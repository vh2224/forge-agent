'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const isolation = require('./forge-isolation');
const { git, validateBranch, GIT_TIMEOUT_MS } = require('./forge-git-process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-isolation-boundaries-'));
function init(name) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'initial']);
  return repo;
}
try {
  const repo = init('repo with spaces');
  const wtRoot = path.join(root, 'work trees');
  const branch = 'forge/M001&echo_AUDIT';
  const setup = (name = branch) => isolation.setupWorktreeOne(repo, name, wtRoot, 'M001', false, { enabled: false });
  const result = setup();
  assert.strictEqual(result.status, 'created', result.error);
  assert.strictEqual(git(result.worktree, ['branch', '--show-current']).trim(), branch);
  assert.strictEqual(setup().status, 'already-exists');
  assert.strictEqual(setup('forge/other').reason, 'wrong-branch');
  for (const ref of ['-B', 'bad ref', 'x..y', '@{-1}']) assert.throws(() => validateBranch(repo, ref), /Invalid Git/);
  assert.strictEqual(setup('-bad').status, 'error');
  git(repo, ['worktree', 'remove', result.worktree]);
  fs.mkdirSync(result.worktree, { recursive: true });
  assert.strictEqual(setup().reason, 'not-a-worktree');
  git(result.worktree, ['init', '-q', '-b', 'main']);
  assert.strictEqual(setup().reason, 'wrong-repository');

  // Capture the real adapter boundary: no shell, literals and bounded timeout.
  const original = cp.execFileSync;
  const modulePath = require.resolve('./forge-git-process');
  const calls = [];
  try {
    cp.execFileSync = (file, args, opts) => { calls.push({ file, args, opts }); return ''; };
    delete require.cache[modulePath];
    require('./forge-git-process').git(repo, ['fetch', 'origin', branch]);
  } finally { cp.execFileSync = original; delete require.cache[modulePath]; }
  assert.strictEqual(calls[0].file, 'git');
  assert.deepStrictEqual(calls[0].args, ['fetch', 'origin', branch]);
  assert.strictEqual(calls[0].opts.shell, false);
  assert.strictEqual(calls[0].opts.timeout, GIT_TIMEOUT_MS);
  // Exercise a real native subprocess timeout without a shell/child tree.
  try {
    cp.execFileSync = (file, args, opts) => original(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], opts);
    delete require.cache[modulePath];
    const started = Date.now();
    assert.throws(() => require('./forge-git-process').git(repo, ['fetch', 'origin'], { timeout: 100 }), /ETIMEDOUT/);
    assert(Date.now() - started < 5000);
  } finally { cp.execFileSync = original; delete require.cache[modulePath]; }
  const depRepo = init('deps');
  fs.writeFileSync(path.join(depRepo, 'package.json'), '{}');
  fs.writeFileSync(path.join(depRepo, 'package-lock.json'), '{}');
  let installs = 0;
  const options = { runner: () => ({ status: ++installs === 1 ? 1 : 0, stderr: 'fixture install failure' }) };
  const provision = () => isolation.setupWorktreeOne(depRepo, 'forge/deps', wtRoot, 'deps', false, options);
  const failed = provision();
  assert.strictEqual(failed.status, 'error');
  assert.strictEqual(failed.reason, 'dependency-install-failed');
  fs.writeFileSync(path.join(failed.worktree, 'user.txt'), 'preserve');
  assert.strictEqual(provision().deps.status, 'installed');
  assert.strictEqual(installs, 2);
  assert.strictEqual(provision().deps.reason, 'worktree-already-exists');
  assert.strictEqual(fs.readFileSync(path.join(failed.worktree, 'user.txt'), 'utf8'), 'preserve');

  const runStore = require('./forge-runs');
  fs.mkdirSync(path.join(depRepo, '.gsd'));
  runStore.add(depRepo, { id: 'lender', kind: 'task', session_id: 'fixture', branch: 'forge/deps', worktrees: [{ repo: depRepo, path: failed.worktree }] });
  assert.strictEqual(isolation.attachForRun(depRepo, 'borrower', 'lender').ok, true);
  runStore.update(depRepo, 'lender', { branch: 'forge/wrong' });
  assert.strictEqual(isolation.attachForRun(depRepo, 'borrower', 'lender').reason, 'wrong-branch');
  runStore.update(depRepo, 'lender', { branch: 'forge/deps', worktrees: [{ repo, path: failed.worktree }] });
  assert.strictEqual(isolation.attachForRun(depRepo, 'borrower', 'lender').reason, 'wrong-repository');
  runStore.update(depRepo, 'lender', { branch: null });
  assert.strictEqual(isolation.attachForRun(depRepo, 'borrower', 'lender').reason, 'worktree-identity-missing');

  const crashRepo = init('interrupted');
  git(crashRepo, ['branch', 'forge/existing']);
  const beforeTarget = () => isolation.setupWorktreeOne(crashRepo, 'forge/existing', wtRoot, 'existing', false, { enabled: false });
  assert.strictEqual(beforeTarget().status, 'error');
  const absentRetry = beforeTarget();
  assert.strictEqual(absentRetry.reason, 'provisioning-incomplete');
  assert(absentRetry.error.includes('forge-provisioning'));
  assert.strictEqual(fs.existsSync(absentRetry.worktree), false);
  fs.mkdirSync(path.join(crashRepo, '.gsd'));
  const isolatedPath = require.resolve('./forge-isolation');
  try {
    cp.execFileSync = (file, args, opts) => {
      const result = original(file, args, opts);
      if (args[0] === 'worktree' && args[1] === 'add') throw new Error('fixture interruption after registration');
      return result;
    };
    delete require.cache[modulePath];
    delete require.cache[isolatedPath];
    const interrupted = require('./forge-isolation').setupWorktreeOne(crashRepo, 'forge/interrupted', wtRoot, 'interrupted', false, { enabled: false });
    assert.strictEqual(interrupted.status, 'error');
    assert(fs.existsSync(interrupted.worktree));
    fs.writeFileSync(path.join(interrupted.worktree, 'user.txt'), 'preserve interrupted');
    const retry = isolation.setupWorktreeOne(crashRepo, 'forge/interrupted', wtRoot, 'interrupted', false, { enabled: false });
    assert.strictEqual(retry.reason, 'provisioning-incomplete');
    assert.strictEqual(fs.readFileSync(path.join(interrupted.worktree, 'user.txt'), 'utf8'), 'preserve interrupted');
    runStore.add(crashRepo, { id: 'interrupted-lender', kind: 'task', session_id: 'fixture', branch: 'forge/interrupted', worktrees: [{ repo: crashRepo, path: interrupted.worktree }] });
    assert.strictEqual(isolation.attachForRun(crashRepo, 'borrower', 'interrupted-lender').reason, 'provisioning-incomplete');
  } finally { cp.execFileSync = original; delete require.cache[modulePath]; delete require.cache[isolatedPath]; }
  console.log('PASS isolation boundaries: refs, identity, timeouts, provisioning recovery and lender validation');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
