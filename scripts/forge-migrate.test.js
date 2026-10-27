#!/usr/bin/env node
// forge-migrate.test.js — regression suite for the already-migrated guard.
//
//   Bug: backupMonolith decided to retire a monolith to .bak purely by file
//   presence — no SCHEMA-VERSION / fragment-store check. On a repo already
//   migrated to the prior fragment-store major whose monoliths are REGENERATED projection
//   caches, the first `forge-migrate` (run by /forge-update) renamed those caches
//   to .bak and never regenerated them, so they vanished from disk and skills
//   like forge-sweep aborted with "Project not initialized".
//
//   Fix: migrateStore short-circuits when SCHEMA-VERSION is current AND the
//   store's fragments are populated, reporting skipped_reason 'already-migrated'
//   and leaving the monolith untouched (no .bak). An inconsistent
//   "schema current but fragment store empty" state warns instead of retiring.
//
// Run: node scripts/forge-migrate.test.js  (exit 0 = all pass, 1 = fail)

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const migrate    = require('./forge-migrate');
const projection = require('./forge-projection');
const { CURRENT_SCHEMA } = require('./forge-doctor');

// ── Harness ───────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// ── Fixtures ────────────────────────────────────────────────────────────────────
const LEDGER_CONTENT =
  '## M-20260101000000-smoke — Smoke milestone\n' +
  '\n' +
  '**Slices:** S01\n' +
  '\n' +
  '**Key files:** scripts/forge-migrate.js\n' +
  '\n' +
  '**Key decisions:** D12\n';

const DECISIONS_CONTENT =
  '# Forge Decisions Log\n' +
  '\n' +
  '| # | When | Scope | Decision | Choice | Rationale | Revisable? |\n' +
  '|---|------|-------|----------|--------|-----------|------------|\n' +
  '| 1 | 2026-01-01 | M-20260101000000-smoke | Use fragment store | Yes | Scalability | No |\n';

const MEMORY_CONTENT =
  '# Forge Auto-Memory\n' +
  '\n' +
  '- [MEM001] (convention) confidence:0.90 hits:3 — Smoke test memory entry\n' +
  '  source: task/T01 | updated: 2026-01-01\n';

const MONOLITHS = [
  { rel: '.gsd/LEDGER.md',      content: LEDGER_CONTENT },
  { rel: '.gsd/DECISIONS.md',   content: DECISIONS_CONTENT },
  { rel: '.gsd/AUTO-MEMORY.md', content: MEMORY_CONTENT },
];
const STORE_NAMES = ['ledger', 'decisions', 'memory'];

function mkTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-migrate-test-'));
  fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
  return dir;
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
}

function writeMonoliths(cwd) {
  for (const { rel, content } of MONOLITHS) {
    fs.writeFileSync(path.join(cwd, rel), content, 'utf8');
  }
}

function bakExists(cwd, rel) {
  return fs.existsSync(path.join(cwd, rel + '.bak'));
}

// Builds an already-migrated repo whose monoliths are REGENERATED caches:
//   1. genuine migration (monoliths → fragments, creates .bak + SCHEMA-VERSION)
//   2. regenerate monoliths from fragments (projection.writeAll)
//   3. delete the .bak files — now the monoliths are caches with no .bak,
//      exactly the state /forge-update lands a second time on.
function buildMigratedRepo(cwd) {
  writeMonoliths(cwd);
  const first = migrate.migrateAll(cwd);
  assert(!first.ledger.error && !first.decisions.error && !first.memory.error,
    'setup: genuine migration should not error');
  const w = projection.writeAll(cwd, {});
  assert((w.blocked || []).length === 0, 'setup: writeAll should not be blocked on a migrated store');
  for (const { rel } of MONOLITHS) {
    const bak = path.join(cwd, rel + '.bak');
    if (fs.existsSync(bak)) fs.rmSync(bak);
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────────

test('already-migrated repo: monoliths are NOT retired to .bak', () => {
  const cwd = mkTmp();
  try {
    buildMigratedRepo(cwd);

    // Pre-condition: SCHEMA-VERSION current, fragments populated, monoliths present, no .bak.
    assert(fs.readFileSync(path.join(cwd, '.gsd', 'SCHEMA-VERSION'), 'utf8').trim() === CURRENT_SCHEMA,
      'pre: SCHEMA-VERSION is current');
    for (const { rel } of MONOLITHS) {
      assert(fs.existsSync(path.join(cwd, rel)), `pre: ${rel} regenerated cache present`);
      assert(!bakExists(cwd, rel), `pre: ${rel}.bak should have been removed`);
    }
    const before = MONOLITHS.map(({ rel }) => fs.readFileSync(path.join(cwd, rel), 'utf8'));

    // Act: this is the second forge-migrate (the one /forge-update triggers).
    const res = migrate.migrateAll(cwd);

    for (const name of STORE_NAMES) {
      assert(res[name].skipped_reason === 'already-migrated',
        `${name}: skipped_reason should be 'already-migrated', got '${res[name].skipped_reason}'`);
      assert(res[name].bak === 'skipped (already-migrated)',
        `${name}: bak action should be 'skipped (already-migrated)', got '${res[name].bak}'`);
      assert(!res[name].error, `${name}: no error expected`);
    }

    // Monoliths still present and byte-identical; no .bak created.
    MONOLITHS.forEach(({ rel }, i) => {
      assert(fs.existsSync(path.join(cwd, rel)), `post: ${rel} still present`);
      assert(!bakExists(cwd, rel), `post: ${rel}.bak must NOT be created`);
      assert(fs.readFileSync(path.join(cwd, rel), 'utf8') === before[i],
        `post: ${rel} content unchanged`);
    });
  } finally {
    rmrf(cwd);
  }
});

test('an earlier schema major with populated fragments is already migrated', () => {
  const cwd = mkTmp();
  try {
    buildMigratedRepo(cwd);
    const legacySchema = ['fragment-store', '1.0.0'].join('@');
    fs.writeFileSync(path.join(cwd, '.gsd', 'SCHEMA-VERSION'), legacySchema + '\n', 'utf8');
    const res = migrate.migrateAll(cwd);
    for (const name of STORE_NAMES) {
      assert(res[name].skipped_reason === 'already-migrated', `${name}: legacy major should skip`);
    }
    for (const { rel } of MONOLITHS) assert(!bakExists(cwd, rel), `${rel}.bak must not be created`);
  } finally {
    rmrf(cwd);
  }
});

test('compatible legacy stamp is refreshed only after the no-backup shortcut', () => {
  const cwd = mkTmp();
  try {
    buildMigratedRepo(cwd);
    fs.writeFileSync(path.join(cwd, '.gsd', 'SCHEMA-VERSION'), ['fragment-store', '1.0.0'].join('@') + '\n', 'utf8');
    const result = migrate.migrateAll(cwd);
    assert(result.schema_version_written === CURRENT_SCHEMA, 'migration refreshes the stamp to current schema');
    for (const { rel } of MONOLITHS) {
      assert(fs.existsSync(path.join(cwd, rel)), `${rel} cache remains present`);
      assert(!bakExists(cwd, rel), `${rel} must not be backed up during schema refresh`);
    }
  } finally {
    rmrf(cwd);
  }
});

test('a schema newer than tooling does not use the compatible-stamp shortcut', () => {
  const cwd = mkTmp();
  try {
    buildMigratedRepo(cwd);
    fs.writeFileSync(path.join(cwd, '.gsd', 'SCHEMA-VERSION'), ['fragment-store', '99.0.0'].join('@') + '\n', 'utf8');
    const result = migrate.migrateAll(cwd, { dryRun: true });
    for (const name of STORE_NAMES) {
      assert(result[name].skipped_reason !== 'already-migrated', `${name}: newer stamp is not compatible`);
    }
  } finally {
    rmrf(cwd);
  }
});

test('genuine first migration still retires monoliths and populates fragments', () => {
  const cwd = mkTmp();
  try {
    writeMonoliths(cwd);
    // No SCHEMA-VERSION, no fragments → must take the normal migration path.
    const res = migrate.migrateAll(cwd);

    for (const name of STORE_NAMES) {
      assert(res[name].skipped_reason === null,
        `${name}: skipped_reason should be null on genuine migration, got '${res[name].skipped_reason}'`);
      assert(res[name].bak === 'renamed',
        `${name}: bak action should be 'renamed', got '${res[name].bak}'`);
      assert(!res[name].error, `${name}: no error expected`);
    }
    assert(res.schema_version_written === CURRENT_SCHEMA, 'SCHEMA-VERSION written');

    for (const { rel } of MONOLITHS) {
      assert(bakExists(cwd, rel), `${rel}.bak created`);
    }
    for (const name of STORE_NAMES) {
      const dir = path.join(cwd, '.gsd', name);
      assert(fs.existsSync(dir) && fs.readdirSync(dir).some(f => f.endsWith('.md')),
        `fragment store .gsd/${name}/ populated`);
    }
  } finally {
    rmrf(cwd);
  }
});

test('inconsistent state (schema current + empty store + populated monolith) warns, does not retire', () => {
  const cwd = mkTmp();
  try {
    // Stamp the schema as current but never populate fragments — the
    // "stamped-but-empty" failure mode. Monoliths still hold real content.
    writeMonoliths(cwd);
    fs.writeFileSync(path.join(cwd, '.gsd', 'SCHEMA-VERSION'), CURRENT_SCHEMA + '\n', 'utf8');

    const res = migrate.migrateAll(cwd);

    for (const name of STORE_NAMES) {
      assert(res[name].skipped_reason === 'inconsistent-schema-current-empty-store',
        `${name}: skipped_reason should flag the inconsistent state, got '${res[name].skipped_reason}'`);
      assert(res[name].warnings.length > 0, `${name}: should emit a warning`);
      assert(/not retiring the monolith/i.test(res[name].warnings.join(' ')),
        `${name}: warning explains the monolith is preserved`);
    }
    // Monoliths preserved, no .bak created — no silent history loss.
    for (const { rel, content } of MONOLITHS) {
      assert(fs.existsSync(path.join(cwd, rel)), `${rel} preserved`);
      assert(!bakExists(cwd, rel), `${rel}.bak must NOT be created`);
      assert(fs.readFileSync(path.join(cwd, rel), 'utf8') === content, `${rel} content untouched`);
    }
  } finally {
    rmrf(cwd);
  }
});

test('--dry-run on already-migrated repo writes nothing and reports skip', () => {
  const cwd = mkTmp();
  try {
    buildMigratedRepo(cwd);
    const before = MONOLITHS.map(({ rel }) => fs.readFileSync(path.join(cwd, rel), 'utf8'));

    const res = migrate.migrateAll(cwd, { dryRun: true });

    for (const name of STORE_NAMES) {
      assert(res[name].skipped_reason === 'already-migrated',
        `${name}: dry-run still reports already-migrated`);
    }
    MONOLITHS.forEach(({ rel }, i) => {
      assert(!bakExists(cwd, rel), `dry-run: ${rel}.bak must NOT be created`);
      assert(fs.readFileSync(path.join(cwd, rel), 'utf8') === before[i],
        `dry-run: ${rel} unchanged`);
    });
  } finally {
    rmrf(cwd);
  }
});

function treeSnapshot(root) {
  const rows = [];
  const visit = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + entry.name, file = path.join(directory, entry.name);
      if (entry.isDirectory()) { rows.push([relative + '/']); visit(file, relative + '/'); }
      else rows.push([relative, require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
    }
  };
  visit(root);
  return JSON.stringify(rows);
}

test('first-migration dry-run reads existing monoliths and writes nothing', () => {
  const cwd = mkTmp();
  try {
    writeMonoliths(cwd);
    const before = treeSnapshot(cwd);
    const result = migrate.migrateAll(cwd, { dryRun: true });
    assert(treeSnapshot(cwd) === before, 'dry-run changed the tree');
    for (const name of STORE_NAMES) {
      assert(result[name].bak === 'would-rename', `${name}: expected would-rename`);
      assert(result[name].would_write > 0, `${name}: dry-run lost source entries`);
      assert(result[name].written === 0 && result[name].error === null, `${name}: unexpected write/error`);
      assert(!result[name].warnings.some(w => /not found/i.test(w)), `${name}: source falsely missing`);
    }
    assert(/^\(dry-run/.test(result.schema_version_written), 'dry-run schema not reported');
  } finally { rmrf(cwd); }
});

test('dry-run preserves existing-backup precedence and real migration still writes', () => {
  const cwd = mkTmp();
  try {
    writeMonoliths(cwd);
    const backup = LEDGER_CONTENT + '\n' + LEDGER_CONTENT.replaceAll('M-20260101000000-smoke', 'M-20260102000000-smoke');
    fs.writeFileSync(path.join(cwd, '.gsd/LEDGER.md.bak'), backup);
    const before = treeSnapshot(cwd);
    const dry = migrate.migrateAll(cwd, { dryRun: true });
    assert(dry.ledger.bak === 'bak-exists' && dry.ledger.would_write === 2, 'dry-run did not read backup');
    assert(treeSnapshot(cwd) === before, 'backup dry-run changed the tree');
    const applied = migrate.migrateAll(cwd);
    assert(applied.ledger.written === 2, 'real migration did not retain backup precedence');
    for (const name of STORE_NAMES) {
      assert(applied[name].written > 0 && !applied[name].error, `${name}: real migration failed`);
      assert(applied[name].verification !== 'no-bak', `${name}: backup verification missing`);
      if (name !== 'ledger') assert(applied[name].bak === 'renamed', `${name}: real rename missing`);
    }
    assert(fs.existsSync(path.join(cwd, '.gsd/SCHEMA-VERSION')), 'real schema stamp missing');
    assert(fs.readFileSync(path.join(cwd, '.gsd/LEDGER.md.bak'), 'utf8') === backup, 'backup overwritten');
  } finally { rmrf(cwd); }
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('');
if (failed === 0) {
  console.log(`OK: forge-migrate guard suite passed (${passed}/${passed})`);
  process.exit(0);
} else {
  console.log(`FAIL: ${failed} of ${passed + failed} tests failed`);
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
