#!/usr/bin/env node
/**
 * forge-model-alias.js
 *
 * Canonical model ID → Agent()-accepted alias map. The ONLY place this
 * mapping logic lives — everything else (skills, smoke, docs) must call
 * into this module or its CLI, never reimplement the regex table.
 *
 * Agent() only accepts the aliases: sonnet | opus | haiku | fable.
 * Full model IDs (e.g. "claude-opus-4-8[1m]") are not valid `model:` values
 * for Agent() — callers must resolve to an alias first, and when an ID has
 * no known alias, omit `model:` entirely (documented degradation).
 *
 * Zero npm dependencies. CommonJS (matches scripts/ convention).
 *
 * Exports:
 *   modelToAlias(id) -> { alias: 'haiku'|'sonnet'|'opus'|'fable'|null, mapped: boolean }
 *
 * CLI usage:
 *   node forge-model-alias.js --id <modelId>            # prints alias or '' (exit 0)
 *   node forge-model-alias.js --id <modelId> --json      # prints {"alias":...,"mapped":...}
 */

'use strict';

// ── Alias detection order — fable BEFORE haiku/sonnet/opus ─────────────────
// Substring match on the lowercased id; the [1m] context-window suffix
// (e.g. "claude-opus-4-8[1m]") is naturally handled by substring match —
// no special-casing needed.
function modelToAlias(id) {
  const str = id === null || id === undefined ? '' : String(id).toLowerCase();

  let alias = null;
  if (str.indexOf('fable') !== -1) {
    alias = 'fable';
  } else if (str.indexOf('haiku') !== -1) {
    alias = 'haiku';
  } else if (str.indexOf('sonnet') !== -1) {
    alias = 'sonnet';
  } else if (str.indexOf('opus') !== -1) {
    alias = 'opus';
  }

  return { alias, mapped: alias !== null };
}

// ── Exports ──────────────────────────────────────────────────────────────
module.exports = { modelToAlias };

// ── CLI entrypoint ───────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  let id = null;
  let asJson = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--id' && args[i + 1] !== undefined) {
      id = args[++i];
    } else if (args[i] === '--json') {
      asJson = true;
    }
  }

  const result = modelToAlias(id);

  if (asJson) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    process.stdout.write((result.alias || '') + '\n');
  }
  process.exit(0);
}
