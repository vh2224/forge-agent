'use strict';

// End-to-end suite for issue 440, S02/T06: replay first, closed refusal
// (replay-refusal-v1), safe abandonment (T04) and the successor attempt inside
// the SAME controller begin (same lease generation and write claim), driven only
// through public APIs: recoverUnitSidecar, runUnitSidecar, abandonAttempt and
// admitAttemptSuccessor. Real temporary owner and git roots, controller begin,
// lease and claim gate, protected owner activity, S0, T02 custody, T03 backup and
// claimed reset, T04 record. ONLY the transport is synthetic and labelled `mock`
// (xllm.runExecute); the host adapters are live in-process callbacks labelled
// `mock`. Primary route: host Claude -> worker Codex (app-server); host Codex ->
// worker Claude is the regression. No provider, account, network or real state.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const abandon = require('./forge-attempt-abandon');
const recovery = require('./forge-attempt-recovery');
const controller = require('./forge-unit-controller');
const roots = require('./forge-code-roots');
const lab = require('./forge-code-roots.test');
const { activityRequest } = require('./forge-issues-429-432.test');
const { ceilingFromRoute } = require('./forge-worker-timeout');
const { recoveryDispatchId } = require('./forge-recovery-dispatch-id');
const TIME_CODES = require('./forge-milestone-time-admission').TRANSPORT_REFUSAL_CODES;
const source = path.resolve(__dirname, '..');
const CUSTODY = process.platform === 'win32';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const { digest } = roots;
const put = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const read = file => (fs.existsSync(file) ? fs.readFileSync(file) : null);
const text = file => fs.readFileSync(file, 'utf8');
const MOCK_FAILURE = 'claude-exit-nonzero';
const REFERENCE = 'conversation:issue-440-recovery-fixture';
const SECTION = 'user:forge-routing-continuity';
const TIERS = ['light', 'standard', 'heavy', 'max'];
// Two-candidate chains per host (mock routing only; no model is contacted).
const CHAINS = { claude: ['gpt-6.1-sol', 'gpt-5.6-terra'], codex: ['claude-opus-5-5', 'claude-sonnet-5-5'] };
const HELPER = "const fs=require('fs'),p=require('path'),cp=require('child_process');const wait=Number(process.argv[1]);"
  + "for(const d of process.argv.slice(2))fs.writeFileSync(p.join(d,'same.txt'),'after\\n');"
  + "const g=cp.spawn(process.execPath,['-e','setTimeout(()=>{},'+wait+')'],{stdio:'ignore'});g.on('exit',()=>process.exit(0));";
const WRITER = "require('fs').writeFileSync('same.txt','after\\n')";
const DONE = Object.freeze({ status: 'done', summary: 'mock delivery', files_changed: ['same.txt'], must_haves_status: [] });

// ── Fixture ─────────────────────────────────────────────────────────────────
function authority(f) {
  put(path.join(f.profile, '.codex/AGENTS.md'), `<!-- ${SECTION}:start -->\nFixture standing authorization.\n<!-- ${SECTION}:end -->\n`);
  const make = () => require('./forge-interaction').createRecoveryAuthorizationAdapter(observed => ({ ...observed,
    received: true, answer: 'authorize', resolved_at: Date.now() - 1000 }), { resolveProfile: () => f.profile });
  const adapter = make();
  recovery.bindRecoveryAuthorization({ adapter, reference: REFERENCE, registration: { host: 'codex', section: SECTION } });
  return { adapter, reference: REFERENCE };
}
// Live mock host: it answers only about the transport child this process spawned.
function liveAdapter(f, overrides = {}) {
  return abandon.createAbandonmentAdapter({
    attestWriter: challenge => {
      if (!f.parent || f.parent.exitCode === null) return { status: 'running' };
      return { status: 'stopped', binding_sha256: digest(challenge), writer_identity: `mock-transport:${f.parent.pid}`,
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
function waitClose(child) { return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
function spawnIn(scope, cwd, code, args = []) {
  const xllm = require('./forge-xllm');
  return scope.spawn(process.execPath, ['-e', code, ...args], { cwd, env: xllm.buildSidecarEnv('minimal'), windowsHide: true, stdio: 'ignore' });
}
// The first transport call is the original attempt; later calls are successors.
async function originalTransport(f, mode, scope, runOptions) {
  if (mode === 'time') {
    throw Object.assign(new Error('mock transport: time refusal at the last launch hook, before any provider'),
      { code: 'milestone-budget-exhausted', provider_called: false, stage: 'milestone-time-admission', layer: 'milestone-time-admission' });
  }
  if (mode === 'ready' || mode === 'returned') {
    if (mode === 'ready') { const child = spawnIn(scope, runOptions.cwd, WRITER); f.parent = child; assert.equal(await waitClose(child), 0); }
    return { ...DONE };
  }
  f.started = fs.readFileSync(f.files.receiptFile);
  const dirs = f.request.execution_contract.code_roots.map(root => root.path);
  f.parent = spawnIn(scope, runOptions.cwd, HELPER, [String(150), ...dirs]);
  assert.equal(await waitClose(f.parent), 0);
  throw Object.assign(new Error('mock transport failure after the controlled helper exited'), { code: MOCK_FAILURE });
}
async function successorTransport(f, scope, runOptions) {
  const child = spawnIn(scope, runOptions.cwd, WRITER);
  assert.equal(await waitClose(child), 0);
  return { ...DONE, summary: 'mock successor delivery' };
}
function leaseRecord(f) {
  const lease = require('./forge-unit-lease');
  return lease.readLease(lease.leaseFile(f.owner, 'execute-task/T01')).record;
}
async function attemptFixture({ host = 'claude', chain = 2, mode = 'failed' } = {}) {
  const f = lab.fixture(), env = { ...process.env };
  const xllm = require('./forge-xllm'), activity = require('./forge-protected-owner-activity'), sidecar = require('./forge-unit-sidecar');
  const previous = xllm.runExecute;
  f.restore = () => { xllm.runExecute = previous; process.env = env; };
  try {
    const home = path.join(f.dir, 'home'); fs.mkdirSync(home);
    f.profile = path.join(f.dir, 'profile'); fs.mkdirSync(f.profile);
    Object.assign(process.env, { HOME: home, USERPROFILE: home, FORGE_HOME: source });
    const request = activityRequest(f, host);
    if (chain === 2) {
      put(path.join(f.owner, '.gsd/forge-prefs.jsonc'), JSON.stringify({ tier_models: Object.fromEntries(TIERS.map(tier => [tier, CHAINS[host]])) }));
      request.route = require('./forge-dispatch-resolve').resolveDispatch({ cwd: f.owner, unitType: 'execute-task', milestoneId: 'M001',
        unitId: 'T01', planPath: request.planFile, hostRuntime: host });
      assert.equal(request.route.worker_mode, 'sidecar'); assert.equal(request.route.chain.length, 2);
    }
    // Operator state present before the attempt: an untracked (pre_dirty) file.
    put(path.join(f.a, 'operator.txt'), 'operator\r\n');
    Object.assign(f, { request, host, mode, calls: 0, scopes: [], parent: null });
    f.authority = authority(f);
    f.files = sidecar.artifactAttemptFiles(request);
    f.stateFile = `${f.files.resultFile}.recovery.json`; f.recordFile = `${f.files.resultFile}.abandon.jsonl`;
    f.adapter = liveAdapter(f);
    f.lease = leaseRecord(f);
    xllm.runExecute = async runOptions => {
      f.calls++;
      runOptions.onBeforeSpawn?.();
      const scope = activity.currentScope(); assert(scope, 'mock transport inside the protected activity scope');
      f.scopes.push({ unit: scope.unit, generation: scope.generation });
      return f.calls === 1 ? originalTransport(f, mode, scope, runOptions) : successorTransport(f, scope, runOptions);
    };
    const run = sidecar.runUnitSidecar(request, {});
    if (mode === 'ready') assert.equal((await run).status, 'done');
    else await assert.rejects(run, error => mode === 'returned' || error.code === (mode === 'time' ? 'milestone-budget-exhausted' : MOCK_FAILURE));
    if (mode === 'started') {
      // Host crash before the failure was recorded: the started receipt (with S0) remains.
      fs.writeFileSync(f.files.receiptFile, f.started);
      fs.rmSync(f.files.resultFile, { force: true }); fs.rmSync(f.stateFile, { force: true });
    }
    f.resetState = JSON.parse(text(f.files.receiptFile)).recovery_baseline?.state_file || null;
    f.beginChecksum = controller.recordChecksum(controller.lookupRecord(f.owner, 'transaction', 'fixture-begin'));
    return f;
  } catch (error) { f.restore(); f.cleanup(); throw error; }
}
async function withFixture(options, fn) {
  const f = await attemptFixture(options);
  try { return await fn(f); } finally { f.restore(); f.cleanup(); }
}
function runtime(f, extra = {}) {
  return { processProbe: () => (f.parent && f.parent.exitCode === null ? 'running' : 'stopped'),
    recoveryAuthorization: { adapter: f.authority.adapter, reference: f.authority.reference }, ...extra };
}
function recover(f, extra = {}, runtimeExtra = {}) {
  return require('./forge-unit-sidecar').recoverUnitSidecar(f.request, { stateFile: f.stateFile, receiptFile: f.files.receiptFile,
    abandonment: f.adapter, ...extra }, runtime(f, runtimeExtra));
}
function abandonInput(f, extra = {}) {
  return { request: f.request, adapter: f.adapter, processProbe: runtime(f).processProbe,
    recoveryAuthorization: runtime(f).recoveryAuthorization, ...extra };
}
const state = f => (fs.existsSync(f.stateFile) ? JSON.parse(text(f.stateFile)) : null);
const kinds = f => (fs.existsSync(f.recordFile) ? text(f.recordFile).trim().split('\n').map(line => JSON.parse(line).kind) : []);
const successors = f => fs.readdirSync(f.dir).filter(name => /^activity-result\.json\.recovery-.+\.json\.receipt\.json$/.test(name));
function recoveryEvents(f) {
  const file = path.join(f.owner, '.gsd/forge/events.jsonl');
  return fs.existsSync(file) ? text(file).trim().split('\n').map(line => JSON.parse(line)).filter(row => abandon.EVENT_NAMES.includes(row.event)) : [];
}
// Every observable effect a refusal before the mutation must leave untouched.
function effects(f) {
  const current = state(f);
  return { receipt: sha(fs.readFileSync(f.files.receiptFile)), reset_state: f.resetState ? sha(fs.readFileSync(f.resetState)) : null,
    same: text(path.join(f.a, 'same.txt')), operator: text(path.join(f.a, 'operator.txt')), calls: f.calls,
    reservations: current?.reservations?.length || 0, abandonments: current?.abandonments?.length || 0,
    successors: successors(f).length, abandoned: kinds(f).includes('abandoned'), lease: JSON.stringify(leaseRecord(f)) };
}
function noMutation(before, after, label, except = []) {
  for (const key of ['receipt', 'reset_state', 'same', 'operator', 'calls', 'reservations', 'abandonments', 'successors', 'abandoned', 'lease']) {
    if (except.includes(key)) continue;
    assert.deepEqual(after[key], before[key], `${label}: ${key} unchanged (no reset, no reservation, no new begin)`);
  }
}
function childRecover(f, operation) {
  const input = path.join(f.dir, `child-${operation}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(input, JSON.stringify({ request: f.request, stateFile: f.stateFile, receiptFile: f.files.receiptFile, profile: f.profile, operation }));
  const run = cp.spawnSync(process.execPath, [__filename, '--child', input], { encoding: 'utf8', timeout: 180000, windowsHide: true, env: process.env });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
}

// ── Cases ───────────────────────────────────────────────────────────────────
async function contractAndState() {
  assert.deepEqual([...controller.ATTEMPT_SUCCESSOR_CODES], ['attempt-successor-begin-changed', 'attempt-successor-generation-changed',
    'attempt-successor-claim-divergent', 'attempt-successor-terminal']);
  assert(Object.isFrozen(controller.ATTEMPT_SUCCESSOR_CODES));
  assert.equal(typeof controller.admitAttemptSuccessor, 'function');
  // The pinned public inventory (Object.keys) is unchanged: both exports are non-enumerable.
  for (const name of ['ATTEMPT_SUCCESSOR_CODES', 'admitAttemptSuccessor']) {
    assert(!Object.keys(controller).includes(name)); assert.equal(Object.prototype.propertyIsEnumerable.call(controller, name), false);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-440-recovery-'));
  try {
    const cases = [[{ phase: 'ready' }, 'ready'], [{ phase: 'executed', returned_response: { sha256: 'a' } }, 'executed'],
      [{ phase: 'failed', saved_candidate: { sha256: 'a' } }, 'saved-candidate'], [{ phase: 'failed', failure: { returned_response: {} } }, 'returned-custody'],
      [{ phase: 'failed', returned_response: {} }, 'returned-custody'], [{ phase: 'started' }, null], [{ phase: 'failed', failure: { reason_code: MOCK_FAILURE } }, null]];
    for (const [receipt, expected] of cases) {
      const file = path.join(dir, 'receipt.json'); fs.writeFileSync(file, JSON.stringify(receipt));
      const inspected = recovery.inspectReceipt(file, { processProbe: () => 'stopped' });
      assert.equal(inspected.retained_output, expected, JSON.stringify(receipt));
      assert.deepEqual(Object.keys(inspected), ['receipt_checked', 'process_stopped', 'receipt_sha256', 'phase', 'incomplete_execution',
        'valid_saved_response', 'writer_possible', 'roots_reconciled', 'retained_output', 'receipt'], 'only the additive key');
    }
    // validateState stays compatible; the additive histories must be arrays.
    const base = { schema_version: 2, budget: 'tier-ceiling', unit: 'execute-task/T01', started_at: 1, attempts: [], pending_questions: [] };
    assert.equal(recovery.validateState({ ...base, replay_refusals: [], abandonments: [] }).unit, 'execute-task/T01');
    for (const key of ['replay_refusals', 'abandonments']) assert.throws(() => recovery.validateState({ ...base, [key]: {} }), /recovery-state-invalid/);
    // Append-only refusal history: validated, deduplicated, prefix preserved.
    let saved = null;
    const session = recovery.createRecovery({ unit: 'execute-task/T01', roots_sha256: 'r', clock: () => 5, persist: value => { saved = value; } });
    const refusalSet = require('./forge-replay-refusal');
    const classify = factsPatch => refusalSet.classifyReplayRefusal({ version: refusalSet.REFUSAL_SET_VERSION,
      inspection: { receipt_checked: true, process_stopped: true, receipt_sha256: 'a'.repeat(64), phase: 'failed', valid_saved_response: false,
        incomplete_execution: false, retained_output: null },
      receipt: { phase: 'failed', failure: { reason_code: MOCK_FAILURE, provider_called: 'unknown' } },
      replay: { attempted: true, refused: true, reason_code: MOCK_FAILURE, provider_called: false },
      facts: { identity_matches: true, claim_matches: true, pending_questions: [], authority_present: true, failure_class: 'unknown', ...factsPatch } });
    const operational = classify({}), blocking = classify({ authority_present: false });
    assert.equal(operational.code, 'replay-refusal-transport-no-output'); assert.equal(blocking.code, 'replay-refusal-authority-missing');
    assert.equal(session.recordReplayRefusal(operational), true); assert.equal(session.recordReplayRefusal(operational), false);
    const first = structuredClone(saved.replay_refusals[0]);
    assert.equal(session.recordReplayRefusal(blocking), true);
    assert.deepEqual(saved.replay_refusals[0], first, 'prefix preserved'); assert.equal(saved.replay_refusals.length, 2);
    assert.equal(first.classification_sha256, digest(operational));
    assert.throws(() => session.recordReplayRefusal({ ...operational, code: 'replay-refusal-forged' }), /replay-refusal-classification-invalid/);
    const outcome = { ok: true, status: 'abandoned', record_sha256: 'b'.repeat(64), roots_reset: ['alpha'], classification_code: operational.code };
    assert.equal(session.recordAbandonment(outcome), true); assert.equal(session.recordAbandonment(outcome), false);
    assert.equal(saved.abandonments.length, 1); assert.equal(saved.abandonments[0].original_provider_called, 'unknown');
    for (const forged of [null, { ...outcome, ok: false }, { ...outcome, record_sha256: 'x' }]) assert.throws(() => session.recordAbandonment(forged), /recovery-state-invalid/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function legacyWithoutHandle() {
  await withFixture({ host: 'claude' }, async f => {
    const stateBefore = fs.readFileSync(f.stateFile), resetBefore = JSON.parse(text(f.resetState));
    let outcome, failure = null;
    try { outcome = await recover(f, { abandonment: undefined }, { verifyOwnership: () => true }); } catch (error) { failure = error; }
    // The legacy reconcile (reconcileMilestoneAttempt -> reconcileFailedAttempt) ran: it alone
    // records `reconciliation` in the reset state; the abandonment branch never does.
    assert(JSON.parse(text(f.resetState)).reconciliation, `legacy reconcile used: ${failure?.code || outcome?.action}`);
    assert.equal(resetBefore.reconciliation, undefined);
    assert.equal(fs.existsSync(f.recordFile), false, 'no abandonment record without the handle');
    const after = state(f);
    for (const key of ['replay_refusals', 'abandonments']) assert.equal(Object.hasOwn(after, key), false, key);
    assert(!(after.reservations || []).some(row => Object.hasOwn(row, 'abandonment')));
    assert.equal(recoveryEvents(f).length, 0);
    if (outcome) assert.equal(Object.hasOwn(outcome, 'abandonment'), false);
    assert(fs.readFileSync(f.stateFile).length >= stateBefore.length);
    console.log(`ENV legacy without handle: ${failure ? 'refused ' + failure.code : outcome.action}`);
  });
}

async function replayFirst() {
  // Ready receipt: published by replay, zero transport calls, repeat and fresh process.
  await withFixture({ host: 'claude', chain: 1, mode: 'ready' }, async f => {
    const execution = require('./forge-task-execution');
    const hashes = () => ({ receipt: sha(fs.readFileSync(f.files.receiptFile)), result: sha(fs.readFileSync(f.files.resultFile)),
      owner: digest(execution.protectedSnapshot(f.owner)) });
    const before = hashes();
    for (const label of ['first', 'repeat']) {
      const value = await recover(f);
      assert.equal(value.action, 'replay', label); assert.equal(value.provider_called, false);
      assert.equal(value.result.status, 'done'); assert.equal(f.calls, 1, `${label}: transport not called`);
      assert.deepEqual(hashes(), before, `${label}: no duplicated artifact, event or receipt`);
    }
    const child = childRecover(f, 'replay');
    assert.equal(child.action, 'replay'); assert.equal(child.calls, 0); assert.deepEqual(hashes(), before, 'fresh process: stable hashes');
    assert.equal(fs.existsSync(f.stateFile), false); assert.equal(fs.existsSync(f.recordFile), false);
  });
  // Saved candidate with a signed anchor: reconcileArtifactAttempt publishes it (current path).
  const h = require('./forge-recovery-transition.test'), xllm = require('./forge-xllm');
  const f = await h.candidateFixture(false, true);
  const wrapped = Object.keys(xllm).filter(name => /^run[A-Z]/.test(name) && typeof xllm[name] === 'function');
  const originals = Object.fromEntries(wrapped.map(name => [name, xllm[name]]));
  let calls = 0;
  try {
    for (const name of wrapped) xllm[name] = async () => { calls++; throw new Error('mock transport: replay must not infer'); };
    const handle = abandon.createAbandonmentAdapter({ attestWriter() {}, attestRoot() {}, revalidateAttribution() {} });
    const run = () => require('./forge-unit-sidecar').recoverUnitSidecar(f.request, { stateFile: f.stateFile, receiptFile: f.receiptFile,
      clock: () => f.now, reconciliation: f.reconciliation, abandonment: handle }, { processProbe: () => 'stopped', recoveryAuthorization: f.binding });
    const value = await run();
    assert.equal(value.action, 'replay', JSON.stringify(value)); assert.equal(calls, 0);
    assert.deepEqual(value.abandonment, { status: 'not-applicable', reason_code: 'abandon-unit-unsupported', provider_called: false });
    const published = fs.readFileSync(f.receiptFile);
    const again = await run();
    assert.equal(again.action, 'replay'); assert.equal(calls, 0); assert(fs.readFileSync(f.receiptFile).equals(published), 'repeat: same receipt');
  } finally { for (const name of wrapped) xllm[name] = originals[name]; f.cleanup(); }
  // Returned custody without a live repair capability: retained output, never abandonment.
  await withFixture({ host: 'claude', chain: 2, mode: 'returned' }, async f => {
    const inspected = recovery.inspectReceipt(f.files.receiptFile, { processProbe: () => 'stopped' });
    assert(['returned-custody', 'executed'].includes(inspected.retained_output), inspected.retained_output);
    const before = effects(f), phase = JSON.parse(text(f.files.receiptFile)).phase;
    const value = await recover(f);
    assert.equal(value.reason_code, 'replay-refusal-retained-output', JSON.stringify(value));
    // The current publisher's own replay bookkeeping may touch the receipt; the phase and
    // every recovery effect (reset, reservation, abandonment, successor) stay untouched.
    noMutation(before, effects(f), 'returned custody', ['receipt']);
    assert.equal(JSON.parse(text(f.files.receiptFile)).phase, phase);
    assert.equal(value.classification.code, 'replay-refusal-retained-output'); assert.equal(value.provider_called, false);
    assert(!kinds(f).includes('proofs'), 'never reaches an abandonment proof');
    assert.deepEqual(recoveryEvents(f).map(row => [row.event, row.reason_code]), [['attempt-replay-refused', 'replay-refusal-retained-output']]);
  });
}

async function positiveBothHosts() {
  for (const host of ['claude', 'codex']) {
    await withFixture({ host }, async f => {
      const runs = require('./forge-runs'), claim = digest(runs.get(f.owner, 'M001').write_claim);
      const transactions = fs.readdirSync(controller.transactionDir(f.owner)).sort();
      const receiptBytes = fs.readFileSync(f.files.receiptFile), resetBytes = fs.readFileSync(f.resetState);
      const questions = state(f).pending_questions;
      if (host === 'codex') {
        // Boundary "abandonment concluded" reached by the public T04 API first.
        const done = await abandon.abandonAttempt(abandonInput(f, { emitEvents: true }));
        assert.equal(done.status, CUSTODY ? 'abandoned' : 'refused', JSON.stringify(done));
      }
      const value = await recover(f);
      if (!CUSTODY) {
        assert.equal(value.reason_code, 'abandon-descendants-unproved'); assert.equal(f.calls, 1);
        assert.equal(text(path.join(f.a, 'same.txt')), 'after\n'); console.log(`ENV ${host}: no native custody, named refusal`); return;
      }
      assert.equal(value.action, 'invoke', JSON.stringify(value)); assert.equal(value.result.status, 'done');
      assert.equal(value.provider_called, false); assert.equal(value.abandonment.status, 'abandoned');
      assert.equal(value.abandonment.classification_code, 'replay-refusal-transport-no-output');
      assert.equal(value.route.model, CHAINS[host][1], 'next untried candidate of the original list');
      assert.deepEqual(value.sidecar_ceiling, ceilingFromRoute(value.route), 'full tier ceiling');
      assert.equal(value.authorization_reference, REFERENCE);
      assert.equal(f.calls, 2, 'one original call and one successor call');
      // Same controller begin: same lease generation, begin record, write claim; no new begin.
      assert.equal(f.scopes[1].generation, f.lease.generation); assert.equal(f.scopes[0].generation, f.lease.generation);
      assert.equal(leaseRecord(f).request_id, 'fixture-begin');
      assert.equal(controller.recordChecksum(controller.lookupRecord(f.owner, 'transaction', 'fixture-begin')), f.beginChecksum);
      assert.deepEqual(fs.readdirSync(controller.transactionDir(f.owner)).sort(), transactions); assert.equal(controller.pendingTransactions(f.owner).length, 0);
      assert.equal(digest(runs.get(f.owner, 'M001').write_claim), claim);
      const current = state(f);
      assert.deepEqual(current.replay_refusals.map(row => row.code), ['replay-refusal-transport-no-output']);
      assert.deepEqual(current.abandonments.map(row => row.record_sha256), [value.abandonment.record_sha256]);
      assert.equal(current.reservations.length, 1);
      assert.equal(current.reservations[0].abandonment.record_sha256, value.abandonment.record_sha256, 'reservation carries the record');
      assert.equal(current.reservations[0].route_key, recovery.routeKey(value.route));
      assert.deepEqual(current.pending_questions, questions, 'questions preserved');
      // The successor attempt: dispatch derived from the parent, same authority, tier ceiling.
      const names = successors(f); assert.equal(names.length, 1);
      const successor = JSON.parse(text(path.join(f.dir, names[0])));
      const suffix = successor.dispatch_id.slice(`${f.request.dispatchId}-recovery-`.length);
      assert(successor.dispatch_id.startsWith(`${f.request.dispatchId}-recovery-`));
      assert.equal(successor.dispatch_id, recoveryDispatchId(f.request.dispatchId, suffix));
      // One exact identity: T04 admission = reservation = decision = the actually invoked receipt.
      const admittedId = abandon.readAbandonment({ request: f.request }).successor.dispatch_id;
      assert.equal(current.reservations[0].abandonment.successor_dispatch_id, admittedId, 'reservation carries the admitted id');
      assert.equal(value.abandonment.successor_admission.dispatch_id, admittedId);
      assert.equal(successor.dispatch_id, admittedId, 'the invoked receipt is exactly the admitted successor');
      assert.equal(successor.authorization_reference, REFERENCE); assert.equal(successor.route.model, CHAINS[host][1]);
      assert.equal(successor.route.workers_timeout, ceilingFromRoute(value.route).seconds);
      assert.equal(successor.phase, 'ready');
      assert.equal(digest(successor.recovery_baseline.execution_contract), digest(JSON.parse(receiptBytes).recovery_baseline.execution_contract),
        'same execution_contract and roots');
      assert.deepEqual(kinds(f), ['refusal', 'owner-event', 'proofs', 'backup', 'reset-started', 'reset-root', 'reset-verified',
        'abandoned', 'owner-event', 'successor-admitted', 'owner-event'], 'T04 record: refusal, proofs, reset, abandoned, successor');
      // History: original receipt and S0 untouched; T04 record and guarded owner events.
      assert(fs.readFileSync(f.files.receiptFile).equals(receiptBytes)); assert(fs.readFileSync(f.resetState).equals(resetBytes));
      assert(kinds(f).includes('successor-admitted'));
      const status = abandon.readAbandonment({ request: f.request });
      assert.equal(status.status, 'successor-admitted'); assert.equal(status.authorizes, false);
      const events = recoveryEvents(f).map(row => row.event);
      for (const name of ['attempt-replay-refused', 'attempt-abandoned', 'attempt-successor-admitted']) assert(events.includes(name), name);
      assert(events.indexOf('attempt-abandoned') < events.indexOf('attempt-successor-admitted'));
      // Idempotency after the reservation boundary: no second reservation, abandonment or successor.
      const record = fs.readFileSync(f.recordFile), stateBytes = fs.readFileSync(f.stateFile);
      const rerun = await recover(f);
      assert(['recovery-reservation-pending', 'recovery-reservation-consumed'].includes(rerun.reason_code), JSON.stringify(rerun));
      assert.equal(f.calls, 2); assert.equal(successors(f).length, 1);
      assert(fs.readFileSync(f.recordFile).equals(record)); assert(fs.readFileSync(f.stateFile).equals(stateBytes));
      console.log(`ENV ${host}-host positive: successor ${CHAINS[host][1]}, record ${kinds(f).length} lines`);
    });
  }
}

async function singleCandidateStarted() {
  await withFixture({ host: 'claude', chain: 1, mode: 'started' }, async f => {
    assert.equal(fs.existsSync(f.stateFile), false, 'host crash: no recovery state');
    const receipt = JSON.parse(text(f.files.receiptFile)); assert.equal(receipt.phase, 'started');
    const value = await recover(f);
    if (!CUSTODY) { assert.equal(value.reason_code, 'abandon-descendants-unproved'); return; }
    assert.equal(value.reason_code, 'recovery-candidates-exhausted', JSON.stringify(value));
    assert.equal(value.abandonment.status, 'abandoned'); assert.equal(value.abandonment.classification_code, 'replay-refusal-interrupted-no-output');
    assert.equal(text(path.join(f.a, 'same.txt')), 'before\n', 'claimed reset proved'); assert.equal(text(path.join(f.a, 'operator.txt')), 'operator\r\n');
    const current = state(f);
    assert.equal(current.attempts.length, 1);
    const attempt = current.attempts[0];
    assert.equal(attempt.failure_class, 'interrupted'); assert.equal(attempt.reason_code, 'sidecar-attempt-interrupted');
    assert.equal(attempt.provider_called, 'unknown'); assert.equal(attempt.model_observed, 'unknown');
    assert.deepEqual(attempt.route, receipt.route, 'recorded with the receipt route');
    assert.equal(current.abandonments.length, 1); assert.equal(current.reservations, undefined); assert.equal(f.calls, 1);
    // Idempotent: the same stop, the abandonment is history (no new line, entry or reservation).
    const record = fs.readFileSync(f.recordFile);
    const rerun = await recover(f);
    assert.equal(rerun.reason_code, 'recovery-candidates-exhausted');
    assert(fs.readFileSync(f.recordFile).equals(record)); assert.equal(state(f).abandonments.length, 1);
    assert.equal(state(f).replay_refusals.length, 1); assert.equal(state(f).attempts.length, 1);
  });
}

async function negativesThenPositive() {
  await withFixture({ host: 'claude' }, async f => {
    const check = async (label, action, expect) => {
      const before = effects(f);
      let value, failure = null;
      try { value = await action(); } catch (error) { failure = error; }
      expect(value, failure);
      noMutation(before, effects(f), label);
      return value;
    };
    // Writer alive: refused before any classification or abandonment.
    await check('writer alive', () => recover(f, {}, { processProbe: () => 'running' }),
      (value, error) => assert.equal(error?.code, 'recovery-process-receipt-inspection-required'));
    // A JSON copy of the opaque handle is not the handle.
    await check('forged handle', () => recover(f, { abandonment: JSON.parse(JSON.stringify(f.adapter)) }),
      value => assert.equal(value.reason_code, 'abandon-adapter-required'));
    // Authority absent: blocking refusal registered once, event once, idempotent rerun.
    await check('authority missing', () => recover(f, {}, { recoveryAuthorization: undefined }),
      value => assert.equal(value.reason_code, 'replay-refusal-authority-missing'));
    const refusals = state(f).replay_refusals.length, events = recoveryEvents(f).length;
    await check('authority missing again', () => recover(f, {}, { recoveryAuthorization: undefined }),
      value => assert.equal(value.reason_code, 'replay-refusal-authority-missing'));
    assert.equal(state(f).replay_refusals.length, refusals); assert.equal(recoveryEvents(f).length, events);
    assert.deepEqual(recoveryEvents(f).map(row => row.event), ['attempt-replay-refused']);
    // Pending functional question in the recovery state.
    const stateApi = require('./forge-xllm-state'), stateBytes = fs.readFileSync(f.stateFile);
    stateApi.saveRecovery(f.stateFile, { ...stateApi.loadRecovery(f.stateFile), pending_questions: [{ id: 'fixture-functional', question: 'Keep fixture?', status: 'pending' }] });
    await check('pending question', () => recover(f), value => {
      assert.equal(value.action, 'pending-questions'); assert.equal(value.reason_code, 'replay-refusal-question-pending');
    });
    fs.writeFileSync(f.stateFile, stateBytes);
    // Writer unknown: no process-tree record (custody never proven), then no writer attestation.
    const tree = `${f.files.resultFile}.process-tree.jsonl`;
    fs.renameSync(tree, `${tree}.aside`);
    await check('no tree record', () => recover(f), value => assert.equal(value.reason_code, 'abandon-descendants-unproved'));
    fs.renameSync(`${tree}.aside`, tree);
    await check('writer unknown', () => recover(f, { abandonment: liveAdapter(f, { attestWriter: () => null }) }),
      value => assert.equal(value.reason_code, CUSTODY ? 'abandon-writer-unknown' : 'abandon-descendants-unproved'));
    // Unexplained owner delta (manual note).
    const note = path.join(f.owner, '.gsd/HANDOFF-manual.md'); put(note, 'manual note\n');
    await check('delta unexplained', () => recover(f), value => assert.equal(value.reason_code, CUSTODY ? 'abandon-delta-unexplained' : 'abandon-descendants-unproved'));
    fs.rmSync(note);
    // Baseline absent (legacy receipt): named, the current path refuses it.
    const receiptBytes = fs.readFileSync(f.files.receiptFile), legacy = JSON.parse(receiptBytes); delete legacy.recovery_baseline;
    fs.writeFileSync(f.files.receiptFile, JSON.stringify(legacy));
    const legacyBefore = effects(f);
    await assert.rejects(recover(f), error => error.code === 'recovery-baseline-required');
    noMutation(legacyBefore, effects(f), 'baseline missing');
    fs.writeFileSync(f.files.receiptFile, receiptBytes);
    // Write after the proof (public T04 API with its failpoint).
    const same = path.join(f.a, 'same.txt');
    const changed = await abandon.abandonAttempt(abandonInput(f, { failpoint: name => {
      if (name === 'backup-taken') fs.writeFileSync(same, 'after\nlate\n');
      return false;
    } }));
    assert.equal(changed.reason_code, CUSTODY ? 'abandon-changed-after-proof' : 'abandon-descendants-unproved');
    assert(!kinds(f).includes('reset-started')); fs.writeFileSync(same, 'after\n');
    // Divergent held claim.
    const runFile = require('./forge-runs').runFile(f.owner, 'M001'), runBytes = fs.readFileSync(runFile);
    const run = JSON.parse(runBytes); run.write_claim = { ...run.write_claim, generation: 'fixture-other-generation' };
    fs.writeFileSync(runFile, JSON.stringify(run, null, 2));
    await check('claim divergent', () => recover(f), (value, error) => assert(/claim/.test(error?.code || value?.reason_code || ''), String(error?.code || JSON.stringify(value))));
    fs.writeFileSync(runFile, runBytes);
    assert.equal(f.calls, 1); assert.equal(text(same), 'after\n');
    // Abandonment boundary, then a fresh Node process: no live custody origin, so the
    // historical abandoned record never admits a successor.
    const done = await abandon.abandonAttempt(abandonInput(f, { emitEvents: true }));
    if (!CUSTODY) { assert.equal(done.reason_code, 'abandon-descendants-unproved'); return; }
    assert.equal(done.status, 'abandoned', JSON.stringify(done));
    const child = childRecover(f, 'recover');
    assert.equal(child.reason_code, 'abandon-descendants-unproved', JSON.stringify(child)); assert.equal(child.calls, 0);
    assert.equal(state(f).reservations, undefined); assert.equal(successors(f).length, 0);
    // The live process still owns the origin: the successor is admitted once.
    const value = await recover(f);
    assert.equal(value.action, 'invoke', JSON.stringify(value)); assert.equal(f.calls, 2);
    assert.equal(state(f).abandonments.length, 1); assert.equal(state(f).reservations.length, 1);
    assert.equal(recoveryEvents(f).filter(row => row.event === 'attempt-successor-refused').length, 1, 'the restart refusal was recorded');
  });
}

async function timeAdmission() {
  // A time refusal at transport entry is blocking: no abandonment, reset or successor.
  await withFixture({ host: 'claude', mode: 'time' }, async f => {
    const before = effects(f);
    const value = await recover(f);
    // captureFailure records a pre-provider refusal (provider_called false) as class
    // `caller`, and replay-refusal-v1 ranks caller-defect before time-admission: the
    // observed stop is that blocking code, with the time code as its closed source.
    assert.equal(value.reason_code, 'replay-refusal-caller-defect', JSON.stringify(value));
    assert.equal(value.classification.source_reason_code, 'milestone-budget-exhausted'); assert.equal(value.classification.eligible, false);
    noMutation(before, effects(f), 'time refusal'); assert.equal(f.calls, 1); assert.equal(f.parent, null);
    assert(!kinds(f).includes('proofs')); assert.equal(state(f).abandonments, undefined);
  });
}

function activate(owner, base) {
  const questions = require('./forge-pending-questions'), time = require('./forge-milestone-time'), id = 'budget-fixture';
  const opened = questions.openQuestions({ cwd: owner, milestone: 'M001', unit: 'milestone-time/' + id,
    decision_set: 'milestone-time-activation', questions: [{ id, question: 'Fixture choice?' }] });
  questions.answer({ cwd: owner, identity: opened.identity_sha256, answers: [{ id, answer: 'option:fixture', source: 'user-text' }] });
  const iso = value => new Date(value).toISOString();
  const contract = { schema_version: 1, milestone: 'M001', clock_policy: { id: 'forge-milestone-time-clock', version: 1 },
    option: { id: 'fixture', options_sha256: 'a'.repeat(64), label: 'Verified fixture' }, activated_at: iso(base),
    preselection_started_at: iso(base), ceiling_ms: 100,
    endpoint: { kind: 'verified-integrated-delivery', items: Object.fromEntries(time.ENDPOINT_ITEMS.map(k => [k, 'pending'])) },
    allocation: null, linked_task: null, chain_forecast: null };
  const live = { reference: 'live-' + id, status: 'resolved', answer: 'option:fixture', source: 'user-text',
    resolved_at: iso(base), question: { identity_sha256: opened.identity_sha256, id } };
  const handle = time.createDecisionAuthority(() => live).issue(live.reference,
    { milestone: 'M001', kind: 'activation', request_sha256: digest(contract), expires_at: base + 60000 }, () => base);
  time.activateContract({ cwd: owner, milestone: 'M001', contract, now: base, handle });
}
async function controllerAdmission() {
  const fixture = async fn => {
    const f = lab.fixture(), env = { ...process.env };
    try {
      const home = path.join(f.dir, 'home'); fs.mkdirSync(home);
      Object.assign(process.env, { HOME: home, USERPROFILE: home, FORGE_HOME: source });
      f.request = activityRequest(f, 'codex'); f.lease = leaseRecord(f);
      f.input = (patch = {}) => ({ milestone: 'M001', unit: 'execute-task/T01', begin_key: f.lease.request_id, lease_generation: f.lease.generation,
        owner_token: f.lease.owner_token, host_runtime: 'codex', run_id: 'M001', claim: f.request.claim, ...patch });
      return await fn(f);
    } finally { process.env = env; f.cleanup(); }
  };
  const refuse = (f, patch, code, label, options) => assert.throws(() => controller.admitAttemptSuccessor(f.owner, f.input(patch), options),
    error => error.code === code, label);
  await fixture(async f => {
    const execution = require('./forge-task-execution');
    const owner = digest(execution.protectedSnapshot(f.owner)), lease = fs.readFileSync(require('./forge-unit-lease').leaseFile(f.owner, 'execute-task/T01'));
    const admitted = controller.admitAttemptSuccessor(f.owner, f.input());
    assert.equal(admitted.ok, true); assert(Object.isFrozen(admitted)); assert.equal(admitted.lease_generation, f.lease.generation);
    assert.equal(admitted.provider_called, false); assert.equal(admitted.time_admission, 'no-contract');
    // Read-only: no record, lease, claim or generation; owner bytes identical.
    assert.equal(digest(execution.protectedSnapshot(f.owner)), owner, 'owner unchanged');
    assert(fs.readFileSync(require('./forge-unit-lease').leaseFile(f.owner, 'execute-task/T01')).equals(lease));
    refuse(f, { claim: { ...f.request.claim, generation: 'fixture-other' } }, 'attempt-successor-claim-divergent', 'claim');
    refuse(f, { lease_generation: 'fixture-other-generation' }, 'attempt-successor-generation-changed', 'generation');
    refuse(f, { begin_key: 'fixture-unknown-begin' }, 'attempt-successor-begin-changed', 'begin');
    refuse(f, { owner_token: 'fixture-other-owner' }, 'attempt-successor-begin-changed', 'owner');
    assert.equal(digest(execution.protectedSnapshot(f.owner)), owner, 'refusals are read-only too');
    // An uncommitted terminal intent is pending; once committed it is terminal.
    const terminal = { milestone: 'M001', unit: 'execute-task/T01', host_runtime: 'codex', owner_token: f.lease.owner_token,
      generation: f.lease.generation, idempotency_key: 'fixture-begin:pause', result: { status: 'cancelled', summary: 'fixture' } };
    const prefsReader = () => ({ ok: true, prefs: { workflow: { skip_discuss: true, skip_research: true } } });
    assert.throws(() => controller.pause(f.owner, terminal, { prefsReader, failpoint: name => name === 'after-intent' }), /failpoint/);
    refuse(f, {}, 'transaction-pending', 'pending');
    controller.pause(f.owner, terminal, { prefsReader });
    refuse(f, {}, 'attempt-successor-terminal', 'terminal');
  });
  await fixture(async f => {
    // Exhausted milestone time contract: the canonical time decision prevails.
    activate(f.owner, Date.now() - 3600000);
    let code = null;
    try { controller.admitAttemptSuccessor(f.owner, f.input(), { now: Date.now() }); } catch (error) { code = error.code; }
    assert(TIME_CODES.includes(code), String(code));
    console.log(`ENV controller time admission refused with ${code}`);
  });
}

function spyOn(target, name, calls) {
  const original = target[name];
  target[name] = function spied(...args) { calls.push({ name, request: !!args[0]?.request }); return original.apply(this, args); };
  return () => { target[name] = original; };
}
// T06-R3: a blocking refusal is recorded by the refusal-only seam. No capability able to
// prove a writer, back up, reset or admit is ever called with a request.
async function blockingRefusalNeverAbandons() {
  await withFixture({ host: 'claude' }, async f => {
    const surgical = require('./forge-surgical-reset'), calls = [];
    const restore = [spyOn(abandon, 'abandonAttempt', calls), spyOn(abandon, 'recordSuccessorAdmission', calls),
      spyOn(surgical, 'backupResetTargets', calls), spyOn(surgical, 'resetClaimedAttempt', calls)];
    try {
      const before = effects(f);
      const value = await recover(f, {}, { recoveryAuthorization: undefined });
      assert.equal(value.reason_code, 'replay-refusal-authority-missing', JSON.stringify(value));
      assert.deepEqual(calls.filter(row => row.request || /^(backup|reset)/.test(row.name)), [], 'no mutation-capable call');
      noMutation(before, effects(f), 'blocking refusal');
      assert.deepEqual(kinds(f), ['refusal', 'owner-event'], 'only the refusal anchor and its guarded event');
      assert.deepEqual(recoveryEvents(f).map(row => [row.event, row.reason_code]), [['attempt-replay-refused', 'replay-refusal-authority-missing']]);
      const record = fs.readFileSync(f.recordFile);
      await recover(f, {}, { recoveryAuthorization: undefined });
      assert(fs.readFileSync(f.recordFile).equals(record), 'repeat is idempotent'); assert.equal(recoveryEvents(f).length, 1);
      // The seam itself refuses a forged handle and an eligible (operational) classification.
      const operational = require('./forge-replay-refusal');
      assert.equal((await abandon.recordRefusal({ request: f.request, adapter: JSON.parse(JSON.stringify(f.adapter)),
        classification: value.classification })).reason_code, 'abandon-adapter-required');
      assert.equal((await abandon.recordRefusal({ request: f.request, adapter: f.adapter, classification: { code: 'replay-refusal-forged' } })).reason_code,
        'abandon-input-invalid');
      assert.equal(typeof operational.isEligible, 'function');
    } finally { for (const undo of restore) undo(); }
  });
}
// T06-R1/R2/R5/R6: exact successor identity, missing lease stop, exact durable refusal
// codes, and a cut between the admission and the reservation.
async function successorBoundaries() {
  await withFixture({ host: 'claude' }, async f => {
    if (!CUSTODY) { console.log('ENV successor boundaries: no native custody, named refusal elsewhere'); return; }
    const done = await abandon.abandonAttempt(abandonInput(f, { emitEvents: true }));
    assert.equal(done.status, 'abandoned', JSON.stringify(done));
    const stateFilePath = f.stateFile, leaseFile = require('./forge-unit-lease').leaseFile(f.owner, 'execute-task/T01');
    const refusedEvents = () => recoveryEvents(f).filter(row => row.event === 'attempt-successor-refused');
    const nothingReserved = label => {
      assert.equal(state(f)?.reservations?.length || 0, 0, `${label}: no reservation`); assert.equal(successors(f).length, 0, `${label}: no successor`);
      assert.equal(f.calls, 1, `${label}: no invocation`);
    };
    // R2: the held lease is missing at the admission boundary.
    const leaseBytes = fs.readFileSync(leaseFile); fs.rmSync(leaseFile);
    const missing = await recover(f);
    fs.writeFileSync(leaseFile, leaseBytes);
    assert.equal(missing.reason_code, 'attempt-successor-generation-changed', JSON.stringify(missing));
    nothingReserved('missing lease'); assert(!kinds(f).includes('successor-admitted'));
    assert.deepEqual(refusedEvents().map(row => row.reason_code), ['attempt-successor-generation-changed'], 'exact durable code');
    // R5: a controller refusal keeps its exact code in the durable event, once per identical retry.
    const runFile = require('./forge-runs').runFile(f.owner, 'M001'), runBytes = fs.readFileSync(runFile);
    const run = JSON.parse(runBytes); run.write_claim = { ...run.write_claim, generation: 'fixture-other-generation' };
    fs.writeFileSync(runFile, JSON.stringify(run, null, 2));
    const divergent = await recover(f).catch(error => ({ reason_code: error.code }));
    fs.writeFileSync(runFile, runBytes);
    assert(/claim/.test(divergent.reason_code), JSON.stringify(divergent)); nothingReserved('divergent claim');
    console.log(`ENV divergent claim after abandonment stops with ${divergent.reason_code}`);
    if (controller.ATTEMPT_SUCCESSOR_CODES.includes(divergent.reason_code)) {
      assert.equal(refusedEvents().at(-1).reason_code, divergent.reason_code, 'exact durable controller code');
      const count = refusedEvents().length;
      fs.writeFileSync(runFile, JSON.stringify(run, null, 2));
      await recover(f).catch(() => null);
      fs.writeFileSync(runFile, runBytes);
      assert.equal(refusedEvents().length, count, 'identical retry appends no duplicate event');
    }
    // The durable event accepts only the closed controller/time codes, and only for the refused-successor event.
    const append = (event, reason_code) => abandon.appendRecoveryEvent({ request: f.request, event, reason_code });
    assert.equal(append('attempt-successor-refused', 'attempt-successor-terminal').ok, true);
    assert.equal(append('attempt-successor-refused', 'transaction-pending').ok, true);
    assert.equal(append('attempt-successor-refused', TIME_CODES[0]).ok, true);
    assert.equal(append('attempt-successor-refused', 'fixture-unlisted-code').reason_code, 'abandon-input-invalid');
    assert.equal(append('attempt-abandoned', 'attempt-successor-terminal').reason_code, 'abandon-input-invalid');
    // R1/R6: the cut between the admission record and the reservation.
    const original = abandon.appendRecoveryEvent; let cut = false;
    abandon.appendRecoveryEvent = function cutOnce(input) {
      if (!cut && input?.event === 'attempt-successor-admitted') { cut = true; throw new Error('fixture cut after the admission, before the reservation'); }
      return original.call(this, input);
    };
    try { await assert.rejects(recover(f), /fixture cut/); } finally { abandon.appendRecoveryEvent = original; }
    assert(cut); assert(kinds(f).includes('successor-admitted')); nothingReserved('cut');
    assert.equal(recoveryEvents(f).filter(row => row.event === 'attempt-successor-admitted').length, 0);
    const admittedId = abandon.readAbandonment({ request: f.request }).successor.dispatch_id;
    // No live authority: zero effects, nothing reserved, nothing invoked.
    const stateBytes = fs.existsSync(stateFilePath) ? fs.readFileSync(stateFilePath) : null;
    const unauthorized = await recover(f, {}, { recoveryAuthorization: undefined }).catch(error => ({ reason_code: error.code }));
    assert.notEqual(unauthorized.action, 'invoke', JSON.stringify(unauthorized)); nothingReserved('no live authority');
    assert(!stateBytes || state(f).reservations === undefined || state(f).reservations.length === 0);
    // Live resume: exactly one reservation and one successor, both the admitted identity.
    const resumed = await recover(f);
    assert.equal(resumed.action, 'invoke', JSON.stringify(resumed)); assert.equal(f.calls, 2);
    assert.equal(state(f).reservations.length, 1);
    assert.equal(state(f).reservations[0].abandonment.successor_dispatch_id, admittedId);
    assert.equal(resumed.abandonment.successor_admission.dispatch_id, admittedId);
    const names = successors(f); assert.equal(names.length, 1);
    assert.equal(JSON.parse(text(path.join(f.dir, names[0]))).dispatch_id, admittedId, 'the invoked receipt is the admitted successor');
    assert.equal(recoveryEvents(f).filter(row => row.event === 'attempt-successor-admitted').length, 1);
    assert.equal(kinds(f).filter(kind => kind === 'successor-admitted').length, 1);
    const rerun = await recover(f);
    assert(['recovery-reservation-pending', 'recovery-reservation-consumed'].includes(rerun.reason_code), JSON.stringify(rerun));
    assert.equal(f.calls, 2); assert.equal(successors(f).length, 1); assert.equal(state(f).reservations.length, 1);
    assert.equal(controller.pendingTransactions(f.owner).length, 0);
  });
}

// T06-R5: the exact controller refusal reaches the durable event (a pending transaction here).
async function controllerRefusalIsDurable() {
  await withFixture({ host: 'claude' }, async f => {
    if (!CUSTODY) { console.log('ENV durable controller refusal: no native custody'); return; }
    const done = await abandon.abandonAttempt(abandonInput(f, { emitEvents: true }));
    assert.equal(done.status, 'abandoned', JSON.stringify(done));
    const prefsReader = () => ({ ok: true, prefs: { workflow: { skip_discuss: true, skip_research: true } } });
    const intent = { milestone: 'M001', unit: 'execute-task/T01', host_runtime: f.lease.host_runtime, owner_token: f.lease.owner_token,
      generation: f.lease.generation, idempotency_key: 'fixture-begin:pause', result: { status: 'cancelled', summary: 'fixture' } };
    assert.throws(() => controller.pause(f.owner, intent, { prefsReader, failpoint: name => name === 'after-intent' }), /failpoint/);
    const refused = () => recoveryEvents(f).filter(row => row.event === 'attempt-successor-refused');
    const first = await recover(f);
    console.log(`ENV pending controller transaction stops with ${first.reason_code}`);
    assert.equal(first.reason_code, 'transaction-pending', JSON.stringify(first));
    assert.deepEqual(refused().map(row => row.reason_code), ['transaction-pending'], 'exact durable code');
    const again = await recover(f);
    assert.equal(again.reason_code, 'transaction-pending'); assert.equal(refused().length, 1, 'identical retry: no duplicate event');
    assert.equal(state(f)?.reservations?.length || 0, 0); assert.equal(successors(f).length, 0); assert.equal(f.calls, 1);
    assert(!kinds(f).includes('successor-admitted'));
  });
}

// Admission history cannot authorize a different descriptor or a dirty reset baseline.
async function successorAdmissionReplayGuards() {
  await withFixture({ host: 'claude' }, async f => {
    if (!CUSTODY) { console.log('ENV admission replay guards: Windows custody required'); return; }
    const done = await abandon.abandonAttempt(abandonInput(f));
    assert.equal(done.status, 'abandoned', JSON.stringify(done));
    const candidate = { ...f.request.route, model: CHAINS.claude[1], model_resolved: CHAINS.claude[1], sidecar_model: CHAINS.claude[1] };
    const successor = { dispatch_id: recoveryDispatchId(f.request.dispatchId, 'fixture-admission-replay'), kind: 'successor-dispatch',
      route_key: recovery.routeKey(candidate), abandonment_record_sha256: done.record_sha256 };
    const admit = descriptor => abandon.recordSuccessorAdmission({ ...abandonInput(f), successor: descriptor });
    const admitted = await admit(successor);
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    const prefix = fs.readFileSync(f.recordFile), beforeRoute = effects(f);
    const alternate = { ...successor, route_key: recovery.routeKey(f.request.route) };
    assert.notEqual(alternate.route_key, successor.route_key);
    const changedRoute = await admit(alternate), afterRoute = effects(f);
    const claimed = path.join(f.a, 'same.txt'), originalBytes = fs.readFileSync(claimed), lateBytes = Buffer.from('operator-write-after-admission\n');
    fs.writeFileSync(claimed, lateBytes);
    const beforeDirty = effects(f), dirtyReset = await admit(successor), afterDirty = effects(f), preservedLateBytes = fs.readFileSync(claimed);
    // Restore only this fixture's own bytes, then verify the unchanged valid replay.
    fs.writeFileSync(claimed, originalBytes);
    const repeated = await admit(successor), record = fs.readFileSync(f.recordFile);
    console.log(JSON.stringify({ label: 'admission-replay-guards', changed_route_ok: changedRoute.ok,
      changed_route_code: changedRoute.reason_code || null, dirty_reset_ok: dirtyReset.ok,
      dirty_reset_code: dirtyReset.reason_code || null, valid_repeat_ok: repeated.ok, transport_calls: f.calls, provider_calls: 0 }));
    assert.equal(changedRoute.ok, false, 'same dispatch must not admit a different route descriptor');
    assert.equal(changedRoute.reason_code, 'abandon-record-conflict');
    noMutation(beforeRoute, afterRoute, 'changed admission descriptor');
    assert.equal(dirtyReset.ok, false, 'admission replay must revalidate the claimed reset baseline');
    assert(['abandon-reset-unproved', 'abandon-changed-after-proof'].includes(dirtyReset.reason_code), JSON.stringify(dirtyReset));
    assert(preservedLateBytes.equals(lateBytes), 'refusal preserves the operator write without resetting it');
    noMutation(beforeDirty, afterDirty, 'dirty admission replay');
    assert(record.subarray(0, prefix.length).equals(prefix), 'immutable admission prefix retained');
    assert.equal(repeated.ok, true, JSON.stringify(repeated));
    assert.equal(repeated.record_sha256, admitted.record_sha256, 'valid replay returns the same admission anchor');
    assert.equal(kinds(f).filter(kind => kind === 'successor-admitted').length, 1);
    assert.equal(state(f)?.reservations?.length || 0, 0);
    assert.equal(successors(f).length, 0);
    assert.equal(f.calls, 1, 'no successor transport invocation');
  });
}

const cases = [
  { name: 'T0 contract, retained_output and append-only state', fn: contractAndState },
  { name: 'T1 legacy without handle keeps reconcile and state shape', fn: legacyWithoutHandle },
  { name: 'A1 replay first: ready, signed candidate, returned custody', fn: replayFirst },
  { name: 'A5 positive host claude and host codex with idempotent rerun', fn: positiveBothHosts },
  { name: 'A5 single candidate after host crash stops exhausted', fn: singleCandidateStarted },
  { name: 'A2 negatives refuse by code, then live successor', fn: negativesThenPositive },
  { name: 'A5 time refusal at transport entry is blocking', fn: timeAdmission },
  { name: 'A5 controller admission is read-only and same-generation', fn: controllerAdmission },
  { name: 'R3 blocking refusal uses the refusal-only seam, never abandonment', fn: blockingRefusalNeverAbandons },
  { name: 'R1/R2/R5/R6 exact successor identity, lease stop, durable codes and cut resume', fn: successorBoundaries },
  { name: 'R5 controller refusal keeps its exact durable code', fn: controllerRefusalIsDurable },
  { name: 'R1 admission replay binds the descriptor and revalidates the reset baseline', fn: successorAdmissionReplayGuards },
];

async function childMain(file) {
  // Fresh Node process: same request bytes and live callbacks, but no custody origin.
  const input = JSON.parse(fs.readFileSync(file, 'utf8')), xllm = require('./forge-xllm');
  let calls = 0;
  xllm.runExecute = async () => { calls++; throw new Error('mock transport: the child must not infer'); };
  const adapter = abandon.createAbandonmentAdapter({
    attestWriter: challenge => ({ status: 'stopped', binding_sha256: digest(challenge), writer_identity: 'mock-restarted-host',
      evidence_reference: 'mock:restart', ...challenge }),
    attestRoot: challenge => ({ binding_sha256: digest(challenge), status: 'stopped', root_id: challenge.root_id, evidence_reference: 'mock:restart' }),
    revalidateAttribution: challenge => ({ observed: true, journal_sha256: challenge.journal_sha256, attempt_sha256: challenge.attempt_sha256, reference: 'mock:restart' }) });
  const recoveryAuthorization = { reference: REFERENCE, adapter: require('./forge-interaction').createRecoveryAuthorizationAdapter(
    observed => ({ ...observed, received: true, answer: 'authorize', resolved_at: Date.now() - 1000 }), { resolveProfile: () => input.profile }) };
  const value = await require('./forge-unit-sidecar').recoverUnitSidecar(input.request, { stateFile: input.stateFile,
    receiptFile: input.receiptFile, abandonment: adapter }, { processProbe: () => 'stopped', recoveryAuthorization });
  process.stdout.write(JSON.stringify({ action: value.action, reason_code: value.reason_code || null, provider_called: value.provider_called, calls }) + '\n');
}
async function main() {
  if (process.argv[2] === '--child') return childMain(process.argv[3]);
  let passed = 0;
  const selected = require('./forge-ci-units').selectCases(cases);
  for (const row of selected) {
    const started = Date.now();
    await row.fn();
    passed++;
    console.log(`PASS ${row.name} (${Date.now() - started} ms)`);
  }
  console.log(`${passed}/${selected.length} forge-issue-440-recovery cases passed (platform ${process.platform}, custody ${CUSTODY ? 'native' : 'unavailable'}, transport mock, provider_calls 0)`);
}
module.exports = { cases };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
