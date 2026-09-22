#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const provider = require('./forge-update-check');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-check-'));
const cacheDir = path.join(ROOT, 'cache');
fs.mkdirSync(cacheDir);
let passed = 0;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
}
function commit(repo, text) {
  fs.writeFileSync(path.join(repo, 'content.txt'), text);
  git(repo, 'add', 'content.txt');
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-m', text);
  return git(repo, 'rev-parse', 'HEAD');
}
function test(name, fn) {
  fn(); passed++; console.log(`PASS ${name}`);
}

try {
  const origin = path.join(ROOT, 'origin with spaces');
  const repo = path.join(ROOT, 'local with spaces');
  fs.mkdirSync(origin);
  git(origin, 'init', '--initial-branch=main');
  const base = commit(origin, 'base');
  const remote = commit(origin, 'remote ahead');
  git(origin, 'tag', 'v1.2.3');
  git(origin, 'switch', '-c', 'side', base);
  const side = commit(origin, 'side branch');
  git(origin, 'switch', 'main');
  git(ROOT, 'clone', origin, repo);

  test('ancestry distinguishes equal, behind, ahead, diverged and unknown', () => {
    assert.strictEqual(provider.compareCommits(repo, base, base), 'equal');
    assert.strictEqual(provider.compareCommits(repo, base, remote), 'behind');
    assert.strictEqual(provider.compareCommits(repo, remote, base), 'ahead');
    assert.strictEqual(provider.compareCommits(repo, remote, side), 'diverged');
    assert.strictEqual(provider.compareCommits(repo, base, '0'.repeat(40)), 'unknown');
    assert.strictEqual(provider.compareCommits(repo, 'not-a-commit', remote), 'unknown');
  });

  test('known remote commit after fetch still reports behind and stable tag', () => {
    git(repo, 'reset', '--hard', base);
    git(repo, 'fetch', 'origin');
    git(repo, 'cat-file', '-e', `${remote}^{commit}`);
    const value = provider.refresh(repo, { cacheDir });
    assert.strictEqual(value.state, 'behind');
    assert.strictEqual(value.has_update, true);
    assert.strictEqual(value.remote_version, 'v1.2.3');
    assert.strictEqual(value.localCommit, base);
    assert.strictEqual(value.remoteCommit, remote);
    assert.strictEqual(git(repo, 'rev-parse', 'HEAD'), base);
    assert.strictEqual(JSON.parse(fs.readFileSync(provider.cachePath(repo, cacheDir))).state, 'behind');
  });

  test('offline refresh preserves last known indicator and marks unknown', () => {
    const previous = JSON.parse(fs.readFileSync(provider.cachePath(repo, cacheDir)));
    git(repo, 'remote', 'set-url', 'origin', path.join(ROOT, 'missing-origin'));
    try {
      const value = provider.refresh(repo, { cacheDir });
      assert.strictEqual(value.state, 'unknown');
      assert.strictEqual(value.error, 'update-check-unavailable');
      assert.strictEqual(value.has_update, true);
      assert.strictEqual(value.remote_version, previous.remote_version);
      assert.strictEqual(value.last_success_ts, previous.last_success_ts);
    } finally { git(repo, 'remote', 'set-url', 'origin', origin); }
  });

  test('offline refresh clears an update verdict after the checkout changes', () => {
    git(repo, 'reset', '--hard', remote);
    git(repo, 'remote', 'set-url', 'origin', path.join(ROOT, 'missing-origin'));
    try {
      const value = provider.refresh(repo, { cacheDir });
      assert.strictEqual(value.localCommit, remote);
      assert.strictEqual(value.state, 'unknown');
      assert.strictEqual(value.has_update, false);
      assert.strictEqual(value.remote_version, '');
    } finally { git(repo, 'remote', 'set-url', 'origin', origin); }
  });

  test('refresh handles equal, ahead and diverged checkouts without changing HEAD', () => {
    git(repo, 'reset', '--hard', remote);
    assert.strictEqual(provider.refresh(repo, { cacheDir }).state, 'equal');
    assert.strictEqual(provider.refresh(repo, { cacheDir }).has_update, false);
    const ahead = commit(repo, 'local ahead');
    const value = provider.refresh(repo, { cacheDir });
    assert.strictEqual(value.state, 'ahead');
    assert.strictEqual(value.has_update, false);
    assert.strictEqual(git(repo, 'rev-parse', 'HEAD'), ahead);
    git(repo, 'reset', '--hard', side);
    const diverged = provider.refresh(repo, { cacheDir });
    assert.strictEqual(diverged.state, 'diverged');
    assert.strictEqual(diverged.has_update, true);
    assert.strictEqual(git(repo, 'rev-parse', 'HEAD'), side);
  });

  test('fresh remote object is fetched only into the object database', () => {
    const next = commit(origin, 'new remote commit');
    const headBefore = git(repo, 'rev-parse', 'HEAD');
    const refsBefore = git(repo, 'show-ref');
    const fetchHead = fs.readFileSync(path.join(repo, '.git', 'FETCH_HEAD'), 'utf8');
    const value = provider.refresh(repo, { cacheDir });
    assert.strictEqual(value.remoteCommit, next);
    assert.strictEqual(value.state, 'diverged');
    git(repo, 'cat-file', '-e', `${next}^{commit}`);
    assert.strictEqual(git(repo, 'rev-parse', 'HEAD'), headBefore);
    assert.strictEqual(git(repo, 'show-ref'), refsBefore);
    assert.strictEqual(fs.readFileSync(path.join(repo, '.git', 'FETCH_HEAD'), 'utf8'), fetchHead);
  });

  test('two repositories have distinct caches and independent results', () => {
    const second = path.join(ROOT, 'second');
    git(ROOT, 'clone', origin, second);
    const firstFile = provider.cachePath(repo, cacheDir);
    const secondFile = provider.cachePath(second, cacheDir);
    assert.notStrictEqual(firstFile, secondFile);
    assert.strictEqual(provider.cachePath(path.join(repo, '.'), cacheDir), firstFile);
    const before = fs.readFileSync(firstFile, 'utf8');
    assert.strictEqual(provider.refresh(second, { cacheDir }).state, 'equal');
    assert.strictEqual(fs.readFileSync(firstFile, 'utf8'), before);
    assert.strictEqual(provider.cachedUpdate(repo, { cacheDir }).state, 'diverged');
    assert.strictEqual(provider.cachedUpdate(second, { cacheDir }).state, 'equal');
  });

  test('cache render schedules once, serves stale data and performs no synchronous Git', () => {
    const file = provider.cachePath(repo, cacheDir);
    const stale = { ts: 1, state: 'behind', version: 'v1.0', has_update: true, remote_version: 'v2.0' };
    fs.writeFileSync(file, JSON.stringify(stale));
    const gitModule = require('./forge-git-process'), originalGit = gitModule.git;
    let launches = 0, unrefs = 0;
    try {
      gitModule.git = () => { throw new Error('synchronous Git reached render path'); };
      delete require.cache[require.resolve('./forge-update-check')];
      const isolated = require('./forge-update-check');
      const spawn = (command, args, options) => {
        launches++;
        assert.strictEqual(command, process.execPath);
        assert(args.includes('--refresh'));
        assert(args.includes(path.resolve(repo)));
        assert.strictEqual(options.stdio, 'ignore');
        assert.strictEqual(options.windowsHide, true);
        assert.strictEqual(options.detached, true, 'refresh must outlive render on Windows');
        assert.strictEqual(options.timeout, undefined, 'Node spawn timeout would keep the render event loop alive');
        return { on() {}, unref() { unrefs++; } };
      };
      assert.deepStrictEqual(isolated.cachedUpdate(repo, { cacheDir, spawn }), stale);
      assert.deepStrictEqual(isolated.cachedUpdate(repo, { cacheDir, spawn }), stale);
      assert.strictEqual(launches, 1);
      assert.strictEqual(unrefs, 1);
    } finally {
      gitModule.git = originalGit;
      delete require.cache[require.resolve('./forge-update-check')];
      fs.rmSync(`${file}.refresh`, { force: true });
    }
  });

  test('real render process exits promptly while a scheduled worker is still alive', () => {
    const isolatedCache = path.join(ROOT, 'render-cache');
    fs.mkdirSync(isolatedCache);
    const pidFile = path.join(ROOT, 'worker.pid');
    let workerPid;
    const started = Date.now();
    try {
      const result = spawnSync(process.execPath, ['-e', `
        const fs = require('fs'), { spawn } = require('child_process');
        const provider = require(process.argv[1]);
        const value = provider.cachedUpdate(process.argv[2], {
          cacheDir: process.argv[3],
          spawn(command, args, options) {
            const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], options);
            fs.writeFileSync(process.argv[4], String(child.pid));
            return child;
          }
        });
        console.log(JSON.stringify(value));
      `, require.resolve('./forge-update-check'), repo, isolatedCache, pidFile], {
        encoding: 'utf8', timeout: 3000,
      });
      workerPid = Number(fs.readFileSync(pidFile, 'utf8'));
      assert.strictEqual(result.status, 0, result.stderr || String(result.error));
      assert(Date.now() - started < 3000, 'render waited for worker');
      assert.strictEqual(JSON.parse(result.stdout).state, 'unknown');
      assert.strictEqual(JSON.parse(result.stdout).has_update, false);
      process.kill(workerPid, 0); // The render exited while its refresh was still running.
    } finally {
      if (!workerPid && fs.existsSync(pidFile)) workerPid = Number(fs.readFileSync(pidFile, 'utf8'));
      if (workerPid) { try { process.kill(workerPid); } catch {} }
    }
  });

  test('flat installed statusline resolves provider under scripts and renders cached update', () => {
    const installed = path.join(ROOT, 'flat-install');
    const scripts = path.join(installed, 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    const statusline = path.join(installed, 'forge-statusline.js');
    fs.copyFileSync(path.join(__dirname, 'forge-statusline.js'), statusline);
    const called = path.join(installed, 'provider-called.json');
    fs.writeFileSync(path.join(scripts, 'forge-prefs.js'),
      `module.exports.readPrefsCached = () => ({prefs:{repo_path:${JSON.stringify(repo)}}});`);
    fs.writeFileSync(path.join(scripts, 'forge-update-check.js'), `
      module.exports.cachedUpdate = repo => {
        require('fs').writeFileSync(${JSON.stringify(called)}, JSON.stringify(repo));
        return {version:'v1.0.0',has_update:true,remote_version:'v2.0.0',state:'behind'};
      };
    `);
    const rendered = spawnSync(process.execPath, [statusline], {
      encoding: 'utf8', timeout: 3000, cwd: installed,
      input: JSON.stringify({ cwd: installed, model: { display_name: 'Fixture' } }),
    });
    assert.strictEqual(rendered.status, 0, rendered.stderr);
    assert.strictEqual(JSON.parse(fs.readFileSync(called, 'utf8')), repo);
    assert(rendered.stdout.includes('Forge'), rendered.stdout);
    assert(rendered.stdout.includes('v2.0.0'), rendered.stdout);
  });

  console.log(`${passed} update-check tests passed`);
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 });
}
