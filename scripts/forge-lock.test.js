#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const lock = require('./forge-lock.js');

function temporary() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge lock espaço-測試-'));
  fs.mkdirSync(path.join(cwd, '.gsd'), { recursive: true });
  return cwd;
}
function remove(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
function child(cwd, name, barrier) {
  const source = [
    "const l=require(process.argv[1]);",
    "const fs=require('fs');",
    "const cwd=process.argv[2],name=process.argv[3],barrier=process.argv[4];",
    "while(!fs.existsSync(barrier)){}",
    "const h=l.tryAcquireSync(cwd,name,{ttlMs:5000});",
    "process.stdout.write(JSON.stringify({won:!!h,token:h&&h.ownerToken}));",
    "if(h)setTimeout(()=>h.release(),80);"
  ].join('');
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['-e', source, path.join(__dirname, 'forge-lock.js'), cwd, name, barrier], { shell: false });
    let output = ''; let error = '';
    proc.stdout.on('data', data => { output += data; });
    proc.stderr.on('data', data => { error += data; });
    proc.on('error', reject);
    proc.on('exit', code => resolve({ code, output, error }));
  });
}
async function testExactOneWinner() {
  const cwd = temporary(); const barrier = path.join(cwd, 'go');
  try {
    const attempts = [child(cwd, 'cross-platform', barrier), child(cwd, 'cross-platform', barrier)];
    fs.writeFileSync(barrier, 'go');
    const results = await Promise.all(attempts);
    assert.deepStrictEqual(results.map(result => result.code), [0, 0]);
    const winners = results.map(result => JSON.parse(result.output)).filter(result => result.won);
    assert.strictEqual(winners.length, 1, `expected one winner: ${JSON.stringify(results)}`);
  } finally { remove(cwd); }
}
function testOwnerScopedRenewalAndRelease() {
  const cwd = temporary();
  try {
    const first = lock.tryAcquireSync(cwd, 'owner', { ttlMs: 5_000 });
    assert(first);
    const fake = { lockDir: first.lockDir, ownerToken: 'not-the-owner', generation: first.generation };
    assert.deepStrictEqual(lock.renewHandle(fake), { ok: false, reason: 'owner_mismatch' });
    assert.deepStrictEqual(lock.releaseHandle(fake), { ok: false, reason: 'owner_mismatch' });
    assert.strictEqual(lock.releaseSync(cwd, 'owner'), false, 'legacy release cannot prove ownership');
    assert.strictEqual(first.renew().ok, true);
    assert.strictEqual(first.release().ok, true);
    assert.deepStrictEqual(first.release(), { ok: false, reason: 'owner_mismatch' });
  } finally { remove(cwd); }
}
function testStaleRecoveryAndABA() {
  const cwd = temporary();
  try {
    const old = lock.tryAcquireSync(cwd, 'aba', { ttlMs: 10, now: () => 10, tokenFactory: (() => { let n = 0; return () => `token${++n}`; })() });
    assert(old);
    const successor = lock.tryAcquireSync(cwd, 'aba', { ttlMs: 10, now: () => 100 });
    assert(successor, 'expired generation is quarantined then reacquired');
    assert.notStrictEqual(successor.generation, old.generation);
    assert.deepStrictEqual(old.release(), { ok: false, reason: 'owner_mismatch' }, 'old callback cannot unlink new generation');
    assert.strictEqual(lock.status(cwd, 'aba').metadata.generation, successor.generation);
    assert.strictEqual(successor.release().ok, true);
  } finally { remove(cwd); }
}
function testCrashBeforeMetadataIsRecoverable() {
  const cwd = temporary();
  try {
    const dir = lock.lockPath(cwd, 'crash'); fs.mkdirSync(dir, { recursive: true });
    const stale = new Date(0); fs.utimesSync(dir, stale, stale);
    const acquired = lock.tryAcquireSync(cwd, 'crash', { ttlMs: 10, now: () => 100 });
    assert(acquired);
    assert.strictEqual(acquired.release().ok, true);
  } finally { remove(cwd); }
}

function testExplicitBootstrapRecoveryAfterActualCrash() {
  const cwd = temporary();
  try {
    const dir = lock.lockPath(cwd, 'bootstrap');
    const result = spawnSync(process.execPath, ['-e', `
      const fs = require('fs'), lock = require(process.argv[1]), mkdir = fs.mkdirSync;
      const target = lock.lockPath(process.argv[2], 'bootstrap');
      fs.mkdirSync = function(file, ...args) {
        const value = mkdir.call(fs, file, ...args);
        if (file === target) process.exit(73);
        return value;
      };
      lock.acquireSync(process.argv[2], 'bootstrap', {allowStaleRecovery:false});
    `, require.resolve('./forge-lock'), cwd], { encoding: 'utf8', timeout: 5000 });
    assert.strictEqual(result.status, 73, result.stderr);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
    assert.strictEqual(lock.tryAcquireSync(cwd, 'bootstrap', { ttlMs: 1, now: () => Date.now() + 86400000, allowStaleRecovery: false }), null);
    assert.strictEqual(lock.recoverIncompleteLock(cwd, 'bootstrap').reason, 'recovery_requires_stopped_writers');
    const recovery = lock.recoverIncompleteLock(cwd, 'bootstrap', { confirmStopped: true });
    assert.strictEqual(recovery.ok, true);
    assert.deepStrictEqual(fs.readdirSync(recovery.evidence), []);
    const owner = lock.tryAcquireSync(cwd, 'bootstrap', { allowStaleRecovery: false });
    assert(owner);
    assert.strictEqual(lock.recoverIncompleteLock(cwd, 'bootstrap', { confirmStopped: true }).reason, 'guard_metadata_present');
    assert.strictEqual(owner.release().ok, true);
  } finally { remove(cwd); }
}

function testReleaseFailureIsExplicitAndEvidenceIsRecoverable() {
  const cwd = temporary();
  const unlink = fs.unlinkSync;
  try {
    const owner = lock.tryAcquireSync(cwd, 'release-failure', { allowStaleRecovery: false });
    const metadata = fs.readFileSync(lock.metaPath(owner.lockDir));
    fs.unlinkSync = function(file, ...args) {
      if (file === lock.metaPath(owner.lockDir)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return unlink.call(fs, file, ...args);
    };
    assert.deepStrictEqual(owner.release(), { ok: false, reason: 'release_failed', errno: 'EACCES' });
    fs.unlinkSync = unlink;
    assert.strictEqual(lock.tryAcquireSync(cwd, 'release-failure', { allowStaleRecovery: false }), null);
    assert.strictEqual(lock.recoverIncompleteLock(cwd, 'release-failure').ok, false);
    const recovered = lock.recoverIncompleteLock(cwd, 'release-failure', { confirmStopped: true });
    assert.strictEqual(recovered.reason, 'guard_release_recovered');
    assert.deepStrictEqual(fs.readFileSync(lock.metaPath(recovered.evidence)), metadata);
    assert(fs.existsSync(path.join(recovered.evidence, `owner-${owner.ownerToken}.released`)));
    const next = lock.tryAcquireSync(cwd, 'release-failure', { allowStaleRecovery: false });
    assert(next);
    assert.strictEqual(owner.release().ok, false, 'old token cannot release successor');
    const marker = path.join(next.lockDir, `owner-${next.ownerToken}`);
    const unrelated = path.join(next.lockDir, 'owner-unrelated.released');
    fs.renameSync(marker, unrelated);
    assert.strictEqual(lock.recoverIncompleteLock(cwd, 'release-failure', { confirmStopped: true }).reason,
      'guard_metadata_present', 'a different released token cannot prove this owner released');
    fs.renameSync(unrelated, marker);
    assert.strictEqual(next.release().ok, true);
  } finally { fs.unlinkSync = unlink; remove(cwd); }
}

async function testLiveInitializingWriterIsNeverAutomaticallyRecovered() {
  const cwd = temporary();
  const barrier = path.join(cwd, 'finish-initializing');
  const proc = spawn(process.execPath, ['-e', `
    const fs = require('fs'), lock = require(process.argv[1]), mkdir = fs.mkdirSync;
    const target = lock.lockPath(process.argv[2], 'initializing');
    fs.mkdirSync = function(file, ...args) {
      const result = mkdir.call(fs, file, ...args);
      if (file === target) {
        process.stdout.write('initializing');
        const sleeper = new Int32Array(new SharedArrayBuffer(4)), deadline = Date.now() + 5000;
        while (!fs.existsSync(process.argv[3])) {
          if (Date.now() >= deadline) process.exit(74);
          Atomics.wait(sleeper, 0, 0, 10);
        }
      }
      return result;
    };
    const owner = lock.acquireSync(process.argv[2], 'initializing', {allowStaleRecovery:false});
    if (!owner.release().ok) process.exit(75);
  `, require.resolve('./forge-lock'), cwd, barrier], { stdio: ['ignore', 'pipe', 'pipe'] });
  const completion = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('exit', code => resolve(code));
  });
  try {
    await new Promise((resolve, reject) => {
      proc.stdout.once('data', resolve);
      proc.once('error', reject);
      proc.once('exit', () => reject(new Error('initializer exited before barrier')));
    });
    const dir = lock.lockPath(cwd, 'initializing');
    assert.deepStrictEqual(fs.readdirSync(dir), []);
    assert.strictEqual(lock.tryAcquireSync(cwd, 'initializing', { ttlMs: 1, now: () => Date.now() + 86400000, allowStaleRecovery: false }), null);
    assert.strictEqual(lock.recoverIncompleteLock(cwd, 'initializing').ok, false);
    assert.deepStrictEqual(fs.readdirSync(dir), [], 'active initializer is untouched');
    fs.writeFileSync(barrier, 'continue');
    assert.strictEqual(await completion, 0);
    assert.strictEqual(lock.status(cwd, 'initializing').held, false);
  } finally { proc.kill(); await completion; remove(cwd); }
}
function testInitialWindowsMkdirRetry() {
  const source = fs.readFileSync(require.resolve('./forge-lock.js'), 'utf8');
  function fixture(label, { platform = 'win32', code = 'EPERM', phase = 'initial', failures = Infinity, retries = 3, budget = null, held = false } = {}) {
    const cwd = temporary(), name = `mkdir-${label}`, target = lock.lockPath(cwd, name);
    const original = Object.assign(new Error(`injected ${phase} failure`), { code, syscall: phase === 'initial' ? 'mkdir' : 'write', path: target });
    const originalStack = original.stack;
    let attempts = 0, waits = 0, clock = 1000, uuid = 0, probes = 0;
    const fakeFs = Object.create(fs);
    fakeFs.mkdirSync = function(file, ...args) {
      if (file === target) {
        attempts++;
        if (phase === 'initial' && attempts <= failures) throw original;
      }
      if (phase === 'owner' && path.dirname(file) === target && path.basename(file).startsWith('owner-')) throw original;
      return fs.mkdirSync(file, ...args);
    };
    fakeFs.writeFileSync = function(file, ...args) {
      if (phase === 'metadata' && path.dirname(file) === target && path.basename(file).startsWith('metadata.json.')) throw original;
      return fs.writeFileSync(file, ...args);
    };
    const module = {}, request = { retries, backoffMin: 1, backoffMax: 1 };
    if (budget) request.acquisitionBudget = { remaining_attempts: budget, deadline_ms: clock + 100 };
    const context = {
      module, exports: module.exports = {}, console,
      require(name) {
        if (name === 'fs') return fakeFs;
        if (name === 'path') return path;
        if (name === 'crypto') return { randomUUID: () => `fixture-${++uuid}` };
        throw Error('unexpected lock dependency');
      },
      process: { platform, pid: 424242, kill(pid, signal) { probes++; assert.strictEqual(signal, 0); } },
      Date: { now: () => clock },
      Atomics: { wait(array, index, expected, ms) { waits++; clock += ms; } },
    };
    const holder = held ? lock.tryAcquireSync(cwd, name, { allowStaleRecovery: false }) : null;
    try {
      require('vm').runInNewContext(source, context, { filename: require.resolve('./forge-lock.js') });
      let handle = null, error = null;
      try { handle = module.exports.acquireProcessSync(cwd, name, request); } catch (caught) { error = caught; }
      assert.strictEqual(original.stack, originalStack, 'original syscall diagnostic was not rewritten');
      assert.strictEqual(original.code, code); assert.strictEqual(original.path, target);
      if (handle) {
        assert.strictEqual(error, null); assert.strictEqual(module.exports.assertOwned(handle), true);
        assert.strictEqual(handle.release().ok, true);
      }
      return { error, original, attempts, waits, probes, remaining: request.acquisitionBudget?.remaining_attempts, acquired: !!handle };
    } finally { holder?.release(); remove(cwd); }
  }
  const transient = fixture('transient', { failures: 1 });
  assert.strictEqual(transient.acquired, true); assert.strictEqual(transient.attempts, 2);
  assert.strictEqual(transient.waits, 1); assert.strictEqual(transient.probes, 0);
  const persistent = fixture('persistent', { retries: 10, budget: 2 });
  assert.strictEqual(persistent.error, persistent.original, 'exhaustion rethrows the exact original Error');
  assert.strictEqual(persistent.attempts, 2); assert.strictEqual(persistent.waits, 1);
  assert.strictEqual(persistent.remaining, 0); assert.strictEqual(persistent.probes, 0);
  for (const phase of ['owner', 'metadata']) {
    const later = fixture(phase, { phase });
    assert.strictEqual(later.error, later.original); assert.strictEqual(later.attempts, 1);
    assert.strictEqual(later.waits, 0); assert.strictEqual(later.probes, 0);
  }
  for (const opts of [{ platform: 'linux' }, { platform: 'darwin' }, { code: 'EACCES' }]) {
    const unchanged = fixture(`unchanged-${opts.platform || opts.code}`, opts);
    assert.strictEqual(unchanged.error, unchanged.original); assert.strictEqual(unchanged.attempts, 1);
    assert.strictEqual(unchanged.waits, 0);
  }
  const busy = fixture('later-busy', { failures: 1, retries: 2, held: true });
  assert.strictEqual(busy.error.code, 'LOCK_BUSY', 'later genuine contention clears earlier EPERM');
  assert.notStrictEqual(busy.error, busy.original); assert.strictEqual(busy.attempts, 2);
  assert.strictEqual(busy.probes, 1);
}

async function main() {
  console.log(`forge-lock tests on ${process.platform}`);
  testInitialWindowsMkdirRetry();
  const processRoot = temporary();
  try {
    const held = lock.acquireProcessSync(processRoot, 'process-owner', { ttlMs: 1 });
    const bytes = fs.readFileSync(lock.metaPath(held.lockDir));
    assert.throws(() => lock.acquireProcessSync(processRoot, 'process-owner', { retries: 1, now: () => Date.now() + 86400000 }), error => error.code === 'LOCK_BUSY');
    const originalKill = process.kill;
    try {
      process.kill = () => { throw Object.assign(Error('inaccessible'), { code: 'EPERM' }); };
      assert.throws(() => lock.acquireProcessSync(processRoot, 'process-owner', { retries: 1 }), error => error.code === 'LOCK_BUSY');
    } finally { process.kill = originalKill; }
    assert.deepStrictEqual(fs.readFileSync(lock.metaPath(held.lockDir)), bytes);
    assert(held.release().ok);
  } finally { remove(processRoot); }
  testOwnerScopedRenewalAndRelease();
  testStaleRecoveryAndABA();
  testCrashBeforeMetadataIsRecoverable();
  testExplicitBootstrapRecoveryAfterActualCrash();
  testReleaseFailureIsExplicitAndEvidenceIsRecoverable();
  await testLiveInitializingWriterIsNeverAutomaticallyRecovered();
  await testExactOneWinner();
  console.log('forge-lock tests passed');
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
