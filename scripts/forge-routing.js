#!/usr/bin/env node
/**
 * forge-routing.js
 *
 * Domain-first routing resolver (M007). This file lands in three tasks:
 *   T01 — parser skeleton: `readRoutingConfig(cwd)` (this file) + CLI guard.
 *   T02 — `resolveRoute()`: precedence, phase mapping, cross-engine chain.
 *   T03 — full CLI: flags, contract JSON, `--next-after`, `--explain`.
 *
 * ── Shared contract (authoritative — S01-PLAN § Contrato compartilhado) ─────
 *
 * Output JSON (stdout, one line, `--json`/default) [built in T02/T03]:
 *   {
 *     "chain":       [{ "id", "alias", "mapped", "engine" }],
 *     "fallback":    { "id", "alias" },
 *     "source":      "frontmatter" | "routing" | "tier_models",
 *     "domain_used": "<domain>" | "default",
 *     "phase":       "executor" | "planner" | <echoed unit_type>,
 *     "reason":      "<; -joined discriminators>"
 *   }
 *   Exit 0 ALWAYS — a last-resort try/catch preserves the ordered contract.
 *
 * ── Parser shape (`readRoutingConfig(cwd)`) ────────────────────────────────
 *   {
 *     present: boolean,   // some routing: block found across the cascade
 *     ok:      boolean,   // parsed clean (false → anomaly, degrade to legacy)
 *     routing: { <domain>: { <phaseKey>: { <tier>: [id,...], fallback: id } } },
 *     error:   null | 'routing-parse-error'
 *   }
 *   - present:false, ok:true  → no block (compat path, byte-identical legacy).
 *   - present:true,  ok:false → parse error (degrade to legacy).
 *   - present:true,  ok:true  → use routing.
 *
 * ── Granularity: last-wins POR DOMÍNIO INTEIRO ─────────────────────────────
 * When the same domain is redefined in a more-specific cascade file, the
 * newer file's domain REPLACES the whole domain of the previous file — it is
 * NEVER a field-by-field merge. Half a domain from one file + half from
 * another would be a silent misroute (worse than ignoring). This granularity
 * is surfaced in the future `--explain` output.
 *
 * ── All-or-nothing por arquivo ─────────────────────────────────────────────
 * Any malformed nesting inside a cascade file discards that file's block AND
 * degrades the whole cascade to `ok:false` — never a partial result.
 *
 * ── Cascade (home > repo > local, last wins per domain) ────────────────────
 *   ~/.claude/forge-agent-prefs.md
 *   <cwd>/.gsd/claude-agent-prefs.md
 *   <cwd>/.gsd/prefs.local.md
 * Same order as `readRawTierModelsValue` in forge-tier-chain.js.
 *
 * MEM004/MEM030: regex uses `[ \t]` NEVER `\s` (leaks across lines); no `\Z`
 * anchor (does not exist in JS — becomes literal 'Z'); block regex scoped to
 * the captured block, never a whole-file indented-line scan. Readers are
 * silent-fail: a missing/unreadable file is skipped, not an error.
 *
 * Zero npm dependencies. CommonJS (matches scripts/ convention). 'use strict'.
 *
 * Exports:
 *   readRoutingConfig(cwd) -> { present, ok, routing, error }
 *   resolveRoute(opts)     -> { chain, fallback, source, domain_used, phase, reason }
 *
 * CLI usage — exit 0 ALWAYS (degrades, never throws to the caller):
 *   # Contract JSON (default and --json are identical):
 *   node forge-routing.js --unit-type execute-task --tier standard \
 *     --domain backend --cwd <dir>
 *   node forge-routing.js --unit-type plan-slice --tier heavy --json
 *
 *   # Walk the RESOLVED chain, then the category fallback ONCE, then '':
 *   node forge-routing.js --unit-type execute-task --tier standard \
 *     --domain backend --next-after claude-sonnet-5 --cwd <dir>
 *
 *   # Step-by-step precedence trace (pt-BR — shadowing mitigation, v1):
 *   node forge-routing.js --unit-type execute-task --tier standard \
 *     --domain backend --explain --cwd <dir>
 *
 * Flags: --unit-type <v> --tier <v> --domain <v> --frontmatter-tier <v>
 *        --frontmatter-worker <v> --cwd <dir> --next-after <id> --explain --json
 * Defaults: --tier standard, --cwd process.cwd(), --domain absent → resolver
 * uses the `default` domain. Unexpected runtime failure is caught by a
 * last-resort try/catch that still emits the ordered contract and exits 0.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Cascade file list (home > repo > local) ────────────────────────────────
function cascadeFiles(cwd) {
  return [
    path.join(os.homedir(), '.claude', 'forge-agent-prefs.md'),
    path.join(cwd, '.gsd', 'claude-agent-prefs.md'),
    path.join(cwd, '.gsd', 'prefs.local.md'),
  ];
}

// ── Inline comment strip (# outside inline-list brackets) ───────────────────
// Mirrors the heuristic in readRawTierModelsValue: strip a trailing `# ...`
// when there is no `[` before it, or when a `]` closes before the `#`.
function stripInlineComment(line) {
  const hashIdx = line.indexOf('#');
  if (hashIdx === -1) return line;
  const open = line.indexOf('[');
  if (open === -1 || open > hashIdx) return line.slice(0, hashIdx);
  const close = line.indexOf(']');
  if (close !== -1 && hashIdx > close) return line.slice(0, hashIdx);
  return line; // '#' sits inside the brackets — keep it
}

// ── Value parse: scalar OR inline flow list [a, b] ─────────────────────────
// Returns an ordered id array, or null when the list is malformed/empty.
function parseValue(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    if (!trimmed.endsWith(']')) return null;
    const inner = trimmed.slice(1, -1);
    const parts = inner
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter((s) => s.length > 0);
    return parts.length > 0 ? parts : null;
  }
  const unquoted = trimmed.replace(/^["']|["']$/g, '');
  return unquoted.length > 0 ? [unquoted] : null;
}

const KEY_RE = /^[ \t]*([A-Za-z0-9_.\-]+):[ \t]*(.*)$/;
const INDENT_RE = /^[ \t]*/;

// ── Block parser: indent-tracking, 3 levels (domain > phase > tier) ─────────
// Returns { ok:true, routing } or { ok:false }. Depth is tracked by a stack of
// leading-whitespace widths; tabs vs spaces compare by RELATIVE depth (the
// first indented line of each nesting sets that level's width), never by an
// absolute space count. Any inconsistency → { ok:false } (all-or-nothing).
function parseRoutingBlock(block) {
  const lines = block.split('\n');
  const routing = {};
  const indentStack = []; // widths; index 0 = level 1 (domain)
  let curDomain = null;
  let curPhase = null;

  for (const rawLine of lines) {
    if (rawLine.trim() === '') continue; // blank line inside block
    const indent = rawLine.match(INDENT_RE)[0];
    const width = indent.length;
    if (rawLine.slice(width).startsWith('#')) continue; // full-line comment

    const line = stripInlineComment(rawLine);
    const m = line.match(KEY_RE);
    if (!m) return { ok: false };
    const key = m[1];
    const value = m[2].trim();

    // Resolve nesting level from the indent stack.
    let level;
    if (indentStack.length === 0) {
      indentStack.push(width);
      level = 1;
    } else {
      const top = indentStack[indentStack.length - 1];
      if (width === top) {
        level = indentStack.length;
      } else if (width > top) {
        indentStack.push(width);
        level = indentStack.length;
      } else {
        while (
          indentStack.length > 0 &&
          indentStack[indentStack.length - 1] > width
        ) {
          indentStack.pop();
        }
        if (
          indentStack.length === 0 ||
          indentStack[indentStack.length - 1] !== width
        ) {
          return { ok: false }; // dedent to an unknown level → malformed
        }
        level = indentStack.length;
      }
    }

    if (level > 3) return { ok: false };

    if (level === 1) {
      if (value !== '') return { ok: false }; // domain carries no value
      curDomain = key;
      curPhase = null;
      routing[curDomain] = {}; // duplicate within a file → replace whole domain
    } else if (level === 2) {
      if (curDomain === null || value !== '') return { ok: false };
      curPhase = key;
      routing[curDomain][curPhase] = {};
    } else {
      if (curDomain === null || curPhase === null || value === '') {
        return { ok: false };
      }
      const list = parseValue(value);
      if (list === null) return { ok: false };
      if (key === 'fallback') {
        routing[curDomain][curPhase].fallback = list[0];
      } else {
        routing[curDomain][curPhase][key] = list;
      }
    }
  }

  return { ok: true, routing };
}

// ── Public API ─────────────────────────────────────────────────────────────
function readRoutingConfig(cwd) {
  const targetCwd = cwd || process.cwd();
  const files = cascadeFiles(targetCwd);

  let present = false;
  let ok = true;
  const merged = {};

  for (const f of files) {
    let raw;
    try {
      raw = fs.readFileSync(f, 'utf8');
    } catch {
      continue; // missing/unreadable → skip (silent-fail)
    }
    const blockMatch = raw.match(/^routing:[ \t]*\n((?:[ \t]+.+\n?)+)/m);
    if (!blockMatch) continue;

    present = true;
    const parsed = parseRoutingBlock(blockMatch[1]);
    if (!parsed.ok) {
      ok = false; // all-or-nothing: this file's block is discarded
      continue;
    }
    for (const domain of Object.keys(parsed.routing)) {
      merged[domain] = parsed.routing[domain]; // last-wins per whole domain
    }
  }

  if (!present) return { present: false, ok: true, routing: {}, error: null };
  if (!ok) {
    return { present: true, ok: false, routing: {}, error: 'routing-parse-error' };
  }
  return { present: true, ok: true, routing: merged, error: null };
}

// ═══════════════════════════════════════════════════════════════════════════
// T02 — resolveRoute(): precedence, phase mapping, cross-engine chain, cap,
// validated category fallback, byte-identical legacy compat.
// ═══════════════════════════════════════════════════════════════════════════
//
// Reuse (never reimplemented here):
//   • readTierChain  — the legacy tier_models chain (compat path + non-routable
//     phases). We delegate; the canonical DEFAULT_TIER_MODEL and tier
//     normalization live inside forge-tier-chain.js, not duplicated here.
//   • modelToAlias   — Agent()-accepted alias + mapped flag per member.
//   • modelFamily    — engine per member ('claude' | 'gpt' | null). null =
//     unknown family (e.g. gemini today) → member is skipped (S05 refines the
//     warning to phase-unsupported-family once gemini becomes a real engine).
//
// Precedence (6 sources, highest first) — matches M007-CONTEXT § Locked:
//   frontmatter tier:/worker:  >  routing.<d>.<f>.<t>  >  routing.default.<f>.<t>
//   >  tier_models  >  workers  >  canonical default
// The last three collapse into readTierChain (tier_models + canonical default);
// per-phase `workers:` pinning is honored at the top via frontmatterWorker.
//
// Contract returned: { chain, fallback, source, domain_used, phase, reason }.
//   source ∈ 'frontmatter' | 'routing' | 'tier_models' (winning layer).
//   reason is a `; `-joined composition of discriminators (buildReason pattern
//   from forge-review-pairing.js) — degradations are NEVER silent.
//
// resolveRoute is a PURE LIBRARY function — no printing. The CLI (contract
// JSON, --next-after, --explain) is built in T03 on top of these exports.

const { readTierChain } = require('./forge-tier-chain');
const { modelToAlias, modelFamily } = require('./forge-model-alias');

const CHAIN_CAP = 3; // resolved chain hard cap (fallback is separate, uncapped)

// ── Phase mapping ───────────────────────────────────────────────────────────
// execute-task → executor; plan-slice → planner. plan-milestone is NEVER
// captured (locked max/Fable). discuss-*/memory/complete-*/unknown → null.
// null ⇒ phase-not-routable (resolves via the legacy tier chain).
function mapPhase(unitType) {
  if (unitType === 'execute-task') return 'executor';
  if (unitType === 'plan-slice') return 'planner';
  return null;
}

// ── Reason composition — `; `-joined discriminators, order-preserving ──────
function buildReason(parts) {
  return parts.filter((p) => p != null && p !== '').join('; ');
}

// ── Cell resolution (1-path: domain → default → null) ───────────────────────
// Tries routing.<domain>.<phase>.<tier> (routing-hit, domain_used=<domain>),
// then routing.default.<phase>.<tier> (routing-default, domain_used='default').
// null ⇒ caller falls to the legacy tier_models chain. Config incompleteness
// inherits down this path; the CATEGORY fallback is a RUNTIME net only.
function resolveCell(routing, domain, phase, tier) {
  const tryDomain = (dKey, reason) => {
    const d = routing[dKey];
    if (!d || !d[phase] || !Array.isArray(d[phase][tier])) return null;
    return {
      ids: d[phase][tier],
      fallbackId: d[phase].fallback != null ? d[phase].fallback : null,
      domain_used: reason === 'routing-hit' ? dKey : 'default',
      reason,
    };
  };

  if (domain && Object.prototype.hasOwnProperty.call(routing, domain)) {
    const hit = tryDomain(domain, 'routing-hit');
    if (hit) return hit;
  }
  const def = tryDomain('default', 'routing-default');
  if (def) return def;
  return null;
}

// ── Chain builder — each id → { id, alias, mapped, engine } ─────────────────
// Members whose modelFamily() is null (unknown family) are DROPPED from the
// resolved chain and accumulate a `skipped-unknown-family` discriminator. The
// cap and --next-after operate on the already-pruned chain.
function buildChain(ids, reasonParts) {
  const list = Array.isArray(ids) ? ids : [ids];
  const chain = [];
  let skipped = false;
  for (const id of list) {
    const engine = modelFamily(id);
    if (engine === null) {
      skipped = true;
      continue;
    }
    const { alias, mapped } = modelToAlias(id);
    chain.push({ id, alias, mapped, engine });
  }
  if (skipped && reasonParts) reasonParts.push('skipped-unknown-family');
  return chain;
}

// ── Cap — hard-truncate above CHAIN_CAP, never silent ───────────────────────
function capChain(chain, reasonParts) {
  if (chain.length > CHAIN_CAP) {
    if (reasonParts) reasonParts.push('chain-capped');
    return chain.slice(0, CHAIN_CAP);
  }
  return chain;
}

// ── Fallback validation — claude + mapped, else default-of-tier ─────────────
// A configured fallback that is not a mapped Claude model is substituted by the
// tier default with reason `fallback-invalid-substituted`. A MISSING fallback
// (null) silently uses the tier default (no reason — it is the natural net, not
// an invalid config). Tier default = readTierChain(tier)[0] (respects
// tier_models config; canonical default folded inside readTierChain).
function validateFallback(fallbackId, tier, cwd, reasonParts) {
  if (fallbackId != null && String(fallbackId).length > 0) {
    const fam = modelFamily(fallbackId);
    const { alias, mapped } = modelToAlias(fallbackId);
    if (fam === 'claude' && mapped) {
      return { id: fallbackId, alias };
    }
    if (reasonParts) reasonParts.push('fallback-invalid-substituted');
  }
  const def = readTierChain(tier, cwd)[0];
  return { id: def.id, alias: def.alias };
}

// ── Walk the resolved chain, then the fallback once, then '' ────────────────
// Cross-engine aware: does NOT filter by mapped (a gpt member routes via the
// sidecar and is a legitimate next target). T03's --next-after builds on this.
function nextInChain(chain, fallback, id) {
  const ids = (Array.isArray(chain) ? chain : []).map((m) => m.id);
  if (fallback && fallback.id) ids.push(fallback.id);
  const idx = ids.indexOf(id);
  if (idx === -1) return '';
  return idx + 1 < ids.length ? ids[idx + 1] : '';
}

// ── The resolver ────────────────────────────────────────────────────────────
function resolveRoute(opts) {
  const o = opts || {};
  const unitType = o.unitType;
  const tier = o.tier;
  const domain = o.domain;
  const frontmatterTier = o.frontmatterTier;
  const frontmatterWorker = o.frontmatterWorker;
  const cwd = o.cwd || process.cwd();

  const reasonParts = [];
  // Frontmatter fixes the tier/worker; it does NOT replace the whole chain —
  // the chain still resolves at the effective tier through routing/legacy.
  const effectiveTier =
    frontmatterTier != null && String(frontmatterTier).length > 0
      ? frontmatterTier
      : tier;

  const phase = mapPhase(unitType);
  const phaseField = phase !== null ? phase : unitType != null ? unitType : '';

  // ── Precedence 1a: frontmatter worker pins an explicit model ──────────────
  if (frontmatterWorker != null && String(frontmatterWorker).length > 0) {
    reasonParts.push('frontmatter-worker');
    const chain = capChain(buildChain([frontmatterWorker], reasonParts), reasonParts);
    const fallback = validateFallback(null, effectiveTier, cwd, reasonParts);
    return {
      chain,
      fallback,
      source: 'frontmatter',
      domain_used: 'default',
      phase: phaseField,
      reason: buildReason(reasonParts),
    };
  }

  // frontmatter tier wins the SOURCE label even when the chain comes from
  // routing/legacy at the fixed tier.
  const frontmatterFixesTier =
    frontmatterTier != null && String(frontmatterTier).length > 0;
  if (frontmatterFixesTier) reasonParts.push('frontmatter-tier');

  const cfg = readRoutingConfig(cwd);

  // ── Early degradations → legacy tier chain (readTierChain) ────────────────
  let useRouting = false;
  let cell = null;
  if (cfg.ok === false) {
    reasonParts.push('routing-parse-error');
  } else if (phase === null) {
    reasonParts.push('phase-not-routable');
  } else if (cfg.present === false) {
    reasonParts.push('tier_models'); // compat path — byte-identical legacy
  } else {
    cell = resolveCell(cfg.routing, domain, phase, effectiveTier);
    if (cell) {
      reasonParts.push(cell.reason); // routing-hit | routing-default
      useRouting = true;
    } else {
      reasonParts.push('tier_models'); // cell + default missing → legacy
    }
  }

  if (useRouting) {
    const chain = capChain(buildChain(cell.ids, reasonParts), reasonParts);
    const fallback = validateFallback(cell.fallbackId, effectiveTier, cwd, reasonParts);
    return {
      chain,
      fallback,
      source: frontmatterFixesTier ? 'frontmatter' : 'routing',
      domain_used: cell.domain_used,
      phase: phaseField,
      reason: buildReason(reasonParts),
    };
  }

  // ── Legacy path — byte-identical to readTierChain (engine field additive) ──
  const legacy = readTierChain(effectiveTier, cwd);
  const chain = legacy.map((m) => ({
    id: m.id,
    alias: m.alias,
    mapped: m.mapped,
    engine: modelFamily(m.id),
  }));
  const fallback = validateFallback(null, effectiveTier, cwd, reasonParts);
  return {
    chain,
    fallback,
    source: frontmatterFixesTier ? 'frontmatter' : 'tier_models',
    domain_used: 'default',
    phase: phaseField,
    reason: buildReason(reasonParts),
  };
}

module.exports = {
  readRoutingConfig,
  resolveRoute,
  mapPhase,
  resolveCell,
  buildChain,
  capChain,
  validateFallback,
  buildReason,
  nextInChain,
};

// ═══════════════════════════════════════════════════════════════════════════
// T03 — CLI: arg parsing, contract JSON, --next-after, --explain, last-resort
// try/catch. resolveRoute is NOT reimplemented here — the CLI only wires it.
// ═══════════════════════════════════════════════════════════════════════════

// ── Arg parsing (forge-review-pairing.js loop pattern) ──────────────────────
function parseArgs(args) {
  const parsed = {
    unitType: null,
    tier: 'standard',
    domain: null,
    frontmatterTier: null,
    frontmatterWorker: null,
    cwd: process.cwd(),
    nextAfter: null,
    hasNextAfter: false,
    explain: false,
    asJson: false,
  };
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    if (args[i] === '--unit-type' && value !== undefined) {
      parsed.unitType = value;
      i += 1;
    } else if (args[i] === '--tier' && value !== undefined) {
      parsed.tier = value;
      i += 1;
    } else if (args[i] === '--domain' && value !== undefined) {
      parsed.domain = value;
      i += 1;
    } else if (args[i] === '--frontmatter-tier' && value !== undefined) {
      parsed.frontmatterTier = value;
      i += 1;
    } else if (args[i] === '--frontmatter-worker' && value !== undefined) {
      parsed.frontmatterWorker = value;
      i += 1;
    } else if (args[i] === '--cwd' && value !== undefined) {
      parsed.cwd = value;
      i += 1;
    } else if (args[i] === '--next-after' && value !== undefined) {
      parsed.hasNextAfter = true;
      parsed.nextAfter = value;
      i += 1;
    } else if (args[i] === '--explain') {
      parsed.explain = true;
    } else if (args[i] === '--json') {
      parsed.asJson = true;
    }
  }
  return parsed;
}

// ── --explain — pt-BR precedence trace (v1 shadowing mitigation) ────────────
// Discriminator → human sentence. Absent discriminators are simply not shown.
const REASON_TEXT = {
  'routing-hit': 'célula routing.<domínio>.<fase>.<tier> encontrada',
  'routing-default':
    'célula do domínio ausente — usou routing.default.<fase>.<tier>',
  tier_models: 'cadeia legada tier_models (sem routing, ou célula+default ausentes)',
  'frontmatter-tier': 'tier fixado no frontmatter venceu o rótulo de source',
  'frontmatter-worker': 'worker fixado no frontmatter venceu a precedência',
  'routing-parse-error':
    'anomalia de parse no bloco routing: — degradou para a cadeia legada',
  'phase-not-routable':
    'fase não-roteável (plan-milestone/discuss/memory/completer/desconhecida) — cadeia legada',
  'fallback-invalid-substituted':
    'fallback configurado não-claude/não-mapeado — substituído pelo default do tier',
  'chain-capped': 'cadeia truncada no cap de ' + CHAIN_CAP,
  'skipped-unknown-family':
    'membro com família desconhecida (modelFamily null) pulado da cadeia',
  'routing-runtime-error':
    'falha runtime inesperada — degradou preservando o contrato',
};

function explainRoute(r, o) {
  const reasons = r.reason ? r.reason.split('; ').filter((p) => p !== '') : [];
  const reqTier = o.frontmatterTier || o.tier;
  const lines = [];
  lines.push('── Explicação da rota (forge-routing) ──');
  lines.push(
    'unit_type: ' +
      (o.unitType || '(nenhum)') +
      ' → fase mapeada: ' +
      (r.phase || '(não-roteável)')
  );
  lines.push(
    'tier: ' +
      reqTier +
      (o.frontmatterTier ? ' (fixado pelo frontmatter)' : '')
  );
  lines.push(
    'domínio consultado: ' +
      (o.domain || '(nenhum)') +
      ' → domain_used: ' +
      r.domain_used +
      ' (last-wins por domínio inteiro)'
  );
  lines.push('camada de precedência vencedora (source): ' + r.source);
  lines.push('');
  lines.push('Passo a passo / degradações aplicadas:');
  if (reasons.length === 0) {
    lines.push('  • (nenhum discriminador registrado)');
  } else {
    for (const rp of reasons) {
      lines.push('  • ' + rp + ' — ' + (REASON_TEXT[rp] || 'discriminador'));
    }
  }
  lines.push('');
  lines.push('Cadeia final (engine por membro):');
  if (!r.chain || r.chain.length === 0) {
    lines.push('  (vazia)');
  } else {
    r.chain.forEach((m, idx) => {
      lines.push(
        '  ' +
          (idx + 1) +
          '. ' +
          m.id +
          ' [alias: ' +
          m.alias +
          ', engine: ' +
          m.engine +
          ', mapped: ' +
          m.mapped +
          ']'
      );
    });
  }
  lines.push(
    'fallback de categoria: ' +
      r.fallback.id +
      ' [alias: ' +
      r.fallback.alias +
      ']'
  );
  return lines.join('\n');
}

// ── runCli — resolve, then emit the requested view. exit 0 handled by caller ─
function runCli(args) {
  const o = parseArgs(args);
  const r = resolveRoute({
    unitType: o.unitType,
    tier: o.tier,
    domain: o.domain,
    frontmatterTier: o.frontmatterTier,
    frontmatterWorker: o.frontmatterWorker,
    cwd: o.cwd,
  });

  // --next-after walks the RESOLVED chain (already pruned + capped), then the
  // category fallback ONCE, then '' — nextInChain implements exactly this.
  if (o.hasNextAfter) {
    process.stdout.write(nextInChain(r.chain, r.fallback, o.nextAfter) + '\n');
    return;
  }
  if (o.explain) {
    process.stdout.write(explainRoute(r, o) + '\n');
    return;
  }
  // default and --json emit the same one-line contract JSON.
  process.stdout.write(JSON.stringify(r) + '\n');
}

module.exports.parseArgs = parseArgs;
module.exports.explainRoute = explainRoute;
module.exports.runCli = runCli;

// ── CLI entrypoint — exit 0 ALWAYS, last-resort degradation preserves order ──
if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch {
    // Unexpected runtime failure: emit a valid degraded contract from the
    // legacy tier chain, preserving the ordered field contract. Never throw.
    let tier = 'standard';
    let cwd = process.cwd();
    const a = process.argv.slice(2);
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '--tier' && a[i + 1] !== undefined) tier = a[++i];
      else if (a[i] === '--cwd' && a[i + 1] !== undefined) cwd = a[++i];
    }
    let chain = [];
    let fallback = { id: '', alias: null };
    try {
      const legacy = readTierChain(tier, cwd);
      chain = legacy.map((m) => ({
        id: m.id,
        alias: m.alias,
        mapped: m.mapped,
        engine: modelFamily(m.id),
      }));
      if (legacy[0]) fallback = { id: legacy[0].id, alias: legacy[0].alias };
    } catch {
      /* even the legacy chain failed — emit the minimal ordered contract */
    }
    const result = {
      chain,
      fallback,
      source: 'tier_models',
      domain_used: 'default',
      phase: '',
      reason: buildReason(['routing-runtime-error', 'tier_models']),
    };
    process.stdout.write(JSON.stringify(result) + '\n');
  }
  process.exit(0);
}
