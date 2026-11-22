'use strict';

// Contract suite for scripts/forge-attempt-abandon.js (issue 440, S02/T04).
// Real temporary owner and git roots, real controller begin, lease, claim gate,
// protected owner activity, S0 capture, process-family custody (T02), backup and
// claimed reset (T03). ONLY the transport is synthetic and labelled `mock`: the
// mocked xllm.runExecute spawns a controlled helper (which creates a grandchild)
// through scope.spawn and then injects a transport failure. The host adapters are
// live in-process test callbacks labelled `mock`. No provider, account or network.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const abandon = require('./forge-attempt-abandon');
const roots = require('./forge-code-roots');
const lab = require('./forge-code-roots.test');
const { activityRequest } = require('./forge-issues-429-432.test');
const source = path.resolve(__dirname, '..');
const CUSTODY = process.platform === 'win32';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const { digest } = roots;
const put = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const read = file => (fs.existsSync(file) ? fs.readFileSync(file) : null);
const text = file => fs.readFileSync(file, 'utf8');
const MOCK_FAILURE = 'claude-exit-nonzero';
const REFERENCE = 'conversation:abandon-fixture';
const SECTION = 'user:forge-routing-continuity';

// ── Fixture ─────────────────────────────────────────────────────────────────
function twoRootRequest(f, host) {
  // activityRequest with every root of the lab contract (same canonical calls).
  const runs = require('./forge-runs'), controller = require('./forge-unit-controller');
  const actor = 'fixture-actor-' + host, milestone = 'M001';
  if (host === 'codex') process.env.CODEX_THREAD_ID = actor;
  else Object.assign(process.env, { FORGE_CLAUDE_OWNER_SESSION_ID: actor, FORGE_CLAUDE_OWNER_SOURCE: 'claude-sessionstart-env-v1' });
  fs.mkdirSync(path.join(f.owner, '.gsd/milestones/M001'), { recursive: true });
  runs.add(f.owner, { id: milestone, kind: 'milestone', session_id: actor, host_runtime: host,
    owner_session_source: host === 'codex' ? 'CODEX_THREAD_ID' : 'claude-sessionstart-env-v1', active: true, root: f.owner });
  require('./forge-state').write(f.owner, { milestone, phase: 'idle', active_slice: 'S01', active_task: '—', auto_mode: 'off' });
  const contract = roots.validateContract(f.contract);
  const base = path.join(f.owner, '.gsd/milestones/M001/slices/S01'), planFile = path.join(base, 'tasks/T01/T01-PLAN.md');
  put(planFile, lab.plan(contract)); put(planFile.replace('-PLAN.md', '-PLAN-GATE.md'), '---\nstatus: approved\n---\n'); put(path.join(base, 'S01-PLAN.md'), '# Slice\n- [ ] **T01**: fixture\n');
  const model = host === 'codex' ? 'claude-opus-5-5' : 'gpt-6.1-sol';
  put(path.join(f.owner, '.gsd/forge-prefs.jsonc'), JSON.stringify({ tier_models: Object.fromEntries(['light', 'standard', 'heavy', 'max'].map(tier => [tier, [model]])) }));
  const route = require('./forge-dispatch-resolve').resolveDispatch({ cwd: f.owner, unitType: 'execute-task', milestoneId: milestone, unitId: 'T01', planPath: planFile, hostRuntime: host });
  assert.equal(route.worker_mode, 'sidecar');
  const gate = require('./forge-claim-gate').recordAndEvaluate({ cwd: f.owner, runId: milestone, unit: 'execute-task/T01', source: 'plan-writes', codeDir: f.a, executionContract: contract, paths: roots.validatePlan(fs.readFileSync(planFile, 'utf8'), contract).writes.map(roots.wire), readyAlternatives: 0, wait: false });
  assert.equal(gate.decision, 'proceed');
  const begin = controller.begin(f.owner, { milestone, slice: 'S01', unit: 'execute-task/T01', host_runtime: host,
    owner_token: 'fixture-loop', idempotency_key: 'fixture-begin', state_patch: { active_slice: 'S01' } }, { prefsReader: () => ({ ok: true, prefs: { workflow: { skip_discuss: true, skip_research: true } } }) });
  assert(begin.ok);
  return { unitType: 'execute-task', scope: 'milestone', phase: 'execute', milestoneId: milestone, sliceId: 'S01', taskId: 'T01', runId: milestone,
    cwd: f.a, contextRoot: f.owner, execution_contract: contract, claim: runs.get(f.owner, milestone).write_claim,
    workflowId: 'fixture-activity', dispatchId: 'fixture-activity-' + host, resultFile: path.join(f.dir, 'activity-result.json'), planFile, route,
    gates: { plan: 'approved', security: 'not-applicable', claim: 'proceed' }, verification: {
      preferenceCommands: ['node -e "process.exit(0)"'],
      bindings: ['alpha', 'beta'].flatMap((root_id, index) => [
        { root_id, criterion: { kind: 'truth', index: 0 }, aspect: 'default', coverage: 'behavioral', source: { kind: 'verification', check_index: 0 } },
        { root_id, criterion: { kind: 'artifact', index }, aspect: 'declared-property', coverage: 'structural', source: { kind: 'verification', check_index: 0 } }]) } };
}
function authority(f) {
  put(path.join(f.profile, '.codex/AGENTS.md'), `<!-- ${SECTION}:start -->\nFixture standing authorization.\n<!-- ${SECTION}:end -->\n`);
  const make = () => require('./forge-interaction').createRecoveryAuthorizationAdapter(observed => ({ ...observed,
    received: true, answer: 'authorize', resolved_at: Date.now() - 1000 }), { resolveProfile: () => f.profile });
  const adapter = make();
  require('./forge-attempt-recovery').bindRecoveryAuthorization({ adapter, reference: REFERENCE, registration: { host: 'codex', section: SECTION } });
  return { adapter, reference: REFERENCE, make };
}
// The live mock host: it answers only about the child this process spawned.
function liveAdapter(f, overrides = {}) {
  return abandon.createAbandonmentAdapter({
    attestWriter: challenge => {
      if (!f.child || f.child.exitCode === null) return { status: 'running' };
      return { status: 'stopped', binding_sha256: digest(challenge), writer_identity: `mock-transport:${f.child.pid}`,
        evidence_reference: 'mock:joined-transport-child', dispatch_id: challenge.dispatch_id, fingerprint: challenge.fingerprint,
        receipt_sha256: challenge.receipt_sha256, execution_identity_sha256: challenge.execution_identity_sha256,
        roots_sha256: challenge.roots_sha256, descendants_sha256: challenge.descendants_sha256 };
    },
    attestRoot: challenge => ({ binding_sha256: digest(challenge), status: 'stopped', root_id: challenge.root_id,
      evidence_reference: `mock:root:${challenge.root_id}` }),
    revalidateAttribution: challenge => ({ observed: true, journal_sha256: challenge.journal_sha256,
      attempt_sha256: challenge.attempt_sha256, reference: 'mock:live-attribution-revalidation' }),
    ...overrides,
  });
}
const HELPER = "const fs=require('fs'),p=require('path'),cp=require('child_process');const wait=Number(process.argv[1]);"
  + "for(const d of process.argv.slice(2))fs.writeFileSync(p.join(d,'same.txt'),'after\\n');"
  + "const g=cp.spawn(process.execPath,['-e','setTimeout(()=>{},'+wait+')'],{stdio:'ignore'});g.on('exit',()=>process.exit(0));";
async function attemptFixture(options = {}) {
  const { host = 'codex', twoRoots = false, mode = 'failed', code = MOCK_FAILURE, inputQuestions = false, legacy = false,
    during = null, grandchildMs = 150 } = options;
  const f = lab.fixture(), env = { ...process.env };
  f.restoreEnv = () => { process.env = env; };
  try {
    const home = path.join(f.dir, 'home'); fs.mkdirSync(home);
    f.profile = path.join(f.dir, 'profile'); fs.mkdirSync(f.profile);
    Object.assign(process.env, { HOME: home, USERPROFILE: home, FORGE_HOME: source });
    const request = twoRoots ? twoRootRequest(f, host) : activityRequest(f, host);
    if (inputQuestions) request.pending_questions = [{ id: 'fixture-input-question', question: 'Which fixture branch?', status: 'pending' }];
    // Operator state present before the attempt: an untracked file (pre_dirty) per root.
    for (const root of request.execution_contract.code_roots) put(path.join(root.path, 'operator.txt'), 'operator\r\n');
    f.request = request; f.host = host;
    f.authority = authority(f);
    const xllm = require('./forge-xllm'), activity = require('./forge-protected-owner-activity'), sidecar = require('./forge-unit-sidecar');
    f.files = sidecar.artifactAttemptFiles(request);
    f.recordFile = `${f.files.resultFile}.abandon.jsonl`;
    f.stateFile = `${f.files.resultFile}.recovery.json`;
    f.adapter = liveAdapter(f);
    f.input = (extra = {}) => ({ request: f.request, adapter: f.adapter, processProbe: () => (f.child.exitCode === null ? 'running' : 'stopped'),
      recoveryAuthorization: { adapter: f.authority.adapter, reference: f.authority.reference }, ...extra });
    const previous = xllm.runExecute;
    let started = null;
    xllm.runExecute = async runOptions => {
      runOptions.onBeforeSpawn?.();
      const scope = activity.currentScope(); assert(scope, 'protected activity scope');
      started = fs.readFileSync(f.files.receiptFile);
      const dirs = request.execution_contract.code_roots.map(root => root.path);
      f.child = scope.spawn(process.execPath, ['-e', HELPER, String(grandchildMs), ...dirs],
        { cwd: runOptions.cwd, env: xllm.buildSidecarEnv('minimal'), windowsHide: true, stdio: 'ignore' });
      if (during) await during(f);
      const exit = await new Promise((resolve, reject) => { f.child.once('error', reject); f.child.once('close', resolve); });
      assert.equal(exit, 0);
      throw Object.assign(new Error('mock transport failure after the controlled helper exited'), { code });
    };
    try {
      await assert.rejects(sidecar.runUnitSidecar(request, legacy ? { managedSurfacesVersion: 'managed-surfaces-v0' } : {}),
        error => error.code === code);
    } finally { xllm.runExecute = previous; }
    if (mode === 'started') {
      // Host crash before the failure was recorded: the durable started receipt
      // (with S0) is all that remains; no result and no recovery state exist.
      fs.writeFileSync(f.files.receiptFile, started);
      fs.rmSync(f.files.resultFile, { force: true }); fs.rmSync(`${f.files.resultFile}.recovery.json`, { force: true });
    }
    f.resetState = JSON.parse(text(f.files.receiptFile)).recovery_baseline.state_file;
    return f;
  } catch (error) { f.restoreEnv(); f.cleanup(); throw error; }
}
async function withFixture(options, fn) {
  const f = await attemptFixture(options);
  try { return await fn(f); } finally { f.restoreEnv(); f.cleanup(); }
}
function lines(f) { return fs.existsSync(f.recordFile) ? text(f.recordFile).trim().split('\n').map(line => JSON.parse(line)) : []; }
function kinds(f) { return lines(f).map(row => row.kind); }
// Every observable byte that a refusal must leave untouched.
function effects(f) {
  const execution = require('./forge-task-execution'), reset = require('./forge-surgical-reset');
  return {
    receipt: sha(fs.readFileSync(f.files.receiptFile)), reset_state: sha(fs.readFileSync(f.resetState)),
    recovery_state: read(f.stateFile) ? sha(read(f.stateFile)) : null,
    owner: digest(execution.protectedSnapshot(f.owner)),
    roots: f.request.execution_contract.code_roots.map(root => ({ id: root.id, protected: digest(execution.protectedSnapshot(root.path)),
      snapshot: digest(reset.captureAttemptSnapshot(root.path, { vcsName: root.vcs })), same: text(path.join(root.path, 'same.txt')),
      operator: text(path.join(root.path, 'operator.txt')) })),
    backup: fs.existsSync(path.join(`${f.files.resultFile}.abandon`, 'backup', 'manifest.json')),
  };
}
async function refused(f, input, code, label) {
  const before = effects(f);
  const value = await abandon.abandonAttempt(input);
  assert.equal(value.ok, false, `${label}: ${JSON.stringify(value)}`);
  assert.equal(value.reason_code, code, `${label}: ${JSON.stringify(value)}`);
  assert.equal(value.provider_called, false);
  assert.deepEqual(effects(f), before, `${label}: zero root effects and receipt/S0/recovery bytes unchanged`);
  assert(!kinds(f).includes('abandoned'), `${label}: no abandoned line`);
  assert(!JSON.stringify(value).includes(f.dir), `${label}: diagnostic without private paths`);
  return value;
}
function assertAttemptOutput(f, expected) {
  for (const root of f.request.execution_contract.code_roots) assert.equal(text(path.join(root.path, 'same.txt')), expected, root.id);
}

// ── Cases ───────────────────────────────────────────────────────────────────
async function contractPins() {
  assert.equal(abandon.ABANDON_VERSION, 'attempt-abandon-v1');
  assert.deepEqual([...abandon.REASON_CODES], ['abandon-adapter-required', 'abandon-unit-unsupported', 'abandon-identity-conflict',
    'abandon-refusal-not-operational', 'abandon-writer-live', 'abandon-writer-unknown', 'abandon-descendants-unproved',
    'abandon-descendants-alive', 'abandon-root-unproved', 'abandon-questions-pending', 'abandon-authority-missing',
    'abandon-authority-invalid', 'abandon-baseline-missing', 'abandon-baseline-invalid', 'abandon-delta-legacy',
    'abandon-delta-unexplained', 'abandon-backup-unverified', 'abandon-changed-after-proof', 'abandon-reset-partial',
    'abandon-reset-unproved', 'abandon-record-conflict', 'abandon-input-invalid']);
  assert.deepEqual([...abandon.EVENT_NAMES], ['attempt-replay-refused', 'attempt-abandon-refused', 'attempt-abandoned',
    'attempt-successor-admitted', 'attempt-successor-refused']);
  assert.deepEqual([...abandon.LINE_KINDS], ['refusal', 'owner-event', 'proofs', 'backup', 'reset-started', 'reset-root',
    'reset-verified', 'reset-partial', 'abandoned', 'successor-admitted', 'refused']);
  for (const value of [abandon.REASON_CODES, abandon.EVENT_NAMES, abandon.LINE_KINDS, abandon]) assert(Object.isFrozen(value) || value === abandon);
  assert(abandon.REASON_CODES.every(code => code.startsWith('abandon-')));
  for (const name of ['createAbandonmentAdapter', 'abandonAttempt', 'readAbandonment', 'recordSuccessorAdmission', 'appendRecoveryEvent']) assert.equal(typeof abandon[name], 'function');
  const ok = { attestWriter() {}, attestRoot() {}, revalidateAttribution() {} };
  for (const missing of ['attestWriter', 'attestRoot', 'revalidateAttribution']) {
    assert.throws(() => abandon.createAbandonmentAdapter({ ...ok, [missing]: undefined }), error => error.code === 'abandon-adapter-required');
  }
  const handle = abandon.createAbandonmentAdapter(ok);
  assert(Object.isFrozen(handle));
  for (const forged of [JSON.parse(JSON.stringify(handle)), { ...handle }, Object.freeze({ kind: 'attempt-abandon-adapter' }), null]) {
    const value = await abandon.abandonAttempt({ request: { scope: 'milestone' }, adapter: forged });
    assert.equal(value.reason_code, 'abandon-adapter-required'); assert.equal(value.provider_called, false);
  }
  // The S0 digest formula is pinned against a receipt produced by captureMilestoneBaseline.
  await withFixture({}, async f => {
    const receipt = JSON.parse(text(f.files.receiptFile));
    assert.equal(abandon.internals.baselineDigest(JSON.parse(text(receipt.recovery_baseline.state_file))), receipt.recovery_baseline.state_sha256);
    assert(receipt.recovery_baseline.managed_surfaces, 'live v1 S0 marker');
  });
}

async function scopeAndIdentity() {
  await withFixture({}, async f => {
    const before = effects(f);
    const variants = [
      [{ ...f.request, scope: 'standalone-task', milestoneId: undefined, sliceId: undefined }, 'abandon-unit-unsupported'],
      [{ ...f.request, unitType: 'review-fix', reviewFix: { boundary: 'task', items: [] } }, 'abandon-unit-unsupported'],
      [{ ...f.request, route: { ...f.request.route, worker_mode: 'native' } }, 'abandon-unit-unsupported'],
      [{ ...f.request, unitType: 'plan-slice', phase: 'plan' }, 'abandon-unit-unsupported'],
      [{ ...f.request, execution_contract: { ...f.request.execution_contract, schema_version: 1 } }, 'abandon-unit-unsupported'],
      [{ ...f.request, dispatchId: 'fixture-other-dispatch' }, 'abandon-identity-conflict'],
      [{ ...f.request, resultFile: path.join(f.dir, 'never-started.json') }, 'abandon-baseline-missing'],
      [{ ...f.request, workflowId: 'fixture-other-workflow' }, 'abandon-identity-conflict'],
    ];
    for (const [request, code] of variants) {
      const value = await abandon.abandonAttempt(f.input({ request }));
      assert.equal(value.reason_code, code, JSON.stringify([request.unitType, request.scope, value]));
      assert.equal(value.provider_called, false);
    }
    // Receipt fields that bind the identity: fingerprint, dispatch and recovery identity.
    const original = fs.readFileSync(f.files.receiptFile);
    for (const [key, value] of [['fingerprint', 'f'.repeat(64)], ['dispatch_id', 'other'], ['recovery_identity_sha256', 'e'.repeat(64)], ['recovery_baseline', undefined]]) {
      const receipt = JSON.parse(original); if (value === undefined) delete receipt[key]; else receipt[key] = value;
      fs.writeFileSync(f.files.receiptFile, JSON.stringify(receipt));
      const result = await abandon.abandonAttempt(f.input());
      assert.equal(result.reason_code, key === 'recovery_baseline' ? 'abandon-baseline-missing' : 'abandon-identity-conflict', key);
      fs.writeFileSync(f.files.receiptFile, original);
    }
    const legacyBaseline = JSON.parse(original); legacyBaseline.recovery_baseline.schema_version = 0;
    fs.writeFileSync(f.files.receiptFile, JSON.stringify(legacyBaseline));
    assert.equal((await abandon.abandonAttempt(f.input())).reason_code, 'abandon-unit-unsupported');
    fs.writeFileSync(f.files.receiptFile, original);
    assert.deepEqual(effects(f), before); assert.equal(fs.existsSync(f.recordFile), false, 'no record before identity holds');
  });
}

async function prerequisites() {
  await withFixture({}, async f => {
    const input = f.input();
    // 2. Operational refusal reclassified live: a divergent held claim is blocking.
    const runFile = require('./forge-runs').runFile(f.owner, 'M001'), runBytes = fs.readFileSync(runFile);
    const run = JSON.parse(runBytes); run.write_claim = { ...run.write_claim, generation: 'fixture-other-generation' };
    fs.writeFileSync(runFile, JSON.stringify(run, null, 2));
    const notOperational = await refused(f, input, 'abandon-refusal-not-operational', 'claim divergent');
    assert.equal(notOperational.detail, 'replay-refusal-claim-divergent');
    fs.writeFileSync(runFile, runBytes);
    // 3. Live process, then writer attestation absent/refused/PID-only.
    await refused(f, { ...input, processProbe: () => 'running' }, 'abandon-writer-live', 'process alive');
    await refused(f, { ...input, processProbe: undefined }, 'abandon-writer-unknown', 'no live probe');
    for (const attestWriter of [() => null, () => { throw new Error('host refused'); }, () => ({ pid: f.child.pid }),
      challenge => ({ status: 'stopped', binding_sha256: digest(challenge), pid: f.child.pid })]) {
      await refused(f, { ...input, adapter: liveAdapter(f, { attestWriter }) }, 'abandon-writer-unknown', 'writer attestation');
    }
    // Descendants: no tree record at all (unknown), then a foreign binding.
    const treeRecord = `${f.files.resultFile}.process-tree.jsonl`;
    fs.renameSync(treeRecord, `${treeRecord}.aside`);
    await refused(f, input, 'abandon-descendants-unproved', 'no tree record');
    fs.renameSync(`${treeRecord}.aside`, treeRecord);
    // Owner and every code root need a live attestation.
    for (const target of ['owner', 'alpha']) {
      await refused(f, { ...input, adapter: liveAdapter(f, { attestRoot: challenge => challenge.root_id === target ? { status: 'stopped' }
        : { binding_sha256: digest(challenge), status: 'stopped', root_id: challenge.root_id, evidence_reference: 'mock:root' } }) },
      CUSTODY ? 'abandon-root-unproved' : 'abandon-descendants-unproved', `root ${target}`);
    }
    // 4. Pending question in the recovery state.
    const stateApi = require('./forge-xllm-state'), stateBytes = fs.readFileSync(f.stateFile);
    const state = stateApi.loadRecovery(f.stateFile);
    stateApi.saveRecovery(f.stateFile, { ...state, pending_questions: [{ id: 'fixture-functional', question: 'Keep fixture?', status: 'pending' }] });
    await refused(f, input, 'abandon-questions-pending', 'recovery-state question');
    fs.writeFileSync(f.stateFile, stateBytes);
    // 5. Authority absent, JSON copy, and revoked (not revalidated by the permanent adapter).
    await refused(f, { ...input, recoveryAuthorization: undefined }, 'abandon-authority-missing', 'authority absent');
    await refused(f, { ...input, recoveryAuthorization: JSON.parse(JSON.stringify(input.recoveryAuthorization)) }, 'abandon-authority-missing', 'authority JSON');
    const revoked = { adapter: f.authority.make(), reference: 'conversation:abandon-revoked' };
    require('./forge-attempt-recovery').bindRecoveryAuthorization({ ...revoked, registration: { host: 'codex', section: SECTION } });
    revoked.adapter.revokeStandingAuthorization(revoked.reference);
    if (CUSTODY) await refused(f, { ...input, recoveryAuthorization: revoked }, 'abandon-authority-invalid', 'authority revoked');
    // 6. S0 tampered (reset-state) and input (plan) divergent.
    const s0 = fs.readFileSync(f.resetState), s0Value = JSON.parse(s0); s0Value.attempt = 'fixture-forged';
    fs.writeFileSync(f.resetState, JSON.stringify(s0Value));
    if (CUSTODY) await refused(f, input, 'abandon-baseline-invalid', 'S0 tampered');
    fs.writeFileSync(f.resetState, s0);
    const plan = fs.readFileSync(f.request.planFile);
    fs.writeFileSync(f.request.planFile, Buffer.concat([plan, Buffer.from('\n')]));
    if (CUSTODY) await refused(f, input, 'abandon-baseline-invalid', 'input divergent');
    fs.writeFileSync(f.request.planFile, plan);
    assertAttemptOutput(f, 'after\n');
    // The same attempt still abandons once every prerequisite holds.
    const done = await abandon.abandonAttempt(input);
    if (!CUSTODY) { assert.equal(done.reason_code, 'abandon-descendants-unproved'); return; }
    assert.equal(done.status, 'abandoned', JSON.stringify(done));
    assertAttemptOutput(f, 'before\n');
  });
  // Pending input questions recorded in the receipt (input_pending_questions).
  await withFixture({ inputQuestions: true }, async f => {
    assert.equal(JSON.parse(text(f.files.receiptFile)).input_pending_questions.length, 1);
    await refused(f, f.input(), 'abandon-questions-pending', 'input_pending_questions');
  });
}

async function deltaExplained() {
  await withFixture({}, async f => {
    const input = f.input();
    if (!CUSTODY) { await refused(f, input, 'abandon-descendants-unproved', 'no custody platform'); return; }
    // Manual owner note and arbitrary file: unexplained, sanitized verdict rows.
    const note = path.join(f.owner, '.gsd/HANDOFF-manual.md');
    put(note, 'manual note\n');
    const manual = await refused(f, input, 'abandon-delta-unexplained', 'manual owner note');
    assert(manual.diagnostic.owner.length >= 1 && manual.diagnostic.owner.every(row => row.status === 'unexplained'));
    assert(!JSON.stringify(manual).includes('HANDOFF-manual'), 'never-declared path is hashed');
    fs.rmSync(note);
    // Same-schema manual append to events.jsonl is not an attributed link.
    const events = path.join(f.owner, '.gsd/forge/events.jsonl'), eventBytes = fs.readFileSync(events);
    fs.appendFileSync(events, JSON.stringify({ event: 'attempt-abandoned', unit: 'execute-task/T01', dispatch_id: f.request.dispatchId }) + '\n');
    const appended = await refused(f, input, 'abandon-delta-unexplained', 'manual same-schema event');
    assert(appended.diagnostic.owner.some(row => row.path === '.gsd/forge/events.jsonl'));
    fs.writeFileSync(events, eventBytes);
    // A code-root change outside the concrete claims: unexplained, before any byte.
    put(path.join(f.a, 'unclaimed.txt'), 'outside claim\n');
    const outside = await refused(f, input, 'abandon-delta-unexplained', 'unclaimed code change');
    assert.equal(outside.diagnostic.reset_code, 'reset-unclaimed-change');
    assert.deepEqual(outside.diagnostic.paths, ['unclaimed.txt']);
    fs.rmSync(path.join(f.a, 'unclaimed.txt'));
    const done = await abandon.abandonAttempt(input);
    assert.equal(done.status, 'abandoned', JSON.stringify(done));
  });
  // Legacy S0 (no managed-surfaces-v1 marker): any owner delta is legacy.
  await withFixture({ legacy: true }, async f => {
    assert.equal(JSON.parse(text(f.files.receiptFile)).recovery_baseline.managed_surfaces, undefined);
    put(path.join(f.owner, '.gsd/legacy-note.md'), 'legacy manual\n');
    await refused(f, f.input(), CUSTODY ? 'abandon-delta-legacy' : 'abandon-descendants-unproved', 'legacy delta');
  });
}

async function realisticPositive() {
  for (const host of ['claude', 'codex']) {
    await withFixture({ host }, async f => {
      const execution = require('./forge-task-execution');
      const receiptBytes = fs.readFileSync(f.files.receiptFile), stateBytes = fs.readFileSync(f.stateFile), s0 = fs.readFileSync(f.resetState);
      const ownerBefore = execution.protectedSnapshot(f.owner);
      const value = await abandon.abandonAttempt(f.input());
      if (!CUSTODY) {
        assert.equal(value.reason_code, 'abandon-descendants-unproved'); assertAttemptOutput(f, 'after\n');
        console.log(`ENV ${host} platform ${process.platform}: no native custody, named refusal`); return;
      }
      assert.equal(value.ok, true, JSON.stringify(value));
      assert.equal(value.status, 'abandoned'); assert.equal(value.provider_called, false);
      assert.equal(value.operation_provider_called, false); assert.equal(value.original_provider_called, 'unknown');
      assert.equal(value.classification_code, 'replay-refusal-transport-no-output');
      assert.deepEqual(value.roots_reset, ['alpha']);
      assertAttemptOutput(f, 'before\n');
      assert.equal(text(path.join(f.a, 'operator.txt')), 'operator\r\n', 'pre-dirty operator file untouched');
      // Receipt, S0, recovery state and the attributed S01 owner surfaces are never reverted.
      assert(fs.readFileSync(f.files.receiptFile).equals(receiptBytes));
      assert(fs.readFileSync(f.stateFile).equals(stateBytes)); assert(fs.readFileSync(f.resetState).equals(s0));
      assert.deepEqual(execution.protectedSnapshot(f.owner), ownerBefore);
      assert.deepEqual(kinds(f), ['refusal', 'proofs', 'backup', 'reset-started', 'reset-root', 'reset-verified', 'abandoned']);
      const rows = lines(f), receiptSha = sha(receiptBytes);
      assert.equal(rows[0].binding.receipt_sha256, receiptSha);
      assert.equal(rows.find(row => row.kind === 'backup').manifest_sha256, value.manifest_sha256);
      assert(rows.every((row, index) => row.seq === index && row.binding_sha256 === rows[0].binding_sha256));
      const proofs = rows.find(row => row.kind === 'proofs');
      assert.equal(proofs.descendants_method, 'process-tree-custody-v1');
      assert.deepEqual(proofs.roots.map(row => row.root_id), ['owner', 'alpha']);
      // Repetition: the same result, no new line, no new effect.
      const before = effects(f), bytes = fs.readFileSync(f.recordFile);
      assert.deepEqual(await abandon.abandonAttempt(f.input()), value);
      assert(fs.readFileSync(f.recordFile).equals(bytes)); assert.deepEqual(effects(f), before);
      const status = abandon.readAbandonment({ request: f.request });
      assert.equal(status.status, 'abandoned'); assert.equal(status.authorizes, false);
      console.log(`ENV ${host}-host positive record ${kinds(f).length} lines, manifest ${value.manifest_sha256.slice(0, 12)}`);
    });
  }
}

async function interruptedVariant() {
  await withFixture({ host: 'claude', mode: 'started' }, async f => {
    const receipt = JSON.parse(text(f.files.receiptFile));
    assert.equal(receipt.phase, 'started');
    if (!CUSTODY) { await refused(f, f.input(), 'abandon-descendants-unproved', 'no custody'); return; }
    // The S0 predates the attributed failure event: the S01 chain explains it only
    // with a live revalidation adapter answer bound to the journal head.
    const events = '.gsd/forge/events.jsonl';
    assert.notEqual(receipt.recovery_baseline.protected_owner[events], require('./forge-task-execution').protectedSnapshot(f.owner)[events]);
    const unproved = await refused(f, { ...f.input(), adapter: liveAdapter(f, { revalidateAttribution: () => ({ observed: true }) }) },
      'abandon-delta-unexplained', 'no live revalidation');
    assert.deepEqual(unproved.diagnostic.owner.map(row => [row.path, row.reason_code]), [[events, 'managed-surface-capability-required']]);
    const value = await abandon.abandonAttempt(f.input());
    assert.equal(value.status, 'abandoned', JSON.stringify(value));
    assert.equal(value.classification_code, 'replay-refusal-interrupted-no-output');
    assertAttemptOutput(f, 'before\n');
  });
}

async function descendantsAlive() {
  let observed = null;
  await withFixture({ host: 'claude', grandchildMs: 2500, during: async f => {
    await new Promise(resolve => setTimeout(resolve, 600));
    // A lying probe says stopped while the family is still inside the job.
    observed = await abandon.abandonAttempt({ ...f.input(), processProbe: () => 'stopped' });
  } }, async f => {
    assert.equal(observed.ok, false);
    assert.equal(observed.reason_code, CUSTODY ? 'abandon-descendants-alive' : 'abandon-descendants-unproved', JSON.stringify(observed));
    assert(!kinds(f).includes('proofs'));
    assertAttemptOutput(f, 'after\n');
  });
}

async function changedAfterProof() {
  await withFixture({}, async f => {
    if (!CUSTODY) { await refused(f, f.input(), 'abandon-descendants-unproved', 'no custody'); return; }
    const treeRecord = `${f.files.resultFile}.process-tree.jsonl`;
    const targets = [
      ['receipt', f.files.receiptFile, 'proofs-observed'], ['recovery-state', f.stateFile, 'proofs-observed'],
      ['process-tree', treeRecord, 'proofs-observed'], ['owner', path.join(f.owner, '.gsd/forge-prefs.jsonc'), 'proofs-observed'],
      ['root', path.join(f.a, 'operator.txt'), 'proofs-observed'], ['claimed', path.join(f.a, 'same.txt'), 'backup-taken'],
      ['backup', path.join(`${f.files.resultFile}.abandon`, 'backup', 'manifest.json'), 'backup-taken'],
    ];
    for (const [label, file, point] of targets) {
      let original = null;
      const value = await abandon.abandonAttempt(f.input({ failpoint: name => {
        if (name === point) { original = fs.readFileSync(file); fs.writeFileSync(file, Buffer.concat([original, Buffer.from(' ')])); }
        return false;
      } }));
      assert.equal(value.reason_code, 'abandon-changed-after-proof', `${label}: ${JSON.stringify(value)}`);
      assertAttemptOutput(f, label === 'claimed' ? 'after\n ' : 'after\n');
      assert(!kinds(f).includes('reset-started') && !kinds(f).includes('abandoned'), label);
      fs.writeFileSync(file, original);
    }
    const done = await abandon.abandonAttempt(f.input());
    assert.equal(done.status, 'abandoned', JSON.stringify(done));
    assert.equal(kinds(f).filter(kind => kind === 'proofs').length, 1);
    assert.equal(kinds(f).filter(kind => kind === 'backup').length, 1);
  });
}

function restartChild(f, operation) {
  const input = path.join(f.dir, `restart-${operation}.json`);
  fs.writeFileSync(input, JSON.stringify({ request: f.request, operation, profile: f.profile }));
  const run = cp.spawnSync(process.execPath, [__filename, '--restart-child', input], { encoding: 'utf8', timeout: 120000, windowsHide: true, env: process.env });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
}
async function restartEveryBoundary() {
  await withFixture({ host: 'claude', twoRoots: true, mode: 'started' }, async f => {
    if (!CUSTODY) { await refused(f, f.input(), 'abandon-descendants-unproved', 'no custody'); return; }
    const points = ['after-refusal', 'after-proofs', 'after-backup', 'after-reset-started', 'after-reset-root', 'between-roots', 'after-reset-verified', 'after-abandoned'];
    const crashes = [];
    for (const point of points) {
      let thrown = null;
      try { await abandon.abandonAttempt(f.input({ failpoint: name => name === point })); } catch (error) { thrown = error; }
      if (thrown) { assert.equal(thrown.code, 'ABANDON_FAILPOINT', point); crashes.push(point); }
      if (point === 'after-backup') {
        // A new Node process has no live custody origin: unknown, refused, history kept.
        const before = effects(f), bytes = fs.readFileSync(f.recordFile);
        const child = restartChild(f, 'abandon');
        assert.equal(child.reason_code, 'abandon-descendants-unproved', JSON.stringify(child));
        assert.deepEqual(effects(f), before); assert(fs.readFileSync(f.recordFile).subarray(0, bytes.length).equals(bytes));
      }
    }
    assert(crashes.includes('after-reset-root') && crashes.includes('between-roots'), JSON.stringify(crashes));
    const final = await abandon.abandonAttempt(f.input());
    assert.equal(final.status, 'abandoned', JSON.stringify(final));
    assert.deepEqual(final.roots_reset, ['alpha', 'beta']);
    assertAttemptOutput(f, 'before\n');
    const seen = kinds(f).filter(kind => kind !== 'refused');
    assert.deepEqual(seen, ['refusal', 'proofs', 'backup', 'reset-started', 'reset-root', 'reset-root', 'reset-verified', 'abandoned'], JSON.stringify(kinds(f)));
    assert.deepEqual(await abandon.abandonAttempt(f.input()), final);
    // Successor admission: live in this process; never from the record after a restart.
    const successor = { dispatch_id: require('./forge-recovery-dispatch-id').recoveryDispatchId(f.request.dispatchId, 'fixture-successor') };
    const child = restartChild(f, 'successor');
    assert.equal(child.reason_code, 'abandon-descendants-unproved', JSON.stringify(child));
    const admitted = await abandon.recordSuccessorAdmission(f.input({ successor }));
    assert.equal(admitted.status, 'successor-admitted', JSON.stringify(admitted));
    assert.deepEqual(await abandon.recordSuccessorAdmission(f.input({ successor })), admitted);
    const other = await abandon.recordSuccessorAdmission(f.input({ successor: { dispatch_id: `${f.request.dispatchId}-recovery-other` } }));
    assert.equal(other.reason_code, 'abandon-record-conflict');
    const invalid = await abandon.recordSuccessorAdmission(f.input({ successor: { dispatch_id: 'unrelated' } }));
    assert.equal(invalid.reason_code, 'abandon-input-invalid');
    assert.equal(abandon.readAbandonment({ request: f.request }).status, 'successor-admitted');
  });
}

async function resetPartial() {
  await withFixture({ twoRoots: true }, async f => {
    if (!CUSTODY) { await refused(f, f.input(), 'abandon-descendants-unproved', 'no custody'); return; }
    const beta = path.join(f.b, 'same.txt');
    const value = await abandon.abandonAttempt(f.input({ failpoint: name => {
      if (name === 'after-reset-root') fs.writeFileSync(beta, 'after\nlate writer\n');
      return false;
    } }));
    assert.equal(value.status, 'blocked', JSON.stringify(value));
    assert.equal(value.reason_code, 'abandon-reset-partial');
    assert.deepEqual(value.effects.roots_done, ['alpha']); assert.deepEqual(value.effects.pending_roots, ['beta']);
    assert.deepEqual(value.effects.altered, [{ root_id: 'alpha', paths: ['same.txt'] }]);
    assert.equal(value.successor, false);
    assert.equal(text(path.join(f.a, 'same.txt')), 'before\n'); assert.equal(text(beta), 'after\nlate writer\n');
    const manifest = path.join(`${f.files.resultFile}.abandon`, 'backup', 'manifest.json'), manifestBytes = fs.readFileSync(manifest);
    assert(kinds(f).includes('reset-partial') && !kinds(f).includes('abandoned'));
    const successor = { dispatch_id: require('./forge-recovery-dispatch-id').recoveryDispatchId(f.request.dispatchId, 'partial') };
    const blocked = await abandon.recordSuccessorAdmission(f.input({ successor }));
    assert.equal(blocked.reason_code, 'abandon-reset-partial');
    assert.equal(abandon.readAbandonment({ request: f.request }).status, 'blocked');
    // Resumption after the late writer is gone: live proofs again, then every root proved.
    fs.writeFileSync(beta, 'after\n');
    const resumed = await abandon.abandonAttempt(f.input());
    assert.equal(resumed.status, 'abandoned', JSON.stringify(resumed));
    assert(fs.readFileSync(manifest).equals(manifestBytes));
    assertAttemptOutput(f, 'before\n');
    assert.equal(kinds(f).filter(kind => kind === 'reset-verified').length, 1);
  });
}

async function ownerEvents() {
  await withFixture({}, async f => {
    const events = path.join(f.owner, '.gsd/forge/events.jsonl');
    const invalid = abandon.appendRecoveryEvent({ request: f.request, event: 'attempt-abandoned', reason_code: null });
    assert.equal(invalid.reason_code, 'abandon-input-invalid', 'no record yet');
    // A refusal creates history; emitted events go through the guarded owner append.
    const first = await abandon.abandonAttempt(f.input({ emitEvents: true, recoveryAuthorization: undefined }));
    assert.equal(first.reason_code, CUSTODY ? 'abandon-authority-missing' : 'abandon-descendants-unproved');
    const emitted = text(events).trim().split('\n').slice(-2).map(line => JSON.parse(line));
    assert.deepEqual(emitted.map(row => row.event), ['attempt-replay-refused', 'attempt-abandon-refused']);
    for (const row of emitted) {
      assert.deepEqual(Object.keys(row), ['event', 'unit', 'dispatch_id', 'reason_code', 'record_sha256']);
      assert.equal(row.unit, 'execute-task/T01'); assert(/^[a-f0-9]{64}$/.test(row.record_sha256));
      assert(!JSON.stringify(row).includes(f.dir));
    }
    const recorded = lines(f).filter(row => row.kind === 'owner-event');
    assert.deepEqual(recorded.map(row => row.status), ['appended', 'appended']);
    const tail = text(events).trim().split('\n').slice(-2);
    assert.deepEqual(recorded.map(row => row.event_sha256), tail.map(line => sha(Buffer.from(line + '\n'))));
    assert.equal(abandon.appendRecoveryEvent({ request: f.request, event: 'attempt-unknown' }).reason_code, 'abandon-input-invalid');
    // Busy owner fence: no owner byte, recorded pending-window.
    const windows = require('./forge-owner-transport-window');
    const cap = windows.open(f.owner, { kind: 'artifact-preparation', task_id: 'T99', dispatch_id: 'fixture-fence', request_sha256: 'a'.repeat(64) });
    const ownerBytes = fs.readFileSync(events);
    const pending = abandon.appendRecoveryEvent({ request: f.request, event: 'attempt-replay-refused', reason_code: 'replay-refusal-transport-no-output' });
    assert.equal(pending.owner_event, 'pending-window'); assert(fs.readFileSync(events).equals(ownerBytes));
    assert.equal(lines(f).at(-1).owner_event, 'pending-window');
    windows.close(cap, challenge => ({ challenge_sha256: digest(challenge), joined: true, possible_writers: 0, reference: 'mock:fence-closed' }));
    // The record explains its own appends in a new evaluation; the positive still holds.
    const done = await abandon.abandonAttempt(f.input({ emitEvents: true }));
    if (!CUSTODY) { assert.equal(done.reason_code, 'abandon-descendants-unproved'); return; }
    assert.equal(done.status, 'abandoned', JSON.stringify(done));
    assert.equal(JSON.parse(text(events).trim().split('\n').at(-1)).event, 'attempt-abandoned');
  });
}

async function forgedRecords() {
  let foreign = null;
  await withFixture({ host: 'codex' }, async f => {
    await abandon.abandonAttempt(f.input({ recoveryAuthorization: undefined }));
    foreign = fs.readFileSync(f.recordFile);
  });
  await withFixture({ host: 'claude' }, async f => {
    // A record copied from another attempt binds another receipt/identity.
    fs.writeFileSync(f.recordFile, foreign, { mode: 0o600 });
    await refused(f, f.input(), 'abandon-record-conflict', 'copied record');
    fs.rmSync(f.recordFile);
    await abandon.abandonAttempt(f.input({ recoveryAuthorization: undefined }));
    const bytes = fs.readFileSync(f.recordFile), changed = Buffer.from(bytes);
    changed[changed.indexOf('"refusal"') + 2] ^= 1;
    fs.writeFileSync(f.recordFile, changed);
    await refused(f, f.input(), 'abandon-record-conflict', 'altered line');
    fs.writeFileSync(f.recordFile, Buffer.concat([bytes, Buffer.from('{"v":"attempt-abandon-v1"}\n')]));
    await refused(f, f.input(), 'abandon-record-conflict', 'appended foreign line');
    assert.equal(abandon.readAbandonment({ request: f.request }).reason_code, 'abandon-record-conflict');
    fs.writeFileSync(f.recordFile, bytes);
    const linked = `${f.recordFile}.link`; fs.linkSync(f.recordFile, linked);
    await refused(f, f.input(), 'abandon-record-conflict', 'hard-linked record');
    fs.rmSync(linked);
    const done = await abandon.abandonAttempt(f.input());
    if (CUSTODY) assert.equal(done.status, 'abandoned', JSON.stringify(done));
  });
}

const cases = [
  { name: 'T0 contract codes events version and opaque adapter', fn: contractPins },
  { name: 'T1 scope and identity refuse before any effect', fn: scopeAndIdentity },
  { name: 'T2 every prerequisite refuses by name with zero effects', fn: prerequisites },
  { name: 'T3 owner, events and code-root deltas must be explained', fn: deltaExplained },
  { name: 'T4 realistic positive on claude and codex hosts', fn: realisticPositive },
  { name: 'T4 interrupted started receipt abandons through custody', fn: interruptedVariant },
  { name: 'T2 live family inside the job is alive', fn: descendantsAlive },
  { name: 'T5 a byte changed after the proofs refuses before reset', fn: changedAfterProof },
  { name: 'T7 restart at every boundary converges and successor needs live origin', fn: restartEveryBoundary },
  { name: 'T7 partial reset blocks and resumes from the same backup', fn: resetPartial },
  { name: 'T8 guarded owner events, busy fence and own-append explanation', fn: ownerEvents },
  { name: 'T6 copied, altered and linked records conflict', fn: forgedRecords },
];

async function restartMain(file) {
  // Fresh Node process: same request bytes, live callbacks, but no custody origin.
  const input = JSON.parse(fs.readFileSync(file, 'utf8'));
  const adapter = abandon.createAbandonmentAdapter({
    attestWriter: challenge => ({ status: 'stopped', binding_sha256: digest(challenge), writer_identity: 'mock-restarted-host',
      evidence_reference: 'mock:restart', ...challenge }),
    attestRoot: challenge => ({ binding_sha256: digest(challenge), status: 'stopped', root_id: challenge.root_id, evidence_reference: 'mock:restart' }),
    revalidateAttribution: challenge => ({ observed: true, journal_sha256: challenge.journal_sha256, attempt_sha256: challenge.attempt_sha256, reference: 'mock:restart' }) });
  // The standing authority is re-opened from the same OS-profile store (live adapter).
  const recoveryAuthorization = { reference: REFERENCE, adapter: require('./forge-interaction').createRecoveryAuthorizationAdapter(
    observed => ({ ...observed, received: true, answer: 'authorize', resolved_at: Date.now() - 1000 }), { resolveProfile: () => input.profile }) };
  const options = { request: input.request, adapter, processProbe: () => 'stopped', recoveryAuthorization };
  const value = input.operation === 'successor'
    ? await abandon.recordSuccessorAdmission({ ...options, successor: { dispatch_id: require('./forge-recovery-dispatch-id').recoveryDispatchId(input.request.dispatchId, 'restart') } })
    : await abandon.abandonAttempt(options);
  process.stdout.write(JSON.stringify(value) + '\n');
}
async function main() {
  if (process.argv[2] === '--restart-child') return restartMain(process.argv[3]);
  let passed = 0;
  for (const row of require('./forge-ci-units').selectCases(cases)) {
    const started = Date.now();
    await row.fn();
    passed++;
    console.log(`PASS ${row.name} (${Date.now() - started} ms)`);
  }
  console.log(`${passed}/${cases.length} forge-attempt-abandon cases passed (platform ${process.platform}, custody ${CUSTODY ? 'native' : 'unavailable'}, provider_calls 0)`);
}
module.exports = { cases };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
