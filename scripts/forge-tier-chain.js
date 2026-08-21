#!/usr/bin/env node
/**
 * forge-tier-chain.js
 *
 * Reads the intra-tier fallback chain for a given tier from the shared prefs
 * engine. NEVER reads `.gsd/prefs-resolved.json` — that file is never written
 * (see MEM001 M005).
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

const { modelToAlias } = require('./forge-model-alias');
const { readPrefsCached } = require('./forge-prefs.js');

// ── Canonical default map — mirrors shared/forge-tiers.md § Tier → Default Model
// heavy is claude-opus-5: 1M context is the model's default, no [1m] suffix needed.
const DEFAULT_TIER_MODEL = {
  light: 'claude-haiku-4-5-20251001',
  standard: 'claude-sonnet-5',
  heavy: 'claude-opus-5',
  max: 'claude-fable-5',
};

const VALID_TIERS = ['light', 'standard', 'heavy', 'max'];

function defaultTierModel(tier) {
  const normalizedTier = VALID_TIERS.includes(tier) ? tier : 'standard';
  return DEFAULT_TIER_MODEL[normalizedTier];
}

// ── Engine value-shape normalization ────────────────────────────────────────
// legacyRead() has already parsed Markdown flow lists: engine values are an
// Array for valid lists, a string for scalars (and malformed bracket strings),
// or native JSONC arrays/strings. Keep the malformed-string check solely to
// preserve the legacy stderr warning and default degradation contract.
function parseTierValue(value, tier) {
  if (Array.isArray(value)) {
    return value.length > 0 ? value : [DEFAULT_TIER_MODEL[tier]];
  }
  if (typeof value !== 'string' || !value.trim()) {
    return [DEFAULT_TIER_MODEL[tier]];
  }
  const trimmed = value.trim();
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

  const { prefs } = readPrefsCached(targetCwd);
  const value = prefs.tier_models && prefs.tier_models[normalizedTier];
  let ids;
  try {
    ids = parseTierValue(value, normalizedTier);
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
module.exports = { readTierChain, nextAfter, defaultTierModel };

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
