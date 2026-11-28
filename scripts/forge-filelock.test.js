#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const filelock = require('./forge-filelock.js');
const legacy = require('./fixtures/filelock-v1/forge-filelock.js');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function temporary() { return fs.mkdtempSync(path.join(os.tmpdir(), 'forge file lock espaço-測試-')); }
function remove(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function testOwnerScopedLifecycle() {
  const cwd = temporary(); const target = 'dir com espaço/測試.json';
  try {
    const owner = filelock.acquireFileLock(cwd, target, 'run-a', 'session-a', { ttlMs: 5000 });
    assert(owner.acquired && owner.owner_token);
    assert.strictEqual(filelock.releaseFileLock(cwd, target, 'run-a'), false, 'run ID alone is diagnostic, not ownership');
    assert.deepStrictEqual(filelock.renewFileLock(cwd, target, 'wrong', owner.generation), { ok: false, reason: 'owner_mismatch' });
    const renewed = filelock.renewFileLock(cwd, target, owner.owner_token, owner.generation);
    assert.strictEqual(renewed.ok, true);
    assert.strictEqual(filelock.releaseFileLock(cwd, target, 'run-a', owner.owner_token, owner.generation), true);
    assert.strictEqual(filelock.checkFileLock(cwd, target).held, false);
  } finally { remove(cwd); }
}
function testNonOwnerAndABA() {
  const cwd = temporary(); const target = 'same.json';
  try {
    const one = filelock.acquireFileLock(cwd, target, 'one', 's', { ttlMs: 10, now: () => 10 });
    const two = filelock.acquireFileLock(cwd, target, 'two', 's', { ttlMs: 10, now: () => 100 });
    assert(two.acquired && two.stolen);
    assert.strictEqual(filelock.releaseFileLock(cwd, target, 'one', one.owner_token, one.generation), false);
    const publicCheck = filelock.checkFileLock(cwd, target);
    assert.strictEqual(publicCheck.holder.generation, undefined, 'status must not disclose generation');
    assert.strictEqual(publicCheck.holder.owner_token, undefined, 'status must not disclose owner token');
    const privateCheck = filelock.checkFileLock(cwd, target, { ownerToken: two.owner_token, generation: two.generation });
    assert.strictEqual(privateCheck.holder.generation, two.generation, 'owner-scoped proof remains available to the holder');
    assert.strictEqual(filelock.releaseFileLock(cwd, target, 'two', two.owner_token, two.generation), true);
  } finally { remove(cwd); }
}
function testCanonicalPathIdentity() {
  const cwd = temporary();
  try {
    const first = filelock.acquireFileLock(cwd, './src/foo.js', 'run-a', 's-a');
    const denied = filelock.acquireFileLock(cwd, 'src\\foo.js', 'run-b', 's-b');
    assert.strictEqual(denied.acquired, false, 'separator aliases must share one lock');
    assert.strictEqual(filelock.releaseFileLock(cwd, './src/foo.js', 'run-a', first.owner_token, first.generation), true);
  } finally { remove(cwd); }
}
function testFreshOtherOwnerIsBusy() {
  const cwd = temporary(); const target = 'fresh.json';
  try {
    const owner = filelock.acquireFileLock(cwd, target, 'run-a', 's', { ttlMs: 5000 });
    const denied = filelock.acquireFileLock(cwd, target, 'run-b', 's', { ttlMs: 5000 });
    assert.strictEqual(denied.acquired, false);
    assert.strictEqual(denied.reason, 'busy');
    assert.strictEqual(filelock.releaseFileLock(cwd, target, 'run-a', owner.owner_token, owner.generation), true);
  } finally { remove(cwd); }
}
// ── classifyHolder: absent vs illegible, and the lock consequence (review R2b) ─────────────────
//
// `runs.get` swallows its own parse failure into `null`, so "no record" and "record I could not
// read" arrive at `classifyHolder` byte-identical. They are NOT the same fact: absent is plausibly
// dead (the clock may reach it), illegible is a question that could not be asked (fail-closed, the
// lock is NOT stolen). The `record-unreadable` branch existed and NOTHING exercised it — a branch
// nobody bites is indistinguishable from a wrong branch. Both directions are asserted here, over
// the real registry layout, and the stale-lock consequence is asserted too — classifying without
// checking what the classification DOES would be an inert test.
function writeRunFile(cwd, id, content) {
  const dir = path.join(cwd, '.gsd', 'forge', 'runs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), content, 'utf8');
}
function testHolderAbsentVersusIllegible() {
  const cwd = temporary();
  try {
    // The export the safeguard depends on must actually be there (the objection claimed it was not).
    const runs = require('./forge-runs.js');
    assert.strictEqual(typeof runs.runFile, 'function', 'classifyHolder needs runs.runFile to tell absent from illegible');

    // (a) NO record on disk -> ended / run-not-registered. The clock may reach this holder.
    const absent = filelock.classifyHolder(cwd, 'run-fantasma');
    assert.strictEqual(absent.activity, 'ended');
    assert.strictEqual(absent.reason, 'run-not-registered');
    const staleGhost = filelock.acquireFileLock(cwd, 'alvo-a.json', 'run-fantasma', 's', { ttlMs: 10, now: () => 10 });
    assert.strictEqual(staleGhost.acquired, true);
    const steal = filelock.acquireFileLock(cwd, 'alvo-a.json', 'run-b', 's', { ttlMs: 10, now: () => 100000 });
    assert.strictEqual(steal.acquired, true, 'an unregistered holder is plausibly dead: the clock is allowed to reach it');
    assert.strictEqual(steal.stolen && steal.stolen.reason, 'expired', 'and the steal names the clock as its authorization');

    // (b) record PRESENT but truncated — exactly what a kill mid-write leaves behind.
    writeRunFile(cwd, 'run-truncada', '{"kind":"milestone","id":"run-trunc');
    const illegible = filelock.classifyHolder(cwd, 'run-truncada');
    assert.strictEqual(illegible.activity, 'unmeasured', 'a record that could not be read is never "dead"');
    assert.strictEqual(illegible.reason, 'record-unreadable');
    assert(filelock.HOLDER_ACTIVITY.includes(illegible.activity) && filelock.HOLDER_REASONS.includes(illegible.reason),
      'both come from the closed sets');

    // and the consequence: a STALE lock held by that run is NOT stolen (fail-closed).
    const held = filelock.acquireFileLock(cwd, 'alvo-b.json', 'run-truncada', 's', { ttlMs: 10, now: () => 10 });
    assert.strictEqual(held.acquired, true);
    const denied = filelock.acquireFileLock(cwd, 'alvo-b.json', 'run-c', 's', { ttlMs: 10, now: () => 100000 });
    assert.strictEqual(denied.acquired, false, 'stealing from an UNMEASURED holder is the over-reach this guard exists to refuse');
    assert.strictEqual(denied.reason, 'holder_unmeasured');
    assert.strictEqual(denied.holder.run_diagnostic, 'unmeasured', 'and the caller is told WHY, not just "no"');

    // (c) the same file, now legible and inactive -> ended, and the lock becomes takeable. Proves
    // (b) is about legibility, not about the id.
    writeRunFile(cwd, 'run-truncada', JSON.stringify({ kind: 'milestone', id: 'run-truncada', active: false }));
    assert.strictEqual(filelock.classifyHolder(cwd, 'run-truncada').reason, 'registry-inactive');
    const now = filelock.acquireFileLock(cwd, 'alvo-b.json', 'run-c', 's', { ttlMs: 10, now: () => 200000 });
    assert.strictEqual(now.acquired, true, 'measured-ended + stale is what the clock is FOR');
  } finally { remove(cwd); }
}
// ── The lock leak by path LENGTH (Q1(a)) ───────────────────────────────────────────────────────
//
// The release used to rename the lock to `${file}.release-${generation}-${uuid}` — +78 chars —
// before unlinking. Crossing the OS component limit (255 bytes on POSIX; 255 chars per component
// on win32 too) made the bare `catch` answer `already_released`, a NAME for an outcome that did
// not happen, and the orphan then killed the SECOND write to the same fragment inside the TTL.
//
// Deep targets must now produce fixed-size hash names, including temporary files.
function locksLeftIn(cwd) {
  const dir = path.join(cwd, '.gsd', 'forge', 'file-locks');
  try { return fs.readdirSync(dir); } catch { return []; }
}
function testReleaseSurvivesADeepLockName() {
  const cwd = temporary();
  try {
    const target = Array.from({ length: 18 }, (_, i) => `level-${i}-\u6e2c\u8a66`).join('/') + '/r\u00e9sum\u00e9.json';
    fs.mkdirSync(path.dirname(path.join(cwd, target)), { recursive: true });
    fs.writeFileSync(path.join(cwd, target), 'real target');
    assert.strictEqual(path.basename(filelock.lockPathFor(cwd, target)).length, 72);
    const owner = filelock.acquireFileLock(cwd, target, 'run-deep', 's', { ttlMs: 5000 });
    assert.strictEqual(owner.acquired, true, 'deep Unicode target is lockable');
    assert.strictEqual(
      filelock.releaseFileLock(cwd, target, 'run-deep', owner.owner_token, owner.generation), true,
      'a deep lock name must still be releasable — this is the leak that orphaned 205 locks',
    );
    assert.deepStrictEqual(locksLeftIn(cwd), [], 'and it leaves NOTHING behind, neither lock nor rename debris');
  } finally { remove(cwd); }
}
// The control. A test that only fails deep and never passes shallow cannot tell a fix from an
// environment — it must pass both before and after the production change.
function testReleaseWithAShortLockName() {
  const cwd = temporary();
  try {
    const target = 'raso.json';
    assert(path.basename(filelock.lockPathFor(cwd, target)).length < 178, 'the control stays out of the window');
    const owner = filelock.acquireFileLock(cwd, target, 'run-raso', 's', { ttlMs: 5000 });
    assert.strictEqual(owner.acquired, true);
    assert.strictEqual(filelock.releaseFileLock(cwd, target, 'run-raso', owner.owner_token, owner.generation), true);
    assert.deepStrictEqual(locksLeftIn(cwd), [], 'nothing left behind on the shallow path either');
  } finally { remove(cwd); }
}
// A removal that fails is named by its errno. `already_released` is reserved to `!existing` —
// that is the whole defect class this milestone exists to close.
function testRemovalFailureIsNamedByErrno() {
  const cwd = temporary();
  const realUnlink = fs.unlinkSync;
  try {
    const target = 'errno.json';
    // The one case where `already_released` is TRUE, measured BEFORE any stub is in place:
    // nothing was there to remove.
    const never = filelock.acquireFileLock(cwd, 'nunca.json', 'run-x', 's', { ttlMs: 5000 });
    assert.strictEqual(filelock.releaseFileLock(cwd, 'nunca.json', 'run-x', never.owner_token, never.generation), true);
    const absent = filelock.releaseFileLockDetailed(cwd, 'nunca.json', 'run-x', never.owner_token, never.generation);
    assert.strictEqual(absent.ok, false);
    assert.strictEqual(absent.reason, 'already_released', 'that name is reserved to "nothing was there"');

    const owner = filelock.acquireFileLock(cwd, target, 'run-errno', 's', { ttlMs: 5000 });
    assert.strictEqual(owner.acquired, true);
    // The stub also reaches the internal mutex's own release, so this is the LAST measurement
    // taken on this cwd: the guard file it leaves behind is expected debris, not a finding.
    fs.unlinkSync = () => { throw Object.assign(new Error('name too long'), { code: 'ENAMETOOLONG' }); };
    const detailed = filelock.releaseFileLockDetailed(cwd, target, 'run-errno', owner.owner_token, owner.generation);
    assert.strictEqual(detailed.ok, false);
    assert.strictEqual(detailed.reason, 'release-failed', 'a removal that failed is never called "already_released"');
    assert.strictEqual(detailed.errno, 'ENAMETOOLONG', 'and the errno that caused it is carried, not swallowed');
    fs.unlinkSync = realUnlink;
    // The boolean shape of `releaseFileLock` is asserted by the six existing call sites and by
    // the two length tests above; re-asserting it on this cwd would measure the stub's debris,
    // not the export.
  } finally { fs.unlinkSync = realUnlink; remove(cwd); }
}
function testInvalidReadsFailClosedAndRecoveryKeepsEvidence() {
  const cwd = temporary();
  const originalRead = fs.readFileSync;
  try {
    const target = 'corrupt.json';
    const owner = filelock.acquireFileLock(cwd, target, 'a', 's');
    const file = filelock.lockPathFor(cwd, target);
    const valid = fs.readFileSync(file, 'utf8');
    for (const [content, reason] of [['{broken', 'lock_invalid_json'], ['null', 'lock_invalid_metadata'], ['[]', 'lock_invalid_metadata'], ['{}', 'lock_invalid_metadata'], [JSON.stringify({ ...JSON.parse(valid), ttl_ms: 'forever' }), 'lock_invalid_metadata']]) {
      fs.writeFileSync(file, content);
      assert.strictEqual(filelock.checkFileLock(cwd, target).held, true);
      assert.strictEqual(filelock.checkFileLock(cwd, target).reason, reason);
      assert.strictEqual(filelock.acquireFileLock(cwd, target, 'b', 's').reason, reason);
      assert.strictEqual(filelock.renewFileLock(cwd, target, owner.owner_token, owner.generation).reason, reason);
      assert.strictEqual(filelock.touchFileLock(cwd, target, { runId: 'a', sessionId: 's' }).reason, reason);
      assert.strictEqual(filelock.releaseFileLockDetailed(cwd, target, 'a', owner.owner_token, owner.generation).reason, reason);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), content);
    }
    fs.writeFileSync(file, valid);
    fs.readFileSync = function (name, ...args) {
      if (String(name) === file) throw Object.assign(new Error('injected read failure'), { code: 'EACCES' });
      return originalRead.call(this, name, ...args);
    };
    assert.strictEqual(filelock.acquireFileLock(cwd, target, 'b', 's').reason, 'lock_read_failed');
    assert.strictEqual(filelock.renewFileLock(cwd, target, owner.owner_token, owner.generation).reason, 'lock_read_failed');
    assert.strictEqual(filelock.releaseFileLockDetailed(cwd, target, 'a', owner.owner_token, owner.generation).reason, 'lock_read_failed');
    assert.strictEqual(filelock.checkFileLock(cwd, target).errno, 'EACCES');
    assert.strictEqual(filelock.checkFileLock(cwd, target).held, true);
    fs.readFileSync = originalRead;
    assert.strictEqual(fs.readFileSync(file, 'utf8'), valid);
    fs.writeFileSync(file, '{broken evidence');
    assert.strictEqual(filelock.recoverFileLock(cwd, target).ok, false);
    const recovered = filelock.recoverFileLock(cwd, target, { confirmStopped: true });
    assert.strictEqual(recovered.ok, true);
    assert.strictEqual(fs.readFileSync(recovered.evidence, 'utf8'), '{broken evidence');
    assert(path.basename(recovered.evidence).length <= filelock.LOCK_BASENAME_MAX);
    const replacement = filelock.acquireFileLock(cwd, target, 'b', 's');
    assert.strictEqual(replacement.acquired, true);
    assert.strictEqual(replacement.release(), true);

    // CLI recovery has the same explicit precondition and preserves evidence.
    fs.writeFileSync(file, '{cli damage');
    const cli = spawnSync(process.execPath, [require.resolve('./forge-filelock.js'), '--cwd', cwd, '--recover', target, '--confirm-stopped'], { encoding: 'utf8', timeout: 10000 });
    assert.strictEqual(cli.status, 0, cli.stderr);
    assert.strictEqual(fs.readFileSync(JSON.parse(cli.stdout).evidence, 'utf8'), '{cli damage');
  } finally { fs.readFileSync = originalRead; remove(cwd); }
}

function testActualLegacyAndNewWritersCannotOverlap() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-v1-'));
  try {
    const target = 'x';
    const oldOwner = legacy.acquireFileLock(cwd, target, null, 'old');
    assert.strictEqual(oldOwner.acquired, true);
    const before = fs.readFileSync(legacy.lockPathFor(cwd, target));
    assert.strictEqual(filelock.acquireFileLock(cwd, target, 'new', 's').reason, 'legacy_lock_present');
    assert.strictEqual(filelock.checkFileLock(cwd, target).held, true);
    assert.deepStrictEqual(fs.readFileSync(legacy.lockPathFor(cwd, target)), before);
    assert.strictEqual(oldOwner.release(), true, 'refusing legacy entry must still let old owner release');

    const owner = filelock.acquireFileLock(cwd, target, 'new', 's');
    assert.strictEqual(owner.acquired, true);
    // Exercise the actual old mutex stale-recovery path without sleeping: age
    // the compatibility mutex well beyond its old 5s default and the file TTL.
    const canonical = JSON.parse(fs.readFileSync(filelock.lockPathFor(cwd, target), 'utf8')).file_path;
    const common = path.join(cwd, '.gsd', '.locks', `filelock-${crypto.createHash('sha256').update(canonical).digest('hex')}`, 'metadata.json');
    const metadata = JSON.parse(fs.readFileSync(common, 'utf8'));
    metadata.renewed_at = Date.now() - 86400000;
    fs.writeFileSync(common, JSON.stringify(metadata));
    assert.strictEqual(legacy.acquireFileLock(cwd, target, null, 'old').acquired, false, 'actual old writer must not bypass hash lock');
    assert.strictEqual(filelock.renewFileLock(cwd, target, owner.owner_token, owner.generation).ok, true);
    assert.strictEqual(owner.release(), true);
    const oldAgain = legacy.acquireFileLock(cwd, target, null, 'old');
    assert.strictEqual(oldAgain.acquired, true, 'old protocol may resume after new owner releases');
    assert.strictEqual(oldAgain.release(), true);

    // An illegible legacy record is also preserved and explicitly recoverable.
    fs.writeFileSync(legacy.lockPathFor(cwd, target), '{legacy damage');
    assert.strictEqual(filelock.acquireFileLock(cwd, target, 'new', 's').reason, 'legacy_lock_present');
    const recovered = filelock.recoverFileLock(cwd, target, { confirmStopped: true });
    assert.strictEqual(recovered.ok, true);
    assert.strictEqual(fs.readFileSync(recovered.evidence, 'utf8'), '{legacy damage');
  } finally { remove(cwd); }
}

function testBridgeSurvivesProcessExitAndRecoversIncompletePublication() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-exit-'));
  try {
    const child = spawnSync(process.execPath, ['-e', 'const f=require(process.argv[1]); const h=f.acquireFileLock(process.argv[2],"x",null,"child",{ttlMs:1}); console.log(JSON.stringify(h));', require.resolve('./forge-filelock.js'), cwd], { encoding: 'utf8', timeout: 10000 });
    assert.strictEqual(child.status, 0, child.stderr);
    assert.strictEqual(JSON.parse(child.stdout).acquired, true);
    assert.strictEqual(legacy.acquireFileLock(cwd, 'x', null, 'old').acquired, false, 'process exit is not a compatibility fence release');
    const next = filelock.acquireFileLock(cwd, 'x', null, 'new', { now: () => Date.now() + 10000 });
    assert.strictEqual(next.acquired, true, 'new writer recovers expired unowned lock through durable fence');
    assert(next.stolen);
    // Simulate death between removing the hash file and releasing the fence.
    fs.unlinkSync(filelock.lockPathFor(cwd, 'x'));
    assert.strictEqual(legacy.acquireFileLock(cwd, 'x', null, 'old').acquired, false);
    const afterGap = filelock.acquireFileLock(cwd, 'x', null, 'new');
    assert.strictEqual(afterGap.acquired, true);
    assert.strictEqual(afterGap.release(), true);
    assert.strictEqual(legacy.acquireFileLock(cwd, 'x', null, 'old').release(), true);
  } finally { remove(cwd); }
}

function testExplicitRecoveryOfCrashedLegacyProcessGuard() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-v1-crash-'));
  try {
    const crashed = spawnSync(process.execPath, ['-e', `
      const mutex = require(process.argv[1]), acquire = mutex.tryAcquireSync;
      mutex.tryAcquireSync = (...args) => {
        const guard = acquire(...args);
        if (guard) process.exit(73);
        return guard;
      };
      require(process.argv[2]).acquireFileLock(process.argv[3], 'x', null, 'legacy');
    `, require.resolve('./fixtures/filelock-v1/forge-lock.js'), require.resolve('./fixtures/filelock-v1/forge-filelock.js'), cwd], { encoding: 'utf8', timeout: 10000 });
    assert.strictEqual(crashed.status, 73, crashed.stderr);
    const dir = path.join(cwd, '.gsd', '.locks', fs.readdirSync(path.join(cwd, '.gsd', '.locks'))[0]);
    const before = fs.readFileSync(path.join(dir, 'metadata.json'));
    assert.strictEqual(JSON.parse(before).ttl_ms, 5000);
    assert.strictEqual(filelock.acquireFileLock(cwd, 'x', null, 'new').reason, 'guard_busy');
    assert.strictEqual(filelock.recoverFileLock(cwd, 'x').reason, 'recovery_requires_stopped_writers');
    const recovered = filelock.recoverFileLock(cwd, 'x', { confirmStopped: true });
    assert.strictEqual(recovered.ok, true, JSON.stringify(recovered));
    assert.deepStrictEqual(fs.readFileSync(path.join(recovered.guard_evidence, 'metadata.json')), before);
    const next = filelock.acquireFileLock(cwd, 'x', null, 'new');
    assert.strictEqual(next.acquired, true);
    assert.strictEqual(next.release(), true);
  } finally { remove(cwd); }
}

function testRecoveryPreservesLiveUnmeasuredAndDurableGuards() {
  const mutex = require('./forge-lock.js');
  for (const liveness of ['live', 'permission-denied', 'pid-absent']) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-v1-live-'));
    const kill = process.kill;
    try {
      fs.mkdirSync(path.join(cwd, '.gsd'));
      const canonical = process.platform === 'win32' ? path.resolve(cwd, 'x').toLowerCase() : path.resolve(cwd, 'x');
      const name = `filelock-${crypto.createHash('sha256').update(canonical).digest('hex')}`;
      const guard = mutex.tryAcquireSync(cwd, name, { ttlMs: 5000 });
      if (liveness === 'pid-absent') {
        const meta = { ...guard.metadata }; delete meta.holder_pid;
        fs.writeFileSync(mutex.metaPath(guard.lockDir), JSON.stringify(meta));
      }
      const before = fs.readFileSync(mutex.metaPath(guard.lockDir));
      if (liveness === 'permission-denied') process.kill = () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); };
      const refused = filelock.recoverFileLock(cwd, 'x', { confirmStopped: true });
      assert.strictEqual(Boolean(refused.ok), false, liveness);
      assert.deepStrictEqual(fs.readFileSync(mutex.metaPath(guard.lockDir)), before);
      assert.strictEqual(mutex.assertOwned(guard), true);
    } finally { process.kill = kill; remove(cwd); }
  }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-v2-dead-'));
  try {
    const child = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(require(process.argv[1]).acquireFileLock(process.argv[2], "x", null, "child")))', require.resolve('./forge-filelock.js'), cwd], { encoding: 'utf8', timeout: 10000 });
    assert.strictEqual(child.status, 0, child.stderr);
    const owner = JSON.parse(child.stdout); assert.strictEqual(owner.acquired, true);
    const file = filelock.lockPathFor(cwd, 'x'), before = fs.readFileSync(file);
    const root = path.join(cwd, '.gsd', '.locks'), dir = path.join(root, fs.readdirSync(root)[0]);
    const fence = fs.readFileSync(path.join(dir, 'metadata.json'));
    assert.strictEqual(filelock.recoverFileLock(cwd, 'x', { confirmStopped: true }).reason, 'owner_token_required');
    assert.deepStrictEqual(fs.readFileSync(file), before);
    assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'metadata.json')), fence);
    assert.strictEqual(legacy.acquireFileLock(cwd, 'x', null, 'old').acquired, false);
    assert.strictEqual(filelock.releaseFileLock(cwd, 'x', null, owner.owner_token, owner.generation), true);
  } finally { remove(cwd); }
}

function testTemporaryNamesAreBounded() {
  const cwd = temporary();
  const originalWrite = fs.writeFileSync;
  const names = [];
  try {
    fs.writeFileSync = function (name, ...args) {
      if (String(name).includes('file-locks')) names.push(path.basename(String(name)));
      return originalWrite.call(this, name, ...args);
    };
    const target = Array(70).fill('測試-é').join('/') + '/document.json';
    const owner = filelock.acquireFileLock(cwd, target, null, 's');
    assert.strictEqual(owner.acquired, true);
    assert.strictEqual(filelock.acquireFileLock(cwd, target.normalize('NFD'), null, 'other').acquired, false);
    assert.strictEqual(owner.release(), true);
    assert(names.some(name => name.endsWith('.tmp')));
    assert(names.every(name => Buffer.byteLength(name) <= filelock.LOCK_BASENAME_MAX));
  } finally { fs.writeFileSync = originalWrite; remove(cwd); }
}

function testGuardBootstrapCrashHasExplicitRecovery() {
  for (const operationGuard of [false, true]) {
    const cwd = temporary();
    try {
      const canonical = JSON.parse(JSON.stringify(path.resolve(cwd, 'x')));
      const normalized = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
      const name = `filelock-${crypto.createHash('sha256').update(normalized).digest('hex')}${operationGuard ? '-v2' : ''}`;
      const dir = path.join(cwd, '.gsd', '.locks', name);
      const crashed = spawnSync(process.execPath, ['-e', `
        const fs = require('fs'), mkdir = fs.mkdirSync;
        const target = process.argv[3];
        fs.mkdirSync = function(file, ...args) {
          const value = mkdir.call(fs, file, ...args);
          if (file === target) process.exit(73);
          return value;
        };
        require(process.argv[1]).acquireFileLock(process.argv[2], 'x', null, 'crash');
      `, require.resolve('./forge-filelock'), cwd, dir], { encoding: 'utf8', timeout: 5000 });
      assert.strictEqual(crashed.status, 73, crashed.stderr);
      assert.deepStrictEqual(fs.readdirSync(dir), []);
      assert.strictEqual(filelock.acquireFileLock(cwd, 'x', null, 'next').acquired, false);
      assert.strictEqual(filelock.recoverFileLock(cwd, 'x').ok, false);
      const recovered = filelock.recoverFileLock(cwd, 'x', { confirmStopped: true });
      assert.strictEqual(recovered.ok, true, JSON.stringify(recovered));
      const evidence = operationGuard ? recovered.operation_guard_evidence : recovered.guard_evidence;
      assert.deepStrictEqual(fs.readdirSync(evidence), []);
      const owner = filelock.acquireFileLock(cwd, 'x', null, 'next');
      assert.strictEqual(owner.acquired, true);
      assert.strictEqual(owner.release(), true);
      assert.strictEqual(legacy.acquireFileLock(cwd, 'x', null, 'old').release(), true);
    } finally { remove(cwd); }
  }
}

function testGuardReleaseFailuresAreReportedAndRecoverable() {
  for (const operationGuard of [false, true]) {
    for (const phase of ['metadata', 'released-marker', 'directory']) {
      const cwd = temporary();
      const unlink = fs.unlinkSync, rmdir = fs.rmdirSync;
      try {
        const owner = filelock.acquireFileLock(cwd, 'x', null, 'owner');
        const canonical = JSON.parse(fs.readFileSync(filelock.lockPathFor(cwd, 'x'), 'utf8')).file_path;
        const name = `filelock-${crypto.createHash('sha256').update(canonical).digest('hex')}${operationGuard ? '-v2' : ''}`;
        const dir = path.join(cwd, '.gsd', '.locks', name);
        fs.unlinkSync = function(file, ...args) {
          if (phase === 'metadata' && file === path.join(dir, 'metadata.json')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
          return unlink.call(fs, file, ...args);
        };
        fs.rmdirSync = function(file, ...args) {
          if ((phase === 'directory' && file === dir) || (phase === 'released-marker' && path.dirname(file) === dir && file.endsWith('.released'))) {
            throw Object.assign(new Error('denied'), { code: 'EACCES' });
          }
          return rmdir.call(fs, file, ...args);
        };
        assert.throws(() => owner.release(), { code: 'GUARD_RELEASE_FAILED' });
        fs.unlinkSync = unlink; fs.rmdirSync = rmdir;
        const residue = fs.readdirSync(dir);
        const recovered = filelock.recoverFileLock(cwd, 'x', { confirmStopped: true });
        assert.strictEqual(recovered.ok, true, JSON.stringify(recovered));
        const evidence = operationGuard ? recovered.operation_guard_evidence : recovered.guard_evidence;
        assert.deepStrictEqual(fs.readdirSync(evidence), residue);
        const next = filelock.acquireFileLock(cwd, 'x', null, 'next');
        assert.strictEqual(next.acquired, true);
        assert.strictEqual(next.release(), true);
      } finally { fs.unlinkSync = unlink; fs.rmdirSync = rmdir; remove(cwd); }
    }
  }
}

// The actual pre-canonical format has five fields, not the nine-field v1 fixture.
function seedRelativeLegacy(cwd, raw = 'src/relative.txt', patch = {}) {
  const meta = { run_id: 'legacy-run', session_id: 'legacy-session', file_path: raw, acquired_at: 1, intent: 'edit', ...patch };
  const file = path.join(cwd, '.gsd', 'forge', 'file-locks', filelock.encodePath(raw) + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = JSON.stringify(meta);
  fs.writeFileSync(file, bytes);
  writeRunFile(cwd, 'legacy-run', JSON.stringify({ id: 'legacy-run', session_id: 'legacy-session', active: false, write_claim: null }));
  return { file, bytes, raw };
}
function testRelativeFiveFieldRecovery() {
  const cwd = temporary();
  const kill = process.kill;
  try {
    const old = seedRelativeLegacy(cwd);
    process.kill = () => { throw Error('relative recovery must not use PID or age as authority'); };
    assert.strictEqual(filelock.acquireFileLock(cwd, old.raw, 'new', 'new').reason, 'legacy_lock_present');
    assert.strictEqual(filelock.checkFileLock(cwd, old.raw).held, true);
    assert.strictEqual(filelock.recoverFileLock(cwd, old.raw).reason, 'recovery_requires_stopped_writers');
    const recovered = filelock.recoverFileLock(cwd, old.raw, { confirmStopped: true });
    assert.strictEqual(recovered.ok, true, JSON.stringify(recovered));
    assert.strictEqual(recovered.profile, 'relative-five-field');
    assert.strictEqual(fs.readFileSync(recovered.evidence, 'utf8'), old.bytes);
    assert.strictEqual(path.dirname(recovered.evidence), path.join(cwd, '.gsd', 'forge', 'file-lock-recovery'));
    assert.deepStrictEqual(fs.readdirSync(path.dirname(old.file)), [], 'the unchanged resume empty gate needs a genuinely empty active directory');
    const next = filelock.acquireFileLock(cwd, old.raw, 'new', 'new');
    assert.strictEqual(next.acquired, true);
    assert.strictEqual(next.release(), true);
  } finally { process.kill = kill; remove(cwd); }
}
function testRelativeRecoveryRefusals() {
  for (const variant of ['live', 'missing', 'invalid-registry', 'claim', 'session', 'filename-mismatch', 'extra-key', 'traversal', 'ambiguous', 'v2', 'raw-guard', 'canonical-guard', 'v2-guard', 'archive-symlink']) {
    const cwd = temporary(); const mutex = require('./forge-lock.js'); let held;
    try {
      const raw = variant === 'traversal' ? 'src/../relative.txt' : 'src/relative.txt';
      const old = seedRelativeLegacy(cwd, raw, variant === 'extra-key' ? { owner_token: 'not-the-five-field-profile' } : variant === 'filename-mismatch' ? { file_path: 'foreign.txt' } : {});
      const registry = path.join(cwd, '.gsd', 'forge', 'runs', 'legacy-run.json');
      if (variant === 'live') writeRunFile(cwd, 'legacy-run', JSON.stringify({ id: 'legacy-run', session_id: 'legacy-session', active: true }));
      if (variant === 'missing') fs.unlinkSync(registry);
      if (variant === 'invalid-registry') fs.writeFileSync(registry, '{broken');
      if (variant === 'claim') writeRunFile(cwd, 'legacy-run', JSON.stringify({ id: 'legacy-run', session_id: 'legacy-session', active: false, write_claim: { paths: [] } }));
      if (variant === 'session') writeRunFile(cwd, 'legacy-run', JSON.stringify({ id: 'legacy-run', session_id: 'foreign-session', active: false }));
      if (variant === 'ambiguous') {
        const alias = 'src\\relative.txt';
        fs.writeFileSync(path.join(path.dirname(old.file), filelock.encodePath(alias) + '.json'), JSON.stringify({ ...JSON.parse(old.bytes), file_path: alias }));
      }
      if (variant === 'v2') fs.writeFileSync(filelock.lockPathFor(cwd, raw), '{}');
      if (variant.endsWith('-guard')) {
        const canonical = process.platform === 'win32' ? path.resolve(cwd, raw).toLowerCase() : path.resolve(cwd, raw);
        const value = variant === 'raw-guard' ? raw : canonical;
        const name = 'filelock-' + crypto.createHash('sha256').update(value).digest('hex') + (variant === 'v2-guard' ? '-v2' : '');
        held = mutex.tryAcquireSync(cwd, name, { ttlMs: 5000, allowStaleRecovery: false });
        assert(held);
        const stale = { ...held.metadata, acquired_at: 1, renewed_at: 1 };
        fs.writeFileSync(mutex.metaPath(held.lockDir), JSON.stringify(stale));
      }
      if (variant === 'archive-symlink') {
        const outside = path.join(cwd, 'foreign-archive'); fs.mkdirSync(outside);
        fs.symlinkSync(outside, path.join(cwd, '.gsd', 'forge', 'file-lock-recovery'), process.platform === 'win32' ? 'junction' : 'dir');
      }
      let result;
      try { result = filelock.recoverFileLock(cwd, raw, { confirmStopped: true }); }
      catch (error) { assert.strictEqual(variant, 'archive-symlink', error.stack); result = { ok: false }; }
      assert.strictEqual(Boolean(result.ok), false, variant);
      assert.strictEqual(fs.readFileSync(old.file, 'utf8'), old.bytes, variant);
      if (held) assert.strictEqual(mutex.assertOwned(held), true, variant);
    } finally { if (held) held.release(); remove(cwd); }
  }
}
function testRelativeRecoveryDriftAndGuardLifetime() {
  for (const variant of ['lock', 'registry', 'guards']) {
    const cwd = temporary(), open = fs.openSync, close = fs.closeSync, rename = fs.renameSync;
    const observed = new Map(); let injected = false, checked = false;
    try {
      const old = seedRelativeLegacy(cwd), registry = path.join(cwd, '.gsd', 'forge', 'runs', 'legacy-run.json');
      fs.openSync = function(file, ...args) { const fd = open.call(this, file, ...args); observed.set(fd, String(file)); return fd; };
      // Mutate only after the measured registry FD has closed. This avoids a
      // Windows held-FD rename/write error being mistaken for a drift control.
      fs.closeSync = function(fd) {
        const file = observed.get(fd); observed.delete(fd); const result = close.call(this, fd);
        if (!injected && file === registry && variant !== 'guards') {
          injected = true;
          fs.writeFileSync(variant === 'lock' ? old.file : registry, variant === 'lock' ? old.bytes + ' ' : JSON.stringify({ id: 'legacy-run', session_id: 'legacy-session', active: true }));
        }
        return result;
      };
      fs.renameSync = function(from, to) {
        if (String(from) === old.file && variant === 'guards') {
          const mutex = require('./forge-lock.js'), canonical = process.platform === 'win32' ? path.resolve(cwd, old.raw).toLowerCase() : path.resolve(cwd, old.raw);
          const name = value => 'filelock-' + crypto.createHash('sha256').update(value).digest('hex');
          for (const guard of [name(canonical), name(canonical) + '-v2', name(old.raw)]) {
            assert.strictEqual(mutex.tryAcquireSync(cwd, guard, { allowStaleRecovery: false }), null, guard);
          }
          assert.throws(() => require('./forge-runs.js').update(cwd, 'legacy-run', { active: true }), { code: 'EOWNERSHIPBUSY' }, 'registry fence is held at archive');
          checked = true;
        }
        return rename.call(this, from, to);
      };
      const result = filelock.recoverFileLock(cwd, old.raw, { confirmStopped: true });
      assert.strictEqual(Boolean(result.ok), variant === 'guards', variant);
      if (variant === 'guards') assert(checked, 'all three guards are held at archive');
      else { assert(injected, 'the exact post-measurement drift was injected'); assert(fs.existsSync(old.file), 'changed lock remains active'); }
    } finally { fs.openSync = open; fs.closeSync = close; fs.renameSync = rename; remove(cwd); }
  }
}

function testRelativeAppearsAfterRecoveryRouteProbe() {
  const cwd = temporary(), mutex = require('./forge-lock.js'), acquire = mutex.tryAcquireSync;
  let injected = false, rawGuard, old;
  try {
    mutex.tryAcquireSync = function(root, name, options) {
      const result = acquire.call(this, root, name, options);
      if (!injected && result && root === cwd && name.endsWith('-v2')) {
        injected = true;
        old = seedRelativeLegacy(cwd);
        writeRunFile(cwd, 'legacy-run', JSON.stringify({ id: 'legacy-run', session_id: 'legacy-session', active: true, write_claim: null }));
        const rawName = 'filelock-' + crypto.createHash('sha256').update(old.raw).digest('hex');
        rawGuard = acquire.call(this, cwd, rawName, { ttlMs: 5000, allowStaleRecovery: false });
        assert(rawGuard);
      }
      return result;
    };
    const denied = filelock.recoverFileLock(cwd, 'src/relative.txt', { confirmStopped: true });
    assert(injected, 'relative LIVE record appeared after initial routing probe');
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.reason, 'legacy_lock_changed');
    assert.strictEqual(fs.readFileSync(old.file, 'utf8'), old.bytes);
    assert.strictEqual(mutex.assertOwned(rawGuard), true);
    assert.strictEqual(fs.existsSync(path.join(cwd, '.gsd', 'forge', 'file-lock-recovery')), false, 'no archive created');
    mutex.tryAcquireSync = acquire;
    assert.strictEqual(filelock.recoverFileLock(cwd, old.raw, { confirmStopped: true }).reason, 'guard_busy', 'dedicated retry still needs the raw guard');
    rawGuard.release(); rawGuard = null;
    assert.strictEqual(filelock.recoverFileLock(cwd, old.raw, { confirmStopped: true }).reason, 'holder_unmeasured_or_live', 'dedicated retry still measures the LIVE registry');
    assert.strictEqual(fs.readFileSync(old.file, 'utf8'), old.bytes);
  } finally { mutex.tryAcquireSync = acquire; if (rawGuard) rawGuard.release(); remove(cwd); }
}

function main() {
  console.log(`forge-filelock tests on ${process.platform}`);
  testRelativeAppearsAfterRecoveryRouteProbe();
  testRelativeFiveFieldRecovery();
  testRelativeRecoveryRefusals();
  testRelativeRecoveryDriftAndGuardLifetime();
  testOwnerScopedLifecycle();
  testNonOwnerAndABA();
  testFreshOtherOwnerIsBusy();
  testCanonicalPathIdentity();
  testHolderAbsentVersusIllegible();
  testReleaseSurvivesADeepLockName();
  testReleaseWithAShortLockName();
  testRemovalFailureIsNamedByErrno();
  testInvalidReadsFailClosedAndRecoveryKeepsEvidence();
  testActualLegacyAndNewWritersCannotOverlap();
  testBridgeSurvivesProcessExitAndRecoversIncompletePublication();
  testExplicitRecoveryOfCrashedLegacyProcessGuard();
  testRecoveryPreservesLiveUnmeasuredAndDurableGuards();
  testTemporaryNamesAreBounded();
  testGuardBootstrapCrashHasExplicitRecovery();
  testGuardReleaseFailuresAreReportedAndRecoverable();
  console.log('forge-filelock tests passed');
}
try { main(); } catch (error) { console.error(error.stack || error); process.exitCode = 1; }
