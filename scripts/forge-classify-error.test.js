'use strict';
const assert = require('assert/strict');
const { classifyError, isTransient } = require('./forge-classify-error');

for (const code of [429, 500, 502, 503]) {
  for (const message of [
    `forge-appserver-client: anomalous silence (dead-start) after 60.${code}s`,
    `forge-appserver-client: anomalous silence (dead-silence) after 240.${code}s`,
    `forge-appserver-client: budget exceeded while active after ${code}0s`,
    `opaque attempt id abc${code}def`,
    `opaque request id 1${code}2`,
    `elapsed ${code}.125 seconds`,
  ]) {
    assert.deepEqual(classifyError(message), { kind: 'unknown', retry: false }, message);
    assert.equal(isTransient(classifyError(message)), false, message);
  }
  for (const message of [`${code}`, `HTTP ${code}`, `HTTP ${code}.`, `HTTP ${code}. Retry later.`, `status=${code}`, `request failed (${code})`]) {
    const expected = code === 429 ? 'rate-limit' : 'server';
    assert.equal(classifyError(message).kind, expected, message);
    assert.equal(isTransient(classifyError(message)), true, message);
  }
}
assert.equal(classifyError('rate limit reached').kind, 'rate-limit');
assert.equal(classifyError('service unavailable').kind, 'server');
assert.equal(classifyError('unauthorized after 60.429s').kind, 'permanent');
assert.equal(classifyError('unauthorized HTTP 429').kind, 'rate-limit');
assert.equal(classifyError('HTTP 429 reset in 7s').backoffMs, 7000);
assert.equal(classifyError('HTTP 503', 1234).backoffMs, 1234);
console.log('forge-classify-error: numeric HTTP tokens and precedence passed');
