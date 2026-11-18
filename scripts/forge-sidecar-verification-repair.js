'use strict';

// Owner-only criterion repair of a retained milestone attempt. A returned
// response is custody: it becomes eligible only after the original S0, claim,
// complete delta and protected surfaces have been independently revalidated.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const roots = require('./forge-code-roots'), execution = require('./forge-task-execution');
const records = new WeakMap(), hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code, provider_called: false }); };
function bytes(file, limit = 16 * 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) fail('verification-repair-file-invalid');
  const read = require('./forge-autonomy-sources').readBoundedStableFile(file, limit, { expectedReal: fs.realpathSync.native(file) });
  if (read.error) fail('verification-repair-file-unstable');
  return read.buffer;
}
function create(options = {}) {
  const { request, ownerReconciliation } = options;
  if (ownerReconciliation !== undefined) return require('./forge-protected-owner-activity').withOwnerReconciliation(
    ownerReconciliation, request, () => construct(options));
  return construct(options);
}
function construct({ request, bindings, reference, assertAuthority, attestStoppedWriter, readPendingQuestions } = {}) {
  if (![assertAuthority, attestStoppedWriter, readPendingQuestions].every(fn => typeof fn === 'function')
      || typeof reference !== 'string' || !reference.trim() || reference.length > 512 || /[\r\n]/.test(reference)) fail('verification-repair-live-adapter-required');
  const r = require('./forge-attempt-recovery').canonicalRequest(structuredClone(request));
  const side = require('./forge-unit-sidecar'), verify = require('./forge-verify'), runs = require('./forge-runs');
  if (r.scope !== 'milestone' || r.unitType !== 'execute-task' || !r.execution_contract
      || r.route?.worker_mode !== 'sidecar' || r.linked_begin_key || r.batch_id || r.ownerBroker) fail('verification-repair-scope-unsupported');
  side.validateRecoveryRequest(r);
  const owner = fs.realpathSync.native(r.contextRoot), contract = roots.validateContract(r.execution_contract, { owner, revalidate: true });
  const parentFile = side.artifactAttemptFiles(r).receiptFile, parentBytes = bytes(parentFile), parent = JSON.parse(parentBytes);
  const recoveryId = roots.digest(require('./forge-attempt-recovery').requestIdentity(r));
  if (!['failed', 'executed'].includes(parent.phase) || parent.dispatch_id !== r.dispatchId || parent.fingerprint !== side.artifactFingerprint(r)
      || parent.recovery_identity_sha256 !== recoveryId || !parent.before || parent.execution || parent.verification_successor) fail('verification-repair-parent-invalid');
  if (parent.retained_request) require('./forge-request-retention').assertForReceipt(r, parent);
  const baseline = parent.recovery_baseline;
  if (!baseline || baseline.schema_version !== 1 || baseline.dispatch_id !== r.dispatchId || baseline.fingerprint !== parent.fingerprint
      || roots.digest(baseline.execution_contract) !== roots.digest(contract)) fail('verification-repair-baseline-invalid');
  require('./forge-attempt-recovery').validateStateTarget(baseline.state_file, r, contract);
  const stateBytes = bytes(baseline.state_file), state = JSON.parse(stateBytes), { reconciliation, ...immutableState } = state;
  const plan = bytes(r.planFile), planText = plan.toString('utf8');
  if (reconciliation || roots.digest(immutableState) !== baseline.state_sha256 || state.attempt !== r.dispatchId
      || roots.digest(state.execution_contract) !== roots.digest(contract) || roots.key(baseline.input.path) !== roots.key(r.planFile)
      || hash(plan) !== baseline.input.sha256) fail('verification-repair-baseline-invalid');
  const identity = { dispatch_id: r.dispatchId, fingerprint: parent.fingerprint, recovery_identity_sha256: recoveryId };
  verify.assertExecutionVerification(parent.verification_seal, contract, planText, identity);
  const seal = structuredClone(parent.verification_seal), declared = structuredClone(bindings);
  const loc = side.locations(r);
  require('./forge-delivery').validateExecutionBindings(planText, contract, loc.rules[loc.delivery.input].unit, declared, seal);
  let result = parent.result, responseFile = null, responseBytes = null;
  if (parent.phase === 'failed') {
    responseFile = r.resultFile + '.returned.json'; responseBytes = bytes(responseFile);
    const response = JSON.parse(responseBytes), anchor = parent.returned_response;
    if (!anchor || anchor.version !== 1 || anchor.channel !== 'resultFile.returned.json' || anchor.sha256 !== hash(responseBytes)
        || anchor.bytes !== responseBytes.length || response.version !== 1 || response.dispatch_id !== r.dispatchId
        || response.request_fingerprint !== parent.fingerprint || response.trust !== 'transport-normalized; unit-validation-pending'
        || !['execution-protected-metadata', 'execution-verification-failed'].includes(parent.failure?.reason_code)) fail('verification-repair-response-anchor-required');
    result = response.result;
  }
  if (!require('./forge-xllm').validateExecuteResult(result) || result.status !== 'done') fail('verification-repair-result-invalid');
  execution.assertProtected(owner, baseline.protected_owner);
  if (!Array.isArray(baseline.protected_roots) || baseline.protected_roots.length !== contract.code_roots.length) fail('verification-repair-roots-invalid');
  for (const root of contract.code_roots) {
    const original = baseline.protected_roots.find(row => row.root_id === root.id && roots.key(row.path) === roots.key(root.path));
    if (!original) fail('verification-repair-roots-invalid');
    execution.assertProtected(root.path, original.snapshot);
  }
  const checked = roots.validatePlan(planText, contract);
  const verifiedFiles = execution.verifyResult(r.cwd, { execution_contract: contract, claims: checked.writes, snapshots: state.repos }, result);
  const codeState = execution.replayState(r.cwd, contract);
  if (parent.milestone_delivery && (parent.milestone_delivery.plan_sha256 !== hash(plan)
      || roots.digest(parent.milestone_delivery.code_state) !== roots.digest(codeState)
      || roots.digest(parent.milestone_delivery.verified_files) !== roots.digest(verifiedFiles))) fail('verification-repair-code-changed');
  const actor = runs.observeHostSession(r.route.host_runtime, process.env.FORGE_CLAUDE_OWNER_SESSION_ID);
  if (!actor) fail('verification-repair-owner-required');
  const inputFiles = [...new Set([r.planFile, r.contextFile, r.securityFile, r.researchFile, r.roadmapFile, r.promptFile].filter(Boolean))]
    .map(file => ({ file, sha256: hash(bytes(file)) }));
  const outputBytes = fs.existsSync(r.resultFile) ? bytes(r.resultFile) : null;
  const challenge = Object.freeze({ owner, unit: `execute-task/${r.taskId}`, dispatch_id: r.dispatchId,
    request_sha256: roots.digest(r), parent_receipt_sha256: hash(parentBytes), original_baseline_sha256: hash(stateBytes),
    retained_result_sha256: roots.digest(result), code_sha256: roots.digest(codeState), bindings_sha256: roots.digest(declared) });
  function check() {
    const currentActor = runs.observeHostSession(actor.hostRuntime, process.env.FORGE_CLAUDE_OWNER_SESSION_ID), record = runs.get(owner, r.runId || r.milestoneId);
    if (assertAuthority(structuredClone(challenge)) !== true || attestStoppedWriter(structuredClone(challenge)) !== true
        || currentActor?.sessionId !== actor.sessionId || !record?.active || record.session_id !== actor.sessionId
        || record.host_runtime !== actor.hostRuntime || roots.digest(record.write_claim) !== roots.digest(r.claim)) fail('verification-repair-authority-required');
    const pending = readPendingQuestions(structuredClone(challenge));
    if (!Array.isArray(pending) || pending.some(row => row?.status !== 'resolved')) fail('verification-repair-pending-questions');
    side.validateRecoveryRequest(r); roots.validateContract(contract, { owner, revalidate: true });
    if (!bytes(parentFile).equals(parentBytes) || !bytes(baseline.state_file).equals(stateBytes)
        || outputBytes === null && fs.existsSync(r.resultFile) || outputBytes !== null && (!fs.existsSync(r.resultFile) || !bytes(r.resultFile).equals(outputBytes))
        || responseFile && !bytes(responseFile).equals(responseBytes) || inputFiles.some(row => hash(bytes(row.file)) !== row.sha256)
        || roots.digest(execution.replayState(r.cwd, contract)) !== roots.digest(codeState)) fail('verification-repair-source-changed');
  }
  check();
  const info = { schema_version: 1, kind: 'owner-criterion-verification-repair', reference, ...challenge,
    verification_seal_sha256: seal.sha256, provider_called: false, worker_budget_unchanged: true };
  const prefix = path.join(path.dirname(r.resultFile), 'forge-verification-repair-' + crypto.randomBytes(24).toString('hex'));
  const receiptFile = prefix + '.receipt.json', resultFile = prefix + '.result.json';
  for (const file of [receiptFile, resultFile]) for (const root of [owner, ...contract.code_roots.map(row => row.path)]) require('./forge-xllm').validateResultFileTarget(file, root);
  const seed = { ...structuredClone(parent), phase: 'executed', result: structuredClone(result), verification_successor: info,
    milestone_delivery: parent.milestone_delivery || { plan_sha256: hash(plan), verified_files: verifiedFiles,
      protected_owner: baseline.protected_owner, protected_roots: baseline.protected_roots, code_state: codeState } };
  delete seed.delivery_capture;
  function assertRecord(record) {
    check();
    for (const key of ['fingerprint', 'dispatch_id', 'recovery_identity_sha256', 'verification_seal', 'verification_successor', 'result', 'before', 'milestone_delivery', 'recovery_baseline', 'route']) {
      if (roots.digest(record[key] ?? null) !== roots.digest(seed[key] ?? null)) fail('verification-repair-record-changed');
    }
  }
  const handle = Object.freeze({}); records.set(handle, { requestHash: roots.digest(r), check, assertRecord, seal, info,
    bindings: declared, receiptFile, resultFile, seed, used: false });
  return handle;
}
function read(handle, request) {
  const held = records.get(handle);
  if (!held || roots.digest(require('./forge-attempt-recovery').canonicalRequest(request)) !== held.requestHash) fail('verification-successor-capability-required');
  held.check();
  return { check: held.check, assertRecord: held.assertRecord, seal: structuredClone(held.seal), info: structuredClone(held.info),
    bindings: structuredClone(held.bindings), receiptFile: held.receiptFile, resultFile: held.resultFile,
    expectedOwner(record, expected) { held.assertRecord(record); return require('./forge-protected-owner-activity').expectedProtectedOwner(request.contextRoot, expected); },
    initialize() { held.check(); if (held.used || fs.existsSync(held.receiptFile) || fs.existsSync(held.resultFile)) fail('verification-successor-already-used');
      held.used = true; fs.writeFileSync(held.receiptFile, JSON.stringify(held.seed, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); },
  };
}
module.exports = { create, read };
