#!/usr/bin/env node
// fragment-store-compat.test.js — S02 back-compat proof suite (fragment-store@2.0.0).
//
// Proves the two mandatory RISK/ROADMAP guards plus schema-set + anti-downgrade:
//   (a) byte-identical projection before/after PARTIAL bucket consolidation.
//   (b) countFragments/storeState returns N (unit count), not 1, for a fully
//       consolidated store (0 loose fragments, everything in one bucket).
//   (c) dedup precedence — a unit present BOTH loose and in a bucket renders
//       ONCE, with the bucket's content winning (bucket-wins per S01/S02).
//   (d) isValidSchema / checkSchema accept 1.0.0 AND 2.0.0, reject 3.0.0.
//   (e) anti-downgrade — migrateAll() on an already-2.0.0, already-consolidated
//       repo reports 'already-migrated' (no .bak, stamp untouched).
//
// Standalone harness (no jest/vitest) — mirrors fragment-store-guards.test.js.
// Run: node scripts/fragment-store-compat.test.js  (exit 0 = all pass, 1 = fail)

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { mergeBucket }      = require('./forge-maintenance');
const ledgerMod             = require('./forge-ledger');
const decisionsMod          = require('./forge-decisions');
const projection            = require('./forge-projection');
const storeStateMod         = require('./forge-store-state');
const doctor                = require('./forge-doctor');
const migrate                = require('./forge-migrate');

// ── Harness ──────────────────────────────────────────────────────────────────
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

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-compat-'));
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Fixtures use LF-only content (writeAtomic convention) — CRLF byte-identity is
// documented as out of scope (S02-PLAN § Notes caveat), not tested here.

function ledgerEntry(id, title, completedAt, slices) {
  return {
    id,
    title,
    completed_at: completedAt,
    slices: slices || ['S01'],
    key_files: ['scripts/example.js'],
    key_decisions: ['Example decision'],
    body: `Body for ${id}.`,
  };
}

function decisionsFragment(unitId, decisions) {
  return { unit_id: unitId, decisions };
}

// mkStore: writes 3 loose ledger fragments + 2 loose decisions fragments into
// a fresh tmpdir via the real writers (never hand-built strings).
function mkStore(tmp) {
  // 2 timestamp ids + 1 legacy id — matches the ledger fragment convention.
  ledgerMod.writeFragment(tmp, ledgerEntry('M-20260101000000-alfa', 'Alfa', '2026-01-01T00:00:00Z', ['S01']));
  ledgerMod.writeFragment(tmp, ledgerEntry('M-20260102000000-beta', 'Beta', '2026-01-02T00:00:00Z', ['S01', 'S02']));
  ledgerMod.writeFragment(tmp, ledgerEntry('M001', 'Legacy Gamma', '2026-01-03T00:00:00Z', ['S01']));

  decisionsMod.writeFragment(tmp, decisionsFragment('M-20260101000000-alfa', [
    { when: '2026-01-01', scope: 'S01', decision: 'Use postgres', choice: 'sim', rationale: 'escala', revisable: 'no' },
  ]));
  decisionsMod.writeFragment(tmp, decisionsFragment('M-20260102000000-beta', [
    { when: '2026-01-02', scope: 'S02', decision: 'Use redis', choice: 'standalone', rationale: 'performance', revisable: 'yes' },
  ]));
}

function ledgerFragmentIds(tmp) {
  return fs.readdirSync(path.join(tmp, '.gsd', 'ledger'))
    .filter(f => f.endsWith('.md') && !f.startsWith('_'))
    .map(f => f.slice(0, -3));
}

function ledgerFragmentPaths(tmp, ids) {
  return ids.map(id => path.join(tmp, '.gsd', 'ledger', `${id}.md`));
}

function decisionsFragmentIds(tmp) {
  return fs.readdirSync(path.join(tmp, '.gsd', 'decisions'))
    .filter(f => f.endsWith('.md') && !f.startsWith('_'))
    .map(f => f.slice(0, -3));
}

function decisionsFragmentPaths(tmp, ids) {
  return ids.map(id => path.join(tmp, '.gsd', 'decisions', `${id}.md`));
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== fragment-store compat — S02 back-compat proof suite ===\n');

// ── (a) byte-identical projection: half-consolidated state ─────────────────
console.log('(a) byte-identical projection before/after partial consolidation');

test('renderLedger byte-identical before/after consolidating 2 of 3 fragments into a bucket', () => {
  const tmp = mkTmp();
  try {
    mkStore(tmp);
    const before = projection.renderLedger(tmp);

    const ids = ledgerFragmentIds(tmp).sort(); // bytewise — deterministic
    assert(ids.length === 3, `expected 3 loose ledger fragments, got ${ids.length}`);
    const toConsolidate = ids.slice(0, 2); // leave >=1 loose, per plan step 2(a)
    const paths = ledgerFragmentPaths(tmp, toConsolidate);

    const result = mergeBucket(paths, { type: 'ledger' });
    fs.writeFileSync(path.join(tmp, '.gsd', 'ledger', '_rollup-2026-Q1.md'), result.content, 'utf8');
    for (const p of paths) fs.unlinkSync(p);

    const after = projection.renderLedger(tmp);
    assert(before === after, 'renderLedger output changed after partial consolidation');
    // Sanity: still half-consolidated (>=1 loose fragment left)
    assert(ledgerFragmentIds(tmp).length === 1, 'expected exactly 1 loose ledger fragment left');
  } finally { rmrf(tmp); }
});

test('renderDecisions byte-identical before/after consolidating 1 of 2 fragments into a bucket', () => {
  const tmp = mkTmp();
  try {
    mkStore(tmp);
    const before = projection.renderDecisions(tmp);

    const ids = decisionsFragmentIds(tmp).sort();
    assert(ids.length === 2, `expected 2 loose decisions fragments, got ${ids.length}`);
    const toConsolidate = ids.slice(0, 1); // leave 1 loose
    const paths = decisionsFragmentPaths(tmp, toConsolidate);

    const result = mergeBucket(paths, { type: 'decisions' });
    fs.writeFileSync(path.join(tmp, '.gsd', 'decisions', '_rollup-2026-Q1.md'), result.content, 'utf8');
    for (const p of paths) fs.unlinkSync(p);

    const after = projection.renderDecisions(tmp);
    assert(before === after, 'renderDecisions output changed after partial consolidation');
    assert(decisionsFragmentIds(tmp).length === 1, 'expected exactly 1 loose decisions fragment left');
  } finally { rmrf(tmp); }
});

// ── (b) counter-guard: fully consolidated store returns N, not 1 ───────────
console.log('\n(b) counter-guard — fully consolidated store reports N units, not 1');

test('storeState + listFragments report 3 ledger units after full consolidation into one bucket', () => {
  const tmp = mkTmp();
  try {
    mkStore(tmp);
    const ids = ledgerFragmentIds(tmp).sort();
    assert(ids.length === 3, `expected 3 loose ledger fragments, got ${ids.length}`);
    const paths = ledgerFragmentPaths(tmp, ids);

    const result = mergeBucket(paths, { type: 'ledger' });
    fs.writeFileSync(path.join(tmp, '.gsd', 'ledger', '_rollup-2026-full.md'), result.content, 'utf8');
    for (const p of paths) fs.unlinkSync(p);

    assert(ledgerFragmentIds(tmp).length === 0, 'expected 0 loose ledger fragments after full consolidation');

    const st = storeStateMod.storeState(tmp);
    assert(st.ledger.fragments === 3, `expected storeState.ledger.fragments === 3, got ${st.ledger.fragments}`);
    assert(st.ledger.state === 'migrated', `expected state 'migrated', got '${st.ledger.state}'`);

    assert(ledgerMod.listFragments(tmp).length === 3, `expected listFragments length 3, got ${ledgerMod.listFragments(tmp).length}`);
  } finally { rmrf(tmp); }
});

// ── (c) dedup — bucket wins ─────────────────────────────────────────────────
console.log('\n(c) dedup precedence — bucket wins over a divergent loose duplicate');

test('renderLedger emits a duplicated id ONCE, with the bucket content winning', () => {
  const tmp = mkTmp();
  try {
    mkStore(tmp);
    const ids = ledgerFragmentIds(tmp).sort();
    const [dupId] = ids;
    const dupPath = path.join(tmp, '.gsd', 'ledger', `${dupId}.md`);
    const bucketSourceContent = fs.readFileSync(dupPath, 'utf8');

    // Consolidate ALL fragments into a bucket first.
    const paths = ledgerFragmentPaths(tmp, ids);
    const result = mergeBucket(paths, { type: 'ledger' });
    fs.writeFileSync(path.join(tmp, '.gsd', 'ledger', '_rollup-dedup.md'), result.content, 'utf8');
    for (const p of paths) fs.unlinkSync(p);

    // Now write back the SAME id as a loose fragment with DIVERGENT content
    // (extra line in the body — never via the bucket engine, this simulates a
    // stray re-write of a loose fragment after its unit was already bucketed).
    const divergentMarker = 'DIVERGENT-LINE-SHOULD-NOT-APPEAR';
    const divergentContent = bucketSourceContent.replace(/\n$/, `\n${divergentMarker}\n`);
    fs.writeFileSync(dupPath, divergentContent, 'utf8');

    // listFragments must report exactly one entry for dupId, sourced from the bucket.
    const entries = ledgerMod.listFragments(tmp).filter(f => f.id === dupId);
    assert(entries.length === 1, `expected exactly 1 entry for ${dupId}, got ${entries.length}`);
    assert(entries[0].bucket === true, 'winning entry should be sourced from the bucket');

    const rendered = projection.renderLedger(tmp);
    const occurrences = rendered.split(`## ${dupId}`).length - 1;
    assert(occurrences === 1, `expected ${dupId} to appear exactly once in renderLedger, got ${occurrences}`);
    assert(!rendered.includes(divergentMarker), 'divergent loose content leaked into the projection — bucket must win');
  } finally { rmrf(tmp); }
});

test('renderLedger emits baseline bucket content when the loose duplicate is IDENTICAL', () => {
  const tmp = mkTmp();
  try {
    mkStore(tmp);
    const ids = ledgerFragmentIds(tmp).sort();
    const [dupId] = ids;
    const dupPath = path.join(tmp, '.gsd', 'ledger', `${dupId}.md`);
    const originalContent = fs.readFileSync(dupPath, 'utf8');

    const paths = ledgerFragmentPaths(tmp, ids);
    const result = mergeBucket(paths, { type: 'ledger' });
    fs.writeFileSync(path.join(tmp, '.gsd', 'ledger', '_rollup-dedup-identical.md'), result.content, 'utf8');
    for (const p of paths) fs.unlinkSync(p);

    // Baseline: render with only the bucket present (no loose duplicate).
    const baseline = projection.renderLedger(tmp);

    // Write back the identical content as a loose fragment.
    fs.writeFileSync(dupPath, originalContent, 'utf8');
    const withIdenticalLoose = projection.renderLedger(tmp);

    assert(baseline === withIdenticalLoose, 'render should be unchanged when the loose duplicate is byte-identical to the bucket entry');
  } finally { rmrf(tmp); }
});

// ── (d) schema set ───────────────────────────────────────────────────────────
console.log('\n(d) schema set — 1.0.0 and 2.0.0 both valid; 3.0.0 invalid');

test('isValidSchema accepts fragment-store@1.0.0 and fragment-store@2.0.0, rejects @3.0.0', () => {
  assert(doctor.isValidSchema('fragment-store@1.0.0') === true, '1.0.0 should be valid');
  assert(doctor.isValidSchema('fragment-store@2.0.0') === true, '2.0.0 should be valid');
  assert(doctor.isValidSchema('fragment-store@3.0.0') === false, '3.0.0 should be invalid');
});

test('checkSchema ok:true for a 1.0.0 stamp and ok:true for a 2.0.0 stamp; ok:false for 3.0.0', () => {
  for (const [version, expectOk] of [['fragment-store@1.0.0', true], ['fragment-store@2.0.0', true], ['fragment-store@3.0.0', false]]) {
    const tmp = mkTmp();
    try {
      fs.mkdirSync(path.join(tmp, '.gsd'), { recursive: true });
      fs.writeFileSync(path.join(tmp, '.gsd', 'SCHEMA-VERSION'), version + '\n', 'utf8');
      const res = doctor.checkSchema(tmp);
      assert(res.ok === expectOk, `checkSchema(${version}).ok expected ${expectOk}, got ${res.ok}`);
    } finally { rmrf(tmp); }
  }
});

// ── (e) anti-downgrade + already-migrated ────────────────────────────────────
console.log('\n(e) anti-downgrade — a 2.0.0 stamp survives migrateAll on a consolidated store');

test('migrateAll on an already-2.0.0, fully-consolidated repo reports already-migrated (no .bak, stamp untouched)', () => {
  const tmp = mkTmp();
  try {
    mkStore(tmp);
    const ids = ledgerFragmentIds(tmp).sort();
    const paths = ledgerFragmentPaths(tmp, ids);
    const result = mergeBucket(paths, { type: 'ledger' });
    fs.writeFileSync(path.join(tmp, '.gsd', 'ledger', '_rollup-2026-full.md'), result.content, 'utf8');
    for (const p of paths) fs.unlinkSync(p);

    fs.writeFileSync(path.join(tmp, '.gsd', 'SCHEMA-VERSION'), 'fragment-store@2.0.0\n', 'utf8');

    const before = fs.readFileSync(path.join(tmp, '.gsd', 'SCHEMA-VERSION'), 'utf8');
    const results = migrate.migrateAll(tmp, {});

    assert(results.ledger.skipped_reason === 'already-migrated', `expected 'already-migrated', got '${results.ledger.skipped_reason}'`);
    assert(!fs.existsSync(path.join(tmp, '.gsd', 'LEDGER.md.bak')), 'expected NO .gsd/LEDGER.md.bak to be created');

    const after = fs.readFileSync(path.join(tmp, '.gsd', 'SCHEMA-VERSION'), 'utf8');
    assert(after === before, 'SCHEMA-VERSION content changed');
    assert(after.trim() === 'fragment-store@2.0.0', `expected stamp to remain 'fragment-store@2.0.0', got '${after.trim()}'`);
  } finally { rmrf(tmp); }
});

test('writeSchemaVersion never downgrades an existing valid 2.0.0 stamp', () => {
  const tmp = mkTmp();
  try {
    fs.mkdirSync(path.join(tmp, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.gsd', 'SCHEMA-VERSION'), 'fragment-store@2.0.0\n', 'utf8');
    // Force through doctor --fix path is out of scope here (CLI); assert via
    // the storeState-driven migrateAll instead, which calls writeSchemaVersion
    // internally on an empty (non-consolidated) store — still must not downgrade.
    const results = migrate.migrateAll(tmp, {});
    const stamp = fs.readFileSync(path.join(tmp, '.gsd', 'SCHEMA-VERSION'), 'utf8').trim();
    assert(stamp === 'fragment-store@2.0.0', `expected stamp to remain 2.0.0, got '${stamp}'`);
    assert(results.schema_version_written === 'fragment-store@2.0.0', `expected schema_version_written to report 2.0.0, got '${results.schema_version_written}'`);
  } finally { rmrf(tmp); }
});

// ── Negative guard: broken bucket is lenient (T01 posture) ──────────────────
console.log('\nNegative guard — an unparseable bucket does not throw, loose fragments still counted');

test('listFragments does not throw on a broken bucket file; loose fragments still counted; warning on stderr', () => {
  const tmp = mkTmp();
  try {
    mkStore(tmp);
    // Write a broken bucket (invalid header line) alongside the loose fragments.
    fs.writeFileSync(path.join(tmp, '.gsd', 'ledger', '_rollup-broken.md'), 'not a valid bucket header\ngarbage\n', 'utf8');

    let threw = false;
    let entries = null;
    const origWrite = process.stderr.write;
    let stderrBuf = '';
    process.stderr.write = (chunk) => { stderrBuf += chunk; return true; };
    try {
      entries = ledgerMod.listFragments(tmp);
    } catch (e) {
      threw = true;
    } finally {
      process.stderr.write = origWrite;
    }

    assert(threw === false, 'listFragments must not throw on a broken bucket (lenient posture)');
    assert(entries.length === 3, `expected 3 loose fragments still counted, got ${entries ? entries.length : 'null'}`);
    assert(/skipping bucket/.test(stderrBuf), `expected a "skipping bucket" warning on stderr, got: ${stderrBuf}`);
  } finally { rmrf(tmp); }
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
