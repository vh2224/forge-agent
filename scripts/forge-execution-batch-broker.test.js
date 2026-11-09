#!/usr/bin/env node
'use strict';

// forge-execution-batch-broker.test.js — issue 343 U3a: the existing artifact broker in cohort
// member mode over a REAL cohort (the real long-workflow adapter, loop, orchestrate and controller
// dispatch it; prepareIsolation gives each member its own worktree and index; each attempt is
// bound) in real disposable Git, with two real synthetic provider processes.
//
//   U3a-1 the cohort broker opens once over the closed registry of bound, admitido members; the
//         interleaved events of two live synthetic providers, each inside its own member
//         worktree, form ONE contiguous signed stream (one global sequence, owner journal equal
//         to the stream) that every member verification and a fresh-process read walk whole;
//   U3a-2 raw, non-canonical, unauthorized, unsigned, truncated, reordered, extra, forged,
//         member-filtered and cross-member writes, second responses, swapped manifests and
//         anchors, forged or serialized handles and a barrier without a real join refuse;
//   U3a-3 the private key is absent from the signer's and the workers' arguments and
//         environment, from every receipt and public file; the single broker is unchanged.
//
// Issue 343 U3b, through the real sidecar (forge-unit-sidecar runUnitSidecar) of each member:
//
//   U3b-1 a finished member is retained executed plus seal (the immutable executed copy, the
//         RetainedRef and the broker's single anchor) with no owner artifact, marker, controller
//         completion or done result while its sibling's writer still runs;
//   U3b-2 no heavy capture exists before the barrier (it starts only from the anchored executed
//         record after it, writing nothing to the owner), and a saved returned response alone is
//         never replay authority for the sidecar replay nor for the post-barrier verification;
//   U3b-3 the single path, without a handle, publishes exactly as before; member-shaped requests,
//         forged views and member seals never take it.
//
// Everything is synthetic and local: temporary HOME/USERPROFILE/FORGE_HOME (no operator
// preference), `git init` roots with pinned local config, FORGE_RESOURCES_PRESSURE=1 (the
// documented forced-normal seam of forge-resources), no paid provider, network or real history.
// The observation seams: a recording wrapper around child_process.fork, installed before any
// Forge module loads (it records the real arguments and delegates to the real fork); for U3b,
// the transport adapter entry (forge-xllm runExecute) launches a real synthetic writer process
// inside the member's own worktree, as forge-milestone-task-marker.test.js replaces that entry,
// and a counter wraps the real heavy capture (forge-verify captureRootDelivery).

const childProcess = require('child_process');
const realFork = childProcess.fork;
const FORKS = [];
childProcess.fork = function recordingFork(modulePath, args, options) {
  const child = realFork.apply(this, arguments);
  FORKS.push({ modulePath: String(modulePath), args: Array.isArray(args) ? [...args] : [],
    options: options ? { ...options, env: options.env ? { ...options.env } : undefined } : {}, pid: child.pid });
  return child;
};

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = childProcess;

const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-batch-broker-')));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME, { recursive: true });
const SENTINEL = `forge-synthetic-credential-${crypto.randomUUID()}`;
const SAVED_ENV = Object.fromEntries(['HOME', 'USERPROFILE', 'FORGE_HOME', 'FORGE_RESOURCES_PRESSURE', 'FORGE_SYNTHETIC_PROVIDER_SECRET']
  .map(name => [name, process.env[name]]));
const CHANNELS = path.join(TMP, 'u3b-channels');
fs.mkdirSync(CHANNELS, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.FORGE_HOME = path.join(HOME, '.forge-agent');
process.env.FORGE_RESOURCES_PRESSURE = '1';
// A synthetic provider credential in the coordinator environment: it must never reach the
// signing child nor any broker record.
process.env.FORGE_SYNTHETIC_PROVIDER_SECRET = SENTINEL;
fs.cpSync(path.join(__dirname, '..', 'shared'), path.join(process.env.FORGE_HOME, 'shared'), { recursive: true });

const adapter = require('./forge-long-workflow-adapter');
const loop = require('./forge-loop-controller');
const controller = require('./forge-unit-controller');
const batch = require('./forge-execution-batch');
const state = require('./forge-state');
const runs = require('./forge-runs');
const claims = require('./forge-write-claim');
const rootsApi = require('./forge-code-roots');
const reconciliation = require('./forge-artifact-reconciliation');
const emitter = require('./forge-dispatch-event');
const execution = require('./forge-task-execution');
const unit = require('./forge-unit-sidecar');
const xllm = require('./forge-xllm');
const verifyApi = require('./forge-verify');
const permissions = require('./forge-claude-permissions');
const deliveryApi = require('./forge-delivery');
const { resolveDispatch } = require('./forge-dispatch-resolve');

const M = 'M-20261108000000-batch';
const S = 'S01';
const TOKEN = 'owner-broker-token-6c1d';
const SESSION = 'session-broker-fixture-9e42';
const EVENTS = '.gsd/forge/events.jsonl';
const COMMIT = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m'];
const NAMES = Object.freeze(['T01', 'T02']);
const STEPS = 3;
const RECONCILIATION_MODULE = path.join(__dirname, 'forge-artifact-reconciliation.js');
const ROUTE_KEYS = Object.freeze(['worker_mode', 'host_runtime', 'resolved_worker_engine', 'engine', 'model', 'tier', 'effort', 'route_sha256']);
const SIGNER_ENV = Object.freeze(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'LANG', 'LC_ALL', 'TZ']);
// PEM private blocks and the PKCS#8 Ed25519 private-key prefix (base64, hex and raw DER).
const KEY_DER = Buffer.from('302e020100300506032b657004220420', 'hex');
const KEY_MARKERS = Object.freeze(['PRIVATE KEY', 'MC4CAQAwBQYDK2VwBCIEI', KEY_DER.toString('hex')]);

// The synthetic provider: it enters its member worktree (cwd), waits until its sibling entered
// too, emits one progress line per step and waits for the coordinator's acknowledgement of each,
// then exits only when released. Files are published by rename, so a reader never sees half.
const PROVIDER = path.join(TMP, 'provider', 'synthetic-provider.js');
fs.mkdirSync(path.dirname(PROVIDER), { recursive: true });
fs.writeFileSync(PROVIDER, [
  "'use strict';",
  "const fs = require('fs');",
  "const path = require('path');",
  'const [name, peer, dir, steps] = process.argv.slice(2);',
  'const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));',
  'function publish(file, text) { fs.writeFileSync(`${file}.tmp`, text); fs.renameSync(`${file}.tmp`, file); }',
  'async function until(file, label) {',
  '  const deadline = Date.now() + 60000;',
  '  while (!fs.existsSync(file)) {',
  '    if (Date.now() > deadline) throw new Error(`synthetic provider ${name} timed out waiting for ${label}`);',
  '    await sleep(5);',
  '  }',
  '}',
  '(async () => {',
  '  publish(path.join(dir, `${name}.entered`), JSON.stringify({ pid: process.pid, cwd: process.cwd() }));',
  "  await until(path.join(dir, `${peer}.entered`), 'its sibling');",
  '  publish(path.join(dir, `${name}.environment.json`), JSON.stringify({ argv: process.argv, execArgv: process.execArgv, env: process.env }));',
  '  for (let step = 1; step <= Number(steps); step++) {',
  '    process.stdout.write(`${JSON.stringify({ step, cwd: process.cwd() })}\\n`);',
  '    await until(path.join(dir, `${name}.ack.${step}`), `ack ${step}`);',
  '  }',
  "  await until(path.join(dir, `${name}.release`), 'release');",
  '})().catch(error => { process.stderr.write(`${error && error.stack ? error.stack : error}\\n`); process.exitCode = 3; });',
  '',
].join('\n'));
const FRESH_EVIDENCE = 'const [file, trust] = process.argv.slice(1);'
  + 'process.stdout.write(JSON.stringify(require(file).readBatchEvidence(JSON.parse(trust))));';

// U3b: the synthetic writer a member's transport launches inside its own worktree (cwd). It enters,
// waits until released, then writes its product file(s) relative to cwd and exits.
const WRITER = path.join(TMP, 'provider', 'synthetic-writer.js');
fs.writeFileSync(WRITER, [
  "'use strict';",
  "const fs = require('fs');",
  "const path = require('path');",
  'const [name, dir, ...files] = process.argv.slice(2);',
  'const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));',
  'function publish(target, text) { fs.writeFileSync(`${target}.tmp`, text); fs.renameSync(`${target}.tmp`, target); }',
  '(async () => {',
  '  publish(path.join(dir, `${name}.entered`), JSON.stringify({ pid: process.pid, cwd: process.cwd() }));',
  '  const deadline = Date.now() + 60000;',
  '  while (!fs.existsSync(path.join(dir, `${name}.release`))) {',
  '    if (Date.now() > deadline) throw new Error(`synthetic writer ${name} was never released`);',
  '    await sleep(5);',
  '  }',
  '  for (const file of files) {',
  '    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });',
  '    fs.writeFileSync(file, "module.exports = " + JSON.stringify(name + ":" + file) + ";\\n");',
  '  }',
  '})().catch(error => { process.stderr.write(`${error && error.stack ? error.stack : error}\\n`); process.exitCode = 3; });',
  '',
].join('\n'));
// The transport adapter entry: no real provider ever runs. A registered root (a member worktree or
// the single-path owner) gets its synthetic writer process; a member's writer is attached to the
// cohort broker at spawn, so the broker observes its exit itself. Anything else refuses.
const realRunExecute = xllm.runExecute;
const realCapture = verifyApi.captureRootDelivery;
const WRITERS = new Map();
const CAPTURES = [];
let TRANSPORTS = 0;
xllm.runExecute = async function syntheticTransport(options) {
  const writer = WRITERS.get(rootsApi.key(fs.realpathSync.native(options.cwd)));
  if (!writer) throw new Error(`no synthetic writer is registered for ${options.cwd}`);
  TRANSPORTS++;
  writer.options = options;
  // The real adapters run their last launch hook immediately before the child.
  if (typeof options.onBeforeSpawn === 'function') options.onBeforeSpawn();
  const child = spawn(process.execPath, [WRITER, writer.name, writer.rendezvous, ...writer.files],
    { cwd: options.cwd, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: { ...process.env } });
  writer.child = child;
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  if (writer.broker) writer.broker.attachMemberProcess(writer.handle, child);
  await within(exited(child), 90000, `${writer.name} synthetic writer`);
  if (child.exitCode !== 0) throw new Error(`${writer.name} synthetic writer failed: ${stderr}`);
  return { status: 'done', summary: `${writer.name} synthetic delivery`, files_changed: [writer.files[0]], must_haves_status: [] };
};
// The real heavy capture, counted.
verifyApi.captureRootDelivery = function countedCapture(contract, planText, options) {
  CAPTURES.push({ roots: (contract && Array.isArray(contract.code_roots) ? contract.code_roots : []).map(root => rootsApi.key(root.path)) });
  return realCapture.apply(this, arguments);
};

let passed = 0;
let failed = 0;
const CASES = [];
function test(name, fn) { CASES.push({ name, fn }); }
async function runCases() {
  for (const { name, fn } of CASES) {
    const started = Date.now();
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name} (${Date.now() - started} ms)`);
    } catch (error) {
      failed++;
      console.log(`  ✗ ${name}`);
      console.log(`      ${error && error.stack ? error.stack : error}`);
    }
  }
}

// ── Fixtures (the U2a/U2b real cohort shape) ──────────────────────────────────

let serial = 0;
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; }
function at(root, rel) { return path.join(root, ...rel.split('/')); }
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
// Test-side git: argv only and never an optional lock, so no fixture read rewrites an index.
function git(cwd, args) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  assert.strictEqual(run.status, 0, `git ${args.join(' ')}: ${run.stderr || run.error}`);
  return run.stdout;
}
// A real owner whose root is a real Git checkout with one committed base.
function owner(label) {
  const dir = path.join(TMP, `${label}-${++serial}`);
  const base = path.join(dir, '.gsd', 'milestones', M);
  fs.mkdirSync(base, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  write(path.join(base, `${M}-ROADMAP.md`), `# Roadmap\n\n- [ ] **${S}: Work** \`depends:[]\`\n`);
  write(path.join(base, `${M}-CONTEXT.md`), '# Context\n');
  write(path.join(base, `${M}-RESEARCH.md`), '# Research\n');
  state.write(dir, { milestone: M, kind: 'milestone', phase: 'idle', active_slice: '—', active_task: '—', next_action: 'plan', auto_mode: 'on' });
  write(at(dir, '.gitignore'), 'build/\n*.log\n');
  write(at(dir, 'src/keep.js'), 'module.exports = "keep";\n');
  git(dir, ['add', '--', '.gitignore', 'src']);
  git(dir, [...COMMIT, 'base']);
  return dir;
}
// A new task plan the strict admission accepts (the U1 fixture shape).
function taskPlan(id) {
  const output = `src/${id.toLowerCase()}.js`;
  return ['---', 'tier: standard', 'depends: []', 'writes:', `  - "${output}"`,
    'must_haves:', '  truths:', `    - "${id} fixture behavior is observable"`, '  artifacts:', `    - path: "${output}"`,
    '      provides: "fixture module"', '      min_lines: 1', '  key_links: []', 'expected_output:', `  - ${output}`,
    '---', '', `# ${id}: Fixture task`, '', 'Prose never counts as a declaration.', ''].join('\n');
}
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
// The real cohort: the loop's auto next through the long-workflow adapter dispatches T01 and
// T02 with committed begins and live leases (U1).
function cohort(dir) {
  planSlice(dir, Object.fromEntries(NAMES.map(id => [id, taskPlan(id)])));
  const snapshot = loop.create({ mode: 'auto', workflow_id: `wf-${++serial}`, host_runtime: 'codex', max_steps: 10 });
  const result = adapter.invoke('codex', 'auto', 'next', { cwd: dir, milestone: M, owner_token: TOKEN, session: SESSION }, snapshot, {}).result;
  assert.deepStrictEqual([result.outcome, result.action], ['dispatch_required', 'dispatch-batch'], JSON.stringify(result.controller_result));
  const dispatched = result.controller_result.details.dispatch_batch;
  assert.deepStrictEqual(dispatched.members.map(member => member.unit.key), NAMES.map(id => `execute-task/${id}`));
  return { batch_id: dispatched.batch_id, manifest_sha256: dispatched.manifest_sha256 };
}
// The real run of the cohort and its live v2 reservation of the integration namespace.
function scopeOf(dir, ids, label) {
  const runId = `M-20261108000001-${label}`;
  runs.add(dir, { id: runId, kind: 'milestone', session_id: SESSION, host_runtime: 'codex',
    project: dir, cwd: dir, milestone_dir: `.gsd/milestones/${M}/`, isolation_mode: 'worktree' });
  const contract = rootsApi.validateContract({ schema_version: 2, owner: dir, primary_root_id: 'primary', code_roots: [{ id: 'primary', path: dir, vcs: 'git' }] });
  claims.recordClaim(dir, runId, { schema_version: 2, execution_contract: contract, source: 'plan-writes', unit: 'BATCH:T01,T02',
    paths: [{ root_id: 'primary', path: '**' }] });
  return { cwd: dir, milestone: M, host_runtime: 'codex', owner_token: TOKEN, batch_id: ids.batch_id, manifest_sha256: ids.manifest_sha256, run_id: runId };
}
// The fixture is the live owner between synchronous lower-level API calls: it keeps the actual
// leases with their canonical heartbeat and unchanged TTL, and fails if one already expired.
function heartbeatMembers(dir, prepared) {
  const lease = require('./forge-unit-lease');
  for (const member of prepared.members) {
    const unit = `execute-task/${member.task_id}`, observed = lease.observe(dir, unit);
    assert(observed.ok && observed.lease && !observed.lease.expired, `fixture lost live lease for ${unit}`);
    const renewed = lease.heartbeat(dir, unit, TOKEN, member.lease_generation);
    assert.strictEqual(renewed.ok, true, JSON.stringify(renewed));
  }
}
// The exact member request a sidecar attempt binds (the U2b shape): the member's own physical
// projection, the held aggregate claim and the manifest route of THIS member.
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
// Hashes of a synthetic retained result (the U3b producer provides genuine ones).
function retained(id) {
  return { response_sha256: digest(`${id} synthetic returned response`), executed_sha256: digest(`${id} synthetic executed record`),
    seal_sha256: digest(`${id} synthetic verification seal`), baseline_sha256: digest(`${id} synthetic reset baseline`),
    delta_sha256: digest(`${id} synthetic verified delta`) };
}
function progressLine(member, step, cwd) {
  return `${JSON.stringify({ ts: new Date().toISOString(), event: 'member-progress', unit: member.unit, dispatch_id: member.dispatch_id,
    milestone: member.milestone, slice: member.slice, batch_id: member.batch_id, batch_size: member.batch_size, member_ref: member.member_ref,
    step, worktree_sha256: digest(rootsApi.key(cwd)) })}\n`;
}
function pick(value, keys) { return Object.fromEntries(keys.map(key => [key, value[key]])); }
async function rejectsCode(promise, code, label) {
  await assert.rejects(promise, error => {
    assert.strictEqual(error && error.code, code, `${label}: ${error && error.stack ? error.stack : error}`);
    if (String(code).startsWith('broker-')) assert(reconciliation.BATCH_BROKER_REFUSALS.includes(code), `${label}: ${code} is a closed broker refusal`);
    return true;
  }, label);
}
function throwsCode(fn, code, label) {
  assert.throws(fn, error => {
    assert.strictEqual(error && error.code, code, `${label}: ${error && error.stack ? error.stack : error}`);
    return true;
  }, label);
}
function within(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms); })])
    .finally(() => clearTimeout(timer));
}
function exited(child) {
  return child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', () => resolve()));
}
// Line-by-line reader of one provider's stdout.
function lineReader(child, label) {
  const queue = [], waiters = [];
  let buffer = '', ended = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (let cut = buffer.indexOf('\n'); cut >= 0; cut = buffer.indexOf('\n')) {
      const line = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 1);
      if (waiters.length) waiters.shift()(line); else queue.push(line);
    }
  });
  child.stdout.on('end', () => { ended = true; while (waiters.length) waiters.shift()(null); });
  return () => {
    if (queue.length) return Promise.resolve(queue.shift());
    if (ended) return Promise.resolve(null);
    return within(new Promise(resolve => waiters.push(resolve)), 60000, `${label}: next line`);
  };
}
// Replace one evidence file, run the check, restore its exact bytes in place.
async function tampered(file, bytes, check) {
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, bytes);
  try { await check(); } finally { fs.writeFileSync(file, original); }
}
function filesBelow(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...filesBelow(file)); else out.push(file);
  }
  return out;
}
function assertNoKey(label, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'), textValue = bytes.toString('utf8');
  for (const marker of KEY_MARKERS) assert(!textValue.includes(marker), `${label} carries private key material (${marker})`);
  assert(!bytes.includes(KEY_DER), `${label} carries a DER private key`);
}
function signatureValid(publicKey, record) {
  const { signature, ...payload } = record;
  return crypto.verify(null, Buffer.from(JSON.stringify(payload)), publicKey, Buffer.from(signature, 'base64'));
}
// Removes only the exact canonical external mutex directory of one fixture owner.
function removeLockRoot(lockRoot) {
  if (typeof lockRoot !== 'string' || !fs.existsSync(lockRoot)) return;
  assert(!fs.lstatSync(lockRoot).isSymbolicLink());
  assert.strictEqual(rootsApi.key(path.dirname(fs.realpathSync.native(lockRoot))), rootsApi.key(fs.realpathSync.native(os.tmpdir())));
  assert(path.basename(lockRoot).startsWith('forge-artifact-owner-'));
  fs.rmSync(lockRoot, { recursive: true, force: true });
}

const lab = {};
function ready() {
  assert(lab.broker, 'the cohort broker fixture is not ready (an earlier case failed)');
  return lab;
}

// ── U3a-1: one broker over the closed registry ───────────────────────────────

test('issue343 U3a-1 the cohort broker opens once, after the attempt bindings, over the closed registry of admitido members', async () => {
  assert(os.cpus().length >= 2, 'the forced-normal resource budget needs two CPUs for a cohort of two');
  const dir = owner('broker'), ids = cohort(dir), scope = scopeOf(dir, ids, 'broker'), handles = [];
  const prepared = batch.prepareIsolation(scope, { onMember: handle => handles.push(handle) });
  assert.strictEqual(prepared.status, 'prepared', JSON.stringify(prepared));
  assert.strictEqual(handles.length, 2);
  heartbeatMembers(dir, prepared);
  // A prepared handle without its bound attempt is not a broker member.
  await rejectsCode(batch.openCohortBroker(scope, handles), 'batch-member-attempt-required', 'unbound member handles');
  const requests = handles.map((handle, index) => memberRequest(dir, scope, prepared, index, handle));
  requests.forEach((request, index) => batch.bindMemberExecution(handles[index], request));
  const manifestRecord = batch.readManifest(dir, ids.batch_id);
  // The members' own canonical routes, resolved before S0 by the resolver the decision used.
  const resolver = require('./forge-dispatch-resolve');
  const routes = manifestRecord.members.map(member => resolver.resolveDispatch({ ...member.route.resolution_options }));
  routes.forEach((route, index) => assert.strictEqual(route.worker_mode, 'sidecar', `${NAMES[index]} keeps its sidecar route`));
  const brokerDir = path.join(prepared.base.batch_dir, 'broker');
  // Registry refusals create nothing.
  await rejectsCode(batch.openCohortBroker(scope, [handles[0]]), 'batch-cohort-incomplete', 'one of two members');
  await rejectsCode(batch.openCohortBroker(scope, [handles[0], handles[0]]), 'batch-cohort-incomplete', 'a duplicated member');
  await rejectsCode(batch.openCohortBroker(scope, [handles[0], { ...handles[1] }]), 'batch-member-attempt-required', 'a cloned member');
  await rejectsCode(batch.openCohortBroker({ ...scope, owner_token: 'foreign-owner-token' }, handles), 'batch-manifest-foreign', 'a foreign owner token');
  assert(!fs.existsSync(brokerDir), 'a refused registry creates no broker slot');
  // Owner history before the common snapshot S0 (the stream starts after it).
  const eventsFile = at(dir, EVENTS);
  fs.appendFileSync(eventsFile, '{"event":"fixture-owner-history"}\n');
  heartbeatMembers(dir, prepared);
  const forksBefore = FORKS.length;
  const { cohort: cohortHandle, broker } = await batch.openCohortBroker(scope, handles);
  assert.strictEqual(FORKS.length, forksBefore + 1, 'ONE signing child for the whole cohort');
  const signer = FORKS[forksBefore], manifest = broker.manifest;
  assert.strictEqual(rootsApi.key(signer.modulePath), rootsApi.key(RECONCILIATION_MODULE));
  assert.strictEqual(manifest.schema_version, 2);
  assert.strictEqual(manifest.kind, 'forge-batch-broker');
  assert.strictEqual(manifest.batch_id, ids.batch_id);
  assert.strictEqual(manifest.batch_manifest_sha256, ids.manifest_sha256);
  assert.strictEqual(manifest.run_id, scope.run_id);
  assert.strictEqual(broker.manifest_sha256, rootsApi.digest(manifest));
  assert.strictEqual(rootsApi.key(broker.directory), rootsApi.key(brokerDir));
  assert.deepStrictEqual(fs.readdirSync(brokerDir).sort(), ['anchors', 'manifest.json', 'proofs.jsonl']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(brokerDir, 'manifest.json'), 'utf8')), manifest, 'the exclusive external manifest');
  assert.strictEqual(fs.readFileSync(path.join(brokerDir, 'proofs.jsonl'), 'utf8'), '');
  // The closed registry names every member attempt exactly.
  assert.deepStrictEqual(manifest.members.map(member => member.task_id), NAMES);
  manifest.members.forEach((member, index) => {
    const placed = prepared.members[index];
    assert.match(member.member_ref, /^m[0-7]-[a-f0-9]{16}$/);
    assert.deepStrictEqual([member.member_index, member.unit, member.milestone, member.slice], [index, `execute-task/${NAMES[index]}`, M, S]);
    assert.deepStrictEqual([member.begin_key, member.lease_generation, member.dispatch_id, member.workflow_id],
      [placed.begin_key, placed.lease_generation, requests[index].dispatchId, requests[index].workflowId]);
    assert.strictEqual(member.plan_sha256, manifestRecord.members[index].plan.sha256);
    assert.deepStrictEqual(member.route, pick(manifestRecord.members[index].route, ROUTE_KEYS), 'each member keeps exactly its resolved route');
    assert.deepStrictEqual(member.roots.map(root => rootsApi.key(root.path)), [rootsApi.key(requests[index].cwd)], 'only its own member root');
    assert(/^[a-f0-9]{64}$/.test(member.request_sha256) && /^[a-f0-9]{64}$/.test(member.runtime_view_sha256));
  });
  assert.notStrictEqual(manifest.members[0].member_ref, manifest.members[1].member_ref);
  assert.notStrictEqual(rootsApi.key(manifest.members[0].roots[0].path), rootsApi.key(manifest.members[1].roots[0].path));
  // S0: the common snapshot, taken after every begin, preparation and binding.
  assert.deepStrictEqual(manifest.surface, execution.protectedSnapshot(fs.realpathSync.native(dir)));
  assert.strictEqual(manifest.append_baselines[EVENTS].length, fs.readFileSync(eventsFile).length);
  // One broker per cohort: neither a second open nor a second start of the cohort handle.
  await rejectsCode(batch.openCohortBroker(scope, handles), 'batch-cohort-broker-exists', 'a second cohort broker');
  const memberRoot = requests[0].cwd;
  for (const [directory, code] of [[path.join(memberRoot, '.broker'), 'broker-manifest-in-worker-surface'],
    [path.join(dir, '.gsd', 'broker'), 'broker-manifest-in-worker-surface'],
    [path.join(TMP, 'outside-the-batch-area'), 'broker-directory-invalid'], ['relative/broker', 'broker-directory-invalid'],
    [path.join(prepared.base.batch_dir, 'broker-second'), 'broker-batch-already-started']]) {
    await rejectsCode(reconciliation.startBatchBroker(cohortHandle, handles, { directory }), code, `broker directory ${directory}`);
  }
  await rejectsCode(reconciliation.startBatchBroker(cohortHandle, [handles[1]], { directory: brokerDir }), 'broker-member-registry-incomplete', 'a partial registry');
  await rejectsCode(reconciliation.startBatchBroker({}, handles, { directory: brokerDir }), 'batch-cohort-handle-invalid', 'a forged cohort handle');
  assert(!fs.existsSync(path.join(prepared.base.batch_dir, 'broker-second')) && !fs.existsSync(path.join(memberRoot, '.broker')));
  assert.strictEqual(FORKS.length, forksBefore + 1, 'no refused start forked a signer');
  // The two broker capabilities never substitute, and no handle serializes.
  throwsCode(() => reconciliation.assertBroker(broker), 'broker-caller-handle-required', 'the cohort broker is not a single broker');
  throwsCode(() => reconciliation.assertBatchBroker(JSON.parse(JSON.stringify(broker))), 'broker-batch-handle-required', 'a serialized broker');
  throwsCode(() => JSON.stringify(cohortHandle), 'batch-isolation-handle-invalid', 'a serialized cohort handle');
  throwsCode(() => batch.resolveBrokerCohort({ ...cohortHandle }), 'batch-cohort-handle-invalid', 'a cloned cohort handle');
  Object.assign(lab, { dir, ids, scope, prepared, handles, requests, routes, manifestRecord, broker, cohortHandle, eventsFile, signer });
});

// ── U3a-2: refusals inside the execution window ──────────────────────────────

test('issue343 U3a-2 raw, non-canonical, unauthorized, cross-member and forged-handle appends refuse before any byte', async () => {
  const { broker, handles, eventsFile, routes } = ready();
  const before = fs.readFileSync(eventsFile), [a, b] = handles.map(handle => broker.memberIdentity(handle));
  const progress = (member, extra = {}) => `${JSON.stringify({ ts: '2026-11-09T00:00:00.000Z', event: 'member-progress', unit: member.unit,
    dispatch_id: member.dispatch_id, milestone: member.milestone, slice: member.slice, batch_id: member.batch_id,
    batch_size: member.batch_size, member_ref: member.member_ref, ...extra })}\n`;
  for (const [line, code] of [['not json\n', 'broker-append-noncanonical'], ['{"event": "member-progress"}\n', 'broker-append-noncanonical'],
    ['{"event":"member-progress"}', 'broker-append-invalid'], ['{"event":"one"}\n{"event":"two"}\n', 'broker-append-noncanonical'],
    ['[1]\n', 'broker-append-noncanonical'], ['{"unit":"execute-task/T01"}\n', 'broker-append-noncanonical'],
    [`${JSON.stringify({ event: 'oversized', pad: 'x'.repeat(70000) })}\n`, 'broker-append-invalid'], [42, 'broker-append-invalid']]) {
    await rejectsCode(broker.appendMember(handles[0], EVENTS, line), code, `raw line ${String(line).slice(0, 40)}`);
  }
  await rejectsCode(broker.appendMember(handles[0], '.gsd/STATE.md', progress(a)), 'broker-path-not-authorized', 'another owner path');
  // The signer refuses a line naming the sibling's attempt or another cohort.
  for (const patch of [{ member_ref: b.member_ref }, { unit: b.unit }, { dispatch_id: b.dispatch_id }, { batch_id: `batch-${'0'.repeat(32)}` },
    { batch_size: 3 }, { slice: 'S99' }, { milestone: 'M-20261108000000-other' }]) {
    await rejectsCode(broker.appendMember(handles[0], EVENTS, progress(a, patch)), 'broker-member-identity-mismatch', `cross-member ${JSON.stringify(patch)}`);
  }
  // A member dispatch line is the canonical builder's: without the cohort fields it is refused.
  await rejectsCode(broker.appendMember(handles[0], EVENTS, `${JSON.stringify({ event: 'dispatch', unit: a.unit, dispatch_id: a.dispatch_id })}\n`),
    'broker-member-identity-mismatch', 'a bare dispatch line');
  // The canonical builder stamps the registry's fields; a caller naming the sibling is refused.
  const args = member => ({ unit: member.unit, model: member.route.model, transport: 'app-server' });
  for (const patch of [{ unit: b.unit }, { memberRef: b.member_ref }, { dispatchId: b.dispatch_id }, { batchId: `batch-${'1'.repeat(32)}` }, { batchSize: '3' }]) {
    await rejectsCode(emitter.appendMemberDispatchEvent(broker, handles[0], { ...args(a), ...patch }, routes[0]), 'dispatch-event-member-mismatch', `builder ${JSON.stringify(patch)}`);
  }
  await rejectsCode(emitter.appendMemberDispatchEvent(broker, handles[0], { ...args(a), model: `${a.route.model}-other` }, routes[0]),
    'dispatch-event-member-route-mismatch', 'another model');
  await rejectsCode(emitter.appendMemberDispatchEvent(broker, handles[0], { ...args(a), effort: a.route.effort === 'low' ? 'high' : 'low' }, routes[0]),
    'dispatch-event-member-route-mismatch', 'another effort');
  // Forged, cloned, serialized and foreign handles are not members; a copied broker is not the broker.
  for (const forged of [{}, { ...handles[0] }, Object.create(handles[0]), structuredClone(handles[0]), null, 'execute-task/T01']) {
    await rejectsCode(broker.appendMember(forged, EVENTS, progress(a)), 'broker-member-handle-required', 'a forged member handle');
    throwsCode(() => broker.memberIdentity(forged), 'broker-member-handle-required', 'a forged identity handle');
  }
  throwsCode(() => JSON.stringify(handles[0]), 'batch-isolation-handle-invalid', 'a serialized member handle');
  await rejectsCode(emitter.appendMemberDispatchEvent(JSON.parse(JSON.stringify(broker)), handles[0], args(a), routes[0]), 'broker-batch-handle-required', 'a serialized broker');
  // The single entry uses its existing refusal contract, not the batch-only enum.
  throwsCode(() => reconciliation.assertBroker(broker), 'broker-caller-handle-required', 'the single guard refuses the cohort capability');
  await assert.rejects(emitter.appendDispatchEvent(broker, args(a), routes[0]), { code: 'broker-caller-handle-required' }, 'the single emitter refuses the cohort broker');
  // Canonical builder shape: the additive cohort fields come together, a line without them is unchanged.
  const plain = emitter.buildDispatchEvent({ unit: a.unit, batchSize: '2' }, routes[0], '2026-11-09T00:00:00Z');
  assert(!('batch_id' in plain) && !('member_ref' in plain), 'a line without cohort fields keeps the previous key set');
  const stamped = emitter.buildDispatchEvent({ unit: a.unit, batchSize: '2', batchId: a.batch_id, memberRef: a.member_ref }, routes[0], '2026-11-09T00:00:00Z');
  assert.deepStrictEqual(Object.keys(stamped).filter(key => key !== 'batch_id' && key !== 'member_ref'), Object.keys(plain), 'every previous key keeps its position');
  assert.deepStrictEqual([stamped.batch_size, stamped.batch_id, stamped.member_ref], [2, a.batch_id, a.member_ref]);
  for (const partial of [{ batchId: a.batch_id }, { memberRef: a.member_ref }, { batchId: 'batch-x', memberRef: a.member_ref }, { batchId: a.batch_id, memberRef: 'T01' },
    { batchId: a.batch_id, memberRef: a.member_ref, batchSize: '' }, { batchId: a.batch_id, memberRef: a.member_ref, batchSize: '9' }]) {
    assert.throws(() => emitter.buildDispatchEvent({ unit: a.unit, batchSize: '2', ...partial }, routes[0], '2026-11-09T00:00:00Z'),
      error => error instanceof emitter.DispatchEventError, JSON.stringify(partial));
  }
  // Nothing refused reached the log or the stream.
  assert(fs.readFileSync(eventsFile).equals(before), 'no refused line reached the owner log');
  assert.deepStrictEqual(broker.proofs(), []);
  assert.strictEqual(fs.readFileSync(path.join(broker.directory, 'proofs.jsonl'), 'utf8'), '');
});

// ── U3a-1: two live synthetic providers, one signed stream ───────────────────

test('issue343 U3a-1 interleaved events of two live synthetic providers in distinct member worktrees form one contiguous signed stream', async () => {
  const { broker, cohortHandle, handles, eventsFile, routes, requests, manifestRecord } = ready();
  const members = handles.map(handle => broker.memberIdentity(handle)), [a, b] = members;
  const baseline = broker.manifest.append_baselines[EVENTS], publicKey = broker.manifest.public_key;
  // Each member's canonical dispatch event: its own cohort fields and its own resolved route.
  for (const [index, member] of members.entries()) {
    const proof = await emitter.appendMemberDispatchEvent(broker, handles[index], { unit: member.unit, model: member.route.model, transport: 'app-server' }, routes[index]);
    assert.deepStrictEqual([proof.member_ref, proof.sequence], [member.member_ref, index + 1]);
  }
  fs.readFileSync(eventsFile).subarray(baseline.length).toString('utf8').trim().split('\n').map(line => JSON.parse(line)).forEach((event, index) => {
    const member = members[index], route = manifestRecord.members[index].route;
    assert.deepStrictEqual([event.event, event.batch_id, event.batch_size, event.member_ref, event.unit, event.dispatch_id, event.milestone, event.slice],
      ['dispatch', member.batch_id, 2, member.member_ref, member.unit, member.dispatch_id, M, S]);
    assert.deepStrictEqual([event.model, event.tier, event.effort, event.worker_mode, event.resolved_worker_engine, event.host_runtime],
      [route.model, route.tier, route.effort, 'sidecar', route.resolved_worker_engine, 'codex'], `${NAMES[index]}: the Route of its real event`);
  });
  const rendezvous = fs.mkdtempSync(path.join(TMP, 'rendezvous-'));
  const providers = [], stderr = ['', ''];
  const outcome = (first, second) => [{ handle: handles[0], outcome: first }, { handle: handles[1], outcome: second }];
  try {
    for (const index of [0, 1]) {
      const child = spawn(process.execPath, [PROVIDER, NAMES[index], NAMES[1 - index], rendezvous, String(STEPS)],
        { cwd: requests[index].cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env } });
      providers.push(child);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr[index] += chunk; });
      // The member's one writer is attached at spawn: the broker observes its exit itself.
      assert.deepStrictEqual(broker.attachMemberProcess(handles[index], child), { member_ref: members[index].member_ref, pid: child.pid });
    }
    const next = providers.map((child, index) => lineReader(child, NAMES[index]));
    for (let step = 1; step <= STEPS; step++) {
      for (const index of [0, 1]) {
        const line = await next[index]();
        assert(line, `${NAMES[index]} ended before step ${step}: ${stderr[index]}`);
        const observed = JSON.parse(line);
        assert.strictEqual(observed.step, step);
        if (step === 1 && index === 0) {
          // Both writers entered distinct member worktrees before either may finish.
          const entered = NAMES.map(name => JSON.parse(fs.readFileSync(path.join(rendezvous, `${name}.entered`), 'utf8')));
          assert.deepStrictEqual(entered.map(row => rootsApi.key(fs.realpathSync.native(row.cwd))),
            requests.map(request => rootsApi.key(fs.realpathSync.native(request.cwd))), 'each provider runs inside its own member worktree');
          assert.notStrictEqual(rootsApi.key(entered[0].cwd), rootsApi.key(entered[1].cwd));
          assert.deepStrictEqual(entered.map(row => row.pid), providers.map(child => child.pid));
          assert(providers.every(child => child.exitCode === null && child.signalCode === null), 'both providers are alive together');
        }
        await broker.appendMember(handles[index], EVENTS, progressLine(members[index], step, observed.cwd));
        fs.writeFileSync(path.join(rendezvous, `${NAMES[index]}.ack.${step}`), '');
      }
    }
    // Both writers are still alive: no barrier, no second writer, no anchor.
    assert(providers.every(child => child.exitCode === null && child.signalCode === null), 'both writers are alive after the interleaved steps');
    await rejectsCode(broker.sealExecutionBarrier(cohortHandle, outcome('retained', 'retained')), 'broker-barrier-writer-live', 'both writers live');
    await rejectsCode(broker.sealExecutionBarrier(cohortHandle, [outcome('failed', 'failed')[0]]), 'broker-barrier-incomplete', 'a missing member');
    await rejectsCode(broker.sealExecutionBarrier(cohortHandle, [{ handle: handles[0], outcome: 'failed', exited: true }, outcome('failed', 'failed')[1]]),
      'broker-barrier-observation-invalid', 'a caller-supplied exit flag');
    await rejectsCode(broker.sealExecutionBarrier({ ...cohortHandle }, outcome('failed', 'failed')), 'broker-cohort-handle-required', 'a forged cohort handle');
    throwsCode(() => broker.attachMemberProcess(handles[0], providers[1]), 'broker-member-writer-exists', 'a second writer for the member');
    throwsCode(() => broker.attachMemberProcess(handles[0], { pid: process.pid, exitCode: null, signalCode: null, once() {} }), 'broker-process-invalid', 'a process-like object');
    await rejectsCode(broker.bindMemberResponse(handles[0], retained('T01')), 'broker-member-writer-live', 'an anchor while its writer lives');
    // T01 really exits; T02 keeps running.
    fs.writeFileSync(path.join(rendezvous, `${NAMES[0]}.release`), '');
    await within(exited(providers[0]), 60000, 'T01 provider exit');
    assert.strictEqual(providers[0].exitCode, 0, stderr[0]);
    const anchorA = await broker.bindMemberResponse(handles[0], retained('T01'));
    assert(signatureValid(publicKey, anchorA), 'the anchor is signed by the cohort key');
    assert.deepStrictEqual([anchorA.kind, anchorA.member_ref, anchorA.dispatch_id, anchorA.request_sha256, anchorA.seal_sha256],
      ['member-response', a.member_ref, a.dispatch_id, broker.manifest.members[0].request_sha256, retained('T01').seal_sha256]);
    assert.deepStrictEqual(await broker.bindMemberResponse(handles[0], retained('T01')), anchorA, 'the same binding replays its one anchor');
    await rejectsCode(broker.bindMemberResponse(handles[0], { ...retained('T01'), response_sha256: digest('a second response') }), 'broker-response-already-bound', 'a second response');
    await rejectsCode(broker.bindMemberResponse(handles[0], { ...retained('T01'), approved: 'true' }), 'broker-response-ref-invalid', 'an extra field');
    await rejectsCode(broker.bindMemberResponse(handles[0], { response_sha256: retained('T01').response_sha256 }), 'broker-response-ref-invalid', 'a partial reference');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(broker.directory, 'anchors', 'm0.json'), 'utf8')), anchorA, 'one immutable anchor file');
    // The sibling still runs: the barrier stays closed and its anchor waits for its own join.
    await rejectsCode(broker.sealExecutionBarrier(cohortHandle, outcome('retained', 'failed')), 'broker-barrier-writer-live', 'one writer still live');
    await rejectsCode(broker.bindMemberResponse(handles[1], retained('T02')), 'broker-member-writer-live', 'the live sibling anchor');
    fs.writeFileSync(path.join(rendezvous, `${NAMES[1]}.release`), '');
    await within(exited(providers[1]), 60000, 'T02 provider exit');
    assert.strictEqual(providers[1].exitCode, 0, stderr[1]);
    // The outcome is the retention fact, never the caller's word.
    await rejectsCode(broker.sealExecutionBarrier(cohortHandle, outcome('failed', 'failed')), 'broker-barrier-outcome-mismatch', 'a retained member reported failed');
    const anchorB = await broker.bindMemberResponse(handles[1], retained('T02'));
    await rejectsCode(broker.sealExecutionBarrier(cohortHandle, [outcome('retained', 'retained')[0], outcome('retained', 'retained')[0]]),
      'broker-barrier-incomplete', 'a duplicated member');
    const barrier = await broker.sealExecutionBarrier(cohortHandle, outcome('retained', 'retained').reverse());
    assert(signatureValid(publicKey, barrier), 'the barrier is signed by the cohort key');
    assert.deepStrictEqual(barrier.members.map(row => [row.member_ref, row.outcome, row.pid, row.exit_code, row.signal, row.anchor_sha256]),
      [[a.member_ref, 'retained', providers[0].pid, 0, null, rootsApi.digest(anchorA)], [b.member_ref, 'retained', providers[1].pid, 0, null, rootsApi.digest(anchorB)]]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(broker.directory, 'barrier.json'), 'utf8')), barrier);
    // ONE stream: a global sequence, both members interleaved line by line, contiguous from S0 to the end.
    const proofs = broker.proofs(), log = fs.readFileSync(eventsFile);
    assert.strictEqual(proofs.length, 2 + 2 * STEPS);
    assert.deepStrictEqual(proofs.map(proof => proof.sequence), proofs.map((_, index) => index + 1), 'one global sequence across members');
    assert.deepStrictEqual(proofs.map(proof => proof.member_ref), proofs.map((_, index) => members[index % 2].member_ref), 'the members interleave');
    let end = baseline.length;
    for (const proof of proofs) {
      assert(signatureValid(publicKey, proof), `proof ${proof.sequence} is signed by the cohort key`);
      assert.deepStrictEqual([proof.kind, proof.batch_id, proof.path, proof.start], ['member-append', a.batch_id, EVENTS, end], `proof ${proof.sequence} continues the stream`);
      assert.strictEqual(JSON.parse(log.subarray(proof.start, proof.end).toString('utf8')).member_ref, proof.member_ref, 'each line is its member\'s own');
      end = proof.end;
    }
    assert.strictEqual(end, log.length, 'the stream reaches the end of the log: no unsigned tail');
    assert.deepStrictEqual(barrier.heads[EVENTS], { sequence: proofs.length, length: log.length, sha256: rootsApi.digest(log) });
    assert.deepStrictEqual(fs.readFileSync(path.join(broker.directory, 'proofs.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)), proofs,
      'the owner journal is exactly the stream');
    // Every member verification walks the whole common stream and revalidates its live B2 binding.
    const verified = [];
    for (const handle of handles) verified.push(await broker.verifyMember(handle, { phase: 'sealed' }));
    verified.forEach((result, index) => {
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.proofs, proofs.length, 'every member verification walks every sibling proof');
      assert.deepStrictEqual(result.sequences.map(row => row.sequence), proofs.filter(proof => proof.member_ref === members[index].member_ref).map(proof => proof.sequence));
      assert.strictEqual(result.anchor_sha256, rootsApi.digest(index ? anchorB : anchorA));
      assert.strictEqual(result.binding.request_sha256, broker.manifest.members[index].request_sha256);
      assert.strictEqual(result.binding.runtime_view_sha256, broker.manifest.members[index].runtime_view_sha256);
    });
    assert.deepStrictEqual(verified[0].heads, verified[1].heads);
    assert.strictEqual(verified[0].journal_sha256, verified[1].journal_sha256);
    // The execution window is closed.
    await rejectsCode(broker.appendMember(handles[0], EVENTS, progressLine(a, STEPS + 1, requests[0].cwd)), 'broker-barrier-sealed', 'an append after the barrier');
    await rejectsCode(broker.bindMemberResponse(handles[1], retained('T02')), 'broker-barrier-sealed', 'an anchor after the barrier');
    throwsCode(() => broker.attachMemberProcess(handles[0], providers[0]), 'broker-barrier-sealed', 'a writer after the barrier');
    await rejectsCode(broker.sealExecutionBarrier(cohortHandle, outcome('retained', 'retained')), 'broker-barrier-sealed', 'a second barrier');
    await rejectsCode(broker.verifyMember(handles[0], { phase: 'execution' }), 'broker-phase-mismatch', 'the execution phase is over');
    assert(fs.readFileSync(eventsFile).equals(log), 'refusals after the barrier wrote nothing');
    Object.assign(lab, { anchors: [anchorA, anchorB], barrier, rendezvous });
  } finally {
    for (const name of NAMES) { try { fs.writeFileSync(path.join(rendezvous, `${name}.release`), ''); } catch (_) { /* fixture release */ } }
    for (const child of providers) if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});

// ── U3a-2: tampered evidence ──────────────────────────────────────────────────

test('issue343 U3a-2 unsigned, truncated, reordered, extra, forged and member-filtered proofs, swapped manifests and anchors refuse; a fresh process reads the evidence', async () => {
  const { broker, handles, eventsFile } = ready();
  assert(lab.barrier, 'the sealed cohort is required');
  const trust = { directory: broker.directory, manifest_sha256: broker.manifest_sha256 };
  const [anchorA, anchorB] = lab.anchors, refs = broker.manifest.members.map(member => member.member_ref);
  const evidence = reconciliation.readBatchEvidence(trust);
  assert.strictEqual(evidence.stream, 'verified');
  assert.strictEqual(evidence.proofs, broker.proofs().length);
  assert.strictEqual(evidence.surface.matches_s0, true, 'only signed member lines changed the owner since S0');
  assert.deepStrictEqual(evidence.members.map(member => [member.member_ref, member.outcome, member.anchor && member.anchor.trust]), refs.map(ref => [ref, 'retained', 'signed']));
  assert.deepStrictEqual(evidence.barrier, { sealed: true, sha256: rootsApi.digest(lab.barrier), sealed_at: lab.barrier.sealed_at });
  const anchored = reconciliation.readBatchEvidence({ ...trust, anchors: { [refs[0]]: rootsApi.digest(anchorA), [refs[1]]: rootsApi.digest(anchorB) },
    barrier_sha256: rootsApi.digest(lab.barrier) });
  assert(anchored.members.every(member => member.anchor.trust === 'anchored'));
  // A fresh process, without any live handle or broker, reads the same complete evidence.
  const fresh = spawnSync(process.execPath, ['-e', FRESH_EVIDENCE, RECONCILIATION_MODULE, JSON.stringify(trust)],
    { encoding: 'utf8', timeout: 120000, windowsHide: true, env: { ...process.env } });
  assert.strictEqual(fresh.status, 0, fresh.stderr || String(fresh.error));
  assert.deepStrictEqual(JSON.parse(fresh.stdout), JSON.parse(JSON.stringify(evidence)));
  const evidenceCode = (expected, label) => throwsCode(() => reconciliation.readBatchEvidence(trust), expected, label);
  // The owner log: a raw unsigned append, a truncation, a changed member line, a changed S0 prefix.
  const validEvents = fs.readFileSync(eventsFile), proofs = broker.proofs();
  await tampered(eventsFile, Buffer.concat([validEvents, Buffer.from('{"event":"raw-unsigned"}\n')]), async () => {
    evidenceCode('reconciliation-unsigned-append', 'a raw unsigned append');
    await rejectsCode(broker.verifyMember(handles[0]), 'reconciliation-unsigned-append', 'verifyMember over a raw append');
  });
  await tampered(eventsFile, validEvents.subarray(0, validEvents.length - 2), () => evidenceCode('reconciliation-span-invalid', 'a truncated log'));
  const changed = Buffer.from(validEvents), at3 = proofs[2].start + 2;
  changed[at3] = changed[at3] === 0x41 ? 0x42 : 0x41;
  await tampered(eventsFile, changed, () => evidenceCode('reconciliation-append-changed', 'a changed member line'));
  const prefix = Buffer.from(validEvents);
  prefix[0] = prefix[0] === 0x41 ? 0x42 : 0x41;
  await tampered(eventsFile, prefix, () => evidenceCode('reconciliation-prefix-changed', 'a changed S0 prefix'));
  // The owner journal: reordered, dropped, duplicated, member-filtered, forged, re-attributed, partial, foreign.
  const journalFile = path.join(broker.directory, 'proofs.jsonl'), validJournal = fs.readFileSync(journalFile, 'utf8');
  const rows = validJournal.trim().split('\n'), journal = list => `${list.join('\n')}\n`;
  const swapped = [...rows];
  [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
  await tampered(journalFile, journal(swapped), async () => {
    evidenceCode('reconciliation-proof-sequence', 'a reordered journal');
    await rejectsCode(broker.verifyMember(handles[1]), 'broker-journal-mismatch', 'verifyMember over a reordered journal');
  });
  await tampered(journalFile, journal(rows.slice(0, -1)), () => evidenceCode('reconciliation-unsigned-append', 'a dropped proof'));
  await tampered(journalFile, journal([...rows, rows[rows.length - 1]]), () => evidenceCode('reconciliation-proof-sequence', 'an extra proof'));
  await tampered(journalFile, journal(rows.filter((_, index) => index % 2 === 0)), () => evidenceCode('reconciliation-proof-sequence', 'one member\'s proofs only'));
  const forged = JSON.parse(rows[3]);
  forged.end += 1;
  await tampered(journalFile, journal([...rows.slice(0, 3), JSON.stringify(forged), ...rows.slice(4)]), () => evidenceCode('reconciliation-signature-invalid', 'a forged span'));
  const reattributed = JSON.parse(rows[3]);
  reattributed.member_ref = refs[0];
  await tampered(journalFile, journal([...rows.slice(0, 3), JSON.stringify(reattributed), ...rows.slice(4)]), () => evidenceCode('reconciliation-signature-invalid', 'a re-attributed proof'));
  const unsigned = JSON.parse(rows[3]);
  delete unsigned.signature;
  await tampered(journalFile, journal([...rows.slice(0, 3), JSON.stringify(unsigned), ...rows.slice(4)]), () => evidenceCode('reconciliation-signature-invalid', 'an unsigned proof'));
  await tampered(journalFile, validJournal.slice(0, -1), () => evidenceCode('broker-journal-invalid', 'a partial journal line'));
  // Swapped or untrusted manifests.
  throwsCode(() => reconciliation.readBatchEvidence({ ...trust, manifest_sha256: rootsApi.digest({ ...broker.manifest, run_id: 'M-20261108000009-foreign' }) }),
    'reconciliation-trust-anchor-required', 'a foreign manifest digest');
  throwsCode(() => reconciliation.readBatchEvidence({ directory: broker.directory }), 'reconciliation-trust-anchor-required', 'no independent trust anchor');
  const manifestFile = path.join(broker.directory, 'manifest.json');
  await tampered(manifestFile, `${JSON.stringify({ ...broker.manifest, members: [...broker.manifest.members].reverse() })}\n`,
    () => evidenceCode('reconciliation-trust-anchor-required', 'a swapped manifest'));
  // Swapped, changed, extra and untrusted anchors.
  const anchorFiles = ['m0.json', 'm1.json'].map(name => path.join(broker.directory, 'anchors', name)), validAnchor = fs.readFileSync(anchorFiles[1]);
  await tampered(anchorFiles[1], fs.readFileSync(anchorFiles[0]), () => evidenceCode('broker-anchor-member-mismatch', 'a sibling anchor'));
  const changedAnchor = JSON.parse(validAnchor);
  changedAnchor.response_sha256 = digest('a swapped response');
  await tampered(anchorFiles[1], `${JSON.stringify(changedAnchor)}\n`, () => evidenceCode('broker-anchor-invalid', 'a changed anchor'));
  throwsCode(() => reconciliation.readBatchEvidence({ ...trust, anchors: { [refs[0]]: rootsApi.digest(anchorA), [refs[1]]: rootsApi.digest(anchorA) } }),
    'broker-anchor-untrusted', 'an untrusted anchor digest');
  const extra = path.join(broker.directory, 'anchors', 'm7.json');
  fs.writeFileSync(extra, validAnchor);
  try { evidenceCode('broker-anchor-invalid', 'an anchor of no member'); } finally { fs.unlinkSync(extra); }
  // A changed or untrusted barrier.
  const barrierFile = path.join(broker.directory, 'barrier.json'), changedBarrier = JSON.parse(fs.readFileSync(barrierFile, 'utf8'));
  changedBarrier.members[1].outcome = 'failed';
  await tampered(barrierFile, `${JSON.stringify(changedBarrier)}\n`, () => evidenceCode('broker-barrier-invalid', 'a changed barrier'));
  throwsCode(() => reconciliation.readBatchEvidence({ ...trust, barrier_sha256: digest('another barrier') }), 'broker-barrier-untrusted', 'an untrusted barrier digest');
  // Every restored byte verifies again.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(reconciliation.readBatchEvidence(trust))), JSON.parse(JSON.stringify(evidence)));
});

// ── U3a-3: the private key ────────────────────────────────────────────────────

test('issue343 U3a-3 the private key never reaches the signer or worker arguments and environment, receipts or public files', async () => {
  const { broker, eventsFile, signer } = ready();
  assert(lab.rendezvous, 'the synthetic providers ran');
  assert.deepStrictEqual(signer.args, ['--broker'], 'the signer receives no key, secret or path argument');
  assert.deepStrictEqual(signer.options.execArgv, [], 'no inspector or preload flag reaches the key holder');
  const env = signer.options.env || {};
  assert(Object.keys(env).every(name => SIGNER_ENV.includes(name.toUpperCase())), `signer environment: ${JSON.stringify(Object.keys(env))}`);
  assert(!JSON.stringify(env).includes(SENTINEL), 'a provider credential never reaches the signer');
  assert(!Object.keys(env).some(name => name.toUpperCase() === 'NODE_OPTIONS'));
  const workers = NAMES.map(name => fs.readFileSync(path.join(lab.rendezvous, `${name}.environment.json`)));
  assert.strictEqual(JSON.parse(workers[0]).env.FORGE_SYNTHETIC_PROVIDER_SECRET, SENTINEL, 'the fixture really inspected a worker environment');
  // The client exposes closed member operations only: no generic signing function, no key.
  assert.deepStrictEqual(Object.keys(broker).sort(), ['appendMember', 'attachMemberProcess', 'bindMemberResponse', 'close', 'directory', 'manifest',
    'manifest_sha256', 'memberIdentity', 'proofs', 'sealExecutionBarrier', 'verifyMember']);
  const publicFiles = [...filesBelow(broker.directory), eventsFile];
  assert.deepStrictEqual(fs.readdirSync(broker.directory).sort(), ['anchors', 'barrier.json', 'manifest.json', 'proofs.jsonl'], 'no key is ever persisted');
  for (const [label, value] of [['broker client', JSON.stringify(broker)], ['signer arguments and environment', JSON.stringify(signer)],
    ['coordinator arguments and environment', JSON.stringify({ argv: process.argv, execArgv: process.execArgv, env: process.env })],
    ...workers.map((bytes, index) => [`${NAMES[index]} worker arguments and environment`, bytes]),
    ...publicFiles.map(file => [file, fs.readFileSync(file)])]) {
    assertNoKey(label, value);
  }
  for (const file of publicFiles) assert(!fs.readFileSync(file, 'utf8').includes(SENTINEL), `${file} carries the synthetic credential`);
  // Only the public half travels: it verifies every record, so the private half exists only in the signer.
  assert.match(broker.manifest.public_key, /^-----BEGIN PUBLIC KEY-----/);
  for (const record of [...broker.proofs(), ...lab.anchors, lab.barrier]) assert(signatureValid(broker.manifest.public_key, record));
  // No public record has a private-key field (S0's surface is keyed by owner paths, walked apart).
  const walk = value => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return undefined;
    for (const [key, item] of Object.entries(value)) { assert(!/private/i.test(key), `a public record names ${key}`); walk(item); }
    return undefined;
  };
  const { surface, ...manifestFields } = broker.manifest;
  walk([manifestFields, broker.proofs(), lab.anchors, lab.barrier]);
  assert(Object.values(surface).every(value => value === 'directory' || /^[a-f0-9]{64}$/.test(value)), 'S0 holds only digests and directory marks');
});

test('issue343 U3a-3 the single-dispatch broker is unchanged and neither capability stands in for the other', async () => {
  const { handles, routes, broker } = ready();
  const labDir = fs.mkdtempSync(path.join(TMP, 'single-')), single = path.join(labDir, 'owner');
  fs.mkdirSync(path.join(single, '.gsd', 'forge'), { recursive: true });
  const forks = FORKS.length;
  const v1 = await reconciliation.startBroker({ owner: single, manifestFile: path.join(labDir, 'manifest.json'), dispatchId: 'single-dispatch',
    request_sha256: digest('single request') });
  try {
    const fork = FORKS[forks];
    assert.strictEqual(FORKS.length, forks + 1);
    assert.deepStrictEqual(fork.args, ['--broker']);
    assert.strictEqual(fork.options.execArgv, undefined, 'the single broker keeps its spawn options');
    assert.deepStrictEqual(Object.keys(v1.manifest), ['schema_version', 'owner', 'dispatch_id', 'request_sha256', 'nonce', 'lock_root', 'plan_sha256',
      'execution_contract', 'append_paths', 'append_baselines', 'surface', 'created_at', 'public_key']);
    assert.strictEqual(v1.manifest.schema_version, 1);
    const proof = await v1.append(EVENTS, '{"event":"single-owner"}\n');
    assert.deepStrictEqual(Object.keys(proof), ['manifest_sha256', 'dispatch_id', 'path', 'sequence', 'log_identity_sha256', 'start', 'end',
      'prefix_sha256', 'append_sha256', 'result_sha256', 'signature']);
    // A generic line is still a single-broker append, exactly as before.
    const generic = await v1.append(EVENTS, 'generic single line\n');
    assert.strictEqual(generic.sequence, 2);
    assert.strictEqual(v1.verify().passed, true);
    const anchor = await v1.bindResponse({ status: 'done' });
    assert.deepStrictEqual(Object.keys(anchor), ['kind', 'manifest_sha256', 'dispatch_id', 'request_sha256', 'response_sha256', 'signature']);
    assert.strictEqual(anchor.kind, 'saved-response');
    await rejectsCode(v1.bindResponse({ status: 'other' }), 'broker-response-already-bound', 'the single anchor rule');
    assert.strictEqual(typeof v1.appendMember, 'undefined');
    for (const file of filesBelow(labDir).filter(name => !name.includes(`${path.sep}owner${path.sep}`))) assertNoKey(file, fs.readFileSync(file));
    // The capabilities never substitute.
    throwsCode(() => reconciliation.assertBatchBroker(v1), 'broker-batch-handle-required', 'the single broker is not a cohort broker');
    await rejectsCode(emitter.appendMemberDispatchEvent(v1, handles[0], { unit: 'execute-task/T01' }, routes[0]), 'broker-batch-handle-required', 'the member emitter refuses the single broker');
    // A single-broker proof is never a cohort proof.
    const journalFile = path.join(broker.directory, 'proofs.jsonl'), trust = { directory: broker.directory, manifest_sha256: broker.manifest_sha256 };
    const rows = fs.readFileSync(journalFile, 'utf8').trim().split('\n');
    await tampered(journalFile, `${[...rows.slice(0, 1), JSON.stringify(proof), ...rows.slice(1)].join('\n')}\n`,
      () => throwsCode(() => reconciliation.readBatchEvidence(trust), 'reconciliation-signature-invalid', 'a foreign single-broker proof'));
  } finally {
    await v1.close();
    removeLockRoot(v1.manifest.lock_root);
  }
});

test('issue343 U3a-1 closing the cohort broker keeps its durable evidence verifiable and refuses further appends', async () => {
  const { broker, cohortHandle, handles } = ready();
  await batch.closeCohortBroker(cohortHandle);
  await rejectsCode(broker.appendMember(handles[0], EVENTS, '{"event":"after-close"}\n'), 'broker-stopped', 'an append after close');
  await rejectsCode(batch.closeCohortBroker({ ...cohortHandle }), 'batch-cohort-handle-invalid', 'a cloned cohort handle');
  const evidence = reconciliation.readBatchEvidence({ directory: broker.directory, manifest_sha256: broker.manifest_sha256 });
  assert.strictEqual(evidence.stream, 'verified');
  assert.strictEqual(evidence.barrier.sealed, true);
});

// ── U3b fixtures: the real sidecar of each member over a real cohort ─────────

// The historical fields of an execution seal (a single seal never carries a runtime view).
const SINGLE_SEAL_KEYS = Object.freeze(['schema_version', 'execution_contract_sha256', 'plan_sha256', 'identity', 'roots',
  'command_timeout_ms', 'timeout_origin', 'sha256']);
const DELIVERY_SUFFIXES = Object.freeze(['SUMMARY.md', 'DELIVERY-INPUT.json', 'DELIVERY.json', 'VERIFICATION-primary-ENVELOPE.json',
  'ARTIFACT-primary-ENVELOPE.json']);
const settle = promise => promise.then(value => ({ value }), error => ({ error }));
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function taskFile(dir, id, suffix) { return path.join(sliceDir(dir), 'tasks', id, `${id}-${suffix}`); }
async function entered(dir, names) {
  while (!names.every(name => fs.existsSync(path.join(dir, `${name}.entered`)))) await new Promise(resolve => setTimeout(resolve, 10));
}
function ownerLockRoot(dir) {
  return path.join(os.tmpdir(), `forge-artifact-owner-${rootsApi.digest(rootsApi.key(fs.realpathSync.native(dir)))}`);
}
// The exact sidecar request of one member attempt (the U2b shape plus the attempt channel): its own
// physical projection, the held aggregate claim, the route its own canonical resolver resolved.
function sidecarRequest(dir, scope, prepared, index, handle, label, extra) {
  const manifest = batch.readManifest(dir, scope.batch_id), planned = manifest.members[index], placed = prepared.members[index];
  const planFile = at(dir, planned.plan.path);
  const view = batch.validateMemberPlan(handle, fs.readFileSync(planFile));
  const contract = view.checked_runtime_plan.contract, id = planned.task_id;
  return { view, request: { unitType: 'execute-task', scope: 'milestone', phase: 'execute', milestoneId: M, sliceId: S, taskId: id,
    cwd: contract.code_roots.find(root => root.id === contract.primary_root_id).path, contextRoot: dir, planFile,
    execution_contract: contract, runId: scope.run_id, claim: runs.get(dir, scope.run_id).write_claim, batch_id: scope.batch_id,
    begin_key: placed.begin_key, lease_generation: placed.lease_generation,
    dispatchId: `u3b-${label}-dispatch-${placed.member_index}`, workflowId: `u3b-${label}-workflow`,
    route: resolveDispatch({ ...planned.route.resolution_options }), resultFile: path.join(CHANNELS, `${label}-${id}.json`),
    prompt: 'Synthetic cohort member fixture only.', verification: { preferenceCommands: [`node --check src/${id.toLowerCase()}.js`] },
    gates: { plan: 'approved', claim: 'proceed', security: 'not-applicable' }, constraints: { auto_commit: false, deploy: false },
    ...(extra || {}) } };
}
// One real cohort per U3b case: its own owner, the loop's real dispatch, real isolation, one sidecar
// attempt bound to each member handle, and the cohort broker opened last (S0), right after the
// leases' canonical heartbeat (the TTL is unchanged; the case window stays short).
async function retainedCohort(label, extra) {
  const dir = owner(label), ids = cohort(dir), scope = scopeOf(dir, ids, label), handles = [];
  const prepared = batch.prepareIsolation(scope, { onMember: handle => handles.push(handle) });
  assert.strictEqual(prepared.status, 'prepared', JSON.stringify(prepared));
  assert.strictEqual(handles.length, 2);
  heartbeatMembers(dir, prepared);
  const built = handles.map((handle, index) => sidecarRequest(dir, scope, prepared, index, handle, label, extra && extra(index)));
  const requests = built.map(row => row.request);
  requests.forEach((request, index) => batch.bindMemberExecution(handles[index], { ...request, memberHandle: handles[index] }));
  const rendezvous = fs.mkdtempSync(path.join(TMP, `u3b-${label}-rendezvous-`));
  const writers = prepared.members.map((member, index) => {
    const writer = { name: NAMES[index], rendezvous, files: [`src/${NAMES[index].toLowerCase()}.js`], handle: handles[index], broker: null };
    WRITERS.set(rootsApi.key(fs.realpathSync.native(member.roots[0].path)), writer);
    return writer;
  });
  const manifestRecord = batch.readManifest(dir, ids.batch_id);
  const slicePlan = fs.readFileSync(path.join(sliceDir(dir), `${S}-PLAN.md`));
  heartbeatMembers(dir, prepared);
  const { cohort: cohortHandle, broker } = await batch.openCohortBroker(scope, handles);
  for (const writer of writers) writer.broker = broker;
  return { dir, ids, scope, prepared, handles, requests, views: built.map(row => row.view), writers, rendezvous, manifestRecord, slicePlan,
    broker, cohortHandle, trust: { directory: broker.directory, manifest_sha256: broker.manifest_sha256 } };
}
async function closeRetainedCohort(lab) {
  if (!lab) return;
  for (const writer of lab.writers) {
    try { fs.writeFileSync(path.join(lab.rendezvous, `${writer.name}.release`), ''); } catch (_) { /* fixture release */ }
    if (writer.child && writer.child.exitCode === null && writer.child.signalCode === null) writer.child.kill();
  }
  try { await batch.closeCohortBroker(lab.cohortHandle); } catch (_) { /* already stopped */ }
  try { removeLockRoot(lab.broker.manifest.lock_root); } catch (error) { console.log(`      lock cleanup: ${error && error.message}`); }
}
const memberCall = (lab, index) => ({ ...lab.requests[index], memberHandle: lab.handles[index] });
const u3b = {};

// ── U3b-1 / U3b-2: retention while a sibling runs; custody is never authority ─

test('issue343 U3b-2 a phase-only ready cache cannot cross the barrier or bypass the retained completion core', async () => {
  let lab = null;
  try {
    lab = await retainedCohort('ready-cache');
    const { handles, requests, broker, writers, rendezvous } = lab;
    const captures = CAPTURES.length, transports = TRANSPORTS;
    const running = handles.map((handle, index) => settle(unit.runUnitSidecar(memberCall(lab, index), {})));
    await within(entered(rendezvous, NAMES), 60000, 'both ready-cache writers entered');
    fs.writeFileSync(path.join(rendezvous, 'T01.release'), '');
    const first = await within(running[0], 90000, 'ready-cache T01 retained'); assert(!first.error, first.error && first.error.stack);
    const receiptFile = requests[0].resultFile + '.receipt.json', executedBytes = fs.readFileSync(receiptFile);
    const phaseOnly = { ...JSON.parse(executedBytes), phase: 'ready' };
    assert(writers[1].child.exitCode === null && writers[1].child.signalCode === null, 'sibling really remains alive');
    try {
      fs.writeFileSync(receiptFile, JSON.stringify(phaseOnly, null, 2) + '\n');
      await rejectsCode(unit.runUnitSidecar(memberCall(lab, 0), {}), 'batch-member-barrier-open', 'phase-only ready before barrier');
      assert.deepStrictEqual([CAPTURES.length, TRANSPORTS], [captures, transports + 2], 'refusal neither captures nor infers');
    } finally { fs.writeFileSync(receiptFile, executedBytes); }
    fs.writeFileSync(path.join(rendezvous, 'T02.release'), '');
    const second = await within(running[1], 90000, 'ready-cache T02 retained'); assert(!second.error, second.error && second.error.stack);
    assert.deepStrictEqual([CAPTURES.length, TRANSPORTS], [captures, transports + 2], 'phase-cache refusal never captures, infers or publishes');
    assert.strictEqual(reconciliation.readBatchEvidence(lab.trust).surface.matches_s0, true);
    for (const id of NAMES) for (const suffix of DELIVERY_SUFFIXES) assert(!fs.existsSync(taskFile(lab.dir, id, suffix)), 'no owner artifacts');
  } finally { await closeRetainedCohort(lab); }
});

test('issue343 U3b-1 a finished member is retained executed plus seal, with no owner artifact or completion, while its sibling still runs', async () => {
  const lab = await retainedCohort('retained');
  try {
    const { dir, handles, requests, broker, writers, rendezvous } = lab;
    const transports = TRANSPORTS, captures = CAPTURES.length;
    // T02 also writes one undeclared file: its returned response can only ever be custody.
    writers[1].files.push('src/t02-undeclared.js');
    const running = handles.map((handle, index) => settle(unit.runUnitSidecar(memberCall(lab, index), {})));
    await within(entered(rendezvous, NAMES), 60000, 'both synthetic writers entered');
    const seen = NAMES.map(name => readJson(path.join(rendezvous, `${name}.entered`)));
    assert.deepStrictEqual(seen.map(row => rootsApi.key(fs.realpathSync.native(row.cwd))),
      requests.map(request => rootsApi.key(fs.realpathSync.native(request.cwd))), 'each writer runs inside its own member worktree');
    assert(writers.every(writer => writer.child && writer.child.exitCode === null && writer.child.signalCode === null), 'both writers are alive together');
    // T01 finishes; T02 keeps running.
    fs.writeFileSync(path.join(rendezvous, 'T01.release'), '');
    const first = await within(running[0], 90000, 'the T01 sidecar');
    assert(!first.error, first.error && first.error.stack);
    assert(writers[1].child.exitCode === null && writers[1].child.signalCode === null, 'the sibling writer still runs');
    const result = first.value, member0 = broker.manifest.members[0];
    assert.deepStrictEqual([result.status, result.stage, result.provider_called, result.task_id, result.member_ref, result.batch_id],
      ['retained', 'executed', true, 'T01', member0.member_ref, lab.ids.batch_id]);
    assert.deepStrictEqual(readJson(requests[0].resultFile), result, 'the result channel holds the retention, never a done delivery');
    // Executed plus its real seal: bound to the member runtime view, keeping the original plan hash.
    const receiptFile = `${requests[0].resultFile}.receipt.json`, receipt = readJson(receiptFile);
    assert.strictEqual(receipt.phase, 'executed');
    assert.strictEqual(receipt.delivery_capture, undefined, 'no capture before the barrier');
    assert.strictEqual(receipt.artifacts, undefined, 'no ready artifacts');
    assert.strictEqual(receipt.verification_seal.runtime_view_sha256, member0.runtime_view_sha256);
    assert.strictEqual(receipt.verification_seal.plan_sha256, lab.manifestRecord.members[0].plan.sha256);
    assert.deepStrictEqual(Object.keys(receipt.milestone_delivery.verified_files), ['primary::src/t01.js']);
    assert.deepStrictEqual([receipt.milestone_delivery.protected_owner, receipt.recovery_baseline.protected_owner], [null, null],
      'no private snapshot of the shared owner');
    // The immutable executed copy and the RetainedRef in the batch area, bound by the broker's one anchor.
    const refBytes = fs.readFileSync(result.retained_ref.path), ref = JSON.parse(refBytes);
    assert.strictEqual(digest(refBytes), result.retained_ref.sha256);
    assert(rootsApi.within(path.join(lab.prepared.base.batch_dir, 'retained'), result.retained_ref.path), 'the RetainedRef lives in the cohort batch area');
    const executedCopy = fs.readFileSync(ref.executed.path);
    assert(executedCopy.equals(fs.readFileSync(receiptFile)), 'the executed copy is the executed receipt byte for byte');
    const custody = fs.readFileSync(`${requests[0].resultFile}.returned.json`);
    assert.strictEqual(JSON.parse(custody).trust, 'transport-normalized; unit-validation-pending', 'returned.json stays custody');
    const anchor = readJson(ref.anchor.path);
    assert(signatureValid(broker.manifest.public_key, anchor), 'the anchor is signed by the cohort key');
    assert.deepStrictEqual([anchor.kind, anchor.member_ref, anchor.executed_sha256, anchor.response_sha256, anchor.seal_sha256],
      ['member-response', member0.member_ref, digest(executedCopy), digest(custody), receipt.verification_seal.sha256]);
    assert.strictEqual(rootsApi.digest(anchor), result.anchor_sha256);
    for (const [label, value] of [['RetainedRef', refBytes], ['executed copy', executedCopy], ['result', fs.readFileSync(requests[0].resultFile)]]) {
      assertNoKey(label, value);
    }
    // Nothing reached the owner but signed member lines: no SUMMARY, DELIVERY, envelope or marker,
    // no controller completion, STATE or progress change (the whole .gsd surface still matches S0).
    const evidence = reconciliation.readBatchEvidence(lab.trust);
    assert.deepStrictEqual([evidence.stream, evidence.surface.matches_s0, evidence.proofs], ['verified', true, 4]);
    assert.deepStrictEqual(evidence.members.map(row => (row.anchor ? row.anchor.sha256 : null)), [result.anchor_sha256, null]);
    for (const id of NAMES) for (const suffix of DELIVERY_SUFFIXES) assert(!fs.existsSync(taskFile(dir, id, suffix)), `${id}-${suffix} is not published`);
    assert(fs.readFileSync(path.join(sliceDir(dir), `${S}-PLAN.md`)).equals(lab.slicePlan), 'no task marker');
    const lines = fs.readFileSync(at(dir, EVENTS)).subarray(broker.manifest.append_baselines[EVENTS].length).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepStrictEqual(lines.filter(line => line.event === 'dispatch').map(line => [line.batch_id, line.member_ref]).sort(),
      broker.manifest.members.map(member => [lab.ids.batch_id, member.member_ref]).sort(), 'each member dispatch line is the canonical member builder\'s');
    assert(!lines.some(line => line.event === 'sidecar-unit' && line.status !== 'started'), 'no terminal unit event while retained');
    assert.strictEqual(CAPTURES.length, captures, 'no heavy capture before the barrier');
    assert.strictEqual(TRANSPORTS, transports + 2, 'one transport per member');
    // The replay respects the barrier: the retained execution again, zero provider calls.
    const replay = await unit.runUnitSidecar(memberCall(lab, 0), {});
    assert.deepStrictEqual([replay.status, replay.stage, replay.provider_called, replay.anchor_sha256, replay.retained_ref.sha256],
      ['retained', 'executed', false, result.anchor_sha256, result.retained_ref.sha256]);
    assert(fs.readFileSync(receiptFile).equals(executedCopy), 'the replay never rewrites the executed record');
    // The heavy verification does not exist before the barrier; foreign handles never reach it.
    await rejectsCode(unit.verifyRetainedExecution(memberCall(lab, 0)), 'batch-member-barrier-open', 'verification before the barrier');
    await rejectsCode(unit.verifyRetainedExecution({ ...requests[0], memberHandle: { ...handles[0] } }), 'batch-member-attempt-required', 'a cloned handle');
    await rejectsCode(unit.runUnitSidecar({ ...requests[0], memberHandle: { ...handles[0] } }, {}), 'batch-member-attempt-required', 'a cloned handle replay');
    await rejectsCode(unit.runUnitSidecar({ ...requests[0], dispatchId: 'u3b-no-handle', resultFile: path.join(CHANNELS, 'no-handle.json') }, {}),
      'execution-member-handle-required', 'a member request without its handle');
    assert(!fs.existsSync(path.join(CHANNELS, 'no-handle.json.receipt.json')), 'a refused request writes no receipt');
    assert.deepStrictEqual([CAPTURES.length, TRANSPORTS], [captures, transports + 2]);
    u3b.retained = { lab, running, result, executedCopy, transports, captures };
  } catch (error) { await closeRetainedCohort(lab); throw error; }
});

test('issue343 U3b-2 a saved returned response alone is never replay authority, before or after the barrier', async () => {
  assert(u3b.retained, 'the retained cohort is required');
  const { lab, running, result, executedCopy, transports, captures } = u3b.retained;
  try {
    const { handles, requests, broker, rendezvous, prepared } = lab;
    // T02 returns with an undeclared write: its transport response is retained as custody only.
    fs.writeFileSync(path.join(rendezvous, 'T02.release'), '');
    const second = await within(running[1], 90000, 'the T02 sidecar');
    assert(second.error, 'the undeclared write is refused');
    assert.deepStrictEqual([second.error.code, second.error.provider_called], ['execution-outside-claim', true]);
    const failed = readJson(`${requests[1].resultFile}.receipt.json`);
    const custody = fs.readFileSync(`${requests[1].resultFile}.returned.json`);
    assert.strictEqual(failed.phase, 'failed');
    assert.strictEqual(failed.returned_response.sha256, digest(custody), 'the custodial response is hashed, never executed');
    const member1 = broker.manifest.members[1], retainedDir = path.join(prepared.base.batch_dir, 'retained');
    assert(!fs.existsSync(path.join(retainedDir, `${member1.member_ref}.json`)), 'custody never becomes a RetainedRef');
    // The sidecar replay of custody alone: the recorded failure, no provider, no retention.
    const replayed = await settle(unit.runUnitSidecar(memberCall(lab, 1), {}));
    assert.strictEqual(replayed.error && replayed.error.code, 'execution-outside-claim');
    assert.strictEqual(TRANSPORTS, transports + 2, 'zero second inference');
    // The barrier seals from the broker's own process observations: T01 retained, T02 failed.
    const barrier = await broker.sealExecutionBarrier(lab.cohortHandle, [{ handle: handles[0], outcome: 'retained' }, { handle: handles[1], outcome: 'failed' }]);
    assert.deepStrictEqual(barrier.members.map(row => [row.outcome, row.anchor_sha256]), [['retained', result.anchor_sha256], ['failed', null]]);
    // After the barrier, the post-barrier verification refuses custody alone, and a RetainedRef
    // forged over the custodial bytes, with no anchor of the broker behind it.
    await rejectsCode(unit.verifyRetainedExecution(memberCall(lab, 1)), 'batch-member-retained-required', 'custody alone after the barrier');
    const forgedExecuted = path.join(retainedDir, `${member1.member_ref}.executed.json`), forgedRef = path.join(retainedDir, `${member1.member_ref}.json`);
    const t01Ref = readJson(u3b.retained.result.retained_ref.path);
    fs.writeFileSync(forgedExecuted, custody);
    fs.writeFileSync(forgedRef, `${JSON.stringify({ ...t01Ref, member_index: 1, task_id: 'T02', member_ref: member1.member_ref,
      dispatch_id: requests[1].dispatchId, request_sha256: member1.request_sha256, executed: { path: forgedExecuted, sha256: digest(custody) },
      response: { path: `${requests[1].resultFile}.returned.json`, sha256: digest(custody) },
      anchor: { path: path.join(broker.directory, 'anchors', 'm1.json'), sha256: digest('a forged anchor') } })}\n`);
    try {
      await rejectsCode(unit.verifyRetainedExecution(memberCall(lab, 1)), 'batch-retained-invalid', 'a RetainedRef forged over custody');
    } finally { fs.rmSync(forgedRef, { force: true }); fs.rmSync(forgedExecuted, { force: true }); }
    // The successful sibling and its original bytes survive the partial failure; still no capture.
    assert(fs.readFileSync(`${requests[0].resultFile}.receipt.json`).equals(executedCopy), 'the retained sibling is preserved');
    const evidence = reconciliation.readBatchEvidence(lab.trust);
    assert.deepStrictEqual([evidence.stream, evidence.surface.matches_s0, evidence.barrier.sealed], ['verified', true, true]);
    for (const suffix of DELIVERY_SUFFIXES) assert(!fs.existsSync(taskFile(lab.dir, 'T01', suffix)), `T01-${suffix} is not published`);
    assert.deepStrictEqual([CAPTURES.length, TRANSPORTS], [captures, transports + 2]);
  } finally { await closeRetainedCohort(lab); }
});

test('issue343 U3b-2 the heavy capture starts only after the barrier, from the anchored executed record, and writes nothing to the owner', async () => {
  let lab = null;
  try {
    lab = await retainedCohort('verified', () => ({ claudePermissions: 'verification' }));
    const { dir, handles, requests, broker, writers, rendezvous } = lab;
    const transports = TRANSPORTS, captures = CAPTURES.length;
    const running = handles.map((handle, index) => settle(unit.runUnitSidecar(memberCall(lab, index), {})));
    await within(entered(rendezvous, NAMES), 60000, 'both synthetic writers entered');
    fs.writeFileSync(path.join(rendezvous, 'T01.release'), '');
    const first = await within(running[0], 90000, 'the T01 sidecar');
    fs.writeFileSync(path.join(rendezvous, 'T02.release'), '');
    const second = await within(running[1], 90000, 'the T02 sidecar');
    for (const outcome of [first, second]) assert(!outcome.error, outcome.error && outcome.error.stack);
    assert.deepStrictEqual([first.value.status, second.value.status], ['retained', 'retained']);
    // The Claude verification permission of each member derives from its member seal and view.
    writers.forEach((writer, index) => {
      const policy = writer.options.permissionPolicy;
      assert.strictEqual(policy.seal.runtime_view_sha256, broker.manifest.members[index].runtime_view_sha256);
      assert.deepStrictEqual(permissions.validatePolicy(policy, { cwd: writer.options.cwd, identity: writer.options.permissionIdentity }), policy);
    });
    assert.strictEqual(CAPTURES.length, captures, 'both members are retained without any capture');
    const barrier = await broker.sealExecutionBarrier(lab.cohortHandle, handles.map(handle => ({ handle, outcome: 'retained' })));
    assert.deepStrictEqual(barrier.members.map(row => row.outcome), ['retained', 'retained']);
    // After the barrier: the real core, from the anchored executed record of T01.
    const receiptFile = `${requests[0].resultFile}.receipt.json`, executed = readJson(receiptFile);
    const verified = await unit.verifyRetainedExecution(memberCall(lab, 0));
    assert.deepStrictEqual([verified.status, verified.stage, verified.provider_called, verified.anchor_sha256],
      ['retained', 'ready', false, first.value.anchor_sha256]);
    assert.strictEqual(CAPTURES.length, captures + 1, 'exactly one heavy capture, after the barrier');
    assert.deepStrictEqual(CAPTURES[CAPTURES.length - 1].roots, [rootsApi.key(requests[0].cwd)], 'it measured only the member root');
    assert.strictEqual(TRANSPORTS, transports + 2, 'no provider in the verification');
    const ready = readJson(receiptFile);
    assert.strictEqual(digest(fs.readFileSync(receiptFile)), verified.ready_sha256);
    assert.deepStrictEqual([ready.phase, ready.delivery_capture.passed, ready.delivery_capture.verification_policy_sha256],
      ['ready', true, executed.verification_seal.sha256]);
    const artifactPaths = ready.artifacts.map(artifact => artifact.path);
    const prefix = `.gsd/milestones/${M}/slices/${S}/tasks/T01/T01-`;
    assert.deepStrictEqual(artifactPaths, [`${prefix}VERIFICATION-primary-ENVELOPE.json`, `${prefix}ARTIFACT-primary-ENVELOPE.json`,
      `${prefix}SUMMARY.md`, `${prefix}DELIVERY-INPUT.json`, `${prefix}DELIVERY.json`, `.gsd/milestones/${M}/slices/${S}/${S}-PLAN.md`]);
    const output = JSON.parse(ready.artifacts.find(artifact => artifact.path === `${prefix}DELIVERY.json`).content);
    const input = JSON.parse(ready.artifacts.find(artifact => artifact.path === `${prefix}DELIVERY-INPUT.json`).content);
    const planSha = lab.manifestRecord.members[0].plan.sha256;
    assert.deepStrictEqual([output.plan.fingerprint, input.plan_fingerprint], [planSha, planSha], 'the delivery keeps the original plan hash');
    assert.deepStrictEqual(input.execution_contract.code_roots.map(root => rootsApi.key(root.path)), [rootsApi.key(requests[0].cwd)],
      'the delivery evidence names the member physical root it measured');
    assert.match(ready.artifacts[ready.artifacts.length - 1].content, /- \[x\] \*\*T01\*\*/, 'the task marker is prepared last');
    // Prepared, never published: the owner surface still matches S0 and nothing was written there.
    const evidence = reconciliation.readBatchEvidence(lab.trust);
    assert.deepStrictEqual([evidence.surface.matches_s0, evidence.barrier.sealed], [true, true]);
    for (const suffix of DELIVERY_SUFFIXES) assert(!fs.existsSync(taskFile(dir, 'T01', suffix)), `T01-${suffix} is not published`);
    assert(fs.readFileSync(path.join(sliceDir(dir), `${S}-PLAN.md`)).equals(lab.slicePlan), 'no task marker in the owner');
    assert(Array.isArray(verified.deferred_events), 'resource events are returned, never appended');
    // The sibling stays exactly retained.
    const sibling = readJson(`${requests[1].resultFile}.receipt.json`);
    assert.deepStrictEqual([sibling.phase, sibling.delivery_capture], ['executed', undefined]);
    // A replay of the verified member never publishes and never infers again.
    const replay = await unit.runUnitSidecar(memberCall(lab, 0), {});
    assert.deepStrictEqual([replay.status, replay.stage, replay.provider_called], ['retained', 'ready', false]);
    assert.deepStrictEqual([CAPTURES.length, TRANSPORTS], [captures + 1, transports + 2]);
    for (const suffix of DELIVERY_SUFFIXES) assert(!fs.existsSync(taskFile(dir, 'T01', suffix)), `T01-${suffix} is still not published`);
    u3b.verified = { view: lab.views[0], seal: executed.verification_seal, request: requests[0] };
  } finally { await closeRetainedCohort(lab); }
});

// ── U3b-3: the single path ───────────────────────────────────────────────────

test('issue343 U3b-3 the single path publishes exactly as before; member requests, forged views and member seals never take it', async () => {
  const dir = owner('single');
  planSlice(dir, { T01: taskPlan('T01') });
  const contract = rootsApi.validateContract({ schema_version: 2, owner: dir, primary_root_id: 'primary', code_roots: [{ id: 'primary', path: dir, vcs: 'git' }] });
  const runId = 'M-20261108000001-single';
  runs.add(dir, { id: runId, kind: 'milestone', session_id: SESSION, host_runtime: 'codex',
    project: dir, cwd: dir, milestone_dir: `.gsd/milestones/${M}/`, isolation_mode: 'worktree' });
  claims.recordClaim(dir, runId, { schema_version: 2, execution_contract: contract, source: 'plan-writes', unit: 'T01',
    paths: [{ root_id: 'primary', path: 'src/t01.js' }] });
  const planFile = path.join(sliceDir(dir), 'tasks', 'T01', 'T01-PLAN.md'), slicePlanFile = path.join(sliceDir(dir), `${S}-PLAN.md`);
  const request = { unitType: 'execute-task', scope: 'milestone', phase: 'execute', milestoneId: M, sliceId: S, taskId: 'T01',
    cwd: contract.code_roots[0].path, contextRoot: dir, planFile, execution_contract: contract, runId, claim: runs.get(dir, runId).write_claim,
    dispatchId: 'u3b-single-dispatch', workflowId: 'u3b-single-workflow',
    route: resolveDispatch({ unitType: 'execute-task', cwd: dir, planPath: planFile, milestoneId: M, unitId: 'T01', hostRuntime: 'codex' }),
    resultFile: path.join(CHANNELS, 'single-T01.json'), prompt: 'Synthetic single fixture only.',
    verification: { preferenceCommands: ['node --check src/t01.js'] },
    gates: { plan: 'approved', claim: 'proceed', security: 'not-applicable' }, constraints: { auto_commit: false, deploy: false } };
  const rendezvous = fs.mkdtempSync(path.join(TMP, 'u3b-single-rendezvous-'));
  fs.writeFileSync(path.join(rendezvous, 'single.release'), '');
  WRITERS.set(rootsApi.key(fs.realpathSync.native(dir)), { name: 'single', rendezvous, files: ['src/t01.js'], broker: null });
  try {
    const transports = TRANSPORTS, captures = CAPTURES.length;
    // A member-shaped request without its handle never takes the single path, before any receipt.
    const named = { ...request, batch_id: `batch-${'0'.repeat(32)}`, dispatchId: 'u3b-single-named', resultFile: path.join(CHANNELS, 'single-named.json') };
    const refused = await settle(unit.runUnitSidecar(named, {}));
    assert.deepStrictEqual([refused.error && refused.error.code, refused.error && refused.error.provider_called], ['execution-member-handle-required', false]);
    assert(!fs.existsSync(`${named.resultFile}.receipt.json`), 'no receipt for the refused request');
    assert.strictEqual(TRANSPORTS, transports, 'no transport for the refused request');
    // The single path: one transport, one capture before publication, the delivery published with
    // the task marker last, its historical seal and its own owner snapshot.
    const published = await unit.runUnitSidecar(request, {});
    assert.strictEqual(published.status, 'done');
    assert.deepStrictEqual([TRANSPORTS, CAPTURES.length], [transports + 1, captures + 1]);
    const receipt = readJson(`${request.resultFile}.receipt.json`);
    assert.strictEqual(receipt.phase, 'ready');
    assert.deepStrictEqual(Object.keys(receipt.verification_seal).sort(), [...SINGLE_SEAL_KEYS].sort(), 'the single seal keeps exactly its historical fields');
    assert.strictEqual(receipt.delivery_capture.passed, true);
    assert(receipt.milestone_delivery.protected_owner && typeof receipt.milestone_delivery.protected_owner === 'object', 'the single path keeps its owner snapshot');
    for (const suffix of DELIVERY_SUFFIXES) assert(fs.existsSync(taskFile(dir, 'T01', suffix)), `T01-${suffix} is published`);
    assert.match(fs.readFileSync(slicePlanFile, 'utf8'), /- \[x\] \*\*T01\*\*/, 'the task marker is checked');
    const output = readJson(taskFile(dir, 'T01', 'DELIVERY.json'));
    assert.strictEqual(output.plan.fingerprint, digest(fs.readFileSync(planFile)));
    assert(!fs.existsSync(path.join(CHANNELS, 'single-T01.json.retained.json')), 'the single path retains nothing');
    // The same seal is re-derived without a view, field for field.
    const plan = fs.readFileSync(planFile, 'utf8'), identity = receipt.verification_seal.identity;
    assert.deepStrictEqual(verifyApi.normalizeExecutionVerification(contract, plan, request.verification, undefined, identity), receipt.verification_seal);
    assert.strictEqual(verifyApi.assertExecutionVerification(receipt.verification_seal, contract, plan, identity), receipt.verification_seal);
    // A seal claiming a runtime view never verifies without its minted view, and never creates a policy.
    const { sha256: ignored, ...body } = receipt.verification_seal;
    const memberLike = { ...body, runtime_view_sha256: digest('a runtime view'), sha256: rootsApi.digest({ ...body, runtime_view_sha256: digest('a runtime view') }) };
    assert.throws(() => verifyApi.assertExecutionVerification(memberLike, contract, plan, identity), { code: 'verification-provenance-insufficient' });
    assert.throws(() => permissions.createPolicy({ seal: memberLike, contract, identity, cwd: dir }), { code: 'claude-permission-member-view-required' });
    // A forged or copied view is never a member view, for the seal, the capture or the delivery.
    const forgedView = { schema: 'forge-batch-runtime-view-v1', canonical_plan_sha256: digest(plan), runtime_contract_sha256: rootsApi.digest(contract),
      runtime_plan_text: plan, runtime_view_sha256: digest('forged') };
    assert.throws(() => verifyApi.normalizeExecutionVerification(contract, plan, request.verification, undefined, identity, { memberView: forgedView }),
      { code: 'verification-member-view-invalid' });
    assert.throws(() => verifyApi.captureRootDelivery(contract, plan, { ...request.verification, memberView: forgedView }), { code: 'verification-member-view-invalid' });
    const inputBytes = fs.readFileSync(taskFile(dir, 'T01', 'DELIVERY-INPUT.json'));
    assert.throws(() => deliveryApi.buildDelivery(JSON.parse(inputBytes), { ownerRoot: dir, codeDir: dir, memberView: forgedView }), /delivery-member-view-invalid/);
    if (u3b.verified) {
      // The real minted view of a verified member binds its member seal and nothing else; a copy of it is refused.
      const { view, seal, request: memberRequest } = u3b.verified, memberPlan = fs.readFileSync(memberRequest.planFile, 'utf8');
      assert.strictEqual(verifyApi.assertExecutionVerification(seal, memberRequest.execution_contract, memberPlan, seal.identity, { memberView: view }), seal);
      assert.throws(() => verifyApi.assertExecutionVerification(seal, memberRequest.execution_contract, memberPlan, seal.identity, { memberView: JSON.parse(JSON.stringify(view)) }),
        { code: 'verification-member-view-invalid' });
      assert.throws(() => verifyApi.assertExecutionVerification(seal, memberRequest.execution_contract, memberPlan, seal.identity), { code: 'verification-provenance-insufficient' });
      assert.throws(() => verifyApi.assertExecutionVerification(receipt.verification_seal, contract, plan, identity, { memberView: view }), { code: 'verification-member-view-invalid' });
    }
  } finally { removeLockRoot(ownerLockRoot(dir)); }
});

(async () => {
  try {
    await runCases();
  } finally {
    if (lab.broker) {
      try { await lab.broker.close(); } catch (_) { /* already stopped */ }
      try { removeLockRoot(lab.broker.manifest.lock_root); } catch (error) { console.log(`      lock cleanup: ${error && error.message}`); }
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  for (const [name, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best-effort cleanup of synthetic fixtures */ }
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
