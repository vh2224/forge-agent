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
  consolidateAxis,
  runBaseline,
  MILESTONE_THRESHOLD,
  TASK_THRESHOLD,
  DECISIONS_THRESHOLD,
} = require('./forge-maintenance-baseline');

const ledger = require('./forge-ledger.js');
const decisions = require('./forge-decisions.js');
const { isRollupPath } = require('./forge-maintenance-vcs.js');
const { renderLedger, renderDecisions } = require('./forge-projection.js');

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

// REVIEW-FIX (S05, M1/MAJOR): the axes selector name must be `ledgerDecisions`
// end-to-end (detection/spec/skills already used it; the selector previously
// only accepted the bare `'decisions'`, so a caller following the spec —
// `runBaseline(cwd, { axes: ['ledgerDecisions'] })` — silently no-op'd the
// decisions axis). This proves the confirmed axis is actually honored on a
// fixture with ONLY closed-quarter decision fragments (no milestones/tasks).
test('runBaseline: axes:["ledgerDecisions"] selector actually consolidates the decisions axis', () => {
  const cwd = mkTmp();
  try {
    const now = new Date('2026-07-15T12:00:00Z'); // Q3 — Q1 closed
    const closedId = 'M-20260201000000-onlydec';
    writeMilestoneSummary(cwd, closedId);
    writeDecisionsFragment(cwd, closedId);

    const result = runBaseline(cwd, { now, axes: ['ledgerDecisions'] });
    assert(result.applied === true, 'runBaseline must apply');
    assert(result.ledgerDecisions.perQuarter.length === 1, 'the closed-quarter decisions axis must actually consolidate');
    assert(result.ledgerDecisions.perQuarter[0].unitIds.includes(closedId), 'consolidated bucket must include the closed-quarter unit');
    const target = path.join(cwd, '.gsd', 'decisions', '_rollup-2026-Q1.md');
    assert(fs.existsSync(target), 'decisions rollup bucket must be written on disk');
    assert(!fs.existsSync(path.join(cwd, '.gsd', 'decisions', `${closedId}.md`)), 'loose decision fragment must be consumed');
  } finally {
    rmrf(cwd);
  }
});

// ── runBaseline / consolidateAxis (T03) ──────────────────────────────────────
// Builds a mixed .gsd fixture: 3 finalized milestones + 1 in-progress
// milestone (active per legacy STATE) + 2 finalized tasks + finalized
// decisions in a CLOSED quarter + 1 decision in the CURRENT quarter.
const BASELINE_NOW = new Date('2026-07-15T12:00:00Z'); // Q3 — Q1/Q2 closed

function buildMixedFixture(cwd) {
  const finalizedMilestoneIds = [
    'M-20260101000001-f1',
    'M-20260101000002-f2',
    'M-20260101000003-f3',
  ];
  for (const id of finalizedMilestoneIds) {
    writeMilestoneSummary(cwd, id);
    writeLedgerFragment(cwd, id);
  }

  const inProgressId = 'M-20260101000004-inprogress';
  writeLedgerFragment(cwd, inProgressId); // done-evidence present...
  writeLegacyState(cwd, { activeMilestone: inProgressId, phase: 'execute-task' }); // ...but active per STATE

  const finalizedTaskIds = [
    'T-20260101000005-t1',
    'T-20260101000006-t2',
  ];
  for (const id of finalizedTaskIds) {
    writeTaskSummary(cwd, id);
    writeLedgerFragment(cwd, id);
  }

  const closedQuarterDecisionId = 'M-20260201000000-decclosed'; // Feb -> Q1, closed rel. to Q3
  writeMilestoneSummary(cwd, closedQuarterDecisionId);
  writeDecisionsFragment(cwd, closedQuarterDecisionId);

  const currentQuarterDecisionId = 'M-20260706000000-deccurrent'; // July -> Q3, current
  writeMilestoneSummary(cwd, currentQuarterDecisionId);
  writeDecisionsFragment(cwd, currentQuarterDecisionId);

  return {
    finalizedMilestoneIds,
    inProgressId,
    finalizedTaskIds,
    closedQuarterDecisionId,
    currentQuarterDecisionId,
  };
}

function readBucketIds(bucketPath) {
  const { parseBucket, normalizeText } = require('./forge-maintenance.js');
  const content = fs.readFileSync(bucketPath, 'utf8');
  return parseBucket(normalizeText(content)).units.map(u => u.id);
}

test('consolidateAxis: fuses given units into a fresh bucket, asserts isRollupPath, invalidates cache', () => {
  const cwd = mkTmp();
  try {
    const id = 'M-20260101000001-solo';
    writeLedgerFragment(cwd, id);
    const src = path.join(cwd, '.gsd', 'ledger', `${id}.md`);
    const target = path.join(cwd, '.gsd', 'archive', 'milestones-rollup.md');

    let invalidated = false;
    const result = consolidateAxis(cwd, {
      units: [src], target, type: 'ledger', invalidate: () => { invalidated = true; },
    });

    assert(fs.existsSync(target), 'target bucket must be written');
    assert(result.unitIds.includes(id), 'result must report the consolidated unit id');
    assert(invalidated === true, 'invalidate callback must be called');
    const rel = path.relative(cwd, target).replace(/\\/g, '/');
    assert(isRollupPath(rel), 'written target must satisfy isRollupPath()');
  } finally {
    rmrf(cwd);
  }
});

test('consolidateAxis: refuses to write a target that does not satisfy isRollupPath()', () => {
  const cwd = mkTmp();
  try {
    const id = 'M-20260101000001-solo';
    writeLedgerFragment(cwd, id);
    const src = path.join(cwd, '.gsd', 'ledger', `${id}.md`);
    const badTarget = path.join(cwd, '.gsd', 'archive', 'plain-name.md');
    let threw = false;
    try {
      consolidateAxis(cwd, { units: [src], target: badTarget, type: 'ledger' });
    } catch (e) {
      threw = true;
      assert(/isRollupPath/.test(e.message), 'error must name the isRollupPath guard');
    }
    assert(threw, 'must throw for a non-rollup target name');
    assert(!fs.existsSync(badTarget), 'must not have written the bad target');
  } finally {
    rmrf(cwd);
  }
});

test('runBaseline: consolidates only finalized loose units per axis, excludes active + current-quarter', () => {
  const cwd = mkTmp();
  try {
    const fx = buildMixedFixture(cwd);

    const beforeLedger = renderLedger(cwd);
    const beforeDecisions = renderDecisions(cwd);

    const result = runBaseline(cwd, { now: BASELINE_NOW });

    assert(result.applied === true, 'runBaseline must report applied:true');
    assert(result.verified === true, 'runBaseline must report verified:true');

    const milestonesTarget = path.join(cwd, '.gsd', 'archive', 'milestones-rollup.md');
    const tasksTarget = path.join(cwd, '.gsd', 'archive', 'tasks-rollup.md');
    const closedTarget = path.join(cwd, '.gsd', 'decisions', '_rollup-2026-Q1.md');

    assert(fs.existsSync(milestonesTarget), 'milestones-rollup.md must exist');
    assert(fs.existsSync(tasksTarget), 'tasks-rollup.md must exist');
    assert(fs.existsSync(closedTarget), '_rollup-2026-Q1.md must exist');

    const milestoneIdsInBucket = readBucketIds(milestonesTarget);
    for (const id of fx.finalizedMilestoneIds) {
      assert(milestoneIdsInBucket.includes(id), `bucket must contain finalized milestone ${id}`);
    }
    assert(!milestoneIdsInBucket.includes(fx.inProgressId), 'bucket must NOT contain the in-progress milestone');
    assert(milestoneIdsInBucket.length === fx.finalizedMilestoneIds.length, 'bucket must contain exactly the 3 finalized milestones');

    const taskIdsInBucket = readBucketIds(tasksTarget);
    assert(taskIdsInBucket.length === fx.finalizedTaskIds.length, 'bucket must contain exactly the 2 finalized tasks');
    for (const id of fx.finalizedTaskIds) {
      assert(taskIdsInBucket.includes(id), `bucket must contain finalized task ${id}`);
    }

    const decisionIdsInBucket = readBucketIds(closedTarget);
    assert(decisionIdsInBucket.includes(fx.closedQuarterDecisionId), 'closed-quarter bucket must contain the closed decision unit');
    assert(!decisionIdsInBucket.includes(fx.currentQuarterDecisionId), 'closed-quarter bucket must NOT contain the current-quarter unit');

    // Current-quarter decision + in-progress milestone remain loose.
    assert(fs.existsSync(path.join(cwd, '.gsd', 'decisions', `${fx.currentQuarterDecisionId}.md`)), 'current-quarter decision must remain loose');
    assert(fs.existsSync(path.join(cwd, '.gsd', 'ledger', `${fx.inProgressId}.md`)), 'in-progress milestone must remain loose');

    // isRollupPath satisfied for every written target.
    for (const t of [milestonesTarget, tasksTarget, closedTarget]) {
      const rel = path.relative(cwd, t).replace(/\\/g, '/');
      assert(isRollupPath(rel), `${rel} must satisfy isRollupPath()`);
    }

    // .bak present for every consumed source.
    for (const id of fx.finalizedMilestoneIds) {
      assert(fs.existsSync(path.join(cwd, '.gsd', 'ledger', `${id}.md.bak`)), `.bak must exist for ${id}`);
    }
    for (const id of fx.finalizedTaskIds) {
      assert(fs.existsSync(path.join(cwd, '.gsd', 'ledger', `${id}.md.bak`)), `.bak must exist for ${id}`);
    }
    assert(fs.existsSync(path.join(cwd, '.gsd', 'decisions', `${fx.closedQuarterDecisionId}.md.bak`)), '.bak must exist for the closed-quarter decision');

    // Consumed sources themselves deleted.
    for (const id of fx.finalizedMilestoneIds.concat(fx.finalizedTaskIds)) {
      assert(!fs.existsSync(path.join(cwd, '.gsd', 'ledger', `${id}.md`)), `${id} loose fragment must be deleted after consolidation`);
    }
    assert(!fs.existsSync(path.join(cwd, '.gsd', 'decisions', `${fx.closedQuarterDecisionId}.md`)), 'closed-quarter decision loose fragment must be deleted');

    // Projection byte-identical before vs after (S02 lossless guarantee).
    const afterLedger = renderLedger(cwd);
    const afterDecisions = renderDecisions(cwd);
    assert(afterLedger === beforeLedger, 'renderLedger must be byte-identical before vs after baseline');
    assert(afterDecisions === beforeDecisions, 'renderDecisions must be byte-identical before vs after baseline');

    // Schema bump is NOT this task's job.
    assert(!fs.existsSync(path.join(cwd, '.gsd', 'SCHEMA-VERSION')), 'runBaseline must NOT write .gsd/SCHEMA-VERSION');
  } finally {
    rmrf(cwd);
  }
});

test('runBaseline --dry-run: writes nothing, returns correct per-axis plan', () => {
  const cwd = mkTmp();
  try {
    const fx = buildMixedFixture(cwd);

    const plan = runBaseline(cwd, { dryRun: true, now: BASELINE_NOW });

    assert(plan.dryRun === true, 'dry-run result must set dryRun:true');
    assert(plan.milestones.count === fx.finalizedMilestoneIds.length, `expected ${fx.finalizedMilestoneIds.length} finalized milestones in plan`);
    assert(plan.tasks.count === fx.finalizedTaskIds.length, `expected ${fx.finalizedTaskIds.length} finalized tasks in plan`);
    assert(plan.ledgerDecisions.closedQuarterCount === 1, 'expected exactly 1 closed-quarter decision');
    assert(plan.ledgerDecisions.perQuarter.some(p => p.quarter === '2026-Q1' && p.count === 1), 'plan must list the 2026-Q1 quarter with count 1');

    // Nothing written, nothing deleted.
    assert(!fs.existsSync(path.join(cwd, '.gsd', 'archive')), 'dry-run must not create .gsd/archive');
    assert(!fs.existsSync(path.join(cwd, '.gsd', 'decisions', '_rollup-2026-Q1.md')), 'dry-run must not create the decisions rollup');
    for (const id of fx.finalizedMilestoneIds.concat(fx.finalizedTaskIds)) {
      assert(fs.existsSync(path.join(cwd, '.gsd', 'ledger', `${id}.md`)), `${id} loose fragment must remain untouched by dry-run`);
      assert(!fs.existsSync(path.join(cwd, '.gsd', 'ledger', `${id}.md.bak`)), `dry-run must not create a .bak for ${id}`);
    }
  } finally {
    rmrf(cwd);
  }
});

test('runBaseline: _forceMismatch aborts, restores every source from .bak, removes just-written buckets', () => {
  const cwd = mkTmp();
  try {
    const fx = buildMixedFixture(cwd);

    const originalMilestoneContents = fx.finalizedMilestoneIds.map(id =>
      fs.readFileSync(path.join(cwd, '.gsd', 'ledger', `${id}.md`), 'utf8')
    );
    const originalTaskContents = fx.finalizedTaskIds.map(id =>
      fs.readFileSync(path.join(cwd, '.gsd', 'ledger', `${id}.md`), 'utf8')
    );
    const originalDecisionContent = fs.readFileSync(
      path.join(cwd, '.gsd', 'decisions', `${fx.closedQuarterDecisionId}.md`), 'utf8'
    );

    let threw = false;
    try {
      runBaseline(cwd, { now: BASELINE_NOW, _forceMismatch: true });
    } catch (e) {
      threw = true;
      assert(/mismatch/i.test(e.message), 'abort error must mention the mismatch');
    }
    assert(threw, 'runBaseline must throw on forced mismatch');

    // Every source restored, byte-identical to its pre-run content.
    fx.finalizedMilestoneIds.forEach((id, i) => {
      const restored = fs.readFileSync(path.join(cwd, '.gsd', 'ledger', `${id}.md`), 'utf8');
      assert(restored === originalMilestoneContents[i], `${id} must be restored byte-identical from .bak`);
    });
    fx.finalizedTaskIds.forEach((id, i) => {
      const restored = fs.readFileSync(path.join(cwd, '.gsd', 'ledger', `${id}.md`), 'utf8');
      assert(restored === originalTaskContents[i], `${id} must be restored byte-identical from .bak`);
    });
    const restoredDecision = fs.readFileSync(path.join(cwd, '.gsd', 'decisions', `${fx.closedQuarterDecisionId}.md`), 'utf8');
    assert(restoredDecision === originalDecisionContent, 'closed-quarter decision must be restored byte-identical from .bak');

    // No bucket left behind.
    assert(!fs.existsSync(path.join(cwd, '.gsd', 'archive', 'milestones-rollup.md')), 'milestones-rollup.md must be removed on abort');
    assert(!fs.existsSync(path.join(cwd, '.gsd', 'archive', 'tasks-rollup.md')), 'tasks-rollup.md must be removed on abort');
    assert(!fs.existsSync(path.join(cwd, '.gsd', 'decisions', '_rollup-2026-Q1.md')), '_rollup-2026-Q1.md must be removed on abort');

    // No data loss: nothing consumed is actually gone.
    for (const id of fx.finalizedMilestoneIds.concat(fx.finalizedTaskIds)) {
      assert(fs.existsSync(path.join(cwd, '.gsd', 'ledger', `${id}.md`)), `${id} must still exist after abort — no data loss`);
    }
    assert(fs.existsSync(path.join(cwd, '.gsd', 'decisions', `${fx.closedQuarterDecisionId}.md`)), 'closed-quarter decision must still exist after abort — no data loss');
  } finally {
    rmrf(cwd);
  }
});

test('runBaseline: repeat-run abort restores prior consolidated data (no data loss on 2nd baseline)', () => {
  const cwd = mkTmp();
  try {
    // Run 1: clean baseline — consolidates a first batch into the milestones
    // rollup target, which now holds real prior data.
    const run1Id = 'M-20260101000001-run1';
    writeMilestoneSummary(cwd, run1Id);
    writeLedgerFragment(cwd, run1Id);

    const result1 = runBaseline(cwd, { now: BASELINE_NOW });
    assert(result1.applied === true, 'run 1 must apply cleanly');
    assert(result1.verified === true, 'run 1 must verify');

    const milestonesTarget = path.join(cwd, '.gsd', 'archive', 'milestones-rollup.md');
    assert(fs.existsSync(milestonesTarget), 'run 1 must create the milestones rollup');
    const afterRun1 = readBucketIds(milestonesTarget);
    assert(afterRun1.includes(run1Id), 'rollup must contain run 1 unit after run 1');
    assert(!fs.existsSync(milestonesTarget + '.bak'), 'no target .bak should remain after a successful run');

    // Run 2: add more finalized units, then force the post-write verify to
    // fail — this must abort WITHOUT losing run 1's already-consolidated data.
    const run2Id = 'M-20260101000002-run2';
    writeMilestoneSummary(cwd, run2Id);
    writeLedgerFragment(cwd, run2Id);

    let threw = false;
    try {
      runBaseline(cwd, { now: BASELINE_NOW, _forceMismatch: true });
    } catch (e) {
      threw = true;
      assert(/mismatch/i.test(e.message), 'run 2 abort error must mention the mismatch');
    }
    assert(threw, 'run 2 must throw on forced mismatch');

    // The rollup target must still exist and still contain run 1's data —
    // this is the regression this fix addresses: an unconditional unlink
    // on abort would have deleted the entire rollup here.
    assert(fs.existsSync(milestonesTarget), 'rollup target must still exist after aborted run 2 — must not be deleted');
    const afterAbort = readBucketIds(milestonesTarget);
    assert(afterAbort.includes(run1Id), 'run 1 unit must still be present in the rollup after aborted run 2 — no data loss');
    assert(!afterAbort.includes(run2Id), 'run 2 unit must not have been committed to the rollup (its consolidation was aborted)');

    // Run 2's source fragment must be restored (unconsumed), and no orphan
    // target .bak should remain after the abort completes.
    assert(fs.existsSync(path.join(cwd, '.gsd', 'ledger', `${run2Id}.md`)), 'run 2 source fragment must be restored after abort');
    assert(!fs.existsSync(milestonesTarget + '.bak'), 'no orphan target .bak should remain after the abort restore completes');
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
