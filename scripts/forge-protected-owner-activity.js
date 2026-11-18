'use strict';

// A live, single-unit owner boundary. It is not a filesystem sandbox and never
// treats a saved JSON record as authority to advance a protected snapshot.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { spawn, ChildProcess } = require('child_process');
const roots = require('./forge-code-roots');
const lease = require('./forge-unit-lease');
const windows = require('./forge-owner-transport-window');
const contexts = new AsyncLocalStorage();
const preflightRefusals = new AsyncLocalStorage();
const scopes = new WeakSet();
const reconciliations = new WeakMap();
const reconciliationContext = new AsyncLocalStorage();
const handoffs = new AsyncLocalStorage();
const attemptResumes = new WeakMap();
const ownerTransfers = new WeakMap();
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fail(code) { throw Object.assign(new Error(code), { code }); }
function currentScope() { return contexts.getStore() || null; }
function assertPreflightAdmission() {
  const refusal = preflightRefusals.getStore();
  if (refusal) throw refusal;
}
function regular(file, limit = 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) fail('protected-owner-source-invalid');
  const read = require('./forge-autonomy-sources').readBoundedStableFile(file, limit,
    { expectedReal: fs.realpathSync.native(file) });
  if (read.error) fail('protected-owner-source-unstable');
  return read.buffer;
}
function gone(child) {
  if (!(child instanceof ChildProcess)) return false;
  if (!child.pid) return false;
  if (child.exitCode === null && child.signalCode === null) return false;
  try { process.kill(child.pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}
async function waitForExit(child, deadline) {
  while (!gone(child)) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return true;
}

async function withExecutionActivity(request, runtime, action) {
  const r = request || {};
  if (r.scope !== 'milestone' || r.unitType !== 'execute-task' || !r.execution_contract
      || r.ownerBroker || r.memberHandle !== undefined || r.route?.worker_mode === 'native'
      || fs.existsSync(`${r.resultFile}.receipt.json`)) return action(runtime);
  const owner = fs.realpathSync.native(r.contextRoot || r.cwd), unit = `execute-task/${r.taskId}`;
  // A known time refusal must reach the existing owner receipt path without
  // opening/renewing a writer lease or requiring writer identity. Carry the
  // exact canonical refusal privately, so a changing clock cannot turn this
  // diagnostic-only branch into an uncoordinated provider launch.
  try {
    require('./forge-milestone-time-admission').assertTransportEntry({ cwd: owner,
      milestone: r.milestoneId, unit, now: runtime.now });
  } catch (error) {
    if (error?.provider_called !== false || error.stage !== 'milestone-time-admission'
        || !require('./forge-milestone-time-admission').TRANSPORT_REFUSAL_CODES.includes(error.code)) throw error;
    return preflightRefusals.run(error, () => action(runtime));
  }
  const leaseFile = lease.leaseFile(owner, unit), observed = lease.readLease(leaseFile);
  // Old adapter fixtures/legacy callers may execute without a controller begin.
  // They gain no lease exception or owner capability through this branch.
  if (!observed.record && !observed.corrupt) return action(runtime);
  if (!lease.validRecord(observed.record, unit)) fail('protected-owner-lease-invalid');
  const initialBytes = regular(leaseFile);
  if (roots.digest(JSON.parse(initialBytes)) !== roots.digest(observed.record)) fail('protected-owner-source-unstable');
  require('./forge-unit-sidecar').validateRecoveryRequest(r, { verification: runtime.verification });
  const original = observed.record, controller = require('./forge-unit-controller');
  const begin = controller.lookupRecord(owner, 'transaction', original.request_id);
  const token = original.owner_token, generation = original.generation;
  if (!begin || begin.action !== 'begin' || begin.phase !== 'committed' || begin.unit?.key !== unit
      || begin.milestone !== r.milestoneId || begin.lease_generation !== generation
      || begin.owner_digest !== `sha256:${sha(token)}` || begin.host_runtime !== original.host_runtime) fail('protected-owner-begin-mismatch');
  const runs = require('./forge-runs'), runId = r.runId || r.milestoneId;
  const actor = runs.observeHostSession(r.route?.host_runtime, process.env.FORGE_CLAUDE_OWNER_SESSION_ID);
  const run = runs.get(owner, runId);
  if (!actor || !run?.active || run.session_id !== actor.sessionId || run.host_runtime !== actor.hostRuntime) fail('protected-owner-session-required');
  const planHash = sha(regular(r.planFile)), claimHash = roots.digest(run.write_claim);
  const timeout = require('./forge-worker-timeout');
  const duration = timeout.protectedWindowMs(timeout.ceilingFromRoute(r.route).ms);
  if (!duration.covers) fail('protected-owner-window-ceiling-unsupported');
  let leaseWindow, ownerWindow, expectedLease, closed = false, spawnAttempted = false;
  let child = null, failedSpawn = null, childClosed = false, join = null;
  const knownLeaseHashes = new Set();
  const relative = path.relative(owner, leaseFile).replace(/\\/g, '/');
  const requestHash = roots.digest({ owner, run: runId, unit, generation, dispatch: r.dispatchId,
    workflow: r.workflowId, contract: r.execution_contract, plan: planHash, claim: claimHash });
  function assertLive() {
    if (closed || !leaseWindow?.heartbeat().ok || sha(regular(leaseFile)) !== expectedLease) fail('protected-owner-lease-changed');
    windows.withWindow(ownerWindow, () => {});
    const current = runs.get(owner, runId);
    if (!current?.active || current.session_id !== actor.sessionId || current.host_runtime !== actor.hostRuntime
        || roots.digest(current.write_claim) !== claimHash || sha(regular(r.planFile)) !== planHash) fail('protected-owner-authority-changed');
    roots.validateContract(r.execution_contract, { owner, revalidate: true });
  }
  windows.withMutation(owner, () => {
    leaseWindow = lease.openProtectedWindow(owner, unit, token, generation,
      { durationMs: duration.duration_ms, reuseExisting: true });
    if (!leaseWindow.ok) fail('protected-owner-lease-window-refused');
    expectedLease = sha(regular(leaseFile)); knownLeaseHashes.add(expectedLease);
    try {
      ownerWindow = windows.open(owner, { kind: 'unit-execution', task_id: runId,
        dispatch_id: r.dispatchId, request_sha256: requestHash, unit_key: unit,
        lease_generation: generation, owner_token_sha256: sha(token), lease_deadline_at: leaseWindow.deadline_at });
    } catch (error) { leaseWindow.close(); throw error; }
  });
  const scope = Object.freeze({
    owner, unit, generation,
    spawn(command, args, options) {
      assertLive();
      if (spawnAttempted) fail('protected-owner-writer-exists');
      spawnAttempted = true;
      try { child = spawn(command, args, options); }
      catch (error) { failedSpawn = ['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code) ? error.code : null; throw error; }
      child.once('error', error => { if (!child.pid && ['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code)) failedSpawn = error.code; });
      child.once('close', () => { childClosed = true; });
      return child;
    },
    async joinWriter() {
      if (join) return join;
      if (!spawnAttempted) return (join = Object.freeze({ joined: true, possible_writers: 0, reason: 'before-provider-spawn' }));
      if (!child) {
        if (!failedSpawn) fail('protected-owner-writer-unproven');
        return (join = Object.freeze({ joined: true, possible_writers: 0, reason: failedSpawn }));
      }
      if (!child.pid) {
        const until = Date.now() + 15000;
        while (!childClosed && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
        if (!childClosed || !failedSpawn) fail('protected-owner-writer-unproven');
      } else if (!await waitForExit(child, Date.now() + 15000)) {
        require('./forge-xllm').terminateOwnedProcessTree(child);
        if (!await waitForExit(child, Date.now() + 10000)) fail('protected-owner-writer-unproven');
      }
      return (join = Object.freeze({ joined: true, possible_writers: 0, pid: child.pid || null }));
    },
    verificationWindow(seal) {
      if (!join?.joined) fail('protected-owner-writer-unproven');
      assertLive();
      const commands = Array.isArray(seal?.roots) ? seal.roots.reduce((sum, root) => sum + (root.commands?.length || 0), 0) : 0;
      const commandMs = seal?.command_timeout_ms;
      if (!Number.isSafeInteger(commandMs) || commandMs <= 0) fail('protected-owner-verification-window-invalid');
      const wanted = timeout.protectedWindowMs(Math.max(1, commands) * commandMs);
      if (!wanted.covers) fail('protected-owner-verification-window-limit');
      if (leaseWindow.borrowed) {
        if (leaseWindow.deadline_at - Date.now() < wanted.duration_ms) fail('protected-owner-verification-window-limit');
        return;
      }
      leaseWindow.close();
      leaseWindow = lease.openProtectedWindow(owner, unit, token, generation, { durationMs: wanted.duration_ms });
      if (!leaseWindow.ok) fail('protected-owner-lease-window-refused');
      expectedLease = sha(regular(leaseFile)); knownLeaseHashes.add(expectedLease);
    },
    expectedOwner(root, before) {
      if (roots.key(fs.realpathSync.native(root)) !== roots.key(owner)) return before;
      if (!before || !knownLeaseHashes.has(before[relative])) fail('protected-owner-baseline-unbound');
      assertLive();
      return { ...before, [relative]: expectedLease };
    },
  });
  scopes.add(scope);
  let value, failure;
  try { value = await windows.withWindow(ownerWindow, () => contexts.run(scope, () => action(runtime))); }
  catch (error) { failure = error; }
  try {
    await scope.joinWriter();
    // Closing the coordination boundary does not renew/revive an expired lease.
    windows.close(ownerWindow, challenge => ({ challenge_sha256: roots.digest(challenge),
      joined: true, possible_writers: 0, reference: `unit-execution:${r.dispatchId}:actual-spawn-join` }));
    leaseWindow.close(); closed = true; scopes.delete(scope);
  } catch (error) {
    if (failure) { failure.owner_window = { status: 'held', reason_code: error.code || 'protected-owner-writer-unproven' }; }
    else failure = error;
  }
  if (failure) throw failure;
  return value;
}

function expectedProtectedOwner(root, before) {
  const reconciliation = reconciliationContext.getStore();
  if (reconciliation) before = reconciliation.project(root, before);
  const scope = currentScope();
  return scope && scopes.has(scope) ? scope.expectedOwner(root, before) : before;
}

function hookAppendProof(owner, change, evidence, unit, dispatch) {
  const prior = evidence?.originalBytes?.[change.path];
  if (!Buffer.isBuffer(prior) || typeof evidence?.attestAppend !== 'function'
      || !/^\.gsd\/forge\/evidence[-~][A-Za-z0-9_.~-]+\.jsonl$/.test(change.path)
      || (change.before === null ? prior.length !== 0 : sha(prior) !== change.before)) fail('owner-reconciliation-hook-proof-required');
  if (change.before === null && change.after === null) return { path: change.path, before: null, original_sha256: sha(prior) };
  const current = regular(path.join(owner, change.path));
  if (sha(current) !== change.after || current.length < prior.length || !current.subarray(0, prior.length).equals(prior)) fail('owner-reconciliation-append-invalid');
  if (current.equals(prior)) return { path: change.path, before: change.before, original_sha256: sha(prior) };
  if (current.at(-1) !== 10) fail('owner-reconciliation-append-invalid');
  const suffix = current.subarray(prior.length);
  if (suffix.length > 65536) fail('owner-reconciliation-delta-limit');
  const lines = suffix.toString('utf8').trimEnd().split('\n');
  if (lines.length > 128) fail('owner-reconciliation-delta-limit');
  for (const line of lines) { try { JSON.parse(line); } catch { fail('owner-reconciliation-append-invalid'); } }
  const challenge = Object.freeze({ owner, unit, dispatch_id: dispatch, ...change, original_sha256: sha(prior), appended_sha256: sha(suffix), rows: lines.length });
  const observed = evidence.attestAppend(challenge);
  if (observed?.observed !== true || typeof observed.reference !== 'string' || !observed.reference.trim()
      || observed.reference.length > 512 || /[\r\n]/.test(observed.reference)) fail('owner-reconciliation-hook-proof-required');
  return { path: change.path, before: change.before, original_sha256: sha(prior) };
}
function reconciliationView(request, operatorDecision, options = {}) {
  const sidecar = require('./forge-unit-sidecar'), r = require('./forge-attempt-recovery').canonicalRequest(request);
  if (r.scope !== 'milestone' || r.unitType !== 'execute-task' || !r.execution_contract) fail('owner-reconciliation-scope-invalid');
  const owner = fs.realpathSync.native(r.contextRoot), contract = roots.validateContract(r.execution_contract, { owner, revalidate: true });
  const receiptFile = sidecar.artifactAttemptFiles(r).receiptFile, receiptBytes = regular(receiptFile, 8 * 1024 * 1024);
  const receipt = JSON.parse(receiptBytes), baseline = receipt.recovery_baseline;
  if (!baseline || baseline.schema_version !== 1 || !['failed', 'executed', 'ready'].includes(receipt.phase)
      || receipt.dispatch_id !== r.dispatchId || receipt.fingerprint !== sidecar.artifactFingerprint(r)
      || baseline.dispatch_id !== r.dispatchId || baseline.fingerprint !== receipt.fingerprint
      || roots.digest(baseline.execution_contract) !== roots.digest(contract)) fail('owner-reconciliation-parent-invalid');
  const stateBytes = regular(baseline.state_file, 16 * 1024 * 1024), state = JSON.parse(stateBytes);
  const { reconciliation: ignored, ...immutableState } = state;
  if (roots.digest(immutableState) !== baseline.state_sha256 || state.attempt !== r.dispatchId
      || roots.digest(state.execution_contract) !== roots.digest(contract)
      || roots.key(baseline.input.path) !== roots.key(r.planFile) || sha(regular(r.planFile)) !== baseline.input.sha256) fail('owner-reconciliation-baseline-invalid');
  const execution = require('./forge-task-execution'), current = execution.protectedSnapshot(owner);
  const before = baseline.protected_owner;
  if (!before || typeof before !== 'object') fail('owner-reconciliation-baseline-invalid');
  const carriers = new Set(operatorDecision ? [`.gsd/forge/questions/${operatorDecision}.json`, `.gsd/forge/questions/${operatorDecision}.origin.json`] : []);
  const changes = [...new Set([...Object.keys(before), ...Object.keys(current)])].sort()
    .filter(file => before[file] !== current[file]).map(file => ({ path: file, before: before[file] ?? null, after: current[file] ?? null }));
  const hooks = Object.keys(options.hookEvidence?.originalBytes || {}).sort().map(file => hookAppendProof(owner,
    { path: file, before: before[file] ?? null, after: current[file] ?? null }, options.hookEvidence, `execute-task/${r.taskId}`, r.dispatchId));
  const hookPaths = new Set(hooks.map(row => row.path));
  const reviewed = changes.filter(row => !carriers.has(row.path) && !(operatorDecision && row.path === '.gsd/forge/questions/') && !hookPaths.has(row.path));
  if (changes.length > 64) fail('owner-reconciliation-delta-limit');
  const deltaSha = roots.digest({ owner, unit: `execute-task/${r.taskId}`, dispatch_id: r.dispatchId, changes: reviewed,
    ...(hooks.length ? { hook_baselines: hooks } : {}) });
  return { r, owner, contract, receiptFile, receiptBytes, receipt, baseline, stateBytes, current, before, changes, reviewed, carriers, deltaSha };
}
function reconciliationDecision(request, operatorDecision, options = {}) {
  const view = reconciliationView(request, operatorDecision, options), r = view.r;
  return { cwd: view.owner, unit: `execute-task/${r.taskId}`, milestone: r.milestoneId,
    slice: r.sliceId, task: r.taskId, workflow_id: r.milestoneId, decision_set: `owner-delta/${view.deltaSha}`,
    questions: [{ id: 'owner-delta-approval', question: `Autorizar somente os deltas de metadados revisados ${view.deltaSha} para ${r.milestoneId}/${r.taskId}? Nenhum plano, claim ou código será aceito como alterado.` }],
    delta_sha256: view.deltaSha, changes: view.reviewed };
}

// Private, live exception for this one original open begin. The generic resume
// API cannot acquire this authority from serialized scope or an expired clock.
function inspectAttemptResume(owner, record, handle) {
  const prepared = attemptResumes.get(handle);
  if (!prepared || roots.key(owner) !== roots.key(prepared.owner) || record.id !== prepared.runId) fail('owner-reconciliation-resume-capability-required');
  prepared.check(record);
  return structuredClone(prepared.scope);
}
function resumeAttemptOwner(options = {}) {
  const { request, assertAuthority, attestStoppedWriter, readPendingQuestions } = options;
  if (![assertAuthority, attestStoppedWriter, readPendingQuestions].every(fn => typeof fn === 'function')) fail('owner-reconciliation-live-adapter-required');
  const view = reconciliationView(request), r = view.r, runId = r.runId || r.milestoneId, unit = `execute-task/${r.taskId}`;
  const runs = require('./forge-runs'), controller = require('./forge-unit-controller');
  const actor = runs.observeHostSession(options.hostRuntime, options.expectedSession);
  if (!actor) fail('owner-reconciliation-observed-owner-required');
  const recordPath = `.gsd/forge/runs/${runId}.json`, beforeBytes = regular(path.join(view.owner, recordPath));
  const before = runs.get(view.owner, runId), leaseBytes = regular(lease.leaseFile(view.owner, unit)), held = JSON.parse(leaseBytes);
  const begin = controller.lookupRecord(view.owner, 'transaction', held.request_id);
  if (view.receipt.phase !== 'failed' && view.receipt.phase !== 'executed' || !runs.knownResumeBinding(before)
      || before.active !== false || before.worker || before.worker_started || !lease.validRecord(held, unit)
      || actor.hostRuntime !== held.host_runtime || before.host_runtime !== held.host_runtime || r.route?.host_runtime !== held.host_runtime
      || roots.digest(before.write_claim) !== roots.digest(r.claim) || !begin || begin.action !== 'begin' || begin.phase !== 'committed'
      || begin.milestone !== r.milestoneId || begin.unit?.key !== unit || begin.lease_generation !== held.generation
      || begin.owner_digest !== `sha256:${sha(held.owner_token)}`
      || view.before[path.relative(view.owner, controller.transactionFile(view.owner, held.request_id)).replace(/\\/g, '/')] !== sha(regular(controller.transactionFile(view.owner, held.request_id)))
      || !controller.incompleteUnits(view.owner, runId).some(row => row.idempotency_key === held.request_id && row.action === 'begin')) fail('owner-reconciliation-resume-scope-invalid');
  const challenge = Object.freeze({ owner: view.owner, run_id: runId, unit, dispatch_id: r.dispatchId,
    request_sha256: roots.digest(r), receipt_sha256: sha(view.receiptBytes), original_owner_record_sha256: sha(beforeBytes),
    current_session_sha256: sha(actor.sessionId), roots: view.contract.code_roots.map(row => ({ id: row.id, identity_sha256: row.identity_sha256 })) });
  const code = view.contract.code_roots.map(root => ({ path: root.path, code: require('./forge-task-execution').replayState(root.path), protected: require('./forge-task-execution').protectedSnapshot(root.path) }));
  const check = record => {
    const liveActor = runs.observeHostSession(actor.hostRuntime, actor.sessionId);
    if (liveActor?.sessionId !== actor.sessionId || liveActor?.source !== actor.source
        || assertAuthority(structuredClone(challenge)) !== true || attestStoppedWriter(structuredClone(challenge)) !== true) fail('owner-reconciliation-authority-required');
    const pending = readPendingQuestions(structuredClone(challenge));
    if (!Array.isArray(pending) || pending.some(row => row?.status !== 'resolved')) fail('owner-reconciliation-pending-questions');
    if (roots.digest(record) !== roots.digest(before) || sha(regular(path.join(view.owner, recordPath))) !== sha(beforeBytes)
        || !regular(view.receiptFile, 8 * 1024 * 1024).equals(view.receiptBytes)
        || !regular(view.baseline.state_file, 16 * 1024 * 1024).equals(view.stateBytes)
        || sha(regular(r.planFile)) !== view.baseline.input.sha256
        || !regular(lease.leaseFile(view.owner, unit)).equals(leaseBytes)) fail('owner-reconciliation-resume-source-changed');
    roots.validateContract(view.contract, { owner: view.owner, revalidate: true });
    for (const row of code) if (roots.digest(require('./forge-task-execution').replayState(row.path)) !== roots.digest(row.code)
        || roots.digest(require('./forge-task-execution').protectedSnapshot(row.path)) !== roots.digest(row.protected)) fail('owner-reconciliation-root-changed');
  };
  const scope = { kind: 'attempt-recovery', milestone: runId, unit, begin_key: begin.idempotency_key,
    repair_generation: held.generation, repair_owner_digest: begin.owner_digest, host_runtime: held.host_runtime,
    request_sha256: roots.digest(r), parent_receipt_sha256: sha(view.receiptBytes) };
  const handle = Object.freeze({}); attemptResumes.set(handle, { owner: view.owner, runId, check, scope });
  let resumed;
  try { resumed = runs.resumeOwner(view.owner, runId, { hostRuntime: actor.hostRuntime, expectedSession: actor.sessionId,
    expectedRecordSha256: options.expectedRecordSha256, confirmOwnerStopped: options.confirmOwnerStopped,
    confirmWorkspaceQuiescent: options.confirmWorkspaceQuiescent, attemptRecovery: handle }); }
  finally { attemptResumes.delete(handle); }
  const afterBytes = regular(path.join(view.owner, recordPath));
  const transfer = Object.freeze({}); ownerTransfers.set(transfer, { requestHash: roots.digest(r), recordPath, beforeBytes, afterBytes });
  return Object.freeze({ status: resumed.status, ownerTransfer: transfer, scope: structuredClone(scope) });
}
function createOwnerReconciliation(options = {}) {
  const { request, assertAuthority, attestStoppedWriter, readPendingQuestions, attestChanges } = options;
  if ([assertAuthority, attestStoppedWriter, readPendingQuestions, attestChanges].some(fn => typeof fn !== 'function')) fail('owner-reconciliation-live-adapter-required');
  const view = reconciliationView(request, options.operatorDecision, options), r = view.r, unit = `execute-task/${r.taskId}`;
  const leasePath = path.relative(view.owner, lease.leaseFile(view.owner, unit)).replace(/\\/g, '/');
  const runs = require('./forge-runs'), actor = runs.observeHostSession(options.hostRuntime || r.route?.host_runtime, process.env.FORGE_CLAUDE_OWNER_SESSION_ID);
  const record = runs.get(view.owner, r.runId || r.milestoneId);
  if (!actor || !record?.active || record.session_id !== actor.sessionId || record.host_runtime !== actor.hostRuntime
      || roots.digest(record.write_claim) !== roots.digest(r.claim)) fail('owner-reconciliation-owner-mismatch');
  const challenge = Object.freeze({ owner: view.owner, unit, dispatch_id: r.dispatchId,
    request_sha256: roots.digest(r), receipt_sha256: sha(view.receiptBytes), baseline_sha256: roots.digest(view.baseline),
    delta_sha256: view.deltaSha, changes: structuredClone(view.changes) });
  let stateHash = sha(view.stateBytes);
  function live(acceptReset = false) {
    if (assertAuthority(structuredClone(challenge)) !== true || attestStoppedWriter(structuredClone(challenge)) !== true) fail('owner-reconciliation-authority-required');
    const pending = readPendingQuestions(structuredClone(challenge));
    if (!Array.isArray(pending) || pending.some(q => q?.status !== 'resolved')) fail('owner-reconciliation-pending-questions');
    const current = runs.get(view.owner, r.runId || r.milestoneId), currentActor = runs.observeHostSession(actor.hostRuntime, process.env.FORGE_CLAUDE_OWNER_SESSION_ID);
    if (!current?.active || current.session_id !== actor.sessionId || currentActor?.sessionId !== actor.sessionId
        || roots.digest(current.write_claim) !== roots.digest(r.claim) || sha(regular(r.planFile)) !== view.baseline.input.sha256) fail('owner-reconciliation-authority-changed');
    roots.validateContract(view.contract, { owner: view.owner, revalidate: true });
    const receipt = regular(view.receiptFile, 8 * 1024 * 1024);
    if (!receipt.equals(view.receiptBytes)) fail('owner-reconciliation-parent-changed');
    const stateBytes = regular(view.baseline.state_file, 16 * 1024 * 1024);
    if (sha(stateBytes) !== stateHash) {
      const { reconciliation: ignored, ...immutableState } = JSON.parse(stateBytes);
      if (!acceptReset || roots.digest(immutableState) !== view.baseline.state_sha256) fail('owner-reconciliation-parent-changed');
      stateHash = sha(stateBytes);
    }
  }
  live();
  let operatorApproved = false;
  if (options.operatorDecision !== undefined) {
    const expected = reconciliationDecision(request, options.operatorDecision, options), answer = require('./forge-pending-questions').continuation({ cwd: view.owner, identity: options.operatorDecision });
    const identity = answer.identity;
    const q = answer.questions?.find(row => row.id === expected.questions[0].id);
    if (!answer.ok || identity?.origin !== 'owner' || identity.unit !== unit || identity.milestone !== r.milestoneId
        || identity.slice !== r.sliceId || identity.task !== r.taskId || identity.decision_set !== expected.decision_set
        || !q || q.question !== expected.questions[0].question || !['aprovar', 'aprovado', 'sim', 'autorizar'].includes(q.answer?.trim().toLowerCase())) fail('owner-reconciliation-operator-decision-required');
    operatorApproved = true;
  }
  const classified = attestChanges(structuredClone(challenge));
  if (!classified || classified.then || classified.challenge_sha256 !== roots.digest(challenge)
      || !Array.isArray(classified.changes) || classified.changes.length !== view.changes.length) fail('owner-reconciliation-delta-attestation-required');
  const approved = new Map();
  const canonical = file => file === `.gsd/forge/runs/${r.runId || r.milestoneId}.json` || file === '.gsd/forge/auto-mode.json'
    || file === '.gsd/STATE.md' || file === `.gsd/milestones/${r.milestoneId}/${r.milestoneId}-STATE.md`
    || file === `.gsd/forge/time/${r.milestoneId}/journal.jsonl`;
  for (const change of view.changes) {
    const rows = classified.changes.filter(row => row?.path === change.path), row = rows[0];
    if (rows.length !== 1 || row.before !== change.before || row.after !== change.after || typeof row.reference !== 'string'
        || !row.reference.trim() || row.reference.length > 512 || /[\r\n]/.test(row.reference)) fail('owner-reconciliation-delta-attestation-required');
    if (change.after === null) fail('owner-reconciliation-deletion-refused');
    if (change.path === leasePath) {
      const currentLease = JSON.parse(regular(path.join(view.owner, leasePath)));
      const controller = require('./forge-unit-controller');
      const begin = controller.lookupRecord(view.owner, 'transaction', currentLease.request_id);
      if (!lease.validRecord(currentLease, unit) || !begin || begin.action !== 'begin' || begin.phase !== 'committed'
          || begin.unit?.key !== unit || begin.milestone !== r.milestoneId || begin.lease_generation !== currentLease.generation
          || begin.owner_digest !== `sha256:${sha(currentLease.owner_token)}`) fail('owner-reconciliation-lease-scope-invalid');
      const beginFile = controller.transactionFile(view.owner, currentLease.request_id);
      const beginRelative = path.relative(view.owner, beginFile).replace(/\\/g, '/');
      if (view.before[beginRelative] !== sha(regular(beginFile))
          || !controller.incompleteUnits(view.owner, r.milestoneId).some(row => row.action === 'begin'
            && row.idempotency_key === begin.idempotency_key && row.lease_generation === begin.lease_generation)) fail('owner-reconciliation-lease-scope-invalid');
    }
    const isDecision = view.carriers.has(change.path) || options.operatorDecision && change.path === '.gsd/forge/questions/';
    if (isDecision) { if (!operatorApproved || row.kind !== 'decision-record') fail('owner-reconciliation-operator-decision-required'); }
    else if (row.kind === 'operator-reviewed') {
      const note = /^\.gsd\/(?:HANDOFF[-A-Za-z0-9_.]*\.md|sessions\/[A-Za-z0-9_.-]+\.md)$/.test(change.path);
      if (!operatorApproved || !note && !canonical(change.path) && change.path !== leasePath
          && !/^\.gsd\/forge\/evidence[-~][A-Za-z0-9_.~-]+\.jsonl$/.test(change.path)) fail('owner-reconciliation-operator-decision-required');
    } else {
      const prior = options.originalBytes?.[change.path];
      if (!Buffer.isBuffer(prior) || change.before !== null && sha(prior) !== change.before
          || change.before === null && prior.length) fail('owner-reconciliation-before-bytes-required');
      const current = regular(path.join(view.owner, change.path));
      if (row.kind === 'same-unit-lease-clock') {
        if (change.path !== leasePath) fail('owner-reconciliation-lease-scope-invalid');
        const old = JSON.parse(prior), next = JSON.parse(current), immutable = value => Object.fromEntries(Object.entries(value).filter(([key]) => !['heartbeat_at', 'expires_at'].includes(key)));
        if (!lease.validRecord(old, unit) || !lease.validRecord(next, unit) || roots.digest(immutable(old)) !== roots.digest(immutable(next))
            || next.heartbeat_at < old.heartbeat_at || next.expires_at < old.expires_at) fail('owner-reconciliation-lease-scope-invalid');
      } else if (row.kind === 'hook-append') {
        if (!/^\.gsd\/forge\/evidence[-~][A-Za-z0-9_.~-]+\.jsonl$/.test(change.path)
            || current.length < prior.length || !current.subarray(0, prior.length).equals(prior) || current.at(-1) !== 10) fail('owner-reconciliation-append-invalid');
        const suffix = current.subarray(prior.length).toString('utf8').trimEnd().split('\n');
        if (suffix.length > 128) fail('owner-reconciliation-delta-limit');
        for (const line of suffix) { try { JSON.parse(line); } catch { fail('owner-reconciliation-append-invalid'); } }
      } else if (row.kind === 'canonical-owner-transfer') {
        const proof = ownerTransfers.get(options.ownerTransfer);
        if (!proof || proof.requestHash !== roots.digest(r) || proof.recordPath !== change.path || !current.equals(proof.afterBytes)) fail('owner-reconciliation-transfer-proof-required');
        const original = JSON.parse(prior), previous = JSON.parse(proof.beforeBytes);
        const immutable = value => Object.fromEntries(Object.entries(value).filter(([key]) => !['active', 'last_heartbeat', 'heartbeat', 'updated_at', 'ended_at', 'worker', 'worker_started'].includes(key)));
        if (roots.digest(immutable(original)) !== roots.digest(immutable(previous))) fail('owner-reconciliation-transfer-proof-required');
      } else if (row.kind === 'canonical-stop') {
        if (!canonical(change.path)) fail('owner-reconciliation-stop-scope-invalid');
        if (change.path.startsWith('.gsd/forge/runs/')) {
          const old = JSON.parse(prior), next = JSON.parse(current), immutable = value => Object.fromEntries(Object.entries(value).filter(([key]) => !['active', 'last_heartbeat', 'heartbeat', 'updated_at', 'ended_at', 'worker', 'worker_started'].includes(key)));
          if (roots.digest(immutable(old)) !== roots.digest(immutable(next)) || next.worker || next.worker_started) fail('owner-reconciliation-stop-scope-invalid');
        }
      } else fail('owner-reconciliation-change-kind-invalid');
    }
    const candidates = [view.baseline.protected_owner, view.receipt.execution?.protected_owner, view.receipt.milestone_delivery?.protected_owner].filter(Boolean);
    approved.set(change.path, { ...change, values: new Set(candidates.map(snapshot => snapshot[change.path] ?? null).concat(change.after)) });
  }
  const execution = require('./forge-task-execution');
  const originalRootRows = view.baseline.protected_roots;
  if (!Array.isArray(originalRootRows) || originalRootRows.length !== view.contract.code_roots.length) fail('owner-reconciliation-roots-missing');
  let observedRoots = view.contract.code_roots.filter(root => roots.key(root.path) !== roots.key(view.owner)).map(root => {
    const baseline = originalRootRows.find(row => row.root_id === root.id && roots.key(row.path) === roots.key(root.path));
    if (!baseline) fail('owner-reconciliation-roots-missing');
    execution.assertProtected(root.path, baseline.snapshot);
    return { path: root.path, protected: execution.protectedSnapshot(root.path), code: execution.replayState(root.path) };
  });
  function assertCurrent() {
    live();
    const current = execution.protectedSnapshot(view.owner);
    if (roots.digest(current) !== roots.digest(view.current)) fail('owner-reconciliation-observation-changed');
    for (const row of observedRoots) if (roots.digest(execution.protectedSnapshot(row.path)) !== roots.digest(row.protected)
        || roots.digest(execution.replayState(row.path)) !== roots.digest(row.code)) fail('owner-reconciliation-root-changed');
  }
  const entry = { requestHash: roots.digest(view.r), view, challenge, live, assertCurrent, active: false, consumed: false,
    project(root, before) {
      if (!entry.active) fail('owner-reconciliation-operation-inactive');
      if (roots.key(fs.realpathSync.native(root)) !== roots.key(view.owner)) return before;
      live(); const expected = { ...before };
      for (const [file, row] of approved) {
        if (!row.values.has(before[file] ?? null)) fail('owner-reconciliation-baseline-unbound');
        expected[file] = row.after;
      }
      return expected;
    },
    acceptReconciled(result) {
      const allowReset = result?.ok === true && !result.pending_roots?.length
        && view.contract.code_roots.every(root => result.roots?.some(row => row.root_id === root.id && row.reconciled === true));
      live(allowReset);
      if (roots.digest(execution.protectedSnapshot(view.owner)) !== roots.digest(view.current)) fail('owner-reconciliation-observation-changed');
      observedRoots = observedRoots.map(row => ({ ...row, code: execution.replayState(row.path) }));
    },
  };
  assertCurrent(); const cap = Object.freeze({}); reconciliations.set(cap, entry); return cap;
}
function reconciliationEntry(handle, request) {
  const entry = reconciliations.get(handle);
  if (!entry || entry.consumed || roots.digest(require('./forge-attempt-recovery').canonicalRequest(request)) !== entry.requestHash) fail('owner-reconciliation-capability-required');
  return entry;
}
function assertOwnerReconciliationReady(handle, request) {
  const entry = reconciliationEntry(handle, request);
  if (handoffs.getStore() === entry) { entry.live(); return; }
  entry.assertCurrent();
}
function withOwnerReconciliation(handle, request, action) {
  if (typeof action !== 'function' || action.constructor?.name === 'AsyncFunction') fail('owner-reconciliation-sync-required');
  const entry = reconciliationEntry(handle, request); entry.assertCurrent();
  if (entry.active) fail('owner-reconciliation-operation-active');
  entry.active = true;
  try {
    const result = reconciliationContext.run(entry, action);
    if (result?.then) fail('owner-reconciliation-sync-required');
    entry.acceptReconciled(result); return result;
  } finally { entry.active = false; }
}
async function withReconciliationHandoff(request, runtime, action) {
  if (runtime.ownerReconciliation === undefined) return action();
  const entry = reconciliations.get(runtime.ownerReconciliation);
  if (!entry || entry.consumed) fail('owner-reconciliation-capability-required');
  const r = request || {}, old = entry.view.r;
  if (r.unitType !== old.unitType || r.scope !== old.scope || r.milestoneId !== old.milestoneId || r.taskId !== old.taskId
      || roots.digest(r.execution_contract) !== roots.digest(old.execution_contract) || roots.digest(r.claim) !== roots.digest(old.claim)) fail('owner-reconciliation-successor-mismatch');
  entry.assertCurrent();
  if (r.resultFile === old.resultFile) {
    if (entry.active) fail('owner-reconciliation-operation-active');
    entry.active = true;
    try { return await reconciliationContext.run(entry, action); }
    finally { entry.active = false; entry.consumed = true; }
  }
  try { return await handoffs.run(entry, action); }
  finally { entry.consumed = true; }
}
module.exports = { withExecutionActivity, currentScope, assertPreflightAdmission, expectedProtectedOwner, reconciliationDecision,
  createOwnerReconciliation, assertOwnerReconciliationReady, withOwnerReconciliation, withReconciliationHandoff,
  resumeAttemptOwner, inspectAttemptResume };
