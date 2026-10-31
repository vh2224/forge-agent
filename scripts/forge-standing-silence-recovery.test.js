'use strict';

const assert = require('node:assert/strict');
const api = require('./forge-attempt-recovery');
const resolver = require('./forge-dispatch-resolve');
const { digest } = require('./forge-code-roots');
const fixtures = require('./forge-recovery-transition.test');

async function main() {
  const f = fixtures.setup();
  try {
    const options = { cwd: f.owner, unitType: 'plan-slice', scope: 'milestone', phase: 'plan',
      hostRuntime: 'codex', milestoneId: 'M901', unitId: 'S01', roadmapPath: f.roadmap };
    // Milestone transport capability uses unitType; scope remains in request/provenance.
    const request = { ...f.request, route: resolver.resolveDispatch({ ...options, scope: undefined, phase: undefined }) };
    let saved;
    const identity = { unit: 'plan-slice/S01', roots_sha256: digest(f.contract), request,
      clock: () => f.now, persist: state => { saved = structuredClone(state); } };
    const recovery = api.createRecovery(identity);
    recovery.record({ route: request.route, failure_class: 'silence', service_failure_proven: false,
      reason_code: 'claude-anomalous-silence', layer: 'transport-adapter', provider_called: 'unknown',
      request_sha256: 'fixture-request', context_sha256: 'fixture-context', request_bytes: 10,
      context_bytes: 10, budgets: { total: 600000 }, duration_ms: 540001, observation: { silence: { dimension: 'gap',
        window_ms: 540001, threshold_ms: 120000, policy: 'claude-silence-v1', source: 'persisted-calibration', cause: 'indeterminate' } } });
    const initialAttempt = structuredClone(saved.attempts[0]);
    const candidates = api.resolveCandidates(options, undefined, request);
    const inspection = { process_stopped: true, receipt_checked: true, writer_possible: true, roots_reconciled: true };
    const routes = request.route.chain.map(member => ({ ...request.route, model: member.id,
      model_resolved: member.id, worker_mode: member.engine === 'gpt' ? 'native' : 'sidecar',
      resolved_worker_engine: member.engine === 'gpt' ? 'codex' : 'claude' }));
    const scope = { unit: identity.unit, roots_sha256: identity.roots_sha256, purpose: 'sidecar-recovery',
      owner: f.owner, roots: f.contract.code_roots.map(root => root.path),
      request_identity_sha256: saved.request_identity_sha256, chain_sha256: digest(request.route.chain),
      expires_at: f.now + 60000, routes: routes.map(api.routeKey), gates_preserved: true };
    const standing = f.binding.adapter.issueRecoveryException(f.binding.reference, scope);
    const checked = [];
    const input = { inspection, exception: standing, candidateSet: candidates,
      validateInvocation: candidate => { checked.push(candidate.model); return { ok: true }; } };

    await assert.rejects(recovery.next({ ...input, exception: { approved: true,
      authorization_profile: 'fixture', authorization_source_sha256: 'a'.repeat(64) } }), /exception-invalid/);
    assert.equal(checked.length, 0);
    console.log('PASS standing silence: imported authorization fields cannot replace a live opaque exception');
    await assert.rejects(recovery.next({ ...input, inspection: { ...inspection, process_stopped: false } }), /process-receipt/);
    await assert.rejects(recovery.next({ ...input, inspection: { ...inspection, roots_reconciled: false } }), /writer-reconciliation/);
    console.log('PASS standing silence: process and writer reconciliation remain mandatory');

    const oneTime = api.createAuthority(reference => ({ reference, status: 'resolved', answer: 'authorize', resolved_at: 'fixture' }))
      .issue('fixture:one-time', scope, () => f.now);
    const legacy = await recovery.next({ ...input, exception: oneTime });
    assert.equal(legacy.action, 'invoke', JSON.stringify({ result: legacy, actual: { model: request.route.model, resolved: request.route.model_resolved, worker: request.route.resolved_worker_engine, mode: request.route.worker_mode }, granted: scope.routes.includes(api.routeKey(request.route)) }));
    assert.equal(legacy.route.model, request.route.model);
    assert.equal(legacy.silence_retry, true);
    console.log('PASS standing silence: ordinary one-time authorization retains its legacy retry policy');
    checked.length = 0;

    const next = await recovery.next(input);
    assert.equal(next.silence_retry, false);
    assert.equal(next.route.worker_mode, 'native');
    assert.equal(next.route.model, 'gpt-6-astra');
    assert.equal(next.route.tier, request.route.tier);
    assert.equal(next.route.effort, request.route.effort);
    assert.deepEqual(checked, ['gpt-6-astra']);
    assert.equal(next.sidecar_ceiling, null);
    assert.deepEqual(saved.attempts[0], initialAttempt);
    console.log('PASS standing silence: registered source-bound authority advances to the untried native candidate with unchanged tier and effort');

    recovery.questions(['Choose the fixture result']);
    const pending = await recovery.next(input);
    assert.equal(pending.action, 'pending-questions');
    const question = saved.pending_questions.find(row => row.status === 'pending');
    recovery.answer([{ id: question.id, answer: 'Explicit fixture answer' }]);
    const resolved = await recovery.next(input);
    assert.equal(resolved.route.model, 'gpt-6-astra');
    console.log('PASS standing silence: standing recovery never answers a functional question');

    recovery.reserve(resolved, 'fixture-request');
    assert.equal(saved.reservations[0].reason, 'resolved-next-destination');
    const restarted = api.createRecovery({ ...identity, state: saved });
    const afterRestart = await restarted.next(input);
    assert.equal(afterRestart.route.model, 'claude-opus-5');
    assert.equal(afterRestart.silence_retry, false);
    assert.deepEqual(saved.attempts[0], initialAttempt);
    assert.equal(saved.attempts[0].service_failure_proven, false);
    assert.equal(saved.attempts[0].provider_called, 'unknown');
    console.log('PASS standing silence: restart excludes attempted and reserved destinations without inventing a provider failure');

    let calls = 0;
    const rejected = await api.createRecovery({ ...identity, state: { ...saved, reservations: [] } }).next({ ...input,
      validateInvocation: candidate => { calls++; return { ok: candidate.worker_mode !== 'native', reason_code: 'fixture-native-unavailable' }; } });
    assert.equal(calls, 2);
    assert.equal(rejected.route.model, 'claude-opus-5');
    assert.equal(rejected.rejected.length, 1);
    console.log('PASS standing silence: a real adapter refusal advances only within the original authorized list');
  } finally { f.cleanup(); }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main };
