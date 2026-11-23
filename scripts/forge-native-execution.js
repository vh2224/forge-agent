'use strict';

// Owner entry for an ordinary milestone-native attempt. Retained responses use
// the original delivery manifest/receipts, never this first-invocation entry.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const delivery = require('./forge-native-recovery-delivery');
const native = require('./forge-native-invocation');
const roots = require('./forge-code-roots');
function fail(code) { throw Object.assign(new Error(code), { code, provider_called: false }); }
function prepare(options) { return delivery.prepare(options); }
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
  options.assertAuthority(); options.assertBoundary();
  require('./forge-unit-sidecar').validateRecoveryRequest(request,
    { nativeInvocation: preflight, linkedEntryOptions: options.linkedEntryOptions });
  const inputFiles = [request.planFile, request.contextFile, request.securityFile];
  const research = request.researchFile || path.join(request.contextRoot, '.gsd', 'milestones', request.milestoneId,
    'slices', request.sliceId, request.sliceId + '-RESEARCH.md');
  if (fs.existsSync(research)) inputFiles.push(research);
  const inputPins = new Map(inputFiles.map(file => [file, crypto.createHash('sha256').update(delivery.readInput(file)).digest('hex')]));
  const procedure = require('./forge-procedure-context').loadProcedureContext({ cwd: request.cwd,
    phase: 'execute-task', forgeHome: process.env.FORGE_HOME || path.resolve(__dirname, '..') });
  const packaged = delivery.packagePrompt(request, request.prompt || invocationOptions.prompt || '', { nativeInvocation: preflight });
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
    terminalResult: result => delivery.resultContract.validate(result).ok
      && (typeof invocationOptions.terminalResult !== 'function' || invocationOptions.terminalResult(result) === true),
    assertInvocation: async (stage, current) => {
      assertUnchanged(current);
      await invocationOptions.assertInvocation?.(stage, current);
    },
  }, async (...args) => {
    const result = await invokeNative(...args);
    if (delivery.resultContract.validate(result).ok) {
      // Preserve the original normalized response before post-call guards can
      // refuse it. This candidate is not a receipt or replay/publication authority.
      const candidate = JSON.stringify({ schema_version: 1, kind: 'native-returned-candidate', accepted: false,
        dispatch_id: request.dispatchId, manifest_sha256: started.manifest_sha256, result }) + '\n';
      const hash = crypto.createHash('sha256').update(candidate).digest('hex');
      returnedFile = request.resultFile + '.returned.' + hash + '.json';
      for (const root of [request.contextRoot, ...request.execution_contract.code_roots.map(row => row.path)])
        require('./forge-xllm').validateResultFileTarget(returnedFile, root);
      fs.writeFileSync(returnedFile, candidate, { flag: 'wx', mode: 0o600 });
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
  fs.writeFileSync(outcomeFile, bytes, { flag: 'wx', mode: 0o600 });
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
    return { status: 'done', published: true, outcome, outcome_file: outcomeFile, returned_file: returnedFile, verified, delivery: published, started };
  } catch (error) {
    // A post-tool verification/publication refusal must not erase the actual
    // invocation or misreport that the provider was never called.
    error.provider_called = outcome.provider_called;
    error.native_outcome_file = outcomeFile;
    error.native_returned_file = returnedFile;
    throw error;
  }
}
module.exports = { prepare, run };
