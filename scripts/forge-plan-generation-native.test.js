#!/usr/bin/env node
'use strict';

// forge-plan-generation-native.test.js — issue 343 U0d: strict admission of a newly
// generated slice plan at the NATIVE controller boundary (forge-unit-controller), through
// the real public chain loop -> orchestrate -> controller and through controller.complete
// called directly.
//
//   U0d-1 the native flow with interactive off cannot complete an invalid plan-slice or
//         reach the first executor;
//   U0d-2 a direct controller.complete refuses the same way; the lease stays recoverable
//         and a corrected plan completes under the same request;
//   U0d-3 the enrollment survives reentry and continuation and cannot be skipped by
//         plan_exists or imported flags;
//   U0d-4 failpoints around validation and publication replay from the saved evidence;
//         historical transactions stay byte-identical;
//   U0d-5 the first execute begin refuses semantic drift and accepts checkbox and
//         repair_count edits.
//
// Every record is produced by the real controller (begin, complete, pause, fail, consume
// and reenter); nothing attaches evidence after a commit. The only rewritten records are
// the deliberately labelled synthetic pre-requirement begins and the named forgeries.
// Everything is synthetic and local: no provider, network or operator history.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const loop = require('./forge-loop-controller');
const controller = require('./forge-unit-controller');
const state = require('./forge-state');
const lease = require('./forge-unit-lease');
const repair = require('./forge-repair');
const pv = require('./forge-plan-validation');

const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-plan-generation-native-')));
const M = 'M-20261108000000-native-plan';
const S = 'S01';
const HOST = 'claude';
const PLAN_UNIT = `plan-slice/${S}`;
const TASK_UNIT = 'execute-task/T01';
// Interactive off: the gate never reads a plan-gate preference, ask_in_auto or a checker verdict.
const PREFS = { workflow: { skip_discuss: true, skip_research: true }, plan_gate: { interactive: false, ask_in_auto: false } };
const prefsReader = () => ({ ok: true, prefs: PREFS });
const deps = { prefsReader };

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${error && error.stack ? error.stack : error}`);
  }
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
// The controller's record checksum (sha256 of the sorted-key JSON), used only to recompose a
// deliberate self-consistent forgery.
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}
function checksum(value) { return sha(JSON.stringify(stable(value))); }
function refuses(fn, code, label) {
  let caught = null;
  let value;
  try { value = fn(); } catch (error) { caught = error; }
  assert(caught, `${label}: expected ${code}, got ${JSON.stringify(value)}`);
  assert.strictEqual(caught.code, code, `${label}: ${caught && caught.message}`);
  return caught;
}
function exists(file) { return fs.existsSync(file); }
function bytesOf(file) { return exists(file) ? sha(fs.readFileSync(file)) : null; }
function held(dir, unit) { return lease.observe(dir, unit).lease; }
function recordFile(dir, key) { return controller.transactionFile(dir, key); }
function eventsOf(dir, milestone = M) { return controller.readEvents(controller.eventsFile(dir, milestone)); }

// ── Synthetic plans ───────────────────────────────────────────────────────────

// A new task plan with the structured must_haves the strict product parser admits.
// `depends` is the frontmatter line (null omits it); `writes: null` omits the writes key.
function taskPlan(id, options = {}) {
  const file = options.file || `src/${id.toLowerCase().replace('.', '-')}.js`;
  const lines = ['---', 'tier: standard'];
  if (options.depends !== null) lines.push(options.depends || 'depends: []');
  if (options.writes !== null) lines.push('writes:', `  - "${file}"`);
  lines.push('must_haves:', '  truths:', `    - "${id} fixture behavior is observable"`, '  artifacts:', `    - path: "${file}"`,
    '      provides: "fixture module"', '      min_lines: 1', '  key_links: []', 'expected_output:', `  - ${file}`,
    '---', '', `# ${id}: Fixture task`, '', 'Prose never counts as a declaration.', '');
  return lines.join('\n');
}
// The S-plan task list in the forge-status parsePlanTasks grammar.
function slicePlan(ids, slice = S) {
  return [`# ${slice}: Fixture slice`, '', '## Tasks', '', ...ids.map(id => `- [ ] **${id}**: ${id} fixture task`), '', 'Slice prose.', ''].join('\n');
}
const VALID = () => ({ T01: taskPlan('T01'), T02: taskPlan('T02', { depends: 'depends: [T01]' }) });
const MISSING_DEPENDS = () => ({ T01: taskPlan('T01'), T02: taskPlan('T02', { depends: null }) });
const MISSING_WRITES = () => ({ T01: taskPlan('T01', { writes: null }), T02: taskPlan('T02', { depends: 'depends: [T01]' }) });
const CYCLE = () => ({ T01: taskPlan('T01', { depends: 'depends: [T02]' }), T02: taskPlan('T02', { depends: 'depends: [T01]' }) });

// ── Owner fixtures ────────────────────────────────────────────────────────────

let sequence = 0;
function owner(label) {
  const dir = path.join(TMP, `${label}-${++sequence}`);
  fs.mkdirSync(path.join(dir, '.gsd', 'milestones', M), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gsd', 'milestones', M, `${M}-ROADMAP.md`), `# Roadmap\n\n- [ ] **${S}: Work** \`depends:[]\`\n`);
  state.write(dir, { milestone: M, kind: 'milestone', phase: 'idle', active_slice: '—', active_task: '—', next_action: 'plan', auto_mode: 'on' });
  return dir;
}
function sliceDir(dir, milestone = M, slice = S) { return path.join(dir, '.gsd', 'milestones', milestone, 'slices', slice); }
function sliceFile(dir, milestone = M, slice = S) { return path.join(sliceDir(dir, milestone, slice), `${slice}-PLAN.md`); }
function taskFile(dir, id, milestone = M, slice = S) { return path.join(sliceDir(dir, milestone, slice), 'tasks', id, `${id}-PLAN.md`); }
// Writes exactly these owner plan files (the worker's output); `listed` defaults to the task set.
function writePlan(dir, tasks, options = {}) {
  const milestone = options.milestone || M, slice = options.slice || S;
  fs.rmSync(sliceDir(dir, milestone, slice), { recursive: true, force: true });
  fs.mkdirSync(sliceDir(dir, milestone, slice), { recursive: true });
  fs.writeFileSync(sliceFile(dir, milestone, slice), slicePlan(options.listed || Object.keys(tasks), slice));
  for (const [id, content] of Object.entries(tasks)) {
    fs.mkdirSync(path.dirname(taskFile(dir, id, milestone, slice)), { recursive: true });
    fs.writeFileSync(taskFile(dir, id, milestone, slice), content);
  }
}
function beginPlan(dir, key, ownerToken) {
  const begun = controller.begin(dir, { milestone: M, unit: PLAN_UNIT, slice: S, state_patch: { active_slice: S }, host_runtime: HOST,
    owner_token: ownerToken, session: 'session-neutral', idempotency_key: key }, { prefsReader });
  assert.strictEqual(begun.ok, true, JSON.stringify(begun));
  return begun;
}
function transitionPlan(dir, begun, action, key, result, options = {}) {
  return controller.transition(dir, { action, milestone: M, unit: PLAN_UNIT, host_runtime: HOST, owner_token: begun.owner_token,
    generation: begun.generation, idempotency_key: key, result }, { prefsReader, ...options });
}
function completePlan(dir, begun, key, result = { status: 'succeeded', summary: 'planned' }, options) {
  return transitionPlan(dir, begun, 'complete', key, result, options);
}
function beginExecute(dir, key, ownerToken = 'owner-u0d-executor') {
  return controller.begin(dir, { milestone: M, unit: TASK_UNIT, slice: S, state_patch: { active_slice: S }, host_runtime: HOST,
    owner_token: ownerToken, session: 'session-neutral', idempotency_key: key }, { prefsReader });
}
// What a refused completion must leave untouched.
function observe(dir, keys) {
  return { events: bytesOf(controller.eventsFile(dir, M)), state: bytesOf(state.statePath(dir, M)),
    boundary: bytesOf(controller.boundaryFile(dir, PLAN_UNIT)), records: keys.map(key => exists(recordFile(dir, key))) };
}
function assertPlanRefusal(error, code, stage, label) {
  assert.strictEqual(error.code, code, `${label}: ${error.message}`);
  assert(error.details && error.details.plan_generation, `${label}: a closed plan_generation diagnostic`);
  assert.deepStrictEqual([error.details.plan_generation.stage, error.details.plan_generation.code], [stage, code], label);
}
// A synthetic PRE-REQUIREMENT begin: the same committed begin with its enrollment removed,
// exactly as a begin recorded before issue 343 U0d looks. Labelled; never a real history.
function asPreRequirementBegin(dir, key) {
  const record = controller.lookupRecord(dir, 'transaction', key);
  assert(Object.hasOwn(record, 'plan_generation'), 'the real begin was enrolled');
  const { plan_generation: _enrollment, ...historical } = record;
  controller.writeAtomic(recordFile(dir, key), historical);
  assert(!Object.hasOwn(controller.lookupRecord(dir, 'transaction', key), 'plan_generation'));
}
// A fresh process resumes one uncommitted transaction from its durable record alone.
function freshResume(dir, key, begun) {
  const script = [
    'const controller = require(process.argv[1]);',
    'const out = controller.resume(process.argv[2], { idempotency_key: process.argv[3], owner_token: process.argv[4], generation: process.argv[5] },',
    '  { prefsReader: () => ({ ok: true, prefs: {} }) });',
    'process.stdout.write(JSON.stringify(out));',
  ].join('\n');
  const child = spawnSync(process.execPath, ['-e', script, path.join(__dirname, 'forge-unit-controller.js'), dir, key, begun.owner_token, begun.generation],
    { encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.strictEqual(child.status, 0, child.stderr || String(child.error));
  return JSON.parse(child.stdout);
}

// ── U0d-1 ─────────────────────────────────────────────────────────────────────

test('issue343 U0d-1 native flow with interactive off cannot complete an invalid plan-slice or reach the first executor', () => {
  const dir = owner('loop');
  const input = { cwd: dir, milestone: M, owner_token: 'owner-u0d-loop' };
  const first = loop.advance(loop.create({ mode: 'auto', workflow_id: 'u0d-loop', host_runtime: HOST, max_steps: 6 }), 'next', input, deps);
  assert.deepStrictEqual([first.outcome, first.unit && first.unit.key], ['dispatch_required', PLAN_UNIT], JSON.stringify(first.controller_result));
  const beginKey = first.controller_result.details.transaction.idempotency_key;
  const begin = controller.lookupRecord(dir, 'transaction', beginKey);
  // The real native begin is enrolled with its own key, lease generation, owner digest and owner.
  assert.deepStrictEqual(begin.plan_generation, JSON.parse(JSON.stringify(pv.buildPlanGeneration({ owner: dir, milestone: M, slice: S,
    begin_key: beginKey, lease_generation: begin.lease_generation, owner_digest: begin.owner_digest }))));
  // The worker writes a plan whose T02 omits depends; no checker runs and interactive is off.
  writePlan(dir, MISSING_DEPENDS());
  const before = observe(dir, [`${beginKey}:complete`]);
  const refused = loop.advance(first.snapshot, 'complete', { ...input, result: { status: 'done', summary: 'planned' } }, deps);
  assert.deepStrictEqual([refused.outcome, refused.reason_code, refused.lifecycle, refused.unit.key],
    ['blocked', 'plan-declaration-depends-missing', 'dispatch_required', PLAN_UNIT], JSON.stringify(refused.controller_result));
  assert.deepStrictEqual([refused.controller_result.details.plan_generation.stage, refused.controller_result.details.plan_generation.task_id],
    ['plan-slice-completion', 'T02'], 'the named refusal reaches orchestrate.complete and loop.complete');
  assert.deepStrictEqual(observe(dir, [`${beginKey}:complete`]), before, 'no intent, event, STATE or boundary');
  assert.strictEqual(held(dir, PLAN_UNIT).generation, begin.lease_generation, 'the lease stays held for a corrected plan');
  // The S-plan now exists, so selection skips plan-slice: the first executor is still refused.
  const skipped = loop.advance(loop.create({ mode: 'auto', workflow_id: 'u0d-skip', host_runtime: HOST }), 'next',
    { ...input, owner_token: 'owner-u0d-skip' }, deps);
  assert.deepStrictEqual([skipped.outcome, skipped.reason_code, skipped.controller_result.unit.key],
    ['blocked', 'plan-generation-pending', TASK_UNIT], JSON.stringify(skipped.controller_result));
  assert.strictEqual(skipped.controller_result.details.plan_generation.stage, 'execute-begin');
  assert.strictEqual(held(dir, TASK_UNIT), null, 'the first executor never received a lease');
  assert(!exists(recordFile(dir, `forge-orchestrate-next:${M}:${TASK_UNIT}:${S}`)), 'no execute begin record');
  // The same snapshot still dispatches the plan-slice, never the executor.
  const redispatch = loop.advance(refused.snapshot, 'next', input, deps);
  assert.deepStrictEqual([redispatch.outcome, redispatch.unit.key], ['dispatch_required', PLAN_UNIT]);
  // The corrected plan completes through the same snapshot and lineage.
  writePlan(dir, VALID());
  const completed = loop.advance(refused.snapshot, 'complete', { ...input, result: { status: 'done', summary: 'planned' } }, deps);
  assert.deepStrictEqual([completed.outcome, completed.lifecycle], ['completed', 'idle'], JSON.stringify(completed.controller_result));
  const completion = controller.lookupRecord(dir, 'transaction', `${beginKey}:complete`);
  assert.strictEqual(completion.phase, 'committed');
  assert(!Object.hasOwn(completion, 'plan_validation'), 'no top-level alias is written');
  assert.strictEqual(completion.boundary.result_checksum, checksum(completion.result), 'result_checksum covers the nested evidence');
  const validation = pv.verifyPlanValidation(completion.result.plan_validation, begin.plan_generation);
  assert.deepStrictEqual([validation.begin_key, validation.task_ids], [beginKey, ['T01', 'T02']]);
  assert.strictEqual(held(dir, PLAN_UNIT), null, 'only the admitted completion releases the lease');
  // Only now the first executor is reached.
  const executor = loop.advance(completed.snapshot, 'next', input, deps);
  assert.deepStrictEqual([executor.outcome, executor.unit.key], ['dispatch_required', TASK_UNIT], JSON.stringify(executor.controller_result));
  assert(held(dir, TASK_UNIT), 'the executor lease exists only after admission');
});

// ── U0d-2 ─────────────────────────────────────────────────────────────────────

test('issue343 U0d-2 direct controller.complete refuses the same way; lease stays recoverable and a corrected plan completes', () => {
  const dir = owner('direct'), key = 'plan-complete-u0d-direct';
  const begun = beginPlan(dir, 'plan-begin-u0d-direct', 'owner-u0d-direct');
  const generation = begun.generation;
  const cases = [
    ['no owner plan', null, 'plan-source-missing'],
    ['writes missing', MISSING_WRITES(), 'plan-declaration-writes-missing'],
    ['depends missing', MISSING_DEPENDS(), 'plan-declaration-depends-missing'],
    ['a dependency cycle', CYCLE(), 'plan-dag-invalid'],
    ['a listed task without its plan', { T01: taskPlan('T01') }, 'plan-source-missing', ['T01', 'T02']],
  ];
  for (const [label, tasks, code, listed] of cases) {
    if (tasks) writePlan(dir, tasks, listed ? { listed } : {});
    else fs.rmSync(sliceDir(dir), { recursive: true, force: true });
    const before = observe(dir, [key]);
    assertPlanRefusal(refuses(() => completePlan(dir, begun, key), code, label), code, 'plan-slice-completion', label);
    assert.deepStrictEqual(observe(dir, [key]), before, `${label}: no intent, event, STATE or boundary`);
    assert.strictEqual(held(dir, PLAN_UNIT).generation, generation, `${label}: the lease is held and recoverable`);
  }
  // Imported flags waive nothing: neither a worker plan_validation, an approved flag nor a request alias.
  writePlan(dir, MISSING_WRITES());
  const imported = { status: 'succeeded', summary: 'planned', approved: true, legacy: true,
    plan_validation: { approved: true }, output: { plan_validation: { approved: true } } };
  refuses(() => controller.complete(dir, { milestone: M, unit: PLAN_UNIT, host_runtime: HOST, owner_token: begun.owner_token, generation,
    idempotency_key: key, result: imported, plan_validation: { approved: true }, approved: true }, { prefsReader }),
  'plan-declaration-writes-missing', 'imported flags');
  // Another owner token for the same lease cannot complete it either (assertLease, unchanged).
  refuses(() => completePlan(dir, { owner_token: 'owner-foreign', generation }, key), 'lease-owner-mismatch', 'a foreign owner');
  // The corrected plan completes under the SAME request key; imported fields are not recorded.
  writePlan(dir, VALID());
  const completed = completePlan(dir, begun, key, imported);
  assert.strictEqual(completed.transaction.phase, 'committed');
  const completion = controller.lookupRecord(dir, 'transaction', key);
  const begin = controller.lookupRecord(dir, 'transaction', 'plan-begin-u0d-direct');
  assert.deepStrictEqual(Object.keys(completion.result.plan_validation).sort(), ['begin_key', 'declarations', 'edges', 'generation_key',
    'graph_sha256', 'milestone', 'owner', 'requirement', 'requirement_sha256', 'slice', 'source', 'task_ids', 'validated_at', 'validation_sha256']);
  pv.verifyPlanValidation(completion.result.plan_validation, begin.plan_generation);
  assert.deepStrictEqual([completion.result.approved, completion.result.legacy, completion.plan_validation], [undefined, undefined, undefined]);
  assert.strictEqual(held(dir, PLAN_UNIT), null, 'the admitted completion releases the lease');
  assert.strictEqual(pv.assertCurrentGeneration(dir, { milestone: M, slice: S, validation_key: key }).status, 'current');
  assert.deepStrictEqual([pv.classifySliceGeneration(dir, { milestone: M, slice: S }).status, pv.assertSliceGeneration(dir, { milestone: M, slice: S }).status],
    ['completed', 'current']);
});

// ── U0d-3 ─────────────────────────────────────────────────────────────────────

test('issue343 U0d-3 enrollment survives reentry and cannot be skipped by plan_exists or imported flags', () => {
  // Imported enrollment fields on a begin request are ignored: the record is the controller's own.
  const dir = owner('imported');
  const forged = pv.buildPlanGeneration({ owner: dir, milestone: M, slice: S, begin_key: 'plan-begin-forged', lease_generation: 'lease-forged',
    owner_digest: `sha256:${'f'.repeat(64)}` });
  const begun = controller.begin(dir, { milestone: M, unit: PLAN_UNIT, slice: S, state_patch: { active_slice: S }, host_runtime: HOST,
    owner_token: 'owner-u0d-imported', idempotency_key: 'plan-begin-u0d-imported', plan_generation: forged, approved: true, legacy: true }, { prefsReader });
  const begin = controller.lookupRecord(dir, 'transaction', 'plan-begin-u0d-imported');
  assert.deepStrictEqual([begin.plan_generation.begin_key, begin.plan_generation.lease_generation], ['plan-begin-u0d-imported', begun.generation]);
  assert.notStrictEqual(begin.plan_generation.generation_key, forged.generation_key);
  // A lineage that ends without a successful completion keeps the obligation, even with a plan present.
  assert.strictEqual(transitionPlan(dir, begun, 'fail', 'plan-fail-u0d-imported', { status: 'failed', reason_code: 'worker-failed' }).transaction.phase, 'committed');
  writePlan(dir, VALID());
  assertPlanRefusal(refuses(() => beginExecute(dir, 'execute-after-fail'), 'plan-generation-completion-missing', 'plan_exists after a failed lineage'),
    'plan-generation-completion-missing', 'execute-begin', 'plan_exists after a failed lineage');
  assert.strictEqual(held(dir, TASK_UNIT), null);

  // Continuation: a pause ends the enrolled lineage; the next begin of the unit inherits the
  // enrollment with its own real key and lease; a completion without a valid plan refuses.
  const paused = owner('continuation');
  const first = beginPlan(paused, 'plan-begin-u0d-paused', 'owner-u0d-paused');
  assert.strictEqual(transitionPlan(paused, first, 'pause', 'plan-pause-u0d', { status: 'cancelled' }).transaction.phase, 'committed');
  const resumed = beginPlan(paused, 'plan-begin-u0d-resumed', 'owner-u0d-paused');
  const continuation = controller.lookupRecord(paused, 'transaction', 'plan-begin-u0d-resumed');
  assert.deepStrictEqual([continuation.plan_generation.begin_key, continuation.plan_generation.lease_generation],
    ['plan-begin-u0d-resumed', resumed.generation], 'the continuation is enrolled under its own begin');
  assertPlanRefusal(refuses(() => completePlan(paused, resumed, 'plan-complete-u0d-resumed', { status: 'succeeded', output: { choice: 'answered' } }),
    'plan-source-missing', 'a continuation completed by an answer alone'), 'plan-source-missing', 'plan-slice-completion', 'continuation');
  // A genuine pre-requirement paused lineage keeps its historical semantics (synthetic stand-in).
  const historical = owner('historical-continuation');
  const old = beginPlan(historical, 'plan-begin-u0d-historical', 'owner-u0d-historical');
  asPreRequirementBegin(historical, 'plan-begin-u0d-historical');
  transitionPlan(historical, old, 'pause', 'plan-pause-u0d-historical', { status: 'cancelled' });
  const reopened = beginPlan(historical, 'plan-begin-u0d-reopened', 'owner-u0d-historical');
  assert(!Object.hasOwn(controller.lookupRecord(historical, 'transaction', 'plan-begin-u0d-reopened'), 'plan_generation'),
    'no enrollment is invented for a pre-requirement lineage');
  assert.strictEqual(completePlan(historical, reopened, 'plan-complete-u0d-reopened').transaction.phase, 'committed', 'completed as before');
  assert.strictEqual(pv.classifySliceGeneration(historical, { milestone: M, slice: S }).status, 'unenrolled');

  // Linked reentry after a consumed failure (the real loop-failure fixture): the entry begin
  // inherits the enrollment of the failed begin; its completion is admitted strictly.
  const failures = require('./forge-loop-failure.test');
  const f = failures.fixture();
  try {
    const failedBegin = controller.lookupRecord(f.cwd, 'transaction', f.begin.idempotency_key);
    assert(Object.hasOwn(failedBegin, 'plan_generation'), 'the failed plan-slice begin was enrolled');
    const consumed = failures.consume(f);
    assert.strictEqual(consumed.reason_code, 'failure-consumed', JSON.stringify(consumed.controller_result));
    const entered = failures.invoke(f, 'reenter', consumed.snapshot, failures.entryInput(f, consumed));
    assert.strictEqual(entered.outcome, 'dispatch_required', JSON.stringify(entered.controller_result));
    const entryKey = entered.controller_result.details.transaction.idempotency_key;
    const entry = controller.lookupRecord(f.cwd, 'transaction', entryKey);
    assert.deepStrictEqual([entry.plan_generation.begin_key, entry.plan_generation.lease_generation, entry.plan_generation.slice],
      [entryKey, entry.lease_generation, 'S03'], 'the reentry is enrolled under its own begin');
    // The shared positive fixture now provides a valid planner output. This
    // negative explicitly removes only its private fixture S-plan, preserving
    // the assertion that an enrolled reentry cannot complete without source.
    fs.unlinkSync(path.join(f.cwd, '.gsd', 'milestones', f.milestone, 'slices', 'S03', 'S03-PLAN.md'));
    const refused = failures.invoke(f, 'complete', entered.snapshot, { result: { status: 'done' } });
    assert.deepStrictEqual([refused.outcome, refused.reason_code], ['blocked', 'plan-source-missing'], JSON.stringify(refused.controller_result));
    assert(lease.observe(f.cwd, 'plan-slice/S03').lease, 'the reentry lease stays held');
    writePlan(f.cwd, VALID(), { milestone: f.milestone, slice: 'S03' });
    const completed = failures.invoke(f, 'complete', refused.snapshot, { result: { status: 'done' } });
    assert.strictEqual(completed.outcome, 'completed', JSON.stringify(completed.controller_result));
    const completion = controller.lookupRecord(f.cwd, 'transaction', `${entryKey}:complete`);
    pv.verifyPlanValidation(completion.result.plan_validation, entry.plan_generation);
    assert.strictEqual(pv.assertSliceGeneration(f.cwd, { milestone: f.milestone, slice: 'S03' }).status, 'current');
  } finally { failures.cleanup(f); }
});

// ── U0d-4 ─────────────────────────────────────────────────────────────────────

test('issue343 U0d-4 failpoints around validation and publication replay; historical transactions stay byte-identical', () => {
  // A crash right after admission leaves no intent; the same request completes.
  {
    const dir = owner('failpoint-validation');
    writePlan(dir, VALID());
    const begun = beginPlan(dir, 'plan-begin-fp', 'owner-fp');
    refuses(() => completePlan(dir, begun, 'plan-complete-fp', undefined, { failpoint: name => name === 'after-plan-validation' }),
      'CONTROLLER_FAILPOINT', 'after-plan-validation');
    assert(!exists(recordFile(dir, 'plan-complete-fp')), 'no intent before the failpoint');
    assert.strictEqual(held(dir, PLAN_UNIT).generation, begun.generation);
    assert.strictEqual(completePlan(dir, begun, 'plan-complete-fp').transaction.phase, 'committed');
  }
  // Every publication failpoint replays from the saved evidence, in process and in a fresh one.
  const points = ['after-intent', 'after-result-published', 'after-event-published', 'after-boundary-pending', 'after-state-published',
    'after-lease-release-pending', 'after-lease-released', 'after-boundary-ready'];
  for (const point of points) {
    const dir = owner(`failpoint-${point}`);
    writePlan(dir, VALID());
    const begun = beginPlan(dir, 'plan-begin-fp', 'owner-fp');
    refuses(() => completePlan(dir, begun, 'plan-complete-fp', undefined, { failpoint: name => name === point }), 'CONTROLLER_FAILPOINT', point);
    const intent = controller.lookupRecord(dir, 'transaction', 'plan-complete-fp');
    assert(intent && intent.phase !== 'committed', `${point}: a durable uncommitted intent`);
    const saved = JSON.stringify(intent.result.plan_validation);
    if (point === 'after-intent') {
      // Semantic drift after the intent: recovery proves the SAVED evidence and never re-collects;
      // the first execute then sees the drift.
      fs.writeFileSync(taskFile(dir, 'T02'), taskPlan('T02', { depends: 'depends: []' }));
      freshResume(dir, 'plan-complete-fp', begun);
    } else if (point === 'after-state-published') freshResume(dir, 'plan-complete-fp', begun);
    else controller.resume(dir, { idempotency_key: 'plan-complete-fp', owner_token: begun.owner_token, generation: begun.generation }, { prefsReader });
    const committed = controller.lookupRecord(dir, 'transaction', 'plan-complete-fp');
    assert.strictEqual(committed.phase, 'committed', point);
    assert.strictEqual(JSON.stringify(committed.result.plan_validation), saved, `${point}: the committed evidence is the saved one`);
    assert.strictEqual(eventsOf(dir).filter(event => event.idempotency_key === 'plan-complete-fp').length, 1, `${point}: one event`);
    assert.strictEqual(held(dir, PLAN_UNIT), null, `${point}: the lease is released once`);
    const bytes = fs.readFileSync(recordFile(dir, 'plan-complete-fp'));
    assert.strictEqual(completePlan(dir, begun, 'plan-complete-fp').reason, 'already-committed', `${point}: committed replay`);
    assert(fs.readFileSync(recordFile(dir, 'plan-complete-fp')).equals(bytes), `${point}: the committed record stays byte-identical`);
    if (point === 'after-intent') {
      refuses(() => beginExecute(dir, 'execute-after-drift'), 'plan-generation-drift', 'the drift reaches the first execute');
    }
  }
  // A recovered intent publishes only the evidence it was admitted with.
  {
    const dir = owner('failpoint-forgery');
    writePlan(dir, VALID());
    const begun = beginPlan(dir, 'plan-begin-fp', 'owner-fp');
    refuses(() => completePlan(dir, begun, 'plan-complete-fp', undefined, { failpoint: name => name === 'after-intent' }), 'CONTROLLER_FAILPOINT', 'forgery intent');
    const file = recordFile(dir, 'plan-complete-fp'), original = fs.readFileSync(file);
    const intent = controller.lookupRecord(dir, 'transaction', 'plan-complete-fp');
    const resume = () => controller.resume(dir, { idempotency_key: 'plan-complete-fp', owner_token: begun.owner_token, generation: begun.generation }, { prefsReader });
    const forge = (label, mutate, code, recompose) => {
      const record = JSON.parse(JSON.stringify(intent));
      mutate(record);
      if (recompose) record.boundary.result_checksum = checksum(record.result);
      controller.writeAtomic(file, record);
      try { refuses(resume, code, label); } finally { fs.writeFileSync(file, original); }
      assert.strictEqual(controller.lookupRecord(dir, 'transaction', 'plan-complete-fp').phase, 'intent', `${label}: nothing was published`);
    };
    // Storage corruption: the nested evidence edited without its result checksum.
    forge('nested evidence edited, checksum stale', record => { record.result.plan_validation.approved = true; }, 'record-conflict', false);
    // Self-consistent synthetic forgeries reach the evidence checks.
    forge('nested evidence with an imported flag', record => { record.result.plan_validation.approved = true; }, 'plan-validation-invalid', true);
    forge('nested evidence removed', record => { delete record.result.plan_validation; }, 'plan-generation-evidence-missing', true);
    forge('a top-level alias', record => { record.plan_validation = record.result.plan_validation; }, 'plan-generation-evidence-invalid', true);
    assert.strictEqual(resume().results[0].transaction.phase, 'committed', 'the genuine intent completes');
  }
  // A pre-requirement committed lineage (synthetic stand-in) replays byte-identically, unclassified.
  {
    const dir = owner('historical');
    const begun = beginPlan(dir, 'plan-begin-historical', 'owner-historical');
    asPreRequirementBegin(dir, 'plan-begin-historical');
    assert.strictEqual(completePlan(dir, begun, 'plan-complete-historical').transaction.phase, 'committed', 'completed without a plan, as before');
    const files = ['plan-begin-historical', 'plan-complete-historical'].map(key => recordFile(dir, key));
    const bytes = files.map(file => fs.readFileSync(file));
    assert(!Object.hasOwn(controller.lookupRecord(dir, 'transaction', 'plan-complete-historical').result, 'plan_validation'), 'no backfill');
    assert.strictEqual(completePlan(dir, begun, 'plan-complete-historical').reason, 'already-committed');
    assert.strictEqual(controller.begin(dir, { milestone: M, unit: PLAN_UNIT, slice: S, state_patch: { active_slice: S }, host_runtime: HOST,
      owner_token: 'owner-historical', idempotency_key: 'plan-begin-historical' }, { prefsReader }).reason, 'already-committed');
    controller.resume(dir, {}, { prefsReader });
    assert.strictEqual(pv.classifySliceGeneration(dir, { milestone: M, slice: S }).status, 'unenrolled');
    assert.strictEqual(pv.assertSliceGeneration(dir, { milestone: M, slice: S }).status, 'unenrolled');
    files.forEach((file, index) => assert(fs.readFileSync(file).equals(bytes[index]), `${path.basename(file)} stays byte-identical`));
  }
});

// ── U0d-5 ─────────────────────────────────────────────────────────────────────

test('issue343 U0d-5 first execute begin refuses semantic drift and accepts checkbox and repair_count edits', () => {
  const dir = owner('execute');
  writePlan(dir, VALID());
  const begun = beginPlan(dir, 'plan-begin-u0d-execute', 'owner-u0d-execute');
  assert.strictEqual(completePlan(dir, begun, 'plan-complete-u0d-execute').transaction.phase, 'committed');
  const t02 = taskFile(dir, 'T02'), t02Bytes = fs.readFileSync(t02), sliceBytes = fs.readFileSync(sliceFile(dir));
  const drift = [
    ['depends changed', t02, text => text.replace('depends: [T01]', 'depends: []'), null],
    ['writes changed', t02, text => text.replace('  - "src/t02.js"', '  - "src/moved.js"'), null],
    ['depends removed', t02, text => text.replace('depends: [T01]\n', ''), 'plan-declaration-depends-missing'],
    ['membership reordered', sliceFile(dir), () => slicePlan(['T02', 'T01']), null],
  ];
  let attempt = 0;
  for (const [label, file, rewrite, cause] of drift) {
    const original = fs.readFileSync(file);
    const text = rewrite(original.toString('utf8'));
    assert.notStrictEqual(text, original.toString('utf8'), `${label}: the fixture changed`);
    fs.writeFileSync(file, text);
    try {
      const error = refuses(() => beginExecute(dir, `execute-drift-${++attempt}`), 'plan-generation-drift', label);
      assertPlanRefusal(error, 'plan-generation-drift', 'execute-begin', label);
      assert.strictEqual(error.details.plan_generation.cause_code, cause, `${label}: cause`);
      assert.strictEqual(held(dir, TASK_UNIT), null, `${label}: no executor lease`);
      assert(!exists(recordFile(dir, `execute-drift-${attempt}`)), `${label}: no execute record`);
    } finally { fs.writeFileSync(file, original); }
  }
  assert(fs.readFileSync(t02).equals(t02Bytes) && fs.readFileSync(sliceFile(dir)).equals(sliceBytes), 'restored');
  // Control: a checked box and the real repair_count increment change no declaration.
  fs.writeFileSync(sliceFile(dir), sliceBytes.toString('utf8').replace('- [ ] **T02**', '- [x] **T02**'));
  assert.strictEqual(repair.incrementRepairCount(taskFile(dir, 'T01')), 1);
  const executed = beginExecute(dir, 'execute-control');
  assert.strictEqual(executed.ok, true, JSON.stringify(executed));
  assert(held(dir, TASK_UNIT), 'the enrolled generation is current: the executor begins');
});

console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); } catch { /* best-effort cleanup of synthetic fixtures */ }
if (failed) process.exitCode = 1;
