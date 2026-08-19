#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const filelock = require('./forge-filelock.js');

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
// The bite is calibrated on the lock's BASENAME, not on the caller's path: `lockPathFor` base64s
// the whole canonical path, so the name grows ~4/3 of it. The window that makes the acquire pass
// (its temp suffix costs ~47) and the OLD release fail (~78) is basename ∈ [178, 208]. The target
// need not exist on disk — only the locks directory is ever created.
const DEEP_BASENAME_TARGET = 195;
function targetWithLockBasename(cwd, want) {
  // Grow a single relative segment until the lock basename lands on `want`. Deriving the length
  // instead of hard-coding a path is what keeps the window honest under any tmpdir depth.
  let segment = 'a';
  let last = null;
  for (let i = 0; i < 4096; i++) {
    const candidate = `deep/${segment}.json`;
    const length = path.basename(filelock.lockPathFor(cwd, candidate)).length;
    if (length >= want) return { target: candidate, length };
    last = length;
    segment += 'a';
  }
  throw new Error(`could not reach a lock basename of ${want} (stopped at ${last})`);
}
function locksLeftIn(cwd) {
  const dir = path.join(cwd, '.gsd', 'forge', 'file-locks');
  try { return fs.readdirSync(dir); } catch { return []; }
}
function testReleaseSurvivesADeepLockName() {
  const cwd = temporary();
  try {
    const { target, length } = targetWithLockBasename(cwd, DEEP_BASENAME_TARGET);
    assert(length >= 178 && length <= 208, `lock basename ${length} must sit in the biting window`);
    const owner = filelock.acquireFileLock(cwd, target, 'run-deep', 's', { ttlMs: 5000 });
    assert.strictEqual(owner.acquired, true, 'the acquire still fits: only the OLD release overflowed');
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
function main() {
  console.log(`forge-filelock tests on ${process.platform}`);
  testOwnerScopedLifecycle();
  testNonOwnerAndABA();
  testFreshOtherOwnerIsBusy();
  testCanonicalPathIdentity();
  testHolderAbsentVersusIllegible();
  testReleaseSurvivesADeepLockName();
  testReleaseWithAShortLockName();
  testRemovalFailureIsNamedByErrno();
  console.log('forge-filelock tests passed');
}
try { main(); } catch (error) { console.error(error.stack || error); process.exitCode = 1; }
