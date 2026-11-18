'use strict';
const assert = require('assert/strict'), fs = require('fs'), path = require('path');
const lab = require('./forge-code-roots.test'), roots = require('./forge-code-roots');
const side = require('./forge-unit-sidecar'), activity = require('./forge-protected-owner-activity');
const runs = require('./forge-runs'), questions = require('./forge-pending-questions');
const repair = require('./forge-sidecar-verification-repair'), lease = require('./forge-unit-lease');
const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
async function fixture(fn) {
  const f = lab.fixture(), env = { ...process.env };
  try { const home = path.join(f.dir, 'home'); fs.mkdirSync(home); Object.assign(process.env, { HOME: home, USERPROFILE: home, FORGE_HOME: path.resolve(__dirname, '..') }); return await fn(f); }
  finally { process.env = env; f.cleanup(); }
}
function historical(f, { expired = false } = {}) {
  const request = require('./forge-issues-429-432.test').activityRequest(f, 'codex');
  const bindings = structuredClone(request.verification.bindings); delete request.verification.bindings;
  if (expired) {
    const file = lease.leaseFile(f.owner, 'execute-task/T01'), held = JSON.parse(fs.readFileSync(file));
    put(file, JSON.stringify({ ...held, heartbeat_at: Date.now() - 2000, expires_at: Date.now() - 1000 }));
  }
  // A synthetic historical pre-bindings attempt, not a new admitted dispatch.
  // Capture its original S0 before the fixture writer, with the actual APIs.
  const fingerprint = side.artifactFingerprint(request), recoveryId = roots.digest(require('./forge-attempt-recovery').requestIdentity(request));
  const parent = { phase: 'started', fingerprint, dispatch_id: request.dispatchId, recovery_identity_sha256: recoveryId,
    before: Object.fromEntries(side.locations(request).allowed.map(file => [file, fs.existsSync(path.join(f.owner, file)) ? roots.digest(fs.readFileSync(path.join(f.owner, file))) : null])) };
  const marker = '.gsd/milestones/M001/slices/S01/S01-PLAN.md'; parent.before[marker] = roots.digest(fs.readFileSync(path.join(f.owner, marker)));
  const parentFile = side.artifactAttemptFiles(request).receiptFile; put(parentFile, JSON.stringify(parent));
  parent.recovery_baseline = side.captureMilestoneBaseline(request, parent);
  parent.verification_seal = require('./forge-verify').normalizeExecutionVerification(request.execution_contract, fs.readFileSync(request.planFile, 'utf8'), request.verification, {},
    { dispatch_id: request.dispatchId, fingerprint, recovery_identity_sha256: recoveryId });
  const originalBytes = {};
  for (const [file, hash] of Object.entries(parent.recovery_baseline.protected_owner)) if (hash !== 'directory') originalBytes[file] = fs.readFileSync(path.join(f.owner, file));
  put(path.join(f.a, 'same.txt'), 'after\n');
  const result = { status: 'done', summary: 'Synthetic retained historical writer', files_changed: ['same.txt'], must_haves_status: [] };
  const response = Buffer.from(JSON.stringify({ version: 1, dispatch_id: request.dispatchId, request_fingerprint: fingerprint,
    result, trust: 'transport-normalized; unit-validation-pending' }));
  put(request.resultFile + '.returned.json', response);
  parent.returned_response = { version: 1, sha256: roots.digest(response), bytes: response.length, channel: 'resultFile.returned.json', unit_validation: 'pending' };
  parent.phase = 'failed'; parent.failure = { reason_code: 'execution-protected-metadata', provider_called: true };
  put(parentFile, JSON.stringify(parent)); put(request.resultFile, JSON.stringify({ status: 'adapter-failed', reason_code: 'execution-protected-metadata' }));
  return { request, bindings, parent, parentFile, parentBytes: fs.readFileSync(parentFile), stateBytes: fs.readFileSync(parent.recovery_baseline.state_file), originalBytes };
}
function callbacks(f, h, overrides = {}) {
  return { request: h.request, hostRuntime: 'codex', assertAuthority: () => true, attestStoppedWriter: () => true, readPendingQuestions: () => [], originalBytes: h.originalBytes,
    attestChanges: challenge => ({ challenge_sha256: roots.digest(challenge), changes: challenge.changes.map(row => ({ ...row,
      kind: row.path.includes('/questions') ? 'decision-record' : row.path.includes('/runs/') ? overrides.ownerTransfer ? 'canonical-owner-transfer' : 'canonical-stop'
        : row.path.includes('/evidence-') ? 'hook-append' : row.path.includes('/leases/') ? 'same-unit-lease-clock'
          : row.path === '.gsd/forge/auto-mode.json' ? 'canonical-stop' : 'operator-reviewed',
      reference: 'synthetic scoped canonical API observation' })) }), ...overrides };
}
function repairOptions(h, extra = {}) { return { request: h.request, bindings: h.bindings, reference: 'synthetic criterion repair', assertAuthority: () => true, attestStoppedWriter: () => true, readPendingQuestions: () => [], ...extra }; }
function unchanged(f, h) { assert(fs.readFileSync(h.parentFile).equals(h.parentBytes)); assert(fs.readFileSync(h.parent.recovery_baseline.state_file).equals(h.stateBytes)); assert.equal(fs.readFileSync(path.join(f.a, 'same.txt'), 'utf8'), 'after\n'); }
async function preflight() { return fixture(async f => {
  const r = require('./forge-issues-429-432.test').activityRequest(f, 'codex'); assert(side.preflightExecutionVerification(r));
  for (const bindings of [undefined, [], r.verification.bindings.slice(0, 1)]) {
    assert.throws(() => side.preflightExecutionVerification({ ...r, verification: { ...r.verification, bindings } }), /verification-bindings-(required|incomplete)/);
  }
  for (const mutate of [b => { b[0].root_id = 'foreign'; }, b => { b[0].criterion.index = 100; }, b => { b[0].source.check_index = 999; }, b => { b[0].coverage = 'structural'; }]) {
    const bindings = structuredClone(r.verification.bindings); mutate(bindings);
    assert.throws(() => side.preflightExecutionVerification({ ...r, verification: { ...r.verification, bindings } }), /verification-binding/);
  }
  const documentary = r.verification.bindings.map(b => ({ ...b, coverage: 'documentary', source: { kind: 'artifact', property: 'documentary' } }));
  assert.throws(() => side.preflightExecutionVerification({ ...r, verification: { ...r.verification, bindings: documentary } }), /verification-binding-source-invalid/);
  const roadmap = '.gsd/milestones/M001/M001-ROADMAP.md', text = '# Roadmap\n'; put(path.join(f.owner, roadmap), text);
  const aggregate = require('./forge-delivery').buildDelivery({ schema_version: 2, execution_contract: r.execution_contract,
    unit: { type: 'milestone', id: 'M001' }, plan: roadmap, plan_fingerprint: roots.digest(text), expected_children: [], bindings: [] }, { ownerRoot: f.owner, codeDir: f.a });
  assert.deepEqual(aggregate.criteria, []); assert.equal(aggregate.plan.structured, false); assert(aggregate.diagnostics.includes('plan_legacy'));
}); }
async function hookDecision(negative = false) { return fixture(async f => {
  const h = historical(f), note = '.gsd/HANDOFF-fixture.md', journal = '.gsd/forge/evidence-fixture.jsonl';
  put(path.join(f.owner, note), 'reviewed note\n'); h.originalBytes[journal] = Buffer.alloc(0);
  const hookEvidence = { originalBytes: { [journal]: Buffer.alloc(0) }, attestAppend: () => ({ observed: true, reference: 'synthetic hook invocation' }) };
  const first = activity.reconciliationDecision(h.request, undefined, { hookEvidence }), opened = questions.openQuestions(first);
  require('./forge-owner-transport-window').appendHookEvidence(f.owner, 'evidence-fixture.jsonl', '{"fixture":1}');
  questions.answer({ cwd: f.owner, identity: opened.identity_sha256, answers: [{ id: 'owner-delta-approval', answer: 'aprovado', source: 'user-text' }] });
  require('./forge-owner-transport-window').appendHookEvidence(f.owner, 'evidence-fixture.jsonl', '{"fixture":2}');
  assert.equal(activity.reconciliationDecision(h.request, opened.identity_sha256, { hookEvidence }).decision_set, first.decision_set);
  if (negative) {
    assert.throws(() => activity.reconciliationDecision(h.request, opened.identity_sha256, { hookEvidence: { ...hookEvidence, attestAppend: () => ({ observed: false }) } }), /hook-proof-required/);
    put(path.join(f.owner, journal), 'invalid\n'); assert.throws(() => activity.reconciliationDecision(h.request, opened.identity_sha256, { hookEvidence }), /append-invalid/);
    put(path.join(f.owner, journal), '{"fixture":1}\n{"fixture":2}\n'); put(path.join(f.owner, note), 'changed manual note\n');
    assert.throws(() => activity.createOwnerReconciliation(callbacks(f, h, { hookEvidence, operatorDecision: opened.identity_sha256 })), /operator-decision-required/);
  } else assert(activity.createOwnerReconciliation(callbacks(f, h, { hookEvidence, operatorDecision: opened.identity_sha256 })));
  unchanged(f, h);
}); }
async function transfer(negative = false) { return fixture(async f => {
  const h = historical(f, { expired: true }); runs.update(f.owner, 'M001', { active: false }); process.env.CODEX_THREAD_ID = 'fixture-next-owner';
  const inspection = runs.inspectOwnerResume(f.owner, 'M001', { hostRuntime: 'codex', expectedSession: 'fixture-next-owner' });
  const options = { ...callbacks(f, h), expectedSession: 'fixture-next-owner', expectedRecordSha256: inspection.record_sha256, confirmOwnerStopped: true, confirmWorkspaceQuiescent: true };
  assert.throws(() => runs.resumeOwner(f.owner, 'M001', { ...options, attemptRecovery: {} }), /resume-capability-required/);
  if (negative) {
    Object.assign(process.env, { FORGE_CLAUDE_OWNER_SESSION_ID: 'fixture-next-claude', FORGE_CLAUDE_OWNER_SOURCE: 'claude-sessionstart-env-v1' });
    assert.throws(() => activity.resumeAttemptOwner({ ...options, hostRuntime: 'claude', expectedSession: 'fixture-next-claude' }), /resume-scope-invalid/);
    assert.throws(() => activity.resumeAttemptOwner({ ...options, attestStoppedWriter: () => false }), /authority-required/);
    assert.throws(() => activity.resumeAttemptOwner({ ...options, readPendingQuestions: () => [{ status: 'pending' }] }), /pending-questions/);
    assert.throws(() => activity.resumeAttemptOwner({ ...options, expectedRecordSha256: 'a'.repeat(64) }), /snapshot-changed/);
    assert.equal(runs.get(f.owner, 'M001').active, false);
  } else {
    const resumed = activity.resumeAttemptOwner(options); assert.equal(resumed.status, 'transferred');
    assert.equal(runs.get(f.owner, 'M001').session_id, 'fixture-next-owner');
    assert(require('./forge-unit-controller').incompleteUnits(f.owner, 'M001').some(row => row.idempotency_key === 'fixture-begin'));
    const cap = activity.createOwnerReconciliation(callbacks(f, h, { ownerTransfer: resumed.ownerTransfer })); assert(cap);
  }
  unchanged(f, h);
}); }
async function repairNegative() { return fixture(async f => {
  const h = historical(f);
  assert.throws(() => repair.create(repairOptions(h, { bindings: [] })), /verification-bindings-required/);
  assert.throws(() => repair.create(repairOptions(h, { attestStoppedWriter: () => false })), /authority-required/);
  assert.throws(() => repair.create(repairOptions(h, { readPendingQuestions: () => [{ status: 'pending' }] })), /pending-questions/);
  const cap = repair.create(repairOptions(h));
  assert.throws(() => repair.read(JSON.parse(JSON.stringify(cap)), h.request), /capability-required/);
  put(path.join(f.a, 'same.txt'), 'changed after capture\n'); assert.throws(() => repair.read(cap, h.request), /source-changed/);
  put(path.join(f.a, 'same.txt'), 'after\n'); unchanged(f, h);
}); }
async function retainedNegatives() { return fixture(async f => {
  const h = historical(f), options = repairOptions(h), responseFile = h.request.resultFile + '.returned.json', original = fs.readFileSync(responseFile);
  const missing = structuredClone(h.parent); delete missing.returned_response; put(h.parentFile, JSON.stringify(missing));
  assert.throws(() => repair.create(options), /response-anchor-required/); put(h.parentFile, h.parentBytes);
  const response = JSON.parse(original); response.result.files_changed = [];
  const altered = Buffer.from(JSON.stringify(response)), parent = { ...h.parent, returned_response: { ...h.parent.returned_response, sha256: roots.digest(altered), bytes: altered.length } };
  put(responseFile, altered); put(h.parentFile, JSON.stringify(parent));
  assert.throws(() => repair.create(options), /execution-result-omitted-delta/);
  put(responseFile, original); put(h.parentFile, h.parentBytes);
  const cap = repair.create(options), value = repair.read(cap, h.request); value.initialize();
  assert.throws(() => value.initialize(), /already-used/);
  put(h.parentFile, JSON.stringify({ ...h.parent, diagnostic: 'changed original' }));
  assert.throws(() => repair.read(cap, h.request), /source-changed/); put(h.parentFile, h.parentBytes); unchanged(f, h);
}); }
async function transferScopeNegatives() { return fixture(async f => {
  const h = historical(f); runs.update(f.owner, 'M001', { active: false }); process.env.CODEX_THREAD_ID = 'fixture-next-owner';
  const inspection = runs.inspectOwnerResume(f.owner, 'M001', { hostRuntime: 'codex', expectedSession: 'fixture-next-owner' });
  const options = { ...callbacks(f, h), expectedSession: 'fixture-next-owner', expectedRecordSha256: inspection.record_sha256, confirmOwnerStopped: true, confirmWorkspaceQuiescent: true };
  const file = lease.leaseFile(f.owner, 'execute-task/T01'), before = fs.readFileSync(file), foreign = lease.leaseFile(f.owner, 'execute-task/T99');
  put(foreign, before); assert.throws(() => activity.resumeAttemptOwner(options), /owner-resume-lease-present/); fs.unlinkSync(foreign);
  put(file, JSON.stringify({ ...JSON.parse(before), generation: 'foreign-generation' }));
  assert.throws(() => activity.resumeAttemptOwner(options), /resume-scope-invalid/); put(file, before);
  unchanged(f, h);
}); }
async function repairPipeline(withTransfer = false) { return fixture(async f => {
  const h = historical(f, { expired: withTransfer }), originalOutput = fs.readFileSync(h.request.resultFile);
  let ownerReconciliation;
  if (withTransfer) {
    runs.update(f.owner, 'M001', { active: false }); process.env.CODEX_THREAD_ID = 'fixture-next-owner';
    const inspection = runs.inspectOwnerResume(f.owner, 'M001', { hostRuntime: 'codex', expectedSession: 'fixture-next-owner' });
    const resumed = activity.resumeAttemptOwner({ ...callbacks(f, h), expectedSession: 'fixture-next-owner', expectedRecordSha256: inspection.record_sha256, confirmOwnerStopped: true, confirmWorkspaceQuiescent: true });
    const journal = '.gsd/forge/evidence-fixture.jsonl'; h.originalBytes[journal] = Buffer.alloc(0);
    const hookEvidence = { originalBytes: { [journal]: Buffer.alloc(0) }, attestAppend: () => ({ observed: true, reference: 'synthetic canonical hook observation' }) };
    put(path.join(f.owner, '.gsd/HANDOFF-fixture.md'), 'reviewed transfer note\n');
    const decision = activity.reconciliationDecision(h.request, undefined, { hookEvidence }), opened = questions.openQuestions(decision);
    require('./forge-owner-transport-window').appendHookEvidence(f.owner, 'evidence-fixture.jsonl', '{"phase":"before-answer"}');
    questions.answer({ cwd: f.owner, identity: opened.identity_sha256, answers: [{ id: 'owner-delta-approval', answer: 'aprovado', source: 'user-text' }] });
    require('./forge-owner-transport-window').appendHookEvidence(f.owner, 'evidence-fixture.jsonl', '{"phase":"after-answer"}');
    ownerReconciliation = activity.createOwnerReconciliation(callbacks(f, h, { ownerTransfer: resumed.ownerTransfer, hookEvidence, operatorDecision: opened.identity_sha256 }));
  }
  const cap = repair.create(repairOptions(h, { ownerReconciliation })), xllm = require('./forge-xllm'), originalRun = xllm.runExecute;
  let providerCalls = 0; xllm.runExecute = async () => { providerCalls++; throw Error('unexpected provider'); };
  try {
    const result = await side.runUnitSidecar(h.request, { verificationSuccessor: cap, ...(ownerReconciliation ? { ownerReconciliation } : {}) });
    assert.equal(result.status, 'done'); assert.equal(providerCalls, 0); unchanged(f, h); assert(fs.readFileSync(h.request.resultFile).equals(originalOutput));
    const delivery = require('./forge-milestone-time-clock').readCurrentTaskDelivery({ cwd: f.owner, milestone: 'M001', slice: 'S01', task: 'T01', begunAt: 0, completedAt: Date.now() + 1000 });
    assert.equal(delivery.status, 'proven', JSON.stringify(delivery));
    const begin = require('./forge-unit-controller').lookupRecord(f.owner, 'transaction', 'fixture-begin');
    const completed = require('./forge-orchestrate').run('complete', { cwd: f.owner, milestone: 'M001', unit: 'execute-task/T01', begin_key: 'fixture-begin', host_runtime: 'codex', owner_token: 'fixture-loop', generation: begin.generation, result: { status: 'done', summary: 'verification repair' } });
    assert.equal(completed.outcome, 'completed', JSON.stringify(completed));
    await assert.rejects(side.runUnitSidecar(h.request, { verificationSuccessor: cap }), /already-used|authority-required|source-changed/);
  } finally { xllm.runExecute = originalRun; }
}); }
const cases = [{ name: 'preflight-coverage', fn: preflight }, { name: 'hook-stable-decision', fn: () => hookDecision() },
  { name: 'hook-decision-negatives', fn: () => hookDecision(true) }, { name: 'transfer-open-begin', fn: () => transfer() },
  { name: 'transfer-negatives', fn: () => transfer(true) }, { name: 'verification-repair-negatives', fn: repairNegative },
  { name: 'verification-repair-pipeline', fn: () => repairPipeline() }, { name: 'cross-session-repair-pipeline', fn: () => repairPipeline(true) },
  { name: 'retained-result-negatives', fn: retainedNegatives }, { name: 'transfer-scope-negatives', fn: transferScopeNegatives }];
async function main() { for (const row of require('./forge-ci-units').selectCases(cases)) { await row.fn(); console.log('PASS ' + row.name); } }
module.exports = { cases, main };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
