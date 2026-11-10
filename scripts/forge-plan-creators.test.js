#!/usr/bin/env node
'use strict';

// forge-plan-creators.test.js — issue 343 U0e: the owner mutation gates of the direct
// creators (add-task, add-slice, decompose) in scripts/forge-plan-validation.js, driven
// through real subprocesses of its CLI (begin-mutation, finish-mutation, check).
//
//   U0e-1 add-task begin/write/finish admits a valid decimal addition without a new run;
//   U0e-2 a missing-field addition stays unready after restart and creates no receipt;
//   U0e-3 add-slice needs a fully valid graph and decompose keeps the original plan except
//         DECOMPOSED (and only at a safe owner boundary);
//   U0e-4 legacy mixed slice: strict new subset, sequential slice, no backfill;
//   plus the mutation chain itself: exact records bound to their owner, failing closed.
//
// Enrolled slices are planned and completed by the real controller (begin/complete); the
// execute readiness is observed through the real controller begin, in process and in a
// fresh process. The only rewritten records are the named forgeries of the chain test.
// Everything is synthetic and local: no provider, network or operator history.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const controller = require('./forge-unit-controller');
const state = require('./forge-state');
const lease = require('./forge-unit-lease');
const repair = require('./forge-repair');
const pv = require('./forge-plan-validation');

const MODULE = path.join(__dirname, 'forge-plan-validation.js');
const PARALLELISM = path.join(__dirname, 'forge-parallelism.js');
const CONTROLLER = path.join(__dirname, 'forge-unit-controller.js');
const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-plan-creators-')));
const M = 'M-20261108000000-plan-creators';
const S = 'S01';
const HOST = 'claude';
const LINK = process.platform === 'win32' ? 'junction' : 'dir';
const PREFS = { workflow: { skip_discuss: true, skip_research: true }, plan_gate: { interactive: false, ask_in_auto: false } };
const prefsReader = () => ({ ok: true, prefs: PREFS });

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
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}
// The chain record checksum (sha256 of the sorted-key JSON without record_sha256), used only
// to recompose a deliberate self-consistent forgery.
function recordDigest(record) {
  const { record_sha256: _digest, ...content } = record;
  return sha(JSON.stringify(stable(content)));
}
function bytesOf(file) { return fs.existsSync(file) ? sha(fs.readFileSync(file)) : null; }
function held(dir, unit) { return lease.observe(dir, unit).lease; }
// A named refusal of the module API.
function refuses(fn, code, label) {
  let caught = null;
  let value;
  try { value = fn(); } catch (error) { caught = error; }
  assert(caught, `${label}: expected ${code}, got ${JSON.stringify(value)}`);
  assert.strictEqual(caught.code, code, `${label}: ${caught && caught.message}`);
  assert(pv.CODES.includes(code) || code.startsWith('plan-declaration-'), `${label}: ${code} is a named refusal`);
  return caught;
}
// Every file and directory of a tree, with file digests.
function tree(root) {
  const out = {};
  const visit = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name), name = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out[`${name}/`] = 'directory';
        visit(file, name);
      } else out[name] = sha(fs.readFileSync(file));
    }
  };
  visit(root, '');
  return out;
}
function changes(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => before[key] !== after[key]).sort();
}

// ── Synthetic plans ───────────────────────────────────────────────────────────

// A new task plan with explicit declarations and the structured must_haves the strict product
// parser admits. `depends` is the frontmatter line (null omits it), `writes: null` omits the
// writes key and `head` adds frontmatter lines (imported flags, for instance).
function taskPlan(id, options = {}) {
  const file = options.file || `src/${id.toLowerCase().replace('.', '-')}.js`;
  const lines = ['---', 'tier: standard', ...(options.head || [])];
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

// ── Owner fixtures ────────────────────────────────────────────────────────────

let sequence = 0;
function owner(label) {
  const dir = path.join(TMP, `${label}-${++sequence}`);
  fs.mkdirSync(path.join(dir, '.gsd', 'milestones', M), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gsd', 'milestones', M, `${M}-ROADMAP.md`), `# Roadmap\n\n- [ ] **${S}: Work** \`depends:[]\`\n`);
  state.write(dir, { milestone: M, kind: 'milestone', phase: 'idle', active_slice: '—', active_task: '—', next_action: 'plan', auto_mode: 'on' });
  return dir;
}
function sliceDir(dir, slice = S) { return path.join(dir, '.gsd', 'milestones', M, 'slices', slice); }
function sliceFile(dir, slice = S) { return path.join(sliceDir(dir, slice), `${slice}-PLAN.md`); }
function taskFile(dir, id, slice = S) { return path.join(sliceDir(dir, slice), 'tasks', id, `${id}-PLAN.md`); }
function writeSlice(dir, content, slice = S) {
  fs.mkdirSync(sliceDir(dir, slice), { recursive: true });
  fs.writeFileSync(sliceFile(dir, slice), content);
}
function writeTask(dir, id, content, slice = S) {
  fs.mkdirSync(path.dirname(taskFile(dir, id, slice)), { recursive: true });
  fs.writeFileSync(taskFile(dir, id, slice), content);
}
function writePlan(dir, tasks, slice = S) {
  writeSlice(dir, slicePlan(Object.keys(tasks), slice), slice);
  for (const [id, content] of Object.entries(tasks)) writeTask(dir, id, content, slice);
}
// An enrolled slice planned and completed by the real controller (the U0d evidence).
function planned(label, tasks) {
  const dir = owner(label), unit = `plan-slice/${S}`;
  const begun = controller.begin(dir, { milestone: M, unit, slice: S, state_patch: { active_slice: S }, host_runtime: HOST,
    owner_token: `owner-${label}`, session: 'session-neutral', idempotency_key: `plan-begin-${label}` }, { prefsReader });
  assert.strictEqual(begun.ok, true, JSON.stringify(begun));
  writePlan(dir, tasks);
  const completed = controller.transition(dir, { action: 'complete', milestone: M, unit, host_runtime: HOST, owner_token: begun.owner_token,
    generation: begun.generation, idempotency_key: `plan-complete-${label}`, result: { status: 'succeeded', summary: 'planned' } }, { prefsReader });
  assert.strictEqual(completed.transaction.phase, 'committed');
  return { dir, validationKey: `plan-complete-${label}` };
}
function beginExecute(dir, task, key) {
  return controller.begin(dir, { milestone: M, unit: `execute-task/${task}`, slice: S, state_patch: { active_slice: S }, host_runtime: HOST,
    owner_token: `owner-${key}`, session: 'session-neutral', idempotency_key: key }, { prefsReader });
}
// The real controller begin in a fresh process (a restart sees only durable records).
function freshExecute(dir, task, key) {
  const script = [
    'const controller = require(process.argv[1]);',
    'const prefsReader = () => ({ ok: true, prefs: { workflow: { skip_discuss: true, skip_research: true } } });',
    'let out;',
    'try {',
    '  const begun = controller.begin(process.argv[2], { milestone: process.argv[3], unit: "execute-task/" + process.argv[4],',
    '    slice: process.argv[5], state_patch: { active_slice: process.argv[5] }, host_runtime: "claude", owner_token: "owner-" + process.argv[6],',
    '    session: "session-neutral", idempotency_key: process.argv[6] }, { prefsReader });',
    '  out = { ok: begun.ok === true, code: null, stage: null };',
    '} catch (error) {',
    '  const plan = error && error.details && error.details.plan_generation;',
    '  out = { ok: false, code: error && error.code, stage: plan ? plan.stage : null };',
    '}',
    'process.stdout.write(JSON.stringify(out));',
  ].join('\n');
  const child = spawnSync(process.execPath, ['-e', script, CONTROLLER, dir, M, task, S, key], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.strictEqual(child.status, 0, child.stderr || String(child.error));
  return JSON.parse(child.stdout);
}
function chainDir(dir, slice = S) { return path.join(dir, '.gsd', 'forge', 'plan-validations', M, slice); }
function chainNames(dir, slice = S) { return fs.existsSync(chainDir(dir, slice)) ? fs.readdirSync(chainDir(dir, slice)).sort() : []; }
function chainFile(dir, number, slice = S) { return path.join(chainDir(dir, slice), `${String(number).padStart(4, '0')}.json`); }
function find(root, predicate) {
  return Object.keys(tree(root)).filter(name => !name.endsWith('/') && predicate(name));
}
function transactionCount(dir) {
  const directory = controller.transactionDir(dir);
  return fs.existsSync(directory) ? fs.readdirSync(directory).length : 0;
}

// ── The real CLI ──────────────────────────────────────────────────────────────

function cli(args) {
  const child = spawnSync(process.execPath, [MODULE, ...args], { encoding: 'utf8', cwd: TMP, timeout: 60000, windowsHide: true });
  let out = null;
  try { out = JSON.parse(child.stdout); } catch (_) { out = null; }
  return { status: child.status, out, stdout: child.stdout, stderr: child.stderr };
}
function begin(dir, operation, tasks, options = {}) {
  return cli(['begin-mutation', '--cwd', dir, '--operation', operation, '--milestone', M, '--slice', options.slice || S,
    ...tasks.flatMap(id => ['--task', id]), ...(options.parent ? ['--parent', options.parent] : []), '--owner', options.owner || dir]);
}
function finish(dir, ref) { return cli(['finish-mutation', '--cwd', dir, '--ref', ref]); }
function check(dir, slice = S) { return cli(['check', '--cwd', dir, '--milestone', M, '--slice', slice]); }
function ok(result, label) {
  assert.strictEqual(result.status, 0, `${label}: ${result.stdout || result.stderr}`);
  assert.strictEqual(result.out && result.out.ok, true, `${label}: ${result.stdout}`);
  return result.out;
}
function refused(result, code, label) {
  assert.strictEqual(result.status, 1, `${label}: expected ${code}, got ${result.stdout || result.stderr}`);
  assert.deepStrictEqual([result.out && result.out.ok, result.out && result.out.code], [false, code], `${label}: ${result.stdout}`);
  assert(pv.CODES.includes(code) || code.startsWith('plan-declaration-'), `${label}: ${code} is a named refusal`);
  return result.out;
}

console.log('\n=== forge-plan-creators.test.js ===\n');

// ── U0e-1 ─────────────────────────────────────────────────────────────────────

test('issue343 U0e-1 add-task begin/write/finish admits a valid decimal addition without a new run', () => {
  const f = planned('u0e1', VALID());
  const dir = f.dir, scope = { milestone: M, slice: S, validation_key: f.validationKey };
  const first = pv.assertCurrentGeneration(dir, scope);
  const before = tree(dir), events = bytesOf(controller.eventsFile(dir, M)), transactions = transactionCount(dir);
  // Begin: the owner intent exists before any plan byte is written.
  const begun = ok(begin(dir, 'add-task', ['T01.1']), 'begin').mutation;
  assert.deepStrictEqual([begun.status, begun.operation, begun.changed_task_ids, begun.parent_task_id, begun.sequence],
    ['begun', 'add-task', ['T01.1'], null, 1]);
  assert.deepStrictEqual([begun.base.kind, begun.base.validation_key, begun.base.semantic_sha256], ['completed', f.validationKey, first.semantic_sha256]);
  assert.deepStrictEqual(begun.targets, { slice_plan: `.gsd/milestones/${M}/slices/${S}/${S}-PLAN.md`,
    task_plans: [{ id: 'T01.1', path: `.gsd/milestones/${M}/slices/${S}/tasks/T01.1/T01.1-PLAN.md` }] });
  assert.match(begun.mutation_ref, new RegExp(`^${M}:${S}:0001:[a-f0-9]{64}$`));
  assert.deepStrictEqual(chainNames(dir), ['0001.json']);
  // While it is open nothing of the milestone is ready, in another process or in this one.
  const pending = refused(check(dir), 'plan-mutation-pending', 'check while open');
  assert.strictEqual(pending.mutation_ref, begun.mutation_ref);
  const blocked = refuses(() => beginExecute(dir, 'T01', 'u0e1-execute-open'), 'plan-mutation-pending', 'execute while open');
  assert.strictEqual(blocked.details.plan_generation.stage, 'execute-begin');
  assert.strictEqual(held(dir, 'execute-task/T01'), null, 'no executor lease');
  assert(!fs.existsSync(controller.transactionFile(dir, 'u0e1-execute-open')), 'no execute record');
  refuses(() => pv.assertCurrentGeneration(dir, scope), 'plan-mutation-pending', 'the generation is in flux');
  // The creator's direct writes: the decimal task between T01 and T02.
  writeTask(dir, 'T01.1', taskPlan('T01.1', { depends: 'depends: [T01]' }));
  writeSlice(dir, slicePlan(['T01', 'T01.1', 'T02']));
  const admission = ok(finish(dir, begun.mutation_ref), 'finish').admission;
  assert.deepStrictEqual([admission.status, admission.operation, admission.sequence, admission.graph_status, admission.task_ids,
    admission.added_task_ids, admission.legacy_task_ids], ['admitted', 'add-task', 2, 'valid', ['T01', 'T01.1', 'T02'], ['T01.1'], []]);
  assert.strictEqual(admission.mutation_ref, begun.mutation_ref, 'the admission names its intent');
  // A repeated finish replays the admission; nothing is appended twice.
  const replayed = ok(finish(dir, begun.mutation_ref), 'replay').admission;
  assert.deepStrictEqual([replayed.status, replayed.admission_sha256], ['replayed', admission.admission_sha256]);
  assert.deepStrictEqual(chainNames(dir), ['0001.json', '0002.json']);
  refused(begin(dir, 'add-task', ['T01.1']), 'plan-mutation-task-exists', 'the admitted task is no longer new');
  // assertCurrentGeneration now considers the last admitted amendment.
  const current = pv.assertCurrentGeneration(dir, scope);
  assert.deepStrictEqual([current.status, current.semantic_sha256, current.task_ids, current.amendment],
    ['current', admission.semantic_sha256, ['T01', 'T01.1', 'T02'], { sequence: 2, admission_sha256: admission.admission_sha256, operation: 'add-task' }]);
  assert.notStrictEqual(current.semantic_sha256, first.semantic_sha256, 'the membership changed by admission');
  const ready = ok(check(dir), 'check after admission');
  assert.deepStrictEqual([ready.readiness.status, ready.mutations.records, ready.mutations.open, ready.mutations.last_admission.sequence],
    ['current', 2, null, 2]);
  // Without a new run: exactly the creator's writes and the two chain records changed.
  const chain = `.gsd/forge/plan-validations`;
  assert.deepStrictEqual(changes(before, tree(dir)), [
    `${chain}/`, `${chain}/.staging/`, `${chain}/${M}/`, `${chain}/${M}/${S}/`, `${chain}/${M}/${S}/0001.json`, `${chain}/${M}/${S}/0002.json`,
    `.gsd/milestones/${M}/slices/${S}/${S}-PLAN.md`, `.gsd/milestones/${M}/slices/${S}/tasks/T01.1/`,
    `.gsd/milestones/${M}/slices/${S}/tasks/T01.1/T01.1-PLAN.md`].sort());
  assert.deepStrictEqual([bytesOf(controller.eventsFile(dir, M)), transactionCount(dir)], [events, transactions], 'no event or controller record');
  assert.deepStrictEqual(find(dir, name => /receipt/i.test(name) || name.startsWith('.gsd/forge/runs/')), [], 'no receipt and no run');
  // An unadmitted semantic edit after the admission is drift.
  const t011 = fs.readFileSync(taskFile(dir, 'T01.1'));
  fs.writeFileSync(taskFile(dir, 'T01.1'), t011.toString('utf8').replace('depends: [T01]', 'depends: []'));
  try { refuses(() => pv.assertCurrentGeneration(dir, scope), 'plan-generation-drift', 'an unadmitted edit'); }
  finally { fs.writeFileSync(taskFile(dir, 'T01.1'), t011); }
  // The admitted decimal task is ready: the real controller begins it.
  const executed = beginExecute(dir, 'T01.1', 'u0e1-execute-decimal');
  assert.strictEqual(executed.ok, true, JSON.stringify(executed));
  assert(held(dir, 'execute-task/T01.1'), 'the decimal task holds its executor lease');
});

// ── U0e-2 ─────────────────────────────────────────────────────────────────────

test('issue343 U0e-2 a missing-field addition stays unready after restart and creates no receipt', () => {
  const f = planned('u0e2', VALID());
  const dir = f.dir;
  const transactions = transactionCount(dir), events = bytesOf(controller.eventsFile(dir, M));
  const begun = ok(begin(dir, 'add-task', ['T03']), 'begin').mutation;
  const intentBytes = fs.readFileSync(chainFile(dir, 1));
  writeSlice(dir, slicePlan(['T01', 'T02', 'T03']));
  // Every missing or invalid declaration refuses by name; nothing is appended, and the intent
  // and the candidate stay for correction. Imported flags waive nothing.
  const cases = [
    ['writes missing', taskPlan('T03', { depends: 'depends: [T02]', writes: null }), 'plan-declaration-writes-missing'],
    ['depends missing', taskPlan('T03', { depends: null }), 'plan-declaration-depends-missing'],
    ['legacy prose without must_haves', '# T03: legacy prose\n\nNo declarations.\n', 'plan-must-haves-legacy'],
    ['imported approved and legacy flags', taskPlan('T03', { depends: 'depends: [T02]', writes: null, head: ['approved: true', 'legacy: true'] }),
      'plan-declaration-writes-missing'],
    ['an unknown reference', taskPlan('T03', { depends: 'depends: [T09]' }), 'plan-dag-invalid'],
    ['a protected product path', taskPlan('T03', { depends: 'depends: [T02]', file: '.gsd/STATE.md' }), 'plan-must-haves-invalid', 'root-path-protected'],
  ];
  for (const [label, content, code, cause] of cases) {
    writeTask(dir, 'T03', content);
    const out = refused(finish(dir, begun.mutation_ref), code, label);
    if (cause) assert.strictEqual(out.cause_code, cause, `${label}: cause`);
    assert.deepStrictEqual(chainNames(dir), ['0001.json'], `${label}: no admission is appended`);
    assert(fs.readFileSync(chainFile(dir, 1)).equals(intentBytes), `${label}: the intent is preserved`);
    assert.strictEqual(fs.readFileSync(taskFile(dir, 'T03'), 'utf8'), content, `${label}: the candidate stays for correction`);
  }
  assert.strictEqual(cli(['finish-mutation', '--cwd', dir, '--ref', begun.mutation_ref, '--approved', 'true']).status, 2, 'no approval flag exists');
  // Restart: fresh processes still see the milestone unready, with no executor lease.
  const pending = refused(check(dir), 'plan-mutation-pending', 'check after restart');
  assert.strictEqual(pending.mutation_ref, begun.mutation_ref, 'the open intent is recoverable by its reference');
  assert.deepStrictEqual(freshExecute(dir, 'T01', 'u0e2-execute-restart'), { ok: false, code: 'plan-mutation-pending', stage: 'execute-begin' });
  assert.strictEqual(held(dir, 'execute-task/T01'), null);
  // The same begin replays the open intent; another mutation of the milestone waits for it.
  const again = ok(begin(dir, 'add-task', ['T03']), 'replayed begin').mutation;
  assert.deepStrictEqual([again.status, again.mutation_ref], ['replayed', begun.mutation_ref]);
  refused(begin(dir, 'add-task', ['T04']), 'plan-mutation-pending', 'another addition while open');
  refused(begin(dir, 'decompose', ['T02.1'], { parent: 'T02' }), 'plan-mutation-pending', 'a decompose while open');
  // No receipt, run, controller record or event was created by the mutation.
  assert.deepStrictEqual(find(dir, name => /receipt/i.test(name) || name.startsWith('.gsd/forge/runs/')), [], 'no receipt and no run');
  assert.deepStrictEqual([transactionCount(dir), bytesOf(controller.eventsFile(dir, M))], [transactions, events]);
  // Correction: a known task's repair_count (bytes, not declarations) may change meanwhile;
  // the corrected candidate is admitted by the same intent, in a fresh process.
  assert.strictEqual(repair.incrementRepairCount(taskFile(dir, 'T01')), 1);
  writeTask(dir, 'T03', taskPlan('T03', { depends: 'depends: [T02]' }));
  const admission = ok(finish(dir, begun.mutation_ref), 'corrected finish').admission;
  assert.deepStrictEqual([admission.status, admission.added_task_ids, admission.graph_status], ['admitted', ['T03'], 'valid']);
  assert.strictEqual(ok(check(dir), 'ready').readiness.status, 'current');
  const executed = freshExecute(dir, 'T01', 'u0e2-execute-ready');
  assert.strictEqual(executed.ok, true, JSON.stringify(executed));
});

// ── U0e-3 ─────────────────────────────────────────────────────────────────────

test('issue343 U0e-3 add-slice needs a fully valid graph and decompose keeps the original plan except DECOMPOSED', () => {
  const f = planned('u0e3', { T01: taskPlan('T01'), T02: taskPlan('T02', { depends: 'depends: [T01]' }),
    T03: taskPlan('T03', { depends: 'depends: [T02]' }) });
  const dir = f.dir, S2 = 'S02';
  // add-slice: only a new slice, admitted only as a complete and fully valid graph.
  refused(begin(dir, 'add-slice', ['T01']), 'plan-mutation-slice-exists', 'an existing slice');
  const created = ok(begin(dir, 'add-slice', ['T01', 'T02'], { slice: S2 }), 'add-slice begin').mutation;
  assert.deepStrictEqual([created.base.kind, created.base.semantic_sha256], ['unenrolled', null]);
  refused(check(dir, S), 'plan-mutation-pending', 'S01 waits for the open S02 creation');
  writeSlice(dir, slicePlan(['T01', 'T02'], S2), S2);
  const invalidSlices = [
    ['an unknown reference', { T01: taskPlan('T01'), T02: taskPlan('T02', { depends: 'depends: [T05]' }) }, 'plan-dag-invalid'],
    ['a cycle', { T01: taskPlan('T01', { depends: 'depends: [T02]' }), T02: taskPlan('T02', { depends: 'depends: [T01]' }) }, 'plan-dag-invalid'],
    ['a task without depends', { T01: taskPlan('T01'), T02: taskPlan('T02', { depends: null }) }, 'plan-declaration-depends-missing'],
    ['a legacy task', { T01: taskPlan('T01'), T02: '# T02: legacy prose\n' }, 'plan-must-haves-legacy'],
  ];
  for (const [label, plans, code] of invalidSlices) {
    for (const [id, content] of Object.entries(plans)) writeTask(dir, id, content, S2);
    refused(finish(dir, created.mutation_ref), code, `add-slice: ${label}`);
    assert.deepStrictEqual(chainNames(dir, S2), ['0001.json'], `add-slice ${label}: nothing is appended`);
  }
  writeSlice(dir, slicePlan(['T01', 'T02', 'T03'], S2), S2);
  writeTask(dir, 'T03', taskPlan('T03'), S2);
  writeTask(dir, 'T01', taskPlan('T01'), S2);
  writeTask(dir, 'T02', taskPlan('T02', { depends: 'depends: [T01]' }), S2);
  refused(finish(dir, created.mutation_ref), 'plan-mutation-delta-mismatch', 'add-slice: an undeclared listed task');
  fs.rmSync(path.dirname(taskFile(dir, 'T03', S2)), { recursive: true, force: true });
  writeSlice(dir, slicePlan(['T01', 'T02'], S2), S2);
  const slice = ok(finish(dir, created.mutation_ref), 'add-slice finish').admission;
  assert.deepStrictEqual([slice.graph_status, slice.task_ids, slice.added_task_ids, slice.legacy_task_ids], ['valid', ['T01', 'T02'], ['T01', 'T02'], []]);
  assert.strictEqual(ok(check(dir, S2), 'the new slice').readiness.status, 'unenrolled');

  // decompose: only at a safe owner boundary. A running execute-task of the milestone defers it.
  const running = beginExecute(dir, 'T02', 'u0e3-execute-running');
  assert.strictEqual(running.ok, true, JSON.stringify(running));
  const deferred = refused(begin(dir, 'decompose', ['T02.1', 'T02.2'], { parent: 'T02' }), 'plan-mutation-boundary-deferred', 'a running executor');
  assert.match(String(deferred.cause_code), /^(begin-open|lease-active|transaction-pending)$/);
  assert.deepStrictEqual(chainNames(dir), [], 'no intent outside a safe boundary');
  const paused = controller.transition(dir, { action: 'pause', milestone: M, unit: 'execute-task/T02', host_runtime: HOST, owner_token: running.owner_token,
    generation: running.generation, idempotency_key: 'u0e3-execute-paused', result: { status: 'cancelled' } }, { prefsReader });
  assert.strictEqual(paused.transaction.phase, 'committed');
  // Malformed requests refuse by name before any intent.
  refused(begin(dir, 'decompose', ['T09.1'], { parent: 'T09' }), 'plan-mutation-parent-invalid', 'an unknown parent');
  refused(begin(dir, 'decompose', ['T03.1'], { parent: 'T02' }), 'plan-mutation-invalid', 'a sub-task of another parent');
  refused(begin(dir, 'decompose', ['T02.1'], { parent: 'T02.1' }), 'plan-mutation-parent-invalid', 'a decimal parent');
  refused(begin(dir, 'decompose', ['T02.1.1'], { parent: 'T02' }), 'plan-task-id-invalid', 'a sub-task id outside the local grammar');
  refused(begin(dir, 'decompose', ['T02.1']), 'plan-mutation-parent-invalid', 'no parent');
  refused(begin(dir, 'add-task', ['T04'], { parent: 'T02' }), 'plan-mutation-invalid', 'a parent outside decompose');
  assert.deepStrictEqual(chainNames(dir), []);
  const original = fs.readFileSync(taskFile(dir, 'T02'));
  const siblings = { T01: fs.readFileSync(taskFile(dir, 'T01')), T03: fs.readFileSync(taskFile(dir, 'T03')) };
  const split = ok(begin(dir, 'decompose', ['T02.1', 'T02.2'], { parent: 'T02' }), 'decompose begin').mutation;
  assert.deepStrictEqual(split.targets.task_plans.map(row => row.id), ['T02', 'T02.1', 'T02.2']);
  writeTask(dir, 'T02.1', taskPlan('T02.1', { depends: 'depends: [T01]' }));
  writeTask(dir, 'T02.2', taskPlan('T02.2', { depends: 'depends: [T02.1]' }));
  const container = [`# ${S}: Fixture slice`, '', '## Tasks', '', '- [ ] **T01**: T01 fixture task',
    '- [ ] **T02** *(DECOMPOSED — see sub-tasks below)*', '  - [ ] T02.1: first half', '  - [ ] T02.2: second half',
    '- [ ] **T03**: T03 fixture task', '', 'Slice prose.', ''].join('\n');
  const text = original.toString('utf8');
  const marked = text.replace(/^---\n/, '---\nstatus: DECOMPOSED\n');
  assert.notStrictEqual(marked, text, 'the fixture parent opens with a frontmatter fence');
  const t03 = siblings.T03.toString('utf8');
  const invalidSplits = [
    ['the parent not marked', text, container, t03, 'plan-mutation-parent-altered'],
    ['the parent marked and edited', marked.replace('Prose never counts', 'Edited prose never counts'), container, t03, 'plan-mutation-parent-altered'],
    ['the status below the first line', text.replace('tier: standard\n', 'tier: standard\nstatus: DECOMPOSED\n'), container, t03, 'plan-mutation-parent-altered'],
    ['a sibling changing its declarations', marked, container, t03.replace('depends: [T02]', 'depends: [T01]'), 'plan-mutation-known-changed'],
    ['a container line without DECOMPOSED', marked, container.replace(' *(DECOMPOSED — see sub-tasks below)*', ': split in two'), t03,
      'plan-mutation-substitution-invalid'],
    ['sub-tasks away from their container', marked, [`# ${S}: Fixture slice`, '', '## Tasks', '', '- [ ] **T01**: T01 fixture task',
      '- [ ] **T02** *(DECOMPOSED — see sub-tasks below)*', '- [ ] **T03**: T03 fixture task', '  - [ ] T02.1: first half',
      '  - [ ] T02.2: second half', ''].join('\n'), t03, 'plan-mutation-substitution-invalid'],
    ['an invalid sub-task', marked, container, t03, 'plan-declaration-writes-missing', taskPlan('T02.2', { depends: 'depends: [T02.1]', writes: null })],
  ];
  for (const [label, parent, plan, sibling, code, subtask] of invalidSplits) {
    writeTask(dir, 'T02', parent);
    writeSlice(dir, plan);
    writeTask(dir, 'T03', sibling);
    writeTask(dir, 'T02.2', subtask || taskPlan('T02.2', { depends: 'depends: [T02.1]' }));
    refused(finish(dir, split.mutation_ref), code, `decompose: ${label}`);
    assert.deepStrictEqual(chainNames(dir), ['0001.json'], `decompose ${label}: nothing is appended`);
  }
  writeTask(dir, 'T02', marked);
  writeSlice(dir, container);
  writeTask(dir, 'T03', t03);
  writeTask(dir, 'T02.2', taskPlan('T02.2', { depends: 'depends: [T02.1]' }));
  const admission = ok(finish(dir, split.mutation_ref), 'decompose finish').admission;
  assert.deepStrictEqual([admission.operation, admission.graph_status, admission.task_ids, admission.added_task_ids],
    ['decompose', 'valid', ['T01', 'T02', 'T02.1', 'T02.2', 'T03'], ['T02.1', 'T02.2']]);
  // The original plan is kept except DECOMPOSED: one inserted first line, every other byte identical.
  const after = fs.readFileSync(taskFile(dir, 'T02'));
  const line = Buffer.from('status: DECOMPOSED\n');
  assert(after.subarray(4, 4 + line.length).equals(line), 'the DECOMPOSED status is the first line of the YAML block');
  assert(Buffer.concat([after.subarray(0, 4), after.subarray(4 + line.length)]).equals(original), 'removing it restores the original bytes');
  assert(fs.readFileSync(taskFile(dir, 'T01')).equals(siblings.T01) && fs.readFileSync(taskFile(dir, 'T03')).equals(siblings.T03), 'siblings untouched');
  const current = pv.assertCurrentGeneration(dir, { milestone: M, slice: S, validation_key: f.validationKey });
  assert.deepStrictEqual([current.status, current.semantic_sha256, current.amendment.operation], ['current', admission.semantic_sha256, 'decompose']);
  assert.strictEqual(ok(check(dir, S), 'decomposed slice').readiness.status, 'current');
});

// ── U0e-4 ─────────────────────────────────────────────────────────────────────

test('issue343 historical dependencies survive owner add-task intent, admission and fresh-process replay', () => {
  const dir = owner('historical-depends');
  const original = { T01: taskPlan('T01', { writes: null }),
    T02: taskPlan('T02', { depends: 'depends: [T01]', writes: null }) };
  writePlan(dir, original);
  const intent = ok(begin(dir, 'add-task', ['T03']), 'partial known begin').mutation;
  writeSlice(dir, slicePlan(['T01', 'T02', 'T03']));
  writeTask(dir, 'T03', taskPlan('T03', { depends: 'depends: [T02]' }));
  const first = ok(finish(dir, intent.mutation_ref), 'partial known finish').admission;
  assert.strictEqual(first.graph_status, 'legacy');
  const replay = ok(finish(dir, intent.mutation_ref), 'partial known replay').admission;
  assert.strictEqual(replay.semantic_sha256, first.semantic_sha256);
  assert.strictEqual(ok(check(dir), 'partial known readmission').readiness.status, 'unenrolled');
  for (const [id, bytes] of Object.entries(original)) assert.strictEqual(fs.readFileSync(taskFile(dir, id), 'utf8'), bytes);
});

test('issue343 U0e-4 legacy mixed slice: strict new subset, sequential slice, no backfill', () => {
  // A genuine historical slice: no controller generation, two tasks without declarations
  // (one without any frontmatter) and one explicit task.
  const dir = owner('u0e4');
  const historical = {
    T01: ['---', 'tier: standard', '---', '', '# T01: historical task without declarations', ''].join('\n'),
    T02: '# T02: historical prose plan\n\nNo frontmatter at all.\n',
    T03: taskPlan('T03', { depends: 'depends: [T01]' }),
  };
  writePlan(dir, historical);
  const bytes = Object.fromEntries(Object.keys(historical).map(id => [id, fs.readFileSync(taskFile(dir, id))]));
  assert.strictEqual(pv.classifySliceGeneration(dir, { milestone: M, slice: S }).status, 'unenrolled');
  assert.strictEqual(ok(check(dir), 'historical slice').readiness.status, 'unenrolled');
  const begun = ok(begin(dir, 'add-task', ['T04', 'T05']), 'begin').mutation;
  assert.deepStrictEqual([begun.base.kind, begun.base.generation_key], ['unenrolled', null]);
  writeSlice(dir, slicePlan(['T01', 'T02', 'T03', 'T04', 'T05']));
  // The new subset is strict: each malformed addition refuses by name.
  const invalid = [
    ['a new task without writes', { T04: taskPlan('T04', { depends: 'depends: [T03]', writes: null }), T05: taskPlan('T05') }, 'plan-declaration-writes-missing'],
    ['a new task without depends', { T04: taskPlan('T04'), T05: taskPlan('T05', { depends: null }) }, 'plan-declaration-depends-missing'],
    ['legacy new output', { T04: '# T04: prose only\n', T05: taskPlan('T05') }, 'plan-must-haves-legacy'],
    ['an unknown reference', { T04: taskPlan('T04', { depends: 'depends: [T09]' }), T05: taskPlan('T05') }, 'plan-dag-invalid'],
    ['a cycle in the new subset', { T04: taskPlan('T04', { depends: 'depends: [T05]' }), T05: taskPlan('T05', { depends: 'depends: [T04]' }) }, 'plan-dag-invalid'],
  ];
  for (const [label, plans, code] of invalid) {
    for (const [id, content] of Object.entries(plans)) writeTask(dir, id, content);
    refused(finish(dir, begun.mutation_ref), code, label);
    assert.deepStrictEqual(chainNames(dir), ['0001.json'], `${label}: nothing is appended`);
  }
  // A strict subset referencing legacy and explicit known tasks is admitted; the slice stays legacy.
  writeTask(dir, 'T04', taskPlan('T04', { depends: 'depends: [T02, T03]' }));
  writeTask(dir, 'T05', taskPlan('T05', { depends: 'depends: [T04]' }));
  const admission = ok(finish(dir, begun.mutation_ref), 'finish').admission;
  assert.deepStrictEqual([admission.graph_status, admission.task_ids, admission.legacy_task_ids, admission.added_task_ids],
    ['legacy', ['T01', 'T02', 'T03', 'T04', 'T05'], ['T01', 'T02'], ['T04', 'T05']]);
  const record = JSON.parse(fs.readFileSync(chainFile(dir, 2), 'utf8'));
  assert.deepStrictEqual(record.evidence.declarations.map(entry => (entry ? entry.depends : null)), [null, null, ['T01'], ['T02', 'T03'], ['T04']]);
  // No backfill: the historical bytes stay exactly as they were.
  for (const id of Object.keys(historical)) assert(fs.readFileSync(taskFile(dir, id)).equals(bytes[id]), `${id} is not backfilled`);
  // Sequential: the batch selector keeps one legacy task at a time.
  const selector = spawnSync(process.execPath, [PARALLELISM, '--slice-plan', sliceFile(dir)], { encoding: 'utf8', cwd: TMP, timeout: 60000, windowsHide: true });
  assert.strictEqual(selector.status, 0, selector.stderr);
  const batch = JSON.parse(selector.stdout);
  assert.deepStrictEqual([batch.mode, batch.batch.map(item => item.id)], ['legacy', ['T01']], selector.stdout);
  // The historical slice keeps its execute behavior once the mutation is admitted.
  const ready = ok(check(dir), 'admitted legacy slice');
  assert.deepStrictEqual([ready.readiness.status, ready.mutations.last_admission.graph_status], ['unenrolled', 'legacy']);
  // A malformed known declaration refuses the next mutation before any intent exists.
  fs.writeFileSync(taskFile(dir, 'T01'), historical.T01.replace('tier: standard', 'tier: standard\ndepends: T00'));
  try {
    refused(begin(dir, 'add-task', ['T06']), 'plan-known-invalid', 'a malformed known declaration');
    assert.deepStrictEqual(chainNames(dir), ['0001.json', '0002.json'], 'no intent is published');
  } finally { fs.writeFileSync(taskFile(dir, 'T01'), bytes.T01); }
});

// ── The mutation chain ────────────────────────────────────────────────────────

test('issue343 U0e the mutation chain is exact, bound to its owner and fails closed', () => {
  const f = planned('chain', VALID());
  const dir = f.dir;
  // Requests are closed: no imported field, operation or foreign owner binding is accepted.
  const request = { operation: 'add-task', milestone: M, slice: S, changedTaskIds: ['T03'], ownerBinding: { owner: dir } };
  refuses(() => pv.beginOwnerPlanMutation(dir, { ...request, approved: true }), 'plan-mutation-invalid', 'an imported approved flag');
  refuses(() => pv.beginOwnerPlanMutation(dir, { ...request, operation: 'replace-plan' }), 'plan-mutation-invalid', 'an unknown operation');
  refuses(() => pv.beginOwnerPlanMutation(dir, { ...request, ownerBinding: { owner: TMP } }), 'plan-mutation-owner-mismatch', 'another owner');
  refuses(() => pv.beginOwnerPlanMutation(dir, { ...request, ownerBinding: { owner: dir, legacy: true } }), 'plan-mutation-invalid', 'a binding flag');
  refuses(() => pv.beginOwnerPlanMutation(dir, { ...request, changedTaskIds: ['T01'] }), 'plan-mutation-task-exists', 'a known task as new');
  refuses(() => pv.beginOwnerPlanMutation(dir, { ...request, changedTaskIds: ['../T03'] }), 'plan-task-id-invalid', 'an unsafe task id');
  refuses(() => pv.finishOwnerPlanMutation(dir, 'not-a-reference'), 'plan-mutation-ref-invalid', 'a malformed reference');
  assert.strictEqual(cli(['begin-mutation', '--cwd', dir, '--operation', 'add-task', '--milestone', M, '--slice', S, '--task', 'T03']).status, 2,
    'the owner binding is a required argument');
  assert.strictEqual(cli(['check', '--cwd', dir]).status, 2, 'check requires its slice');
  assert.deepStrictEqual(chainNames(dir), [], 'no refused request wrote a record');
  // One admitted mutation, then named forgeries of its records.
  const begun = ok(begin(dir, 'add-task', ['T03']), 'begin').mutation;
  writeTask(dir, 'T03', taskPlan('T03', { depends: 'depends: [T02]' }));
  writeSlice(dir, slicePlan(['T01', 'T02', 'T03']));
  ok(finish(dir, begun.mutation_ref), 'finish');
  refused(finish(dir, begun.mutation_ref.replace(/[a-f0-9]{64}$/, 'b'.repeat(64))), 'plan-mutation-ref-invalid', 'a reference to another intent');
  const files = [chainFile(dir, 1), chainFile(dir, 2)], original = files.map(file => fs.readFileSync(file));
  const restore = () => files.forEach((file, index) => fs.writeFileSync(file, original[index]));
  const gate = () => pv.assertSliceGeneration(dir, { milestone: M, slice: S });
  assert.strictEqual(gate().status, 'current');
  const forgeries = [
    ['an admission edited under its checksum', 1, record => { record.evidence.graph_status = 'legacy'; }, false, 'plan-mutation-evidence-invalid', 'record-conflict'],
    ['an approved flag on the intent', 0, record => { record.approved = true; }, true, 'plan-mutation-evidence-invalid'],
    ['a forged semantic digest', 1, record => { record.evidence.semantic_sha256 = 'a'.repeat(64); }, true, 'plan-mutation-evidence-invalid'],
    ['a forged declaration', 1, record => { record.evidence.declarations[2].depends = []; }, true, 'plan-mutation-evidence-invalid'],
    ['an imported legacy declaration', 1, record => { record.evidence.declarations[2] = null; }, true, 'plan-mutation-evidence-invalid'],
    ['another admitted task set', 1, record => { record.evidence.added_task_ids = ['T02']; }, true, 'plan-mutation-evidence-invalid'],
    ['another owner', 0, record => { record.owner = 'c:/elsewhere/owner'; }, true, 'plan-mutation-owner-mismatch'],
  ];
  for (const [label, index, mutate, recompose, code, cause] of forgeries) {
    const record = JSON.parse(original[index].toString('utf8'));
    mutate(record);
    if (recompose) record.record_sha256 = recordDigest(record);
    fs.writeFileSync(files[index], `${JSON.stringify(record)}\n`);
    try {
      const error = refuses(() => gate(), code, label);
      if (cause) assert.strictEqual(error.cause_code, cause, `${label}: cause`);
      refused(check(dir), code, `${label}: check`);
    } finally { restore(); }
  }
  assert.strictEqual(gate().status, 'current', 'the genuine chain still holds');
  // Unknown entries, a missing record and a link refuse; nothing is repaired.
  fs.writeFileSync(path.join(chainDir(dir), 'notes.txt'), 'not a record\n');
  try { refuses(() => gate(), 'plan-mutation-evidence-invalid', 'an unknown chain entry'); }
  finally { fs.rmSync(path.join(chainDir(dir), 'notes.txt')); }
  fs.renameSync(files[0], `${files[0]}.moved`);
  try { refuses(() => gate(), 'plan-mutation-evidence-invalid', 'a missing record'); }
  finally { fs.renameSync(`${files[0]}.moved`, files[0]); }
  const chains = path.join(dir, '.gsd', 'forge', 'plan-validations'), foreign = path.join(TMP, `foreign-chains-${++sequence}`);
  fs.renameSync(chains, foreign);
  fs.symlinkSync(foreign, chains, LINK);
  try { assert.strictEqual(refuses(() => gate(), 'plan-mutation-evidence-invalid', 'a linked chain root').cause_code, 'link'); }
  finally { fs.unlinkSync(chains); fs.renameSync(foreign, chains); }
  assert.strictEqual(gate().status, 'current');
  // A copied owner tree never continues or passes a mutation of the original.
  const next = ok(begin(dir, 'add-task', ['T04']), 'second begin').mutation;
  const copied = path.join(TMP, `chain-copy-${++sequence}`);
  fs.cpSync(dir, copied, { recursive: true });
  writeTask(copied, 'T04', taskPlan('T04', { depends: 'depends: [T03]' }));
  writeSlice(copied, slicePlan(['T01', 'T02', 'T03', 'T04']));
  refused(finish(copied, next.mutation_ref), 'plan-mutation-owner-mismatch', 'finish on a copied owner');
  refuses(() => pv.assertSliceGeneration(copied, { milestone: M, slice: S }), 'plan-mutation-owner-mismatch', 'the gate on a copied owner');
  // An interrupted publication (a leftover staging record) is reconciled by the next one.
  const staging = path.join(chains, '.staging'), leftover = path.join(staging, `0004.json.4242.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(leftover, 'interrupted publication\n');
  writeTask(dir, 'T04', taskPlan('T04', { depends: 'depends: [T03]' }));
  writeSlice(dir, slicePlan(['T01', 'T02', 'T03', 'T04']));
  ok(finish(dir, next.mutation_ref), 'finish after an interrupted publication');
  assert(!fs.existsSync(leftover), 'the leftover staging record was reconciled');
  assert.deepStrictEqual([chainNames(dir), fs.readdirSync(staging)], [['0001.json', '0002.json', '0003.json', '0004.json'], []]);
  const current = pv.assertCurrentGeneration(dir, { milestone: M, slice: S, validation_key: f.validationKey });
  assert.deepStrictEqual([current.task_ids, current.amendment.sequence], [['T01', 'T02', 'T03', 'T04'], 4], 'the last admitted amendment is the anchor');
});

console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); } catch { /* best-effort cleanup of synthetic fixtures */ }
if (failed) process.exitCode = 1;
