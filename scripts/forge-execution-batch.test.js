#!/usr/bin/env node
'use strict';

// forge-execution-batch.test.js — issue 343 U1: the canonical batch decision of forge-auto
// execute-task, through the REAL long-workflow adapter (in process and its CLI in a fresh
// process), the real loop, orchestrate and controller, real owner records and real Git roots.
//
//   U1-1 a sidecar primary and an independent sidecar sibling produce one immutable manifest
//        with two committed begins and distinct live leases; each member keeps its own route;
//   U1-2 current_batch stays apart from current_unit; max_steps and time admission are charged
//        once per member; replay (loop and owner) creates no second begin;
//   U1-3 native primary, next, standalone, other phases, legacy, unmet, overlap, roots over 14,
//        SVN and materialization (and the other closed reasons) keep their path with a reason;
//   U1-4 swapped inputs, foreign begins or leases and imported manifests admit nothing; a crash
//        between member intents recovers in a fresh process.
//
// Everything is synthetic and local: temporary HOME/USERPROFILE/FORGE_HOME (no operator
// preference), `git init` roots, FORGE_RESOURCES_PRESSURE=1 (the documented forced-normal seam
// of forge-resources, so the CPU-based clamp is deterministic), no provider, network or real
// history. The only injected seams are the controller failpoints and, for the one synthetic
// native sibling, the trusted in-process routeResolver; every other route is the real
// resolveDispatch of that task's own plan.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-execution-batch-')));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME, { recursive: true });
const SAVED_ENV = Object.fromEntries(['HOME', 'USERPROFILE', 'FORGE_HOME', 'FORGE_RESOURCES_PRESSURE'].map(name => [name, process.env[name]]));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.FORGE_HOME = path.join(HOME, '.forge-agent');
process.env.FORGE_RESOURCES_PRESSURE = '1';

const adapter = require('./forge-long-workflow-adapter');
const loop = require('./forge-loop-controller');
const orchestrate = require('./forge-orchestrate');
const controller = require('./forge-unit-controller');
const batch = require('./forge-execution-batch');
const state = require('./forge-state');
const lease = require('./forge-unit-lease');
const resolver = require('./forge-dispatch-resolve');

const M = 'M-20261108000000-batch';
const S = 'S01';
const ADAPTER = path.join(__dirname, 'forge-long-workflow-adapter.js');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared', 'schemas', 'forge-execution-batch.schema.json'), 'utf8'));
const TOKEN = 'owner-batch-token-6f1d';
const SESSION = 'session-batch-private-91c2';
const BATCH_NAME = /^batch-[a-f0-9]{32}$/;

let passed = 0;
let failed = 0;
function test(name, fn) {
  const started = Date.now();
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${error && error.stack ? error.stack : error}`);
  }
}

// ── Owner fixtures ────────────────────────────────────────────────────────────

let serial = 0;
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; }
function git(cwd, args) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.strictEqual(run.status, 0, `git ${args.join(' ')}: ${run.stderr || run.error}`);
}
// A real owner: ROADMAP, CONTEXT and RESEARCH (no skip preference), STATE, and its root as a
// real Git checkout unless `vcs` says otherwise.
function owner(label, options = {}) {
  const dir = path.join(TMP, `${label}-${++serial}`);
  const base = path.join(dir, '.gsd', 'milestones', M);
  fs.mkdirSync(base, { recursive: true });
  if (!options.vcs || options.vcs === 'git') git(dir, ['init', '-q']);
  if (options.vcs === 'svn') fs.mkdirSync(path.join(dir, '.svn'));
  if (options.gitmodules) write(path.join(dir, '.gitmodules'), '[submodule "vendor"]\n\tpath = vendor\n\turl = ./vendor\n');
  if (options.prefs) write(path.join(dir, '.gsd', 'forge-prefs.jsonc'), JSON.stringify(options.prefs, null, 2));
  if (typeof options.beforeRoadmap === 'function') options.beforeRoadmap(dir);
  write(path.join(base, `${M}-ROADMAP.md`), `# Roadmap\n\n- [ ] **${S}: Work** \`depends:[]\`\n`);
  write(path.join(base, `${M}-CONTEXT.md`), '# Context\n');
  write(path.join(base, `${M}-RESEARCH.md`), '# Research\n');
  state.write(dir, { milestone: M, kind: 'milestone', phase: 'idle', active_slice: '—', active_task: '—', next_action: 'plan', auto_mode: 'on' });
  return dir;
}
// A new task plan the strict admission accepts: structured must_haves, explicit depends/writes.
function taskPlan(id, options = {}) {
  const writes = options.writes || [`src/${id.toLowerCase().replace('.', '-')}.js`];
  const artifact = options.artifact || writes[0];
  const lines = ['---', 'tier: standard', `depends: [${(options.depends || []).join(', ')}]`, 'writes:', ...writes.map(item => `  - "${item}"`)];
  if (options.roots) {
    lines.push('roots_schema: 2', `primary_root_id: ${options.roots[0].id}`, 'code_roots:',
      ...options.roots.flatMap(root => [`  - id: ${root.id}`, `    path: "${root.path.replace(/\\/g, '/')}"`, '    vcs: git']));
  }
  lines.push('must_haves:', '  truths:', `    - "${id} fixture behavior is observable"`, '  artifacts:', `    - path: "${artifact}"`,
    '      provides: "fixture module"', '      min_lines: 1', '  key_links: []', 'expected_output:', `  - ${artifact}`,
    '---', '', `# ${id}: Fixture task`, '', 'Prose never counts as a declaration.', '');
  return lines.join('\n');
}
function independent(ids) { return Object.fromEntries(ids.map(id => [id, taskPlan(id)])); }
function sliceDir(dir) { return path.join(dir, '.gsd', 'milestones', M, 'slices', S); }
function taskFile(dir, id) { return path.join(sliceDir(dir), 'tasks', id, `${id}-PLAN.md`); }
function writePlan(dir, tasks) {
  const ids = Object.keys(tasks);
  write(path.join(sliceDir(dir), `${S}-PLAN.md`), [`# ${S}: Fixture slice`, '', '## Tasks', '',
    ...ids.map(id => `- [ ] **${id}**: ${id} fixture task`), '', 'Slice prose.', ''].join('\n'));
  write(path.join(sliceDir(dir), `${S}-RESEARCH.md`), '# Slice research\n');
  for (const [id, content] of Object.entries(tasks)) write(taskFile(dir, id), content);
}
// The real enrolled plan-slice lineage: controller begin, the planner's owner bytes and the
// strictly admitted completion (forge-unit-controller + forge-plan-validation, issue 343 U0d).
function planSlice(dir, tasks) {
  const key = `plan-begin-${++serial}`;
  const begun = controller.begin(dir, { milestone: M, unit: `plan-slice/${S}`, slice: S, state_patch: { active_slice: S }, host_runtime: 'codex',
    owner_token: 'owner-planner', idempotency_key: key }, {});
  assert.strictEqual(begun.ok, true, JSON.stringify(begun));
  writePlan(dir, tasks);
  const completed = controller.transition(dir, { action: 'complete', milestone: M, unit: `plan-slice/${S}`, host_runtime: 'codex',
    owner_token: 'owner-planner', generation: begun.generation, idempotency_key: `${key}:complete`,
    result: { status: 'succeeded', summary: 'planned' } }, {});
  assert.strictEqual(completed.transaction.phase, 'committed', JSON.stringify(completed));
  return dir;
}
function input(dir, extra = {}) { return { cwd: dir, milestone: M, owner_token: TOKEN, session: SESSION, ...extra }; }
function snapshotOf(host, options = {}) {
  return loop.create({ mode: options.mode || 'auto', workflow_id: `wf-${++serial}`, host_runtime: host, max_steps: options.max_steps || 10 });
}
function next(host, dir, options = {}) {
  const snapshot = options.snapshot || snapshotOf(host, options);
  return adapter.invoke(host, snapshot.mode, 'next', input(dir, options.input || {}), snapshot, options.deps || {}).result;
}
// The real adapter CLI in a fresh process: no in-process seam, failpoint or cache survives.
function freshNext(host, dir, snapshot) {
  const child = spawnSync(process.execPath, [ADAPTER, '--host', host, '--mode', snapshot.mode, '--command', 'next',
    '--json', JSON.stringify(input(dir)), '--snapshot', JSON.stringify(snapshot)],
  { encoding: 'utf8', timeout: 120000, windowsHide: true, env: { ...process.env } });
  assert.strictEqual(child.status, 0, child.stderr || String(child.error));
  return JSON.parse(child.stdout).result;
}
function batchDir(dir) { return path.join(dir, '.gsd', 'forge', 'batches'); }
function manifestIds(dir) { return fs.existsSync(batchDir(dir)) ? fs.readdirSync(batchDir(dir)).filter(name => BATCH_NAME.test(name)) : []; }
function memberTransactions(dir) {
  const directory = controller.transactionDir(dir);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => name.endsWith('.json')).map(name => controller.readJson(path.join(directory, name)))
    .filter(record => record && String(record.idempotency_key).startsWith('forge-execution-batch:'))
    .sort((left, right) => left.unit.key.localeCompare(right.unit.key));
}
function memberEvents(dir) {
  return controller.readEvents(controller.eventsFile(dir, M)).filter(event => event.event === 'unit-began'
    && String(event.idempotency_key).startsWith('forge-execution-batch:'));
}
function held(dir, unitKey) { return lease.observe(dir, unitKey).lease; }
function decisionOf(result) { return result.controller_result && result.controller_result.details && result.controller_result.details.batch; }
function assertSingle(result, reason, label, unitKey = 'execute-task/T01') {
  assert.deepStrictEqual([result.outcome, result.action, result.unit && result.unit.key], ['dispatch_required', 'dispatch', unitKey],
    `${label}: ${JSON.stringify(result.controller_result)}`);
  assert.deepStrictEqual([decisionOf(result).decision, decisionOf(result).reason_code], ['single', reason], `${label}: ${JSON.stringify(decisionOf(result))}`);
  assert.strictEqual(result.snapshot.current_batch, undefined, `${label}: no current_batch`);
  assert.strictEqual(result.snapshot.step_count, 1, `${label}: one step for one unit`);
}
function assertBatch(result, ids, label) {
  assert.deepStrictEqual([result.outcome, result.action, result.reason_code, result.unit], ['dispatch_required', 'dispatch-batch', 'batch-ready', null],
    `${label}: ${JSON.stringify(result.controller_result)}`);
  const dispatched = result.controller_result.details.dispatch_batch;
  const keys = ids.map(id => `execute-task/${id}`);
  assert.deepStrictEqual(dispatched.members.map(member => member.unit.key), keys, label);
  assert.deepStrictEqual([result.snapshot.current_unit, result.snapshot.current_batch.members, result.snapshot.current_batch.batch_id],
    [null, keys, dispatched.batch_id], label);
  return dispatched;
}
// An interrupted dispatch: the manifest and the member preparation are durable, then the first
// member begin crashes before its intent (the lease it took is rolled back by the controller).
function crashed(label) {
  const dir = planSlice(owner(label), independent(['T01', 'T02']));
  const initial = snapshotOf('codex');
  assert.throws(() => adapter.invoke('codex', 'auto', 'next', input(dir), initial, { failpoint: name => name === 'before-make-transaction' }),
    error => error && error.code === 'CONTROLLER_FAILPOINT');
  const ids = manifestIds(dir);
  assert.strictEqual(ids.length, 1, `${label}: one manifest before any intent`);
  assert.strictEqual(memberTransactions(dir).length, 0, `${label}: no member intent`);
  assert.deepStrictEqual([held(dir, 'execute-task/T01'), held(dir, 'execute-task/T02')], [null, null], `${label}: the interrupted lease was rolled back`);
  assert.deepStrictEqual(batch.readProgress(dir, batch.readManifest(dir, ids[0])).map(row => row.state), ['preparado', 'preparado'],
    `${label}: both members prepared before any lease`);
  return { dir, initial, batchId: ids[0] };
}

// ── U1-1 ──────────────────────────────────────────────────────────────────────

test('issue343 U1-1 sidecar primary and two independent sidecars produce one manifest with two committed begins and distinct leases', () => {
  assert(os.cpus().length >= 2, 'the forced-normal resource budget needs two CPUs for a cohort of two');
  const dir = planSlice(owner('positive'), { ...independent(['T01', 'T02']), T03: taskPlan('T03', { depends: ['T01'] }) });
  const first = next('codex', dir);
  const dispatched = assertBatch(first, ['T01', 'T02'], 'codex sidecar cohort');
  // One immutable manifest, exclusively published, sealed and bound to this request.
  assert.deepStrictEqual(manifestIds(dir), [dispatched.batch_id]);
  const manifest = batch.readManifest(dir, dispatched.batch_id);
  assert.strictEqual(manifest.manifest_sha256, dispatched.manifest_sha256);
  assert.strictEqual(manifest.request_key, `forge-orchestrate-next:${M}:execute-task/T01:${S}`);
  assert.deepStrictEqual([manifest.primary.task_id, manifest.members.map(member => member.task_id)], ['T01', ['T01', 'T02']]);
  assert.deepStrictEqual(manifest.excluded, [{ task_id: 'T03', reason_code: 'dependency-unmet' }], 'the dependent task stays pending');
  assert.deepStrictEqual([manifest.limits.max_concurrent >= 2, manifest.limits.roots_limit, manifest.limits.roots_used], [true, 14, 3]);
  // Two committed begins, each bound to its member, each holding its own live lease.
  const records = manifest.members.map(member => controller.lookupRecord(dir, 'transaction', member.begin_key));
  records.forEach((record, index) => {
    assert.strictEqual(record.phase, 'committed', `${record.unit.key} committed`);
    assert.deepStrictEqual(record.batch, batch.memberBinding(manifest, manifest.members[index]));
    assert.strictEqual(record.after.state.active_slice, S);
    assert.strictEqual(held(dir, record.unit.key).generation, record.lease_generation, `${record.unit.key}: the live lease is its begin generation`);
    assert.strictEqual(dispatched.members[index].transaction.generation, record.lease_generation);
  });
  assert.notStrictEqual(records[0].lease_generation, records[1].lease_generation, 'distinct leases');
  assert.deepStrictEqual([memberTransactions(dir).length, memberEvents(dir).length], [2, 2]);
  assert.strictEqual(held(dir, 'execute-task/T03'), null, 'the dependent task holds nothing');
  // Each member keeps exactly its own canonical route, model, tier and effort (real resolver).
  manifest.members.forEach((member, index) => {
    const direct = resolver.resolveDispatch(JSON.parse(JSON.stringify(member.route.resolution_options)));
    assert.deepStrictEqual([member.route.worker_mode, member.route.host_runtime, member.route.resolved_worker_engine, member.route.model,
      member.route.tier, member.route.effort], ['sidecar', 'codex', direct.resolved_worker_engine, direct.model_resolved || direct.model, direct.tier, direct.effort]);
    assert(member.route.resolution_options.planPath.endsWith(path.join('tasks', member.task_id, `${member.task_id}-PLAN.md`)), 'its own plan only');
    assert.strictEqual(dispatched.members[index].route.route_sha256, member.route.route_sha256);
  });
  // Per-member progress: preparado, then admitido; one CAS chain per member.
  assert.deepStrictEqual(batch.readProgress(dir, manifest).map(row => [row.task_id, row.state, row.sequence]), [['T01', 'admitido', 2], ['T02', 'admitido', 2]]);
  assert.throws(() => batch.appendProgress(dir, manifest, 1, 'preparado', 'executando', null), error => error.code === 'batch-progress-conflict', 'CAS refuses a stale view');
  // STATE stays the compatible projection of the primary; nothing public carries the token or session.
  assert.strictEqual(state.read(dir, M).active_task, 'T01');
  const bytes = fs.readFileSync(path.join(batchDir(dir), dispatched.batch_id, 'manifest.json'), 'utf8');
  for (const secret of [TOKEN, SESSION]) {
    assert(!JSON.stringify(first).includes(secret), `the result carries no ${secret}`);
    assert(!bytes.includes(secret), `the manifest carries no ${secret}`);
  }
  // The schema and the module agree on every closed shape and vocabulary.
  const entry = JSON.parse(fs.readFileSync(path.join(batchDir(dir), dispatched.batch_id, 'progress', 'm0', '0001.json'), 'utf8'));
  const keys = value => Object.keys(value).sort();
  assert.strictEqual(SCHEMA.$id, 'urn:forge:execution-batch:v1');
  assert.deepStrictEqual([...SCHEMA.required].sort(), keys(manifest));
  assert.deepStrictEqual([...SCHEMA.$defs.member.required].sort(), keys(manifest.members[0]));
  assert.deepStrictEqual([...SCHEMA.$defs.route.required].sort(), keys(manifest.members[0].route));
  assert.deepStrictEqual([...SCHEMA.properties.limits.required].sort(), keys(manifest.limits));
  assert.deepStrictEqual([...SCHEMA.properties.generation.required].sort(), keys(manifest.generation));
  assert.deepStrictEqual([...SCHEMA.$defs.progressEntry.required].sort(), keys(entry));
  assert.deepStrictEqual([...SCHEMA.$defs.binding.required].sort(), keys(records[0].batch));
  assert.deepStrictEqual(SCHEMA.$defs.reasonCode.enum, [...batch.REASON_CODES]);
  assert.deepStrictEqual(SCHEMA.$defs.refusalCode.enum, [...batch.REFUSAL_CODES]);
  assert.deepStrictEqual(SCHEMA.$defs.memberState.enum, [...batch.MEMBER_STATES]);
  for (const code of batch.REFUSAL_CODES) assert(orchestrate.REASON_CODES.includes(code), `orchestrate names ${code}`);
});

// ── U1-2 ──────────────────────────────────────────────────────────────────────

test('issue343 U1-2 current_batch stays separate; max_steps and time admission charged once; replay creates no second begin', () => {
  const dir = planSlice(owner('replay'), independent(['T01', 'T02']));
  const initial = snapshotOf('codex', { max_steps: 5 });
  const first = adapter.invoke('codex', 'auto', 'next', input(dir), initial, {}).result;
  const dispatched = assertBatch(first, ['T01', 'T02'], 'replay fixture');
  assert.deepStrictEqual([first.snapshot.current_unit, first.snapshot.step_count, first.batch.batch_id, dispatched.replay], [null, 2, dispatched.batch_id, false]);
  const manifest = batch.readManifest(dir, dispatched.batch_id);
  // One step and one (read-only, then recorded-at-begin) time admission per member.
  assert.deepStrictEqual(manifest.members.map(member => [member.step_charge, member.time_admission.decision]), [[1, 'no-contract'], [1, 'no-contract']]);
  const files = manifest.members.map(member => controller.transactionFile(dir, member.begin_key));
  const bytes = files.map(file => fs.readFileSync(file));
  const manifestFile = path.join(batchDir(dir), dispatched.batch_id, 'manifest.json'), manifestBytes = fs.readFileSync(manifestFile);
  // Loop replay of the same snapshot: the same decision, uncharged, revalidated on owner records.
  const repeated = adapter.invoke('codex', 'auto', 'next', input(dir), first.snapshot, {}).result;
  assert.deepStrictEqual(repeated, first, 'the pending batch replays identically');
  // Owner replay from the older snapshot (the dispatch result was lost): the manifest decides.
  const lost = adapter.invoke('codex', 'auto', 'next', input(dir), initial, {}).result;
  const again = assertBatch(lost, ['T01', 'T02'], 'owner replay');
  assert.deepStrictEqual([again.replay, again.batch_id, again.manifest_sha256, lost.snapshot.step_count], [true, dispatched.batch_id, dispatched.manifest_sha256, 2]);
  files.forEach((file, index) => assert(fs.readFileSync(file).equals(bytes[index]), 'no second begin: the member begin bytes are unchanged'));
  assert(fs.readFileSync(manifestFile).equals(manifestBytes), 'the manifest is immutable');
  assert.deepStrictEqual([memberTransactions(dir).length, memberEvents(dir).length], [2, 2], 'no second begin record or event');
  assert.deepStrictEqual(batch.readProgress(dir, manifest).map(row => row.sequence), [2, 2], 'no progress entry repeated');
  // Every single-unit command refuses by name while the batch is active, without delegation.
  for (const command of ['complete', 'pause', 'resume', 'consume-failure', 'reenter', 'resume-budget', 'resume-time-option']) {
    const refused = adapter.invoke('codex', 'auto', command, input(dir, { result: { status: 'done' }, response: 'sim', resume_intent: 'execute' }),
      first.snapshot, {}).result;
    assert.deepStrictEqual([refused.outcome, refused.reason_code, refused.controller_result], ['blocked', 'batch-active', null], command);
    assert.deepStrictEqual(refused.snapshot, first.snapshot, `${command}: the snapshot is unchanged`);
  }
  // A direct single-unit completion of a member is deferred to the batch consolidation.
  const member = dispatched.members[1];
  const direct = orchestrate.run('complete', { cwd: dir, milestone: M, host_runtime: 'codex', owner_token: TOKEN, unit: member.unit,
    begin_key: member.transaction.idempotency_key, result: { status: 'done' } });
  assert.deepStrictEqual([direct.outcome, direct.reason_code], ['blocked', 'batch-member-operation-deferred']);
  assert.strictEqual(controller.lookupRecord(dir, 'transaction', `${member.transaction.idempotency_key}:complete`), null, 'no completion intent');
  // batch-status observes the owner records; batch-ack waits for every member, and an answer,
  // a done result or an approved flag never completes or acknowledges one.
  const observed = adapter.invoke('codex', 'auto', 'batch-status', input(dir), first.snapshot, {}).result;
  assert.deepStrictEqual([observed.outcome, observed.reason_code, observed.action], ['status', 'batch-status-ready', 'observe']);
  assert.deepStrictEqual(observed.controller_result.details.batch.members.map(row => [row.task_id, row.state, row.begin, row.lease]),
    [['T01', 'admitido', 'committed', 'held'], ['T02', 'admitido', 'committed', 'held']]);
  const ack = adapter.invoke('codex', 'auto', 'batch-ack', input(dir, { response: 'aprovado', result: { status: 'done' }, approved: true,
    batch: { batch_id: `batch-${'c'.repeat(32)}`, manifest_sha256: 'd'.repeat(64) } }), first.snapshot, {}).result;
  assert.deepStrictEqual([ack.outcome, ack.reason_code, ack.snapshot.current_batch, ack.snapshot.step_count],
    ['blocked', 'batch-members-pending', first.snapshot.current_batch, 2]);
  // max_steps: two remaining steps admit two of three; one remaining step keeps the single path.
  const capped = next('codex', planSlice(owner('steps'), independent(['T01', 'T02', 'T03'])), { max_steps: 2 });
  assert.deepStrictEqual([assertBatch(capped, ['T01', 'T02'], 'max_steps 2').excluded, capped.snapshot.step_count],
    [[{ task_id: 'T03', reason_code: 'max-steps' }], 2]);
  assertSingle(next('codex', planSlice(owner('one-step'), independent(['T01', 'T02'])), { max_steps: 1 }), 'max-steps', 'max_steps 1');
  // Snapshot compatibility: an older snapshot has no current_batch; a batch never coexists with a unit.
  assert.strictEqual(Object.prototype.hasOwnProperty.call(loop.create({ mode: 'auto', workflow_id: 'old', host_runtime: 'codex' }), 'current_batch'), false);
  assert.throws(() => loop.validateSnapshot({ ...first.snapshot, current_unit: { type: 'execute-task', id: 'T01', key: 'execute-task/T01' } }),
    error => error.code === 'invalid-snapshot');
  assert.throws(() => loop.validateSnapshot({ ...first.snapshot, current_batch: { batch_id: 'forged', manifest_sha256: 'x', members: [] } }),
    error => error.code === 'invalid-snapshot');
});

// ── U1-3 ──────────────────────────────────────────────────────────────────────

test('issue343 U1-2 active time contract binds each admitted begin and replays without duplicate time or steps', () => {
  const time = require('./forge-milestone-time');
  const clocks = require('./forge-milestone-time-clock');
  const questions = require('./forge-pending-questions');
  const { digest } = require('./forge-code-roots');
  // activateContract must precede ROADMAP publication, with an actual persisted
  // answer and a live decision handle; imported approved flags grant nothing.
  function timedOwner(label) {
    let activated;
    const dir = owner(label, { beforeRoadmap: cwd => {
      fs.mkdirSync(path.join(cwd, '.gsd', 'forge'), { recursive: true });
      activated = Date.now();
      assert.strictEqual(fs.existsSync(path.join(cwd, '.gsd', 'milestones', M, `${M}-ROADMAP.md`)), false);
      const payload = { schema_version: 1, milestone: M,
        clock_policy: { id: 'forge-milestone-time-clock', version: 1 },
        option: { id: 'balanced', options_sha256: 'a'.repeat(64), label: 'Bounded batch fixture' },
        activated_at: new Date(activated).toISOString(), preselection_started_at: new Date(activated - 1).toISOString(),
        ceiling_ms: 60000, endpoint: { kind: 'verified-integrated-delivery',
          items: Object.fromEntries(time.ENDPOINT_ITEMS.map(key => [key, 'pending'])) },
        allocation: null, linked_task: null, chain_forecast: null };
      const id = 'batch-time-' + ++serial;
      const opened = questions.openQuestions({ cwd, milestone: M, unit: 'milestone-time/' + id,
        decision_set: 'milestone-time-activation', questions: [{ id, question: 'Activate synthetic bounded time contract?' }] });
      questions.answer({ cwd, identity: opened.identity_sha256, answers: [{ id, answer: 'option:balanced', source: 'user-text' }] });
      const live = { reference: 'fixture-' + id, status: 'resolved', answer: 'option:balanced', source: 'user-text',
        resolved_at: new Date(activated).toISOString(), question: { identity_sha256: opened.identity_sha256, id } };
      const handle = time.createDecisionAuthority(() => live).issue(live.reference,
        { milestone: M, kind: 'activation', request_sha256: digest(payload), expires_at: activated + 60000 }, () => activated);
      assert.strictEqual(time.activateContract({ cwd, milestone: M, contract: payload, now: activated, handle }).status, 'valid');
    } });
    planSlice(dir, independent(['T01', 'T02']));
    return { dir, activated };
  }
  const { dir } = timedOwner('active-time');
  const initial = snapshotOf('codex', { max_steps: 5 });
  let at = Date.now() + 1000;
  const deps = { now: () => at }, active = time.readContract({ cwd: dir, milestone: M });
  assert.strictEqual(active.status, 'valid');
  const beforeClock = clocks.readClock({ cwd: dir, milestone: M, now: at });
  assert.strictEqual(beforeClock.status, 'measured');
  const first = adapter.invoke('codex', 'auto', 'next', input(dir), initial, deps).result;
  const dispatched = assertBatch(first, ['T01', 'T02'], 'active temporal cohort');
  const manifest = batch.readManifest(dir, dispatched.batch_id);
  assert.deepStrictEqual(manifest.members.map(m => [m.step_charge, m.time_admission.decision]), [[1, 'admitted'], [1, 'admitted']]);
  const files = manifest.members.map(m => controller.transactionFile(dir, m.begin_key));
  const bytes = files.map(file => fs.readFileSync(file));
  const events = fs.readFileSync(controller.eventsFile(dir, M));
  for (const member of manifest.members) {
    const record = controller.lookupRecord(dir, 'transaction', member.begin_key);
    assert.strictEqual(record.idempotency_key, member.begin_key);
    assert.strictEqual(record.unit.key, member.unit);
    assert.strictEqual(record.time_admission.decision, 'admitted');
    assert.deepStrictEqual([record.time_admission.contract_version, record.time_admission.contract_sha256], [active.version, active.sha256]);
    assert.strictEqual(record.time_admission.at, new Date(at).toISOString());
    assert.strictEqual(record.time_admission.consumed_ms, beforeClock.consumption.consumed_ms, 'admission observes time; it does not increment a fictitious charge counter');
    assert.strictEqual(held(dir, member.unit).generation, record.lease_generation);
  }
  const admittedClock = clocks.readClock({ cwd: dir, milestone: M, now: at });
  assert.strictEqual(admittedClock.consumption.consumed_ms, beforeClock.consumption.consumed_ms);
  at += 250;
  const elapsedClock = clocks.readClock({ cwd: dir, milestone: M, now: at });
  assert.strictEqual(elapsedClock.consumption.consumed_ms - admittedClock.consumption.consumed_ms, 250, 'overlapping member time is consumed once by union');
  assert.strictEqual(elapsedClock.effort.unit_interval_sum_ms - admittedClock.effort.unit_interval_sum_ms, 500, 'unit interval sum is a distinct two-member proxy, not consumed_ms');
  const repeated = adapter.invoke('codex', 'auto', 'next', input(dir), first.snapshot, deps).result;
  assert.deepStrictEqual(repeated, first);
  const lost = adapter.invoke('codex', 'auto', 'next', input(dir), initial, deps).result;
  assert.deepStrictEqual([assertBatch(lost, ['T01', 'T02'], 'active owner replay').replay, lost.snapshot.step_count], [true, 2]);
  // New process, real adapter, same controlled clock; no in-process cache or handle
  // survives. The contract's already-persisted live-authorized decision is read.
  const childScript = 'const [moduleFile,cwd,milestone,token,session,snapshot,now]=process.argv.slice(1);' +
    'const result=require(moduleFile).invoke("codex","auto","next",{cwd,milestone,owner_token:token,session},JSON.parse(snapshot),{now:()=>Number(now)}).result;' +
    'process.stdout.write(JSON.stringify(result));';
  const child = spawnSync(process.execPath, ['-e', childScript, ADAPTER, dir, M, TOKEN, SESSION, JSON.stringify(initial), String(at)],
    { env: { ...process.env }, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.strictEqual(child.status, 0, child.stderr || String(child.error));
  const fresh = JSON.parse(child.stdout);
  assert.deepStrictEqual([assertBatch(fresh, ['T01', 'T02'], 'active fresh-process replay').replay, fresh.snapshot.step_count], [true, 2]);
  files.forEach((file, index) => assert(fs.readFileSync(file).equals(bytes[index]), 'replay retains exact own admission/begin bytes'));
  assert(fs.readFileSync(controller.eventsFile(dir, M)).equals(events), 'no duplicate controller begin/event');
  assert.deepStrictEqual([memberTransactions(dir).length, memberEvents(dir).length], [2, 2]);
  const replayedClock = clocks.readClock({ cwd: dir, milestone: M, now: at });
  assert.strictEqual(replayedClock.consumption.consumed_ms, elapsedClock.consumption.consumed_ms, 'same-now replay adds no consumption');
  assert.deepStrictEqual(batch.readProgress(dir, manifest).map(row => row.sequence), [2, 2]);
  assert.strictEqual(time.readContract({ cwd: dir, milestone: M }).sha256, active.sha256);
  const blocked = timedOwner('active-time-cap');
  const capAt = blocked.activated + 60000;
  const capped = adapter.invoke('codex', 'auto', 'next', input(blocked.dir), snapshotOf('codex'), { now: () => capAt }).result;
  assert.strictEqual(capped.reason_code, 'milestone-budget-exhausted', JSON.stringify(capped));
  assert.deepStrictEqual([held(blocked.dir, 'execute-task/T01'), held(blocked.dir, 'execute-task/T02')], [null, null]);
  assert.deepStrictEqual([memberTransactions(blocked.dir).length, memberEvents(blocked.dir).length], [0, 0]);
  assert.throws(() => controller.begin(blocked.dir, { milestone: M, unit: 'execute-task/T01', slice: S,
    owner_token: TOKEN, host_runtime: 'codex', idempotency_key: 'capped-time-begin' }, { now: () => capAt }),
    error => error.code === 'milestone-budget-exhausted');
  assert.strictEqual(controller.lookupRecord(blocked.dir, 'transaction', 'capped-time-begin'), null);
  assert.strictEqual(held(blocked.dir, 'execute-task/T01'), null);
  // U1_ACTIVE_TIME_OBSERVATION_POINT
});


test('issue343 U1-3 native primary, next, standalone, other phases, legacy, unmet, overlap, roots over 14, SVN and materialization keep their path with a named reason', () => {
  // Native primary (real resolver: Claude host, Claude worker): the native path, no cohort.
  const native = planSlice(owner('native'), independent(['T01', 'T02']));
  assertSingle(next('claude', native), 'primary-native', 'native primary');
  // next (a direct owner call carries no loop mode) and task mode keep the single path.
  const direct = planSlice(owner('direct'), independent(['T01', 'T02']));
  const plain = orchestrate.run('next', { cwd: direct, milestone: M, host_runtime: 'codex', owner_token: TOKEN });
  assert.deepStrictEqual([plain.outcome, plain.unit.key, plain.details.batch.reason_code], ['completed', 'execute-task/T01', 'mode-not-auto']);
  assertSingle(next('codex', planSlice(owner('task-mode'), independent(['T01', 'T02'])), { mode: 'task' }), 'mode-not-auto', 'task mode');
  // Standalone (no milestone): refused by name before orchestrate, nothing durable.
  const loose = owner('standalone');
  const refused = adapter.invoke('codex', 'task', 'next', { cwd: loose, owner_token: TOKEN, workflow_id: 'loose' }, null, {}).result;
  assert.deepStrictEqual([refused.reason_code, refused.controller_result], ['task-scope-unsupported', null]);
  // Other phases: plan-slice selected in auto mode.
  const phase = next('codex', owner('phase'));
  assert.deepStrictEqual([phase.unit.key, decisionOf(phase).reason_code], [`plan-slice/${S}`, 'unit-not-execute-task']);
  // Legacy: owner plan bytes without an enrolled plan-slice lineage stay sequential.
  const legacy = owner('legacy');
  writePlan(legacy, independent(['T01', 'T02']));
  assertSingle(next('codex', legacy), 'legacy-plan-sequential', 'legacy');
  // Unmet dependency and overlapping writes (literal, and intersecting globs).
  assertSingle(next('codex', planSlice(owner('unmet'), { T01: taskPlan('T01'), T02: taskPlan('T02', { depends: ['T01'] }) })), 'dependency-unmet', 'unmet');
  assertSingle(next('codex', planSlice(owner('overlap'), { T01: taskPlan('T01', { writes: ['src/shared.js'] }),
    T02: taskPlan('T02', { writes: ['src/shared.js'] }) })), 'writes-overlap', 'literal overlap');
  assertSingle(next('codex', planSlice(owner('glob'), { T01: taskPlan('T01', { writes: ['src/*.js'], artifact: 'src/t01.js' }),
    T02: taskPlan('T02', { writes: ['src/a*'], artifact: 'src/a.js' }) })), 'writes-overlap', 'glob overlap');
  // Roots over 14: five declared roots per member need 5 + 5 + a union of 5 > 14.
  const roots = Array.from({ length: 5 }, (_, index) => ({ id: `r${index + 1}`, path: path.join(TMP, 'declared-roots', `r${index + 1}`) }));
  const rooted = id => taskPlan(id, { writes: [`r1::src/${id.toLowerCase()}.js`], artifact: `src/${id.toLowerCase()}.js`, roots });
  assertSingle(next('codex', planSlice(owner('roots'), { T01: rooted('T01'), T02: rooted('T02') })), 'roots-limit', 'roots over 14');
  // SVN, an unknown VCS and submodules cannot give each member its own Git worktree and index.
  assertSingle(next('codex', planSlice(owner('svn', { vcs: 'svn' }), independent(['T01', 'T02']))), 'svn-isolation-unavailable', 'svn');
  assertSingle(next('codex', planSlice(owner('none', { vcs: 'none' }), independent(['T01', 'T02']))), 'vcs-isolation-unavailable', 'no vcs');
  assertSingle(next('codex', planSlice(owner('modules', { gitmodules: true }), independent(['T01', 'T02']))), 'materialization-unsupported', 'materialization');
  // An explicit shared isolation is the operator's opt-out of worktrees; the preference is never rewritten.
  const shared = planSlice(owner('shared', { prefs: { forge_isolation: { mode: 'shared' } } }), independent(['T01', 'T02']));
  const sharedPrefs = fs.readFileSync(path.join(shared, '.gsd', 'forge-prefs.jsonc'));
  assertSingle(next('codex', shared), 'isolation-policy', 'isolation policy');
  assert(fs.readFileSync(path.join(shared, '.gsd', 'forge-prefs.jsonc')).equals(sharedPrefs), 'the preference is untouched');
  // max_concurrent is the canonical preference (range and default unchanged): it reduces the cohort.
  const limited = next('codex', planSlice(owner('limit', { prefs: { parallelism: { max_concurrent: 2 } } }), independent(['T01', 'T02', 'T03'])));
  assert.deepStrictEqual(assertBatch(limited, ['T01', 'T02'], 'max_concurrent 2').excluded, [{ task_id: 'T03', reason_code: 'max-concurrent' }]);
  assertSingle(next('codex', planSlice(owner('serial', { prefs: { parallelism: { max_concurrent: 1 } } }), independent(['T01', 'T02']))), 'max-concurrent', 'max_concurrent 1');
  // A native candidate stays pending with its route untouched; the cohort never joins a native window.
  const mixed = planSlice(owner('mixed'), independent(['T01', 'T02', 'T03']));
  const routeResolver = options => {
    const route = resolver.resolveDispatch(options);
    return options.unitId === 'T02' ? { ...route, worker_mode: 'native', resolved_worker_engine: 'codex' } : route;
  };
  const cohort = next('codex', mixed, { deps: { routeResolver } });
  assert.deepStrictEqual(assertBatch(cohort, ['T01', 'T03'], 'native sibling').excluded, [{ task_id: 'T02', reason_code: 'route-not-sidecar' }]);
  assert.strictEqual(held(mixed, 'execute-task/T02'), null, 'the native candidate holds no lease');
  // A sibling whose scope already holds a lease of another owner is never adopted.
  const busy = planSlice(owner('busy'), independent(['T01', 'T02']));
  assert.strictEqual(lease.acquire(busy, 'execute-task/T02', { ownerToken: 'owner-foreign', requestId: 'foreign-request', hostRuntime: 'codex' }).ok, true);
  assertSingle(next('codex', busy), 'lease-scope-collision', 'foreign lease');
  // No single decision above published a manifest or a member begin.
  for (const dir of [native, direct, legacy, shared, busy]) {
    assert.deepStrictEqual([manifestIds(dir), memberTransactions(dir).length], [[], 0], `${dir}: nothing of a batch`);
  }
});

// ── U1-4 ──────────────────────────────────────────────────────────────────────

test('issue343 U1-4 swapped inputs, foreign begin or lease and imported manifests admit nothing; crash between intents recovers in a fresh process', () => {
  // Imported JSON grants nothing: a caller's manifest, dispatch_batch, current_batch, batch or approved flag.
  const imported = planSlice(owner('imported'), independent(['T01', 'T02']));
  const forged = { batch_id: `batch-${'a'.repeat(32)}`, manifest_sha256: 'b'.repeat(64), members: ['execute-task/T01', 'execute-task/T02'] };
  assertSingle(next('claude', imported, { input: { approved: true, legacy: false, dispatch_batch: { ...forged }, manifest: { schema: batch.SCHEMA },
    current_batch: forged, batch: forged } }), 'primary-native', 'imported JSON on a native primary');
  assert.deepStrictEqual(manifestIds(imported), []);
  const forgedSnapshot = { ...loop.create({ mode: 'auto', workflow_id: 'forged', host_runtime: 'codex' }), lifecycle: 'dispatch_required', current_batch: forged };
  for (const command of ['batch-status', 'batch-ack']) {
    const view = adapter.invoke('codex', 'auto', command, input(imported), forgedSnapshot, {}).result;
    assert.deepStrictEqual([view.outcome, view.reason_code], ['blocked', 'batch-manifest-invalid'], command);
  }
  // A crash right after the manifest (before any intent) recovers in a fresh process.
  const resumed = crashed('crash-manifest');
  assert.strictEqual(assertBatch(freshNext('codex', resumed.dir, resumed.initial), ['T01', 'T02'], 'recovery after the manifest').batch_id, resumed.batchId);
  // A tampered manifest admits nothing; its genuine bytes recover.
  const tampered = crashed('tampered');
  const manifestFile = path.join(batchDir(tampered.dir), tampered.batchId, 'manifest.json'), original = fs.readFileSync(manifestFile);
  const edited = JSON.parse(original.toString('utf8'));
  edited.members[1].writes = ['src/t01.js'];
  fs.writeFileSync(manifestFile, `${JSON.stringify(edited)}\n`);
  const invalid = adapter.invoke('codex', 'auto', 'next', input(tampered.dir), tampered.initial, {}).result;
  assert.deepStrictEqual([invalid.outcome, invalid.reason_code], ['blocked', 'batch-manifest-invalid'], JSON.stringify(invalid.controller_result));
  assert.deepStrictEqual([memberTransactions(tampered.dir).length, held(tampered.dir, 'execute-task/T01')], [0, null]);
  fs.writeFileSync(manifestFile, original);
  assertBatch(freshNext('codex', tampered.dir, tampered.initial), ['T01', 'T02'], 'the genuine manifest recovers');
  // A manifest imported from another owner (same request identity) is foreign.
  const other = planSlice(owner('foreign-manifest'), independent(['T01', 'T02']));
  write(path.join(batchDir(other), tampered.batchId, 'manifest.json'), original);
  const foreignManifest = next('codex', other);
  assert.deepStrictEqual([foreignManifest.outcome, foreignManifest.reason_code], ['blocked', 'batch-manifest-foreign'], JSON.stringify(foreignManifest.controller_result));
  assert.deepStrictEqual([memberTransactions(other).length, held(other, 'execute-task/T01'), held(other, 'execute-task/T02')], [0, null, null]);
  // A foreign begin in a member's scope (an ordinary begin at its key, no binding) admits nothing.
  const foreign = crashed('foreign-begin');
  const memberKey = batch.memberBeginKey(foreign.batchId, 'execute-task/T02');
  controller.begin(foreign.dir, { milestone: M, unit: 'execute-task/T02', slice: S, state_patch: { active_slice: S }, host_runtime: 'codex',
    owner_token: TOKEN, idempotency_key: memberKey }, {});
  const refusedForeign = adapter.invoke('codex', 'auto', 'next', input(foreign.dir), foreign.initial, {}).result;
  assert.deepStrictEqual([refusedForeign.outcome, refusedForeign.reason_code], ['blocked', 'batch-member-begin-foreign'], JSON.stringify(refusedForeign.controller_result));
  assert.deepStrictEqual([memberTransactions(foreign.dir).filter(record => record.batch).length, held(foreign.dir, 'execute-task/T01')], [0, null]);
  // A foreign lease taken before the replay: the sibling is never admitted, the primary keeps the single path.
  const leased = crashed('foreign-lease');
  assert.strictEqual(lease.acquire(leased.dir, 'execute-task/T02', { ownerToken: 'owner-foreign', requestId: 'foreign-request', hostRuntime: 'codex' }).ok, true);
  assertSingle(adapter.invoke('codex', 'auto', 'next', input(leased.dir), leased.initial, {}).result, 'lease-scope-collision', 'foreign lease on replay');
  assert.strictEqual(memberTransactions(leased.dir).length, 0, 'no member begin');
  assert.deepStrictEqual(batch.readProgress(leased.dir, batch.readManifest(leased.dir, leased.batchId)).map(row => [row.state, row.reason_code]),
    [['bloqueado', 'lease-scope-collision'], ['bloqueado', 'lease-scope-collision']]);
  // Swapped plan inputs (T02 now writes the primary's file): nothing is admitted on any path.
  const swapped = crashed('swapped-plan');
  fs.writeFileSync(taskFile(swapped.dir, 'T02'), taskPlan('T02', { writes: ['src/t01.js'] }));
  const drift = adapter.invoke('codex', 'auto', 'next', input(swapped.dir), swapped.initial, {}).result;
  assert.deepStrictEqual([drift.outcome, drift.reason_code], ['blocked', 'plan-generation-drift'], JSON.stringify(drift.controller_result));
  assert.deepStrictEqual([memberTransactions(swapped.dir).length, held(swapped.dir, 'execute-task/T01'), held(swapped.dir, 'execute-task/T02')], [0, null, null]);
  // A swapped route (the effort preference changed after the decision): the stale cohort admits nothing.
  const rerouted = crashed('swapped-route');
  write(path.join(rerouted.dir, '.gsd', 'forge-prefs.jsonc'), JSON.stringify({ effort: { 'execute-task': 'high' } }));
  assertSingle(adapter.invoke('codex', 'auto', 'next', input(rerouted.dir), rerouted.initial, {}).result, 'route-stale', 'swapped route');
  assert.strictEqual(memberTransactions(rerouted.dir).length, 0, 'no member begin for a stale route');
  // A crash between the two member intents recovers in a fresh process without a second begin.
  const between = planSlice(owner('crash-intents'), independent(['T01', 'T02']));
  const start = snapshotOf('codex');
  let intents = 0;
  assert.throws(() => adapter.invoke('codex', 'auto', 'next', input(between), start, { failpoint: name => name === 'after-intent' && ++intents === 2 }),
    error => error && error.code === 'CONTROLLER_FAILPOINT');
  const partial = memberTransactions(between);
  assert.deepStrictEqual(partial.map(record => [record.unit.key, record.phase]), [['execute-task/T01', 'committed'], ['execute-task/T02', 'intent']]);
  const committedBytes = fs.readFileSync(controller.transactionFile(between, partial[0].idempotency_key));
  const recovered = freshNext('codex', between, start);
  const recoveredBatch = assertBatch(recovered, ['T01', 'T02'], 'fresh-process recovery between intents');
  assert.deepStrictEqual([recoveredBatch.replay, recovered.snapshot.step_count], [true, 2]);
  assert.deepStrictEqual(memberTransactions(between).map(record => record.phase), ['committed', 'committed']);
  assert(fs.readFileSync(controller.transactionFile(between, partial[0].idempotency_key)).equals(committedBytes), 'the committed member never begins twice');
  assert.deepStrictEqual(memberEvents(between).map(event => event.unit).sort(), ['execute-task/T01', 'execute-task/T02'], 'one begin event per member');
  assert.deepStrictEqual(batch.readProgress(between, batch.readManifest(between, recoveredBatch.batch_id)).map(row => row.state), ['admitido', 'admitido']);
  assert.notStrictEqual(held(between, 'execute-task/T01').generation, held(between, 'execute-task/T02').generation, 'distinct live leases');
});

test('integration R1 existing later batch member with missing or foreign lease blocks before earlier new begin', () => {
  for (const condition of ['absent', 'foreign']) {
    const fixture = crashed('later-member-lease-' + condition), dir = fixture.dir;
    const manifest = batch.readManifest(dir, fixture.batchId);
    const request = member => ({ milestone: M, unit: member.unit, slice: S,
      state_patch: { active_slice: S, active_task: manifest.primary.task_id }, host_runtime: 'codex',
      owner_token: TOKEN, idempotency_key: member.begin_key, batch: batch.memberBinding(manifest, member) });
    // A genuine canonical later begin, not an imported or resealed transaction.
    const later = manifest.members[1], admitted = controller.begin(dir, { members: [request(later)] }, {});
    assert.strictEqual(admitted.members[0].ok, true, condition + ': later member really began');
    const begun = controller.lookupRecord(dir, 'transaction', later.begin_key);
    assert.strictEqual(begun.phase, 'committed');
    assert.strictEqual(lease.release(dir, later.unit, TOKEN, begun.lease_generation).ok, true);
    if (condition === 'foreign') assert.strictEqual(lease.acquire(dir, later.unit,
      { ownerToken: 'foreign-later-owner', requestId: 'foreign-later-request', hostRuntime: 'codex' }).ok, true);
    const leaseFile = lease.leaseFile(dir, later.unit), leaseBefore = fs.existsSync(leaseFile) ? fs.readFileSync(leaseFile) : null;
    const beginBefore = fs.readFileSync(controller.transactionFile(dir, later.begin_key));
    const eventsBefore = fs.readFileSync(controller.eventsFile(dir, M)), stateBefore = fs.readFileSync(state.statePath(dir, M));
    const earlier = manifest.members[0];
    assert.strictEqual(controller.lookupRecord(dir, 'transaction', earlier.begin_key), null);
    assert.strictEqual(held(dir, earlier.unit), null);
    assert.throws(() => controller.begin(dir, { members: manifest.members.map(request) }, {}),
      error => error && error.code === (condition === 'absent' ? 'lease-required' : 'lease-owner-mismatch'),
      condition + ': invalid later lease is checked before any earlier begin');
    assert.strictEqual(controller.lookupRecord(dir, 'transaction', earlier.begin_key), null, condition + ': no earlier begin');
    assert.strictEqual(held(dir, earlier.unit), null, condition + ': no earlier lease');
    assert.strictEqual(memberTransactions(dir).length, 1, condition + ': only the genuine later begin remains');
    assert(fs.readFileSync(controller.transactionFile(dir, later.begin_key)).equals(beginBefore), condition + ': later begin immutable');
    assert(fs.readFileSync(controller.eventsFile(dir, M)).equals(eventsBefore), condition + ': no new event');
    assert(fs.readFileSync(state.statePath(dir, M)).equals(stateBefore), condition + ': STATE unchanged');
    if (leaseBefore) assert(fs.readFileSync(leaseFile).equals(leaseBefore), 'foreign lease bytes remain untouched');
    else assert.strictEqual(fs.existsSync(leaseFile), false, 'missing lease is not silently recreated');
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
for (const [name, value] of Object.entries(SAVED_ENV)) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best-effort cleanup of synthetic fixtures */ }
if (failed) process.exitCode = 1;
