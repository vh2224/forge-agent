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
fs.mkdirSync(cacheDir, { mode: 0o700 });
let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function commit(repo, text) {
  fs.writeFileSync(path.join(repo, 'content.txt'), text);
  git(repo, 'add', 'content.txt');
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-m', text);
  return git(repo, 'rev-parse', 'HEAD');
}

function writeManifest(forgeHome, value) {
  fs.mkdirSync(forgeHome, { recursive: true });
  fs.writeFileSync(path.join(forgeHome, 'manifest.json'), `${JSON.stringify(value)}\n`);
}

function remoteManifest(overrides = {}) {
  return {
    version: '1.2.3',
    source_remote: {
      remote: 'https://example.invalid/forge.git',
      channel: 'stable',
      tag: 'v1.2.3',
      sha: '1'.repeat(40),
      ...overrides,
    },
  };
}

function remoteGit(tags, master = '1'.repeat(40), calls = []) {
  return (cwd, args) => {
    calls.push({ cwd, args: [...args] });
    assert.strictEqual(args[0], 'ls-remote');
    if (args.includes('--tags')) return tags;
    assert.deepStrictEqual(args.slice(-1), ['refs/heads/master']);
    return `${master}\trefs/heads/master\n`;
  };
}

function tag(sha, version) {
  return `${sha}\trefs/tags/v${version}\n`;
}

try {
  const origin = path.join(ROOT, 'origin with spaces');
  const repo = path.join(ROOT, 'local with spaces');
  fs.mkdirSync(origin);
  git(origin, 'init', '--initial-branch=main');
  const base = commit(origin, 'base');
  git(origin, 'tag', 'v1.2.3');
  const remote = commit(origin, 'remote ahead');
  git(origin, 'tag', 'v1.3.0');
  git(origin, 'switch', '-c', 'side', base);
  const side = commit(origin, 'side branch');
  git(origin, 'switch', 'main');
  git(ROOT, 'clone', origin, repo);

  test('clone ancestry retains equal, behind, ahead, diverged and unknown states', () => {
    assert.strictEqual(provider.compareCommits(repo, base, base), 'equal');
    assert.strictEqual(provider.compareCommits(repo, base, remote), 'behind');
    assert.strictEqual(provider.compareCommits(repo, remote, base), 'ahead');
    assert.strictEqual(provider.compareCommits(repo, remote, side), 'diverged');
    assert.strictEqual(provider.compareCommits(repo, base, '0'.repeat(40)), 'unknown');
    assert.strictEqual(provider.compareCommits(repo, 'not-a-sha', remote), 'unknown');
  });

  test('stable installation ignores an outdated auxiliary clone when installed tag is current', () => {
    git(repo, 'reset', '--hard', base);
    const forgeHome = path.join(ROOT, 'stable-current');
    const installedSha = 'a'.repeat(40);
    writeManifest(forgeHome, remoteManifest({ sha: installedSha }));
    const calls = [];
    const value = provider.refresh({ forgeHome, cwd: ROOT, prefs: { repo_path: repo } }, {
      cacheDir,
      git: remoteGit(tag(installedSha, '1.2.3'), 'b'.repeat(40), calls),
    });
    assert.strictEqual(value.state, 'equal');
    assert.strictEqual(value.has_update, false);
    assert.strictEqual(value.version, 'v1.2.3');
    assert.strictEqual(value.remote_version, '');
    assert(calls.every((call) => call.args.includes('https://example.invalid/forge.git')));
    assert(calls.every((call) => path.resolve(call.cwd).toLowerCase() === path.resolve(forgeHome).toLowerCase()));
    assert.strictEqual(git(repo, 'rev-parse', 'HEAD'), base, 'auxiliary clone stays untouched');
  });

  test('only a higher stable semver produces the stable update arrow payload', () => {
    const forgeHome = path.join(ROOT, 'stable-newer');
    const installedSha = 'a'.repeat(40);
    const nextSha = 'b'.repeat(40);
    writeManifest(forgeHome, remoteManifest({ sha: installedSha }));
    const value = provider.refresh({ forgeHome, cwd: ROOT, prefs: { repo_path: repo } }, {
      cacheDir,
      git: remoteGit(tag(nextSha, '2.0.0') + tag(installedSha, '1.2.3')),
    });
    assert.strictEqual(value.state, 'behind');
    assert.strictEqual(value.has_update, true);
    assert.strictEqual(value.remote_version, 'v2.0.0');
    assert.strictEqual(value.version, 'v1.2.3');
  });

  test('a new master commit without a stable tag does not affect stable', () => {
    const forgeHome = path.join(ROOT, 'stable-master-only');
    const installedSha = 'a'.repeat(40);
    writeManifest(forgeHome, remoteManifest({ sha: installedSha }));
    const calls = [];
    const value = provider.refresh({ forgeHome }, {
      cacheDir,
      git: remoteGit(tag(installedSha, '1.2.3'), 'f'.repeat(40), calls),
    });
    assert.strictEqual(value.state, 'equal');
    assert.strictEqual(value.has_update, false);
    assert.strictEqual(calls.length, 1, 'stable consults tags only, never master');
    assert(calls[0].args.includes('--tags'));
  });

  test('master compares equality only and reports a different SHA as differs', () => {
    const forgeHome = path.join(ROOT, 'master');
    const installedSha = 'c'.repeat(40);
    writeManifest(forgeHome, remoteManifest({ channel: 'master', tag: null, sha: installedSha }));
    const equal = provider.refresh({ forgeHome }, {
      cacheDir,
      git: remoteGit('', installedSha),
    });
    assert.strictEqual(equal.state, 'equal');
    assert.strictEqual(equal.has_update, false);
    const different = provider.refresh({ forgeHome }, {
      cacheDir,
      git: remoteGit('', 'd'.repeat(40)),
    });
    assert.strictEqual(different.state, 'differs');
    assert.strictEqual(different.has_update, true);
    assert.strictEqual(different.remote_version, 'dddddddd');
    assert.strictEqual(different.version, '1.2.3');
  });

  for (const [name, tags] of [
    ['missing', tag('b'.repeat(40), '2.0.0')],
    ['retargeted', tag('b'.repeat(40), '1.2.3')],
  ]) {
    test(`stable installed tag ${name} is conservative unknown`, () => {
      const forgeHome = path.join(ROOT, `stable-${name}`);
      writeManifest(forgeHome, remoteManifest({ sha: 'a'.repeat(40) }));
      const value = provider.refresh({ forgeHome }, { cacheDir, git: remoteGit(tags) });
      assert.strictEqual(value.state, 'unknown');
      assert.strictEqual(value.has_update, false);
      assert.strictEqual(value.remote_version, '');
    });
  }

  test('source_repo clone fallback keeps Git states and installation version', () => {
    git(repo, 'reset', '--hard', base);
    git(repo, 'fetch', 'origin');
    const forgeHome = path.join(ROOT, 'source-repo');
    writeManifest(forgeHome, { version: '9.8.7', source_repo: repo });
    const beforeHead = git(repo, 'rev-parse', 'HEAD');
    const value = provider.refresh({ forgeHome, cwd: ROOT, prefs: { repo_path: origin } }, { cacheDir });
    assert.strictEqual(value.state, 'behind');
    assert.strictEqual(value.has_update, true);
    assert.strictEqual(value.version, '9.8.7', 'version comes from installation manifest');
    assert.strictEqual(value.localCommit, base);
    assert.strictEqual(git(repo, 'rev-parse', 'HEAD'), beforeHead);
  });

  test('repo_path is only the clone fallback when source_repo is absent', () => {
    git(repo, 'reset', '--hard', remote);
    const forgeHome = path.join(ROOT, 'prefs-repo');
    writeManifest(forgeHome, { version: '4.5.6' });
    const value = provider.refresh({ forgeHome, cwd: ROOT, prefs: { repo_path: repo } }, { cacheDir });
    assert.strictEqual(value.state, 'equal');
    assert.strictEqual(value.version, '4.5.6');
    const unavailable = path.join(ROOT, 'prefs-unavailable');
    writeManifest(unavailable, { version: '4.5.6' });
    assert.strictEqual(provider.refresh({ forgeHome: unavailable }, { cacheDir }).state, 'unknown');
  });

  test('missing, malformed and oversized manifests are unknown without Git', () => {
    for (const name of ['missing', 'malformed', 'oversized']) {
      const forgeHome = path.join(ROOT, `manifest-${name}`);
      fs.mkdirSync(forgeHome);
      if (name === 'malformed') fs.writeFileSync(path.join(forgeHome, 'manifest.json'), '{bad');
      if (name === 'oversized') fs.writeFileSync(path.join(forgeHome, 'manifest.json'), `{"pad":"${'x'.repeat(70000)}"}`);
      let gitCalls = 0;
      const value = provider.refresh({ forgeHome }, { cacheDir, git() { gitCalls++; throw new Error('must not run'); } });
      assert.strictEqual(value.state, 'unknown');
      assert.strictEqual(value.has_update, false);
      assert.strictEqual(gitCalls, 0);
    }
  });

  test('unreadable manifest is unknown and never reaches Git', () => {
    const forgeHome = path.join(ROOT, 'manifest-unreadable');
    writeManifest(forgeHome, remoteManifest());
    const manifestFile = path.resolve(forgeHome, 'manifest.json');
    const originalRead = fs.readFileSync;
    let gitCalls = 0;
    try {
      fs.readFileSync = function(file, ...args) {
        if (path.resolve(file).toLowerCase() === manifestFile.toLowerCase()) {
          const error = new Error('fixture access denied');
          error.code = 'EACCES';
          throw error;
        }
        return originalRead.call(fs, file, ...args);
      };
      const value = provider.refresh({ forgeHome }, {
        cacheDir,
        git() { gitCalls++; throw new Error('must not run'); },
      });
      assert.strictEqual(value.state, 'unknown');
      assert.strictEqual(value.has_update, false);
      assert.strictEqual(gitCalls, 0);
    } finally { fs.readFileSync = originalRead; }
  });

  test('remote identity changes for sha, tag, channel or remote while clone identity includes HEAD', () => {
    const baseSource = { mode: 'remote', remote: 'https://one.invalid/a.git', channel: 'stable',
      tag: 'v1.2.3', sha: 'a'.repeat(40), version: 'v1.2.3' };
    const identity = provider._private.sourceIdentity(baseSource);
    for (const changed of [
      { sha: 'b'.repeat(40) },
      { tag: 'v1.2.4', version: 'v1.2.4' },
      { channel: 'master', tag: null, version: '1.2.3' },
      { remote: 'https://two.invalid/a.git' },
    ]) assert.notStrictEqual(provider._private.sourceIdentity({ ...baseSource, ...changed }), identity);
    const clone = { mode: 'clone', repo, version: '1.2.3' };
    assert.notStrictEqual(provider._private.sourceIdentity(clone, base), provider._private.sourceIdentity(clone, remote));
  });

  test('generation invalidation rejects an older concurrent publication', () => {
    const forgeHome = path.join(ROOT, 'generation');
    const installedSha = 'a'.repeat(40);
    writeManifest(forgeHome, remoteManifest({ sha: installedSha }));
    const target = { forgeHome };
    const file = provider.cachePath(target, cacheDir);
    provider.refresh(target, { cacheDir, git: remoteGit(tag(installedSha, '1.2.3')) });
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(provider.invalidateCache(target, { cacheDir }).invalidated, true);
    fs.writeFileSync(file, JSON.stringify(old));
    let launches = 0;
    const value = provider.cachedUpdate(target, { cacheDir, spawn() {
      launches++;
      return { on() {}, unref() {} };
    } });
    assert.strictEqual(value.state, 'unknown');
    assert.strictEqual(launches, 1);
    fs.rmSync(`${file}.refresh`, { force: true });
  });

  test('renderer reads cache only and starts one detached refresh without repo_path', () => {
    const forgeHome = path.join(ROOT, 'render');
    writeManifest(forgeHome, remoteManifest());
    const target = { forgeHome, cwd: ROOT, prefs: {} };
    let launches = 0;
    let unrefs = 0;
    const spawn = (command, args, options) => {
      launches++;
      assert.strictEqual(command, process.execPath);
      assert.strictEqual(args[1], '--refresh');
      assert.strictEqual(options.stdio, 'ignore');
      assert.strictEqual(options.windowsHide, true);
      assert.strictEqual(options.detached, true);
      return { on() {}, unref() { unrefs++; } };
    };
    assert.strictEqual(provider.cachedUpdate(target, { cacheDir, spawn }).state, 'unknown');
    assert.strictEqual(provider.cachedUpdate(target, { cacheDir, spawn }).state, 'unknown');
    assert.strictEqual(launches, 1);
    assert.strictEqual(unrefs, 1);
    fs.rmSync(`${provider.cachePath(target, cacheDir)}.refresh`, { force: true });
  });

  test('real render process exits while its detached refresh child remains alive', () => {
    const isolatedCache = path.join(ROOT, 'render-process-cache');
    const forgeHome = path.join(ROOT, 'render-process-home');
    const pidFile = path.join(ROOT, 'render-worker.pid');
    fs.mkdirSync(isolatedCache, { mode: 0o700 });
    writeManifest(forgeHome, remoteManifest());
    let workerPid;
    try {
      const result = spawnSync(process.execPath, ['-e', `
        const fs = require('fs'), { spawn } = require('child_process');
        const provider = require(process.argv[1]);
        console.log(JSON.stringify(provider.cachedUpdate({ forgeHome: process.argv[2] }, {
          cacheDir: process.argv[3],
          spawn(command, args, options) {
            const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], options);
            fs.writeFileSync(process.argv[4], String(child.pid));
            return child;
          }
        })));
      `, require.resolve('./forge-update-check'), forgeHome, isolatedCache, pidFile], {
        encoding: 'utf8', timeout: 3000,
      });
      workerPid = Number(fs.readFileSync(pidFile, 'utf8'));
      assert.strictEqual(result.status, 0, result.stderr || String(result.error));
      assert.strictEqual(JSON.parse(result.stdout).state, 'unknown');
      process.kill(workerPid, 0);
    } finally {
      if (!workerPid && fs.existsSync(pidFile)) workerPid = Number(fs.readFileSync(pidFile, 'utf8'));
      if (workerPid) { try { process.kill(workerPid); } catch (_) { /* finished */ } }
    }
  });

  test('installed statusline calls provider without requiring repo_path', () => {
    const installed = path.join(ROOT, 'flat-install');
    const scripts = path.join(installed, 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'forge-statusline.js'), path.join(installed, 'forge-statusline.js'));
    const called = path.join(installed, 'provider-called.json');
    fs.writeFileSync(path.join(scripts, 'forge-prefs.js'), 'module.exports.readPrefsCached=()=>({prefs:{}});');
    fs.writeFileSync(path.join(scripts, 'forge-update-check.js'), `
      module.exports.cachedUpdate = context => {
        require('fs').writeFileSync(${JSON.stringify(called)}, JSON.stringify(context));
        return {version:'v1.2.3',has_update:true,remote_version:'v2.0.0',state:'behind'};
      };
    `);
    const rendered = spawnSync(process.execPath, [path.join(installed, 'forge-statusline.js')], {
      encoding: 'utf8', timeout: 3000, cwd: installed,
      input: JSON.stringify({ cwd: installed, model: { display_name: 'Fixture' } }),
      env: { ...process.env, FORGE_HOME: installed },
    });
    assert.strictEqual(rendered.status, 0, rendered.stderr);
    const context = JSON.parse(fs.readFileSync(called, 'utf8'));
    assert.deepStrictEqual(context.prefs, {});
    assert.strictEqual(context.forgeHome, installed);
    assert(rendered.stdout.includes('v2.0.0'), rendered.stdout);
  });

  console.log(`${passed} update-check tests passed`);
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 });
}
