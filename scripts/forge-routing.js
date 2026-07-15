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
 *
 * CLI usage (minimal until T03):
 *   node forge-routing.js --dump-config [--cwd <dir>]   # prints parser JSON
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

module.exports = { readRoutingConfig };

// ── CLI entrypoint (minimal — full CLI arrives in T03) ─────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  let cwd = process.cwd();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cwd' && args[i + 1] !== undefined) {
      cwd = args[++i];
    }
  }
  // Debug flag only for now; the contract CLI is built in T03. Exit 0 always.
  process.stdout.write(JSON.stringify(readRoutingConfig(cwd)) + '\n');
  process.exit(0);
}
