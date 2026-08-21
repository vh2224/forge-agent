#!/usr/bin/env node
// forge-parallelism-exports.test.js — proves the require.main guard + module.exports seam
// added by T01 (S02, M-20260813133328-lease-escrita-cross-run) without changing CLI behavior.
//
// Three concerns proven here:
//   1. require-without-effect: requiring the module does NOT run main() (no stdout, no exit).
//   2. CLI parity: spawning the script (no args / bad --slice-plan / real fixture) produces the
//      same shape of output as before the guard existed — asserted by spawn, matching the style
//      of forge-parallelism.test.js.
//   3. Exports smoke: the 7 named exports exist and behave as expected.
//   4. Bite in both directions: reverting the guard on a disposable copy makes the
//      require-without-effect assertion fail; restoring it makes it pass again.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'forge-parallelism.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-parallelism-exports-test-'));

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
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'mismatch'}\n     expected: ${e}\n     actual:   ${a}`);
}

// Runs `node -e "<code>"` requiring the given script path; returns { status, stdout, stderr }.
function requireProbe(scriptPath) {
  const code =
    `const p = require(${JSON.stringify(scriptPath)}); ` +
    `console.log(typeof p.pathsOverlap);`;
  const res = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

console.log('\n=== forge-parallelism-exports.test.js ===\n');

// --- Concern 1: require-without-effect on the real (fixed) script ---
console.log('Concern 1: require() does not execute main()');
{
  const r = requireProbe(SCRIPT);
  test('exit code 0', () => assertEq(r.status, 0, `stderr: ${r.stderr}`));
  test('stdout is exactly "function"', () => assertEq(r.stdout.trim(), 'function', `stdout: ${JSON.stringify(r.stdout)}`));
  test('stdout does NOT contain the old error JSON', () => {
    assert(!/"mode":"error"/.test(r.stdout), `stdout leaked main() output: ${r.stdout}`);
  });
}

// --- Concern 2: CLI parity (spawn), same shapes as forge-parallelism.test.js ---
console.log('\nConcern 2: CLI parity — no args / bad --slice-plan / fixture');
{
  // No args → error, exit 1, mentions "missing"
  try {
    execFileSync('node', [SCRIPT], { encoding: 'utf8' });
    test('no-args should exit non-zero', () => { throw new Error('expected failure'); });
  } catch (e) {
    const out = (e.stdout || '').toString();
    test('no-args emits error JSON with "missing"', () => {
      const r = JSON.parse(out);
      assertEq(r.mode, 'error');
      assert(/missing/.test(r.reason), `reason: ${r.reason}`);
    });
  }

  // Nonexistent --slice-plan → error, exit 1, mentions "not found"
  try {
    execFileSync('node', [SCRIPT, '--slice-plan', path.join(ROOT, 'nope', 'X.md')], { encoding: 'utf8' });
    test('bad-slice-plan should exit non-zero', () => { throw new Error('expected failure'); });
  } catch (e) {
    const out = (e.stdout || '').toString();
    test('bad-slice-plan emits error JSON with "not found"', () => {
      const r = JSON.parse(out);
      assertEq(r.mode, 'error');
      assert(/not found/.test(r.reason), `reason: ${r.reason}`);
    });
  }

  // Minimal fixture: 2 independent tasks with depends/writes → parallel batch of 2
  const sliceDir = path.join(ROOT, 'fixture-slice');
  fs.mkdirSync(path.join(sliceDir, 'tasks', 'T01'), { recursive: true });
  fs.mkdirSync(path.join(sliceDir, 'tasks', 'T02'), { recursive: true });
  const planPath = path.join(sliceDir, 'S99-PLAN.md');
  fs.writeFileSync(planPath, '# fixture\n');
  fs.writeFileSync(
    path.join(sliceDir, 'tasks', 'T01', 'T01-PLAN.md'),
    '---\ndepends: []\nwrites:\n  - "src/a.ts"\n---\n# T01\n'
  );
  fs.writeFileSync(
    path.join(sliceDir, 'tasks', 'T02', 'T02-PLAN.md'),
    '---\ndepends: []\nwrites:\n  - "src/b.ts"\n---\n# T02\n'
  );
  const out = execFileSync('node', [SCRIPT, '--slice-plan', planPath, '--max-concurrent', '3'], { encoding: 'utf8' });
  const r = JSON.parse(out);
  test('fixture: mode == parallel', () => assertEq(r.mode, 'parallel'));
  test('fixture: batch has T01 and T02', () => {
    const ids = (r.batch || []).map(b => b.id);
    assertEq(ids, ['T01', 'T02']);
  });
}

// --- Concern 3: exports smoke ---
console.log('\nConcern 3: named exports smoke');
{
  const mod = require(SCRIPT);
  const names = ['globToRegex', 'normalizePath', 'normalizeFilesystemPath', 'canonicalizeClaimPath', 'pathsOverlap', 'writesConflict',
    'parseTaskFrontmatter', 'parseListField', 'discoverTasks'];
  for (const n of names) {
    test(`exports.${n} is a function`, () => assertEq(typeof mod[n], 'function'));
  }
  test('pathsOverlap glob match', () => assertEq(mod.pathsOverlap('src/a/**', 'src/a/b.ts'), true));

  const fixturePlan = path.join(ROOT, 'frontmatter-fixture.md');
  fs.writeFileSync(
    fixturePlan,
    '---\ndepends: [T01]\nwrites:\n  - "src/x.ts"\n  - "src/y.ts"\n---\n# fixture\n'
  );
  test('parseTaskFrontmatter returns {depends, writes}', () => {
    const fm = mod.parseTaskFrontmatter(fixturePlan);
    assertEq(fm.depends, ['T01']);
    assertEq(fm.writes, ['src/x.ts', 'src/y.ts']);
  });
}

// --- Concern 4: bite in both directions ---
console.log('\nConcern 4: bite — reverted guard fails the require-without-effect assert, restored passes');
{
  const original = fs.readFileSync(SCRIPT, 'utf8');
  const biteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-parallelism-bite-'));
  const bitePath = path.join(biteDir, 'forge-parallelism.js');

  // Reverted: strip the guard, call main() unconditionally (pre-T01 shape).
  // Match either LF or CRLF line endings — checked out working copies may carry either.
  const nl = original.includes('\r\n') ? '\r\n' : '\n';
  const guardOpen = [
    'if (require.main === module) {',
    '  try {',
    '    main();',
    '  } catch (e) {',
    '    emit({ mode: \'error\', batch: [], reason: \'parser error: \' + (e && e.message || String(e)) }, 1);',
    '  }',
    '}',
    '',
  ].join(nl);
  assert(original.includes(guardOpen), 'could not locate exact guard block in current script — bite setup broken');
  const revertedBody = [
    'try {',
    '  main();',
    '} catch (e) {',
    '  emit({ mode: \'error\', batch: [], reason: \'parser error: \' + (e && e.message || String(e)) }, 1);',
    '}',
    '',
  ].join(nl);
  const reverted = original.replace(guardOpen, revertedBody);
  assert(!/if \(require\.main === module\)/.test(reverted), 'revert did not remove the guard');
  fs.writeFileSync(bitePath, reverted);

  test('reverted copy: require-without-effect assertion FAILS', () => {
    const r = requireProbe(bitePath);
    // Reverted script runs main() on require with no --slice-plan → prints error JSON to
    // stdout, not "function" — the assertion `stdout.trim() === 'function'` must fail here.
    const wouldPass = r.stdout.trim() === 'function' && !/"mode":"error"/.test(r.stdout);
    assert(!wouldPass, `bite did not fail as expected — stdout: ${JSON.stringify(r.stdout)}`);
  });

  // Restore: write the original (fixed) content back to the disposable copy and re-check.
  fs.writeFileSync(bitePath, original);
  test('restored copy: require-without-effect assertion PASSES', () => {
    const r = requireProbe(bitePath);
    assertEq(r.stdout.trim(), 'function', `stdout: ${JSON.stringify(r.stdout)}`);
    assert(!/"mode":"error"/.test(r.stdout), `stdout: ${r.stdout}`);
  });

  try { fs.rmSync(biteDir, { recursive: true, force: true }); } catch (_) {}
}

// --- Summary ---
console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);

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
