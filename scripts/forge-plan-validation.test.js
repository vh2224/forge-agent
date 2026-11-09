#!/usr/bin/env node
'use strict';

// forge-plan-validation.test.js — issue 343 U0b: the shared strict admission of newly
// generated slice plans (scripts/forge-plan-validation.js).
//
//   U0b-1 a returned candidate and the owner files written from it yield identical
//         declarations, source SHA and graph digest;
//   U0b-2 the owner collector refuses links, junctions, unstable, oversized,
//         non-UTF-8, unsafe IDs and nested/flat conflicts, and reads only the S-plan
//         and the T-plans it lists;
//   U0b-3 the pure validators reach no prefs, provider, lease, claim or file-system
//         write (measured in a fresh process);
//   U0b-4 the semantic digest ignores checkbox and repair_count and changes with
//         depends, writes, roots or membership; assertCurrentGeneration rechecks real
//         committed controller transactions, read-only.
//   U0d   the evidence is produced by the real native begin/complete (no post-commit
//         attach) and read only from the checksum-covered completion.result; storage
//         corruption (record-conflict) is told apart from self-consistent forgeries; the
//         one canonical classification shared by the controller and the sidecar refuses
//         an enrolled lineage whose completion is missing, pending, corrupt, foreign or
//         ambiguous; readOwnerTaskPlan is the collector's single-plan read.
// Every fixture is synthetic and local: no provider, network or operator history.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MODULE = path.join(__dirname, 'forge-plan-validation.js');
const pv = require('./forge-plan-validation.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-plan-validation-'));
const M = 'M-20261108000000-plan-validation';
const S = 'S01';
const LINK = process.platform === 'win32' ? 'junction' : 'dir';
const VALIDATED_AT = '2026-11-08T09:00:00.000Z';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    failures.push({ name, error });
    console.log(`  ✗ ${name}`);
    console.log(`      ${error && error.stack ? error.stack : error}`);
  }
}
function note(text) { console.log(`      ${text}`); }
function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
// The controller's record checksum (sha256 of the sorted-key JSON), used only to recompose a
// deliberate self-consistent forgery of a stored record.
function recordDigest(value) {
  const sorted = item => (Array.isArray(item) ? item.map(sorted) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sorted(item[key])])) : item);
  return sha(JSON.stringify(sorted(value)));
}

// ── Synthetic plans ───────────────────────────────────────────────────────────

// A new task plan with explicit depends/writes and the structured must_haves the
// strict product parser admits. `depends`/`writes` are frontmatter lines (null omits
// the key), `head` opens the frontmatter, `roots` adds a v2 root declaration; `eol`
// and `bom` change only bytes.
function taskPlan(id, options = {}) {
  const file = `src/${id.toLowerCase()}.js`;
  const lines = ['---', ...(options.head || []), 'tier: standard'];
  if (options.depends !== null) lines.push(...(options.depends || ['depends: []']));
  if (options.writes !== null) lines.push(...(options.writes || ['writes:', `  - "${file}"`]));
  if (options.roots) lines.push(...options.roots);
  lines.push('must_haves:', '  truths:', `    - "${id} fixture behavior is observable"`, '  artifacts:', `    - path: "${file}"`,
    '      provides: "fixture module"', '      min_lines: 1', '  key_links: []', 'expected_output:', `  - ${file}`,
    '---', '', `# ${id}: Fixture task`, '', options.body || 'Prose never counts as a declaration.', '');
  return (options.bom ? '\uFEFF' : '') + lines.join(options.eol || '\n');
}
function rootsOf(rootPath) {
  return ['roots_schema: 2', 'primary_root_id: primary', 'code_roots:', '  - id: primary', `    path: "${rootPath}"`, '    vcs: git'];
}
// The S-plan task list in the forge-status parsePlanTasks grammar.
function slicePlan(ids, options = {}) {
  const checked = options.checked || [];
  const lines = [`# ${S}: Fixture slice`, '', '## Tasks', '',
    ...ids.map(id => `- [${checked.includes(id) ? 'x' : ' '}] **${id}**: ${id} fixture task`), '', 'Slice prose.', ''];
  return (options.bom ? '\uFEFF' : '') + lines.join(options.eol || '\n');
}
// The planner result shape (forge-xllm planSchema). Only slice_plan.content and
// task_plans[].id/content are admission inputs; status, summary and filename are not.
function candidate(ids, plans = {}, sliceOptions = {}) {
  return {
    status: 'done',
    summary: 'fixture plan',
    slice_plan: { filename: `${S}-PLAN.md`, content: sliceOptions.content || slicePlan(ids, sliceOptions) },
    task_plans: ids.map(id => ({ id, filename: `${id}-PLAN.md`,
      content: typeof plans[id] === 'string' ? plans[id] : taskPlan(id, plans[id] || {}) })),
  };
}
// T01 <- T02 <- T03 (T03 also depends on T01, in a commented block list).
function chain(options = {}) {
  const bytes = { eol: options.eol, bom: options.bom };
  return candidate(['T01', 'T02', 'T03'], {
    T01: { ...bytes },
    T02: { ...bytes, depends: ['depends: [T01]'] },
    T03: { ...bytes, depends: ['depends:', '  - T01', '  - T02 # the second prerequisite'] },
  }, bytes);
}
// T01 declares one v2 root; T02 depends on T01.
function semanticBase() {
  return candidate(['T01', 'T02'], {
    T01: { writes: ['writes:', '  - "primary::src/t01.js"'], roots: rootsOf('C:/fixture/primary') },
    T02: { depends: ['depends: [T01]'] },
  });
}

// ── Owner fixtures ────────────────────────────────────────────────────────────

let sequence = 0;
function ownerRoot(label) {
  const root = path.join(TMP, `${label}-${++sequence}`);
  fs.mkdirSync(path.join(root, '.gsd', 'milestones', M), { recursive: true });
  return root;
}
function sliceDir(root) { return path.join(root, '.gsd', 'milestones', M, 'slices', S); }
function sliceFile(root) { return path.join(sliceDir(root), `${S}-PLAN.md`); }
function taskFile(root, id) { return path.join(sliceDir(root), 'tasks', id, `${id}-PLAN.md`); }
// Writes exactly the candidate bytes at the canonical owner paths, as the owner publisher does.
function publish(root, plan) {
  fs.mkdirSync(sliceDir(root), { recursive: true });
  fs.writeFileSync(sliceFile(root), Buffer.from(plan.slice_plan.content, 'utf8'));
  for (const task of plan.task_plans) {
    fs.mkdirSync(path.dirname(taskFile(root, task.id)), { recursive: true });
    fs.writeFileSync(taskFile(root, task.id), Buffer.from(task.content, 'utf8'));
  }
  return root;
}
function published(label, plan) { return publish(ownerRoot(label), plan || chain()); }
function scopeFor(root, extra) { return { owner: fs.realpathSync.native(root), milestone: M, slice: S, ...(extra || {}) }; }
function collect(root, options) { return pv.collectOwnerSlicePlan(root, { milestone: M, slice: S }, options); }
// A named refusal: its code (from the closed set, or a shared-decoder declaration
// code), its message prefix and no returned evidence.
function refuses(fn, code, label) {
  let value;
  let caught = null;
  try { value = fn(); } catch (error) { caught = error; }
  assert(caught, `${label}: expected ${code}, got a result`);
  assert.strictEqual(caught.code, code, `${label}: expected ${code}, got ${caught.message}`);
  assert(String(caught.message).startsWith(`${code}: `), `${label}: message ${caught.message}`);
  assert(pv.CODES.includes(code) || code.startsWith('plan-declaration-'), `${label}: ${code} is a named refusal`);
  assert.strictEqual(value, undefined, `${label}: a refusal returns no evidence`);
  return caught;
}
const WRITE_FUNCTIONS = ['writeFileSync', 'appendFileSync', 'writeSync', 'mkdirSync', 'mkdtempSync', 'renameSync', 'unlinkSync',
  'rmSync', 'rmdirSync', 'copyFileSync', 'cpSync', 'symlinkSync', 'linkSync', 'truncateSync', 'ftruncateSync', 'utimesSync', 'chmodSync'];
const WRITE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;
// Runs fn with every synchronous file-system write recorded, and asserts there was none
// (also when fn refuses; the refusal is rethrown afterwards).
function withoutWrites(fn) {
  const calls = [];
  const originals = {};
  for (const name of WRITE_FUNCTIONS) {
    const original = fs[name];
    if (typeof original !== 'function') continue;
    originals[name] = original;
    fs[name] = function (...args) { calls.push(`${name} ${String(args[0])}`); return original.apply(this, args); };
  }
  const openSync = fs.openSync;
  originals.openSync = openSync;
  fs.openSync = function (file, flags, ...rest) {
    const writing = typeof flags === 'number' ? (flags & WRITE_FLAGS) !== 0 : flags !== undefined && flags !== null && /[wa+]/.test(String(flags));
    if (writing) calls.push(`openSync ${String(file)} ${String(flags)}`);
    return openSync.call(this, file, flags, ...rest);
  };
  let result;
  let failure = null;
  try { result = fn(); } catch (error) { failure = error; } finally { Object.assign(fs, originals); }
  assert.deepStrictEqual(calls, [], 'no file-system write');
  if (failure) throw failure;
  return result;
}

console.log('\n=== forge-plan-validation.test.js ===\n');

// ── U0b-1 ─────────────────────────────────────────────────────────────────────

test('issue343 U0b-1 candidate and owner files yield identical declarations, source SHA and graph digest', () => {
  for (const [label, bytes] of [['LF', {}], ['CRLF', { eol: '\r\n' }], ['BOM', { bom: true }]]) {
    const plan = chain(bytes);
    const root = ownerRoot(`u0b1-${label}`);
    const scope = scopeFor(root);
    const fromCandidate = pv.validateNewSlicePlan(plan, scope);
    publish(root, plan);
    const collected = collect(root);
    const fromOwner = pv.validateNewSlicePlan(collected, scope);
    assert.deepStrictEqual(fromOwner, fromCandidate, `${label}: the owner files yield the candidate's evidence`);
    assert.deepStrictEqual(fromOwner.declarations, fromCandidate.declarations, `${label}: declarations`);
    assert.deepStrictEqual(fromOwner.source, fromCandidate.source, `${label}: source`);
    assert.strictEqual(fromOwner.graph_sha256, fromCandidate.graph_sha256, `${label}: graph digest`);
    // The source digest is the digest of the exact bytes, on disk and in the candidate text.
    assert.strictEqual(fromOwner.source.slice_plan.sha256, sha(fs.readFileSync(sliceFile(root))), `${label}: S-plan bytes on disk`);
    assert.strictEqual(fromCandidate.source.slice_plan.sha256, sha(Buffer.from(plan.slice_plan.content, 'utf8')), `${label}: S-plan candidate bytes`);
    assert.strictEqual(collected.slice_plan.content, plan.slice_plan.content, `${label}: the collected S-plan text is exact`);
    for (const task of plan.task_plans) {
      const entry = fromOwner.source.task_plans.find(row => row.id === task.id);
      assert.deepStrictEqual([entry.path, entry.sha256, entry.bytes],
        [`.gsd/milestones/${M}/slices/${S}/tasks/${task.id}/${task.id}-PLAN.md`, sha(fs.readFileSync(taskFile(root, task.id))),
          Buffer.byteLength(task.content, 'utf8')], `${label}: ${task.id} source`);
      assert.strictEqual(collected.task_plans.find(row => row.id === task.id).content, task.content, `${label}: ${task.id} exact text`);
    }
    assert.deepStrictEqual([fromOwner.kind, fromOwner.graph_status, fromOwner.task_ids, fromOwner.topological_order, fromOwner.legacy_task_ids],
      ['complete', 'valid', ['T01', 'T02', 'T03'], ['T01', 'T02', 'T03'], []], `${label}: graph`);
    assert.deepStrictEqual(fromOwner.edges, [{ task: 'T02', depends_on: 'T01' }, { task: 'T03', depends_on: 'T01' },
      { task: 'T03', depends_on: 'T02' }], `${label}: edges`);
    assert.deepStrictEqual(fromOwner.declarations.map(entry => [entry.task_id, entry.depends, entry.writes]),
      [['T01', [], ['src/t01.js']], ['T02', ['T01'], ['src/t02.js']], ['T03', ['T01', 'T02'], ['src/t03.js']]], `${label}: declared values`);
    assert.match(fromOwner.graph_sha256, /^[a-f0-9]{64}$/);
    assert(Object.isFrozen(fromOwner) && Object.isFrozen(fromOwner.source.task_plans[2]) && Object.isFrozen(fromOwner.declarations[2].depends),
      `${label}: deep-frozen evidence`);
    assert(Object.isFrozen(collected) && Object.isFrozen(collected.task_plans[0]), `${label}: frozen snapshot`);
  }
  // Other bytes, same declarations: the source binds the bytes; declarations, graph and semantics stay.
  const lf = chain();
  const root = published('u0b1-mixed', chain({ eol: '\r\n' }));
  const scope = scopeFor(root);
  const candidateEvidence = pv.validateNewSlicePlan(lf, scope);
  const collected = collect(root);
  const ownerEvidence = pv.validateNewSlicePlan(collected, scope);
  assert.notStrictEqual(ownerEvidence.source.slice_plan.sha256, candidateEvidence.source.slice_plan.sha256, 'other bytes, other source digest');
  assert.deepStrictEqual([ownerEvidence.declarations, ownerEvidence.edges, ownerEvidence.graph_sha256, ownerEvidence.semantic_sha256],
    [candidateEvidence.declarations, candidateEvidence.edges, candidateEvidence.graph_sha256, candidateEvidence.semantic_sha256],
    'same declarations, graph and semantics');
  // A snapshot whose digest or path does not match its text is refused.
  refuses(() => pv.validateNewSlicePlan({ ...collected, slice_plan: { ...collected.slice_plan, content: lf.slice_plan.content } }, scope),
    'plan-source-inconsistent', 'a stale snapshot digest');
  refuses(() => pv.validateNewSlicePlan({ ...collected,
    task_plans: collected.task_plans.map((row, index) => (index ? row : { ...row, path: 'tasks/T01-PLAN.md' })) }, scope),
  'plan-source-inconsistent', 'a snapshot entry at another path');
});

// ── U0b-2 ─────────────────────────────────────────────────────────────────────

test('issue343 U0b-2 collector refuses links and junctions at every component', () => {
  const components = [['.gsd', root => path.join(root, '.gsd')], ['slice directory', root => sliceDir(root)],
    ['tasks directory', root => path.join(sliceDir(root), 'tasks')], ['task directory', root => path.dirname(taskFile(root, 'T02'))]];
  for (const [label, locate] of components) {
    const root = published(`link-${label.replace(/[^a-z]+/gi, '-')}`);
    const real = locate(root);
    const foreign = path.join(TMP, `foreign-${++sequence}`);
    fs.cpSync(real, foreign, { recursive: true });
    fs.rmSync(real, { recursive: true, force: true });
    fs.symlinkSync(foreign, real, LINK);
    refuses(() => collect(root), 'plan-source-link', `a ${LINK} at the ${label}`);
  }
  // A symbolic link to a foreign plan file, where this platform permits creating one.
  const root = published('link-file');
  const file = taskFile(root, 'T02');
  const foreignFile = path.join(TMP, `foreign-${++sequence}-T02-PLAN.md`);
  fs.copyFileSync(file, foreignFile);
  fs.rmSync(file);
  let linked = false;
  try {
    fs.symlinkSync(foreignFile, file, 'file');
    linked = true;
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    note(`file symlink creation not permitted here (${error.code}); the ${LINK} cases above cover links`);
  }
  if (linked) refuses(() => collect(root), 'plan-source-link', 'a symlinked task plan file');
  // The real layout is admitted.
  assert.deepStrictEqual(collect(published('link-none')).task_plans.map(row => row.id), ['T01', 'T02', 'T03']);
});

// The bounded reader's file-system seam only times one real append, made through the
// real file system while that reader holds the descriptor: a genuine concurrent edit.
function appendingIo(suffix, target) {
  const opened = new Map();
  let appended = false;
  const io = Object.create(fs);
  io.openSync = (file, ...rest) => {
    const fd = fs.openSync(file, ...rest);
    opened.set(fd, String(file));
    return fd;
  };
  io.readSync = (fd, ...rest) => {
    if (!appended && String(opened.get(fd) || '').endsWith(suffix)) {
      appended = true;
      fs.appendFileSync(target, '\n<!-- concurrent edit -->\n');
    }
    return fs.readSync(fd, ...rest);
  };
  io.closeSync = fd => {
    opened.delete(fd);
    return fs.closeSync(fd);
  };
  return { io, appended: () => appended };
}

test('issue343 U0b-2 collector refuses a plan edited during its read and a snapshot changed before the end', () => {
  const edited = published('unstable-task');
  const first = appendingIo('T02-PLAN.md', taskFile(edited, 'T02'));
  refuses(() => collect(edited, { io: first.io }), 'plan-source-unstable', 'a task plan appended during its own read');
  assert(first.appended(), 'the concurrent edit happened');
  const snapshot = published('unstable-snapshot');
  const second = appendingIo('T02-PLAN.md', sliceFile(snapshot));
  refuses(() => collect(snapshot, { io: second.io }), 'plan-source-unstable', 'the slice plan appended while its task plans were read');
  assert(second.appended(), 'the concurrent edit happened');
  // Without a concurrent edit the same seam reads the same snapshot.
  const quiet = published('unstable-quiet');
  const idle = appendingIo('no-such-plan.md', sliceFile(quiet));
  assert.deepStrictEqual(collect(quiet, { io: idle.io }), collect(quiet));
  assert(!idle.appended(), 'no edit happened');
  // The seam carries only { io }: no other option exists.
  assert.throws(() => collect(quiet, { io: fs, approved: true }), TypeError);
});

test('issue343 U0b-2 collector refuses oversized and non-UTF-8 plans; the candidate has the same bounds', () => {
  const max = pv.MAX_PLAN_BYTES;
  const exact = published('size-exact');
  const base = fs.readFileSync(taskFile(exact, 'T02'));
  fs.writeFileSync(taskFile(exact, 'T02'), Buffer.concat([base, Buffer.alloc(max - base.length, 0x61)]));
  const atLimit = collect(exact);
  assert.strictEqual(atLimit.task_plans[1].bytes, max, 'exactly the limit is read');
  assert.strictEqual(pv.validateNewSlicePlan(atLimit, scopeFor(exact)).source.task_plans[1].bytes, max, 'and admitted');
  const overTask = published('size-task');
  fs.appendFileSync(taskFile(overTask, 'T02'), Buffer.alloc(max, 0x61));
  refuses(() => collect(overTask), 'plan-source-too-large', 'an oversized task plan');
  const overSlice = published('size-slice');
  fs.appendFileSync(sliceFile(overSlice), Buffer.alloc(max, 0x61));
  refuses(() => collect(overSlice), 'plan-source-too-large', 'an oversized slice plan');
  const big = chain();
  big.task_plans[1].content += 'a'.repeat(max);
  refuses(() => pv.validateNewSlicePlan(big, scopeFor(exact)), 'plan-source-too-large', 'an oversized candidate');
  const wide = chain();
  wide.task_plans[1].content += '\u00e9'.repeat(Math.ceil(max / 2));
  refuses(() => pv.validateNewSlicePlan(wide, scopeFor(exact)), 'plan-source-too-large', 'a candidate over the limit only in UTF-8 bytes');
  const badTask = published('utf8-task');
  fs.appendFileSync(taskFile(badTask, 'T02'), Buffer.from([0xc3, 0x28]));
  refuses(() => collect(badTask), 'plan-source-encoding', 'an invalid UTF-8 task plan');
  const badSlice = published('utf8-slice');
  fs.writeFileSync(sliceFile(badSlice), Buffer.concat([Buffer.from([0xff, 0xfe]), fs.readFileSync(sliceFile(badSlice))]));
  refuses(() => collect(badSlice), 'plan-source-encoding', 'a UTF-16 byte-order mark');
  const lone = chain();
  lone.task_plans[0].content += '\ud800';
  refuses(() => pv.validateNewSlicePlan(lone, scopeFor(exact)), 'plan-source-encoding', 'a lone surrogate in a candidate');
});

test('issue343 U0b-2 unsafe milestone, slice and task IDs refuse before any path is built', () => {
  const root = published('ids');
  const unsafe = ['..', '../M1', 'M1/S01', 'M1\\S01', '', '.', 'M1.', ' M1', 'M1 ', 'CON', 'nul.txt', 'COM1', 'C:', '.gsd',
    'x'.repeat(200), 5, null, undefined];
  for (const value of unsafe) {
    refuses(() => pv.collectOwnerSlicePlan(root, { milestone: value, slice: S }), 'plan-scope-invalid', `milestone ${String(value)}`);
    refuses(() => pv.collectOwnerSlicePlan(root, { milestone: M, slice: value }), 'plan-scope-invalid', `slice ${String(value)}`);
    refuses(() => pv.validateNewSlicePlan(chain(), { owner: fs.realpathSync.native(root), milestone: value, slice: S }),
      'plan-scope-invalid', `candidate milestone ${String(value)}`);
  }
  refuses(() => pv.collectOwnerSlicePlan(root, { milestone: M, slice: S, approved: true }), 'plan-scope-invalid', 'an imported approved flag');
  refuses(() => pv.validateNewSlicePlan(chain(), scopeFor(root, { legacy: true })), 'plan-scope-invalid', 'an imported legacy flag');
  refuses(() => pv.validateNewSlicePlan(chain(), { milestone: M, slice: S }), 'plan-scope-invalid', 'no owner');
  refuses(() => pv.validateNewSlicePlan(chain(), { owner: 'relative/owner', milestone: M, slice: S }), 'plan-scope-invalid', 'a relative owner');
  // Listed IDs: valid but missing on disk, repeated or absent. Length by itself
  // does not change the canonical T+digits grammar into a new admission limit.
  fs.writeFileSync(sliceFile(root), `${slicePlan(['T01', 'T02', 'T03'])}- [ ] T${'9'.repeat(40)}: over-long\n`);
  refuses(() => collect(root), 'plan-source-missing', 'a valid long listed task id with no owner plan');
  fs.writeFileSync(sliceFile(root), slicePlan(['T01', 'T02', 'T03', 'T02']));
  refuses(() => collect(root), 'plan-task-id-duplicate', 'a repeated listed task id');
  fs.writeFileSync(sliceFile(root), slicePlan([]));
  refuses(() => collect(root), 'plan-task-list-empty', 'a slice plan that lists no task');
  // Candidate IDs become path segments too.
  for (const id of ['../T01', 'T01/../T02', 'T01\\x', 'T1x', 't01', 'T01.', 'T01.1.1', 'S01', '', 7, null]) {
    const bad = chain();
    bad.task_plans[0].id = id;
    refuses(() => pv.validateNewSlicePlan(bad, scopeFor(root)), 'plan-task-id-invalid', `candidate id ${String(id)}`);
  }
  const twice = chain();
  twice.task_plans[1].id = 'T01';
  refuses(() => pv.validateNewSlicePlan(twice, scopeFor(root)), 'plan-task-id-duplicate', 'a candidate id returned twice');
});

test('issue343 U0b compatibility: canonical task IDs and native membership do not acquire generic quotas', () => {
  const longId = `T${'9'.repeat(32)}`;
  const root = published('canonical-membership');
  const scope = scopeFor(root);
  const long = pv.validateNewSlicePlan(candidate([longId]), scope);
  assert.deepStrictEqual(long.task_ids, [longId], 'a canonical 33-character task ID is admitted');

  const ids = Array.from({ length: 101 }, (_, index) => `T${index + 1}`);
  const full = candidate(ids);
  publish(root, full);
  const admitted = pv.validateNewSlicePlan(full, scope);
  assert.deepStrictEqual(pv.validateNewSlicePlan(collect(root), scope), admitted,
    'small native/owner plans preserve all 101 tasks, with no new count quota');
  const generation = pv.buildPlanGeneration({ ...scope, begin_key: 'canonical-membership-begin',
    lease_generation: 'canonical-membership-lease', owner_digest: `sha256:${'a'.repeat(64)}` });
  const validation = pv.buildPlanValidation(generation, admitted, { validatedAt: VALIDATED_AT });
  assert.deepStrictEqual(pv.verifyPlanValidation(validation, generation).task_ids, ids,
    'evidence verification does not reintroduce a separate count quota');

  const knownRoot = published('canonical-known-membership', candidate(ids.slice(0, 100)));
  const addition = candidate(ids);
  addition.task_plans = addition.task_plans.filter(task => task.id === 'T101');
  const amended = pv.validateNewSlicePlan(addition, { ...scopeFor(knownRoot), known: collect(knownRoot) });
  assert.deepStrictEqual(amended.task_ids, ids, 'a strict addition may grow an existing set past 100');
  assert.strictEqual(pv.MAX_PLAN_BYTES, 1024 * 1024, 'the inherited per-plan byte bound stays unchanged');
});

test('issue343 U0b-2 collector refuses nested/flat conflicts, legacy flat plans, missing and irregular sources', () => {
  const both = published('layout-both');
  fs.copyFileSync(taskFile(both, 'T02'), path.join(sliceDir(both), 'tasks', 'T02-PLAN.md'));
  refuses(() => collect(both), 'plan-source-layout-conflict', 'nested and flat T02 plans');
  const flat = published('layout-flat');
  fs.renameSync(taskFile(flat, 'T02'), path.join(sliceDir(flat), 'tasks', 'T02-PLAN.md'));
  refuses(() => collect(flat), 'plan-source-legacy-layout', 'only the flat legacy T02 plan');
  const missing = published('missing-task');
  fs.rmSync(taskFile(missing, 'T03'));
  refuses(() => collect(missing), 'plan-source-missing', 'a listed task plan that does not exist');
  const directory = published('not-regular');
  fs.rmSync(taskFile(directory, 'T03'));
  fs.mkdirSync(taskFile(directory, 'T03'));
  refuses(() => collect(directory), 'plan-source-not-regular', 'a directory in place of a task plan');
  refuses(() => collect(ownerRoot('no-slice')), 'plan-source-missing', 'an absent slice plan');
  refuses(() => pv.collectOwnerSlicePlan(path.join(TMP, 'absent-owner'), { milestone: M, slice: S }), 'plan-source-owner-unreadable', 'an absent owner');
  refuses(() => pv.collectOwnerSlicePlan(sliceFile(missing), { milestone: M, slice: S }), 'plan-source-owner-unreadable', 'a file as owner');
  refuses(() => pv.collectOwnerSlicePlan(missing, { milestone: M, slice: S, owner: TMP }), 'plan-source-owner-mismatch', 'another owner in the scope');
});

test('issue343 U0b-2 collector reads only the S-plan and its listed T-plans: no STATE, ledger, directory scan or other run', () => {
  require('./forge-autonomy-sources.js'); // loaded before the trap: module loading is not collection
  require('./forge-code-roots.js');
  const root = published('queue');
  const decoy = Buffer.from([0xff, 0xfe, 0x00]);
  fs.writeFileSync(path.join(root, '.gsd', 'milestones', M, `${M}-STATE.md`), '---\nmilestone: decoy\n---\n**Active Task:** T09\n');
  fs.mkdirSync(path.join(root, '.gsd', 'ledger'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gsd', 'ledger', `${M}.md`), '- [ ] T09: ledger decoy\n');
  fs.mkdirSync(path.dirname(taskFile(root, 'T09')), { recursive: true });
  fs.writeFileSync(taskFile(root, 'T09'), decoy);
  const otherRun = path.join(root, '.gsd', 'milestones', 'M-20261108000001-other-run', 'slices', S, 'tasks', 'T01');
  fs.mkdirSync(otherRun, { recursive: true });
  fs.writeFileSync(path.join(otherRun, 'T01-PLAN.md'), decoy);
  const standalone = path.join(root, '.gsd', 'tasks', 'T-20261108000000-standalone');
  fs.mkdirSync(standalone, { recursive: true });
  fs.writeFileSync(path.join(standalone, 'T-20261108000000-standalone-PLAN.md'), decoy);
  const opened = [];
  const listed = [];
  const originals = { openSync: fs.openSync, readFileSync: fs.readFileSync, readdirSync: fs.readdirSync, opendirSync: fs.opendirSync };
  fs.openSync = function (file, ...rest) { opened.push(path.resolve(String(file))); return originals.openSync.call(this, file, ...rest); };
  fs.readFileSync = function (...args) { opened.push(path.resolve(String(args[0]))); return originals.readFileSync.apply(this, args); };
  fs.readdirSync = function (...args) { listed.push(String(args[0])); return originals.readdirSync.apply(this, args); };
  fs.opendirSync = function (...args) { listed.push(String(args[0])); return originals.opendirSync.apply(this, args); };
  let collected;
  try { collected = collect(root); } finally { Object.assign(fs, originals); }
  assert.deepStrictEqual(opened, [sliceFile(root), taskFile(root, 'T01'), taskFile(root, 'T02'), taskFile(root, 'T03')].map(file => path.resolve(file)),
    'only the S-plan and its listed T-plans are opened, in order');
  assert.deepStrictEqual(listed, [], 'no directory is listed');
  assert.deepStrictEqual(collected.task_plans.map(row => row.id), ['T01', 'T02', 'T03']);
});

// ── U0b-3 ─────────────────────────────────────────────────────────────────────

// Runs in a fresh process (serialized with Function.prototype.toString): it records
// every file-system write and process spawn, then exercises the pure validators.
function probePure(input) {
  'use strict';
  const fs = require('fs');
  const path = require('path');
  const childProcess = require('child_process');
  const writes = [];
  const spawns = [];
  const masks = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;
  const writing = flags => (typeof flags === 'number' ? (flags & masks) !== 0
    : flags !== undefined && flags !== null && /[wa+]/.test(String(flags)));
  for (const name of ['writeFileSync', 'appendFileSync', 'writeSync', 'writevSync', 'mkdirSync', 'mkdtempSync', 'renameSync',
    'unlinkSync', 'rmSync', 'rmdirSync', 'copyFileSync', 'cpSync', 'symlinkSync', 'linkSync', 'truncateSync', 'ftruncateSync',
    'chmodSync', 'chownSync', 'utimesSync', 'futimesSync', 'lutimesSync', 'writeFile', 'appendFile', 'write', 'writev', 'mkdir',
    'mkdtemp', 'rename', 'unlink', 'rm', 'rmdir', 'copyFile', 'cp', 'symlink', 'link', 'truncate', 'ftruncate', 'chmod', 'chown',
    'utimes', 'createWriteStream']) {
    const original = fs[name];
    if (typeof original !== 'function') continue;
    fs[name] = function (...args) { writes.push(name); return original.apply(this, args); };
  }
  const openSync = fs.openSync;
  fs.openSync = function (file, flags, ...rest) {
    if (writing(flags)) writes.push(`openSync:${String(flags)}`);
    return openSync.call(this, file, flags, ...rest);
  };
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const original = childProcess[name];
    childProcess[name] = function (...args) { spawns.push(name); return original.apply(this, args); };
  }
  const before = new Set(Object.keys(require.cache));
  const pv = require(input.module);
  const onRequire = Object.keys(require.cache).filter(file => !before.has(file)).map(file => path.basename(file));
  const evidence = pv.validateNewSlicePlan(input.candidate, input.scope);
  const generation = pv.buildPlanGeneration(input.generation);
  pv.verifyPlanGeneration(JSON.parse(JSON.stringify(generation)), { begin_key: input.generation.begin_key });
  const validation = pv.buildPlanValidation(generation, evidence, { validatedAt: input.validatedAt });
  pv.verifyPlanValidation(JSON.parse(JSON.stringify(validation)), generation);
  const semantic = pv.semanticDigest(validation) === evidence.semantic_sha256 ? evidence.semantic_sha256 : null;
  const refused = input.refusals.map(bad => {
    try { pv.validateNewSlicePlan(bad, input.scope); return null; } catch (error) { return error.code || String(error); }
  });
  const directory = path.dirname(require.resolve(input.module));
  const local = Object.keys(require.cache).filter(file => path.dirname(file) === directory).map(file => path.basename(file)).sort();
  process.stdout.write(JSON.stringify({ onRequire, local, writes, spawns, semantic, graph: evidence.graph_sha256, refused }));
}

test('issue343 U0b-3 pure validators reach no prefs, provider, lease, claim or filesystem write', () => {
  const root = published('pure');
  const scope = scopeFor(root);
  const input = {
    module: MODULE,
    scope,
    candidate: chain(),
    validatedAt: VALIDATED_AT,
    generation: { owner: scope.owner, milestone: M, slice: S, begin_key: 'plan-begin-probe', lease_generation: 'lease-probe',
      owner_digest: `sha256:${'d'.repeat(64)}` },
    refusals: [candidate(['T01'], { T01: { writes: null } }), candidate(['T01'], { T01: '# Legacy plan without frontmatter\n' }),
      candidate(['T01', 'T02'], { T01: { depends: ['depends: [T02]'] }, T02: { depends: ['depends: [T01]'] } })],
  };
  const result = spawnSync(process.execPath, ['-e', `(${probePure.toString()})(JSON.parse(process.env.FORGE_PLAN_VALIDATION_PROBE))`],
    { encoding: 'utf8', cwd: TMP, env: { ...process.env, FORGE_PLAN_VALIDATION_PROBE: JSON.stringify(input) }, timeout: 60000 });
  assert.strictEqual(result.status, 0, `probe failed: ${result.stderr || result.error}`);
  const out = JSON.parse(result.stdout);
  assert.deepStrictEqual(out.onRequire, ['forge-plan-validation.js'], 'requiring the gate loads no other module');
  assert.deepStrictEqual(out.local, ['forge-code-roots.js', 'forge-must-haves.js', 'forge-parallelism.js', 'forge-plan-validation.js'],
    'the pure validators reach only the parser, the graph and the path policy');
  for (const unreachable of ['forge-prefs.js', 'forge-unit-lease.js', 'forge-write-claim.js', 'forge-claim-gate.js', 'forge-claim-overlap.js',
    'forge-xllm.js', 'forge-unit-sidecar.js', 'forge-unit-controller.js', 'forge-lock.js', 'forge-runs.js', 'forge-ids.js', 'forge-status.js']) {
    assert(!out.local.includes(unreachable), `${unreachable} is never loaded`);
  }
  assert.deepStrictEqual(out.writes, [], 'no file-system write');
  assert.deepStrictEqual(out.spawns, [], 'no process spawn');
  assert.deepStrictEqual(out.refused, ['plan-declaration-writes-missing', 'plan-must-haves-legacy', 'plan-dag-invalid'], 'refusals are pure too');
  const here = pv.validateNewSlicePlan(chain(), scope);
  assert.deepStrictEqual([out.semantic, out.graph], [here.semantic_sha256, here.graph_sha256], 'deterministic across processes');
  // No option, profile or imported flag relaxes the pure admission.
  const flagged = { ...candidate(['T01'], { T01: { writes: null } }), approved: true, legacy: true, profile: 'relaxed' };
  refuses(() => pv.validateNewSlicePlan(flagged, scope), 'plan-declaration-writes-missing', 'imported flags on a candidate');
  for (const extra of [{ approved: true }, { legacy: true }, { profile: 'relaxed' }, { requireExplicit: false }]) {
    refuses(() => pv.validateNewSlicePlan(chain(), { ...scope, ...extra }), 'plan-scope-invalid', `scope ${Object.keys(extra)[0]}`);
  }
});

// ── U0b-4 ─────────────────────────────────────────────────────────────────────

test('issue343 U0b-4 semantic digest ignores checkbox and repair_count and changes with depends, writes, roots or membership', () => {
  const root = ownerRoot('u0b4');
  const scope = scopeFor(root);
  const reference = pv.validateNewSlicePlan(semanticBase(), scope);
  const variant = mutate => {
    const plan = semanticBase();
    mutate(plan);
    return pv.validateNewSlicePlan(plan, scope);
  };
  const task = (plan, id) => plan.task_plans.find(row => row.id === id);
  const edit = (plan, id, from, to) => {
    const row = task(plan, id);
    assert(row.content.includes(from), `fixture ${id} holds ${JSON.stringify(from)}`);
    row.content = row.content.replace(from, to);
  };
  const kept = [
    ['a checked box', plan => {
      assert(plan.slice_plan.content.includes('- [ ] **T01**'));
      plan.slice_plan.content = plan.slice_plan.content.replace('- [ ] **T01**', '- [x] **T01**');
    }],
    ['repair_count inserted', plan => edit(plan, 'T02', '---\n', '---\nrepair_count: 1\n')],
    ['repair_count raised', plan => edit(plan, 'T02', '---\n', '---\nrepair_count: 7\n')],
    ['prose and a SUMMARY reference', plan => {
      task(plan, 'T01').content += '\nSee T01-SUMMARY.md; prose changed.\n';
      plan.slice_plan.content += '\nSlice notes changed.\n';
    }],
    ['declaration layout, comments and quoting', plan => edit(plan, 'T02', 'depends: [T01]', 'depends:\n  # the only prerequisite\n  - "T01" # quoted')],
    ['CRLF bytes', plan => {
      for (const row of plan.task_plans) row.content = row.content.replace(/\n/g, '\r\n');
      plan.slice_plan.content = plan.slice_plan.content.replace(/\n/g, '\r\n');
    }],
  ];
  for (const [label, mutate] of kept) {
    const evidence = variant(mutate);
    assert.strictEqual(evidence.semantic_sha256, reference.semantic_sha256, `${label}: same semantic digest`);
    assert.strictEqual(evidence.graph_sha256, reference.graph_sha256, `${label}: same graph`);
    assert.notDeepStrictEqual(evidence.source, reference.source, `${label}: the bytes did change`);
  }
  const changed = [
    ['depends', plan => edit(plan, 'T02', 'depends: [T01]', 'depends: []')],
    ['writes', plan => edit(plan, 'T02', '  - "src/t02.js"', '  - "src/t02.js"\n  - "src/shared.js"')],
    ['a root path', plan => edit(plan, 'T01', 'C:/fixture/primary', 'C:/fixture/elsewhere')],
    ['the roots schema', plan => edit(plan, 'T01', 'roots_schema: 2\n', '')],
    ['the primary root', plan => edit(plan, 'T01', 'primary_root_id: primary', 'primary_root_id: secondary')],
    ['membership: one more task', plan => {
      plan.slice_plan.content = slicePlan(['T01', 'T02', 'T03']);
      plan.task_plans.push({ id: 'T03', content: taskPlan('T03') });
    }],
    ['membership: one task less', plan => {
      plan.slice_plan.content = slicePlan(['T01']);
      plan.task_plans = plan.task_plans.filter(row => row.id === 'T01');
    }],
    ['membership: another order', plan => { plan.slice_plan.content = slicePlan(['T02', 'T01']); }],
  ];
  const digests = new Set([reference.semantic_sha256]);
  for (const [label, mutate] of changed) {
    const evidence = variant(mutate);
    assert(!digests.has(evidence.semantic_sha256), `${label}: the semantic digest changes`);
    digests.add(evidence.semantic_sha256);
  }
  // Removing a declaration is never absorbed as drift: the strict admission refuses it.
  refuses(() => variant(plan => edit(plan, 'T02', 'depends: [T01]\n', '')), 'plan-declaration-depends-missing', 'depends removed');
  refuses(() => variant(plan => edit(plan, 'T02', 'writes:\n  - "src/t02.js"\n', '')), 'plan-declaration-writes-missing', 'writes removed');
  // The digest of the durable record is the digest of its admission.
  const generation = pv.buildPlanGeneration({ owner: scope.owner, milestone: M, slice: S, begin_key: 'plan-begin-u0b4',
    lease_generation: 'lease-u0b4', owner_digest: `sha256:${'a'.repeat(64)}` });
  assert.strictEqual(pv.semanticDigest(pv.buildPlanValidation(generation, reference, { validatedAt: VALIDATED_AT })), reference.semantic_sha256);
  assert.throws(() => pv.semanticDigest({ task_ids: ['T01'] }), TypeError);
});

test('issue343 U0b-4 assertCurrentGeneration rechecks committed controller evidence read-only: checkbox and repair_count pass, drift and forgeries refuse', () => {
  const controller = require('./forge-unit-controller.js');
  const state = require('./forge-state.js');
  const repair = require('./forge-repair.js');
  const prefsReader = () => ({ ok: true, prefs: { workflow: { skip_discuss: true, skip_research: true } } });
  const root = ownerRoot('current');
  const unit = `plan-slice/${S}`;
  state.write(root, { milestone: M, kind: 'milestone', phase: 'plan-slice', active_slice: S, active_task: '—', next_action: 'plan', auto_mode: 'on' });
  const request = extra => ({ milestone: M, unit, host_runtime: 'claude', session: 'session-neutral', ...extra });
  const begun = controller.begin(root, request({ owner_token: 'owner-u0b', idempotency_key: 'plan-begin-u0b' }), { prefsReader });
  assert.strictEqual(begun.ok, true, JSON.stringify(begun));
  publish(root, semanticBase());
  const completed = controller.complete(root, request({ owner_token: begun.owner_token, generation: begun.generation,
    idempotency_key: 'plan-complete-u0b', result: { status: 'succeeded', summary: 'planned' } }), { prefsReader });
  assert.strictEqual(completed.transaction.phase, 'committed');
  // U0d: the real native begin enrolled itself and the real completion admitted the owner plan,
  // writing plan_validation inside its result under result_checksum. Nothing is attached after a commit.
  const beginRecord = controller.lookupRecord(root, 'transaction', 'plan-begin-u0b');
  const completionRecord = controller.lookupRecord(root, 'transaction', 'plan-complete-u0b');
  const enrollment = { owner: fs.realpathSync.native(root), milestone: M, slice: S, begin_key: 'plan-begin-u0b',
    lease_generation: beginRecord.lease_generation, owner_digest: beginRecord.owner_digest };
  const generation = pv.buildPlanGeneration(enrollment);
  const admission = pv.validateNewSlicePlan(collect(root), scopeFor(root));
  assert.deepStrictEqual(beginRecord[pv.TRANSACTION_FIELDS.generation], JSON.parse(JSON.stringify(generation)), 'the begin carries its own enrollment');
  assert(!Object.hasOwn(completionRecord, pv.TRANSACTION_FIELDS.validation), 'no top-level evidence is written');
  assert.strictEqual(completionRecord.boundary.result_checksum, recordDigest(completionRecord.result), 'result_checksum covers the evidence');
  const validation = pv.verifyPlanValidation(completionRecord.result[pv.TRANSACTION_FIELDS.validation], generation);
  assert.strictEqual(pv.semanticDigest(validation), admission.semantic_sha256, 'the native evidence is the admission of the owner plan');
  const files = ['plan-begin-u0b', 'plan-complete-u0b'].map(key => controller.transactionFile(root, key));
  const evidenceBytes = files.map(file => fs.readFileSync(file));
  const restoreEvidence = () => files.forEach((file, index) => fs.writeFileSync(file, evidenceBytes[index]));
  // Rewrites one stored record through the controller's own writer (its storage checksum is
  // fresh). recompose: the completion's result_checksum is recomputed too, so the record stays
  // self-consistent storage and only the evidence checks can refuse it; without it the
  // storage-level check refuses first (record-conflict).
  const rewrite = (key, mutate, recompose) => {
    const record = JSON.parse(JSON.stringify(controller.lookupRecord(root, 'transaction', key)));
    mutate(record);
    if (recompose) record.boundary.result_checksum = recordDigest(record.result);
    controller.writeAtomic(controller.transactionFile(root, key), record);
  };
  const current = extra => pv.assertCurrentGeneration(root, { milestone: M, slice: S, validation_key: 'plan-complete-u0b', ...(extra || {}) });
  const first = withoutWrites(() => current());
  assert.deepStrictEqual([first.status, first.generation_key, first.begin_key, first.validation_key, first.semantic_sha256,
    first.graph_sha256, first.task_ids], ['current', generation.generation_key, 'plan-begin-u0b', 'plan-complete-u0b',
    admission.semantic_sha256, admission.graph_sha256, ['T01', 'T02']]);
  assert(Object.isFrozen(first) && Object.isFrozen(first.source), 'frozen result');
  // Checkbox, repair_count (the real forge-repair increment), prose and a SUMMARY never drift.
  fs.writeFileSync(sliceFile(root), fs.readFileSync(sliceFile(root), 'utf8').replace('- [ ] **T01**', '- [x] **T01**'));
  assert.strictEqual(withoutWrites(() => current()).semantic_sha256, admission.semantic_sha256, 'a checked box');
  assert.deepStrictEqual([repair.incrementRepairCount(taskFile(root, 'T02')), repair.incrementRepairCount(taskFile(root, 'T02'))], [1, 2]);
  assert(fs.readFileSync(taskFile(root, 'T02'), 'utf8').startsWith('---\nrepair_count: 2\n'), 'repair_count persisted in the frontmatter');
  assert.strictEqual(withoutWrites(() => current()).semantic_sha256, admission.semantic_sha256, 'repair_count');
  fs.appendFileSync(taskFile(root, 'T01'), '\nProse changed after admission.\n');
  fs.writeFileSync(path.join(path.dirname(taskFile(root, 'T01')), 'T01-SUMMARY.md'), '# T01 summary\n');
  const edited = withoutWrites(() => current());
  assert.strictEqual(edited.semantic_sha256, admission.semantic_sha256, 'prose and a SUMMARY');
  assert.notDeepStrictEqual(edited.source, first.source, 'the current bytes differ from the admitted bytes');
  // Semantic drift refuses (until an admitted amendment exists, U0e), writing nothing.
  const drift = (label, file, rewrite, cause) => {
    const before = fs.readFileSync(file);
    fs.writeFileSync(file, rewrite(before.toString('utf8')));
    try {
      const error = refuses(() => withoutWrites(() => current()), 'plan-generation-drift', label);
      if (cause) assert.strictEqual(error.cause_code, cause, `${label}: cause`);
    } finally { fs.writeFileSync(file, before); }
    assert.strictEqual(current().status, 'current', `${label}: the restored bytes are current again`);
  };
  const replaceOnce = (from, to) => text => {
    assert(text.includes(from), `fixture holds ${JSON.stringify(from)}`);
    return text.replace(from, to);
  };
  drift('depends changed', taskFile(root, 'T02'), replaceOnce('depends: [T01]', 'depends: []'));
  drift('depends removed', taskFile(root, 'T02'), replaceOnce('depends: [T01]\n', ''), 'plan-declaration-depends-missing');
  drift('writes changed', taskFile(root, 'T02'), replaceOnce('  - "src/t02.js"', '  - "src/other.js"'));
  drift('writes removed', taskFile(root, 'T02'), replaceOnce('writes:\n  - "src/t02.js"\n', ''), 'plan-declaration-writes-missing');
  drift('roots changed', taskFile(root, 'T01'), replaceOnce('C:/fixture/primary', 'C:/fixture/moved'));
  drift('membership reordered', sliceFile(root), () => slicePlan(['T02', 'T01']));
  drift('membership reduced', sliceFile(root), () => slicePlan(['T01']));
  fs.mkdirSync(path.dirname(taskFile(root, 'T03')), { recursive: true });
  fs.writeFileSync(taskFile(root, 'T03'), taskPlan('T03'));
  drift('membership extended', sliceFile(root), () => slicePlan(['T01', 'T02', 'T03']));
  fs.rmSync(path.dirname(taskFile(root, 'T03')), { recursive: true, force: true });
  // Evidence that is absent, foreign, forged or carries an imported flag refuses. Forgeries
  // live where the evidence lives (completion.result), and storage-level corruption is told
  // apart from evidence that is consistently stored but invalid.
  const forged = (label, key, mutate, recompose, code, cause) => {
    rewrite(key, mutate, recompose);
    try {
      const error = refuses(() => withoutWrites(() => current()), code, label);
      if (cause !== undefined) assert.strictEqual(error.cause_code, cause, `${label}: cause`);
    } finally { restoreEvidence(); }
  };
  const nested = record => record.result[pv.TRANSACTION_FIELDS.validation];
  // Storage-level: the nested evidence edited without its result checksum (record-conflict).
  forged('nested evidence edited without its result checksum', 'plan-complete-u0b', record => { nested(record).approved = true; }, false,
    'plan-generation-evidence-invalid', 'record-conflict');
  // Self-consistent synthetic forgeries reach the evidence verifiers.
  forged('an approved flag on the nested validation', 'plan-complete-u0b', record => { nested(record).approved = true; }, true,
    'plan-validation-invalid');
  forged('a declaration edited without its digest', 'plan-complete-u0b', record => {
    const value = nested(record);
    value.declarations = [value.declarations[0], { ...value.declarations[1], depends: [] }];
  }, true, 'plan-validation-invalid');
  forged('the nested validation removed', 'plan-complete-u0b', record => { delete record.result[pv.TRANSACTION_FIELDS.validation]; }, true,
    'plan-generation-evidence-missing');
  // A top-level alias is never read as evidence, alone or beside the nested record.
  forged('an isolated top-level alias', 'plan-complete-u0b', record => {
    record[pv.TRANSACTION_FIELDS.validation] = nested(record);
    delete record.result[pv.TRANSACTION_FIELDS.validation];
  }, true, 'plan-generation-evidence-invalid');
  forged('a top-level alias beside the nested evidence', 'plan-complete-u0b', record => {
    record[pv.TRANSACTION_FIELDS.validation] = nested(record);
  }, true, 'plan-generation-evidence-invalid');
  forged('the enrollment removed', 'plan-begin-u0b', record => { delete record[pv.TRANSACTION_FIELDS.generation]; }, false,
    'plan-generation-evidence-missing');
  // The controller binds a stored enrollment to the begin that carries it (U0d record
  // validation): an enrollment naming another begin is storage-level, not evidence.
  forged('an enrollment of another begin', 'plan-begin-u0b', record => {
    record[pv.TRANSACTION_FIELDS.generation] = pv.buildPlanGeneration({ ...enrollment, begin_key: 'plan-begin-other' });
  }, false, 'plan-generation-evidence-invalid', 'record-conflict');
  {
    // A self-consistent begin of another lease generation, enrolled for that lease, and a
    // completion whose nested evidence follows it: only the lineage check can refuse.
    const outside = pv.buildPlanGeneration({ ...enrollment, lease_generation: 'lease-forged' });
    rewrite('plan-begin-u0b', record => {
      record.lease_generation = 'lease-forged';
      record[pv.TRANSACTION_FIELDS.generation] = outside;
    }, false);
    rewrite('plan-complete-u0b', record => {
      record.result[pv.TRANSACTION_FIELDS.validation] = pv.buildPlanValidation(outside, admission, { validatedAt: VALIDATED_AT });
    }, true);
    try {
      refuses(() => current(), 'plan-generation-lineage-mismatch', 'a self-consistent enrollment outside the completion lease');
    } finally { restoreEvidence(); }
  }
  refuses(() => current({ validation_key: 'plan-complete-unknown' }), 'plan-generation-evidence-missing', 'an unknown completion key');
  refuses(() => current({ validation_key: 'plan-begin-u0b' }), 'plan-generation-evidence-invalid', 'a begin is not a completion');
  refuses(() => pv.assertCurrentGeneration(root, { milestone: M, slice: 'S02', validation_key: 'plan-complete-u0b' }),
    'plan-generation-evidence-invalid', 'another slice');
  refuses(() => current({ approved: true }), 'plan-scope-invalid', 'an imported approved flag');
  refuses(() => current({ owner: TMP }), 'plan-generation-owner-mismatch', 'another owner named by the scope');
  const copied = path.join(TMP, `current-copy-${++sequence}`);
  fs.cpSync(root, copied, { recursive: true });
  refuses(() => pv.assertCurrentGeneration(copied, { milestone: M, slice: S, validation_key: 'plan-complete-u0b' }),
    'plan-generation-owner-mismatch', 'a copied owner');
  assert.strictEqual(current().status, 'current', 'the genuine evidence still holds');
});

// ── U0d: the shared canonical enrollment classification ───────────────────────

test('issue343 U0d one canonical classification: an enrolled lineage with a missing, pending, corrupt, foreign or ambiguous completion refuses', () => {
  const controller = require('./forge-unit-controller.js');
  const state = require('./forge-state.js');
  const prefsReader = () => ({ ok: true, prefs: { workflow: { skip_discuss: true, skip_research: true } } });
  const unit = `plan-slice/${S}`;
  const fresh = label => {
    const root = ownerRoot(label);
    state.write(root, { milestone: M, kind: 'milestone', phase: 'plan-slice', active_slice: S, active_task: '—', next_action: 'plan', auto_mode: 'on' });
    return root;
  };
  const request = extra => ({ milestone: M, unit, host_runtime: 'claude', session: 'session-neutral', ...extra });
  const begin = (root, key) => {
    const begun = controller.begin(root, request({ owner_token: `owner-${key}`, idempotency_key: key }), { prefsReader });
    assert.strictEqual(begun.ok, true, JSON.stringify(begun));
    return begun;
  };
  const finish = (root, begun, action, key, result, options) => controller.transition(root, request({ action, owner_token: begun.owner_token,
    generation: begun.generation, idempotency_key: key, result }), { prefsReader, ...(options || {}) });
  const classify = root => pv.classifySliceGeneration(root, { milestone: M, slice: S });
  const gate = root => pv.assertSliceGeneration(root, { milestone: M, slice: S });

  // No enrolled begin: the historical behavior, read-only, and a task without a slice passes.
  const none = fresh('class-none');
  assert.deepStrictEqual(withoutWrites(() => classify(none)), { status: 'unenrolled', milestone: M, slice: S });
  assert.deepStrictEqual([gate(none).status, pv.assertSliceGeneration(none, { milestone: M, slice: null }).status], ['unenrolled', 'unenrolled']);
  // Open: the enrolled begin has no terminal transition yet (the plan-slice is still running).
  const open = fresh('class-open');
  const opened = begin(open, 'plan-begin-open');
  publish(open, semanticBase());
  const openClass = withoutWrites(() => classify(open));
  assert.deepStrictEqual([openClass.status, openClass.begin_key, openClass.lease_generation], ['open', 'plan-begin-open', opened.generation]);
  refuses(() => withoutWrites(() => gate(open)), 'plan-generation-pending', 'an open enrolled lineage with a plan present');
  refuses(() => pv.assertSliceGeneration(open, { milestone: M, slice: null }), 'plan-generation-slice-unknown', 'a task without its slice');
  // Missing: the enrolled lineage ended without a successful completion.
  const ended = fresh('class-ended');
  const failedBegin = begin(ended, 'plan-begin-ended');
  assert.strictEqual(finish(ended, failedBegin, 'fail', 'plan-fail-ended', { status: 'failed', reason_code: 'worker-failed' }).transaction.phase, 'committed');
  publish(ended, semanticBase());
  assert.deepStrictEqual([classify(ended).status, classify(ended).terminal_action], ['ended', 'fail']);
  refuses(() => gate(ended), 'plan-generation-completion-missing', 'a failed lineage with a plan present');
  // Pending: an uncommitted completion intent of the enrolled lineage.
  const pending = fresh('class-pending');
  const pendingBegin = begin(pending, 'plan-begin-pending');
  publish(pending, semanticBase());
  assert.throws(() => finish(pending, pendingBegin, 'complete', 'plan-complete-pending', { status: 'succeeded' },
    { failpoint: name => name === 'after-intent' }), error => error.code === 'CONTROLLER_FAILPOINT');
  refuses(() => classify(pending), 'plan-generation-pending', 'an uncommitted completion');
  refuses(() => gate(pending), 'plan-generation-pending', 'an uncommitted completion at the gate');
  // Completed and current, then corrupt, foreign, other-lease and ambiguous variants of its records.
  const done = fresh('class-done');
  const doneBegin = begin(done, 'plan-begin-done');
  publish(done, semanticBase());
  assert.strictEqual(finish(done, doneBegin, 'complete', 'plan-complete-done', { status: 'succeeded' }).transaction.phase, 'committed');
  const doneClass = classify(done);
  assert.deepStrictEqual([doneClass.status, doneClass.begin_key, doneClass.validation_key], ['completed', 'plan-begin-done', 'plan-complete-done']);
  const admitted = withoutWrites(() => gate(done));
  assert.deepStrictEqual([admitted.status, admitted.validation_key], ['current', 'plan-complete-done']);
  const completionFile = controller.transactionFile(done, 'plan-complete-done'), completionBytes = fs.readFileSync(completionFile);
  const restore = () => fs.writeFileSync(completionFile, completionBytes);
  const rewriteCompletion = mutate => {
    const record = JSON.parse(JSON.stringify(controller.lookupRecord(done, 'transaction', 'plan-complete-done')));
    mutate(record);
    controller.writeAtomic(completionFile, record);
  };
  // Corrupt storage: bytes changed under the record's own storage checksum.
  fs.writeFileSync(completionFile, completionBytes.toString('utf8').replace('"succeeded"', '"failed"'));
  try {
    assert.strictEqual(refuses(() => classify(done), 'plan-generation-evidence-invalid', 'a corrupt completion').cause_code, 'record-conflict');
    assert.strictEqual(refuses(() => gate(done), 'plan-generation-evidence-invalid', 'a corrupt completion at the gate').cause_code, 'record-conflict');
  } finally { restore(); }
  // Foreign: a self-consistent completion of the same lease written for another owner digest.
  rewriteCompletion(record => { record.owner_digest = `sha256:${'9'.repeat(64)}`; });
  try { refuses(() => gate(done), 'plan-generation-lineage-mismatch', 'a completion of another owner'); } finally { restore(); }
  // Another lease: the completion no longer belongs to the enrolled begin, which stays open.
  rewriteCompletion(record => { record.lease_generation = 'lease-of-another-begin'; });
  try {
    assert.strictEqual(classify(done).status, 'open');
    refuses(() => gate(done), 'plan-generation-pending', 'a completion of another lease');
  } finally { restore(); }
  // Missing evidence on a self-consistent completion reaches the recheck by name.
  rewriteCompletion(record => {
    delete record.result[pv.TRANSACTION_FIELDS.validation];
    record.boundary.result_checksum = recordDigest(record.result);
  });
  try { refuses(() => gate(done), 'plan-generation-evidence-missing', 'a completion without its nested evidence'); } finally { restore(); }
  // Ambiguous: a second, consistently stored terminal transition of the same lineage.
  {
    const key = 'plan-complete-duplicate';
    const record = JSON.parse(JSON.stringify(controller.lookupRecord(done, 'transaction', 'plan-complete-done')));
    record.idempotency_key = key;
    record.event.idempotency_key = key;
    record.result.idempotency_key = key;
    record.boundary.idempotency_key = key;
    record.boundary.result_checksum = recordDigest(record.result);
    record.boundary.event_checksum = recordDigest(record.event);
    const file = controller.transactionFile(done, key);
    controller.writeAtomic(file, record);
    try {
      refuses(() => classify(done), 'plan-generation-ambiguous', 'two terminals of one lineage');
      refuses(() => gate(done), 'plan-generation-ambiguous', 'two terminals at the gate');
    } finally { fs.rmSync(file, { force: true }); }
  }
  assert.strictEqual(gate(done).status, 'current', 'the genuine records still hold');
  assert(fs.readFileSync(completionFile).equals(completionBytes), 'the classification never rewrites a record');
});

test('issue343 U0d readOwnerTaskPlan is the collector read of one T-plan, status-coded for the controller task DAG', () => {
  const root = published('single-plan');
  const scope = id => ({ milestone: M, slice: S, task: id });
  const read = withoutWrites(() => pv.readOwnerTaskPlan(root, scope('T01')));
  assert.deepStrictEqual([read.status, read.path, read.sha256, read.content],
    ['ok', `.gsd/milestones/${M}/slices/${S}/tasks/T01/T01-PLAN.md`, sha(fs.readFileSync(taskFile(root, 'T01'))), fs.readFileSync(taskFile(root, 'T01'), 'utf8')]);
  assert.deepStrictEqual(pv.readOwnerTaskPlan(root, scope('T09')), { status: 'missing' });
  assert.deepStrictEqual(pv.readOwnerTaskPlan(root, { milestone: M, slice: '..', task: 'T01' }), { status: 'invalid', reason: 'path-invalid' });
  assert.deepStrictEqual(pv.readOwnerTaskPlan(root, scope('X01')), { status: 'invalid', reason: 'path-invalid' });
  fs.mkdirSync(path.join(sliceDir(root), 'tasks', 'T04', 'T04-PLAN.md'), { recursive: true });
  assert.deepStrictEqual(pv.readOwnerTaskPlan(root, scope('T04')), { status: 'invalid', reason: 'not-regular' });
  const foreign = path.join(TMP, `foreign-${++sequence}`);
  fs.cpSync(path.dirname(taskFile(root, 'T03')), foreign, { recursive: true });
  fs.rmSync(path.dirname(taskFile(root, 'T03')), { recursive: true, force: true });
  fs.symlinkSync(foreign, path.dirname(taskFile(root, 'T03')), LINK);
  assert.deepStrictEqual(pv.readOwnerTaskPlan(root, scope('T03')), { status: 'invalid', reason: 'link' });
  // The BOM stays in the text, exactly as the collector keeps it.
  const bom = published('single-plan-bom', chain({ bom: true }));
  assert(pv.readOwnerTaskPlan(bom, scope('T02')).content.startsWith('﻿---'));
  assert.throws(() => pv.readOwnerTaskPlan(root, { ...scope('T01'), approved: true }), TypeError, 'an imported field is not a scope');
});

// ── Additions, records, list parity and the read-only CLI ─────────────────────

test('issue343 U0b additions admit only the strict altered subset and check references against the known set', () => {
  const root = published('addition');
  const scope = scopeFor(root);
  const known = collect(root);
  const withKnown = { ...scope, known };
  const knownText = id => known.task_plans.find(row => row.id === id).content;
  const addition = (ids, plans) => ({ slice_plan: { content: Array.isArray(ids) ? slicePlan(ids) : ids }, task_plans: plans });
  const t04 = { id: 'T04', content: taskPlan('T04', { depends: ['depends: [T03]'] }) };
  const four = ['T01', 'T02', 'T03', 'T04'];
  const added = pv.validateNewSlicePlan(addition(four, [t04]), withKnown);
  assert.deepStrictEqual([added.kind, added.graph_status, added.task_ids, added.added_task_ids, added.altered_task_ids, added.topological_order],
    ['addition', 'valid', four, ['T04'], [], four]);
  // The owner files written from the addition yield the same declarations, source and graph.
  fs.writeFileSync(sliceFile(root), slicePlan(four));
  fs.mkdirSync(path.dirname(taskFile(root, 'T04')), { recursive: true });
  fs.writeFileSync(taskFile(root, 'T04'), t04.content);
  const after = pv.validateNewSlicePlan(collect(root), scope);
  assert.deepStrictEqual([after.source, after.declarations, after.edges, after.graph_sha256, after.semantic_sha256],
    [added.source, added.declarations, added.edges, added.graph_sha256, added.semantic_sha256]);
  // Decompose: the altered container and its new decimal sub-tasks.
  const decomposed = [`# ${S}: Fixture slice`, '', '## Tasks', '', '- [ ] **T01**: T01 fixture task',
    '- [ ] **T02** *(DECOMPOSED — see sub-tasks below)*', '  - [ ] T02.1: first half', '  - [ ] T02.2: second half',
    '- [ ] **T03**: T03 fixture task', '', 'Slice prose.', ''].join('\n');
  const split = pv.validateNewSlicePlan(addition(decomposed, [
    { id: 'T02', content: knownText('T02').replace(/^---\n/, '---\nstatus: DECOMPOSED\n') },
    { id: 'T02.1', content: taskPlan('T02.1', { depends: ['depends: [T01]'] }) },
    { id: 'T02.2', content: taskPlan('T02.2', { depends: ['depends: [T02.1]'] }) },
  ]), withKnown);
  assert.deepStrictEqual([split.task_ids, split.added_task_ids, split.altered_task_ids, split.graph_status],
    [['T01', 'T02', 'T02.1', 'T02.2', 'T03'], ['T02.1', 'T02.2'], ['T02'], 'valid']);
  // An altered declaration alone, without a new task, is an addition too.
  const rewired = pv.validateNewSlicePlan(addition(['T01', 'T02', 'T03'], [{ id: 'T03', content: taskPlan('T03', { depends: ['depends: [T02]'] }) }]), withKnown);
  assert.deepStrictEqual([rewired.added_task_ids, rewired.altered_task_ids], [[], ['T03']]);
  assert.notStrictEqual(rewired.semantic_sha256, pv.validateNewSlicePlan(known, scope).semantic_sha256);
  // Refusals.
  const t04With = line => ({ id: 'T04', content: taskPlan('T04', { depends: [line] }) });
  refuses(() => pv.validateNewSlicePlan(addition(four, [t04With('depends: [T09]')]), withKnown), 'plan-dag-invalid', 'an unknown reference');
  refuses(() => pv.validateNewSlicePlan(addition(four, [t04With('depends: [T04]')]), withKnown), 'plan-dag-invalid', 'a self reference');
  refuses(() => pv.validateNewSlicePlan(addition(four, [{ id: 'T01', content: taskPlan('T01', { depends: ['depends: [T04]'] }) },
    t04With('depends: [T01]')]), withKnown), 'plan-dag-invalid', 'a cycle through an altered task');
  refuses(() => pv.validateNewSlicePlan(addition(four, [{ id: 'T01', content: knownText('T01') }, t04]), withKnown),
    'plan-addition-unaltered', 'an unaltered known task');
  refuses(() => pv.validateNewSlicePlan(addition(['T01', 'T03', 'T04'], [t04]), withKnown), 'plan-addition-task-removed', 'a known task removed');
  refuses(() => pv.validateNewSlicePlan(addition(['T02', 'T01', 'T03', 'T04'], [t04]), withKnown), 'plan-addition-order-changed', 'known tasks reordered');
  refuses(() => pv.validateNewSlicePlan(addition([...four, 'T05'], [t04]), withKnown), 'plan-task-list-mismatch', 'a listed task without a plan');
  refuses(() => pv.validateNewSlicePlan(addition(four, [t04, { id: 'T06', content: taskPlan('T06') }]), withKnown),
    'plan-task-list-mismatch', 'a returned task that is not listed');
  refuses(() => pv.validateNewSlicePlan(addition(four, [{ id: 'T04', content: taskPlan('T04', { writes: null }) }]), withKnown),
    'plan-declaration-writes-missing', 'a new task without writes');
  refuses(() => pv.validateNewSlicePlan(addition(four, [{ id: 'T04', content: '# no structured block\n' }]), withKnown),
    'plan-must-haves-legacy', 'a new task without must_haves');
  refuses(() => pv.validateNewSlicePlan(addition(four, [t04]), { ...scope, known: { ...known, task_plans: known.task_plans.slice(0, 2) } }),
    'plan-known-invalid', 'a known set that does not match its own list');
  // A genuine legacy known task stays legacy (sequential, never backfilled); a malformed one refuses.
  const legacyRoot = published('addition-legacy', candidate(['T01'], { T01: { depends: null, writes: null } }));
  const legacyKnown = collect(legacyRoot);
  refuses(() => pv.validateNewSlicePlan(legacyKnown, scopeFor(legacyRoot)), 'plan-declaration-depends-missing', 'a legacy plan is never admitted as new');
  const onLegacy = pv.validateNewSlicePlan(addition(['T01', 'T02'], [{ id: 'T02', content: taskPlan('T02', { depends: ['depends: [T01]'] }) }]),
    { ...scopeFor(legacyRoot), known: legacyKnown });
  assert.deepStrictEqual([onLegacy.graph_status, onLegacy.legacy_task_ids, onLegacy.declarations[0], onLegacy.topological_order],
    ['legacy', ['T01'], null, null]);
  const generation = pv.buildPlanGeneration({ owner: scope.owner, milestone: M, slice: S, begin_key: 'plan-begin-addition',
    lease_generation: 'lease-addition', owner_digest: `sha256:${'e'.repeat(64)}` });
  refuses(() => pv.buildPlanValidation(generation, added, { validatedAt: VALIDATED_AT }), 'plan-validation-invalid',
    'an addition is an owner amendment, not a plan_validation');
  const malformedRoot = published('addition-malformed', candidate(['T01'], { T01: { depends: ['depends: T00'] } }));
  refuses(() => pv.validateNewSlicePlan(addition(['T01', 'T02'], [{ id: 'T02', content: taskPlan('T02', { depends: ['depends: [T01]'] }) }]),
    { ...scopeFor(malformedRoot), known: collect(malformedRoot) }), 'plan-known-invalid', 'a malformed known declaration');
});

test('issue343 U0b plan_generation and plan_validation records are exact, bound and verified by recomputation', () => {
  const root = published('records');
  const scope = scopeFor(root);
  const admission = pv.validateNewSlicePlan(collect(root), scope);
  const input = { owner: scope.owner, milestone: M, slice: S, begin_key: 'plan-begin-records', lease_generation: 'lease-7',
    owner_digest: `sha256:${'b'.repeat(64)}` };
  const generation = pv.buildPlanGeneration(input);
  assert.deepStrictEqual(Object.keys(generation), ['schema_version', 'requirement', 'generation_key', 'owner', 'milestone', 'slice',
    'begin_key', 'lease_generation', 'owner_digest', 'requirement_sha256']);
  assert.deepStrictEqual([generation.schema_version, generation.requirement, generation.requirement_sha256, generation.owner],
    [1, 'explicit-depends-writes-v1', pv.REQUIREMENT_SHA256, admission.owner]);
  assert.match(generation.generation_key, /^[a-f0-9]{64}$/);
  assert(Object.isFrozen(generation), 'frozen enrollment');
  assert.strictEqual(pv.buildPlanGeneration({ ...input }).generation_key, generation.generation_key, 'deterministic');
  for (const [key, value] of [['begin_key', 'plan-begin-other'], ['lease_generation', 'lease-8'], ['owner_digest', `sha256:${'c'.repeat(64)}`],
    ['slice', 'S02'], ['milestone', 'M-20261108000002-other']]) {
    assert.notStrictEqual(pv.buildPlanGeneration({ ...input, [key]: value }).generation_key, generation.generation_key, `${key} is bound`);
  }
  assert.deepStrictEqual(pv.verifyPlanGeneration(JSON.parse(JSON.stringify(generation)), { begin_key: 'plan-begin-records', owner: scope.owner }),
    generation);
  refuses(() => pv.buildPlanGeneration({ ...input, approved: true }), 'plan-generation-invalid', 'an unknown input field');
  refuses(() => pv.buildPlanGeneration({ ...input, owner: 'relative/owner' }), 'plan-generation-invalid', 'a relative owner');
  refuses(() => pv.buildPlanGeneration({ ...input, owner_digest: 'owner-u0b' }), 'plan-generation-invalid', 'a raw owner token');
  refuses(() => pv.buildPlanGeneration({ ...input, begin_key: '' }), 'plan-generation-invalid', 'an empty begin key');
  refuses(() => pv.verifyPlanGeneration({ ...generation, approved: true }), 'plan-generation-invalid', 'an approved flag');
  refuses(() => pv.verifyPlanGeneration({ ...generation, lease_generation: 'lease-8' }), 'plan-generation-invalid', 'an edited lease generation');
  refuses(() => pv.verifyPlanGeneration({ ...generation, requirement_sha256: 'f'.repeat(64) }), 'plan-generation-invalid', 'another requirement');
  refuses(() => pv.verifyPlanGeneration(generation, { begin_key: 'plan-begin-other' }), 'plan-generation-invalid', 'another begin');
  const validation = pv.buildPlanValidation(generation, admission, { validatedAt: VALIDATED_AT });
  assert.deepStrictEqual(Object.keys(validation), ['requirement', 'generation_key', 'requirement_sha256', 'owner', 'milestone', 'slice',
    'begin_key', 'source', 'declarations', 'task_ids', 'edges', 'graph_sha256', 'validation_sha256', 'validated_at']);
  assert.deepStrictEqual(validation.source, { slice_plan: { path: admission.source.slice_plan.path, sha256: admission.source.slice_plan.sha256 },
    task_plans: admission.source.task_plans.map(row => ({ id: row.id, path: row.path, sha256: row.sha256 })) });
  assert.deepStrictEqual([validation.generation_key, validation.begin_key, validation.declarations, validation.task_ids, validation.edges,
    validation.graph_sha256], [generation.generation_key, 'plan-begin-records', admission.declarations, admission.task_ids, admission.edges,
    admission.graph_sha256]);
  assert.match(validation.validation_sha256, /^[a-f0-9]{64}$/);
  assert(Object.isFrozen(validation) && Object.isFrozen(validation.declarations[0].writes), 'frozen record');
  assert.strictEqual(pv.buildPlanValidation(generation, admission, { validatedAt: '2026-11-08T11:00:00.000Z' }).validation_sha256,
    validation.validation_sha256, 'validated_at is an observation only');
  assert.deepStrictEqual(pv.verifyPlanValidation(JSON.parse(JSON.stringify(validation)), generation), validation);
  refuses(() => pv.buildPlanValidation(generation, admission), 'plan-validation-invalid', 'no observation instant');
  refuses(() => pv.buildPlanValidation(generation, admission, { validatedAt: '2026-11-08' }), 'plan-validation-invalid', 'a non-canonical instant');
  refuses(() => pv.buildPlanValidation(pv.buildPlanGeneration({ ...input, slice: 'S02' }), admission, { validatedAt: VALIDATED_AT }),
    'plan-validation-invalid', 'another slice enrollment');
  refuses(() => pv.buildPlanValidation(generation, { ...admission, approved: true, schema: 'imported' }, { validatedAt: VALIDATED_AT }),
    'plan-validation-invalid', 'imported evidence');
  const tamper = mutate => {
    const record = JSON.parse(JSON.stringify(validation));
    mutate(record);
    return record;
  };
  for (const [label, mutate] of [
    ['an approved flag', record => { record.approved = true; }],
    ['a forged graph digest', record => { record.graph_sha256 = 'a'.repeat(64); }],
    ['dropped edges', record => { record.edges = []; }],
    ['reordered membership', record => { record.task_ids.reverse(); }],
    ['a foreign source path', record => { record.source.task_plans[0].path = 'docs/T01-PLAN.md'; }],
    ['a protected write', record => { record.declarations[0].writes = ['.gsd/STATE.md']; }],
    ['an edited declaration', record => { record.declarations[2].depends = ['T01']; }],
    ['an edited source digest', record => { record.source.slice_plan.sha256 = 'b'.repeat(64); }],
    ['a missing observation', record => { delete record.validated_at; }],
  ]) refuses(() => pv.verifyPlanValidation(tamper(mutate)), 'plan-validation-invalid', label);
  refuses(() => pv.verifyPlanValidation(validation, pv.buildPlanGeneration({ ...input, lease_generation: 'lease-8' })),
    'plan-validation-invalid', 'another enrollment');
});

test('issue343 U0b the S-plan list mirror keeps forge-status parsePlanTasks parity', () => {
  const status = require('./forge-status.js');
  const grammar = ['# S', '- [X] T01: an upper-case box is not a task', '- [x] T02 checked without colon', '-  [ ] T03 two spaces',
    '- [ ] **T04** bold, no colon', '  - [ ] T04.1: nested sub-task', '* [ ] T05 star bullet', '- [ ]T06 no space',
    '- [ ] T07x suffix', '- [ ] S01: not a task id', '```', '- [ ] T08: inside a fence still counts', '```', ''].join('\n');
  const texts = [slicePlan(['T01', 'T02']), slicePlan(['T01', 'T02.1'], { eol: '\r\n', checked: ['T02.1'], bom: true }), grammar, ''];
  for (const text of texts) {
    assert.deepStrictEqual(pv.listedTaskIds(text), status.parsePlanTasks(text).map(task => task.id), JSON.stringify(text.slice(0, 60)));
  }
  assert.deepStrictEqual(pv.listedTaskIds(grammar), ['T02', 'T04', 'T04.1', 'T07', 'T08']);
});

test('issue343 U0b the read-only CLI checks the owner plan and names a refusal', () => {
  const root = published('cli');
  const run = args => spawnSync(process.execPath, [MODULE, ...args], { encoding: 'utf8', cwd: TMP, timeout: 60000 });
  const ok = run(['--check', '--cwd', root, '--milestone', M, '--slice', S]);
  assert.strictEqual(ok.status, 0, ok.stderr);
  const out = JSON.parse(ok.stdout);
  assert.deepStrictEqual([out.ok, out.mode, out.evidence.task_ids, out.evidence.semantic_sha256],
    [true, 'check', ['T01', 'T02', 'T03'], pv.validateNewSlicePlan(collect(root), scopeFor(root)).semantic_sha256]);
  fs.writeFileSync(taskFile(root, 'T02'), taskPlan('T02', { writes: null }));
  const refused = run(['--check', '--cwd', root, '--milestone', M, '--slice', S]);
  assert.strictEqual(refused.status, 1, refused.stdout);
  assert.deepStrictEqual([JSON.parse(refused.stdout).ok, JSON.parse(refused.stdout).code], [false, 'plan-declaration-writes-missing']);
  const incomplete = run(['--current', '--cwd', root, '--milestone', M, '--slice', S]);
  assert.deepStrictEqual([incomplete.status, JSON.parse(incomplete.stdout).code], [1, 'plan-scope-invalid']);
  const usage = run(['--check', '--bogus', 'x']);
  assert.strictEqual(usage.status, 2);
  assert.match(usage.stderr, /Usage:/);
});

// ── Summary ───────────────────────────────────────────────────────────────────


// Focused regressions for D1/D3: every begin/completion is produced by the real
// controller. The only deliberate mutations below are relevant event sequences.
function generationRegressionFixture(label, foreignHistory = false) {
  const controller = require('./forge-unit-controller.js');
  const state = require('./forge-state.js');
  const root = ownerRoot(label), unit = `plan-slice/${S}`;
  const prefsReader = () => ({ ok: true, prefs: { workflow: { skip_discuss: true, skip_research: true } } });
  state.write(root, { milestone: M, kind: 'milestone', phase: 'plan-slice', active_slice: S, active_task: '—', next_action: 'plan', auto_mode: 'on' });
  if (foreignHistory) fs.writeFileSync(controller.eventsFile(root, M), JSON.stringify({ event: 'foreign-old-schema', schema_version: 0 }) + '\n');
  const request = extra => ({ milestone: M, unit, host_runtime: 'claude', session: 'session-neutral', ...extra });
  const begin = key => controller.begin(root, request({ owner_token: `owner-${key}`, idempotency_key: key }), { prefsReader });
  const complete = (begun, key) => controller.complete(root, request({ owner_token: begun.owner_token, generation: begun.generation,
    idempotency_key: key, result: { status: 'succeeded' } }), { prefsReader });
  return { root, controller, begin, complete };
}

test('issue343 U0d current generation keys reject superseded completions in the API and CLI without changing committed replay', () => {
  const f = generationRegressionFixture('current-superseded');
  const first = f.begin('current-g0-begin');
  publish(f.root, semanticBase());
  assert.strictEqual(f.complete(first, 'current-g0-complete').transaction.phase, 'committed');
  const scope = key => ({ milestone: M, slice: S, validation_key: key });
  assert.strictEqual(withoutWrites(() => pv.assertCurrentGeneration(f.root, scope('current-g0-complete'))).status, 'current');
  const oldFile = f.controller.transactionFile(f.root, 'current-g0-complete'), oldBytes = fs.readFileSync(oldFile);
  const next = f.begin('current-g1-begin');
  assert.strictEqual(pv.classifySliceGeneration(f.root, { milestone: M, slice: S }).status, 'open');
  refuses(() => withoutWrites(() => pv.assertCurrentGeneration(f.root, scope('current-g0-complete'))),
    'plan-generation-pending', 'an explicit old completion while a new enrolled begin is open');
  const cli = key => spawnSync(process.execPath, [MODULE, '--current', '--cwd', f.root, '--milestone', M, '--slice', S,
    '--validation-key', key], { encoding: 'utf8', cwd: TMP, timeout: 60000 });
  const stale = cli('current-g0-complete');
  assert.deepStrictEqual([stale.status, JSON.parse(stale.stdout).ok, JSON.parse(stale.stdout).code],
    [1, false, 'plan-generation-pending'], stale.stderr || stale.stdout);
  assert.strictEqual(f.complete(first, 'current-g0-complete').reason, 'already-committed', 'historical committed replay stays first');
  assert(fs.readFileSync(oldFile).equals(oldBytes), 'the historical completion is not rewritten or backfilled');
  assert.strictEqual(f.complete(next, 'current-g1-complete').transaction.phase, 'committed');
  refuses(() => withoutWrites(() => pv.assertCurrentGeneration(f.root, scope('current-g0-complete'))),
    'plan-generation-lineage-mismatch', 'the explicit key must name the latest completed lineage');
  const current = cli('current-g1-complete');
  assert.strictEqual(current.status, 0, current.stderr || current.stdout);
  assert.strictEqual(JSON.parse(current.stdout).generation.validation_key, 'current-g1-complete');
});

test('issue343 U0d enrolled begin ordering refuses duplicate or reordered relevant published sequences and preserves foreign history', () => {
  const none = generationRegressionFixture('ordering-unenrolled', true);
  assert.strictEqual(pv.classifySliceGeneration(none.root, { milestone: M, slice: S }).status, 'unenrolled');
  assert.strictEqual(pv.assertSliceGeneration(none.root, { milestone: M, slice: S }).status, 'unenrolled');
  for (const [kind, expected] of [['duplicate-sequence', 'plan-generation-ambiguous'],
    ['reordered-sequence', 'plan-generation-evidence-invalid'], ['duplicate-event', 'plan-generation-ambiguous']]) {
    const f = generationRegressionFixture(`ordering-${kind}`, true);
    const first = f.begin(`${kind}-g0-begin`);
    publish(f.root, semanticBase());
    f.complete(first, `${kind}-g0-complete`);
    const next = f.begin(`${kind}-g1-begin`);
    f.complete(next, `${kind}-g1-complete`);
    // The foreign old-schema prefix has no sequence, but the controller's own
    // begin events still have their canonical positions in the mixed stream.
    assert.strictEqual(pv.assertSliceGeneration(f.root, { milestone: M, slice: S }).validation_key, `${kind}-g1-complete`);
    const file = f.controller.eventsFile(f.root, M), events = f.controller.readEvents(file);
    const a = events.find(event => event.idempotency_key === `${kind}-g0-begin`);
    const b = events.find(event => event.idempotency_key === `${kind}-g1-begin`);
    assert(a.sequence < b.sequence);
    if (kind === 'duplicate-sequence') b.sequence = a.sequence;
    else if (kind === 'reordered-sequence') [a.sequence, b.sequence] = [b.sequence, a.sequence];
    else events.push({ ...b, sequence: events.length + 1 });
    fs.writeFileSync(file, events.map(event => JSON.stringify(event)).join('\n') + '\n');
    refuses(() => withoutWrites(() => pv.classifySliceGeneration(f.root, { milestone: M, slice: S })), expected, kind);
    refuses(() => withoutWrites(() => pv.assertSliceGeneration(f.root, { milestone: M, slice: S })), expected, `${kind}: shared gate`);
    refuses(() => withoutWrites(() => pv.assertCurrentGeneration(f.root, { milestone: M, slice: S,
      validation_key: `${kind}-g1-complete` })), expected, `${kind}: explicit current key`);
  }
});

console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best-effort cleanup of synthetic fixtures */ }
if (failed > 0) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  ✗ ${failure.name}\n      ${failure.error && failure.error.message}`);
  process.exit(1);
}
process.exit(0);
