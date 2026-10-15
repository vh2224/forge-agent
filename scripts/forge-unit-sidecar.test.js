'use strict';
const assert = require('assert');
const { inspectArtifacts, schema } = require('./forge-unit-sidecar');
const result = questions => ({ status: 'partial', summary: 'Decision needed', questions, artifacts: [] });
const inspect = questions => inspectArtifacts(result(questions), [], [], Infinity, {}, { forbidArtifactsOnNonDone: true });
assert(inspect(['Legacy question?']).ok);
assert(inspect([{ id: 'decision', question: 'Which source?' }]).ok);
assert(schema.properties.questions.items.anyOf.some(row => row.type === 'object' && row.additionalProperties === false));
for (const value of [null, [], {}, { id: '', question: 'Q' }, { id: 'x', question: '' }, { id: 'x', question: 'Q', answer: 'forged' }, { id: 1, question: 'Q' }]) {
  assert.strictEqual(inspect([value]).reason, 'schema-invalid', JSON.stringify(value));
}
const limit = 16 * 1024;
assert(inspect(['a'.repeat(limit)]).ok);
assert.strictEqual(inspect(['a'.repeat(limit + 1)]).reason, 'payload-limit');
const overhead = Buffer.byteLength(JSON.stringify({ id: 'x', question: '' }));
assert(inspect([{ id: 'x', question: 'a'.repeat(limit - overhead) }]).ok);
assert.strictEqual(inspect([{ id: 'x', question: 'a'.repeat(limit - overhead + 1) }]).reason, 'payload-limit');
assert.strictEqual(inspect([{ id: 'x'.repeat(limit), question: 'Q' }]).reason, 'payload-limit');
assert.strictEqual(inspect([{ id: 'x', question: String.fromCodePoint(0x1f600).repeat(limit / 4) }]).reason, 'payload-limit');
assert.strictEqual(inspect(Array(33).fill('Q')).reason, 'payload-limit');
assert.strictEqual(inspectArtifacts({ ...result([{ id: 'x', question: 'Q' }]), status: 'done' }, [], []).reason, 'questions-on-done');
assert.strictEqual(inspectArtifacts(result([{ id: 'x', question: 'Q' }]), [], [], 1).reason, 'payload-limit');
console.log('stable-ID and legacy questions: strict schema, UTF-8 bytes, count, total payload and done invariants passed');
