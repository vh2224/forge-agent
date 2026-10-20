'use strict';

const crypto = require('crypto');
const { digest } = require('./forge-code-roots');
const exceptions = new WeakMap();
const candidateSets = new WeakMap();
function fail(code) { throw Object.assign(new Error(code), { code }); }
function callerRequestHash(request) {
  return digest(JSON.stringify(request, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value));
}
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
      || scope.request_identity_sha256 && scope.request_identity_sha256 !== identity.request_identity_sha256
      || scope.purpose !== identity.purpose || scope.gates_preserved !== true) fail('recovery-exception-invalid');
  return scope;
}
function routeKey(route) { return digest({ host: route.host_runtime, worker: route.resolved_worker_engine,
  transport: route.worker_mode, model: route.model_resolved || route.model, effort: route.effort }); }
function canonicalRequest(request) {
  const phase = request.phase || ({ 'execute-task': 'execute', 'plan-check': 'plan-check' }[request.unitType])
    || request.unitType?.split('-')[0];
  return { ...request, scope: request.scope || (request.milestoneId ? 'milestone' : undefined), phase,
    contextRoot: request.contextRoot || request.cwd };
}
// Only the embedding host can supply this object. JSON references are data;
// registration and revalidation require executable methods on a trusted adapter.
function bindRecoveryAuthorization(binding) {
  if (!binding) return null;
  if (typeof binding.adapter?.readStandingAuthorization !== 'function'
      || typeof binding.adapter?.issueRecoveryException !== 'function' || !binding.reference) fail('recovery-trusted-authority-required');
  if (binding.registration) binding.adapter.registerStandingAuthorization({ ...binding.registration, reference: binding.reference });
  binding.adapter.readStandingAuthorization(binding.reference);
  return binding.reference;
}
// Resolve in the caller. A JSON list, even one labelled approved, is not a
// live resolver observation and cannot authorize a destination.
function requestIdentity(request) {
  const path = require('path'), fs = require('fs');
  if (!request || !request.unitType || !['milestone', 'standalone-task'].includes(request.scope) || !request.phase
      || !request.route?.host_runtime || !request.cwd || !request.contextRoot
      || request.scope === 'standalone-task' && (!request.taskId || request.milestoneId || request.sliceId)
      || request.scope === 'milestone' && !request.milestoneId
      || request.unitType === 'execute-task' && (!request.taskId || request.scope === 'milestone' && !request.sliceId)
      || request.scope === 'milestone' && /-slice$/.test(request.unitType) && !request.sliceId) fail('recovery-request-identity-required');
  const canonical = file => {
    if (!path.isAbsolute(file)) fail('recovery-request-path-invalid');
    const resolved = fs.realpathSync(file);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const result = { unit_type: request.unitType, scope: request.scope, phase: request.phase,
    milestone_id: request.milestoneId || null, slice_id: request.sliceId || null, task_id: request.taskId || null,
    host: request.route.host_runtime, owner: canonical(request.contextRoot), cwd: canonical(request.cwd) };
  for (const [key, field] of [['plan', 'planFile'], ['roadmap', 'roadmapFile']]) result[key] = request[field] ? canonical(request[field]) : null;
  return result;
}
function resolveCandidates(options, resolve = require('./forge-dispatch-resolve').resolveDispatch, request) {
  const identity = requestIdentity(request);
  if (!options || options.unitType !== identity.unit_type || options.scope !== identity.scope || options.phase !== identity.phase
      || options.hostRuntime !== identity.host || (options.milestoneId || null) !== identity.milestone_id
      || options.unitId !== (identity.task_id || identity.slice_id || identity.milestone_id)
      || (options.planPath || null) !== (request.planFile || null) || (options.roadmapPath || null) !== (request.roadmapFile || null)
      // Preferences and preparation belong to the owner; execution belongs
      // to request.cwd, which can be a distinct isolated worktree.
      || require('path').resolve(options.cwd || '') !== require('path').resolve(request.contextRoot)) fail('recovery-resolver-identity-mismatch');
  const resolved = resolve(options);
  if (!resolved || !Array.isArray(resolved.chain) || !resolved.chain.length || resolved.prefs_ok === false) fail('recovery-resolved-list-required');
  // The current resolver does not echo unit_type. Its explicit validated input
  // supplies that identity; missing inputs never compare equal to undefined.
  if (resolved.unit_type && resolved.unit_type !== identity.unit_type || resolved.host_runtime !== identity.host) fail('recovery-resolver-identity-mismatch');
  const resolver = require('./forge-dispatch-resolve');
  const routes = resolved.chain.map(member => {
    const engine = resolver.dispatchEngineFor(member.engine);
    // The transport guard represents milestone units by unitType (legacy wire
    // shape); retain scope in provenance, while adapting only its guard input.
    const posture = identity.scope === 'milestone' ? { ...options, scope: undefined, phase: undefined } : options;
    const runtime = resolver.composeRuntimePosture(resolver.runtimeFields({ hostRuntime: resolved.host_runtime }, engine), identity.unit_type, posture);
    return { ...resolved, ...runtime, unit_type: identity.unit_type, model: member.id, model_requested: member.id, model_resolved: member.id,
      sidecar_model: member.id, engine: member.engine, dispatch_engine: engine };
  });
  const provenance = { unit_type: identity.unit_type, host: resolved.host_runtime, tier: resolved.tier,
    request_identity: identity, request_identity_sha256: digest(identity), chain_sha256: digest(resolved.chain),
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
  if (options.authorizationReference) state.authorization_reference = options.authorizationReference;
  if (state.unit !== options.unit || state.roots_sha256 !== options.roots_sha256) fail('recovery-identity-mismatch');
  if (options.request) {
    const identity = requestIdentity(options.request), hash = digest(identity);
    if (state.unit !== `${identity.unit_type}/${identity.task_id || identity.slice_id || identity.milestone_id}`) fail('recovery-identity-mismatch');
    if (state.request_identity_sha256 && state.request_identity_sha256 !== hash) fail('recovery-identity-mismatch');
    state.request_identity = identity; state.request_identity_sha256 = hash;
  }
  const save = () => { options.persist?.(JSON.parse(JSON.stringify(state))); return JSON.parse(JSON.stringify(state)); };
  const remaining = () => Math.max(0, state.deadline_at - clock());
  return Object.freeze({
    snapshot: save, remaining,
    authorization(reference) { state.authorization_reference = reference; return save(); },
    questions(questions) {
      state.pending_questions = require('./forge-interaction').mergePendingQuestions(state.pending_questions, questions); save();
    },
    answer(answers) {
      state.pending_questions = require('./forge-interaction').resolvePendingQuestions(state.pending_questions, answers); save();
    },
    record(attempt) {
      if (!['caller', 'service', 'timeout', 'interrupted', 'unknown'].includes(attempt.failure_class)) fail('recovery-failure-class-invalid');
      const measurementValid = (hash, bytes) => hash === null && bytes === null
        || typeof hash === 'string' && hash.length > 0 && Number.isFinite(bytes) && bytes >= 0;
      if (!attempt.reason_code || !attempt.layer || !measurementValid(attempt.request_sha256, attempt.request_bytes)
          || !measurementValid(attempt.context_sha256, attempt.context_bytes)
          || !(attempt.duration_ms === null || Number.isFinite(attempt.duration_ms)) || !attempt.budgets || !attempt.route) fail('recovery-telemetry-required');
      const previous = state.attempts.at(-1);
      const entry = { ...attempt, diagnostic: safeDiagnostic(attempt.diagnostic), stderr: safeDiagnostic(attempt.stderr),
        provider_called: [true, false].includes(attempt.provider_called) ? attempt.provider_called : 'unknown',
        model_observed: attempt.model_observed || 'unknown', recorded_at: clock(), route_key: routeKey(attempt.route),
        timeout_cause: attempt.failure_class === 'timeout' ? 'indeterminate' : null };
      entry.previous_attempt = previous ? { route_key: previous.route_key, recorded_at: previous.recorded_at,
        request_sha256: previous.request_sha256, context_sha256: previous.context_sha256,
        budgets: previous.budgets, context_measurement: previous.context_measurement || null } : null;
      entry.reservation = state.reservations?.at(-1) || null;
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
        if (!observed || !state.request_identity_sha256 || observed.provenance.request_identity_sha256 !== state.request_identity_sha256
            || previous.route.unit_type && observed.provenance.unit_type !== previous.route.unit_type
            || observed.provenance.host !== previous.route.host_runtime) fail('recovery-candidate-provenance-required');
        provenance = observed.provenance;
        const original = state.attempts[0].route.chain;
        if (!Array.isArray(original) || !original.length) fail('recovery-original-list-required');
        if (digest(original) !== provenance.chain_sha256 || scope?.chain_sha256 && scope.chain_sha256 !== provenance.chain_sha256) fail('recovery-candidate-list-changed');
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
        if (!remaining() && candidate.worker_mode !== 'native') {
          rejected.push({ route_key: routeKey(candidate), reason_code: 'recovery-deadline-exhausted' }); continue;
        }
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
      if (!remaining() && (!scope || route.worker_mode !== 'native')) return { action: 'stop', reason_code: 'recovery-deadline-exhausted' };
      if (scope) exceptionFor(input.exception, state, clock());
      state.phase = 'ready'; save();
      return { action: 'invoke', route, invocation, provenance, rejected, corrected: !!input.correction,
        correction: input.correction ? { offline_validated: true, request_sha256: input.correction.request_sha256,
          evidence_reference: require('./forge-attempt-telemetry').code(input.correction.evidence_reference) } : null,
        remaining_ms: remaining(), sidecar_remaining_ms: remaining(),
        ...(scope ? { authorization_reference: scope.reference, authorization_expires_at: scope.expires_at,
          native_authorization_remaining_ms: Math.max(0, scope.expires_at - clock()) } : {}), provider_called: false };
    },
    reserve(decision, requestHash) {
      if (decision.action !== 'invoke' || state.phase !== 'ready' || state.selection?.selected !== routeKey(decision.route)) fail('recovery-reservation-invalid');
      if (!remaining() && (decision.route.worker_mode !== 'native' || !(decision.authorization_expires_at > clock()))) fail('recovery-deadline-exhausted');
      const entry = { route_key: routeKey(decision.route), corrected: decision.corrected, request_sha256: requestHash,
        correction: decision.correction || null,
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
  let writer = 'unknown';
  if (options.request) {
    const request = canonicalRequest(options.request);
    try {
      const identity = digest(requestIdentity(request));
      const bound = receipt.recovery_identity_sha256 === identity
        || receipt.fingerprint === require('./forge-unit-sidecar').artifactFingerprint(options.request);
      const cap = require('./forge-transport-capabilities').capability(request.route.resolved_worker_engine,
        request.unitType, request.scope === 'milestone' ? {} : request);
      require('./forge-unit-sidecar').locations(request);
      if (bound && cap.supported) writer = cap.mode === 'execute' || request.unitType === 'review-fix';
      // A missing/stripped legacy execution field never makes an executor read-only.
      if (request.unitType === 'execute-task' || receipt.execution || receipt.reset_state_file) writer = true;
    } catch { writer = 'unknown'; }
  }
  return { receipt_checked: true, process_stopped: stopped, receipt_sha256: digest(bytes),
    phase: receipt.phase, valid_saved_response: ['ready', 'executed'].includes(receipt.phase) || !!receipt.saved_candidate,
    writer_possible: writer,
    roots_reconciled: false, receipt };
}
function captureFailure(options) {
  const fs = require('fs'), stateApi = require('./forge-xllm-state');
  validateStateTarget(options.stateFile, options.request, options.contract);
  const telemetry = require('./forge-attempt-telemetry');
  const observed = telemetry.sanitizeFinal(options.finalEvidence || options.packagedContext?.final_evidence) || telemetry.captureFinal({
    identity: options.request, route: options.route, budgets: options.budgets });
  // Legacy packaged measurements remain readable, but an absent callback is not
  // evidence that a caller's intermediate prompt reached the adapter unchanged.
  const context = options.packagedContext && !options.packagedContext.final_evidence
    ? { sha256: options.packagedContext.sha256 ?? null, bytes: options.packagedContext.bytes ?? null,
      method: 'legacy-packaged', diagnostic: null } : observed.context;
  const error = options.error || {}, code = error.code || error.reason_code || 'attempt-failed';
  const state = fs.existsSync(options.stateFile) ? stateApi.loadRecovery(options.stateFile) : undefined;
  const session = createRecovery({ unit: options.unit, roots_sha256: digest(options.contract || { cwd: options.request.cwd }),
    authorizationReference: options.receiptFile && fs.existsSync(options.receiptFile)
      ? JSON.parse(fs.readFileSync(options.receiptFile, 'utf8')).authorization_reference : undefined,
    ...(options.request.route ? { request: canonicalRequest(options.request) } : {}),
    state, persist: value => stateApi.saveRecovery(options.stateFile, value) });
  const provider = [true, false].includes(error.provider_called) ? error.provider_called : 'unknown';
  const timeout = /timeout|timed-out/.test(code);
  const service = provider === true && /quota|rate-limit|model-unavailable|service-unavailable/.test(code);
  session.record({ failure_class: timeout ? 'timeout' : service ? 'service' : provider === false ? 'caller' : 'unknown',
    service_failure_proven: service, reason_code: code, layer: options.layer || error.stage || 'unknown', route: options.route,
    request_sha256: observed.request.sha256, caller_request_sha256: callerRequestHash(options.request), context_sha256: context.sha256,
    request_bytes: observed.request.bytes, context_bytes: context.bytes,
    context_measurement: context.method, measurement_diagnostic: context.diagnostic,
    final_evidence: observed, budgets: telemetry.numericBudgets(options.budgets || observed.budgets),
    duration_ms: options.durationMs ?? observed.duration_ms ?? null, provider_called: provider,
    model_requested: observed.model_requested, model_observed: options.modelObserved || observed.model_observed || 'unknown',
    model_sent: observed.model_sent || 'unknown',
    receipt: options.receiptFile, result: options.request.resultFile,
    diagnostic: telemetry.code(error.diagnostic?.reason, telemetry.code(code, 'attempt-failed')),
    stderr: error.stderr ? '[omitted-provider-output]' : '', next_action: 'inspect-process-receipt-roots' });
  const questions = options.questions || (options.receiptFile && fs.existsSync(options.receiptFile)
    ? JSON.parse(fs.readFileSync(options.receiptFile, 'utf8')).pending_questions : null) || options.request.pending_questions;
  if (questions?.length) session.questions(questions);
  return session.snapshot();
}
async function recoverAttempt(options) {
  const stateApi = require('./forge-xllm-state');
  validateStateTarget(options.stateFile, options.request, options.executionContract);
  const state = stateApi.loadRecovery(options.stateFile);
  const expectedRoots = digest(options.executionContract || { cwd: options.request.cwd });
  const request = canonicalRequest(options.request);
  const session = createRecovery({ unit: options.unit || `${request.unitType}/${request.taskId || request.sliceId || request.milestoneId}`,
    roots_sha256: expectedRoots, state,
    ...(request.route ? { request } : {}),
    clock: options.clock, persist: value => stateApi.saveRecovery(options.stateFile, value) });
  const inspection = inspectReceipt(options.receiptFile, { processProbe: options.processProbe, request: options.request });
  if (inspection.process_stopped !== true) fail('recovery-process-receipt-inspection-required');
  if (inspection.writer_possible !== false && !inspection.valid_saved_response && options.reconcile) {
    const reset = await options.reconcile(inspection.receipt);
    const contract = options.executionContract || inspection.receipt.execution?.execution_contract || inspection.receipt.recovery_baseline?.execution_contract;
    const declared = contract && require('./forge-code-roots').validateContract(contract, { revalidate: true }).code_roots;
    inspection.roots_reconciled = reset?.ok === true && !reset.pending_roots?.length && Array.isArray(declared)
      && declared.every(root => reset.roots?.some(row => row.root_id === root.id && row.reconciled === true));
  }
  if (options.answers?.length) session.answer(options.answers);
  let correction;
  if (options.correction) {
    if (typeof options.validateCorrection !== 'function' || !options.request) fail('recovery-offline-validator-required');
    const previous = state.attempts.at(-1);
    // Final adapter arguments and caller inputs are different representations.
    // Compare inputs only with inputs; random thread ids/temp paths cannot
    // turn an unchanged caller request into an offline repair.
    if (!previous?.caller_request_sha256 || previous.caller_request_sha256 === callerRequestHash(options.request)) fail('recovery-correction-required');
    const observed = await options.validateCorrection(options.request);
    if (observed?.ok !== true) fail(observed?.reason_code || 'recovery-offline-validation-failed');
    const finalEvidence = require('./forge-attempt-telemetry').sanitizeFinal(observed.final_evidence);
    if (!finalEvidence || finalEvidence.request.status !== 'observed' || finalEvidence.context.status !== 'observed') fail('recovery-final-packaging-required');
    if (finalEvidence.request.sha256 === previous.request_sha256) fail('recovery-correction-required');
    correction = { request_sha256: finalEvidence.request.sha256,
      offline_validated: true, evidence_reference: observed.evidence_reference };
  }
  const reference = inspection.receipt.authorization_reference || state.authorization_reference;
  let exception = options.exception;
  const binding = options.recoveryAuthorization;
  if (binding && reference && binding.reference !== reference) fail('recovery-authorization-reference-mismatch');
  const authorizedReference = binding ? bindRecoveryAuthorization(binding) : reference;
  const candidateSet = !inspection.valid_saved_response && !correction
    && !session.snapshot().pending_questions.some(q => q.status === 'pending')
    && (state.attempts.at(-1)?.service_failure_proven === true || exception || binding)
    ? resolveCandidates(options.resolverOptions, options.resolveDispatch, request) : undefined;
  if (binding && candidateSet) {
    const observed = candidateSets.get(candidateSet), saved = session.snapshot();
    const authority = binding.adapter.readStandingAuthorization(authorizedReference);
    const now = (options.clock || Date.now)();
    exception = binding.adapter.issueRecoveryException(authorizedReference, { unit: saved.unit, roots_sha256: saved.roots_sha256,
      purpose: saved.purpose, owner: request.contextRoot,
      roots: options.executionContract?.code_roots.map(root => root.path) || [request.cwd],
      request_identity_sha256: saved.request_identity_sha256, chain_sha256: observed.provenance.chain_sha256,
      expires_at: Math.min(now + 3600000, authority.expires_at ?? Infinity),
      routes: observed.routes.map(routeKey), gates_preserved: true });
    session.authorization(authorizedReference);
  }
  const decision = await session.next({ inspection, candidateSet, correction,
    exception, validateInvocation: options.validateInvocation });
  if (decision.action === 'replay') {
    if (typeof options.replay !== 'function') fail('recovery-replay-required');
    return { ...decision, result: await options.replay(inspection.receipt), inspection: { ...inspection, receipt: undefined } };
  }
  if (decision.action !== 'invoke') return decision;
  session.reserve(decision, correction?.request_sha256 || state.attempts.at(-1).request_sha256);
  if (typeof options.invoke !== 'function') return { ...decision, action: 'invoke-native', inspection: { ...inspection, receipt: undefined } };
  decision.remaining_ms = session.remaining(); decision.sidecar_remaining_ms = decision.remaining_ms;
  // The invocation budget is always the historic sidecar budget. Native
  // authorization validity is returned separately, never a fresh sidecar wait.
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
module.exports = { canonicalRequest, bindRecoveryAuthorization, createRecovery, resolveCandidates, createAuthority, exceptionFor, requestIdentity, validateState, validateStateTarget, routeKey, safeDiagnostic, inspectReceipt, captureFailure, recoverAttempt, cli };
if (require.main === module) cli(process.argv.slice(2)).then(value => process.stdout.write(JSON.stringify(value) + '\n')).catch(error => {
  process.stderr.write(JSON.stringify({ reason_code: error.code || 'recovery-command-failed' }) + '\n'); process.exitCode = 2;
});
