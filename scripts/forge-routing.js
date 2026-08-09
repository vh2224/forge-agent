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
 * The shared prefs engine owns Markdown/JSONC precedence, the three-level
 * routing parser, and the all-or-nothing malformed-block behavior.
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

const { readPrefsCached } = require('./forge-prefs.js');

// ── Public API ─────────────────────────────────────────────────────────────
function readRoutingConfig(cwd) {
  const result = readPrefsCached(cwd || process.cwd());
  const routingError = result.errors.some((entry) =>
    typeof entry.message === 'string' && entry.message.includes('routing-parse-error'));
  const present = Object.prototype.hasOwnProperty.call(result.prefs, 'routing') || routingError;
  if (routingError) {
    return { present: true, ok: false, routing: {}, error: 'routing-parse-error' };
  }
  return { present, ok: true, routing: result.prefs.routing ?? {}, error: null };
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
//   • modelFamily    — engine per member ('claude' | 'gpt' | 'gemini' | null).
//     null = unknown family → member is skipped (skipped-unknown-family).
//     'gemini' is now a KNOWN family (agy engine) but executor/planner chains
//     cannot route it (agy has no --mode execute/plan) → member is skipped with
//     the distinct discriminator phase-unsupported-family (S05 T02, item d).
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
const { modelToAlias, modelFamily, isMalformedId } = require('./forge-model-alias');

const CHAIN_CAP = 3; // resolved chain hard cap (fallback is separate, uncapped)

// ── Family-only worker pin ──────────────────────────────────────────────────
// `worker:` in a T##-PLAN frontmatter is written two very different ways:
//   • a CONCRETE model id (`gpt-5.6-terra`) — the author picked the model;
//   • a FAMILY token (`claude`, `codex`) — the author picked only the ENGINE.
// Treating the second as a model id is what made the whole tier resolution
// inert: `worker: claude` produced chain `[{id:'claude', alias:null}]`, so the
// orchestrator omitted `model:` from Agent() (alias null → documented
// degradation) and the worker silently ran on its agent-frontmatter default
// instead of the tier's model — and the effort clamp, which keys off
// `claude-(haiku|sonnet)`, never matched the token `claude`, so a `standard`
// task could be dispatched at `high` effort (HTTP 400 on Sonnet).
// A family token therefore pins ONLY the engine: the chain keeps resolving
// through routing/tier_models at the effective tier and is then FILTERED to
// that family. Precedence is unchanged — the frontmatter still wins the
// `source` label, and a concrete id still short-circuits exactly as before.
const WORKER_FAMILY_TOKENS = {
  claude: 'claude',
  gpt: 'gpt',
  codex: 'gpt',
  gemini: 'gemini',
  agy: 'gemini',
};

function workerFamilyToken(value) {
  if (value === null || value === undefined) return null;
  const key = String(value).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(WORKER_FAMILY_TOKENS, key)
    ? WORKER_FAMILY_TOKENS[key]
    : null;
}

// Filter a resolved chain down to the pinned family. An EMPTY result is never
// silent and never leaves the caller with an empty chain: the pin degrades to
// the pre-fix literal-token chain (byte-identical to the old behavior for that
// case) with its own discriminator, so a family the tier cannot supply cannot
// regress into "no chain at all".
function applyFamilyPin(chain, familyPin, rawWorker, reasonParts) {
  const kept = (Array.isArray(chain) ? chain : []).filter((m) => m && m.engine === familyPin);
  if (kept.length > 0) return kept;
  if (reasonParts) reasonParts.push('frontmatter-worker-family-unmatched');
  return buildChain([rawWorker], reasonParts);
}

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
// Two classes of member are DROPPED from the resolved chain, each with its own
// non-silent discriminator:
//   • modelFamily() === null → unknown family → `skipped-unknown-family`.
//   • modelFamily() === 'gemini' → KNOWN family, but executor/planner cannot
//     route it (agy has no --mode execute/plan) → `phase-unsupported-family`.
// The cap and --next-after operate on the already-pruned chain.
function buildChain(ids, reasonParts) {
  const list = Array.isArray(ids) ? ids : [ids];
  const chain = [];
  let skippedUnknown = false;
  let skippedUnsupported = false;
  let skippedMalformed = false;
  for (const id of list) {
    // Checked before modelFamily: a composite like "gpt-5.6-terra,
    // claude-opus-5" contains BOTH families, and family detection would pick
    // whichever it tests first — dispatching to a model nobody chose. Drop it
    // instead of admitting a member whose id is not a model.
    if (isMalformedId(id)) {
      skippedMalformed = true;
      continue;
    }
    const engine = modelFamily(id);
    if (engine === null) {
      skippedUnknown = true;
      continue;
    }
    if (engine === 'gemini') {
      skippedUnsupported = true;
      continue;
    }
    const { alias, mapped } = modelToAlias(id);
    chain.push({ id, alias, mapped, engine });
  }
  if (skippedUnsupported && reasonParts) reasonParts.push('phase-unsupported-family');
  if (skippedUnknown && reasonParts) reasonParts.push('skipped-unknown-family');
  if (skippedMalformed && reasonParts) reasonParts.push('skipped-malformed-id');
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
  const ordered = (Array.isArray(chain) ? chain : []).map((m) => m.id);
  if (fallback && fallback.id) ordered.push(fallback.id);
  // Dedupe, keeping first position. A MISSING category fallback substitutes the
  // tier default, which on the legacy path IS the chain head — so the raw walk
  // order routinely repeats an id. Left duplicated the walk hands back a member
  // it already tried and never returns '', making the Failure Taxonomy's
  // "chain exhausted → stop the loop" branch unreachable: a single-member chain
  // re-dispatches the same model forever, and a two-member one ping-pongs.
  const ids = ordered.filter((entry, index) => ordered.indexOf(entry) === index);
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
  // A family-only token (claude/codex/gpt/gemini/agy) is NOT a model id — it
  // pins the engine and lets tier resolution continue (see applyFamilyPin).
  const familyPin = workerFamilyToken(frontmatterWorker);
  if (familyPin !== null) reasonParts.push('frontmatter-worker-family');
  if (familyPin === null && frontmatterWorker != null && String(frontmatterWorker).length > 0) {
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
    let chain = capChain(buildChain(cell.ids, reasonParts), reasonParts);
    if (familyPin !== null) chain = applyFamilyPin(chain, familyPin, frontmatterWorker, reasonParts);
    const fallback = validateFallback(cell.fallbackId, effectiveTier, cwd, reasonParts);
    return {
      chain,
      fallback,
      source: frontmatterFixesTier || familyPin !== null ? 'frontmatter' : 'routing',
      domain_used: cell.domain_used,
      phase: phaseField,
      reason: buildReason(reasonParts),
    };
  }

  // ── Legacy path — byte-identical to readTierChain (engine field additive) ──
  const legacy = readTierChain(effectiveTier, cwd);
  let chain = legacy.map((m) => ({
    id: m.id,
    alias: m.alias,
    mapped: m.mapped,
    engine: modelFamily(m.id),
  }));
  if (familyPin !== null) chain = applyFamilyPin(chain, familyPin, frontmatterWorker, reasonParts);
  const fallback = validateFallback(null, effectiveTier, cwd, reasonParts);
  return {
    chain,
    fallback,
    source: frontmatterFixesTier || familyPin !== null ? 'frontmatter' : 'tier_models',
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
  workerFamilyToken,
  applyFamilyPin,
  WORKER_FAMILY_TOKENS,
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
    listDomains: false,
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
    } else if (args[i] === '--list-domains') {
      parsed.listDomains = true;
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
  'frontmatter-worker-family':
    'worker do frontmatter nomeia só a família (engine) — a cadeia continua resolvendo pelo tier e é filtrada por essa família',
  'frontmatter-worker-family-unmatched':
    'nenhum membro da cadeia do tier pertence à família pinada — degradou para a cadeia literal do token (comportamento pré-fix)',
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

  // --list-domains is an early-exit path: no --unit-type/--tier required.
  // Reuses readRoutingConfig() — never reimplements the parser. Contract:
  // JSON array of routing: domain keys, or '[]' on absent/parse-error
  // (silent-fail — exit 0 always, handled by the caller).
  if (o.listDomains) {
    let domains = [];
    try {
      const cfg = readRoutingConfig(o.cwd);
      if (cfg.present && cfg.ok && cfg.routing) {
        domains = Object.keys(cfg.routing);
      }
    } catch {
      domains = [];
    }
    process.stdout.write(JSON.stringify(domains) + '\n');
    return;
  }

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
