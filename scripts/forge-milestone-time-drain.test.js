#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const time = require('./forge-milestone-time');
const controller = require('./forge-unit-controller');
const state = require('./forge-state');
const lease = require('./forge-unit-lease');
const personal = require('./forge-personal-context');
const recovery = require('./forge-attempt-recovery');
const { digest } = require('./forge-code-roots');
const drain = require('./forge-milestone-time-drain');
const M = 'M001', BASE = Date.parse('2026-11-01T12:00:00.000Z'), roots = [];
const iso = n => new Date(BASE + n).toISOString();
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
let serial = 0, count = 0;
function test(name, fn) { fn(); count++; console.log('PASS ' + name); }
function write(cwd, ref, value) {
  const file = path.join(cwd, ref); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value) + '\n'); return file;
}
function snapshot(cwd, checkpointMutex = false) {
  const rows = {};
  function visit(dir) {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      const relative = path.relative(cwd, file);
      const transientMutex = checkpointMutex && relative === path.join('.gsd', '.locks');
      rows[relative] = [transientMutex ? 'mutex-directory' : stat.mtimeMs, stat.isFile() ? hash(fs.readFileSync(file)) : 'directory'];
      if (stat.isDirectory()) visit(file);
    }
  }
  visit(cwd); return rows;
}
function authorize(cwd, kind, request, answer) {
  const q = require('./forge-pending-questions'), id = 'q' + ++serial;
  const opened = q.openQuestions({ cwd, milestone: M, unit: 'milestone-time/' + id,
    decision_set: 'milestone-time-' + kind, questions: [{ id, question: 'Escolha de fixture?' }] });
  q.answer({ cwd, identity: opened.identity_sha256, answers: [{ id, answer, source: 'user-text' }] });
  const observed = { reference: 'fixture-' + serial, status: 'resolved', answer, resolved_at: iso(0),
    source: 'user-text', question: { identity_sha256: opened.identity_sha256, id } };
  return time.createDecisionAuthority(() => observed).issue(observed.reference,
    { milestone: M, kind, request_sha256: digest(request), expires_at: BASE + 60000 }, () => BASE);
}
function fixture(withContract = true, bound = false) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-time-drain-'));
  roots.push(cwd); fs.mkdirSync(path.join(cwd, '.gsd/forge'), { recursive: true });
  const userHome = path.join(cwd, 'isolated-home'), env = { HOME: userHome, USERPROFILE: userHome };
  if (withContract) {
    const contract = { schema_version: 1, milestone: M, clock_policy: { id: 'forge-milestone-time-clock', version: 1 },
      option: { id: 'balanced', options_sha256: 'a'.repeat(64), label: 'Entrega verificada' },
      activated_at: iso(0), preselection_started_at: iso(-5), ceiling_ms: 100,
      endpoint: { kind: 'verified-integrated-delivery', items: Object.fromEntries(time.ENDPOINT_ITEMS.map(k => [k, 'pending'])) },
      allocation: null, linked_task: null, chain_forecast: null };
    time.activateContract({ cwd, milestone: M, contract, now: BASE,
      handle: authorize(cwd, 'activation', contract, 'option:balanced') });
  }
  fs.mkdirSync(path.join(cwd, '.gsd/milestones', M), { recursive: true });
  state.write(cwd, { milestone: M, kind: 'milestone', phase: 'execute-task', active_slice: 'S01',
    active_task: 'T01', next_action: 'execute', auto_mode: 'on' });
  const options = { now: BASE + 150, userHome, env };
  if (bound) assert.equal(personal.bindWork({ cwd, id: M, kind: 'milestone', intent: 'create', userHome, env }).status, 'ok');
  return { cwd, userHome, env, options };
}
function begin(f, extra = {}) {
  const request = { milestone: M, slice: 'S01', unit: 'execute-task/T01', host_runtime: 'codex',
    owner_token: 'fixture-owner', idempotency_key: 'begin-' + ++serial };
  const options = { now: () => BASE + 1, prefsReader: () => ({ ok: true, prefs: {} }),
    inventoryReader: () => ({ slices: [{ id: 'S01', tasks: [{ id: 'T01' }] }] }), ...extra };
  const result = controller.begin(f.cwd, request, options);
  const tx = controller.lookupRecord(f.cwd, 'transaction', request.idempotency_key);
  const original = { cwd: f.cwd, contextRoot: f.cwd, milestoneId: M, sliceId: 'S01', taskId: 'T01',
    scope: 'milestone', phase: 'execute', unitType: 'execute-task',
    route: { host_runtime: 'codex', resolved_worker_engine: 'codex', tier: 'standard' } };
  const receipt = write(f.cwd, 'receipt.json', { phase: 'executing', recovery_identity_sha256: digest(recovery.requestIdentity(original)) });
  return Object.assign(f, { request, result, tx, original, receipt, controllerOptions: options });
}
function terminal(f, action = 'complete', at = 120) {
  return controller[action](f.cwd, { ...f.request, generation: f.result.generation,
    idempotency_key: action + '-' + ++serial, result: { status: action === 'fail' ? 'failed' : 'succeeded' } },
  { ...f.controllerOptions, now: () => BASE + at });
}
function adapter(f, observed = 'alive') {
  return { ...f.options, inspectAttempt: () => ({ receipt_path: f.receipt, request: f.original }),
    processProbe: () => observed };
}
function inspect(f, options = f.options) { return drain.inspectDrain(f.cwd, M, options); }
function checkpoint(f, options = f.options) { return drain.checkpointIfDrained(f.cwd, M, options); }
function receipt(f, phase, extra = {}) {
  write(f.cwd, 'receipt.json', { phase, recovery_identity_sha256: digest(recovery.requestIdentity(f.original)), ...extra });
}
function onlyWriter(f, options) { const r = inspect(f, options); assert.equal(r.writers.length, 1); return r.writers[0]; }
function restart(f, action, extra = {}) {
  const result = spawnSync(process.execPath, [__filename, '--child', action, f.cwd, JSON.stringify({ ...f.options, ...extra })],
    { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}

if (process.argv[2] === '--child') {
  const options = JSON.parse(process.argv[5]);
  process.stdout.write(JSON.stringify(drain[process.argv[3]](process.argv[4], M, options)));
} else try {
  test('exports-frozen-drain-and-writer-vocabulary', () => {
    assert.deepEqual(drain.DRAIN_STATES, ['not-applicable', 'draining', 'drained', 'incomplete-unknown']);
    assert.deepEqual(drain.WRITER_CLASSES, ['terminal', 'healthy', 'dead-requires-failure-consumption',
      'saved-response-requires-publication', 'unknown']);
    assert(Object.isFrozen(drain.DRAIN_STATES)); assert(Object.isFrozen(drain.WRITER_CLASSES));
    assert.deepEqual(drain.CLAIM_STATES, ['absent', 'released', 'held', 'retained-reconciled', 'unknown']);
    assert(Object.isFrozen(drain.CLAIM_STATES)); assert(Object.isFrozen(drain.OBSERVABILITY_LIMITS));
    assert(drain.OBSERVABILITY_LIMITS.includes('native-batch-children-unobservable'));
    for (const name of ['inspectDrain', 'checkpointIfDrained', 'verifyRetainedCheckpoint', 'main']) assert.equal(typeof drain[name], 'function');
  });
  test('retained-proof-never-accepts-malformed-unbound-or-unoffered-claims', () => {
    const f = begin(fixture()); terminal(f, 'fail');
    const proof = { reconcileRetainedClaim: () => ({ writer_ended: true, reference: 'echo' }) };
    for (const raw of [{ paths: [] }, { released: false }, { schema_version: 2, generation: 'g', paths: [] }]) {
      write(f.cwd, '.gsd/forge/runs/M001.json', { id: M, kind: 'milestone', write_claim: raw });
      const before = snapshot(f.cwd);
      assert.equal(inspect(f).claim, 'held', JSON.stringify(raw));
      const offered = inspect(f, { ...adapter(f, 'stopped'), ...proof });
      assert.equal(offered.claim, 'unknown', JSON.stringify(raw)); assert.equal(offered.state, 'incomplete-unknown');
      assert.equal(offered.claim_reason, 'retained-claim-invalid'); assert(!offered.retained);
      assert.equal(checkpoint(f, { ...adapter(f, 'stopped'), ...proof }).status, 'not-drained');
      assert.deepEqual(snapshot(f.cwd), before);
    }
    const missing = inspect(f, { ...f.options, ...proof });
    assert.equal(missing.claim, 'unknown'); assert.equal(missing.claim_reason, 'retained-host-inspector-required');
    for (const record of [null, { drain: { claim: 'released' } }, { drain: { claim: 'retained-reconciled', retained: { schema_version: 1 } } }]) {
      assert.equal(drain.verifyRetainedCheckpoint(f.cwd, M, record, adapter(f, 'stopped')).ok, false);
    }
  });
  test('no-contract-and-below-cap-are-pure-not-applicable', () => {
    for (const contract of [false, true]) {
      const f = fixture(contract), options = { ...f.options, now: BASE + 50 }, before = snapshot(f.cwd);
      assert.equal(inspect(f, options).state, 'not-applicable');
      assert.equal(checkpoint(f, options).status, contract ? 'not-exhausted' : 'no-contract');
      assert.deepEqual(snapshot(f.cwd), before);
    }
  });
  test('real-controller-open-begin-lease-host-receipt-and-healthy-own-ceiling', () => {
    const f = begin(fixture()), before = snapshot(f.cwd), options = adapter(f);
    const row = onlyWriter(f, options), timeout = require('./forge-worker-timeout');
    assert.equal(row.classification, 'healthy'); assert.equal(row.state, 'waiting-own-ceiling');
    assert.equal(row.bound_at, iso(1 + timeout.protectedWindowMs(timeout.ceilingFromRoute(f.original.route).ms).duration_ms));
    assert.equal(row.lease.present, true); assert.equal(inspect(f, options).state, 'draining');
    assert.deepEqual(snapshot(f.cwd), before);
    assert.equal(onlyWriter(f, { ...options, now: BASE + 999999999 }).classification, 'healthy');
  });
  test('stopped-failed-and-abandoned-require-existing-failure-consumption', () => {
    for (const phase of ['failed', 'abandoned']) {
      const f = begin(fixture()); receipt(f, phase, { failure: { reason_code: 'fixture-failure' } });
      const row = onlyWriter(f, adapter(f, 'stopped'));
      assert.equal(row.classification, 'dead-requires-failure-consumption');
      assert.equal(row.state, 'failure-consumption-required');
      assert.equal(checkpoint(f, adapter(f, 'stopped')).status, 'not-drained');
    }
  });
  test('saved-ready-and-executed-results-require-original-publication', () => {
    for (const phase of ['ready', 'executed']) {
      const f = begin(fixture()); receipt(f, phase);
      const before = snapshot(f.cwd), options = adapter(f, 'stopped');
      assert.equal(onlyWriter(f, options).classification, 'saved-response-requires-publication');
      assert.equal(inspect(f, options).state, 'draining'); assert.equal(checkpoint(f, options).status, 'not-drained');
      assert.deepEqual(snapshot(f.cwd), before);
    }
  });
  test('unknown-probe-missing-adapter-and-native-batch-G1-never-drain', () => {
    const f = begin(fixture()); receipt(f, 'failed', { failure: { provider_called: false, reason_code: 'fixture-failure' } });
    for (const options of [f.options, adapter(f, 'unknown'), { ...adapter(f), processProbe: undefined },
      { ...adapter(f), inspectAttempt: () => ({ native_batch: true }) }]) {
      const before = snapshot(f.cwd);
      assert.equal(onlyWriter(f, options).classification, 'unknown');
      assert.equal(inspect(f, options).state, 'incomplete-unknown'); assert.equal(checkpoint(f, options).status, 'not-drained');
      assert.deepEqual(snapshot(f.cwd), before);
    }
    assert.equal(restart(f, 'inspectDrain').state, 'incomplete-unknown');
  });
  test('PID-probe-is-signal-zero-only-and-live-PID-overrides-stopped-host', () => {
    const f = begin(fixture()); receipt(f, 'failed', { pid: process.pid, failure: { reason_code: 'fixture-failure' } });
    const original = process.kill, calls = [];
    try {
      process.kill = (pid, signal) => { calls.push([pid, signal]); return original(pid, signal); };
      assert.equal(onlyWriter(f, adapter(f, 'stopped')).classification, 'healthy');
    } finally { process.kill = original; }
    assert(calls.length > 0); assert(calls.every(([pid, signal]) => pid === process.pid && signal === 0));
  });
  test('ambiguous-begins-stay-unknown-regardless-of-clock-and-probe', () => {
    const f = begin(fixture()), file = path.join(f.cwd, '.gsd/milestones/M001/M001-events.jsonl');
    fs.appendFileSync(file, JSON.stringify({ ...f.tx.event, idempotency_key: 'other-begin', ts: iso(2) }) + '\n');
    assert.equal(inspect(f, adapter(f)).state, 'incomplete-unknown');
    assert.equal(onlyWriter(f, adapter(f)).classification, 'unknown');
  });
  test('pending-transactions-enumerated-from-real-controller-crash-and-resume', () => {
    const f = fixture();
    assert.throws(() => begin(f, { failpoint: name => name === 'after-intent' }), /failpoint/);
    const before = snapshot(f.cwd), r = inspect(f);
    assert.equal(r.pending_transactions, 1); assert.notEqual(r.state, 'drained');
    assert.equal(r.writers[0].source, 'pending-transaction'); assert.deepEqual(snapshot(f.cwd), before);
    assert.equal(restart(f, 'inspectDrain').pending_transactions, 1);
  });
  test('run-write-claim-is-retained-even-with-empty-paths-and-malformed-run-is-unknown', () => {
    const f = fixture(), file = write(f.cwd, '.gsd/forge/runs/M001.json', { id: M, kind: 'milestone', write_claim: { paths: [] } });
    const before = snapshot(f.cwd); assert.equal(inspect(f).state, 'draining'); assert.equal(inspect(f).claim, 'held');
    assert.equal(checkpoint(f).status, 'not-drained'); assert.deepEqual(snapshot(f.cwd), before);
    fs.writeFileSync(file, '{broken'); assert.equal(inspect(f).state, 'incomplete-unknown');
  });
  test('raw-claim-absence-released-and-malformed-values-stay-distinct', () => {
    const f = fixture();
    for (const raw of [undefined, null, false, '', [], 0, { paths: [] }, { released: {} }, { released: false }]) {
      write(f.cwd, '.gsd/forge/runs/M001.json', { id: M, kind: 'milestone', write_claim: raw });
      const absent = raw === undefined || raw === null, result = inspect(f);
      assert.equal(result.claim, absent ? 'absent' : 'held', JSON.stringify(raw));
      assert.equal(result.state, absent ? 'drained' : 'draining');
    }
  });
  test('real-recordClaim-changed-file-commit-measured-release-drain-and-checkpoint', () => {
    const f = fixture(), code = path.join(f.cwd, 'isolated-code'); fs.mkdirSync(code);
    const git = args => {
      const r = spawnSync('git', args, { cwd: code, encoding: 'utf8', timeout: 15000 });
      assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
    };
    git(['init', '-q']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'user.name', 'Fixture']);
    write(code, 'claimed.txt', 'before\n'); git(['add', 'claimed.txt']); git(['commit', '-q', '-m', 'fixture baseline']);
    const baseline = git(['rev-parse', 'HEAD']);
    write(f.cwd, '.gsd/forge/runs/M001.json', { id: M, kind: 'milestone', active: true });
    const claims = require('./forge-write-claim'), release = require('./forge-claim-release');
    claims.recordClaim(f.cwd, M, { at: BASE, unit: 'execute-task/T01', source: 'plan-writes', code_dir: code,
      paths: ['claimed.txt'], vcs_baseline: { vcs: 'git', id: baseline } });
    const before = JSON.parse(fs.readFileSync(path.join(f.cwd, '.gsd/forge/runs/M001.json'))).write_claim;
    assert(claims.isHeld(before)); assert.equal(inspect(f).claim, 'held');
    write(code, 'claimed.txt', 'after\n');
    assert.equal(release.releaseIfObservable(f.cwd, M, { now: BASE + 150 }).held, true);
    git(['add', 'claimed.txt']); git(['commit', '-q', '-m', 'fixture delivered claim']);
    const result = release.releaseIfObservable(f.cwd, M, { now: BASE + 150 });
    assert.equal(result.reason, 'released-committed', JSON.stringify(result)); assert.equal(result.held, false);
    const runFile = path.join(f.cwd, '.gsd/forge/runs/M001.json'), after = fs.readFileSync(runFile);
    const raw = JSON.parse(after).write_claim;
    assert(raw && raw.released); assert.deepEqual(raw.paths, before.paths); assert(!claims.isHeld(raw));
    assert.equal(inspect(f).claim, 'released'); assert.equal(inspect(f).state, 'drained');
    assert.equal(checkpoint(f).status, 'checkpointed');
    assert.deepEqual(fs.readFileSync(runFile), after, 'drain/checkpoint changed the released claim');
  });
  test('zero-forbidden-kill-lease-claim-failure-replay-and-attempt-mutations', () => {
    const f = begin(fixture()), claim = require('./forge-write-claim'), xllm = require('./forge-xllm');
    const targets = [[lease, 'acquire'], [lease, 'release'], [lease, 'heartbeat'], [claim, 'clearClaim'],
      [claim, 'releaseClaim'], [claim, 'recoverClaim'], [controller, 'begin'], [controller, 'consumeFailure'],
      [recovery, 'recoverAttempt'], [xllm, 'terminateOwnedProcessTree']];
    const originals = targets.map(([obj, key]) => obj[key]); let calls = 0;
    try {
      for (const [obj, key] of targets) obj[key] = () => { calls++; throw Error('forbidden mutation ' + key); };
      const before = snapshot(f.cwd); inspect(f, adapter(f)); checkpoint(f, adapter(f));
      assert.equal(calls, 0); assert.deepEqual(snapshot(f.cwd), before);
    } finally { targets.forEach(([obj, key], i) => { obj[key] = originals[i]; }); }
  });
  test('terminal-boundary-only-after-real-complete-or-fail-and-released-lease', () => {
    for (const action of ['complete', 'fail']) {
      const f = begin(fixture()); assert.notEqual(inspect(f).state, 'drained'); terminal(f, action);
      const row = onlyWriter(f); assert.equal(row.classification, 'terminal');
      assert.equal(row.lease.present, false); assert.equal(inspect(f).state, 'drained');
    }
  });
  test('retained-lease-after-terminal-boundary-never-authorizes-checkpoint', () => {
    const f = begin(fixture()); terminal(f);
    lease.acquire(f.cwd, f.request.unit, { ownerToken: 'another-owner', hostRuntime: 'codex', now: BASE + 130 });
    assert.notEqual(inspect(f).state, 'drained'); assert.equal(checkpoint(f).status, 'not-drained');
  });
  test('orphan-lease-with-missing-event-is-still-a-possible-writer', () => {
    const f = begin(fixture());
    fs.unlinkSync(path.join(f.cwd, '.gsd/milestones/M001/M001-events.jsonl'));
    const row = onlyWriter(f, adapter(f)); assert.equal(row.source, 'retained-lease');
    assert.equal(row.classification, 'healthy'); assert.equal(inspect(f, adapter(f)).state, 'draining');
    assert.equal(checkpoint(f, adapter(f)).status, 'not-drained');
  });
  test('checkpoint-record-state-personal-order-and-unknown-counted-once', () => {
    const f = begin(fixture(true, true)); terminal(f);
    const order = [], originalRecord = time.recordCheckpoint, originalState = state.updateFields, originalPersonal = personal.saveCheckpoint;
    try {
      time.recordCheckpoint = options => { order.push('record'); return originalRecord(options); };
      state.updateFields = (...args) => { order.push('state'); return originalState(...args); };
      personal.saveCheckpoint = options => { order.push('personal'); return originalPersonal(options); };
      const r = checkpoint(f); assert.equal(r.status, 'checkpointed'); assert.equal(r.personal, 'saved');
      assert.deepEqual(order, ['record', 'state', 'personal']); assert.equal(r.record.consumed_ms, 150);
      assert.equal(r.record.unknown_ms, 31); assert.equal(r.record.overshoot_ms, 50);
      assert.equal(r.record.decision_pending, true); assert(r.record.pending_decision.id);
      assert(r.record.pending_decision.question.includes('parcial')); assert(!/conclu[ií]d/.test(r.record.next_action));
      const current = state.read(f.cwd, M); assert.equal(current.next_action, r.record.next_action);
      const work = personal.readPersonalSnapshot({ cwd: f.cwd, id: M, userHome: f.userHome, env: f.env }).works[0];
      assert.equal(work.checkpoint.pending[0].validity, 'current');
      const key = require('./forge-code-roots').key;
      assert.equal(key(work.checkpoint.pending[0].source), key(fs.realpathSync(path.join(f.cwd, r.reference))));
      assert.equal(work.checkpoint.nextAction[0].text, r.record.next_action);
      order.length = 0; const before = snapshot(f.cwd, true); checkpoint(f); assert.deepEqual(order, []); assert.deepEqual(snapshot(f.cwd, true), before);
    } finally { time.recordCheckpoint = originalRecord; state.updateFields = originalState; personal.saveCheckpoint = originalPersonal; }
  });
  test('checkpoint-unbound-personal-does-not-create-profile', () => {
    const f = begin(fixture()); terminal(f); const r = checkpoint(f);
    assert.equal(r.status, 'checkpointed'); assert.equal(r.personal, 'not-bound');
    assert(!fs.existsSync(f.userHome)); assert.equal(time.readCheckpoints({ cwd: f.cwd, milestone: M }).records.length, 1);
  });
  test('personal-real-pending-decision-identity-preserved-alongside-cap-decision', () => {
    const f = fixture(true, true), source = '.gsd/milestones/M001/prior-question.md';
    write(f.cwd, source, 'pending-functional-123: Decisão funcional ainda pendente.\n');
    assert.equal(personal.saveCheckpoint({ cwd: f.cwd, id: M, userHome: f.userHome, env: f.env, intent: 'checkpoint',
      checkpoint: { pending: [{ text: 'pending-functional-123', source }] } }).status, 'ok');
    const r = checkpoint(f); assert.equal(r.personal, 'saved');
    const pending = personal.readPersonalSnapshot({ cwd: f.cwd, id: M, userHome: f.userHome, env: f.env }).works[0].checkpoint.pending;
    assert.equal(pending.length, 2); assert.equal(pending[0].text, 'pending-functional-123'); assert.equal(pending[0].validity, 'current');
    assert(pending[1].text.startsWith(r.record.pending_decision.id));
    const before = snapshot(f.cwd, true); checkpoint(f); assert.deepEqual(snapshot(f.cwd, true), before);
  });
  test('malformed-prior-checkpoint-never-reapplies-fields', () => {
    const f = fixture(), r = checkpoint(f), file = path.join(f.cwd, r.reference);
    write(f.cwd, r.reference, { ...r.record, consumed_ms: -1, overshoot_ms: -101 });
    const prior = fs.readFileSync(file), stateBefore = fs.readFileSync(state.statePath(f.cwd, M));
    assert.throws(() => checkpoint(f), /time-drain-checkpoint-conflict/);
    assert.deepEqual(fs.readFileSync(file), prior); assert.deepEqual(fs.readFileSync(state.statePath(f.cwd, M)), stateBefore);
  });
  test('stale-personal-pending-evidence-requires-reconciliation-without-rehash', () => {
    const f = fixture(true, true), source = '.gsd/milestones/M001/prior-question.md';
    write(f.cwd, source, 'prior-evidence\n');
    personal.saveCheckpoint({ cwd: f.cwd, id: M, userHome: f.userHome, env: f.env, intent: 'checkpoint',
      checkpoint: { pending: [{ text: 'real-decision-id', source }] } });
    write(f.cwd, source, 'changed-evidence\n'); const before = snapshot(f.userHome);
    assert.throws(() => checkpoint(f), /time-drain-personal-reconciliation-required/);
    assert.deepEqual(snapshot(f.userHome), before);
  });
  test('checkpoint-crashpoints-restart-without-replacing-record-or-reapplying-state', () => {
    for (const point of ['after-record', 'after-state', 'after-personal']) {
      const f = begin(fixture(true, true)); terminal(f);
      assert.throws(() => checkpoint(f, { ...f.options, failpoint: name => name === point }), /time-drain-crashpoint/);
      const file = path.join(f.cwd, '.gsd/forge/time/M001/checkpoints/1.json');
      const prior = fs.readFileSync(file), mtime = fs.statSync(file).mtimeMs;
      const stateFile = state.statePath(f.cwd, M), stateMtime = fs.statSync(stateFile).mtimeMs;
      const r = restart(f, 'checkpointIfDrained', { now: BASE + 180 });
      assert.equal(r.status, 'checkpointed'); assert.equal(r.record.consumed_ms, 150);
      assert.equal(fs.statSync(file).mtimeMs, mtime); assert.deepEqual(fs.readFileSync(file), prior);
      if (point !== 'after-record') assert.equal(fs.statSync(stateFile).mtimeMs, stateMtime);
      const before = snapshot(f.cwd, true); restart(f, 'checkpointIfDrained'); assert.deepEqual(snapshot(f.cwd, true), before);
    }
  });
  test('serialized-checkpoint-rechecks-exhaustion-and-drain-before-record', () => {
    const f = fixture(), lock = require('./forge-lock'), saved = lock.acquireProcessSync;
    let injected = false;
    try {
      lock.acquireProcessSync = (...args) => {
        if (args[1] === 'unit-controller-transactions' && !injected) { injected = true; begin(f); }
        return saved(...args);
      };
      assert.equal(checkpoint(f).status, 'not-drained');
      assert.equal(time.readCheckpoints({ cwd: f.cwd, milestone: M }).records.length, 0);
    } finally { lock.acquireProcessSync = saved; }
  });
  test('contract-version-extension-has-independent-idempotent-checkpoint', () => {
    const f = fixture(); const first = checkpoint(f); assert.equal(first.record.version, 1);
    const request = { kind: 'extension', reason: 'Extensão explícita de fixture', patch: { ceiling_ms: 200 } };
    time.amendContract({ cwd: f.cwd, milestone: M, ...request, now: BASE,
      handle: authorize(f.cwd, 'extension', request, 'extend:200') });
    assert.equal(checkpoint(f).status, 'not-exhausted');
    const next = checkpoint(f, { ...f.options, now: BASE + 220 }); assert.equal(next.record.version, 2);
    assert.notEqual(next.record.pending_decision.id, first.record.pending_decision.id);
    assert.equal(time.readCheckpoints({ cwd: f.cwd, milestone: M }).records.length, 2);
  });
  test('invalid-and-unstable-sources-never-become-zero-or-false-death', () => {
    const f = begin(fixture()), options = adapter(f, 'stopped');
    options.inspectAttempt = () => { throw Error('private absolute path C:\\secret'); };
    const r = inspect(f, options); assert.equal(r.state, 'incomplete-unknown'); assert(!JSON.stringify(r).includes('secret'));
    receipt(f, 'failed', { recovery_identity_sha256: 'b'.repeat(64), failure: { reason_code: 'fixture-failure' } });
    assert.equal(inspect(f, adapter(f, 'stopped')).state, 'incomplete-unknown');
    write(f.cwd, '.gsd/milestones/M001/M001-events.jsonl', '{bad');
    assert.equal(inspect(f).state, 'incomplete-unknown'); assert.equal(checkpoint(f).status, 'not-drained');
  });
  test('receipt-change-during-process-probe-fails-closed-without-clock-guess', () => {
    const f = begin(fixture()), options = adapter(f);
    options.processProbe = () => { receipt(f, 'executed'); return 'stopped'; };
    const r = inspect(f, options); assert.equal(r.state, 'incomplete-unknown');
    assert(r.unknowns.includes('time-drain-source-unstable'));
  });
  test('junction-source-refused-without-reading-or-writing-outside-owner', () => {
    const f = fixture(), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-drain-external-'));
    roots.push(outside); write(outside, 'M001.json', { id: M, kind: 'milestone', write_claim: null });
    const before = snapshot(outside);
    fs.symlinkSync(outside, path.join(f.cwd, '.gsd/forge/runs'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(inspect(f).state, 'incomplete-unknown'); assert.equal(checkpoint(f).status, 'not-drained');
    assert.deepEqual(snapshot(outside), before);
  });
  test('CLI-read-only-output-refusals-and-exit-codes-are-bounded-public', () => {
    const f = begin(fixture()), file = path.join(__dirname, 'forge-milestone-time-drain.js'), before = snapshot(f.cwd);
    function cli(action, cwd = f.cwd) {
      const r = spawnSync(process.execPath, [file, action, '--cwd', cwd, '--milestone', M, '--json'],
        { encoding: 'utf8', timeout: 20000, env: { ...process.env, ...f.env } });
      assert(r.stdout.length < 65536); assert(!r.stdout.includes(cwd)); return { code: r.status, value: JSON.parse(r.stdout) };
    }
    const observed = cli('--inspect'); assert.equal(observed.code, 0); assert.equal(observed.value.state, 'incomplete-unknown');
    const refused = cli('--checkpoint'); assert.equal(refused.code, 2); assert.equal(refused.value.reason_code, 'time-drain-incomplete');
    assert.deepEqual(snapshot(f.cwd), before);
    const fresh = fixture(); fresh.options.now = Date.now();
    const io = { stdout: { write: s => { io.value = JSON.parse(s); } } };
    assert.equal(drain.main(['--checkpoint', '--cwd', fresh.cwd, '--milestone', M, '--json'], io, { ...fresh.options, now: BASE + 1 }), 2);
    assert.equal(io.value.reason_code, 'time-drain-not-exhausted');
    assert.equal(drain.main(['--invalid', '--json'], io), 3);
    terminal(f); assert.equal(cli('--checkpoint').code, 0);
  });
  test('time-status-readContract-recordCheckpoint-directed-behavior', () => {
    const f = fixture(), admission = require('./forge-milestone-time-admission');
    const savedStatus = admission.readTimeStatus, savedRead = time.readContract, savedRecord = time.recordCheckpoint;
    const calls = { status: 0, read: 0, record: 0 };
    try {
      admission.readTimeStatus = (...args) => { calls.status++; return savedStatus(...args); };
      time.readContract = (...args) => { calls.read++; return savedRead(...args); };
      time.recordCheckpoint = (...args) => { calls.record++; return savedRecord(...args); };
      assert.equal(checkpoint(f).status, 'checkpointed');
      assert(calls.status >= 2); assert(calls.read >= 2); assert.equal(calls.record, 1);
    } finally { admission.readTimeStatus = savedStatus; time.readContract = savedRead; time.recordCheckpoint = savedRecord; }
  });
  test('declared-drain-module-and-contract-test-artifacts-substantive', () => {
    for (const name of ['forge-milestone-time-drain.js', 'forge-milestone-time-drain.test.js']) {
      const contents = fs.readFileSync(path.join(__dirname, name), 'utf8');
      assert(contents.split('\n').length >= 220);
      if (name === 'forge-milestone-time-drain.js') assert(!/\b(?:TODO|TBD|FIXME)\b/.test(contents));
    }
  });
  console.log('PASS all ' + count + ' drain checks');
} finally {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
}
