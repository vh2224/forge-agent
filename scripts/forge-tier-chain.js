#!/usr/bin/env node
/**
 * forge-tier-chain.js
 *
 * Reads the intra-tier fallback chain for a given tier from the raw 3-file
 * prefs cascade (home > repo > local, last wins). NEVER reads
 * `.gsd/prefs-resolved.json` — that file is never written (see MEM001 M005).
 *
 * `tier_models.<tier>` may be a scalar model ID (single-member chain, the
 * legacy/common case) or an inline flow list `[a, b]` (ordered primary-first
 * fallback chain). Each member is annotated with its Agent()-accepted alias
 * via the shared `forge-model-alias.js` map — never reimplemented here.
 *
 * Zero npm dependencies. CommonJS (matches scripts/ convention).
 *
 * Exports:
 *   readTierChain(tier, cwd) -> [{ id, alias, mapped }, ...]   (non-empty)
 *   nextAfter(chain, id) -> id | ''   (next MAPPED member after id, or '')
 *
 * CLI usage:
 *   node forge-tier-chain.js --tier standard [--cwd <dir>] [--json]
 *   node forge-tier-chain.js --tier standard --next-after <id> [--cwd <dir>]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { modelToAlias } = require('./forge-model-alias');

// ── Canonical default map — mirrors shared/forge-tiers.md § Tier → Default Model
// heavy is WITHOUT the [1m] suffix here (matches § Tier Resolution default).
const DEFAULT_TIER_MODEL = {
  light: 'claude-haiku-4-5-20251001',
  standard: 'claude-sonnet-5',
  heavy: 'claude-opus-4-8',
  max: 'claude-fable-5',
};

const VALID_TIERS = ['light', 'standard', 'heavy', 'max'];

// ── Raw prefs cascade reader ────────────────────────────────────────────────
// Pattern mirrors readEvidenceMode in forge-hook.js: regex-only, `[ \t]`
// (never `\s`), no `\Z` anchor (invalid in JS), silent-fail to safe default.
function readRawTierModelsValue(tier, cwd) {
  const files = [
    path.join(os.homedir(), '.claude', 'forge-agent-prefs.md'),
    path.join(cwd, '.gsd', 'claude-agent-prefs.md'),
    path.join(cwd, '.gsd', 'prefs.local.md'),
  ];

  let value = null; // last-wins across the cascade
  for (const f of files) {
    try {
      const raw = fs.readFileSync(f, 'utf8');
      const blockMatch = raw.match(/^tier_models:[ \t]*\n((?:[ \t]+.+\n?)+)/m);
      if (!blockMatch) continue;
      const block = blockMatch[1];
      const lineRe = new RegExp('^[ \\t]+' + tier + ':[ \\t]*(.+)$', 'm');
      const lineMatch = block.match(lineRe);
      if (lineMatch) {
        // Strip trailing YAML comment (# ...) outside of brackets/quotes.
        let v = lineMatch[1].trim();
        const hashIdx = v.indexOf('#');
        if (hashIdx !== -1 && v.indexOf('[') === -1) {
          v = v.slice(0, hashIdx).trim();
        } else if (hashIdx !== -1 && v.indexOf(']') !== -1 && hashIdx > v.indexOf(']')) {
          v = v.slice(0, hashIdx).trim();
        }
        value = v;
      }
    } catch { /* missing file — skip */ }
  }
  return value;
}

// ── Value parsing: scalar OR inline flow list ───────────────────────────────
function parseTierValue(raw, tier) {
  if (!raw || !raw.trim()) {
    return [DEFAULT_TIER_MODEL[tier]];
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    if (!trimmed.endsWith(']')) {
      throw new Error(`malformed tier_models list: unbalanced brackets in "${trimmed}"`);
    }
    const inner = trimmed.slice(1, -1);
    const parts = inner
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter((s) => s.length > 0);
    if (parts.length === 0) {
      throw new Error(`malformed tier_models list: unbalanced brackets in "${trimmed}"`);
    }
    return parts;
  }
  const unquoted = trimmed.replace(/^["']|["']$/g, '');
  return unquoted.length > 0 ? [unquoted] : [DEFAULT_TIER_MODEL[tier]];
}

// ── Public API ───────────────────────────────────────────────────────────────
function readTierChain(tier, cwd) {
  const normalizedTier = VALID_TIERS.includes(tier) ? tier : 'standard';
  const targetCwd = cwd || process.cwd();

  const raw = readRawTierModelsValue(normalizedTier, targetCwd);
  let ids;
  try {
    ids = parseTierValue(raw, normalizedTier);
  } catch (e) {
    process.stderr.write(
      `⚠ tier_models.${normalizedTier} malformado — usando default ${DEFAULT_TIER_MODEL[normalizedTier]}\n`
    );
    ids = [DEFAULT_TIER_MODEL[normalizedTier]];
  }

  return ids.map((id) => {
    const { alias, mapped } = modelToAlias(id);
    return { id, alias, mapped };
  });
}

function nextAfter(chain, id) {
  if (!Array.isArray(chain) || chain.length === 0) return '';
  const idx = chain.findIndex((m) => m.id === id);
  if (idx === -1) return '';
  for (let i = idx + 1; i < chain.length; i++) {
    if (chain[i].mapped === true) return chain[i].id;
  }
  return '';
}

// ── Exports ──────────────────────────────────────────────────────────────
module.exports = { readTierChain, nextAfter };

// ── CLI entrypoint ───────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  let tier = null;
  let cwd = process.cwd();
  let asJson = false;
  let nextAfterId = null;
  let hasNextAfter = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tier' && args[i + 1] !== undefined) {
      tier = args[++i];
    } else if (args[i] === '--cwd' && args[i + 1] !== undefined) {
      cwd = args[++i];
    } else if (args[i] === '--json') {
      asJson = true;
    } else if (args[i] === '--next-after' && args[i + 1] !== undefined) {
      hasNextAfter = true;
      nextAfterId = args[++i];
    }
  }

  if (!tier) tier = 'standard';

  const chain = readTierChain(tier, cwd);

  if (hasNextAfter) {
    process.stdout.write(nextAfter(chain, nextAfterId) + '\n');
    process.exit(0);
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(chain) + '\n');
  } else {
    for (const m of chain) {
      process.stdout.write(m.id + '\n');
    }
  }
  process.exit(0);
}
