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
async function main() {
  console.log(`forge-lock tests on ${process.platform}`);
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
