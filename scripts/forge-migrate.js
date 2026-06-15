#!/usr/bin/env node
// forge-migrate — Consolidated migration orchestrator for Forge Agent fragment stores.
//
// Runs the three migrators (ledger, decisions, memory) in order. For each:
//   0. Already-migrated shortcut: when .gsd/SCHEMA-VERSION is already CURRENT_SCHEMA
//      AND the store's fragments are populated, the monolith on disk is a REGENERATED
//      projection cache — NOT a legacy pre-migration monolith. Skip backup + migrate so
//      the cache is never retired to .bak (reports skipped_reason: 'already-migrated').
//   1. Otherwise: renames the legacy monolith to <name>.bak (preserves existing .bak).
//   2. Invokes the migrator's migrate() export.
//   3. Verifies: renders via forge-projection and diffs against .bak content.
//   4. Writes .gsd/SCHEMA-VERSION on success.
//
// Library exports:
//   migrateAll(cwd, opts)  → summary object per store + schema_version_written
//
// CLI:
//   node forge-migrate.js [--cwd <dir>] [--dry-run]
//
// Exit codes:
//   0 — success
//   1 — migration error (partial state preserved; .bak files kept)
//   2 — bad arguments

'use strict';

const fs   = require('fs');
const path = require('path');

const ledgerMigrate    = require('./forge-ledger-migrate');
const decisionsMigrate = require('./forge-decisions-migrate');
const memoryMigrate    = require('./forge-memory-migrate');
const projection       = require('./forge-projection');
const storeStateMod    = require('./forge-store-state');
const { CURRENT_SCHEMA } = require('./forge-doctor');

// ── Store descriptors ─────────────────────────────────────────────────────────
// Each store: { name, monolithRel, bakRel, migrate, render }
const STORES = [
  {
    name:       'ledger',
    monolithRel: '.gsd/LEDGER.md',
    bakRel:      '.gsd/LEDGER.md.bak',
    migrate:    (cwd, opts) => ledgerMigrate.migrate(cwd, opts),
    render:     (cwd)       => projection.renderLedger(cwd),
  },
  {
    name:       'decisions',
    monolithRel: '.gsd/DECISIONS.md',
    bakRel:      '.gsd/DECISIONS.md.bak',
    migrate:    (cwd, opts) => decisionsMigrate.migrate(cwd, opts),
    render:     (cwd)       => projection.renderDecisions(cwd),
  },
  {
    name:       'memory',
    monolithRel: '.gsd/AUTO-MEMORY.md',
    bakRel:      '.gsd/AUTO-MEMORY.md.bak',
    // memoryMigrate.migrate returns a nested shape { memory: {written,…}, checker, warnings }
    // (it owns both the AUTO-MEMORY and CHECKER-MEMORY monoliths). Flatten the memory
    // counts to the top level migrateStore expects — otherwise migrateResult.written is
    // undefined and the orchestrator reports `memory: written:0` even on a successful
    // migration. Skip the checker monolith here: forge-migrate only governs AUTO-MEMORY.
    migrate:    (cwd, opts) => {
      const r = memoryMigrate.migrate(cwd, Object.assign({ skipChecker: true }, opts));
      const mem = r.memory || {};
      return {
        status:      r.status,
        written:     mem.written     || 0,
        skipped:     mem.skipped     || 0,
        would_write: mem.would_write || 0,
        warnings:    r.warnings      || [],
      };
    },
    render:     (cwd)       => projection.renderMemory(cwd),
  },
];

// ── normalizeDecisions ────────────────────────────────────────────────────────
// Strip the leading `| # |` column from each table data row so that derived
// numbering differences don't cause spurious "differs" classification.
function stripDecisionNumbers(text) {
  return text
    .split('\n')
    .map(line => {
      // Match table rows that start with "| <number> |" and strip that column
      const m = line.match(/^\|\s*\d+\s*\|(.*)/);
      if (m) return '|' + m[1];
      return line;
    })
    .join('\n');
}

// ── canonicalizeMemory ──────────────────────────────────────────────────────
// The memory store changes SHAPE across migration: the legacy monolith uses
//   - [MEM###] (category) confidence:X hits:Y [score:Z] — text
// while the projection (forge-projection.renderMemory) emits
//   <!-- gsd-auto-memory mem_id:MEM### category:cat confidence:X hits:Y … -->
// A line-by-line diff can never call these "layout only", yet the migration is
// lossless when the same set of memories survives. So for the memory store we
// compare a CANONICAL ENTRY SET instead: (mem_id, category, hits) extracted from
// whichever dialect a side is in, sorted. confidence is excluded because the
// projection applies on-read time decay; text is excluded because multi-line
// entries are folded to a single line on migration. A mismatch here means a
// memory was actually dropped (the failure this whole fix targets).
function canonicalizeMemory(text) {
  const set = [];
  // Legacy bullet dialect.
  const legacyRe = /^- \[([A-Z]+\d+)\] \(([^)]+)\) confidence:[\d.]+ hits:(\d+)/gm;
  // Projection HTML-comment dialect.
  const renderedRe = /<!--\s*gsd-auto-memory\s+mem_id:(\S+)\s+category:(\S+)\s+confidence:[\d.]+\s+hits:(\d+)/g;
  let m;
  while ((m = legacyRe.exec(text)) !== null)   set.push(`${m[1]}|${m[2].trim()}|${m[3]}`);
  while ((m = renderedRe.exec(text)) !== null) set.push(`${m[1]}|${m[2].trim()}|${m[3]}`);
  set.sort();
  return set.join('\n');
}

// ── normalizeLayout ───────────────────────────────────────────────────────────
// Returns a canonical form of text for layout-insensitive comparison.
// Normalizations applied (conservative — never masks real content changes):
//   1. Trim trailing whitespace on each line.
//   2. Collapse runs of blank lines to a single blank line.
//   3. Strip a leading and trailing blank line.
//   4. Normalize trailing newline to a single \n.
//   5. Strip derived projection header/preamble lines (^# ... and ^> ...).
//   6. For the 'decisions' store: also apply stripDecisionNumbers to remove
//      the derived | # | column (rows reuse the existing helper).
// Returns the normalized string.
function normalizeLayout(text, storeName) {
  // The memory store changes shape across migration — compare entry sets, not lines.
  if (storeName === 'memory') {
    return canonicalizeMemory(text);
  }

  let lines = text.split('\n');

  // Strip derived header/preamble lines (projection title + blockquote boilerplate)
  lines = lines.filter(line => !/^#\s/.test(line) && !/^>\s/.test(line));

  // Trim trailing whitespace per line
  lines = lines.map(line => line.trimEnd());

  // Collapse runs of blank lines to a single blank line
  const collapsed = [];
  let prevBlank = false;
  for (const line of lines) {
    const isBlank = line === '';
    if (isBlank && prevBlank) continue;
    collapsed.push(line);
    prevBlank = isBlank;
  }

  // Strip leading and trailing blank lines
  while (collapsed.length > 0 && collapsed[0] === '') collapsed.shift();
  while (collapsed.length > 0 && collapsed[collapsed.length - 1] === '') collapsed.pop();

  let result = collapsed.join('\n');

  // For decisions store, strip derived # numbering column
  if (storeName === 'decisions') {
    result = stripDecisionNumbers(result);
  }

  return result;
}

// ── compareContent ────────────────────────────────────────────────────────────
// Compares bak content vs rendered content.
// Returns 'identical' | 'differs (layout only)' | 'differs' | 'no-bak'
//
// Classification ladder:
//   bakContent === null                          → 'no-bak'
//   bakContent === rendered                      → 'identical'
//   normalizeLayout(bak) === normalizeLayout(rendered) → 'differs (layout only)'
//   else                                         → 'differs'
//
// Note: the legacy 'differs (numbering only)' string is subsumed by
// 'differs (layout only)' — the decisions numbering-only case now reports
// layout only. The B1 smoke test does not assert the legacy string literally.
function compareContent(bakContent, rendered, storeName) {
  if (bakContent === null) return 'no-bak';
  if (bakContent === rendered) return 'identical';

  if (normalizeLayout(bakContent, storeName) === normalizeLayout(rendered, storeName)) {
    return 'differs (layout only)';
  }

  return 'differs';
}

// ── readSchemaVersion ───────────────────────────────────────────────────────
// Returns the trimmed content of .gsd/SCHEMA-VERSION, or null if absent.
function readSchemaVersion(cwd) {
  try {
    return fs.readFileSync(path.join(cwd, '.gsd', 'SCHEMA-VERSION'), 'utf8').trim();
  } catch (_) {
    return null;
  }
}

// ── backupMonolith ────────────────────────────────────────────────────────────
// Renames monolith to .bak if monolith exists and .bak does not exist yet.
// Returns { action: 'renamed'|'bak-exists'|'no-source', bakContent: string|null }
//
// NOTE: this function only knows about file presence — it cannot tell a legacy
// pre-migration monolith apart from a regenerated projection cache. The
// already-migrated guard in migrateStore() short-circuits BEFORE this is called
// when the repo is already at CURRENT_SCHEMA with a populated fragment store, so
// a regenerated cache is never mistaken for a legacy monolith and retired.
function backupMonolith(cwd, store, dryRun) {
  const monolithPath = path.join(cwd, store.monolithRel);
  const bakPath      = path.join(cwd, store.bakRel);

  if (!fs.existsSync(monolithPath)) {
    return { action: 'no-source', bakContent: null };
  }

  if (fs.existsSync(bakPath)) {
    // .bak already exists — preserve it, read for verification
    const bakContent = fs.readFileSync(bakPath, 'utf8');
    return { action: 'bak-exists', bakContent };
  }

  // Read monolith content before rename (we need it for verification)
  const bakContent = fs.readFileSync(monolithPath, 'utf8');

  if (!dryRun) {
    fs.renameSync(monolithPath, bakPath);
  }

  return { action: dryRun ? 'would-rename' : 'renamed', bakContent };
}

// ── migrateStore ──────────────────────────────────────────────────────────────
// Runs backup + migration + verification for a single store.
// Returns store result object.
function migrateStore(cwd, store, opts) {
  const { dryRun = false, schemaCurrent = false, storeState = null } = opts;
  const result = {
    name:           store.name,
    bak:            null,    // 'renamed'|'bak-exists'|'no-source'|'would-rename'|'skipped (already-migrated)'
    written:        0,
    skipped:        0,
    would_write:    0,
    skipped_reason: null,   // 'already-migrated'|'inconsistent-schema-current-empty-store'|null
    warnings:       [],
    verification:   null,   // 'identical'|'differs (numbering only)'|'differs'|'no-bak'|'skipped'
    error:          null,
  };

  // Step 0: already-migrated shortcut.
  // When the repo is already at CURRENT_SCHEMA, the monolith on disk is a
  // REGENERATED projection cache — not a legacy pre-migration monolith. Retiring
  // it to .bak would delete the cache and break skills that read it. Decide by
  // schema version + populated fragment store, never by file presence alone.
  if (schemaCurrent && storeState) {
    if (storeState.state === 'migrated') {
      // Fragments are the source of truth and the schema is current → done.
      result.bak            = 'skipped (already-migrated)';
      result.skipped_reason = 'already-migrated';
      result.verification   = 'skipped (already-migrated)';
      return result;
    }
    if (storeState.state === 'unmigrated') {
      // SCHEMA-VERSION claims current, but fragments are empty while the monolith
      // still holds real entries — an inconsistent ("stamped-but-empty") state.
      // Do NOT silently retire the monolith; warn and skip so no history is lost.
      const n = storeState.monolithEntries;
      result.bak            = 'skipped (inconsistent-state)';
      result.skipped_reason = 'inconsistent-schema-current-empty-store';
      result.verification   = 'skipped (inconsistent-state)';
      result.warnings.push(
        `SCHEMA-VERSION is "${CURRENT_SCHEMA}" but the ${store.name} fragment store is empty ` +
        `while ${store.monolithRel} still has ${n} entr${n === 1 ? 'y' : 'ies'}. ` +
        `Not retiring the monolith. Remove .gsd/SCHEMA-VERSION and re-run migrate, ` +
        `or investigate why the fragment store is missing.`
      );
      return result;
    }
    // storeState.state === 'empty' → nothing to migrate; fall through to backup
    // (which reports 'no-source' when the monolith is absent).
  }

  // Step 1: backup
  let bakContent = null;
  try {
    const backup = backupMonolith(cwd, store, dryRun);
    result.bak   = backup.action;
    bakContent   = backup.bakContent;
  } catch (e) {
    result.error = `backup failed: ${e.message}`;
    return result;
  }

  // Step 2: migrate — pass bakPath as source when bakContent is available so the
  // migrator reads from the .bak file (original content) instead of the now-renamed path.
  let migrateResult;
  try {
    const migrateOpts = { dryRun };
    if (bakContent !== null) {
      migrateOpts.source = path.join(cwd, store.bakRel);
    }
    migrateResult = store.migrate(cwd, migrateOpts);
  } catch (e) {
    result.error = `migrate failed: ${e.message}`;
    return result;
  }

  result.written     = migrateResult.written     || 0;
  result.skipped     = migrateResult.skipped      || 0;
  result.would_write = migrateResult.would_write  || 0;
  result.warnings    = migrateResult.warnings     || [];

  // Step 3: verification (skip on dry-run — fragments weren't written)
  if (dryRun) {
    result.verification = 'skipped (dry-run)';
    return result;
  }

  // Only verify if we had a bak to compare against
  if (bakContent === null) {
    result.verification = 'no-bak';
    return result;
  }

  try {
    const rendered       = store.render(cwd);
    result.verification  = compareContent(bakContent, rendered, store.name);
  } catch (e) {
    result.verification = `error: ${e.message}`;
  }

  return result;
}

// ── writeSchemaVersion ────────────────────────────────────────────────────────
function writeSchemaVersion(cwd) {
  const dest = path.join(cwd, '.gsd', 'SCHEMA-VERSION');
  const dir  = path.dirname(dest);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dest, CURRENT_SCHEMA + '\n', 'utf8');
  return CURRENT_SCHEMA;
}

// ── migrateAll ────────────────────────────────────────────────────────────────
// Orchestrates all three stores in order.
// Returns { ledger, decisions, memory, schema_version_written }
function migrateAll(cwd, opts = {}) {
  const { dryRun = false } = opts;

  // Resolve "already migrated" inputs once. The shortcut in migrateStore consults
  // both: SCHEMA-VERSION must be current AND the store's fragments must be
  // populated. storeState is read up-front — stores are independent, so a per-store
  // snapshot taken here stays accurate across the loop.
  const schemaCurrent = readSchemaVersion(cwd) === CURRENT_SCHEMA;
  const state = storeStateMod.storeState(cwd);

  const results = {};
  let anyError = false;

  for (const store of STORES) {
    const r = migrateStore(cwd, store, { dryRun, schemaCurrent, storeState: state[store.name] });
    results[store.name] = r;
    if (r.error) {
      anyError = true;
      // Stop on first error to prevent cascading state corruption
      break;
    }
  }

  if (anyError) {
    results.schema_version_written = null;
    return results;
  }

  // Write SCHEMA-VERSION (skip on dry-run)
  let schemaWritten = null;
  if (!dryRun) {
    schemaWritten = writeSchemaVersion(cwd);
  } else {
    schemaWritten = `(dry-run, would write: ${CURRENT_SCHEMA})`;
  }

  results.schema_version_written = schemaWritten;
  return results;
}

// ── Module exports ────────────────────────────────────────────────────────────
module.exports = { migrateAll };

// ── CLI ───────────────────────────────────────────────────────────────────────
function printUsage() {
  console.log(`Usage: node forge-migrate.js [options]

Options:
  --cwd <dir>   Working directory (default: process.cwd())
  --dry-run     Preview only — no files written
  --help, -h    Show this help

Description:
  Orchestrates the three Forge fragment-store migrations in order:
    1. LEDGER.md        → .gsd/ledger/*.md
    2. DECISIONS.md     → .gsd/decisions/*.md
    3. AUTO-MEMORY.md   → .gsd/memory/*.md

  Each legacy monolith is renamed to <name>.bak before migration.
  Existing .bak files are preserved (never overwritten).
  After migration, renders via forge-projection and diffs against .bak.
  Writes .gsd/SCHEMA-VERSION on success.
  Idempotent: second run reports written:0 for each store.
  Already-migrated shortcut: when SCHEMA-VERSION is current AND the fragment
  store is populated, the monolith is a regenerated cache and is left untouched
  (no .bak) — reported as skipped_reason: "already-migrated".

Exit codes:
  0  Success
  1  Migration error (partial state; .bak files kept)
  2  Bad arguments`);
}

function cliMain(argv) {
  let cwd    = process.cwd();
  let dryRun = false;

  const cwdIdx = argv.indexOf('--cwd');
  if (cwdIdx !== -1) {
    cwd = argv[cwdIdx + 1];
    if (!cwd) {
      process.stderr.write('--cwd requires a directory argument\n');
      process.exit(2);
    }
    argv = argv.filter((_, i) => i !== cwdIdx && i !== cwdIdx + 1);
  }

  if (argv.includes('--dry-run')) dryRun = true;

  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const unknowns = argv.filter(a => a.startsWith('--') && a !== '--dry-run');
  if (unknowns.length > 0) {
    process.stderr.write(`Unknown argument(s): ${unknowns.join(', ')}\n\n`);
    printUsage();
    process.exit(2);
  }

  let results;
  try {
    results = migrateAll(cwd, { dryRun });
  } catch (e) {
    process.stderr.write(`Migration failed: ${e.message}\n`);
    process.exit(1);
  }

  // Print summary
  console.log(JSON.stringify(results, null, 2));

  // Exit 1 if any store errored
  const hasError = STORES.some(s => results[s.name] && results[s.name].error);
  if (hasError) process.exit(1);
}

if (require.main === module) {
  try {
    cliMain(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}
