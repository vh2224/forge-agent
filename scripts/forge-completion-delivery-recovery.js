'use strict';

// Trusted host composition, not a CLI authorization channel. A committed
// completion is immutable; current verification gets a distinct real lineage.
const fs = require('fs'), path = require('path');
const controller = require('./forge-unit-controller');
const roots = require('./forge-code-roots');
const claims = require('./forge-write-claim');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const digest = roots.digest;

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
  const run = () => require('./forge-runs').get(cwd, runId);
  function currentClaim() {
    const record = run(), claim = claims.readClaim(record);
    if (record?.active !== true || !claims.isHeld(claim) || !claim.paths?.length) fail('delivery-repair-claim-required');
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
    run_id: runId, host_runtime: hostRuntime, owner_digest: require('crypto').createHash('sha256').update(ownerToken.normalize('NFC').trim()).digest('hex') };
  const baselineFile = path.join(path.dirname(planFile), `.delivery-verification-${originalHash}.json`);
  let saved = readBaseline(baselineFile);
  if (!saved) {
    if (controller.readEvents(controller.eventsFile(cwd, milestone)).some(event => event.idempotency_key?.startsWith(prefix))) fail('delivery-repair-baseline-missing');
    const measured = snapshot();
    saved = { schema_version: 1, kind: 'current-delivery-verification-baseline', identity, baseline: measured,
      baseline_sha256: digest(measured), created_at: new Date().toISOString() };
  }
  if (saved.schema_version !== 1 || saved.kind !== 'current-delivery-verification-baseline' || digest(saved.identity) !== digest(identity)
      || Object.keys(saved).sort().join('|') !== ['schema_version','kind','identity','baseline','baseline_sha256','created_at'].sort().join('|')
      || !Number.isFinite(Date.parse(saved.created_at)) || !Array.isArray(saved.baseline) || saved.baseline_sha256 !== digest(saved.baseline)) fail('delivery-repair-baseline-invalid');
  const stateSha = digest(saved), baseline = saved.baseline_sha256, beginKey = prefix + stateSha;
  const oldEntries = controller.readEvents(controller.eventsFile(cwd, milestone)).filter(event => event.action === 'begin' && event.idempotency_key?.startsWith(prefix));
  if (oldEntries.some(event => event.idempotency_key !== beginKey)
      || controller.pendingTransactions(cwd).some(tx => tx.idempotency_key?.startsWith(prefix) && tx.idempotency_key !== beginKey)) fail('delivery-repair-baseline-changed');
  const scope = Object.freeze({ cwd, milestone, slice, task, run_id: runId, host_runtime: hostRuntime,
    original_begin_key: options.beginKey, original_completion_key: options.completionKey,
    original_sha256: originalHash, begin_key: beginKey, execution_contract_sha256: digest(contract), claim_sha256: claimSha,
    baseline_sha256: baseline, baseline_state_sha256: stateSha });
  function live() {
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
    for (const tx of [originalBegin, originalComplete]) {
      const found = events.filter(event => event.idempotency_key === tx.idempotency_key);
      if (found.length !== 1) fail('delivery-repair-original-event-invalid');
      const content = { ...found[0] }; delete content.sequence;
      if (digest(content) !== digest(tx.event)) fail('delivery-repair-original-event-invalid');
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
    const begun = controller.beginSerial(cwd, { milestone, unit, slice, host_runtime: hostRuntime, owner_token: ownerToken,
      idempotency_key: beginKey, state_patch: { active_slice: slice } }, txOptions);
    if (!begun.ok) fail('delivery-repair-begin-refused');
    return { status: 'verification-required', action: 'verify-only', begin_key: beginKey,
      completion_key: beginKey + ':complete', original_sha256: originalHash, implementation_reexecuted: false };
  }
  function complete() {
    stable();
    const begin = controller.lookupRecord(cwd, 'transaction', beginKey);
    if (!begin || begin.phase !== 'committed') fail('delivery-repair-begin-required');
    const now = typeof txOptions.now === 'function' ? txOptions.now() : Date.now();
    const proof = require('./forge-milestone-time-clock').readCurrentTaskDelivery({ cwd, milestone, slice, task, begunAt: begin.created_at, completedAt: now });
    if (proof.status !== 'proven' || proof.captures.some(c => Date.parse(c.captured_at) < Date.parse(begin.created_at))) fail('delivery-repair-current-capture-required');
    stable();
    return require('./forge-orchestrate').run('complete', { cwd, milestone, unit, host_runtime: hostRuntime, owner_token: ownerToken,
      begin_key: beginKey, result: { status: 'done', summary: 'Current owner verification and delivery only; original execution retained.',
        provider_called: false, implementation_reexecuted: false, original_completion_sha256: digest(originalComplete) } }, txOptions);
  }
  return Object.freeze({ scope, start, complete });
}

// Read-only administrative admission. A locator/snapshot never supplies proof:
// re-read the canonical records, published events, saved baseline and delivery.
function verifyRepairCompletion(options = {}) {
  const cwd = fs.realpathSync.native(options.cwd), block = options.block;
  if (!block || typeof options.repairBeginKey !== 'string' || typeof options.ownerToken !== 'string'
      || !options.ownerToken.trim() || !['claude','codex'].includes(options.hostRuntime)
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
  const owner = require('crypto').createHash('sha256').update(options.ownerToken.normalize('NFC').trim()).digest('hex');
  if (!fresh || !complete || fresh.action !== 'begin' || complete.action !== 'complete' || fresh.phase !== 'committed' || complete.phase !== 'committed'
      || fresh.milestone !== begin.milestone || fresh.unit?.key !== begin.unit.key || complete.unit?.key !== fresh.unit.key
      || fresh.after?.state?.active_slice !== begin.after.state.active_slice || complete.after?.state?.active_slice !== begin.after.state.active_slice
      || fresh.host_runtime !== options.hostRuntime || complete.host_runtime !== fresh.host_runtime
      || fresh.owner_digest !== 'sha256:' + owner || complete.owner_digest !== fresh.owner_digest || complete.lease_generation !== fresh.lease_generation
      || complete.result?.status !== 'succeeded' || complete.boundary?.kind !== 'completed' || complete.boundary.handoff_ready !== true) fail('delivery-recovery-unproven');
  const directory = path.join(cwd, '.gsd', 'milestones', begin.milestone, 'slices', begin.after.state.active_slice, 'tasks', begin.unit.id);
  const baseline = readBaseline(path.join(directory, `.delivery-verification-${original}.json`));
  if (!baseline || digest(baseline) !== options.repairBeginKey.slice(prefix.length) || baseline.identity?.original_sha256 !== original
      || baseline.identity?.owner_digest !== owner || baseline.identity?.host_runtime !== fresh.host_runtime) fail('delivery-recovery-baseline-unproven');
  const events = controller.readEvents(controller.eventsFile(cwd, begin.milestone));
  for (const pair of [[begin, old], [fresh, complete]]) {
    const published = pair.map(tx => {
      const rows = events.filter(event => event.idempotency_key === tx.idempotency_key);
      if (rows.length !== 1 || !Number.isSafeInteger(rows[0].sequence) || rows[0].sequence < 1) fail('delivery-recovery-event-unproven');
      const value = { ...rows[0] }; delete value.sequence;
      if (digest(value) !== digest(tx.event)) fail('delivery-recovery-event-unproven');
      return rows[0];
    });
    if (published[0].sequence >= published[1].sequence) fail('delivery-recovery-event-unproven');
  }
  const proof = require('./forge-milestone-time-clock').readHistoricalTaskDelivery({ cwd, milestone: begin.milestone,
    slice: begin.after.state.active_slice, task: begin.unit.id, completedAt: complete.event.ts });
  const binding = complete.result.output?.owner_delivery_proof;
  if (proof.status !== 'proven' || !binding || binding.begin_key !== fresh.idempotency_key || binding.begin_sha256 !== controller.recordChecksum(fresh)
      || binding.delivery_fingerprint !== proof.fingerprint || binding.current_source_conformity !== 'matched'
      || digest(binding.captures) !== digest(proof.captures.map(c => ({ reference: c.reference, sha256: c.sha256, captured_at: c.captured_at })))) fail('delivery-recovery-unproven');
  return { status: 'proven', original_completion_sha256: block.completion_sha256, repair_begin_key: fresh.idempotency_key,
    repair_completion_key: complete.idempotency_key, implementation_reexecuted: false };
}

module.exports = { createRepair, verifyRepairCompletion };
