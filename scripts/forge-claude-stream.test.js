'use strict';
const assert = require('assert');
const { createReducer, LIMITS } = require('./forge-claude-stream');
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
