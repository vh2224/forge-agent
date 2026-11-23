'use strict';

// Trusted host composition, not a CLI authorization channel. A committed
// completion is immutable; current verification gets a distinct real lineage.
const fs = require('fs'), path = require('path');
const controller = require('./forge-unit-controller');
const roots = require('./forge-code-roots');
const claims = require('./forge-write-claim');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const digest = roots.digest;
const resumeInputs = new WeakSet();
const preparedResumes = new WeakMap();
const baselinePublishers = new WeakMap();
const trustedRepairProofInputs = new WeakSet();
const tokenDigest = token => require('crypto').createHash('sha256').update(token.normalize('NFC').trim()).digest('hex');

function readBaseline(file) {
  let stat;
  try { stat = fs.lstatSync(file, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > 4n * 1024n * 1024n) fail('delivery-repair-baseline-invalid');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) fail('delivery-repair-baseline-changed');
    const bytes = fs.readFileSync(fd), after = fs.lstatSync(file, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino
        || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs) fail('delivery-repair-baseline-changed');
    try { return JSON.parse(bytes); } catch { fail('delivery-repair-baseline-invalid'); }
  } finally { fs.closeSync(fd); }
}

function persistBaseline(cwd, file, value) {
  require('./forge-owner-transport-window').withMutation(cwd, () => {
    if (!readBaseline(file)) {
      const bytes = JSON.stringify(value) + '\n';
      if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) fail('delivery-repair-baseline-invalid');
      fs.writeFileSync(file, bytes, { flag: 'wx' });
    }
    if (digest(readBaseline(file)) !== digest(value)) fail('delivery-repair-baseline-changed');
  });
}

function createRepair(options = {}) {
  return constructRepair(options, false);
}
// Only inspectRetainedClaimResume can request an inactive read-only preflight;
// that function returns scope alone, never this object's start/complete methods.
function constructRepair(options, inactivePreflight, adoptionActor = null) {
  const { assertAuthority, attestStoppedWriter, readPendingQuestions } = options;
  if (![assertAuthority, attestStoppedWriter, readPendingQuestions].every(fn => typeof fn === 'function')) fail('delivery-repair-live-adapter-required');
  const cwd = fs.realpathSync.native(options.cwd), { milestone, slice, task, runId, ownerToken, hostRuntime } = options;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(milestone || '') || !/^S\d{2,}$/.test(slice || '')
      || !/^T\d+(?:\.\d+)?$/.test(task || '') || typeof runId !== 'string' || !runId
      || typeof ownerToken !== 'string' || !ownerToken.trim() || ownerToken.includes('\0') || !['claude', 'codex'].includes(hostRuntime)) fail('delivery-repair-scope-invalid');
  const contract = roots.validateContract(options.executionContract, { owner: cwd, revalidate: true });
  const originalBegin = controller.lookupRecord(cwd, 'transaction', options.beginKey);
  const originalComplete = controller.lookupRecord(cwd, 'transaction', options.completionKey);
  const unit = `execute-task/${task}`;
  if (!originalBegin || !originalComplete || originalBegin.batch || originalComplete.batch
      || originalBegin.action !== 'begin' || originalComplete.action !== 'complete'
      || originalBegin.phase !== 'committed' || originalComplete.phase !== 'committed'
      || originalBegin.unit?.key !== unit || originalComplete.unit?.key !== unit
      || originalBegin.milestone !== milestone || originalComplete.milestone !== milestone
      || originalBegin.after?.state?.active_slice !== slice || originalComplete.after?.state?.active_slice !== slice
      || originalBegin.owner_digest !== originalComplete.owner_digest || originalBegin.host_runtime !== originalComplete.host_runtime
      || originalBegin.lease_generation !== originalComplete.lease_generation || originalComplete.result?.status !== 'succeeded'
      || originalComplete.boundary?.kind !== 'completed' || originalComplete.boundary.handoff_ready !== true) fail('delivery-repair-original-lineage-invalid');
  const originalHash = digest({ begin: originalBegin, complete: originalComplete });
  const prefix = `forge-delivery-verification:${originalHash}:`;
  const planFile = path.join(cwd, '.gsd', 'milestones', milestone, 'slices', slice, 'tasks', task, `${task}-PLAN.md`);
  function planHash() {
    let cursor = cwd;
    for (const segment of path.relative(cwd, planFile).split(path.sep)) {
      cursor = path.join(cursor, segment);
      if (fs.lstatSync(cursor).isSymbolicLink()) fail('delivery-repair-plan-linked');
    }
    const stat = fs.statSync(planFile);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) fail('delivery-repair-plan-invalid');
    return require('crypto').createHash('sha256').update(fs.readFileSync(planFile)).digest('hex');
  }
  const planSha = planHash();
  const baselineFile = path.join(path.dirname(planFile), `.delivery-verification-${originalHash}.json`);
  let saved = readBaseline(baselineFile);
  const existingBeginKey = saved ? prefix + digest(saved) : null;
  const alreadyComplete = () => existingBeginKey && controller.lookupRecord(cwd, 'transaction', existingBeginKey + ':complete')?.phase === 'committed';
  const run = () => require('./forge-runs').get(cwd, runId);
  function currentClaim() {
    const record = run();let claim = claims.readClaim(record);
    // Completed repairs can be admitted read-only after their original claim
    // was released. Never re-acquire it or mint another begin from this state.
    if (adoptionActor && alreadyComplete() && claim?.released) claim = { ...claim, released: null };
    if (!(record?.active === true || inactivePreflight && record?.active === false) || !claims.isHeld(claim) || !claim.paths?.length) fail('delivery-repair-claim-required');
    claims.validateHeldClaim(claim);
    const primary = contract.code_roots.find(root => root.id === contract.primary_root_id);
    if (claim.schema_version === 2 ? digest(claim.execution_contract) !== digest(contract)
      : contract.code_roots.length !== 1 || !claim.code_dir || roots.key(fs.realpathSync.native(claim.code_dir)) !== roots.key(primary.path)) fail('delivery-repair-claim-roots-mismatch');
    return digest(claim);
  }
  const claimSha = currentClaim();
  function snapshot() {
    return contract.code_roots.map(root => ({ id: root.id,
      snapshot: require('./forge-surgical-reset').captureAttemptSnapshot(root.path) }));
  }
  const identity = { original_sha256: originalHash, plan_sha256: planSha, claim_sha256: claimSha, execution_contract_sha256: digest(contract),
    run_id: runId, host_runtime: hostRuntime, owner_digest: tokenDigest(ownerToken) };
  if (!saved) {
    if (controller.readEvents(controller.eventsFile(cwd, milestone)).some(event => event.idempotency_key?.startsWith(prefix))) fail('delivery-repair-baseline-missing');
    const measured = snapshot();
    saved = { schema_version: 1, kind: 'current-delivery-verification-baseline', identity, baseline: measured,
      baseline_sha256: digest(measured), created_at: new Date().toISOString() };
  }
  const expectedIdentity = adoptionActor ? { ...identity, owner_digest: saved.identity?.owner_digest } : identity;
  if (saved.schema_version !== 1 || saved.kind !== 'current-delivery-verification-baseline' || digest(saved.identity) !== digest(expectedIdentity)
      || !/^[a-f0-9]{64}$/.test(saved.identity?.owner_digest || '')
      || Object.keys(saved).sort().join('|') !== ['schema_version','kind','identity','baseline','baseline_sha256','created_at'].sort().join('|')
      || !Number.isFinite(Date.parse(saved.created_at)) || !Array.isArray(saved.baseline) || saved.baseline_sha256 !== digest(saved.baseline)) fail('delivery-repair-baseline-invalid');
  const stateSha = digest(saved), baseline = saved.baseline_sha256, beginKey = prefix + stateSha;
  const retainedBegin = controller.lookupRecord(cwd, 'transaction', beginKey);
  if (retainedBegin && (retainedBegin.action !== 'begin' || retainedBegin.phase !== 'committed'
      || retainedBegin.unit?.key !== unit || retainedBegin.milestone !== milestone
      || retainedBegin.after?.state?.active_slice !== slice || retainedBegin.host_runtime !== hostRuntime)) fail('delivery-repair-baseline-changed');
  // Raw legacy tokens remain inside this closure, after lineage and live host
  // validation. A digest is never reversed into a token. No-lease completion
  // is a proof/replay path, not a fresh controller write.
  let executionToken = ownerToken;
  if (adoptionActor && retainedBegin && !alreadyComplete()) {
    const lease = controller.dependencies.forgeLease;
    let held;try { held=readBaseline(lease.leaseFile(cwd, unit)); } catch { fail('delivery-repair-retained-lease-invalid'); }
    if (!held || !lease.validRecord(held, unit)
        || held.generation !== retainedBegin.lease_generation || held.host_runtime !== hostRuntime
        || 'sha256:' + tokenDigest(held.owner_token) !== retainedBegin.owner_digest) fail('delivery-repair-retained-lease-invalid');
    executionToken = held.owner_token;
  }
  const oldEntries = controller.readEvents(controller.eventsFile(cwd, milestone)).filter(event => event.action === 'begin' && event.idempotency_key?.startsWith(prefix));
  if (oldEntries.some(event => event.idempotency_key !== beginKey)
      || controller.pendingTransactions(cwd).some(tx => tx.idempotency_key?.startsWith(prefix) && tx.idempotency_key !== beginKey)) fail('delivery-repair-baseline-changed');
  const scope = Object.freeze({ cwd, milestone, slice, task, run_id: runId, host_runtime: hostRuntime,
    original_begin_key: options.beginKey, original_completion_key: options.completionKey,
    original_sha256: originalHash, begin_key: beginKey, execution_contract_sha256: digest(contract), claim_sha256: claimSha,
    baseline_sha256: baseline, baseline_state_sha256: stateSha });
  const resumeScope = Object.freeze({ ...scope, unit, actor_digest: tokenDigest(ownerToken),
    baseline_owner_digest: saved.identity.owner_digest,
    repair_owner_digest: retainedBegin?.owner_digest || 'sha256:' + tokenDigest(executionToken),
    repair_generation: retainedBegin?.lease_generation || null });
  function live() {
    if (adoptionActor) {
      const observed = require('./forge-runs').observeHostSession(hostRuntime, adoptionActor.sessionId), record = run();
      if (!observed || observed.sessionId !== adoptionActor.sessionId || observed.source !== adoptionActor.source
          || !inactivePreflight && (record?.session_id !== observed.sessionId || record?.host_runtime !== hostRuntime || record?.active !== true)) fail('delivery-repair-authority-required');
    }
    let authorized, questions, stopped;
    try { authorized = assertAuthority(scope); } catch { fail('delivery-repair-authority-required'); }
    if (authorized !== undefined && authorized !== true) fail('delivery-repair-authority-required');
    try { questions = readPendingQuestions(scope); } catch { fail('delivery-repair-pending-questions'); }
    if (!Array.isArray(questions) || questions.some(q => q?.status !== 'resolved')) fail('delivery-repair-pending-questions');
    try { stopped = attestStoppedWriter(scope); } catch { fail('delivery-repair-writer-not-stopped'); }
    if (stopped !== true) fail('delivery-repair-writer-not-stopped');
    const state = readBaseline(baselineFile);
    if (state ? digest(state) !== stateSha : controller.lookupRecord(cwd, 'transaction', beginKey)) fail('delivery-repair-baseline-changed');
    roots.validateContract(contract, { owner: cwd, revalidate: true });
    if (currentClaim() !== claimSha || planHash() !== planSha
      || digest({ begin: controller.lookupRecord(cwd, 'transaction', options.beginKey), complete: controller.lookupRecord(cwd, 'transaction', options.completionKey) }) !== originalHash) fail('delivery-repair-original-changed');
    const events = controller.readEvents(controller.eventsFile(cwd, milestone));
    for (const tx of [originalBegin, originalComplete, ...(retainedBegin ? [retainedBegin] : [])]) {
      const found = events.filter(event => event.idempotency_key === tx.idempotency_key);
      if (found.length !== 1) fail('delivery-repair-original-event-invalid');
      const content = { ...found[0] }; delete content.sequence;
      if (digest(content) !== digest(tx.event)) fail('delivery-repair-original-event-invalid');
    }
    if (adoptionActor && alreadyComplete()) {
      const proofOptions={cwd,milestone,hostRuntime,ownerToken,repairBeginKey:beginKey,
        block:{begin_key:options.beginKey,completion_key:options.completionKey,completion_sha256:controller.recordChecksum(originalComplete)}};
      trustedRepairProofInputs.add(proofOptions);
      try { verifyRepairCompletion(proofOptions); } finally { trustedRepairProofInputs.delete(proofOptions); }
    }
  }
  live();
  function stable() { live(); if (digest(snapshot()) !== baseline) fail('delivery-repair-code-changed'); }
  stable();
  const txOptions = { ...(options.controllerOptions || {}) };
  const callerFailpoint = txOptions.failpoint;
  txOptions.failpoint = stage => { const result = callerFailpoint?.(stage); stable(); return result; };
  function start() {
    stable();
    persistBaseline(cwd, baselineFile, saved);
    stable();
    const completed = controller.lookupRecord(cwd, 'transaction', beginKey + ':complete');
    if (completed?.phase === 'committed') return { status: 'completed', begin_key: beginKey, completion_key: beginKey + ':complete', implementation_reexecuted: false };
    const begun = controller.beginSerial(cwd, { milestone, unit, slice, host_runtime: hostRuntime, owner_token: executionToken,
      idempotency_key: beginKey, state_patch: { active_slice: slice } }, txOptions);
    if (!begun.ok) fail('delivery-repair-begin-refused');
    return { status: 'verification-required', action: 'verify-only', begin_key: beginKey,
      completion_key: beginKey + ':complete', original_sha256: originalHash, implementation_reexecuted: false };
  }
  function complete() {
    stable();
    const begin = controller.lookupRecord(cwd, 'transaction', beginKey);
    if (!begin || begin.phase !== 'committed') fail('delivery-repair-begin-required');
    if (adoptionActor && alreadyComplete()) {
      verifyRepairCompletion({cwd,milestone,hostRuntime,ownerToken,repairBeginKey:beginKey,
        block:{begin_key:options.beginKey,completion_key:options.completionKey,completion_sha256:controller.recordChecksum(originalComplete)}});
      return { status: 'completed', begin_key: beginKey, completion_key: beginKey + ':complete', implementation_reexecuted: false };
    }
    const now = typeof txOptions.now === 'function' ? txOptions.now() : Date.now();
    const proof = require('./forge-milestone-time-clock').readCurrentTaskDelivery({ cwd, milestone, slice, task, begunAt: begin.created_at, completedAt: now });
    if (proof.status !== 'proven' || proof.captures.some(c => Date.parse(c.captured_at) < Date.parse(begin.created_at))) fail('delivery-repair-current-capture-required');
    stable();
    return require('./forge-orchestrate').run('complete', { cwd, milestone, unit, host_runtime: hostRuntime, owner_token: executionToken,
      begin_key: beginKey, result: { status: 'done', summary: 'Current owner verification and delivery only; original execution retained.',
        provider_called: false, implementation_reexecuted: false, original_completion_sha256: digest(originalComplete) } }, txOptions);
  }
  const repair=Object.freeze({ scope: adoptionActor ? resumeScope : scope, start, complete });
  baselinePublishers.set(repair,Object.freeze({assert:stable,publish:()=>{stable();persistBaseline(cwd,baselineFile,saved);stable();}}));
  return repair;
}

// Read-only admission of a scoped actor binding published by the fenced live
// bridge. A history row alone grants no writer capability or default-token
// authority: the current host observation, roots, claim and plan must agree.
function repairActorBinding(options, baseline, fresh) {
  try {
    const runs = require('./forge-runs'), run = runs.get(options.cwd, baseline.identity.run_id);
    const actor = runs.observeHostSession(options.hostRuntime,run?.session_id);
    if (!actor || !run?.active || run.session_id !== actor.sessionId || run.host_runtime !== actor.hostRuntime
        || options.ownerToken !== actor.sessionId && !(options.allowDefaultOwnerToken === true && options.ownerToken === 'forge-orchestrate')) return null;
    let claim = claims.readClaim(run);
    if (claim?.released) claim = {...claim,released:null};
    claims.validateHeldClaim(claim);
    if (digest(claim) !== baseline.identity.claim_sha256) return null;
    let contract;
    if(claim.schema_version===2) contract=roots.validateContract(claim.execution_contract,{owner:options.cwd,revalidate:true});
    else {
      if(baseline.baseline?.length!==1 || roots.key(fs.realpathSync.native(claim.code_dir))!==roots.key(fs.realpathSync.native(baseline.baseline[0].snapshot.code_dir)))return null;
      const id=baseline.baseline[0].id;
      contract=roots.validateContract({schema_version:2,owner:options.cwd,primary_root_id:id,code_roots:[{id,path:claim.code_dir}]});
    }
    if (digest(contract) !== baseline.identity.execution_contract_sha256) return null;
    const plan = path.join(options.cwd,'.gsd/milestones',options.milestone,'slices',fresh.after.state.active_slice,'tasks',fresh.unit.id,fresh.unit.id+'-PLAN.md');
    let cursor=options.cwd;for(const part of path.relative(options.cwd,plan).split(path.sep)){cursor=path.join(cursor,part);if(fs.lstatSync(cursor).isSymbolicLink())return null;}
    if(digest(fs.readFileSync(plan))!==baseline.identity.plan_sha256)return null;
    return (run.owner_resume_history || []).findLast(row => {
      const scope=row.boundary?.delivery_repair;
      return row.mechanism==='trusted-caller-attestation-v1' && row.workspace_quiescent_attested===true
        && ['same-owner-reactivation','stopped-owner-transfer'].includes(row.kind)
        && row.current_session_sha256===digest(actor.sessionId) && row.current_host_runtime===actor.hostRuntime
        && scope?.begin_key===fresh.idempotency_key && scope.run_id===run.id && scope.milestone===options.milestone
        && roots.key(scope.cwd)===roots.key(fs.realpathSync.native(options.cwd))
        && scope.actor_digest===tokenDigest(actor.sessionId) && scope.host_runtime===actor.hostRuntime
        && scope.baseline_state_sha256===digest(baseline) && scope.baseline_sha256===baseline.baseline_sha256
        && scope.baseline_owner_digest===baseline.identity.owner_digest && scope.repair_owner_digest===fresh.owner_digest
        && (scope.repair_generation===null || scope.repair_generation===fresh.lease_generation)
        && scope.original_sha256===baseline.identity.original_sha256 && scope.claim_sha256===baseline.identity.claim_sha256
        && scope.execution_contract_sha256===baseline.identity.execution_contract_sha256;
    })?.boundary.delivery_repair || null;
  } catch { return null; }
}

// Read-only administrative admission. A locator/snapshot never supplies proof:
// re-read the canonical records, published events, saved baseline and delivery.
function verifyRepairCompletion(options = {}) {
  return verifyCompletedRepair(options, false);
}

// Selection consumes a historical fact, never a writer capability. A later
// task owns a different claim and a later owner has a different session; neither
// changes the committed verification-only successor. Keep this mode private so
// resume/publication callers retain the live actor checks above.
function verifyCompletedRepair(options, historical) {
  const cwd = fs.realpathSync.native(options.cwd), block = options.block;
  if (!block || typeof options.repairBeginKey !== 'string' || !historical && (typeof options.ownerToken !== 'string'
      || !options.ownerToken.trim() || !['claude','codex'].includes(options.hostRuntime))
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.milestone || '')) fail('delivery-recovery-unproven');
  const begin = controller.lookupRecord(cwd, 'transaction', block.begin_key), old = controller.lookupRecord(cwd, 'transaction', block.completion_key);
  if (!begin || !old || begin.action !== 'begin' || begin.phase !== 'committed' || begin.unit?.type !== 'execute-task'
      || !/^T\d+(?:\.\d+)?$/.test(begin.unit.id || '') || !/^S\d{2,}$/.test(begin.after?.state?.active_slice || '')
      || old.action !== 'complete' || old.phase !== 'committed' || old.boundary?.kind !== 'completed' || old.boundary.handoff_ready !== true
      || old.milestone !== options.milestone || begin.milestone !== old.milestone || begin.unit.key !== old.unit?.key
      || begin.lease_generation !== old.lease_generation || begin.owner_digest !== old.owner_digest || begin.host_runtime !== old.host_runtime
      || controller.recordChecksum(old) !== block.completion_sha256) fail('delivery-recovery-original-changed');
  const original = digest({ begin, complete: old }), prefix = `forge-delivery-verification:${original}:`;
  if (!options.repairBeginKey.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(options.repairBeginKey.slice(prefix.length))) fail('delivery-recovery-unproven');
  const fresh = controller.lookupRecord(cwd, 'transaction', options.repairBeginKey), complete = controller.lookupRecord(cwd, 'transaction', options.repairBeginKey + ':complete');
  const owner = historical ? null : tokenDigest(options.ownerToken);
  if (!fresh || !complete || fresh.action !== 'begin' || complete.action !== 'complete' || fresh.phase !== 'committed' || complete.phase !== 'committed'
      || fresh.milestone !== begin.milestone || fresh.unit?.key !== begin.unit.key || complete.unit?.key !== fresh.unit.key
      || fresh.after?.state?.active_slice !== begin.after.state.active_slice || complete.after?.state?.active_slice !== begin.after.state.active_slice
      || !historical && fresh.host_runtime !== options.hostRuntime || complete.host_runtime !== fresh.host_runtime
      || complete.owner_digest !== fresh.owner_digest || complete.lease_generation !== fresh.lease_generation
      || complete.result?.status !== 'succeeded' || complete.boundary?.kind !== 'completed' || complete.boundary.handoff_ready !== true) fail('delivery-recovery-unproven');
  const directory = path.join(cwd, '.gsd', 'milestones', begin.milestone, 'slices', begin.after.state.active_slice, 'tasks', begin.unit.id);
  const baseline = readBaseline(path.join(directory, `.delivery-verification-${original}.json`));
  if (!baseline || digest(baseline) !== options.repairBeginKey.slice(prefix.length) || baseline.identity?.original_sha256 !== original
      || baseline.identity?.host_runtime !== fresh.host_runtime || baseline.schema_version !== 1
      || baseline.kind !== 'current-delivery-verification-baseline' || !Array.isArray(baseline.baseline)
      || baseline.baseline_sha256 !== digest(baseline.baseline) || !Number.isFinite(Date.parse(baseline.created_at))
      || !['owner_digest','plan_sha256','claim_sha256','execution_contract_sha256'].every(key => /^[a-f0-9]{64}$/.test(baseline.identity[key] || ''))
      || typeof baseline.identity.run_id !== 'string' || !baseline.identity.run_id) fail('delivery-recovery-baseline-unproven');
  const actorBinding = historical ? historicalRepairBinding(options, baseline, fresh) : repairActorBinding(options, baseline, fresh);
  const boundRun = require('./forge-runs').get(cwd, baseline.identity.run_id);
  const bindingRequired = boundRun?.owner_resume_history?.some(row=>row.boundary?.delivery_repair?.begin_key===fresh.idempotency_key);
  if (historical ? bindingRequired ? !actorBinding : fresh.owner_digest !== 'sha256:' + baseline.identity.owner_digest
    : !trustedRepairProofInputs.has(options) && (bindingRequired ? !actorBinding : fresh.owner_digest !== 'sha256:' + owner || baseline.identity.owner_digest !== owner)) fail('delivery-recovery-unproven');
  let events;
  try { events = controller.readEvents(controller.eventsFile(cwd, begin.milestone)); }
  catch { fail('delivery-recovery-event-unproven'); }
  const eventKeys = new Set();
  for (const [index,event] of events.entries()) {
    if (!event || event.sequence !== index + 1 || typeof event.idempotency_key !== 'string' || !event.idempotency_key
        || eventKeys.has(event.idempotency_key)) fail('delivery-recovery-event-unproven');
    eventKeys.add(event.idempotency_key);
  }
  const lineage = [];
  for (const pair of [[begin, old], [fresh, complete]]) {
    const published = pair.map(tx => {
      const rows = events.filter(event => event.idempotency_key === tx.idempotency_key);
      if (rows.length !== 1 || !Number.isSafeInteger(rows[0].sequence) || rows[0].sequence < 1) fail('delivery-recovery-event-unproven');
      const value = { ...rows[0] }; delete value.sequence;
      if (digest(value) !== digest(tx.event)) fail('delivery-recovery-event-unproven');
      return rows[0];
    });
    if (published[0].sequence >= published[1].sequence) fail('delivery-recovery-event-unproven');
    lineage.push(published);
  }
  if (lineage[0][1].sequence >= lineage[1][0].sequence) fail('delivery-recovery-event-unproven');
  const proof = require('./forge-milestone-time-clock').readHistoricalTaskDelivery({ cwd, milestone: begin.milestone,
    slice: begin.after.state.active_slice, task: begin.unit.id, completedAt: complete.event.ts });
  const binding = complete.result.output?.owner_delivery_proof;
  if (proof.status !== 'proven' || !binding || binding.begin_key !== fresh.idempotency_key || binding.begin_sha256 !== controller.recordChecksum(fresh)
      || binding.delivery_fingerprint !== proof.fingerprint || binding.current_source_conformity !== 'matched'
      || digest(binding.captures) !== digest(proof.captures.map(c => ({ reference: c.reference, sha256: c.sha256, captured_at: c.captured_at })))) fail('delivery-recovery-unproven');
  return { status: 'proven', original_completion_sha256: block.completion_sha256, repair_begin_key: fresh.idempotency_key,
    repair_completion_key: complete.idempotency_key, implementation_reexecuted: false };
}

// Validate the exact historical repair binding and the subsequent durable owner
// chain. Current claim/source/lease bytes are deliberately not an input. This
// read-only proof never admits a restart or supplies the previous owner's token.
function historicalRepairBinding(options, baseline, fresh) {
  const run = require('./forge-runs').get(options.cwd, baseline.identity.run_id), history = run?.owner_resume_history;
  if (!run || !Array.isArray(history)) return null;
  const bindings = history.map((row, index) => ({ row, index })).filter(({ row }) => {
    const scope = row.boundary?.delivery_repair;
    return row.mechanism === 'trusted-caller-attestation-v1' && row.workspace_quiescent_attested === true
      && ['same-owner-reactivation','stopped-owner-transfer'].includes(row.kind)
      && scope?.begin_key === fresh.idempotency_key && scope.run_id === run.id && scope.milestone === options.milestone
      && roots.key(scope.cwd) === roots.key(fs.realpathSync.native(options.cwd))
      && scope.actor_digest === row.current_session_sha256 && scope.host_runtime === row.current_host_runtime
      && scope.baseline_state_sha256 === digest(baseline) && scope.baseline_sha256 === baseline.baseline_sha256
      && scope.baseline_owner_digest === baseline.identity.owner_digest && scope.repair_owner_digest === fresh.owner_digest
      && (scope.repair_generation === null || scope.repair_generation === fresh.lease_generation)
      && scope.original_sha256 === baseline.identity.original_sha256 && scope.claim_sha256 === baseline.identity.claim_sha256
      && scope.execution_contract_sha256 === baseline.identity.execution_contract_sha256;
  });
  if (!bindings.length) return null;
  for (const { row: first, index } of bindings) {
    let previous = null, valid = true;
    for (const row of history.slice(index)) {
      if (row.mechanism !== 'trusted-caller-attestation-v1'
          || !['same-owner-reactivation','stopped-owner-transfer','interrupted-owner-transfer'].includes(row.kind)
          || !['claude','codex'].includes(row.previous_host_runtime) || !['claude','codex'].includes(row.current_host_runtime)
          || !/^[a-f0-9]{64}$/.test(row.previous_session_sha256 || '') || !/^[a-f0-9]{64}$/.test(row.current_session_sha256 || '')
          || previous && (previous.current_session_sha256 !== row.previous_session_sha256 || previous.current_host_runtime !== row.previous_host_runtime)
          || row.kind === 'same-owner-reactivation' && (row.previous_session_sha256 !== row.current_session_sha256 || row.previous_host_runtime !== row.current_host_runtime)
          || row.kind === 'stopped-owner-transfer' && row.previous_owner_stopped_attested !== true) { valid = false; break; }
      previous = row;
    }
    if (valid && previous?.current_session_sha256 === digest(run.session_id) && previous.current_host_runtime === run.host_runtime) return first.boundary.delivery_repair;
  }
  return null;
}

// A narrow preflight inside the existing fenced owner-transfer path. This
// read-only construction reuses the real committed lineage/roots/claim/event
// and live stopped-writer/questions checks; start() is never called here.
function inspectRetainedClaimResume(cwd, record, options) {
  let sameRoot=false;try{sameRoot=roots.key(fs.realpathSync.native(cwd))===roots.key(fs.realpathSync.native(options?.cwd));}catch{}
  if (!options || record.kind!=='milestone' || options.runId!==record.id || options.milestone!==record.id || !sameRoot) fail('delivery-repair-resume-scope-mismatch');
  if(!resumeInputs.has(options))return constructRepair(options,true).scope;
  const actor=require('./forge-runs').observeHostSession(options.hostRuntime,options.expectedSession);
  if(!actor||actor.sessionId!==options.ownerToken||actor.sessionId!==options.expectedSession)fail('delivery-repair-observed-owner-required');
  let repair=preparedResumes.get(options);
  if(!repair){repair=constructRepair(options,true,actor);preparedResumes.set(options,repair);}
  else baselinePublishers.get(repair).assert();
  return repair.scope;
}
// Called only inside the controller + registry owner-transfer fences, after
// the read-only quiescence checks. The process-local brand grants publication
// of this exact prepared baseline, not general writes or imported approval.
function publishPreparedResumeBaseline(cwd,record,options,scope){
  if(!resumeInputs.has(options))fail('delivery-repair-live-adapter-required');
  const checked=inspectRetainedClaimResume(cwd,record,options),repair=preparedResumes.get(options);
  if(!repair||digest(checked)!==digest(scope))fail('delivery-repair-baseline-changed');
  baselinePublishers.get(repair).publish();
}
// Live host bridge: three host callbacks remain mandatory; imported JSON and
// CLI flags do not become callbacks. resumeOwner retains its existing caller
// confirmations and fences. Observed identity is checked on each repair call.
function resumeAndCreateRepair(options = {}) {
  const runs=require('./forge-runs');
  if (![options.assertAuthority,options.attestStoppedWriter,options.readPendingQuestions].every(fn=>typeof fn==='function')) fail('delivery-repair-live-adapter-required');
  const observed=runs.observeHostSession(options.hostRuntime,options.expectedSession);
  if (!observed || observed.sessionId!==options.ownerToken) fail('delivery-repair-observed-owner-required');
  const liveOptions={...options,expectedSession:observed.sessionId};
  resumeInputs.add(liveOptions);
  let resumed;
  try { resumed=runs.resumeOwner(options.cwd,options.runId,{hostRuntime:options.hostRuntime,expectedSession:observed.sessionId,
    expectedRecordSha256:options.expectedRecordSha256,confirmOwnerStopped:options.confirmOwnerStopped,
    confirmWorkspaceQuiescent:options.confirmWorkspaceQuiescent,deliveryRepair:liveOptions}); }
  finally { resumeInputs.delete(liveOptions);preparedResumes.delete(liveOptions); }
  const hostAuthority=options.assertAuthority;
  const repair=constructRepair({...options,assertAuthority:scope=>{
    const current=runs.observeHostSession(options.hostRuntime,options.expectedSession),record=runs.get(options.cwd,options.runId);
    if (!current || current.sessionId!==observed.sessionId || current.source!==observed.source || record?.active!==true
        || record.session_id!==observed.sessionId || record.host_runtime!==observed.hostRuntime) fail('delivery-repair-authority-required');
    return hostAuthority(scope);
  }},false,observed);
  return Object.freeze({owner_resume_status:resumed.status,scope:repair.scope,start:repair.start,complete:repair.complete});
}
// A successful resume must also survive the next selection. Project only a
// re-proven delivery-only successor; unchecked source inventory and imported
// snapshots never skip a task on their own. This does not edit its checklist.
function projectVerifiedRepairs(cwd,milestone,inventory,actor) {
  if(!Array.isArray(inventory?.slices))return inventory;
  const history=require('./forge-runs').get(cwd,milestone)?.owner_resume_history || [];
  if(!Array.isArray(history))fail('delivery-recovery-unproven');
  const events=controller.readEvents(controller.eventsFile(cwd,milestone));
  const diagnostics=[];
  const slices=inventory.slices.map(slice=>({...slice,tasks:(slice.tasks||[]).map(task=>{
    if(task.checked || !/^T\d+(?:\.\d+)?$/.test(task.id||''))return task;
    const unit='execute-task/'+task.id,legacy=`forge-orchestrate-next:${milestone}:${unit}`;
    const keys=new Set([legacy,legacy+':'+slice.id,...events.filter(event=>event.action==='begin'&&event.unit===unit
      && !event.idempotency_key?.startsWith('forge-delivery-verification:')).map(event=>event.idempotency_key),...history.map(row=>row.boundary?.delivery_repair)
      .filter(scope=>scope?.milestone===milestone&&scope.slice===slice.id&&scope.unit===unit).map(scope=>scope.original_begin_key)]);
    const proven=new Set();
    const diagnosticStart=diagnostics.length;
    for(const key of keys)try{
      const begin=controller.lookupRecord(cwd,'transaction',key),old=controller.lookupRecord(cwd,'transaction',key+':complete');
      if(!begin||!old||begin.unit?.key!==unit||begin.after?.state?.active_slice!==slice.id)continue;
      const original=digest({begin,complete:old});
      const baseline=readBaseline(path.join(cwd,'.gsd/milestones',milestone,'slices',slice.id,'tasks',task.id,`.delivery-verification-${original}.json`));
      if(!baseline){
        if(events.some(event=>event.idempotency_key?.startsWith(`forge-delivery-verification:${original}:`))
            || history.some(row=>row.boundary?.delivery_repair?.original_begin_key===key))fail('delivery-recovery-baseline-unproven');
        continue;
      }
      const repairBeginKey=`forge-delivery-verification:${original}:${digest(baseline)}`;
      verifyCompletedRepair({cwd,milestone,...actor,repairBeginKey,block:{begin_key:key,completion_key:key+':complete',completion_sha256:controller.recordChecksum(old)}},true);
      proven.add(repairBeginKey);
    }catch(cause){
      // Only closed codes cross the command boundary, never paths, exception
      // text or provider payload. Preserve the original failed proof stage.
      const codes=['delivery-recovery-unproven','delivery-recovery-original-changed','delivery-recovery-baseline-unproven','delivery-recovery-event-unproven',
        'delivery-repair-baseline-invalid','delivery-repair-baseline-changed','record-conflict'];
      diagnostics.push({slice:slice.id,task:task.id,reason_code:codes.includes(cause?.code)?cause.code:'delivery-recovery-unproven'});
    }
    if(proven.size>1)diagnostics.push({slice:slice.id,task:task.id,reason_code:'delivery-recovery-unproven'});
    return proven.size===1&&diagnostics.length===diagnosticStart?{...task,checked:true}:task;
  })}));
  return {...inventory,slices,...(diagnostics.length?{delivery_repair_diagnostics:diagnostics}:{})};
}
module.exports = { createRepair, verifyRepairCompletion, inspectRetainedClaimResume, publishPreparedResumeBaseline, resumeAndCreateRepair, projectVerifiedRepairs };
