'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const roots = require('./forge-code-roots');
const resolver = require('./forge-dispatch-resolve');
const reconciliation = require('./forge-artifact-reconciliation');
const execution = require('./forge-task-execution');
const { digest } = roots;
const adapters = new WeakMap(), handles = new WeakMap();
const TYPES = Object.freeze(['resolver-context-omission', 'saved-candidate-unreplayable', 'uninvoked-native-reservation']);
function fail(code) { throw Object.assign(new Error(code), { code, provider_called: false }); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function hashFile(file) { try { return digest(fs.readFileSync(file)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }

// Only the embedding host constructs this adapter. attestHistory must consult
// independently retained evidence, not accept a caller's JSON or timestamps.
function createTransitionAdapter(callbacks) {
  if (typeof callbacks?.attestHistory !== 'function' || typeof callbacks?.attestRoot !== 'function') fail('transition-live-adapter-required');
  const adapter = Object.freeze({ id: crypto.randomUUID() });
  adapters.set(adapter, callbacks); return adapter;
}
function destinationKey(route) {
  return digest({ host: route.host_runtime, worker: route.resolved_worker_engine,
    model: route.model_resolved || route.model });
}
function rootObservations(contract, claim) {
  return [{ id: 'owner', path: contract.owner }, ...contract.code_roots].map(root => ({
    root_id: root.id, path: root.path, protected: execution.protectedSnapshot(root.path),
    code: root.id === 'owner' ? null : execution.replayState(root.path),
    claimed: (claim?.paths || []).filter(row => row.root_id === root.id).map(row => {
      if (/[*?]/.test(row.path)) fail('transition-concrete-claims-required');
      return { path: row.path, sha256: hashFile(roots.resolvePath(contract, row).absolute) };
    }),
  }));
}
// This builds DATA for a host's independent evidence store. Calling it now is
// never proof of a past resolution. Its authentication is deliberately external.
function observeHistory({ request, state, receiptFile, contract, claim, resolverOptions }) {
  const recovery = require('./forge-attempt-recovery');
  const identity = recovery.requestIdentity(recovery.canonicalRequest(request));
  const receiptBytes = fs.readFileSync(receiptFile), receipt = JSON.parse(receiptBytes);
  const resolved = resolverOptions ? resolver.resolveDispatch(resolverOptions) : null;
  return { schema_version: 1, request_identity_sha256: digest(identity),
    request_sha256: recovery.callerRequestHash(recovery.canonicalRequest(request)), roots_sha256: digest(contract), claim_sha256: digest(claim || null),
    started_at: state.started_at, deadline_at: state.deadline_at,
    attempts: clone(state.attempts), reservations: clone(state.reservations || []), pending_questions: clone(state.pending_questions),
    receipt_sha256: digest(receiptBytes), candidate_sha256: receipt.saved_candidate ? digest(receipt.saved_candidate) : null,
    broker_manifest_sha256: receipt.broker_manifest_sha256 || null,
    anchor_sha256: hashFile(`${receiptFile}.response-anchor.json`),
    roots: rootObservations(contract, claim),
    ...(resolved ? { resolution: { options: resolved.resolution_options,
      sources: resolver.resolutionInputs(resolved.resolution_options, { milestoneId: request.milestoneId,
        roadmapPath: request.roadmapFile, planPath: request.planFile }),
      policy: resolver.resolutionPolicy(resolved) } } : {}),
  };
}
function validateHistory(history, request, state, contract, claim, receipt, attested) {
  const recovery = require('./forge-attempt-recovery');
  if (history?.schema_version !== 1 || history.request_identity_sha256 !== digest(recovery.requestIdentity(recovery.canonicalRequest(request)))
      || history.request_sha256 !== recovery.callerRequestHash(request) || history.roots_sha256 !== digest(contract)
      || history.claim_sha256 !== digest(claim || null) || history.started_at !== state.started_at || history.deadline_at !== state.deadline_at
      || !history.attempts?.length || digest(state.attempts.slice(0, history.attempts.length)) !== digest(history.attempts)
      || digest((state.reservations || []).slice(0, history.reservations?.length)) !== digest(history.reservations)
      || history.receipt_sha256 !== receipt.receipt_sha256 || history.candidate_sha256 !== receipt.candidate_sha256
      || history.anchor_sha256 !== receipt.anchor_sha256) fail('transition-historical-binding');
  if (digest(history.pending_questions) !== digest(state.pending_questions)) {
    // A resolved answer is not an identity change. On restart the live host
    // authenticates the answer source; serialized resolved flags alone cannot.
    if (!attested.question_evidence_reference || attested.question_state_sha256 !== digest(state.pending_questions)) fail('transition-question-history-unproved');
    const answers = state.pending_questions.filter(row => row.status === 'resolved'
      && history.pending_questions.some(old => old.id === row.id && old.status === 'pending'));
    const resolved = require('./forge-interaction').resolvePendingQuestions(history.pending_questions, answers);
    if (digest(resolved) !== digest(state.pending_questions)) fail('transition-question-history-mismatch');
  }
}
function correctedResolution(history, request) {
  const original = history.resolution;
  if (!original?.options || !original.sources || !original.policy || request.scope !== 'milestone') fail('transition-resolution-history-required');
  const before = original.options, after = clone(before);
  const expected = { milestoneId: request.milestoneId, unitId: request.taskId || request.sliceId || request.milestoneId,
    roadmapPath: request.roadmapFile || path.join(request.contextRoot, '.gsd', 'milestones', request.milestoneId, `${request.milestoneId}-ROADMAP.md`) };
  if (before.unitType !== request.unitType || path.resolve(before.cwd || '') !== path.resolve(request.contextRoot)
      || before.hostRuntime !== request.route.host_runtime || (before.planPath || null) !== (request.planFile || null)) fail('transition-resolver-identity');
  let omitted = false;
  for (const [key, value] of Object.entries(expected)) {
    if (!before[key]) { after[key] = value; omitted = true; }
    else if (before[key] !== value) fail('transition-resolver-context-conflict');
  }
  if (!omitted) fail('transition-resolver-omission-required');
  const sourceIdentity = { milestoneId: request.milestoneId, roadmapPath: request.roadmapFile, planPath: request.planFile };
  if (digest(resolver.resolutionInputs(before, sourceIdentity)) !== digest(original.sources)) fail('transition-resolver-source-drift');
  const reproduced = resolver.resolveDispatch(before);
  if (digest(resolver.resolutionPolicy(reproduced)) !== digest(original.policy)
      || digest(resolver.resolutionPolicy(request.route)) !== digest(original.policy)) fail('transition-resolver-history-mismatch');
  const effective = resolver.resolveDispatch(after);
  if (digest(resolver.resolutionInputs(before, sourceIdentity)) !== digest(original.sources)) fail('transition-resolver-source-drift');
  if (effective.reason !== 'risk-escalation:high' || effective.tier !== 'max' || effective.effort !== 'max'
      || reproduced.tier !== 'heavy' || reproduced.effort !== 'high') fail('transition-resolver-correction-not-proved');
  return { options: after, original: original.policy, effective: resolver.resolutionPolicy(effective) };
}
function live(handle) { const value = handles.get(handle); if (!value) fail('transition-live-handle-required'); return value; }
function assertLive(handle) { const value = live(handle); value.assertUnchanged(); return value; }

async function prepare(options, state, inspection) {
  const requested = options.transitions;
  if (!Array.isArray(requested) || !requested.length || requested.length > 2
      || new Set(requested.map(row => row.type)).size !== requested.length
      || requested.some(row => !TYPES.includes(row.type) || typeof row.reference !== 'string' || !row.reference)) fail('transition-type-invalid');
  const callbacks = adapters.get(options.transitionAdapter);
  if (!callbacks) fail('transition-live-adapter-required');
  const ordinary = requested.some(row => row.type === 'uninvoked-native-reservation');
  if (ordinary && (requested.length !== 1 || typeof callbacks.attestUninvoked !== 'function')) fail('transition-uninvoked-adapter-required');
  if (options.correction || options.environmentalCorrection) fail('transition-correction-conflict');
  if (typeof options.processProbe !== 'function' || inspection.process_stopped !== true) fail('transition-process-proof-required');
  const recovery = require('./forge-attempt-recovery'), request = recovery.canonicalRequest(options.request);
  if (ordinary && request.scope !== 'milestone'
      && !(request.scope === 'standalone-task' && request.unitType === 'execute-task' && request.phase === 'execute')) fail('transition-ordinary-scope-unsupported');
  const contract = roots.validateContract(options.executionContract || roots.singleContract(request.contextRoot, request.cwd),
    { owner: request.contextRoot, revalidate: true });
  const claim = options.executionAuthority?.claim || request.claim || null;
  if (request.phase === 'execute' && (!claim?.generation || claim.released || typeof options.validateExecutionAuthority !== 'function')) fail('transition-held-claim-required');
  const binding = options.recoveryAuthorization;
  if (!binding) fail('transition-standing-authority-required');
  recovery.bindRecoveryAuthorization(binding);
  const candidate = reconciliation.inspectCandidate({ ...(options.reconciliation || {}), receiptFile: options.receiptFile, request });
  // A usable signed candidate always goes through existing replay. Disposition
  // cannot suppress it, and no resolver/transition record is needed to replay.
  if (candidate.replay_eligible) return { replay: true };
  const stateHashAtStart = hashFile(options.stateFile);
  let stateHash = stateHashAtStart;
  const contractHash = digest(contract), claimHash = digest(claim), requestHash = recovery.callerRequestHash(options.request);
  const currentRoots = rootObservations(contract, claim);
  const previousRecords = (state.transitions || []).map(reference => {
    if (reference?.schema_version !== 1 || !/^[a-f0-9]{64}$/.test(reference.sha256)
        || reference.path !== `${options.stateFile}.transition-${reference.sha256}.json`) fail('transition-reference-mismatch');
    recovery.validateStateTarget(reference.path, request, contract);
    if (hashFile(reference.path) !== reference.sha256) fail('transition-record-conflict');
    const record = JSON.parse(fs.readFileSync(reference.path, 'utf8'));
    if (record.schema_version !== 1 || digest(record.types) !== digest(reference.types)
        || record.request_identity_sha256 !== digest(recovery.requestIdentity(request)) || record.request_sha256 !== requestHash
        || record.contract_sha256 !== contractHash || record.claim_sha256 !== claimHash
        || record.original_receipt_sha256 !== candidate.receipt_sha256 || record.original_candidate_sha256 !== candidate.candidate_sha256
        || record.started_at !== state.started_at || record.deadline_at !== state.deadline_at
        || record.authorization_reference !== binding.reference) fail('transition-record-binding');
    return { reference, record };
  });
  const challenge = { schema_version: 1, requested: clone(requested), request_sha256: requestHash,
    request_identity_sha256: digest(recovery.requestIdentity(request)), state_sha256: stateHash,
    contract_sha256: contractHash, claim_sha256: claimHash, started_at: state.started_at, deadline_at: state.deadline_at,
    candidate, roots: currentRoots };
  if (ordinary) {
    const reservation = state.reservations?.at(-1);
    if (!reservation || reservation.handoff_pending !== undefined || reservation.handed_off_at
        || reservation.transition_reference || state.phase !== 'reserved'
        || options.resumeReservation?.sha256 !== digest(reservation)
        || state.continuation && state.continuation.status !== 'prepared') fail('transition-ordinary-reservation-required');
    challenge.reservation_sha256 = digest(reservation);
    challenge.dispatch_id = inspection.receipt.dispatch_id;
    challenge.receipt_sha256 = inspection.receipt_sha256;
    if (!challenge.dispatch_id || challenge.dispatch_id !== request.dispatchId) fail('transition-dispatch-binding');
  }
  const assertAuthority = () => {
    binding.adapter.readStandingAuthorization(binding.reference);
    options.validateExecutionAuthority?.();
    if (options.processProbe(inspection.receipt) !== 'stopped' || hashFile(options.receiptFile) !== inspection.receipt_sha256
        || hashFile(options.stateFile) !== stateHash || recovery.callerRequestHash(options.request) !== requestHash
        || digest(options.executionAuthority?.claim || request.claim || null) !== claimHash
        || digest(roots.validateContract(contract, { revalidate: true })) !== contractHash
        || hashFile(`${options.receiptFile}.response-anchor.json`) !== candidate.anchor_sha256
        || previousRecords.some(row => hashFile(row.reference.path) !== row.reference.sha256)) fail('transition-inspection-changed');
  };
  const assertUnchanged = () => {
    assertAuthority();
    if (digest(rootObservations(contract, claim)) !== digest(currentRoots)) fail('transition-inspection-changed');
  };
  assertUnchanged();
  const attested = await callbacks.attestHistory(clone(challenge));
  assertUnchanged();
  if (!attested?.history || attested.binding_sha256 !== digest(challenge) || !attested.evidence_reference
      || !attested.provenance_reference || attested.history_sha256 !== digest(attested.history)) fail('transition-history-unproved');
  const history = clone(attested.history);
  validateHistory(history, request, state, contract, claim, candidate, attested);
  let uninvoked = null;
  if (ordinary) {
    // The host must consult retained tool-call evidence. Process absence and
    // a serialized boolean cannot establish that this reservation was unused.
    const proof = await callbacks.attestUninvoked(clone(challenge));
    assertUnchanged();
    if (proof?.binding_sha256 !== digest(challenge) || proof.native_calls !== 0
        || proof.status !== 'uninvoked' || typeof proof.evidence_reference !== 'string' || !proof.evidence_reference.trim()
        || ['dispatch_id', 'reservation_sha256', 'receipt_sha256', 'request_sha256', 'contract_sha256']
          .some(key => proof[key] !== challenge[key])) fail('transition-uninvoked-unproved');
    if (digest(history.reservations) !== digest(state.reservations)
        || digest(history.attempts) !== digest(state.attempts)) fail('transition-reservation-history-mismatch');
    uninvoked = { reservation_sha256: challenge.reservation_sha256, dispatch_id: challenge.dispatch_id,
      evidence_reference: proof.evidence_reference, native_calls: 0 };
  }
  if (previousRecords.some(row => row.record.history_sha256 !== digest(history))) fail('transition-record-binding');
  const types = requested.map(row => row.type);
  if (candidate.present) {
    if (!types.includes('saved-candidate-unreplayable')) fail('transition-saved-candidate-replay-required');
    if (!candidate.schema_valid || candidate.provenance !== 'absence-unproved' || history.broker_manifest_sha256
        || history.anchor_sha256 || attested.original_provenance !== 'absent') fail('transition-original-absence-unproved');
  } else if (types.includes('saved-candidate-unreplayable')) fail('transition-candidate-required');
  const resolution = types.includes('resolver-context-omission') ? correctedResolution(history, request) : null;
  if (history.roots?.length !== currentRoots.length) fail('transition-root-coverage-required');
  const rootEvidence = [];
  for (const row of currentRoots) {
    const before = history.roots.find(old => old.root_id === row.root_id && old.path === row.path);
    if (!before) fail('transition-root-coverage-required');
    const rootChallenge = { binding_sha256: digest(challenge), history_sha256: digest(history), before, current: row };
    const proof = await callbacks.attestRoot(clone(rootChallenge));
    assertUnchanged();
    if (proof?.binding_sha256 !== digest(rootChallenge) || !proof.evidence_reference
        || !['unchanged', 'attributed-host-only'].includes(proof.classification)
        || proof.classification === 'unchanged' && digest(before) !== digest(row)) fail('transition-root-attribution-required');
    rootEvidence.push({ root_id: row.root_id, evidence_reference: proof.evidence_reference,
      classification: proof.classification, before_sha256: digest(before), current_sha256: digest(row) });
  }
  const record = { schema_version: 1, types, references: requested.map(row => row.reference),
    authorization_reference: binding.reference,
    request_identity_sha256: challenge.request_identity_sha256, request_sha256: requestHash,
    contract_sha256: contractHash, claim_sha256: claimHash, history_sha256: digest(history),
    evidence_reference: attested.evidence_reference, provenance_reference: attested.provenance_reference,
    original_receipt_sha256: candidate.receipt_sha256, original_candidate_sha256: candidate.candidate_sha256,
    started_at: state.started_at, deadline_at: state.deadline_at, resolution, reconciliation: rootEvidence,
    ...(uninvoked ? { uninvoked } : {}),
    disposition: candidate.present ? 'unreplayable-original-provenance-absent' : null };
  const recordBytes = Buffer.from(JSON.stringify(record) + '\n'), recordHash = digest(recordBytes);
  const file = `${options.stateFile}.transition-${recordHash}.json`;
  recovery.validateStateTarget(file, request, contract);
  const reference = { schema_version: 1, path: file, sha256: recordHash, types };
  const existing = (state.transitions || []).find(row => row.sha256 === recordHash);
  if (existing && digest(existing) !== digest(reference)) fail('transition-reference-mismatch');
  const guard = reconciliation.lock({ owner: contract.owner });
  try {
    assertUnchanged();
    if (resolution) correctedResolution(history, request);
    if (fs.existsSync(file)) {
      if (hashFile(file) !== recordHash) fail('transition-record-conflict');
    } else {
      if (existing) fail('transition-record-missing');
      fs.writeFileSync(file, recordBytes, { flag: 'wx', mode: 0o600 });
    }
  } finally { guard.release(); }
  const handle = Object.freeze({ id: crypto.randomUUID() });
  handles.set(handle, { reference, resolution, rootEvidence, uninvoked, disposed: candidate.present,
    assertAuthority() {
      assertAuthority();
      if (hashFile(file) !== recordHash) fail('transition-record-conflict');
    },
    assertUnchanged() {
      assertUnchanged();
      if (hashFile(file) !== recordHash) fail('transition-record-conflict');
      if (resolution) correctedResolution(history, request);
    },
    acceptPersist(value) {
      if (digest(JSON.parse(fs.readFileSync(options.stateFile, 'utf8'))) !== digest(value)) fail('transition-state-raced');
      stateHash = hashFile(options.stateFile);
    },
    appendOwnerEvent(line) {
      return this.withLock(() => {
        const file = path.join(contract.owner, '.gsd/forge/events.jsonl');
        const before = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
        const expected = Buffer.concat([before, Buffer.from(line)]);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, line);
        // Adopt only the exact caller append, never a fresh root snapshot.
        const owner = currentRoots.find(row => row.root_id === 'owner');
        owner.protected['.gsd/forge/'] = 'directory';
        owner.protected['.gsd/forge/events.jsonl'] = digest(expected);
        assertLive(handle);
      });
    },
    withLock(callback) {
      const held = reconciliation.lock({ owner: contract.owner });
      try { assertLive(handle); return callback(); } finally { held.release(); }
    },
  });
  return { handle, reference, resolution, disposed: candidate.present };
}

// Writer observations are live capabilities, deliberately separate from repair
// transitions. Serialized adapters/handles and PID-only claims grant nothing.
const writerAdapters = new WeakMap(), writerHandles = new WeakMap();
function createWriterObservationAdapter(attestWriter) {
  if (typeof attestWriter !== 'function') fail('writer-observation-adapter-required');
  const adapter = Object.freeze({ id: crypto.randomUUID() });
  writerAdapters.set(adapter, attestWriter); return adapter;
}
async function observeStoppedWriter(adapter, options) {
  const attest = writerAdapters.get(adapter);
  if (!attest) fail('writer-observation-adapter-required');
  if (typeof options.processProbe !== 'function' || typeof options.assertUnchanged !== 'function') fail('writer-observation-live-probe-required');
  const receipt = JSON.parse(fs.readFileSync(options.receiptFile));
  const receiptHash = hashFile(options.receiptFile);
  const challenge = { schema_version: 1, nonce: crypto.randomUUID(), dispatch_id: receipt.dispatch_id,
    fingerprint: receipt.fingerprint, receipt_sha256: receiptHash,
    execution_identity_sha256: receipt.recovery_identity_sha256,
    roots_sha256: digest(options.contract), route: receipt.route };
  const previous = options.previous ? writerHandles.get(options.previous) : null;
  if (options.previous && !previous) fail('writer-observation-handle-invalid');
  if (previous && ['dispatch_id', 'fingerprint', 'execution_identity_sha256', 'roots_sha256']
    .some(key => previous.challenge[key] !== challenge[key])) fail('writer-observation-attempt-changed');
  let writerIdentity = previous?.writerIdentity();
  const assertUnchanged = () => {
    if (hashFile(options.receiptFile) !== receiptHash) fail('writer-observation-receipt-changed');
    const inspected = require('./forge-attempt-recovery').inspectReceipt(options.receiptFile, { request: options.request, processProbe: options.processProbe });
    if (inspected.process_stopped !== true) fail('writer-observation-not-stopped');
    options.assertUnchanged();
  };
  const refresh = async () => {
    assertUnchanged();
    const observed = await attest(clone(challenge));
    assertUnchanged();
    if (observed?.status !== 'stopped' || observed.binding_sha256 !== digest(challenge)
      || typeof observed.writer_identity !== 'string' || !observed.writer_identity.trim()
      || typeof observed.evidence_reference !== 'string' || !observed.evidence_reference.trim()
      || observed.dispatch_id !== challenge.dispatch_id || observed.fingerprint !== challenge.fingerprint
      || observed.receipt_sha256 !== challenge.receipt_sha256
      || observed.execution_identity_sha256 !== challenge.execution_identity_sha256
      || observed.roots_sha256 !== challenge.roots_sha256
      || (writerIdentity && writerIdentity !== observed.writer_identity)) fail('writer-observation-unproved');
    writerIdentity = observed.writer_identity;
  };
  await refresh();
  const handle = Object.freeze({ id: crypto.randomUUID() });
  writerHandles.set(handle, { assertUnchanged, refresh, challenge, writerIdentity: () => writerIdentity });
  return handle;
}
function assertWriterObservation(handle) {
  const live = writerHandles.get(handle);
  if (!live) fail('writer-observation-handle-invalid');
  live.assertUnchanged(); return live;
}

module.exports = { createWriterObservationAdapter, observeStoppedWriter, assertWriterObservation, TYPES, createTransitionAdapter, observeHistory, rootObservations, destinationKey, prepare, assertLive };
