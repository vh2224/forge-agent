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
  // Warm cached process-family custody only AFTER the initial temporal admission,
  // before any lease/window and the synchronous scope.spawn path. Final launch
  // admission is still rechecked after this asynchronous preparation. A known
  // time refusal starts no helper or provider; unavailable custody stays conservative.
  try { await require('./forge-process-tree').prepareCustody(); } catch { /* custody unavailable */ }
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
  let child = null, failedSpawn = null, childClosed = false, join = null, attemptTree = null;
  // Attempt binding from the same canonical sources as managed-surfaces-v1.
  const treeBinding = () => {
    const recovery = require('./forge-attempt-recovery');
    const claimGeneration = run.write_claim?.generation;
    return { dispatch_id: r.dispatchId, fingerprint: require('./forge-unit-sidecar').artifactFingerprint(r),
      recovery_identity_sha256: roots.digest(recovery.requestIdentity(recovery.canonicalRequest(r))), unit,
      claim_generation: claimGeneration === undefined ? null : claimGeneration, lease_generation: generation };
  };
  const treeRoots = () => [owner, ...r.execution_contract.code_roots.map(root => root.path)];
  const knownLeaseHashes = new Set();
  const relative = path.relative(owner, leaseFile).replace(/\\/g, '/');
  const requestHash = roots.digest({ owner, run: runId, unit, generation, dispatch: r.dispatchId,
    workflow: r.workflowId, contract: r.execution_contract, plan: planHash, claim: claimHash });
  // Live managed-surfaces-v1 attribution (issue 440). Only a live v1 context
  // changes anything below; a refusal handle keeps every current guard as-is.
  const managed = require('./forge-managed-attribution');
  let attribution = null;
  const managedLive = () => attribution !== null && managed.isAttributionLive(attribution);
  function assertLive(options) {
    // Under a live v1 context the projected snapshot itself refuses a changed
    // lease (execution-protected-metadata with a named diagnostic).
    const leaseByProjection = options?.projection === true && managedLive();
    // A manual lease edit of a live v1 attempt is diagnosed by name through the
    // canonical protected-snapshot assert, from the trusted chain head, BEFORE any
    // heartbeat/renewal or adoption of the untrusted bytes. Anything else, or a
    // diagnosis that does not refuse, falls through to the unchanged legacy throw.
    if (!closed && !options && managedLive()) {
      let observed = null;
      try { observed = sha(regular(leaseFile)); } catch { observed = null; }
      if (observed !== null && observed !== expectedLease) {
        const api = require('./forge-task-execution'), snapshot = api.protectedSnapshot(owner);
        contexts.run(scope, () => managed.runWithAttribution(attribution, () => api.assertProtected(owner, { ...snapshot, [relative]: expectedLease })));
      }
    }
    if (closed || !leaseWindow?.heartbeat().ok || (!leaseByProjection && sha(regular(leaseFile)) !== expectedLease)) fail('protected-owner-lease-changed');
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
      // The family custody starts the transport itself (supervisor on win32,
      // plain spawn for forms it cannot reproduce). A module error BEFORE any
      // spawn keeps today's plain spawn; a custody failure after the supervisor
      // was chosen is a named refusal and never runs the transport uncontained.
      let tree = null;
      try {
        tree = require('./forge-process-tree');
        attemptTree = tree.startAttemptTree({ command, args, options, resultFile: r.resultFile, binding: treeBinding(), roots: treeRoots() });
      } catch (error) {
        attemptTree = null;
        if (tree?.isSpawnError(error)) { failedSpawn = ['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code) ? error.code : null; throw error; }
        if (tree?.isCustodyFailure(error)) throw error;
      }
      if (attemptTree) child = attemptTree.child;
      else {
        try { child = spawn(command, args, options); }
        catch (error) { failedSpawn = ['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code) ? error.code : null; throw error; }
      }
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
      // Additive, diagnostic-only key: no record/journal/proof failure changes
      // joined, possible_writers, codes, the owner window or the lease.
      let descendants = null;
      try { descendants = attemptTree ? await attemptTree.tree.join() : null; } catch { descendants = null; }
      if (!descendants) descendants = Object.freeze({ status: 'unknown', method: 'process-tree-census-v1', record_sha256: null });
      return (join = Object.freeze({ joined: true, possible_writers: 0, pid: child.pid || null, descendants }));
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
      const reopen = () => {
        const prior = managedLive() ? regular(leaseFile) : null;
        leaseWindow = lease.openProtectedWindow(owner, unit, token, generation, { durationMs: wanted.duration_ms });
        if (!leaseWindow.ok) fail('protected-owner-lease-window-refused');
        const next = regular(leaseFile);
        expectedLease = sha(next); knownLeaseHashes.add(expectedLease);
        // Attributed under the same owner fence that published the lease.
        if (prior) managed.runWithAttribution(attribution, () => managed.recordManagedWrite({ surface: 'unit-lease', path: relative,
          writer: 'scripts/forge-unit-lease.js#openProtectedWindow', beforeBytes: prior, afterBytes: next }));
      };
      if (managedLive()) windows.withMutation(owner, reopen); else reopen();
    },
    expectedOwner(root, before) {
      if (roots.key(fs.realpathSync.native(root)) !== roots.key(owner)) return before;
      if (!before || !knownLeaseHashes.has(before[relative])) fail('protected-owner-baseline-unbound');
      assertLive({ projection: true });
      return { ...before, [relative]: expectedLease };
    },
  });
  scopes.add(scope);
  let value, failure;
  try {
    attribution = windows.withWindow(ownerWindow, () => windows.withMutation(owner, () => managed.createActivityAttribution({
      request: r, owner, unit, revalidate: assertLive, claimGeneration: run.write_claim?.generation, leaseGeneration: generation,
      version: runtime?.managedSurfacesVersion, attestation: runtime?.managedAppendAttestation,
      onAdopt(file, digestValue) { if (file === relative && digestValue) { expectedLease = digestValue; knownLeaseHashes.add(digestValue); } } })));
    value = await windows.withWindow(ownerWindow, () => contexts.run(scope, () => managed.runWithAttribution(attribution, () => action(runtime))));
  } catch (error) { failure = error; }
  try {
    await scope.joinWriter();
    // Closing the coordination boundary does not renew/revive an expired lease.
    windows.close(ownerWindow, challenge => ({ challenge_sha256: roots.digest(challenge),
      joined: true, possible_writers: 0, reference: `unit-execution:${r.dispatchId}:actual-spawn-join` }));
    leaseWindow.close(); closed = true; scopes.delete(scope);
  } catch (error) {
    if (failure) { failure.owner_window = { status: 'held', reason_code: error.code || 'protected-owner-writer-unproven' }; }
    else failure = error;
  } finally { if (attribution) managed.releaseAttribution(attribution); }
  if (failure) throw failure;
  return value;
}

function expectedProtectedOwner(root, before) {
  const reconciliation = reconciliationContext.getStore();
  if (reconciliation) before = reconciliation.project(root, before);
  const scope = currentScope();
  const projected = scope && scopes.has(scope) ? scope.expectedOwner(root, before) : before;
  // Exact attributed deltas only; returns its input unchanged without a live v1 context.
  return require('./forge-managed-attribution').projectExpected(root, projected);
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
// Separate operator consent for one retained non-owner resource-event append.
// No assertion of historical authorship and no baseline/receipt rewrite.
const validatedRootAppendApprovals = new WeakSet();
function rootAppendView(request, options = {}) {
  const view = reconciliationView(request, options.ownerDecision);
  if (!/^[a-f0-9]{64}$/.test(options.ownerDecision || '')) fail('root-append-owner-decision-required');
  const root = view.contract.code_roots.find(row => row.id === options.rootId);
  if (!root || roots.key(root.path) === roots.key(view.owner)) fail('root-append-root-invalid');
  const originals = view.baseline.protected_roots?.filter(row => row.root_id === root.id && roots.key(row.path) === roots.key(root.path));
  if (originals?.length !== 1) fail('root-append-baseline-invalid');
  const before = originals[0].snapshot, relative = '.gsd/forge/events.jsonl';
  if (!Buffer.isBuffer(options.originalBytes) || !Buffer.isBuffer(options.appendedBytes)
      || !/^[a-f0-9]{64}$/.test(before?.[relative] || '') || sha(options.originalBytes) !== before[relative]
      || !options.appendedBytes.length || options.appendedBytes.length > 65536
      || options.appendedBytes.at(-1) !== 10) fail('root-append-bytes-invalid');
  const originalBytes = Buffer.from(options.originalBytes), appendedBytes = Buffer.from(options.appendedBytes);
  const currentBytes = regular(path.join(root.path, relative));
  if (!currentBytes.equals(Buffer.concat([originalBytes, appendedBytes]))) fail('root-append-bytes-invalid');
  let rows;
  try { rows = new TextDecoder('utf-8', { fatal: true }).decode(appendedBytes).trimEnd().split('\n').map(JSON.parse); }
  catch { fail('root-append-events-invalid'); }
  if (!rows.length || rows.length > 128 || rows.length % 3) fail('root-append-events-invalid');
  const kinds = ['resource-admission', 'resource-pool-granted', 'resource-pool-released'];
  const keys = ['kind,pressureLevel,reason,source,ts,workers', 'ceiling,granted,kind,reason,ts', 'granted,kind,reason,ts'];
  for (const [i, row] of rows.entries()) {
    if (!row || Object.keys(row).sort().join(',') !== keys[i % 3] || row.kind !== kinds[i % 3]
        || !Number.isFinite(Date.parse(row.ts)) || Date.parse(row.ts) > Date.now()
        || i && Date.parse(row.ts) < Date.parse(rows[i - 1].ts)
        || typeof row.reason !== 'string' || !row.reason || row.reason.length > 128
        || i % 3 === 0 && (typeof row.source !== 'string' || !row.source || row.source.length > 128
          || row.pressureLevel !== null && ![1, 2, 4].includes(row.pressureLevel)
          || !Number.isInteger(row.workers) || row.workers < 1 || row.workers > 1024)
        || i % 3 !== 0 && (!Number.isInteger(row.granted) || row.granted < 1 || row.granted > 1024)
        || i % 3 === 1 && (!Number.isInteger(row.ceiling) || row.ceiling < row.granted || row.ceiling > 1024)
        || i % 3 === 2 && row.granted !== rows[i - 1].granted) fail('root-append-events-invalid');
  }
  const expected = { ...before, [relative]: sha(currentBytes) };
  const execution = require('./forge-task-execution'), current = execution.protectedSnapshot(root.path);
  if (roots.digest(current) !== roots.digest(expected)) fail('root-append-protected-delta-invalid');
  const binding = { owner: view.owner, unit: `execute-task/${view.r.taskId}`, dispatch_id: view.r.dispatchId,
    request_sha256: roots.digest(view.r), receipt_sha256: sha(view.receiptBytes), baseline_sha256: roots.digest(view.baseline),
    owner_decision: options.ownerDecision, root_id: root.id, root_path: root.path, root_identity_sha256: root.identity_sha256,
    path: relative, original_snapshot_sha256: roots.digest(before), current_snapshot_sha256: roots.digest(current),
    original_sha256: sha(originalBytes), appended_sha256: sha(appendedBytes), current_sha256: sha(currentBytes),
    original_bytes: originalBytes.length, appended_bytes: appendedBytes.length, event_count: rows.length };
  return { view, root, before, expected, currentBytes, binding };
}
function rootAppendQuestion(proof) {
  const r = proof.view.r, b = proof.binding, digest = roots.digest(b);
  return { cwd: proof.view.owner, unit: b.unit, milestone: r.milestoneId, slice: r.sliceId, task: r.taskId,
    workflow_id: r.milestoneId, decision_set: `code-root-append/${digest}`,
    questions: [{ id: 'code-root-append-approval', question:
      `Autorizar exclusivamente o sufixo retido de metadados ${digest} em ${b.root_id}:${b.root_path}/${b.path}, prefixo ${b.original_sha256}, sufixo ${b.appended_sha256} (${b.appended_bytes} bytes, ${b.event_count} linhas), atual ${b.current_sha256}? Esta decisao nao certifica autoria historica e nao autoriza outros arquivos, roots, codigo, planos ou claims.` }],
    delta_sha256: digest, changes: [structuredClone(b)] };
}
function codeRootAppendDecision(request, options = {}) {
  return rootAppendQuestion(rootAppendView(request, options));
}
function validateRootAppendApproval(request, ownerDecision, options) {
  if (typeof options?.attestOperatorAnswer !== 'function') fail('root-append-live-answer-required');
  const proof = rootAppendView(request, { ...options, ownerDecision });
  return windows.withMutation(proof.view.owner, () => {
    const decision = rootAppendQuestion(proof), api = require('./forge-pending-questions');
    if (!/^[a-f0-9]{64}$/.test(options.operatorDecision || '') || options.operatorDecision === ownerDecision) fail('root-append-answer-required');
    const answer = api.continuation({ cwd: proof.view.owner, identity: options.operatorDecision });
    const expectedIdentity = { schema_version: 1, origin: 'owner', unit: decision.unit, milestone: decision.milestone,
      slice: decision.slice, task: decision.task, workflow_id: decision.workflow_id, dispatch_id: null,
      request_fingerprint: null, receipt_phase: null, decision_set: decision.decision_set };
    if (!answer.ok || roots.digest(answer.identity) !== options.operatorDecision
        || roots.digest(answer.identity) !== roots.digest(expectedIdentity) || answer.questions?.length !== 1
        || answer.questions[0].id !== decision.questions[0].id || answer.questions[0].question !== decision.questions[0].question
        || !['aprovar', 'aprovado', 'sim', 'autorizar'].includes(answer.questions[0].answer?.trim().toLowerCase())) fail('root-append-answer-required');
    const carriers = [`.gsd/forge/questions/${options.operatorDecision}.json`, `.gsd/forge/questions/${options.operatorDecision}.origin.json`]
      .map(relative => ({ relative, bytes: regular(path.join(proof.view.owner, relative)) }));
    const challenge = Object.freeze({ ...proof.binding, decision_identity: options.operatorDecision,
      answer_sha256: roots.digest(answer), carriers: carriers.map(row => ({ path: row.relative, sha256: sha(row.bytes) })) });
    const observed = options.attestOperatorAnswer(structuredClone(challenge));
    if (!observed || observed.then || observed.observed !== true || observed.challenge_sha256 !== roots.digest(challenge)
        || typeof observed.reference !== 'string' || !observed.reference.trim() || observed.reference.length > 512
        || /[\r\n]/.test(observed.reference)) fail('root-append-live-answer-required');
    function check() {
      roots.validateContract(proof.view.contract, { owner: proof.view.owner, revalidate: true });
      for (const row of carriers) if (!regular(path.join(proof.view.owner, row.relative)).equals(row.bytes)) fail('root-append-answer-changed');
      if (!regular(path.join(proof.root.path, proof.binding.path)).equals(proof.currentBytes)
          || roots.digest(require('./forge-task-execution').protectedSnapshot(proof.root.path)) !== roots.digest(proof.expected)) fail('root-append-root-changed');
    }
    check();
    const accepted = { ...proof, carriers, check, reference: observed.reference,
      project(root, before) {
        if (roots.key(fs.realpathSync.native(root)) !== roots.key(proof.root.path)) return before;
        check();
        if (![roots.digest(proof.before), roots.digest(proof.expected)].includes(roots.digest(before))) fail('root-append-baseline-unbound');
        return { ...before, [proof.binding.path]: proof.binding.current_sha256 };
      } };
    validatedRootAppendApprovals.add(accepted); return accepted;
  });
}
// Read/projection scope for a genuine successor outside an execution handoff.
// It cannot accept a reset, change an observation or create a new capability.
function withOwnerReconciliationRead(handle, request, action) {
  if (typeof action !== 'function' || action.constructor?.name === 'AsyncFunction') fail('owner-reconciliation-sync-required');
  const entry = reconciliationEntry(handle, request); entry.live(); entry.checkRoots();
  if (entry.active) {
    if (reconciliationContext.getStore() !== entry) fail('owner-reconciliation-operation-active');
    return action();
  }
  entry.active = true;
  try { const result = reconciliationContext.run(entry, action); if (result?.then) fail('owner-reconciliation-sync-required'); return result; }
  finally { entry.active = false; }
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
  if (options.validatedRootAppend !== undefined && options.validatedRootAppend !== null
      && !validatedRootAppendApprovals.has(options.validatedRootAppend)) fail('root-append-capability-required');
  for (const row of options.validatedRootAppend?.carriers || []) carriers.add(row.relative);
  const changes = [...new Set([...Object.keys(before), ...Object.keys(current)])].sort()
    .filter(file => before[file] !== current[file]).map(file => ({ path: file, before: before[file] ?? null, after: current[file] ?? null }));
  const hooks = Object.keys(options.hookEvidence?.originalBytes || {}).sort().map(file => hookAppendProof(owner,
    { path: file, before: before[file] ?? null, after: current[file] ?? null }, options.hookEvidence, `execute-task/${r.taskId}`, r.dispatchId));
  const hookPaths = new Set(hooks.map(row => row.path));
  const reviewed = changes.filter(row => !carriers.has(row.path) && !(operatorDecision && row.path === '.gsd/forge/questions/') && !hookPaths.has(row.path));
  if (changes.length > 64) fail('owner-reconciliation-delta-limit');
  const deltaSha = roots.digest({ owner, unit: `execute-task/${r.taskId}`, dispatch_id: r.dispatchId, changes: reviewed,
    ...(hooks.length ? { hook_baselines: hooks } : {}) });
  return { r, owner, contract, receiptFile, receiptBytes, receipt, baseline, stateBytes, current, before, changes, reviewed, carriers, deltaSha, hooks };
}
function decisionForView(view, deltaSha = view.deltaSha, changes = view.reviewed) {
  const r = view.r;
  return { cwd: view.owner, unit: `execute-task/${r.taskId}`, milestone: r.milestoneId,
    slice: r.sliceId, task: r.taskId, workflow_id: r.milestoneId, decision_set: `owner-delta/${deltaSha}`,
    questions: [{ id: 'owner-delta-approval', question: `Autorizar somente os deltas de metadados revisados ${deltaSha} para ${r.milestoneId}/${r.taskId}? Nenhum plano, claim ou código será aceito como alterado.` }],
    delta_sha256: deltaSha, changes };
}
function reconciliationDecision(request, operatorDecision, options = {}) {
  return decisionForView(reconciliationView(request, operatorDecision, options));
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
  const request = options.request || {};
  const owner = roots.realDirectory(request.contextRoot || request.cwd);
  return windows.withMutation(owner, () => resumeAttemptOwnerInside(options));
}
function resumeAttemptOwnerInside(options) {
  const { request, assertAuthority, attestStoppedWriter, readPendingQuestions } = options;
  if (![assertAuthority, attestStoppedWriter, readPendingQuestions].every(fn => typeof fn === 'function')) fail('owner-reconciliation-live-adapter-required');
  const view = reconciliationView(request), r = view.r, runId = r.runId || r.milestoneId, unit = `execute-task/${r.taskId}`;
  const runs = require('./forge-runs'), controller = require('./forge-unit-controller');
  const actor = runs.observeHostSession(options.hostRuntime, options.expectedSession);
  if (!actor) fail('owner-reconciliation-observed-owner-required');
  const recordPath = `.gsd/forge/runs/${runId}.json`, beforeBytes = regular(path.join(view.owner, recordPath));
  const mirrorPath = '.gsd/forge/auto-mode.json', mirrorFile = path.join(view.owner, mirrorPath);
  const mirrorBefore = fs.existsSync(mirrorFile) ? regular(mirrorFile) : null;
  const before = runs.get(view.owner, runId), leaseBytes = regular(lease.leaseFile(view.owner, unit)), held = JSON.parse(leaseBytes);
  const begin = controller.lookupRecord(view.owner, 'transaction', held.request_id);
  if (view.receipt.phase !== 'failed' && view.receipt.phase !== 'executed' || !runs.knownResumeBinding(before)
      || before.worker || before.worker_started || !lease.validRecord(held, unit)
      || actor.hostRuntime !== held.host_runtime || before.host_runtime !== held.host_runtime || r.route?.host_runtime !== held.host_runtime
      || roots.digest(before.write_claim) !== roots.digest(r.claim) || !begin || begin.action !== 'begin' || begin.phase !== 'committed'
      || begin.milestone !== r.milestoneId || begin.unit?.key !== unit || begin.lease_generation !== held.generation
      || begin.owner_digest !== `sha256:${sha(held.owner_token)}`
      || view.before[path.relative(view.owner, controller.transactionFile(view.owner, held.request_id)).replace(/\\/g, '/')] !== sha(regular(controller.transactionFile(view.owner, held.request_id)))
      || !controller.incompleteUnits(view.owner, runId).some(row => row.idempotency_key === held.request_id && row.action === 'begin')) fail('owner-reconciliation-resume-scope-invalid');
  const scope = { kind: 'attempt-recovery', milestone: runId, unit, begin_key: begin.idempotency_key,
    repair_generation: held.generation, repair_owner_digest: begin.owner_digest, host_runtime: held.host_runtime,
    request_sha256: roots.digest(r), parent_receipt_sha256: sha(view.receiptBytes) };
  if (before.active !== false) {
    const latest = Array.isArray(before.owner_resume_history) ? before.owner_resume_history.at(-1) : null;
    // History permits only this exact retained-attempt continuation. It is not
    // authority or a death proof: fresh live callbacks and fenced source checks
    // below remain mandatory, as do resumeOwner's explicit stop/quiescence gates.
    if (before.active !== true || before.session_id === actor.sessionId
        || latest?.kind !== 'stopped-owner-transfer'
        || latest.current_session_sha256 !== roots.digest(before.session_id)
        || latest.current_host_runtime !== before.host_runtime
        || latest.previous_owner_stopped_attested !== true || latest.workspace_quiescent_attested !== true
        || latest.mechanism !== 'trusted-caller-attestation-v1'
        || !latest.boundary?.attempt_recovery || typeof latest.boundary.attempt_recovery !== 'object'
        || Array.isArray(latest.boundary.attempt_recovery)
        || roots.digest(latest.boundary?.attempt_recovery) !== roots.digest(scope)) fail('owner-reconciliation-resume-scope-invalid');
  }
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
  const handle = Object.freeze({}); attemptResumes.set(handle, { owner: view.owner, runId, check, scope });
  let resumed;
  try { resumed = runs.resumeOwner(view.owner, runId, { hostRuntime: actor.hostRuntime, expectedSession: actor.sessionId,
    expectedRecordSha256: options.expectedRecordSha256, confirmOwnerStopped: options.confirmOwnerStopped,
    confirmWorkspaceQuiescent: options.confirmWorkspaceQuiescent, attemptRecovery: handle }); }
  finally { attemptResumes.delete(handle); }
  const afterBytes = regular(path.join(view.owner, recordPath));
  const mirrorAfter = fs.existsSync(mirrorFile) ? regular(mirrorFile) : null;
  const transfer = Object.freeze({}); ownerTransfers.set(transfer, { requestHash: roots.digest(r), recordPath, beforeBytes, afterBytes,
    changes: [{ path: recordPath, beforeBytes, afterBytes }, { path: mirrorPath, beforeBytes: mirrorBefore, afterBytes: mirrorAfter }] });
  return Object.freeze({ status: resumed.status, ownerTransfer: transfer, scope: structuredClone(scope) });
}
function createOwnerReconciliation(options = {}) {
  const { request, assertAuthority, attestStoppedWriter, readPendingQuestions, attestChanges } = options;
  if ([assertAuthority, attestStoppedWriter, readPendingQuestions, attestChanges].some(fn => typeof fn !== 'function')) fail('owner-reconciliation-live-adapter-required');
  const rootAppend = options.codeRootAppendApproval === undefined ? null
    : validateRootAppendApproval(request, options.operatorDecision, options.codeRootAppendApproval);
  const view = reconciliationView(request, options.operatorDecision, { ...options, validatedRootAppend: rootAppend }), r = view.r, unit = `execute-task/${r.taskId}`;
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
    if (rootAppend) rootAppend.check();
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
  let operatorApproved = false, preTransferApproved = false;
  if (options.operatorDecision !== undefined) {
    const expected = decisionForView(view), answer = require('./forge-pending-questions').continuation({ cwd: view.owner, identity: options.operatorDecision });
    const identity = answer.identity;
    const q = answer.questions?.find(row => row.id === expected.questions[0].id);
    if (!answer.ok || identity?.origin !== 'owner' || identity.unit !== unit || identity.milestone !== r.milestoneId
        || identity.slice !== r.sliceId || identity.task !== r.taskId
        || !q || !['aprovar', 'aprovado', 'sim', 'autorizar'].includes(q.answer?.trim().toLowerCase())) fail('owner-reconciliation-operator-decision-required');
    const matches = candidate => identity.decision_set === candidate.decision_set && q.question === candidate.questions[0].question;
    if (!matches(expected)) {
      // Compose an already answered EXACT historical delta with only the new
      // canonical transition captured by this live opaque handle. No serialized
      // history, missing handle or different new metadata supplies this bridge.
      const proof = ownerTransfers.get(options.ownerTransfer);
      if (!proof || proof.requestHash !== roots.digest(r)
          || !view.reviewed.some(row => row.path === proof.recordPath && row.after === sha(proof.afterBytes))
          || view.current[proof.recordPath] !== sha(proof.afterBytes)) fail('owner-reconciliation-operator-decision-required');
      const bridge = new Map(proof.changes.map(row => [row.path, row]));
      for (const row of bridge.values()) if ((view.current[row.path] ?? null) !== (row.afterBytes ? sha(row.afterBytes) : null)) fail('owner-reconciliation-operator-decision-required');
      const changes = view.reviewed.map(row => bridge.has(row.path) ? { ...row, after: bridge.get(row.path).beforeBytes ? sha(bridge.get(row.path).beforeBytes) : null } : row)
        .filter(row => row.before !== row.after);
      const delta = roots.digest({ owner: view.owner, unit, dispatch_id: r.dispatchId, changes,
        ...(view.hooks.length ? { hook_baselines: view.hooks } : {}) });
      if (!matches(decisionForView(view, delta, changes))) fail('owner-reconciliation-operator-decision-required');
      preTransferApproved = true;
    }
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
        if (roots.digest(immutable(original)) !== roots.digest(immutable(previous)) && !preTransferApproved) fail('owner-reconciliation-transfer-proof-required');
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
    execution.assertProtected(root.path, rootAppend ? rootAppend.project(root.path, baseline.snapshot) : baseline.snapshot);
    return { path: root.path, protected: execution.protectedSnapshot(root.path), code: execution.replayState(root.path) };
  });
  function checkRoots() {
    if (rootAppend) rootAppend.check();
    for (const row of observedRoots) if (roots.digest(execution.protectedSnapshot(row.path)) !== roots.digest(row.protected)
        || roots.digest(execution.replayState(row.path)) !== roots.digest(row.code)) fail('owner-reconciliation-root-changed');
  }
  function assertCurrent() {
    live();
    const current = execution.protectedSnapshot(view.owner);
    if (roots.digest(current) !== roots.digest(view.current)) fail('owner-reconciliation-observation-changed');
    checkRoots();
  }
  const entry = { requestHash: roots.digest(view.r), view, challenge, live, assertCurrent, checkRoots, active: false, consumed: false,
    project(root, before) {
      if (!entry.active) fail('owner-reconciliation-operation-inactive');
      if (roots.key(fs.realpathSync.native(root)) !== roots.key(view.owner)) {
        if (!rootAppend) return before;
        live(); return rootAppend.project(root, before);
      }
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
  codeRootAppendDecision, withOwnerReconciliationRead,
  resumeAttemptOwner, inspectAttemptResume, hookAppendProof };
