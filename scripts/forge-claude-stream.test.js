'use strict';
const assert = require('assert');
const { createReducer, toolFingerprint, LIMITS } = require('./forge-claude-stream');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const terminal = { type: 'result', subtype: 'success', is_error: false,
  structured_output: { status: 'done' }, modelUsage: { 'claude-fixture': {} } };
const frame = value => Buffer.from(JSON.stringify(value) + '\r\n');
const start = id => ({ type: 'stream_event', event: { type: 'message_start', message: { id, role: 'assistant' } } });
const event = value => frame({ type: 'stream_event', event: value });
const refused = (action, reason) => assert.throws(action, error => error.reason === reason);
let now = 0;
let reducer = createReducer({ clock: () => now, secret: 'private-token' });
for (const byte of frame({ type: 'system', subtype: 'init' })) reducer.push(Buffer.from([byte]));
assert.equal(reducer.snapshot().first_remote_ms, null);
now = 20; reducer.push(frame(start('message')));
now = 40; reducer.push(event({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
for (const byte of event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: String.fromCodePoint(0x1f680) } })) {
  reducer.push(Buffer.from([byte]));
}
assert.equal(reducer.snapshot().gap_sample_ms, 20);
now = 10; assert.equal(reducer.snapshot().elapsed_ms, 40, 'clock regression cannot reduce elapsed time');
reducer.push(Buffer.from(JSON.stringify(terminal)));
assert.deepEqual(reducer.end(), terminal, 'EOF without final newline is accepted');
for (const bytes of ['{"type":"ping","type":"ping"}\n', '{"x":', '\ufffd\n',
  '{"a":1,"\\u0061":2}\n']) {
  reducer = createReducer();
  refused(() => { reducer.push(Buffer.from(bytes)); reducer.end(); }, 'json-invalid');
}
reducer = createReducer(); refused(() => reducer.push(Buffer.from([0xff, 10])), 'json-invalid');
reducer = createReducer(); refused(() => reducer.push(Buffer.from([0xa0, 10])), 'json-invalid');
reducer = createReducer(); reducer.push(frame(terminal));
refused(() => reducer.push(frame({ type: 'ping' })), 'event-after-terminal');
reducer = createReducer(); reducer.push(frame(terminal));
refused(() => reducer.push(frame(terminal)), 'duplicate-terminal');
for (const value of [{ type: 'result', subtype: 'success', is_error: false, result: 'legacy' },
  { type: 'result', subtype: 'success', structured_output: {} }]) {
  reducer = createReducer(); refused(() => reducer.push(frame(value)), 'result-envelope-invalid');
}
reducer = createReducer(); reducer.push(frame({ type: 'ping' }));
refused(() => reducer.end(), 'result-envelope-invalid');
for (const value of ['{"unknown":{"private\\u002dtoken":"x"}}\n',
  '{"permission_denials":[{"tool_name":"private-token"}]}\n']) {
  reducer = createReducer({ secret: 'private-token' });
  refused(() => reducer.push(Buffer.from(value)), 'secret-output');
}
reducer = createReducer({ secret: 'private-token' });
reducer.push(Buffer.from('{"x":"private-'));
refused(() => reducer.push(Buffer.from('token"}\n')), 'secret-output');
reducer = createReducer({ secret: 'private-token' }); reducer.stderr(Buffer.from('private-'));
refused(() => reducer.stderr(Buffer.from('token')), 'secret-output');
reducer = createReducer(); reducer.push(Buffer.alloc(LIMITS.line, 32));
refused(() => reducer.push(Buffer.from(' ')), 'output-limit');
reducer = createReducer(); refused(() => reducer.push(Buffer.alloc(LIMITS.stdout + 1)), 'output-limit');
reducer = createReducer(); reducer.stderr(Buffer.alloc(LIMITS.stderr));
refused(() => reducer.stderr(Buffer.from(' ')), 'output-limit');
reducer = createReducer();
refused(() => reducer.push(Buffer.from('{"nested":' + '['.repeat(128) + '0' + ']'.repeat(128) + '}\n')), 'output-limit');
reducer = createReducer();
refused(() => reducer.push(frame({ values: Array(100000).fill(0) })), 'output-limit');
// Accepted boundaries are exercised as well as the first refused byte/node.
reducer = createReducer();
const prefix = '{"type":"ping","padding":"', suffix = '"}';
const exactLine = prefix + ' '.repeat(LIMITS.line - Buffer.byteLength(prefix + suffix)) + suffix;
reducer.push(Buffer.from(exactLine + '\n'));
reducer.push(frame(terminal)); assert.deepEqual(reducer.end(), terminal);
reducer = createReducer();
reducer.push(Buffer.from('{"nested":' + '['.repeat(127) + '0' + ']'.repeat(127) + '}\n'));
reducer.push(frame({ values: Array(99998).fill(0) }));
reducer.push(frame(terminal)); reducer.end();
reducer = createReducer();
const blankLine = Buffer.alloc(LIMITS.line + 1, 32); blankLine[blankLine.length - 1] = 10;
for (let i = 0; i < 15; i++) reducer.push(blankLine);
reducer.push(Buffer.alloc(LIMITS.stdout - blankLine.length * 15, 32));
assert.equal(reducer.snapshot().stdout_bytes, LIMITS.stdout);
refused(() => reducer.push(Buffer.from(' ')), 'output-limit');
reducer = createReducer(); reducer.push(frame(start('reconstruction')));
reducer.push(event({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
for (let i = 0; i < 2; i++) reducer.push(event({ type: 'content_block_delta', index: 0,
  delta: { type: 'text_delta', text: 'x'.repeat(LIMITS.reconstruction / 2) } }));
refused(() => reducer.push(event({ type: 'content_block_delta', index: 0,
  delta: { type: 'text_delta', text: 'x' } })), 'output-limit');
reducer = createReducer();
for (let i = 0; i < LIMITS.events; i++) reducer.push(frame({ type: 'ping' }));
refused(() => reducer.push(frame({ type: 'ping' })), 'output-limit');
reducer = createReducer(); reducer.push(frame(start('blocks')));
for (let index = 0; index < LIMITS.blocks; index++) {
  reducer.push(event({ type: 'content_block_start', index, content_block: { type: 'text' } }));
}
refused(() => reducer.push(event({ type: 'content_block_start', index: 32, content_block: {} })), 'output-limit');
reducer = createReducer();
refused(() => reducer.push(frame({ type: 'error', error: { type: 'overloaded_error' } })), 'result-error');
reducer = createReducer(); reducer.stderr(Buffer.from('warning fatal timeout retry'));
reducer.push(frame({ type: 'ping' })); assert.equal(reducer.snapshot().remote_event_count, 0);
reducer.push(frame({ ...terminal, usage: { input_tokens: 0, output_tokens: -1, cache_read_input_tokens: 1.5 },
  total_cost_usd: 0.0123, permission_denials: [{ tool_name: 'Read' }, { tool_name: 'untrusted-label' }] }));
reducer.end();
assert.equal(reducer.snapshot().input_tokens, 0); assert.equal(reducer.snapshot().output_tokens, null);
assert.equal(reducer.snapshot().cache_read_tokens, null); assert.equal(reducer.snapshot().cost_usd, 0.0123);
assert.deepEqual(reducer.snapshot().denials, { read: 1, write: 0, shell: 0, other: 1 });
// Local tool time does not train or trigger an eligible gap.
now = 0; reducer = createReducer({ clock: () => now, secret: 'private-token' });
now = 10; reducer.push(frame(start('tool')));
now = 20; reducer.push(event({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use' } }));
now = 500000; reducer.push(frame({ type: 'system', subtype: 'tool_progress', elapsed: 500000 }));
assert.equal(reducer.snapshot().gap_suspended, true);
reducer.push(event({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"key":"private-' } }));
refused(() => reducer.push(event({ type: 'content_block_delta', index: 0,
  delta: { type: 'input_json_delta', partial_json: 'token"}' } })), 'secret-output');
reducer = createReducer({ clock: () => now }); reducer.push(frame(start('one')));
reducer.push(event({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use' } }));
now += 900000; reducer.push(frame(start('two')));
assert.equal(reducer.snapshot().gap_sample_ms, null);
now += 25; reducer.push(event({ type: 'message_delta', message_id: 'foreign', usage: {} }));
assert.equal(reducer.snapshot().remote_event_count, 2);
reducer.push(event({ type: 'message_delta', message_id: 'two', usage: {} }));
assert.equal(reducer.snapshot().gap_sample_ms, 25);
reducer.push(frame(terminal)); reducer.end();
const finalSnapshot = reducer.snapshot();
reducer.dispose(); reducer.dispose(); now += 1000;
assert.deepEqual(reducer.snapshot(), finalSnapshot, 'disposed reducer retains only its closed safe snapshot');
for (const action of [() => reducer.push(frame(terminal)), () => reducer.stderr('raw'), () => reducer.end()]) {
  refused(action, 'result-envelope-invalid');
}
assert(!JSON.stringify(reducer.snapshot()).includes('structured_output'));
reducer = createReducer();
reducer.push(frame({ type: 'assistant', message: { role: 'assistant', id: 'partial-usage', usage: { input_tokens: 40, output_tokens: 7 } } }));
assert.equal(reducer.snapshot().input_tokens, null, 'intermediate message usage is not final usage');
reducer.push(frame({ ...terminal, usage: { input_tokens: -1, output_tokens: 0 } })); reducer.end();
assert.equal(reducer.snapshot().input_tokens, null, 'invalid terminal usage cannot inherit a message value');
assert.equal(reducer.snapshot().output_tokens, 0);
console.log('PASS Claude stream: UTF-8/NDJSON, exact bounded limits, unique terminal, secrets, closed usage and tool-excluded remote timing');

// Synthetic documented assumption, NOT a real CLI capture. Sources:
// https://platform.claude.com/docs/en/agent-sdk/streaming-output
// https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py
const calls = [];
now = 0;
let remoteCalls = 0;
reducer = createReducer({ clock: () => now, onToolCall: call => calls.push(call), onRemote: () => remoteCalls++ });
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/claude-stream-tool-result.jsonl'), 'utf8').trim().split(/\r?\n/);
for (let index = 0; index < fixture.length; index++) {
  now += 100;
  const before = reducer.snapshot(), beforeRemote = remoteCalls;
  reducer.push(fixture[index] + '\n');
  if (index === 2) assert.equal(calls.length, 0, 'complete delta still waits for block closure');
  if (index === 3 || index === 4) assert.equal(calls.length, 1, 'stream and assistant dedupe');
  if (index === 4) assert.equal(reducer.snapshot().tools_in_flight, 1);
  if (index === 5) {
    const after = reducer.snapshot();
    assert.equal(after.tools_in_flight, 0);
    assert.equal(after.gap_suspended, false);
    assert.equal(after.remote_silence_ms, 0);
    assert.equal(after.remote_event_count, before.remote_event_count);
    assert.equal(after.gap_sample_ms, before.gap_sample_ms);
    assert.equal(remoteCalls, beforeRemote);
    now += 25;
    assert.equal(reducer.snapshot().remote_silence_ms, 25);
  }
}
reducer.end();
assert.deepEqual(Object.keys(calls[0]), ['fingerprint']);
assert.match(calls[0].fingerprint, /^[a-f0-9]{64}$/);
const fixtureInput = JSON.parse(fixture[4]).message.content[0].input;
assert.equal(calls[0].fingerprint, toolFingerprint('SyntheticRead', fixtureInput));
for (const privateValue of ['SyntheticRead', 'synthetic-private-path', 'synthetic-private-description',
  'synthetic-private-mode', 'synthetic-private-result', 'partial_json', 'description']) {
  assert(!JSON.stringify(reducer.snapshot()).includes(privateValue));
  assert(!JSON.stringify(calls).includes(privateValue));
}
const safeSnapshot = reducer.snapshot();
reducer.dispose();
assert.deepEqual(reducer.snapshot(), safeSnapshot);

const canonicalInput = { z: [{ b: 2, a: 1 }], a: { y: true, x: 'value' }, description: 'ignored' };
const canonicalExpected = '{"a":{"x":"value","y":true},"z":[{"a":1,"b":2}]}';
assert.equal(toolFingerprint('Tool', canonicalInput), crypto.createHash('sha256').update('Tool\0' + canonicalExpected).digest('hex'));
assert.equal(toolFingerprint('Tool', canonicalInput), toolFingerprint('Tool', { a: { x: 'value', y: true }, z: [{ a: 1, b: 2 }] }));
assert.equal(toolFingerprint('Tool', { description: 'one', x: 1 }), toolFingerprint('Tool', { x: 1, description: 'two' }));
assert.notEqual(toolFingerprint('Tool', { x: 1 }), toolFingerprint('Tool', { x: 2 }));
assert.notEqual(toolFingerprint('Tool', { x: [1, 2] }), toolFingerprint('Tool', { x: [2, 1] }));
assert.notEqual(toolFingerprint('Tool', { x: { description: 'one' } }), toolFingerprint('Tool', { x: { description: 'two' } }));
assert.notEqual(toolFingerprint('Tool', {}), toolFingerprint('Other', {}));
assert.equal(toolFingerprint('Tool', JSON.parse('{"__proto__":{"x":1}}')),
  crypto.createHash('sha256').update('Tool\0{"__proto__":{"x":1}}').digest('hex'));
for (const name of [null, '', ' ', 1]) assert.equal(toolFingerprint(name, {}), null);
const cycle = {}; cycle.self = cycle;
for (const input of [null, undefined, 1, 'text', [], cycle, { value: 1n }]) assert.equal(toolFingerprint('Tool', input), null);
console.log('PASS Claude stream fingerprints: canonical SHA-256, recursive ordering, description, fixture replay, dedupe and privacy');

const toolStart = (id, index = 0, name = 'PrivateTool') => event({
  type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} },
});
const toolDelta = (text, index = 0) => event({ type: 'content_block_delta', index,
  delta: { type: 'input_json_delta', partial_json: text } });
const assistantTool = (id, input = {}, name = 'PrivateTool') => frame({ type: 'assistant',
  message: { id: 'assistant-tools', role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id, extra = {}) => frame({ type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id }] }, ...extra });

for (const closing of ['content_block_stop', 'message_stop']) {
  for (const text of ['{"private":"argument"}', '{"private":', '[]', 'null']) {
    const observed = [];
    reducer = createReducer({ onToolCall: call => observed.push(call) });
    reducer.push(frame(start('completion')));
    reducer.push(toolStart('toolu_test'));
    reducer.push(toolDelta(text.slice(0, 5)));
    assert.equal(observed.length, 0);
    reducer.push(toolDelta(text.slice(5)));
    assert.equal(observed.length, 0);
    assert.doesNotThrow(() => reducer.push(event({ type: closing, index: 0 })));
    assert.equal(observed.length, text === '{"private":"argument"}' ? 1 : 0);
    reducer.push(assistantTool('toolu_test', { private: 'argument' }));
    assert.equal(observed.length, 1, 'invalid stream JSON permits a later valid complete message');
  }
}
reducer = createReducer({ onToolCall: () => { throw new Error('private callback error'); } });
assert.doesNotThrow(() => reducer.push(assistantTool('observer')));
reducer.push(frame(terminal)); reducer.end();
assert(!JSON.stringify(reducer.snapshot()).includes('private callback error'));
let assistantCount = 0;
reducer = createReducer({ onToolCall: () => assistantCount++ });
reducer.push(assistantTool('reverse'));
reducer.push(toolStart('reverse')); reducer.push(toolDelta('{}'));
reducer.push(event({ type: 'content_block_stop', index: 0 }));
assert.equal(assistantCount, 1, 'assistant then stream also dedupes');
for (const input of [null, [], 'invalid']) {
  let invalidCalls = 0;
  reducer = createReducer({ onToolCall: () => invalidCalls++ });
  reducer.push(assistantTool('invalid-input', input));
  assert.equal(invalidCalls, 0);
}
console.log('PASS Claude stream completion: closure only, open message_stop, invalid JSON, assistant path and observer isolation');

now = 0; reducer = createReducer({ clock: () => now });
reducer.push(frame(start('parallel')));
now = 10; reducer.push(event({ type: 'message_delta' }));
reducer.push(toolStart('first', 0)); reducer.push(toolStart('second', 1));
now = 1000; const timingBefore = reducer.snapshot();
reducer.push(toolResult('first'));
assert.equal(reducer.snapshot().tools_in_flight, 1);
assert.equal(reducer.snapshot().gap_suspended, true);
now = 2000; reducer.push(toolResult('second', { parent_tool_use_id: null }));
assert.equal(reducer.snapshot().tools_in_flight, 0);
assert.equal(reducer.snapshot().gap_suspended, false);
assert.equal(reducer.snapshot().remote_silence_ms, 0);
assert.equal(reducer.snapshot().remote_event_count, timingBefore.remote_event_count);
assert.equal(reducer.snapshot().gap_sample_ms, timingBefore.gap_sample_ms);
now += 20; reducer.push(event({ type: 'message_delta' }));
assert.equal(reducer.snapshot().gap_sample_ms, 20, 'tool time cannot train the resumed gap');
now += 10; const lastBeforeUnknown = reducer.snapshot().last_remote_ms;
reducer.push(toolResult('unknown'));
assert.equal(reducer.snapshot().last_remote_ms, lastBeforeUnknown);

const badResults = [
  { message: { content: [{ type: 'tool_result', tool_use_id: 'unknown' }] } },
  { parent_tool_use_id: 'parent', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_test' }] } },
  { parent_tool_use_id: false, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_test' }] } },
  { message: { content: {} } },
  { message: { content: [{ type: 'tool_result', tool_use_id: 123 }] } },
  { message: { content: [{ type: 'tool_result' }] } },
  { message: { content: [{ type: 'tool_result', tool_use_id: '' }] } },
  { message: { content: [{ type: 'tool_result', tool_use_id: 'x'.repeat(257) }] } },
  { message: { content: [null, 1, { type: 'text', tool_use_id: 'toolu_test' }] } },
  { message: null },
];
for (const value of badResults) {
  reducer = createReducer(); reducer.push(frame(start('guard'))); reducer.push(toolStart('toolu_test'));
  const before = reducer.snapshot();
  assert.doesNotThrow(() => reducer.push(frame({ type: 'user', ...value })));
  assert.equal(reducer.snapshot().tools_in_flight, 1);
  assert.equal(reducer.snapshot().gap_suspended, true);
  assert.equal(reducer.snapshot().remote_event_count, before.remote_event_count);
  reducer.push(frame(start('fallback')));
  assert.equal(reducer.snapshot().gap_suspended, false, 'S01 eligible remote fallback');
}
for (const id of [null, undefined, 123, '', ' ', 'x'.repeat(257)]) {
  let malformedCalls = 0;
  reducer = createReducer({ onToolCall: () => malformedCalls++ });
  reducer.push(frame(start('malformed'))); reducer.push(toolStart(id));
  reducer.push(toolDelta('{}')); reducer.push(event({ type: 'content_block_stop', index: 0 }));
  reducer.push(assistantTool(id));
  assert.equal(reducer.snapshot().tools_in_flight, 0);
  assert.equal(malformedCalls, 0);
}
reducer = createReducer();
for (let index = 0; index < LIMITS.blocks; index++) reducer.push(assistantTool('bounded-' + index));
assert.equal(reducer.snapshot().tools_in_flight, LIMITS.blocks);
refused(() => reducer.push(assistantTool('overflow')), 'output-limit');
reducer = createReducer(); reducer.push(frame(start('closed-blocks')));
for (let index = 0; index < LIMITS.blocks; index++) {
  reducer.push(toolStart('stream-bounded-' + index));
  reducer.push(toolDelta('{}')); reducer.push(event({ type: 'content_block_stop', index: 0 }));
}
refused(() => reducer.push(toolStart('stream-overflow')), 'output-limit');
// Tool accumulation shares the existing byte budget, including split UTF-8 text.
reducer = createReducer(); reducer.push(frame(start('tool-byte-limit')));
reducer.push(toolStart('tool-byte-limit'));
for (let index = 0; index < 2; index++) reducer.push(toolDelta('x'.repeat(LIMITS.reconstruction / 2)));
refused(() => reducer.push(toolDelta('x')), 'output-limit');
// Removing an id frees capacity without allowing a duplicate id to enter again.
reducer = createReducer();
for (let index = 0; index < LIMITS.blocks; index++) reducer.push(assistantTool('capacity-' + index));
reducer.push(toolResult('capacity-0'));
reducer.push(assistantTool('capacity-0'));
assert.equal(reducer.snapshot().tools_in_flight, LIMITS.blocks - 1);
reducer.push(assistantTool('capacity-new'));
assert.equal(reducer.snapshot().tools_in_flight, LIMITS.blocks);
assert.equal(toolFingerprint('Deep', JSON.parse('{"x":' + '['.repeat(LIMITS.depth) + '0' + ']'.repeat(LIMITS.depth) + '}')), null);
reducer = createReducer({ secret: 'private-token' }); reducer.push(assistantTool('secret-scan'));
assert.throws(() => reducer.push(toolResult('secret-scan', { text: 'private-token' })), error => {
  assert.equal(error.reason, 'secret-output');
  for (const value of ['private-token', 'PrivateTool', 'secret-scan']) {
    assert(!String(error).includes(value));
    assert(!JSON.stringify(error).includes(value));
  }
  return true;
});
assert.equal(reducer.snapshot().tools_in_flight, 1, 'secret inspection precedes result handling');
console.log('PASS Claude stream tool results: parallel tools, guarded documented shape, S01 fallback, bounded ids and unchanged remote samples');
