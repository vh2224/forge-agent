#!/usr/bin/env node
'use strict';

// review-fix-policy-v1 contract suite. Temporary synthetic owners only: every
// event log, controller record and REVIEW.md lives under os.tmpdir() and is
// removed in `finally`. No provider, network or real .gsd state is touched.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const policy = require('./forge-review-policy');
const reviewFix = require('./forge-review-fix');
const reconciliation = require('./forge-artifact-reconciliation');
const { recoveryDispatchId } = require('./forge-recovery-dispatch-id');

const SCRIPT = path.join(__dirname, 'forge-review-policy.js');
const CLASSIFICATION = require('./fixtures/review-policy/classification-cases.json');
const HISTORY = require('./fixtures/review-policy/history-cases.json');
const ROUTE = { host_runtime: 'claude', resolved_worker_engine: 'claude', model: 'claude-opus-5', effort: 'high', worker_mode: 'sidecar' };
const MIN = 60000;
let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n  ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n  ') : error}`); }
}
function withOwner(fn) {
  const owner = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-review-policy-')));
  fs.mkdirSync(path.join(owner, '.gsd', 'forge'), { recursive: true });
  try { return fn(owner); } finally { fs.rmSync(owner, { recursive: true, force: true }); }
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function iso(ms) { return new Date(ms).toISOString(); }
function ownerEvents(owner) { return path.join(owner, '.gsd', 'forge', 'events.jsonl'); }
function appendRows(file, rows) {
  if (!rows.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n');
}
function readRows(owner) {
  if (!fs.existsSync(ownerEvents(owner))) return [];
  return fs.readFileSync(ownerEvents(owner), 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}
function admissionRows(owner) { return readRows(owner).filter(row => row && row.event === policy.ADMISSION_EVENT); }
function unitLabel(boundary) {
  return boundary.boundary === 'slice' ? `review-fix/${boundary.slice}`
    : boundary.boundary === 'task' ? `review-fix/${boundary.task}` : `review-fix/${boundary.milestone}-triage`;
}
function presetItems(names) { return names.map(name => clone(HISTORY.item_presets[name])); }
function admissionInput(owner, boundary, dispatchId, items, extra = {}) {
  const normalized = reviewFix.normalizeItems(items);
  const claim = reviewFix.deriveClaim(normalized);
  const brief = reviewFix.buildBrief({ boundary: boundary.boundary, unitLabel: unitLabel(boundary), items: normalized,
    claimPaths: claim.paths, route: extra.route || ROUTE });
  const { route, ...rest } = extra;
  return { owner, ...boundary, dispatch_id: dispatchId, brief, items, ...rest };
}
// Synthetic event timeline for one named fixture case (see the fixture description).
function materialize(owner, kase) {
  const defaults = HISTORY.defaults, M = kase.boundary.milestone || defaults.milestone;
  const milestoneRows = new Map(), ownerRows = [], transactions = new Map();
  const pushMilestone = (m, row) => { if (!milestoneRows.has(m)) milestoneRows.set(m, []); milestoneRows.get(m).push(row); };
  let cursor = Date.parse(defaults.execute_start);
  for (const e of kase.execute || []) {
    const m = e.milestone || M, unit = `execute-task/${e.task}`, key = `forge-orchestrate-next:${m}:${unit}:${e.slice}`;
    const start = e.start ? Date.parse(e.start) : cursor, end = start + Math.round(e.minutes * MIN);
    cursor = end;
    pushMilestone(m, { ts: iso(start), event: 'unit-began', action: 'begin', unit, milestone: m, host_runtime: 'claude', idempotency_key: key });
    pushMilestone(m, { ts: iso(end), event: 'unit-transition', action: 'complete', unit, milestone: m, host_runtime: 'claude', idempotency_key: `complete:${key}` });
    if (e.record !== false) transactions.set(key, { phase: 'committed', action: 'begin', milestone: m, unit: { key: unit }, after: { state: { active_slice: e.slice } } });
  }
  for (const row of kase.raw_milestone_events || []) pushMilestone(M, row);
  const timeline = { at: Date.parse(defaults.review_start) };
  const attempt = (id, minutes, unit, milestone, slice, terminal = true, noId = false) => {
    const start = timeline.at, end = start + Math.round(minutes * MIN);
    timeline.at = end + MIN;
    ownerRows.push({ ts: iso(start), event: 'dispatch', unit, ...(milestone ? { milestone } : {}), ...(slice ? { slice } : {}), ...(noId ? {} : { dispatch_id: id }) });
    if (noId) return;
    ownerRows.push({ ts: iso(start), event: 'sidecar-unit', workflow_id: 'wf-fixture', dispatch_id: id, unit, status: 'started', provider_called: false });
    if (terminal) ownerRows.push({ ts: iso(end), event: 'sidecar-unit', workflow_id: 'wf-fixture', dispatch_id: id, unit, status: 'done', provider_called: true });
  };
  for (const l of kase.legacy || []) {
    const milestone = l.milestone === null ? null : l.milestone || M;
    const slice = l.unit ? null : l.slice || kase.boundary.slice || 'S01';
    attempt(l.dispatch_id, l.minutes, l.unit || `review-fix/${slice}`, milestone, slice, l.terminal !== false, l.no_id === true);
  }
  if (kase.incident) {
    for (let i = 1; i <= kase.incident.dispatches; i++) {
      attempt(`incident-${i}`, kase.incident.minutes_each, unitLabel(kase.boundary), M, kase.boundary.slice);
    }
  }
  appendRows(ownerEvents(owner), [...(kase.raw_owner_lines || []), ...ownerRows]);
  for (const [m, rows] of milestoneRows) appendRows(path.join(owner, '.gsd', 'milestones', m, `${m}-events.jsonl`), rows);
  const lookup = (root, kind, key) => {
    assert.strictEqual(root, owner, 'lookup receives the physical owner');
    assert.strictEqual(kind, 'transaction');
    return transactions.has(key) ? clone(transactions.get(key)) : null;
  };
  // A measured attempt recorded after an admission (the real started → terminal pair).
  const after = (dispatchId, minutes) => attempt(dispatchId, minutes, unitLabel(kase.boundary), kase.boundary.milestone,
    kase.boundary.slice, true, false) || appendRows(ownerEvents(owner), ownerRows.splice(0));
  ownerRows.length = 0;
  return { lookup, after };
}
function checkStatus(row, expect, label) {
  if (!expect) return;
  for (const field of ['cycles', 'refusals', 'malformed_lines']) if (field in expect) assert.strictEqual(row[field], expect[field], `${label} ${field}`);
  if ('budget_status' in expect) assert.strictEqual(row.budget.status, expect.budget_status, `${label} budget status`);
  for (const field of ['execute_ms', 'review_fix_ms']) if (field in expect) assert.strictEqual(row.budget[field], expect[field], `${label} ${field}`);
  if ('budget_reasons' in expect) assert.deepStrictEqual(row.budget.reasons, expect.budget_reasons, `${label} budget reasons`);
  for (const reason of expect.budget_reasons_include || []) assert(row.budget.reasons.includes(reason), `${label} reason ${reason} in ${row.budget.reasons}`);
  if (row.budget.status === 'unknown') assert.strictEqual(row.budget.ratio, null, `${label} unknown ratio is null, never 0`);
  if ('line' in expect) assert.strictEqual(row.line, expect.line, `${label} line`);
}
function statusOf(owner, boundary, lookup) {
  const input = boundary.boundary === 'task' ? { owner, task: boundary.task } : { owner, milestone: boundary.milestone, slice: boundary.slice };
  return policy.readStatus(input, { lookup }).rows[0];
}
function cli(args, options = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 30000, ...options });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// ── Classification ──────────────────────────────────────────────────────────
test('classification matrix: every named fixture case', () => {
  assert(CLASSIFICATION.cases.length >= 15);
  for (const kase of CLASSIFICATION.cases) {
    const result = policy.classifyFinding(kase.verdict, kase.basis);
    assert.deepStrictEqual({ fix_now: result.fix_now, admissible: result.admissible, resolved: result.resolved, reasons: result.reasons },
      kase.expect, kase.name);
    for (const reason of result.reasons) assert(policy.ITEM_REASONS.includes(reason), `${kase.name} closed reason ${reason}`);
  }
});
test('classification is pure and deterministic (frozen input, repeated output)', () => {
  const deepFreeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };
  for (const kase of CLASSIFICATION.cases) {
    const input = deepFreeze(clone(kase.verdict));
    assert.deepStrictEqual(policy.classifyFinding(input, kase.basis), policy.classifyFinding(clone(kase.verdict), kase.basis), kase.name);
  }
  assert.strictEqual(policy.classifyFinding(undefined).fix_now, false);
  assert.strictEqual(policy.classifyFinding(null, 'operator-decision').admissible, true);
});
test('itemVerdicts: closed enums, basis, sizes and legacy items fail closed or stay unknown', () => {
  const base = { r: 'R1', path: 'src/a.js', verdict: { resolution: 'conceded', severity: 'high', reachable: 'yes', in_scope: 'yes' } };
  assert.strictEqual(policy.itemVerdicts([base])[0].classification.fix_now, true);
  const legacy = policy.itemVerdicts([{ r: 'R2', path: 'src/b.js', claim: 'saída legada' }])[0];
  assert.strictEqual(legacy.basis, 'dual-verdict');
  assert.deepStrictEqual(legacy.classification.reasons, ['resolution-unknown', 'severity-unknown', 'reachable-unknown', 'scope-unknown']);
  const bad = [
    { ...base, basis: 'auto' }, { ...base, verdict: { ...base.verdict, severity: 'High' } }, { ...base, verdict: { ...base.verdict, reachable: 'maybe' } },
    { ...base, verdict: { ...base.verdict, extra: 'x' } }, { ...base, verdict: 'conceded' }, { ...base, r: 'X1' },
    { ...base, verdict: { ...base.verdict, contest: { advocate: { reachable: 'perhaps' } } } }, { ...base, verdict: { ...base.verdict, contest: { judge: {} } } },
    { ...base, review_file: '../outside.md' },
  ];
  for (const item of bad) assert.throws(() => policy.itemVerdicts([item]), e => e.code === 'review-fix-policy-invalid', JSON.stringify(item));
  assert.throws(() => policy.itemVerdicts([base, { ...base }]), e => e.code === 'review-fix-policy-invalid');
  assert.throws(() => policy.itemVerdicts(Array.from({ length: 65 }, (_, i) => ({ ...base, r: `R${i + 1}` }))), e => e.code === 'review-fix-policy-invalid');
  assert.throws(() => policy.itemVerdicts([]), e => e.code === 'review-fix-policy-invalid');
});
test('verdict and basis never enter normalizeItems, the brief or reviewFixIdentity', () => {
  const plain = [{ r: 'R1', path: 'src/a.js', claim: 'x' }];
  const withVerdict = [{ ...plain[0], basis: 'operator-decision', verdict: { resolution: 'conceded', severity: 'high', reachable: 'yes', in_scope: 'yes' } }];
  assert.deepStrictEqual(reviewFix.normalizeItems(withVerdict), reviewFix.normalizeItems(plain));
  const brief = items => reviewFix.buildBrief({ boundary: 'slice', unitLabel: 'review-fix/S01', items: reviewFix.normalizeItems(items), claimPaths: ['src/a.js'], route: ROUTE });
  assert.strictEqual(brief(withVerdict).identity, brief(plain).identity);
});

// ── Boundaries ──────────────────────────────────────────────────────────────
test('boundary keys: slice, task and milestone-triage; malformed ids refuse', () => {
  assert.strictEqual(policy.boundaryKey({ boundary: 'slice', milestone: 'M001', slice: 'S03' }), 'slice:M001:S03');
  assert.strictEqual(policy.boundaryKey({ boundary: 'task', task: 'T-20261106000000-avulsa' }), 'task:T-20261106000000-avulsa');
  assert.strictEqual(policy.boundaryKey({ boundary: 'milestone-triage', milestone: 'M001' }), 'milestone-triage:M001');
  for (const input of [{ boundary: 'slice', milestone: '../M001', slice: 'S01' }, { boundary: 'slice', milestone: 'M001', slice: 'S1/..' },
    { boundary: 'task', task: 'TASK/../x' }, { boundary: 'task', task: 'T-20261106000000-x', milestone: 'M001' }, { boundary: 'review' },
    { boundary: 'slice', milestone: 'M001' }, null]) {
    assert.throws(() => policy.boundaryKey(input), e => e.code === 'review-fix-policy-invalid', JSON.stringify(input));
  }
});

// ── Named history cases ─────────────────────────────────────────────────────
for (const kase of HISTORY.cases) {
  test(`history case: ${kase.name}`, () => withOwner(owner => {
    const { lookup, after } = materialize(owner, kase);
    if (kase.expect_before) checkStatus(statusOf(owner, kase.boundary, lookup), kase.expect_before, 'before');
    kase.steps.forEach((step, index) => {
      const eventsBefore = admissionRows(owner).length;
      const result = policy.admitCorrection(admissionInput(owner, kase.boundary, step.dispatch_id, presetItems(step.items), { now: Date.parse('2026-11-05T00:00:00.000Z') + index }), { lookup });
      const label = `step ${index + 1} ${step.dispatch_id}`, e = step.expect;
      assert.strictEqual(result.decision, e.decision, `${label} decision ${JSON.stringify(result)}`);
      assert.strictEqual(result.allowed, e.decision === 'admitted', label);
      assert.strictEqual(result.provider_called, false);
      for (const field of ['mode', 'counted', 'cycle', 'reason_code', 'event_written', 'malformed_lines']) {
        if (field in e) assert.strictEqual(result[field], e[field], `${label} ${field}`);
      }
      if (e.decision === 'refused') assert(policy.REFUSAL_CODES.includes(result.reason_code), label);
      if ('budget_status' in e) assert.strictEqual(result.budget.status, e.budget_status, `${label} budget`);
      if ('line' in e) assert.strictEqual(result.status_line, e.line, `${label} line`);
      if (e.refused_items) assert.deepStrictEqual(result.refused_items.map(r => ({ r: r.r, reasons: r.reasons })), e.refused_items, label);
      const written = admissionRows(owner).length - eventsBefore;
      assert.strictEqual(written, result.event_written ? 1 : 0, `${label} exactly one event per new decision`);
      if (step.after_minutes) after(step.dispatch_id, step.after_minutes);
    });
    if (kase.expect_status) {
      checkStatus(statusOf(owner, kase.boundary, lookup), kase.expect_status, 'after');
      if ('admission_events' in kase.expect_status) assert.strictEqual(admissionRows(owner).length, kase.expect_status.admission_events);
    }
  }));
}

// ── Events, replay, recovery and isolation ──────────────────────────────────
const SLICE = { boundary: 'slice', milestone: 'M001', slice: 'S01' };
const EVENT_KEYS = ['ts', 'event', 'policy_version', 'identity', 'correction_identity', 'boundary', 'boundary_key', 'milestone', 'slice', 'task',
  'dispatch_id', 'brief_identity', 'decision', 'reason_code', 'counted', 'cycle', 'cycle_limit', 'budget', 'items', 'refused_items'];
test('admission event: closed bounded fields, no absolute path, claim or item text', () => withOwner(owner => {
  const items = [...presetItems(['fix-now']), { ...presetItems(['medium'])[0], claim: 'SEGREDO-DO-ITEM C:\\Users\\alguem' }];
  const refused = policy.admitCorrection(admissionInput(owner, SLICE, 'rf-ev1', items));
  assert.strictEqual(refused.reason_code, 'review-fix-not-fix-now');
  const admitted = policy.admitCorrection(admissionInput(owner, SLICE, 'rf-ev2', presetItems(['fix-now'])));
  assert.strictEqual(admitted.cycle, 1);
  const lines = fs.readFileSync(ownerEvents(owner), 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 2);
  for (const line of lines) {
    const row = JSON.parse(line);
    assert(Object.keys(row).every(key => EVENT_KEYS.includes(key)), `closed keys ${Object.keys(row)}`);
    assert.deepStrictEqual(Object.keys(row.budget).sort(), ['execute_ms', 'limit', 'ratio', 'reasons', 'review_fix_ms', 'status']);
    for (const item of row.items) assert(Object.keys(item).every(key => ['r', 'review_file', 'basis', 'fix_now', 'reasons'].includes(key)));
    assert(!line.includes(owner) && !line.includes(owner.replace(/\\/g, '\\\\')), 'no absolute owner path');
    assert(!/SEGREDO|src\/a\.js|src\/b\.js|claim|falha real/.test(line), 'no claim, path or item text');
    assert.strictEqual(row.policy_version, policy.POLICY_VERSION);
    assert.strictEqual(row.cycle_limit, policy.CYCLE_LIMIT);
  }
  assert.deepStrictEqual(JSON.parse(lines[0]).refused_items, [{ r: 'R2', reasons: ['severity-below-high'] }]);
}));
test('replay of the same identity returns the recorded decision without a new event; findAdmission serves it', () => withOwner(owner => {
  const input = admissionInput(owner, SLICE, 'rf-r1', presetItems(['fix-now']));
  const first = policy.admitCorrection(input);
  const second = policy.admitCorrection(clone(input));
  assert.strictEqual(first.mode, 'new'); assert.strictEqual(second.mode, 'replay');
  assert.strictEqual(second.cycle, 1); assert.strictEqual(second.identity, first.identity);
  assert.strictEqual(admissionRows(owner).length, 1);
  const found = policy.findAdmission({ owner, ...SLICE, dispatch_id: 'rf-r1', brief_identity: input.brief.identity });
  assert.strictEqual(found.identity, first.identity); assert.strictEqual(found.decision, 'admitted');
  assert.deepStrictEqual(policy.findAdmission({ owner, ...SLICE, identity: first.identity }), found);
  assert.strictEqual(policy.findAdmission({ owner, ...SLICE, dispatch_id: 'rf-other', brief_identity: input.brief.identity }), null);
  const refused = policy.admitCorrection(admissionInput(owner, SLICE, 'rf-r2', presetItems(['medium'])));
  assert.strictEqual(policy.findAdmission({ owner, ...SLICE, identity: refused.identity }), null, 'refusals are never an admission');
}));
test('recovery: valid parent returns its decision without cycle or event; unknown or mismatched parents refuse', () => withOwner(owner => {
  const items = presetItems(['fix-now']);
  const parent = policy.admitCorrection(admissionInput(owner, SLICE, 'rf-p1', items));
  const child = recoveryDispatchId('rf-p1', 'c1');
  const before = admissionRows(owner).length;
  // The successor may change route; the correction identity is route-free.
  const recovered = policy.admitCorrection(admissionInput(owner, SLICE, child, clone(items), { recovery_of: 'rf-p1', route: { ...ROUTE, model: 'claude-sonnet-5' } }));
  assert.strictEqual(recovered.mode, 'recovery'); assert.strictEqual(recovered.counted, false); assert.strictEqual(recovered.cycle, parent.cycle);
  assert.strictEqual(admissionRows(owner).length, before, 'recovery writes no event');
  const grandchild = recoveryDispatchId(child, 'c2');
  assert.strictEqual(policy.admitCorrection(admissionInput(owner, SLICE, grandchild, clone(items), { recovery_of: child })).mode, 'recovery');
  const longParent = 'rf-' + 'x'.repeat(120);
  policy.admitCorrection(admissionInput(owner, SLICE, longParent, clone(items)));
  assert.strictEqual(policy.admitCorrection(admissionInput(owner, SLICE, recoveryDispatchId(longParent, 'c3'), clone(items), { recovery_of: longParent })).mode, 'recovery');
  const status = statusOf(owner, SLICE);
  assert.strictEqual(status.cycles, 2, 'recoveries never consumed a cycle');
  const unknown = policy.admitCorrection(admissionInput(owner, SLICE, recoveryDispatchId('rf-ghost', 'c4'), clone(items), { recovery_of: 'rf-ghost' }));
  assert.strictEqual(unknown.reason_code, 'review-fix-policy-invalid'); assert.strictEqual(unknown.detail, 'recovery-parent-unknown');
  const mismatch = policy.admitCorrection(admissionInput(owner, SLICE, recoveryDispatchId('rf-p1', 'c5'), presetItems(['critical']), { recovery_of: 'rf-p1' }));
  assert.strictEqual(mismatch.detail, 'recovery-correction-mismatch');
  const unbound = policy.admitCorrection(admissionInput(owner, SLICE, 'rf-not-a-successor', clone(items), { recovery_of: 'rf-p1' }));
  assert.strictEqual(unbound.reason_code, 'review-fix-policy-invalid');
  assert.strictEqual(statusOf(owner, SLICE).cycles, 2);
}));
test('recovery of a legacy dispatch of the same boundary is valid and consumes nothing', () => withOwner(owner => {
  materialize(owner, { boundary: SLICE, legacy: [{ dispatch_id: 'legacy-9', minutes: 5 }] });
  const result = policy.admitCorrection(admissionInput(owner, SLICE, recoveryDispatchId('legacy-9', 'c1'), presetItems(['fix-now']), { recovery_of: 'legacy-9' }));
  assert.strictEqual(result.mode, 'recovery'); assert.strictEqual(result.event_written, false);
  assert.strictEqual(statusOf(owner, SLICE).cycles, 1);
}));
test('isolation by physical owner: another owner keeps its own count', () => withOwner(a => withOwner(b => {
  for (const id of ['rf-1', 'rf-2']) assert(policy.admitCorrection(admissionInput(a, SLICE, id, presetItems(['fix-now']))).allowed);
  assert.strictEqual(policy.admitCorrection(admissionInput(a, SLICE, 'rf-3', presetItems(['fix-now']))).reason_code, 'review-fix-cycle-limit');
  const other = policy.admitCorrection(admissionInput(b, SLICE, 'rf-3', presetItems(['fix-now'])));
  assert.strictEqual(other.cycle, 1); assert.strictEqual(other.allowed, true);
  const task = { boundary: 'task', task: 'T-20261106000000-avulsa' };
  assert.strictEqual(policy.admitCorrection(admissionInput(a, task, 'rf-t1', presetItems(['fix-now']))).cycle, 1, 'task boundary is independent of the slice');
})));
test('invalid input and unreadable history refuse review-fix-policy-invalid before any counting', () => withOwner(owner => {
  const good = admissionInput(owner, SLICE, 'rf-ok', presetItems(['fix-now']));
  const cases = [
    [{ ...good, dispatch_id: '../bad id' }, false], [{ ...good, boundary: 'review' }, false], [{ ...good, owner: path.join(owner, 'absent') }, false],
    [{ ...good, items: [{ ...good.items[0], basis: 'auto-fix' }] }, true], [{ ...good, items: presetItems(['critical']) }, true],
    [{ ...good, brief: { ...good.brief, identity: 'nope' } }, true], [{ ...good, brief: { ...good.brief, unit_label: 'review-fix/S02' } }, true],
    [{ ...good, recovery_of: 'bad id!' }, true],
  ];
  for (const [input, recorded] of cases) {
    const before = admissionRows(owner).length;
    const result = policy.admitCorrection(input);
    assert.strictEqual(result.reason_code, 'review-fix-policy-invalid', JSON.stringify(result));
    assert.strictEqual(result.allowed, false); assert.strictEqual(result.counted, false);
    assert.strictEqual(admissionRows(owner).length - before, recorded ? 1 : 0, 'named refusal recorded when the boundary is attributable');
  }
  assert.strictEqual(policy.admitCorrection(good).cycle, 1, 'refusals consumed nothing');
}));
test('owner history above the named 16 MiB bound or with a damaged admission record fails closed', () => {
  withOwner(owner => {
    fs.writeFileSync(ownerEvents(owner), Buffer.alloc(policy.MAX_OWNER_EVENTS_BYTES + 1, 0x0a));
    const result = policy.admitCorrection(admissionInput(owner, SLICE, 'rf-big', presetItems(['fix-now'])));
    assert.strictEqual(result.reason_code, 'review-fix-policy-invalid'); assert.strictEqual(result.detail, 'history-oversized');
    const status = statusOf(owner, SLICE);
    assert.strictEqual(status.history, 'unknown'); assert.strictEqual(status.cycles, null);
    assert.strictEqual(status.budget.status, 'unknown'); assert.deepStrictEqual(status.budget.reasons, ['history-oversized']);
    assert(status.line.includes('ciclo desconhecido/2'));
  });
  withOwner(owner => {
    appendRows(ownerEvents(owner), [{ event: policy.ADMISSION_EVENT, boundary_key: 'slice:M001:S01', decision: 'admitted', identity: 'x' }]);
    const result = policy.admitCorrection(admissionInput(owner, SLICE, 'rf-dmg', presetItems(['fix-now'])));
    assert.strictEqual(result.detail, 'admission-record-invalid');
  });
});
test('admission runs under the canonical owner lock and never admits when the lock is unavailable', () => withOwner(owner => {
  const original = reconciliation.withOwnerLock, calls = [];
  reconciliation.withOwnerLock = (root, fn, guard) => { calls.push(root); return original(root, fn, guard); };
  try { assert(policy.admitCorrection(admissionInput(owner, SLICE, 'rf-l1', presetItems(['fix-now']))).allowed); }
  finally { reconciliation.withOwnerLock = original; }
  assert.deepStrictEqual(calls, [owner], 'one lock around read, decision and append');
  reconciliation.withOwnerLock = () => { throw Object.assign(new Error('busy'), { code: 'LOCK_BUSY' }); };
  let blocked;
  try { blocked = policy.admitCorrection(admissionInput(owner, SLICE, 'rf-l2', presetItems(['fix-now']))); }
  finally { reconciliation.withOwnerLock = original; }
  assert.strictEqual(blocked.allowed, false); assert.strictEqual(blocked.reason_code, 'review-fix-policy-invalid');
  assert.strictEqual(blocked.event_written, false);
  assert.strictEqual(statusOf(owner, SLICE).cycles, 1);
}));

// ── Real controller records (injected clock) ────────────────────────────────
test('budget from real controller begin/complete records: slice attribution, repeated T01 isolated', () => withOwner(owner => {
  const controller = require('./forge-unit-controller'), state = require('./forge-state');
  const M = 'M001', base = Date.parse('2026-11-04T01:12:00.000Z');
  fs.mkdirSync(path.join(owner, '.gsd', 'milestones', M), { recursive: true });
  state.write(owner, { milestone: M, kind: 'milestone', phase: 'idle', active_slice: 'S01', active_task: '—', auto_mode: 'on', created: iso(base), heartbeat: iso(base) });
  let at = base;
  const options = { now: () => at, prefsReader: () => ({ ok: true, prefs: {} }), inventoryReader: () => ({ slices: [] }) };
  const run = (slice, minutes) => {
    const unit = 'execute-task/T01', key = `forge-orchestrate-next:${M}:${unit}:${slice}`;
    const begun = controller.begin(owner, { milestone: M, unit, slice, host_runtime: 'claude', owner_token: 'fixture-owner',
      idempotency_key: key, state_patch: { active_slice: slice } }, options);
    assert(begun.ok, JSON.stringify(begun));
    at += minutes * MIN;
    controller.complete(owner, { milestone: M, unit, host_runtime: 'claude', owner_token: 'fixture-owner', generation: begun.generation,
      idempotency_key: `complete:${key}`, result: { status: 'succeeded' } }, options);
    at += MIN;
  };
  run('S01', 90); run('S02', 30);
  const s01 = statusOf(owner, SLICE), s02 = statusOf(owner, { ...SLICE, slice: 'S02' });
  assert.strictEqual(s01.budget.execute_ms, 90 * MIN, JSON.stringify(s01.budget));
  assert.strictEqual(s02.budget.execute_ms, 30 * MIN, 'the same T01 label in S02 is attributed to S02 only');
  materialize(owner, { boundary: SLICE, legacy: [{ dispatch_id: 'legacy-1', minutes: 45 }] });
  const refused = policy.admitCorrection(admissionInput(owner, SLICE, 'rf-real', presetItems(['fix-now'])));
  assert.strictEqual(refused.reason_code, 'review-fix-budget-exhausted', JSON.stringify(refused.budget));
  assert.strictEqual(refused.status_line, '⚖ Review S01: ciclo 1/2 · review-fix 45 min / execute 1 h 30 min (50%)');
}));

// ── Status, durations and CLI ───────────────────────────────────────────────
test('durations and status line in pt-BR; unknown never renders as zero', () => {
  assert.strictEqual(policy.formatDuration(45 * MIN), '45 min');
  assert.strictEqual(policy.formatDuration(90 * MIN), '1 h 30 min');
  assert.strictEqual(policy.formatDuration(24 * 60 * MIN), '24 h');
  assert.strictEqual(policy.formatDuration(0), '0 min');
  assert.strictEqual(policy.formatDuration(10000), '<1 min');
  assert.strictEqual(policy.formatDuration(null), 'desconhecido');
  assert.strictEqual(policy.renderStatusLine({ label: 'S02', cycles: 0, budget: { status: 'unknown', execute_ms: null, review_fix_ms: 0, ratio: null } }),
    '⚖ Review S02: ciclo 0/2 · review-fix 0 min / execute desconhecido (desconhecido)');
});
test('CLI --status: slice, milestone listing, task and --json; incident shows ciclo 25/2 above 50%', () => withOwner(owner => {
  const incident = HISTORY.cases.find(k => k.name.startsWith('incidente'));
  const M = incident.boundary.milestone;
  materialize(owner, { ...incident, execute: [] });
  materialize(owner, { boundary: { boundary: 'task', task: 'T-20261106000000-avulsa' }, legacy: [{ dispatch_id: 'task-1', minutes: 20, unit: 'review-fix/T-20261106000000-avulsa', milestone: null }] });
  const slice = cli(['--status', '--cwd', owner, '--milestone', M, '--slice', 'S03']);
  assert.strictEqual(slice.status, 0, slice.stderr);
  assert.strictEqual(slice.stdout, '⚖ Review S03: ciclo 25/2 · review-fix 24 h / execute desconhecido (desconhecido)\n');
  const json = cli(['--status', '--cwd', owner, '--milestone', M, '--json']);
  const parsed = JSON.parse(json.stdout);
  assert.strictEqual(json.stdout.trim().split('\n').length, 1, 'single JSON');
  assert.strictEqual(parsed.rows.length, 1); assert.strictEqual(parsed.rows[0].cycles, 25);
  assert.strictEqual(parsed.rows[0].budget.ratio, null); assert(parsed.rows[0].budget.reasons.includes('execute-unobserved'));
  assert(!json.stdout.includes(owner.replace(/\\/g, '\\\\')), 'no absolute owner path');
  const task = cli(['--status', '--cwd', owner, '--task', 'T-20261106000000-avulsa']);
  assert.strictEqual(task.stdout, '⚖ Review T-20261106000000-avulsa: ciclo 1/2 · review-fix 20 min / execute desconhecido (desconhecido)\n');
  for (const args of [['--status', '--cwd', owner], ['--status', '--cwd', owner, '--task', 'T-20261106000000-x', '--milestone', M],
    ['--status', '--cwd', owner, '--milestone', '../x'], ['--bogus'], [], ['--status', '--status']]) {
    const bad = cli(args);
    assert.strictEqual(bad.status, 2, args.join(' ')); assert.strictEqual(bad.stdout, '');
  }
}));
test('CLI --status measures the incident with a real execute interval (ratio above 50%)', () => withOwner(owner => {
  const incident = HISTORY.cases.find(k => k.name.startsWith('incidente'));
  const { lookup } = materialize(owner, incident);
  const row = statusOf(owner, incident.boundary, lookup);
  assert.strictEqual(row.line, '⚖ Review S03: ciclo 25/2 · review-fix 24 h / execute 1 h 30 min (1600%)');
  assert(row.budget.ratio > policy.BUDGET_RATIO);
}));
test('CLI --classify returns the classification; unreadable input exits 2', () => withOwner(owner => {
  const input = path.join(owner, 'items.json');
  fs.writeFileSync(input, JSON.stringify({ items: presetItems(['fix-now', 'medium', 'operator']) }));
  const out = cli(['--classify', '--input', input]);
  assert.strictEqual(out.status, 0, out.stderr);
  const parsed = JSON.parse(out.stdout);
  assert.deepStrictEqual(parsed.items.map(i => [i.r, i.fix_now, i.admissible]), [['R1', true, true], ['R2', false, false], ['R5', false, true]]);
  fs.writeFileSync(input, '{not json');
  assert.strictEqual(cli(['--classify', '--input', input]).status, 2);
  fs.writeFileSync(input, JSON.stringify({ items: [{ r: 'R1', basis: 'whatever' }] }));
  assert.strictEqual(cli(['--classify', '--input', input]).status, 2);
  assert.strictEqual(cli(['--classify']).status, 2);
}));
test('CLI --admit with the native request: exit 0 admitted, 3 refused, 2 usage; one JSON on stdout', () => withOwner(owner => {
  const request = id => ({ cwd: owner, contextRoot: owner, scope: 'milestone', milestoneId: 'M001', sliceId: 'S01', unitType: 'review-fix', dispatchId: id,
    workflowId: 'wf', route: ROUTE, reviewFix: { boundary: 'slice', decision: 'proceed', items: presetItems(['fix-now']), claimPaths: ['src/a.js'] } });
  const file = path.join(owner, 'request.json');
  const run = id => { fs.writeFileSync(file, JSON.stringify(request(id))); return cli(['--admit', '--request', file]); };
  for (const [id, cycle] of [['rf-cli-1', 1], ['rf-cli-2', 2]]) {
    const ok = run(id);
    assert.strictEqual(ok.status, 0, ok.stderr);
    const parsed = JSON.parse(ok.stdout);
    assert.strictEqual(parsed.cycle, cycle); assert.strictEqual(parsed.allowed, true);
  }
  const refused = run('rf-cli-3');
  assert.strictEqual(refused.status, 3); assert.strictEqual(refused.stdout.trim().split('\n').length, 1);
  assert.strictEqual(JSON.parse(refused.stdout).reason_code, 'review-fix-cycle-limit');
  assert(/review-fix-cycle-limit/.test(refused.stderr) && !refused.stderr.includes(owner) && !/at .*\.js:\d+/.test(refused.stderr), 'named reason, no path or stack');
  const replay = run('rf-cli-1');
  assert.strictEqual(replay.status, 0); assert.strictEqual(JSON.parse(replay.stdout).mode, 'replay');
  fs.writeFileSync(file, JSON.stringify({ ...request('rf-cli-4'), reviewFix: { boundary: 'slice', items: [{ ...presetItems(['fix-now'])[0], basis: 'auto' }] } }));
  const bad = cli(['--admit', '--request', file]);
  assert.strictEqual(bad.status, 3); assert.strictEqual(JSON.parse(bad.stdout).reason_code, 'review-fix-policy-invalid');
  assert.strictEqual(cli(['--admit']).status, 2);
  assert.strictEqual(cli(['--admit', '--request', path.join(owner, 'missing.json')]).status, 2);
}));

// ── Review-leg guard ────────────────────────────────────────────────────────
function legThrows(input, code) {
  let error;
  try { policy.assertReviewLeg(input); } catch (e) { error = e; }
  assert(error, `expected ${code}`);
  assert.strictEqual(error.code, code); assert.strictEqual(error.provider_called, false);
  assert.strictEqual(error.stage, 'review-policy'); assert.strictEqual(error.layer, 'review-policy');
  return error;
}
test('review-leg guard: only milestone context acts; per-task refused unless the opt-in pref is true', () => withOwner(owner => {
  const off = () => ({ ok: true, prefs: { review: { milestone_task_review: false } } });
  const on = () => ({ ok: true, prefs: { review: { milestone_task_review: true } } });
  assert.strictEqual(policy.assertReviewLeg({}).status, 'not-applicable');
  assert.strictEqual(policy.assertReviewLeg({ mode: 'challenge' }).status, 'not-applicable');
  assert.strictEqual(policy.assertReviewLeg({ mode: 'challenge', context: { cwd: owner, task: 'T-20261106000000-avulsa', unit: 'execute-task/T-20261106000000-avulsa' } }).status, 'not-applicable');
  assert.strictEqual(policy.assertReviewLeg({ agentType: 'forge-executor', context: { cwd: owner, milestone: 'M001', unit: 'execute-task/T03' } }).status, 'not-applicable');
  const error = legThrows({ mode: 'challenge', context: { cwd: owner, milestone: 'M001', unit: 'execute-task/T03' }, prefsReader: off, now: Date.parse('2026-11-06T00:00:00.000Z') }, 'review-per-task-in-milestone');
  assert.strictEqual(error.details.event_written, true);
  const rows = readRows(owner).filter(row => row.event === policy.LEG_REFUSAL_EVENT);
  assert.deepStrictEqual(rows, [{ ts: '2026-11-06T00:00:00.000Z', event: 'review-leg-refusal', reason_code: 'review-per-task-in-milestone', milestone: 'M001', unit: 'execute-task/T03', leg: 'challenge' }]);
  for (const agentType of policy.REVIEW_LEG_AGENTS) legThrows({ agentType, context: { cwd: owner, milestone: 'M001', unit: 'execute-task/T03' }, prefsReader: off, record: false }, 'review-per-task-in-milestone');
  legThrows({ mode: 'defend', context: { cwd: owner, milestone: 'M001', unit: 'execute-task/T03' }, prefsReader: () => ({ ok: false, prefs: { review: { milestone_task_review: true } } }), record: false }, 'review-per-task-in-milestone');
  assert.strictEqual(policy.assertReviewLeg({ mode: 'rebuttal', context: { cwd: owner, milestone: 'M001', unit: 'execute-task/T03' }, prefsReader: on }).status, 'allowed');
  assert.strictEqual(readRows(owner).filter(row => row.event === policy.LEG_REFUSAL_EVENT).length, 1, 'record:false and allowed legs write nothing');
  legThrows({ mode: 'challenge', context: { cwd: owner, milestone: '../x', unit: 'complete-slice/S01' } }, 'review-fix-policy-invalid');
}));
test('review-leg guard: complete-slice reviews once; retry before completion passes', () => withOwner(owner => {
  const context = { cwd: owner, milestone: 'M001', unit: 'complete-slice/S01' };
  for (const mode of ['challenge', 'challenge', 'defend', 'rebuttal']) assert.strictEqual(policy.assertReviewLeg({ mode, context }).status, 'allowed');
  const review = path.join(owner, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'S01-REVIEW.md');
  fs.mkdirSync(path.dirname(review), { recursive: true }); fs.writeFileSync(review, '# Review\n');
  legThrows({ mode: 'challenge', context }, 'review-already-completed');
  fs.rmSync(review);
  appendRows(ownerEvents(owner), [{ ts: '2026-11-06T00:00:00.000Z', event: 'review', milestone: 'M001', slice: 'S02', style: 'dialectic' }]);
  assert.strictEqual(policy.assertReviewLeg({ mode: 'challenge', context }).status, 'allowed', 'another slice review does not close S01');
  appendRows(ownerEvents(owner), [{ ts: '2026-11-06T00:01:00.000Z', event: 'review', milestone: 'M001', slice: 'S01', style: 'dialectic' }]);
  legThrows({ mode: 'defend', context }, 'review-already-completed');
  assert.strictEqual(policy.assertReviewLeg({ mode: 'challenge', context: { ...context, milestone: 'M002' } }).status, 'allowed', 'same S01 in another milestone');
}));

// ── Contract surface and declared artifacts ─────────────────────────────────
test('exported constants and API follow the S01 contract', () => {
  assert.strictEqual(policy.POLICY_VERSION, 'review-fix-policy-v1');
  assert.strictEqual(policy.CYCLE_LIMIT, 2); assert.strictEqual(policy.BUDGET_RATIO, 0.5);
  assert.strictEqual(policy.ADMISSION_EVENT, 'review-fix-admission'); assert.strictEqual(policy.LEG_REFUSAL_EVENT, 'review-leg-refusal');
  assert.deepStrictEqual([...policy.REFUSAL_CODES], ['review-fix-cycle-limit', 'review-fix-budget-exhausted', 'review-fix-not-fix-now', 'review-fix-policy-invalid']);
  assert.deepStrictEqual([...policy.REVIEW_LEG_CODES], ['review-per-task-in-milestone', 'review-already-completed']);
  assert.deepStrictEqual([...policy.REVIEW_LEG_AGENTS], ['forge-reviewer', 'forge-advocate']);
  assert.deepStrictEqual([...policy.TRISTATE], ['yes', 'no', 'unknown']); assert.deepStrictEqual([...policy.BASES], ['dual-verdict', 'operator-decision']);
  assert.strictEqual(policy.MAX_OWNER_EVENTS_BYTES, 16 * 1024 * 1024);
  for (const name of ['classifyFinding', 'itemVerdicts', 'boundaryKey', 'readHistory', 'decideAdmission', 'admitCorrection', 'findAdmission',
    'readStatus', 'renderStatusLine', 'assertReviewLeg', 'main']) assert.strictEqual(typeof policy[name], 'function', name);
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert(source.indexOf('module.exports') < source.indexOf('if (require.main === module)'), 'exports before the CLI guard');
  for (const link of ['./forge-phase-cost', './forge-unit-controller', './forge-autonomy-sources', './forge-artifact-reconciliation', './forge-prefs', './forge-review-fix']) {
    assert(source.includes(`require('${link}')`), `key link ${link}`);
  }
  for (const name of ['analyzeEventIntervals', 'lookupRecord', 'readBoundedStableFile', 'withOwnerLock', 'readPrefs', 'normalizeItems', 'deriveClaim', 'buildBrief']) {
    assert(source.includes(name), `reuses ${name}`);
  }
});
test('decideAdmission is pure: same context and history give the same decision', () => {
  const ctx = { scope: { boundary: 'slice', key: 'slice:M001:S01' }, identity: 'a'.repeat(64), correction_identity: 'b'.repeat(64), dispatch_id: 'rf-1', recovery_of: null,
    verdicts: policy.itemVerdicts(presetItems(['fix-now'])) };
  const history = { status: 'valid', admitted: [], consumed: 1, legacy: { dispatch_ids: [] }, budget: { status: 'complete', ratio: 0.2 } };
  const frozen = JSON.stringify(history);
  assert.deepStrictEqual(policy.decideAdmission(ctx, history), policy.decideAdmission(ctx, history));
  assert.strictEqual(JSON.stringify(history), frozen, 'history untouched');
  assert.strictEqual(policy.decideAdmission(ctx, { ...history, consumed: 2 }).reason_code, 'review-fix-cycle-limit');
  assert.strictEqual(policy.decideAdmission(ctx, { ...history, budget: { status: 'complete', ratio: 0.5 } }).reason_code, 'review-fix-budget-exhausted');
  assert.strictEqual(policy.decideAdmission(ctx, { ...history, budget: { status: 'unknown', ratio: null } }).cycle, 2);
  assert.strictEqual(policy.decideAdmission(ctx, { status: 'invalid', reason: 'history-oversized' }).reason_code, 'review-fix-policy-invalid');
});
test('declared artifacts are substantive', () => {
  const stubs = ['TO' + 'DO', 'T' + 'BD', 'FIX' + 'ME', 'PLACE' + 'HOLDER', 'not ' + 'implemented'];
  for (const [file, minimum] of [['forge-review-policy.js', 300], ['forge-review-policy.test.js', 350],
    ['fixtures/review-policy/classification-cases.json', 60], ['fixtures/review-policy/history-cases.json', 80]]) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert(source.split('\n').length >= minimum, `${file} has at least ${minimum} lines`);
    for (const stub of stubs) assert(!source.includes(stub), `${file} has no ${stub}`);
  }
});

console.log(`\nforge-review-policy: ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exitCode = 1;
