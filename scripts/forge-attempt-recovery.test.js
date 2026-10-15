'use strict';
const assert = require('assert');
const api = require('./forge-attempt-recovery');
async function main() {
  let now = 0, saved;
  const identity = { unit: 'T-recovery', roots_sha256: 'roots', clock: () => now, persist: state => { saved = state; } };
  const route = { unit_type: 'execute-task', host_runtime: 'codex', resolved_worker_engine: 'claude', worker_mode: 'sidecar',
    model: 'claude-sonnet-5', model_resolved: 'claude-sonnet-5', effort: 'medium', tier: 'standard', dispatch_allowed: true };
  const attempt = { reason_code: 'quota', layer: 'provider', request_sha256: 'request', context_sha256: 'context',
    request_bytes: 100, context_bytes: 100, duration_ms: 10, budgets: { total: 1000 }, route,
    failure_class: 'service', service_failure_proven: true, diagnostic: 'token=secret-value' };
  const inspection = { process_stopped: true, receipt_checked: true, writer_possible: false };
  const chain = [{ id: 'claude-sonnet-5', engine: 'claude' }, { id: 'gpt-incompatible', engine: 'gpt' }, { id: 'gpt-6-astra', engine: 'gpt' }, { id: 'claude-opus-4-8', engine: 'claude' }];
  route.chain = chain;
  const recovery = api.createRecovery(identity); recovery.record(attempt);
  assert.strictEqual(saved.attempts[0].provider_called, 'unknown');
  assert(!saved.attempts[0].diagnostic.includes('secret-value'));
  const candidateSet = api.resolveCandidates({}, () => ({ ...route, chain, source: 'fixture-resolver' }));
  const checked = [];
  const next = await recovery.next({ inspection, candidateSet, validateInvocation: async candidate => {
    checked.push(candidate.model); return { ok: candidate.model !== 'gpt-incompatible', reason_code: 'unsupported-model' };
  } });
  assert.strictEqual(next.route.model, 'gpt-6-astra');
  assert.deepStrictEqual(checked, ['gpt-incompatible', 'gpt-6-astra']);
  const unapproved = api.resolveCandidates({}, () => ({ ...route, chain: [{ id: 'gpt-new-unapproved', engine: 'gpt' }] }));
  const rejectedList = await recovery.next({ inspection, candidateSet: unapproved,
    validateInvocation() { throw new Error('unapproved route must never reach adapter'); } });
  assert.strictEqual(rejectedList.reason_code, 'recovery-candidates-exhausted');
  assert(next.provenance.sha256); assert.strictEqual(next.rejected.length, 1);
  await assert.rejects(recovery.next({ inspection, candidateSet: {}, candidates: chain, validateInvocation: async () => ({ ok: true }) }), /provenance/);
  await assert.rejects(recovery.next({ inspection: { ...inspection, writer_possible: true }, candidateSet }), /reconciliation/);
  recovery.questions(['Choose root', 'Choose route']); const questions = saved.pending_questions;
  recovery.answer([{ id: questions[0].id, answer: 'alpha' }]);
  assert.strictEqual((await recovery.next({ inspection })).action, 'pending-questions');
  recovery.answer([{ id: questions[1].id, answer: 'native' }]);
  now = 60001;
  const resumed = api.createRecovery({ ...identity, state: saved });
  assert.strictEqual((await resumed.next({ inspection })).reason_code, 'recovery-deadline-exhausted');
  const timeout = api.createRecovery({ ...identity, state: undefined }); timeout.record({ ...attempt, failure_class: 'timeout' });
  assert.strictEqual((await timeout.next({ inspection })).reason_code, 'timeout-cause-indeterminate');
  await assert.rejects(timeout.next({ inspection, correction: { request_sha256: 'request', offline_validated: true, evidence_reference: 'check' } }), /correction-required/);
  const corrected = await timeout.next({ inspection, correction: { request_sha256: 'new', offline_validated: true, evidence_reference: 'check' }, validateInvocation: async () => ({ ok: true }) });
  assert.strictEqual(corrected.route.model, route.model);
  timeout.record({ ...attempt, failure_class: 'timeout', corrected: true });
  await assert.rejects(timeout.next({ inspection, correction: { request_sha256: 'newer', offline_validated: true, evidence_reference: 'check' } }), /retry-exhausted/);
  assert.throws(() => api.exceptionFor({ approved: true }, identity, now), /exception-invalid/);
  const authority = api.createAuthority(reference => ({ reference, status: 'resolved', answer: 'authorize', resolved_at: new Date().toISOString() }));
  const handle = authority.issue('live-answer', { unit: identity.unit, roots_sha256: identity.roots_sha256, purpose: 'sidecar-recovery',
    expires_at: now + 1000, routes: [api.routeKey(next.route)], gates_preserved: true }, () => now);
  assert.strictEqual(api.exceptionFor(handle, { ...identity, purpose: 'sidecar-recovery' }, now).reference, 'live-answer');
  for (const foreign of [{ ...identity, unit: 'other' }, { ...identity, roots_sha256: 'other' }, { ...identity, purpose: 'other' }]) {
    assert.throws(() => api.exceptionFor(handle, foreign, now), /exception-invalid/);
  }
  assert.throws(() => api.exceptionFor(handle, { ...identity, purpose: 'sidecar-recovery' }, now + 1001), /exception-invalid/);
  assert.throws(() => authority.issue('live-answer', { unit: identity.unit, roots_sha256: 'roots', routes: ['route'],
    purpose: 'sidecar-recovery', expires_at: now + 100, gates_preserved: false }, () => now), /not-authorized/);
  await persistentRecovery(route);
  console.log('PASS recovery clock, canonical candidate provenance/order, adapters, caller repair, pending IDs and live exception');
}
async function persistentRecovery(route) {
  const fs = require('fs'), path = require('path'), stateApi = require('./forge-xllm-state');
  const lab = require('./forge-code-roots.test').laboratory('recovery-state');
  const cwd = path.join(lab.dir, 'code'); fs.mkdirSync(cwd);
  const request = { cwd, unitType: 'execute-task', taskId: 'T-state', prompt: 'before', resultFile: path.join(lab.dir, 'result.json') };
  const stateFile = path.join(lab.dir, 'state.json'), receiptFile = path.join(lab.dir, 'receipt.json');
  fs.writeFileSync(receiptFile, JSON.stringify({ phase: 'failed', failure: { provider_called: false } }));
  const initial = api.captureFailure({ stateFile, receiptFile, request, unit: 'execute-task/T-state', route,
    error: { code: 'context-budget-exceeded', provider_called: false, stderr: 'token=secret' }, budgets: { coding_standards: 3000 } });
  assert.strictEqual(initial.attempts[0].failure_class, 'caller');
  assert.strictEqual(initial.attempts[0].model_sent, 'unknown');
  assert(!fs.readFileSync(stateFile, 'utf8').includes('secret'));
  const base = { stateFile, receiptFile, request, clock: () => initial.started_at + 1,
    validateInvocation: async () => ({ ok: true }) };
  await assert.rejects(api.recoverAttempt({ ...base, request: { ...request, taskId: 'foreign' } }), /identity-mismatch/);
  assert.throws(() => api.captureFailure({ stateFile: path.join(cwd, 'state.json'), request, unit: 'x', route }), /result.*(?:root|inside|outside)|inside.*root/i);
  await assert.rejects(api.recoverAttempt({ ...base, correction: { offline_validated: true } }), /offline-validator-required/);
  let invoked = 0;
  const corrected = { ...request, prompt: 'after offline repair' };
  const retried = await api.recoverAttempt({ ...base, request: corrected, correction: true,
    validateCorrection: async () => ({ ok: true, evidence_reference: 'fixture:offline-check' }),
    invoke: async (selected, _invocation, remaining) => {
      invoked++; assert.strictEqual(selected.model, route.model); assert(remaining > 0 && remaining <= 60000); return { status: 'done' };
    } });
  assert.strictEqual(retried.corrected, true); assert.strictEqual(invoked, 1);
  assert.strictEqual(stateApi.loadRecovery(stateFile).reservations.length, 1);
  // Reloaded state retains the reservation even if the host stopped before it
  // could record the next result, and cannot send a second corrected request.
  await assert.rejects(api.recoverAttempt({ ...base, request: { ...request, prompt: 'second repair' }, correction: true,
    validateCorrection: async () => ({ ok: true, evidence_reference: 'fixture:offline-check' }) }), /retry-exhausted/);
  const child = require('child_process').spawnSync(process.execPath,
    [path.join(__dirname, 'forge-attempt-recovery.js'), '--inspect', stateFile, receiptFile], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(child.status, 0, child.stderr);
  const inspected = JSON.parse(child.stdout);
  assert.strictEqual(inspected.state.deadline_at, initial.deadline_at);
  assert.strictEqual(inspected.state.reservations.length, 1);
  assert.strictEqual((await api.recoverAttempt({ ...base, clock: () => initial.deadline_at + 1 })).reason_code, 'recovery-deadline-exhausted');
  fs.writeFileSync(receiptFile, JSON.stringify({ phase: 'failed', pid: process.pid, execution: {} }));
  let reconciled = 0;
  await assert.rejects(api.recoverAttempt({ ...base, reconcile() { reconciled++; } }), /process-receipt-inspection-required/);
  assert.strictEqual(reconciled, 0, 'a live writer must block before reset');
  fs.writeFileSync(receiptFile, JSON.stringify({ phase: 'failed' }));
  await assert.rejects(api.recoverAttempt(base), /process-receipt-inspection-required/);
  fs.writeFileSync(receiptFile, JSON.stringify({ phase: 'ready', provider_called: true }));
  const replay = await api.recoverAttempt({ ...base, clock: () => initial.deadline_at + 1, processProbe: () => 'stopped',
    resolveDispatch() { throw new Error('saved response must not resolve candidates'); }, replay: async () => ({ status: 'done' }) });
  assert.strictEqual(replay.action, 'replay'); assert.strictEqual(replay.provider_called, false); assert.strictEqual(invoked, 1);
  assert.throws(() => api.validateState({ ...initial, deadline_at: initial.deadline_at + 1 }), /state-invalid/);
  lab.cleanup();
  console.log('PASS persisted recovery: caller repair once, process proof, restart/CLI deadline, identity, external state and zero-inference replay');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
