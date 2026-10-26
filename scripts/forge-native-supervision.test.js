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
  const cancel = api.supervise(o3, () => new Promise(() => {})); await c3.advance(1000);
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
  const first = api.supervise(o6, () => new Promise(() => {})); await c6.advance(1000); await first;
  o6.adapter = { capabilities: { resume: true }, resume() { calls++; } };
  const resumed = await api.supervise(o6, () => { throw Error('must never restart writer'); });
  assert.equal(resumed.reason_code, 'native-safety-ceiling'); assert.equal(calls, 0);
  assert.equal(resumed.lifecycle.deadline_wall_ms, 101000);
  // Capture late terminal only, without another terminal/publication outcome.
  const c7 = clock(), o7 = base(c7); let late, captures = 0;
  o7.captureLateResult = value => { assert.equal(value.status, 'done'); captures++; };
  const p7 = api.supervise(o7, () => new Promise(resolve => { late = resolve; }));
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
  const startup = api.supervise(o10, () => new Promise(() => {})); await c10.advance(11);
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
  console.log('native supervision discriminating tests passed');
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run, clock };
