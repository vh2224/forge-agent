#!/usr/bin/env node
'use strict';

const assert = require('assert');
const adapter = require('./forge-long-workflow-adapter.js');

function fakeOrchestrate() {
  const calls = [];
  return {
    calls,
    api: {
      run(operation, input) {
        calls.push({ operation, input: { ...input } });
        if (operation === 'status') return { outcome: 'completed', reason_code: 'status-ready' };
        return { outcome: 'completed', reason_code: 'unit-selected', unit: { type: 'execute-task', id: 'T01', key: 'execute-task/T01' } };
      },
    },
  };
}

for (const host of ['claude', 'codex']) for (const mode of ['auto', 'task']) {
  const fake = fakeOrchestrate();
  const result = adapter.invoke(host, mode, 'next', { workflow_id: `${host}-${mode}`, milestone: 'M1', session: 'private' }, null, { orchestrate: fake.api });
  assert.strictEqual(result.adapter_runtime, host);
  assert.strictEqual(result.result.host_runtime, host);
  assert.strictEqual(result.result.outcome, 'dispatch_required');
  assert.strictEqual(fake.calls.length, 1);
  assert.strictEqual(fake.calls[0].input.host_runtime, host);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(result.result.snapshot, 'session'), false);
  assert.strictEqual(JSON.stringify(result).includes('private'), false);
}

const fake = fakeOrchestrate();
const initial = adapter.invoke('claude', 'auto', 'next', { workflow_id: 'fixed-host', milestone: 'M1' }, null, { orchestrate: fake.api });
assert.throws(() => adapter.invoke('codex', 'auto', 'next', { workflow_id: 'fixed-host', milestone: 'M1' }, initial.result.snapshot, { orchestrate: fake.api }), (error) => error.code === 'host-runtime-mismatch');
assert.throws(() => adapter.invoke('other', 'auto', 'next', { workflow_id: 'bad' }, null, { orchestrate: fake.api }), (error) => error.code === 'invalid-host');

let stdout = ''; let stderr = '';
const exit = adapter.main(['--host', 'codex', '--mode', 'auto', '--command', 'status', '--json', '{"workflow_id":"cli","milestone":"M1"}'], (value) => { stdout += value; }, (value) => { stderr += value; });
assert.strictEqual(exit, 0, stderr);
assert.strictEqual(JSON.parse(stdout).adapter_runtime, 'codex');

// The exact standalone-task repro from the field report. Before the named
// refusal this exited 1 with `invalid-request` thrown by the delegate, leaving
// the operator to choose between ignoring the authority layer and borrowing an
// unrelated milestone. The CLI must answer, not throw — and answer without
// reaching forge-orchestrate (no fixture, no cwd, no fake controller here).
const refusals = {};
for (const host of ['claude', 'codex']) {
  let looseStdout = ''; let looseStderr = '';
  const looseExit = adapter.main(['--host', host, '--mode', 'task', '--command', 'next', '--json', '{"workflow_id":"loose"}'], (value) => { looseStdout += value; }, (value) => { looseStderr += value; });
  assert.strictEqual(looseExit, 0, looseStderr);
  const looseResult = JSON.parse(looseStdout).result;
  assert.strictEqual(looseResult.reason_code, 'task-scope-unsupported');
  assert.strictEqual(looseResult.outcome, 'blocked');
  assert.strictEqual(looseResult.action, 'stop');
  assert.strictEqual(looseResult.controller_result, null);
  refusals[host] = { ...looseResult, host_runtime: null, snapshot: { ...looseResult.snapshot, host_runtime: null } };
}
assert.deepStrictEqual(refusals.claude, refusals.codex, 'the refusal must not depend on the host');

const source = require('fs').readFileSync(require('path').join(__dirname, 'forge-long-workflow-adapter.js'), 'utf8');
{
  const fixtures = require('./forge-loop-failure.test'), f = fixtures.fixture();
  try {
    const imported = fixtures.invoke(f, 'consume-failure', f.selected.snapshot, { approved: true, process_stopped: true }, {});
    assert.strictEqual(imported.reason_code, 'failure-inspector-required');
    const consumed = fixtures.consume(f);
    assert.strictEqual(consumed.reason_code, 'failure-consumed');
    assert.strictEqual(consumed.snapshot.step_count, 1);
  } finally { fixtures.cleanup(f); }
}
assert.strictEqual(/child_process|\bspawn(?:Sync)?\s*\(/.test(source), false, 'adapter must not spawn');
const executableSource = source.replace(/^\s*\/\/.*$/gm, '');
assert.strictEqual(/modelFamily|worker_engine|forge-dispatch-resolve|forge-xllm/.test(executableSource), false, 'adapter must not choose fallback or worker');
for (const skill of ['forge-auto', 'forge-task']) {
  const content = require('fs').readFileSync(require('path').join(__dirname, '..', 'skills', skill, 'SKILL.md'), 'utf8');
  assert(content.includes('forge-long-workflow-adapter.js'));
  assert(content.includes('shared/forge-lifecycle.md'));
}
console.log('forge-long-workflow-adapter tests passed (Claude/Codex × auto/task)');
