'use strict';

// Owner entry for an ordinary milestone-native attempt. Retained responses use
// the original delivery manifest/receipts, never this first-invocation entry.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const delivery = require('./forge-native-recovery-delivery');
const native = require('./forge-native-invocation');
const roots = require('./forge-code-roots');
// Only the original owner callback below can create this live witness. A saved
// digest, JSON message, selector or host observation cannot reconstruct it.
const originalCallbackWitnesses = new WeakMap();
function assertOriginalCallbackWitness(handle, { request } = {}) {
  const record = originalCallbackWitnesses.get(handle);
  const refuse = () => { throw Object.assign(new Error('native-host-original-callback-required'),
    { code: 'native-host-original-callback-required' }); };
  if (!record || !request || roots.digest(request) !== record.facts.request_sha256) refuse();
  record.assertCurrent();
  if (roots.digest(record.liveRequest) !== record.facts.request_sha256
      || roots.digest(record.arguments) !== record.facts.arguments_sha256
      || roots.digest(record.invocation) !== record.facts.invocation_sha256) refuse();
  return Object.freeze({ ...record.facts });
}
function fail(code) { throw Object.assign(new Error(code), { code, provider_called: false }); }
function prepare(options) { return delivery.prepare(options); }
const originalPublicationResults = new WeakMap();
function getPublicationWitness(actualResult, { request } = {}) {
  const entry = originalPublicationResults.get(actualResult);
  if (!entry) return delivery.getPublicationWitness(actualResult, { request });
  if (roots.digest(entry.liveRequest) !== entry.request_sha256
      || roots.digest(actualResult) !== entry.actual_sha256) throw Object.assign(new Error('native-publication-result-changed'), { code: 'native-publication-result-changed', stage: 'native-publication' });
  delivery.assertOriginalPublicationWitness(entry.witness, { request });
  return entry.witness;
}
function assertOriginalPublicationWitness(witness, options) {
  return delivery.assertOriginalPublicationWitness(witness, options);
}
function getPublicationAttemptWitness(originalPointer, options) {
  return delivery.getPublicationAttemptWitness(originalPointer, options);
}
function assertOriginalPublicationAttemptWitness(witness, options) {
  return delivery.assertOriginalPublicationAttemptWitness(witness, options);
}
function hostAdmission(options, request) {
  if (options.nativeHostAdmission === undefined) return null;
  return require('./forge-native-host-bridge').assertNativeAdmission(options.nativeHostAdmission, request);
}
function writeNativeSpool(options, request, file, bytes) {
  const admission = hostAdmission(options, request);
  if (!admission) return fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  // The canonical immutable writer admits peak bytes before wx, commits after,
  // and recognizes exact duplicate bytes without a fictitious second disk peak.
  return admission.writeImmutable('native-evidence', file, Buffer.from(bytes));
}
function invocationDiagnostic(outcome, binding, prompt) {
  const telemetry = require('./forge-attempt-telemetry');
  const lifecycle = {};
  // Closed metadata vocabulary: never copy arguments, arbitrary diagnostics,
  // provider text or normalized result content into this diagnostic channel.
  for (const field of ['schema_version', 'identity', 'phase', 'reason_code', 'sequence', 'start_wall_ms',
    'last_wall_ms', 'deadline_wall_ms', 'ceiling_ms', 'tier', 'first_remote_ms', 'last_remote_ms',
    'open_tools', 'activity', 'possible_writer', 'stopped', 'cancel_requested', 'handle_sha256', 'late_terminal',
    'journal_reference', 'persistence']) {
    const value = outcome.lifecycle?.[field];
    if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
        || value === null || typeof value === 'string' && telemetry.code(value) !== null) lifecycle[field] = value;
  }
  const host = require('./forge-agent-identity').normalizeHostIdentity(outcome.lifecycle?.host_identity);
  if (host) lifecycle.host_identity = host;
  return { schema_version: 1, kind: 'native-invocation-diagnostic', ok: outcome.ok === true,
    provider_called: typeof outcome.provider_called === 'boolean' ? outcome.provider_called : 'unknown',
    reason_code: telemetry.code(outcome.reason_code), host_runtime: telemetry.code(outcome.host_runtime),
    diagnostic: { reason_code: telemetry.code(outcome.diagnostic?.reason_code), layer: telemetry.code(outcome.diagnostic?.layer) },
    invocation: telemetry.measure(binding, 'native-binding', true), prompt: telemetry.measure(prompt, 'effective-native-prompt'),
    result: { worker_status: ['done', 'partial', 'blocked'].includes(outcome.result?.status) ? outcome.result.status : null,
      ...telemetry.measure(outcome.result, 'native-returned-result', true) },
    final_evidence: telemetry.sanitizeFinal(outcome.final_evidence), lifecycle };
}
async function run(options = {}) {
  const request = options.request;
  if (options.executionPlanGate !== undefined && request?.gates?.plan === 'skipped'
      && request.gates.planSkipReason === 'auto-defer') {
    return require('./forge-task-execution').withAutoPlanGateAdapter(options.executionPlanGate, request,
      () => runFresh(options));
  }
  return runFresh(options);
}
async function runFresh(options) {
  const { request: liveRequest, invocationOptions, invokeNative } = options;
  const request = liveRequest && structuredClone(liveRequest);
  if (!request || request.scope !== 'milestone' || request.phase !== 'execute'
      || request.unitType !== 'execute-task') fail('fresh-native-milestone-required');
  if (typeof invokeNative !== 'function' || typeof options.assertBoundary !== 'function'
      || typeof options.assertAuthority !== 'function') fail('live-native-owner-adapters-required');
  if (!invocationOptions || !invocationOptions.resolvedDispatch || !request.route
      || roots.digest(invocationOptions.resolvedDispatch) !== roots.digest(request.route)
      || invocationOptions.hostRuntime !== request.route.host_runtime) fail('fresh-native-invocation-identity');
  if (options.savedManifest || options.leaseRenewal || options.documentaryContinuation
      || options.coveragePolicy || options.supplementalCoverage || options.verificationContinuation
      || options.artifactAdvisoryReview) fail('fresh-native-continuation-not-allowed');
  for (const suffix of ['.manifest.json', '.receipt.json']) {
    if (fs.existsSync(request.resultFile + suffix)) fail('fresh-native-attempt-exists');
  }
  const preflight = native.buildNativeInvocation(invocationOptions);
  if (!preflight.ok) fail(preflight.reason_code);
  if (options.nativeInvocation && roots.digest(options.nativeInvocation) !== roots.digest(preflight))
    fail('fresh-native-binding-mismatch');
  hostAdmission(options, request);
  options.assertAuthority(); options.assertBoundary();
  require('./forge-unit-sidecar').validateRecoveryRequest(request,
    { nativeInvocation: preflight, linkedEntryOptions: options.linkedEntryOptions });
  const inputFiles = [request.planFile, request.contextFile];
  // Absence is valid only under the already validated canonical N/A gate.
  if (request.securityFile || request.gates?.security !== 'not-applicable') inputFiles.push(request.securityFile);
  const research = request.researchFile || path.join(request.contextRoot, '.gsd', 'milestones', request.milestoneId,
    'slices', request.sliceId, request.sliceId + '-RESEARCH.md');
  if (fs.existsSync(research)) inputFiles.push(research);
  const inputPins = new Map(inputFiles.map(file => [file, crypto.createHash('sha256').update(delivery.readInput(file)).digest('hex')]));
  const procedure = require('./forge-procedure-context').loadProcedureContext({ cwd: request.cwd,
    phase: 'execute-task', forgeHome: process.env.FORGE_HOME || path.resolve(__dirname, '..') });
  const packaged = delivery.packagePrompt(request, request.prompt || invocationOptions.prompt || '', { nativeInvocation: preflight,
    ...(options.nativeHostAdmission === undefined ? {} : { nativeHostAdmission: options.nativeHostAdmission }) });
  const prompt = require('./forge-prompt').composeProcedurePrompt(packaged, procedure,
    options.procedureContext || request.procedure_context);
  const effectiveInvocation = { ...invocationOptions, prompt, promptContext: prompt };
  const binding = native.buildNativeInvocation(effectiveInvocation);
  if (!binding.ok) fail(binding.reason_code);
  const session = prepare({ ...options, request, nativeInvocation: binding });
  const manifest = session.manifest();
  if (manifest.inputs.some(row => inputPins.get(row.file) !== row.sha256)) fail('fresh-native-packaged-input-changed');
  const assertUnchanged = current => {
    if (roots.digest(liveRequest) !== roots.digest(request)) fail('fresh-native-request-changed');
    options.assertAuthority(); options.assertBoundary();
    require('./forge-unit-sidecar').validateRecoveryRequest(request,
      { nativeInvocation: current, linkedEntryOptions: options.linkedEntryOptions });
    const execution = require('./forge-task-execution');
    execution.assertProtected(request.contextRoot, manifest.prepared.protected_owner);
    for (const root of manifest.prepared.protected_roots) execution.assertProtected(root.path, root.snapshot);
    if (manifest.inputs.some(row => crypto.createHash('sha256').update(delivery.readInput(row.file)).digest('hex') !== row.sha256))
      fail('fresh-native-packaged-input-changed');
  };
  const started = session.start();
  let returnedFile = null;
  const outcome = await native.invokeNative({ ...effectiveInvocation,
    ...(options.nativeHostAdmission === undefined ? {} : { nativeHostAdmission: options.nativeHostAdmission, nativeHostRequest: request }),
    terminalResult: result => delivery.resultContract.validate(result).ok
      && (hostAdmission(options, request)?.assertTerminalAdmission() ?? true)
      && (typeof invocationOptions.terminalResult !== 'function' || invocationOptions.terminalResult(result) === true),
    assertInvocation: async (stage, current) => {
      assertUnchanged(current);
      await invocationOptions.assertInvocation?.(stage, current);
    },
  }, async (...args) => {
    const [originalArguments, originalInvocation] = args;
    // This function is invoked by native.invokeNative only after its actual
    // callback-boundary admission. Bind the exact live arguments, not a caller
    // supplied reconstruction or an observation received later over the relay.
    assertUnchanged(originalInvocation);
    const witness = Object.freeze(Object.create(null));
    originalCallbackWitnesses.set(witness, {
      facts: Object.freeze({ request_sha256: roots.digest(request), dispatch_id: request.dispatchId,
        arguments_sha256: roots.digest(originalArguments), invocation_sha256: roots.digest(originalInvocation) }),
      liveRequest, arguments: originalArguments, invocation: originalInvocation,
      assertCurrent: () => assertUnchanged(originalInvocation),
    });
    const result = await invokeNative(...args, witness);
    if (delivery.resultContract.validate(result).ok) {
      // Preserve the original normalized response before post-call guards can
      // refuse it. This candidate is not a receipt or replay/publication authority.
      const candidate = JSON.stringify({ schema_version: 1, kind: 'native-returned-candidate', accepted: false,
        dispatch_id: request.dispatchId, manifest_sha256: started.manifest_sha256, result }) + '\n';
      const hash = crypto.createHash('sha256').update(candidate).digest('hex');
      returnedFile = request.resultFile + '.returned.' + hash + '.json';
      for (const root of [request.contextRoot, ...request.execution_contract.code_roots.map(row => row.path)])
        require('./forge-xllm').validateResultFileTarget(returnedFile, root);
      writeNativeSpool(options, request, returnedFile, candidate);
    }
    return result;
  });
  // Save the real host outcome even when the tool did not return a valid result.
  // This is diagnostic evidence, never a successful worker/delivery receipt.
  const bytes = JSON.stringify(invocationDiagnostic(outcome, binding, prompt)) + '\n';
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const outcomeFile = request.resultFile + '.invocation.' + hash + '.json';
  for (const root of [request.contextRoot, ...request.execution_contract.code_roots.map(row => row.path)])
    require('./forge-xllm').validateResultFileTarget(outcomeFile, root);
  try { writeNativeSpool(options, request, outcomeFile, bytes); }
  catch (error) { error.provider_called = outcome.provider_called; error.native_outcome_persistence = 'refused'; throw error; }
  if (!outcome.ok) {
    if (native.notInvokedWitness(outcome)) session.refuseNotInvoked(outcome);
    return { status: 'failed', published: false, outcome, outcome_file: outcomeFile, returned_file: returnedFile, started };
  }
  try {
    session.returned(outcome.result);
    if (outcome.result.status !== 'done')
      return { status: outcome.result.status, published: false, outcome, outcome_file: outcomeFile, returned_file: returnedFile, started };
    const verified = session.verify(outcome.result);
    const published = session.publish(outcome.result);
    const actual = { status: 'done', published: true, outcome, outcome_file: outcomeFile, returned_file: returnedFile, verified, delivery: published, started };
    const witness = delivery.getPublicationWitness(published, { request });
    originalPublicationResults.set(actual, { witness, liveRequest, request_sha256: roots.digest(request), actual_sha256: roots.digest(actual) });
    return actual;
  } catch (error) {
    // A post-tool verification/publication refusal must not erase the actual
    // invocation or misreport that the provider was never called.
    error.provider_called = outcome.provider_called;
    error.native_outcome_file = outcomeFile;
    error.native_returned_file = returnedFile;
    throw error;
  }
}
module.exports = { prepare, run, assertOriginalCallbackWitness, getPublicationWitness, assertOriginalPublicationWitness, getPublicationAttemptWitness, assertOriginalPublicationAttemptWitness };
