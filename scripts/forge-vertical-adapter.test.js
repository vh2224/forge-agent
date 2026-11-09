#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const state = require('./forge-state');
const lease = require('./forge-unit-lease');
const adapter = require('./forge-vertical-adapter');
const controller = require('./forge-unit-controller');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-vertical-slice-Ω-'));
const milestone = 'M-20260804000000-vertical-test';
function prefsReader() { return { ok: true, prefs: { workflow: { skip_discuss: true, skip_research: true } } }; }
function setup() {
  const cwd = path.join(root, Math.random().toString(36).slice(2));
  fs.mkdirSync(path.join(cwd, '.gsd', 'milestones', milestone), { recursive: true });
  state.write(cwd, { milestone, phase: 'idle', active_slice: 'S01', active_task: '—', next_action: 'plan', auto_mode: 'off' });
  return cwd;
}
function input(cwd, host, extra) {
  return {
    cwd, milestone, host_runtime: host, owner_token: 'adapter-owner', prefsReader,
    idempotency_key: `adapter-${host}-next`,
    inventory: { roadmap_exists: true, context_exists: true, research_exists: true, slices: [{ id: 'S01', checked: false, plan_exists: true, research_exists: true, tasks: [{ id: 'T01', checked: false }] }], milestone_complete: false },
    ...(extra || {}),
  };
}
// Preparation responses remain answer-as-result. Keep this distinct from the
// execute-task inventory above: authorization cannot complete unfinished code.
function preparationInput(cwd, host, extra) {
  const request = input(cwd, host, extra);
  request.inventory.slices[0].plan_exists = false;
  request.inventory.slices[0].tasks = [];
  // This answer completes plan-slice; its real owner outputs must also be valid.
  const slice = path.join(cwd, '.gsd', 'milestones', milestone, 'slices', 'S01');
  fs.mkdirSync(path.join(slice, 'tasks', 'T01'), { recursive: true });
  fs.writeFileSync(path.join(slice, 'S01-PLAN.md'), '# S01\n- [ ] **T01**: Fixture\n');
  fs.writeFileSync(path.join(slice, 'tasks', 'T01', 'T01-PLAN.md'), '---\nid: T01\ndepends: []\nwrites:\n  - src/result.js\nmust_haves:\n  truths:\n    - Vertical preparation fixture is observable.\n  artifacts: []\n  key_links: []\nexpected_output:\n  - src/result.js\n---\n# T01\n');
  return request;
}
try {
  const cwd = setup();
  const init = adapter.invoke('claude', 'init', { cwd, milestone, prefsReader });
  assert.strictEqual(init.adapter_runtime, 'claude');
  const status = adapter.invoke('codex', 'status', { cwd, milestone, session: 'host-session' });
  assert.strictEqual(status.adapter_runtime, 'codex');
  assert(!JSON.stringify(status).includes('host-session'));

  // Claude asks; the durable paused boundary is presented to Codex.
  const ask = adapter.invoke('claude', 'next', preparationInput(cwd, 'claude', { needs_input: true }));
  assert.strictEqual(ask.result.outcome, 'needs_input');
  assert.strictEqual(ask.result.unit.key, 'plan-slice/S01', 'the answer-as-result control explicitly selects preparation');
  assert(ask.result.boundary && ask.result.boundary.handoff_ready === true);
  assert.strictEqual(ask.result.boundary.kind, 'paused');
  const askRetry = adapter.invoke('claude', 'next', preparationInput(cwd, 'claude', { needs_input: true }));
  assert.strictEqual(askRetry.result.outcome, 'needs_input');
  assert.strictEqual(askRetry.result.boundary.idempotency_key, ask.result.boundary.idempotency_key);

  const crashCwd = setup();
  assert.throws(() => adapter.invoke('claude', 'next', input(crashCwd, 'claude', { needs_input: true, idempotency_key: 'adapter-crash' }), { failpoint: (name) => name === 'after-intent' }), (error) => error.code === 'CONTROLLER_FAILPOINT');
  const crashRetry = adapter.invoke('claude', 'next', input(crashCwd, 'claude', { needs_input: true, idempotency_key: 'adapter-crash' }));
  assert.strictEqual(crashRetry.result.outcome, 'needs_input');
  assert(crashRetry.result.boundary && crashRetry.result.boundary.handoff_ready === true);
  const handoff = adapter.handoff('claude', 'codex', { cwd, milestone, boundary: ask.result.boundary, prefsReader });
  assert.strictEqual(handoff.result.reason_code, 'handoff-ready');
  assert.strictEqual(handoff.result.boundary.next_host_runtime, 'codex');
  const invokedHandoff = adapter.invoke('codex', 'handoff', { cwd, milestone, from_runtime: 'claude', boundary: ask.result.boundary, prefsReader });
  assert.strictEqual(invokedHandoff.result.reason_code, 'handoff-ready');
  const tampered = adapter.handoff('claude', 'codex', { cwd, milestone, boundary: { ...ask.result.boundary, idempotency_key: 'forged-pointer' }, prefsReader });
  assert.strictEqual(tampered.result.outcome, 'failed');
  assert.strictEqual(tampered.result.reason_code, 'boundary-not-transferable');
  const resumed = adapter.collect('codex', preparationInput(cwd, 'codex', { boundary: ask.result.boundary, idempotency_key: 'adapter-resume-1' }), { choice: 'continue' });
  assert.strictEqual(resumed.result.outcome, 'completed');
  assert.strictEqual(resumed.result.reason_code, 'handoff-ready');
  const resumedRetry = adapter.collect('codex', preparationInput(cwd, 'codex', { boundary: ask.result.boundary, idempotency_key: 'adapter-resume-retry' }), { choice: 'continue' });
  assert.strictEqual(resumedRetry.result.outcome, 'completed');
  assert.strictEqual(resumedRetry.result.reason_code, 'handoff-ready');
  assert(!JSON.stringify(resumedRetry).includes('owner_token'));

  // The opposite direction uses the same bridge and boundary contract.
  const reverseCwd = setup();
  const reverseAsk = adapter.invoke('codex', 'next', preparationInput(reverseCwd, 'codex', { needs_input: true }));
  assert.strictEqual(reverseAsk.result.unit.key, 'plan-slice/S01');
  const reverse = adapter.collect('claude', preparationInput(reverseCwd, 'claude', { boundary: reverseAsk.result.boundary, idempotency_key: 'adapter-reverse-1' }), { value: 'ok' });
  assert.strictEqual(reverse.result.outcome, 'completed');
  assert.strictEqual(reverse.result.reason_code, 'handoff-ready');


  // An actual paused execution takes the other path. A human answer is not
  // delivery; explicit execute intent reopens that exact unit, not success.
  const executionCwd = setup();
  const executionAsk = adapter.invoke('claude', 'next', input(executionCwd, 'claude', { needs_input: true }));
  assert.strictEqual(executionAsk.result.unit.key, 'execute-task/T01');
  assert.strictEqual(executionAsk.result.boundary.kind, 'paused');
  const executionEvents = controller.eventsFile(executionCwd, milestone);
  const beforeAnswer = fs.readFileSync(executionEvents);
  const answerAsExecution = adapter.collect('codex', input(executionCwd, 'codex', { boundary: executionAsk.result.boundary }), { choice: 'continue' });
  assert.strictEqual(answerAsExecution.result.outcome, 'blocked');
  assert.strictEqual(answerAsExecution.result.reason_code, 'execution-resume-intent-required');
  assert(fs.readFileSync(executionEvents).equals(beforeAnswer), 'a rejected answer never creates a begin or completion event');
  assert.strictEqual(lease.observe(executionCwd, 'execute-task/T01').lease, null);
  const mixedIntent = adapter.collect('codex', input(executionCwd, 'codex', { boundary: executionAsk.result.boundary, resume_intent: 'execute' }), { choice: 'continue' });
  assert.strictEqual(mixedIntent.result.outcome, 'blocked');
  assert.strictEqual(mixedIntent.result.reason_code, 'execution-resume-intent-invalid');
  assert(fs.readFileSync(executionEvents).equals(beforeAnswer));
  const authorized = adapter.invoke('codex', 'next', input(executionCwd, 'codex', { boundary: executionAsk.result.boundary, resume_intent: 'execute' }));
  // 'completed' here is the thin adapter/orchestrate operation outcome only.
  // The reason/transaction below must prove execution was REOPENED, not done.
  assert.strictEqual(authorized.result.outcome, 'completed');
  assert.strictEqual(authorized.result.reason_code, 'execution-resume-ready');
  assert.strictEqual(authorized.result.unit.key, 'execute-task/T01');
  assert.strictEqual(authorized.result.details.resume_execution, true);
  const executionBinding = authorized.result.details.transaction;
  const executionBegin = controller.lookupRecord(executionCwd, 'transaction', executionBinding.idempotency_key);
  assert.strictEqual(executionBegin.action, 'begin');
  assert.strictEqual(executionBegin.phase, 'committed');
  assert.strictEqual(executionBegin.after.state.active_slice, 'S01');
  assert.strictEqual(controller.lookupRecord(executionCwd, 'transaction', executionBinding.idempotency_key + ':complete'), null);
  assert.strictEqual(controller.readEvents(executionEvents).filter(event => event.action === 'complete').length, 0, 'no execution was marked complete');
  const resumedLease = lease.observe(executionCwd, 'execute-task/T01').lease;
  assert(resumedLease && resumedLease.generation === executionBinding.generation);
  const beforeRetry = fs.readFileSync(executionEvents);
  const authorizedRetry = adapter.invoke('codex', 'next', input(executionCwd, 'codex', { boundary: executionAsk.result.boundary, resume_intent: 'execute', idempotency_key: 'execution-retry' }));
  assert.strictEqual(authorizedRetry.result.reason_code, 'execution-resume-ready');
  assert.deepStrictEqual(authorizedRetry.result.details.transaction, executionBinding);
  assert(fs.readFileSync(executionEvents).equals(beforeRetry), 'retry reuses the actual begin/lease');
  // Close this fixture-owned lease by a real pause; no worker/delivery is
  // fabricated. Full genuine-delivery completion lives in execution-resume.test.
  const executionPaused = controller.pause(executionCwd, { milestone, unit: 'execute-task/T01', host_runtime: 'codex',
    owner_token: 'adapter-owner', generation: executionBinding.generation, idempotency_key: 'execution-fixture-pause' }, { prefsReader });
  assert.strictEqual(executionPaused.transaction.boundary.kind, 'paused');
  assert.strictEqual(lease.observe(executionCwd, 'execute-task/T01').lease, null);

  // A response cannot smuggle transcript/session data into the controller.
  const invalid = adapter.collect('codex', input(setup(), 'codex', { boundary: ask.result.boundary }), { transcript: 'secret' });
  assert.strictEqual(invalid.result.outcome, 'blocked');
  assert.strictEqual(invalid.result.reason_code, 'response-invalid');
  assert(!JSON.stringify(invalid).includes('secret'));

  // Lease-active takeover is denied by the S02 lease API, never by adapter logic.
  const leaseCwd = setup();
  const leaseAsk = adapter.invoke('claude', 'next', input(leaseCwd, 'claude', { needs_input: true }));
  assert.strictEqual(leaseAsk.result.outcome, 'needs_input');
  assert.strictEqual(leaseAsk.result.unit.key, 'execute-task/T01', 'lease takeover control retains a real execution boundary');
  const acquired = lease.acquire(leaseCwd, 'execute-task/T01', { ownerToken: 'active-owner', requestId: 'lease-test', hostRuntime: 'claude' });
  assert.strictEqual(acquired.ok, true);
  const denied = adapter.handoff('claude', 'codex', { cwd: leaseCwd, milestone, boundary: leaseAsk.result.boundary, prefsReader });
  assert.strictEqual(denied.result.outcome, 'blocked');
  assert.strictEqual(denied.result.reason_code, 'lease-active');
  lease.release(leaseCwd, 'execute-task/T01', acquired.owner_token, acquired.generation);

  assert.throws(() => adapter.invoke('terminal', 'status', { cwd, milestone }), (error) => error.code === 'invalid-host');
  assert.throws(() => adapter.invoke('claude', 'handoff', { cwd, milestone, from_runtime: 'claude' }), (error) => error.code === 'invalid-handoff');

  assert(fs.existsSync(path.join(__dirname, 'fixtures', 'vertical-slice', 'handoff-claude-to-codex.json')));
  assert(fs.existsSync(path.join(__dirname, 'fixtures', 'vertical-slice', 'handoff-codex-to-claude.json')));
  console.log('forge-vertical-adapter tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
