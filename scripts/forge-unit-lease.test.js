#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lease = require('./forge-unit-lease.js');

function temporary() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge unit lease espaço-測試-'));
}

function remove(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

function sandbox(callback) {
  const cwd = temporary();
  try { return callback(cwd); } finally { remove(cwd); }
}

function test(name, callback) {
  try {
    const value = callback();
    if (value && typeof value.then === 'function') return value.then(() => console.log(`ok - ${name}`));
    console.log(`ok - ${name}`);
    return Promise.resolve();
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function fixtureOptions(now, hostRuntime, extras) {
  return Object.assign({
    now: () => now,
    ttlMs: 100,
    graceMs: 25,
    hostRuntime,
    session: `${hostRuntime}-session`,
  }, extras || {});
}

function disk(cwd, unit) {
  return JSON.parse(fs.readFileSync(lease.leaseFile(cwd, unit), 'utf8'));
}

function assertNoSecret(value) {
  const text = JSON.stringify(value);
  assert(!text.includes('owner_token'), 'public response must omit owner_token');
  assert(!text.includes('request_id'), 'public response must omit request_id');
}

function assertPublic(value, hostRuntime) {
  assert(value && value.lease, 'expected public lease');
  assert.strictEqual(value.lease.owner, 'redacted');
  assert.strictEqual(value.lease.host_runtime, hostRuntime);
  assertNoSecret(value.lease);
}

function testPersistedShapeAndSanitizedObserve() {
  sandbox(cwd => {
    const acquired = lease.acquire(cwd, { type: 'execute-task', id: 'T03' }, fixtureOptions(1000, 'claude', {
      ownerToken: 'owner-a', requestId: 'request-a',
    }));
    assert.strictEqual(acquired.ok, true);
    assert.strictEqual(acquired.reason, 'acquired');
    assert.strictEqual(acquired.owner_token, 'owner-a');
    const stored = disk(cwd, 'execute-task/T03');
    for (const key of ['unit', 'owner_token', 'host_runtime', 'session', 'generation', 'acquired_at', 'heartbeat_at', 'expires_at', 'grace_ms']) {
      assert(Object.prototype.hasOwnProperty.call(stored, key), `storage requires ${key}`);
    }
    assert.strictEqual(stored.protocol_version, lease.PROTOCOL_VERSION);
    assert.strictEqual(stored.expires_at, 1100);
    assert.strictEqual(stored.grace_ms, 25);
    const observed = lease.observe(cwd, 'execute-task/T03', { now: () => 1001 });
    assert.strictEqual(observed.reason, 'lease-active');
    assertPublic(observed, 'claude');
    assert.strictEqual(observed.lease.session, 'claude-session');
    assert.strictEqual(JSON.stringify(observed).includes('owner-a'), false);
  });
}

function testOwnerTokenAndGenerationAreAuthorization() {
  sandbox(cwd => {
    const acquired = lease.acquire(cwd, 'execute-task/T03', fixtureOptions(1, 'codex', { ownerToken: 'owner-good' }));
    const wrongToken = lease.heartbeat(cwd, 'execute-task/T03', 'owner-wrong', acquired.generation, fixtureOptions(2, 'claude'));
    const wrongGeneration = lease.release(cwd, 'execute-task/T03', 'owner-good', 'different-generation');
    assert.deepStrictEqual(wrongToken, { ok: false, reason: 'owner-mismatch' });
    assert.deepStrictEqual(wrongGeneration, { ok: false, reason: 'owner-mismatch' });
    const stillHeld = lease.observe(cwd, 'execute-task/T03', { now: () => 2 });
    assert.strictEqual(stillHeld.reason, 'lease-active');
    const renewed = lease.heartbeat(cwd, 'execute-task/T03', 'owner-good', acquired.generation, fixtureOptions(50, 'claude'));
    assert.strictEqual(renewed.reason, 'renewed');
    assert.strictEqual(renewed.lease.host_runtime, 'codex', 'host is acquisition audit metadata, not heartbeat authority');
    const released = lease.release(cwd, 'execute-task/T03', 'owner-good', acquired.generation);
    assert.strictEqual(released.reason, 'released');
    assert.deepStrictEqual(lease.release(cwd, 'execute-task/T03', 'owner-good', acquired.generation), { ok: true, reason: 'already-released' });
  });
}

function testSameTokenRequestIsIdempotent() {
  sandbox(cwd => {
    const first = lease.acquire(cwd, 'plan-slice/S02', fixtureOptions(10, 'claude', { ownerToken: 'fixed-owner', requestId: 'retry-1' }));
    const repeated = lease.acquire(cwd, 'plan-slice/S02', fixtureOptions(11, 'codex', { ownerToken: 'fixed-owner', requestId: 'retry-1' }));
    assert.strictEqual(first.generation, repeated.generation);
    assert.strictEqual(repeated.reason, 'already-acquired');
    assert.strictEqual(disk(cwd, 'plan-slice/S02').host_runtime, 'claude');
    const denied = lease.acquire(cwd, 'plan-slice/S02', fixtureOptions(12, 'codex', { ownerToken: 'different-owner', requestId: 'retry-2' }));
    assert.strictEqual(denied.reason, 'lease-active');
    assertPublic(denied, 'claude');
    assert.strictEqual(lease.release(cwd, 'plan-slice/S02', first.owner_token, first.generation).reason, 'released');
  });
}

function testGraceBoundaryAndRecoveryAreClockControlled() {
  sandbox(cwd => {
    const first = lease.acquire(cwd, 'execute-task/T03', fixtureOptions(100, 'claude', { ownerToken: 'stale-owner' }));
    assert.strictEqual(lease.observe(cwd, 'execute-task/T03', { now: () => 201 }).reason, 'expired-awaiting-grace');
    const beforeGrace = lease.recover(cwd, 'execute-task/T03', { now: () => 224 });
    assert.strictEqual(beforeGrace.reason, 'expired-awaiting-grace');
    const atBoundary = lease.recover(cwd, 'execute-task/T03', { now: () => 225 });
    assert.strictEqual(atBoundary.reason, 'expired-awaiting-grace', 'expiry plus grace must be strictly passed');
    const recovered = lease.recover(cwd, 'execute-task/T03', { now: () => 226 });
    assert.strictEqual(recovered.reason, 'recovered');
    assert.strictEqual(recovered.previous.generation, first.generation);
    assertNoSecret(recovered.previous);
    assert.deepStrictEqual(lease.recover(cwd, 'execute-task/T03', { now: () => 226 }), { ok: true, reason: 'already-released' });
    const second = lease.acquire(cwd, 'execute-task/T03', fixtureOptions(227, 'codex', { ownerToken: 'next-owner' }));
    assert.notStrictEqual(second.generation, first.generation);
    assert.strictEqual(lease.release(cwd, 'execute-task/T03', first.owner_token, first.generation).reason, 'owner-mismatch');
    assert.strictEqual(lease.release(cwd, 'execute-task/T03', second.owner_token, second.generation).reason, 'released');
  });
}

function testHeartbeatWinsOnlyWhileItStillOwnsGeneration() {
  sandbox(cwd => {
    const original = lease.acquire(cwd, 'execute-task/T04', fixtureOptions(0, 'claude', { ownerToken: 'owner-one' }));
    const heartbeat = lease.heartbeat(cwd, 'execute-task/T04', original.owner_token, original.generation, fixtureOptions(130, 'codex'));
    assert.strictEqual(heartbeat.reason, 'renewed');
    assert.strictEqual(heartbeat.lease.expires_at, 230);
    const blockedRecovery = lease.recover(cwd, 'execute-task/T04', { now: () => 231 });
    assert.strictEqual(blockedRecovery.reason, 'expired-awaiting-grace');
    const recovery = lease.recover(cwd, 'execute-task/T04', { now: () => 256 });
    assert.strictEqual(recovery.reason, 'recovered');
    assert.deepStrictEqual(lease.heartbeat(cwd, 'execute-task/T04', original.owner_token, original.generation, fixtureOptions(257, 'claude')), { ok: false, reason: 'already-released' });
  });
}

function testUnicodePathsHaveOneLogicalLeaseFile() {
  sandbox(cwd => {
    const decomposed = ' execute-task/te\u0301ste 測試 ';
    const composed = 'execute-task/téste 測試';
    assert.strictEqual(lease.normalizeUnitKey(decomposed), composed);
    const acquired = lease.acquire(cwd, decomposed, fixtureOptions(1, 'claude', { ownerToken: 'unicode-owner' }));
    const competing = lease.acquire(cwd, composed, fixtureOptions(2, 'codex', { ownerToken: 'unicode-other' }));
    assert.strictEqual(competing.reason, 'lease-active');
    assert.strictEqual(lease.leaseFile(cwd, decomposed), lease.leaseFile(cwd, composed));
    assert(!path.basename(lease.leaseFile(cwd, composed)).includes('測試'));
    assert.notStrictEqual(lease.leaseFile(cwd, 'execute-task/AG'), lease.leaseFile(cwd, 'execute-task/Aa'), 'physical filenames must not fold encoded case');
    assert.strictEqual(lease.release(cwd, composed, acquired.owner_token, acquired.generation).reason, 'released');
  });
}

function testFailpointsLeaveAtMostOneCanonicalRecord() {
  sandbox(cwd => {
    const unit = 'execute-task/failpoints';
    assert.throws(() => lease.acquire(cwd, unit, fixtureOptions(1, 'claude', { failpoint: point => point === 'before-write' })), /failpoint/);
    assert.strictEqual(lease.observe(cwd, unit).lease, null);
    assert.throws(() => lease.acquire(cwd, unit, fixtureOptions(2, 'claude', { failpoint: point => point === 'after-write-before-rename' })), /failpoint/);
    assert.strictEqual(lease.observe(cwd, unit).lease, null);
    const first = lease.acquire(cwd, unit, fixtureOptions(3, 'claude', { ownerToken: 'after-rename-owner' }));
    assert.throws(() => lease.heartbeat(cwd, unit, first.owner_token, first.generation, fixtureOptions(4, 'claude', { failpoint: point => point === 'after-rename' })), /failpoint/);
    const current = lease.observe(cwd, unit, { now: () => 4 });
    assert.strictEqual(current.reason, 'lease-active');
    assert.strictEqual(disk(cwd, unit).heartbeat_at, 4);
    const files = fs.readdirSync(lease.leasesDir(cwd)).filter(name => name.endsWith('.json'));
    assert.strictEqual(files.length, 1, 'canonical directory has one lease record');
    assert.strictEqual(lease.release(cwd, unit, first.owner_token, first.generation).reason, 'released');
  });
}

function testInvalidOrInterruptedRecordRecoversWithoutPromotingTemp() {
  sandbox(cwd => {
    const unit = 'execute-task/recover-corrupt';
    const file = lease.leaseFile(cwd, unit);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{half-json', 'utf8');
    fs.writeFileSync(path.join(path.dirname(file), `.${path.basename(file)}.orphan.tmp`), '{not-a-lease', 'utf8');
    const recovered = lease.recover(cwd, unit, { now: () => 1 });
    assert.strictEqual(recovered.reason, 'recovered');
    assert.strictEqual(fs.existsSync(file), false);
    const next = lease.acquire(cwd, unit, fixtureOptions(2, 'codex', { ownerToken: 'recovered-owner' }));
    assert.strictEqual(next.reason, 'acquired');
    assert.strictEqual(lease.release(cwd, unit, next.owner_token, next.generation).reason, 'released');
  });
}

function testRuntimeDirectionsAreSymmetric() {
  sandbox(cwd => {
    for (const [firstHost, secondHost] of [['claude', 'codex'], ['codex', 'claude']]) {
      const unit = `execute-task/${firstHost}-to-${secondHost}`;
      const first = lease.acquire(cwd, unit, fixtureOptions(10, firstHost, { ownerToken: `${firstHost}-owner` }));
      const second = lease.acquire(cwd, unit, fixtureOptions(11, secondHost, { ownerToken: `${secondHost}-owner` }));
      assert.strictEqual(first.reason, 'acquired');
      assert.strictEqual(second.reason, 'lease-active');
      assert.strictEqual(second.lease.host_runtime, firstHost);
      assert.strictEqual(lease.release(cwd, unit, first.owner_token, first.generation).reason, 'released');
    }
  });
}

function childAcquire(cwd, unit, hostRuntime, token, barrier) {
  const source = [
    "const fs=require('fs');",
    "const l=require(process.argv[1]);",
    "const cwd=process.argv[2],unit=process.argv[3],host=process.argv[4],token=process.argv[5],barrier=process.argv[6];",
    "while(!fs.existsSync(barrier)){}",
    "const r=l.acquire(cwd,unit,{hostRuntime:host,ownerToken:token,ttlMs:5000,graceMs:100});",
    "process.stdout.write(JSON.stringify(r));"
  ].join('');
  return new Promise((resolve, reject) => {
    const processChild = childProcess.spawn(process.execPath, [
      '-e', source, path.join(__dirname, 'forge-unit-lease.js'), cwd, unit, hostRuntime, token, barrier,
    ], { shell: false });
    let output = ''; let error = '';
    processChild.stdout.on('data', data => { output += data; });
    processChild.stderr.on('data', data => { error += data; });
    processChild.on('error', reject);
    processChild.on('exit', code => resolve({ code, output, error }));
  });
}

async function testRealMultiProcessContention() {
  const cwd = temporary();
  const barrier = path.join(cwd, 'start barrier');
  try {
    const unit = 'execute-task/contended-測試';
    const attempts = [
      childAcquire(cwd, unit, 'claude', 'claude-process-owner', barrier),
      childAcquire(cwd, unit, 'codex', 'codex-process-owner', barrier),
      childAcquire(cwd, unit, 'claude', 'claude-process-owner-2', barrier),
      childAcquire(cwd, unit, 'codex', 'codex-process-owner-2', barrier),
    ];
    fs.writeFileSync(barrier, 'go', 'utf8');
    const results = await Promise.all(attempts);
    assert(results.every(entry => entry.code === 0 || entry.code === 1), 'CLI uses only success or contention exits');
    const parsed = results.map(entry => {
      assert.strictEqual(entry.error, '');
      return JSON.parse(entry.output);
    });
    const winners = parsed.filter(entry => entry.ok && entry.reason === 'acquired');
    const losers = parsed.filter(entry => !entry.ok && entry.reason === 'lease-active');
    assert.strictEqual(winners.length, 1, `exactly one durable winner: ${JSON.stringify(parsed)}`);
    assert.strictEqual(losers.length, 3, `all other owners are rejected: ${JSON.stringify(parsed)}`);
    for (const loser of losers) assertNoSecret(loser.lease);
  } finally { remove(cwd); }
}

function testInputBoundaryRejectsUnsafeValues() {
  sandbox(cwd => {
    assert.throws(() => lease.acquire(cwd, '', fixtureOptions(1, 'claude')), /unit inválida/);
    assert.throws(() => lease.acquire(cwd, 'safe\u0000unsafe', fixtureOptions(1, 'claude')), /unit inválida/);
    assert.throws(() => lease.acquire(cwd, 'safe', fixtureOptions(1, 'unknown-runtime')), /invalid-host-runtime/);
    assert.throws(() => lease.acquire(cwd, 'safe', fixtureOptions(1, 'claude', { session: '' })), /session inválido/);
    assert.throws(() => lease.acquire(cwd, 'safe', fixtureOptions(1, 'claude', { ttlMs: 0 })), /ttl deve ser positivo/);
  });
}

function testAcquirePerformsSafeRecoveryAfterGrace() {
  sandbox(cwd => {
    const unit = 'execute-task/acquire-recovery';
    const old = lease.acquire(cwd, unit, fixtureOptions(10, 'claude', { ownerToken: 'old-owner' }));
    const before = lease.acquire(cwd, unit, fixtureOptions(135, 'codex', { ownerToken: 'early-owner' }));
    assert.strictEqual(before.reason, 'expired-awaiting-grace');
    const successor = lease.acquire(cwd, unit, fixtureOptions(136, 'codex', { ownerToken: 'new-owner' }));
    assert.strictEqual(successor.reason, 'acquired');
    assert.strictEqual(successor.recovered.generation, old.generation);
    assert.strictEqual(successor.lease.host_runtime, 'codex');
    assert.notStrictEqual(successor.generation, old.generation);
    assert.deepStrictEqual(lease.release(cwd, unit, old.owner_token, old.generation), { ok: false, reason: 'owner-mismatch' });
    assert.strictEqual(lease.release(cwd, unit, successor.owner_token, successor.generation).reason, 'released');
  });
}

function testPidAndRunMetadataCannotAuthorizeTakeover() {
  sandbox(cwd => {
    const unit = 'execute-task/no-pid-authorization';
    const held = lease.acquire(cwd, unit, fixtureOptions(20, 'claude', { ownerToken: 'pid-owner' }));
    const file = lease.leaseFile(cwd, unit);
    const record = disk(cwd, unit);
    record.holder_pid = process.pid;
    record.holder_run_id = 'apparently-active-run';
    fs.writeFileSync(file, JSON.stringify(record), 'utf8');
    const blocked = lease.acquire(cwd, unit, fixtureOptions(21, 'codex', { ownerToken: 'not-authorized' }));
    assert.strictEqual(blocked.reason, 'lease-active');
    const recovered = lease.recover(cwd, unit, { now: () => 146 });
    assert.strictEqual(recovered.reason, 'recovered');
    assert.strictEqual(recovered.previous.generation, held.generation);
    assert.strictEqual(lease.observe(cwd, unit, { now: () => 146 }).lease, null);
  });
}

function testObjectAndStringUnitFormsNeverCreateParallelPaths() {
  sandbox(cwd => {
    const objectUnit = { type: 'complete-slice', id: 'S02' };
    const stringUnit = 'complete-slice/S02';
    assert.strictEqual(lease.mutexName(objectUnit), lease.mutexName(stringUnit));
    const one = lease.acquire(cwd, objectUnit, fixtureOptions(1, 'claude', { ownerToken: 'object-owner' }));
    const two = lease.acquire(cwd, stringUnit, fixtureOptions(2, 'codex', { ownerToken: 'string-owner' }));
    assert.strictEqual(two.reason, 'lease-active');
    assert.strictEqual(fs.readdirSync(lease.leasesDir(cwd)).filter(name => name.endsWith('.json')).length, 1);
    assert.strictEqual(lease.release(cwd, stringUnit, one.owner_token, one.generation).reason, 'released');
  });
}

function testProtocolAndSchemaReasonCodesDoNotDrift() {
  // The schema is a wire contract: keep storage, public status, and result
  // reason codes coupled to the executable module rather than a prose-only
  // promise. This remains dependency-free on every supported host.
  const schemaPath = path.join(__dirname, '..', 'schemas', 'forge-unit-lease.schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  assert.strictEqual(schema.$defs.protocolVersion.const, lease.PROTOCOL_VERSION);
  const declared = schema.$defs.reasonCode.enum.slice().sort();
  assert.deepStrictEqual(declared, lease.REASON_CODES.slice().sort());
  assert(schema.$defs.leaseRecord.required.includes('owner_token'));
  assert(schema.$defs.publicLease.required.includes('owner'));
  assert.strictEqual(Object.prototype.hasOwnProperty.call(schema.$defs.publicLease.properties, 'owner_token'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(schema.$defs.publicLease.properties, 'request_id'), false);
}

function testCliProducesMachineReadableResults() {
  // Keep the CLI boundary usable by non-Node orchestration hosts as well.
  sandbox(cwd => {
    const script = path.join(__dirname, 'forge-unit-lease.js');
    const acquired = childProcess.spawnSync(process.execPath, [
      script, '--acquire', 'execute-task/cli', '--cwd', cwd, '--host', 'claude', '--token', 'cli-owner', '--ttl', '500', '--grace', '50',
    ], { encoding: 'utf8', shell: false });
    assert.strictEqual(acquired.status, 0, acquired.stderr);
    const parsed = JSON.parse(acquired.stdout);
    assert.strictEqual(parsed.reason, 'acquired');
    const observed = childProcess.spawnSync(process.execPath, [
      script, '--observe', 'execute-task/cli', '--cwd', cwd,
    ], { encoding: 'utf8', shell: false });
    assert.strictEqual(observed.status, 0, observed.stderr);
    const publicResult = JSON.parse(observed.stdout);
    assert.strictEqual(publicResult.reason, 'lease-active');
    assertNoSecret(publicResult.lease);
    const rejected = childProcess.spawnSync(process.execPath, [
      script, '--release', 'execute-task/cli', '--cwd', cwd, '--token', 'wrong', '--generation', parsed.generation,
    ], { encoding: 'utf8', shell: false });
    assert.strictEqual(rejected.status, 1);
    const released = childProcess.spawnSync(process.execPath, [
      script, '--release', 'execute-task/cli', '--cwd', cwd, '--token', 'cli-owner', '--generation', parsed.generation,
    ], { encoding: 'utf8', shell: false });
    assert.strictEqual(released.status, 0, released.stderr);
    assert.strictEqual(JSON.parse(released.stdout).reason, 'released');
  });
}

function testLegacyOmissionUsesRuntimeBoundaryWithoutBackfill() {
  sandbox(cwd => {
    const unit = 'execute-task/legacy-input';
    const acquired = lease.acquire(cwd, unit, {
      now: () => 1,
      ttlMs: 100,
      graceMs: 25,
      ownerToken: 'legacy-owner',
    });
    assert.strictEqual(acquired.reason, 'acquired');
    assert.strictEqual(acquired.lease.host_runtime, 'claude');
    assert.strictEqual(disk(cwd, unit).session, null);
    const after = lease.observe(cwd, unit, { now: () => 2 });
    assert.strictEqual(after.lease.host_runtime, 'claude');
    assert.strictEqual(after.lease.session, null);
    assert.strictEqual(lease.release(cwd, unit, acquired.owner_token, acquired.generation).reason, 'released');
  });
}

function testObservationDoesNotMutateOrRecoverLease() {
  sandbox(cwd => {
    const unit = 'execute-task/passive-observer';
    const held = lease.acquire(cwd, unit, fixtureOptions(1, 'claude', { ownerToken: 'observer-owner' }));
    const expired = lease.observe(cwd, unit, { now: () => 127 });
    assert.strictEqual(expired.reason, 'recovered');
    assert.strictEqual(expired.lease.recoverable, true);
    assert.strictEqual(disk(cwd, unit).generation, held.generation, 'observe cannot take over or delete a lease');
    const ownerHeartbeat = lease.heartbeat(cwd, unit, held.owner_token, held.generation, fixtureOptions(128, 'codex'));
    assert.strictEqual(ownerHeartbeat.reason, 'renewed');
    assert.strictEqual(lease.observe(cwd, unit, { now: () => 129 }).reason, 'lease-active');
    assert.strictEqual(lease.release(cwd, unit, held.owner_token, held.generation).reason, 'released');
  });
}

function testRequestBoundReleaseAndSuccessor() {
  sandbox(cwd => {
    const unit = 'execute-task/request-bound';
    const options = fixtureOptions(1, 'codex', { ownerToken: 'owner', requestId: 'r'.repeat(1500) });
    const acquired = lease.acquire(cwd, unit, options);
    assert.strictEqual(lease.acquire(cwd, unit, options).reason, 'already-acquired');
    assert.strictEqual(lease.release(cwd, unit, 'owner', acquired.generation, { requestId: 'wrong' }).reason, 'owner-mismatch');
    assert.strictEqual(disk(cwd, unit).request_id, options.requestId);
    const child = childProcess.spawnSync(process.execPath, ['-e', `
      const fs = require('fs'); const lock = require(process.argv[1]); const lease = require(process.argv[2]);
      const cwd = process.argv[3], unit = process.argv[4];
      const guard = lock.acquireSync(cwd, lease.mutexName(unit));
      try { const file = lease.leaseFile(cwd, unit); const record = JSON.parse(fs.readFileSync(file));
        record.request_id = 'successor-request'; fs.writeFileSync(file, JSON.stringify(record));
      } finally { guard.release(); }
    `, path.join(__dirname, 'forge-lock.js'), path.join(__dirname, 'forge-unit-lease.js'), cwd, unit], { encoding: 'utf8' });
    assert.strictEqual(child.status, 0, child.stderr);
    assert.strictEqual(lease.release(cwd, unit, 'owner', acquired.generation, { requestId: options.requestId }).reason, 'owner-mismatch');
    assert.strictEqual(disk(cwd, unit).request_id, 'successor-request', 'the losing rollback retains the successor request');
    assert.strictEqual(lease.release(cwd, unit, 'owner', acquired.generation, { requestId: 'successor-request' }).reason, 'released');
    assert.strictEqual(lease.release(cwd, unit, 'owner', acquired.generation).reason, 'already-released', 'legacy four-argument API remains idempotent');
  });
}

async function main() {
  console.log(`forge-unit-lease tests on ${process.platform}`);
  await test('persisted shape and sanitized observe', testPersistedShapeAndSanitizedObserve);
  await test('owner token and generation authorize lifecycle', testOwnerTokenAndGenerationAreAuthorization);
  await test('same owner token and request are idempotent', testSameTokenRequestIsIdempotent);
  await test('grace boundary and recovery are clock controlled', testGraceBoundaryAndRecoveryAreClockControlled);
  await test('heartbeat does not survive a recovered generation', testHeartbeatWinsOnlyWhileItStillOwnsGeneration);
  await test('Unicode unit keys map to one cross-platform lease path', testUnicodePathsHaveOneLogicalLeaseFile);
  await test('failpoints preserve a single canonical record', testFailpointsLeaveAtMostOneCanonicalRecord);
  await test('invalid and interrupted records are recoverable', testInvalidOrInterruptedRecordRecoversWithoutPromotingTemp);
  await test('Claude and Codex directions obey the same lease rule', testRuntimeDirectionsAreSymmetric);
  await test('real Node processes contend for exactly one durable lease', testRealMultiProcessContention);
  await test('input boundary rejects unsafe values', testInputBoundaryRejectsUnsafeValues);
  await test('acquire performs recovery only after expiry plus grace', testAcquirePerformsSafeRecoveryAfterGrace);
  await test('PID and run metadata cannot authorize takeover', testPidAndRunMetadataCannotAuthorizeTakeover);
  await test('object and string forms use one lease path', testObjectAndStringUnitFormsNeverCreateParallelPaths);
  await test('schema and module reason codes do not drift', testProtocolAndSchemaReasonCodesDoNotDrift);
  await test('CLI returns machine-readable lifecycle results', testCliProducesMachineReadableResults);
  await test('legacy omission stays at the runtime input boundary', testLegacyOmissionUsesRuntimeBoundaryWithoutBackfill);
  await test('observation is passive even after expiry and grace', testObservationDoesNotMutateOrRecoverLease);
  await test('request-bound rollback refuses a successor published by another process', testRequestBoundReleaseAndSuccessor);
  await test('protected window is bounded, opaque, read-only and never revives an expired owner', testProtectedWindow);
  console.log('forge-unit-lease tests passed');
}

function testProtectedWindow() {
  sandbox(cwd => {
    let now = 10;
    const unit = 'execute-task/window', held = lease.acquire(cwd, unit, fixtureOptions(now, 'codex', { ownerToken: 'held' }));
    const open = () => lease.openProtectedWindow(cwd, unit, 'held', held.generation, { now: () => now, durationMs: 200 });
    assert.strictEqual(lease.openProtectedWindow(cwd, unit, 'foreign', held.generation, { durationMs: 1 }).ok, false);
    const window = open(), file = lease.leaseFile(cwd, unit), bytes = fs.readFileSync(file, 'utf8');
    assert(window.ok);
    assert.strictEqual(window.generation, held.generation);
    for (now of [20, 100, 209]) { assert(window.heartbeat().ok); assert.strictEqual(fs.readFileSync(file, 'utf8'), bytes); }
    lease.assertProtectedWindow(window, cwd, unit);
    assert.throws(() => lease.assertProtectedWindow(JSON.parse(JSON.stringify(window)), cwd, unit), /window-invalid/);
    assert.throws(() => lease.assertProtectedWindow(window, cwd, 'foreign'), /window-invalid/);
    now = 210;
    assert.strictEqual(window.check().ok, false);
    assert.strictEqual(window.close().ok, false);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), bytes, 'expiry and close must never revive ownership');
    assert.strictEqual(open().reason, 'expired-awaiting-grace');
    for (const durationMs of [0, -1, Infinity, 300001]) assert.throws(() => lease.openProtectedWindow(cwd, unit, 'held', held.generation, { durationMs }), /duration/);
    now = 236;
    const replacement = lease.acquire(cwd, unit, fixtureOptions(now, 'claude', { ownerToken: 'replacement' }));
    assert(replacement.ok);
    assert.strictEqual(open().ok, false);
    const next = lease.openProtectedWindow(cwd, unit, replacement.owner_token, replacement.generation, { now: () => now, durationMs: 50 });
    try { throw Error('fixture failure'); } catch (_) { /* cleanup is mandatory even on failure */ } finally { next.close(); }
    assert.throws(() => lease.assertProtectedWindow(next, cwd, unit), /window-invalid/);
    const active = lease.openProtectedWindow(cwd, unit, replacement.owner_token, replacement.generation, { now: () => now, durationMs: 50 });
    lease.release(cwd, unit, replacement.owner_token, replacement.generation);
    assert.strictEqual(active.heartbeat().ok, false, 'release/replacement invalidates a live handle');
  });
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
