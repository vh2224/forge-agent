#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const guard = require('./forge-native-readonly-guard');
const lease = require('./forge-unit-lease');
const runs = require('./forge-runs');
const execution = require('./forge-task-execution');
const vcs = require('./forge-vcs');
const dispatchEvent = require('./forge-dispatch-event');

const temporary = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'forge-readonly-'));
const script = path.join(__dirname, 'forge-native-readonly-guard.js');
let serial = 0;
function git(root, ...args) {
  assert.ok(root.startsWith(temporary + path.sep), 'Git writes stay in own temporary repositories');
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', shell: false, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function fixture() {
  const root = path.join(temporary, `repo-${++serial}`);
  fs.mkdirSync(root); git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(root, '.gitignore'), '.gsd/\nignored/\n');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'original\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture');
  fs.mkdirSync(path.join(root, '.gsd', 'forge'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gsd', 'control.json'), '{"original":true}\n');
  fs.writeFileSync(path.join(root, '.gsd', 'forge', 'events.jsonl'), '{"event":"before"}\n');
  return root;
}
function capture(root, options = {}) {
  const result = guard.captureBaseline({ owner: root, codeRoots: [{ id: 'forge', path: root }], ...options });
  assert.equal(result.exit_code, 0, JSON.stringify(result));
  return result.baseline;
}
function verify(baseline) { return guard.verifyBaseline(baseline, { writerStopped: true }); }
function mutation(root, change, expected, options = {}) {
  const before = capture(root, options); change(root);
  const result = verify(before);
  assert.equal(result.reason, guard.REASONS.MUTATION, JSON.stringify(result));
  assert.equal(result.exit_code, 3);
  assert.ok(result.changes.some(row => row.kind === expected), JSON.stringify(result));
  assert.ok(result.changes.every(row => !path.isAbsolute(row.path) && row.root && !('content' in row)));
  return result;
}
function check(label, action) { action(); console.log(`PASS S03/T06 ${label}`); }
function cli(args) { return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 1024 * 1024 }); }

// #387 uses real canonical run writes and exact FULL owner comparisons.
function oldestAliasCases(root, label) {
  for (const record of runs.listAll(root)) runs.remove(root, record.id);
  runs.add(root, { id: 'alias-own', kind: 'milestone', session_id: 'fixture', started_at: 200, last_heartbeat: 200, write_claim: null });
  const options = { ownRun: 'alias-own' }, alias = path.join(root, '.gsd', 'forge', 'auto-mode.json');
  check(label + ' only-own canonical heartbeat permits exact legacy alias clock', () => {
    const baseline = capture(root, options); runs.bumpHeartbeat(root, 'alias-own', 300);
    const result = verify(baseline); assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.owner_transitions.map(row => row.kind).sort(), ['run-alias-heartbeat', 'run-heartbeat']);
    assert.equal(fs.readFileSync(alias, 'utf8'), JSON.stringify(runs.legacyAliasProjection(runs.oldestActive(root)), null, 2));
  });
  runs.add(root, { id: 'alias-foreign', kind: 'milestone', session_id: 'foreign', started_at: 400, last_heartbeat: 400, write_claim: null });
  check(label + ' oldest-own with foreign newer run permits own heartbeat only', () => {
    const baseline = capture(root, options); runs.bumpHeartbeat(root, 'alias-own', 500);
    assert.equal(verify(baseline).ok, true);
    const denied = capture(root, options), foreignFile = runs.runFile(root, 'alias-foreign'), raw = fs.readFileSync(foreignFile);
    runs.bumpHeartbeat(root, 'alias-foreign', 600);
    assert.equal(verify(denied).reason, guard.REASONS.MUTATION);
    fs.writeFileSync(foreignFile, raw);
  });
  check(label + ' malformed arbitrary and forged alias clocks remain owner-control', () => {
    for (const mutate of [() => '{', value => JSON.stringify({ ...value, arbitrary: true }, null, 2),
      value => JSON.stringify({ ...value, last_heartbeat: value.last_heartbeat + 1 }, null, 2),
      value => JSON.stringify({ ...value, worker: 'foreign' }, null, 2)]) {
      const baseline = capture(root, options), raw = fs.readFileSync(alias);
      fs.writeFileSync(alias, mutate(JSON.parse(raw)));
      const result = verify(baseline); assert.equal(result.reason, guard.REASONS.MUTATION);
      assert.ok(result.changes.some(row => row.path === '.gsd/forge/auto-mode.json' && row.kind === 'owner-control'));
      fs.writeFileSync(alias, raw);
    }
  });
  check(label + ' own owner active worker claim changes remain forbidden', () => {
    for (const patch of [{ owner: { session_id: 'foreign' } }, { active: false }, { worker: 'execute-task/foreign' }, { write_claim: { forged: true } }]) {
      const baseline = capture(root, options), ownFile = runs.runFile(root, 'alias-own');
      const ownRaw = fs.readFileSync(ownFile), aliasRaw = fs.readFileSync(alias);
      runs.update(root, 'alias-own', patch);
      assert.equal(verify(baseline).reason, guard.REASONS.MUTATION);
      fs.writeFileSync(ownFile, ownRaw); fs.writeFileSync(alias, aliasRaw);
    }
  });
  check(label + ' foreign oldest malformed registry and absent preimage grant no alias allowance', () => {
    const foreignFile = runs.runFile(root, 'alias-foreign'), foreignRaw = fs.readFileSync(foreignFile);
    runs.update(root, 'alias-foreign', { started_at: 100 });
    const foreignOldest = capture(root, options); runs.bumpHeartbeat(root, 'alias-foreign', 700);
    assert.equal(verify(foreignOldest).reason, guard.REASONS.MUTATION);
    fs.writeFileSync(foreignFile, foreignRaw); runs.refreshLegacyAlias(root);
    const malformed = path.join(runs.runsDir(root), 'malformed.json'); fs.writeFileSync(malformed, '{');
    const unknown = capture(root, options); runs.bumpHeartbeat(root, 'alias-own', 800);
    assert.equal(verify(unknown).reason, guard.REASONS.MUTATION); fs.unlinkSync(malformed);
    const saved = fs.readFileSync(alias); fs.unlinkSync(alias);
    const absent = capture(root, options); runs.bumpHeartbeat(root, 'alias-own', 900);
    assert.equal(verify(absent).reason, guard.REASONS.MUTATION); fs.writeFileSync(alias, saved);
  });
}
// END #387 REGRESSION

// SVN regression: real private file:// repository, no foreign WC or provider.
function svnFullCases() {
  for (const binary of ['svn', 'svnadmin']) {
    const observed = spawnSync(binary, ['--version', '--quiet'], { encoding: 'utf8', shell: false, windowsHide: true });
    if (observed.status !== 0) { console.log('SKIP S03/T06 SVN fixture: ' + binary + ' unavailable'); return; }
  }
  const folder = path.join(temporary, 'svn-full'), repository = path.join(folder, 'repository'), root = path.join(folder, 'wc');
  fs.mkdirSync(folder); const home = path.join(folder, 'home'); fs.mkdirSync(home);
  const saved = Object.fromEntries(['HOME', 'USERPROFILE', 'APPDATA', 'FORGE_HOME', 'CODEX_HOME'].map(key => [key, process.env[key]]));
  for (const key of Object.keys(saved)) process.env[key] = home;
  const configDir = path.join(home, 'svn-client'); fs.mkdirSync(configDir);
  function command(binary, args, cwd = folder) {
    assert.ok(path.resolve(cwd).startsWith(path.resolve(folder) + path.sep) || path.resolve(cwd) === path.resolve(folder));
    const result = spawnSync(binary, args, { cwd, encoding: 'utf8', shell: false, windowsHide: true });
    assert.equal(result.status, 0, result.stderr); return result.stdout;
  }
  const svn = (...args) => command('svn', ['--non-interactive', '--config-dir', configDir, ...args], root);
  try {
    command('svnadmin', ['create', repository]);
    command('svn', ['--non-interactive', '--config-dir', configDir, 'checkout', require('url').pathToFileURL(repository).href, root]);
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'original\n');
    fs.mkdirSync(path.join(root, 'subdir')); fs.writeFileSync(path.join(root, 'subdir', 'nested.txt'), 'nested\n');
    svn('add', 'tracked.txt', 'subdir'); svn('commit', '-m', 'synthetic baseline'); svn('update');
    fs.mkdirSync(path.join(root, '.gsd', 'forge'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gsd', 'control.json'), '{"original":true}\n');
    fs.writeFileSync(path.join(root, '.gsd', 'forge', 'events.jsonl'), 'before\n');
    check('SVN FULL unchanged and writer attestation remain strict', () => {
      const baseline = capture(root); assert.equal(baseline.code_roots[0].vcs, 'svn');
      assert.equal(verify(baseline).ok, true);
      assert.equal(guard.verifyBaseline(baseline).reason, guard.REASONS.UNRECONCILED);
      assert.equal(guard.captureBaseline({ owner: root, codeRoots: [path.join(root, 'subdir')] }).ok, true);
    });
    check('SVN FULL permits exact owner append/publication and own heartbeat only', () => {
      const own = lease.acquire(root, 'review/svn', { now: 1000, ttlMs: 10000 }); assert.equal(own.ok, true);
      runs.add(root, { id: 'svn-foreign', kind: 'milestone', session_id: 'fixture', started_at: 100, last_heartbeat: 100, write_claim: null });
      runs.add(root, { id: 'svn-own', kind: 'milestone', session_id: 'fixture', started_at: 200, last_heartbeat: 200, write_claim: null });
      const baseline = capture(root, { allowAppend: ['.gsd/forge/events.jsonl'], allowPublication: ['.gsd/DEFENSE.md'], ownLease: 'review/svn', ownRun: 'svn-own' });
      fs.appendFileSync(path.join(root, '.gsd', 'forge', 'events.jsonl'), 'append\n');
      fs.writeFileSync(path.join(root, '.gsd', 'DEFENSE.md'), 'synthetic defense\n');
      assert.equal(lease.heartbeat(root, 'review/svn', own.owner_token, own.generation, { now: 2000, ttlMs: 10000 }).ok, true);
      runs.bumpHeartbeat(root, 'svn-own', 300);
      const allowed = verify(baseline); assert.equal(allowed.ok, true, JSON.stringify(allowed));
      fs.writeFileSync(path.join(root, '.gsd', 'control.json'), '{"original":false}\n');
      assert.equal(verify(baseline).reason, guard.REASONS.MUTATION);
    });
    check('SVN FULL detects content plus unversioned add and missing path', () => {
      mutation(root, r => fs.writeFileSync(path.join(r, 'tracked.txt'), 'changed\n'), 'modified');
      fs.writeFileSync(path.join(root, 'tracked.txt'), 'original\n');
      mutation(root, r => fs.writeFileSync(path.join(r, 'new.txt'), 'new\n'), 'added');
      mutation(root, r => fs.unlinkSync(path.join(r, 'tracked.txt')), 'deleted');
      fs.writeFileSync(path.join(root, 'tracked.txt'), 'original\n');
    });
    check('SVN FULL detects observable mode without byte changes', () => {
      const file = path.join(root, 'tracked.txt'), mode = fs.statSync(file).mode;
      const baseline = capture(root); fs.chmodSync(file, mode & ~0o222);
      assert.notEqual(fs.statSync(file).mode, mode, 'fixture requires observable readonly bit');
      assert.ok(verify(baseline).changes.some(row => row.kind === 'mode'));
      fs.chmodSync(file, mode & 0o777);
    });
    check('SVN FULL detects property and administrative bytes', () => {
      mutation(root, () => svn('propset', 'fixture:property', 'new', 'tracked.txt'), 'properties');
      mutation(root, r => fs.writeFileSync(path.join(r, '.svn', 'tmp', 'unapproved'), 'admin\n'), 'administration');
    });
    check('SVN FULL detects local BASE advancement', () => {
      const baseline = capture(root); fs.writeFileSync(path.join(root, 'tracked.txt'), 'committed\n');
      svn('commit', '-m', 'synthetic revision'); svn('update');
      assert.ok(verify(baseline).changes.some(row => row.kind === 'base'));
    });
    oldestAliasCases(root, 'SVN FULL #387');
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
// END SVN REGRESSION

// SVN administration regression: bounded stream, real private SQLite WC files.
function svnAdminStreamingCases() {
  const folder = path.join(temporary, 'svn-streaming'), repository = path.join(folder, 'repository');
  fs.mkdirSync(folder);
  const configDir = path.join(folder, 'client'); fs.mkdirSync(configDir);
  function command(binary, args, cwd = folder) {
    assert.ok(path.resolve(cwd) === path.resolve(folder) || path.resolve(cwd).startsWith(path.resolve(folder) + path.sep));
    const observed = spawnSync(binary, args, { cwd, encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 1024 * 1024 });
    assert.equal(observed.status, 0, observed.stderr); return observed.stdout;
  }
  for (const binary of ['svn', 'svnadmin']) {
    const observed = spawnSync(binary, ['--version', '--quiet'], { encoding: 'utf8', shell: false, windowsHide: true });
    if (observed.status !== 0) { console.log('SKIP SVN admin streaming: ' + binary + ' unavailable'); return; }
  }
  command('svnadmin', ['create', repository]);
  function largeFixture(name, payloadBytes) {
    const root = path.join(folder, name);
    command('svn', ['--non-interactive', '--config-dir', configDir, 'checkout', require('url').pathToFileURL(repository).href, root]);
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'original\n');
    const svn = (...args) => command('svn', ['--non-interactive', '--config-dir', configDir, ...args], root);
    svn('add', 'tracked.txt');
    const payload = path.join(folder, name + '.payload');
    fs.writeFileSync(payload, Buffer.alloc(payloadBytes, 65));
    svn('propset', 'fixture:large-admin', '--file', payload, 'tracked.txt');
    fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
    const db = path.join(root, '.svn', 'wc.db'), size = fs.statSync(db).size;
    assert.ok(size >= payloadBytes, 'valid SQLite WC contains the representative administrative payload');
    return { root, db, size };
  }
  const small = largeFixture('wc-4m6', 4603904), large = largeFixture('wc-9m3', 9256960);
  console.log('MEASURE SVN admin fixtures ' + JSON.stringify({ small_wc_db_bytes: small.size, large_wc_db_bytes: large.size }));
  const saved = { open: fs.openSync, read: fs.readSync, close: fs.closeSync, readFile: fs.readFileSync };
  const administrative = new Map(); let calls = 0, largest = 0, observer = null;
  function isAdmin(file) { return typeof file !== 'number' && /[\\/]\.svn(?:[\\/]|$)/i.test(String(file)); }
  fs.openSync = function(file, ...args) {
    const fd = saved.open.call(fs, file, ...args); if (isAdmin(file)) administrative.set(fd, String(file)); return fd;
  };
  fs.readSync = function(fd, buffer, offset, length, position) {
    if (administrative.has(fd)) {
      assert.ok(length <= 64 * 1024, 'administrative read buffer stays bounded');
      largest = Math.max(largest, length); calls++;
    }
    const count = saved.read.call(fs, fd, buffer, offset, length, position);
    if (observer && administrative.has(fd)) observer(administrative.get(fd), count);
    return count;
  };
  fs.closeSync = function(fd) { administrative.delete(fd); return saved.close.call(fs, fd); };
  fs.readFileSync = function(file, ...args) { assert.ok(!isAdmin(file), 'no whole administrative file read'); return saved.readFile.call(fs, file, ...args); };
  try {
    check('SVN FULL streams a valid 4.6 MB administrative database', () => {
      const baseline = capture(small.root); assert.equal(verify(baseline).ok, true);
    });
    check('SVN FULL streams a valid 9.3 MB database and canonical-sized local content', () => {
      fs.writeFileSync(path.join(large.root, 'local-2m.bin'), Buffer.alloc(2 * 1024 * 1024, 88));
      const baseline = capture(large.root); assert.equal(verify(baseline).ok, true);
      assert.ok(calls > 100 && largest === 64 * 1024);
    });
    check('SVN FULL detects administrative content tamper after a large baseline', () => {
      const proof = path.join(small.root, '.svn', 'tmp', 'stream-proof'); fs.writeFileSync(proof, 'before');
      const baseline = capture(small.root); fs.writeFileSync(proof, 'after!');
      const observed = verify(baseline); assert.equal(observed.reason, guard.REASONS.MUTATION);
      assert.ok(observed.changes.some(row => row.kind === 'administration'));
      fs.unlinkSync(proof);
    });
    check('SVN FULL refuses an administrative file changing during its stream', () => {
      const before = fs.statSync(small.db); let changed = false;
      observer = (file, count) => {
        if (!changed && path.resolve(file) === path.resolve(small.db) && count > 0) {
          changed = true; fs.utimesSync(small.db, before.atime, new Date(before.mtimeMs + 5000));
        }
      };
      try {
        const observed = guard.captureBaseline({ owner: small.root, codeRoots: [small.root] });
        assert.ok(changed); assert.equal(observed.reason, guard.REASONS.UNAVAILABLE);
        assert.ok(!observed.baseline, 'unstable evidence never publishes a baseline');
      } finally { observer = null; fs.utimesSync(small.db, before.atime, before.mtime); }
    });
    check('SVN FULL refuses administration above the canonical per-file limit before reading it', () => {
      const oversized = path.join(small.root, '.svn', 'tmp', 'oversized');
      const fd = saved.open.call(fs, oversized, 'wx');
      try { fs.ftruncateSync(fd, vcs.SVN_STRICT_POLICY.maxFileBytes + 1); } finally { saved.close.call(fs, fd); }
      const openBefore = fs.openSync;
      fs.openSync = function(file, ...args) {
        assert.notEqual(typeof file === 'number' ? '' : path.resolve(String(file)), path.resolve(oversized), 'oversized content is not opened');
        return openBefore.call(fs, file, ...args);
      };
      try {
        const observed = guard.captureBaseline({ owner: small.root, codeRoots: [small.root] });
        assert.equal(observed.reason, guard.REASONS.UNAVAILABLE); assert.ok(!observed.baseline);
      } finally { fs.openSync = openBefore; fs.unlinkSync(oversized); }
    });
    check('SVN FULL counts administrative entries once across both observations', () => {
      const folder = path.join(small.root, '.svn', 'tmp', 'entry-budget'); fs.mkdirSync(folder);
      try {
        for (let i = 0; i < 10000; i++) fs.writeFileSync(path.join(folder, 'empty-' + i), '');
        const baseline = capture(small.root); assert.equal(verify(baseline).ok, true);
      } finally { fs.rmSync(folder, { recursive: true, force: true }); }
    });
    console.log('MEASURE SVN admin stream ' + JSON.stringify({ administrative_read_calls: calls, maximum_buffer_bytes: largest }));
  } finally {
    fs.openSync = saved.open; fs.readSync = saved.read; fs.closeSync = saved.close; fs.readFileSync = saved.readFile;
  }
}
// END SVN ADMIN STREAMING REGRESSION

// FULL guard observed paths are evidence, not permission patterns.
function observedGitPathCases(reproduceBefore = false) {
  const root = fixture(), file = path.join(root, '[id].js'); fs.writeFileSync(file, 'route original\n');
  git(root, 'add', '--', '[id].js'); git(root, 'commit', '-qm', 'dynamic route');
  if (reproduceBefore) {
    check('REPRO R2 Git tracked bracket name refuses before dispatch', () => {
      assert.equal(guard.captureBaseline({ owner: root, codeRoots: [root] }).reason, guard.REASONS.USAGE);
    }); return;
  }
  check('Git FULL observes bracket filenames in index, status and dirty content', () => {
    const baseline = capture(root); assert.equal(verify(baseline).ok, true);
    fs.writeFileSync(file, 'changed route\n'); const changed = verify(baseline);
    assert.equal(changed.reason, guard.REASONS.MUTATION); assert.ok(changed.changes.some(row => row.path === '[id].js'));
    fs.writeFileSync(file, 'route original\n');
    fs.writeFileSync(path.join(root, '[new].js'), 'new route\n'); const added = verify(baseline);
    assert.equal(added.reason, guard.REASONS.MUTATION); assert.ok(added.changes.some(row => row.path === '[new].js'));
  });
}
function svnObservedPathCases(reproduceBefore = false) {
  for (const binary of ['svn', 'svnadmin']) {
    const observed = spawnSync(binary, ['--version', '--quiet'], { encoding: 'utf8', shell: false, windowsHide: true });
    if (observed.status !== 0) { console.log('SKIP observed SVN paths: ' + binary + ' unavailable'); return; }
  }
  const folder = path.join(temporary, 'svn-observed-paths'), repository = path.join(folder, 'repository'), root = path.join(folder, 'wc');
  fs.mkdirSync(folder); const configDir = path.join(folder, 'client'); fs.mkdirSync(configDir);
  function command(binary, args, cwd = folder) {
    assert.ok(path.resolve(cwd) === path.resolve(folder) || path.resolve(cwd).startsWith(path.resolve(folder) + path.sep));
    const observed = spawnSync(binary, args, { cwd, encoding: 'utf8', shell: false, windowsHide: true });
    assert.equal(observed.status, 0, observed.stderr); return observed.stdout;
  }
  const svn = (...args) => command('svn', ['--non-interactive', '--config-dir', configDir, ...args], root);
  command('svnadmin', ['create', repository]);
  command('svn', ['--non-interactive', '--config-dir', configDir, 'checkout', require('url').pathToFileURL(repository).href, root]);
  const subdir = path.join(root, 'subdir'); fs.mkdirSync(subdir);
  fs.writeFileSync(path.join(root, 'outside.txt'), 'outside original\n'); fs.writeFileSync(path.join(subdir, 'nested.txt'), 'nested original\n');
  svn('add', 'outside.txt', 'subdir'); svn('commit', '-m', 'nested baseline'); svn('update');
  fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
  const options = { owner: root, codeRoots: [{ id: 'nested', path: subdir }] };
  if (reproduceBefore) {
    check('REPRO R1 SVN nested code root refuses before dispatch', () => {
      assert.equal(guard.captureBaseline(options).reason, guard.REASONS.UNAVAILABLE);
    });
    fs.writeFileSync(path.join(root, '[id].js'), 'dynamic route\n'); svn('add', '[id].js');
    check('REPRO R2 SVN bracket name refuses before dispatch', () => {
      assert.equal(guard.captureBaseline({ owner: root, codeRoots: [root] }).reason, guard.REASONS.USAGE);
    }); return;
  }
  check('SVN FULL nested code root retains exact content scope and observes actual WC administration', () => {
    const observed = guard.captureBaseline(options); assert.equal(observed.ok, true, JSON.stringify(observed)); const baseline = observed.baseline;
    assert.equal(path.resolve(baseline.code_roots[0].path), path.resolve(subdir));
    assert.ok(baseline.code_roots[0].entries.some(row => row.path === 'nested.txt'));
    assert.ok(!baseline.code_roots[0].entries.some(row => row.path === 'outside.txt'));
    fs.writeFileSync(path.join(root, 'outside.txt'), 'outside changed\n'); assert.equal(verify(baseline).ok, true, 'content outside nested scope is not silently claimed');
    fs.writeFileSync(path.join(subdir, 'nested.txt'), 'nested changed\n');
    const content = verify(baseline); assert.equal(content.reason, guard.REASONS.MUTATION); assert.ok(content.changes.some(row => row.path === 'nested.txt'));
    fs.writeFileSync(path.join(subdir, 'nested.txt'), 'nested original\n');
    const admin = path.join(root, '.svn', 'tmp', 'nested-admin-proof'); fs.writeFileSync(admin, 'unapproved\n');
    try { const changed = verify(baseline); assert.equal(changed.reason, guard.REASONS.MUTATION); assert.ok(changed.changes.some(row => row.kind === 'administration')); }
    finally { fs.unlinkSync(admin); }
  });
  fs.writeFileSync(path.join(subdir, '[id].js'), 'dynamic route\n'); svn('add', 'subdir/[id].js');
  check('SVN FULL accepts observed bracket filenames and detects their mutation', () => {
    const baseline = capture(root); assert.equal(verify(baseline).ok, true);
    const file = path.join(subdir, '[id].js'); fs.writeFileSync(file, 'changed dynamic route\n');
    const changed = verify(baseline); assert.equal(changed.reason, guard.REASONS.MUTATION);
    assert.ok(changed.changes.some(row => row.path === 'subdir/[id].js')); fs.writeFileSync(file, 'dynamic route\n');
    fs.writeFileSync(path.join(subdir, '[new].js'), 'new route\n'); const added = verify(baseline);
    assert.equal(added.reason, guard.REASONS.MUTATION); assert.ok(added.changes.some(row => row.path === 'subdir/[new].js'));
  });
  check('Observed path support grants no wildcard or bracket owner permission', () => {
    for (const key of ['allowAppend', 'allowPublication']) {
      assert.equal(guard.captureBaseline({ ...options, [key]: ['.gsd/[id].json'] }).reason, guard.REASONS.USAGE);
      assert.equal(guard.captureBaseline({ ...options, [key]: ['.gsd/../escape'] }).reason, guard.REASONS.USAGE);
    }
  });
  check('SVN FULL refuses a validated snapshot claiming an unrelated administrative root', () => {
    const saved = vcs.captureDirty, unrelated = path.join(folder, 'unrelated'); fs.mkdirSync(unrelated);
    vcs.captureDirty = (...args) => {
      const value = saved(...args); assert.equal(value.ok, true);
      for (const row of value.baseline.inventory) row.wc_root = fs.realpathSync.native(unrelated);
      const base = value.baseline;
      base.fingerprint = require('crypto').createHash('sha256').update(JSON.stringify({ code_dir: base.code_dir, svnversion: base.svnversion, inventory: base.inventory })).digest('hex');
      assert.equal(vcs.validateSvnStrictSnapshot(value), true, 'negative reaches physical ancestry validation, not malformed evidence'); return value;
    };
    try { assert.equal(guard.captureBaseline(options).reason, guard.REASONS.UNAVAILABLE); }
    finally { vcs.captureDirty = saved; }
  });
}
// END OBSERVED PATH REGRESSION



try {
  oldestAliasCases(fixture(), 'Git FULL #387');
  svnFullCases();
  svnAdminStreamingCases();
  observedGitPathCases();
  svnObservedPathCases();
  check('intent-to-add empty and nonempty files preserve baseline and detect later mutation', () => {
    const root = fixture();
    for (const [file, contents] of [['intent empty.txt', ''], ['intent data.txt', 'new\n']]) fs.writeFileSync(path.join(root, file), contents);
    git(root, 'add', '-N', '--', 'intent empty.txt', 'intent data.txt');
    const baseline = capture(root);
    for (const file of ['intent empty.txt', 'intent data.txt']) {
      assert.ok(baseline.code_roots[0].status.some(row => row.path === file && row.code === ' A'));
    }
    assert.equal(verify(baseline).exit_code, 0);
    fs.appendFileSync(path.join(root, 'intent empty.txt'), 'changed\n');
    const changed = verify(baseline);
    assert.equal(changed.reason, guard.REASONS.MUTATION);
    assert.equal(changed.exit_code, 3);
  });
  check('preexisting assume-unchanged skip-worktree refuse hidden tracked changes before spawn', () => {
    for (const flag of ['--assume-unchanged', '--skip-worktree']) {
      const root = fixture(); git(root, 'update-index', flag, 'tracked.txt');
      const before = guard.captureBaseline({ owner: root, codeRoots: [{ id: 'forge', path: root }] });
      fs.writeFileSync(path.join(root, 'tracked.txt'), 'hidden mutation\n');
      if (before.ok) {
        const observed = verify(before.baseline);
        console.log(`REPRO S03/T06 preexisting ${flag}: capture=${before.exit_code}; verify=${observed.exit_code}`);
      }
      assert.equal(before.exit_code, 4, 'preexisting index visibility flags must refuse capture');
      assert.equal(before.reason, guard.REASONS.UNAVAILABLE);
      assert.equal(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'hidden mutation\n');
    }
  });
  check('exports CLI permissions exact paths and immutable capture options', () => {
    for (const name of ['captureBaseline', 'verifyBaseline']) assert.equal(typeof guard[name], 'function');
    assert.equal(typeof guard.REASONS, 'object');
    const root = fixture();
    for (const value of ['/absolute', 'C:/absolute', '.gsd/../file', '.gsd/*', '.gsd/[x]', 'outside', '.gsd/', '.gsd/./file']) {
      for (const flag of ['--allow-append', '--allow-publication']) {
        const output = cli(['--capture', '--owner', root, '--code-root', root, flag, value, '--out', path.join(temporary, 'invalid.json')]);
        assert.equal(output.status, 2, output.stdout + output.stderr);
      }
    }
    const values = ['.gsd/forge/events.jsonl'];
    const baseline = capture(root, { allowAppend: values }); values.push('.gsd/control.json');
    assert.deepEqual(baseline.permissions.allow_append, ['.gsd/forge/events.jsonl']);
    assert.equal(cli(['--capture', '--owner', root, '--out', path.join(temporary, 'missing-root.json')]).status, 2);
    assert.equal(cli(['--capture', '--owner', root, '--code-root', root, '--mode', 'other', '--out', path.join(temporary, 'bad-mode.json')]).status, 2);
  });
  check('external output physical containment case aliases exclusive wx and CLI exit0', () => {
    const root = fixture(), outside = path.join(temporary, 'baseline.json');
    const args = ['--capture', '--owner', root, '--code-root', root, '--out'];
    for (const target of [path.join(root, 'bad.json'), path.join(root, '.gsd', 'bad.json')]) assert.equal(cli([...args, target]).status, 2);
    if (process.platform === 'win32') assert.equal(cli([...args, path.join(root.toUpperCase(), 'bad.json')]).status, 2);
    const alias = path.join(temporary, 'alias'); fs.symlinkSync(root, alias, 'junction');
    assert.equal(cli([...args, path.join(alias, 'bad.json')]).status, 2);
    let output = cli([...args, outside]); assert.equal(output.status, 0, output.stdout + output.stderr);
    const bytes = fs.readFileSync(outside); output = cli([...args, outside]); assert.equal(output.status, 2);
    assert.deepEqual(fs.readFileSync(outside), bytes);
    output = cli(['--verify', outside, '--writer-stopped']); assert.equal(output.status, 0, output.stdout + output.stderr);
    assert.equal(JSON.parse(output.stdout).ok, true);
    output = cli(['--verify', outside]); assert.equal(output.status, 4); assert.equal(JSON.parse(output.stdout).reason, guard.REASONS.UNRECONCILED);
    console.log('EXAMPLE S03/T06 unchanged: exit0; writer-stopped é atestado do chamador, não prova de processo');
  });
  check('baseline VCS porcelain index dirty hashes protectedSnapshot digests and no file content', () => {
    const root = fixture(); fs.writeFileSync(path.join(root, 'tracked.txt'), 'PRIVATE_FILE_CONTENT\n');
    fs.writeFileSync(path.join(root, 'new.txt'), 'PRIVATE_NEW_CONTENT\n');
    const before = capture(root, { allowAppend: ['.gsd/forge/events.jsonl'] });
    assert.equal(before.code_roots[0].head, vcs.baselineId(root).id);
    assert.deepEqual(before.owner_snapshot, execution.protectedSnapshot(root));
    assert.ok(before.code_roots[0].status.some(row => row.code === ' M'));
    assert.ok(before.code_roots[0].status.some(row => row.code === '??'));
    assert.equal(before.code_roots[0].dirty.length, 2);
    for (const field of ['refs', 'stash', 'config', 'hooks', 'index']) assert.match(before.code_roots[0][field], /^[a-f0-9]{64}$/);
    assert.ok(before.appends[0].size > 0); assert.match(before.appends[0].sha256, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(before).includes('PRIVATE_'));
    assert.equal(verify(before).exit_code, 0);
  });
  check('tracked modified deleted new file HEAD branch tag stash config hooks and index mutations', () => {
    const cases = [
      ['modified', r => fs.writeFileSync(path.join(r, 'tracked.txt'), 'changed\n')],
      ['deleted', r => fs.unlinkSync(path.join(r, 'tracked.txt'))],
      ['added', r => fs.writeFileSync(path.join(r, 'new.txt'), 'new\n')],
      ['head', r => { fs.writeFileSync(path.join(r, 'tracked.txt'), 'committed\n'); git(r, 'add', '.'); git(r, 'commit', '-qm', 'next'); }],
      ['ref', r => git(r, 'branch', 'new-branch')], ['ref', r => git(r, 'tag', 'new-tag')],
      ['stash', r => { fs.writeFileSync(path.join(r, 'tracked.txt'), 'stashed\n'); git(r, 'stash', 'push', '-qm', 'new-stash'); }],
      ['config', r => git(r, 'config', 'fixture.changed', 'yes')],
      ['hooks', r => fs.writeFileSync(path.join(r, '.git', 'hooks', 'pre-commit'), '# fixture\n')],
    ];
    for (const [kind, action] of cases) mutation(fixture(), action, kind);
    const root = fixture(); fs.writeFileSync(path.join(root, 'tracked.txt'), 'dirty\n');
    mutation(root, r => git(r, 'add', 'tracked.txt'), 'index');
    const both = fixture(); fs.writeFileSync(path.join(both, 'tracked.txt'), 'staged\n'); git(both, 'add', 'tracked.txt');
    fs.writeFileSync(path.join(both, 'tracked.txt'), 'working\n');
    mutation(both, r => { fs.writeFileSync(path.join(r, 'tracked.txt'), 'new-stage\n'); git(r, 'add', 'tracked.txt'); fs.writeFileSync(path.join(r, 'tracked.txt'), 'working\n'); }, 'index');
    mutation(fixture(), r => git(r, 'update-index', '--assume-unchanged', 'tracked.txt'), 'index');
    const branch = fixture(); git(branch, 'branch', 'same-head');
    mutation(branch, r => git(r, 'checkout', '-q', 'same-head'), 'head');
    const hooks = fixture(), custom = path.join(hooks, 'custom-hooks'); fs.mkdirSync(custom); git(hooks, 'config', 'core.hooksPath', 'custom-hooks');
    mutation(hooks, () => fs.writeFileSync(path.join(custom, 'pre-commit'), 'hook\n'), 'hooks');
    console.log('EXAMPLE S03/T06 mutation: exit3; native-readonly-mutation-detected; relative path and kind only');
  });
  check('owner control create modify delete append rewrite truncate and bounded100 changes', () => {
    for (const action of [r => fs.writeFileSync(path.join(r, '.gsd', 'new'), 'new'), r => fs.writeFileSync(path.join(r, '.gsd', 'control.json'), '{}'), r => fs.unlinkSync(path.join(r, '.gsd', 'control.json'))]) mutation(fixture(), action, 'owner-control');
    const options = { allowAppend: ['.gsd/forge/events.jsonl'] };
    for (const value of ['rewritten prefix\n', '']) mutation(fixture(), r => fs.writeFileSync(path.join(r, '.gsd', 'forge', 'events.jsonl'), value), 'append-rewrite', options);
    const result = mutation(fixture(), r => { for (let i = 0; i < 105; i++) fs.writeFileSync(path.join(r, `.gsd/new-${i}`), 'private'); }, 'owner-control');
    assert.equal(result.changes.length, 100); assert.equal(result.truncated, true);
    assert.ok(!JSON.stringify(result).includes('private'));
  });
  check('genuine event append exact publication and unpermitted append detection', () => {
    const root = fixture(), file = path.join(root, '.gsd', 'forge', 'events.jsonl');
    const before = capture(root, { allowAppend: ['.gsd/forge/events.jsonl'], allowPublication: ['.gsd/defense.md'] });
    const denied = capture(root);
    assert.equal(dispatchEvent.main(['--events', file, '--unit', 'review/S03', '--route-json', JSON.stringify({
      engine: 'codex', model: 'fixture-model', effort: 'high', host_runtime: 'codex', resolved_worker_engine: 'codex',
      worker_mode: 'native', dispatch_allowed: true, dispatch_reason_code: 'fixture', dispatch_posture: 'native', dispatch_decision: 'allowed',
    })], { stdout: { write() {} }, stderr: { write(text) { throw new Error(text); } } }), 0);
    fs.writeFileSync(path.join(root, '.gsd', 'defense.md'), 'PRIVATE_DEFENSE');
    const result = verify(before); assert.equal(result.exit_code, 0, JSON.stringify(result));
    assert.equal(result.appended[0].path, '.gsd/forge/events.jsonl');
    assert.equal(result.allowed_publications[0].path, '.gsd/defense.md');
    assert.equal(verify(denied).exit_code, 3);
    console.log('EXAMPLE S03/T06 allowed: exact event append and defense publication; no baseline recapture');
  });
  check('genuine own lease heartbeat validRecord owner generation exact clock transitions', () => {
    const root = fixture(), unit = 'review/S03';
    const acquired = lease.acquire(root, unit, { now: 1000, ttlMs: 10000 }); assert.equal(acquired.ok, true);
    const before = capture(root, { ownLease: unit }), denied = capture(root);
    assert.equal(lease.heartbeat(root, unit, acquired.owner_token, acquired.generation, { now: 2000, ttlMs: 10000 }).ok, true);
    const result = verify(before); assert.equal(result.exit_code, 0, JSON.stringify(result));
    assert.equal(result.owner_transitions[0].kind, 'lease-heartbeat'); assert.equal(verify(denied).exit_code, 3);
    assert.ok(!JSON.stringify(before).includes(acquired.owner_token));
    for (const patch of [{ generation: 'foreign' }, { owner_token: 'foreign' }, { heartbeat_at: 1 }, { grace_ms: 7 }, { protocol_version: 99 }]) {
      const baseline = capture(root, { ownLease: unit }); const target = lease.leaseFile(root, unit); const original = fs.readFileSync(target);
      fs.writeFileSync(target, JSON.stringify({ ...JSON.parse(original), ...patch })); assert.equal(verify(baseline).exit_code, 3); fs.writeFileSync(target, original);
    }
    console.log('EXAMPLE S03/T06 own transition: lease-heartbeat allowed only with exact own-lease');
  });
  check('genuine own run heartbeat foreign heartbeat alias and nonclock mutations', () => {
    const root = fixture();
    runs.add(root, { id: 'foreign', kind: 'milestone', session_id: 'fixture', started_at: 100, last_heartbeat: 100, write_claim: null });
    runs.add(root, { id: 'own', kind: 'milestone', session_id: 'fixture', started_at: 200, last_heartbeat: 200, write_claim: null });
    const before = capture(root, { ownRun: 'own' }), denied = capture(root);
    runs.bumpHeartbeat(root, 'own', 300);
    const result = verify(before); assert.equal(result.exit_code, 0, JSON.stringify(result));
    assert.equal(result.owner_transitions[0].kind, 'run-heartbeat'); assert.equal(verify(denied).exit_code, 3);
    mutation(root, r => runs.bumpHeartbeat(r, 'foreign', 400), 'owner-control', { ownRun: 'own' });
    mutation(root, r => runs.update(r, 'own', { active: false }), 'owner-control', { ownRun: 'own' });
  });
  check('code-only ignores owner but preserves all code roots refs stash config hooks and index', () => {
    const root = fixture(); const before = capture(root, { mode: 'code-only' });
    fs.writeFileSync(path.join(root, '.gsd', 'control.json'), 'ignored in this mode');
    assert.equal(verify(before).exit_code, 0); assert.equal(before.owner_snapshot, null);
    for (const [kind, action] of [['ref', r => git(r, 'tag', 'tag')], ['config', r => git(r, 'config', 'fixture.other', 'yes')], ['hooks', r => fs.writeFileSync(path.join(r, '.git', 'hooks', 'pre-commit'), 'x')], ['modified', r => fs.writeFileSync(path.join(r, 'tracked.txt'), 'x')]]) mutation(fixture(), action, kind, { mode: 'code-only' });
    const second = fixture(), baseline = capture(root, { mode: 'code-only', codeRoots: [{ id: 'forge', path: root }, { id: 'other', path: second }] });
    fs.writeFileSync(path.join(second, 'tracked.txt'), 'other root mutation');
    assert.ok(verify(baseline).changes.some(row => row.root === 'other'));
  });
  check('fail closed writer unavailable unexpected porcelain unstable links entry and byte limits', () => {
    const root = fixture(), baseline = capture(root);
    assert.equal(guard.verifyBaseline(baseline).reason, guard.REASONS.UNRECONCILED);
    assert.equal(guard.verifyBaseline(baseline).exit_code, 4);
    const original = vcs.workingStatus;
    try { vcs.workingStatus = () => ({ ok: false, error: 'git-status-unhandled:T ' }); assert.equal(verify(baseline).reason, guard.REASONS.UNAVAILABLE); }
    finally { vcs.workingStatus = original; }
    const snapshot = execution.protectedSnapshot;
    try { let n = 0; execution.protectedSnapshot = r => { const value = snapshot(r); fs.writeFileSync(path.join(r, '.gsd', 'control.json'), String(++n)); return value; }; assert.equal(verify(baseline).reason, guard.REASONS.UNAVAILABLE); }
    finally { execution.protectedSnapshot = snapshot; }
    const linked = fixture(); fs.symlinkSync(path.join(linked, '.gsd', 'forge'), path.join(linked, '.gsd', 'link'), 'junction');
    assert.equal(guard.captureBaseline({ owner: linked, codeRoots: [linked] }).reason, guard.REASONS.UNAVAILABLE);
    const hookRoot = fixture(); fs.symlinkSync(path.join(hookRoot, '.gsd'), path.join(hookRoot, '.git', 'hooks', 'linked'), 'junction');
    assert.equal(guard.captureBaseline({ owner: hookRoot, codeRoots: [hookRoot] }).reason, guard.REASONS.UNAVAILABLE);
    const missing = path.join(temporary, 'no-vcs'); fs.mkdirSync(missing);
    assert.equal(guard.captureBaseline({ owner: missing, codeRoots: [missing] }).reason, guard.REASONS.UNAVAILABLE);
    const oversized = fixture(); fs.writeFileSync(path.join(oversized, '.git', 'hooks', 'huge'), Buffer.alloc(1024 * 1024 + 1));
    assert.equal(guard.captureBaseline({ owner: oversized, codeRoots: [oversized] }).reason, guard.REASONS.UNAVAILABLE);
    const many = fixture(); for (let i = 0; i < 20001; i++) fs.writeFileSync(path.join(many, '.gsd', `entry-${i}`), '');
    assert.equal(guard.captureBaseline({ owner: many, codeRoots: [many] }).reason, guard.REASONS.UNAVAILABLE);
    console.log('EXAMPLE S03/T06 unreconciled: exit4; native-readonly-writer-unreconciled; no process proof');
  });
  check('pt-BR detection limits no sandbox ignored outside reverted network concurrent writers no repair', () => {
    const root = fixture(), before = capture(root);
    fs.mkdirSync(path.join(root, 'ignored')); fs.writeFileSync(path.join(root, 'ignored', 'file'), 'outside coverage');
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'transient'); fs.writeFileSync(path.join(root, 'tracked.txt'), 'original\n');
    const result = verify(before); assert.equal(result.exit_code, 0);
    for (const term of ['sandbox do SO', 'ignorados', 'fora das raízes', 'revertida', 'rede', 'concorrentes', 'atestado do chamador']) assert.ok(JSON.stringify(result).includes(term), term);
    assert.equal(fs.readFileSync(path.join(root, 'ignored', 'file'), 'utf8'), 'outside coverage');
    assert.equal(verify(before).exit_code, 0, 'same original baseline is reusable without recapture');
  });
  check('review native legs full guard exact permissions terminal reconciliation and unchanged248 audit', () => {
    const review = fs.readFileSync(path.join(__dirname, '..', 'shared', 'forge-review.md'), 'utf8');
    const start = review.indexOf('Nas pernas nativas somente leitura no host Codex');
    const end = review.indexOf('### Resolução de pairing', start); assert.ok(start > 0 && end > start);
    const inserted = review.slice(start, end);
    for (const term of ['challenge', 'defense', 'rebuttal', '--mode full', '--allow-append .gsd/forge/events.jsonl', '--allow-publication', 'DEFENSE_FILE', '--own-lease', '--own-run', '--writer-stopped', 'saída 3 ou 4', 'REVIEW', 'review-fix', 'reconciliação', 'Claude', 'opcional']) assert.ok(inserted.includes(term), term);
    assert.ok(!inserted.split('\n').some(line => /^(#|\*\*)/.test(line)));
    const sourceGuard = require('./forge-dispatch-source-guard');
    const historicalRegistry = require('./fixtures/owner-recovery/distribution.cjs').previousRegistry(sourceGuard.SOURCE_REGISTRY);
    assert.equal(historicalRegistry.length, 248, 'exact historical inventory remains preserved');
    assert.deepEqual(sourceGuard.audit(), { ok: true, root: path.resolve(__dirname, '..'), discovered_count: 254, registered_count: 254, unexpected: [], missing: [], errors: [] });
  });
  check('permissions document G2-1 modes exact allowances limits review and renderer anchors', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'codex-agent-permissions.md'), 'utf8');
    for (const term of ['forge-native-readonly-guard.js', 'code-only', 'full', '--allow-append', '--allow-publication', '--own-lease', '--own-run', '--writer-stopped', 'ignorados', 'revertida', 'concorrentes', 'rede', 'forge-review.md', 'forge-native-invocation.js', 'forge-xllm.js', 'forge-headless.js', 'forge-dispatch-policy.js', 'G2', 'Nenhum escape de sandbox foi demonstrado', 'allowlists', 'permission mode']) assert.ok(doc.includes(term), term);
  });
  check('directed links actual protectedSnapshot VCS lease validation code-roots containment and CLI', () => {
    const root = fixture(); let protectedCalls = 0, dirtyCalls = 0, statusCalls = 0, headCalls = 0, validCalls = 0;
    const originals = { snapshot: execution.protectedSnapshot, dirty: vcs.captureDirty, status: vcs.workingStatus, head: vcs.baselineId, valid: lease.validRecord };
    const own = lease.acquire(root, 'review/link', { now: 1000, ttlMs: 10000 });
    try {
      execution.protectedSnapshot = (...args) => { protectedCalls++; return originals.snapshot(...args); };
      vcs.captureDirty = (...args) => { dirtyCalls++; return originals.dirty(...args); };
      vcs.workingStatus = (...args) => { statusCalls++; return originals.status(...args); };
      vcs.baselineId = (...args) => { headCalls++; return originals.head(...args); };
      lease.validRecord = (...args) => { validCalls++; return originals.valid(...args); };
      const baseline = capture(root, { ownLease: 'review/link' });
      lease.heartbeat(root, 'review/link', own.owner_token, own.generation, { now: 2000, ttlMs: 10000 });
      assert.equal(verify(baseline).exit_code, 0);
      for (const count of [protectedCalls, dirtyCalls, statusCalls, headCalls, validCalls]) assert.ok(count >= 2);
    } finally { execution.protectedSnapshot = originals.snapshot; vcs.captureDirty = originals.dirty; vcs.workingStatus = originals.status; vcs.baselineId = originals.head; lease.validRecord = originals.valid; }
    const roots = require('./forge-code-roots'), old = roots.key; let calls = 0;
    try { roots.key = value => { calls++; return old(value); }; assert.equal(cli(['--capture']).status, 2); const output = guard.captureBaseline({ owner: root, codeRoots: [root], out: path.join(root, 'denied.json') }); assert.equal(output.exit_code, 2); assert.ok(calls > 0); }
    finally { roots.key = old; }
  });
} finally {
  assert.ok(path.resolve(temporary).startsWith(path.resolve(fs.realpathSync.native(os.tmpdir())) + path.sep));
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3 });
}
