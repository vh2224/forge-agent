#!/usr/bin/env node
'use strict';

// forge-execution-batch-isolation.test.js — issue 343 U2a: the measured dirty base and one
// exclusive worktree and index per batch member and root, prepared for a REAL cohort (the real
// long-workflow adapter, loop, orchestrate and controller dispatch it) in real disposable Git.
//
//   U2a-1 two member worktrees reproduce the dirty base (staged and unstaged kept apart, a
//         binary, deletions, a rename, an index mode, legitimate untracked files, paths with a
//         space and non-ASCII characters) while the integration HEAD, index bytes and raw
//         working tree stay byte-identical; replays in process and in a fresh process create
//         nothing new;
//   U2a-2 unrepresentable bases fall back to one named serial reason, and foreign or aliased
//         roots, an unstable or changed source and forged, cloned, serialized, stale or
//         foreign handles refuse — before any provider, with nothing materialized; a crash
//         after the member worktree or after its materialization resumes in a fresh process.
//
// Everything is synthetic and local: temporary HOME/USERPROFILE/FORGE_HOME (no operator
// preference), `git init` roots with pinned local config, FORGE_RESOURCES_PRESSURE=1 (the
// documented forced-normal seam of forge-resources), no provider, network or real history.
// The only injected seams are the trusted in-process isolation failpoints and limits (limits
// can only be tightened) and a wrapper around the real setupForBatchMember export that
// observes its real arguments (and once perturbs the source before delegating).

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-batch-isolation-')));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME, { recursive: true });
const SAVED_ENV = Object.fromEntries(['HOME', 'USERPROFILE', 'FORGE_HOME', 'FORGE_RESOURCES_PRESSURE'].map(name => [name, process.env[name]]));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.FORGE_HOME = path.join(HOME, '.forge-agent');
process.env.FORGE_RESOURCES_PRESSURE = '1';
// Each case must be able to prepare/capture without a prior case having
// installed its mandatory procedures. Never read the operator installation.
fs.cpSync(path.join(__dirname, '..', 'shared'), path.join(process.env.FORGE_HOME, 'shared'), { recursive: true });

const adapter = require('./forge-long-workflow-adapter');
const loop = require('./forge-loop-controller');
const controller = require('./forge-unit-controller');
const batch = require('./forge-execution-batch');
const isolation = require('./forge-isolation');
const state = require('./forge-state');
const runs = require('./forge-runs');
const claims = require('./forge-write-claim');
const rootsApi = require('./forge-code-roots');

const M = 'M-20261108000000-batch';
const S = 'S01';
const TOKEN = 'owner-isolation-token-3a7e';
const SESSION = 'session-isolation-private-5b90';
const BATCH_MODULE = path.join(__dirname, 'forge-execution-batch.js');
// The legacy-sibling worktree anchor of every fixture owner (TMP/<label>-<n>) and run id.
const WORKTREES = path.join(TMP, '.forge-worktrees');
const COMMIT = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m'];
const SPACED = 'docs/relatório final ção.txt';
const UNTRACKED_SPACED = 'notas/rascunho ç ã.md';
const BINARY_HEAD = Buffer.from([0, 1, 2, 3, 13, 10, 255, 254, 0, 127]);
const BINARY_STAGED = Buffer.from([255, 0, 13, 10, 26, 0, 1, 128, 200]);
const BINARY_NEW = Buffer.from([0, 0, 1, 255, 13]);
const NUL = '\u0000';

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

// ── Fixtures ──────────────────────────────────────────────────────────────────

let serial = 0;
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; }
function at(root, rel) { return path.join(root, ...rel.split('/')); }
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
// Test-side git: argv only and never an optional lock, so no fixture read rewrites an index.
function git(cwd, args, options = {}) {
  const run = spawnSync('git', args, { cwd, encoding: options.encoding || 'utf8', windowsHide: true, timeout: 60000,
    ...(options.input === undefined ? {} : { input: options.input }), env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  assert.strictEqual(run.status, 0, `git ${args.join(' ')}: ${run.stderr || run.error}`);
  return run.stdout;
}
// A real owner whose root is a real Git checkout: ROADMAP, CONTEXT, RESEARCH, STATE and, unless
// `commit: false`, one committed base (.gitignore and src/keep.js).
function owner(label, options = {}) {
  const dir = path.join(TMP, `${label}-${++serial}`);
  const base = path.join(dir, '.gsd', 'milestones', M);
  fs.mkdirSync(base, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  if (options.prefs) write(path.join(dir, '.gsd', 'forge-prefs.jsonc'), JSON.stringify(options.prefs(dir), null, 2));
  write(path.join(base, `${M}-ROADMAP.md`), `# Roadmap\n\n- [ ] **${S}: Work** \`depends:[]\`\n`);
  write(path.join(base, `${M}-CONTEXT.md`), '# Context\n');
  write(path.join(base, `${M}-RESEARCH.md`), '# Research\n');
  state.write(dir, { milestone: M, kind: 'milestone', phase: 'idle', active_slice: '—', active_task: '—', next_action: 'plan', auto_mode: 'on' });
  if (options.commit !== false) {
    write(at(dir, '.gitignore'), `build/\n*.log\n${options.ignore || ''}`);
    write(at(dir, 'src/keep.js'), 'module.exports = "keep";\n');
    git(dir, ['add', '--', '.gitignore', 'src']);
    git(dir, [...COMMIT, 'base']);
  }
  return dir;
}
// The predecessor's uncommitted work every member must start from.
function dirtyBase(dir) {
  const files = { 'src/staged.js': 'staged v1\n', 'src/both.js': 'both v1\n', 'src/unstaged.js': 'unstaged v1\n',
    'src/gone-staged.js': 'gone staged\n', 'src/gone-unstaged.js': 'gone unstaged\n', 'src/old-name.js': 'renamed content\n',
    'bin/tool.sh': '#!/bin/sh\necho tool\n', [SPACED]: 'relatório v1\n', 'docs/crlf.txt': 'line one\nline two\n' };
  for (const [rel, content] of Object.entries(files)) write(at(dir, rel), content);
  write(at(dir, 'assets/logo.bin'), BINARY_HEAD);
  git(dir, ['add', '--', 'src', 'bin', 'docs', 'assets']);
  git(dir, [...COMMIT, 'predecessor base']);
  write(at(dir, 'src/staged.js'), 'staged v2\n');
  git(dir, ['add', '--', 'src/staged.js']);
  write(at(dir, 'src/both.js'), 'both v2 staged\n');
  git(dir, ['add', '--', 'src/both.js']);
  write(at(dir, 'src/both.js'), 'both v3 unstaged on top\n');
  write(at(dir, 'src/unstaged.js'), 'unstaged v2\n');
  git(dir, ['rm', '-q', '--', 'src/gone-staged.js']);
  fs.unlinkSync(at(dir, 'src/gone-unstaged.js'));
  git(dir, ['mv', 'src/old-name.js', 'src/new-name.js']);
  git(dir, ['update-index', '--chmod=+x', 'bin/tool.sh']);
  write(at(dir, 'assets/logo.bin'), BINARY_STAGED);
  git(dir, ['add', '--', 'assets/logo.bin']);
  write(at(dir, SPACED), 'relatório v2, não staged\n');
  write(at(dir, 'docs/crlf.txt'), 'line one\r\nline two changed\r\n');
  write(at(dir, UNTRACKED_SPACED), 'rascunho não rastreado\n');
  write(at(dir, 'assets/new.bin'), BINARY_NEW);
  write(at(dir, 'build/out.txt'), 'ignored build output\n');
  write(at(dir, 'debug.log'), 'ignored log\n');
  write(at(dir, '.forge-claude-sidecar-fixture/prompt.txt'), 'another unit private prompt\n');
}
// A new task plan the strict admission accepts (the U1 fixture shape).
function taskPlan(id, options = {}) {
  const writes = options.writes || [`src/${id.toLowerCase().replace('.', '-')}.js`];
  const artifact = options.artifact || writes[0];
  const lines = ['---', 'tier: standard', `depends: [${(options.depends || []).join(', ')}]`, 'writes:', ...writes.map(item => `  - "${item}"`)];
  lines.push('must_haves:', '  truths:', `    - "${id} fixture behavior is observable"`, '  artifacts:', `    - path: "${artifact}"`,
    '      provides: "fixture module"', '      min_lines: 1',
    ...(options.inputs?.length ? ['  key_links:', ...options.inputs.flatMap(input => [
      `    - from: "${input}"`, `      to: "${artifact}"`, '      via: "explicit fixture read-only input"'])] : ['  key_links: []']),
    'expected_output:', `  - ${artifact}`,
    '---', '', `# ${id}: Fixture task`, '', 'Prose never counts as a declaration.', '');
  return lines.join('\n');
}
function independent(ids) { return Object.fromEntries(ids.map(id => [id, taskPlan(id)])); }
function sliceDir(dir) { return path.join(dir, '.gsd', 'milestones', M, 'slices', S); }
function writePlan(dir, tasks) {
  const ids = Object.keys(tasks);
  write(path.join(sliceDir(dir), `${S}-PLAN.md`), [`# ${S}: Fixture slice`, '', '## Tasks', '',
    ...ids.map(id => `- [ ] **${id}**: ${id} fixture task`), '', 'Slice prose.', ''].join('\n'));
  write(path.join(sliceDir(dir), `${S}-RESEARCH.md`), '# Slice research\n');
  for (const [id, content] of Object.entries(tasks)) {
    write(path.join(sliceDir(dir), 'tasks', id, `${id}-PLAN.md`), content);
    write(path.join(sliceDir(dir), 'tasks', id, `${id}-PLAN-GATE.md`), `---\nstatus: approved\nplan_sha256: ${digest(content)}\n---\n`);
  }
}
// The real enrolled plan-slice lineage: controller begin, the planner's owner bytes and the
// strictly admitted completion.
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
}
// Real capture/build/completion fixture, also used to distinguish a foreign proof namespace.
function completePredecessor(dir, id, planText, output, codeDir = dir) {
  const begun = controller.begin(dir, { milestone: M, unit: `execute-task/${id}`, slice: S, state_patch: { active_slice: S },
    host_runtime: 'codex', owner_token: TOKEN, idempotency_key: `predecessor-${id}-begin` }, {});
  assert.strictEqual(begun.ok, true, JSON.stringify(begun));
  write(at(codeDir, output), 'real predecessor output\n');
  const roots = require('./forge-code-roots'), delivery = require('./forge-delivery'), verify = require('./forge-verify');
  const contract = roots.singleContract(dir, codeDir), unit = { type: 'task', id, slice: S, milestone: M }, key = delivery.unitKey(unit);
  const command = `node -e "require('assert').strictEqual(require('fs').readFileSync('${output}','utf8'),'real predecessor output\\n')"`;
  const captured = verify.captureRootDelivery(contract, planText, { unit, preferenceCommands: [command], commandTimeoutMs: 30000 });
  assert.strictEqual(captured.passed, true, JSON.stringify(captured));
  const base = `.gsd/milestones/${M}/slices/${S}/tasks/${id}`, rel = name => `${base}/${id}-${name}`;
  write(at(dir, rel('VERIFY-ENVELOPE.json')), JSON.stringify(captured.gate.roots[0]));
  write(at(dir, rel('ARTIFACT-ENVELOPE.json')), JSON.stringify(captured.artifacts[0]));
  const input = { schema_version: 2, unit, plan: rel('PLAN.md'), plan_fingerprint: delivery.sha256(planText), execution_contract: contract,
    bindings: [{ criterion_id: `${key}:truth:0`, root_id: 'primary', coverage: 'behavioral', source: { kind: 'verification', path: rel('VERIFY-ENVELOPE.json'), check_index: 0 } },
      { criterion_id: `${key}:artifact:0`, root_id: 'primary', coverage: 'structural', source: { kind: 'artifact', path: rel('ARTIFACT-ENVELOPE.json'), row_index: 0, property: 'exists' } }] };
  write(at(dir, rel('DELIVERY-INPUT.json')), JSON.stringify(input));
  const built = delivery.buildDelivery(input, { ownerRoot: dir, codeDir });
  assert(built.criteria.length === 2 && built.criteria.every(row => row.status === 'verificado'), JSON.stringify(built));
  write(at(dir, rel('DELIVERY.json')), JSON.stringify(built));
  controller.complete(dir, { milestone: M, unit: `execute-task/${id}`, host_runtime: 'codex', owner_token: TOKEN,
    generation: begun.generation, idempotency_key: `predecessor-${id}-complete`, result: { status: 'succeeded' } }, {});
  const sliceFile = path.join(sliceDir(dir), `${S}-PLAN.md`);
  fs.writeFileSync(sliceFile, fs.readFileSync(sliceFile, 'utf8').replace(`- [ ] **${id}**`, `- [x] **${id}**`));
}

// The real cohort: the loop's auto next through the long-workflow adapter dispatches T01 and
// T02 with committed begins and live leases (U1).
function cohort(dir, tasks) {
  planSlice(dir, tasks || independent(['T01', 'T02']));
  const snapshot = loop.create({ mode: 'auto', workflow_id: `wf-${++serial}`, host_runtime: 'codex', max_steps: 10 });
  const result = adapter.invoke('codex', 'auto', 'next', { cwd: dir, milestone: M, owner_token: TOKEN, session: SESSION }, snapshot, {}).result;
  assert.deepStrictEqual([result.outcome, result.action], ['dispatch_required', 'dispatch-batch'], JSON.stringify(result.controller_result));
  const dispatched = result.controller_result.details.dispatch_batch;
  assert.deepStrictEqual(dispatched.members.map(member => member.unit.key), ['execute-task/T01', 'execute-task/T02']);
  return { batch_id: dispatched.batch_id, manifest_sha256: dispatched.manifest_sha256 };
}
function scopeOf(dir, ids, label, extra = {}) {
  const runId = runLabel(label);
  if (!runs.get(dir, runId)) {
    runs.add(dir, { id: runId, kind: 'milestone', session_id: SESSION, host_runtime: 'codex',
      project: dir, cwd: dir, milestone_dir: `.gsd/milestones/${M}/`, isolation_mode: 'worktree' });
    const declarations = batch.readManifest(dir, ids.batch_id).members.map(member => require('./forge-must-haves').parseExecutionFields(fs.readFileSync(at(dir, member.plan.path), 'utf8')));
    const declared = [...new Map(declarations.flatMap(declaration => declaration.code_roots || [{ id: 'primary', path: dir, vcs: 'git' }]).map(root => [root.id, root])).values()];
    const contract = rootsApi.validateContract({ schema_version: 2, owner: dir, primary_root_id: declarations[0].primary_root_id || 'primary', code_roots: declared });
    // Unborn Git has no measured baseline: register the real run, then exercise
    // the named no-materialization result without fabricating a claim baseline.
    if (require('./forge-claim-release').measureBaseline(dir, { vcs: 'git' }).ok) claims.recordClaim(dir, runId, {
      schema_version: 2, execution_contract: contract, source: 'plan-writes', unit: 'BATCH:T01,T02',
      paths: contract.code_roots.map(root => ({ root_id: root.id, path: '**' })),
    });
  }
  return { cwd: dir, milestone: M, host_runtime: 'codex', owner_token: TOKEN, batch_id: ids.batch_id, manifest_sha256: ids.manifest_sha256,
    run_id: runId, ...extra };
}
function runLabel(label) { return `M-20261108000001-${label}`; }
function areaOf(label) { return path.join(WORKTREES, runLabel(label), '.batch'); }
function states(dir, ids) { return batch.readProgress(dir, batch.readManifest(dir, ids.batch_id)).map(row => row.state); }
// path → SHA-256 of the raw bytes of every file below `root` that `skip` keeps.
function tree(root, skip) {
  const out = {};
  const walk = rel => {
    for (const entry of fs.readdirSync(rel ? at(root, rel) : root, { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (skip(child)) continue;
      if (entry.isDirectory()) walk(child);
      else out[child] = entry.isFile() ? digest(fs.readFileSync(at(root, child))) : 'not-a-file';
    }
  };
  walk('');
  return out;
}
function integration(dir) {
  return { head: git(dir, ['rev-parse', 'HEAD']).trim(), symbolic: git(dir, ['symbolic-ref', 'HEAD']).trim(),
    index: fs.readFileSync(path.join(dir, '.git', 'index')), wip: tree(dir, rel => rel === '.git' || rel === '.gsd'),
    refs: git(dir, ['for-each-ref', '--format=%(refname) %(objectname)']).split(/\r?\n/).filter(Boolean),
    commits: git(dir, ['rev-list', '--all', '--count']).trim() };
}
function assertIntegrationUnchanged(dir, before, label, memberRefs) {
  const after = integration(dir);
  assert.strictEqual(after.head, before.head, `${label}: HEAD`);
  assert.strictEqual(after.symbolic, before.symbolic, `${label}: the integration branch was never checked out or moved`);
  assert(after.index.equals(before.index), `${label}: the integration index bytes are identical`);
  assert.deepStrictEqual(after.wip, before.wip, `${label}: the raw integration working tree is identical`);
  assert.strictEqual(after.commits, before.commits, `${label}: no commit`);
  assert(!after.refs.some(line => line.startsWith('refs/stash ')), `${label}: no stash`);
  assert(before.refs.every(line => after.refs.includes(line)), `${label}: no ref moved`);
  const added = after.refs.filter(line => !before.refs.includes(line));
  assert.deepStrictEqual(added.map(line => line.split(' ')[0]).sort(), [...memberRefs].sort(), `${label}: only the member refs are new`);
  for (const line of added) assert.strictEqual(line.split(' ')[1], before.head, `${label}: a member ref starts at the measured HEAD`);
}
// What git itself reports, without owner metadata or a sidecar's private prompt staging.
function statusOf(root) {
  const raw = git(root, ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], { encoding: 'buffer' });
  return raw.toString('utf8').split(NUL).filter(Boolean).filter(token => {
    const rel = token.slice(3);
    return !(rel === '.gsd' || rel.startsWith('.gsd/') || rel.startsWith('.forge-claude-sidecar-'));
  });
}
function linked(dir) {
  return git(dir, ['worktree', 'list', '--porcelain']).split(/\r?\n/).filter(line => line.startsWith('worktree ')).slice(1)
    .map(line => fs.realpathSync.native(line.slice('worktree '.length)));
}
// prepareIsolation in a fresh process: no handle, failpoint or cache of this one survives.
function freshPrepare(scope) {
  const script = [`const batch = require(${JSON.stringify(BATCH_MODULE)});`, 'let out;',
    'try { out = batch.prepareIsolation(JSON.parse(process.argv[1])); } catch (error) { out = { thrown: error.code || error.message }; }',
    'process.stdout.write(JSON.stringify(out));'].join('\n');
  const child = spawnSync(process.execPath, ['-e', script, JSON.stringify(scope)], { encoding: 'utf8', timeout: 180000, windowsHide: true, env: { ...process.env } });
  assert.strictEqual(child.status, 0, child.stderr || String(child.error));
  return JSON.parse(child.stdout);
}
// Observes the real setupForBatchMember export forge-execution-batch calls, then delegates.
function observing(onCall, fn) {
  const real = isolation.setupForBatchMember;
  isolation.setupForBatchMember = (handle, baseRef, trusted) => { onCall(handle, baseRef); return real(handle, baseRef, trusted); };
  try { return fn(); } finally { isolation.setupForBatchMember = real; }
}
function refusal(fn, code, label) {
  assert.throws(fn, error => {
    assert.strictEqual(error && error.code, code, `${label}: ${error && error.stack}`);
    return true;
  }, label);
  assert(isolation.BATCH_ISOLATION_REFUSALS.includes(code), `${label}: ${code} is a closed isolation refusal`);
}

// ── U2a-1 ─────────────────────────────────────────────────────────────────────

test('issue343 U2a-1 two member worktrees reproduce the dirty base while integration HEAD, index and WIP stay byte-identical', () => {
  assert(os.cpus().length >= 2, 'the forced-normal resource budget needs two CPUs for a cohort of two');
  const dir = owner('dirty');
  dirtyBase(dir);
  const ids = cohort(dir, { T01: taskPlan('T01', { inputs: ['primary::assets/new.bin', `primary::${UNTRACKED_SPACED}`] }), T02: taskPlan('T02') });
  const scope = scopeOf(dir, ids, 'dirty');
  // The measured base really is dirty in every dimension the members must reproduce.
  const statusBefore = statusOf(dir);
  const codes = Object.fromEntries(statusBefore.map(token => [token.slice(3), token.slice(0, 2)]));
  assert.deepStrictEqual(['src/staged.js', 'src/both.js', 'src/unstaged.js', 'src/gone-staged.js', 'src/gone-unstaged.js', 'src/old-name.js',
    'src/new-name.js', 'assets/logo.bin', SPACED, 'docs/crlf.txt', 'assets/new.bin', UNTRACKED_SPACED].map(rel => codes[rel]),
  ['M ', 'MM', ' M', 'D ', ' D', 'D ', 'A ', 'M ', ' M', ' M', '??', '??'], JSON.stringify(codes));
  assert.strictEqual(codes['bin/tool.sh'][0], 'M', 'a staged index-mode change');
  const before = integration(dir);
  const started = Date.now();
  const prepared = batch.prepareIsolation(scope);
  const elapsed = Date.now() - started;
  assert.strictEqual(prepared.status, 'prepared', JSON.stringify(prepared));
  assert.deepStrictEqual(prepared.members.map(member => [member.task_id, member.roots.length]), [['T01', 1], ['T02', 1]]);
  assert.deepStrictEqual(prepared.skipped, []);
  const summary = prepared.base.roots[0];
  const pkg = JSON.parse(fs.readFileSync(path.join(prepared.base.batch_dir, 'base', 'package.json'), 'utf8'));
  assert(/^[a-f0-9]{64}$/.test(pkg.batch.base_inputs_sha256), 'the package pins the whole admitted input inventory');
  for (const entry of pkg.roots[0].inventory.filter(row => !row.tracked)) {
    assert(entry.provenance.some(origin => origin.task_id === 'T01' && origin.field.startsWith('key_links[')
      && origin.root_id === 'primary' && origin.path === entry.path && origin.authority === 'manifest-member-plan'
      && origin.plan_sha256 === batch.readManifest(dir, ids.batch_id).members[0].plan.sha256
      && origin.generation_key === batch.readManifest(dir, ids.batch_id).generation.generation_key), 'explicit read-only input provenance');
  }
  assert.deepStrictEqual([summary.root_id, summary.head, summary.index_entries, summary.files, summary.deleted, summary.untracked, summary.package_blobs],
    ['primary', before.head, 11, 12, 1, 2, 6], JSON.stringify(summary));
  const roots = prepared.members.map(member => member.roots[0]);
  assert.notStrictEqual(roots[0].path, roots[1].path, 'distinct member roots');
  assert.notStrictEqual(roots[0].branch, roots[1].branch, 'distinct member refs');
  const product = tree(dir, rel => ['.git', '.gsd', 'build', 'debug.log', '.forge-claude-sidecar-fixture'].includes(rel));
  const integrationIndex = path.join(dir, '.git', 'index').toLowerCase();
  const memberIndexes = [];
  roots.forEach((root, index) => {
    const label = prepared.members[index].task_id;
    // Its own registered worktree on its own sibling ref, beside the run anchor, outside the owner.
    assert(root.path.startsWith(areaOf('dirty') + path.sep), `${label}: inside the batch area of the run anchor (${root.path})`);
    assert(!root.path.toLowerCase().startsWith(dir.toLowerCase() + path.sep), `${label}: outside the owner and its code root`);
    assert.strictEqual(fs.realpathSync.native(git(root.path, ['rev-parse', '--show-toplevel']).trim()), root.path, `${label}: its own toplevel`);
    assert.strictEqual(git(root.path, ['branch', '--show-current']).trim(), root.branch, `${label}: on its member ref`);
    assert(root.branch.startsWith(`forge/${runLabel('dirty')}-batch-`) && !root.branch.startsWith(`forge/${runLabel('dirty')}/`), `${label}: a sibling of the run branch`);
    assert.strictEqual(git(root.path, ['rev-parse', 'HEAD']).trim(), before.head, `${label}: at the measured HEAD`);
    assert(linked(dir).includes(root.path), `${label}: registered with the integration repository`);
    // Its own index file, holding exactly the integration's logical index.
    const memberIndex = path.resolve(root.path, git(root.path, ['rev-parse', '--git-path', 'index']).trim()).toLowerCase();
    assert.notStrictEqual(memberIndex, integrationIndex, `${label}: an exclusive index`);
    memberIndexes.push(memberIndex);
    assert(git(root.path, ['ls-files', '-s', '-z'], { encoding: 'buffer' }).equals(git(dir, ['ls-files', '-s', '-z'], { encoding: 'buffer' })),
      `${label}: the logical index (path, stage, mode, blob)`);
    // The bytes and what git sees: staged and unstaged apart, binary, deletions, the rename,
    // the mode and the legitimate untracked files — nothing ignored, owned or private.
    assert.deepStrictEqual(tree(root.path, rel => rel === '.git'), product, `${label}: the working-tree bytes`);
    assert.deepStrictEqual(statusOf(root.path), statusBefore, `${label}: git sees the measured staged and unstaged state`);
    assert.strictEqual(git(root.path, ['show', ':src/both.js']), 'both v2 staged\n', `${label}: the staged version`);
    assert.strictEqual(fs.readFileSync(at(root.path, 'src/both.js'), 'utf8'), 'both v3 unstaged on top\n', `${label}: the unstaged version on top`);
    assert(fs.readFileSync(at(root.path, 'assets/logo.bin')).equals(BINARY_STAGED), `${label}: the staged binary`);
    assert(fs.readFileSync(at(root.path, 'assets/new.bin')).equals(BINARY_NEW), `${label}: the untracked binary`);
    assert(fs.readFileSync(at(root.path, 'docs/crlf.txt')).equals(Buffer.from('line one\r\nline two changed\r\n')), `${label}: CRLF bytes kept`);
    assert.strictEqual(fs.readFileSync(at(root.path, SPACED), 'utf8'), 'relatório v2, não staged\n', `${label}: a spaced non-ASCII path`);
    assert.strictEqual(fs.readFileSync(at(root.path, UNTRACKED_SPACED), 'utf8'), 'rascunho não rastreado\n', `${label}: an untracked non-ASCII path`);
    assert.strictEqual(git(root.path, ['ls-files', '-s', 'bin/tool.sh']).split(' ')[0], '100755', `${label}: the index mode`);
    assert.strictEqual(git(root.path, ['ls-files', 'src/gone-unstaged.js']).trim(), 'src/gone-unstaged.js', `${label}: an unstaged deletion stays indexed`);
    assert.strictEqual(git(root.path, ['ls-files', 'src/gone-staged.js', 'src/old-name.js']).trim(), '', `${label}: staged deletion and rename source leave the index`);
    for (const absent of ['.gsd', 'build', 'debug.log', '.forge-claude-sidecar-fixture', 'src/gone-staged.js', 'src/gone-unstaged.js', 'src/old-name.js']) {
      assert(!fs.existsSync(at(root.path, absent)), `${label}: ${absent} is not in the member root`);
    }
  });
  assert.notStrictEqual(memberIndexes[0], memberIndexes[1], 'one index per member');
  const memberRefs = roots.map(root => `refs/heads/${root.branch}`);
  assertIntegrationUnchanged(dir, before, 'prepare', memberRefs);
  assert.deepStrictEqual(states(dir, ids), ['admitido', 'admitido'], 'preparation is not execution: no member progress advanced');
  // Replay in process: the same members, nothing new.
  const worktrees = git(dir, ['worktree', 'list', '--porcelain']);
  const again = batch.prepareIsolation(scope);
  assert.strictEqual(again.status, 'prepared', JSON.stringify(again));
  assert.deepStrictEqual(again.members.map(member => member.roots[0].path), roots.map(root => root.path));
  assert(again.base.replay && again.members.every(member => member.roots[0].replay), 'the published base and both journals replay');
  assert.strictEqual(git(dir, ['worktree', 'list', '--porcelain']), worktrees, 'no second worktree');
  // A fresh process replays from the published package and the journals alone.
  const fresh = freshPrepare(scope);
  assert.strictEqual(fresh.status, 'prepared', JSON.stringify(fresh));
  assert.deepStrictEqual(fresh.members.map(member => [member.roots[0].path, member.roots[0].branch, member.roots[0].replay]),
    roots.map(root => [root.path, root.branch, true]));
  assertIntegrationUnchanged(dir, before, 'replay', memberRefs);
  console.log(`      witness: two members prepared in ${elapsed} ms; base ${JSON.stringify(summary)}`);
});

// ── U2a-2 ─────────────────────────────────────────────────────────────────────

test('issue343 U2a-2 unrepresentable bases fall back to one named serial reason before any provider, with nothing materialized', () => {
  const dir = owner('matrix');
  const ids = cohort(dir, { T01: taskPlan('T01', { inputs: ['.gitattributes', 'data/x.dat'] }), T02: taskPlan('T02') });
  const scope = scopeOf(dir, ids, 'matrix');
  const keep = git(dir, ['rev-parse', 'HEAD:src/keep.js']).trim(), head = git(dir, ['rev-parse', 'HEAD']).trim(), zero = '0'.repeat(keep.length);
  const seen = new Set();
  const expectSerial = (label, detail, options) => {
    const index = fs.readFileSync(path.join(dir, '.git', 'index'));
    const result = batch.prepareIsolation(scope, options || {});
    assert.deepStrictEqual([result.status, result.reason_code, result.detail], ['serial', 'materialization-unsupported', detail], `${label}: ${JSON.stringify(result)}`);
    assert(isolation.BATCH_MATERIALIZATION_DETAILS.includes(result.detail), `${label}: a closed detail`);
    assert(fs.readFileSync(path.join(dir, '.git', 'index')).equals(index), `${label}: the integration index is untouched`);
    assert(!fs.existsSync(areaOf('matrix')), `${label}: nothing was materialized`);
    assert.deepStrictEqual(linked(dir), [], `${label}: no member worktree`);
    seen.add(detail);
  };
  const updateIndex = args => git(dir, ['update-index', ...args]);
  const indexInfo = rows => git(dir, ['update-index', '-z', '--index-info'], { input: Buffer.from(rows.map(row => `${row}${NUL}`).join(''), 'utf8') });
  updateIndex(['--skip-worktree', 'src/keep.js']);
  expectSerial('skip-worktree', 'skip-worktree');
  updateIndex(['--no-skip-worktree', 'src/keep.js']);
  updateIndex(['--assume-unchanged', 'src/keep.js']);
  expectSerial('assume-unchanged', 'assume-unchanged');
  updateIndex(['--no-assume-unchanged', 'src/keep.js']);
  git(dir, ['config', 'core.sparseCheckout', 'true']);
  expectSerial('sparse checkout', 'sparse-checkout');
  git(dir, ['config', '--unset', 'core.sparseCheckout']);
  write(at(dir, '.gitattributes'), '*.dat filter=fixture-driver\n');
  write(at(dir, 'data/x.dat'), 'filtered\n');
  expectSerial('filter driver', 'filter-attribute');
  fs.rmSync(at(dir, '.gitattributes'));
  fs.rmSync(at(dir, 'data'), { recursive: true, force: true });
  write(at(dir, 'src/later.js'), 'later\n');
  git(dir, ['add', '-N', '--', 'src/later.js']);
  expectSerial('intent to add', 'intent-to-add');
  updateIndex(['--force-remove', 'src/later.js']);
  fs.rmSync(at(dir, 'src/later.js'));
  git(dir, ['init', '-q', 'vendor/inner']);
  write(at(dir, 'vendor/inner/file.txt'), 'nested\n');
  expectSerial('nested repository', 'nested-repository');
  fs.rmSync(at(dir, 'vendor'), { recursive: true, force: true });
  updateIndex(['--add', '--cacheinfo', `120000,${keep},src/link`]);
  expectSerial('symlink entry', 'symlink');
  updateIndex(['--force-remove', 'src/link']);
  updateIndex(['--add', '--cacheinfo', `160000,${head},vendor/lib`]);
  expectSerial('gitlink entry', 'gitlink');
  updateIndex(['--force-remove', 'vendor/lib']);
  // A trusted in-process limit can only tighten the existing bound (here: one entry).
  expectSerial('limits', 'limits-exceeded', { isolationLimits: { entries: 1 } });
  indexInfo([`0 ${zero}\tsrc/keep.js`, `100644 ${keep} 1\tsrc/keep.js`, `100644 ${keep} 2\tsrc/keep.js`, `100644 ${keep} 3\tsrc/keep.js`]);
  expectSerial('conflict stages', 'index-conflict-stage');
  indexInfo([`0 ${zero}\tsrc/keep.js`, `100644 ${keep} 0\tsrc/keep.js`]);
  git(dir, ['-c', 'core.ignorecase=false', 'update-index', '--add', '--cacheinfo', `100644,${keep},src/Keep.js`]);
  expectSerial('case collision', 'case-collision');
  // An unborn HEAD has no commit to reproduce.
  const unborn = owner('unborn', { commit: false });
  const unbornIds = cohort(unborn);
  const unbornResult = batch.prepareIsolation(scopeOf(unborn, unbornIds, 'unborn'));
  assert.deepStrictEqual([unbornResult.status, unbornResult.reason_code, unbornResult.detail], ['serial', 'materialization-unsupported', 'head-unborn']);
  seen.add(unbornResult.detail);
  // A member write over an ignored input the member root could not reproduce.
  const ignored = owner('ignored', { ignore: 'generated/\n' });
  write(at(ignored, 'generated/old.js'), 'ignored generated input\n');
  const ignoredIds = cohort(ignored, { T01: taskPlan('T01', { writes: ['generated/old.js'], artifact: 'generated/old.js' }), T02: taskPlan('T02') });
  const ignoredResult = batch.prepareIsolation(scopeOf(ignored, ignoredIds, 'ignored'));
  assert.deepStrictEqual([ignoredResult.status, ignoredResult.reason_code, ignoredResult.detail], ['serial', 'materialization-unsupported', 'ignored-input']);
  seen.add(ignoredResult.detail);
  const ignoredRead = owner('ignored-readonly', { ignore: 'cache/\n' });
  write(at(ignoredRead, 'cache/required.txt'), 'required but ignored read-only input\n');
  const ignoredReadIds = cohort(ignoredRead, { T01: taskPlan('T01', { inputs: ['cache/required.txt'] }), T02: taskPlan('T02') });
  const ignoredReadResult = batch.prepareIsolation(scopeOf(ignoredRead, ignoredReadIds, 'ignored-readonly'));
  assert.deepStrictEqual([ignoredReadResult.status, ignoredReadResult.reason_code, ignoredReadResult.detail],
    ['serial', 'materialization-unsupported', 'ignored-input'], 'an explicit read-only key_link cannot silently omit a necessary ignored input');
  for (const [root, rootIds, label] of [[dir, ids, 'matrix'], [unborn, unbornIds, 'unborn'], [ignored, ignoredIds, 'ignored'], [ignoredRead, ignoredReadIds, 'ignored-readonly']]) {
    assert.deepStrictEqual(states(root, rootIds), ['admitido', 'admitido'], `${label}: no member progressed toward a provider`);
    assert(!fs.existsSync(areaOf(label)), `${label}: no batch area`);
  }
  // SVN keeps its existing decision-level reason (U1); the closed vocabulary is the only one used.
  assert(batch.REASON_CODES.includes('svn-isolation-unavailable') && batch.REASON_CODES.includes('materialization-unsupported'));
  console.log(`      witness: ${seen.size} named details exercised: ${[...seen].join(', ')}`);
});

test('issue343 U2a-2 foreign or aliased roots, an unstable or changed source and forged, cloned, serialized, stale or foreign handles refuse before any provider', () => {
  // A batch named with another manifest digest or owner token is foreign.
  const named = owner('named');
  const namedIds = cohort(named);
  for (const extra of [{ manifest_sha256: 'f'.repeat(64) }, { owner_token: 'another-owner-token' }]) {
    assert.throws(() => batch.prepareIsolation(scopeOf(named, namedIds, 'named', extra)), error => error && error.code === 'batch-manifest-foreign');
  }
  // A foreign root: the decision measured the owner; another checkout never stands in for it.
  const foreign = owner('foreign');
  const foreignIds = cohort(foreign);
  const other = owner('other-checkout');
  refusal(() => batch.prepareIsolation(scopeOf(foreign, foreignIds, 'foreign', { code_root: other })), 'batch-root-foreign', 'foreign root');
  assert(!fs.existsSync(path.join(WORKTREES, runLabel('foreign'))), 'foreign root: nothing was created');
  assert.deepStrictEqual([linked(foreign), linked(other)], [[], []], 'foreign root: no worktree anywhere');
  // An aliased layout: a worktree_root inside the owner would put the batch area in a code root.
  const aliased = owner('alias', { prefs: dir => ({ forge_isolation: { worktree_root: path.join(dir, '.forge-wt') } }) });
  const aliasIds = cohort(aliased);
  refusal(() => batch.prepareIsolation(scopeOf(aliased, aliasIds, 'alias')), 'batch-area-unsafe', 'batch area inside the owner');
  assert(!fs.existsSync(path.join(aliased, '.forge-wt')), 'alias: nothing was created inside the owner');
  // A junction (or symlink) in place of the batch area: nothing is written through it.
  const junction = owner('junction');
  const junctionIds = cohort(junction);
  const trap = path.join(junction, 'trap');
  fs.mkdirSync(trap);
  fs.mkdirSync(path.join(WORKTREES, runLabel('junction')), { recursive: true });
  let linkedArea = true;
  try { fs.symlinkSync(trap, areaOf('junction'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    linkedArea = false;
  }
  if (linkedArea) {
    refusal(() => batch.prepareIsolation(scopeOf(junction, junctionIds, 'junction')), 'batch-area-unsafe', 'linked batch area');
    assert.deepStrictEqual(fs.readdirSync(trap), [], 'junction: nothing was written through the link');
  } else console.log('      (link creation is not permitted here: the linked-area case was not exercised)');
  for (const [root, rootIds, label] of [[foreign, foreignIds, 'foreign'], [aliased, aliasIds, 'alias'], [junction, junctionIds, 'junction']]) {
    assert.deepStrictEqual(states(root, rootIds), ['admitido', 'admitido'], `${label}: no member progressed toward a provider`);
    assert.deepStrictEqual(linked(root), [], `${label}: no member worktree`);
  }
  // An unstable source: a file moves while the base is measured; the attempt is recorded once and
  // nothing is captured; once the source is still, the same batch prepares.
  const unstable = owner('unstable');
  write(at(unstable, 'src/keep.js'), 'module.exports = "changed before the batch";\n');
  const unstableIds = cohort(unstable);
  const moving = { failpoint: name => { if (name === 'base-inventory-read') fs.appendFileSync(at(unstable, 'src/keep.js'), '// moved while measured\n'); } };
  refusal(() => batch.prepareIsolation(scopeOf(unstable, unstableIds, 'unstable'), moving), 'batch-source-unstable', 'unstable source');
  const unstableArea = fs.readdirSync(areaOf('unstable')).map(name => path.join(areaOf('unstable'), name));
  assert.strictEqual(unstableArea.length, 1, 'one batch area');
  const attempt = JSON.parse(fs.readFileSync(path.join(unstableArea[0], 'attempts', '0001.json'), 'utf8'));
  assert.deepStrictEqual([attempt.outcome, attempt.root_id, attempt.changed.includes('working-tree'), attempt.batch.batch_id],
    ['source-unstable', 'primary', true, unstableIds.batch_id], JSON.stringify(attempt));
  assert(!fs.existsSync(path.join(unstableArea[0], 'base', 'package.json')), 'unstable: no package was published');
  assert.deepStrictEqual(linked(unstable), [], 'unstable: no member worktree');
  assert.strictEqual(batch.prepareIsolation(scopeOf(unstable, unstableIds, 'unstable')).status, 'prepared', 'a still source prepares');
  // A source changed after the capture: no member is built from it, and the published base is
  // never refreshed or replaced — even the original bytes back are not the measured file.
  const changed = owner('changed');
  const changedIds = cohort(changed);
  const changedScope = scopeOf(changed, changedIds, 'changed');
  observing(() => fs.appendFileSync(at(changed, 'src/keep.js'), '// edited after the capture\n'), () => {
    refusal(() => batch.prepareIsolation(changedScope), 'batch-integration-changed', 'source changed after the capture');
  });
  assert.deepStrictEqual(linked(changed), [], 'changed: no member worktree was built from a stale base');
  const changedArea = fs.readdirSync(areaOf('changed')).map(name => path.join(areaOf('changed'), name))[0];
  const published = fs.readFileSync(path.join(changedArea, 'base', 'package.json'));
  fs.writeFileSync(at(changed, 'src/keep.js'), 'module.exports = "keep";\n');
  refusal(() => batch.prepareIsolation(changedScope), 'batch-integration-changed', 'replay over a changed source');
  assert(fs.readFileSync(path.join(changedArea, 'base', 'package.json')).equals(published), 'changed: the published package is immutable');
  // Handles: only this module's live in-process capabilities act.
  const owned = owner('handles');
  const ownedIds = cohort(owned);
  const calls = [];
  const prepared = observing((handle, baseRef) => calls.push({ handle, baseRef }), () => batch.prepareIsolation(scopeOf(owned, ownedIds, 'handles')));
  assert.strictEqual(prepared.status, 'prepared', JSON.stringify(prepared));
  assert.strictEqual(calls.length, 2, 'one member handle per admitido member');
  const [first, second] = calls;
  assert.deepStrictEqual(Reflect.ownKeys(first.handle), [], 'a handle carries no data of its own');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(prepared)).members.length, 2, 'the prepared result carries no handle');
  refusal(() => JSON.stringify(first.handle), 'batch-isolation-handle-invalid', 'serialized handle');
  let cloned = null;
  try { cloned = structuredClone(first.handle); } catch (_) { cloned = null; }
  const forgeries = [['forged', {}], ['spread copy', { ...first.handle }], ['derived', Object.create(first.handle)], ['JSON round trip', JSON.parse('{}')],
    ...(cloned ? [['structured clone', cloned]] : [])];
  for (const [label, forged] of forgeries) refusal(() => isolation.setupForBatchMember(forged, first.baseRef), 'batch-isolation-handle-invalid', `${label} handle`);
  refusal(() => isolation.captureBatchBase(first.handle, {}), 'batch-isolation-handle-invalid', 'a member handle is no reservation');
  refusal(() => isolation.setupForBatchMember(first.handle, { ...first.baseRef, package_sha256: '0'.repeat(64) }), 'batch-base-invalid', 'another package');
  refusal(() => isolation.setupForBatchMember(first.handle, { ...first.baseRef, batch_dir: path.join(TMP, 'elsewhere') }), 'batch-base-invalid', 'a foreign batch area');
  // The genuine handle replays its own member, never a sibling's.
  const replayed = isolation.setupForBatchMember(first.handle, first.baseRef);
  assert.deepStrictEqual([replayed.status, replayed.member.task_id, replayed.member.roots[0].path, replayed.member.roots[0].replay],
    ['prepared', 'T01', prepared.members[0].roots[0].path, true]);
  // A stale handle: its member left admitido (the owner blocked it); the handle no longer acts.
  batch.appendProgress(owned, batch.readManifest(owned, ownedIds.batch_id), 1, 'admitido', 'bloqueado', 'member-begin-refused');
  refusal(() => isolation.setupForBatchMember(second.handle, second.baseRef), 'batch-isolation-handle-stale', 'stale handle');
  assert.strictEqual(isolation.setupForBatchMember(first.handle, first.baseRef).status, 'prepared', 'the live sibling still acts');
});

test('issue343 U2a-2 incidental untracked files and write globs do not authorize byte reads, packages or member worktrees', () => {
  const dir = owner('unprovenance');
  const secret = at(dir, 'local/operator-note.txt');
  write(secret, 'synthetic local-only content\n');
  const ids = cohort(dir, { T01: taskPlan('T01', { writes: ['src/t01.js', 'local/**'] }), T02: taskPlan('T02') });
  const scope = scopeOf(dir, ids, 'unprovenance'), before = integration(dir);
  let reads = 0, members = 0;
  const read = fs.readFileSync, open = fs.openSync;
  const forbidden = value => typeof value === 'string' && path.resolve(value) === path.resolve(secret);
  fs.readFileSync = function(file, ...args) { if (forbidden(file)) { reads++; throw new Error('incidental bytes read'); } return read.call(this, file, ...args); };
  fs.openSync = function(file, ...args) { if (forbidden(file)) { reads++; throw new Error('incidental file opened'); } return open.call(this, file, ...args); };
  let result;
  try { result = observing(() => members++, () => batch.prepareIsolation(scope)); }
  finally { fs.readFileSync = read; fs.openSync = open; }
  assert.deepStrictEqual([result.status, result.reason_code, result.detail, reads, members],
    ['serial', 'materialization-unsupported', 'untracked-base-unprovenance', 0, 0], JSON.stringify(result));
  assert(!fs.existsSync(areaOf('unprovenance')), 'zero packages or journals');
  assert.deepStrictEqual(linked(dir), [], 'zero member worktrees');
  assert.deepStrictEqual(states(dir, ids), ['admitido', 'admitido'], 'no member entered execution/provider');
  assertIntegrationUnchanged(dir, before, 'unprovenance', []);
  assert.deepStrictEqual(freshPrepare(scope), result, 'a new process cannot invent input provenance');
});

test('issue343 U2a-2 raw key_links edits after the manifest and resealed package provenance cannot widen input authority', () => {
  const dir = owner('input-tamper');
  write(at(dir, 'notes.txt'), 'explicit read-only input\n');
  const plan = taskPlan('T01', { inputs: ['notes.txt'] });
  const ids = cohort(dir, { T01: plan, T02: taskPlan('T02') }), scope = scopeOf(dir, ids, 'input-tamper');
  const planFile = path.join(sliceDir(dir), 'tasks', 'T01', 'T01-PLAN.md');
  const edited = plan.replace('  key_links:\n', '  key_links:\n    - from: "local/extra.txt"\n      to: "src/t01.js"\n      via: "not admitted"\n');
  const pv = require('./forge-plan-validation');
  const originalSemantic = pv.assertSliceGeneration(dir, { milestone: M, slice: S }).semantic_sha256;
  write(planFile, edited);
  assert.strictEqual(pv.assertSliceGeneration(dir, { milestone: M, slice: S }).semantic_sha256, originalSemantic,
    'this negative changes only raw must_haves, not graph semantics');
  const refused = batch.prepareIsolation(scope);
  assert.deepStrictEqual([refused.status, refused.reason_code], ['serial', 'plan-generation-invalid']);
  assert(!fs.existsSync(areaOf('input-tamper')), 'raw plan drift is refused before package or worktree');
  write(planFile, plan);
  const prepared = batch.prepareIsolation(scope);
  assert.strictEqual(prepared.status, 'prepared', JSON.stringify(prepared));
  const file = path.join(prepared.base.batch_dir, 'base', 'package.json'), original = fs.readFileSync(file);
  write(planFile, edited);
  const fresh = freshPrepare(scope);
  assert.deepStrictEqual([fresh.status, fresh.reason_code], ['serial', 'plan-generation-invalid'], 'fresh replay keeps exact decided plan hash');
  assert(fs.readFileSync(file).equals(original), 'refused replay never refreshes the package');
  write(planFile, plan);
  const forged = JSON.parse(original), row = forged.roots[0].inventory.find(entry => !entry.tracked);
  row.provenance[0].plan_sha256 = '0'.repeat(64);
  const { package_sha256, ...content } = forged;
  forged.package_sha256 = require('./forge-delivery').fingerprint(content);
  fs.writeFileSync(file, JSON.stringify(forged));
  assert.strictEqual(freshPrepare(scope).thrown, 'batch-base-invalid', 'recomputed JSON seal cannot authorize different origins');
  fs.writeFileSync(file, original);
  assert.strictEqual(freshPrepare(scope).status, 'prepared', 'the genuine unchanged package still replays');
});

test('issue343 U2a-2 a genuinely completed transitive predecessor authorizes its exact untracked output without making it a member write', () => {
  const dir = owner('predecessor'), source = 'inputs/predecessor.txt';
  const predecessor = taskPlan('T00', { writes: [source] });
  const intermediate = taskPlan('T09', { writes: ['inputs/intermediate.txt'], depends: ['T00'] });
  planSlice(dir, { T00: predecessor, T09: intermediate, T01: taskPlan('T01', { depends: ['T09'] }), T02: taskPlan('T02', { depends: ['T09'] }) });
  completePredecessor(dir, 'T00', predecessor, source);
  completePredecessor(dir, 'T09', intermediate, 'inputs/intermediate.txt');
  const selected = controller.select(dir, { milestone: M, cohort: true }, {});
  assert(['T00', 'T09'].every(id => selected.cohort?.proven.includes(id)), JSON.stringify(selected));
  const snapshot = loop.create({ mode: 'auto', workflow_id: `wf-${++serial}`, host_runtime: 'codex', max_steps: 10 });
  const dispatched = adapter.invoke('codex', 'auto', 'next', { cwd: dir, milestone: M, owner_token: TOKEN, session: SESSION }, snapshot, {}).result;
  assert.deepStrictEqual([dispatched.outcome, dispatched.action], ['dispatch_required', 'dispatch-batch'], JSON.stringify(dispatched));
  const ids = dispatched.controller_result.details.dispatch_batch, scope = scopeOf(dir, ids, 'predecessor');
  const before = integration(dir);
  const witnessFile = at(dir, `.gsd/milestones/${M}/slices/${S}/tasks/T00/T00-DELIVERY.json`);
  const witness = fs.readFileSync(witnessFile);
  fs.unlinkSync(witnessFile);
  const unproven = batch.prepareIsolation(scope);
  assert.deepStrictEqual([unproven.status, unproven.reason_code, unproven.detail],
    ['serial', 'materialization-unsupported', 'untracked-base-unprovenance'], 'a completion without its genuine historical witness grants no input authority');
  assert(!fs.existsSync(areaOf('predecessor')) && linked(dir).length === 0, 'unproven predecessor: zero package/worktree');
  fs.writeFileSync(witnessFile, witness);
  const prepared = batch.prepareIsolation(scope);
  assert.strictEqual(prepared.status, 'prepared', JSON.stringify(prepared));
  const pkg = JSON.parse(fs.readFileSync(path.join(prepared.base.batch_dir, 'base', 'package.json'), 'utf8'));
  const origins = pkg.roots[0].inventory.find(row => row.path === source).provenance;
  assert(origins.some(origin => origin.task_id === 'T00' && origin.authority === 'controller-proven-predecessor'
    && origin.plan_sha256 === digest(predecessor) && origin.field === 'writes[0]'), JSON.stringify(origins));
  assert(batch.readManifest(dir, ids.batch_id).members.every(member => !member.writes.some(write => String(write).includes(source))), 'read-only predecessor input is not a member write');
  assert.strictEqual(freshPrepare(scope).status, 'prepared', 'fresh replay re-proves predecessor completion');
  for (const member of prepared.members) assert.strictEqual(fs.readFileSync(at(member.roots[0].path, source), 'utf8'), 'real predecessor output\n');
  assertIntegrationUnchanged(dir, before, 'predecessor', prepared.members.map(member => `refs/heads/${member.roots[0].branch}`));
});

test('issue343 U2a-2 a genuine predecessor proof from another physical checkout with the same root_id grants no local input authority', () => {
  const dir = owner('foreign-predecessor'), other = owner('foreign-predecessor-code'), source = 'inputs/predecessor.txt';
  const plan = taskPlan('T00', { writes: [source] });
  write(at(dir, source), 'local incidental bytes, never proved\n');
  planSlice(dir, { T00: plan, T01: taskPlan('T01', { depends: ['T00'] }), T02: taskPlan('T02', { depends: ['T00'] }) });
  completePredecessor(dir, 'T00', plan, source, other);
  const selected = controller.select(dir, { milestone: M, cohort: true }, {});
  assert(selected.cohort?.proven.includes('T00'), 'the historical proof itself is genuine, but belongs to a different physical code root');
  const snapshot = loop.create({ mode: 'auto', workflow_id: `wf-${++serial}`, host_runtime: 'codex', max_steps: 10 });
  const dispatched = adapter.invoke('codex', 'auto', 'next', { cwd: dir, milestone: M, owner_token: TOKEN, session: SESSION }, snapshot, {}).result;
  assert.deepStrictEqual([dispatched.outcome, dispatched.action], ['dispatch_required', 'dispatch-batch'], JSON.stringify(dispatched));
  const ids = dispatched.controller_result.details.dispatch_batch, scope = scopeOf(dir, ids, 'foreign-predecessor');
  const before = integration(dir), otherBefore = integration(other), result = batch.prepareIsolation(scope);
  assert.deepStrictEqual([result.status, result.reason_code, result.detail],
    ['serial', 'materialization-unsupported', 'untracked-base-unprovenance'], 'equal textual root_id cannot transfer input permission across contracts');
  assert.deepStrictEqual(freshPrepare(scope), result, 'fresh process preserves the physical namespace refusal');
  assert(!fs.existsSync(areaOf('foreign-predecessor')), 'zero package/journal');
  assert.deepStrictEqual([linked(dir), linked(other)], [[], []], 'zero worktree in either disposable repository');
  assertIntegrationUnchanged(dir, before, 'foreign predecessor owner', []);
  assertIntegrationUnchanged(other, otherBefore, 'foreign predecessor code', []);
});

test('issue343 U2a-2 a resealed package before its first journal cannot disguise ignored input as tracked or contradict its measured index and observations', () => {
  const dir = owner('package-classification'), secret = 'build/local-only.txt', allowed = 'inputs/allowed.txt';
  const metadata = '.gsd/committed-owner.txt';
  write(at(dir, metadata), 'committed owner baseline\n');
  git(dir, ['add', '--', metadata]);
  git(dir, [...COMMIT, 'owner baseline']);
  write(at(dir, metadata), 'live owner data is not product inventory\n');
  write(at(dir, 'src/keep.js'), 'module.exports = "dirty-one";\n');
  write(at(dir, secret), 'synthetic ignored local-only bytes\n');
  write(at(dir, allowed), 'explicit read-only input\n');
  const ids = cohort(dir, { T01: taskPlan('T01', { inputs: [allowed] }), T02: taskPlan('T02') });
  const scope = scopeOf(dir, ids, 'package-classification'), before = integration(dir);
  let packagePath;
  assert.throws(() => batch.prepareIsolation(scope, { failpoint: name => {
    if (name !== 'base-captured') return;
    const areas = fs.readdirSync(areaOf('package-classification'));
    assert.strictEqual(areas.length, 1);
    packagePath = path.join(areaOf('package-classification'), areas[0], 'base', 'package.json');
    throw Object.assign(new Error('fixture stops after base publication and before any member journal'), { code: 'ISOLATION_FAILPOINT' });
  } }), error => error && error.code === 'ISOLATION_FAILPOINT');
  assert.deepStrictEqual(linked(dir), [], 'crash occurs before the first worktree/journal');
  const original = fs.readFileSync(packagePath), pkg = JSON.parse(original), baseDir = path.dirname(packagePath), batchDir = path.dirname(baseDir);
  const originalDirs = fs.readdirSync(batchDir).sort();
  assert.strictEqual(pkg.roots[0].gsd_tracked.length, 1, 'the full stage retains tracked owner metadata separately');
  assert(!pkg.roots[0].inventory.some(entry => entry.path.startsWith('.gsd/')), 'owner metadata is not product inventory');
  const store = bytes => {
    const sha = digest(bytes), file = path.join(baseDir, 'objects', sha.slice(0, 2), sha);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return sha;
  };
  const bytes = fs.readFileSync(at(dir, secret)), stat = fs.statSync(at(dir, secret), { bigint: true });
  const disguised = { path: secret, tracked: true, type: 'file', size: bytes.length, sha256: store(bytes),
    exec: process.platform === 'win32' ? null : (Number(stat.mode) & 0o100) !== 0, source: 'package', oid: null,
    stat: { size: String(stat.size), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs), ino: String(stat.ino) } };
  const reseal = value => {
    const { package_sha256, ...content } = value;
    value.package_sha256 = require('./forge-delivery').fingerprint(content);
    fs.writeFileSync(packagePath, JSON.stringify(value));
  };
  const negative = (label, mutate, code = 'batch-base-invalid') => {
    const forged = JSON.parse(original);
    mutate(forged.roots[0]);
    reseal(forged);
    const saved = fs.readFileSync(packagePath), result = freshPrepare(scope);
    const diagnostic = result.status === 'prepared' ? result.members.map(member => ({
      task: member.task_id, ignored_present: fs.existsSync(at(member.roots[0].path, secret)),
      tracked_sha256: digest(fs.readFileSync(at(member.roots[0].path, 'src/keep.js'))),
      actual_source_sha256: digest(fs.readFileSync(at(dir, 'src/keep.js'))),
    })) : [];
    assert.strictEqual(result.thrown, code, `${label}: ${JSON.stringify({ result, diagnostic })}`);
    assert(fs.readFileSync(packagePath).equals(saved), `${label}: no repair/reseal by replay`);
    assert.deepStrictEqual(linked(dir), [], `${label}: zero member worktree/content copy`);
    assert.deepStrictEqual(fs.readdirSync(batchDir).sort(), originalDirs, `${label}: zero member journal`);
    assert.deepStrictEqual(states(dir, ids), ['admitido', 'admitido'], `${label}: zero provider execution`);
    assertIntegrationUnchanged(dir, before, label, []);
    fs.writeFileSync(packagePath, original);
  };
  negative('ignored incidental disguised as tracked', root => root.inventory.push(disguised));
  negative('duplicate tracked path', root => root.inventory.push({ ...root.inventory.find(entry => entry.tracked) }));
  negative('missing tracked path', root => { root.inventory = root.inventory.filter(entry => entry.path !== 'src/keep.js'); });
  negative('tracked path with another index oid', root => { root.inventory.find(entry => entry.path === 'src/keep.js').oid = '0'.repeat(40); });
  negative('incorrect stage entry count', root => { root.index.entries++; });
  negative('owner metadata reclassified or dropped', root => { root.gsd_tracked = []; });
  negative('untracked list/inventory no longer matches its observation', root => {
    root.inventory = root.inventory.filter(entry => entry.tracked);
    root.untracked = [];
  });
  negative('status content no longer matches its observation', root => { root.status[0][0] = root.status[0][0] === ' M' ? ' D' : ' M'; });
  negative('forged index blob and observation still fail against the actual integration source', root => {
    const file = path.join(baseDir, 'objects', root.index.blob.slice(0, 2), root.index.blob);
    const oldStage = fs.readFileSync(file);
    const oid = crypto.createHash(root.object_format).update(`blob ${bytes.length}\0`, 'latin1').update(bytes).digest('hex');
    const stage = Buffer.concat([oldStage, Buffer.from(`100644 ${oid} 0\t${secret}\0`, 'utf8')]);
    root.index.blob = store(stage);
    root.index.entries++;
    root.observation.stage_sha256 = root.index.blob;
    root.inventory.push({ ...disguised, oid });
  }, 'batch-integration-changed');
  negative('legitimate dirty tracked path cannot substitute a different same-sized packaged payload', root => {
    const entry = root.inventory.find(row => row.path === 'src/keep.js');
    const forged = Buffer.from('module.exports = "dirty-two";\n');
    assert.strictEqual(forged.length, entry.size);
    entry.sha256 = store(forged);
  }, 'batch-integration-changed');
  negative('legitimate read-only untracked path cannot substitute a different packaged payload', root => {
    const entry = root.inventory.find(row => row.path === allowed);
    entry.sha256 = store(Buffer.alloc(entry.size, 0x78));
  }, 'batch-integration-changed');
  const prepared = freshPrepare(scope);
  assert.strictEqual(prepared.status, 'prepared', JSON.stringify(prepared));
  assert(fs.readFileSync(packagePath).equals(original), 'the genuine original package is unchanged and still replays');
  for (const member of prepared.members) {
    const root = member.roots[0].path;
    assert(!fs.existsSync(at(root, secret)), 'ignored local-only content was never copied');
    assert.strictEqual(fs.readFileSync(at(root, allowed), 'utf8'), 'explicit read-only input\n');
    assert.strictEqual(fs.readFileSync(at(root, 'src/keep.js'), 'utf8'), 'module.exports = "dirty-one";\n');
    assert.strictEqual(fs.readFileSync(at(root, metadata), 'utf8'), 'committed owner baseline\n', 'tracked owner metadata keeps its immutable index blob separately');
  }
  assert.strictEqual(fs.readFileSync(at(dir, metadata), 'utf8'), 'live owner data is not product inventory\n');
  assertIntegrationUnchanged(dir, before, 'genuine restored package', prepared.members.map(member => `refs/heads/${member.roots[0].branch}`));
});

test('issue343 U2a-2 a crash after the member worktree or after its materialization resumes in a fresh process without a second worktree', () => {
  const dir = owner('crash');
  write(at(dir, 'src/keep.js'), 'module.exports = "kept, but changed";\n');
  write(at(dir, 'notes.txt'), 'untracked note\n');
  const ids = cohort(dir, { T01: taskPlan('T01', { inputs: ['notes.txt'] }), T02: taskPlan('T02') });
  const scope = scopeOf(dir, ids, 'crash');
  const before = integration(dir);
  const crash = name => { throw Object.assign(new Error(`fixture crash at ${name}`), { code: 'ISOLATION_FAILPOINT' }); };
  assert(isolation.BATCH_ISOLATION_FAILPOINTS.includes('member-worktree-created') && isolation.BATCH_ISOLATION_FAILPOINTS.includes('member-materialized'));
  assert.throws(() => batch.prepareIsolation(scope, { failpoint: name => { if (name === 'member-worktree-created') crash(name); } }),
    error => error && error.code === 'ISOLATION_FAILPOINT');
  const firstWorktrees = linked(dir);
  assert.strictEqual(firstWorktrees.length, 1, 'the first member worktree exists, the second was never started');
  assert.deepStrictEqual(fs.readdirSync(firstWorktrees[0]), ['.git'], 'still the empty checkout of its journal');
  assert.strictEqual(runs.get(dir, scope.run_id).batch_locator.phase, 'preparing', 'ownership survives the first worktree effect');
  assert.strictEqual(isolation.cleanupForRun(dir, scope.run_id).repos[0].reason, 'batch-members-pending');
  assert.strictEqual(isolation.validateCodeDirBoundary({ workspaceRoot: firstWorktrees[0], codeDir: firstWorktrees[0],
    declaredCodeDir: firstWorktrees[0], repoRoots: firstWorktrees, ownerRoot: dir }).reason_code, 'batch-member-provisioning-pending');
  const contender = claims.normalizeClaim({ schema_version: 2, execution_contract: rootsApi.singleContract(dir, firstWorktrees[0]),
    source: 'plan-writes', paths: [{ root_id: 'primary', path: 'src/unrelated.js' }], unit: 'execute-task/T99' });
  const pendingGate = require('./forge-claim-gate').previewGate({ cwd: dir, runId: 'M-20261108000002-pending-contender', claim: contender });
  assert.notStrictEqual(pendingGate.decision, 'proceed', JSON.stringify(pendingGate));
  assert(pendingGate.census.notes.some(row => row.detail === 'batch-member-provisioning-pending'));
  assert.strictEqual(linked(dir).length, 1, 'neither boundary validation nor cleanup changes the retained worktree');
  let materialized = 0;
  assert.throws(() => batch.prepareIsolation(scope, { failpoint: name => { if (name === 'member-materialized' && ++materialized === 1) crash(name); } }),
    error => error && error.code === 'ISOLATION_FAILPOINT');
  assert.deepStrictEqual(linked(dir), firstWorktrees, 'the resumed member kept its own worktree');
  const fresh = freshPrepare(scope);
  assert.strictEqual(fresh.status, 'prepared', JSON.stringify(fresh));
  assert.deepStrictEqual([fresh.members[0].roots[0].path, fresh.members[0].roots[0].replay, fresh.members[1].roots[0].replay],
    [firstWorktrees[0], false, false], 'the first member resumed its journal, the second was created once');
  assert.strictEqual(linked(dir).length, 2, 'one worktree per member, never a second');
  for (const member of fresh.members) {
    assert.strictEqual(fs.readFileSync(at(member.roots[0].path, 'src/keep.js'), 'utf8'), 'module.exports = "kept, but changed";\n', `${member.task_id}: the base`);
    assert.strictEqual(fs.readFileSync(at(member.roots[0].path, 'notes.txt'), 'utf8'), 'untracked note\n', `${member.task_id}: the untracked note`);
  }
  assertIntegrationUnchanged(dir, before, 'crash recovery', fresh.members.map(member => `refs/heads/${member.roots[0].branch}`));
  assert.deepStrictEqual(states(dir, ids), ['admitido', 'admitido']);
});

test('issue343 member dependencies are provisioned canonically before verification and are not installed again on replay', () => {
  for (const enabled of [true, false]) {
    const dir = owner(`member-deps-${enabled}`, { prefs: () => ({ forge_isolation: { worktree_install_deps: enabled } }) });
    write(at(dir, '.gitignore'), 'node_modules/\n');
    write(at(dir, 'package.json'), JSON.stringify({ name: 'fixture', private: true, dependencies: { 'fixture-dep': '1.0.0' } }));
    write(at(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
    git(dir, ['add', '--', '.gitignore', 'package.json', 'package-lock.json']);
    git(dir, [...COMMIT, 'dependency fixture']);
    const ids = cohort(dir), scope = scopeOf(dir, ids, `deps-${enabled}`), calls = [];
    const dependencyRunner = (cmd, args, options) => {
      calls.push({ cmd, args, cwd: options.cwd, timeout: options.timeoutMs });
      write(at(options.cwd, 'node_modules/fixture-dep/index.js'), 'module.exports = 17;\n');
      return { status: 0 };
    };
    const checkpoints = [];
    const prepared = batch.prepareIsolation(scope, { dependencyRunner, leaseCheckpoint: row => checkpoints.push(row) });
    assert.strictEqual(prepared.status, 'prepared');
    assert.strictEqual(calls.length, enabled ? 2 : 0);
    assert.deepStrictEqual(checkpoints.filter(row => row.stage === 'before-install').map(row => row.required_ms),
      enabled ? [isolation.WORKTREE_INSTALL_TIMEOUT_MS, isolation.WORKTREE_INSTALL_TIMEOUT_MS] : [0, 0]);
    for (const member of prepared.members) {
      const root = member.roots[0].path;
      if (enabled) assert.strictEqual(require(require.resolve('fixture-dep', { paths: [root] })), 17);
      else assert(!fs.existsSync(at(root, 'node_modules')));
    }
    for (const call of calls) {
      assert.deepStrictEqual(call.args, ['ci']);
      assert.strictEqual(call.timeout, isolation.WORKTREE_INSTALL_TIMEOUT_MS);
    }
    assert.strictEqual(batch.prepareIsolation(scope, { dependencyRunner }).status, 'prepared');
    assert.strictEqual(calls.length, enabled ? 2 : 0, 'a verified member replays its provisioning evidence');
  }
});

test('issue343 dependency lifecycle drift cannot publish a verified member or change the integration target', () => {
  const dir = owner('dependency-drift');
  write(at(dir, '.gitignore'), 'node_modules/\n');
  write(at(dir, 'package.json'), '{"name":"fixture","private":true}\n');
  write(at(dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
  git(dir, ['add', '--', '.gitignore', 'package.json', 'package-lock.json']);
  git(dir, [...COMMIT, 'dependency drift fixture']);
  const before = fs.readFileSync(at(dir, 'src/keep.js')), ids = cohort(dir), scope = scopeOf(dir, ids, 'dependency-drift');
  assert.throws(() => batch.prepareIsolation(scope, { dependencyRunner(_cmd, _args, options) {
    write(at(options.cwd, 'src/keep.js'), 'installer altered source\n'); return { status: 0 };
  } }), error => error.code === 'batch-member-verification-failed');
  assert(fs.readFileSync(at(dir, 'src/keep.js')).equals(before));
});

// ── U2b: real reservations, opaque execution handles and physical consumers ──

// The fixture is the live owner between synchronous lower-level API calls.
// Maintain the actual lease with its canonical heartbeat and unchanged TTL;
// fail if it already expired instead of resurrecting it to make a test pass.
function heartbeatMembers(dir, prepared) {
  const lease = require('./forge-unit-lease');
  for (const member of prepared.members) {
    const unit = `execute-task/${member.task_id}`, observed = lease.observe(dir, unit);
    assert(observed.ok && observed.lease && !observed.lease.expired, `fixture lost live lease for ${unit}`);
    const renewed = lease.heartbeat(dir, unit, TOKEN, member.lease_generation);
    assert.strictEqual(renewed.ok, true, JSON.stringify(renewed));
    assert.strictEqual(renewed.generation, member.lease_generation);
  }
}

function memberRequest(dir, scope, prepared, index, handle) {
  const manifest = batch.readManifest(dir, scope.batch_id), member = prepared.members[index];
  const planFile = at(dir, manifest.members[index].plan.path);
  const view = batch.validateMemberPlan(handle, fs.readFileSync(planFile));
  const contract = view.checked_runtime_plan.contract;
  return { scope: 'milestone', phase: 'execute', unitType: 'execute-task', milestoneId: M, sliceId: S, taskId: member.task_id,
    contextRoot: dir, cwd: contract.code_roots.find(root => root.id === contract.primary_root_id).path, planFile,
    execution_contract: contract, writableRoots: contract.code_roots.filter(root => root.id !== contract.primary_root_id).map(root => root.path),
    runId: scope.run_id, claim: runs.get(dir, scope.run_id).write_claim, batch_id: scope.batch_id,
    begin_key: member.begin_key, lease_generation: member.lease_generation, dispatchId: `fixture-dispatch-${member.member_index}`,
    workflowId: 'fixture-member-workflow', route: { ...manifest.members[index].route },
    gates: { plan: 'approved', claim: 'proceed', security: 'not-applicable' }, constraints: { auto_commit: false, deploy: false }, memberHandle: handle };
}

function multiPlan(id, repos) {
  const output = `src/${id.toLowerCase()}.js`;
  return ['---', 'tier: standard', 'depends: []', 'roots_schema: 2', `primary_root_id: ${repos[0].id}`, 'code_roots:',
    ...repos.flatMap(root => [`  - id: ${root.id}`, `    path: ${JSON.stringify(root.path.replace(/\\/g, '/'))}`, '    vcs: git']),
    'writes:', ...repos.map(root => `  - "${root.id}::${output}"`), 'must_haves:', '  truths:', '    - "Every physical root has the exact member output"',
    '  artifacts:', ...repos.flatMap(root => [`    - path: "${root.id}::${output}"`, '      provides: "member output"', '      min_lines: 1']),
    '  key_links: []', 'expected_output:', ...repos.map(root => `  - "${root.id}::${output}"`), '---', '', `# ${id}`, ''].join('\n');
}

test('issue343 U2b-1 aggregate claim CAS with locator; a second writer on a member root is refused even with disjoint paths', () => {
  const dir = owner('claim-cas'), ids = cohort(dir), scope = scopeOf(dir, ids, 'claim-cas');
  const before = runs.get(dir, scope.run_id).write_claim, initialBytes = fs.readFileSync(runs.runFile(dir, scope.run_id));
  assert.strictEqual(runs.get(dir, scope.run_id).owner, undefined, 'the canonical RunRecord caller need not supply an optional owner');
  // A made-up run cannot capture a package or create a worktree.
  assert.throws(() => batch.prepareIsolation({ ...scope, run_id: 'M-20261108000001-absent' }), /batch-parent-run-invalid/);
  assert.deepStrictEqual(linked(dir), []);
  assert(fs.readFileSync(runs.runFile(dir, scope.run_id)).equals(initialBytes));
  runs.update(dir, scope.run_id, { session_id: 'foreign-session' });
  assert.throws(() => batch.prepareIsolation(scope), /batch-parent-run-invalid/);
  assert.deepStrictEqual(linked(dir), [], 'the real run session must own the admitted member leases');
  runs.update(dir, scope.run_id, { session_id: SESSION, owner: 'optional-owner-is-not-the-lease-session' });
  const prepared = batch.prepareIsolation(scope), current = runs.get(dir, scope.run_id);
  assert.strictEqual(prepared.status, 'prepared');
  assert.notStrictEqual(current.write_claim.generation, before.generation);
  assert.deepStrictEqual([current.batch_locator.claim_generation, current.batch_locator.claim_sha256],
    [current.write_claim.generation, rootsApi.digest(current.write_claim)]);
  assert.strictEqual(current.write_claim.execution_contract.code_roots.length, 3);
  assert.deepStrictEqual(current.write_claim.root_baselines.primary, before.root_baselines.primary);
  const stale = claims.replaceBatchClaim(dir, scope.run_id, { expected: { generation: before.generation, sha256: rootsApi.digest(before) },
    union: current.write_claim, batchLocator: current.batch_locator });
  assert.deepStrictEqual(stale, { ok: false, reason: 'stale-claim' });
  assert.strictEqual(runs.get(dir, scope.run_id).write_claim.generation, current.write_claim.generation);
  const replay = runs.withRegistryFence(dir, guard => claims.replaceBatchClaim(dir, scope.run_id, {
    expected: { generation: current.write_claim.generation, sha256: rootsApi.digest(current.write_claim) },
    union: current.write_claim, batchLocator: current.batch_locator }, guard));
  assert(replay.ok && replay.replay, 'CAS uses the live registry guard without acquiring a second fence');
  assert.throws(() => claims.recordClaim(dir, scope.run_id, { source: 'manual', paths: ['src/other.js'] }), /batch-claim-owner-operation-required/);
  assert.strictEqual(claims.releaseClaim(dir, scope.run_id, { at: Date.now(), mechanism: 'manual', evidence: {} }).reason, 'batch-claim-owner-operation-required');
  // A narrowed incoming union must not discard prior target protection.
  runs.update(dir, scope.run_id, { write_claim: before, batch_locator: null });
  const narrow = { ...current.write_claim, paths: current.write_claim.paths.filter(row => row.root_id !== 'primary') };
  assert.throws(() => claims.replaceBatchClaim(dir, scope.run_id, { expected: { generation: before.generation, sha256: rootsApi.digest(before) }, union: narrow,
    batchLocator: { ...current.batch_locator, claim_sha256: rootsApi.digest(narrow) } }), /batch-claim-protection-lost/);
  assert.strictEqual(runs.get(dir, scope.run_id).write_claim.generation, before.generation);
  runs.update(dir, scope.run_id, { write_claim: current.write_claim, batch_locator: current.batch_locator });
  const memberRoot = prepared.members[0].roots[0].path, otherId = 'M-20261108000002-second-writer';
  runs.add(dir, { id: otherId, kind: 'milestone', session_id: 'second', host_runtime: 'codex' });
  const other = claims.normalizeClaim({ schema_version: 2, execution_contract: rootsApi.singleContract(dir, memberRoot),
    unit: 'execute-task/T99', source: 'plan-writes', paths: [{ root_id: 'primary', path: 'src/disjoint.js' }] });
  const comparison = require('./forge-claim-overlap');
  const memberUnionId = current.write_claim.batch_roots[0].root_id;
  const disjoint = { ...current.write_claim, paths: current.write_claim.paths.map(row => row.root_id === memberUnionId ? { ...row, path: 'src/t01.js' } : row) };
  assert.strictEqual(comparison.claimsConflict(disjoint, other).cause, 'overlap', 'exclusive root ownership is stronger than disjoint files');
  const gate = require('./forge-claim-gate').recordAndEvaluate({ cwd: dir, runId: otherId, executionContract: other.execution_contract,
    paths: other.paths, source: other.source, unit: other.unit });
  assert.notStrictEqual(gate.decision, 'proceed', JSON.stringify(gate));
  assert.strictEqual(gate.advised_action, 'stop');
  assert.strictEqual(isolation.attachForRun(dir, otherId, scope.run_id).reason, 'batch-member-root-exclusive');
  assert.strictEqual(isolation.validateCodeDirBoundary({ workspaceRoot: memberRoot, codeDir: memberRoot, declaredCodeDir: memberRoot,
    repoRoots: [memberRoot], ownerRoot: dir }).reason_code, 'batch-member-root-exclusive');
  assert.strictEqual(isolation.cleanupForRun(dir, scope.run_id).repos[0].reason, 'batch-members-pending');
  assert.strictEqual(linked(dir).length, 2);
  // Locator shape is enforced on write; invalid data never becomes a missing field.
  assert.throws(() => runs.update(dir, scope.run_id, { batch_locator: { ...current.batch_locator, isolation_ref: '../escape.json' } }), /batch-locator-invalid/);
});

test('issue343 U2b-1 reservation replay after isolation-record and claim-CAS crashes keeps one generation and all original roots', () => {
  const dir = owner('claim-crash'), ids = cohort(dir), scope = scopeOf(dir, ids, 'claim-crash');
  const initial = runs.get(dir, scope.run_id).write_claim;
  const crash = phase => ({ failpoint: point => { if (point === phase) throw new Error(`fixture-${phase}`); } });
  assert.throws(() => batch.prepareIsolation(scope, crash('batch-isolation-recorded')), /fixture-batch-isolation-recorded/);
  const savedFile = at(dir, `.gsd/forge/batches/${ids.batch_id}/isolation.json`), saved = fs.readFileSync(savedFile);
  const intended = JSON.parse(saved).claim;
  assert.strictEqual(runs.get(dir, scope.run_id).write_claim.generation, initial.generation);
  assert.strictEqual(linked(dir).length, 2);
  assert.throws(() => batch.prepareIsolation(scope, crash('batch-claim-committed')), /fixture-batch-claim-committed/);
  assert.strictEqual(runs.get(dir, scope.run_id).write_claim.generation, intended.generation);
  const fresh = freshPrepare(scope);
  assert.strictEqual(fresh.status, 'prepared', JSON.stringify(fresh));
  assert(fs.readFileSync(savedFile).equals(saved));
  assert.strictEqual(runs.get(dir, scope.run_id).write_claim.generation, intended.generation);
  assert.strictEqual(linked(dir).length, 2);
});

test('issue343 U2b-1 preview under the registry fence observes a committed counterpart without persisting its release', () => {
  const dir = owner('release-preview'), oldHead = git(dir, ['rev-parse', 'HEAD']).trim();
  runs.add(dir, { id: 'M901', kind: 'milestone', session_id: 'old' });
  const oldClaim = claims.recordClaim(dir, 'M901', { source: 'manual', unit: 'execute-task/T01', code_dir: dir, paths: ['src/keep.js'],
    vcs_baseline: { vcs: 'git', id: oldHead } });
  write(at(dir, 'src/keep.js'), 'committed counterpart output\n');
  git(dir, ['add', '--', 'src/keep.js']); git(dir, [...COMMIT, 'counterpart output']);
  const before = fs.readFileSync(runs.runFile(dir, 'M901'));
  const result = runs.withRegistryFence(dir, () => require('./forge-claim-gate').previewGate({ cwd: dir, runId: 'M902',
    claim: { ...oldClaim, at: Date.now() }, enforcement: 'enforcing' }));
  assert.strictEqual(result.decision, 'proceed', JSON.stringify(result));
  assert.strictEqual(result.released_counterparts[0].mechanism, 'committed');
  assert(fs.readFileSync(runs.runFile(dir, 'M901')).equals(before), 'preview performs no release effect within the fence');
});

test('issue343 U2b-2 stale, released, foreign, cloned, serialized and sibling handles refuse at every boundary', () => {
  const dir = owner('execution-handles'), ids = cohort(dir), scope = scopeOf(dir, ids, 'execution-handles'), handles = [];
  const prepared = batch.prepareIsolation(scope, { onMember: handle => handles.push(handle) });
  heartbeatMembers(dir, prepared);
  const requests = handles.map((handle, index) => memberRequest(dir, scope, prepared, index, handle));
  requests.forEach((request, index) => batch.bindMemberExecution(handles[index], request));
  const execution = require('./forge-task-execution'), first = requests[0], root = first.cwd;
  const verified = execution.prepare(first, dir, root);
  heartbeatMembers(dir, prepared);
  assert.deepStrictEqual(verified.claims, [{ root_id: 'primary', path: 'src/t01.js' }]);
  assert.strictEqual(verified.execution_contract.code_roots.length, 1);
  assert.deepStrictEqual(verified.writableRoots, []);
  const bytes = fs.readFileSync(first.planFile), current = runs.get(dir, scope.run_id);
  const firstIndex = isolation.batchIndexIdentity(root).path, siblingIndex = isolation.batchIndexIdentity(requests[1].cwd).path;
  const savedIndex = `${siblingIndex}.fixture-saved`;
  fs.renameSync(siblingIndex, savedIndex);
  try {
    fs.linkSync(firstIndex, siblingIndex);
    assert.throws(() => batch.resolveMemberExecution(handles[0], first), /batch-root-foreign/);
    assert.throws(() => execution.prepare(requests[1], dir, requests[1].cwd), /batch-root-foreign/);
  } finally {
    if (fs.existsSync(siblingIndex)) fs.unlinkSync(siblingIndex);
    fs.renameSync(savedIndex, siblingIndex);
  }
  assert.strictEqual(batch.resolveMemberExecution(handles[0], first).execution_contract.code_roots[0].path, root);
  for (const forged of [{}, { ...handles[0] }, Object.create(handles[0]), structuredClone(handles[0]), handles[1]]) {
    heartbeatMembers(dir, prepared);
    assert.throws(() => batch.resolveMemberExecution(forged, first), /batch-member/);
    assert.throws(() => execution.prepare({ ...first, memberHandle: forged }, dir, root), /batch-member/);
    if (forged !== handles[1]) {
      assert.throws(() => batch.validateMemberPlan(forged, bytes), /batch-member/);
      assert.throws(() => batch.assertMemberRootOwner(forged, root), /batch-member/);
    }
  }
  assert.throws(() => JSON.stringify(handles[0]), /batch-isolation-handle-invalid/);
  assert.throws(() => batch.validateMemberPlan(handles[1], bytes), /batch-member-plan-invalid/);
  assert.throws(() => batch.assertMemberRootOwner(handles[1], root), /batch-member-root-foreign/);
  assert.throws(() => batch.assertMemberRootOwner(handles[0], dir), /batch-member-root-foreign/);
  for (const patch of [{ dispatchId: 'foreign' }, { lease_generation: 'foreign' }, { taskId: 'T02' },
    { writableRoots: [requests[1].cwd] }, { route: { ...first.route, effort: 'low' } }]) {
    heartbeatMembers(dir, prepared);
    assert.throws(() => batch.resolveMemberExecution(handles[0], { ...first, ...patch }), /batch-member-request-mismatch/);
  }
  const { memberHandle, ...serializedRequest } = first;
  assert.throws(() => execution.prepare(serializedRequest, dir, root), /execution-member-handle-required/);
  assert.throws(() => execution.verifyResult(root, JSON.parse(JSON.stringify(verified)), { files_changed: [] }), /batch-member-handle-invalid/);
  assert.throws(() => batch.prepareIsolation(scope), /batch-member-reconciliation-required/);
  assert.throws(() => batch.resumeMemberExecution(scope, 0, serializedRequest), /batch-member-reconciliation-required/);
  assert.throws(() => batch.resumeMemberExecution(scope, 0, serializedRequest, { processProbe: () => false, reconcile: () => true }), /batch-member-reconciliation-required/);
  heartbeatMembers(dir, prepared);
  const restored = batch.resumeMemberExecution(scope, 0, serializedRequest, {
    processProbe: check => check.roots.length === 1 && check.roots[0].path === root,
    reconcile: check => rootsApi.measureRoot({ id: 'primary', path: root }).identity_sha256 === check.roots[0].identity_sha256,
  });
  assert.strictEqual(batch.resolveMemberExecution(restored, { ...serializedRequest, memberHandle: restored }).execution_contract.code_roots[0].path, root);
  heartbeatMembers(dir, prepared);
  for (const mutation of [{ ...current.write_claim, generation: crypto.randomUUID() },
    { ...current.write_claim, released: { at: Date.now(), mechanism: 'manual', evidence: {} } }]) {
    runs.update(dir, scope.run_id, { write_claim: mutation });
    assert.throws(() => batch.resolveMemberExecution(handles[0], first), /batch-(?:isolation-handle-stale|parent-claim-required)/);
    assert.throws(() => execution.verifyResult(root, verified, { files_changed: [] }), /batch-/);
    runs.update(dir, scope.run_id, { write_claim: current.write_claim });
  }
  heartbeatMembers(dir, prepared);
  write(at(root, 'src/outside.js'), 'outside projection\n');
  assert.throws(() => execution.verifyResult(root, verified, { files_changed: [] }), /execution-outside-claim/);
  fs.unlinkSync(at(root, 'src/outside.js'));
  write(at(root, 'src/t01.js'), 'inside projection\n');
  assert.throws(() => execution.verifyResult(root, verified, { files_changed: [] }), /execution-result-omitted-delta/);
  assert.strictEqual(execution.verifyResult(root, verified, { files_changed: ['primary::src/t01.js'] })['primary::src/t01.js'], digest('inside projection\n'));
});

test('issue343 U2b-3 canonical plan and gate bytes unchanged; runtime view reaches prepare, seal, capture, delivery and replay', () => {
  const dir = owner('view-app'), lib = owner('view-lib'), repos = [{ id: 'app', path: dir }, { id: 'lib', path: lib }];
  const ids = cohort(dir, { T01: multiPlan('T01', repos), T02: multiPlan('T02', repos) }), scope = scopeOf(dir, ids, 'view'), handles = [];
  const before = repos.map(root => integration(root.path));
  const prepared = batch.prepareIsolation(scope, { onMember: handle => handles.push(handle) });
  heartbeatMembers(dir, prepared);
  const request = memberRequest(dir, scope, prepared, 0, handles[0]);
  batch.bindMemberExecution(handles[0], request);
  const original = fs.readFileSync(request.planFile), gateFile = request.planFile.replace(/-PLAN\.md$/, '-PLAN-GATE.md'), originalGate = fs.readFileSync(gateFile);
  const execution = require('./forge-task-execution'), verified = execution.prepare(request, dir, request.cwd);
  heartbeatMembers(dir, prepared);
  const view = verified.runtime_view, runtime = verified.execution_contract;
  assert.strictEqual(view.canonical_plan_sha256, digest(original));
  assert.strictEqual(view.canonical_gate_sha256, digest(originalGate));
  assert.notStrictEqual(view.checked_runtime_plan.plan_sha256, view.canonical_plan_sha256, 'lower-level compatibility currently uses the runtime fingerprint');
  assert.deepStrictEqual(runtime.code_roots.map(root => root.id), ['app', 'lib']);
  for (const root of runtime.code_roots) write(at(root.path, 'src/t01.js'), 'member output\n');
  const verifiedFiles = execution.verifyResult(request.cwd, verified, { files_changed: ['app::src/t01.js', 'lib::src/t01.js'] });
  const verify = require('./forge-verify'), delivery = require('./forge-delivery'), unit = { type: 'task', id: 'T01', slice: S, milestone: M };
  const command = `node -e "require('assert').strictEqual(require('fs').readFileSync('src/t01.js','utf8'),'member output\\n')"`;
  const identity = { dispatch_id: request.dispatchId, member_index: 0 };
  const seal = verify.normalizeExecutionVerification(runtime, view.runtime_plan_text, { preferenceCommands: [command], commandTimeoutMs: 30000 }, {}, identity);
  verify.assertExecutionVerification(seal, runtime, view.runtime_plan_text, identity);
  heartbeatMembers(dir, prepared);
  const capture = verify.captureRootDelivery(runtime, view.runtime_plan_text, { unit, verificationSeal: seal, verificationIdentity: identity });
  heartbeatMembers(dir, prepared);
  assert.strictEqual(capture.passed, true, JSON.stringify(capture));
  assert.deepStrictEqual(capture.gate.roots.map(row => row.code_dir), runtime.code_roots.map(root => root.path));
  assert(capture.gate.roots.every(row => row.plan_fingerprint === digest(view.runtime_plan_text) && row.result.checks.length === 1 && row.result.checks[0].exitCode === 0));
  const base = '.gsd/fixture-runtime-delivery', runtimePlan = `${base}/runtime-PLAN.md`;
  write(at(dir, runtimePlan), view.runtime_plan_text);
  const bindings = [], key = delivery.unitKey(unit);
  capture.gate.roots.forEach((source, index) => {
    const verifyPath = `${base}/${source.root_id}-VERIFY.json`, artifactPath = `${base}/${source.root_id}-ARTIFACT.json`;
    write(at(dir, verifyPath), JSON.stringify(source)); write(at(dir, artifactPath), JSON.stringify(capture.artifacts[index]));
    bindings.push({ criterion_id: `${key}:truth:0`, root_id: source.root_id, coverage: 'behavioral', source: { kind: 'verification', path: verifyPath, check_index: 0 } },
      { criterion_id: `${key}:artifact:${index}`, root_id: source.root_id, coverage: 'structural', source: { kind: 'artifact', path: artifactPath, row_index: 0, property: 'exists' } });
  });
  const input = { schema_version: 2, unit, plan: runtimePlan, plan_fingerprint: digest(view.runtime_plan_text), execution_contract: runtime, bindings };
  const built = delivery.buildDelivery(input, { ownerRoot: dir, codeDir: request.cwd });
  assert.strictEqual(built.criteria.length, 3);
  assert(built.criteria.every(row => row.status === 'verificado'), JSON.stringify(built));
  assert.throws(() => verify.captureRootDelivery(runtime, original.toString('utf8'), { unit, verificationSeal: seal, verificationIdentity: identity }), /verification-|execution-plan-roots-mismatch/);
  const wrongFingerprint = delivery.buildDelivery({ ...input, plan_fingerprint: digest(original) }, { ownerRoot: dir, codeDir: request.cwd });
  assert(wrongFingerprint.diagnostics.includes('plan_fingerprint_mismatch'));
  assert.strictEqual(wrongFingerprint.criteria.length, 3);
  assert(wrongFingerprint.criteria.every(row => row.status === 'não verificado'), JSON.stringify(wrongFingerprint));
  heartbeatMembers(dir, prepared);
  const record = { execution: { inputs: verified.inputs, verified_files: verifiedFiles, execution_contract: runtime, runtime_view: view,
    code_state: execution.replayState(request.cwd, runtime) } };
  execution.assertReplay(request, record);
  const { memberHandle, ...plain } = request;
  assert.throws(() => execution.assertReplay(plain, record), /execution-member-handle-required/);
  assert.throws(() => execution.assertReplay({ ...request, memberHandle: handles[1] }, record), /batch-member/);
  heartbeatMembers(dir, prepared);
  fs.appendFileSync(gateFile, 'changed gate bytes\n');
  assert.throws(() => execution.assertReplay(request, record), /batch-member-plan-invalid/);
  fs.writeFileSync(gateFile, originalGate);
  heartbeatMembers(dir, prepared);
  const childScript = 'const [moduleFile,scope,request,record]=process.argv.slice(1);const batch=require(moduleFile);' +
    'const r=JSON.parse(request);r.memberHandle=batch.resumeMemberExecution(JSON.parse(scope),0,r,{processProbe:()=>true,reconcile:c=>c.roots.every(x=>require("fs").existsSync(x.path))});' +
    'require(require("path").join(require("path").dirname(moduleFile),"forge-task-execution.js")).assertReplay(r,JSON.parse(record));process.stdout.write("replayed-without-provider");';
  const child = spawnSync(process.execPath, ['-e', childScript, BATCH_MODULE, JSON.stringify(scope), JSON.stringify(plain), JSON.stringify(record)],
    { encoding: 'utf8', timeout: 60000, windowsHide: true, env: { ...process.env } });
  assert.strictEqual(child.status, 0, child.stderr || String(child.error));
  assert.strictEqual(child.stdout, 'replayed-without-provider');
  assert(fs.readFileSync(request.planFile).equals(original) && fs.readFileSync(gateFile).equals(originalGate));
  repos.forEach((root, index) => assertIntegrationUnchanged(root.path, before[index], root.id,
    prepared.members.flatMap(member => member.roots.filter(row => row.root_id === root.id).map(row => `refs/heads/${row.branch}`))));
  console.log('      witness: real prepare, seal, two-root capture, delivery and fresh-process replay; lower-level evidence uses runtime fingerprint; canonical production wiring remains U3b');
});

test('issue343 U2b-4 cohort shrinks at the 14-root budget without changing limits', () => {
  const dir = owner('budget-app'), other = Array.from({ length: 5 }, (_, index) => owner(`budget-${index}`));
  const repos = [{ id: 'app', path: dir }, ...other.slice(0, 3).map((value, index) => ({ id: `r${index}`, path: value }))];
  const ids = cohort(dir, Object.fromEntries(['T01', 'T02', 'T03'].map(id => [id, multiPlan(id, repos)])));
  const manifest = batch.readManifest(dir, ids.batch_id);
  assert.strictEqual(batch.ROOTS_LIMIT, 14);
  assert.deepStrictEqual(manifest.members.map(row => row.task_id), ['T01', 'T02']);
  assert(manifest.excluded.some(row => row.task_id === 'T03' && row.reason_code === 'roots-limit'));
  const scope = scopeOf(dir, ids, 'root-budget'), prior = runs.get(dir, scope.run_id).write_claim;
  const retained = other.slice(3).map((value, index) => ({ id: `retained${index}`, path: value, vcs: 'git' }));
  const contract = rootsApi.validateContract({ ...prior.execution_contract, code_roots: [...prior.execution_contract.code_roots, ...retained] });
  claims.recordClaim(dir, scope.run_id, { schema_version: 2, execution_contract: contract, source: 'plan-writes', unit: prior.unit,
    paths: contract.code_roots.map(root => ({ root_id: root.id, path: '**' })) });
  const leaseApi = require('./forge-unit-lease'), second = manifest.members[1];
  const secondBefore = leaseApi.readLease(leaseApi.leaseFile(dir, second.unit)).record;
  const setup = isolation.setupForBatchMember;
  let setups = 0, expiredAtCheckpoint = false, prepared;
  isolation.setupForBatchMember = (...args) => {
    const result = setup(...args);
    if (++setups === 1) {
      // The real first member was prepared. Advance only this fixture's heartbeat
      // clock to reproduce a long Git preparation; retain the actual generation.
      assert(leaseApi.heartbeat(dir, second.unit, TOKEN, secondBefore.generation,
        { now: () => Date.now() - leaseApi.DEFAULT_TTL_MS - 1 }).ok);
      expiredAtCheckpoint = leaseApi.observe(dir, second.unit).lease.expired;
    }
    return result;
  };
  try { prepared = batch.prepareIsolation(scope); } finally { isolation.setupForBatchMember = setup; }
  const held = runs.get(dir, scope.run_id).write_claim;
  const secondAfter = leaseApi.readLease(leaseApi.leaseFile(dir, second.unit)).record;
  assert(expiredAtCheckpoint, 'same-owner second member really expired before the next preparation checkpoint');
  assert.strictEqual(secondAfter.generation, secondBefore.generation);
  assert.strictEqual(secondAfter.acquired_at, secondBefore.acquired_at);
  assert.strictEqual(secondAfter.expires_at - secondAfter.heartbeat_at, leaseApi.DEFAULT_TTL_MS);
  assert.strictEqual(leaseApi.observe(dir, second.unit).lease.expired, false);
  assert.strictEqual(prepared.status, 'prepared');
  assert.strictEqual(held.execution_contract.code_roots.length, 14, 'four integration, eight members and two retained roots all remain visible');
  assert.strictEqual(prepared.members.length, 2);
  assert.throws(() => rootsApi.validateContract({ ...held.execution_contract, code_roots: [...held.execution_contract.code_roots, { id: 'fifteenth', path: dir }] }), /execution-contract-schema/);
  assert.strictEqual(require('./forge-unit-lease').observe(dir, 'execute-task/T03').lease, null);
  assert(held.execution_contract.code_roots.some(root => root.id === 'retained0') && held.execution_contract.code_roots.some(root => root.id === 'retained1'));
});


test('issue343 U2b-4 preparation refuses a missing or foreign generation before renewing another member', () => {
  const leaseApi = require('./forge-unit-lease');
  for (const kind of ['missing', 'foreign']) {
    const dir = owner('preparation-' + kind), ids = cohort(dir, independent(['T01', 'T02']));
    const manifest = batch.readManifest(dir, ids.batch_id), scope = scopeOf(dir, ids, 'preparation-' + kind);
    const first = manifest.members[0], second = manifest.members[1], setup = isolation.setupForBatchMember;
    let calls = 0, firstBytes, secondBytes;
    isolation.setupForBatchMember = (...args) => {
      const result = setup(...args);
      if (++calls === 1) {
        const prior = leaseApi.readLease(leaseApi.leaseFile(dir, second.unit)).record;
        assert(leaseApi.release(dir, second.unit, TOKEN, prior.generation).ok);
        if (kind === 'foreign') assert(leaseApi.acquire(dir, second.unit,
          { ownerToken: 'foreign-preparation-owner', hostRuntime: 'codex', session: runs.get(dir, scope.run_id).session_id }).ok);
        firstBytes = fs.readFileSync(leaseApi.leaseFile(dir, first.unit));
        secondBytes = fs.existsSync(leaseApi.leaseFile(dir, second.unit)) ? fs.readFileSync(leaseApi.leaseFile(dir, second.unit)) : null;
      }
      return result;
    };
    try { assert.throws(() => batch.prepareIsolation(scope), error => error.code === 'batch-isolation-handle-stale'); }
    finally { isolation.setupForBatchMember = setup; }
    assert.strictEqual(calls, 1, 'no second member is materialized');
    assert.deepStrictEqual(fs.readFileSync(leaseApi.leaseFile(dir, first.unit)), firstBytes, 'whole cohort is checked before any renewal');
    assert.deepStrictEqual(fs.existsSync(leaseApi.leaseFile(dir, second.unit)) ? fs.readFileSync(leaseApi.leaseFile(dir, second.unit)) : null, secondBytes);
    assert.strictEqual(runs.get(dir, scope.run_id).batch_locator.phase, 'preparing');
  }
});

test('issue343 U2b-4 existing broker or missing prepared record refuses before capture and renewal', () => {
  const leaseApi = require('./forge-unit-lease');
  for (const kind of ['broker', 'missing-record']) {
    const dir = owner('preparation-replay-' + kind), ids = cohort(dir, independent(['T01', 'T02']));
    const scope = scopeOf(dir, ids, 'preparation-replay-' + kind), prepared = batch.prepareIsolation(scope);
    const manifest = batch.readManifest(dir, ids.batch_id);
    if (kind === 'broker') fs.mkdirSync(path.join(prepared.base.batch_dir, 'broker'));
    else fs.unlinkSync(path.join(dir, '.gsd', 'forge', 'batches', ids.batch_id, 'isolation.json'));
    const savedRun = runs.get(dir, scope.run_id), leaseBytes = manifest.members.map(member => fs.readFileSync(leaseApi.leaseFile(dir, member.unit)));
    const capture = isolation.captureBatchBase;
    let captures = 0;
    isolation.captureBatchBase = (...args) => { captures++; return capture(...args); };
    try { assert.throws(() => batch.prepareIsolation(scope), error => error.code === (kind === 'broker' ? 'batch-cohort-broker-exists' : 'batch-isolation-record-invalid')); }
    finally { isolation.captureBatchBase = capture; }
    assert.strictEqual(captures, 0);
    if (kind === 'broker') {
      // Real public async pool entry, in a fresh process. It must refuse before
      // inputs/routes/providers and before its first renewal (not just in prepare).
      const script = 'const batch=require(' + JSON.stringify(BATCH_MODULE) + ');' +
        'batch.runCohort(JSON.parse(process.argv[1]),{}).then(()=>{process.exitCode=2},error=>process.stdout.write(String(error.code)));';
      const child = spawnSync(process.execPath, ['-e', script, JSON.stringify(scope)],
        { encoding: 'utf8', timeout: 180000, windowsHide: true, env: { ...process.env } });
      assert.strictEqual(child.status, 0, child.stderr || String(child.error));
      assert.strictEqual(child.stdout, 'batch-cohort-broker-exists');
    }
    assert.deepStrictEqual(runs.get(dir, scope.run_id), savedRun);
    manifest.members.forEach((member, index) => assert.deepStrictEqual(fs.readFileSync(leaseApi.leaseFile(dir, member.unit)), leaseBytes[index]));
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
for (const [name, value] of Object.entries(SAVED_ENV)) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best-effort cleanup of synthetic fixtures */ }
if (failed) process.exitCode = 1;
