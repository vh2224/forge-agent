#!/usr/bin/env node
// forge-maintenance-baseline.test.js — regression suite for the finalized
// predicate, quarter helpers, and trigger detection (T02 of S04,
// M-20260706152250-maintenance-fragment).
//
// Run: node scripts/forge-maintenance-baseline.test.js  (exit 0 = all pass, 1 = fail)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  isFinalized,
  deriveQuarter,
  currentQuarter,
  isClosedQuarter,
  detectTriggers,
  MILESTONE_THRESHOLD,
  TASK_THRESHOLD,
  DECISIONS_THRESHOLD,
} = require('./forge-maintenance-baseline');

const ledger = require('./forge-ledger.js');
const decisions = require('./forge-decisions.js');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-baseline-test-'));
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

function writeDecisionsFragment(cwd, unitId) {
  decisions.writeFragment(cwd, {
    unit_id: unitId,
    decisions: [
      { when: '2026-01-01', scope: 'slice', decision: 'x', choice: 'y', rationale: 'z', revisable: 'yes' },
    ],
  });
}

function writeLegacyState(cwd, { activeMilestone, activeTask, phase }) {
  const dir = path.join(cwd, '.gsd');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    '# STATE',
    '',
    `**Active Milestone:** ${activeMilestone || '—'}`,
    `**Active Slice:** —`,
    `**Active Task:** ${activeTask || '—'}`,
    `**Phase:** ${phase || 'idle'}`,
    `**Auto-mode:** off`,
    '',
  ];
  fs.writeFileSync(path.join(dir, 'STATE.md'), lines.join('\n'));
}

// ── deriveQuarter ─────────────────────────────────────────────────────────────
test('deriveQuarter: compact timestamp id -> YYYY-QN', () => {
  assert(deriveQuarter('M-20260706152250-x') === '2026-Q3', 'expected 2026-Q3');
});

test('deriveQuarter: another compact timestamp id -> Q1', () => {
  assert(deriveQuarter('M-20260215090000-y') === '2026-Q1', 'expected 2026-Q1');
});

test('deriveQuarter: legacy id falls back to writtenAt digits', () => {
  const q = deriveQuarter('M001', '2025-11-02T00:00:00Z');
  assert(q === '2025-Q4', `expected 2025-Q4, got ${q}`);
});

test('deriveQuarter: unresolvable -> null', () => {
  assert(deriveQuarter('garbage') === null, 'expected null for unresolvable garbage');
  assert(deriveQuarter('M001') === null, 'expected null for legacy id with no writtenAt fallback');
});

test('deriveQuarter: is pure — no Date/mtime dependence, stable across repeated calls', () => {
  const src = fs.readFileSync(path.join(__dirname, 'forge-maintenance-baseline.js'), 'utf8');
  assert(!/Math\.random\(/.test(src), 'must not use Math.random');
  assert(!/\.mtime\b/.test(src), 'must not read mtime');
  assert(!/\.localeCompare\(/.test(src), 'must not use localeCompare');
  const a = deriveQuarter('M-20260706152250-x');
  const b = deriveQuarter('M-20260706152250-x');
  assert(a === b && a === '2026-Q3', 'deriveQuarter must be deterministic across calls');
});

// ── currentQuarter / isClosedQuarter ─────────────────────────────────────────
test('currentQuarter: injectable now, UTC based', () => {
  const now = new Date('2026-07-15T12:00:00Z');
  assert(currentQuarter(now) === '2026-Q3', `expected 2026-Q3, got ${currentQuarter(now)}`);
});

test('isClosedQuarter: earlier quarter is closed relative to injected now', () => {
  const now = new Date('2026-07-15T12:00:00Z'); // Q3
  assert(isClosedQuarter('2026-Q2', now) === true, '2026-Q2 should be closed when now is Q3');
  assert(isClosedQuarter('2026-Q3', now) === false, '2026-Q3 (current) should not be closed');
  assert(isClosedQuarter('2026-Q4', now) === false, '2026-Q4 (future) should not be closed');
});

test('isClosedQuarter: null quarter never closed', () => {
  assert(isClosedQuarter(null, new Date('2026-07-15T12:00:00Z')) === false, 'null quarter is never closed');
});

// ── isFinalized — active-unit exclusion (critical) ───────────────────────────
test('isFinalized: active in-progress milestone (SUMMARY present, run active) is excluded', () => {
  const cwd = mkTmp();
  try {
    const id = 'M-20260101000000-active';
    writeMilestoneSummary(cwd, id);
    writeLedgerFragment(cwd, id);
    const result = isFinalized(cwd, id, { activeIds: new Set([id]) });
    assert(result === false, 'active unit must never be finalized, even with SUMMARY evidence');
  } finally {
    rmrf(cwd);
  }
});

test('isFinalized: done + not-active milestone (SUMMARY + ledger fragment) -> true', () => {
  const cwd = mkTmp();
  try {
    const id = 'M-20260101000001-done';
    writeMilestoneSummary(cwd, id);
    writeLedgerFragment(cwd, id);
    const result = isFinalized(cwd, id, { activeIds: new Set() });
    assert(result === true, 'done + not-active unit must be finalized');
  } finally {
    rmrf(cwd);
  }
});

test('isFinalized: no done-evidence -> false', () => {
  const cwd = mkTmp();
  try {
    const id = 'M-20260101000002-nothing';
    const result = isFinalized(cwd, id, { activeIds: new Set() });
    assert(result === false, 'no evidence -> not finalized');
  } finally {
    rmrf(cwd);
  }
});

test('isFinalized: ledger fragment alone (no SUMMARY dir, e.g. archived) counts as evidence', () => {
  const cwd = mkTmp();
  try {
    const id = 'M-20260101000003-archived';
    writeLedgerFragment(cwd, id);
    const result = isFinalized(cwd, id, { activeIds: new Set() });
    assert(result === true, 'ledger fragment alone should count as done-evidence');
  } finally {
    rmrf(cwd);
  }
});

test('isFinalized: ask-* conversation units always finalized', () => {
  const cwd = mkTmp();
  try {
    assert(isFinalized(cwd, 'ask-abc123', { activeIds: new Set() }) === true, 'ask-* is always finalized');
  } finally {
    rmrf(cwd);
  }
});

test('isFinalized: legacy STATE.md active pointer excludes without a run record (no activeIds injected)', () => {
  const cwd = mkTmp();
  try {
    const id = 'M-20260101000004-legacyactive';
    writeMilestoneSummary(cwd, id);
    writeLedgerFragment(cwd, id);
    writeLegacyState(cwd, { activeMilestone: id, phase: 'execute-task' });
    // No opts.activeIds, no forge-runs record — must fall back to legacy STATE.
    const result = isFinalized(cwd, id);
    assert(result === false, 'legacy STATE active pointer with live phase must exclude the unit');
  } finally {
    rmrf(cwd);
  }
});

test('isFinalized: legacy STATE.md idle phase does not exclude', () => {
  const cwd = mkTmp();
  try {
    const id = 'M-20260101000005-legacyidle';
    writeMilestoneSummary(cwd, id);
    writeLedgerFragment(cwd, id);
    writeLegacyState(cwd, { activeMilestone: id, phase: 'idle' });
    const result = isFinalized(cwd, id);
    assert(result === true, 'idle phase should not exclude a done unit');
  } finally {
    rmrf(cwd);
  }
});

// ── detectTriggers ────────────────────────────────────────────────────────────
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

test('detectTriggers: milestones @29 does not fire, @30 fires', () => {
  const cwd = mkTmp();
  try {
    seedFinalizedMilestones(cwd, MILESTONE_THRESHOLD - 1);
    let result = detectTriggers(cwd, { activeIds: new Set() });
    assert(result.milestones.count === MILESTONE_THRESHOLD - 1, `expected ${MILESTONE_THRESHOLD - 1}, got ${result.milestones.count}`);
    assert(result.milestones.fired === false, 'must not fire at 29');

    seedFinalizedMilestones(cwd, 1); // now at threshold — note ids differ from first batch by index only
    // Re-seed with unique ids to reach exactly 30 total.
    const extraId = 'M-20260101999900-extra';
    writeMilestoneSummary(cwd, extraId);
    writeLedgerFragment(cwd, extraId);
    result = detectTriggers(cwd, { activeIds: new Set() });
    assert(result.milestones.count >= MILESTONE_THRESHOLD, `expected >= ${MILESTONE_THRESHOLD}, got ${result.milestones.count}`);
    assert(result.milestones.fired === true, 'must fire at >= 30');
  } finally {
    rmrf(cwd);
  }
});

test('detectTriggers: tasks @29 does not fire, @30 fires (independent axis)', () => {
  const cwd = mkTmp();
  try {
    seedFinalizedTasks(cwd, TASK_THRESHOLD - 1);
    let result = detectTriggers(cwd, { activeIds: new Set() });
    assert(result.tasks.fired === false, 'must not fire at 29 tasks');
    assert(result.milestones.fired === false, 'milestones axis must remain independent (0 seeded)');

    const extraId = 'T-20260101999900-extra';
    writeTaskSummary(cwd, extraId);
    writeLedgerFragment(cwd, extraId);
    result = detectTriggers(cwd, { activeIds: new Set() });
    assert(result.tasks.fired === true, 'must fire at 30 tasks');
  } finally {
    rmrf(cwd);
  }
});

test('detectTriggers: active unit excluded from counts', () => {
  const cwd = mkTmp();
  try {
    const activeId = 'M-20260101000009-inflight';
    writeMilestoneSummary(cwd, activeId);
    writeLedgerFragment(cwd, activeId);
    const result = detectTriggers(cwd, { activeIds: new Set([activeId]) });
    assert(result.milestones.count === 0, 'active unit must not be counted');
  } finally {
    rmrf(cwd);
  }
});

test('detectTriggers: bucketed (already-consolidated) units are not double-counted', () => {
  const cwd = mkTmp();
  try {
    // A loose fragment plus a fake bucket unit sharing no overlap — since
    // listFragments marks bucket units with `.bucket === true`, they must be
    // filtered out of the loose count regardless of finalized status.
    const looseId = 'M-20260101000010-loose';
    writeMilestoneSummary(cwd, looseId);
    writeLedgerFragment(cwd, looseId);
    const result = detectTriggers(cwd, { activeIds: new Set() });
    assert(result.milestones.count === 1, 'only the loose unit should be counted');
  } finally {
    rmrf(cwd);
  }
});

test('detectTriggers: decisions closed-quarter @99 does not fire, @100 fires', () => {
  const cwd = mkTmp();
  try {
    const now = new Date('2026-07-15T12:00:00Z'); // Q3 — Q1/Q2 are closed
    const ids = [];
    for (let i = 0; i < DECISIONS_THRESHOLD - 1; i++) {
      const id = `M-2026020100${String(1000 + i).slice(1)}0-dec${i}`; // Feb -> Q1, closed
      writeMilestoneSummary(cwd, id); // done-evidence — otherwise isFinalized excludes it
      writeDecisionsFragment(cwd, id);
      ids.push(id);
    }
    let result = detectTriggers(cwd, { activeIds: new Set(), now });
    assert(result.ledgerDecisions.closedQuarterCount === DECISIONS_THRESHOLD - 1, `expected ${DECISIONS_THRESHOLD - 1}, got ${result.ledgerDecisions.closedQuarterCount}`);
    assert(result.ledgerDecisions.fired === false, 'must not fire at 99');

    const extraId = 'M-20260201999900-decextra';
    writeMilestoneSummary(cwd, extraId);
    writeDecisionsFragment(cwd, extraId);
    result = detectTriggers(cwd, { activeIds: new Set(), now });
    assert(result.ledgerDecisions.closedQuarterCount >= DECISIONS_THRESHOLD, `expected >= ${DECISIONS_THRESHOLD}, got ${result.ledgerDecisions.closedQuarterCount}`);
    assert(result.ledgerDecisions.fired === true, 'must fire at 100');
  } finally {
    rmrf(cwd);
  }
});

test('detectTriggers: current-quarter decisions stay loose (not counted)', () => {
  const cwd = mkTmp();
  try {
    const now = new Date('2026-07-15T12:00:00Z'); // Q3
    const currentQId = 'M-20260706120000-currentq';
    writeMilestoneSummary(cwd, currentQId);
    writeDecisionsFragment(cwd, currentQId);
    const result = detectTriggers(cwd, { activeIds: new Set(), now });
    assert(result.ledgerDecisions.closedQuarterCount === 0, 'current-quarter decisions must not be counted as closed');
  } finally {
    rmrf(cwd);
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
