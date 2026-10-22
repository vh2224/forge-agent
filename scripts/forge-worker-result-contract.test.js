'use strict';
const assert = require('assert');
const { contract, matches } = require('./forge-worker-result-contract');
for (const profile of ['execute', 'preparation', 'artifacts', 'memory']) {
  const result = contract(profile);
  assert(result.validate(result.example).ok);
  assert(!result.validate({ ...result.example, status: 'complete' }).ok);
  assert(!result.validate({ ...result.example, extra: true }).ok);
  assert(result.instruction('claude-cli').includes('structured_output'));
  assert(!result.instruction('claude-cli').includes('---GSD-WORKER-RESULT---'));
  assert(result.instruction('native').includes('does not enforce a provider schema'));
}
assert(!contract('preparation').validate({ status: 'done', summary: 'ok', artifacts: [], questions: ['pending'] }).ok);
assert(!contract('preparation').validate({ status: 'partial', summary: 'pending', artifacts: [{ path: 'x', content: 'x' }], questions: [] }).ok);
const execution = contract();
for (const field of Object.keys(execution.example)) {
  const incomplete = { ...execution.example }; delete incomplete[field]; assert(!execution.validate(incomplete).ok);
}
assert(!execution.validate({ ...execution.example, files_changed: [1] }).ok);
assert(!execution.validate({ ...execution.example, must_haves_status: [{ item: 'x', status: 'complete', note: '', scope: 'task', reason: '' }] }).ok);
assert(matches({ x: 1 }, { type: 'object', additionalProperties: { type: 'integer' } }));
assert(!matches({ x: 1.5 }, { type: 'object', additionalProperties: { type: 'integer' } }));
console.log('PASS worker result contracts: canonical examples, exact status, required/closed nested schemas, native and Claude instructions');
