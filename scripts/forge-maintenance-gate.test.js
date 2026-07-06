#!/usr/bin/env node
// forge-maintenance-gate.test.js — regression suite for the detection/announce
// helper, RED-warning render, and the additive opts.axes selector (T01 of
// S05, M-20260706152250-maintenance-fragment).
//
// Run: node scripts/forge-maintenance-gate.test.js  (exit 0 = all pass, 1 = fail)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { detectMode, renderRedWarning } = require('./forge-maintenance-gate.js');
const {
  runBaseline,
  MILESTONE_THRESHOLD,
} = require('./forge-maintenance-baseline.js');
const ledger = require('./forge-ledger.js');

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

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gate-test-'));
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* noop */ }
}

function writeMilestoneSummary(cwd, id) {
  const dir = path.join(cwd, '.gsd', 'milestones', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}-SUMMARY.md`), `# ${id}\n\nDone.\n`);
}

function writeTaskSummary(cwd, id) {
  const dir = path.join(cwd, '.gsd', 'tasks', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}-SUMMARY.md`), `# ${id}\n\nDone.\n`);
}

function writeLedgerFragment(cwd, id, extra) {
  ledger.writeFragment(cwd, Object.assign({
    id,
    title: `Fragment ${id}`,
    completed_at: '2026-01-01T00:00:00Z',
    slices: [],
    key_files: [],
    key_decisions: [],
  }, extra || {}));
}

function seedFinalizedMilestones(cwd, count) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const id = `M-2026010100${String(1000 + i).slice(1)}0-seed${i}`;
    writeMilestoneSummary(cwd, id);
    writeLedgerFragment(cwd, id);
    ids.push(id);
  }
  return ids;
}

function seedFinalizedTasks(cwd, count) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const id = `T-2026010100${String(1000 + i).slice(1)}0-seed${i}`;
    writeTaskSummary(cwd, id);
    writeLedgerFragment(cwd, id);
    ids.push(id);
  }
  return ids;
}

// ── Fixture A: below threshold, baseline already ran once -> normal ────────
// A pre-existing (empty) milestones-rollup bucket simulates "baseline has
// already happened at least once" — isolates the axis-threshold boundary
// from the separate "1st-ever baseline" signal (that is Fixture C, below).
test('detectMode: below all thresholds, baseline already ran -> mode normal', () => {
  const cwd = mkTmp();
  try {
    seedFinalizedMilestones(cwd, MILESTONE_THRESHOLD - 1);
    const bucketDir = path.join(cwd, '.gsd', 'archive');
    fs.mkdirSync(bucketDir, { recursive: true });
    fs.writeFileSync(path.join(bucketDir, 'milestones-rollup.md'), '# milestones rollup\n');
    const detection = detectMode(cwd, { activeIds: new Set(), enabled: true });
    assert(detection.mode === 'normal', `expected normal, got ${detection.mode}`);
    assert(detection.firedAxes.length === 0, 'no axis should be fired');
    assert(detection.baseline.available === false, 'baseline must not be "available" once a bucket already exists');
  } finally {
    rmrf(cwd);
  }
});

// ── Fixture B: milestones @30 fires ──────────────────────────────────────────
test('detectMode: milestones @30 fires -> mode maintenance, firedAxes includes milestones', () => {
  const cwd = mkTmp();
  try {
    seedFinalizedMilestones(cwd, MILESTONE_THRESHOLD);
    const detection = detectMode(cwd, { activeIds: new Set(), enabled: true });
    assert(detection.mode === 'maintenance', `expected maintenance, got ${detection.mode}`);
    const names = detection.firedAxes.map(f => f.axis);
    assert(names.includes('milestones'), 'firedAxes must include milestones');
    const m = detection.firedAxes.find(f => f.axis === 'milestones');
    assert(m.count >= MILESTONE_THRESHOLD, 'reported count must be >= threshold');
  } finally {
    rmrf(cwd);
  }
});

// ── Fixture C: loose finalized units, no buckets -> baseline available ──────
test('detectMode: loose finalized units below threshold but no rollup buckets -> baseline available, mode maintenance', () => {
  const cwd = mkTmp();
  try {
    seedFinalizedMilestones(cwd, 1); // well below threshold
    const detection = detectMode(cwd, { activeIds: new Set(), enabled: true });
    assert(detection.baseline.available === true, 'baseline must be available (loose units exist, no buckets)');
    assert(detection.mode === 'maintenance', 'baseline-available alone must force mode maintenance');
    assert(detection.firedAxes.length === 0, 'no axis threshold fired in this fixture');
  } finally {
    rmrf(cwd);
  }
});

test('detectMode: after a real runBaseline (bucket exists), baseline is no longer "available" for a fresh set of loose units', () => {
  const cwd = mkTmp();
  try {
    seedFinalizedMilestones(cwd, 1);
    runBaseline(cwd, { activeIds: new Set() });
    // Bucket now exists. Seed one more loose unit — anyLoose true, anyBucket
    // true -> baselineAvailable must be false (this is a subsequent axis
    // firing scenario, not a "first baseline" scenario).
    seedFinalizedMilestones(cwd, 1);
    const detection = detectMode(cwd, { activeIds: new Set(), enabled: true });
    assert(detection.baseline.available === false, 'baseline must not be "available" once a rollup bucket exists');
  } finally {
    rmrf(cwd);
  }
});

// ── renderRedWarning ──────────────────────────────────────────────────────────
test('renderRedWarning: contains banner marker and one line per fired axis', () => {
  const cwd = mkTmp();
  try {
    seedFinalizedMilestones(cwd, MILESTONE_THRESHOLD);
    const detection = detectMode(cwd, { activeIds: new Set(), enabled: true });
    const warning = renderRedWarning(detection);
    assert(/\x1b\[1;31m/.test(warning), 'must contain ANSI bold-red escape');
    assert(/⚠ MAINTENANCE/.test(warning), 'must contain boxed ⚠ MAINTENANCE header');
    assert(/eixo "milestones"/.test(warning), 'must contain a per-axis line for milestones');
    assert(new RegExp(String(MILESTONE_THRESHOLD)).test(warning) || /\d+ unidades/.test(warning), 'must mention the entry count');
  } finally {
    rmrf(cwd);
  }
});

test('renderRedWarning: baseline-available fixture gets a BASELINE line', () => {
  const cwd = mkTmp();
  try {
    seedFinalizedMilestones(cwd, 1);
    const detection = detectMode(cwd, { activeIds: new Set(), enabled: true });
    const warning = renderRedWarning(detection);
    assert(/BASELINE/.test(warning), 'must mention BASELINE when it is the first-ever consolidation');
  } finally {
    rmrf(cwd);
  }
});

// ── opts.axes selective consolidation ────────────────────────────────────────
test('runBaseline: opts.axes=[milestones] consolidates only the milestones axis', () => {
  const cwd = mkTmp();
  try {
    const mIds = seedFinalizedMilestones(cwd, 2);
    const tIds = seedFinalizedTasks(cwd, 2);

    const result = runBaseline(cwd, { activeIds: new Set(), axes: ['milestones'] });
    assert(result.applied === true, 'selective run must apply');

    const milestonesTarget = path.join(cwd, '.gsd', 'archive', 'milestones-rollup.md');
    const tasksTarget = path.join(cwd, '.gsd', 'archive', 'tasks-rollup.md');
    assert(fs.existsSync(milestonesTarget), 'milestones-rollup.md must be written');
    assert(!fs.existsSync(tasksTarget), 'tasks-rollup.md must NOT be written when axes=[milestones]');

    // Milestone loose fragments consumed; task loose fragments untouched.
    for (const id of mIds) {
      assert(!fs.existsSync(path.join(cwd, '.gsd', 'ledger', `${id}.md`)), `${id} milestone fragment must be consumed`);
    }
    for (const id of tIds) {
      assert(fs.existsSync(path.join(cwd, '.gsd', 'ledger', `${id}.md`)), `${id} task fragment must remain untouched`);
    }

    // A follow-up default-axes run fuses the rest.
    const result2 = runBaseline(cwd, { activeIds: new Set() });
    assert(result2.applied === true, 'second default-axes run must apply');
    assert(fs.existsSync(tasksTarget), 'tasks-rollup.md must now exist after the default-axes run');
    for (const id of tIds) {
      assert(!fs.existsSync(path.join(cwd, '.gsd', 'ledger', `${id}.md`)), `${id} task fragment must be consumed by the second run`);
    }
  } finally {
    rmrf(cwd);
  }
});

test('runBaseline: default (no opts.axes) dry-run plan matches an explicit all-axes call', () => {
  const cwd = mkTmp();
  try {
    seedFinalizedMilestones(cwd, 2);
    seedFinalizedTasks(cwd, 2);
    const planDefault = runBaseline(cwd, { activeIds: new Set(), dryRun: true });
    const planAllAxes = runBaseline(cwd, { activeIds: new Set(), dryRun: true, axes: ['milestones', 'tasks', 'decisions'] });
    assert(JSON.stringify(planDefault) === JSON.stringify(planAllAxes), 'default axes must be byte-identical to an explicit all-axes call');
  } finally {
    rmrf(cwd);
  }
});

// ── Opt-in gate (S06/T02) ─────────────────────────────────────────────────────
// The feature must be default-inert: installing the tooling does not change
// behavior until the repo explicitly sets maintenance.enabled: true.
test('detectMode: default (no opts.enabled, no pref file) -> mode normal, enabled false, even when an axis would fire', () => {
  const cwd = mkTmp();
  try {
    seedFinalizedMilestones(cwd, MILESTONE_THRESHOLD);
    const detection = detectMode(cwd, { activeIds: new Set() });
    assert(detection.mode === 'normal', `expected normal, got ${detection.mode}`);
    assert(detection.enabled === false, 'enabled must be false by default');
    assert(detection.firedAxes.length === 0, 'firedAxes must be empty when disabled, even though the axis would fire');
  } finally {
    rmrf(cwd);
  }
});

test('detectMode: opts.enabled explicitly false -> mode normal despite baseline-available fixture', () => {
  const cwd = mkTmp();
  try {
    seedFinalizedMilestones(cwd, 1); // would make baseline "available" if enabled
    const detection = detectMode(cwd, { activeIds: new Set(), enabled: false });
    assert(detection.mode === 'normal', `expected normal, got ${detection.mode}`);
    assert(detection.enabled === false, 'enabled must reflect false');
    assert(detection.baseline.available === false, 'baseline must be reported unavailable when disabled');
  } finally {
    rmrf(cwd);
  }
});

test('detectMode: opts.enabled=true restores S05 behavior for a fired-axis fixture', () => {
  const cwd = mkTmp();
  try {
    seedFinalizedMilestones(cwd, MILESTONE_THRESHOLD);
    const detection = detectMode(cwd, { activeIds: new Set(), enabled: true });
    assert(detection.mode === 'maintenance', `expected maintenance, got ${detection.mode}`);
    assert(detection.enabled === true, 'enabled must be true');
    assert(detection.firedAxes.map(f => f.axis).includes('milestones'), 'firedAxes must include milestones when enabled');
  } finally {
    rmrf(cwd);
  }
});

test('detectMode: enabled field is a boolean in both the disabled and enabled branches', () => {
  const cwd = mkTmp();
  try {
    seedFinalizedMilestones(cwd, 1);
    const off = detectMode(cwd, { activeIds: new Set(), enabled: false });
    const on = detectMode(cwd, { activeIds: new Set(), enabled: true });
    assert(typeof off.enabled === 'boolean', 'enabled must be boolean in disabled branch');
    assert(typeof on.enabled === 'boolean', 'enabled must be boolean in enabled branch');
    assert(off.enabled === false && on.enabled === true, 'enabled must reflect the resolved opt-in state');
  } finally {
    rmrf(cwd);
  }
});

test('detectMode: reads maintenance.enabled from a real pref file (repo-level .gsd/claude-agent-prefs.md) when opts.enabled is not set', () => {
  const cwd = mkTmp();
  try {
    seedFinalizedMilestones(cwd, MILESTONE_THRESHOLD);
    const prefsDir = path.join(cwd, '.gsd');
    fs.mkdirSync(prefsDir, { recursive: true });
    fs.writeFileSync(
      path.join(prefsDir, 'claude-agent-prefs.md'),
      'maintenance:\n  enabled: true\nother_section:\n  noop: true\n'
    );
    const detection = detectMode(cwd, { activeIds: new Set() });
    assert(detection.enabled === true, 'must read maintenance.enabled: true from the repo prefs file');
    assert(detection.mode === 'maintenance', 'must restore S05 behavior when the real pref says enabled: true');
  } finally {
    rmrf(cwd);
  }
});

// ── Determinism-token absence ────────────────────────────────────────────────
test('forge-maintenance-gate.js source contains no Math.random, .mtime, localeCompare, or Date', () => {
  const src = fs.readFileSync(path.join(__dirname, 'forge-maintenance-gate.js'), 'utf8');
  assert(!/Math\.random\(/.test(src), 'must not use Math.random');
  assert(!/\.mtime\b/.test(src), 'must not read mtime');
  assert(!/\.localeCompare\(/.test(src), 'must not use localeCompare');
  assert(!/\bnew Date\(/.test(src), 'must not construct a Date');
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
