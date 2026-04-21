#!/usr/bin/env node
// forge-parallelism.test.js — real test suite for the parallelism script.
// Runs scenarios by creating temp slice directories, invoking the script as a
// subprocess (exactly as the orchestrator does), and asserting on the JSON output.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'forge-parallelism.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-parallelism-test-'));

let passed = 0;
let failed = 0;
const failures = [];

function mkSlice(name) {
  const sliceDir = path.join(ROOT, name);
  fs.mkdirSync(path.join(sliceDir, 'tasks'), { recursive: true });
  const planPath = path.join(sliceDir, name + '-PLAN.md');
  fs.writeFileSync(planPath, `# ${name} plan\n`);
  return { sliceDir, planPath };
}

function mkTask(sliceDir, id, frontmatter, { done = false } = {}) {
  const taskDir = path.join(sliceDir, 'tasks', id);
  fs.mkdirSync(taskDir, { recursive: true });
  const fm = frontmatter == null ? '' : `---\n${frontmatter}\n---\n`;
  fs.writeFileSync(path.join(taskDir, `${id}-PLAN.md`), fm + `# ${id}\n`);
  if (done) fs.writeFileSync(path.join(taskDir, `${id}-SUMMARY.md`), 'done\n');
}

function run(planPath, maxConcurrent = 3) {
  const out = execFileSync('node', [SCRIPT, '--slice-plan', planPath, '--max-concurrent', String(maxConcurrent)], {
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

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
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'mismatch'}\n     expected: ${e}\n     actual:   ${a}`);
}
function batchIds(result) {
  return (result.batch || []).map(b => b.id);
}

console.log('\n=== forge-parallelism.js — real test suite ===\n');

// --- Scenario 1: modern plan, two independent tasks → parallel ---
console.log('Scenario 1: modern plan, two independent tasks');
{
  const { sliceDir, planPath } = mkSlice('s01');
  mkTask(sliceDir, 'T01', 'depends: []\nwrites:\n  - "src/a.ts"');
  mkTask(sliceDir, 'T02', 'depends: []\nwrites:\n  - "src/b.ts"');
  const r = run(planPath, 3);

  test('mode == parallel', () => assertEq(r.mode, 'parallel'));
  test('batch contains T01, T02', () => assertEq(batchIds(r), ['T01', 'T02']));
  test('reason mentions ready set count', () => assert(/ready set/.test(r.reason), `got: ${r.reason}`));
}

// --- Scenario 2: single modern task → mode: single ---
console.log('\nScenario 2: only one task, modern plan');
{
  const { sliceDir, planPath } = mkSlice('s02');
  mkTask(sliceDir, 'T01', 'depends: []\nwrites:\n  - "src/a.ts"');
  const r = run(planPath, 3);

  test('mode == single', () => assertEq(r.mode, 'single'));
  test('batch contains only T01', () => assertEq(batchIds(r), ['T01']));
}

// --- Scenario 3: writes conflict → skip + single ---
console.log('\nScenario 3: two tasks with overlapping writes');
{
  const { sliceDir, planPath } = mkSlice('s03');
  mkTask(sliceDir, 'T01', 'depends: []\nwrites:\n  - "src/shared.ts"');
  mkTask(sliceDir, 'T02', 'depends: []\nwrites:\n  - "src/shared.ts"');
  const r = run(planPath, 3);

  test('mode == single (T02 skipped)', () => assertEq(r.mode, 'single'));
  test('batch contains only T01', () => assertEq(batchIds(r), ['T01']));
  test('T02 skipped with conflict reason', () => {
    const sk = (r.details && r.details.skipped) || [];
    assert(sk.some(s => s.id === 'T02' && /conflict/.test(s.reason)), `got: ${JSON.stringify(sk)}`);
  });
}

// --- Scenario 4: glob vs literal bidirectional conflict ---
console.log('\nScenario 4: glob on one side, literal on the other (bidirectional)');
{
  // T01 writes src/auth/**; T02 writes src/auth/jwt.ts — should conflict either direction.
  const { sliceDir, planPath } = mkSlice('s04');
  mkTask(sliceDir, 'T01', 'depends: []\nwrites:\n  - "src/auth/**"');
  mkTask(sliceDir, 'T02', 'depends: []\nwrites:\n  - "src/auth/jwt.ts"');
  const r1 = run(planPath, 3);
  test('glob-first: T02 skipped', () => assertEq(batchIds(r1), ['T01']));

  // Swap order: T01 literal, T02 glob
  const { sliceDir: sd2, planPath: pp2 } = mkSlice('s04b');
  mkTask(sd2, 'T01', 'depends: []\nwrites:\n  - "src/auth/jwt.ts"');
  mkTask(sd2, 'T02', 'depends: []\nwrites:\n  - "src/auth/**"');
  const r2 = run(pp2, 3);
  test('literal-first: T02 skipped', () => assertEq(batchIds(r2), ['T01']));
}

// --- Scenario 5: empty writes (docs-only) → no conflict with anything ---
console.log('\nScenario 5: docs-only task (empty writes)');
{
  const { sliceDir, planPath } = mkSlice('s05');
  mkTask(sliceDir, 'T01', 'depends: []\nwrites: []');
  mkTask(sliceDir, 'T02', 'depends: []\nwrites:\n  - "src/anything.ts"');
  const r = run(planPath, 3);

  test('empty writes does not conflict', () => assertEq(batchIds(r), ['T01', 'T02']));
  test('mode == parallel', () => assertEq(r.mode, 'parallel'));
}

// --- Scenario 6: deps chain — only T01 ready; T02 depends on T01 ---
console.log('\nScenario 6: linear dependency chain');
{
  const { sliceDir, planPath } = mkSlice('s06');
  mkTask(sliceDir, 'T01', 'depends: []\nwrites:\n  - "src/a.ts"');
  mkTask(sliceDir, 'T02', 'depends: [T01]\nwrites:\n  - "src/b.ts"');
  mkTask(sliceDir, 'T03', 'depends: [T02]\nwrites:\n  - "src/c.ts"');
  const r = run(planPath, 3);

  test('only T01 ready', () => assertEq(batchIds(r), ['T01']));
  test('mode == single', () => assertEq(r.mode, 'single'));
}

// --- Scenario 7: diamond dependency — T01 → {T02, T03} → T04 ---
console.log('\nScenario 7: diamond dependency after T01 done');
{
  const { sliceDir, planPath } = mkSlice('s07');
  mkTask(sliceDir, 'T01', 'depends: []\nwrites:\n  - "src/a.ts"', { done: true });
  mkTask(sliceDir, 'T02', 'depends: [T01]\nwrites:\n  - "src/b.ts"');
  mkTask(sliceDir, 'T03', 'depends: [T01]\nwrites:\n  - "src/c.ts"');
  mkTask(sliceDir, 'T04', 'depends: [T02, T03]\nwrites:\n  - "src/d.ts"');
  const r = run(planPath, 3);

  test('T02 + T03 ready in parallel', () => assertEq(batchIds(r), ['T02', 'T03']));
  test('T04 still blocked', () => assertEq(r.mode, 'parallel'));
}

// --- Scenario 8: all deps met + fan-out ---
console.log('\nScenario 8: fan-out after T01 done');
{
  const { sliceDir, planPath } = mkSlice('s08');
  mkTask(sliceDir, 'T01', 'depends: []\nwrites:\n  - "src/a.ts"', { done: true });
  mkTask(sliceDir, 'T02', 'depends: [T01]\nwrites:\n  - "src/b.ts"');
  mkTask(sliceDir, 'T03', 'depends: [T01]\nwrites:\n  - "src/c.ts"');
  mkTask(sliceDir, 'T04', 'depends: [T01]\nwrites:\n  - "src/d.ts"');
  const r = run(planPath, 3);

  test('all three fan-out tasks in batch', () => assertEq(batchIds(r), ['T02', 'T03', 'T04']));
}

// --- Scenario 9: max-concurrent cap ---
console.log('\nScenario 9: max-concurrent=2 caps batch');
{
  const { sliceDir, planPath } = mkSlice('s09');
  mkTask(sliceDir, 'T01', 'depends: []\nwrites:\n  - "src/a.ts"');
  mkTask(sliceDir, 'T02', 'depends: []\nwrites:\n  - "src/b.ts"');
  mkTask(sliceDir, 'T03', 'depends: []\nwrites:\n  - "src/c.ts"');
  mkTask(sliceDir, 'T04', 'depends: []\nwrites:\n  - "src/d.ts"');
  const r = run(planPath, 2);

  test('batch capped at 2', () => assertEq(batchIds(r), ['T01', 'T02']));
  test('T03, T04 skipped with max-concurrent reason', () => {
    const sk = (r.details && r.details.skipped) || [];
    const reasons = sk.filter(s => /max-concurrent/.test(s.reason)).map(s => s.id);
    assertEq(reasons, ['T03', 'T04']);
  });
}

// --- Scenario 10: forge-next simulation (max-concurrent=1) ---
console.log('\nScenario 10: forge-next depends-aware pick (max=1)');
{
  const { sliceDir, planPath } = mkSlice('s10');
  mkTask(sliceDir, 'T01', 'depends: []\nwrites:\n  - "src/a.ts"', { done: true });
  mkTask(sliceDir, 'T02', 'depends: [T01]\nwrites:\n  - "src/b.ts"');
  mkTask(sliceDir, 'T03', 'depends: [T01]\nwrites:\n  - "src/c.ts"');
  const r = run(planPath, 1);

  test('returns single pick (T02, first in order)', () => assertEq(batchIds(r), ['T02']));
  test('mode == single despite multiple ready', () => assertEq(r.mode, 'single'));
}

// --- Scenario 11: legacy plan (one task missing depends) → sequential ---
console.log('\nScenario 11: legacy plan triggers single-task sequential');
{
  const { sliceDir, planPath } = mkSlice('s11');
  mkTask(sliceDir, 'T01', 'depends: []\nwrites:\n  - "src/a.ts"');
  mkTask(sliceDir, 'T02', null); // legacy: no frontmatter
  mkTask(sliceDir, 'T03', 'depends: []\nwrites:\n  - "src/c.ts"');
  const r = run(planPath, 3);

  test('mode == legacy', () => assertEq(r.mode, 'legacy'));
  test('returns first pending (T01)', () => assertEq(batchIds(r), ['T01']));
  test('reason mentions legacy', () => assert(/legacy/.test(r.reason), `got: ${r.reason}`));
}

// --- Scenario 12: legacy mid-flight — T01 done, legacy forces T02 single ---
console.log('\nScenario 12: legacy plan after T01 done');
{
  const { sliceDir, planPath } = mkSlice('s12');
  mkTask(sliceDir, 'T01', 'depends: []\nwrites:\n  - "src/a.ts"', { done: true });
  mkTask(sliceDir, 'T02', null);
  mkTask(sliceDir, 'T03', 'depends: []\nwrites:\n  - "src/c.ts"');
  const r = run(planPath, 3);

  test('legacy still forces single', () => assertEq(r.mode, 'legacy'));
  test('returns first pending (T02)', () => assertEq(batchIds(r), ['T02']));
}

// --- Scenario 13: only partial frontmatter (depends present, writes absent) → legacy ---
console.log('\nScenario 13: partial frontmatter (writes missing)');
{
  const { sliceDir, planPath } = mkSlice('s13');
  mkTask(sliceDir, 'T01', 'depends: []'); // writes missing → legacy
  mkTask(sliceDir, 'T02', 'depends: []\nwrites:\n  - "src/b.ts"');
  const r = run(planPath, 3);

  test('mode == legacy (partial frontmatter counts as legacy)', () => assertEq(r.mode, 'legacy'));
  test('returns T01 as first pending', () => assertEq(batchIds(r), ['T01']));
}

// --- Scenario 14: none — all tasks done ---
console.log('\nScenario 14: all tasks complete');
{
  const { sliceDir, planPath } = mkSlice('s14');
  mkTask(sliceDir, 'T01', 'depends: []\nwrites:\n  - "src/a.ts"', { done: true });
  mkTask(sliceDir, 'T02', 'depends: []\nwrites:\n  - "src/b.ts"', { done: true });
  const r = run(planPath, 3);

  test('mode == none', () => assertEq(r.mode, 'none'));
  test('batch empty', () => assertEq(batchIds(r), []));
}

// --- Scenario 15: no tasks at all ---
console.log('\nScenario 15: empty slice');
{
  const { sliceDir, planPath } = mkSlice('s15');
  const r = run(planPath, 3);
  test('mode == none for empty slice', () => assertEq(r.mode, 'none'));
}

// --- Scenario 16: stray dep (task references unknown ID) ---
console.log('\nScenario 16: stray dependency ID');
{
  const { sliceDir, planPath } = mkSlice('s16');
  mkTask(sliceDir, 'T01', 'depends: []\nwrites:\n  - "src/a.ts"', { done: true });
  mkTask(sliceDir, 'T02', 'depends: [T99]\nwrites:\n  - "src/b.ts"');
  const r = run(planPath, 3);

  // T02 has T99 in depends. T99 isn't in doneIds, so deps-not-satisfied filters it out of ready set.
  test('stray-dep task filtered → blocked', () => assertEq(r.mode, 'blocked'));
  test('blocked details mention unmet dep', () => {
    const pending = (r.details && r.details.pending) || [];
    assert(pending.some(p => p.id === 'T02' && p.unmet.includes('T99')),
      `got: ${JSON.stringify(pending)}`);
  });
}

// --- Scenario 17: block-form YAML + inline-form YAML both parse ---
console.log('\nScenario 17: inline YAML list vs block YAML list');
{
  const { sliceDir, planPath } = mkSlice('s17');
  // Inline
  mkTask(sliceDir, 'T01', 'depends: []\nwrites: ["src/a.ts", "src/x.ts"]');
  // Block
  mkTask(sliceDir, 'T02', 'depends: []\nwrites:\n  - "src/b.ts"\n  - "src/y.ts"');
  const r = run(planPath, 3);

  test('both parse → parallel', () => assertEq(batchIds(r), ['T01', 'T02']));
}

// --- Scenario 18: inline writes with conflict across forms ---
console.log('\nScenario 18: inline vs block parsed consistently for conflicts');
{
  const { sliceDir, planPath } = mkSlice('s18');
  mkTask(sliceDir, 'T01', 'depends: []\nwrites: ["src/shared.ts"]');
  mkTask(sliceDir, 'T02', 'depends: []\nwrites:\n  - "src/shared.ts"');
  const r = run(planPath, 3);

  test('inline+block still detects conflict', () => assertEq(batchIds(r), ['T01']));
}

// --- Scenario 19: Windows-style backslash writes normalized ---
console.log('\nScenario 19: windows-style paths normalized');
{
  const { sliceDir, planPath } = mkSlice('s19');
  mkTask(sliceDir, 'T01', 'depends: []\nwrites:\n  - "src\\auth\\jwt.ts"');
  mkTask(sliceDir, 'T02', 'depends: []\nwrites:\n  - "src/auth/jwt.ts"');
  const r = run(planPath, 3);

  // Both should point at the same path after normalization → conflict
  test('backslash path normalizes and conflicts with forward-slash', () => assertEq(batchIds(r), ['T01']));
}

// --- Scenario 20: blocked — all pending have unmet deps ---
console.log('\nScenario 20: all pending blocked by dead dep');
{
  const { sliceDir, planPath } = mkSlice('s20');
  // T01 isn't done; T02 and T03 both depend on T01. Nothing in ready set (T01 not yet started).
  // Wait — T01 is pending with deps: []. So T01 IS ready. Let me set up so T01 has unmet deps too.
  mkTask(sliceDir, 'T01', 'depends: [T99]\nwrites:\n  - "src/a.ts"');
  mkTask(sliceDir, 'T02', 'depends: [T01]\nwrites:\n  - "src/b.ts"');
  const r = run(planPath, 3);

  test('mode == blocked when nothing ready', () => assertEq(r.mode, 'blocked'));
}

// --- Scenario 21: max-concurrent default (no flag) ---
console.log('\nScenario 21: default max-concurrent');
{
  const { sliceDir, planPath } = mkSlice('s21');
  for (let i = 1; i <= 5; i++) {
    const id = 'T' + String(i).padStart(2, '0');
    mkTask(sliceDir, id, `depends: []\nwrites:\n  - "src/${id}.ts"`);
  }
  // invoke without --max-concurrent → default is 3
  const out = execFileSync('node', [SCRIPT, '--slice-plan', planPath], { encoding: 'utf8' });
  const r = JSON.parse(out);

  test('default caps at 3', () => assertEq(batchIds(r), ['T01', 'T02', 'T03']));
}

// --- Scenario 22: directory prefix conflict (src/auth vs src/auth/jwt.ts) ---
console.log('\nScenario 22: directory prefix conflict');
{
  const { sliceDir, planPath } = mkSlice('s22');
  mkTask(sliceDir, 'T01', 'depends: []\nwrites:\n  - "src/auth/**"');
  mkTask(sliceDir, 'T02', 'depends: []\nwrites:\n  - "src/auth"');
  const r = run(planPath, 3);

  test('glob vs bare dir conflict', () => assertEq(batchIds(r), ['T01']));
}

// --- Scenario 23: missing slice-plan path → error ---
console.log('\nScenario 23: missing --slice-plan argument');
{
  try {
    execFileSync('node', [SCRIPT], { encoding: 'utf8' });
    test('should exit non-zero', () => { throw new Error('expected failure'); });
  } catch (e) {
    const out = (e.stdout || '').toString();
    test('emits error JSON', () => {
      const r = JSON.parse(out);
      assertEq(r.mode, 'error');
      assert(/missing/.test(r.reason));
    });
  }
}

// --- Scenario 24: nonexistent slice-plan → error ---
console.log('\nScenario 24: nonexistent --slice-plan');
{
  try {
    execFileSync('node', [SCRIPT, '--slice-plan', path.join(ROOT, 'does-not-exist', 'X.md')], { encoding: 'utf8' });
    test('should exit non-zero', () => { throw new Error('expected failure'); });
  } catch (e) {
    const out = (e.stdout || '').toString();
    test('emits error JSON for missing path', () => {
      const r = JSON.parse(out);
      assertEq(r.mode, 'error');
      assert(/not found/.test(r.reason));
    });
  }
}

// --- Summary ---
console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);

// Cleanup
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}

if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  ✗ ${f.name}`);
    console.log(`      ${f.error}`);
  }
  process.exit(1);
}
process.exit(0);
