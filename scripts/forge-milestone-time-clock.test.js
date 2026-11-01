#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const clock = require('./forge-milestone-time-clock');
const phase = require('./forge-phase-cost');
const time = require('./forge-milestone-time');
const delivery = require('./forge-delivery');
const controller = require('./forge-unit-controller');
const questions = require('./forge-pending-questions');
const fixture = require('./fixtures/milestone-time/clock-cases.json');
const BASE = Date.parse('2026-11-01T12:00:00.000Z'), M = 'M001';
const roots = [];
let count = 0;
const iso = ms => new Date(BASE + ms).toISOString();
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function test(name, fn) { fn(); count++; console.log('PASS ' + name); }
function root() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-clock-')); roots.push(dir); return dir; }
function write(cwd, ref, value) {
  const file = path.join(cwd, ref); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value) + '\n'); return file;
}
function contract() {
  return { schema_version: 1, milestone: M, clock_policy: { id: clock.CLOCK_POLICY.id, version: 1 },
    option: { id: 'balanced', options_sha256: 'a'.repeat(64), label: 'Entrega verificada' },
    activated_at: iso(0), preselection_started_at: iso(-4), ceiling_ms: 100,
    endpoint: { kind: 'verified-integrated-delivery', items: Object.fromEntries(time.ENDPOINT_ITEMS.map(k => [k, 'pending'])) },
    allocation: null, linked_task: null, chain_forecast: null,
    decision: { reference: 'fixture-only', question: { identity_sha256: 'b'.repeat(64), id: 'q1' },
      answer: 'option:balanced', source: 'user-text', resolved_at: iso(0), request_sha256: 'c'.repeat(64) } };
}
function event(eventName, unit, at, extra = {}) {
  return { event: eventName, milestone: M, unit: unit.includes('/') ? unit : 'execute-task/' + unit,
    host_runtime: 'codex', action: eventName === 'unit-began' ? 'begin' : 'complete', ts: iso(at), ...extra };
}
function inputOf(data) {
  const rows = [], journal = [];
  for (const [unit, start, end] of data.units || []) {
    rows.push(event('unit-began', unit, start)); if (end !== null) rows.push(event('unit-transition', unit, end));
  }
  for (const [first, second, end] of data.ambiguous || []) rows.push(event('unit-began', 'T90', first),
    event('unit-began', 'T90', second), event('unit-transition', 'T90', end));
  for (const [unit, at] of data.pauses || []) {
    const existing = rows.find(r => r.unit === 'execute-task/' + unit && r.ts === iso(at) && r.event === 'unit-transition');
    if (existing) existing.action = 'pause'; else rows.push(event('unit-transition', unit, at, { action: 'pause' }));
  }
  for (const [at, session, boundary] of data.presence || []) journal.push({ type: 'presence', at: iso(at), boundary,
    session_sha256: session === null ? null : hash(session) });
  for (const [index, [kind, start, end, sourceKind, ref]] of (data.waits || []).entries()) {
    const record = { type: 'wait-start', at: iso(start), class: kind, wait_id: 'wait-' + index, source: { kind: sourceKind, ref } };
    journal.push(record); if (end !== null) journal.push({ ...record, type: 'wait-end', at: iso(end) });
  }
  rows.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)); journal.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const bytes = Buffer.from(rows.map(JSON.stringify).join('\n') + (rows.length ? '\n' : ''));
  return { contract: contract(), now: BASE + data.now_ms, events: phase.analyzeEventIntervals(bytes), journal, pending: data.pending || [], rows };
}
function setup(data = { now_ms: 12 }) {
  const cwd = root(), input = inputOf(data);
  write(cwd, '.gsd/forge/time/M001/contract.json', input.contract);
  if (input.journal.length) write(cwd, '.gsd/forge/time/M001/journal.jsonl', input.journal.map(JSON.stringify).join('\n') + '\n');
  if (input.rows.length) write(cwd, '.gsd/milestones/M001/M001-events.jsonl', input.rows.map(JSON.stringify).join('\n') + '\n');
  return { cwd, milestone: M, now: input.now, input };
}
function snapshot(cwd) {
  const result = {};
  function visit(dir) { for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name), stat = fs.lstatSync(file), ref = path.relative(cwd, file);
    result[ref] = [stat.mtimeMs, stat.isFile() ? hash(fs.readFileSync(file)) : stat.isSymbolicLink() ? fs.readlinkSync(file) : 'directory'];
    if (stat.isDirectory() && !stat.isSymbolicLink()) visit(file);
  } }
  visit(cwd); return result;
}
// Explicit filesystem seam for pure fixtures. Production uses forge-vcs.hashPath
// (including Git's configured clean normalization), never this fixture helper.
function fixtureCurrentHash(cwd, relative) {
  const bytes = fs.readFileSync(path.join(cwd, relative));
  return { ok: true, hash: crypto.createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex') };
}
function deliveredFixture() {
  const f = setup(), cwd = f.cwd;
  const source = write(cwd, 'scripts/result.js', 'module.exports = 1;\n');
  const planRef = '.gsd/milestones/M001/slices/S01/S01-PLAN.md';
  const plan = '---\nid: S01\nwrites:\n  - scripts/result.js\nmust_haves:\n  truths:\n    - observable fixture behavior\n  artifacts:\n    - path: scripts/result.js\n      provides: result\n      min_lines: 1\n  key_links: []\nexpected_output:\n  - scripts/result.js\n---\n';
  write(cwd, planRef, plan);
  const unit = { type: 'slice', id: 'S01', milestone: M };
  const contents = fs.readFileSync(source), blob = crypto.createHash('sha1').update(Buffer.from(`blob ${contents.length}\0`)).update(contents).digest('hex');
  const envelope = { schema_version: 1, kind: 'verification', unit, plan_fingerprint: hash(plan), code_dir: cwd,
    revision: 'fixture-revision', workspace: [{ path: 'scripts/result.js', hash: blob }], environment: 'hermetic-fixture', captured_at: iso(1),
    result: { passed: true, checks: [{ command: 'fixture-observable-result', exit_code: 0 }] } };
  const envelopeRef = '.gsd/milestones/M001/slices/S01/verify.json'; write(cwd, envelopeRef, envelope);
  const input = { schema_version: 1, unit, plan: planRef, plan_fingerprint: hash(plan), bindings: [
    { criterion: { kind: 'truth', index: 0 }, aspect: 'default', coverage: 'behavioral', source: { kind: 'verification', path: envelopeRef, check_index: 0 } },
    { criterion: { kind: 'artifact', index: 0 }, aspect: 'declared-property', coverage: 'structural', source: { kind: 'verification', path: envelopeRef, check_index: 0 } },
  ] };
  const deliveryRef = '.gsd/milestones/M001/slices/S01/S01-DELIVERY.json';
  write(cwd, deliveryRef.replace('-DELIVERY.json', '-DELIVERY-INPUT.json'), input);
  const projection = delivery.buildDelivery(input, { ownerRoot: cwd, codeDir: cwd });
  assert(projection.criteria.every(c => c.status === 'verificado'), JSON.stringify(projection.diagnostics));
  write(cwd, deliveryRef, projection);
  require('./forge-state').write(cwd, { milestone: M, kind: 'milestone', phase: 'complete-slice', active_slice: 'S01', active_task: '—', next_action: 'complete', auto_mode: 'on' });
  const request = { milestone: M, slice: 'S01', unit: 'complete-slice/S01', host_runtime: 'codex', owner_token: 'fixture-owner', session: 'fixture' };
  const options = { now: () => BASE + 1, prefsReader: () => ({ ok: true, prefs: {} }), inventoryReader: () => ({ slices: [{ id: 'S01', tasks: [] }] }) };
  const begun = controller.begin(cwd, { ...request, idempotency_key: 'fixture-begin' }, options);
  const completed = controller.complete(cwd, { ...request, generation: begun.generation, idempotency_key: 'fixture-complete', result: { status: 'succeeded' } }, options);
  assert.equal(completed.transaction.phase, 'committed');
  return { ...f, deliveryRef, envelopeRef, envelope, projection, deliveryInput: input, source, planRef, currentHashReader: fixtureCurrentHash };
}
try {
  test('declared-artifact-files-substantive-and-fixture-inputs', () => {
    for (const [file, lines] of [['forge-phase-cost.js', 130], ['forge-phase-cost.test.js', 95],
      ['forge-milestone-time-clock.js', 220], ['forge-milestone-time-clock.test.js', 180], ['fixtures/milestone-time/clock-cases.json', 60]]) {
      const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
      assert(source.split('\n').length >= lines, file);
      if (!file.endsWith('.test.js')) assert(!/\b(?:TODO|TBD|FIXME)\b/.test(source), file);
    }
    assert.equal(fixture.schema_version, 1); assert(fixture.cases.length >= 8);
    assert.equal(fixture.provenance.renamed_from, 'effort'); assert(fixture.cases.every(row => !Object.hasOwn(row.expect, 'effort')));
    assert(fixture.cases.every(row => row.name && row.input && row.expect));
  });
  test('policy-exports-purity-and-no-implicit-clock', () => {
    for (const name of ['CLOCK_POLICY', 'FORECAST_POLICY', 'computeClock', 'readClock', 'readDeliveries', 'computeForecast', 'readForecast', 'main']) assert(clock[name]);
    assert.equal(clock.CLOCK_POLICY.version, 1); assert.equal(clock.FORECAST_POLICY.version, 1);
    assert.deepEqual(clock.CLOCK_POLICY.priority, ['unit-work', 'owner-session', 'human-wait', 'pause', 'ci-wait', 'external-wait', 'unknown']);
    const input = inputOf(fixture.cases[0].input), before = JSON.stringify(input), saved = Date.now;
    try { Date.now = () => { throw Error('implicit time'); }; assert.equal(clock.computeClock(input).status, 'measured');
      assert.equal(clock.computeForecast({ contract: input.contract }).reason, 'allocation-missing'); }
    finally { Date.now = saved; }
    assert.equal(JSON.stringify(input), before); assert.equal(clock.computeClock({ ...input, now: undefined }).reason, 'clock-now-invalid');
  });
  for (const row of fixture.cases) test('clock-fixture-' + row.name, () => {
    const input = inputOf(row.input), result = clock.computeClock(input), expected = row.expect;
    assert.equal(result.status, 'measured', JSON.stringify(result));
    assert.equal(result.elapsed.since_activation_ms, expected.elapsed); assert.equal(result.elapsed.preselection_ms, 4);
    assert.equal(result.consumption.consumed_ms, expected.consumed); assert.equal(result.consumption.unknown_ms, expected.unknown);
    // Pre-release `effort` expectations were controller unit sums, not worker time.
    assert.equal(result.effort.unit_interval_sum_ms, expected.unit_interval_sum); assert.equal(result.effort.open_units, expected.open || 0);
    assert.equal(result.effort.basis, 'controller-unit-intervals'); assert(!Object.hasOwn(result.effort, 'worker_ms'));
    assert.equal(result.effort.ambiguous_units, expected.ambiguous || 0);
    assert.equal(result.effort.unit_complete, !expected.open && !expected.ambiguous);
    assert.equal(result.effort.worker.status, 'unknown'); assert.equal(result.effort.worker.worker_ms, null);
    assert.equal(result.effort.worker.observed_worker_ms, null);
    if (expected.gap_reason) assert(result.gaps.some(g => g.reason === expected.gap_reason));
    if (expected.wait) assert.equal(result.waits[expected.wait[0]], expected.wait[1]);
    assert.equal(Object.values(result.consumption.by_class).reduce((a, b) => a + b, 0), expected.elapsed);
    assert.equal(result.consumption.consumed_ms, result.consumption.by_class['unit-work'] + result.consumption.by_class['owner-session'] + result.consumption.unknown_ms);
  });
  test('recompute-child-process-identical-after-compaction-and-readonly-sources', () => {
    for (const row of fixture.cases) {
      const f = setup(row.input), before = snapshot(f.cwd), local = clock.readClock(f);
      // Pure pending sources in fixtures are intentionally not forged into real
      // question state; only readClock can confirm a live persisted question.
      const child = spawnSync(process.execPath, ['-e', 'const c=require(process.argv[1]);const o=JSON.parse(process.argv[2]);process.stdout.write(JSON.stringify(c.readClock(o)));',
        require.resolve('./forge-milestone-time-clock'), JSON.stringify({ cwd: f.cwd, milestone: M, now: f.now })], { encoding: 'utf8', timeout: 10000 });
      assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), local);
      assert.deepEqual(snapshot(f.cwd), before); assert.equal(local.status, 'measured');
      assert(local.sources.some(s => s.status === 'nested-not-counted' && s.path === '.gsd/forge/events.jsonl'));
      assert(local.sources.some(s => s.status === 'nested-not-counted' && s.path === '.gsd/forge/receipts'));
      assert(!JSON.stringify(local).includes(f.cwd));
    }
  });
  test('human-wait-canonical-continuation-matching-scope-and-missing-end', () => {
    const f = setup(), opened = questions.openQuestions({ cwd: f.cwd, unit: 'milestone-time/M001', milestone: M,
      decision_set: 'milestone-time-clock-fixture', questions: [{ id: 'choice', question: 'Escolha?' }] });
    const wait = { type: 'wait-start', wait_id: 'w1', class: 'human', at: iso(3), source: { kind: 'pending-question', ref: opened.identity_sha256 + ':choice' } };
    write(f.cwd, '.gsd/forge/time/M001/journal.jsonl', JSON.stringify(wait) + '\n');
    const before = snapshot(f.cwd), pending = clock.readClock(f);
    assert.equal(pending.waits['human-wait'], 9); assert.equal(pending.consumption.consumed_ms, 3);
    assert.deepEqual(snapshot(f.cwd), before);
    questions.answer({ cwd: f.cwd, identity: opened.identity_sha256, answers: [{ id: 'choice', answer: 'respondido', source: 'user-text' }] });
    const answered = clock.readClock(f); assert.equal(answered.consumption.unknown_ms, 12); assert(answered.gaps.some(g => g.reason === 'wait-end-missing'));
    const foreign = questions.openQuestions({ cwd: f.cwd, unit: 'milestone-time/M002', milestone: 'M002', decision_set: 'milestone-time-clock-fixture', questions: [{ id: 'choice', question: 'Outra?' }] });
    wait.source.ref = foreign.identity_sha256 + ':choice'; write(f.cwd, '.gsd/forge/time/M001/journal.jsonl', JSON.stringify(wait) + '\n');
    assert.equal(clock.readClock(f).consumption.unknown_ms, 12);
  });
  test('source-absent-zero-invalid-corrupt-conflicting-and-limit-unknown-without-partial-numbers', () => {
    const absent = { cwd: root(), milestone: M, now: BASE + 12 }; assert.equal(clock.readClock(absent).status, 'no-contract');
    const f = setup(), empty = clock.readClock(f); assert.equal(empty.status, 'measured');
    assert(empty.sources.some(s => s.status === 'absent' && s.path.endsWith('events.jsonl')));
    const eventRef = '.gsd/milestones/M001/M001-events.jsonl'; write(f.cwd, eventRef, '');
    assert(clock.readClock(f).sources.some(s => s.status === 'valid' && s.records === 0 && s.path.endsWith('events.jsonl')));
    for (const [contents, reason] of [['{', 'phase-cost-json-invalid'], [Buffer.alloc(phase.MAX_BYTES + 1), 'clock-source-limit'],
      [[event('unit-began', 'T01', 0, { idempotency_key: 'x' }), event('unit-began', 'T01', 1, { idempotency_key: 'x' })].map(JSON.stringify).join('\n'), 'phase-cost-conflicting-id'],
      [JSON.stringify(event('unit-transition', 'T01', 0, { milestone: 'M002' })), 'clock-event-milestone-mismatch'],
      [JSON.stringify(event('unit-began', 'T01', 0, { ts: 'invalid' })), 'phase-cost-lifecycle-invalid']]) {
      write(f.cwd, eventRef, contents); const result = clock.readClock(f);
      assert.equal(result.status, 'unknown'); assert.equal(result.reason, reason); assert.equal(result.consumption, undefined);
    }
    write(f.cwd, eventRef, ''); write(f.cwd, '.gsd/forge/time/M001/journal.jsonl', '{}\n');
    assert.equal(clock.readClock(f).reason, 'time-journal-record-invalid');
    write(f.cwd, '.gsd/forge/time/M001/journal.jsonl', ''); write(f.cwd, '.gsd/forge/time/M001/contract.json', '{}');
    assert.equal(clock.readClock(f).status, 'unknown');
    const malformed = { ...contract(), milestone: 'M002' }; write(f.cwd, '.gsd/forge/time/M001/contract.json', malformed);
    assert.equal(clock.readClock(f).reason, 'time-contract-milestone-mismatch');
    assert.equal(clock.readClock({ ...f, milestone: '../outside' }).status, 'unknown');
    const unreadable = setup({ now_ms: 12, units: [['T01', 0, 7]] }), originalOpen = fs.openSync;
    try {
      fs.openSync = function(file, ...args) { if (String(file).endsWith('M001-events.jsonl')) throw Object.assign(Error('fixture-denied'), { code: 'EACCES' }); return originalOpen.call(this, file, ...args); };
      const result = clock.readClock(unreadable); assert.equal(result.reason, 'clock-source-unreadable'); assert.equal(result.consumption, undefined);
    } finally { fs.openSync = originalOpen; }
    const linkRoot = root(), target = setup(); fs.mkdirSync(path.join(linkRoot, '.gsd'), { recursive: true });
    // Directory junctions are available to ordinary Windows users too.
    fs.symlinkSync(path.join(target.cwd, '.gsd/forge'), path.join(linkRoot, '.gsd/forge'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(clock.readClock({ ...f, cwd: linkRoot }).status, 'unknown');
  });
  test('forecast-v1-all-classes-no-double-unknown-and-no-duration-constant', () => {
    const c = contract(), measured = { status: 'measured', consumption: { consumed_ms: 12, unknown_ms: 5 } };
    const proven = { status: 'observed', proven: [{ slice: 'S01' }] }, none = { status: 'observed', proven: [] };
    const forecast = (ceiling, consumed = 12) => clock.computeForecast({ contract: { ...c, ceiling_ms: ceiling }, clock: { ...measured, consumption: { consumed_ms: consumed, unknown_ms: 5 } }, deliveries: proven });
    assert.equal(forecast(100).reason, 'allocation-missing');
    c.allocation = { roadmap_sha256: 'd'.repeat(64), items: [{ id: 'prep', kind: 'preparation', ms: 2 }, { id: 's1', kind: 'slice', slice: 'S01', ms: 4 }, { id: 's2', kind: 'slice', slice: 'S02', ms: 10 }] };
    let result = forecast(40); assert.equal(result.status, 'fits'); assert.equal(result.burn_ratio, 2); assert.equal(result.remaining_ms, 28);
    assert.deepEqual(result.projection, { low_ms: 10, high_ms: 20 });
    assert.equal(forecast(27).status, 'at-risk'); assert.equal(forecast(21).status, 'exceeds');
    assert.equal(forecast(32).status, 'fits'); assert.equal(forecast(22).status, 'at-risk');
    result = forecast(100, 3); assert.equal(result.burn_ratio, 0.5); assert.deepEqual(result.projection, { low_ms: 5, high_ms: 10 });
    assert.equal(clock.computeForecast({ contract: c, clock: measured, deliveries: none }).reason, 'no-proven-delivery');
    assert.equal(clock.computeForecast({ contract: { ...c, ceiling_ms: 20 }, clock: measured, deliveries: none }).status, 'exceeds');
    assert.equal(clock.computeForecast({ contract: c, clock: { status: 'unknown' }, deliveries: proven }).reason, 'clock-unknown');
    assert.equal(clock.computeForecast({ contract: c, clock: measured, deliveries: { status: 'unknown' } }).reason, 'deliveries-unknown');
    assert.equal(forecast(10).status, 'exceeds');
  });
  test('canonical-delivery-revalidation-committed-completion-and-current-sources', () => {
    const f = deliveredFixture(), before = snapshot(f.cwd), result = clock.readDeliveries({ ...f, slices: ['S01'] });
    assert.deepEqual(result.unproven, [], JSON.stringify(result)); assert.equal(result.proven.length, 1);
    assert.deepEqual(snapshot(f.cwd), before);
  });
  test('delivery-negatives-forged-pending-foreign-stale-corrupt-and-event-only', () => {
    const f = deliveredFixture(), read = () => clock.readDeliveries({ ...f, slices: ['S01'] });
    const deliveryFile = path.join(f.cwd, f.deliveryRef), original = fs.readFileSync(deliveryFile);
    for (const projection of [{ generated_by: 'forge-delivery', unit: f.projection.unit },
      delivery.finalizeOutput({ ...f.projection, unit: { ...f.projection.unit, milestone: 'M002' } }),
      delivery.finalizeOutput({ ...f.projection, criteria: f.projection.criteria.map(c => ({ ...c, status: 'verificado', pending: ['unbound'] })) })]) {
      write(f.cwd, f.deliveryRef, projection); assert.equal(read().proven.length, 0);
    }
    write(f.cwd, f.deliveryRef, original);
    const envelopeFile = path.join(f.cwd, f.envelopeRef), savedEnvelope = fs.readFileSync(envelopeFile);
    write(f.cwd, f.envelopeRef, { ...f.envelope, result: { passed: false, checks: [{ command: 'fixture-observable-result', exit_code: 1 }] } });
    assert.equal(read().proven.length, 0); write(f.cwd, f.envelopeRef, savedEnvelope);
    write(f.cwd, 'scripts/result.js', 'module.exports = 2;\n'); assert.equal(read().unproven[0].reason, 'delivery-current-source-changed');
    write(f.cwd, 'scripts/result.js', 'module.exports = 1;\n');
    write(f.cwd, f.envelopeRef, { ...f.envelope, workspace: [] });
    const changed = delivery.buildDelivery(f.deliveryInput, { ownerRoot: f.cwd, codeDir: f.cwd }); write(f.cwd, f.deliveryRef, changed);
    assert.equal(read().unproven[0].reason, 'delivery-current-source-binding-missing');
    write(f.cwd, f.envelopeRef, savedEnvelope); write(f.cwd, f.deliveryRef, original);
    const tx = controller.transactionFile(f.cwd, 'fixture-complete'), txOriginal = fs.readFileSync(tx);
    const raw = controller.lookupRecord(f.cwd, 'transaction', 'fixture-complete'); raw.phase = 'intent'; controller.writeAtomic(tx, raw);
    assert.equal(read().unproven[0].reason, 'delivery-completion-unproven');
    fs.writeFileSync(tx, txOriginal); const corrupt = JSON.parse(txOriginal); corrupt.phase = 'intent'; write(f.cwd, path.relative(f.cwd, tx), corrupt);
    assert.equal(read().proven.length, 0); fs.writeFileSync(tx, txOriginal);
    const boundary = controller.boundaryFile(f.cwd, 'complete-slice/S01'), savedBoundary = fs.readFileSync(boundary);
    fs.unlinkSync(boundary); assert.equal(read().proven.length, 0); fs.writeFileSync(boundary, savedBoundary);
    const plan = fs.readFileSync(path.join(f.cwd, f.planRef)); write(f.cwd, f.planRef, plan.toString() + 'changed\n');
    assert.equal(read().proven.length, 0); write(f.cwd, f.planRef, plan);
    write(f.cwd, f.deliveryRef, Buffer.alloc(1024 * 1024 + 1)); assert.equal(read().proven.length, 0);
    write(f.cwd, f.deliveryRef, '{'); assert.equal(read().proven.length, 0);
  });
  test('delivery-recursive-child-inputs-and-complete-slice-inventory', () => {
    const f = deliveredFixture(), unit = { type: 'task', id: 'T01', slice: 'S01', milestone: M };
    const childPlanRef = '.gsd/milestones/M001/slices/S01/tasks/T01/T01-PLAN.md';
    const plan = fs.readFileSync(path.join(f.cwd, f.planRef), 'utf8').replace('id: S01', 'id: T01');
    write(f.cwd, childPlanRef, plan);
    const childEnvelopeRef = '.gsd/milestones/M001/slices/S01/tasks/T01/verify.json';
    const childEnvelope = { ...f.envelope, unit, plan_fingerprint: hash(plan) }; write(f.cwd, childEnvelopeRef, childEnvelope);
    const childInput = { ...f.deliveryInput, unit, plan: childPlanRef, plan_fingerprint: hash(plan),
      bindings: f.deliveryInput.bindings.map(row => ({ ...row, source: { ...row.source, path: childEnvelopeRef } })) };
    const childRef = '.gsd/milestones/M001/slices/S01/tasks/T01/T01-DELIVERY.json';
    write(f.cwd, childRef.replace('-DELIVERY.json', '-DELIVERY-INPUT.json'), childInput);
    write(f.cwd, childRef, delivery.buildDelivery(childInput, { ownerRoot: f.cwd, codeDir: f.cwd }));
    const parentPlan = fs.readFileSync(path.join(f.cwd, f.planRef), 'utf8') + '- [x] T01: Child evidence\n';
    write(f.cwd, f.planRef, parentPlan); write(f.cwd, f.envelopeRef, { ...f.envelope, plan_fingerprint: hash(parentPlan) });
    const parentInput = { ...f.deliveryInput, plan_fingerprint: hash(parentPlan), expected_children: [{ unit, delivery: childRef }] };
    const publish = input => {
      write(f.cwd, f.deliveryRef.replace('-DELIVERY.json', '-DELIVERY-INPUT.json'), input);
      write(f.cwd, f.deliveryRef, delivery.buildDelivery(input, { ownerRoot: f.cwd, codeDir: f.cwd }));
    };
    publish(parentInput);
    const read = () => clock.readDeliveries({ ...f, slices: ['S01'] });
    assert.equal(read().proven.length, 1, JSON.stringify(read()));
    write(f.cwd, childEnvelopeRef, { ...childEnvelope, result: { passed: false, checks: [{ command: 'fixture-observable-result', exit_code: 1 }] } });
    assert.equal(read().proven.length, 0, 'green saved child cannot hide changed source'); write(f.cwd, childEnvelopeRef, childEnvelope);
    publish({ ...parentInput, expected_children: [] }); assert.equal(read().unproven[0].reason, 'delivery-child-inventory-mismatch');
    const legacy = '# Slice aggregate\n- [x] T01: Child evidence\n'; write(f.cwd, f.planRef, legacy);
    publish({ ...parentInput, plan_fingerprint: hash(legacy), bindings: [] });
    assert.equal(read().proven.length, 1, JSON.stringify(read()));
  });
  test('delivery-clean-revision-blob-seams-dirty-precedence-cache-and-refusals', () => {
    const f = deliveredFixture(), expectedHash = fixtureCurrentHash(f.cwd, 'scripts/result.js').hash;
    const publishEnvelope = envelope => {
      write(f.cwd, f.envelopeRef, envelope);
      write(f.cwd, f.deliveryRef, delivery.buildDelivery(f.deliveryInput, { ownerRoot: f.cwd, codeDir: f.cwd }));
    };
    const clean = { ...f.envelope, revision: 'a'.repeat(40), workspace: [] }; publishEnvelope(clean);
    let revisionReads = 0, currentReads = 0;
    const options = { ...f, slices: ['S01'],
      revisionBlobReader: (cwd, revision, relative) => {
        assert.equal(cwd, f.cwd); assert.equal(revision, clean.revision); assert.equal(relative, 'scripts/result.js');
        revisionReads++; return { ok: true, hash: expectedHash };
      },
      currentHashReader: (...args) => { currentReads++; return fixtureCurrentHash(...args); } };
    const before = snapshot(f.cwd), observed = clock.readDeliveries(options);
    assert.equal(observed.proven.length, 1, JSON.stringify(observed)); assert.equal(revisionReads, 1); assert.equal(currentReads, 1);
    assert.deepEqual(snapshot(f.cwd), before);
    assert.equal(clock.readDeliveries({ ...options, revisionBlobReader: () => ({ ok: false }) }).unproven[0].reason, 'delivery-revision-unreadable');
    assert.equal(clock.readDeliveries({ ...options, revisionBlobReader: () => ({ ok: true, hash: 'bad' }) }).unproven[0].reason, 'delivery-revision-unreadable');
    assert.equal(clock.readDeliveries({ ...options, revisionBlobReader: () => ({ ok: true, hash: 'b'.repeat(40) }) }).unproven[0].reason, 'delivery-current-source-changed');
    assert.equal(clock.readDeliveries({ ...options, currentHashReader: () => ({ ok: false }) }).unproven[0].reason, 'delivery-current-source-unreadable');
    publishEnvelope({ ...clean, revision: 'HEAD' });
    assert.equal(clock.readDeliveries(options).unproven[0].reason, 'delivery-current-source-binding-missing');
    publishEnvelope({ ...clean, code_dir: root() }); assert.equal(clock.readDeliveries(options).proven.length, 0);
    publishEnvelope({ ...clean, workspace: f.envelope.workspace });
    assert.equal(clock.readDeliveries({ ...options, revisionBlobReader: () => { throw Error('dirty path must not read revision'); } }).proven.length, 1);
    publishEnvelope({ ...clean, workspace: [{ path: 'scripts/result.js', hash: 'd'.repeat(40) }] });
    assert.equal(clock.readDeliveries(options).unproven[0].reason, 'delivery-current-source-changed');
    publishEnvelope(clean);
    const unstable = clock.readDeliveries({ ...options, currentHashReader: () => {
      write(f.cwd, 'scripts/result.js', 'changed-during-read'); return { ok: true, hash: expectedHash };
    } });
    assert.equal(unstable.status, 'unknown'); assert.equal(unstable.reason, 'clock-source-unstable'); assert.equal(unstable.proven.length, 0);
  });
  test('forecast-read-cli-and-all-paths-immutable-with-relative-public-sources', () => {
    const f = setup({ now_ms: 12, units: [['T01', 0, 7]] }), c = contract();
    const roadmap = '# Fixture roadmap\n';
    c.allocation = { roadmap_sha256: hash(roadmap), items: [{ id: 'prep', kind: 'preparation', ms: 2 }, { id: 's1', kind: 'slice', slice: 'S01', ms: 10 }] };
    write(f.cwd, '.gsd/forge/time/M001/contract.json', c); write(f.cwd, '.gsd/milestones/M001/M001-ROADMAP.md', roadmap);
    const before = snapshot(f.cwd), forecast = clock.readForecast(f); assert.equal(forecast.reason, 'no-proven-delivery');
    let stdout = '', stderr = '';
    const io = { stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } };
    assert.equal(clock.main(['--milestone', M, '--cwd', f.cwd, '--json'], io, { now: f.now }), 0);
    const result = JSON.parse(stdout); assert.equal(result.clock.consumption.consumed_ms, 12);
    assert(!stdout.includes(f.cwd)); assert.equal(stderr, ''); assert.deepEqual(snapshot(f.cwd), before);
    assert.equal(clock.main(['--foreign'], io), 2);
    write(f.cwd, '.gsd/milestones/M001/M001-ROADMAP.md', 'changed'); assert.equal(clock.readForecast(f).reason, 'allocation-roadmap-mismatch');
  });
  // T08: worker effort is observed invocation evidence only. Synthetic records
  // follow the persisted schema; acquisition is covered by the observations test.
  const workers = require('./forge-milestone-worker-observations');
  function observation(unit, invocation, start, end, extra = {}) {
    const row = { schema_version: 1, id: '', milestone: M, unit: 'execute-task/' + unit, kind: 'native-supervision',
      invocation_sha256: hash(invocation), dispatch_sha256: hash('d-' + invocation), request_sha256: hash('r-' + unit), root_sha256: hash('root'),
      source: { kind: 'native-journal', sha256: hash('source-' + invocation), bytes: 128 }, started_at: iso(start), finished_at: iso(end),
      duration_ms: end - start, placement: 'exact', bound: 'complete', terminal: 'terminal', provider_called: true,
      boundary: workers.POLICY.boundaries['native-supervision'], ...extra };
    row.id = hash(JSON.stringify([M, row.kind, row.invocation_sha256])); assert(workers.validObservation(row)); return row;
  }
  function coverage(unit, begin, ids, state = 'complete') {
    const row = { schema_version: 1, id: hash(JSON.stringify([M, 'execute-task/' + unit, begin])), milestone: M, unit: 'execute-task/' + unit,
      begin_sha256: hash(begin), completion: 'complete', coverage: state, inventory: state, observations: ids, not_invoked: 0, successors: 0,
      refused: state === 'complete' ? [] : ['observation-boundary-unavailable'], reader: 'trusted-live' };
    assert(workers.validCoverage(row)); return row;
  }
  function keyedInput() {
    // One controller unit [0,10] and one T02 unit [4,12]; idempotency keys bind coverage.
    const rows = [event('unit-began', 'T01', 0, { idempotency_key: 'begin-T01' }), event('unit-began', 'T02', 4, { idempotency_key: 'begin-T02' }),
      event('unit-transition', 'T01', 10, { idempotency_key: 'begin-T01:complete' }), event('unit-transition', 'T02', 12, { idempotency_key: 'begin-T02:complete' })];
    return { contract: contract(), now: BASE + 12, events: phase.analyzeEventIntervals(Buffer.from(rows.map(JSON.stringify).join('\n') + '\n')), journal: [], pending: [], rows };
  }
  test('parallel-observed-invocations-sum-while-consumption-and-unit-sum-unchanged', () => {
    const input = keyedInput(), without = clock.computeClock(input);
    // Two overlapping invocations inside one controller unit plus one in T02.
    const a = observation('T01', 'a', 1, 7), b = observation('T01', 'b', 2, 9), c = observation('T02', 'c', 5, 11);
    const evidence = { status: 'valid', observations: [a, b, c], coverage: [coverage('T01', 'begin-T01', [a.id, b.id]), coverage('T02', 'begin-T02', [c.id])] };
    const withWorkers = clock.computeClock({ ...input, workers: evidence });
    assert.deepEqual(withWorkers.consumption, without.consumption); assert.equal(withWorkers.consumption.consumed_ms, 12);
    assert.equal(withWorkers.effort.unit_interval_sum_ms, 18); assert.equal(without.effort.unit_interval_sum_ms, 18);
    const worker = withWorkers.effort.worker;
    assert.equal(worker.status, 'complete'); assert.equal(worker.worker_ms, 6 + 7 + 6); assert.equal(worker.observed_worker_ms, 19);
    assert.equal(worker.invocations, 3); assert.equal(worker.coverage.covered, 2); assert.equal(worker.basis, 'observed-invocation-wall-intervals');
    assert(worker.limitations.includes('not-cpu-active-llm-or-billing')); assert(worker.policy.excludes.includes('receipt-lifetime'));
    assert.notEqual(worker.worker_ms, withWorkers.effort.unit_interval_sum_ms, 'never a unit-duration fallback');
  });
  test('absent-partial-and-unusable-worker-evidence-never-zero-or-unit-fallback', () => {
    const input = keyedInput(), a = observation('T01', 'a', 1, 7);
    const partial = clock.computeClock({ ...input, workers: { status: 'valid', observations: [a], coverage: [coverage('T01', 'begin-T01', [a.id])] } });
    assert.equal(partial.effort.worker.status, 'partial'); assert.equal(partial.effort.worker.worker_ms, null);
    assert.equal(partial.effort.worker.observed_worker_ms, 6); assert.equal(partial.effort.worker.coverage.unobserved, 1);
    const incomplete = clock.computeClock({ ...input, workers: { status: 'valid', observations: [a],
      coverage: [coverage('T01', 'begin-T01', [a.id], 'partial'), coverage('T02', 'begin-T02', [], 'partial')] } });
    assert.equal(incomplete.effort.worker.worker_ms, null); assert.equal(incomplete.effort.worker.coverage.partial, 2);
    const empty = clock.computeClock({ ...input, workers: { status: 'valid', observations: [], coverage: [] } });
    assert.equal(empty.effort.worker.status, 'unknown'); assert.equal(empty.effort.worker.observed_worker_ms, null);
    for (const broken of [undefined, { status: 'unknown', reason: 'observation-record-invalid' }, { status: 'valid', observations: null, coverage: [] }]) {
      const result = clock.computeClock({ ...input, workers: broken });
      assert.equal(result.status, 'measured'); assert.equal(result.consumption.consumed_ms, 12);
      assert.equal(result.effort.worker.worker_ms, null); assert.equal(result.effort.worker.observed_worker_ms, null);
    }
    const future = observation('T01', 'f', 3, 13);
    const later = clock.computeClock({ ...input, workers: { status: 'valid', observations: [a, future], coverage: [coverage('T01', 'begin-T01', [a.id, future.id])] } });
    assert.equal(later.effort.worker.observed_worker_ms, 6, 'not yet finished at now is not counted');
    const open = clock.computeClock({ ...inputOf({ now_ms: 12, units: [['T01', 2, null]] }), workers: { status: 'valid', observations: [], coverage: [] } });
    assert.equal(open.effort.worker.worker_ms, null); assert.equal(open.effort.worker.coverage.open_units, 1);
  });
  test('persisted-worker-records-read-separately-damage-leaves-clock-and-consumption', () => {
    const f = setup({ now_ms: 12, units: [['T01', 0, 7]] }), before = clock.readClock(f);
    const dir = '.gsd/forge/time/M001/observations/', a = observation('T01', 'a', 1, 6);
    write(f.cwd, dir + a.id + '.json', a);
    const read = clock.readClock(f);
    assert.equal(read.status, 'measured'); assert.deepEqual(read.consumption, before.consumption);
    assert.equal(read.effort.worker.observed_worker_ms, 5); assert.equal(read.effort.worker.status, 'partial');
    assert(read.sources.some(s => s.path === '.gsd/forge/time/M001/observations' && s.status === 'record-set' && s.records === 1));
    write(f.cwd, dir + a.id + '.json', { ...a, duration_ms: 4 });
    const damaged = clock.readClock(f);
    assert.equal(damaged.status, 'measured'); assert.deepEqual(damaged.consumption, before.consumption);
    assert.equal(damaged.effort.worker.status, 'unknown'); assert.equal(damaged.effort.worker.reason, 'observation-record-invalid');
    write(f.cwd, dir + 'other.json', a); assert.equal(clock.readClock(f).effort.worker.reason, 'observation-record-unreadable');
  });
} finally { for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`PASS milestone-clock-complete: ${count} named checks; synthetic bounded readonly evidence, no git or network`);
