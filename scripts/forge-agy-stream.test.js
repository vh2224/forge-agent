#!/usr/bin/env node
'use strict';

// Pure reducer only: fake clock, synthetic NDJSON, no process and no provider.
const assert = require('node:assert/strict');
const { test: nodeTest } = require('node:test');
const liveness = require('./forge-sidecar-liveness');
const { createReducer, normalizeEvent, LIMITS, TOOL_STEP_TYPES, CLOSING_STATES } = require('./forge-agy-stream');

// Delivery binds named successful assertions to exact, timing-independent lines.
function test(name, run) {
  return nodeTest(name, async (...args) => {
    await run(...args);
    process.stdout.write(`PASS agy-stream: ${name}\n`);
  });
}

function harness() {
  const clock = { now: 0 };
  const reducer = createReducer({ clock: () => clock.now });
  const push = (value, at) => {
    if (at !== undefined) clock.now = at;
    reducer.push(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value) + '\n');
    return reducer.snapshot();
  };
  return { clock, reducer, push };
}
const init = (id = 'conv-1') => ({ event: 'init', conversation_id: id });
const step = (index, state, type, extra = {}) => ({ event: 'step_update',
  step_update: { conversation_id: 'conv-1', step_index: index, state, step_type: type, ...extra } });
const result = (status, response, extra = {}) => ({ event: 'result', conversation_id: 'conv-1', status, ...(response === undefined ? {} : { response }), ...extra });

test('LIMITS and vocabularies are frozen with the documented values', () => {
  assert.deepEqual({ ...LIMITS }, { line: 1048576, stdout: 16777216, stderr: 1048576, events: 100000,
    reconstruction: 1048576, openTools: 32, idBytes: 256 });
  assert(Object.isFrozen(LIMITS) && Object.isFrozen(TOOL_STEP_TYPES) && Object.isFrozen(CLOSING_STATES));
  assert.deepEqual([...TOOL_STEP_TYPES], ['tool']);
  assert.deepEqual([...CLOSING_STATES], ['DONE']);
});

test('initial snapshot uses the liveness contract names', () => {
  const { reducer } = harness();
  assert.deepEqual(reducer.snapshot(), { version: 1, phase: 'local-start', elapsed_ms: 0, stdout_bytes: 0,
    stderr_bytes: 0, event_count: 0, remote_event_count: 0, first_remote_ms: null, last_remote_ms: null,
    remote_silence_ms: null, gap_suspended: false, tools_in_flight: 0, suspension_epoch: 0 });
});

test('only new well-formed state changes are progress', () => {
  const { push, clock, reducer } = harness();
  let snap = push(init(), 10);
  assert.equal(snap.first_remote_ms, 10);
  assert.equal(snap.last_remote_ms, 10);
  assert.equal(snap.phase, 'remote-activity');
  snap = push(step(0, 'ACTIVE', 'agent_response', { text: 'a' }), 20);
  assert.equal(snap.last_remote_ms, 20);
  assert.equal(snap.remote_event_count, 2);

  const hostile = [
    '{"event":"step_update"',                      // bytes without newline
    '\n',                                          // completes it as malformed JSON
    'not json at all\n',
    Buffer.from([0xff, 0xfe, 0x7b, 0x0a]),         // invalid UTF-8
    '[1]\n', 'null\n', '"text"\n',
    JSON.stringify({ foo: 1 }) + '\n',             // no event
    JSON.stringify({ event: 'telemetry', conversation_id: 'conv-1' }) + '\n',
    JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'conv-1', state: 'ACTIVE' } }) + '\n',
    JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: 1.5, state: 'ACTIVE' } }) + '\n',
    JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: -1, state: 'ACTIVE' } }) + '\n',
    JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: 2 } }) + '\n',
    JSON.stringify({ event: 'step_update', step_index: 2, state: 'ACTIVE' }) + '\n',
    JSON.stringify(step(2, 'ACTIVE', 'agent_response', { conversation_id: 'conv-2' })) + '\n',
    JSON.stringify(step(0, 'ACTIVE', 'agent_response', { text: 'a' })) + '\n', // identical line
    JSON.stringify(step(0, 'active', 'AGENT_RESPONSE', { text: 'a', ignored: true })) + '\n', // same semantic state
    JSON.stringify(init('conv-9')) + '\n',         // a second init never replaces the conversation
  ];
  clock.now = 30;
  for (const chunk of hostile) {
    const before = reducer.snapshot();
    assert.doesNotThrow(() => reducer.push(chunk));
    const after = reducer.snapshot();
    assert.equal(after.remote_event_count, before.remote_event_count, `remote moved for ${chunk}`);
    assert.equal(after.last_remote_ms, 20, `last moved for ${chunk}`);
    assert.equal(after.first_remote_ms, 10);
    assert.equal(after.suspension_epoch, 0);
    assert(after.stdout_bytes > before.stdout_bytes);
  }
  const counted = reducer.snapshot();
  assert.equal(counted.event_count, 2 + hostile.length - 1, 'every complete line is counted, partial bytes are not');

  // Unknown fields are ignored on an otherwise new event.
  snap = push(step(3, 'ACTIVE', 'agent_response', { text: 'b', unknown_field: { nested: true } }), 40);
  assert.equal(snap.last_remote_ms, 40);
});

test('an id over the byte limit or a non-string state is never progress', () => {
  const { push } = harness();
  let snap = push(init('x'.repeat(LIMITS.idBytes + 1)), 5);
  assert.equal(snap.first_remote_ms, null);
  snap = push({ event: 'step_update', step_update: { step_index: 0, state: 7 } }, 6);
  assert.equal(snap.remote_event_count, 0);
  assert.equal(normalizeEvent({ event: 'step_update', step_update: { step_index: 0, state: 'x'.repeat(33) } }), null);
});

test('unknown states/types and absent conversation identity cannot renew life', () => {
  const { push, reducer } = harness();
  push(init(), 1);
  for (const event of [step(1, 'ERROR', 'tool'), step(2, 'FAILED', 'tool'), step(3, 'CANCELLED', 'tool'),
    step(4, 'ACTIVE', 'tool_call'), step(5, 'ACTIVE', 'command'), step(6, 'ACTIVE', 'unknown'),
    step(7, 'ACTIVE', 'tool', { conversation_id: undefined })]) {
    push(event, 10);
    assert.deepEqual([reducer.snapshot().last_remote_ms, reducer.snapshot().remote_event_count,
      reducer.snapshot().suspension_epoch], [1, 1, 0]);
  }
  assert.throws(() => push(result('SUCCESS', '{}', { conversation_id: undefined })),
    error => error.reason === 'result-envelope-invalid');
});

test('DONE from a different step type cannot close an open tool with the same index', () => {
  const { push } = harness();
  push(init(), 0);
  push(step(1, 'ACTIVE', 'tool'), 1);
  const snap = push(step(1, 'DONE', 'agent_response', { text: 'short' }), 2);
  assert.deepEqual([snap.tools_in_flight, snap.gap_suspended], [1, true]);
});

test('tool windows open on ACTIVE tool steps and close on DONE', () => {
  const { push } = harness();
  push(init(), 0);
  let snap = push(step(1, 'ACTIVE', 'checkpoint'), 50);
  assert.equal(snap.gap_suspended, false, 'types outside the allowlist never open a window');
  snap = push(step(3, 'ACTIVE', 'tool'), 100);
  assert.deepEqual([snap.gap_suspended, snap.suspension_epoch, snap.last_remote_ms, snap.tools_in_flight], [true, 1, 100, 1]);
  snap = push(step(4, 'ACTIVE', 'tool'), 150);
  assert.deepEqual([snap.suspension_epoch, snap.tools_in_flight], [1, 2], 'parallel tools share the epoch');
  const anchor = snap.last_remote_ms;
  snap = push(step(3, 'ACTIVE', 'tool', { text: 'different payload' }), 200);
  assert.deepEqual([snap.suspension_epoch, snap.last_remote_ms, snap.remote_event_count], [1, anchor, 4],
    'a repeated ACTIVE never reopens nor moves the anchor');
  snap = push(step(3, 'DONE', 'tool'), 250);
  assert.deepEqual([snap.gap_suspended, snap.tools_in_flight, snap.last_remote_ms], [true, 1, 250]);
  snap = push(step(4, 'DONE', 'tool', { tool_info: { error: 'boom' } }), 300);
  assert.deepEqual([snap.gap_suspended, snap.tools_in_flight, snap.last_remote_ms], [false, 0, 300]);
  snap = push(step(9, 'DONE', 'tool'), 350);
  assert.deepEqual([snap.gap_suspended, snap.last_remote_ms, snap.suspension_epoch], [false, 350, 1],
    'DONE without ACTIVE is progress and closes nothing');
  snap = push(step(10, 'ACTIVE', 'tool'), 400);
  assert.deepEqual([snap.gap_suspended, snap.suspension_epoch], [true, 2]);
});

test('a DONE for an unknown key does not close an unrelated open tool', () => {
  const { push } = harness();
  push(init(), 0);
  push(step(1, 'ACTIVE', 'tool'), 10);
  const snap = push(step(2, 'DONE', 'agent_response', { text: 'short' }), 20);
  assert.deepEqual([snap.gap_suspended, snap.tools_in_flight, snap.last_remote_ms], [true, 1, 20]);
});

test('open tools are bounded with oldest eviction and no new epoch', () => {
  const { push } = harness();
  push(init(), 0);
  let snap;
  for (let i = 0; i < LIMITS.openTools + 5; i++) snap = push(step(i, 'ACTIVE', 'tool'), i + 1);
  assert.deepEqual([snap.tools_in_flight, snap.suspension_epoch, snap.gap_suspended], [LIMITS.openTools, 1, true]);
  snap = push(step(0, 'DONE', 'tool'), 100);
  assert.equal(snap.tools_in_flight, LIMITS.openTools, 'an evicted key closes nothing');
});

test('reducer snapshots drive the tracker within the locked DEFAULTS', () => {
  const ceiling = liveness.TIER_CEILING_MS.heavy;
  {
    const { push, clock, reducer } = harness();
    push(init(), 0);
    const tracker = liveness.createTracker(liveness.DEFAULTS, ceiling);
    clock.now = 240000;
    assert.equal(tracker.evaluate(reducer.snapshot()).result.kill, false);
    clock.now = 240001;
    const { result } = tracker.evaluate(reducer.snapshot());
    assert.deepEqual([result.kill, result.termination, result.reason], [true, 'dead-silence', 'silence']);
  }
  {
    const { push, clock, reducer } = harness();
    push(init(), 0);
    push(step(1, 'ACTIVE', 'tool'), 1000);
    const tracker = liveness.createTracker(liveness.DEFAULTS, ceiling);
    clock.now = 1000 + 660000;
    assert.equal(tracker.evaluate(reducer.snapshot()).result.kill, false);
    clock.now = 1000 + 660001;
    const { result } = tracker.evaluate(reducer.snapshot());
    assert.deepEqual([result.kill, result.termination, result.reason],
      [true, 'dead-silence', 'tool-proof-unavailable-expired']);
  }
  {
    // Repeated identical ACTIVE spam cannot keep a window alive past the bound.
    const { push, clock, reducer } = harness();
    push(init(), 0);
    push(step(1, 'ACTIVE', 'tool'), 0);
    const tracker = liveness.createTracker(liveness.DEFAULTS, ceiling);
    for (let t = 1000; t <= 660001; t += 50000) push(step(1, 'ACTIVE', 'tool'), t);
    clock.now = 660001;
    assert.equal(tracker.evaluate(reducer.snapshot()).result.kill, true);
  }
  {
    const { push, clock, reducer } = harness();
    push(init(), 0);
    const tracker = liveness.createTracker(liveness.DEFAULTS, 300000);
    for (let t = 100000; t < 300000; t += 100000) push(step(t, 'ACTIVE', 'agent_response', { text: String(t) }), t);
    clock.now = 300000;
    const { result } = tracker.evaluate(reducer.snapshot());
    assert.deepEqual([result.kill, result.cause, result.termination], [true, 'ceiling', 'budget-exceeded-while-active']);
  }
  {
    const { clock, reducer } = harness();
    const tracker = liveness.createTracker(liveness.DEFAULTS, ceiling);
    clock.now = 60001;
    const { result } = tracker.evaluate(reducer.snapshot());
    assert.deepEqual([result.kill, result.termination], [true, 'dead-start']);
  }
});

test('terminal SUCCESS returns the response and later events are not progress', () => {
  const { push, reducer } = harness();
  push(init(), 0);
  let snap = push(result('success', '{"objections":[]}', { conversation_id: 'conv-1' }), 10);
  assert.equal(snap.phase, 'terminal');
  assert.equal(snap.last_remote_ms, 10);
  snap = push(step(5, 'ACTIVE', 'agent_response', { text: 'late' }), 20);
  assert.equal(snap.last_remote_ms, 10);
  assert.deepEqual(reducer.end(), { status: 'SUCCESS', text: '{"objections":[]}', source: 'response' });
});

test('chunks are the fallback only for a SUCCESS without response, repeats included', () => {
  const { push, reducer } = harness();
  push(init(), 0);
  push(step(1, 'ACTIVE', 'agent_response', { text: '{"objections":' }), 1);
  push(step(1, 'ACTIVE', 'agent_response', { text: '[]' }), 2);
  push(step(1, 'ACTIVE', 'agent_response', { text: '[]' }), 3);
  push(step(1, 'ACTIVE', 'agent_response', { text: 'x', conversation_id: 'conv-2' }), 4);
  push(step(2, 'ACTIVE', 'tool', { text: 'tool output' }), 5);
  push(result('SUCCESS'), 6);
  assert.deepEqual(reducer.end(), { status: 'SUCCESS', text: '{"objections":[][]', source: 'chunks' });
});

test('a result line without trailing newline is still read at end()', () => {
  const { push, reducer } = harness();
  push(JSON.stringify(result('SUCCESS', 'ok')), 1);
  assert.equal(reducer.end().text, 'ok');
});

test('missing, failed, duplicate and foreign terminals fail closed', () => {
  const fails = (fn, reason) => assert.throws(fn, error => error.reason === reason);
  { const { reducer } = harness(); fails(() => reducer.end(), 'output-empty'); }
  { const { push, reducer } = harness(); push(init()); push(step(0, 'DONE', 'agent_response', { text: '{}' })); fails(() => reducer.end(), 'result-envelope-invalid'); }
  { const { push, reducer } = harness(); push('{"event":"result","status":"SUC'); fails(() => reducer.end(), 'result-envelope-invalid'); }
  { const { push } = harness(); fails(() => push(result('ERROR', 'x')), 'result-error'); }
  { const { push } = harness(); push(result('SUCCESS', 'a')); fails(() => push(result('SUCCESS', 'a')), 'duplicate-terminal'); }
  { const { push } = harness(); push(result('SUCCESS', 'a')); fails(() => push({ event: 'result' }), 'duplicate-terminal'); }
  { const { push } = harness(); fails(() => push({ event: 'result', status: 7 }), 'result-envelope-invalid'); }
  { const { push } = harness(); push(init()); fails(() => push(result('SUCCESS', 'a', { conversation_id: 'conv-2' })), 'result-envelope-invalid'); }
  { const { push, reducer } = harness(); push(result('SUCCESS', '')); fails(() => reducer.end(), 'output-empty'); }
});

test('byte, line, event and reconstruction limits fail as output-limit', () => {
  const fails = (fn) => assert.throws(fn, error => error.reason === 'output-limit');
  { const { reducer } = harness(); fails(() => reducer.push(Buffer.alloc(LIMITS.line + 1, 0x61))); }
  { const { reducer } = harness(); fails(() => reducer.push(Buffer.alloc(LIMITS.stdout + 1, 10))); }
  { const { reducer } = harness(); fails(() => reducer.stderr(Buffer.alloc(LIMITS.stderr + 1, 0x61))); }
  { const { reducer } = harness(); fails(() => reducer.push('x\n'.repeat(LIMITS.events + 1))); }
  {
    const { push, reducer } = harness();
    const big = 'y'.repeat(600000);
    push(step(1, 'ACTIVE', 'agent_response', { text: big }));
    push(step(2, 'ACTIVE', 'agent_response', { text: big }));
    push(result('SUCCESS'));
    fails(() => reducer.end());
  }
  {
    // The bounded fallback never rejects a SUCCESS that carries its response.
    const { push, reducer } = harness();
    const big = 'y'.repeat(600000);
    push(step(1, 'ACTIVE', 'agent_response', { text: big }));
    push(step(2, 'ACTIVE', 'agent_response', { text: big }));
    push(result('SUCCESS', 'final'));
    assert.equal(reducer.end().text, 'final');
  }
});

test('dispose keeps the final snapshot and refuses further input', () => {
  const { push, reducer, clock } = harness();
  push(init(), 7);
  const before = reducer.snapshot();
  reducer.dispose();
  clock.now = 999;
  assert.deepEqual(reducer.snapshot(), before);
  assert.throws(() => reducer.push('x\n'), error => error.reason === 'result-envelope-invalid');
  assert.doesNotThrow(() => reducer.dispose());
});
