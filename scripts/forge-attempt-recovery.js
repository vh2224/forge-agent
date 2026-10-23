'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { digest } = require('./forge-code-roots');
const exceptions = new WeakMap();
const candidateSets = new WeakMap();
const environmentalRepairs = new WeakSet();
const linkedEntries = new WeakMap();
const transitions = require('./forge-recovery-transition');
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
  if (request.linked_begin_key) {
    const entry = linkedEntries.get(request.linkedEntryBinding);
    if (!entry || entry.begin_key !== request.linked_begin_key || entry.unit !== `${request.unitType}/${request.taskId || request.sliceId || request.milestoneId}`
      || entry.owner !== canonical(request.contextRoot) || entry.host_runtime !== request.route.host_runtime
      || entry.milestone !== request.milestoneId) fail('linked-entry-binding-required');
    result.linked_entry = { entry_id: entry.entry_id, entry_digest: entry.entry_digest, classification: 'new-unit' };
  }
  return result;
}
function bindLinkedRequest(request, options) {
  if (!request.linked_begin_key) return request;
  const entry = require('./forge-unit-controller').validateLinkedEntry(request.contextRoot || request.cwd, request.linked_begin_key, options);
  const begin = require('./forge-unit-controller').lookupRecord(request.contextRoot || request.cwd, 'transaction', request.linked_begin_key);
  const canonical = file => { const real = fs.realpathSync.native(file); return process.platform === 'win32' ? real.toLowerCase() : real; };
  if (!entry.roots.some(root => canonical(root.path) === canonical(request.cwd))) fail('linked-entry-roots-mismatch');
  if (request.execution_contract && request.execution_contract.code_roots.some(root => !entry.roots.some(bound => bound.root_id === root.id
    && canonical(bound.path) === canonical(root.path)))) fail('linked-entry-roots-mismatch');
  const handle = Object.freeze({});
  const owner = fs.realpathSync(request.contextRoot || request.cwd);
  linkedEntries.set(handle, { ...entry, owner: process.platform === 'win32' ? owner.toLowerCase() : owner,
    host_runtime: begin.host_runtime, milestone: begin.milestone });
  const bound = { ...request, linkedEntryBinding: handle };
  requestIdentity(canonicalRequest(bound));
  return bound;
}
function resolveCandidates(options, resolve = require('./forge-dispatch-resolve').resolveDispatch, request) {
  const identity = requestIdentity(request);
  if (!options || options.unitType !== identity.unit_type || options.scope !== identity.scope || options.phase !== identity.phase
      || options.hostRuntime !== identity.host || (options.milestoneId || null) !== identity.milestone_id
      || options.unitId !== (identity.task_id || identity.slice_id || identity.milestone_id)
      || (options.planPath || null) !== (request.planFile || null)
      || (options.roadmapPath || null) !== (request.roadmapFile || null) && !(identity.scope === 'milestone'
        && options.roadmapPath === require('path').join(request.contextRoot, '.gsd', 'milestones', request.milestoneId, `${request.milestoneId}-ROADMAP.md`))
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
  const remaining = () => {
    state.clock_high_water = Math.max(state.clock_high_water ?? state.started_at, clock());
    state.budget_remaining_ms = Math.min(state.budget_remaining_ms ?? 60000,
      Math.max(0, state.deadline_at - state.clock_high_water));
    return state.budget_remaining_ms;
  };
  const save = () => {
    remaining();
    options.persist?.(JSON.parse(JSON.stringify(state)));
    return JSON.parse(JSON.stringify(state));
  };
  return Object.freeze({
    snapshot: save, remaining,
    inspect: () => JSON.parse(JSON.stringify(state)),
    transition(handle) {
      const row = transitions.assertLive(handle).reference;
      if (!(state.transitions || []).some(previous => digest(previous) === digest(row))) state.transitions = [...(state.transitions || []), row];
      return save();
    },
    authorization(reference) { state.authorization_reference = reference; return save(); },
    questions(questions) {
      state.pending_questions = require('./forge-interaction').mergePendingQuestions(state.pending_questions, questions); save();
    },
    answer(answers) {
      state.pending_questions = require('./forge-interaction').resolvePendingQuestions(state.pending_questions, answers); save();
    },
    record(attempt) {
      if (!['caller', 'service', 'timeout', 'silence', 'interrupted', 'unknown'].includes(attempt.failure_class)) fail('recovery-failure-class-invalid');
      const measurementValid = (hash, bytes) => hash === null && bytes === null
        || typeof hash === 'string' && hash.length > 0 && Number.isFinite(bytes) && bytes >= 0;
      if (!attempt.reason_code || !attempt.layer || !measurementValid(attempt.request_sha256, attempt.request_bytes)
          || !measurementValid(attempt.context_sha256, attempt.context_bytes)
          || !(attempt.duration_ms === null || Number.isFinite(attempt.duration_ms)) || !attempt.budgets || !attempt.route) fail('recovery-telemetry-required');
      const previous = state.attempts.at(-1);
      const entry = { ...attempt, diagnostic: safeDiagnostic(attempt.diagnostic), stderr: safeDiagnostic(attempt.stderr),
        provider_called: [true, false].includes(attempt.provider_called) ? attempt.provider_called : 'unknown',
        model_observed: attempt.model_observed || 'unknown', recorded_at: clock(), route_key: routeKey(attempt.route),
        timeout_cause: ['timeout', 'silence'].includes(attempt.failure_class) ? 'indeterminate' : null };
      entry.previous_attempt = previous ? { route_key: previous.route_key, recorded_at: previous.recorded_at,
        request_sha256: previous.request_sha256, context_sha256: previous.context_sha256,
        budgets: previous.budgets, context_measurement: previous.context_measurement || null } : null;
      entry.observation = attempt.observation ? require('./forge-sidecar-diagnostic').observation(attempt.observation) : null;
      entry.reservation = state.reservations?.at(-1) || null;
      state.attempts.push(entry); state.phase = 'inspection'; return save();
    },
    async next(input) {
      if (state.pending_questions.some(q => q.status === 'pending')) return { action: 'pending-questions', questions: state.pending_questions };
      if (!input.inspection || input.inspection.process_stopped !== true || input.inspection.receipt_checked !== true) fail('recovery-process-receipt-inspection-required');
      if (input.inspection.valid_saved_response === true) return { action: 'replay', provider_called: false };
      if (input.inspection.writer_possible !== false && input.inspection.roots_reconciled !== true) fail('recovery-writer-reconciliation-required');
      const pendingReservation = state.reservations?.at(-1);
      if (pendingReservation?.reason === 'anomalous-silence-same-target'
        && !state.attempts.some(a => a.reservation && digest(a.reservation) === digest(pendingReservation))) {
        return { action: 'stop', reason_code: 'recovery-reservation-pending' };
      }
      let scope;
      if (input.exception) scope = exceptionFor(input.exception, state, clock());
      if (!remaining() && !scope) return { action: 'stop', reason_code: 'recovery-deadline-exhausted' };
      const previous = state.attempts.at(-1);
      if (!previous) fail('recovery-previous-attempt-required');
      let routes, provenance;
      const silenceRetry = previous.failure_class === 'silence'
        && previous.observation?.silence?.cause === 'indeterminate' && scope
        && !(state.reservations || []).some(r => r.reason === 'anomalous-silence-same-target');
      const transition = input.transition ? transitions.assertLive(input.transition) : null;
      const environmentRepair = environmentalRepairs.has(input.correction);
      if (environmentRepair && (state.reservations || []).some(a => a.correction?.kind === 'environment'
          && a.correction.failure_id === input.correction.failure_id)) fail('recovery-corrected-retry-exhausted');
      if (silenceRetry) {
        if (remaining() <= 5000) return { action: 'stop', reason_code: 'recovery-deadline-exhausted' };
        routes = [previous.route];
      }
      else if (!environmentRepair && !transition && (previous.failure_class === 'caller' || previous.failure_class === 'timeout' && input.correction)) {
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
        const effective = transition?.resolution?.effective;
        if ((effective ? digest(effective.chain) : digest(original)) !== provenance.chain_sha256
            || scope?.chain_sha256 && scope.chain_sha256 !== provenance.chain_sha256) fail('recovery-candidate-list-changed');
        routes = observed.routes.filter(candidate => (effective?.chain || original).some(member => member.id === (candidate.model_resolved || candidate.model)
          && member.engine === candidate.engine)
          && ![...state.attempts, ...(state.reservations || [])].some(a => a.route_key === routeKey(candidate)
            || transition && (a.destination_key || a.route && transitions.destinationKey(a.route)) === transitions.destinationKey(candidate)));
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
        const policy = transition?.resolution?.effective || previous.route;
        if (candidate.effort !== policy.effort || candidate.tier !== policy.tier) {
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
        ...(transition ? { transition_reference: transition.reference } : {}),
        correction: input.correction ? { offline_validated: true, request_sha256: input.correction.request_sha256,
          ...(environmentRepair ? { kind: 'environment', failure_id: input.correction.failure_id } : {}),
          evidence_reference: require('./forge-attempt-telemetry').code(input.correction.evidence_reference) } : null,
        remaining_ms: silenceRetry ? Math.min(30000, remaining()) : remaining(), sidecar_remaining_ms: remaining(), silence_retry: !!silenceRetry,
        ...(scope ? { authorization_reference: scope.reference, authorization_expires_at: scope.expires_at,
          native_authorization_remaining_ms: Math.max(0, scope.expires_at - clock()) } : {}), provider_called: false };
    },
    async resumeReservation(input) {
      if (state.pending_questions.some(q => q.status === 'pending')) return { action: 'pending-questions', questions: state.pending_questions };
      if (input.inspection?.process_stopped !== true || input.inspection.receipt_checked !== true
          || input.inspection.valid_saved_response || input.inspection.roots_reconciled !== true) fail('recovery-writer-reconciliation-required');
      const saved = state.reservations?.at(-1), previous = state.attempts.at(-1);
      const transition = input.transition ? transitions.assertLive(input.transition) : null;
      if (!saved || digest(saved) !== input.reservation_sha256 || saved.handoff_pending !== true || saved.handed_off_at
          || (transition ? digest(saved.transition_reference) !== digest(transition.reference)
            : !environmentalRepairs.has(input.correction) || saved.correction?.kind !== 'environment'
              || saved.correction.failure_id !== input.correction.failure_id)) fail('recovery-handoff-reservation-invalid');
      const scope = exceptionFor(input.exception, state, clock()), observed = candidateSets.get(input.candidateSet);
      if (!observed || observed.provenance.request_identity_sha256 !== state.request_identity_sha256
          || digest(observed.provenance) !== digest(saved.provenance)
          || digest(transition?.resolution?.effective.chain || previous.route.chain) !== observed.provenance.chain_sha256) fail('recovery-candidate-provenance-required');
      const route = observed.routes.find(row => routeKey(row) === saved.route_key);
      const policy = transition?.resolution?.effective || previous.route;
      if (!route || route.worker_mode !== 'native' || route.dispatch_allowed !== true || route.tier !== policy.tier
          || route.effort !== policy.effort || !scope.routes.includes(saved.route_key)) fail('recovery-handoff-route-invalid');
      const invocation = await input.validateInvocation(route);
      if (invocation?.ok !== true) fail(invocation?.reason_code || 'recovery-adapter-refused');
      exceptionFor(input.exception, state, clock());
      saved.handoff_pending = false; saved.handed_off_at = clock(); state.phase = 'external-handoff'; save();
      return { action: 'invoke', route, invocation, corrected: true, correction: saved.correction,
        provenance: saved.provenance, remaining_ms: remaining(), sidecar_remaining_ms: remaining(),
        authorization_reference: scope.reference, authorization_expires_at: scope.expires_at,
        provider_called: false, reservation_sha256: input.reservation_sha256 };
    },
    reserve(decision, requestHash, handoffPending = false) {
      if (decision.action !== 'invoke' || state.phase !== 'ready' || state.selection?.selected !== routeKey(decision.route)) fail('recovery-reservation-invalid');
      if (!remaining() && (decision.route.worker_mode !== 'native' || !(decision.authorization_expires_at > clock()))) fail('recovery-deadline-exhausted');
      const entry = { route_key: routeKey(decision.route), corrected: decision.corrected, request_sha256: requestHash,
        destination_key: transitions.destinationKey(decision.route),
        ...(decision.transition_reference ? { transition_reference: decision.transition_reference } : {}),
        correction: decision.correction || null,
        ...(handoffPending ? { handoff_pending: true } : {}),
        reserved_at: clock(), reason: decision.silence_retry ? 'anomalous-silence-same-target' : decision.corrected ? 'offline-correction' : 'resolved-next-destination',
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
  if (typeof options.processProbe === 'function') {
    const observed = options.processProbe(receipt) === 'stopped';
    stopped = Number.isInteger(pid) && pid > 0 && !stopped ? false : observed;
  }
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
  const silence = code === 'claude-anomalous-silence'
    && require('./forge-sidecar-diagnostic').observation(error.diagnostic?.observation).silence?.cause === 'indeterminate';
  const timeout = /timeout|timed-out/.test(code);
  const service = provider === true && /quota|rate-limit|model-unavailable|service-unavailable/.test(code);
  session.record({ failure_class: silence ? 'silence' : timeout ? 'timeout' : service ? 'service' : provider === false ? 'caller' : 'unknown',
    observation: error.diagnostic?.observation, service_failure_proven: service, reason_code: code, layer: options.layer || error.stage || 'unknown', route: options.route,
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
// This path is intentionally unavailable through JSON/CLI. The embedding host
// must independently observe the awaited adapter process and its staging, not
// infer either fact from provider_called:false or a missing execution field.
async function inspectPreSpawn(options, state, inspection) {
  const fs = require('fs'), path = require('path'), roots = require('./forge-code-roots');
  const execution = require('./forge-task-execution'), reset = require('./forge-surgical-reset');
  const request = options.request, receipt = inspection.receipt, previous = state.attempts.at(-1);
  const contract = roots.validateContract(options.executionContract, { owner: request.contextRoot || request.cwd, revalidate: true });
  const claim = options.executionAuthority?.claim || request.claim;
  if (typeof options.inspectPreSpawn !== 'function' || typeof options.processProbe !== 'function') fail('recovery-pre-spawn-inspector-required');
  if (inspection.valid_saved_response || receipt.phase !== 'failed'
      || receipt.failure?.reason_code !== 'execution-protected-snapshot-unstable'
      || previous?.reason_code !== receipt.failure.reason_code || previous.failure_class !== 'caller'
      || receipt.execution || receipt.recovery_baseline || receipt.reset_state_file || receipt.final_evidence
      || receipt.failure.final_evidence || receipt.saved_candidate || receipt.provider_called === true
      || receipt.failure.provider_called !== false || receipt.dispatch_id !== request.dispatchId
      || receipt.recovery_identity_sha256 !== digest(requestIdentity(canonicalRequest(request)))
      || receipt.fingerprint !== require('./forge-unit-sidecar').artifactFingerprint(request)
      || previous.caller_request_sha256 !== callerRequestHash(request)
      || !claim?.generation || claim.released) fail('recovery-pre-spawn-binding');
  let stateHash = digest(fs.readFileSync(options.stateFile));
  const challenge = { receipt_sha256: inspection.receipt_sha256, state_sha256: stateHash,
    request_sha256: callerRequestHash(request), request_identity_sha256: receipt.recovery_identity_sha256,
    dispatch_id: request.dispatchId, result_file: path.resolve(request.resultFile),
    contract_sha256: digest(contract), claim_sha256: digest(claim), claim_generation: claim.generation,
    failure_reason: previous.reason_code, roots: contract.code_roots.map(root => ({ ...root })) };
  const challengeHash = digest(challenge);
  const assertIdentity = () => {
    if (digest(fs.readFileSync(options.receiptFile)) !== challenge.receipt_sha256
        || digest(fs.readFileSync(options.stateFile)) !== stateHash
        || callerRequestHash(request) !== challenge.request_sha256
        || digest(options.executionAuthority?.claim || request.claim) !== challenge.claim_sha256
        || digest(roots.validateContract(options.executionContract, { revalidate: true })) !== challenge.contract_sha256
        || options.processProbe(receipt) !== 'stopped') fail('recovery-pre-spawn-inspection-changed');
    options.validateExecutionAuthority?.();
  };
  const attest = JSON.parse(JSON.stringify(await options.inspectPreSpawn(JSON.parse(JSON.stringify(challenge))) || null));
  assertIdentity();
  if (attest?.binding_sha256 !== challengeHash || attest.stage !== 'before-provider-spawn'
      || attest.process !== 'stopped' || !attest.process_reference || !attest.stage_reference
      || !attest.baseline?.path || !attest.baseline.sha256 || !attest.baseline.provenance_reference) fail('recovery-pre-spawn-unproved');
  const baselineBytes = fs.readFileSync(attest.baseline.path);
  if (digest(baselineBytes) !== attest.baseline.sha256) fail('recovery-pre-spawn-baseline-binding');
  const historical = JSON.parse(baselineBytes);
  const rows = historical.schema_version === 2 ? historical.repos : [historical];
  if (!Array.isArray(rows) || rows.length !== contract.code_roots.length) fail('recovery-pre-spawn-baseline-roots');
  const current = () => contract.code_roots.map(root => {
    const before = rows.find(row => row.code_dir && roots.key(fs.realpathSync.native(row.code_dir)) === roots.key(root.path)
      && (contract.code_roots.length === 1 || row.root_id === root.id));
    if (!before?.start_sha || !Array.isArray(before.pre_dirty) || before.vcs !== root.vcs) fail('recovery-pre-spawn-baseline-roots');
    const claimed = claim.paths.filter(row => row.root_id === root.id).map(row => {
      if (/[*?]/.test(row.path)) fail('recovery-pre-spawn-concrete-claims-required');
      const file = roots.resolvePath(contract, row);
      let stat; try { stat = fs.lstatSync(file.absolute); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (stat && (!stat.isFile() || stat.size > 16 * 1024 * 1024)) fail('recovery-pre-spawn-concrete-claims-required');
      return { path: row.path, sha256: stat ? digest(fs.readFileSync(file.absolute)) : null };
    });
    return { root_id: root.id, before, current: reset.captureAttemptSnapshot(root.path), claimed };
  });
  const observations = current();
  for (const row of observations) {
    const drift = row.before.start_sha !== row.current.start_sha || digest(row.before.pre_dirty) !== digest(row.current.pre_dirty)
      || row.current.svn_state && digest(row.before.svn_state) !== digest(row.current.svn_state);
    // Ignored declared files have no historical VCS census. Even an otherwise
    // clean root needs independent attribution, not an inferred unchanged bit.
    if (typeof options.inspectPreSpawnDelta !== 'function') fail('recovery-pre-spawn-drift-unproved');
    const delta = { ...challenge, baseline_sha256: attest.baseline.sha256, vcs_drift: !!drift, ...row };
    const observed = await options.inspectPreSpawnDelta(JSON.parse(JSON.stringify(delta)));
    assertIdentity();
    if (observed?.binding_sha256 !== digest(delta) || observed.classification !== 'no-failed-worker-writes'
        || !observed.evidence_reference) fail('recovery-pre-spawn-drift-unproved');
  }
  // These are contemporary guards, explicitly not missing historical snapshots.
  const protectedRoots = [...new Set([contract.owner, ...contract.code_roots.map(root => root.path)])]
    .map(root => ({ root, snapshot: execution.protectedSnapshot(root) }));
  let window;
  const assertUnchanged = () => {
    assertIdentity();
    if (digest(fs.readFileSync(attest.baseline.path)) !== attest.baseline.sha256
        || digest(current()) !== digest(observations)) fail('recovery-pre-spawn-inspection-changed');
    for (const row of protectedRoots) execution.assertProtected(row.root, row.snapshot);
    if (window) require('./forge-unit-lease').assertProtectedWindow(window, contract.owner, state.unit);
  };
  assertUnchanged();
  return { assertUnchanged, bindWindow(handle) {
    require('./forge-unit-lease').assertProtectedWindow(handle, contract.owner, state.unit);
    window = handle;
    // Exercise the actual read-only heartbeat against the guarded snapshots.
    if (!window.heartbeat().ok) fail('recovery-environment-repair-unproved');
    assertUnchanged();
  }, acceptPersist(value) {
    if (digest(JSON.parse(fs.readFileSync(options.stateFile))) !== digest(value)) fail('recovery-pre-spawn-inspection-changed');
    stateHash = digest(fs.readFileSync(options.stateFile));
  }, challenge: Object.freeze(challenge), failure_id: digest({ receipt: challenge.receipt_sha256,
    request: challenge.request_sha256, reason: challenge.failure_reason }), contract };
}
async function recoverAttempt(options) {
  const stateApi = require('./forge-xllm-state');
  validateStateTarget(options.stateFile, options.request, options.executionContract);
  const stateBytes = fs.readFileSync(options.stateFile);
  const state = validateState(JSON.parse(stateBytes.toString('utf8')));
  let expectedStateHash = digest(stateBytes);
  let expectedRoots = digest(options.executionContract || { cwd: options.request.cwd });
  const inspection = inspectReceipt(options.receiptFile, { processProbe: options.processProbe, request: options.request });
  const savedWriter = typeof options.inspectSavedResult === 'function' ? await options.inspectSavedResult() : null;
  if (savedWriter) {
    transitions.assertWriterObservation(savedWriter);
    inspection.valid_saved_response = true;
  }
  if (inspection.process_stopped !== true) fail('recovery-process-receipt-inspection-required');
  if (options.transitions && state.pending_questions.some(row => row.status === 'pending') && !options.answers?.length)
    return { action: 'pending-questions', questions: state.pending_questions };
  const transition = options.transitions ? await transitions.prepare(options, state, inspection) : null;
  const transitionGuard = transition?.handle ? transitions.assertLive(transition.handle) : null;
  if (transition?.disposed) { inspection.valid_saved_response = false; inspection.roots_reconciled = true; }
  const preSpawn = options.environmentalCorrection && !inspection.valid_saved_response
    ? await inspectPreSpawn(options, state, inspection) : null;
  // Preserve the historical single-cwd identity; adding current held authority
  // does not rewrite the original record into a fabricated multi-root attempt.
  if (preSpawn && state.roots_sha256 === digest({ cwd: options.request.cwd })
      && preSpawn.contract.code_roots.length === 1
      && require('./forge-code-roots').key(preSpawn.contract.code_roots[0].path)
        === require('./forge-code-roots').key(require('fs').realpathSync.native(options.request.cwd))) expectedRoots = state.roots_sha256;
  const request = canonicalRequest(options.request);
  const session = createRecovery({ unit: options.unit || `${request.unitType}/${request.taskId || request.sliceId || request.milestoneId}`,
    roots_sha256: expectedRoots, state,
    ...(request.route ? { request } : {}),
    clock: options.clock, persist: value => {
      preSpawn?.assertUnchanged();
      transitionGuard?.assertUnchanged();
      const lockApi = require('./forge-lock');
      // A private transport mutex must not change guarded owner/code metadata.
      const lockRoot = path.join(require('os').tmpdir(), 'forge-recovery-' + digest(path.resolve(options.stateFile)));
      fs.mkdirSync(path.join(lockRoot, '.gsd'), { recursive: true });
      let guard = lockApi.tryAcquireSync(lockRoot, 'state', { allowStaleRecovery: false });
      if (!guard) {
        const observed = lockApi.status(lockRoot, 'state').metadata;
        // TTL alone never proves a paused writer dead. Revalidate the exact
        // owner/generation and OS process before canonical stale-marker recovery.
        // Unknown/missing metadata or process access errors remain busy.
        if (!observed?.owner_token || !observed.generation
            || !Number.isSafeInteger(observed.holder_pid) || observed.holder_pid <= 0) fail('recovery-state-busy');
        let stoppedOwner = false;
        guard = lockApi.tryAcquireSync(lockRoot, 'state', { now: () => {
          const status = lockApi.status(lockRoot, 'state');
          // The canonical acquisition calls the clock again to create the
          // successor after successfully claiming/removing the stale marker.
          if (!status.held && stoppedOwner) return Date.now();
          const current = status.metadata;
          if (current?.owner_token !== observed.owner_token || current?.generation !== observed.generation
              || current?.holder_pid !== observed.holder_pid) fail('recovery-state-busy');
          try { process.kill(observed.holder_pid, 0); }
          catch (error) { if (error.code === 'ESRCH') { stoppedOwner = true; return Date.now(); } }
          fail('recovery-state-busy');
        } });
      }
      if (!guard) fail('recovery-state-busy');
      try {
        if (digest(fs.readFileSync(options.stateFile)) !== expectedStateHash) fail('recovery-state-raced');
        if (!lockApi.assertOwned(guard)) fail('recovery-state-lock-lost');
        stateApi.saveRecovery(options.stateFile, value);
        expectedStateHash = digest(fs.readFileSync(options.stateFile));
      } finally { guard.release(); }
      preSpawn?.acceptPersist(value); transitionGuard?.acceptPersist(value);
    } });
  if (transitionGuard) { session.transition(transition.handle); inspection.roots_reconciled = true; }
  if (preSpawn) inspection.roots_reconciled = true;
  if (!preSpawn && !transitionGuard && inspection.writer_possible !== false && !inspection.valid_saved_response && options.reconcile) {
    const reset = await options.reconcile(inspection.receipt);
    const contract = options.executionContract || inspection.receipt.execution?.execution_contract || inspection.receipt.recovery_baseline?.execution_contract;
    const declared = contract && require('./forge-code-roots').validateContract(contract, { revalidate: true }).code_roots;
    inspection.roots_reconciled = reset?.ok === true && !reset.pending_roots?.length && Array.isArray(declared)
      && declared.every(root => reset.roots?.some(row => row.root_id === root.id && row.reconciled === true));
  }
  if (options.answers?.length) session.answer(options.answers);
  let correction;
  if (preSpawn) {
    if (options.correction || typeof options.validateEnvironmentalCorrection !== 'function') fail('recovery-environment-validator-required');
    const observed = await options.validateEnvironmentalCorrection(JSON.parse(JSON.stringify(preSpawn.challenge)));
    if (observed?.binding_sha256 !== digest(preSpawn.challenge) || observed.ok !== true
        || observed.repair !== 'bounded-held-lease-window' || !observed.evidence_reference
        || observed.offline_check?.passed !== true || !observed.offline_check.command
        || observed.offline_check.exit_code !== 0) fail('recovery-environment-repair-unproved');
    preSpawn.assertUnchanged();
    preSpawn.bindWindow(observed.lease_window);
    correction = Object.freeze({ kind: 'environment', failure_id: preSpawn.failure_id,
      request_sha256: state.attempts.at(-1).request_sha256, offline_validated: true, evidence_reference: observed.evidence_reference });
    environmentalRepairs.add(correction);
  }
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
  const candidateSet = !inspection.valid_saved_response && (!correction || preSpawn)
    && !session.snapshot().pending_questions.some(q => q.status === 'pending')
    && (state.attempts.at(-1)?.service_failure_proven === true || exception || binding)
    ? resolveCandidates(transition?.resolution ? { ...transition.resolution.options, scope: request.scope, phase: request.phase }
      : options.resolverOptions, transitionGuard ? undefined : options.resolveDispatch, request) : undefined;
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
  preSpawn?.assertUnchanged();
  const nextInput = { inspection, candidateSet, correction, exception, transition: transition?.handle,
    validateInvocation: options.validateInvocation };
  const decision = options.resumeReservation
    ? await session.resumeReservation({ ...nextInput, reservation_sha256: options.resumeReservation.sha256 })
    : await session.next(nextInput);
  if (decision.action === 'replay' && savedWriter) await transitions.assertWriterObservation(savedWriter).refresh();
  if (decision.action === 'replay') {
    if (typeof options.replay !== 'function') fail('recovery-replay-required');
    return { ...decision, result: await options.replay(inspection.receipt), inspection: { ...inspection, receipt: undefined } };
  }
  if (decision.action !== 'invoke') return decision;
  // session persistence changes the recovery file itself; validate the original
  // bytes immediately before reservation, then bind the newly saved state too.
  preSpawn?.assertUnchanged();
  if (!options.resumeReservation) {
    const reserve = () => session.reserve(decision, correction?.request_sha256 || state.attempts.at(-1).request_sha256,
      !!(preSpawn || transitionGuard) && options.externalNativeHandoff === true && decision.route.worker_mode === 'native');
    const saved = transitionGuard ? transitionGuard.withLock(reserve) : reserve();
    decision.reservation_sha256 = digest(saved.reservations.at(-1));
  }
  if (typeof options.invoke !== 'function' && (preSpawn || transitionGuard) && options.externalNativeHandoff === true
      && !options.resumeReservation && decision.route.worker_mode === 'native') return {
    action: 'reattest-native-handoff', reservation_sha256: decision.reservation_sha256, provider_called: false };
  if (typeof options.invoke !== 'function') return { ...decision, action: 'invoke-native',
    ...((preSpawn || transitionGuard) ? { assertReady: transitionGuard ? () => transitionGuard.withLock(() => {}) : preSpawn.assertUnchanged } : {}), inspection: { ...inspection, receipt: undefined } };
  decision.sidecar_remaining_ms = session.remaining();
  decision.remaining_ms = decision.silence_retry ? Math.min(30000, decision.sidecar_remaining_ms) : decision.sidecar_remaining_ms;
  if (decision.route.worker_mode !== 'native' && decision.remaining_ms <= 5000) fail('recovery-deadline-exhausted');
  // The invocation budget is always the historic sidecar budget. Native
  // authorization validity is returned separately, never a fresh sidecar wait.
  preSpawn?.assertUnchanged();
  const reservedStateHash = digest(require('fs').readFileSync(options.stateFile));
  const reservedRequestHash = callerRequestHash(options.request);
  const assertAuthority = () => {
    const live = inspectReceipt(options.receiptFile, { processProbe: options.processProbe, request: options.request });
    if (callerRequestHash(options.request) !== reservedRequestHash
        || live.process_stopped !== true || live.receipt_sha256 !== inspection.receipt_sha256
        || digest(require('fs').readFileSync(options.stateFile)) !== reservedStateHash) fail('recovery-process-receipt-inspection-changed');
    if (binding) binding.adapter.readStandingAuthorization(authorizedReference);
    if (exception) exceptionFor(exception, session.inspect(), (options.clock || Date.now)());
  };
  const assertReady = Object.assign(() => {
    assertAuthority();
    if (transitionGuard) transitionGuard.withLock(() => {});
    else preSpawn?.assertUnchanged();
  }, { assertAuthority, ...(transitionGuard ? { appendOwnerEvent: line => transitionGuard.appendOwnerEvent(line) } : {}) });
  const invoke = () => options.invoke(decision.route, decision.invocation, decision.remaining_ms,
    assertReady, decision.reservation_sha256);
  // The adapter repeats assertReady at the actual native callback. Do not hold
  // the publication mutex while awaiting a provider or its publication.
  transitionGuard?.withLock(() => {});
  const result = await invoke();
  // Phase one exposes only a durable reservation, never executable arguments.
  // The next phase must rebuild and validate them under fresh live authority.
  if ((preSpawn || transitionGuard) && options.externalNativeHandoff === true && !options.resumeReservation
      && decision.route.worker_mode === 'native') return {
    action: 'reattest-native-handoff', reservation_sha256: decision.reservation_sha256,
    provider_called: false, result,
  };
  return { ...decision, result };
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
    return { state, remaining_ms: Math.min(state.budget_remaining_ms ?? 60000, Math.max(0, state.deadline_at - Math.max(state.clock_high_water ?? state.started_at, Date.now()))), inspection: { ...inspected, receipt: undefined } };
  }
  if (['--preparation', '--unit'].includes(argv[0]) && argv[1]) {
    const input = JSON.parse(fs.readFileSync(argv[1], 'utf8'));
    const recovery = { stateFile: input.state_file, receiptFile: input.receipt_file, answers: input.answers, correction: input.correction };
    return argv[0] === '--preparation' ? require('./forge-task-preparation').recoverStandaloneTask(input.request, recovery)
      : require('./forge-unit-sidecar').recoverUnitSidecar(input.request, recovery);
  }
  fail('usage: forge-attempt-recovery.js --inspect <state.json> <receipt.json> | --preparation <request.json>');
}
module.exports = { canonicalRequest, callerRequestHash, bindRecoveryAuthorization, bindLinkedRequest, createRecovery, resolveCandidates, createAuthority, exceptionFor, requestIdentity, validateState, validateStateTarget, routeKey, safeDiagnostic, inspectReceipt, captureFailure, recoverAttempt, cli };
if (require.main === module) cli(process.argv.slice(2)).then(value => process.stdout.write(JSON.stringify(value) + '\n')).catch(error => {
  process.stderr.write(JSON.stringify({ reason_code: error.code || 'recovery-command-failed' }) + '\n'); process.exitCode = 2;
});
