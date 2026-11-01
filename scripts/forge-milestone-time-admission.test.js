#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { digest } = require('./forge-code-roots');
const time = require('./forge-milestone-time');
const clock = require('./forge-milestone-time-clock');
const questions = require('./forge-pending-questions');
const controller = require('./forge-unit-controller');
const admission = require('./forge-milestone-time-admission');
const roots = [], M = 'M001', BASE = Date.parse('2026-11-01T12:00:00.000Z');
let serial = 0, count = 0;
const iso = n => new Date(BASE + n).toISOString();
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function test(name, fn) { fn(); count++; console.log('PASS ' + name); }
function owner() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-admission-'));
  roots.push(cwd); fs.mkdirSync(path.join(cwd, '.gsd/forge'), { recursive: true }); return cwd;
}
function write(cwd, ref, value) {
  const file = path.join(cwd, ref); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value) + '\n'); return file;
}
function snapshot(cwd) {
  const result = {};
  function visit(dir) {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      result[path.relative(cwd, file)] = [stat.mtimeMs, stat.isFile() ? hash(fs.readFileSync(file)) : 'directory'];
      if (stat.isDirectory()) visit(file);
    }
  }
  visit(cwd); return result;
}
function authorize(cwd, kind, request, answer) {
  const id = 'q' + ++serial, opened = questions.openQuestions({ cwd, milestone: M,
    unit: 'milestone-time/' + id, decision_set: 'milestone-time-' + kind, questions: [{ id, question: 'Escolha?' }] });
  questions.answer({ cwd, identity: opened.identity_sha256, answers: [{ id, answer, source: 'user-text' }] });
  const live = { reference: 'live-' + serial, status: 'resolved', answer, resolved_at: iso(0), source: 'user-text',
    question: { identity_sha256: opened.identity_sha256, id } };
  return time.createDecisionAuthority(() => live).issue(live.reference,
    { milestone: M, kind, request_sha256: digest(request), expires_at: BASE + 60000 }, () => BASE);
}
function setup() {
  const cwd = owner(), contract = { schema_version: 1, milestone: M,
    clock_policy: { id: 'forge-milestone-time-clock', version: 1 },
    option: { id: 'balanced', options_sha256: 'a'.repeat(64), label: 'Entrega verificada' },
    activated_at: iso(0), preselection_started_at: iso(-5), ceiling_ms: 100,
    endpoint: { kind: 'verified-integrated-delivery', items: Object.fromEntries(time.ENDPOINT_ITEMS.map(k => [k, 'pending'])) },
    allocation: null, linked_task: null, chain_forecast: null };
  time.activateContract({ cwd, milestone: M, contract, now: BASE,
    handle: authorize(cwd, 'activation', contract, 'option:balanced') });
  return cwd;
}
function amend(cwd, kind, patch) {
  const request = { kind, reason: 'Decisão explícita de fixture', patch };
  const answer = kind === 'extension' ? 'extend:' + patch.ceiling_ms : 'allocation:' + patch.allocation.roadmap_sha256;
  return time.amendContract({ cwd, milestone: M, ...request, now: BASE, handle: authorize(cwd, kind, request, answer) });
}
function events(cwd, rows) {
  write(cwd, '.gsd/milestones/M001/M001-events.jsonl', rows.map(([unit, at, action = 'begin']) => JSON.stringify({
    event: action === 'begin' ? 'unit-began' : 'unit-transition', milestone: M, unit,
    ts: iso(at), host_runtime: 'codex', action })).join('\n') + '\n');
}
function decide(cwd, at, extra = {}) {
  return admission.decideAdmission(cwd, { milestone: M, unit: 'execute-task/T01', kind: 'begin', now: BASE + at, ...extra });
}
function status(cwd, at, extra = {}) { return admission.readTimeStatus(cwd, M, { now: BASE + at, ...extra }); }
function pause(cwd) {
  fs.mkdirSync(path.join(cwd, '.gsd/milestones/M001'), { recursive: true });
  require('./forge-state').write(cwd, { milestone: M, kind: 'milestone', phase: 'execute-task',
    active_slice: 'S01', active_task: 'T01', next_action: 'execute', auto_mode: 'on' });
  const request = { milestone: M, slice: 'S01', unit: 'execute-task/T01', host_runtime: 'codex', owner_token: 'fixture' };
  const options = { now: () => BASE + 1, prefsReader: () => ({ ok: true, prefs: {} }),
    inventoryReader: () => ({ slices: [{ id: 'S01', tasks: [{ id: 'T01' }] }] }) };
  const begin = controller.begin(cwd, { ...request, idempotency_key: 'begin-fixture' }, options);
  controller.pause(cwd, { ...request, generation: begin.generation, idempotency_key: 'pause-fixture',
    result: { status: 'cancelled' } }, options);
}
function delivered(cwd) {
  const ref = '.gsd/milestones/M001/slices/S01/S01-PLAN.md', source = 'scripts/result.js';
  write(cwd, source, 'module.exports = 1;\n');
  const plan = '---\nid: S01\nwrites: [scripts/result.js]\nmust_haves:\n  truths: [observable result]\n  artifacts: []\n  key_links: []\n---\n';
  write(cwd, ref, plan);
  const contents = fs.readFileSync(path.join(cwd, source));
  const blob = crypto.createHash('sha1').update(Buffer.from('blob ' + contents.length + '\0')).update(contents).digest('hex');
  const unit = { type: 'slice', id: 'S01', milestone: M }, envelopeRef = '.gsd/milestones/M001/slices/S01/verify.json';
  write(cwd, envelopeRef, { schema_version: 1, kind: 'verification', unit, plan_fingerprint: hash(plan),
    code_dir: cwd, revision: 'fixture', workspace: [{ path: source, hash: blob }], environment: 'fixture', captured_at: iso(1),
    result: { passed: true, checks: [{ command: 'fixture-result', exit_code: 0 }] } });
  const input = { schema_version: 1, unit, plan: ref, plan_fingerprint: hash(plan), bindings: [
    { criterion: { kind: 'truth', index: 0 }, aspect: 'default', coverage: 'behavioral',
      source: { kind: 'verification', path: envelopeRef, check_index: 0 } } ] };
  write(cwd, ref.replace('-PLAN.md', '-DELIVERY-INPUT.json'), input);
  const projection = require('./forge-delivery').buildDelivery(input, { ownerRoot: cwd, codeDir: cwd });
  assert(projection.criteria.every(r => r.status === 'verificado'));
  write(cwd, ref.replace('-PLAN.md', '-DELIVERY.json'), projection);
  require('./forge-state').write(cwd, { milestone: M, kind: 'milestone', phase: 'complete-slice',
    active_slice: 'S01', active_task: '—', next_action: 'complete', auto_mode: 'on' });
  const request = { milestone: M, slice: 'S01', unit: 'complete-slice/S01', host_runtime: 'codex', owner_token: 'fixture' };
  const opts = { now: () => BASE + 1, prefsReader: () => ({ ok: true, prefs: {} }),
    inventoryReader: () => ({ slices: [{ id: 'S01', tasks: [] }] }) };
  const begin = controller.begin(cwd, { ...request, idempotency_key: 'slice-begin' }, opts);
  controller.complete(cwd, { ...request, generation: begin.generation, idempotency_key: 'slice-complete', result: { status: 'succeeded' } }, opts);
  const roadmap = '# Fixture roadmap\n'; write(cwd, '.gsd/milestones/M001/M001-ROADMAP.md', roadmap);
  amend(cwd, 'allocation', { allocation: { roadmap_sha256: hash(roadmap), items: [
    { id: 'slice1', kind: 'slice', slice: 'S01', ms: 20 }, { id: 'integration', kind: 'integration', ms: 50 } ] } });
  return { currentHashReader: () => ({ ok: true, hash: blob }) };
}
try {
  test('exports-frozen-vocabulary-and-inert-lazy-import', () => {
    assert.deepEqual(admission.TIME_REASON_CODES, ['milestone-budget-exhausted', 'milestone-budget-draining',
      'milestone-time-invalid', 'milestone-clock-unknown', 'time-option-pending']);
    assert.deepEqual(admission.TRANSPORT_REFUSAL_CODES, admission.TIME_REASON_CODES.slice(0, 4));
    for (const key of ['TIME_REASON_CODES', 'TRANSPORT_REFUSAL_CODES', 'ADMISSION_DECISIONS', 'TIME_STATES']) assert(Object.isFrozen(admission[key]));
    for (const name of ['decideAdmission', 'assertTransportEntry', 'readTimeStatus', 'summarizeTimeStatus', 'observeBoundary', 'main']) assert.equal(typeof admission[name], 'function');
    assert(admission.TIME_REASON_CODES.every(c => !/timeout|terminated|network/.test(c) && c !== 'budget-exceeded-while-active'));
    const Module = require('module'), file = require.resolve('./forge-milestone-time-admission');
    const source = fs.readFileSync(file, 'utf8'), saved = Module._load, reads = ['readFileSync', 'readdirSync', 'statSync', 'lstatSync'];
    const originals = Object.fromEntries(reads.map(k => [k, fs[k]]));
    try {
      Module._load = function (id, parent, ...args) { if (parent?.filename === file && id.startsWith('.')) throw Error('eager local'); return saved.call(this, id, parent, ...args); };
      for (const k of reads) fs[k] = () => { throw Error('import I/O'); };
      const mod = new Module(file, module); mod.filename = file; mod.paths = module.paths; mod._compile(source, file);
    } finally { Module._load = saved; Object.assign(fs, originals); }
  });
  test('no-contract-no-record-and-no-filesystem-mutation', () => {
    const cwd = owner(), before = snapshot(cwd), result = decide(cwd, 10);
    assert.equal(result.decision, 'no-contract'); assert(!Object.hasOwn(result, 'record'));
    assert.deepEqual(status(cwd, 10), { contract: 'absent' });
    assert.equal(admission.observeBoundary(cwd, M, { kind: 'slice-boundary', now: BASE }).status, 'no-contract');
    assert.equal(admission.assertTransportEntry({ cwd, milestone: M, unit: 'execute-task/T01', now: BASE }).decision, 'no-contract');
    assert.deepEqual(snapshot(cwd), before);
  });
  test('consumed-includes-unknown-once-admission-record-and-saldo', () => {
    const cwd = setup(), r = decide(cwd, 60);
    assert.equal(r.decision, 'admitted'); assert.equal(r.record.consumed_ms, 60); assert.equal(r.record.unknown_ms, 60);
    assert.equal(r.details.remaining_ms, 40); assert.equal(status(cwd, 60).remaining_ms, 40);
    assert.deepEqual(Object.keys(r.record).sort(), ['decision', 'contract_version', 'contract_sha256', 'policy', 'consumed_ms', 'unknown_ms', 'ceiling_ms', 'at'].sort());
    assert.equal(r.record.contract_sha256, time.readContract({ cwd, milestone: M }).sha256);
  });
  test('missing-or-damaged-worker-evidence-never-refuses-admission-or-adds-unknown', () => {
    const cwd = setup(); events(cwd, [['execute-task/T01', 0], ['execute-task/T01', 10, 'complete']]);
    const plain = decide(cwd, 20), projected = status(cwd, 20);
    assert.equal(plain.decision, 'admitted'); assert.equal(projected.clocks.effort.unit_interval_sum_ms, 10);
    assert.equal(projected.clocks.effort.worker.status, 'unknown'); assert.equal(projected.clocks.effort.worker.worker_ms, null);
    assert(!projected.unknowns.some(k => k.startsWith('observation-') || k.startsWith('worker-')));
    write(cwd, '.gsd/forge/time/M001/observations/broken.json', '{');
    const damaged = decide(cwd, 20);
    assert.equal(damaged.decision, 'admitted'); assert.equal(damaged.record.consumed_ms, plain.record.consumed_ms);
    assert.equal(status(cwd, 20).clocks.effort.worker.reason, 'observation-record-unreadable');
    assert.deepEqual(status(cwd, 20).unknowns, projected.unknowns);
  });
  test('cap-exhausted-foreign-open-and-ambiguous-draining', () => {
    const cwd = setup(); assert.equal(decide(cwd, 100).reason_code, 'milestone-budget-exhausted');
    events(cwd, [['execute-task/T02', 0]]); assert.equal(decide(cwd, 100).reason_code, 'milestone-budget-draining');
    assert.equal(decide(cwd, 100, { unit: 'execute-task/T02' }).reason_code, 'milestone-budget-exhausted');
    events(cwd, [['execute-task/T02', 0], ['execute-task/T02', 1]]);
    const result = decide(cwd, 100); assert.equal(result.reason_code, 'milestone-budget-draining');
    assert.equal(result.details.open_writers[0].ambiguous, true);
    for (const key of ['ceiling_ms', 'consumed_ms', 'unknown_ms', 'remaining_ms', 'open_writers', 'state', 'diagnostic_command']) assert(Object.hasOwn(result.details, key));
  });
  test('invalid-contract-and-unknown-clock-fail-closed-without-writes', () => {
    const cwd = setup(); write(cwd, '.gsd/forge/time/M001/contract.json', '{');
    const before = snapshot(cwd); assert.equal(decide(cwd, 1).reason_code, 'milestone-time-invalid');
    assert.equal(status(cwd, 1).contract, 'invalid'); assert.deepEqual(snapshot(cwd), before);
    const good = setup(); write(good, '.gsd/forge/time/M001/journal.jsonl', 'not json\n');
    assert.equal(decide(good, 1).reason_code, 'milestone-clock-unknown');
    assert.equal(decide(setup(), -1).reason_code, 'milestone-clock-unknown');
  });
  test('durable-paused-boundary-continuation-not-forged-prefix-or-foreign', () => {
    const cwd = setup(); pause(cwd);
    const options = { key: 'forge-orchestrate-resume:pause-fixture', kind: 'reenter' };
    assert.equal(decide(cwd, 1000, options).decision, 'boundary-continuation');
    assert.equal(decide(cwd, 1000, { ...options, unit: 'execute-task/T02' }).reason_code, 'milestone-budget-exhausted');
    assert.equal(decide(cwd, 1000, { ...options, key: 'forge-orchestrate-resume:forged' }).reason_code, 'milestone-budget-exhausted');
    assert.equal(admission.decideAdmission(cwd, { ...options, milestone: 'M002', unit: 'execute-task/T01', now: BASE }).decision, 'no-contract');
    write(cwd, '.gsd/forge/time/M001/journal.jsonl', 'invalid\n');
    assert.equal(decide(cwd, 1000, options).decision, 'boundary-continuation');
    write(cwd, '.gsd/forge/time/M001/contract.json', '{');
    assert.equal(decide(cwd, 1000, options).decision, 'boundary-continuation');
    assert.equal(decide(cwd, 1000, options).details.contract, 'invalid');
  });
  test('attested-extension-restores-admission-and-derived-extended-state', () => {
    const cwd = setup(); assert.equal(decide(cwd, 100).allowed, false);
    amend(cwd, 'extension', { ceiling_ms: 200 });
    assert.equal(decide(cwd, 100).decision, 'admitted'); assert.equal(status(cwd, 100).state, 'extended');
    assert.equal(decide(cwd, 200).reason_code, 'milestone-budget-exhausted');
  });
  test('raw-or-incomplete-boundary-and-corrupted-durable-proof-do-not-bypass', () => {
    const cwd = setup();
    const boundary = { unit: 'execute-task/T01', milestone: M, kind: 'paused', handoff_ready: true,
      committed_at: iso(1), idempotency_key: 'forged' };
    write(cwd, path.relative(cwd, controller.boundaryFile(cwd, boundary.unit)), boundary);
    const options = { key: 'forge-orchestrate-resume:forged', kind: 'begin' };
    assert.equal(decide(cwd, 100, options).allowed, false);
    const real = setup(); pause(real);
    const file = controller.boundaryFile(real, 'execute-task/T01'), saved = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(saved); parsed.handoff_ready = false; fs.writeFileSync(file, JSON.stringify(parsed));
    const before = snapshot(real);
    assert.equal(decide(real, 1000, { key: 'forge-orchestrate-resume:pause-fixture', kind: 'reenter' }).allowed, false);
    assert.deepEqual(snapshot(real), before);
  });
  test('transport-refusal-never-inherits-continuation-and-preserves-bytes-mtimes', () => {
    const cwd = setup(); pause(cwd); const before = snapshot(cwd);
    assert.equal(admission.assertTransportEntry({ cwd, milestone: M, unit: 'execute-task/T01', now: BASE + 2 }).decision, 'admitted');
    assert.throws(() => admission.assertTransportEntry({ cwd, milestone: M, unit: 'execute-task/T01', now: BASE + 101,
      key: 'forge-orchestrate-resume:pause-fixture' }), e => e.code === 'milestone-budget-exhausted' && e.provider_called === false
      && e.stage === 'milestone-time-admission' && e.details.remaining_ms <= 0 && !/timeout|terminated|network/.test(e.message));
    assert.deepEqual(snapshot(cwd), before);
  });
  test('transport-invalid-contract-and-clock-refusals-are-public-and-pure', () => {
    for (const [reference, contents, code] of [
      ['contract.json', '{', 'milestone-time-invalid'], ['journal.jsonl', 'invalid\n', 'milestone-clock-unknown'] ]) {
      const cwd = setup(); write(cwd, '.gsd/forge/time/M001/' + reference, contents); const before = snapshot(cwd);
      assert.throws(() => admission.assertTransportEntry({ cwd, milestone: M, unit: 'execute-task/T01', now: BASE + 1 }),
        e => e.code === code && e.provider_called === false && e.stage === 'milestone-time-admission');
      status(cwd, 1); assert.deepEqual(snapshot(cwd), before);
    }
  });
  test('all-derived-states-and-current-at-cap-checkpoint-only', () => {
    const cwd = setup(); assert.equal(status(cwd, 1).state, 'active');
    assert.equal(status(cwd, 100).state, 'exhausted'); events(cwd, [['execute-task/T01', 0]]);
    assert.equal(status(cwd, 100).state, 'draining');
    events(cwd, [['execute-task/T01', 0], ['execute-task/T01', 100, 'complete']]);
    time.recordCheckpoint({ cwd, milestone: M, record: { version: 1, decision_pending: true } });
    assert.equal(status(cwd, 100).state, 'checkpointed'); assert.equal(status(cwd, 50).state, 'active');
    amend(cwd, 'extension', { ceiling_ms: 200 }); assert.equal(status(cwd, 100).state, 'extended');
    const s = status(cwd, 100); assert.equal(s.checkpoint, null); assert.equal(s.horizon.task, null); assert.equal(s.horizon.chain, null);
    assert.equal(s.horizon.endpoint.kind, 'verified-integrated-delivery'); assert.equal(s.clocks.preselection_ms, 5);
  });
  test('source-backed-slice-warning-stable-id-idempotence-and-closed-projection', () => {
    const cwd = setup(), extra = delivered(cwd);
    assert.equal(clock.readDeliveries({ cwd, milestone: M, now: BASE + 40, ...extra }).proven.length, 1);
    const options = { kind: 'slice-boundary', now: BASE + 40, ...extra };
    const first = admission.observeBoundary(cwd, M, options); assert.equal(first.record.classification, 'at-risk');
    assert.equal(first.record.id, hash(JSON.stringify([M, 2, 'slice-boundary', JSON.stringify(['S01']), 'at-risk'])));
    assert.deepEqual(first.record.alternatives, ['extend', 'reduce-scope', 'continue-to-cap']);
    const before = snapshot(cwd); assert.equal(admission.observeBoundary(cwd, M, { ...options, now: BASE + 41 }).status, 'unchanged');
    assert.deepEqual(snapshot(cwd), before); assert.equal(status(cwd, 40, extra).state, 'warning');
    assert.equal(time.listWarnings({ cwd, milestone: M }).records.length, 1);
    assert.equal(first.record.progress.proven_slices[0], 'S01'); assert.equal(first.record.remaining_ms, 60);
    const summary = admission.summarizeTimeStatus(status(cwd, 40, extra));
    assert(Buffer.byteLength(JSON.stringify(summary)) <= 512); assert(!JSON.stringify(summary).includes(cwd));
    assert.deepEqual(Object.keys(summary).sort(), ['state', 'ceiling_ms', 'consumed_ms', 'unknown_ms', 'remaining_ms', 'forecast', 'last_warning', 'unknown', 'decision_pending'].sort());
  });
  test('new-blocked-boundaries-class-changes-and-informational-no-authority', () => {
    const cwd = setup(), extra = delivered(cwd);
    const observe = (at, reason, units) => admission.observeBoundary(cwd, M, { kind: 'blocked', reason, units, now: BASE + at, ...extra });
    const fits = observe(10, 'units-blocked', ['execute-task/T01']); assert.equal(fits.record.classification, 'fits');
    assert.deepEqual(fits.record.alternatives, []); assert.equal(fits.record.warning, false);
    const warning = observe(40, 'pending-questions', ['execute-task/T02']); assert.equal(warning.record.classification, 'at-risk');
    assert.equal(observe(41, 'failure-deferred', ['execute-task/T03']).status, 'unchanged');
    const exceeds = observe(60, 'units-blocked', ['execute-task/T04']); assert.equal(exceeds.record.classification, 'exceeds');
    assert.equal(observe(61, 'irrelevant', ['execute-task/T05']).status, 'ignored');
    assert.equal(time.readContract({ cwd, milestone: M }).version, 2);
    const unknown = admission.observeBoundary(setup(), M, { kind: 'blocked', reason: 'units-blocked', units: [], now: BASE });
    assert.equal(unknown.record.classification, 'unknown'); assert.deepEqual(unknown.record.alternatives, []);
  });
  test('status-and-cli-public-fields-pure-and-exit-zero-two-three', () => {
    const cwd = setup(), file = path.join(__dirname, 'forge-milestone-time-admission.js'), before = snapshot(cwd);
    const cli = args => spawnSync(process.execPath, [file, ...args, '--cwd', cwd, '--json'], { encoding: 'utf8' });
    assert.equal(cli(['--status', '--milestone', M]).status, 0);
    const refused = cli(['--admit-transport', '--milestone', M, '--unit', 'execute-task/T01']);
    assert.equal(refused.status, 3); assert.equal(JSON.parse(refused.stdout).provider_called, false);
    assert.equal(cli(['--status', '--admit-transport', '--milestone', M]).status, 2);
    assert.equal(cli(['--admit-transport', '--milestone', M, '--unit', '../secret']).status, 2);
    assert.equal(cli(['--status', '--milestone', M, '--bad']).status, 2);
    assert(!JSON.stringify(status(cwd, 10)).includes(cwd)); assert.deepEqual(snapshot(cwd), before);
    const absent = owner(); assert.equal(spawnSync(process.execPath, [file, '--admit-transport', '--milestone', M,
      '--unit', 'execute-task/T01', '--cwd', absent, '--json']).status, 0);
  });
  test('legacy-absent-contract-long-unicode-module-and-controller-identifiers', () => {
    for (const id of ['T-' + 'x'.repeat(180), 'T-ação-Ω']) {
      const cwd = owner(), unit = 'execute-task/' + id;
      assert.deepEqual(admission.decideAdmission(cwd, { milestone: M, unit }), { allowed: true, decision: 'no-contract' });
      assert.deepEqual(admission.assertTransportEntry({ cwd, milestone: M, unit }), { allowed: true, decision: 'no-contract' });
      fs.mkdirSync(path.join(cwd, '.gsd/milestones/M001'), { recursive: true });
      require('./forge-state').write(cwd, { milestone: M, kind: 'milestone', phase: 'execute-task',
        active_slice: 'S01', active_task: id, next_action: 'execute', auto_mode: 'on' });
      const began = controller.begin(cwd, { milestone: M, slice: 'S01', unit, host_runtime: 'codex',
        owner_token: 'fixture', idempotency_key: 'legacy-id' }, { now: () => BASE + 1,
        prefsReader: () => ({ ok: true, prefs: {} }), inventoryReader: () => ({ slices: [{ id: 'S01', tasks: [{ id }] }] }) });
      assert.equal(began.ok, true, JSON.stringify(began));
      assert(!JSON.stringify(began).includes('time_admission'));
      const timed = setup();
      assert.throws(() => admission.decideAdmission(timed, { milestone: M, unit, now: BASE + 1 }), /inválida/);
    }
  });
  test('summary-closed-under-hostile-input-and-maximal-numeric-fields', () => {
    const projected = admission.summarizeTimeStatus({ state: '/private', horizon: { ceiling_ms: Number.MAX_SAFE_INTEGER },
      clocks: { consumed_ms: Number.MAX_SAFE_INTEGER, unknown_ms: Number.MAX_SAFE_INTEGER }, remaining_ms: -Number.MAX_SAFE_INTEGER,
      forecast: { status: 'unknown', reason: 'C:/private' }, last_warning: { id: 'a'.repeat(64) },
      checkpoint: { decision_pending: true }, unknowns: ['raw-session'], raw_session: 'never expose' });
    assert.equal(projected.state, null); assert.equal(projected.decision_pending, true);
    const bytes = JSON.stringify(projected); assert(Buffer.byteLength(bytes) <= 512);
    assert(!/private|raw-session|never expose/.test(bytes));
  });
  test('declared-artifacts-substantive-without-module-stubs', () => {
    for (const [name, minimum] of [['forge-milestone-time-admission.js', 240], ['forge-milestone-time-admission.test.js', 220]]) {
      const source = fs.readFileSync(path.join(__dirname, name), 'utf8'); assert(source.split('\n').length >= minimum);
      if (!name.endsWith('.test.js')) assert(!/TODO|TBD|FIXME/.test(source));
    }
  });
  console.log('PASS admission-suite ' + count + ' checks');
} finally {
  for (const cwd of roots) fs.rmSync(cwd, { recursive: true, force: true });
}
