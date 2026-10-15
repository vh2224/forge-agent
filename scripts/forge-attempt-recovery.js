'use strict';

const crypto = require('crypto');
const { digest } = require('./forge-code-roots');
const exceptions = new WeakMap();
const candidateSets = new WeakMap();
function fail(code) { throw Object.assign(new Error(code), { code }); }
function safeDiagnostic(value) {
  return String(value || '').replace(/(?:bearer\s+|(?:token|secret|password|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, '[redacted]').slice(0, 4096);
}
function createAuthority(resolveLiveAnswer) {
  if (typeof resolveLiveAnswer !== 'function') fail('recovery-live-answer-resolver-required');
  return Object.freeze({ issue(reference, scope, clock = Date.now) {
    const answer = resolveLiveAnswer(reference);
    if (!answer || answer.reference !== reference || answer.status !== 'resolved' || answer.answer !== 'authorize'
        || !answer.resolved_at || !scope.unit || !scope.roots_sha256 || !Array.isArray(scope.routes) || !scope.routes.length
        || !scope.purpose || !Number.isFinite(scope.expires_at) || scope.expires_at <= clock()
        || scope.expires_at > clock() + 24 * 3600000 || scope.gates_preserved !== true) fail('recovery-exception-not-authorized');
    const handle = Object.freeze({ id: crypto.randomUUID() });
    exceptions.set(handle, Object.freeze({ reference, ...JSON.parse(JSON.stringify(scope)) })); return handle;
  } });
}
function exceptionFor(handle, identity, now) {
  const scope = exceptions.get(handle);
  if (!scope || scope.expires_at <= now || scope.unit !== identity.unit || scope.roots_sha256 !== identity.roots_sha256
      || scope.purpose !== identity.purpose || scope.gates_preserved !== true) fail('recovery-exception-invalid');
  return scope;
}
function routeKey(route) { return digest({ host: route.host_runtime, worker: route.resolved_worker_engine,
  transport: route.worker_mode, model: route.model_resolved || route.model, effort: route.effort }); }
// Resolve in the caller. A JSON list, even one labelled approved, is not a
// live resolver observation and cannot authorize a destination.
function resolveCandidates(options, resolve = require('./forge-dispatch-resolve').resolveDispatch) {
  const resolved = resolve(options);
  if (!resolved || !Array.isArray(resolved.chain) || !resolved.chain.length) fail('recovery-resolved-list-required');
  const resolver = require('./forge-dispatch-resolve');
  const routes = resolved.chain.map(member => {
    const engine = resolver.dispatchEngineFor(member.engine);
    const runtime = resolver.composeRuntimePosture(resolver.runtimeFields({ hostRuntime: resolved.host_runtime }, engine), resolved.unit_type, options);
    return { ...resolved, ...runtime, model: member.id, model_requested: member.id, model_resolved: member.id,
      sidecar_model: member.id, engine: member.engine, dispatch_engine: engine };
  });
  const provenance = { unit_type: resolved.unit_type, host: resolved.host_runtime, tier: resolved.tier,
    chain: resolved.chain, source: resolved.source || resolved.reason, sha256: digest({ options, chain: resolved.chain }) };
  const handle = Object.freeze({ id: crypto.randomUUID() });
  candidateSets.set(handle, JSON.parse(JSON.stringify({ routes, provenance }))); return handle;
}
function validateState(state) {
  if (!state || state.schema_version !== 1 || !state.unit || !Number.isFinite(state.started_at)
      || !Number.isFinite(state.deadline_at) || state.deadline_at - state.started_at !== 60000
      || !Array.isArray(state.attempts) || !Array.isArray(state.pending_questions)) fail('recovery-state-invalid');
  return state;
}
function createRecovery(options) {
  const clock = options.clock || Date.now;
  const started = clock();
  const state = options.state ? JSON.parse(JSON.stringify(validateState(options.state))) : {
    schema_version: 1, unit: options.unit, roots_sha256: options.roots_sha256, purpose: options.purpose || 'sidecar-recovery',
    started_at: started, deadline_at: started + 60000, attempts: [], pending_questions: [], phase: 'inspection' };
  if (state.unit !== options.unit || state.roots_sha256 !== options.roots_sha256) fail('recovery-identity-mismatch');
  const save = () => { options.persist?.(JSON.parse(JSON.stringify(state))); return JSON.parse(JSON.stringify(state)); };
  const remaining = () => Math.max(0, state.deadline_at - clock());
  return Object.freeze({
    snapshot: save, remaining,
    questions(questions) {
      state.pending_questions = require('./forge-interaction').mergePendingQuestions(state.pending_questions, questions); save();
    },
    answer(answers) {
      state.pending_questions = require('./forge-interaction').resolvePendingQuestions(state.pending_questions, answers); save();
    },
    record(attempt) {
      if (!['caller', 'service', 'timeout', 'interrupted', 'unknown'].includes(attempt.failure_class)) fail('recovery-failure-class-invalid');
      if (!attempt.reason_code || !attempt.layer || !attempt.request_sha256 || !attempt.context_sha256
          || !Number.isFinite(attempt.request_bytes) || !Number.isFinite(attempt.context_bytes)
          || !Number.isFinite(attempt.duration_ms) || !attempt.budgets || !attempt.route) fail('recovery-telemetry-required');
      const entry = { ...attempt, diagnostic: safeDiagnostic(attempt.diagnostic), stderr: safeDiagnostic(attempt.stderr),
        provider_called: [true, false].includes(attempt.provider_called) ? attempt.provider_called : 'unknown',
        model_observed: attempt.model_observed || 'unknown', recorded_at: clock(), route_key: routeKey(attempt.route),
        timeout_cause: attempt.failure_class === 'timeout' ? 'indeterminate' : null };
      state.attempts.push(entry); state.phase = 'inspection'; return save();
    },
    async next(input) {
      if (state.pending_questions.some(q => q.status === 'pending')) return { action: 'pending-questions', questions: state.pending_questions };
      if (!input.inspection || input.inspection.process_stopped !== true || input.inspection.receipt_checked !== true) fail('recovery-process-receipt-inspection-required');
      if (input.inspection.valid_saved_response === true) return { action: 'replay', provider_called: false };
      if (input.inspection.writer_possible !== false && input.inspection.roots_reconciled !== true) fail('recovery-writer-reconciliation-required');
      let scope;
      if (input.exception) scope = exceptionFor(input.exception, state, clock());
      if (!remaining() && !scope) return { action: 'stop', reason_code: 'recovery-deadline-exhausted' };
      const previous = state.attempts.at(-1);
      if (!previous) fail('recovery-previous-attempt-required');
      let routes, provenance;
      if (previous.failure_class === 'caller' || previous.failure_class === 'timeout' && input.correction) {
        const correction = input.correction;
        if (!correction || correction.offline_validated !== true || !correction.evidence_reference
            || correction.request_sha256 === previous.request_sha256 || !correction.request_sha256) fail('recovery-correction-required');
        if ([...state.attempts, ...(state.reservations || [])].some(a => a.route_key === previous.route_key && a.corrected === true)) fail('recovery-corrected-retry-exhausted');
        routes = [previous.route];
      } else if (previous.failure_class === 'service' && previous.service_failure_proven === true || scope) {
        const observed = candidateSets.get(input.candidateSet);
        if (!observed || observed.provenance.unit_type !== previous.route.unit_type
            || observed.provenance.host !== previous.route.host_runtime) fail('recovery-candidate-provenance-required');
        provenance = observed.provenance;
        const original = state.attempts[0].route.chain;
        if (!Array.isArray(original) || !original.length) fail('recovery-original-list-required');
        routes = observed.routes.filter(candidate => original.some(member => member.id === (candidate.model_resolved || candidate.model)
          && member.engine === candidate.engine)
          && ![...state.attempts, ...(state.reservations || [])].some(a => a.route_key === routeKey(candidate)));
        // Stable partition: the first compatible native candidate wins; adapter
        // refusal falls through to the next candidate without provider contact.
        routes.sort((a, b) => Number(b.worker_mode === 'native') - Number(a.worker_mode === 'native'));
      } else return { action: 'stop', reason_code: previous.failure_class === 'timeout' ? 'timeout-cause-indeterminate' : 'recovery-cause-unproved' };
      if (typeof input.validateInvocation !== 'function') fail('recovery-adapter-required');
      const rejected = [];
      let route, invocation;
      for (const candidate of routes) {
        if (!candidate.effort || !(candidate.model_resolved || candidate.model)) fail('recovery-explicit-route-required');
        if (scope && !scope.routes.includes(routeKey(candidate))) continue;
        if (candidate.effort !== previous.route.effort || candidate.tier !== previous.route.tier) {
          rejected.push({ route_key: routeKey(candidate), reason_code: 'recovery-tier-effort-changed' }); continue;
        }
        let verdict;
        try { verdict = await input.validateInvocation(candidate); }
        catch (error) { verdict = { ok: false, reason_code: error.code || 'recovery-adapter-refused' }; }
        if (verdict?.ok === true && candidate.dispatch_allowed === true) { route = candidate; invocation = verdict; break; }
        rejected.push({ route_key: routeKey(candidate), reason_code: verdict?.reason_code || candidate.dispatch_reason_code || 'recovery-adapter-refused' });
      }
      state.selection = { provenance: provenance || null, rejected, selected: route ? routeKey(route) : null }; save();
      if (!route) return { action: 'stop', reason_code: 'recovery-candidates-exhausted', rejected };
      if (!remaining() && !scope) return { action: 'stop', reason_code: 'recovery-deadline-exhausted' };
      state.phase = 'ready'; save();
      return { action: 'invoke', route, invocation, provenance, rejected, corrected: !!input.correction, remaining_ms: scope ? Math.max(0, scope.expires_at - clock()) : remaining(),
        ...(scope ? { authorization_reference: scope.reference } : {}), provider_called: false };
    },
    reserve(decision, requestHash) {
      if (decision.action !== 'invoke' || state.phase !== 'ready' || state.selection?.selected !== routeKey(decision.route)) fail('recovery-reservation-invalid');
      const entry = { route_key: routeKey(decision.route), corrected: decision.corrected, request_sha256: requestHash,
        reserved_at: clock(), reason: decision.corrected ? 'offline-correction' : 'resolved-next-destination',
        provenance: decision.provenance || null, provider_called: 'unknown' };
      state.reservations = [...(state.reservations || []), entry]; state.phase = 'reserved'; return save();
    },
  });
}
function inspectReceipt(file, options = {}) {
  const fs = require('fs');
  const bytes = fs.readFileSync(file), receipt = JSON.parse(bytes);
  const pid = receipt.process_pid || receipt.pid;
  let stopped = receipt.failure?.provider_called === false || receipt.provider_called === false && !receipt.failure;
  if (Number.isInteger(pid) && pid > 0) {
    try { process.kill(pid, 0); stopped = false; }
    catch (error) { stopped = error.code === 'ESRCH'; }
  }
  // A live adapter may attest that its awaited child exited. Imported JSON is
  // never an attestation. A caller must supply the inspection implementation.
  if (typeof options.processProbe === 'function') stopped = options.processProbe(receipt) === 'stopped';
  return { receipt_checked: true, process_stopped: stopped, receipt_sha256: digest(bytes),
    phase: receipt.phase, valid_saved_response: ['ready', 'executed'].includes(receipt.phase) || !!receipt.saved_candidate,
    writer_possible: !!receipt.execution || !!receipt.reset_state_file,
    roots_reconciled: false, receipt };
}
function captureFailure(options) {
  const fs = require('fs'), stateApi = require('./forge-xllm-state');
  validateStateTarget(options.stateFile, options.request, options.contract);
  const request = Buffer.from(JSON.stringify(options.request)), context = Buffer.from(options.context || '');
  const error = options.error || {}, code = error.code || error.reason_code || 'attempt-failed';
  const state = fs.existsSync(options.stateFile) ? stateApi.loadRecovery(options.stateFile) : undefined;
  const session = createRecovery({ unit: options.unit, roots_sha256: digest(options.contract || { cwd: options.request.cwd }),
    state, persist: value => stateApi.saveRecovery(options.stateFile, value) });
  const provider = [true, false].includes(error.provider_called) ? error.provider_called : 'unknown';
  const timeout = /timeout|timed-out/.test(code);
  const service = provider === true && /quota|rate-limit|model-unavailable|service-unavailable/.test(code);
  session.record({ failure_class: timeout ? 'timeout' : service ? 'service' : provider === false ? 'caller' : 'unknown',
    service_failure_proven: service, reason_code: code, layer: options.layer || error.stage || 'unknown', route: options.route,
    request_sha256: digest(request), context_sha256: options.packagedContext?.sha256 || digest(context),
    request_bytes: request.length, context_bytes: options.packagedContext?.bytes ?? context.length,
    context_measurement: options.packagedContext ? 'packaged' : 'caller', budgets: options.budgets || {},
    duration_ms: options.durationMs || 0, provider_called: provider, model_observed: options.modelObserved || 'unknown',
    model_sent: provider === true ? options.route.model_resolved || options.route.model : 'unknown',
    receipt: options.receiptFile, result: options.request.resultFile, diagnostic: error.diagnostic?.reason || error.message,
    stderr: error.stderr, next_action: 'inspect-process-receipt-roots' });
  if (options.questions?.length) session.questions(options.questions);
  return session.snapshot();
}
async function recoverAttempt(options) {
  const stateApi = require('./forge-xllm-state');
  validateStateTarget(options.stateFile, options.request, options.executionContract);
  const state = stateApi.loadRecovery(options.stateFile);
  const expectedRoots = digest(options.executionContract || { cwd: options.request.cwd });
  const session = createRecovery({ unit: options.unit || `${options.request.unitType}/${options.request.taskId || options.request.sliceId || options.request.milestoneId}`,
    roots_sha256: expectedRoots, state,
    clock: options.clock, persist: value => stateApi.saveRecovery(options.stateFile, value) });
  const inspection = inspectReceipt(options.receiptFile, { processProbe: options.processProbe });
  if (inspection.process_stopped !== true) fail('recovery-process-receipt-inspection-required');
  if (inspection.writer_possible && !inspection.valid_saved_response && options.reconcile) {
    const reset = await options.reconcile(inspection.receipt);
    const contract = options.executionContract || inspection.receipt.execution?.execution_contract;
    const declared = contract && require('./forge-code-roots').validateContract(contract, { revalidate: true }).code_roots;
    inspection.roots_reconciled = reset?.ok === true && !reset.pending_roots?.length && Array.isArray(declared)
      && declared.every(root => reset.roots?.some(row => row.root_id === root.id && row.reconciled === true));
  }
  if (options.answers?.length) session.answer(options.answers);
  let correction;
  if (options.correction) {
    if (typeof options.validateCorrection !== 'function' || !options.request) fail('recovery-offline-validator-required');
    const observed = await options.validateCorrection(options.request);
    if (observed?.ok !== true) fail(observed?.reason_code || 'recovery-offline-validation-failed');
    correction = { request_sha256: digest(Buffer.from(JSON.stringify(options.request))),
      offline_validated: true, evidence_reference: observed.evidence_reference };
  }
  const candidateSet = !inspection.valid_saved_response && !correction
    && !session.snapshot().pending_questions.some(q => q.status === 'pending')
    && (state.attempts.at(-1)?.service_failure_proven === true || options.exception)
    ? resolveCandidates(options.resolverOptions, options.resolveDispatch) : undefined;
  const decision = await session.next({ inspection, candidateSet, correction,
    exception: options.exception, validateInvocation: options.validateInvocation });
  if (decision.action === 'replay') {
    if (typeof options.replay !== 'function') fail('recovery-replay-required');
    return { ...decision, result: await options.replay(inspection.receipt), inspection: { ...inspection, receipt: undefined } };
  }
  if (decision.action !== 'invoke') return decision;
  session.reserve(decision, correction?.request_sha256 || state.attempts.at(-1).request_sha256);
  if (typeof options.invoke !== 'function') return { ...decision, action: 'invoke-native', inspection: { ...inspection, receipt: undefined } };
  // Every new sidecar gets the shared remaining deadline; a native exception
  // carries its explicit expiration. Never renew the original 300-second wait.
  return { ...decision, result: await options.invoke(decision.route, decision.invocation, decision.remaining_ms) };
}
function validateStateTarget(file, request, contract) {
  const validate = require('./forge-xllm').validateResultFileTarget;
  const roots = contract ? require('./forge-code-roots').validateContract(contract, { revalidate: true }) : null;
  const boundaries = roots ? [roots.owner, ...roots.code_roots.map(root => root.path)]
    : [request?.contextRoot, request?.cwd].filter(Boolean);
  if (!boundaries.length) fail('recovery-workspace-required');
  for (const root of boundaries) validate(file, root);
}
async function cli(argv) {
  const fs = require('fs');
  if (argv[0] === '--inspect' && argv[1] && argv[2]) {
    const state = require('./forge-xllm-state').loadRecovery(argv[1]);
    const inspected = inspectReceipt(argv[2]);
    return { state, remaining_ms: Math.max(0, state.deadline_at - Date.now()), inspection: { ...inspected, receipt: undefined } };
  }
  if (['--preparation', '--unit'].includes(argv[0]) && argv[1]) {
    const input = JSON.parse(fs.readFileSync(argv[1], 'utf8'));
    const recovery = { stateFile: input.state_file, receiptFile: input.receipt_file, answers: input.answers, correction: input.correction };
    return argv[0] === '--preparation' ? require('./forge-task-preparation').recoverStandaloneTask(input.request, recovery)
      : require('./forge-unit-sidecar').recoverUnitSidecar(input.request, recovery);
  }
  fail('usage: forge-attempt-recovery.js --inspect <state.json> <receipt.json> | --preparation <request.json>');
}
module.exports = { createRecovery, resolveCandidates, createAuthority, exceptionFor, validateState, validateStateTarget, routeKey, safeDiagnostic, inspectReceipt, captureFailure, recoverAttempt, cli };
if (require.main === module) cli(process.argv.slice(2)).then(value => process.stdout.write(JSON.stringify(value) + '\n')).catch(error => {
  process.stderr.write(JSON.stringify({ reason_code: error.code || 'recovery-command-failed' }) + '\n'); process.exitCode = 2;
});
