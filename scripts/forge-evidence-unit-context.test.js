#!/usr/bin/env node
// forge-evidence-unit-context.test.js — the unit context that names the
// evidence log must exist on all THREE axes and must ADVANCE between
// dispatches (S01 T02, IN-2).
//
// ── CAUSES MEASURED BEFORE ANY FIX (not assumed from the ROADMAP) ─────────────
//
// The ROADMAP named `refreshLegacyAlias` (scripts/forge-runs.js:260) as the
// cause of IN-2. Measured at 5528da6:
//
//   REFUTED — `refreshLegacyAlias` (scripts/forge-runs.js:268-276) ALREADY
//     mirrored `worker` and `worker_started` into auto-mode.json. It was never
//     the reason the unit context failed to advance. Recorded, not silenced;
//     the behaviour is pinned by `refreshLegacyAlias mirrors ...` below so the
//     refutation cannot rot into a fresh guess later.
//
//   CONFIRMED (a) — `skills/forge-next/SKILL.md` had ZERO invocations of
//     `forge-runs.js` (`grep -c "forge-runs.js" skills/forge-next/SKILL.md`
//     → `0`; the same grep on `skills/forge-auto/SKILL.md` → `18`). In step
//     mode `run.worker` was therefore never written, so
//     `forge-hook.js::resolveUnitContext` (scripts/forge-hook.js:169-183 at
//     5528da6) resolved EVERY dispatch to `adhoc`. This is the dominant cause.
//
//   CONFIRMED (b) — the worker field is cleared to `null` between units
//     (`skills/forge-auto/SKILL.md:1457` sequential, `:1556` parallel batch),
//     so every orchestrator-side tool call landing between two dispatches also
//     resolves to `adhoc`. Corroborated live: 9 of the 48 `evidence-*.jsonl`
//     files in `.gsd/forge/` are `…-adhoc.jsonl`.
//
//   CONFIRMED (c) — `worker` is `"UNIT_TYPE/UNIT_ID"` and carries NO slice
//     axis, so even a correctly-advancing worker could not name the slice a
//     tool call belonged to. Fixed by the additive `worker_slice` field.
//
// Causes (a) and (b) are properties of orchestration prose, not of a function;
// what this suite pins executably is the CONSEQUENCE both produce — a unit
// context that does not advance collides two dispatches into one evidence
// file — plus the three-axis return contract and the additive-field
// invariants that make the fix possible.
//
// Run: node scripts/forge-evidence-unit-context.test.js  (exit 0 = all pass)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const runs = require('./forge-runs.js');
const hook = require('./forge-hook.js');
const {
  buildEvidenceFileName,
  SENTINEL_NO_MILESTONE,
  SENTINEL_NO_SLICE,
} = require('./forge-evidence-path.js');

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
function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'expected equality'}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

// ── Fixture ───────────────────────────────────────────────────────────────────
function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-unit-ctx-'));
  fs.mkdirSync(path.join(root, '.gsd', 'forge', 'runs'), { recursive: true });
  return root;
}

const SESSION = 'sess-unit-ctx-0001';
const MILESTONE = 'M-20260813133328-lease-escrita-cross-run';

function seedRun(root, extra) {
  return runs.add(root, Object.assign({
    id: MILESTONE,
    kind: 'milestone',
    session_id: SESSION,
    cwd: root,
  }, extra || {}));
}

// Models the evidence writer exactly as T03 will wire it: resolve the context,
// build the name from the three axes, append one line. The point of the test is
// which FILE the line lands in, so the writer is the smallest thing that can
// answer that.
function writeEvidenceLine(root, sessionId, payload) {
  const ctx = hook.resolveUnitContext(root, sessionId);
  const file = path.join(root, '.gsd', 'forge', buildEvidenceFileName({
    milestone: ctx.milestone === SENTINEL_NO_MILESTONE ? null : ctx.milestone,
    slice: ctx.slice === SENTINEL_NO_SLICE ? null : ctx.slice,
    unit: ctx.unit,
  }));
  fs.appendFileSync(file, `${JSON.stringify(payload)}\n`, 'utf8');
  return path.basename(file);
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log('\n── resolveUnitContext: three axes ───────────────────────────────');

test('resolved run yields {milestone, slice, unit} with real values', () => {
  const root = makeWorkspace();
  try {
    seedRun(root, { worker: 'execute-task/T02', worker_slice: 'S01' });
    const ctx = hook.resolveUnitContext(root, SESSION);
    assertEq(ctx.milestone, MILESTONE, 'milestone axis');
    assertEq(ctx.slice, 'S01', 'slice axis');
    assertEq(ctx.unit, 'T02', 'unit axis');
    // Legacy fields survive verbatim — the contract WIDENS, it does not shift.
    assertEq(ctx.unitId, 'T02', 'legacy unitId preserved');
    assertEq(ctx.runId, MILESTONE, 'legacy runId preserved');
  } finally { cleanup(root); }
});

test('missing axes become NAMED sentinels, never the empty string', () => {
  const root = makeWorkspace();
  try {
    // Run present, worker recorded, but no slice axis (e.g. plan-milestone).
    seedRun(root, { worker: 'plan-milestone/M-x' });
    const ctx = hook.resolveUnitContext(root, SESSION);
    assertEq(ctx.slice, SENTINEL_NO_SLICE, 'absent slice → sentinel');
    assert(ctx.slice !== '', 'slice axis must never be the empty string');
    assert(ctx.milestone !== '', 'milestone axis must never be the empty string');
    // The empty string is what produced `evidence--T01.jsonl`; prove the name
    // built from this context carries no empty axis.
    const name = buildEvidenceFileName({ milestone: ctx.milestone, slice: null, unit: ctx.unit });
    assert(!name.includes('~~'), `name must not contain an empty axis: ${name}`);
  } finally { cleanup(root); }
});

test('no run at all → both sentinels + adhoc unit (never empty, never throw)', () => {
  const root = makeWorkspace();
  try {
    const ctx = hook.resolveUnitContext(root, 'session-that-matches-nothing');
    assertEq(ctx.milestone, SENTINEL_NO_MILESTONE);
    assertEq(ctx.slice, SENTINEL_NO_SLICE);
    assertEq(ctx.unit, 'adhoc');
  } finally { cleanup(root); }
});

test('auto-mode.json fallback path also returns all three axes', () => {
  const root = makeWorkspace();
  try {
    // No runs/*.json at all → resolveRunForSession returns null → fallback.
    fs.writeFileSync(
      path.join(root, '.gsd', 'forge', 'auto-mode.json'),
      JSON.stringify({ active: true, worker: 'execute-task/T07', worker_slice: 'S03' }),
      'utf8',
    );
    const ctx = hook.resolveUnitContext(root, 'unknown-session');
    assertEq(ctx.unit, 'T07', 'unit axis from alias');
    assertEq(ctx.slice, 'S03', 'slice axis from alias');
    assertEq(ctx.milestone, SENTINEL_NO_MILESTONE, 'alias has no milestone axis to read');
  } finally { cleanup(root); }
});

test('auto-mode.json fallback without the slice axis → sentinel, not undefined', () => {
  const root = makeWorkspace();
  try {
    fs.writeFileSync(
      path.join(root, '.gsd', 'forge', 'auto-mode.json'),
      JSON.stringify({ active: true, worker: 'execute-task/T07' }),
      'utf8',
    );
    const ctx = hook.resolveUnitContext(root, 'unknown-session');
    assertEq(ctx.slice, SENTINEL_NO_SLICE);
  } finally { cleanup(root); }
});

console.log('\n── Two consecutive dispatches must NOT collide ──────────────────');

test('two dispatches in one run produce TWO files; the 2nd line is absent from the 1st', () => {
  const root = makeWorkspace();
  try {
    seedRun(root, { worker: null, worker_slice: null });

    // Dispatch 1 — the orchestrator records the worker before Agent().
    runs.update(root, MILESTONE, { worker: 'execute-task/T01', worker_slice: 'S01' });
    const f1 = writeEvidenceLine(root, SESSION, { cmd: 'first-dispatch-line' });

    // Dispatch 2 — the FIX: the worker is recorded again for the new unit.
    runs.update(root, MILESTONE, { worker: 'execute-task/T02', worker_slice: 'S01' });
    const f2 = writeEvidenceLine(root, SESSION, { cmd: 'second-dispatch-line' });

    assert(f1 !== f2, `the two dispatches must not share a file (both were ${f1})`);
    const c1 = fs.readFileSync(path.join(root, '.gsd', 'forge', f1), 'utf8');
    const c2 = fs.readFileSync(path.join(root, '.gsd', 'forge', f2), 'utf8');
    assert(c1.includes('first-dispatch-line'), 'file 1 must hold its own line');
    assert(!c1.includes('second-dispatch-line'), 'CONTAMINATION: dispatch 2 leaked into file 1');
    assert(c2.includes('second-dispatch-line'), 'file 2 must hold its own line');
    assert(!c2.includes('first-dispatch-line'), 'CONTAMINATION: dispatch 1 leaked into file 2');
  } finally { cleanup(root); }
});

test('POSITIVE CONTROL: with the fix neutralized, the collision comes back', () => {
  const root = makeWorkspace();
  try {
    seedRun(root, { worker: null, worker_slice: null });

    runs.update(root, MILESTONE, { worker: 'execute-task/T01', worker_slice: 'S01' });
    const f1 = writeEvidenceLine(root, SESSION, { cmd: 'first-dispatch-line' });

    // NEUTRALIZED: reproduce the pre-fix orchestrator, which never re-recorded
    // the worker for the second unit (cause (a): forge-next had zero
    // forge-runs.js invocations). Everything else is byte-identical to the test
    // above — only the advance is removed.
    const f2 = writeEvidenceLine(root, SESSION, { cmd: 'second-dispatch-line' });

    assertEq(f2, f1, 'control is inert: without the advance the two dispatches MUST share a file');
    const c1 = fs.readFileSync(path.join(root, '.gsd', 'forge', f1), 'utf8');
    assert(c1.includes('first-dispatch-line') && c1.includes('second-dispatch-line'),
      'control is inert: the collision did not reproduce');
  } finally { cleanup(root); }
});

test('POSITIVE CONTROL: worker cleared between units (cause b) collapses to adhoc', () => {
  const root = makeWorkspace();
  try {
    seedRun(root, { worker: 'execute-task/T01', worker_slice: 'S01' });
    const during = hook.resolveUnitContext(root, SESSION).unit;
    // The clear-worker heartbeat that runs after Agent() returns.
    runs.update(root, MILESTONE, { worker: null, worker_slice: null });
    const between = hook.resolveUnitContext(root, SESSION).unit;
    assertEq(during, 'T01');
    assertEq(between, 'adhoc', 'cause (b) reproduced: between-unit tool calls resolve to adhoc');
  } finally { cleanup(root); }
});

console.log('\n── worker_slice: additive by READ ───────────────────────────────');

test('a live record WITHOUT the field reads back as null and is not rewritten', () => {
  const root = makeWorkspace();
  try {
    const file = path.join(root, '.gsd', 'forge', 'runs', `${MILESTONE}.json`);
    // Hand-written pre-T02 record: no worker_slice key at all.
    const legacy = {
      id: MILESTONE, kind: 'milestone', session_id: SESSION, active: true,
      started_at: 1, last_heartbeat: 1, worker: 'execute-task/T01', worker_started: 1,
    };
    fs.writeFileSync(file, JSON.stringify(legacy, null, 2), 'utf8');
    const bytesBefore = fs.readFileSync(file);

    const rec = runs.get(root, MILESTONE);
    assertEq(rec.worker_slice, null, 'default applied on READ');
    assert(Object.prototype.hasOwnProperty.call(rec, 'worker_slice'), 'key present after read');

    const bytesAfter = fs.readFileSync(file);
    assertEq(Buffer.compare(bytesBefore, bytesAfter), 0, 'reading must not rewrite the live record');
  } finally { cleanup(root); }
});

test('add() persists explicit null, never undefined (survives JSON.stringify)', () => {
  const root = makeWorkspace();
  try {
    seedRun(root);
    const raw = fs.readFileSync(path.join(root, '.gsd', 'forge', 'runs', `${MILESTONE}.json`), 'utf8');
    assert(/"worker_slice"\s*:\s*null/.test(raw), `worker_slice must be serialized as null: ${raw}`);
  } finally { cleanup(root); }
});

test('no SCHEMA-VERSION bump is required by this field', () => {
  const root = makeWorkspace();
  try {
    seedRun(root, { worker_slice: 'S01' });
    // An OLD reader is just JSON.parse + property access on the keys it knows.
    const raw = JSON.parse(fs.readFileSync(path.join(root, '.gsd', 'forge', 'runs', `${MILESTONE}.json`), 'utf8'));
    assertEq(raw.worker, null, 'known keys unchanged');
    assertEq(raw.kind, 'milestone', 'known keys unchanged');
    assert(!fs.existsSync(path.join(root, '.gsd', 'SCHEMA-VERSION')), 'no schema stamp written');
  } finally { cleanup(root); }
});

console.log('\n── refreshLegacyAlias ───────────────────────────────────────────');

test('refreshLegacyAlias mirrors worker_slice alongside worker/worker_started', () => {
  const root = makeWorkspace();
  try {
    seedRun(root, { worker: 'execute-task/T02', worker_slice: 'S01' });
    const alias = JSON.parse(fs.readFileSync(path.join(root, '.gsd', 'forge', 'auto-mode.json'), 'utf8'));
    assertEq(alias.worker, 'execute-task/T02', 'REFUTED-CAUSE PIN: worker was already mirrored');
    assertEq(alias.worker_started, null);
    assertEq(alias.worker_slice, 'S01', 'the alias must not lose the slice axis');
  } finally { cleanup(root); }
});

test('refreshLegacyAlias mirrors null for a run that never had the field', () => {
  const root = makeWorkspace();
  try {
    seedRun(root, { worker: 'execute-task/T02' });
    const alias = JSON.parse(fs.readFileSync(path.join(root, '.gsd', 'forge', 'auto-mode.json'), 'utf8'));
    assertEq(alias.worker_slice, null, 'null, never undefined — the key must exist');
    assert(Object.prototype.hasOwnProperty.call(alias, 'worker_slice'));
  } finally { cleanup(root); }
});

test('refreshLegacyAlias never throws when no run is active (remove()/cleanupStale path)', () => {
  const root = makeWorkspace();
  try {
    seedRun(root, { worker: 'execute-task/T02', worker_slice: 'S01' });
    runs.remove(root, MILESTONE);
    const alias = JSON.parse(fs.readFileSync(path.join(root, '.gsd', 'forge', 'auto-mode.json'), 'utf8'));
    assertEq(alias.active, false);
  } finally { cleanup(root); }
});

console.log('\n── Cause (a): forge-next now records the worker ─────────────────');

test('skills/forge-next/SKILL.md invokes forge-runs.js (measured 0 before the fix)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'skills', 'forge-next', 'SKILL.md'), 'utf8');
  const count = src.split('forge-runs.js').length - 1;
  assert(count > 0, `cause (a) not fixed: forge-runs.js invocations in forge-next/SKILL.md = ${count}`);
  // 2026-08-24 heartbeat consolidation: the block is now the one-spawn
  // `--heartbeat` CLI form; the worker value travels as --worker "UNIT_TYPE/UNIT_ID".
  assert(src.includes('--heartbeat --run "$RUN_ID" --worker "UNIT_TYPE/UNIT_ID"'),
    'the record-worker heartbeat block must be present');
  assert(src.includes('--worker-slice'), 'the slice axis must be emitted by step mode too');
});

test('skills/forge-auto/SKILL.md emits worker_slice at every worker site', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'skills', 'forge-auto', 'SKILL.md'), 'utf8');
  // 2026-08-24 heartbeat consolidation: worker writes are `--worker "<value>"`
  // CLI flags now. Clear sites null the axis inside the CLI, so the invariant
  // "every SET site carries the slice axis" is measured over --worker vs
  // --worker-slice flag counts.
  const workerWrites = src.split('--worker "').length - 1;
  const sliceWrites = src.split('--worker-slice').length - 1;
  assertEq(sliceWrites, workerWrites,
    'every site that sets the worker field must also set the slice axis');
});

// ── Result ─────────────────────────────────────────────────────────────────────
console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  ✗ ${f.name}`);
    console.log(`      ${f.error}`);
  }
  process.exit(1);
}
process.exit(0);
