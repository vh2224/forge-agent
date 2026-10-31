'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const api = require('./forge-native-supervision');
function clock(initial = 100000) {
  let now = initial, id = 0; const timers = new Map();
  return { wall: () => now, monotonic: () => now,
    setTimeout(fn, ms) { timers.set(++id, { at: now + ms, fn }); return id; },
    clearTimeout(key) { timers.delete(key); }, size: () => timers.size, crash: () => timers.clear(),
    jump(ms) { now += ms; },
    fire() { for (const [key,t] of [...timers]) if(t.at <= now) { timers.delete(key); t.fn(); } },
    async advance(ms) { now += ms; for (let n = 0; n < 20; n++) { await Promise.resolve();
      const ready = [...timers].filter(([, t]) => t.at <= now);
      for (const [key, t] of ready) { timers.delete(key); t.fn(); }
    } },
  };
}
async function run() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-native-supervision-')));
  let serial = 0;
  const base = c => ({ clock: c, identity: 'a'.repeat(64), route: { tier: 'light', workers_timeout: 1,
    workers_timeout_source: 'explicit' }, terminal: value => value?.status === 'done',
    journal: { root, file: path.join(root, `${++serial}.json`), authorize: () => true } });
  const c = clock(); let settle;
  const pending = api.supervise(base(c), () => new Promise(resolve => { settle = resolve; }));
  await c.advance(0);
  await c.advance(1000); const cut = await pending;
  assert.equal(cut.reason_code, 'native-safety-ceiling');
  assert.equal(cut.lifecycle.activity, 'unknown'); assert.equal(cut.lifecycle.possible_writer, true);
  assert.equal(c.size(), 0);
  settle({ status: 'done' }); await c.advance(0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '1.json'))).late_terminal, true);
  const c2 = clock(); let emit, disposed = 0;
  const opts = base(c2);
  opts.adapter = { capabilities: { result: true, remote_events: true },
    acknowledge: value => value?.agent_id === 'worker' ? 'worker' : null,
    subscribe(handle, callback) { assert.equal(handle, 'worker'); emit = callback; return () => disposed++; } };
  const ack = api.supervise(opts, async () => ({ agent_id: 'worker' }));
  await c2.advance(0); assert.equal(typeof emit, 'function');
  emit({ identity: opts.identity, sequence: 1, kind: 'work', text: 'working' });
  emit({ identity: opts.identity, sequence: 2, kind: 'terminal', result: { status: 'done' } });
  const done = await ack; assert.equal(done.ok, true); assert.equal(disposed, 1); assert.equal(c2.size(), 0);
  const c3 = clock(), o3 = base(c3); let cancelled = 0;
  o3.adapter = { capabilities: { cancel: true }, cancel() { cancelled++; return new Promise(() => {}); } };
  const cancel = api.supervise(o3, () => new Promise(() => {})); await c3.advance(0); await c3.advance(1000);
  assert.equal((await cancel).lifecycle.stopped, 'unknown'); assert.equal(cancelled, 1); assert.equal(c3.size(), 0);
  const c4 = clock(), o4 = base(c4); let invokes = 0;
  fs.writeFileSync(o4.journal.file, JSON.stringify({ identity: 'foreign' }));
  await assert.rejects(() => api.supervise(o4, () => { invokes++; }), /native-journal/);
  assert.equal(invokes, 0);
  const invalid = await api.supervise(base(clock()), async () => ({ agent_id: 'only-ack' }));
  assert.equal(invalid.reason_code, 'native-terminal-unobserved'); assert.equal(invalid.lifecycle.possible_writer, true);
  // Known observation channels use canonical startup/silence thresholds. Fake
  // waits, foreign/empty/stale events cannot extend the original clock.
  const c5 = clock(), o5 = base(c5); let events;
  o5.policy = { startMs: 10, suspectMs: 10, deadMs: 20, toolExtensionMs: 30 };
  o5.adapter = { capabilities: { result: true, remote_events: true, open_tools: true },
    acknowledge: () => 'same', subscribe: (h, cb) => { events = cb; return () => {}; } };
  const watched = api.supervise(o5, async () => ({ agent_id: 'same' })); await c5.advance(0);
  events({ identity: o5.identity, sequence: 1, kind: 'work', text: 'own work' });
  await c5.advance(10);
  events({ identity: 'foreign', sequence: 99, kind: 'work', text: 'foreign' });
  events({ identity: o5.identity, sequence: 2, kind: 'work', text: ' ' });
  events({ identity: o5.identity, sequence: 3, kind: 'running' });
  events({ identity: o5.identity, sequence: 1, kind: 'work', text: 'stale' });
  await c5.advance(22);
  assert.equal((await watched).reason_code, 'dead-silence');
  const persisted = JSON.parse(fs.readFileSync(o5.journal.file));
  assert.equal(persisted.sequence, 1); assert(!JSON.stringify(persisted).includes('own work'));
  // Restart binds the same handle and original wall deadline; no new invoke.
  const c6 = clock(), o6 = base(c6); let calls = 0;
  const first = api.supervise(o6, () => new Promise(() => {})); await c6.advance(0); await c6.advance(1000); await first;
  o6.adapter = { capabilities: { resume: true }, resume() { calls++; } };
  const resumed = await api.supervise(o6, () => { throw Error('must never restart writer'); });
  assert.equal(resumed.reason_code, 'native-safety-ceiling'); assert.equal(calls, 0);
  assert.equal(resumed.lifecycle.deadline_wall_ms, 101000);
  // Capture late terminal only, without another terminal/publication outcome.
  const c7 = clock(), o7 = base(c7); let late, captures = 0;
  o7.captureLateResult = value => { assert.equal(value.status, 'done'); captures++; };
  const p7 = api.supervise(o7, () => new Promise(resolve => { late = resolve; }));
  await c7.advance(0);
  await c7.advance(1000); assert.equal((await p7).ok, false);
  late({ status: 'done' }); await c7.advance(0); assert.equal(captures, 1); assert.equal(c7.size(), 0);
  // Tool state permits only the existing bounded extension.
  const c8 = clock(), o8 = base(c8); let toolEvents;
  o8.policy = o5.policy;
  o8.adapter = { ...o5.adapter, subscribe: (h, cb) => { toolEvents = cb; return () => {}; } };
  const toolRun = api.supervise(o8, async () => ({ agent_id: 'same' })); await c8.advance(0);
  toolEvents({ identity: o8.identity, sequence: 1, kind: 'tool', open: true });
  await c8.advance(30); assert.equal(c8.size(), 1);
  await c8.advance(25); assert.equal((await toolRun).reason_code, 'dead-silence'); assert.equal(c8.size(), 0);
  const c9 = clock(), o9 = base(c9); let raceResolve;
  const race = api.supervise(o9, () => new Promise(resolve => { raceResolve = resolve; }));
  await c9.advance(0); raceResolve({ status: 'done' });
  await c9.advance(1000); assert.equal((await race).ok, false, 'deadline wins even before its scheduled tick');
  const c10 = clock(), o10 = base(c10);
  o10.adapter = { capabilities: { remote_events: true } }; o10.policy = o5.policy;
  const startup = api.supervise(o10, () => new Promise(() => {})); await c10.advance(0); await c10.advance(11);
  assert.equal((await startup).reason_code, 'dead-start');
  const noJournal = { ...base(clock()), journal: undefined, resume: true };
  await assert.rejects(() => api.supervise(noJournal, () => assert.fail('must not spawn')), /native-journal-required/);
  const importedJournal = base(clock()); delete importedJournal.journal.authorize;
  await assert.rejects(() => api.supervise(importedJournal, () => assert.fail('must not spawn')), /native-journal-authority-required/);
  const ca = clock(), oa = base(ca); let launchCount = 0, originalEvents;
  oa.adapter = { capabilities: { result: true, remote_events: true }, acknowledge: value => value.agent_id,
    subscribe: (h, cb) => { originalEvents = cb; return () => {}; } };
  api.supervise(oa, async () => { launchCount++; return { agent_id: 'durable' }; });
  await ca.advance(0);
  originalEvents({ identity: oa.identity, sequence: 7, kind: 'work', text: 'observed progress' });
  ca.crash(); // Simulated loss of the process, not cancellation/stop evidence.
  const cb = clock(100400); let resumedEvents, resumes = 0;
  const restored = { ...oa, clock: cb, adapter: { ...oa.adapter,
    capabilities: { result: true, remote_events: true, resume: true },
    resume: state => { resumes++; assert.equal(state.sequence, 7); return { agent_id: 'durable' }; },
    subscribe: (h, fn) => { resumedEvents = fn; return () => {}; } } };
  const reconnect = api.supervise(restored, () => { launchCount++; assert.fail('no replacement launch'); });
  await cb.advance(0); assert.equal(resumes, 1); assert.equal(launchCount, 1);
  resumedEvents({ identity: oa.identity, sequence: 7, kind: 'work', text: 'stale' });
  await cb.advance(600); const restoredCut = await reconnect;
  assert.equal(restoredCut.ok, false); assert.equal(restoredCut.lifecycle.deadline_wall_ms, 101000);
  assert.equal(restoredCut.lifecycle.sequence, 7); assert.equal(cb.size(), 0);
  const backwards = { ...restored, clock: clock(99999) };
  await assert.rejects(() => api.supervise(backwards, () => assert.fail('no spawn')), /native-journal-identity-or-clock/);
  const escape = base(clock()); escape.journal.file = path.join(root, '..', 'foreign.json');
  await assert.rejects(() => api.supervise(escape, () => assert.fail('no spawn')), /native-journal-path/);
  for (const resume of [false,true]) for (const fire of [false,true]) {
    const launchClock=clock(), launchOptions=base(launchClock); let launches=0, resumes=0;
    if(resume) {
      await api.supervise(launchOptions, () => { throw Error('fixture interrupted attempt'); });
      launchOptions.adapter={capabilities:{resume:true},resume(){resumes++;return {status:'done'};}};
    }
    const delayed=api.supervise(launchOptions,()=>{launches++;return {status:'done'};});
    launchClock.jump(1000); if(fire) launchClock.fire();
    const delayedResult=await delayed;
    assert.equal(delayedResult.ok,false); assert.equal(launches,0,'no launch after scheduled cutoff');
    assert.equal(resumes,0,'no resume after scheduled cutoff'); assert.equal(launchClock.size(),0);
  }
  // Expired startup/silence limits and wall rollbacks win over a late event or terminal.
  for (const kind of ['work', 'terminal']) for (const rollback of [false, true]) {
    const lc = clock(), lo = base(lc); let lemit;
    lo.route = { tier: 'light', workers_timeout: 60, workers_timeout_source: 'explicit' };
    lo.policy = { startMs: 10, suspectMs: 10, deadMs: 20, toolExtensionMs: 30 };
    lo.adapter = { capabilities: { result: true, remote_events: true },
      acknowledge: () => 'late', subscribe: (h, cb) => { lemit = cb; return () => {}; } };
    const late = api.supervise(lo, async () => ({ agent_id: 'late' }));
    await lc.advance(0);
    if (rollback) lc.jump(-5); else lc.jump(500);
    lemit(kind === 'work' ? { identity: lo.identity, sequence: 1, kind: 'work', text: 'late' }
      : { identity: lo.identity, sequence: 1, kind: 'terminal', result: { status: 'done' } });
    const lateResult = await late;
    assert.equal(lateResult.ok, false, `${kind}/${rollback} must not revive the attempt`);
    assert.equal(lateResult.reason_code, rollback ? 'native-clock-inconsistent' : 'dead-start');
    assert.equal(lateResult.lifecycle.first_remote_ms, null);
  }

  // S03/T02: the host identity observer writes only the external journal.
  const hostValue = '/root/experience_s02_t07_334497b58af1';
  const readJournal = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const ci = clock(), oi = { ...base(ci), dispatchId: 'dispatch-s03-t02' }; let seen, finishRun;
  const idRun = api.supervise(oi, observer => { seen = observer; return new Promise(resolve => { finishRun = resolve; }); });
  await ci.advance(0); await ci.advance(5);
  assert(Object.isFrozen(seen)); assert.deepEqual(Object.keys(seen), ['hostIdentity']);
  for (const invalid of ['', 'bad value', 'a\x1b[31m', 'x'.repeat(257), 7, null]) {
    assert.deepEqual(seen.hostIdentity(invalid), { ok: false, reason_code: 'native-host-identity-invalid' });
  }
  assert(!('host_identity' in readJournal(oi.journal.file)), 'invalid values are not recorded');
  assert.deepEqual(seen.hostIdentity(hostValue), { ok: true });
  const firstRecord = { value: hostValue, source: 'host-tool-return', observed_ms: 5, dispatch_id: 'dispatch-s03-t02', conflict: false };
  assert.deepEqual(readJournal(oi.journal.file).host_identity, firstRecord);
  const afterFirst = fs.readFileSync(oi.journal.file);
  assert.deepEqual(seen.hostIdentity(hostValue), { ok: true });
  assert(fs.readFileSync(oi.journal.file).equals(afterFirst), 'same value is a no-op');
  assert.deepEqual(seen.hostIdentity('/root/other'), { ok: false, reason_code: 'native-host-identity-conflict' });
  assert.deepEqual(readJournal(oi.journal.file).host_identity, { ...firstRecord, conflict: true }, 'conflict keeps the first value');
  finishRun({ status: 'done' });
  const idDone = await idRun;
  assert.equal(idDone.ok, true); assert.deepEqual(idDone.lifecycle.host_identity, { ...firstRecord, conflict: true });
  idDone.lifecycle.host_identity.value = 'mutated';
  assert.equal(readJournal(oi.journal.file).host_identity.value, hostValue);
  const terminalBytes = fs.readFileSync(oi.journal.file);
  for (const late of [hostValue, '/root/late']) {
    assert.deepEqual(seen.hostIdentity(late), { ok: false, reason_code: 'native-host-identity-after-terminal' });
  }
  assert(fs.readFileSync(oi.journal.file).equals(terminalBytes), 'late identity cannot alter the journal');
  const cc = clock(), oc = base(cc); let cutObserver;
  const cutRun = api.supervise(oc, observer => { cutObserver = observer; return new Promise(() => {}); });
  await cc.advance(0); await cc.advance(1000); assert.equal((await cutRun).ok, false);
  const cutBytes = fs.readFileSync(oc.journal.file);
  assert.deepEqual(cutObserver.hostIdentity(hostValue), { ok: false, reason_code: 'native-host-identity-after-terminal' });
  assert(fs.readFileSync(oc.journal.file).equals(cutBytes));
  console.log(`EXAMPLE S03/T02 journal with host_identity: ${fs.readFileSync(oi.journal.file, 'utf8')}`);
  console.log('PASS S03/T02 supervision host identity: frozen observer, first valid value in the external journal, invalid unrecorded, same value no-op, conflict keeps the first, after terminal or cutoff refused without journal change');

  const memory = await api.supervise({ ...base(clock()), journal: undefined, dispatchId: 'unsafe dispatch id' },
    observer => { assert.deepEqual(observer.hostIdentity(hostValue), { ok: true }); return { status: 'done' }; });
  assert.equal(memory.lifecycle.persistence, 'unavailable');
  assert.deepEqual(memory.lifecycle.host_identity, { value: hostValue, source: 'host-tool-return', observed_ms: 0, dispatch_id: null, conflict: false });
  const quiet = base(clock());
  const quietRun = await api.supervise(quiet, () => ({ status: 'done' }));
  assert(!('host_identity' in quietRun.lifecycle) && !('host_identity' in readJournal(quiet.journal.file)));
  console.log('PASS S03/T02 supervision without journal or observation: in-memory lifecycle record with unsafe dispatch as null; no key when the host reports nothing');

  const or = { ...base(clock()), dispatchId: 'dispatch-resume' };
  await api.supervise(or, observer => { observer.hostIdentity(hostValue); throw Object.assign(Error('fixture'), { code: 'fixture-interrupted' }); });
  const saved = readJournal(or.journal.file);
  assert.equal(saved.phase, 'interrupted'); assert.equal(saved.host_identity.value, hostValue);
  let reattaches = 0;
  const reattach = { capabilities: { resume: true }, resume: () => { reattaches++; return { status: 'done' }; } };
  const resumeWith = (journal, dispatchId = 'dispatch-resume') => {
    fs.writeFileSync(or.journal.file, JSON.stringify(journal));
    return api.supervise({ ...or, dispatchId, clock: clock(100500), adapter: reattach }, () => assert.fail('no relaunch'));
  };
  const resumedOk = await resumeWith(saved);
  assert.equal(resumedOk.ok, true); assert.deepEqual(resumedOk.lifecycle.host_identity, saved.host_identity);
  assert.deepEqual(readJournal(or.journal.file).host_identity, saved.host_identity);
  const nullRecord = await resumeWith({ ...saved, host_identity: null });
  assert.equal(nullRecord.ok, true); assert(!('host_identity' in nullRecord.lifecycle));
  const { host_identity: _dropped, ...oldJournal } = saved;
  const oldResumed = await resumeWith(oldJournal);
  assert.equal(oldResumed.ok, true); assert(!('host_identity' in oldResumed.lifecycle), 'journals without the key resume as before');
  const invalidRecords = [
    ['observed after the elapsed clock', { ...saved, host_identity: { ...saved.host_identity, observed_ms: 10000000 } }],
    ['invalid saved value', { ...saved, host_identity: { ...saved.host_identity, value: 'bad value' } }],
    ['unknown source', { ...saved, host_identity: { ...saved.host_identity, source: 'task-name' } }],
    ['extra key', { ...saved, host_identity: { ...saved.host_identity, extra: true } }],
    ['not a record', { ...saved, host_identity: hostValue }],
  ];
  const before = reattaches;
  for (const [label, journal] of invalidRecords) {
    await assert.rejects(() => resumeWith(journal), /native-journal-identity-or-clock/, label);
  }
  await assert.rejects(() => resumeWith(saved, 'dispatch-other'), /native-journal-identity-or-clock/, 'foreign dispatch binding');
  assert.equal(reattaches, before, 'refused journals never reattach');
  console.log('PASS S03/T02 supervision resume: valid host_identity survives restart, null or absent key resumes as before, invalid record, clock or dispatch refused');

  // Issue 297: the journal, observer and resume keep canonical recovery dispatches intact.
  const { recoveryDispatchId } = require('./forge-recovery-dispatch-id');
  const real124 = recoveryDispatchId('M-20261028132636-fixture-S03-T02-native-dispatch-'.padEnd(78, 'x'),
    '0f8e2d9c-1b7a-4c3e-9d5f-6a2b1c0e7f48');
  const real128 = recoveryDispatchId('p'.repeat(128), '0f8e2d9c-1b7a-4c3e-9d5f-6a2b1c0e7f48');
  assert.equal(real124.length, 124); assert.equal(real128.length, 128);
  const sized = length => 'd'.repeat(length - 2) + '-1';
  for (const dispatchId of [sized(120), sized(121), real124, real128]) {
    const options = { ...base(clock()), dispatchId };
    const observed = await api.supervise(options, observer => { assert.deepEqual(observer.hostIdentity(hostValue), { ok: true }); return { status: 'done' }; });
    assert.equal(observed.lifecycle.host_identity.dispatch_id, dispatchId, `journal binding ${dispatchId.length}`);
    assert.equal(readJournal(options.journal.file).host_identity.dispatch_id, dispatchId);
  }
  for (const dispatchId of [sized(129), 'dispatch with space', `${real124}\n`]) {
    const refused = await api.supervise({ ...base(clock()), dispatchId }, observer => { observer.hostIdentity(hostValue); return { status: 'done' }; });
    assert.equal(refused.lifecycle.host_identity.dispatch_id, null, 'an unsafe dispatch binds nothing');
  }
  console.log('PASS issue297 supervision: the observer records 120/121/124/128 dispatches exactly in the external journal; 129 or invalid binds null');
  for (const dispatchId of [real124, real128]) {
    const options = { ...base(clock()), dispatchId };
    await api.supervise(options, observer => { observer.hostIdentity(hostValue); throw Object.assign(Error('fixture'), { code: 'fixture-interrupted' }); });
    const interrupted = readJournal(options.journal.file);
    assert.equal(interrupted.host_identity.dispatch_id, dispatchId);
    const reattachLong = { capabilities: { resume: true }, resume: () => ({ status: 'done' }) };
    const resumedLong = await api.supervise({ ...options, clock: clock(100500), adapter: reattachLong }, () => assert.fail('no relaunch'));
    assert.equal(resumedLong.ok, true); assert.equal(resumedLong.lifecycle.host_identity.dispatch_id, dispatchId);
    fs.writeFileSync(options.journal.file, JSON.stringify(interrupted));
    const other = dispatchId === real124 ? real128 : real124;
    for (const foreign of [other, dispatchId.slice(0, 120), sized(129)]) {
      await assert.rejects(() => api.supervise({ ...options, dispatchId: foreign, clock: clock(100500), adapter: reattachLong },
        () => assert.fail('no relaunch')), /native-journal-identity-or-clock/, `resume ${foreign.length}`);
    }
  }
  console.log('PASS issue297 supervision resume: 124/128 journals resume with the exact dispatch; foreign, truncated and 129 dispatches refused without reattach');
  console.log('native supervision discriminating tests passed');
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run, clock };
