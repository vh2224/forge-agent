'use strict';
const assert = require('assert');
const api = require('./forge-attempt-recovery');
const { ceilingFromRoute } = require('./forge-worker-timeout');
async function main() {
  await adapterPreflightRecovery();
  const linkedFixtures = require('./forge-loop-failure.test'), linkedFixture = linkedFixtures.fixture();
  try {
    const consumed = linkedFixtures.consume(linkedFixture);
    const entered = linkedFixtures.invoke(linkedFixture, 'reenter', consumed.snapshot, linkedFixtures.entryInput(linkedFixture, consumed));
    const linkedRequest = { ...linkedFixture.request, linked_begin_key: entered.controller_result.details.transaction.idempotency_key };
    assert.throws(() => api.requestIdentity({ ...linkedRequest, linkedEntryBinding: {}, approved: true }), /binding|required/);
    const bound = api.bindLinkedRequest(linkedRequest, { ...linkedFixtures.liveOptions(linkedFixture), ownerToken: linkedFixture.input.owner_token });
    assert.strictEqual(api.requestIdentity(bound).linked_entry.entry_id, 'fixture-entry-1');
    assert.throws(() => api.requestIdentity(JSON.parse(JSON.stringify(bound))), /binding|required/);
  } finally { linkedFixtures.cleanup(linkedFixture); }
  let now = 0, saved;
  const identity = { unit: 'execute-task/T-recovery', roots_sha256: 'roots', clock: () => now, persist: state => { saved = state; } };
  const route = { unit_type: 'execute-task', host_runtime: 'codex', resolved_worker_engine: 'claude', worker_mode: 'sidecar',
    model: 'claude-sonnet-5', model_resolved: 'claude-sonnet-5', effort: 'medium', tier: 'standard', dispatch_allowed: true };
  const attempt = { reason_code: 'quota', layer: 'provider', request_sha256: 'request', context_sha256: 'context',
    request_bytes: 100, context_bytes: 100, duration_ms: 10, budgets: { total: 1000 }, route,
    failure_class: 'service', service_failure_proven: true, diagnostic: 'token=secret-value' };
  const inspection = { process_stopped: true, receipt_checked: true, writer_possible: false };
  const chain = [{ id: 'claude-sonnet-5', engine: 'claude' }, { id: 'gpt-incompatible', engine: 'gpt' }, { id: 'gpt-6-astra', engine: 'gpt' }, { id: 'claude-opus-4-8', engine: 'claude' }];
  route.chain = chain;
  const request = { unitType: 'execute-task', scope: 'standalone-task', phase: 'execute', taskId: 'T-recovery',
    cwd: __dirname, contextRoot: __dirname, route };
  identity.request = request;
  const transitions = require('./forge-recovery-transition');
  assert.strictEqual(transitions.destinationKey(route), transitions.destinationKey({ ...route, tier: 'max', effort: 'max', worker_mode: 'native' }),
    'changing tier, effort or transport cannot re-enable the same host/worker/model destination');
  assert.notStrictEqual(transitions.destinationKey(route), transitions.destinationKey({ ...route, model: 'gpt-6-astra', model_resolved: 'gpt-6-astra' }));
  const resolverOptions = { unitType: request.unitType, scope: request.scope, phase: request.phase, unitId: request.taskId,
    cwd: request.cwd, hostRuntime: 'codex' };
  const recovery = api.createRecovery(identity); recovery.record(attempt);
  assert.strictEqual(saved.schema_version, 2, 'every limit below runs against the v2 state');
  assert.throws(() => recovery.transition({ approved: true, schema_version: 1, sha256: 'recomputed', types: ['resolver-context-omission'] }), /live-handle/);
  assert.deepStrictEqual(recovery.snapshot().attempts, saved.attempts);
  assert.strictEqual(saved.attempts[0].provider_called, 'unknown');
  assert(!saved.attempts[0].diagnostic.includes('secret-value'));
  const candidateSet = api.resolveCandidates(resolverOptions, () => ({ ...route, chain, source: 'fixture-resolver' }), request);
  const checked = [];
  const next = await recovery.next({ inspection, candidateSet, validateInvocation: async candidate => {
    checked.push(candidate.model); return { ok: candidate.model !== 'gpt-incompatible', reason_code: 'unsupported-model' };
  } });
  assert.strictEqual(next.route.model, 'gpt-6-astra');
  assert.deepStrictEqual(checked, ['gpt-incompatible', 'gpt-6-astra']);
  const unapproved = api.resolveCandidates(resolverOptions, () => ({ ...route, chain: [{ id: 'gpt-new-unapproved', engine: 'gpt' }] }), request);
  await assert.rejects(recovery.next({ inspection, candidateSet: unapproved,
    validateInvocation() { throw new Error('unapproved route must never reach adapter'); } }), /candidate-list-changed/);
  assert(next.provenance.sha256); assert.strictEqual(next.rejected.length, 1);
  await assert.rejects(recovery.next({ inspection, candidateSet: {}, candidates: chain, validateInvocation: async () => ({ ok: true }) }), /provenance/);
  await assert.rejects(recovery.next({ inspection: { ...inspection, writer_possible: true }, candidateSet }), /reconciliation/);
  recovery.questions(['Choose root', 'Choose route']); const questions = saved.pending_questions;
  recovery.answer([{ id: questions[0].id, answer: 'alpha' }]);
  assert.strictEqual((await recovery.next({ inspection })).action, 'pending-questions');
  recovery.answer([{ id: questions[1].id, answer: 'native' }]);
  now = 60001;
  const resumed = api.createRecovery({ ...identity, state: saved });
  // Migrated (was recovery-deadline-exhausted): elapsed time alone never stops
  // recovery; candidate provenance and the finite list still decide.
  await assert.rejects(resumed.next({ inspection }), /candidate-provenance-required/);
  const late = await resumed.next({ inspection, candidateSet, validateInvocation: async candidate => ({ ok: candidate.model !== 'gpt-incompatible' }) });
  assert.strictEqual(late.action, 'invoke'); assert.strictEqual(late.route.model, 'gpt-6-astra');
  assert.strictEqual(late.route.worker_mode, 'native'); assert.strictEqual(late.sidecar_ceiling, null, 'native routes carry no sidecar ceiling');
  for (const key of ['remaining_ms', 'sidecar_remaining_ms']) assert(!(key in late), key);
  const timeout = api.createRecovery({ ...identity, state: undefined }); timeout.record({ ...attempt, failure_class: 'timeout' });
  assert.strictEqual((await timeout.next({ inspection })).reason_code, 'timeout-cause-indeterminate');
  await assert.rejects(timeout.next({ inspection, correction: { request_sha256: 'request', offline_validated: true, evidence_reference: 'check' } }), /correction-required/);
  await assert.rejects(timeout.next({ inspection, correction: { kind: 'environment', failure_id: 'forged', request_sha256: 'request', offline_validated: true, evidence_reference: 'check' } }), /correction-required/);
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
  await silenceRecovery(identity, route, attempt, inspection, candidateSet);
  await persistentRecovery({ ...route, worker_mode: 'sidecar', tier: 'heavy', workers_timeout: 21, workers_timeout_source: 'tier-default' });
  await classificationTable(route);
  console.log('PASS C02 modelNotFound recovery classification: true and unknown provider remain unknown without service or timeout cause');
  await activeBudgetRecovery(identity, route, attempt, inspection, candidateSet);
  await sessionResumeRecovery({ ...route, worker_mode: 'sidecar', tier: 'heavy', workers_timeout: 21, workers_timeout_source: 'tier-default' });
  await codexAppServerRecovery(identity, route, attempt, inspection, candidateSet);
  await modelNotFoundRecovery(identity, route, attempt, inspection, candidateSet);
  console.log('PASS C02 modelNotFound recovery: no live authority stops without invocation and the authorized route uses another model');
  await inboundInputRecovery(identity, route, attempt, inspection, candidateSet);
  await canonicalProvenance();
  await continuationCrashRace();
  stateSchema(identity, attempt);
  await migratedLimits(identity, route, attempt, inspection, candidateSet);
  console.log('PASS recovery without cumulative clock, canonical candidate provenance/order, adapters, caller repair, pending IDs and live exception');
}
async function continuationCrashRace() {
  const fs = require('fs'), path = require('path'), cp = require('child_process');
  const fixtures = require('./forge-recovery-transition.test'), f = await fixtures.ordinaryFixture();
  try {
    const file = path.join(f.dir, 'continuation-fixture.json');
    const calls = path.join(f.dir, 'native-calls.txt');
    fs.writeFileSync(file, JSON.stringify({ request: f.request, stateFile: f.stateFile, receiptFile: f.receiptFile,
      contract: f.contract, profile: f.profile, history: f.history, now: f.now, originalOptions: f.originalOptions,
      roadmap: f.roadmap, transitions: f.transitions, resume: f.resume, calls }));
    const run = () => new Promise((resolve, reject) => {
      const child = cp.spawn(process.execPath, [__filename, '--continuation-crash', file], { windowsHide: true });
      let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
      child.on('error', reject); child.on('exit', code => resolve({ code, output }));
    });
    const outcomes = await Promise.all([run(), run()]);
    assert.strictEqual(outcomes.filter(row => row.code === 73).length, 1, JSON.stringify(outcomes));
    assert.strictEqual(fs.readFileSync(calls, 'utf8'), 'consumed\n');
    const saved = require('./forge-xllm-state').loadRecovery(f.stateFile);
    assert.strictEqual(saved.continuation.status, 'dispatch-possible');
    assert.deepStrictEqual(saved.reservations, f.initial.reservations);
    const afterCrash = await run(); assert.notStrictEqual(afterCrash.code, 73, afterCrash.output);
    assert.strictEqual(fs.readFileSync(calls, 'utf8'), 'consumed\n');
    console.log('PASS continuation CAS: competing OS processes, crash after consumption, restart refuses a second native call');
  } finally { f.cleanup(); }
}
async function continuationCrash() {
  const fs = require('fs'), fixture = require('./forge-recovery-transition.test');
  const f = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')); f.binding = fixture.authority(f);
  const digest = require('./forge-code-roots').digest;
  await api.recoverAttempt(fixture.options(f, { transitions: f.transitions, resumeReservation: f.resume,
    transitionAdapter: fixture.adapter(f, { attestUninvoked: challenge => ({ ...challenge,
      binding_sha256: digest(challenge), status: 'uninvoked', native_calls: 0, evidence_reference: 'fixture:retained-native-tool-census' }) }),
    invoke: async (_route, invocation, _remaining, guard) => {
      guard.consumeInvocation(invocation); fs.appendFileSync(f.calls, 'consumed\n'); process.exit(73);
    },
  }));
}
async function silenceRecovery(identity, route, attempt, inspection, candidateSet) {
  let now = 0, saved;
  const options = { ...identity, state: undefined, clock: () => now, persist: value => { saved = value; } };
  const silence = { dimension: 'initial', window_ms: 120001, threshold_ms: 120000,
    policy: 'claude-silence-v1', source: 'persisted-calibration', cause: 'indeterminate' };
  const session = api.createRecovery(options);
  session.record({ ...attempt, failure_class: 'silence', service_failure_proven: false, observation: { silence } });
  const authority = api.createAuthority(reference => ({ reference, status: 'resolved', answer: 'authorize', resolved_at: 'fixture' }));
  const alternate = { ...route, model: 'gpt-6-astra', model_resolved: 'gpt-6-astra',
    resolved_worker_engine: 'codex', worker_mode: 'native' };
  const exception = authority.issue('fixture:silence', { unit: identity.unit, roots_sha256: identity.roots_sha256,
    purpose: 'sidecar-recovery', expires_at: 120000, routes: [api.routeKey(route), api.routeKey(alternate)], gates_preserved: true }, () => now);
  const input = { inspection, exception, candidateSet, validateInvocation: async () => ({ ok: true }) };
  now = 1000;
  const retry = await session.next(input);
  assert.equal(retry.route.model, route.model); assert.equal(retry.silence_retry, true);
  // Migrated (was remaining_ms 30000): the silence retry receives the tier ceiling.
  assert.deepStrictEqual(retry.sidecar_ceiling, ceilingFromRoute(route)); assert.strictEqual(retry.sidecar_ceiling.seconds, 1800);
  assert(!('remaining_ms' in retry) && !('sidecar_remaining_ms' in retry));
  session.reserve(retry, attempt.request_sha256);
  const restart = api.createRecovery({ ...options, state: saved });
  const pending = await restart.next({ ...input, validateInvocation() { throw Error('pending retry cannot validate another writer'); } });
  assert.equal(pending.reason_code, 'recovery-reservation-pending');
  assert.equal(restart.snapshot().reservations.length, 1);
  assert.equal(restart.snapshot().reservations[0].request_sha256, attempt.request_sha256);
  restart.record({ ...attempt, failure_class: 'silence', service_failure_proven: false, observation: { silence } });
  const following = await restart.next(input);
  assert.equal(following.route.model, 'gpt-6-astra', 'only one unchanged same-target retry is available');
  assert.equal(following.silence_retry, false);
  // Migrated (was clock rollback / remaining() 1000): v2 has no clock to renew.
  now = 59000; const expired = api.createRecovery({ ...options, state: saved });
  assert.strictEqual(expired.remaining, undefined);
  for (const key of ['deadline_at', 'budget_remaining_ms', 'clock_high_water']) assert(!(key in expired.snapshot()), key);
  // Migrated (was 55000 -> recovery-deadline-exhausted): a late silence retry
  // still runs once, with the full tier ceiling and an explicit source honoured.
  const explicitRoute = { ...route, workers_timeout: 2400, workers_timeout_source: 'explicit' };
  const late = api.createRecovery({ ...options, state: undefined, clock: () => 0 });
  late.record({ ...attempt, route: explicitRoute, failure_class: 'silence', observation: { silence } });
  const almostSpent = api.createRecovery({ ...options, state: late.snapshot(), clock: () => 55000 });
  const lateRetry = await almostSpent.next({ ...input, exception: authority.issue('fixture:late', { unit: identity.unit,
    roots_sha256: identity.roots_sha256, purpose: 'sidecar-recovery', expires_at: 120000,
    routes: [api.routeKey(explicitRoute)], gates_preserved: true }, () => 55000) });
  assert.strictEqual(lateRetry.silence_retry, true);
  assert.deepStrictEqual(lateRetry.sidecar_ceiling, ceilingFromRoute(explicitRoute));
  assert.strictEqual(lateRetry.sidecar_ceiling.seconds, 2400); assert.strictEqual(lateRetry.sidecar_ceiling.source, 'explicit');
  console.log('PASS anomalous silence: trusted threshold, one durable same-target reservation, restart exclusion, fallback and tier ceiling');
}
// The whole captureFailure classification table: a live stream at the safety
// ceiling (budget-exceeded-while-active) is never a timeout nor a destination failure.
async function classificationTable(route) {
  const fs = require('fs'), path = require('path');
  const lab = require('./forge-code-roots.test').laboratory('recovery-classification');
  const cwd = path.join(lab.dir, 'code'); fs.mkdirSync(cwd);
  const request = { cwd, contextRoot: cwd, scope: 'milestone', phase: 'research', unitType: 'research-milestone',
    milestoneId: 'M001', route: { ...route, unit_type: 'research-milestone' }, prompt: 'before', resultFile: path.join(lab.dir, 'result.json') };
  const silence = { dimension: 'initial', window_ms: 120001, threshold_ms: 120000,
    policy: 'claude-silence-v1', source: 'persisted-calibration', cause: 'indeterminate' };
  const cases = [
    ['claude-timeout', 'unknown', null, 'timeout'],
    ['codex-timeout', true, null, 'timeout'],
    ['claude-anomalous-silence', 'unknown', { version: 1, silence }, 'silence'],
    ['budget-exceeded-while-active', true, null, 'active-budget'],
    ['budget-exceeded-while-active', false, null, 'active-budget'],
    ['budget-exceeded-while-active', 'unknown', null, 'active-budget'],
    ['quota', true, null, 'service'],
    ['rate-limit', true, null, 'service'],
    ['context-budget-exceeded', false, null, 'caller'],
    ['claude-exit-nonzero', 'unknown', null, 'unknown'],
    // S01/T04: a missing requested model proves neither an outage nor a timeout.
    ['model-not-found', true, null, 'unknown'],
    ['model-not-found', 'unknown', null, 'unknown'],
  ];
  cases.forEach(([code, provider, observation, expected], index) => {
    const stateFile = path.join(lab.dir, `state-${index}.json`);
    const error = { code, ...(provider === 'unknown' ? {} : { provider_called: provider }),
      ...(observation ? { diagnostic: { reason: 'anomalous-silence', observation } } : {}) };
    const captured = api.captureFailure({ stateFile, request, unit: 'research-milestone/M001', route,
      finalEvidence: require('./forge-attempt-telemetry').captureFinal({ request: { argv: ['--model', route.model] }, context: request.prompt }),
      error, budgets: { coding_standards: 3000 } }).attempts.at(-1);
    assert.strictEqual(captured.failure_class, expected, `${code} (provider ${provider}) -> ${expected}`);
    assert.strictEqual(captured.provider_called, provider);
    assert.strictEqual(captured.reason_code, code);
    if (expected === 'active-budget') {
      assert.strictEqual(captured.timeout_cause, null);
      assert.strictEqual(captured.service_failure_proven, false);
    }
    if (expected === 'timeout' || expected === 'silence') assert.strictEqual(captured.timeout_cause, 'indeterminate');
    if (code === 'model-not-found') {
      assert.strictEqual(captured.service_failure_proven, false, 'model-not-found never proves a service outage');
      assert.strictEqual(captured.timeout_cause, null, 'model-not-found never carries a timeout cause');
    }
  });
  console.log('PASS classification table: timeout, silence, active-budget, service, caller and unknown');
}
// S01/T04 (issue 279): model-not-found follows the generic unknown branch. With no
// live standing authorization the recovery stops unproved; it never resolves,
// validates or invokes a candidate, and never retries the same missing model.
// Only the existing authorized path may move to another candidate.
async function modelNotFoundRecovery(identity, route, attempt, inspection, candidateSet) {
  const fs = require('fs'), path = require('path'), { digest } = require('./forge-code-roots');
  const lab = require('./forge-code-roots.test').laboratory('recovery-model-not-found');
  const cwd = path.join(lab.dir, 'code'); fs.mkdirSync(cwd);
  const codexRoute = { ...route, resolved_worker_engine: 'codex', model: 'gpt-missing-model', model_resolved: 'gpt-missing-model',
    worker_mode: 'sidecar', tier: 'heavy', workers_timeout: 21, workers_timeout_source: 'tier-default' };
  const request = { cwd, contextRoot: cwd, scope: 'milestone', phase: 'research', unitType: 'research-milestone',
    milestoneId: 'M001', route: { ...codexRoute, unit_type: 'research-milestone' }, prompt: 'codex', resultFile: path.join(lab.dir, 'result.json') };
  const receiptFile = path.join(lab.dir, 'receipt.json');
  fs.writeFileSync(receiptFile, JSON.stringify({ phase: 'failed', dispatch_id: 'dispatch-model-not-found',
    recovery_identity_sha256: digest(api.requestIdentity(request)), failure: { provider_called: true } }));
  // The error shape forge-appserver-client rejects with: fixed message, closed code
  // and diagnostic, plus a provider stderr tail that must not influence the class.
  const error = { code: 'model-not-found', provider_called: true, codexErrorInfo: 'modelNotFound', turnStatus: 'failed',
    message: 'forge-appserver-client: turn ended with status failed (modelNotFound)',
    stderrTail: 'network connection terminated 503 private-sentinel',
    diagnostic: require('./forge-sidecar-diagnostic').diagnostic('model-not-found', { observation: { phase: 'failed' } }) };
  const stateFile = path.join(lab.dir, 'state.json');
  const captured = api.captureFailure({ stateFile, receiptFile, request, unit: 'research-milestone/M001', route: codexRoute,
    finalEvidence: require('./forge-attempt-telemetry').captureFinal({ request: { argv: ['--model', codexRoute.model] }, context: request.prompt }),
    error, budgets: { coding_standards: 3000 } }).attempts.at(-1);
  assert.strictEqual(captured.failure_class, 'unknown');
  assert.strictEqual(captured.reason_code, 'model-not-found');
  assert.strictEqual(captured.service_failure_proven, false);
  assert.strictEqual(captured.timeout_cause, null);
  assert(!JSON.stringify(captured).includes('private-sentinel'), 'provider stderr never reaches the recovery state');
  const stopped = await api.recoverAttempt({ stateFile, receiptFile, request, clock: () => Date.now(), processProbe: () => 'stopped',
    resolveDispatch() { throw Error('model-not-found without live authority must not resolve candidates'); },
    validateInvocation: async () => { throw Error('model-not-found without live authority must not validate a candidate'); },
    invoke() { throw Error('model-not-found without live authority must not invoke'); } });
  assert.strictEqual(stopped.action, 'stop');
  assert.strictEqual(stopped.reason_code, 'recovery-cause-unproved');
  assert(!('route' in stopped) && !('resume' in stopped), 'no candidate advance and no resume');
  // Same row through the in-memory session: no scope stops; the existing live
  // standing exception remains the only path, and never back to the missing model.
  // Same tier/effort as the original route, so only the model differs.
  const missingRoute = { ...route, model: 'gpt-missing-model', model_resolved: 'gpt-missing-model' };
  const row = { ...attempt, route: missingRoute, reason_code: 'model-not-found', failure_class: 'unknown', service_failure_proven: false };
  const bare = api.createRecovery({ ...identity, state: undefined, clock: () => 0, persist: undefined });
  bare.record(row);
  assert.deepStrictEqual(await bare.next({ inspection, candidateSet, validateInvocation: async () => { throw Error('no scope, no adapter'); } }),
    { action: 'stop', reason_code: 'recovery-cause-unproved' });
  // The candidate the existing path selects, used only to scope the live exception.
  const probe = api.createRecovery({ ...identity, state: undefined, clock: () => 0, persist: undefined });
  probe.record(attempt);
  const target = (await probe.next({ inspection, candidateSet, validateInvocation: async () => ({ ok: true }) })).route;
  const authority = api.createAuthority(reference => ({ reference, status: 'resolved', answer: 'authorize', resolved_at: 'fixture' }));
  const exception = authority.issue('fixture:model-not-found', { unit: identity.unit, roots_sha256: identity.roots_sha256,
    purpose: 'sidecar-recovery', expires_at: 120000, routes: [api.routeKey(missingRoute), api.routeKey(target)], gates_preserved: true }, () => 0);
  const authorized = api.createRecovery({ ...identity, state: undefined, clock: () => 0, persist: undefined });
  authorized.record(row);
  const decision = await authorized.next({ inspection, exception, candidateSet, validateInvocation: async () => ({ ok: true }) });
  assert.strictEqual(decision.action, 'invoke', `the existing authorized path is preserved: ${JSON.stringify(decision)}`);
  assert.strictEqual(api.routeKey(decision.route), api.routeKey(target));
  assert.notStrictEqual(decision.route.model, missingRoute.model, 'never the same missing model again');
  assert.notStrictEqual(decision.silence_retry, true);
  console.log('PASS model-not-found: unknown class, no outage or timeout cause, stops unproved without live authority');
}
// S04/T02: the app-server asked for human input and the client stopped the turn.
// captureFailure turns each closed input record into a stable pending question;
// after explicit answers the recovery stops for the owner's continuation, and the
// standing exception, candidate set or a correction never answer it.
async function inboundInputRecovery(identity, route, attempt, inspection, candidateSet) {
  const fs = require('fs'), path = require('path'), crypto = require('crypto'), { digest } = require('./forge-code-roots');
  const client = require('./forge-appserver-client');
  // The recovery constants are local (it never loads the client); bind them here.
  assert.strictEqual(api.INPUT_REQUIRED_CODE, client.APPSERVER_INPUT_CODES.INPUT_REQUIRED);
  assert.deepStrictEqual(api.INBOUND_INPUT_METHODS.slice().sort(), Object.entries(client.INBOUND_REQUEST_CLASSES)
    .filter(([, kind]) => kind === 'input').map(([method]) => method).sort());
  const lab = require('./forge-code-roots.test').laboratory('recovery-inbound-input');
  const cwd = path.join(lab.dir, 'code'); fs.mkdirSync(cwd);
  const codexRoute = { ...route, resolved_worker_engine: 'codex', model: 'gpt-requested-model', model_resolved: 'gpt-requested-model',
    worker_mode: 'sidecar', tier: 'heavy', workers_timeout: 21, workers_timeout_source: 'tier-default' };
  const unit = 'research-milestone/M001';
  const request = { cwd, contextRoot: cwd, scope: 'milestone', phase: 'research', unitType: 'research-milestone',
    milestoneId: 'M001', dispatchId: 'dispatch-s04-input', route: { ...codexRoute, unit_type: 'research-milestone' },
    prompt: 'codex', resultFile: path.join(lab.dir, 'result.json') };
  const receiptFile = path.join(lab.dir, 'receipt.json');
  fs.writeFileSync(receiptFile, JSON.stringify({ phase: 'failed', dispatch_id: request.dispatchId,
    recovery_identity_sha256: digest(api.requestIdentity(request)), failure: { provider_called: true } }));
  const sentinel = 'FORGE_S04_PROVIDER_SENTINEL';
  const userInput = { id: 'req-1', method: 'item/tool/requestUserInput', class: 'input', thread_id: 'thread-1', turn_id: 'turn-1' };
  const elicitation = { id: 901, method: 'mcpServer/elicitation/request', class: 'input', thread_id: 'thread-1', turn_id: 'turn-1' };
  // The exact rejection forge-appserver-client builds (sessionError + terminateTurn),
  // plus records outside the closed form that must be ignored, never asked.
  const clientError = Object.assign(new Error(client.APPSERVER_INPUT_MESSAGES.INPUT_REQUIRED), {
    code: client.APPSERVER_INPUT_CODES.INPUT_REQUIRED,
    inboundRequests: [userInput, elicitation,
      { ...userInput, id: 'req-extra', params: { question: sentinel } },
      { ...userInput, id: `bad id ${sentinel}` },
      { ...userInput, id: 7, method: 'execCommandApproval', class: 'approval' },
      { ...userInput, id: 8, class: 'approval' },
      { ...userInput, id: 9, thread_id: `${sentinel} thread` },
      `${sentinel} string`, null],
    diagnostic: require('./forge-sidecar-diagnostic').diagnostic('appserver-input-required', { observation: { phase: 'failed' } }),
    timeoutMs: 21000, interrupt: client.INTERRUPT_OUTCOMES.ACKNOWLEDGED, turnId: 'turn-1', turnIdSource: 'turn/started',
    turnCompletions: { observed: 0, matched: 0, ignored: 0, dropped: 0, records: [] },
    retention: { limits: client.RETENTION_LIMITS, dropped: { notifications: 0, items: 0, inboundRequests: 0, turnCompletions: 0 } },
    discarded: { count: 0, kinds: {}, sample: [] }, stderrTail: `network connection terminated 503 ${sentinel}` });
  const stateFile = path.join(lab.dir, 'state.json');
  // forge-unit-sidecar recordFailure spreads the client error into captureFailure.
  const capture = providerCalled => api.captureFailure({ stateFile, receiptFile, request, unit, route: codexRoute,
    finalEvidence: require('./forge-attempt-telemetry').captureFinal({ request: { argv: ['--model', codexRoute.model] }, context: request.prompt }),
    error: { ...clientError, provider_called: providerCalled }, budgets: { coding_standards: 3000 } });
  const first = capture(true);
  const row = first.attempts.at(-1);
  assert.strictEqual(row.failure_class, 'unknown');
  assert.strictEqual(row.reason_code, 'appserver-input-required');
  assert.strictEqual(row.service_failure_proven, false);
  assert.strictEqual(row.timeout_cause, null);
  assert.deepStrictEqual(row.inbound_requests, [userInput, elicitation], 'only the closed input records are kept');
  const expectedId = record => `inbound-${crypto.createHash('sha256').update(JSON.stringify([unit, request.dispatchId,
    record.thread_id, record.turn_id, record.id, record.method])).digest('hex').slice(0, 24)}`;
  assert.deepStrictEqual(first.pending_questions.map(q => [q.id, q.status]),
    [[expectedId(userInput), 'pending'], [expectedId(elicitation), 'pending']]);
  for (const [question, record] of [[first.pending_questions[0], userInput], [first.pending_questions[1], elicitation]]) {
    assert.match(question.id, /^inbound-[0-9a-f]{24}$/);
    assert.strictEqual(question.question, `A unidade ${unit} recebeu do sidecar app-server o pedido de entrada humana ${record.method} `
      + `(request ${record.id}); o turno foi parado e a recusa aguarda decisão explícita do owner.`);
  }
  const persisted = fs.readFileSync(stateFile, 'utf8');
  assert(!persisted.includes(sentinel), 'no provider text, params or stderr in the recovery state');
  assert(!/req-extra|execCommandApproval|bad id/.test(persisted), 'malformed records are ignored');
  // The same failure captured again maps to the same questions; provider_called
  // false does not turn it into a caller defect.
  const again = capture(false);
  assert.strictEqual(again.attempts.length, 2);
  assert.strictEqual(again.attempts.at(-1).failure_class, 'unknown');
  assert.deepStrictEqual(again.pending_questions.map(q => q.id), first.pending_questions.map(q => q.id));
  // Through recoverAttempt: pending blocks, then explicit answers stop for the owner.
  const guarded = { stateFile, receiptFile, request, clock: () => Date.now(), processProbe: () => 'stopped',
    resolveDispatch() { throw Error('an input stop must not resolve candidates'); },
    validateInvocation: async () => { throw Error('an input stop must not validate a candidate'); },
    invoke() { throw Error('an input stop must not invoke'); } };
  const blocked = await api.recoverAttempt(guarded);
  assert.strictEqual(blocked.action, 'pending-questions');
  assert.deepStrictEqual(blocked.questions.map(q => q.id), first.pending_questions.map(q => q.id));
  const answered = await api.recoverAttempt({ ...guarded,
    answers: first.pending_questions.map(q => ({ id: q.id, answer: 'manter a recusa' })) });
  assert.deepStrictEqual(answered, { action: 'stop', reason_code: 'answered-continuation-required' });
  assert(require('./forge-xllm-state').loadRecovery(stateFile).pending_questions.every(q => q.status === 'resolved'));
  // In memory, with a live standing exception and a candidate set: pending first,
  // then the same stop. No invoke, silence retry, corrected retry, resume or walk.
  const probe = api.createRecovery({ ...identity, state: undefined, clock: () => 0, persist: undefined });
  probe.record(attempt);
  const target = (await probe.next({ inspection, candidateSet, validateInvocation: async () => ({ ok: true }) })).route;
  const authority = api.createAuthority(reference => ({ reference, status: 'resolved', answer: 'authorize', resolved_at: 'fixture' }));
  const exception = authority.issue('fixture:inbound-input', { unit: identity.unit, roots_sha256: identity.roots_sha256,
    purpose: 'sidecar-recovery', expires_at: 120000, routes: [api.routeKey(route), api.routeKey(target)], gates_preserved: true }, () => 0);
  const session = api.createRecovery({ ...identity, state: undefined, clock: () => 0, persist: undefined });
  session.record({ ...attempt, reason_code: 'appserver-input-required', failure_class: 'unknown', service_failure_proven: false,
    inbound_requests: [userInput] });
  session.questions([{ id: expectedId(userInput), question: 'fixture input question' }]);
  const refuse = async () => { throw Error('an input stop must not reach the adapter'); };
  const pendingDecision = await session.next({ inspection, exception, candidateSet, validateInvocation: refuse });
  assert.strictEqual(pendingDecision.action, 'pending-questions');
  session.answer([{ id: expectedId(userInput), answer: 'manter a recusa' }]);
  for (const extra of [{}, { correction: { request_sha256: 'new', offline_validated: true, evidence_reference: 'check' } }]) {
    const decision = await session.next({ inspection, exception, candidateSet, validateInvocation: refuse, ...extra });
    assert.deepStrictEqual(decision, { action: 'stop', reason_code: 'answered-continuation-required' });
  }
  assert.strictEqual(session.inspect().reservations, undefined, 'no reservation');
  assert.strictEqual(session.inspect().selection, undefined, 'no candidate selection');
  // The gate is the reason code: the same row as model-not-found keeps its path.
  const control = api.createRecovery({ ...identity, state: undefined, clock: () => 0, persist: undefined });
  control.record({ ...attempt, reason_code: 'model-not-found', failure_class: 'unknown', service_failure_proven: false });
  assert.strictEqual((await control.next({ inspection, exception, candidateSet, validateInvocation: async () => ({ ok: true }) })).action, 'invoke');
  console.log('PASS C11 inbound input recovery: client error shape, stable inbound IDs, closed records, pending block and answered-continuation stop');
}
// Migrated from the S03 named stop: after the existing pending-question,
// inspection, replay and reconciliation checks, active-budget either resumes
// the same session once (same route, no exception, no candidate selection) or
// stops with a named refusal. silence/timeout (dead) never resume.
async function activeBudgetRecovery(identity, route, attempt, inspection, candidateSet) {
  const sessions = require('./forge-claude-session'), path = require('path'), os = require('os');
  // Fixture ref only: no test here removes anything, and the profile path is fictitious.
  const ref = sessions.createSessionRef({ id: sessions.newSessionId(), accountName: null,
    configDir: path.join(os.tmpdir(), 'forge-fixture-claude-profile', '.claude'), cwd: __dirname, now: 0 });
  let now = 0, saved;
  const options = { ...identity, state: undefined, clock: () => now, persist: value => { saved = value; } };
  const budget = { ...attempt, reason_code: 'budget-exceeded-while-active', failure_class: 'active-budget',
    service_failure_proven: false, provider_called: true };
  const session = api.createRecovery(options);
  session.record({ ...budget, session: ref });
  assert.strictEqual(saved.attempts.at(-1).timeout_cause, null);
  assert.deepStrictEqual(saved.attempts.at(-1).session, JSON.parse(JSON.stringify(ref)), 'the ref is kept as a plain clone');
  const authority = api.createAuthority(reference => ({ reference, status: 'resolved', answer: 'authorize', resolved_at: 'fixture' }));
  const alternate = { ...route, model: 'gpt-6-astra', model_resolved: 'gpt-6-astra', resolved_worker_engine: 'codex', worker_mode: 'native' };
  const exception = authority.issue('fixture:active-budget', { unit: identity.unit, roots_sha256: identity.roots_sha256,
    purpose: 'sidecar-recovery', expires_at: 120000, routes: [api.routeKey(route), api.routeKey(alternate)], gates_preserved: true }, () => now);
  const receipted = { ...inspection, receipt_sha256: 'receipt-before', receipt: { dispatch_id: 'dispatch-before' } };
  const validated = [];
  const validateInvocation = async candidate => { validated.push(api.routeKey(candidate)); return { ok: true, adapter: 'fixture' }; };
  const input = { inspection: receipted, exception, candidateSet, validateInvocation };
  await assert.rejects(session.next({ ...input, inspection: undefined }), /process-receipt-inspection-required/);
  await assert.rejects(session.next({ ...input, inspection: { ...receipted, writer_possible: true } }), /writer-reconciliation-required/,
    'without reconciliation there is no resume');
  assert.strictEqual((await session.next({ ...input, inspection: { ...receipted, valid_saved_response: true } })).action, 'replay');
  assert.deepStrictEqual(validated, [], 'no adapter validation before inspection/replay/reconciliation');
  assert.strictEqual(saved.selection, undefined);
  for (const [variant, at] of [[input, 1000], [{ inspection: receipted, validateInvocation }, 2000],
    [{ ...input, inspection: { ...receipted, writer_possible: true, roots_reconciled: true } }, 60001]]) {
    now = at;
    const decision = await session.next(variant);
    assert.strictEqual(decision.action, 'invoke');
    assert.strictEqual(api.routeKey(decision.route), api.routeKey(route), 'same tier/effort/model route');
    assert.strictEqual(decision.resume.session.id, ref.id);
    assert.strictEqual(decision.resume.session_sha256, sessions.sessionDigest(ref.id));
    assert.deepStrictEqual(decision.resume.resumed_from, { receipt_sha256: 'receipt-before', dispatch_id: 'dispatch-before' });
    assert.deepStrictEqual(decision.sidecar_ceiling, JSON.parse(JSON.stringify(ceilingFromRoute(route))));
    assert.strictEqual(decision.sidecar_ceiling.seconds, ceilingFromRoute(route).seconds);
    assert.strictEqual(decision.corrected, false); assert.strictEqual(decision.provider_called, false);
    for (const key of ['authorization_reference', 'authorization_expires_at', 'native_authorization_remaining_ms']) assert(!(key in decision), key);
    assert.deepStrictEqual(saved.selection, { provenance: null, rejected: [], selected: api.routeKey(route) });
  }
  assert(validated.every(key => key === api.routeKey(route)), 'the alternate candidate is never validated');
  assert.doesNotThrow(() => api.exceptionFor(exception, saved, now), 'the standing exception is not consumed');
  assert.deepStrictEqual(await session.next({ inspection: receipted,
    validateInvocation: async () => ({ ok: false, reason_code: 'claude-resume-config-mismatch' }) }),
  { action: 'stop', reason_code: 'budget-exceeded-resume-refused', refusal: 'claude-resume-config-mismatch' });
  const resume = await session.next(input);
  session.reserve(resume, 'request');
  const reservation = saved.reservations.at(-1);
  assert.strictEqual(reservation.reason, 'same-session-resume');
  assert.strictEqual(reservation.session_sha256, sessions.sessionDigest(ref.id));
  assert(!JSON.stringify(saved.reservations).includes(ref.id) && !JSON.stringify(saved.selection).includes(ref.id), 'reservations carry only the digest');
  assert.deepStrictEqual(await session.next(input), { action: 'stop', reason_code: 'recovery-reservation-pending' },
    'a reserved resume with no recorded outcome may still be running: pending, never exhausted');
  session.record({ ...budget, session: null });
  assert.deepStrictEqual(await session.next(input), { action: 'stop', reason_code: 'budget-exceeded-resume-exhausted' });
  session.record({ ...budget, session: ref });
  assert.deepStrictEqual(await session.next(input), { action: 'stop', reason_code: 'budget-exceeded-resume-exhausted' }, 'at most one resume per unit');
  session.questions(['Pending choice']);
  assert.strictEqual((await session.next(input)).action, 'pending-questions', 'pending questions still come first');
  const bare = api.createRecovery({ ...identity, state: undefined, clock: () => 0, persist: undefined });
  bare.record(budget);
  assert.deepStrictEqual(await bare.next({ inspection: receipted, validateInvocation }), { action: 'stop', reason_code: 'budget-exceeded-resume-unavailable' });
  assert.throws(() => bare.record({ ...attempt, failure_class: 'timeout', session: ref }), /recovery-session-class-invalid/);
  assert.throws(() => bare.record({ ...budget, session: { ...ref, id: 'not-a-uuid' } }), /recovery-session-invalid/);
  const silence = { dimension: 'initial', window_ms: 120001, threshold_ms: 120000,
    policy: 'claude-silence-v1', source: 'persisted-calibration', cause: 'indeterminate' };
  for (const dead of [{ ...attempt, failure_class: 'silence', service_failure_proven: false, observation: { silence } },
    { ...attempt, failure_class: 'timeout', service_failure_proven: false }]) {
    const chained = api.createRecovery({ ...identity, state: undefined, clock: () => 0, persist: undefined });
    chained.record({ ...budget, session: ref }); chained.record(dead);
    for (const variant of [{ inspection: receipted, validateInvocation }, input]) {
      const decision = await chained.next(variant);
      assert(!('resume' in decision), dead.failure_class + ' is never resumed');
    }
  }
  const legacy = bare.snapshot();
  assert(!('session' in legacy.attempts[0]), 'an attempt without a ref keeps the old shape');
  assert.strictEqual(api.validateState(legacy), legacy, 'v2 without session remains valid');
  const v1 = legacyV1(legacy);
  assert.strictEqual(api.validateState(v1), v1, 'v1 without session remains valid');
  console.log('PASS active-budget: single same-session resume after inspection/reconciliation, exhausted/unavailable/refused stops, dead never resumed');
}
// recoverAttempt end-to-end on disk: ref captured, resume handed to invoke as
// the 6th argument, then the exhausted stop removes the session.
// S07: the codex app-server liveness kill gets the Claude semantics. An indeterminate
// silence is class 'silence' with a single same-target retry; a live stream at the
// ceiling is 'active-budget', and without a Claude session it stops as unavailable.
async function codexAppServerRecovery(identity, route, attempt, inspection, candidateSet) {
  const fs = require('fs'), path = require('path');
  const liveness = require('./forge-sidecar-liveness'), { digest } = require('./forge-code-roots');
  const lab = require('./forge-code-roots.test').laboratory('recovery-codex-appserver');
  const cwd = path.join(lab.dir, 'code'); fs.mkdirSync(cwd);
  const codexRoute = { ...route, resolved_worker_engine: 'codex', model: 'gpt-6-codex', model_resolved: 'gpt-6-codex',
    worker_mode: 'sidecar', tier: 'heavy', workers_timeout: 21, workers_timeout_source: 'tier-default' };
  const request = { cwd, contextRoot: cwd, scope: 'milestone', phase: 'research', unitType: 'research-milestone',
    milestoneId: 'M001', route: { ...codexRoute, unit_type: 'research-milestone' }, prompt: 'codex', resultFile: path.join(lab.dir, 'result.json') };
  const receiptFile = path.join(lab.dir, 'receipt.json');
  fs.writeFileSync(receiptFile, JSON.stringify({ phase: 'failed', dispatch_id: 'dispatch-codex',
    recovery_identity_sha256: digest(api.requestIdentity(request)), failure: { provider_called: true } }));
  const capture = (stateFile, error) => api.captureFailure({ stateFile, receiptFile, request, unit: 'research-milestone/M001',
    route: codexRoute, finalEvidence: require('./forge-attempt-telemetry').captureFinal({ request: { argv: ['--model', codexRoute.model] }, context: request.prompt }),
    error, budgets: { coding_standards: 3000 } });
  // Same block shape forge-appserver-client's silenceError puts in the diagnostic.
  const silence = { dimension: 'gap', window_ms: 240001, threshold_ms: liveness.DEFAULTS.deadMs,
    policy: liveness.POLICY, source: liveness.SOURCE_DEFAULT, cause: 'indeterminate' };
  const silenceError = { code: 'appserver-anomalous-silence', provider_called: true,
    diagnostic: { reason: 'anomalous-silence', observation: { version: 1, silence } } };
  const dead = capture(path.join(lab.dir, 'silence.json'), silenceError).attempts.at(-1);
  assert.strictEqual(dead.failure_class, 'silence', 'codex anomalous silence has the Claude class');
  assert.strictEqual(dead.timeout_cause, 'indeterminate');
  assert.deepStrictEqual(dead.observation.silence, silence);
  assert.strictEqual(dead.session, undefined);
  const unproven = capture(path.join(lab.dir, 'silence-unproven.json'), { ...silenceError, diagnostic: undefined }).attempts.at(-1);
  assert.strictEqual(unproven.failure_class, 'unknown', 'without the indeterminate silence block it is not silence');
  // The single same-target retry applies to the codex row exactly as to Claude's.
  let now = 0, saved;
  const options = { ...identity, state: undefined, clock: () => now, persist: value => { saved = value; } };
  const row = { ...attempt, route: codexRoute, reason_code: dead.reason_code, failure_class: dead.failure_class,
    service_failure_proven: false, observation: dead.observation };
  const session = api.createRecovery(options);
  session.record(row);
  const alternate = { ...codexRoute, model: 'gpt-6-astra', model_resolved: 'gpt-6-astra', worker_mode: 'native' };
  const authority = api.createAuthority(reference => ({ reference, status: 'resolved', answer: 'authorize', resolved_at: 'fixture' }));
  const exception = authority.issue('fixture:codex-silence', { unit: identity.unit, roots_sha256: identity.roots_sha256,
    purpose: 'sidecar-recovery', expires_at: 120000, routes: [api.routeKey(codexRoute), api.routeKey(alternate)], gates_preserved: true }, () => now);
  const input = { inspection, exception, candidateSet, validateInvocation: async () => ({ ok: true }) };
  const retry = await session.next(input);
  assert.strictEqual(retry.action, 'invoke');
  assert.strictEqual(retry.silence_retry, true);
  assert.strictEqual(retry.route.model, codexRoute.model, 'the first silence retry stays on the same codex target');
  session.reserve(retry, attempt.request_sha256);
  const restart = api.createRecovery({ ...options, state: saved });
  restart.record(row);
  const following = await restart.next(input);
  assert.notStrictEqual(following.silence_retry, true, 'at most one same-target silence retry for codex');
  assert.notStrictEqual(following.route?.model, codexRoute.model, 'no second invocation of the silent codex target');
  // Active budget without a session ref (codex never has one): stop, no candidate, no resume.
  const budgetFile = path.join(lab.dir, 'budget.json');
  const budget = capture(budgetFile, { code: 'budget-exceeded-while-active', provider_called: true }).attempts.at(-1);
  assert.strictEqual(budget.failure_class, 'active-budget');
  assert.strictEqual(budget.session ?? null, null);
  const stopped = await api.recoverAttempt({ stateFile: budgetFile, receiptFile, request, clock: () => Date.now(), processProbe: () => 'stopped',
    resolveDispatch() { throw Error('codex active budget must not resolve candidates'); },
    validateInvocation: async () => { throw Error('codex active budget must not validate a resume'); },
    invoke() { throw Error('codex active budget must not invoke'); } });
  assert.strictEqual(stopped.action, 'stop');
  assert.strictEqual(stopped.reason_code, 'budget-exceeded-resume-unavailable');
  assert(!('resume' in stopped) && !('route' in stopped), 'no resume and no candidate advance');
  console.log('PASS codex app-server: silence class with one same-target retry; active budget without session stops as resume-unavailable');
}

async function sessionResumeRecovery(route) {
  const fs = require('fs'), path = require('path'), stateApi = require('./forge-xllm-state');
  const sessions = require('./forge-claude-session'), { digest } = require('./forge-code-roots');
  const lab = require('./forge-code-roots.test').laboratory('recovery-resume');
  const cwd = path.join(lab.dir, 'code'); fs.mkdirSync(cwd);
  const request = { cwd, contextRoot: cwd, scope: 'milestone', phase: 'research', unitType: 'research-milestone',
    milestoneId: 'M001', route: { ...route, unit_type: 'research-milestone' }, prompt: 'resume', resultFile: path.join(lab.dir, 'result.json') };
  const stateFile = path.join(lab.dir, 'state.json'), receiptFile = path.join(lab.dir, 'receipt.json');
  fs.writeFileSync(receiptFile, JSON.stringify({ phase: 'failed', dispatch_id: 'dispatch-1',
    recovery_identity_sha256: digest(api.requestIdentity(request)), failure: { provider_called: true } }));
  const ref = sessions.createSessionRef({ id: sessions.newSessionId(), accountName: null, configDir: path.join(lab.dir, 'profile', '.claude'), cwd });
  const capture = (session, file = stateFile) => api.captureFailure({ stateFile: file, receiptFile, request, unit: 'research-milestone/M001', route,
    finalEvidence: require('./forge-attempt-telemetry').captureFinal({ request: { argv: ['--model', route.model] }, context: request.prompt }),
    error: { code: 'budget-exceeded-while-active', provider_called: true, session }, budgets: { coding_standards: 3000 } });
  assert.strictEqual(capture({ ...ref, id: 'not-a-uuid' }, path.join(lab.dir, 'invalid.json')).attempts[0].session, null, 'invalid ref discarded, never thrown');
  const first = capture(ref);
  assert.deepStrictEqual(first.attempts[0].session, JSON.parse(JSON.stringify(ref)));
  const removed = [];
  const base = { stateFile, receiptFile, request, clock: () => first.started_at + 1, processProbe: () => 'stopped',
    resolveDispatch() { throw Error('resume must not resolve candidates'); }, validateInvocation: async () => ({ ok: true }),
    sessionRemover: value => { removed.push(value.id); return { ok: true, removed: [], refused: [], errors: [] }; } };
  let args;
  const resumed = await api.recoverAttempt({ ...base, invoke: async (...observed) => { args = observed; observed[3](); return { status: 'failed' }; } });
  assert.strictEqual(resumed.action, 'invoke');
  assert(!JSON.stringify(resumed).includes(ref.id) && !('session' in resumed.resume), 'the public response never carries the session ref');
  assert.deepStrictEqual(Object.keys(resumed.resume).sort(), ['resumed_from', 'session_sha256']);
  assert.strictEqual(args.length, 6, 'invoke receives resume as the 6th positional argument');
  assert.strictEqual(args[5].session.id, ref.id);
  assert.deepStrictEqual(args[5].resumed_from, { receipt_sha256: digest(fs.readFileSync(receiptFile)), dispatch_id: 'dispatch-1' });
  assert.deepStrictEqual(args[2], JSON.parse(JSON.stringify(ceilingFromRoute(route))));
  assert.deepStrictEqual(removed, [], 'no removal before the resume');
  const persisted = stateApi.loadRecovery(stateFile);
  assert.strictEqual(persisted.reservations.at(-1).reason, 'same-session-resume');
  assert.strictEqual(persisted.reservations.at(-1).session_sha256, sessions.sessionDigest(ref.id));
  assert(!JSON.stringify({ ...persisted, attempts: persisted.attempts.map(({ session: _s, ...row }) => row) }).includes(ref.id),
    'the raw id lives only in attempts[].session');
  const inFlight = await api.recoverAttempt({ ...base, invoke() { throw Error('no second resume while the first has no outcome'); } });
  assert.strictEqual(inFlight.reason_code, 'recovery-reservation-pending');
  assert.strictEqual(inFlight.session_cleanup, undefined, 'no session cleanup for a pending resume');
  assert.deepStrictEqual(removed, []);
  capture(undefined);
  const exhausted = await api.recoverAttempt({ ...base, invoke() { throw Error('a second resume must never be invoked'); } });
  assert.strictEqual(exhausted.reason_code, 'budget-exceeded-resume-exhausted');
  assert.deepStrictEqual(exhausted.session_cleanup, { ok: true, removed_count: 1, refused_count: 0 });
  assert.deepStrictEqual(removed, [ref.id], 'each distinct ref is removed once');
  const failing = await api.recoverAttempt({ ...base, sessionRemover: () => ({ ok: false, refused: [{ path: 'x', reason: 'symlink' }] }) });
  assert.deepStrictEqual(failing.session_cleanup, { ok: false, removed_count: 0, refused_count: 1 });
  const real = await api.recoverAttempt({ ...base, sessionRemover: undefined });
  assert.deepStrictEqual(real.session_cleanup, { ok: true, removed_count: 1, refused_count: 0 }, 'absent targets are idempotent');
  // R3/R4: a resume refused before spawn is a terminal session outcome.
  for (const code of ['claude-resume-account-mismatch', 'claude-resume-config-mismatch']) {
    const file = path.join(lab.dir, `refused-${code}.json`), gone = [];
    capture(ref, file);
    const opts = { ...base, stateFile: file, sessionRemover: value => { gone.push(value.id); return { ok: true }; } };
    const refused = await api.recoverAttempt({ ...opts, invoke: async () => { throw Object.assign(Error(code), { code, provider_called: false }); } });
    assert.strictEqual(refused.reason_code, 'budget-exceeded-resume-refused');
    assert.strictEqual(refused.refusal, code);
    assert.deepStrictEqual(refused.session_cleanup, { ok: true, removed_count: 1, refused_count: 0 });
    assert.deepStrictEqual(gone, [ref.id]);
    assert(!JSON.stringify(refused).includes(ref.id));
    // The refusal was also captured as a caller failure: the next recovery cleans instead of demanding a correction.
    api.captureFailure({ stateFile: file, receiptFile, request, unit: 'research-milestone/M001', route,
      finalEvidence: require('./forge-attempt-telemetry').captureFinal({ request: { argv: ['--model', route.model] }, context: request.prompt }),
      error: { code, provider_called: false }, budgets: { coding_standards: 3000 } });
    const later = await api.recoverAttempt({ ...opts, invoke() { throw Error('terminal: nothing to invoke'); } });
    assert.strictEqual(later.reason_code, 'budget-exceeded-resume-refused');
    assert.deepStrictEqual(later.session_cleanup, { ok: true, removed_count: 1, refused_count: 0 });
    assert.deepStrictEqual(gone, [ref.id, ref.id]);
  }
  // R5: a session whose owned process termination was unconfirmed is removed by recovery.
  {
    const file = path.join(lab.dir, 'deferred.json'), gone = [];
    api.captureFailure({ stateFile: file, receiptFile, request, unit: 'research-milestone/M001', route,
      finalEvidence: require('./forge-attempt-telemetry').captureFinal({ request: { argv: ['--model', route.model] }, context: request.prompt }),
      error: { code: 'claude-timeout', provider_called: true, session: ref, session_cleanup: { ok: false, pending: true } }, budgets: { coding_standards: 3000 } });
    assert.deepStrictEqual(stateApi.loadRecovery(file).attempts[0].session, JSON.parse(JSON.stringify(ref)));
    const out = await api.recoverAttempt({ ...base, stateFile: file, sessionRemover: value => { gone.push(value.id); return { ok: true }; } });
    assert.deepStrictEqual(out.deferred_session_cleanup, { ok: true, removed_count: 1, refused_count: 0 });
    assert.deepStrictEqual(gone, [ref.id]);
  }
  lab.cleanup();
  console.log('PASS recoverAttempt resume: ref captured, 6th invoke argument, digest-only reservation and session removal on exhausted stop');
}
async function persistentRecovery(route) {
  const fs = require('fs'), path = require('path'), stateApi = require('./forge-xllm-state');
  const lab = require('./forge-code-roots.test').laboratory('recovery-state');
  const cwd = path.join(lab.dir, 'code'); fs.mkdirSync(cwd);
  const request = { cwd, contextRoot: cwd, scope: 'milestone', phase: 'research', unitType: 'research-milestone',
    milestoneId: 'M001', route: { ...route, unit_type: 'research-milestone' }, prompt: 'before', resultFile: path.join(lab.dir, 'result.json') };
  const stateFile = path.join(lab.dir, 'state.json'), receiptFile = path.join(lab.dir, 'receipt.json');
  fs.writeFileSync(receiptFile, JSON.stringify({ phase: 'failed', recovery_identity_sha256: require('./forge-code-roots').digest(api.requestIdentity(request)), failure: { provider_called: false } }));
  const initial = api.captureFailure({ stateFile, receiptFile, request, unit: 'research-milestone/M001', route,
    finalEvidence: require('./forge-attempt-telemetry').captureFinal({ request: { argv: ['--model', route.model] }, context: request.prompt }),
    error: { code: 'context-budget-exceeded', provider_called: false, stderr: 'token=secret' }, budgets: { coding_standards: 3000 } });
  assert.strictEqual(initial.attempts[0].failure_class, 'caller');
  assert.strictEqual(initial.attempts[0].model_sent, 'unknown');
  assert(!fs.readFileSync(stateFile, 'utf8').includes('secret'));
  const base = { stateFile, receiptFile, request, clock: () => initial.started_at + 1,
    validateInvocation: async () => ({ ok: true }) };
  await assert.rejects(api.recoverAttempt({ ...base, request: { ...request, taskId: 'foreign' } }), /identity-mismatch/);
  assert.throws(() => api.captureFailure({ stateFile: path.join(cwd, 'state.json'), request, unit: 'x', route }), /result.*(?:root|inside|outside)|inside.*root/i);
  await assert.rejects(api.recoverAttempt({ ...base, correction: { offline_validated: true } }), /offline-validator-required/);
  for (const same of [request, Object.fromEntries(Object.entries(request).reverse())]) {
    await assert.rejects(api.recoverAttempt({ ...base, request: same, correction: true,
      validateCorrection: async () => { throw Error('unchanged input must fail before packaging'); } }), /correction-required/);
  }
  let invoked = 0;
  await assert.rejects(api.recoverAttempt({ ...base, request: { ...request, irrelevant: true }, correction: true,
    validateCorrection: async () => ({ ok: true, final_evidence: initial.attempts[0].final_evidence }) }), /correction-required/);
  const corrected = { ...request, prompt: 'after offline repair' };
  let advancing = initial.started_at + 1;
  const guardException = api.createAuthority(reference => ({ reference, status: 'resolved', answer: 'authorize', resolved_at: 'fixture' }))
    .issue('fixture:guard', { unit: initial.unit, roots_sha256: initial.roots_sha256, purpose: initial.purpose,
      routes: [api.routeKey(request.route)], expires_at: advancing + 120000, gates_preserved: true }, () => advancing);
  await assert.rejects(api.recoverAttempt({ ...base, request: corrected, correction: true,
    validateCorrection: async () => ({ ok: true, evidence_reference: 'fixture:unmeasured' }) }), /final-packaging-required/);
  // A killed short-mutex holder must not permanently strand recovery state.
  // Exercise the real lock in a separate process; no fabricated "dead" PID.
  const locks = require('./forge-lock'), { spawn } = require('child_process');
  const mutexState = path.join(lab.dir, 'mutex-state.json');
  const mutexRoot = path.join(require('os').tmpdir(), 'forge-recovery-' + require('./forge-code-roots').digest(path.resolve(mutexState)));
  fs.mkdirSync(path.join(mutexRoot, '.gsd'), { recursive: true });
  const recoverMutex = () => api.recoverAttempt({ ...base, stateFile: mutexState, request: corrected, correction: true,
    validateCorrection: async () => ({ ok: true, evidence_reference: 'fixture:mutex',
      final_evidence: require('./forge-attempt-telemetry').captureFinal({ request: { prompt: corrected.prompt }, context: corrected.prompt }) }) });
  try {
    for (const expired of [false, true]) {
      fs.writeFileSync(mutexState, JSON.stringify(initial));
      const child = spawn(process.execPath, ['-e', `
        const lock = require(process.argv[1]);
        const handle = lock.tryAcquireSync(process.argv[2], 'state', {
          now: () => Date.now() - (process.argv[3] === 'true' ? 60000 : 0)
        });
        process.send({ token: handle.ownerToken, generation: handle.generation });
        setInterval(() => {}, 1000);
      `, require.resolve('./forge-lock'), mutexRoot, String(expired)], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let old;
      try {
        old = await new Promise((resolve, reject) => {
          child.once('message', resolve); child.once('error', reject);
          child.once('exit', () => reject(Error('lock fixture exited before acquiring')));
        });
        await assert.rejects(recoverMutex(), /recovery-state-busy/, 'live owner stays protected even after TTL');
        assert.equal(locks.status(mutexRoot, 'state').metadata.generation, old.generation);
      } finally {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGKILL'); await exited;
      }
      if (!expired) {
        await assert.rejects(recoverMutex(), /recovery-state-busy/, 'non-expired dead owner remains protected');
        assert.equal(locks.releaseSync(mutexRoot, 'state', old.token, old.generation), true);
      } else {
        const recovered = await recoverMutex();
        assert.equal(recovered.action, 'invoke-native');
        assert.equal(stateApi.loadRecovery(mutexState).reservations.length, 1);
        const successor = locks.tryAcquireSync(mutexRoot, 'state');
        assert(successor);
        assert.notEqual(successor.generation, old.generation);
        assert.equal(locks.releaseSync(mutexRoot, 'state', old.token, old.generation), false);
        assert(locks.assertOwned(successor), 'old release cannot remove successor');
        successor.release();
      }
    }
    console.log('PASS recovery mutex: killed expired owner recovered, active/non-expired owners and successor generation protected');
  } finally { fs.rmSync(mutexRoot, { recursive: true, force: true }); }
  const retried = await api.recoverAttempt({ ...base, request: corrected, correction: true, exception: guardException, clock: () => ++advancing,
    validateCorrection: async () => ({ ok: true, evidence_reference: 'fixture:offline-check',
      final_evidence: require('./forge-attempt-telemetry').captureFinal({ request: { argv: ['--model', route.model, '--prompt', corrected.prompt] }, context: corrected.prompt }) }),
    invoke: async (selected, _invocation, remaining, assertReady) => {
      assertReady(); assertReady();
      invoked++; assert.strictEqual(selected.model, route.model); assert.deepStrictEqual(remaining, ceilingFromRoute(selected)); return { status: 'done' };
    } });
  assert.strictEqual(retried.corrected, true); assert.strictEqual(invoked, 1);
  assert.strictEqual(stateApi.loadRecovery(stateFile).reservations.length, 1);
  // Reloaded state retains the reservation even if the host stopped before it
  // could record the next result, and cannot send a second corrected request.
  await assert.rejects(api.recoverAttempt({ ...base, request: { ...request, prompt: 'second repair' }, correction: true,
    validateCorrection: async () => ({ ok: true, evidence_reference: 'fixture:offline-check',
      final_evidence: require('./forge-attempt-telemetry').captureFinal({ request: { repaired: 2 }, context: 'second repair' }) }),
    invoke() { throw Error('restart must not open a second writer'); } }), /retry-exhausted/);
  assert.strictEqual(stateApi.loadRecovery(stateFile).reservations.length, 1);
  assert.strictEqual(invoked, 1);
  const child = require('child_process').spawnSync(process.execPath,
    [path.join(__dirname, 'forge-attempt-recovery.js'), '--inspect', stateFile, receiptFile], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(child.status, 0, child.stderr);
  const inspected = JSON.parse(child.stdout);
  // Migrated (was deadline_at equality): --inspect reports schema and budget, no remaining_ms.
  assert.strictEqual(inspected.schema_version, 2); assert.strictEqual(inspected.budget, 'tier-ceiling');
  assert(!('remaining_ms' in inspected) && !('deadline_at' in inspected.state));
  assert.strictEqual(inspected.state.reservations.length, 1);
  // Migrated (was deadline_at + 1 -> recovery-deadline-exhausted): late recovery
  // is still bounded by the caller-correction requirement, not by time.
  await assert.rejects(api.recoverAttempt({ ...base, clock: () => initial.started_at + 60001 }), /correction-required/);
  await migratedRecovery({ base, initial, lab, corrected });
  const raceState = path.join(lab.dir, 'racing-state.json');
  const readFile = fs.readFileSync;
  const concurrentState = { ...initial, phase: 'concurrent-reservation', reservations: [{ id: 'other-writer' }] };
  fs.writeFileSync(raceState, JSON.stringify(initial));
  let injected = false;
  fs.readFileSync = (file, ...args) => {
    const bytes = readFile(file, ...args);
    if (file === raceState && !injected) {
      injected = true; fs.writeFileSync(raceState, JSON.stringify(concurrentState));
    }
    return bytes;
  };
  try {
    await assert.rejects(api.recoverAttempt({ ...base, stateFile: raceState, request: corrected, correction: true,
      validateCorrection: async () => ({ ok: true, evidence_reference: 'fixture:race',
        final_evidence: require('./forge-attempt-telemetry').captureFinal({ request: { prompt: corrected.prompt }, context: corrected.prompt }) }) }), /state-raced/);
    assert.equal(JSON.parse(readFile(raceState)).phase, 'concurrent-reservation');
  } finally { fs.readFileSync = readFile; }
  fs.writeFileSync(raceState, JSON.stringify(initial));
  let raceWriters = 0;
  const racing = () => api.recoverAttempt({ ...base, stateFile: raceState, request: corrected, correction: true,
    validateCorrection: async () => {
      await new Promise(resolve => setImmediate(resolve));
      return { ok: true, evidence_reference: 'fixture:offline-check',
        final_evidence: require('./forge-attempt-telemetry').captureFinal({ request: { argv: ['--prompt', corrected.prompt] }, context: corrected.prompt }) };
    }, invoke: async () => { raceWriters++; return { status: 'done' }; } });
  const raced = await Promise.allSettled([racing(), racing()]);
  assert.equal(raceWriters, 1, 'concurrent callbacks cannot reserve two writers');
  assert.equal(stateApi.loadRecovery(raceState).reservations.length, 1);
  assert.equal(raced.filter(row => row.status === 'rejected' && /state-raced|state-busy/.test(row.reason.code)).length, 1);
  fs.writeFileSync(receiptFile, JSON.stringify({ phase: 'failed', pid: process.pid, execution: {} }));
  assert.strictEqual(api.inspectReceipt(receiptFile, { processProbe: () => 'stopped' }).process_stopped, false,
    'a callback cannot override an observed live adapter PID');
  let reconciled = 0;
  await assert.rejects(api.recoverAttempt({ ...base, reconcile() { reconciled++; } }), /process-receipt-inspection-required/);
  assert.strictEqual(reconciled, 0, 'a live writer must block before reset');
  fs.writeFileSync(receiptFile, JSON.stringify({ phase: 'failed' }));
  await assert.rejects(api.recoverAttempt(base), /process-receipt-inspection-required/);
  fs.writeFileSync(receiptFile, JSON.stringify({ phase: 'ready', provider_called: true }));
  const replay = await api.recoverAttempt({ ...base, clock: () => initial.started_at + 60001, processProbe: () => 'stopped',
    resolveDispatch() { throw new Error('saved response must not resolve candidates'); }, replay: async () => ({ status: 'done' }) });
  assert.strictEqual(replay.action, 'replay'); assert.strictEqual(replay.provider_called, false); assert.strictEqual(invoked, 1);
  for (const receipt of [{ phase: 'ready', provider_called: true }, { phase: 'failed', saved_candidate: { sha256: 'fixture-candidate' } }]) {
    fs.writeFileSync(receiptFile, JSON.stringify(receipt));
    const saved = await api.recoverAttempt({ ...base, environmentalCorrection: true,
      processProbe: () => 'stopped', clock: () => initial.started_at + 60001,
      inspectPreSpawn() { throw Error('saved response must replay before pre-spawn inspection'); },
      resolveDispatch() { throw Error('saved response must not resolve candidates'); },
      replay: async observed => { assert.deepStrictEqual(observed, receipt); return { status: 'done' }; } });
    assert.strictEqual(saved.action, 'replay'); assert.strictEqual(saved.provider_called, false);
  }
  assert.throws(() => api.validateState({ ...initial, deadline_at: initial.started_at + 60000 }), /state-invalid/, 'v2 cannot carry the clock');
  lab.cleanup();
  console.log('PASS persisted recovery: caller repair once, process proof, restart/CLI schema, identity, external state and zero-inference replay');
}
function legacyV1(state, overrides = {}) {
  const { budget, migrated_from: _origin, ...rest } = JSON.parse(JSON.stringify(state));
  assert.strictEqual(budget, 'tier-ceiling');
  return { ...rest, schema_version: 1, deadline_at: rest.started_at + 60000,
    budget_remaining_ms: 0, clock_high_water: rest.started_at + 60000, ...overrides };
}
// Schema v2, explicit pure migration from v1 and refusal of corrupted/clocked states.
function stateSchema(identity, attempt) {
  const fresh = api.createRecovery({ ...identity, clock: () => 5, persist: undefined });
  fresh.record(attempt);
  const v2 = fresh.snapshot();
  assert.strictEqual(v2.schema_version, 2); assert.strictEqual(v2.budget, 'tier-ceiling'); assert.strictEqual(v2.started_at, 5);
  for (const key of ['deadline_at', 'budget_remaining_ms', 'clock_high_water', 'migrated_from']) assert(!(key in v2), key);
  assert.strictEqual(fresh.state_migration, null);
  const v1 = legacyV1({ ...v2, reservations: [{ route_key: 'r', corrected: false }], pending_questions: [{ id: 'q', question: 'Q', status: 'pending' }],
    transitions: [{ id: 't' }], selection: { selected: 'r' } }, { budget_remaining_ms: 21000, clock_high_water: 39000 });
  const frozen = JSON.stringify(v1);
  assert.strictEqual(api.validateState(v1), v1, 'a valid v1 remains readable');
  const migrated = api.migrateState(v1, 1234);
  assert.strictEqual(JSON.stringify(v1), frozen, 'migrateState never mutates its input');
  assert.strictEqual(migrated.schema_version, 2); assert.strictEqual(migrated.budget, 'tier-ceiling');
  assert.strictEqual(migrated.started_at, v1.started_at); assert.strictEqual(migrated.deadline_at, v1.deadline_at);
  assert.deepStrictEqual(migrated.migrated_from, { schema_version: 1, migrated_at: 1234, reason: 'recovery-budget-tier-ceiling',
    budget_remaining_ms: 21000, clock_high_water: 39000 });
  assert(!('budget_remaining_ms' in migrated) && !('clock_high_water' in migrated));
  for (const key of ['attempts', 'reservations', 'pending_questions', 'transitions', 'selection', 'request_identity',
    'request_identity_sha256', 'unit', 'roots_sha256', 'purpose', 'phase']) assert.deepStrictEqual(migrated[key], v1[key], key);
  assert.deepStrictEqual(api.migrateState(migrated, 9999), migrated, 'v2 -> same content (idempotent)');
  assert.deepStrictEqual(api.migrateState(v2), v2);
  const restarted = api.createRecovery({ ...identity, state: v1, clock: () => 777 });
  assert.deepStrictEqual(restarted.state_migration, { from: 1, to: 2 });
  assert.strictEqual(restarted.snapshot().migrated_from.migrated_at, 777);
  for (const invalid of [legacyV1(v2, { deadline_at: v2.started_at + 59999 }), legacyV1(v2, { deadline_at: undefined }),
    { ...v2, deadline_at: v2.started_at + 60000 }, { ...v2, budget_remaining_ms: 1 }, { ...v2, clock_high_water: 1 },
    { ...migrated, budget_remaining_ms: 1 }, { ...migrated, migrated_from: { ...migrated.migrated_from, schema_version: 2 } },
    { ...migrated, deadline_at: migrated.deadline_at + 1 }, { ...v2, budget: undefined }, { ...v2, schema_version: 3 }]) {
    assert.throws(() => api.validateState(invalid), /recovery-state-invalid/);
    assert.throws(() => api.createRecovery({ ...identity, state: invalid }), /recovery-state-invalid/);
  }
  console.log('PASS recovery state v2: no cumulative clock, explicit pure v1 migration, idempotence and named refusal');
}
// Every preserved limit still holds on a v1 state that expired long ago and is migrated.
async function migratedLimits(identity, route, attempt, inspection, candidateSet) {
  let saved;
  const silence = { dimension: 'initial', window_ms: 120001, threshold_ms: 120000,
    policy: 'claude-silence-v1', source: 'persisted-calibration', cause: 'indeterminate' };
  const base = api.createRecovery({ ...identity, clock: () => 0, persist: value => { saved = value; } });
  base.record({ ...attempt, failure_class: 'silence', service_failure_proven: false, observation: { silence } });
  const authority = api.createAuthority(reference => ({ reference, status: 'resolved', answer: 'authorize', resolved_at: 'fixture' }));
  const exception = authority.issue('fixture:migrated', { unit: identity.unit, roots_sha256: identity.roots_sha256,
    purpose: 'sidecar-recovery', expires_at: 10 * 60000, routes: [api.routeKey(route)], gates_preserved: true }, () => 0);
  const retry = await base.next({ inspection, exception, candidateSet, validateInvocation: async () => ({ ok: true }) });
  base.reserve(retry, attempt.request_sha256);
  const now = 5 * 60000; // five minutes after a 60-second v1 deadline
  const session = api.createRecovery({ ...identity, state: legacyV1(saved), clock: () => now, persist: value => { saved = value; } });
  const input = { inspection, exception, candidateSet, validateInvocation() { throw Error('limits must stop before any adapter'); } };
  await assert.rejects(session.next({ ...input, inspection: undefined }), /process-receipt-inspection-required/);
  await assert.rejects(session.next({ ...input, inspection: { ...inspection, writer_possible: true } }), /writer-reconciliation-required/);
  assert.strictEqual((await session.next(input)).reason_code, 'recovery-reservation-pending');
  session.snapshot();
  assert.strictEqual(saved.schema_version, 2); assert.strictEqual(saved.migrated_from.schema_version, 1);
  assert.throws(() => api.exceptionFor(exception, saved, 10 * 60000), /exception-invalid/, 'expired exception refused');
  console.log('PASS migrated v1 state: inspection, reconciliation, pending reservation and exception expiry still enforced');
}
// recoverAttempt on an expired v1 file: no deadline stop, explicit persisted migration.
async function migratedRecovery({ base, initial, lab, corrected }) {
  const fs = require('fs'), path = require('path'), stateApi = require('./forge-xllm-state');
  const stateFile = path.join(lab.dir, 'legacy-v1-state.json');
  const v1 = legacyV1(initial); fs.writeFileSync(stateFile, JSON.stringify(v1));
  assert.strictEqual(stateApi.loadRecovery(stateFile).schema_version, 1, 'loadRecovery stays read-only');
  const inspectOnly = require('child_process').spawnSync(process.execPath,
    [path.join(__dirname, 'forge-attempt-recovery.js'), '--inspect', stateFile, base.receiptFile], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(inspectOnly.status, 0, inspectOnly.stderr);
  assert.strictEqual(JSON.parse(inspectOnly.stdout).schema_version, 1);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), v1, '--inspect never rewrites the file');
  let ceiling;
  const result = await api.recoverAttempt({ ...base, stateFile, request: corrected, correction: true,
    clock: () => v1.deadline_at + 3600000,
    validateCorrection: async () => ({ ok: true, evidence_reference: 'fixture:migration',
      final_evidence: require('./forge-attempt-telemetry').captureFinal({ request: { prompt: corrected.prompt, v: 1 }, context: corrected.prompt }) }),
    invoke: async (_selected, _invocation, observed, assertReady) => { assertReady(); ceiling = observed; return { status: 'done' }; } });
  assert.strictEqual(result.action, 'invoke');
  assert.deepStrictEqual(result.state_migration, { from: 1, to: 2 });
  assert.deepStrictEqual(ceiling, ceilingFromRoute(result.route));
  assert.strictEqual(ceiling.seconds, 3600, 'a historical integer remainder never becomes the transport timeout');
  assert.strictEqual(ceiling.ms, 3600000);
  const after = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.strictEqual(after.schema_version, 2); assert.strictEqual(after.migrated_from.schema_version, 1);
  assert.strictEqual(after.started_at, v1.started_at); assert.strictEqual(after.deadline_at, v1.deadline_at);
  assert.deepStrictEqual(after.attempts, v1.attempts); assert.deepStrictEqual(after.pending_questions, v1.pending_questions);
  assert.strictEqual(after.reservations.length, 1);
  console.log('PASS expired v1 file: recoverAttempt migrates explicitly, persists v2 and invokes with the tier ceiling');
}
async function canonicalProvenance() {
  const fs = require('fs'), path = require('path'), os = require('os');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-recovery-resolver-')));
  const savedEnv = Object.fromEntries(['HOME', 'USERPROFILE', 'FORGE_HOME'].map(key => [key, process.env[key]]));
  try {
    for (const key of Object.keys(savedEnv)) process.env[key] = root;
    fs.mkdirSync(path.join(root, '.gsd'));
    const worktree = path.join(root, 'worktree');
    fs.mkdirSync(path.join(worktree, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(worktree, '.gsd', 'forge-prefs.jsonc'), JSON.stringify({ tier_models: { standard: ['gpt-6-sol'] } }));
    fs.writeFileSync(path.join(root, '.gsd', 'forge-prefs.jsonc'), JSON.stringify({ tier_models: {
      standard: ['claude-sonnet-5', 'gpt-6-astra', 'claude-opus-4-8'] } }));
    const resolverOptions = { cwd: root, unitType: 'research-slice', unitId: 'S01', milestoneId: 'M001',
      scope: 'milestone', phase: 'research', hostRuntime: 'codex' };
    const resolver = require('./forge-dispatch-resolve').resolveDispatch;
    const route = resolver(resolverOptions);
    assert.strictEqual(route.unit_type, undefined, 'real resolver omits unit_type: do not hide this with a stub');
    const request = { cwd: worktree, contextRoot: root, route, unitType: 'research-slice', scope: 'milestone',
      phase: 'research', milestoneId: 'M001', sliceId: 'S01' };
    assert.throws(() => api.requestIdentity({ ...request, route: { ...route, host_runtime: undefined } }),
      /recovery-request-identity-required/);
    const privateIdentity = api.requestIdentity(request);
    assert.strictEqual(privateIdentity.owner, process.platform === 'win32' ? fs.realpathSync(root).toLowerCase() : fs.realpathSync(root));
    assert.strictEqual(privateIdentity.cwd, process.platform === 'win32' ? fs.realpathSync(worktree).toLowerCase() : fs.realpathSync(worktree));
    const identity = { unit: 'research-slice/S01', roots_sha256: 'roots', request, clock: () => 0 };
    const candidates = api.resolveCandidates(resolverOptions, resolver, request);
    assert.strictEqual(route.chain[0].id, 'claude-sonnet-5', 'owner preferences remain authoritative over worktree preferences');
    assert.throws(() => api.resolveCandidates({ ...resolverOptions, cwd: worktree }, resolver, request), /identity-mismatch/);
    assert.throws(() => api.resolveCandidates({}, resolver), /request-identity-required/);
    for (const patch of [{ unitType: undefined }, { scope: undefined }, { phase: 'execute' }, { milestoneId: 'M002' }, { unitId: 'S02' }, { hostRuntime: 'claude' }]) {
      assert.throws(() => api.resolveCandidates({ ...resolverOptions, ...patch }, resolver, request), /identity-mismatch/);
    }
    const session = api.createRecovery(identity);
    session.record({ failure_class: 'timeout', reason_code: 'timeout', layer: 'provider', route, request_sha256: 'request',
      context_sha256: 'context', request_bytes: 1, context_bytes: 1, duration_ms: 300000, budgets: {} });
    const inspection = { receipt_checked: true, process_stopped: true, writer_possible: false };
    const noAuthority = await session.next({ inspection });
    assert.strictEqual(noAuthority.reason_code, 'timeout-cause-indeterminate');
    const scope = { unit: identity.unit, roots_sha256: 'roots', purpose: 'sidecar-recovery', expires_at: 120000,
      routes: route.chain.map(member => api.routeKey({ ...route, model_resolved: member.id, worker_mode: member.engine === 'gpt' ? 'native' : 'sidecar',
        resolved_worker_engine: member.engine === 'gpt' ? 'codex' : 'claude' })), gates_preserved: true };
    const authority = api.createAuthority(reference => ({ reference, status: 'resolved', answer: 'authorize', resolved_at: 'fixture' }));
    const exception = authority.issue('fixture', scope, () => 0);
    const restarted = api.createRecovery({ ...identity, state: JSON.parse(JSON.stringify(session.snapshot())), clock: () => 60001 });
    const accepted = await restarted.next({ inspection, candidateSet: candidates, exception, validateInvocation: () => ({ ok: true }) });
    assert.strictEqual(accepted.route.worker_mode, 'native');
    assert.strictEqual(accepted.sidecar_ceiling, null, 'native routes carry no sidecar ceiling');
    assert(!('remaining_ms' in accepted) && !('sidecar_remaining_ms' in accepted));
    assert.strictEqual(accepted.native_authorization_remaining_ms, 59999);
    assert.strictEqual(accepted.provenance.unit_type, request.unitType);
    restarted.reserve(accepted, 'request');
    const twice = api.createRecovery({ ...identity, state: JSON.parse(JSON.stringify(restarted.snapshot())), clock: () => 60002 });
    // Migrated (was sidecar rejected with recovery-deadline-exhausted): an untried
    // sidecar candidate may start with the tier ceiling; adapter refusal still
    // falls through, and the finite list ends in recovery-candidates-exhausted.
    const refused = await twice.next({ inspection, candidateSet: candidates, exception, validateInvocation() { throw new Error('adapter refused'); } });
    assert.strictEqual(refused.reason_code, 'recovery-candidates-exhausted');
    assert(refused.rejected.length && refused.rejected.every(item => item.reason_code === 'recovery-adapter-refused'));
    const sidecar = await twice.next({ inspection, candidateSet: candidates, exception, validateInvocation: () => ({ ok: true }) });
    assert.strictEqual(sidecar.route.worker_mode, 'sidecar');
    assert.deepStrictEqual(sidecar.sidecar_ceiling, ceilingFromRoute(sidecar.route));
    assert.strictEqual(twice.snapshot().deadline_at, undefined);
    assert.strictEqual(twice.snapshot().reservations.length, 1);
    let tries = 0, exhausted;
    const draining = api.createRecovery({ ...identity, state: JSON.parse(JSON.stringify(twice.snapshot())), clock: () => 60003 });
    for (; tries < 10; tries++) {
      const decision = await draining.next({ inspection, candidateSet: candidates, exception, validateInvocation: () => ({ ok: true }) });
      if (decision.action !== 'invoke') { exhausted = decision; break; }
      draining.reserve(decision, 'request');
    }
    assert.strictEqual(exhausted?.reason_code, 'recovery-candidates-exhausted', 'a failure sequence terminates without a clock');
    assert(tries < route.chain.length, 'each destination is tried at most once');
    fs.mkdirSync(path.join(root, '.codex'));
    fs.writeFileSync(path.join(root, '.codex', 'AGENTS.md'), '<!-- user:forge-routing-continuity:start -->\nFixture authorization.\n<!-- user:forge-routing-continuity:end -->');
    const reference = 'conversation:restart-fixture';
    require('./forge-interaction').createRecoveryAuthorizationAdapter(observed => ({ ...observed, received: true,
      answer: 'authorize', resolved_at: 0 }), { resolveProfile: () => root, clock: () => 0 })
      .registerStandingAuthorization({ reference, host: 'codex', section: 'user:forge-routing-continuity', expires_at: 120000 });
    const fixture = path.join(root, 'restart.json');
    fs.writeFileSync(fixture, JSON.stringify({ state: session.snapshot(), request, resolverOptions, reference,
      scope: { ...scope, owner: root, roots: [worktree], request_identity_sha256: require('./forge-code-roots').digest(api.requestIdentity(request)),
        chain_sha256: require('./forge-code-roots').digest(route.chain) } }));
    const child = require('child_process').spawnSync(process.execPath, [__filename, '--resume-recovery', fixture], { encoding: 'utf8', windowsHide: true });
    assert.strictEqual(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.strictEqual(result.native.route.worker_mode, 'native');
    assert.strictEqual(result.native.sidecar_ceiling, null);
    // Migrated (was sidecar rejected after the deadline): the next untried sidecar starts with its tier ceiling.
    assert.strictEqual(result.afterReservation.action, 'invoke');
    assert.strictEqual(result.afterReservation.route.worker_mode, 'sidecar');
    assert.deepStrictEqual(result.afterReservation.sidecar_ceiling, JSON.parse(JSON.stringify(ceilingFromRoute(result.afterReservation.route))));
    assert.strictEqual(result.state.schema_version, 2); assert.strictEqual(result.state.deadline_at, undefined);
    assert.strictEqual(result.state.reservations.length, 1);
    const foreign = api.createRecovery({ ...identity, state: undefined, request: undefined });
    foreign.record(session.snapshot().attempts[0]);
    await assert.rejects(foreign.next({ inspection, candidateSet: candidates, exception, validateInvocation: () => ({ ok: true }) }), /provenance/);
    console.log('PASS real resolver identity, missing/foreign scope and IDs, native first, sidecar with tier ceiling, finite candidates and durable reservations');
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
async function adapterPreflightRecovery() {
  const fs = require('fs'), path = require('path'), roots = require('./forge-code-roots');
  const fixtures = require('./forge-code-roots.test'), permissions = require('./forge-claude-permissions');
  const lab = fixtures.fixture();
  try {
    const taskDir = path.join(lab.owner, '.gsd/milestones/M001/slices/S01/tasks/T01');
    fs.mkdirSync(taskDir, { recursive: true });
    const planFile = path.join(taskDir, 'T01-PLAN.md'), plan = fixtures.plan(lab.contract);
    fs.writeFileSync(planFile, plan);
    const route = { unit_type: 'execute-task', host_runtime: 'codex', resolved_worker_engine: 'claude', worker_mode: 'sidecar',
      model: 'claude-sonnet-5', model_resolved: 'claude-sonnet-5', effort: 'medium', tier: 'standard', dispatch_allowed: true,
      chain: [{ id: 'claude-sonnet-5', engine: 'claude' }, { id: 'gpt-6-astra', engine: 'gpt' }] };
    const request = { unitType: 'execute-task', scope: 'milestone', phase: 'execute', milestoneId: 'M001', sliceId: 'S01', taskId: 'T01',
      cwd: lab.a, contextRoot: lab.owner, planFile, route, dispatchId: 'preflight-236', claudePermissions: 'verification',
      execution_contract: lab.contract, verification: { commandsByRoot: { alpha: ['node scripts/test.js'], beta: ['node scripts/test.js'] } } };
    request.resultFile = path.join(lab.dir, 'result.json');
    request.workflowId = 'preflight-fixture';
    request.runId = 'preflight-fixture';
    request.claim = { schema_version: 2, generation: require('crypto').randomUUID(), execution_contract: lab.contract,
      paths: [{ root_id: 'alpha', path: 'same.txt' }, { root_id: 'beta', path: 'same.txt' }] };
    request.gates = { plan: 'skipped', planSkipReason: 'interactive-off', claim: 'proceed', security: 'not-applicable' };
    require('./forge-runs').add(lab.owner, { id: request.runId, kind: 'milestone', session_id: 'fixture', write_claim: request.claim });
    const identity = { dispatch_id: request.dispatchId, fingerprint: 'a'.repeat(64) };
    const seal = require('./forge-verify').normalizeExecutionVerification(lab.contract, plan, request.verification, {}, identity);
    for (const change of [
      r => { r.gates.claim = 'blocked'; },
      r => { r.claim.generation = 'foreign'; },
      r => { r.resultFile = path.join(lab.a, 'same.txt'); },
      r => { r.planFile = path.join(lab.owner, 'missing.md'); },
      r => { r.taskId = '../foreign'; },
      r => { r.verification.commandsByRoot.alpha = [null]; },
      r => { r.workflowId = ''; },
    ]) {
      const invalid = JSON.parse(JSON.stringify(request)); change(invalid);
      assert.throws(() => permissions.createUnsupportedPreflight({ request: invalid, seal, identity }));
    }
    const capability = permissions.createUnsupportedPreflight({ request, seal, identity });
    const proof = permissions.assertUnsupportedPreflight(capability, request);
    let observed = { ...proof, process_stopped: true, receipt_checked: true, writer_possible: false, valid_saved_response: false };
    const options = { unit: 'execute-task/T01', roots_sha256: roots.digest(lab.contract), request, clock: () => 10 };
    const resolverOptions = { unitType: request.unitType, scope: request.scope, phase: request.phase, unitId: request.taskId,
      milestoneId: request.milestoneId, cwd: request.contextRoot, contextRoot: request.contextRoot, planPath: planFile, hostRuntime: 'codex' };
    const candidateSet = api.resolveCandidates(resolverOptions, () => ({ ...route, source: 'fixture' }), request);
    let revoked = false;
    const authority = api.createAuthority(reference => revoked ? null : { reference, status: 'resolved', answer: 'authorize', resolved_at: 1 });
    const readException = () => authority.issue('fixture-live', { unit: options.unit, roots_sha256: options.roots_sha256,
      purpose: 'sidecar-recovery', expires_at: 1000, gates_preserved: true,
      routes: [api.routeKey({ ...route, worker_mode: 'native', resolved_worker_engine: 'codex', model: 'gpt-6-astra', model_resolved: 'gpt-6-astra' })] }, () => 10);
    const recovery = api.createRecovery(options);
    assert.throws(() => recovery.observeAdapterPreflight({ request, capability: {}, observe: () => observed }), /preflight/);
    for (const writer_possible of [true, 'unknown']) {
      assert.throws(() => recovery.observeAdapterPreflight({ request, capability, observe: () => ({ ...observed, writer_possible }) }), /inspection/);
    }
    const adapterPreflight = recovery.observeAdapterPreflight({ request, capability, observe: () => observed });
    const state = recovery.snapshot();
    assert.strictEqual(state.attempts[0].provider_called, false);
    assert.strictEqual(state.attempts[0].failure_class, 'caller');
    const input = { inspection: observed, candidateSet, adapterPreflight, readException,
      validateInvocation: candidate => ({ ok: true, request: { ...request, dispatchId: 'successor', route: candidate } }) };
    await assert.rejects(recovery.next({ ...input, adapterPreflight: {} }), /preflight/);
    const decision = await recovery.next(input);
    assert.strictEqual(decision.action, 'invoke', JSON.stringify(decision));
    assert.strictEqual(decision.route.worker_mode, 'native');
    const requestHash = api.callerRequestHash(decision.invocation.request);
    assert.throws(() => recovery.reserve(JSON.parse(JSON.stringify(decision)), requestHash), /preflight/);
    assert.throws(() => recovery.reserve(decision, 'foreign'), /preflight/);
    revoked = true;
    assert.throws(() => recovery.reserve(decision, requestHash), /authorized|exception|answer/);
    revoked = false;
    request.gates.claim = 'blocked';
    assert.throws(() => recovery.reserve(decision, requestHash), /preflight|gates/);
    request.gates.claim = 'proceed';
    fs.appendFileSync(planFile, '\nchanged');
    assert.throws(() => recovery.reserve(decision, requestHash), /permission/);
    fs.writeFileSync(planFile, plan);
    observed = { ...observed, writer_possible: true };
    assert.throws(() => recovery.reserve(decision, requestHash), /inspection/);
    observed = { ...observed, writer_possible: false };
    recovery.questions(['Required choice']);
    assert.throws(() => recovery.reserve(decision, requestHash), /preflight|questions/);
    const pendingRestart = api.createRecovery({ ...options, state: recovery.snapshot() });
    assert.strictEqual((await pendingRestart.next(input)).action, 'pending-questions');
    const pendingId = pendingRestart.snapshot().pending_questions[0].id;
    pendingRestart.answer([{ id: pendingId, answer: 'Proceed with the authorized native route' }]);
    const answeredCapability = pendingRestart.observeAdapterPreflight({ request,
      capability: permissions.createUnsupportedPreflight({ request, seal, identity }), observe: () => observed, rebuild: true });
    assert.strictEqual((await pendingRestart.next({ ...input, adapterPreflight: answeredCapability })).action, 'invoke');
    const restored = api.createRecovery({ ...options, state });
    await assert.rejects(restored.next({ ...input, adapterPreflight }), /preflight/);
    const rebuilt = restored.observeAdapterPreflight({ request, capability: permissions.createUnsupportedPreflight({ request, seal, identity }),
      observe: () => observed, rebuild: true });
    const resumed = await restored.next({ ...input, adapterPreflight: rebuilt });
    const reservation = restored.reserve(resumed, api.callerRequestHash(resumed.invocation.request));
    assert.strictEqual(reservation.reservations.at(-1).reason, 'adapter-preflight-incompatible');
    assert.throws(() => restored.reserve(resumed, api.callerRequestHash(resumed.invocation.request)), /reservation|preflight/);
    console.log('PASS adapter preflight: physical capability, no writer, caller/providerfalse, live authority, drift, questions, restart and one reservation');
  } finally { lab.cleanup(); }
}
async function resumeRecovery() {
  const fixture = JSON.parse(require('fs').readFileSync(process.argv[3], 'utf8'));
  const store = require('./forge-recovery-authority').createRecoveryAuthority({ resolveProfile: () => fixture.request.contextRoot, clock: () => 60001 });
  const exception = store.issueRecoveryException(fixture.reference, fixture.scope);
  const session = api.createRecovery({ unit: fixture.state.unit, roots_sha256: fixture.state.roots_sha256,
    request: fixture.request, state: fixture.state, clock: () => 60001 });
  const candidateSet = api.resolveCandidates(fixture.resolverOptions, undefined, fixture.request);
  const input = { inspection: { receipt_checked: true, process_stopped: true, writer_possible: false },
    candidateSet, exception, validateInvocation: () => ({ ok: true }) };
  const native = await session.next(input);
  session.reserve(native, 'request');
  const afterReservation = await session.next(input);
  process.stdout.write(JSON.stringify({ native, afterReservation, state: session.snapshot() }));
}
(process.argv[2] === '--continuation-crash' ? continuationCrash()
  : process.argv[2] === '--resume-recovery' ? resumeRecovery() : main()).catch(error => { console.error(error); process.exitCode = 1; });
