'use strict';
const assert = require('assert');
const { recoveryDispatchId } = require('./forge-recovery-dispatch-id');
const { normalizeDispatchId } = require('./forge-xllm');
const suffix = '12345678-1234-4234-8234-123456789012';
assert.strictEqual(recoveryDispatchId('parent', suffix), 'parent-recovery-' + suffix);
assert.throws(() => normalizeDispatchId('x'.repeat(95) + '-recovery-' + suffix, 'execute'), /invalid --dispatch-id/);
for (const size of [1, 82, 83, 95, 128]) {
  let parent = 'x'.repeat(size);
  const seen = new Set([parent]);
  for (let i = 0; i < 12; i++) {
    const next = recoveryDispatchId(parent, i % 2 ? 'a'.repeat(64) : suffix);
    assert.strictEqual(normalizeDispatchId(next, 'execute'), next);
    assert(next.length <= 128); assert(!seen.has(next)); seen.add(next); parent = next;
  }
}
assert.notStrictEqual(recoveryDispatchId('x'.repeat(127) + 'a', suffix), recoveryDispatchId('x'.repeat(127) + 'b', suffix));
assert.notStrictEqual(recoveryDispatchId('x'.repeat(128)), recoveryDispatchId('x'.repeat(128)));
for (const value of ['', 'x'.repeat(129), '../bad', 'bad space', null]) assert.throws(() => recoveryDispatchId(value), /recovery-dispatch-id-invalid/);
for (const value of ['', 'x'.repeat(65), 'bad space', '../bad', null]) assert.throws(() => recoveryDispatchId('parent', value), /recovery-dispatch-id-invalid/);
console.log('PASS bounded recovery IDs: validator, repeated lineage, long continuation, collisions and invalid input');
