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
let skipped = 0;

function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

function skip(name, reason) {
  skipped++;
  console.log(`SKIP ${name}: ${reason}`);
}

function physical(value) {
  try { return fs.realpathSync.native(path.resolve(String(value))).toLowerCase(); }
  catch (_) { return path.resolve(String(value)).toLowerCase(); }
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
    // The provider realpaths FORGE_HOME (Windows 8.3 short names such as PEDROV~1 become
    // long names), so compare physical paths rather than lexical ones.
    assert(calls.every((call) => physical(call.cwd) === physical(forgeHome)));
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
    assert.strictEqual(different.error, null);
    assert.strictEqual(different.retry_after, null);
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

  test('clone refresh keeps ahead and diverged semantic states instead of treating exit 1 as transient', () => {
    const forgeHome = path.join(ROOT, 'source-repo-semantic-states');
    writeManifest(forgeHome, { version: '9.8.7', source_repo: repo });
    try {
      git(repo, 'reset', '--hard', remote);
      commit(repo, 'local ahead');
      const ahead = provider.refresh({ forgeHome, cwd: ROOT }, { cacheDir });
      assert.strictEqual(ahead.state, 'ahead');
      assert.strictEqual(ahead.error, null);

      git(repo, 'reset', '--hard', base);
      commit(repo, 'local divergent');
      const diverged = provider.refresh({ forgeHome, cwd: ROOT }, { cacheDir });
      assert.strictEqual(diverged.state, 'diverged');
      assert.strictEqual(diverged.error, null);
    } finally {
      git(repo, 'reset', '--hard', remote);
    }
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

  test('cache identity separates normalized consumer cwd and repo_path without exposing either path', () => {
    const forgeHome = path.join(ROOT, 'identity-home');
    const consumerA = path.join(ROOT, 'consumer-a');
    const consumerB = path.join(ROOT, 'consumer-b');
    const repoA = path.join(ROOT, 'identity-repo-a');
    const repoB = path.join(ROOT, 'identity-repo-b');
    for (const directory of [forgeHome, consumerA, consumerB, repoA, repoB]) fs.mkdirSync(directory);
    const baseTarget = { forgeHome, cwd: consumerA, prefs: { repo_path: repoA } };
    const sameNormalized = { forgeHome: path.join(forgeHome, '.'), cwd: path.join(consumerA, '..', 'consumer-a'),
      prefs: { repo_path: path.join(repoA, '.') } };
    const differentCwd = { forgeHome, cwd: consumerB, prefs: { repo_path: repoA } };
    const differentRepo = { forgeHome, cwd: consumerA, prefs: { repo_path: repoB } };
    const baseFile = provider.cachePath(baseTarget, cacheDir);
    const refreshTarget = provider._private.targetFromRequest(
      provider._private.spawnRequest(provider.renderContext(baseTarget)));
    assert.strictEqual(provider.cachePath(sameNormalized, cacheDir), baseFile);
    assert.strictEqual(provider.cachePath(refreshTarget, cacheDir), baseFile,
      'detached refresh request must reconstruct the statusline cache identity');
    assert.notStrictEqual(provider.cachePath(differentCwd, cacheDir), baseFile);
    assert.notStrictEqual(provider.cachePath(differentRepo, cacheDir), baseFile);
    assert.match(path.basename(baseFile), /^forge-update-[a-f0-9]{64}\.json$/);
    assert(!path.basename(baseFile).includes(path.basename(consumerA)));
    assert(!path.basename(baseFile).includes(path.basename(repoA)));
  });

  test('refresh, cached read and direct invalidation use the same canonical consumer key', () => {
    const forgeHome = path.join(ROOT, 'context-parity-home');
    const consumer = path.join(ROOT, 'context-parity-consumer');
    fs.mkdirSync(consumer);
    writeManifest(forgeHome, remoteManifest({ sha: 'a'.repeat(40) }));
    const target = { forgeHome, cwd: consumer, prefs: { repo_path: repo } };
    const file = provider.cachePath(target, cacheDir);
    const refreshed = provider.refresh(target, { cacheDir, git: remoteGit(tag('a'.repeat(40), '1.2.3')) });
    assert.strictEqual(refreshed.state, 'equal');
    assert.strictEqual(provider.cachedUpdate(target, { cacheDir, spawn() { throw new Error('fresh cache must not spawn'); } }).state, 'equal');
    const invalidated = provider.invalidateCache(target, { cacheDir });
    assert.strictEqual(invalidated.file, file);
    assert.strictEqual(invalidated.invalidated, true);
    assert.strictEqual(fs.existsSync(file), false);
  });

  test('CLI --invalidate --cwd resolves repo_path with the canonical prefs engine', () => {
    const forgeHome = path.join(ROOT, 'cli-invalidate-home');
    const consumer = path.join(ROOT, 'cli-invalidate-consumer');
    const cliCache = path.join(ROOT, 'cli-invalidate-cache');
    const relativeRepo = path.relative(consumer, repo);
    fs.mkdirSync(path.join(consumer, '.gsd'), { recursive: true });
    fs.mkdirSync(cliCache, { mode: 0o700 });
    fs.writeFileSync(path.join(consumer, '.gsd', 'forge-prefs.jsonc'), JSON.stringify({ repo_path: relativeRepo }));
    writeManifest(forgeHome, remoteManifest({ sha: 'a'.repeat(40) }));
    const target = { forgeHome, cwd: consumer, prefs: { repo_path: relativeRepo } };
    const file = provider.cachePath(target, cliCache);
    provider.refresh(target, { cacheDir: cliCache, git: remoteGit(tag('a'.repeat(40), '1.2.3')) });
    assert.strictEqual(fs.existsSync(file), true);
    const result = spawnSync(process.execPath, [require.resolve('./forge-update-check'), '--invalidate', '--cwd', consumer, cliCache], {
      encoding: 'utf8', timeout: 3000,
      env: { ...process.env, FORGE_HOME: forgeHome, HOME: path.join(ROOT, 'cli-home'), USERPROFILE: path.join(ROOT, 'cli-home') },
    });
    assert.strictEqual(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.strictEqual(output.file, file);
    assert.strictEqual(output.invalidated, true);
    assert.strictEqual(fs.existsSync(file), false);
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
    const manifestFile = physical(path.join(forgeHome, 'manifest.json'));
    const originalOpen = fs.openSync;
    let gitCalls = 0;
    try {
      fs.openSync = function(file, ...args) {
        if (typeof file === 'string' && physical(file) === manifestFile) {
          const error = new Error('fixture access denied');
          error.code = 'EACCES';
          throw error;
        }
        return originalOpen.call(fs, file, ...args);
      };
      const value = provider.refresh({ forgeHome }, {
        cacheDir,
        git() { gitCalls++; throw new Error('must not run'); },
      });
      assert.strictEqual(value.state, 'unknown');
      assert.strictEqual(value.has_update, false);
      assert.strictEqual(gitCalls, 0);
    } finally { fs.openSync = originalOpen; }
  });

  test('manifest directory is unknown without Git', () => {
    const forgeHome = path.join(ROOT, 'manifest-directory');
    fs.mkdirSync(path.join(forgeHome, 'manifest.json'), { recursive: true });
    let gitCalls = 0;
    const value = provider.refresh({ forgeHome }, { cacheDir, git() { gitCalls++; } });
    assert.strictEqual(value.state, 'unknown');
    assert.strictEqual(gitCalls, 0);
  });

  test('manifest symlink is unknown without Git', () => {
    const forgeHome = path.join(ROOT, 'manifest-symlink');
    const target = path.join(ROOT, 'manifest-symlink-target.json');
    fs.mkdirSync(forgeHome);
    fs.writeFileSync(target, JSON.stringify(remoteManifest()));
    try {
      fs.symlinkSync(target, path.join(forgeHome, 'manifest.json'), 'file');
    } catch (error) {
      skip('manifest symlink is unknown without Git', `symlink unavailable (${error.code || error.message})`);
      return;
    }
    let gitCalls = 0;
    const value = provider.refresh({ forgeHome }, { cacheDir, git() { gitCalls++; } });
    assert.strictEqual(value.state, 'unknown');
    assert.strictEqual(gitCalls, 0);
  });

  if (process.platform === 'win32') {
    skip('manifest FIFO is unknown without Git', 'POSIX FIFO unavailable on win32');
    skip('world-writable manifest is unknown without Git', 'POSIX mode policy unavailable on win32');
  } else {
    test('manifest FIFO is unknown without Git', () => {
      const forgeHome = path.join(ROOT, 'manifest-fifo');
      const manifest = path.join(forgeHome, 'manifest.json');
      fs.mkdirSync(forgeHome);
      const made = spawnSync('mkfifo', [manifest], { encoding: 'utf8', shell: false });
      if (made.status !== 0) {
        skip('manifest FIFO is unknown without Git', `mkfifo unavailable (${made.stderr || made.error})`);
        return;
      }
      let gitCalls = 0;
      const value = provider.refresh({ forgeHome }, { cacheDir, git() { gitCalls++; } });
      assert.strictEqual(value.state, 'unknown');
      assert.strictEqual(gitCalls, 0);
    });

    test('world-writable manifest is unknown without Git', () => {
      const forgeHome = path.join(ROOT, 'manifest-world-writable');
      writeManifest(forgeHome, remoteManifest({ sha: 'a'.repeat(40) }));
      fs.chmodSync(path.join(forgeHome, 'manifest.json'), 0o602);
      let gitCalls = 0;
      const value = provider.refresh({ forgeHome }, { cacheDir, git() { gitCalls++; } });
      assert.strictEqual(value.state, 'unknown');
      assert.strictEqual(gitCalls, 0);
    });
  }

  test('manifest identity swap between lstat and open is unknown without Git', () => {
    const forgeHome = path.join(ROOT, 'manifest-identity-swap');
    const manifest = path.join(forgeHome, 'manifest.json');
    const displaced = path.join(forgeHome, 'manifest.displaced');
    writeManifest(forgeHome, remoteManifest({ sha: 'a'.repeat(40) }));
    const originalOpen = fs.openSync;
    let swapped = false;
    let gitCalls = 0;
    try {
      fs.openSync = function(file, ...args) {
        if (!swapped && typeof file === 'string' && physical(file) === physical(manifest)) {
          swapped = true;
          fs.renameSync(manifest, displaced);
          fs.writeFileSync(manifest, JSON.stringify(remoteManifest({ sha: 'b'.repeat(40) })));
        }
        return originalOpen.call(fs, file, ...args);
      };
      const value = provider.refresh({ forgeHome }, { cacheDir, git() { gitCalls++; } });
      assert.strictEqual(value.state, 'unknown');
      assert.strictEqual(gitCalls, 0);
    } finally { fs.openSync = originalOpen; }
  });

  test('remote validation rejects option, upload-pack, ext transport and controls before Git', () => {
    for (const [name, remoteValue] of [
      ['option', '--upload-pack=evil'],
      ['upload-pack', 'https://example.invalid/repo.git --upload-pack=evil'],
      ['ext', 'ext::sh -c evil'],
      ['control', 'https://example.invalid/repo.git\n--upload-pack=evil'],
    ]) {
      const forgeHome = path.join(ROOT, `manifest-remote-${name}`);
      writeManifest(forgeHome, remoteManifest({ remote: remoteValue }));
      let gitCalls = 0;
      const value = provider.refresh({ forgeHome }, { cacheDir, git() { gitCalls++; } });
      assert.strictEqual(value.state, 'unknown');
      assert.strictEqual(gitCalls, 0);
    }
  });

  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    skip('foreign-UID group-writable manifest is accepted', 'POSIX ownership unavailable');
    skip('foreign-UID cache and generation are rejected', 'POSIX ownership unavailable');
    skip('non-private cache and generation modes are rejected', 'POSIX mode policy unavailable');
  } else {
    test('non-private cache and generation modes are rejected', () => {
      const forgeHome = path.join(ROOT, 'private-mode-home');
      const target = { forgeHome };
      writeManifest(forgeHome, remoteManifest({ sha: 'a'.repeat(40) }));
      const file = provider.cachePath(target, cacheDir);
      provider.refresh(target, { cacheDir, git: remoteGit(tag('a'.repeat(40), '1.2.3')) });
      fs.chmodSync(file, 0o640);
      assert.strictEqual(provider._private.readCache(file), null);
      fs.chmodSync(file, 0o600);
      provider.invalidateCache(target, { cacheDir });
      provider.refresh(target, { cacheDir, git: remoteGit(tag('a'.repeat(40), '1.2.3')) });
      fs.chmodSync(`${file}.generation`, 0o640);
      assert.strictEqual(provider._private.readCache(file), null);
    });

    if (process.getuid() !== 0) {
      skip('foreign-UID group-writable manifest is accepted', 'chown requires root');
      skip('foreign-UID cache and generation are rejected', 'chown requires root');
    } else {
      test('foreign-UID group-writable manifest is accepted', () => {
        const forgeHome = path.join(ROOT, 'foreign-manifest-home');
        const manifest = path.join(forgeHome, 'manifest.json');
        writeManifest(forgeHome, remoteManifest({ sha: 'a'.repeat(40) }));
        fs.chmodSync(manifest, 0o620);
        fs.chownSync(manifest, 65534, typeof process.getgid === 'function' ? process.getgid() : 0);
        const value = provider.refresh({ forgeHome }, {
          cacheDir, git: remoteGit(tag('a'.repeat(40), '1.2.3')),
        });
        assert.strictEqual(value.state, 'equal');
      });

      test('foreign-UID cache and generation are rejected', () => {
        const forgeHome = path.join(ROOT, 'foreign-private-home');
        const target = { forgeHome };
        writeManifest(forgeHome, remoteManifest({ sha: 'a'.repeat(40) }));
        const file = provider.cachePath(target, cacheDir);
        provider.refresh(target, { cacheDir, git: remoteGit(tag('a'.repeat(40), '1.2.3')) });
        fs.chownSync(file, 65534, typeof process.getgid === 'function' ? process.getgid() : 0);
        assert.strictEqual(provider._private.readCache(file), null);
        provider.invalidateCache(target, { cacheDir });
        provider.refresh(target, { cacheDir, git: remoteGit(tag('a'.repeat(40), '1.2.3')) });
        fs.chownSync(`${file}.generation`, 65534, typeof process.getgid === 'function' ? process.getgid() : 0);
        assert.strictEqual(provider._private.readCache(file), null);
      });
    }
  }

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

  test('transient Git failure retains only a matching success and retries after exactly 60 seconds', () => {
    const forgeHome = path.join(ROOT, 'transient-retention');
    const target = { forgeHome };
    const installedSha = 'a'.repeat(40);
    const latestSha = 'b'.repeat(40);
    writeManifest(forgeHome, remoteManifest({ sha: installedSha }));
    const success = provider.refresh(target, {
      cacheDir, git: remoteGit(tag(latestSha, '2.0.0') + tag(installedSha, '1.2.3')),
    });
    const beforeFailure = Date.now();
    const failure = provider.refresh(target, { cacheDir, git() {
      const error = new Error('fatal: https://user:token@example.invalid/repo.git\nstderr arbitrary secret');
      error.stderr = 'raw git stderr';
      throw error;
    } });
    assert.strictEqual(failure.state, 'behind');
    assert.strictEqual(failure.has_update, true);
    assert.strictEqual(failure.version, success.version);
    assert.strictEqual(failure.remote_version, success.remote_version);
    assert.strictEqual(failure.ts, success.ts);
    assert.strictEqual(failure.last_success_ts, success.last_success_ts);
    assert.strictEqual(failure.error, 'git_transient');
    assert(failure.retry_after >= beforeFailure + provider._private.TRANSIENT_RETRY_MS);
    const persisted = fs.readFileSync(provider.cachePath(target, cacheDir), 'utf8');
    assert(!persisted.includes('user:token@'));
    assert(!persisted.includes('stderr arbitrary'));
    assert(!persisted.includes('raw git stderr'));
    assert(failure.error.length <= 64);

    const originalNow = Date.now;
    let launches = 0;
    try {
      Date.now = () => failure.retry_after - 1;
      assert.strictEqual(provider.cachedUpdate(target, { cacheDir, spawn() { launches++; } }).state, 'behind');
      assert.strictEqual(launches, 0, 'retry is suppressed only inside the 60-second window');
      Date.now = () => failure.retry_after;
      assert.strictEqual(provider.cachedUpdate(target, { cacheDir, spawn() {
        launches++;
        return { on() {}, unref() {} };
      } }).state, 'behind');
      assert.strictEqual(launches, 1, 'retry becomes eligible at the fixed boundary');
    } finally {
      Date.now = originalNow;
      fs.rmSync(`${provider.cachePath(target, cacheDir)}.refresh`, { force: true });
    }
  });

  test('transient failure without reusable state is unknown with local installed version and 60-second retry', () => {
    const forgeHome = path.join(ROOT, 'transient-no-state');
    writeManifest(forgeHome, remoteManifest({ sha: 'a'.repeat(40) }));
    const before = Date.now();
    const value = provider.refresh({ forgeHome }, { cacheDir, git() { throw new Error('network down'); } });
    assert.strictEqual(value.state, 'unknown');
    assert.strictEqual(value.has_update, false);
    assert.strictEqual(value.version, 'v1.2.3');
    assert.strictEqual(value.last_success_ts, null);
    assert.strictEqual(value.error, 'git_transient');
    assert(value.retry_after >= before + provider._private.TRANSIENT_RETRY_MS);
  });

  test('transient failure does not retain a success from another source identity', () => {
    const forgeHome = path.join(ROOT, 'transient-identity-mismatch');
    const target = { forgeHome };
    writeManifest(forgeHome, remoteManifest({ sha: 'a'.repeat(40) }));
    provider.refresh(target, { cacheDir, git: remoteGit(tag('a'.repeat(40), '1.2.3')) });
    writeManifest(forgeHome, remoteManifest({ sha: 'b'.repeat(40) }));
    const value = provider.refresh(target, { cacheDir, git() { throw new Error('network down'); } });
    assert.strictEqual(value.state, 'unknown');
    assert.strictEqual(value.has_update, false);
    assert.strictEqual(value.identity, provider._private.sourceIdentity({
      mode: 'remote', remote: 'https://example.invalid/forge.git', channel: 'stable',
      tag: 'v1.2.3', sha: 'b'.repeat(40), version: 'v1.2.3',
    }));
  });

  test('transient failure does not retain a cache from an older generation', () => {
    const forgeHome = path.join(ROOT, 'transient-generation-mismatch');
    const target = { forgeHome };
    writeManifest(forgeHome, remoteManifest({ sha: 'a'.repeat(40) }));
    const file = provider.cachePath(target, cacheDir);
    provider.refresh(target, { cacheDir, git: remoteGit(tag('a'.repeat(40), '1.2.3')) });
    const old = fs.readFileSync(file, 'utf8');
    provider.invalidateCache(target, { cacheDir });
    fs.writeFileSync(file, old, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    const value = provider.refresh(target, { cacheDir, git() { throw new Error('network down'); } });
    assert.strictEqual(value.state, 'unknown');
    assert.strictEqual(value.has_update, false);
  });

  test('semantic stable failures never reuse an earlier update arrow', () => {
    for (const [name, tags] of [
      ['missing', tag('b'.repeat(40), '2.0.0')],
      ['retargeted', tag('c'.repeat(40), '1.2.3')],
    ]) {
      const forgeHome = path.join(ROOT, `semantic-no-stale-${name}`);
      const target = { forgeHome };
      const installedSha = 'a'.repeat(40);
      writeManifest(forgeHome, remoteManifest({ sha: installedSha }));
      provider.refresh(target, {
        cacheDir, git: remoteGit(tag('b'.repeat(40), '2.0.0') + tag(installedSha, '1.2.3')),
      });
      const value = provider.refresh(target, { cacheDir, git: remoteGit(tags) });
      assert.strictEqual(value.state, 'unknown');
      assert.strictEqual(value.has_update, false);
      assert.strictEqual(value.remote_version, '');
      assert.strictEqual(value.retry_after, null);
    }
  });

  test('invalid stable tag never reuses an earlier update arrow or reaches Git', () => {
    const forgeHome = path.join(ROOT, 'semantic-invalid-tag');
    const target = { forgeHome };
    const installedSha = 'a'.repeat(40);
    writeManifest(forgeHome, remoteManifest({ sha: installedSha }));
    provider.refresh(target, {
      cacheDir, git: remoteGit(tag('b'.repeat(40), '2.0.0') + tag(installedSha, '1.2.3')),
    });
    writeManifest(forgeHome, remoteManifest({ sha: installedSha, tag: 'latest' }));
    let gitCalls = 0;
    const value = provider.refresh(target, { cacheDir, git() { gitCalls++; } });
    assert.strictEqual(value.state, 'unknown');
    assert.strictEqual(value.has_update, false);
    assert.strictEqual(value.remote_version, '');
    assert.strictEqual(value.retry_after, null);
    assert.strictEqual(gitCalls, 0);
  });

  test('previous cache schema is a cache miss, not a reinterpreted identity', () => {
    const forgeHome = path.join(ROOT, 'old-schema');
    const target = { forgeHome };
    writeManifest(forgeHome, remoteManifest());
    const file = provider.cachePath(target, cacheDir);
    fs.writeFileSync(file, JSON.stringify({
      schema_version: provider._private.CACHE_SCHEMA_VERSION - 1,
      ts: Date.now(), state: 'behind', source_mode: 'remote', identity: 'a'.repeat(64),
      version: 'v1.2.3', has_update: true, remote_version: 'v2.0.0', generation: null,
    }), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    let launches = 0;
    const value = provider.cachedUpdate(target, { cacheDir, spawn() {
      launches++;
      return { on() {}, unref() {} };
    } });
    assert.strictEqual(value.state, 'unknown');
    assert.strictEqual(launches, 1);
    fs.rmSync(`${file}.refresh`, { force: true });
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
