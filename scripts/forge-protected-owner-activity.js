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
        coordination: 'observed-host-session-v1', host_runtime: actor.hostRuntime, host_session_sha256: roots.digest(actor.sessionId),
        dispatch_id: r.dispatchId, request_sha256: requestHash, unit_key: unit,
        request_fingerprint: require('./forge-unit-sidecar').artifactFingerprint(r),
        recovery_identity_sha256: treeBinding().recovery_identity_sha256, result_file_sha256: roots.digest(path.resolve(r.resultFile)),
        begin_key: begin.idempotency_key, begin_sha256: controller.recordChecksum(begin),
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

// Native custody is a distinct live scope. No PID, skipped spawn or serialized
// joined flag can close this window. The caller still owns normal lifecycle.
async function withNativeExecutionActivity(request, profileHandle, action) {
  if (typeof action !== 'function' || !request || request.scope !== 'milestone'
      || request.unitType !== 'execute-task' || request.phase !== 'execute'
      || request.route?.worker_mode !== 'native' || !request.execution_contract
      || request.ownerBroker || request.memberHandle !== undefined || request.batch_id !== undefined) fail('native-owner-activity-scope-required');
  const profile = require('./forge-native-host-profile');
  if (typeof profile.assertActivityAdmission !== 'function') fail('native-owner-profile-admission-unavailable');
  const initialAdmission = syncProfile('assertActivityAdmission', profileHandle, request); // genuine intent, no call IDs yet
  const r = structuredClone(request), requestSha = roots.digest(r);
  const owner = fs.realpathSync.native(r.contextRoot || r.cwd), unit = 'execute-task/' + r.taskId;
  const runs = require('./forge-runs'), controller = require('./forge-unit-controller');
  const execution = require('./forge-task-execution'), managed = require('./forge-managed-attribution');
  // An inherited managed journal is a separately selected external writer. Do
  // not activate an unadmitted .managed-surfaces directory inside the channel.
  if (managed.currentAttribution(owner)?.active) fail('native-owner-managed-admission-unavailable');
  require('./forge-milestone-time-admission').assertTransportEntry({ cwd: owner, milestone: r.milestoneId, unit });
  const leaseFile = lease.leaseFile(owner, unit), observed = lease.readLease(leaseFile);
  if (!lease.validRecord(observed.record, unit)) fail('native-owner-lease-required');
  const original = observed.record, token = original.owner_token, generation = original.generation;
  const initialLeaseBytes = regular(leaseFile);
  if (roots.digest(JSON.parse(initialLeaseBytes)) !== roots.digest(original)) fail('protected-owner-source-unstable');
  const begin = controller.lookupRecord(owner, 'transaction', original.request_id);
  if (!begin || begin.action !== 'begin' || begin.phase !== 'committed' || begin.unit?.key !== unit
      || begin.milestone !== r.milestoneId || begin.lease_generation !== generation
      || begin.owner_digest !== 'sha256:' + sha(token) || begin.host_runtime !== r.route.host_runtime) fail('protected-owner-begin-mismatch');
  const beginSha = controller.recordChecksum(begin), runId = r.runId || r.milestoneId;
  const run = runs.get(owner, runId), actor = runs.observeHostSession(r.route.host_runtime, run?.session_id);
  if (!actor || !run?.active || run.session_id !== actor.sessionId || run.host_runtime !== actor.hostRuntime) fail('protected-owner-session-required');
  function relayReference(admission) {
    if (!admission || typeof admission !== 'object' || Array.isArray(admission)
        || Object.getPrototypeOf(admission) !== Object.prototype
        || Object.values(Object.getOwnPropertyDescriptors(admission)).some(d => !Object.hasOwn(d, 'value'))) fail('native-owner-relay-admission-shape');
    const ref = admission.live_relay_reference, live = 'claude-agent-files-foreground-v1';
    if (ref === undefined) { if (admission.profile_id === live) fail('native-owner-live-relay-required');return null; }
    const fields = ['protocol_version','kind','directory','endpoint','attempt_id','dispatch_id','request_sha256','host_session_sha256','profile_id'];
    if (!ref || typeof ref !== 'object' || Array.isArray(ref) || Object.getPrototypeOf(ref) !== Object.prototype
        || Reflect.ownKeys(ref).some(k => typeof k !== 'string')
        || Object.values(Object.getOwnPropertyDescriptors(ref)).some(d => !Object.hasOwn(d, 'value') || !d.enumerable)
        || Object.keys(ref).sort().join(',') !== [...fields].sort().join(',')) fail('native-owner-live-relay-shape');
    if (ref.protocol_version !== 1 || ref.kind !== 'native-host-live-relay' || ref.profile_id !== live
        || admission.profile_id !== live || ref.dispatch_id !== r.dispatchId || ref.request_sha256 !== requestSha
        || ref.host_session_sha256 !== roots.digest(actor.sessionId)
        || typeof ref.attempt_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(ref.attempt_id)
        || typeof ref.dispatch_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(ref.dispatch_id)) fail('native-owner-live-relay-binding');
    for (const key of ['directory','endpoint']) if (typeof ref[key] !== 'string' || !ref[key]
        || ref[key].length > (key === 'directory' ? 4096 : 4096 + path.sep.length + 'owner.sock'.length)
        || /[\x00-\x1f\x7f]/.test(ref[key])) fail('native-owner-live-relay-path');
    if (!path.isAbsolute(ref.directory) || roots.key(fs.realpathSync.native(ref.directory)) !== roots.key(ref.directory)
        || roots.key(ref.directory) !== roots.key(path.dirname(r.resultFile))) fail('native-owner-live-relay-directory');
    const stat = fs.lstatSync(ref.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('native-owner-live-relay-directory');
    for (const root of [owner, ...r.execution_contract.code_roots.map(row => row.path)])
      if (roots.key(root) === roots.key(ref.directory) || roots.within(root, ref.directory)) fail('native-owner-live-relay-inside-root');
    const endpoint = process.platform === 'win32' ? '\\\\.\\pipe\\forge-native-' + sha(ref.directory) : path.join(ref.directory, 'owner.sock');
    if (ref.endpoint !== endpoint) fail('native-owner-live-relay-endpoint');
    // Locator data only. Caller/parent/source/actor/window authentication and
    // actual native execution admission remain in the receiving host ingress.
    return Object.freeze(Object.fromEntries(fields.map(key => [key, ref[key]])));
  }
  const liveRelay = relayReference(initialAdmission);
  const claimSha = roots.digest(run.write_claim), planSha = sha(regular(r.planFile, 2 * 1024 * 1024));
  const timeout = require('./forge-worker-timeout'), duration = timeout.protectedWindowMs(timeout.ceilingFromRoute(r.route).ms);
  if (!duration.covers) fail('protected-owner-window-ceiling-unsupported');
  const recovery = require('./forge-attempt-recovery'), identity = recovery.requestIdentity(recovery.canonicalRequest(r));
  const relative = path.relative(owner, leaseFile).split(path.sep).join('/'), knownLeaseHashes = new Set([sha(initialLeaseBytes)]);
  let ownerWindow = null, leaseWindow = null, expectedLease = sha(initialLeaseBytes), ownerBefore = null;
  let joinedCustody = null, publicationWitness = null, publication = null;
  let publicationAttemptWitness = null, publicationAttempt = null;
  let coordinationClosed = false, leaseClosed = false, settled = false, settling = null;
  function sameActorClaim(provedPublication = publication || publicationAttempt, pending = !publication) {
    if (roots.digest(request) !== requestSha) fail('native-owner-request-changed');
    const current = runs.get(owner, runId), currentActor = runs.observeHostSession(r.route.host_runtime, actor.sessionId);
    if (!current?.active || !currentActor || currentActor.sessionId !== actor.sessionId || currentActor.hostRuntime !== actor.hostRuntime
        || currentActor.source !== actor.source || current.session_id !== actor.sessionId || current.host_runtime !== actor.hostRuntime
        || roots.digest(current.write_claim) !== claimSha) fail('protected-owner-authority-changed');
    roots.validateContract(r.execution_contract, { owner, revalidate: true });
    const currentBegin = controller.lookupRecord(owner, 'transaction', original.request_id);
    if (!currentBegin || controller.recordChecksum(currentBegin) !== beginSha) fail('native-owner-begin-changed');
    const held = lease.readLease(leaseFile);
    if (!lease.validRecord(held.record, unit) || held.record.generation !== generation
        || held.record.owner_token !== token || held.record.request_id !== begin.idempotency_key
        || sha(regular(leaseFile)) !== expectedLease) fail('protected-owner-lease-changed');
    const planRelative = path.relative(owner, r.planFile).split(path.sep).join('/');
    const planArtifact = provedPublication?.artifacts.find(row => row.path === planRelative);
    const currentPlan = sha(regular(r.planFile, 2 * 1024 * 1024));
    if (planArtifact ? currentPlan !== planArtifact.after_sha256 && (!pending || currentPlan !== planArtifact.before)
      : currentPlan !== planSha) fail('protected-owner-authority-changed');
  }
  function syncProfile(method, ...args) {
    if (typeof profile[method] !== 'function') fail('native-owner-' + method + '-unavailable');
    const value = profile[method](...args);
    if (value && typeof value.then === 'function') fail('native-owner-profile-sync-required');
    return value;
  }
  function assertLive() {
    if (settled || coordinationClosed || leaseClosed || !leaseWindow?.heartbeat().ok) fail('protected-owner-lease-changed');
    windows.withWindow(ownerWindow, () => {});sameActorClaim();
    if (publicationWitness) syncProfile('assertPublicationCurrent', profileHandle, publicationWitness);
    else if (publicationAttemptWitness) syncProfile('assertPublicationAttemptCurrent', profileHandle, publicationAttemptWitness);
    else syncProfile('assertActivityAdmission', profileHandle, r);
  }
  function enter(fn) {
    const run = () => contexts.run(scope, fn);
    return coordinationClosed ? run() : windows.withWindow(ownerWindow, run);
  }
  function checkedPublication(witness, pending = false) {
    const native = require('./forge-native-execution');
    const method = pending ? 'assertOriginalPublicationAttemptWitness' : 'assertOriginalPublicationWitness';
    if (typeof native[method] !== 'function') fail('native-owner-publication-producer-unavailable');
    const proof = native[method](witness, { request: r });
    if (!proof || proof.dispatch_id !== r.dispatchId || proof.request_sha256 !== requestSha
        || !/^[a-f0-9]{64}$/.test(proof.result_sha256 || '') || !Array.isArray(proof.artifacts)
        || proof.manifest?.file !== r.resultFile + '.manifest.json'
        || !/^[a-f0-9]{64}$/.test(proof.manifest?.sha256 || '')
        || !/^[a-f0-9]{64}$/.test(proof.receipt?.sha256 || '')
        || proof.receipt.file !== r.resultFile + '.receipt.json.' + proof.receipt.sha256 + '.json') fail('native-owner-publication-binding');
    const seen = new Set();
    for (const item of proof.artifacts) {
      if (!item || typeof item.path !== 'string' || !item.path.startsWith('.gsd/') || item.path.includes('\\')
          || path.posix.normalize(item.path) !== item.path
          || !roots.within(owner, path.resolve(owner, item.path)) || path.resolve(owner, item.path) === owner
          || seen.has(item.path) || !/^[a-f0-9]{64}$/.test(item.after_sha256 || '')
          || !(item.before === null || /^[a-f0-9]{64}$/.test(item.before))) fail('native-owner-publication-artifact');
      seen.add(item.path);
      if (ownerBefore && (ownerBefore[item.path] ?? null) !== item.before) fail('native-owner-publication-preimage');
    }
    return proof;
  }
  function publicationIdentity(proof) {
    return roots.digest({ dispatch_id: proof.dispatch_id, request_sha256: proof.request_sha256,
      result_sha256: proof.result_sha256, manifest: proof.manifest, receipt: proof.receipt, artifacts: proof.artifacts });
  }
  function projectedOwner(before) {
    const expected = { ...before, [relative]: expectedLease };
    const proof = publication || publicationAttempt, pending = !publication;
    const current = proof && pending ? execution.protectedSnapshot(owner) : null;
    if (proof) for (const item of proof.artifacts) {
      const value = before[item.path] ?? null;
      if (value !== item.before && value !== item.after_sha256) fail('native-owner-publication-baseline-unbound');
      const admitted = pending ? current[item.path] ?? null : item.after_sha256;
      if (pending && admitted !== item.before && admitted !== item.after_sha256) fail('native-owner-publication-readback');
      if (admitted === null) delete expected[item.path];else expected[item.path] = admitted;
      let directory = path.posix.dirname(item.path);
      while (directory !== '.') {
        if (before[directory + '/'] !== undefined && before[directory + '/'] !== 'directory') fail('native-owner-publication-directory');
        if (!pending || current[directory + '/'] !== undefined) {
          if (pending && current[directory + '/'] !== 'directory') fail('native-owner-publication-directory');
          expected[directory + '/'] = 'directory';
        }
        directory = path.posix.dirname(directory);
      }
    }
    return expected;
  }
  function assertOwnerSurface() { if (ownerBefore) execution.assertProtected(owner, projectedOwner(ownerBefore)); }
  function readJoinedCustody() {
    const observed = publicationWitness
      ? syncProfile('assertPublicationCurrent', profileHandle, publicationWitness)
      : publicationAttemptWitness ? syncProfile('assertPublicationAttemptCurrent', profileHandle, publicationAttemptWitness)
      : syncProfile('assertJoined', profileHandle);
    if (!observed || observed.joined !== true || !Buffer.isBuffer(observed.raw)
        || !/^[a-f0-9]{64}$/.test(observed.candidate_sha256 || '')) fail('protected-owner-writer-unproven');
    const parsed = require('./forge-worker-result').parseJsonEnvelope(observed.raw.toString('utf8'));
    if (!parsed.ok || parsed.status !== parsed.payload?.status
        || !require('./forge-native-recovery-delivery').resultContract.validate(parsed.payload).ok) fail('native-owner-return-contract');
    const custody = Object.freeze({ candidate_sha256: observed.candidate_sha256,
      raw_sha256: sha(observed.raw), result_sha256: roots.digest(parsed.payload) });
    if (joinedCustody && roots.digest(custody) !== roots.digest(joinedCustody)) fail('native-owner-joined-custody-changed');
    return custody;
  }
  windows.withMutation(owner, () => {
    sameActorClaim();
    leaseWindow = lease.openProtectedWindow(owner, unit, token, generation, { durationMs: duration.duration_ms, reuseExisting: true });
    if (!leaseWindow.ok) fail('protected-owner-lease-window-refused');
    expectedLease = sha(regular(leaseFile));knownLeaseHashes.add(expectedLease);
    try {
      const currentRelay = relayReference(syncProfile('assertActivityAdmission', profileHandle, r));
      if (roots.digest(currentRelay) !== roots.digest(liveRelay)) fail('native-owner-live-relay-changed');
      ownerWindow = windows.open(owner, { kind: 'unit-execution', task_id: runId,
        coordination: 'native-host-profile-v1', host_runtime: actor.hostRuntime, host_session_sha256: roots.digest(actor.sessionId),
        dispatch_id: r.dispatchId, request_sha256: requestSha, unit_key: unit,
        request_fingerprint: require('./forge-unit-sidecar').artifactFingerprint(r), recovery_identity_sha256: roots.digest(identity),
        result_file_sha256: roots.digest(path.resolve(r.resultFile)), begin_key: begin.idempotency_key, begin_sha256: beginSha,
        lease_generation: generation, owner_token_sha256: sha(token), lease_deadline_at: leaseWindow.deadline_at,
        ...(liveRelay ? { native_host_relay: liveRelay } : {}) });
    } catch (error) { leaseWindow.close();throw error; }
  });
  const scope = Object.freeze({
    kind: 'native-execution', owner, unit, generation,
    spawn() { fail('native-owner-process-spawn-forbidden'); },
    async observeJoined(handle) {
      if (arguments.length !== 1 || handle !== profileHandle) fail('native-owner-profile-foreign');
      return enter(() => {
        assertLive();joinedCustody = readJoinedCustody();
        assertLive();return Object.freeze({ joined: true, reference: 'native-profile:' + r.dispatchId });
      });
    },
    async joinWriter() { if (arguments.length) fail('native-owner-join-arguments');return scope.observeJoined(profileHandle); },
    observePublicationAttempt(witness) {
      if (arguments.length !== 1) fail('native-owner-publication-attempt-arguments');
      return enter(() => {
        if (settling || settled || coordinationClosed || leaseClosed || !leaseWindow?.heartbeat().ok
            || !joinedCustody || publicationWitness) fail('native-owner-publication-attempt-state');
        const proof = checkedPublication(witness, true);sameActorClaim(proof, true);
        if (proof.result_sha256 !== joinedCustody.result_sha256) fail('native-owner-publication-return-mismatch');
        if (publicationAttemptWitness && (publicationAttemptWitness !== witness
            || publicationIdentity(proof) !== publicationIdentity(publicationAttempt))) fail('native-owner-publication-attempt-conflict');
        // Seal only genuine ready facts before reentering Request/Profile. This
        // private transition admits no unknown delta and never closes a window.
        publicationAttemptWitness = witness;publicationAttempt = proof;
        syncProfile('assertPublicationAttemptCurrent', profileHandle, witness);
        assertLive();readJoinedCustody();assertOwnerSurface();
        return Object.freeze({ pending: true, reference: 'native-ready-pending:' + r.dispatchId });
      });
    },
    async observePublication(witness) {
      if (arguments.length !== 1) fail('native-owner-publication-arguments');
      return enter(() => {
        if (settling || coordinationClosed || !joinedCustody) fail('native-owner-joined-custody-required');
        const proof = checkedPublication(witness);sameActorClaim(proof, false);
        if (proof.result_sha256 !== joinedCustody.result_sha256) fail('native-owner-publication-return-mismatch');
        if (publicationAttempt && publicationIdentity(proof) !== publicationIdentity(publicationAttempt)) fail('native-owner-publication-upgrade-mismatch');
        syncProfile('assertPublicationCurrent', profileHandle, witness);
        if (publicationWitness && publicationWitness !== witness) fail('native-owner-publication-witness-changed');
        publicationWitness = witness;publication = proof;assertLive();assertOwnerSurface();
        return Object.freeze({ admitted: true, reference: 'native-publication:' + r.dispatchId });
      });
    },
    assertReplayAdmission() {
      if (arguments.length) fail('native-owner-replay-arguments');
      return enter(() => {
        // Replay writes still belong inside this live window. An already closed
        // activity needs its own canonical replay window, not a saved JSON flag.
        if (settled || coordinationClosed || leaseClosed) fail('native-owner-replay-window-required');
        assertLive();readJoinedCustody();assertOwnerSurface();assertLive();
        return Object.freeze({ joined: true, reference: 'native-replay-admission:' + r.dispatchId });
      });
    },
    async reconcile() {
      if (arguments.length) fail('native-owner-reconcile-arguments');
      return enter(async () => {
        assertLive();
        if (publicationWitness) {
          const proof = checkedPublication(publicationWitness);
          if (roots.digest(proof) !== roots.digest(publication)) fail('native-owner-publication-changed');
          syncProfile('assertPublicationCurrent', profileHandle, publicationWitness);
        } else if (publicationAttemptWitness) {
          const proof = checkedPublication(publicationAttemptWitness, true);
          if (publicationIdentity(proof) !== publicationIdentity(publicationAttempt)) fail('native-owner-publication-attempt-conflict');
          syncProfile('assertPublicationAttemptCurrent', profileHandle, publicationAttemptWitness);readJoinedCustody();
        } else await scope.observeJoined(profileHandle);
        assertLive();assertOwnerSurface();return Object.freeze({ joined: true, reference: 'native-custody:' + r.dispatchId });
      });
    },
    verificationWindow(seal) {
      if (!joinedCustody || publicationWitness || publicationAttemptWitness) fail('protected-owner-writer-unproven');assertLive();
      const commands = Array.isArray(seal?.roots) ? seal.roots.reduce((sum, root) => sum + (root.commands?.length || 0), 0) : 0;
      if (!Number.isSafeInteger(seal?.command_timeout_ms) || seal.command_timeout_ms <= 0) fail('protected-owner-verification-window-invalid');
      const wanted = timeout.protectedWindowMs(Math.max(1, commands) * seal.command_timeout_ms);
      if (!wanted.covers) fail('protected-owner-verification-window-limit');
      if (leaseWindow.borrowed) { if (leaseWindow.deadline_at - Date.now() < wanted.duration_ms) fail('protected-owner-verification-window-limit');return; }
      windows.withMutation(owner, () => {
        leaseWindow.close();leaseWindow = lease.openProtectedWindow(owner, unit, token, generation, { durationMs: wanted.duration_ms });
        if (!leaseWindow.ok) fail('protected-owner-lease-window-refused');
        expectedLease = sha(regular(leaseFile));knownLeaseHashes.add(expectedLease);
      });
    },
    expectedOwner(root, before) {
      if (roots.key(fs.realpathSync.native(root)) !== roots.key(owner)) return before;
      if (!before || !knownLeaseHashes.has(before[relative])) fail('protected-owner-baseline-unbound');
      assertLive();return projectedOwner(before);
    },
    projectPublicationLease(root, before) {
      // Internal read-side producer for Request's original owner snapshot. It
      // deliberately never calls Profile/Request/expectedOwner, avoiding cycles.
      if (arguments.length !== 2 || roots.key(fs.realpathSync.native(root)) !== roots.key(owner)
          || !before || !knownLeaseHashes.has(before[relative])) fail('native-owner-lease-projection-unbound');
      return enter(() => {
        sameActorClaim();
        if (!coordinationClosed) {
          if (leaseClosed || !leaseWindow?.heartbeat().ok) fail('protected-owner-lease-changed');
          windows.withWindow(ownerWindow, () => {});
        } else if (!settled || !leaseClosed || windows.observed(owner)) fail('native-owner-activity-not-settled');
        return { ...before, [relative]: expectedLease };
      });
    },
    async retrySettlement() {
      if (arguments.length) fail('native-owner-settlement-arguments');
      if (settled) return scope.assertSettled();
      if (settling) return settling;
      settling = enter(async () => {
        await scope.reconcile();
        if (publicationAttemptWitness && !publicationWitness) fail('native-owner-publication-pending');
        windows.close(ownerWindow, challenge => {
          assertLive();if (!joinedCustody) fail('protected-owner-writer-unproven');
          return { challenge_sha256: roots.digest(challenge), joined: true, possible_writers: 0,
            reference: 'native-execution:' + r.dispatchId + ':actual-profile-join' };
        });coordinationClosed = true;
        const closedLease = leaseWindow.close();leaseClosed = true;
        if (!closedLease.ok) fail('native-owner-lease-settlement-refused');
        sameActorClaim();
        settled = true;scopes.delete(scope);return scope.assertSettled();
      });
      try { return await settling; } finally { settling = null; }
    },
    assertSettled() {
      if (arguments.length || !settled || !coordinationClosed || !leaseClosed || publicationAttemptWitness && !publicationWitness) fail('native-owner-activity-not-settled');
      sameActorClaim();if (windows.observed(owner)) fail('native-owner-new-window');
      if (publicationWitness) { checkedPublication(publicationWitness);syncProfile('assertPublicationCurrent', profileHandle, publicationWitness); }
      else readJoinedCustody();
      assertOwnerSurface();
      return true;
    },
  });
  scopes.add(scope);
  let value, failure;
  try { value = await enter(() => { ownerBefore = execution.protectedSnapshot(owner);return action(scope); }); }
  catch (error) { failure = error; }
  try {
    // A failed action may have retained a ready receipt. Keep its exact live
    // custody/window for real replay; only retrySettlement after its readback can
    // close it. Failure never becomes no-spawn/join or a synthetic publication.
    if (failure) throw failure;
    if (value?.published === true && !publicationWitness) fail('native-owner-publication-witness-required');
    await scope.retrySettlement();
  } catch (error) {
    if (!failure) failure = error;
    failure.owner_window = { status: coordinationClosed ? 'closed-lease-unsettled' : 'held',
      reason_code: error.code || 'protected-owner-writer-unproven', possible_native_writers: joinedCustody ? 'observed-joined' : 'unknown' };
  }
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
  const reviewed = changes.filter(row => !carriers.has(row.path) && row.path !== '.gsd/forge/questions/' && !hookPaths.has(row.path));
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
// Historical questions are reviewed DATA, never a source of live authority.
// Owner-origin identity omits dispatch/fingerprint/receipt phase, so no exact
// historical attempt or machine provenance is inferred from the opaque digest.
function historicalDecisionRecord(view, relative, pins) {
  const match = /^\.gsd\/forge\/questions\/([a-f0-9]{64})(?:\.origin)?\.json$/.exec(relative);
  if (!match) return false;
  const hash = match[1];
  if (pins.has(hash)) { checkHistoricalDecisionRecords(view, pins); return true; }
  const names = [`.gsd/forge/questions/${hash}.json`, `.gsd/forge/questions/${hash}.origin.json`];
  if (names.some(file => view.carriers.has(file))) return false;
  const rows = [];
  for (const file of names) {
    const change = view.changes.find(row => row.path === file);
    const reviewed = view.reviewed.find(row => row.path === file);
    if (!change || !reviewed || !change.after || change.after !== reviewed.after
        || change.before !== reviewed.before || view.current[file] !== change.after) return false;
    const bytes = regular(path.join(view.owner, file));
    if (sha(bytes) !== change.after) fail('owner-reconciliation-observation-changed');
    rows.push({ relative: file, bytes });
  }
  const state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rows[0].bytes));
  const answer = require('./forge-pending-questions').continuation({ cwd: view.owner, identity: hash });
  const identity = answer.identity, r = view.r;
  if (!answer.ok || identity?.origin !== 'owner' || roots.digest(identity) !== hash
      || identity.unit !== `execute-task/${r.taskId}` || identity.milestone !== r.milestoneId
      || identity.slice !== (r.sliceId ?? null) || identity.task !== r.taskId || identity.workflow_id !== r.milestoneId
      || identity.dispatch_id !== null || identity.request_fingerprint !== null || identity.receipt_phase !== null) return false;
  const purpose = /^(owner-delta|code-root-append)\/([a-f0-9]{64})$/.exec(identity.decision_set || '');
  const questionId = purpose?.[1] === 'owner-delta' ? 'owner-delta-approval' : 'code-root-append-approval';
  if (!purpose || answer.questions?.length !== 1 || answer.questions[0].id !== questionId
      || answer.questions[0].status !== 'resolved' || !answer.questions[0].question.includes(purpose[2])
      || roots.digest(answer.questions) !== roots.digest(state.questions)) return false;
  // Response polarity deliberately supplies no authority. The already validated
  // CURRENT owner approval covers both exact hashes, which stay in reviewed.
  pins.set(hash, { rows, questions_sha256: roots.digest(answer.questions) });
  checkHistoricalDecisionRecords(view, pins);
  return true;
}
function checkHistoricalDecisionRecords(view, pins) {
  for (const [hash, proof] of pins) {
    const unchanged = () => proof.rows.every(row => regular(path.join(view.owner, row.relative)).equals(row.bytes));
    if (!unchanged()) fail('owner-reconciliation-observation-changed');
    // The canonical reader also refuses links/aliases, malformed origins and
    // incomplete question state; byte pins prevent a later answer mutation.
    const answer = require('./forge-pending-questions').continuation({ cwd: view.owner, identity: hash });
    if (!answer.ok || roots.digest(answer.identity) !== hash
        || roots.digest(answer.questions) !== proof.questions_sha256 || !unchanged()) fail('owner-reconciliation-observation-changed');
  }
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
  const historicalPins = new Map();
  let stateHash = sha(view.stateBytes);
  function live(acceptReset = false) {
    checkHistoricalDecisionRecords(view, historicalPins);
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
          && !/^\.gsd\/forge\/evidence[-~][A-Za-z0-9_.~-]+\.jsonl$/.test(change.path)
          && !historicalDecisionRecord(view, change.path, historicalPins)) fail('owner-reconciliation-operator-decision-required');
    } else if (row.kind === 'decision-record') {
      if (!operatorApproved || !historicalDecisionRecord(view, change.path, historicalPins)) fail('owner-reconciliation-operator-decision-required');
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
module.exports = { withExecutionActivity, withNativeExecutionActivity, currentScope, assertPreflightAdmission, expectedProtectedOwner, reconciliationDecision,
  createOwnerReconciliation, assertOwnerReconciliationReady, withOwnerReconciliation, withReconciliationHandoff,
  codeRootAppendDecision, withOwnerReconciliationRead,
  resumeAttemptOwner, inspectAttemptResume, hookAppendProof };
