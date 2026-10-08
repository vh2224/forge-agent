#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  validateExecuteResult,
  validatePlanResult,
  captureDirtySnapshot,
  deriveFilesChanged,
  assertNoProtectedSidecarChanges,
  validateResultFileTarget,
  readResultTelemetry,
} = require('./forge-xllm.js');

let passed = 0;
let skipped = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    process.stderr.write(`  ✗ ${name}\n${error.stack}\n`);
    process.exitCode = 1;
  }
}

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-xllm-runtime-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'forge-test@example.invalid']);
  git(repo, ['config', 'user.name', 'Forge Test']);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n');
  git(repo, ['add', 'tracked.txt']);
  git(repo, ['commit', '-m', 'base']);
  return { root, repo, startSha: git(repo, ['rev-parse', 'HEAD']) };
}

function executeResult(status) {
  return { status, summary: 'result', must_haves_status: [], files_changed: [] };
}

function planResult(status) {
  return {
    status,
    summary: 'plan',
    slice_plan: { filename: 'S01-PLAN.md', content: '# Slice' },
    task_plans: [{ id: 'T01', filename: 'T01-PLAN.md', content: '# Task' }],
  };
}

test('execute accepts done, partial, and blocked as terminal result statuses', () => {
  for (const status of ['done', 'partial', 'blocked']) {
    assert.strictEqual(validateExecuteResult(executeResult(status)), true, status);
  }
});

test('plan accepts only done and rejects partial/blocked', () => {
  assert.strictEqual(validatePlanResult(planResult('done')), true);
  assert.strictEqual(validatePlanResult(planResult('partial')), false);
  assert.strictEqual(validatePlanResult(planResult('blocked')), false);
});

test('result target is canonicalized outside the workspace and rejects inside paths', () => {
  const { root, repo } = makeRepo();
  const outside = path.join(root, 'result.json');
  const expectedOutside = path.join(fs.realpathSync.native(root), 'result.json');
  assert.strictEqual(validateResultFileTarget(outside, repo), expectedOutside);
  assert.throws(
    () => validateResultFileTarget(path.join(repo, 'result.json'), repo),
    /outside the workspace/,
  );
});

test('Windows containment is case-insensitive', () => {
  const { repo } = makeRepo();
  // Linux/macOS cannot resolve a path whose casing differs from the real path,
  // whereas Windows resolves both spellings. Still exercise the win32 containment
  // branch everywhere with an existing path, and use a casing variant on Windows.
  const caseChanged = process.platform === 'win32'
    ? (repo.toUpperCase() === repo ? repo.toLowerCase() : repo.toUpperCase())
    : repo;
  assert.throws(
    () => validateResultFileTarget(path.join(caseChanged, 'result.json'), repo, 'win32'),
    /outside the workspace/,
  );
});

test('result target canonicalizes external symlink/junction parents and rejects aliases into the workspace', () => {
  const { root, repo } = makeRepo();
  const realOut = path.join(root, 'real-out');
  const linkOut = path.join(root, 'link-out');
  fs.mkdirSync(realOut);
  try {
    fs.symlinkSync(realOut, linkOut, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    skipped += 1;
    process.stdout.write(`  - symlink/junction test skipped: ${error.code || error.message}\n`);
    return;
  }
  assert.strictEqual(
    validateResultFileTarget(path.join(linkOut, 'result.json'), repo),
    path.join(fs.realpathSync.native(realOut), 'result.json'),
  );

  const linkIn = path.join(root, 'link-in');
  try {
    fs.symlinkSync(repo, linkIn, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    skipped += 1;
    process.stdout.write(`  - workspace symlink/junction test skipped: ${error.code || error.message}\n`);
    return;
  }
  assert.throws(
    () => validateResultFileTarget(path.join(linkIn, 'result.json'), repo),
    /outside the workspace/,
  );
});

test('adapter CLI never writes adapter-failed to an invalid inside-workspace target', () => {
  const { repo } = makeRepo();
  const context = path.join(repo, 'context.md');
  const target = path.join(repo, 'forbidden-result.json');
  fs.writeFileSync(context, '# context\n');
  const cli = spawnSync(process.execPath, [
    path.join(__dirname, 'forge-xllm.js'),
    '--mode', 'plan',
    '--plan-context', context,
    '--result-file', target,
    '--cwd', repo,
    '--dispatch-id', 'invalid-target-test',
  ], { encoding: 'utf8' });
  assert.strictEqual(cli.status, 2, cli.stderr);
  assert.match(cli.stderr, /result-file must live outside the workspace/);
  assert.strictEqual(fs.existsSync(target), false);
});

test('files_changed excludes intact pre-dirty files and reports only the sidecar delta', () => {
  const { repo, startSha } = makeRepo();
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'user dirty\n');
  fs.mkdirSync(path.join(repo, '.gsd'));
  fs.writeFileSync(path.join(repo, '.gsd', 'preexisting.md'), 'user metadata\n');
  const before = captureDirtySnapshot(repo);

  fs.writeFileSync(path.join(repo, 'created.txt'), 'sidecar\n');
  let delta = deriveFilesChanged(repo, before, startSha);
  assert.deepStrictEqual(delta, [{ status: 'A', path: 'created.txt' }]);

  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'sidecar overlapped user dirty\n');
  delta = deriveFilesChanged(repo, before, startSha);
  assert(delta.some((entry) => entry.path === 'tracked.txt' && entry.status === 'M'));
});

test('files_changed includes pre-dirty paths that disappear from the final VCS diff', () => {
  const { repo, startSha } = makeRepo();
  const tracked = path.join(repo, 'tracked.txt'), original = fs.readFileSync(tracked);
  fs.writeFileSync(tracked, 'user dirty\n');
  fs.writeFileSync(path.join(repo, 'user-new.txt'), 'user new\n');
  const before = captureDirtySnapshot(repo);
  fs.writeFileSync(tracked, original);
  fs.unlinkSync(path.join(repo, 'user-new.txt'));
  assert.deepStrictEqual(deriveFilesChanged(repo, before, startSha), [
    { status: 'M', path: 'tracked.txt' }, { status: 'D', path: 'user-new.txt' },
  ]);
});

test('new .gsd delta is terminal while intact pre-existing .gsd dirt is ignored', () => {
  const { repo, startSha } = makeRepo();
  fs.mkdirSync(path.join(repo, '.gsd'));
  fs.writeFileSync(path.join(repo, '.gsd', 'preexisting.md'), 'user metadata\n');
  const before = captureDirtySnapshot(repo);
  assert.deepStrictEqual(deriveFilesChanged(repo, before, startSha), []);

  fs.writeFileSync(path.join(repo, '.gsd', 'sidecar.md'), 'forbidden\n');
  const delta = deriveFilesChanged(repo, before, startSha);
  assert.deepStrictEqual(delta, [{ status: 'A', path: '.gsd/sidecar.md' }]);
  assert.throws(() => assertNoProtectedSidecarChanges(delta), /protected \.gsd/);
});

test('failure telemetry preserves output tokens captured after the model response', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-xllm-telemetry-'));
  const file = path.join(dir, 'result.json');
  fs.writeFileSync(file, JSON.stringify({ dispatch_id: 'd1', input_tokens: 12, output_tokens: 34 }));
  assert.deepStrictEqual(readResultTelemetry(file, 'fallback'), {
    dispatch_id: 'd1',
    input_tokens: 12,
    output_tokens: 34,
    token_method: 'heuristic-chars-4',
  });
});

if (!process.exitCode) {
  process.stdout.write(`\n${passed} passed, 0 failed${skipped ? `, ${skipped} skipped` : ''}\n`);
}
