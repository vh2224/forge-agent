'use strict';

const assert = require('assert');
const { createNotificationReducer, itemFingerprint, TOOL_ITEM_TYPES } = require('./forge-appserver-liveness');

let t = 0;
const clock = () => t;
const note = (method, item) => ({ method, params: item ? { item } : {} });
const started = item => note('item/started', item);
const completed = item => note('item/completed', item);
const cmd = (id, command = 'echo hi') => ({ id, type: 'commandExecution', command, cwd: '/w' });

function fresh(extra = {}) {
  t = 0;
  return createNotificationReducer({ clock, ...extra });
}

// remote vs local lifecycle
{
  const r = fresh();
  t = 10; r.push(note('thread/started'));
  r.push(note('item/agentMessage/delta'));
  assert.strictEqual(r.snapshot().remote_event_count, 0, 'pre-turnSent is never remote');
  assert.strictEqual(r.snapshot().event_count, 2);
  assert.strictEqual(r.snapshot().remote_silence_ms, null);
  assert.strictEqual(r.snapshot().phase, 'local-start');
  t = 20; r.turnSent();
  r.push(note('turn/started'));
  r.push(started({ id: 'u1', type: 'userMessage' }));
  r.push(completed({ id: 'u1', type: 'userMessage' }));
  assert.strictEqual(r.snapshot().remote_event_count, 0, 'local lifecycle is not remote');
  t = 30; r.push(note('item/agentMessage/delta'));
  let s = r.snapshot();
  assert.strictEqual(s.remote_event_count, 1);
  assert.strictEqual(s.first_remote_ms, 30);
  assert.strictEqual(s.phase, 'remote-activity');
  assert.strictEqual(s.version, 1);
  r.push({ id: 7, result: {} });
  assert.strictEqual(r.snapshot().event_count, s.event_count, 'responses with id are ignored');
  // silence with fake clock
  t = 55; s = r.snapshot();
  assert.strictEqual(s.remote_silence_ms, 25);
  assert.strictEqual(s.last_remote_ms, 30);
  assert.strictEqual(s.elapsed_ms, 55);
  r.push(note('turn/completed'));
  assert.strictEqual(r.snapshot().phase, 'terminal');
}

// tool open/close by id, non-suspending types
{
  const r = fresh();
  r.turnSent();
  for (const type of TOOL_ITEM_TYPES) r.push(started({ id: 'x-' + type, type }));
  assert.strictEqual(r.snapshot().tools_in_flight, TOOL_ITEM_TYPES.length);
  assert.strictEqual(r.snapshot().gap_suspended, true);
  for (const type of TOOL_ITEM_TYPES) r.push(completed({ id: 'x-' + type, type }));
  assert.strictEqual(r.snapshot().gap_suspended, false);
  for (const type of ['agentMessage', 'reasoning', 'plan', 'brandNewType']) {
    r.push(started({ id: 'n-' + type, type }));
  }
  assert.strictEqual(r.snapshot().gap_suspended, false, 'non-tool and unknown types never suspend');
  assert.strictEqual(r.snapshot().tools_in_flight, 0);
  assert.strictEqual(r.snapshot().remote_event_count, TOOL_ITEM_TYPES.length * 2 + 4);
  r.push(started(cmd('a'))); r.push(started(cmd('b')));
  r.push(completed(cmd('a')));
  assert.strictEqual(r.snapshot().gap_suspended, true, 'b still open');
  r.push(completed(cmd('b')));
  assert.strictEqual(r.snapshot().gap_suspended, false);
}

// fingerprint dedupe, equality and distinction, no text leak
{
  const calls = [];
  const r = fresh({ onToolCall: call => calls.push(call) });
  r.turnSent();
  const SECRET = 'SENTINEL-secret-argument-text';
  r.push(started(cmd('a', SECRET)));
  r.push(started(cmd('a', SECRET)));
  assert.strictEqual(calls.length, 1, 'once per item.id');
  assert.match(calls[0].fingerprint, /^[0-9a-f]{64}$/);
  assert.deepStrictEqual(Object.keys(calls[0]), ['fingerprint']);
  r.push(started(cmd('b', SECRET)));
  assert.strictEqual(calls[1].fingerprint, calls[0].fingerprint, 'same fields -> same fingerprint');
  r.push(started(cmd('c', 'other command')));
  assert.notStrictEqual(calls[2].fingerprint, calls[0].fingerprint, 'distinct fields -> distinct fingerprint');
  r.push(started({ id: 'd', type: 'agentMessage' }));
  assert.strictEqual(calls.length, 3, 'non-tool never fingerprints');
  assert.strictEqual(JSON.stringify([r.snapshot(), calls]).includes(SECRET), false, 'no argument text leaks');
  assert.notStrictEqual(itemFingerprint({ type: 'webSearch', query: 'q' }), itemFingerprint({ type: 'imageView', path: 'q' }));
  assert.strictEqual(itemFingerprint({ type: 'imageGeneration' }).length, 64);
  assert.strictEqual(itemFingerprint({ type: 'fileChange', changes: [{ path: 'a', kind: 'add', diff: 'x' }] }),
    itemFingerprint({ type: 'fileChange', changes: [{ path: 'a', kind: 'add', diff: 'y' }] }), 'only closed fields count');
  assert.strictEqual(itemFingerprint({ type: 'agentMessage' }), null);
  assert.strictEqual(itemFingerprint(null), null);
}

// malformed input never throws or counts
{
  const r = fresh({ onToolCall() { throw new Error('boom'); } });
  r.turnSent();
  for (const bad of [null, undefined, 'x', 42, [], {}, { method: 5 }, { method: 'item/started' },
    { method: 'item/started', params: null }, { method: 'item/started', params: { item: 'str' } },
    { method: 'item/started', params: { item: { type: 'commandExecution' } } },
    { method: 'item/started', params: { item: { id: {}, type: 'commandExecution' } } },
    { method: 'item/completed', params: { item: { type: 'sleep' } } }]) {
    assert.doesNotThrow(() => r.push(bad));
  }
  assert.strictEqual(r.snapshot().gap_suspended, false, 'items without id never suspend');
  assert.doesNotThrow(() => r.push(started(cmd('ok'))), 'throwing callback is contained');
}

// bounded open map
{
  const r = fresh({ maxOpenItems: 4 });
  r.turnSent();
  for (let i = 0; i < 50; i++) r.push(started(cmd('i' + i)));
  assert.strictEqual(r.snapshot().tools_in_flight, 4);
  const big = createNotificationReducer({ clock });
  big.turnSent();
  for (let i = 0; i < 1000; i++) big.push(started(cmd('j' + i)));
  assert.strictEqual(big.snapshot().tools_in_flight, 256, 'default cap is 256');
}

// local status/startup notifications are not provider activity
{
  const r = fresh();
  r.turnSent();
  t += 100;
  r.push({ method: 'thread/status/changed', params: { status: { type: 'active' } } });
  r.push({ method: 'mcpServer/startupStatus/updated', params: {} });
  const snap = r.snapshot();
  assert.strictEqual(snap.remote_event_count, 0);
  assert.strictEqual(snap.phase, 'local-start');
}

console.log('forge-appserver-liveness: ok');
