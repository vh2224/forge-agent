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
  test('batch planPath preserves filesystem root', () => {
    const expected = path.join(sliceDir, 'tasks', 'T01', 'T01-PLAN.md').replace(/\\/g, '/');
    assertEq(r.batch[0].planPath, expected);
    if (process.platform === 'win32') assert(/^[A-Za-z]:\//.test(r.batch[0].planPath), `drive root lost: ${r.batch[0].planPath}`);
  });
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

// --- Scenario 25: sub-task IDs (T##.N) discovered and sorted decimal-aware ---
console.log('\nScenario 25: sub-task discovery and decimal-aware sort');
{
  const { sliceDir, planPath } = mkSlice('s25');
  mkTask(sliceDir, 'T03', 'depends: []\nwrites:\n  - "src/a.ts"', { done: true });
  mkTask(sliceDir, 'T03.1', 'depends: [T03]\nwrites:\n  - "src/b.ts"');
  mkTask(sliceDir, 'T03.2', 'depends: [T03]\nwrites:\n  - "src/c.ts"');
  mkTask(sliceDir, 'T04', 'depends: [T03]\nwrites:\n  - "src/d.ts"');
  const r = run(planPath, 10);

  test('sub-task dirs are discovered (4 tasks total)', () => {
    // T03 is done; T03.1, T03.2, T04 should all be in batch or skipped/pending
    const allIds = [
      ...(r.batch || []).map(b => b.id),
      ...((r.details && r.details.skipped) || []).map(s => s.id),
    ];
    assert(allIds.includes('T03.1'), `T03.1 not found in output: ${JSON.stringify(r)}`);
    assert(allIds.includes('T03.2'), `T03.2 not found in output: ${JSON.stringify(r)}`);
    assert(allIds.includes('T04'), `T04 not found in output: ${JSON.stringify(r)}`);
  });
  test('sub-tasks sort after parent: T03.1 and T03.2 before T04', () => {
    const ids = batchIds(r);
    const i31 = ids.indexOf('T03.1');
    const i32 = ids.indexOf('T03.2');
    const i4 = ids.indexOf('T04');
    // All three should be in batch (T03 done, all depend on T03)
    assert(i31 >= 0 && i32 >= 0 && i4 >= 0, `expected T03.1, T03.2, T04 in batch; got ${JSON.stringify(ids)}`);
    assert(i31 < i4, `T03.1 should come before T04; got ${JSON.stringify(ids)}`);
    assert(i32 < i4, `T03.2 should come before T04; got ${JSON.stringify(ids)}`);
    assert(i31 < i32, `T03.1 should come before T03.2; got ${JSON.stringify(ids)}`);
  });
  test('T03.1 depends on T03 — satisfied since T03 is done', () => {
    assert(batchIds(r).includes('T03.1'), `T03.1 should be ready; got batch: ${JSON.stringify(batchIds(r))}`);
  });
}

test('claimPathMatches cobre glob *, **, ?, diretório e não-match', () => {
  const { claimPathMatches, normalizePath, normalizeFilesystemPath, canonicalizeClaimPath, pathsOverlap } = require('./forge-parallelism.js');
  assert(claimPathMatches('src/*.js', 'src/a.js'), '* não casou');
  assert(!claimPathMatches('src/*.js', 'src/deep/a.js'), '* atravessou segmento');
  assert(claimPathMatches('src/**', 'src/deep/a.js'), '** não casou');
  assert(claimPathMatches('src/**/*.js', 'src/a.js'), '**/ não aceitou zero segmento');
  assert(claimPathMatches('src/**/*.js', 'src/deep/a.js'), '**/ não aceitou um segmento');
  assert(claimPathMatches('src/**/*.js', 'src/deep/more/a.js'), '**/ não aceitou múltiplos segmentos');
  assert(claimPathMatches('src/a?.js', 'src/ab.js'), '? não casou');
  assert(claimPathMatches('src', 'src/deep/a.js'), 'diretório não cobriu descendente');
  assert(!claimPathMatches('src/*.js', 'test/a.js'), 'não-match virou match');
  assert(canonicalizeClaimPath('.') === '.', 'dot must represent the workspace');
  assert(canonicalizeClaimPath('./src') === 'src', './src must canonicalize to src');
  assert(canonicalizeClaimPath('src/../src') === 'src', 'internal dot segment must reduce lexically');
  assert(canonicalizeClaimPath('src\\a.js') === 'src/a.js', 'relative Windows claim must remain supported');
  let escaped = false; try { canonicalizeClaimPath('../x'); } catch (_) { escaped = true; }
  assert(escaped, 'escape above root must be rejected');
  assert(normalizeFilesystemPath('/tmp/forge/T01-PLAN.md') === '/tmp/forge/T01-PLAN.md', 'POSIX absolute planPath lost its root');
  assert(normalizeFilesystemPath('C:\\forge\\T01-PLAN.md') === 'C:/forge/T01-PLAN.md', 'drive-rooted planPath changed semantics');
  assert(normalizeFilesystemPath('\\\\server\\share\\T01-PLAN.md') === '//server/share/T01-PLAN.md', 'UNC planPath changed semantics');
  assert(normalizePath('C:\\forge\\T01-PLAN.md') === 'C:/forge/T01-PLAN.md', 'legacy normalizePath export must preserve filesystem API');
  assert(claimPathMatches('.', 'root.txt'), 'workspace claim must cover root file');
  assert(claimPathMatches('./src', 'src/a.js'), './src must share canonical matcher');
  assert(claimPathMatches('src/../src', 'src/a.js'), 'dot segments must share canonical matcher');
  assert(claimPathMatches('../x', 'anything.txt'), 'malformed claim must fail closed');
  assert(pathsOverlap('.', 'any/path'), 'workspace must overlap any path');
  assert(pathsOverlap('../x', 'other'), 'malformed overlap must fail closed');
  for (const absolute of ['/x', 'C:\\x', '\\\\server\\share\\x']) {
    assert(claimPathMatches(absolute, 'src/a.js'), `absolute claim must cover-all fail closed: ${absolute}`);
    assert(pathsOverlap(absolute, 'src'), `absolute claim must conflict fail closed: ${absolute}`);
  }
});

// --- issue 343 U0a: pure DAG, conservative globs and CLI compatibility ---
console.log('\nissue 343 U0a: pure task DAG, conservative glob intersection, CLI compatibility');

test('issue343 U0a-3 pure DAG: valid, legacy and invalid with duplicates, set mismatch, unknown, self and cyclic references', () => {
  const strict = require('assert');
  const { validateTaskDag } = require('./forge-parallelism.js');
  const row = (id, depends, writes = [`src/${id}.js`], extra = {}) => ({ id, depends, writes, ...extra });
  const scope = ['T01', 'T02', 'T03', 'T03.1'];
  const rows = [row('T01', []), row('T02', ['T01']), row('T03', ['T01']), row('T03.1', ['T03', 'T02'])];
  // Pure: the call reaches no file system (and so no prefs, lease, claim, worker or write).
  const names = ['readFileSync', 'writeFileSync', 'appendFileSync', 'existsSync', 'statSync', 'lstatSync', 'readdirSync',
    'mkdirSync', 'openSync', 'renameSync', 'rmSync', 'unlinkSync', 'realpathSync'];
  const saved = names.map(name => [name, fs[name]]);
  let valid;
  try {
    for (const name of names) fs[name] = () => { throw new Error(`validateTaskDag touched fs.${name}`); };
    valid = validateTaskDag(rows, { scopeTaskIds: scope });
  } finally {
    for (const [name, original] of saved) fs[name] = original;
  }
  strict.deepStrictEqual([valid.status, valid.task_ids, valid.topological_order, valid.legacy_task_ids, valid.diagnostics],
    ['valid', scope, ['T01', 'T02', 'T03', 'T03.1'], [], []]);
  strict.deepStrictEqual(valid.edges, [{ task: 'T02', depends_on: 'T01' }, { task: 'T03', depends_on: 'T01' },
    { task: 'T03.1', depends_on: 'T02' }, { task: 'T03.1', depends_on: 'T03' }]);
  strict.match(valid.graph_sha256, /^[a-f0-9]{64}$/);
  strict(Object.isFrozen(valid) && Object.isFrozen(valid.edges) && Object.isFrozen(valid.edges[0]), 'frozen result');
  // Checkbox/done state and the order inside depends are not part of the graph digest; an edge is.
  const marked = rows.map((item, index) => ({ ...item, done: index % 2 === 0, checked: true }));
  strict.strictEqual(validateTaskDag(marked, { scopeTaskIds: scope }).graph_sha256, valid.graph_sha256);
  strict.strictEqual(validateTaskDag([...rows.slice(0, 3), row('T03.1', ['T02', 'T03'])], { scopeTaskIds: scope }).graph_sha256, valid.graph_sha256);
  strict.notStrictEqual(validateTaskDag([...rows.slice(0, 3), row('T03.1', ['T03'])], { scopeTaskIds: scope }).graph_sha256, valid.graph_sha256);
  // Legacy: absent declarations are sequential only under the explicit policy; the default refuses them.
  const legacyRows = [row('T01', []), row('T02', null), row('T03', [], null), row('T03.1', ['T01'])];
  const legacy = validateTaskDag(legacyRows, { scopeTaskIds: scope, legacyPolicy: 'sequential' });
  strict.deepStrictEqual([legacy.status, legacy.legacy_task_ids, legacy.topological_order, legacy.diagnostics], ['legacy', ['T02', 'T03'], null, []]);
  strict.match(legacy.graph_sha256, /^[a-f0-9]{64}$/);
  const refused = validateTaskDag(legacyRows, { scopeTaskIds: scope });
  strict.strictEqual(refused.status, 'invalid');
  strict(refused.diagnostics.includes('dag-declaration-missing:T02:depends') && refused.diagnostics.includes('dag-declaration-missing:T03:writes'),
    JSON.stringify(refused.diagnostics));
  // Invalid: every structural defect is named, with no order and no digest.
  const invalid = (rowsIn, scopeIn, expected, policy = 'sequential') => {
    const result = validateTaskDag(rowsIn, { scopeTaskIds: scopeIn, legacyPolicy: policy });
    strict.strictEqual(result.status, 'invalid', expected);
    strict(result.diagnostics.some(item => item.startsWith(expected)), `${expected}: ${JSON.stringify(result.diagnostics)}`);
    strict.deepStrictEqual([result.topological_order, result.graph_sha256], [null, null], expected);
  };
  invalid([...rows, row('T02', [])], scope, 'dag-task-id-duplicate:T02');
  invalid(rows, [...scope, 'T04'], 'dag-plan-missing:T04');
  invalid([...rows, row('T05', [])], scope, 'dag-task-unlisted:T05');
  invalid(rows, ['T01', 'T02', 'T02', 'T03', 'T03.1'], 'dag-scope-duplicate:T02');
  invalid([row('T01', ['T09'])], ['T01'], 'dag-reference-unknown:T01:T09');
  invalid([row('T01', ['T01'])], ['T01'], 'dag-reference-self:T01');
  invalid([row('T01', ['T03']), row('T02', ['T01']), row('T03', ['T02'])], ['T01', 'T02', 'T03'], 'dag-cycle:T01>T03>T02>T01');
  invalid([row('T01', []), { id: 'T02', depends: null, writes: ['src/b.js'], invalid: ['depends:declaration-scalar'] }], ['T01', 'T02'],
    'dag-declaration-invalid:T02:depends:declaration-scalar');
  invalid([row('S01', [])], ['S01'], 'dag-task-id-invalid:S01');
  invalid([row('T01', [{ id: 'T02' }]), row('T02', [])], ['T01', 'T02'], 'dag-reference-invalid:T01');
  invalid([row('T01', 'T02')], ['T01'], 'dag-declaration-invalid:T01:depends');
  for (const options of [undefined, {}, { scopeTaskIds: scope, legacyPolicy: 'auto' }]) {
    strict.deepStrictEqual(validateTaskDag(rows, options).diagnostics, ['dag-input-invalid']);
  }
});

test('issue343 U0a-4 conservative globs: intersecting globs conflict, disjoint literal segments do not, empty/dot/malformed conflict, polarity unchanged', () => {
  const strict = require('assert');
  const { pathsOverlap, writesConflict } = require('./forge-parallelism.js');
  const both = (a, b, expected) => {
    strict.strictEqual(pathsOverlap(a, b), expected, `${JSON.stringify(a)} × ${JSON.stringify(b)}`);
    strict.strictEqual(pathsOverlap(b, a), expected, `${JSON.stringify(b)} × ${JSON.stringify(a)}`);
  };
  // Intersecting globs conflict in both directions, even when neither text matches the other pattern.
  both('src/*.js', 'src/a*', true);
  both('src/a?.js', 'src/?b.js', true);
  both('src/*.test.js', 'src/forge-*', true);
  both('src/**', 'src/deep/x.ts', true);
  both('**/*.md', 'src/a.js', true); // undecided before a globstar: conflict
  both('src/auth', 'src/auth/jwt.ts', true); // ancestry
  both('src/*', 'src/a/b.js', true);
  both('src/A.js', 'src/a.js', true); // a case-only difference never proves disjointness
  // Disjoint literal segments at the same depth, before any `**`, do not conflict.
  both('src/a.js', 'src/b.js', false);
  both('src/x/**', 'lib/**', false);
  both('docs/**/x.md', 'src/x.md', false);
  both('src/*.js', 'src/*.ts', false);
  both('src/a?.js', 'src/abc.js', false);
  // Root-qualified and object entries: distinct declared roots of one contract are distinct
  // checkouts; an unqualified path may be any root.
  both('alpha::same.txt', 'beta::same.txt', false);
  both('primary::src/a.js', 'src/a.js', true);
  both({ root_id: 'primary', path: 'src/a.js' }, 'primary::src/a.js', true);
  both('primary::src/a.js', { root_id: 'primary', path: 'src/b.js' }, false);
  // Empty, dot, malformed, absolute and escaping declarations conflict with everything.
  for (const unknown of ['', '.', './', '../x', '/abs', 'C:/abs', 'C:\\abs', '\\\\server\\share\\x', 'bad root::x', 'a::b::c',
    { root_id: 'primary' }, { path: 'x' }, null]) {
    both(unknown, 'docs/unrelated.md', true);
  }
  // Intra-slice polarity: an empty list writes nothing; the cross-run comparator keeps the opposite polarity.
  strict.strictEqual(writesConflict([], ['x']), false);
  strict.strictEqual(writesConflict(['x'], []), false);
  strict.strictEqual(writesConflict(null, ['x']), true);
  strict.strictEqual(writesConflict(['src/*.js'], ['src/a*']), true);
  strict.strictEqual(writesConflict(['src/a.js'], ['src/b.js']), false);
  const { claimsConflict } = require('./forge-claim-overlap.js');
  strict.strictEqual(claimsConflict({ paths: [] }, { paths: ['x'] }).cause, 'undeclared-writes');
  strict.strictEqual(claimsConflict({ paths: ['src/*.js'] }, { paths: ['src/a*'] }).cause, 'overlap');
  strict.strictEqual(claimsConflict({ paths: ['src/a.js'] }, { paths: ['src/b.js'] }), null);
});

test('issue343 U0a-5 CLI compatibility: modes and shapes preserved and invalid declarations never produce parallel', () => {
  const strict = require('assert');
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'parallelism', 'reader-cases.json'), 'utf8')).cases;
  const writePlan = (sliceDir, id, content, done) => {
    const dir = path.join(sliceDir, 'tasks', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}-PLAN.md`), content);
    if (done) fs.writeFileSync(path.join(dir, `${id}-SUMMARY.md`), 'done\n');
  };
  // Every reader case through the real CLI, with its declared prerequisites done. The CLI applies the
  // scheduling projection of the fixture: a diagnosed declaration (YAML null, malformed or a blank gap)
  // is never ready, an absent one is legacy, and only a clean declaration is scheduled.
  cases.forEach((c, index) => {
    const { sliceDir, planPath } = mkSlice(`u0a5-case-${String(index + 1).padStart(2, '0')}`);
    const prerequisites = c.decoded.depends.status === 'valid' ? c.decoded.depends.items : [];
    for (const id of prerequisites) writePlan(sliceDir, id, `---\ndepends: []\nwrites: [docs/${id}.md]\n---\n# ${id}\n`, true);
    writePlan(sliceDir, c.task, ['---', ...c.frontmatter, '---', `# ${c.task}`, ''].join(c.eol === 'crlf' ? '\r\n' : '\n'), false);
    const r = run(planPath, 3), schedule = c.projections.schedule;
    strict.notStrictEqual(r.mode, 'parallel', c.name);
    if (schedule.diagnostics.length) {
      strict.deepStrictEqual([r.mode, r.dag_status, batchIds(r)], ['blocked', 'invalid', []], c.name);
      strict.deepStrictEqual(r.diagnostics, schedule.diagnostics.map(name => `dag-declaration-invalid:${c.task}:${name}`), c.name);
    } else if (schedule.depends === null || schedule.writes === null) {
      strict.deepStrictEqual([r.mode, r.dag_status, r.diagnostics, batchIds(r)], ['legacy', 'legacy', [], [c.task]], c.name);
    } else {
      strict.deepStrictEqual([r.mode, r.dag_status, r.diagnostics, batchIds(r)], ['single', 'valid', [], [c.task]], c.name);
    }
  });
  // U0a-r1: a bare `writes:` (YAML null) never schedules as `writes: []` beside a ready task.
  {
    const { sliceDir, planPath } = mkSlice('u0a5-bare-writes-beside-ready');
    mkTask(sliceDir, 'T01', 'depends: []\nwrites:');
    mkTask(sliceDir, 'T02', 'depends: []\nwrites:\n  - "src/b.ts"');
    const r = run(planPath, 3);
    strict.deepStrictEqual([r.mode, batchIds(r), r.dag_status, r.diagnostics], ['single', ['T02'], 'invalid', ['dag-declaration-invalid:T01:writes:declaration-empty-value']]);
  }
  // A malformed declaration beside two independent ready tasks: one task at a time, never parallel.
  {
    const { sliceDir, planPath } = mkSlice('u0a5-invalid-beside-ready');
    mkTask(sliceDir, 'T01', 'depends: []\nwrites:\n  - "src/a.ts"');
    mkTask(sliceDir, 'T02', 'depends: []\nwrites:\n  - "src/b.ts"');
    mkTask(sliceDir, 'T03', 'depends: T01\nwrites:\n  - "src/c.ts"');
    const r = run(planPath, 3);
    strict.deepStrictEqual(Object.keys(r), ['mode', 'batch', 'reason', 'details', 'dag_status', 'diagnostics']);
    strict.deepStrictEqual(Object.keys(r.details), ['readyCount', 'pendingCount', 'maxConcurrent', 'skipped']);
    strict.deepStrictEqual([r.mode, batchIds(r), r.dag_status, r.diagnostics], ['single', ['T01'], 'invalid', ['dag-declaration-invalid:T03:depends:declaration-scalar']]);
    strict.deepStrictEqual(r.details.skipped, [{ id: 'T02', reason: 'sequential: invalid task graph' }]);
  }
  // A cycle is invalid: the independent ready tasks run one at a time.
  {
    const { sliceDir, planPath } = mkSlice('u0a5-cycle');
    mkTask(sliceDir, 'T01', 'depends: [T02]\nwrites: [src/a.ts]');
    mkTask(sliceDir, 'T02', 'depends: [T01]\nwrites: [src/b.ts]');
    mkTask(sliceDir, 'T03', 'depends: []\nwrites: [src/c.ts]');
    mkTask(sliceDir, 'T04', 'depends: []\nwrites: [src/d.ts]');
    const r = run(planPath, 3);
    strict.deepStrictEqual([r.mode, batchIds(r), r.dag_status, r.diagnostics], ['single', ['T03'], 'invalid', ['dag-cycle:T01>T02>T01']]);
  }
  // The shared reader: CRLF, comments, a quoted '#', root-qualified and object entries still schedule in parallel.
  {
    const { sliceDir, planPath } = mkSlice('u0a5-shared-reader');
    writePlan(sliceDir, 'T01', '---\r\ndepends: [] # no prerequisites\r\nwrites:\r\n  - primary::src/a.ts # entry point\r\n  # a comment line inside the list\r\n---\r\n# T01\r\n', false);
    mkTask(sliceDir, 'T02', 'depends: []\nwrites:\n  - "docs/b #1.md"\n  - root_id: primary\n    path: src/c.ts');
    const r = run(planPath, 3);
    strict.deepStrictEqual([r.mode, batchIds(r), r.dag_status, r.diagnostics], ['parallel', ['T01', 'T02'], 'valid', []]);
  }
  // Conservative intersection reaches the CLI: src/*.js and src/a* are serialized.
  {
    const { sliceDir, planPath } = mkSlice('u0a5-glob-intersection');
    mkTask(sliceDir, 'T01', 'depends: []\nwrites: ["src/*.js"]');
    mkTask(sliceDir, 'T02', 'depends: []\nwrites: ["src/a*"]');
    const r = run(planPath, 3);
    strict.deepStrictEqual([r.mode, batchIds(r), r.dag_status], ['single', ['T01'], 'valid']);
    strict.deepStrictEqual(r.details.skipped, [{ id: 'T02', reason: 'writes conflict with T01' }]);
  }
  // Shapes of legacy, blocked and none stay as before (plus the additive DAG fields where the DAG ran).
  {
    const { sliceDir, planPath } = mkSlice('u0a5-legacy-shape');
    mkTask(sliceDir, 'T01', 'depends: []\nwrites: [src/a.ts]');
    mkTask(sliceDir, 'T02', null);
    const r = run(planPath, 3);
    strict.deepStrictEqual(Object.keys(r), ['mode', 'batch', 'reason', 'dag_status', 'diagnostics']);
    strict.deepStrictEqual([r.mode, batchIds(r), r.dag_status], ['legacy', ['T01'], 'legacy']);
  }
  {
    const { sliceDir, planPath } = mkSlice('u0a5-blocked-shape');
    mkTask(sliceDir, 'T01', 'depends: [T99]\nwrites: [src/a.ts]');
    const r = run(planPath, 3);
    strict.deepStrictEqual(Object.keys(r), ['mode', 'batch', 'reason', 'details', 'dag_status', 'diagnostics']);
    strict.deepStrictEqual([r.mode, r.dag_status, r.diagnostics, r.details.pending], ['blocked', 'invalid', ['dag-reference-unknown:T01:T99'],
      [{ id: 'T01', depends: ['T99'], unmet: ['T99'] }]]);
  }
  {
    const { sliceDir, planPath } = mkSlice('u0a5-none-shape');
    mkTask(sliceDir, 'T01', 'depends: []\nwrites: [src/a.ts]', { done: true });
    const r = run(planPath, 3);
    strict.deepStrictEqual(r, { mode: 'none', batch: [], reason: 'all tasks complete' });
  }
});

// --- issue 343 U0a-r1: bounded conservative glob work ---
console.log('\nissue 343 U0a-r1: bounded glob intersection work');

test('issue343 U0a-r1-3 bounded conservative glob work returns conflict on exhausted adversarial input without changing existing polarity or disjoint positives', () => {
  const strict = require('assert');
  const { spawnSync } = require('child_process');
  const { pathsOverlap, writesConflict } = require('./forge-parallelism.js');
  const both = (a, b, expected, label) => {
    strict.strictEqual(pathsOverlap(a, b), expected, `${label}: forward`);
    strict.strictEqual(pathsOverlap(b, a), expected, `${label}: reverse`);
  };
  // Disjoint by construction: every name of ('?*')^k + 'y' ends with 'y' and every name of
  // ('?*')^k + 'x' ends with 'x'. Their product automaton has (2k + 2)^2 states; at least 3k^2
  // distinct states are reachable, and a disjoint pair is decided only after visiting all of them.
  const pair = k => [`src/${'?*'.repeat(k)}y`, `src/${'?*'.repeat(k)}x`];
  // Controls: small products are decided exactly, in both polarities.
  both(...pair(10), false, 'small disjoint product (22 x 22 states)');
  both(`src/${'?*'.repeat(10)}y`, `src/${'?*'.repeat(10)}?`, true, 'small intersecting product');
  // Work bound: 242 x 242 = 58564 states fit the state bound, but visiting at least 43200 of them
  // exceeds the 32768-step work bound: undecided, so a conflict instead of a false disjointness.
  both(...pair(120), true, 'work bound exhausted');
  // State bound: 402 x 402 = 161604 states exceed the bound; refused before the table is allocated.
  both(...pair(200), true, 'state bound');
  // Input bound: a declaration longer than 4096 characters is unknown, even a literal one.
  both(`src/${'a'.repeat(5000)}`, `src/${'b'.repeat(5000)}`, true, 'input bound');
  // Literal segments below the input bound keep their exact verdict, case folding included.
  both(`src/${'a'.repeat(2000)}`, `src/${'b'.repeat(2000)}`, false, 'long literal disjoint');
  both(`src/${'a'.repeat(2000)}`, `src/${'A'.repeat(2000)}`, true, 'long literal case-folded');
  // Existing intersecting/disjoint positives and the empty/dot/malformed polarity are unchanged.
  for (const [a, b, expected] of [['src/*.js', 'src/a*', true], ['src/a?.js', 'src/?b.js', true], ['src/**', 'src/deep/x.ts', true], ['src/auth', 'src/auth/jwt.ts', true],
    ['src/a.js', 'src/b.js', false], ['src/x/**', 'lib/**', false], ['src/*.js', 'src/*.ts', false], ['src/a?.js', 'src/abc.js', false],
    ['alpha::same.txt', 'beta::same.txt', false], ['', 'x', true], ['.', 'x', true], ['../x', 'x', true]]) both(a, b, expected, `${a} x ${b}`);
  strict.deepStrictEqual([writesConflict([], ['x']), writesConflict(['x'], []), writesConflict(null, ['x'])], [false, false, true], 'intra-slice polarity');
  strict.strictEqual(writesConflict([pair(120)[0]], [pair(120)[1]]), true, 'an exhausted pair serializes the two tasks');
  // Subprocess evidence: a fresh process with a 48 MiB old-space limit decides every adversarial pair,
  // including two one-megabyte segments whose product would need 10^12 states, without growing.
  const probe = [
    'const p = require(process.argv[1]);',
    "const pair = k => ['src/' + '?*'.repeat(k) + 'y', 'src/' + '?*'.repeat(k) + 'x'];",
    'const started = process.hrtime.bigint(), heap = process.memoryUsage().heapUsed;',
    'const results = { small: p.pathsOverlap(...pair(10)), work: p.pathsOverlap(...pair(120)), states: p.pathsOverlap(...pair(200)),',
    "  megabyte: p.pathsOverlap(...pair(500000)), literal: p.pathsOverlap('src/' + 'a'.repeat(2000), 'src/' + 'b'.repeat(2000)) };",
    'process.stdout.write(JSON.stringify({ results, elapsed_ms: Number(process.hrtime.bigint() - started) / 1e6,',
    '  heap_growth: process.memoryUsage().heapUsed - heap }));',
  ].join(' ');
  const child = spawnSync(process.execPath, ['--max-old-space-size=48', '-e', probe, path.join(__dirname, 'forge-parallelism.js')],
    { encoding: 'utf8', timeout: 30000, windowsHide: true });
  strict.ifError(child.error);
  strict.strictEqual(child.status, 0, child.stderr);
  const evidence = JSON.parse(child.stdout);
  strict.deepStrictEqual(evidence.results, { small: false, work: true, states: true, megabyte: true, literal: false });
  console.log(`      subprocess (48 MiB old space): ${JSON.stringify(evidence.results)} in ${evidence.elapsed_ms.toFixed(1)} ms, heap growth ${Math.round(evidence.heap_growth / 1024)} KiB`);
});

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
