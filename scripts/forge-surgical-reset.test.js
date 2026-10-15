#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const reset = require('./forge-surgical-reset');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-reset-boundary Ω '));
function git(cwd, args) { const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false }); assert.strictEqual(result.status, 0, result.stderr); }
function repo(name) {
  const cwd = path.join(root, name); fs.mkdirSync(cwd, { recursive: true }); git(cwd, ['init']); git(cwd, ['config', 'user.email', 'forge@example.invalid']); git(cwd, ['config', 'user.name', 'Forge Test']);
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'base\n'); git(cwd, ['add', 'tracked.txt']); git(cwd, ['commit', '-m', 'base']); return cwd;
}
try {
  const cwd = repo('repo safe'); const stateFile = path.join(root, 'attempt-safe.json');
  fs.writeFileSync(path.join(cwd, 'operator.txt'), 'operator dirty\n');
  const state = reset.initState(stateFile, { cwd, attempt: 'dispatch-1' });
  assert.strictEqual(state.start_sha.length > 6, true); assert(Array.isArray(state.pre_dirty));
  fs.writeFileSync(path.join(cwd, 'sidecar.txt'), 'untrusted\n');
  const refusedRead = reset.resetFailedAttempt(stateFile, { mode: 'plan', failed: true, codeDir: cwd, repoRoots: [cwd] });
  assert.strictEqual(refusedRead.reason_code, 'reset-refused-read-only'); assert(fs.existsSync(path.join(cwd, 'sidecar.txt')));
  const done = reset.resetFailedAttempt(stateFile, { mode: 'execute', failed: true, codeDir: cwd, repoRoots: [cwd] });
  assert.strictEqual(done.reason_code, 'reset-verified'); assert.strictEqual(fs.existsSync(path.join(cwd, 'sidecar.txt')), false); assert.strictEqual(fs.readFileSync(path.join(cwd, 'operator.txt'), 'utf8'), 'operator dirty\n');

  const overlapRepo = repo('repo overlap'); const overlapState = path.join(root, 'attempt-overlap.json');
  fs.writeFileSync(path.join(overlapRepo, 'operator.txt'), 'before\n'); reset.initState(overlapState, { cwd: overlapRepo, attempt: 'dispatch-2' });
  fs.writeFileSync(path.join(overlapRepo, 'operator.txt'), 'sidecar overlap\n'); fs.writeFileSync(path.join(overlapRepo, 'sidecar.txt'), 'keep on abort\n');
  const overlap = reset.resetFailedAttempt(overlapState, { mode: 'execute', failed: true, codeDir: overlapRepo, repoRoots: [overlapRepo] });
  assert.strictEqual(overlap.reason_code, 'reset-overlap'); assert.strictEqual(fs.existsSync(path.join(overlapRepo, 'sidecar.txt')), true); assert.strictEqual(fs.readFileSync(path.join(overlapRepo, 'operator.txt'), 'utf8'), 'sidecar overlap\n');
  assert.strictEqual(reset.resetFailedAttempt(overlapState, { mode: 'execute', failed: true, codeDir: overlapRepo, repoRoots: [overlapRepo, cwd] }).reason_code, 'reset-refused-multirepo');
  assert.strictEqual(reset.resetFailedAttempt(overlapState, { mode: 'execute', failed: false, codeDir: overlapRepo, repoRoots: [overlapRepo] }).reason_code, 'reset-refused-not-failed');

  const multiA = repo('repo multi A'); const multiB = repo('repo multi B');
  const multiState = path.join(root, 'attempt-multi.json');
  const multi = reset.initState(multiState, { cwd: multiA, attempt: 'dispatch-multi', repoRoots: [multiA, multiB] });
  assert.strictEqual(multi.repos.length, 2); assert.strictEqual(multi.code_dir, path.resolve(multiA));
  fs.writeFileSync(path.join(multiA, 'sidecar-a.txt'), 'a\n');
  fs.writeFileSync(path.join(multiB, 'sidecar-b.txt'), 'b\n');
  const multiDone = reset.resetFromState(multiState);
  assert.strictEqual(multiDone.code, 0); assert.strictEqual(multiDone.result.verified, true);
  assert.strictEqual(fs.existsSync(path.join(multiA, 'sidecar-a.txt')), false);
  assert.strictEqual(fs.existsSync(path.join(multiB, 'sidecar-b.txt')), false);

  const fenceA = repo('repo fence A'); const fenceB = repo('repo fence B');
  const fenceState = path.join(root, 'attempt-fence.json');
  reset.initState(fenceState, { cwd: fenceA, attempt: 'dispatch-fence', repoRoots: [fenceA, fenceB] });
  fs.writeFileSync(path.join(fenceA, 'must-survive.txt'), 'sidecar\n');
  fs.writeFileSync(path.join(fenceB, 'commit.txt'), 'moved\n'); git(fenceB, ['add', 'commit.txt']); git(fenceB, ['commit', '-m', 'move baseline']);
  const fenced = reset.resetFromState(fenceState);
  assert.strictEqual(fenced.code, 3); assert.strictEqual(fenced.result.abort, 'baseline-moved');
  assert.strictEqual(fs.existsSync(path.join(fenceA, 'must-survive.txt')), true, 'global preflight mutates zero roots');
  for (const vcs of ['git', 'svn']) {
    const f = require('./forge-code-roots.test').fixture(vcs), stateFile = path.join(f.dir, 'reset.json');
    for (const dir of [f.a, f.b]) fs.writeFileSync(path.join(dir, 'prior.txt'), 'prior bytes');
    reset.initState(stateFile, { cwd: f.a, attempt: 'two-roots', executionContract: f.contract });
    for (const dir of [f.a, f.b]) fs.writeFileSync(path.join(dir, 'same.txt'), 'worker bytes');
    fs.writeFileSync(path.join(f.b, 'foreign.txt'), 'foreign bytes');
    const context = { failed: true, processStopped: true, verifyOwnership: row => row.path === 'same.txt' };
    assert.strictEqual(reset.reconcileFailedAttempt(stateFile, context).reason_code, 'reset-unattributed-change');
    assert.strictEqual(fs.readFileSync(path.join(f.a, 'same.txt'), 'utf8'), 'worker bytes', 'all-root preflight resets nothing');
    assert.strictEqual(fs.readFileSync(path.join(f.b, 'foreign.txt'), 'utf8'), 'foreign bytes');
    // A separate attempt snapshots existing foreign bytes before its worker.
    // The refused attempt's baseline is never rewritten to fabricate ownership.
    for (const dir of [f.a, f.b]) fs.writeFileSync(path.join(dir, 'same.txt'), 'before\n');
    reset.initState(stateFile, { cwd: f.a, attempt: 'positive-two-roots', executionContract: f.contract });
    for (const dir of [f.a, f.b]) fs.writeFileSync(path.join(dir, 'same.txt'), 'worker bytes');
    const interrupted = reset.reconcileFailedAttempt(stateFile, { ...context, onProgress() { throw new Error('fixture-interruption'); } });
    assert.deepStrictEqual(interrupted.roots, [{ root_id: 'alpha', reconciled: true }]);
    assert.deepStrictEqual(interrupted.pending_roots, ['beta']);
    assert.strictEqual(JSON.parse(fs.readFileSync(stateFile)).reconciliation.reason_code, 'fixture-interruption');
    assert.strictEqual(fs.readFileSync(path.join(f.b, 'same.txt'), 'utf8'), 'worker bytes');
    const result = reset.reconcileFailedAttempt(stateFile, context);
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assert.deepStrictEqual(result.roots.map(row => row.root_id), ['alpha', 'beta']);
    assert.strictEqual(JSON.parse(fs.readFileSync(stateFile)).reconciliation.ok, true);
    for (const dir of [f.a, f.b]) { assert.strictEqual(fs.readFileSync(path.join(dir, 'prior.txt'), 'utf8'), 'prior bytes'); assert.strictEqual(fs.readFileSync(path.join(dir, 'same.txt'), 'utf8'), 'before\n'); }
    assert.strictEqual(fs.readFileSync(path.join(f.b, 'foreign.txt'), 'utf8'), 'foreign bytes');
    f.cleanup();
  }
  {
    const f = require('./forge-code-roots.test').fixture('svn'), stateFile = path.join(f.dir, 'properties-reset.json');
    const command = require('./forge-code-roots.test').command;
    fs.writeFileSync(path.join(f.b, 'same.txt'), 'operator dirty bytes');
    reset.initState(stateFile, { cwd: f.a, attempt: 'property-divergence', executionContract: f.contract });
    command('svn', ['propset', 'fixture-prop', 'worker value', 'same.txt'], f.b);
    let ownership = 0;
    const result = reset.reconcileFailedAttempt(stateFile, { failed: true, processStopped: true, verifyOwnership() { ownership++; return true; } });
    assert.strictEqual(result.reason_code, 'reset-pre-dirty-changed', JSON.stringify(result));
    assert.strictEqual(command('svn', ['propget', 'fixture-prop', 'same.txt'], f.b), 'worker value');
    assert.strictEqual(ownership, 0, 'pre-dirty divergence refuses before any reset');
    assert.strictEqual(fs.readFileSync(path.join(f.b, 'same.txt'), 'utf8'), 'operator dirty bytes');
    f.cleanup();
  }
  console.log('forge-surgical-reset boundary tests passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
