#!/usr/bin/env node
'use strict';

// forge-execution-batch-process.test.js — issue 343 U4: the bounded cohort pool of
// forge-execution-batch (runCohort, and the real CLI `run --batch <ref> --request <file>`) over
// REAL cohorts: the real long-workflow adapter, loop, orchestrate and controller dispatch them,
// prepareIsolation gives each member its own worktree and index, the real forge-unit-sidecar
// runUnitSidecar runs each member and the existing cohort broker signs its owner lines.
//
//   U4-1 through the real batch CLI, two synthetic provider processes are inside distinct member
//        worktrees before either can finish: each provider writes its entry marker (real pid and
//        cwd) into an external rendezvous folder and finishes only after seeing its sibling's.
//        The same rendezvous run with limit one (a serial pool) leaves the first provider alone
//        and it fails, so a serial implementation cannot pass the CLI case;
//   U4-2 three members with limit two never run three providers at once;
//   U4-3 each provider receives exactly its own route, model, effort, cwd and sanitized
//        environment: synthetic secret sentinels and the owner token never reach a provider;
//   U4-4 aborting one member stops only its own process scope (never through process.emit of a
//        signal); imported approvals, routes, foreign owners and malformed CLI input start nothing.
//
// Part 2, issue 343 U5 (forge-execution-batch consolidateCohort and the CLI `consolidate`), over the
// same real retained cohorts after their sealed barrier:
//   U5-1 serial verify, publish, integrate and ACK in manifest order, with the integrated recheck;
//   U5-2 a done member beside a failed and a needs-input sibling is acknowledged; the residual and
//        the dependents of the failure stay blocked;
//   U5-3 a fresh process restarted at each failpoint performs zero second inference, publication,
//        delta, commit or ACK;
//   U5-4 one-byte edits of receipts, manifests, proofs, the target and .gsd/events refuse;
//   U5-5 a moved target or a Git conflict integrates nothing and preserves worktrees and results;
//   U5-6 cleanup retains dirty or needed worktrees and keeps every sibling claim valid;
//   U5-7 native and SVN controls keep their current native or serial paths.
//
// Everything is synthetic and local (the U3a/U3b fixture shape): temporary HOME/USERPROFILE/
// FORGE_HOME (no operator preference), `git init` owners with pinned local config,
// FORGE_RESOURCES_PRESSURE=1 (the documented forced-normal seam of forge-resources), no paid
// provider, network or real history; the provider binary overrides point at a path that does not
// exist, so no real provider can ever start. The one replaced seam is the transport adapter entry
// (forge-xllm runExecute), as forge-execution-batch-broker.test.js replaces it: it launches a real
// synthetic provider process inside the member's own worktree with the adapter's own environment
// sanitizer (forge-xllm buildSidecarEnv), attaches it through the member's process scope
// (forge-execution-batch currentMemberProcessScope) and honors the member's AbortSignal by
// terminating its own process tree. In the CLI process the same transport module is installed by
// a `-r` preload that replaces that entry when forge-xllm loads (it loads no Forge module itself).

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-batch-process-')));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME, { recursive: true });
// Synthetic credentials in the coordinator environment: none may ever reach a provider.
const SECRETS = Object.freeze({
  FORGE_SYNTHETIC_PROVIDER_SECRET: `forge-synthetic-secret-${crypto.randomUUID()}`,
  SYNTHETIC_UPSTREAM_TOKEN: `synthetic-upstream-token-${crypto.randomUUID()}`,
  FORGE_ANTHROPIC_SYNTHETIC_KEY: `synthetic-provider-key-${crypto.randomUUID()}`,
});
// A plain FORGE_ value the sanitizer keeps: a provider environment is filtered, not emptied.
const VISIBLE = Object.freeze({ name: 'FORGE_SYNTHETIC_ROUTE_MARKER', value: `visible-${crypto.randomUUID()}` });
const NO_PROVIDER = path.join(TMP, 'no-real-provider', 'provider.exe');
const SAVED_ENV = Object.fromEntries(['HOME', 'USERPROFILE', 'FORGE_HOME', 'FORGE_RESOURCES_PRESSURE', 'FORGE_XLLM_CLAUDE_BIN',
  'FORGE_XLLM_CODEX_BIN', VISIBLE.name, ...Object.keys(SECRETS)].map(name => [name, process.env[name]]));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.FORGE_HOME = path.join(HOME, '.forge-agent');
process.env.FORGE_RESOURCES_PRESSURE = '1';
// No real provider can start in this suite, whatever transport would run.
process.env.FORGE_XLLM_CLAUDE_BIN = NO_PROVIDER;
process.env.FORGE_XLLM_CODEX_BIN = NO_PROVIDER;
for (const [name, value] of Object.entries(SECRETS)) process.env[name] = value;
process.env[VISIBLE.name] = VISIBLE.value;
fs.cpSync(path.join(__dirname, '..', 'shared'), path.join(process.env.FORGE_HOME, 'shared'), { recursive: true });
const CHANNELS = path.join(TMP, 'channels');
fs.mkdirSync(CHANNELS, { recursive: true });

// Account resolution is the canonical credential seam; replace it before any
// production adapter can be imported through the controller graph.
const fixtureAccounts = require('./forge-accounts'), savedLaunch = fixtureAccounts.resolveLaunch;
let unavailableAccountTask = null;
fixtureAccounts.resolveLaunch = () => {
  if(require('./forge-execution-batch').currentMemberProcessScope()?.task_id===unavailableAccountTask)throw Error('synthetic unavailable account');
  return {name:'isolated-process-fixture',token:'synthetic-process-fixture-token'};
};
const adapter = require('./forge-long-workflow-adapter');
const loop = require('./forge-loop-controller');
const controller = require('./forge-unit-controller');
const batch = require('./forge-execution-batch');
const state = require('./forge-state');
const runs = require('./forge-runs');
const claims = require('./forge-write-claim');
const rootsApi = require('./forge-code-roots');
const reconciliation = require('./forge-artifact-reconciliation');
// The production Claude adapter captures this canonical account seam at load.
// Synthetic child-only credentials keep these fixtures entirely off operator accounts.
const xllm = require('./forge-xllm');
fixtureAccounts.resolveLaunch = savedLaunch;
const isolation = require('./forge-isolation');
const lease = require('./forge-unit-lease');
const { resolveDispatch } = require('./forge-dispatch-resolve');

const M = 'M-20261108000000-batch';
const S = 'S01';
const TOKEN = 'owner-process-token-8d2f';
const SESSION = 'session-process-fixture-4b71';
const COMMIT = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m'];
const PAIR = Object.freeze(['T01', 'T02']);
const TRIO = Object.freeze(['T01', 'T02', 'T03']);
const CLI = path.join(__dirname, 'forge-execution-batch.js');
const XLLM = path.join(__dirname, 'forge-xllm.js');
// PEM private blocks and the PKCS#8 Ed25519 private-key prefix (base64, hex and raw DER).
const KEY_DER = Buffer.from('302e020100300506032b657004220420', 'hex');
const KEY_MARKERS = Object.freeze(['PRIVATE KEY', 'MC4CAQAwBQYDK2VwBCIEI', KEY_DER.toString('hex')]);

// The synthetic provider: it publishes its entry marker (real pid, real cwd, the route arguments
// and the environment it received), waits until every named sibling entered, optionally holds
// until released, writes its one product file relative to its cwd and publishes its finish.
// Markers are published by rename, so a reader never sees half of one.
const PROVIDER = path.join(TMP, 'provider', 'synthetic-provider.js');
const TRANSPORT = path.join(TMP, 'provider', 'synthetic-transport.js');
fs.mkdirSync(path.dirname(PROVIDER), { recursive: true });
fs.writeFileSync(PROVIDER, [
  "'use strict';",
  "const fs = require('fs');",
  "const path = require('path');",
  'const [name, dir, peerList, file, model, effort, waitMs, mode, operationText] = process.argv.slice(2);',
  "const operations = JSON.parse(operationText || '[]');",
  "const peers = peerList ? peerList.split(',') : [];",
  'const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));',
  'function publish(target, value) { fs.writeFileSync(`${target}.tmp`, JSON.stringify(value)); fs.renameSync(`${target}.tmp`, target); }',
  'async function until(test, label, ms) {',
  '  const deadline = Date.now() + ms;',
  '  while (!test()) {',
  '    if (Date.now() > deadline) throw new Error(`synthetic provider ${name} timed out waiting for ${label}`);',
  '    await sleep(10);',
  '  }',
  '}',
  '(async () => {',
  '  publish(path.join(dir, `${name}.entered`), { pid: process.pid, cwd: process.cwd(), model, effort, mode, at: Date.now(), env: process.env });',
  // U5: a failing provider exits on entry, before writing anything.
  "  if (mode === 'fail') { process.exitCode = 3; return; }",
  "  await until(() => peers.every(peer => fs.existsSync(path.join(dir, `${peer}.entered`))), 'its siblings', Number(waitMs) || 30000);",
  '  publish(path.join(dir, `${name}.peers-seen`), { pid: process.pid, at: Date.now() });',
  "  if (mode === 'hold') await until(() => fs.existsSync(path.join(dir, `${name}.release`)), 'its release', 180000);",
  '  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });',
  '  fs.writeFileSync(file, `module.exports = ${JSON.stringify(`${name}:${file}`)};\\n`);',
  '  for (const operation of operations) {',
  "    if (operation.kind === 'rename') fs.renameSync(operation.from, operation.path);",
  "    else if (operation.kind === 'delete') fs.unlinkSync(operation.path);",
  "    else if (operation.kind === 'binary') fs.writeFileSync(operation.path, Buffer.from(operation.base64, 'base64'));",
  "    else if (operation.kind === 'mode') fs.chmodSync(operation.path, operation.mode);",
  "    else throw new Error('unknown fixture operation');",
  '  }',
  '  publish(path.join(dir, `${name}.finished`), { pid: process.pid, at: Date.now() });',
  '})().catch(error => { process.stderr.write(`${error && error.stack ? error.stack : error}\\n`); process.exitCode = 3; });',
  '',
].join('\n'));
// The transport adapter entry (forge-xllm runExecute) of this fixture, shared by the test process
// and the CLI process: one real synthetic provider inside the member's own worktree, with the
// adapter's own sanitized environment, attached through the member's process scope; the member's
// AbortSignal terminates its own process tree, as the real adapters do on cancel.
fs.writeFileSync(TRANSPORT, [
  "'use strict';",
  "const fs = require('fs');",
  "const { spawn } = require('child_process');",
  'module.exports = function createTransport(config) {',
  '  return async function syntheticRunExecute(options) {',
  '    const xllm = require(config.xllm);',
  '    const scope = require(config.batch).currentMemberProcessScope();',
  "    const unit = options && options.identity && typeof options.identity.unit === 'string' ? options.identity.unit : '';",
  "    const task = unit.slice(unit.indexOf('/') + 1);",
  "    const plan = JSON.parse(fs.readFileSync(config.plan, 'utf8'));",
  '    const member = plan.members[task];',
  "    if (!scope || !member) throw Object.assign(new Error(`no synthetic provider is registered for ${unit}`), { code: 'synthetic-provider-unregistered' });",
  "    if (typeof options.onBeforeSpawn === 'function') options.onBeforeSpawn();",
  '    const file = `src/${task.toLowerCase()}.js`;',
  "    const child = spawn(process.execPath, [config.provider, task, plan.rendezvous, member.peers.join(','), file, String(options.model),",
  "      String(options.effort), String(member.timeout_ms), member.mode || (member.hold ? 'hold' : 'go'), JSON.stringify(member.operations || [])], { cwd: options.cwd,",
  "      env: xllm.buildSidecarEnv(options.envPolicy || 'minimal'), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,",
  "      detached: process.platform !== 'win32' });",
  "    let stderr = '';",
  "    child.stderr.setEncoding('utf8');",
  "    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });",
  '    const exited = new Promise(resolve => {',
  "      child.once('exit', (code, signal) => resolve({ code, signal }));",
  "      child.once('error', error => resolve({ code: null, signal: null, error: String((error && error.code) || error) }));",
  '    });',
  "    const record = entry => fs.appendFileSync(config.journal, `${JSON.stringify(entry)}\\n`);",
  "    record({ event: 'spawned', task, pid: child.pid, at: Date.now(), cwd: options.cwd, engine: options.engine, host: options.hostRuntime,",
  '      model: options.model, effort: options.effort, constraints: options.constraints || null, signal: !!options.signal });',
  "    if (typeof config.onSpawn === 'function') config.onSpawn({ task, child, options });",
  '    const stop = () => xllm.terminateOwnedProcessTree(child);',
  '    try { scope.attach(child); } catch (error) { stop(); await exited; throw error; }',
  // The replaced runExecute must report its actual local start through the same observer.
  // A spawned/attached synthetic child proves a process, not remote provider acceptance.
  "    if (typeof options.announce === 'function') options.announce('iniciado', {",
  '      ...options.identity, engine: options.engine, model_sent: options.model, effort: options.effort, host: options.hostRuntime,',
  "      transport: options.engine === 'claude' ? 'claude-cli' : options.engine === 'agy' ? 'agy-cli' : 'app-server',",
  "      pid: child.pid, provider_called: 'unknown' });",
  '    if (options.signal) {',
  '      if (options.signal.aborted) stop();',
  "      else options.signal.addEventListener('abort', stop, { once: true });",
  '    }',
  '    const outcome = await exited;',
  "    if (options.signal) options.signal.removeEventListener('abort', stop);",
  "    record({ event: 'exited', task, pid: child.pid, at: Date.now(), code: outcome.code, signal: outcome.signal });",
  '    if (options.signal && options.signal.aborted) {',
  "      throw Object.assign(new Error(`synthetic provider ${task} cancelled`), { code: 'synthetic-provider-cancelled' });",
  '    }',
  // U5: a member stopped by its transport with a named code (needs-input, timeout) after its writer exited.
  '    if (member.throw_code) throw Object.assign(new Error(`synthetic provider ${task} stopped`), { code: member.throw_code });',
  '    if (outcome.code !== 0) {',
  "      throw Object.assign(new Error(`synthetic provider ${task} failed: ${stderr}`), { code: 'synthetic-provider-failed' });",
  '    }',
  "    const changed = [file, ...(member.operations || []).flatMap(operation => operation.kind === 'rename' ? [operation.from, operation.path] : [operation.path])];",
  "    return { status: 'done', summary: `${task} synthetic delivery`, files_changed: [...new Set(changed)], must_haves_status: [] };",
  '  };',
  '};',
  '',
].join('\n'));
// The CLI preload: replaces the transport entry of the CLI process when forge-xllm loads.
function preloadSource(configFile) {
  return [
    "'use strict';",
    "const Module = require('module');",
    "const fs = require('fs');",
    "const path = require('path');",
    `const config = JSON.parse(fs.readFileSync(${JSON.stringify(configFile)}, 'utf8'));`,
    'const createTransport = require(config.transport);',
    "const norm = value => { const real = fs.realpathSync.native(path.resolve(value)); return process.platform === 'win32' ? real.toLowerCase() : real; };",
    'const target = norm(config.xllm);',
    'let installed = false;',
    'const load = Module._load;',
    'Module._load = function syntheticTransportPreload(request, parent, isMain) {',
    '  const exported = load.apply(this, arguments);',
    "  if (!installed && exported && typeof exported.runExecute === 'function' && /forge-xllm(?:\\.js)?$/.test(String(request))) {",
    '    let file = null;',
    '    try { file = norm(Module._resolveFilename(request, parent, isMain)); } catch (_) { file = null; }',
    '    if (file === target) { installed = true; exported.runExecute = createTransport(config); }',
    '  }',
    '  return exported;',
    '};',
    '',
  ].join('\n');
}
// The in-process transport: the same module, with a mutable configuration per case.
const CONFIG = { xllm: XLLM, batch: CLI, provider: PROVIDER, plan: null, journal: null, onSpawn: null };
const canonicalRunExecute = xllm.runExecute;
xllm.runExecute = require(TRANSPORT)(CONFIG);
// The members' observer lines of the in-process runs (bounded tail for diagnostics).
const SINK = { bytes: 0, tail: '', write(value) { const line = String(value); this.bytes += line.length; this.tail = (this.tail + line).slice(-8000); return true; } };

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
      console.log(`      member observer tail: ${SINK.tail.slice(-1500).replace(/\n/g, '\n      ')}`);
    }
  }
}

// ── Fixtures (the U2a/U2b/U3b real cohort shape) ──────────────────────────────

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
// A real owner whose root is a real Git checkout with one committed base (U5-7: an SVN-shaped
// owner has a .svn directory and no Git checkout, as the U1 control).
function owner(label, options = {}) {
  const dir = path.join(TMP, `${label}-${++serial}`);
  const base = path.join(dir, '.gsd', 'milestones', M);
  fs.mkdirSync(base, { recursive: true });
  const svn = options.vcs === 'svn';
  if (svn) fs.mkdirSync(path.join(dir, '.svn'));
  else {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'core.autocrlf', 'false']);
  }
  write(path.join(base, `${M}-ROADMAP.md`), `# Roadmap\n\n- [ ] **${S}: Work** \`depends:[]\`\n`);
  write(path.join(base, `${M}-CONTEXT.md`), '# Context\n');
  write(path.join(base, `${M}-RESEARCH.md`), '# Research\n');
  state.write(dir, { milestone: M, kind: 'milestone', phase: 'idle', active_slice: '—', active_task: '—', next_action: 'plan', auto_mode: 'on' });
  write(at(dir, '.gitignore'), 'build/\n*.log\n');
  write(at(dir, 'src/keep.js'), 'module.exports = "keep";\n');
  if (typeof options.setup === 'function') options.setup(dir);
  if (!svn) {
    git(dir, ['add', '--', '.gitignore', 'src']);
    git(dir, [...COMMIT, 'base']);
  }
  return dir;
}
// A new task plan the strict admission accepts (the U1 fixture shape); U5-2 declares a dependency.
function taskPlan(id, depends = []) {
  const output = `src/${id.toLowerCase()}.js`;
  return ['---', 'tier: standard', `depends: [${depends.join(', ')}]`, 'writes:', `  - "${output}"`,
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
// The real cohort: the loop's auto next through the long-workflow adapter dispatches every named
// task with committed begins and live leases (U1). The loop snapshot is kept for its batch commands.
function cohort(dir, names, tasks, hostRuntime = 'codex') {
  planSlice(dir, tasks || Object.fromEntries(names.map(id => [id, taskPlan(id)])));
  const snapshot = loop.create({ mode: 'auto', workflow_id: `wf-${++serial}`, host_runtime: hostRuntime, max_steps: 10 });
  const result = adapter.invoke(hostRuntime, 'auto', 'next', { cwd: dir, milestone: M, owner_token: TOKEN, session: SESSION }, snapshot, {}).result;
  assert.deepStrictEqual([result.outcome, result.action], ['dispatch_required', 'dispatch-batch'], JSON.stringify(result.controller_result));
  const dispatched = result.controller_result.details.dispatch_batch;
  assert.deepStrictEqual(dispatched.members.map(member => member.unit.key), names.map(id => `execute-task/${id}`));
  return { batch_id: dispatched.batch_id, manifest_sha256: dispatched.manifest_sha256, snapshot: result.snapshot };
}
// The real run of the cohort and its live v2 reservation of the integration namespace.
function scopeOf(dir, ids, label, names, hostRuntime = 'codex') {
  const runId = `M-20261108000001-${label}`;
  runs.add(dir, { id: runId, kind: 'milestone', session_id: SESSION, host_runtime: hostRuntime,
    project: dir, cwd: dir, milestone_dir: `.gsd/milestones/${M}/`, isolation_mode: 'worktree' });
  const contract = rootsApi.validateContract({ schema_version: 2, owner: dir, primary_root_id: 'primary', code_roots: [{ id: 'primary', path: dir, vcs: 'git' }] });
  claims.recordClaim(dir, runId, { schema_version: 2, execution_contract: contract, source: 'plan-writes', unit: `BATCH:${names.join(',')}`,
    paths: [{ root_id: 'primary', path: '**' }] });
  return { cwd: dir, milestone: M, host_runtime: hostRuntime, owner_token: TOKEN, batch_id: ids.batch_id, manifest_sha256: ids.manifest_sha256, run_id: runId };
}
// The host's own fields of each member attempt (the U3b sidecar request shape): its own dispatch,
// its own external result channel, the operator constraints. Nothing else is the host's.
function hostInputs(label, names) {
  return Object.fromEntries(names.map((id, index) => [id, { dispatchId: `u4-${label}-dispatch-${index}`, workflowId: `u4-${label}-workflow`,
    resultFile: path.join(CHANNELS, `${label}-${id}.json`), prompt: 'Synthetic cohort member fixture only.',
    verification: { preferenceCommands: [`node --check src/${id.toLowerCase()}.js`] },
    gates: { plan: 'approved', claim: 'proceed', security: 'not-applicable' }, constraints: { auto_commit: true, deploy: false } }]));
}
// One real cohort per case: its own owner, dispatch, run, rendezvous folder, provider plan and
// transport journal.
function fixture(label, names, providers, options = {}) {
  const dir = owner(label, options), ids = cohort(dir, names, options.tasks, options.hostRuntime), scope = scopeOf(dir, ids, label, names, options.hostRuntime);
  const rendezvous = fs.mkdtempSync(path.join(TMP, `${label}-rendezvous-`));
  const plan = path.join(TMP, `${label}-providers.json`), journalFile = path.join(TMP, `${label}-transport.jsonl`);
  fs.writeFileSync(plan, JSON.stringify({ rendezvous, members: providers }));
  fs.writeFileSync(journalFile, '');
  const inputs=hostInputs(label,names);
  if(typeof options.verification==='function')for(const id of names)inputs[id].verification=options.verification(id);
  return { label, names, dir, ids, scope, rendezvous, plan, journal: journalFile, inputs, controls: new Map(), running: null };
}
// The in-process pool of a fixture, with the trusted seams of this case.
function start(fx, options = {}) {
  Object.assign(CONFIG, { plan: fx.plan, journal: fx.journal, onSpawn: options.onSpawn || null });
  fx.running = settle(batch.runCohort(fx.scope, { members: fx.inputs, stream: SINK,
    onMemberControl: control => fx.controls.set(control.task_id, control),
    ...(options.prefsReader ? { prefsReader: options.prefsReader } : {}) }));
  return fx.running;
}
// Releases and stops every synthetic provider of a fixture, awaits its pool and removes only the
// exact canonical external mutex directory of its owner.
async function finish(fx) {
  if (!fx) return;
  for (const name of fx.names) {
    try { fs.writeFileSync(mark(fx, name, 'release'), ''); } catch (_) { /* fixture release */ }
  }
  if (fx.running) {
    try { await within(fx.running, 120000, `${fx.label} pool`); } catch (error) { console.log(`      ${fx.label} pool: ${error && error.message}`); }
  }
  for (const name of fx.names) {
    try { const entered = readJson(mark(fx, name, 'entered')); if (alive(entered.pid)) process.kill(entered.pid); } catch (_) { /* already gone */ }
  }
  try { removeLockRoot(ownerLockRoot(fx.dir)); } catch (error) { console.log(`      lock cleanup: ${error && error.message}`); }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const settle = promise => promise.then(value => ({ value }), error => ({ error }));
function within(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms); })])
    .finally(() => clearTimeout(timer));
}
async function waitFor(check, ms, label) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await sleep(20);
  }
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function journal(file) { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); }
function mark(fx, name, kind) { return path.join(fx.rendezvous, `${name}.${kind}`); }
function release(fx, names) { for (const name of names) fs.writeFileSync(mark(fx, name, 'release'), ''); }
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return !!error && error.code === 'EPERM'; }
}
function prefs(maxConcurrent) { return () => ({ ok: true, prefs: { parallelism: { max_concurrent: maxConcurrent } } }); }
function ownerLockRoot(dir) {
  return path.join(os.tmpdir(), `forge-artifact-owner-${rootsApi.digest(rootsApi.key(fs.realpathSync.native(dir)))}`);
}
// Removes only the exact canonical external mutex directory of one fixture owner.
function removeLockRoot(lockRoot) {
  if (typeof lockRoot !== 'string' || !fs.existsSync(lockRoot)) return;
  assert(!fs.lstatSync(lockRoot).isSymbolicLink());
  assert.strictEqual(rootsApi.key(path.dirname(fs.realpathSync.native(lockRoot))), rootsApi.key(fs.realpathSync.native(os.tmpdir())));
  assert(path.basename(lockRoot).startsWith('forge-artifact-owner-'));
  fs.rmSync(lockRoot, { recursive: true, force: true });
}
async function rejectsCode(promise, code, label) {
  await assert.rejects(promise, error => {
    assert.strictEqual(error && error.code, code, `${label}: ${error && error.stack ? error.stack : error}`);
    return true;
  }, label);
}
function assertNoKey(label, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'), textValue = bytes.toString('utf8');
  for (const marker of KEY_MARKERS) assert(!textValue.includes(marker), `${label} carries private key material (${marker})`);
  assert(!bytes.includes(KEY_DER), `${label} carries a DER private key`);
}
// Each member's own physical worktree root, from the cohort's published isolation record.
function memberRoots(fx) {
  const record = readJson(path.join(fx.dir, '.gsd', 'forge', 'batches', fx.ids.batch_id, 'isolation.json'));
  return new Map(record.members.map(member => [member.task_id, rootsApi.key(fs.realpathSync.native(member.roots[0].path))]));
}
// The real batch CLI as its own process (the preload installs this fixture's transport entry).
function runCli(args, ms) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: path.join(__dirname, '..'), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timeout: the batch CLI\n${stderr.slice(-4000)}`)); }, ms);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, pid: child.pid }); });
  });
}

// U4-3: exactly this member's resolved route reached its transport and its provider, inside its
// own member worktree, with the adapter's sanitized environment.
function assertBinding(fx) {
  const manifest = batch.readManifest(fx.dir, fx.ids.batch_id), roots = memberRoots(fx);
  const spawned = journal(fx.journal).filter(row => row.event === 'spawned');
  assert.deepStrictEqual(spawned.map(row => row.task).sort(), manifest.members.map(member => member.task_id).sort(), `${fx.label}: one provider per member`);
  const integration = rootsApi.key(fs.realpathSync.native(fx.dir)), seen = new Set();
  for (const member of manifest.members) {
    const row = spawned.find(entry => entry.task === member.task_id), route = member.route, label = `${fx.label} ${member.task_id}`;
    const model = route.resolved_worker_engine === 'codex' ? route.sidecar_model || route.model : route.model;
    assert.deepStrictEqual([row.engine, row.host, row.model, row.effort], [route.resolved_worker_engine, manifest.host_runtime, model, route.effort],
      `${label}: the transport receives exactly this member's route, model and effort`);
    const canonical = resolveDispatch({ ...route.resolution_options });
    assert.deepStrictEqual([canonical.worker_mode, canonical.resolved_worker_engine, canonical.model_resolved || canonical.model, canonical.effort],
      ['sidecar', route.resolved_worker_engine, route.model, route.effort], `${label}: the canonical resolver still resolves this member's own route`);
    assert.deepStrictEqual(row.constraints, fx.inputs[member.task_id].constraints, `${label}: the operator constraints are preserved`);
    assert.strictEqual(row.signal, true, `${label}: the transport receives the member's own AbortSignal`);
    const root = rootsApi.key(fs.realpathSync.native(row.cwd));
    assert.strictEqual(root, roots.get(member.task_id), `${label}: it runs in its own member worktree`);
    assert(root !== integration && !seen.has(root), `${label}: never the integration root nor a sibling's worktree`);
    seen.add(root);
    const entered = readJson(mark(fx, member.task_id, 'entered'));
    assert.strictEqual(entered.pid, row.pid, `${label}: the provider process is the spawned one`);
    assert.strictEqual(rootsApi.key(fs.realpathSync.native(entered.cwd)), root, `${label}: the provider's real cwd`);
    assert.deepStrictEqual([entered.model, entered.effort], [model, route.effort], `${label}: the provider's own model and effort`);
    const env = entered.env, envText = JSON.stringify(env);
    for (const [name, value] of Object.entries(SECRETS)) {
      assert(!Object.keys(env).some(key => key.toUpperCase() === name), `${label}: ${name} never reaches a provider`);
      assert(!envText.includes(value), `${label}: a synthetic secret value never reaches a provider`);
    }
    assert(!envText.includes(TOKEN), `${label}: the owner token never reaches a provider`);
    assert.strictEqual(env[VISIBLE.name], VISIBLE.value, `${label}: the provider environment is the adapter's filtered one, not empty`);
    assertNoKey(`${label} provider environment`, envText);
  }
}

// ── U4-1: the real batch CLI, two providers inside distinct worktrees together ─

test('issue343 U4-1 through the real batch CLI two synthetic providers are inside distinct member worktrees before either finishes', async () => {
  assert(os.cpus().length >= 2, 'the forced-normal resource budget needs two CPUs for a cohort of two');
  const fx = fixture('cli', PAIR, { T01: { peers: ['T02'], hold: false, timeout_ms: 90000 }, T02: { peers: ['T01'], hold: false, timeout_ms: 90000 } });
  try {
    const requestFile = write(path.join(TMP, 'requests', 'cli-run.json'), JSON.stringify({ schema: batch.RUN_REQUEST_SCHEMA, cwd: fx.dir, milestone: M,
      host_runtime: 'codex', owner_token: TOKEN, run_id: fx.scope.run_id, manifest_sha256: fx.ids.manifest_sha256, members: fx.inputs }));
    const config = write(path.join(TMP, 'cli-transport.json'), JSON.stringify({ xllm: XLLM, batch: CLI, provider: PROVIDER, transport: TRANSPORT,
      plan: fx.plan, journal: fx.journal }));
    const preload = write(path.join(TMP, 'cli-preload.js'), preloadSource(config));
    const cli = await runCli(['-r', preload, CLI, 'run', '--batch', fx.ids.batch_id, '--request', requestFile], 300000);
    assert.strictEqual(cli.code, 0, `the batch CLI run (stderr tail):\n${cli.stderr.slice(-4000)}`);
    const report = JSON.parse(cli.stdout.trim().split('\n').pop());
    assert.deepStrictEqual([report.schema, report.batch_id, report.manifest_sha256, report.status, report.reason_code],
      [batch.RUN_SCHEMA, fx.ids.batch_id, fx.ids.manifest_sha256, 'retained', null]);
    assert.deepStrictEqual(report.members.map(row => [row.task_id, row.outcome, row.reason_code, row.provider_called, row.stage]),
      [['T01', 'retained', null, true, 'executed'], ['T02', 'retained', null, true, 'executed']]);
    assert.deepStrictEqual([report.pool.max_concurrent, report.pool.peak_in_flight, report.barrier.sealed], [2, 2, true]);
    // The rendezvous: neither provider could finish before its sibling entered its own worktree.
    const entered = PAIR.map(name => readJson(mark(fx, name, 'entered')));
    const seen = PAIR.map(name => readJson(mark(fx, name, 'peers-seen')));
    const finished = PAIR.map(name => readJson(mark(fx, name, 'finished')));
    assert(Math.max(...entered.map(row => row.at)) <= Math.min(...finished.map(row => row.at)), 'both providers entered before either finished');
    assert(seen.every((row, index) => row.pid === entered[index].pid && row.at <= finished[index].at), 'each provider saw its sibling while alive');
    assert.notStrictEqual(entered[0].pid, entered[1].pid);
    assert(entered.every(row => row.pid !== cli.pid), 'each provider is its own process, never the coordinator');
    const roots = memberRoots(fx), cwds = entered.map(row => rootsApi.key(fs.realpathSync.native(row.cwd)));
    assert.deepStrictEqual(cwds, PAIR.map(name => roots.get(name)), 'each provider runs inside its own member worktree');
    assert.notStrictEqual(cwds[0], cwds[1]);
    assert(!cwds.includes(rootsApi.key(fs.realpathSync.native(fx.dir))), 'no provider runs in the integration root');
    // U4-3 on the CLI path: route, model, effort, cwd and sanitized environment of each provider.
    assertBinding(fx);
    // The evidence the report names: one sealed barrier over both retained members; the owner holds
    // nothing beyond S0 and the signed member lines.
    const evidence = reconciliation.readBatchEvidence({ directory: report.broker.directory, manifest_sha256: report.broker.manifest_sha256 });
    assert.deepStrictEqual([evidence.stream, evidence.barrier.sealed, evidence.barrier.sha256, evidence.surface.matches_s0],
      ['verified', true, report.barrier.sha256, true]);
    assert.deepStrictEqual(evidence.members.map(row => row.outcome), ['retained', 'retained']);
    assert.deepStrictEqual(evidence.members.map(row => row.anchor && row.anchor.sha256), report.members.map(row => row.anchor_sha256));
    // Neither the report nor the CLI's own output carries the owner token, a secret or a key.
    for (const value of [TOKEN, ...Object.values(SECRETS)]) {
      assert(!cli.stdout.includes(value) && !cli.stderr.includes(value), 'the CLI output never carries the owner token or a secret');
    }
    assertNoKey('the CLI report', cli.stdout);
  } finally { await finish(fx); }
});

test('issue343 U4-1 a serial pool cannot pass the rendezvous: with limit one the first provider never sees its sibling and fails', async () => {
  const fx = fixture('serial', PAIR, { T01: { peers: ['T02'], hold: false, timeout_ms: 2500 }, T02: { peers: ['T01'], hold: false, timeout_ms: 90000 } });
  try {
    const outcome = await within(start(fx, { prefsReader: prefs(1) }), 300000, 'the serial pool');
    assert(!outcome.error, outcome.error && outcome.error.stack);
    const report = outcome.value;
    assert.deepStrictEqual([report.pool.max_concurrent, report.pool.resolved_max_concurrent, report.pool.peak_in_flight], [1, 1, 1]);
    assert.deepStrictEqual(report.members.map(row => [row.task_id, row.outcome, row.reason_code]),
      [['T01', 'failed', 'synthetic-provider-failed'], ['T02', 'retained', null]]);
    assert(fs.existsSync(mark(fx, 'T01', 'entered')) && !fs.existsSync(mark(fx, 'T01', 'peers-seen')), 'alone, the first provider never saw its sibling');
    const rows = journal(fx.journal);
    const firstExit = rows.find(row => row.event === 'exited' && row.task === 'T01');
    const secondSpawn = rows.find(row => row.event === 'spawned' && row.task === 'T02');
    assert(firstExit && secondSpawn && firstExit.at <= secondSpawn.at, 'serially, the second provider starts only after the first exited');
    assert.notStrictEqual(firstExit.code, 0);
    // The failed member never cancelled its healthy successor, and the barrier joined both writers.
    assert.deepStrictEqual([report.status, report.barrier.sealed], ['partial', true]);
  } finally { await finish(fx); }
});

// ── U4-2 and U4-3: limit two over three members ──────────────────────────────

test('issue343 U4-2 three members with limit two never run three providers at once', async () => {
  assert(os.cpus().length >= 3, 'the forced-normal resource budget needs three CPUs for a decided cohort of three');
  const hold = { peers: [], hold: true, timeout_ms: 90000 };
  const fx = fixture('limit', TRIO, { T01: hold, T02: hold, T03: hold });
  // Explicit false remains supported beside the default-true rendezvous/CLI cases.
  for (const input of Object.values(fx.inputs)) input.constraints.auto_commit = false;
  const live = { now: 0, peak: 0, order: [], signals: new Map() };
  try {
    const manifest = batch.readManifest(fx.dir, fx.ids.batch_id);
    assert.deepStrictEqual([manifest.members.length, manifest.limits.max_concurrent], [3, 3], 'the decision admitted three members under its own limit');
    const running = start(fx, { prefsReader: prefs(2), onSpawn: ({ task, child, options }) => {
      live.now += 1;
      live.peak = Math.max(live.peak, live.now);
      live.order.push(task);
      live.signals.set(task, options.signal);
      child.once('exit', () => { live.now -= 1; });
    } });
    await waitFor(() => ['T01', 'T02'].every(name => fs.existsSync(mark(fx, name, 'entered'))), 180000, 'the first two providers entered');
    await sleep(1500);
    assert(!fs.existsSync(mark(fx, 'T03', 'entered')), 'the third member waits for a free slot');
    assert.deepStrictEqual([[...live.order].sort(), live.now], [['T01', 'T02'], 2], 'exactly the first two providers are alive');
    assert.strictEqual(fx.controls.size, 3, 'every member has its own control');
    release(fx, ['T01']);
    await waitFor(() => fs.existsSync(mark(fx, 'T03', 'entered')), 180000, 'the third provider entered once a slot freed');
    const rows = journal(fx.journal);
    const firstExit = rows.find(row => row.event === 'exited' && row.task === 'T01');
    const thirdSpawn = rows.find(row => row.event === 'spawned' && row.task === 'T03');
    assert(firstExit && thirdSpawn && firstExit.at <= thirdSpawn.at, 'the third provider started only after one of the first two exited');
    assert(!rows.some(row => row.event === 'exited' && row.task === 'T02'), 'the second provider still runs beside the third');
    assert(live.now <= 2);
    release(fx, ['T02', 'T03']);
    const outcome = await within(running, 300000, 'the limited pool');
    assert(!outcome.error, outcome.error && outcome.error.stack);
    const report = outcome.value;
    assert.deepStrictEqual([report.pool.max_concurrent, report.pool.manifest_max_concurrent, report.pool.resolved_max_concurrent, report.pool.peak_in_flight],
      [2, 3, 2, 2]);
    assert.deepStrictEqual(report.members.map(row => [row.task_id, row.outcome]), TRIO.map(id => [id, 'retained']));
    assert.deepStrictEqual([report.status, report.barrier.sealed], ['retained', true]);
    assert.deepStrictEqual([live.peak, live.now, [...live.order.slice(0, 2)].sort(), live.order[2]], [2, 0, ['T01', 'T02'], 'T03'],
      'never three providers at once; the third started only from a freed slot');
    // U4-3 for the three in-process members: each its own route, model, effort, cwd, env and signal.
    assertBinding(fx);
    const signals = [...live.signals.values()];
    assert.strictEqual(new Set(signals).size, 3, 'each member has its own AbortSignal');
    assert(signals.every(signal => signal.aborted === false), 'no member was cancelled');
    const evidence = reconciliation.readBatchEvidence({ directory: report.broker.directory, manifest_sha256: report.broker.manifest_sha256 });
    assert.deepStrictEqual([evidence.barrier.sealed, evidence.surface.matches_s0], [true, true]);
    assert.deepStrictEqual(evidence.members.map(row => row.outcome), ['retained', 'retained', 'retained']);
  } finally { await finish(fx); }
});

// ── U4-4: one member's cancellation, imported authority and malformed input ───

test('issue343 U4-4 aborting one member stops only its own process scope', async () => {
  const fx = fixture('abort', PAIR, { T01: { peers: ['T02'], hold: true, timeout_ms: 90000 }, T02: { peers: ['T01'], hold: true, timeout_ms: 90000 } });
  const emitted = [], realEmit = process.emit;
  try {
    // Imported authority never starts anything: an approved flag, an imported route, a missing
    // member, malformed constraints and a foreign owner token refuse before any effect.
    const isolationFile = path.join(fx.dir, '.gsd', 'forge', 'batches', fx.ids.batch_id, 'isolation.json');
    const refused = [
      [{ ...fx.inputs, T01: { ...fx.inputs.T01, approved: true } }, 'batch-member-input-invalid', 'an approved flag'],
      [{ ...fx.inputs, T02: { ...fx.inputs.T02, route: { model: 'imported-model' } } }, 'batch-member-input-invalid', 'an imported route'],
      [{ T01: fx.inputs.T01 }, 'batch-member-input-invalid', 'a missing member'],
      [{ ...fx.inputs, T02: { ...fx.inputs.T02, resultFile: fx.inputs.T01.resultFile } }, 'batch-member-input-invalid', 'a shared channel'],
      [{ ...fx.inputs, T01: { ...fx.inputs.T01, constraints: { auto_commit: 'true', deploy: false } } }, 'batch-member-constraints-unsupported', 'a nonboolean auto_commit'],
      [{ ...fx.inputs, T01: { ...fx.inputs.T01, constraints: { auto_commit: true, deploy: true } } }, 'batch-member-constraints-unsupported', 'an unsupported deployment'],
    ];
    for (const [members, code, label] of refused) await rejectsCode(batch.runCohort(fx.scope, { members, stream: SINK }), code, label);
    await rejectsCode(batch.runCohort({ ...fx.scope, owner_token: 'foreign-owner-token' }, { members: fx.inputs, stream: SINK }), 'batch-manifest-foreign', 'a foreign owner token');
    assert.strictEqual(fs.readFileSync(fx.journal, 'utf8'), '', 'no refused run reached a transport');
    assert(!fs.existsSync(isolationFile), 'no refused run prepared any isolation');
    // The coordinator never emits a process signal to cancel a member.
    process.emit = function recordingEmit(name, ...args) {
      if (name === 'SIGINT' || name === 'SIGTERM') emitted.push(name);
      return realEmit.call(this, name, ...args);
    };
    const signals = new Map();
    const running = start(fx, { onSpawn: ({ task, options }) => signals.set(task, options.signal) });
    await waitFor(() => PAIR.every(name => fs.existsSync(mark(fx, name, 'peers-seen'))), 180000, 'both providers are inside their worktrees together');
    const [first, second] = PAIR.map(name => readJson(mark(fx, name, 'entered')).pid);
    assert(alive(first) && alive(second), 'both providers are alive together');
    assert.strictEqual(fx.controls.get('T01').abort('fixture-abort'), true);
    await waitFor(() => !alive(first), 60000, 'the aborted provider is gone');
    await sleep(750);
    assert(alive(second), 'the sibling provider still runs');
    assert(!fs.existsSync(mark(fx, 'T02', 'finished')), 'the sibling provider was not finished by the abort');
    assert.deepStrictEqual([signals.get('T01').aborted, signals.get('T02').aborted], [true, false], 'only the aborted member signal fired');
    release(fx, ['T02']);
    const outcome = await within(running, 300000, 'the pool after one abort');
    assert(!outcome.error, outcome.error && outcome.error.stack);
    const report = outcome.value, [a, b] = report.members;
    assert.deepStrictEqual([a.task_id, a.outcome, a.reason_code, a.cause_code, a.aborted], ['T01', 'failed', 'batch-member-aborted', 'synthetic-provider-cancelled', true]);
    assert.deepStrictEqual([b.task_id, b.outcome, b.reason_code, b.aborted], ['T02', 'retained', null, false]);
    assert(fs.existsSync(mark(fx, 'T02', 'finished')), 'the healthy sibling finished its own work');
    assert.deepStrictEqual([report.status, report.barrier.sealed], ['partial', true]);
    const evidence = reconciliation.readBatchEvidence({ directory: report.broker.directory, manifest_sha256: report.broker.manifest_sha256 });
    assert.deepStrictEqual(evidence.members.map(row => row.outcome), ['interrupted', 'retained']);
    assert.strictEqual(evidence.surface.matches_s0, true, 'the aborted member left only signed lines in the owner');
    const roots = memberRoots(fx);
    for (const name of PAIR) assert(fs.existsSync(roots.get(name)), `${name}'s worktree is retained`);
    assert.deepStrictEqual(emitted, [], 'no process signal was emitted to cancel a member');
    assert.strictEqual(fx.controls.get('T02').abort('late'), false, 'a settled member cannot be aborted');
  } finally {
    process.emit = realEmit;
    await finish(fx);
  }
});

test('issue343 U4-4 the batch CLI refuses malformed, unapproved or foreign input before any effect and never echoes the owner token', async () => {
  const requestFile = write(path.join(TMP, 'requests', 'refused.json'), JSON.stringify({ schema: batch.RUN_REQUEST_SCHEMA, cwd: TMP, milestone: M,
    host_runtime: 'codex', owner_token: TOKEN, run_id: 'M-20261108000001-refused', manifest_sha256: '0'.repeat(64), members: {}, approved: true }));
  const unknown = write(path.join(TMP, 'requests', 'unknown-batch.json'), JSON.stringify({ schema: batch.RUN_REQUEST_SCHEMA, cwd: TMP, milestone: M,
    host_runtime: 'codex', owner_token: TOKEN, run_id: 'M-20261108000001-refused', manifest_sha256: '0'.repeat(64), members: {} }));
  for (const [args, code] of [
    [[CLI], 'batch-run-request-invalid'],
    [[CLI, 'run', '--batch', 'not-a-batch', '--request', requestFile], 'batch-not-active'],
    [[CLI, 'run', '--batch', `batch-${'0'.repeat(32)}`, '--request', requestFile], 'batch-run-request-invalid'],
    [[CLI, 'run', '--batch', `batch-${'0'.repeat(32)}`, '--request', 'relative-request.json'], 'batch-run-request-invalid'],
    [[CLI, 'run', '--batch', `batch-${'0'.repeat(32)}`, '--request', unknown, '--request', unknown], 'batch-run-request-invalid'],
    [[CLI, 'run', '--batch', `batch-${'0'.repeat(32)}`, '--request', unknown], 'batch-manifest-invalid'],
  ]) {
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env } });
    const label = args.slice(1).join(' ') || '(no arguments)';
    assert.strictEqual(result.status, 1, `${label}: ${result.stderr}`);
    assert.strictEqual(result.stdout, '', `${label}: a refusal prints no report`);
    assert.strictEqual(result.stderr.trim().split('\n').pop(), `forge-execution-batch: ${code}`, label);
    assert(!result.stderr.includes(TOKEN), `${label}: the owner token is never echoed`);
  }
});

// ── U5: the serial post-barrier consolidation over real retained cohorts ─────

const GO = Object.freeze({ peers: [], hold: false, timeout_ms: 90000 });
const PAIR_GO = Object.freeze({ T01: GO, T02: GO });
const ACKED = Object.freeze(['preparado', 'admitido', 'executando', 'retido', 'publicacao-pendente', 'publicado', 'integrado', 'ack']);
const RESTART_POINTS = Object.freeze(['consolidation-progress-intent', 'consolidation-progress-applied', 'consolidation-member-verified',
  'member-artifacts-intent', 'member-artifacts-applied', 'member-artifacts-committed', 'member-integrated',
  'controller-terminal-intent', 'controller-terminal-applied', 'member-acknowledged',
  'claim-mutation-intent', 'claim-mutation-applied', 'claim-mutation-before-commit',
  'post-unit-intent', 'post-unit-applied', 'post-unit-before-commit']);
// Cohorts consolidated by one case and inspected by a later one (U5-6), released at the end.
const u5 = {};
function taskDir(dir, id) { return path.join(sliceDir(dir), 'tasks', id); }
function published(dir, id) { return fs.existsSync(path.join(taskDir(dir, id), `${id}-SUMMARY.md`)); }
// Each member's own physical worktree root (real path), from the published isolation record.
function memberPaths(fx) {
  const record = readJson(path.join(fx.dir, '.gsd', 'forge', 'batches', fx.ids.batch_id, 'isolation.json'));
  return new Map(record.members.map(member => [member.task_id, member.roots[0].path]));
}
// The complete progress chain of one member, in order.
function chainStates(fx, index) {
  const dir = path.join(fx.dir, '.gsd', 'forge', 'batches', fx.ids.batch_id, 'progress', `m${index}`);
  return fs.readdirSync(dir).sort().map(name => readJson(path.join(dir, name)).state);
}
// The controller's own completions of batch member begins, and their published events.
function completions(dir) {
  const directory = controller.transactionDir(dir);
  return fs.readdirSync(directory).filter(name => name.endsWith('.json')).map(name => controller.readJson(path.join(directory, name)))
    .filter(record => record && record.action === 'complete' && String(record.idempotency_key).startsWith('forge-execution-batch:'))
    .sort((left, right) => left.unit.key.localeCompare(right.unit.key));
}
function completeEvents(dir) {
  return controller.readEvents(controller.eventsFile(dir, M)).filter(event => event.event === 'unit-transition' && event.action === 'complete'
    && String(event.idempotency_key).startsWith('forge-execution-batch:'));
}
function spawnedCount(fx) { return journal(fx.journal).filter(row => row.event === 'spawned').length; }
// The integration target's Git state: HEAD, the history length and the logical index.
function targetState(dir) {
  return { head: git(dir, ['rev-parse', 'HEAD']).trim(), commits: git(dir, ['rev-list', '--count', 'HEAD']).trim(), stage: git(dir, ['ls-files', '-s']) };
}
function targetMatchesMembers(fx, ids) {
  const paths = memberPaths(fx);
  for (const id of ids) {
    const rel = `src/${id.toLowerCase()}.js`;
    assert(fs.readFileSync(at(fx.dir, rel)).equals(fs.readFileSync(at(paths.get(id), rel))), `${id}: the target holds exactly the member's verified bytes`);
  }
}
// A real cohort run to its sealed barrier (every provider of `providers` behaves as declared).
async function retainedCohort(label, names, providers, options = {}) {
  const fx = fixture(label, names, providers, options);
  try {
    const outcome = await within(start(fx, options), 300000, `${label} pool`);
    assert(!outcome.error, outcome.error && outcome.error.stack);
    fx.report = outcome.value;
    assert.strictEqual(fx.report.barrier.sealed, true, `${label}: the barrier is sealed`);
    fx.trust = { directory: fx.report.broker.directory, manifest_sha256: fx.report.broker.manifest_sha256 };
    return fx;
  } catch (error) { await finish(fx); throw error; }
}
function consolidate(fx, extra = {}) {
  return settle(batch.consolidateCohort(fx.scope, { members: fx.inputs, broker_manifest_sha256: fx.report.broker.manifest_sha256, ...extra }));
}
async function consolidated(fx, label, extra) {
  const outcome = await within(consolidate(fx, extra), 300000, label);
  assert(!outcome.error, `${label}: ${outcome.error && outcome.error.stack}`);
  return outcome.value;
}
// A simulated crash at one named consolidation failpoint (the coordinator's process dies there).
function crashAt(point) {
  return name => { if (name === point) throw Object.assign(new Error(`fixture crash at ${point}`), { code: 'FIXTURE_CRASH' }); };
}
// The real batch CLI `consolidate` in a fresh process; its preload journals any provider it would start.
function freshConsolidate(fx) {
  const requestFile = write(path.join(TMP, 'requests', `${fx.label}-consolidate.json`), JSON.stringify({ schema: batch.CONSOLIDATE_REQUEST_SCHEMA,
    cwd: fx.dir, milestone: M, host_runtime: 'codex', owner_token: TOKEN, run_id: fx.scope.run_id, manifest_sha256: fx.ids.manifest_sha256,
    broker_manifest_sha256: fx.report.broker.manifest_sha256, members: fx.inputs }));
  const config = write(path.join(TMP, `${fx.label}-consolidate-transport.json`), JSON.stringify({ xllm: XLLM, batch: CLI, provider: PROVIDER,
    transport: TRANSPORT, plan: fx.plan, journal: fx.journal }));
  const preload = write(path.join(TMP, `${fx.label}-consolidate-preload.js`), preloadSource(config));
  return runCli(['-r', preload, CLI, 'consolidate', '--batch', fx.ids.batch_id, '--request', requestFile], 300000);
}
function ackInput(fx) { return { cwd: fx.dir, milestone: M, owner_token: TOKEN, session: SESSION }; }
// One byte changed right after `needle` ('A' <-> 'B' keeps JSON text and base64 valid).
function flipAfter(bytes, needle) {
  const position = bytes.indexOf(needle);
  assert(position >= 0, `fixture needle ${needle}`);
  const changed = Buffer.from(bytes), index = position + Buffer.byteLength(needle);
  changed[index] = changed[index] === 0x41 ? 0x42 : 0x41;
  return changed;
}
// The consolidation refuses with `code` while `file` holds `bytes`; the original bytes are restored.
async function refused(fx, file, bytes, code, label) {
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, bytes);
  let outcome;
  try { outcome = await within(consolidate(fx), 300000, label); } finally { fs.writeFileSync(file, original); }
  assert(outcome.error, `${label}: the consolidation refused`);
  assert.strictEqual(outcome.error.code, code, `${label}: ${outcome.error.stack}`);
}

// ── U5-1: barrier, then serial verify, publish, integrate and ACK ────────────

test('issue343 U5-1 after the barrier each member is verified, published, integrated and acknowledged serially in manifest order, with the integrated delivery rechecked', async () => {
  const fx = await retainedCohort('u5-serial', PAIR, PAIR_GO);
  try {
    const before = targetState(fx.dir), spawned = spawnedCount(fx);
    const rootManifest = fs.readFileSync(path.join(fx.trust.directory, 'manifest.json'));
    for (const id of PAIR) {
      assert(!published(fx.dir, id), `${id} is retained, never published before the consolidation`);
      assert(!fs.existsSync(at(fx.dir, `src/${id.toLowerCase()}.js`)), `${id} is not integrated before the consolidation`);
    }
    const report = await consolidated(fx, 'the serial consolidation');
    assert.deepStrictEqual([report.schema, report.status, report.reason_code, report.conflict], [batch.CONSOLIDATION_SCHEMA, 'consolidated', null, null]);
    assert.deepStrictEqual(report.members.map(row => [row.task_id, row.barrier_outcome, row.outcome, row.progress_state, row.recheck]),
      [['T01', 'retained', 'acknowledged', 'ack', 'verified'], ['T02', 'retained', 'acknowledged', 'ack', 'verified']]);
    assert(report.members.every(row => /^[a-f0-9]{64}$/.test(row.ready_sha256)), 'each member was verified by the real completion core');
    assert.deepStrictEqual(report.members.map(row => row.integration), [{ applied: ['primary::src/t01.js'], already: [] }, { applied: ['primary::src/t02.js'], already: [] }]);
    // Manifest order, one member at a time: T01 is published and acknowledged before T02 is published.
    const evidence = reconciliation.readBatchEvidence(fx.trust), refs = evidence.members.map(row => row.member_ref);
    assert.deepStrictEqual(evidence.operations.entries.filter(entry => entry.species !== 'batch-progress')
      .map(entry => [entry.species, refs.indexOf(entry.member_ref), entry.committed]),
    [['member-artifacts', 0, true], ['controller-terminal', 0, true], ['member-artifacts', 1, true], ['controller-terminal', 1, true], ['claim-mutation', -1, true],
      ['post-unit',0,true],['post-unit',1,true],['post-unit',-1,true]]);
    assert.deepStrictEqual([evidence.stream, evidence.barrier.sealed, evidence.operations.pending, evidence.surface.matches_s0, evidence.surface.matches_operations],
      ['verified', true, null, false, true], 'the owner is S0, the signed member lines and exactly the committed operations');
    assert.deepStrictEqual(evidence.generations.map(row => row.generation), [1, 2], 'one successor generation signed every operation');
    assert(fs.readFileSync(path.join(fx.trust.directory, 'manifest.json')).equals(rootManifest), 'S0 and the root manifest are never refreshed');
    // Published through the canonical publisher: SUMMARY, DELIVERY and both slice markers, the second rebased on the first.
    for (const id of PAIR) assert(published(fx.dir, id), `${id} is published`);
    const slicePlan = fs.readFileSync(path.join(sliceDir(fx.dir), `${S}-PLAN.md`), 'utf8');
    assert(/- \[x\] \*\*T01\*\*/.test(slicePlan) && /- \[x\] \*\*T02\*\*/.test(slicePlan), 'both task markers');
    // Integrated into the run target: exactly the verified bytes; HEAD, history and index untouched.
    targetMatchesMembers(fx, PAIR);
    assert.deepStrictEqual(targetState(fx.dir), before, 'no commit, no index or HEAD change');
    // Acknowledged by the controller's own transaction: one completion per member, its lease released.
    assert.deepStrictEqual(completions(fx.dir).map(row => [row.unit.key, row.phase, row.result.status]),
      [['execute-task/T01', 'committed', 'succeeded'], ['execute-task/T02', 'committed', 'succeeded']]);
    assert.strictEqual(completeEvents(fx.dir).length, 2, 'one completion event per member');
    for (const id of PAIR) assert.strictEqual(lease.observe(fx.dir, `execute-task/${id}`).lease, null, `${id}'s lease is released`);
    assert.deepStrictEqual([chainStates(fx, 0), chainStates(fx, 1)], [ACKED, ACKED]);
    assert.strictEqual(spawnedCount(fx), spawned, 'the consolidation never starts a provider');
    // The loop releases the batch once every member is acknowledged by the owner.
    const acked = adapter.invoke('codex', 'auto', 'batch-ack', ackInput(fx), fx.ids.snapshot, {}).result;
    assert.deepStrictEqual([acked.outcome, acked.reason_code, acked.snapshot.current_batch], ['completed', 'batch-acked', undefined]);
    assert.deepStrictEqual(acked.controller_result.details.acknowledged, ['execute-task/T01', 'execute-task/T02']);
    fx.consolidation = report;
    u5.serial = fx;
  } catch (error) { await finish(fx); throw error; }
});

// ── U5-2: partial failure ─────────────────────────────────────────────────────

test('issue343 U5-2 a done member is acknowledged beside a failed and a needs-input sibling; their residual and the dependents of the failure stay blocked', async () => {
  assert(os.cpus().length >= 3, 'the forced-normal resource budget needs three CPUs for a decided cohort of three');
  const tasks = { T01: taskPlan('T01'), T02: taskPlan('T02'), T03: taskPlan('T03'), T04: taskPlan('T04', ['T02']) };
  const fx = await retainedCohort('u5-partial', TRIO, { T01: GO, T02: { ...GO, mode: 'fail' },
    T03: { ...GO, mode: 'fail', throw_code: 'appserver-input-required' } }, { tasks });
  try {
    assert.deepStrictEqual(fx.report.members.map(row => [row.task_id, row.outcome]), [['T01', 'retained'], ['T02', 'failed'], ['T03', 'needs-input']]);
    const manifest = batch.readManifest(fx.dir, fx.ids.batch_id);
    assert.deepStrictEqual(manifest.excluded, [{ task_id: 'T04', reason_code: 'dependency-unmet' }], 'the dependent of T02 never joined the cohort');
    const residual = new Map(['T02', 'T03'].map(id => [id, fs.readFileSync(`${fx.inputs[id].resultFile}.receipt.json`)]));
    const report = await consolidated(fx, 'the partial consolidation');
    assert.deepStrictEqual([report.status, report.reason_code], ['partial', null]);
    assert.deepStrictEqual(report.members.map(row => [row.task_id, row.barrier_outcome, row.outcome, row.progress_state, row.reason_code]),
      [['T01', 'retained', 'acknowledged', 'ack', null], ['T02', 'failed', 'failed', 'falhou', 'member-failed'],
        ['T03', 'failed', 'needs-input', 'needs-input', 'member-needs-input']]);
    // The done member: captured, published, integrated and acknowledged.
    assert(published(fx.dir, 'T01') && fs.existsSync(at(fx.dir, 'src/t01.js')), 'the done member is published and integrated');
    assert.deepStrictEqual(completions(fx.dir).map(row => row.unit.key), ['execute-task/T01'], 'only the done member is acknowledged');
    // The residual stays explicit: no publication, integration or completion; receipts, leases and worktrees kept.
    const paths = memberPaths(fx);
    for (const id of ['T02', 'T03']) {
      assert(!published(fx.dir, id), `${id} is never published`);
      assert(!fs.existsSync(at(fx.dir, `src/${id.toLowerCase()}.js`)), `${id} is never integrated`);
      assert(fs.readFileSync(`${fx.inputs[id].resultFile}.receipt.json`).equals(residual.get(id)), `${id}: its receipt is preserved byte for byte`);
      assert.notStrictEqual(lease.observe(fx.dir, `execute-task/${id}`).lease, null, `${id} keeps the lease of its own begin`);
      assert(fs.existsSync(paths.get(id)), `${id}'s worktree is retained`);
    }
    assert.deepStrictEqual(batch.readProgress(fx.dir, manifest).map(row => [row.task_id, row.state, row.reason_code]),
      [['T01', 'ack', null], ['T02', 'falhou', null], ['T03', 'needs-input', 'pending-question']]);
    // The dependents of the failure never start: neither T02 nor T03 proves a completion.
    const selection = controller.select(fx.dir, { milestone: M, cohort: true }, {});
    assert(selection.cohort && Array.isArray(selection.cohort.proven), JSON.stringify(selection));
    assert(!selection.cohort.proven.includes('T02') && !selection.cohort.proven.includes('T03'), JSON.stringify(selection.cohort));
    u5.partial = fx;
  } catch (error) { await finish(fx); throw error; }
});

// ── U5-3: fresh-process restart at each failpoint ─────────────────────────────

const RESTART_OBSERVED = new Set();
async function restartWitness(point) {
    assert(batch.CONSOLIDATION_FAILPOINTS.includes(point), point);
    const label = point.startsWith('claim-mutation-') ? `u5c-${digest(point).slice(0, 12)}` : `u5-crash-${point}`;
    const fx = await retainedCohort(label, PAIR, PAIR_GO);
    try {
      const before = targetState(fx.dir), spawned = spawnedCount(fx);
      const rootManifest = fs.readFileSync(path.join(fx.trust.directory, 'manifest.json'));
      const crashed = await within(consolidate(fx, { failpoint: crashAt(point) }), 300000, `${point}: the crashed consolidation`);
      assert.strictEqual(crashed.error && crashed.error.code, 'FIXTURE_CRASH', `${point}: ${crashed.error && crashed.error.stack}`);
      if (point === 'member-acknowledged') {
        // Mid-cohort: the loop releases only the acknowledged member; cleanup retains every root while a sibling is live.
        const pending = adapter.invoke('codex', 'auto', 'batch-ack', ackInput(fx), fx.ids.snapshot, {}).result;
        assert.deepStrictEqual([pending.outcome, pending.reason_code, pending.snapshot.current_batch.members],
          ['blocked', 'batch-members-pending', ['execute-task/T02']], 'only T01 leaves current_batch');
        const plan = batch.cleanupCohort(fx.scope);
        assert.deepStrictEqual(plan.map(member => [member.task_id, member.roots.map(root => [root.decision, root.reason_code])]),
          [['T01', [['retained', 'batch-members-pending']]], ['T02', [['retained', 'batch-members-pending']]]]);
      }
      const cli = await freshConsolidate(fx);
      write(path.join(TMP, 'restart-witnesses', digest(point) + '.json'), JSON.stringify({ point,
        pid: cli.pid, exit_code: cli.code, signal: cli.signal, actual_child_close: true,
        stdout_sha256: digest(cli.stdout), stderr_sha256: digest(cli.stderr) }));
      console.log(`  fresh coordinator ${point}: pid=${cli.pid} exit=${cli.code}`);
      assert.strictEqual(cli.code, 0, `${point}: the fresh consolidation (stderr tail):\n${cli.stderr.slice(-4000)}`);
      const report = JSON.parse(cli.stdout.trim().split('\n').pop());
      assert.deepStrictEqual([report.status, report.members.map(row => row.outcome)], ['consolidated', ['acknowledged', 'acknowledged']], point);
      assert.strictEqual(report.broker.generation, 3, `${point}: the fresh process signs with a new generation, never the dead key`);
      assert.strictEqual(spawnedCount(fx), spawned, `${point}: zero second inference`);
      const evidence = reconciliation.readBatchEvidence(fx.trust), refs = evidence.members.map(row => row.member_ref);
      assert.deepStrictEqual(evidence.operations.entries.filter(entry => entry.species !== 'batch-progress')
        .map(entry => [entry.species, refs.indexOf(entry.member_ref), entry.committed]),
      [['member-artifacts', 0, true], ['controller-terminal', 0, true], ['member-artifacts', 1, true], ['controller-terminal', 1, true], ['claim-mutation', -1, true],
        ['post-unit',0,true],['post-unit',1,true],['post-unit',-1,true]],
      `${point}: exactly one publication and one controller terminal per member`);
      assert.deepStrictEqual([evidence.operations.pending, evidence.surface.matches_operations], [null, true], point);
      assert.deepStrictEqual([chainStates(fx, 0), chainStates(fx, 1)], [ACKED, ACKED], `${point}: no progress step repeated`);
      assert.deepStrictEqual([completions(fx.dir).length, completeEvents(fx.dir).length], [2, 2], `${point}: exactly one ACK per member`);
      assert.deepStrictEqual(targetState(fx.dir), before, `${point}: no commit, index or HEAD change`);
      targetMatchesMembers(fx, PAIR);
      if (point === 'member-integrated') {
        assert.deepStrictEqual(report.members[0].integration, { applied: [], already: ['primary::src/t01.js'] }, 'the interrupted delta is never applied twice');
      }
      assert(fs.readFileSync(path.join(fx.trust.directory, 'manifest.json')).equals(rootManifest), `${point}: S0 is never refreshed`);
      for (const value of [TOKEN, ...Object.values(SECRETS)]) {
        assert(!cli.stdout.includes(value) && !cli.stderr.includes(value), `${point}: the CLI output carries no token or secret`);
      }
      assertNoKey(`${point} consolidation report`, cli.stdout);
    } finally { await finish(fx); }
  RESTART_OBSERVED.add(point);
  console.log('  restart witness ' + point);
}

test('issue343 U5-3 a fresh process restarted at each failpoint resumes with zero second inference, publication, delta, commit or ACK', async () => {
  assert.deepStrictEqual([...RESTART_POINTS].sort(), [...batch.CONSOLIDATION_FAILPOINTS].sort(), 'every declared failpoint has an actual fresh-process restart witness');
  for (const point of RESTART_POINTS) await restartWitness(point);
});

test('review R5 fresh coordinator recovers each new claim intent effect and precommit with no second inference', async () => {
  const points = ['claim-mutation-intent', 'claim-mutation-applied', 'claim-mutation-before-commit'];
  for (const point of points) if (!RESTART_OBSERVED.has(point)) await restartWitness(point);
  assert(points.every(point => RESTART_OBSERVED.has(point)), 'all three have actual fresh-process witnesses');
});



// ── U5-4: one-byte edits ──────────────────────────────────────────────────────

test('issue343 U5-4 one-byte edits of receipts, manifests, proofs, the target and .gsd/events refuse before any publication or ACK', async () => {
  const fx = await retainedCohort('u5-tamper', PAIR, PAIR_GO);
  try {
    const batchManifest = path.join(fx.dir, '.gsd', 'forge', 'batches', fx.ids.batch_id, 'manifest.json');
    const brokerManifest = path.join(fx.trust.directory, 'manifest.json'), proofs = path.join(fx.trust.directory, 'proofs.jsonl');
    const events = at(fx.dir, '.gsd/forge/events.jsonl'), receipt = `${fx.inputs.T01.resultFile}.receipt.json`;
    const nothing = label => {
      for (const id of PAIR) assert(!published(fx.dir, id), `${label}: nothing is published`);
      assert.strictEqual(completions(fx.dir).length, 0, `${label}: nothing is acknowledged`);
      for (const id of PAIR) assert(!fs.existsSync(at(fx.dir, `src/${id.toLowerCase()}.js`)), `${label}: nothing is integrated`);
    };
    await refused(fx, batchManifest, flipAfter(fs.readFileSync(batchManifest), '"kind":"'), 'batch-manifest-invalid', 'the batch manifest');
    nothing('the batch manifest');
    await refused(fx, brokerManifest, flipAfter(fs.readFileSync(brokerManifest), '"nonce":"'), 'reconciliation-trust-anchor-required', 'the broker manifest');
    nothing('the broker manifest');
    await refused(fx, proofs, flipAfter(fs.readFileSync(proofs), '"signature":"'), 'reconciliation-signature-invalid', 'a signed proof');
    nothing('a signed proof');
    await refused(fx, events, Buffer.concat([fs.readFileSync(events), Buffer.from(' ')]), 'reconciliation-unsigned-append', '.gsd/events');
    nothing('.gsd/events');
    await refused(fx, receipt, flipAfter(fs.readFileSync(receipt), 'synthetic deliver'), 'batch-member-retained-changed', 'the executed receipt');
    nothing('the executed receipt');
    // The operation journal: one byte of a signed owner operation.
    const commit = path.join(fx.trust.directory, 'ops', '0001.commit.json');
    await refused(fx, commit, flipAfter(fs.readFileSync(commit), '"signature":"'), 'broker-operations-mismatch', 'a signed owner operation');
    nothing('a signed owner operation');
    // The target: one byte of a base file is a named conflict that integrates (and publishes) nothing.
    const keep = at(fx.dir, 'src/keep.js'), keepBytes = fs.readFileSync(keep);
    fs.writeFileSync(keep, flipAfter(keepBytes, 'module.exports = "'));
    let conflict;
    try { conflict = await consolidated(fx, 'the target'); } finally { fs.writeFileSync(keep, keepBytes); }
    assert.deepStrictEqual([conflict.status, conflict.reason_code, conflict.conflict], ['conflict', 'integration-conflict', { task_id: 'T01', root_id: 'primary', path: 'src/keep.js' }]);
    nothing('the target');
    // After a member's publication: one byte of a published owner artifact refuses the next step.
    const crashed = await within(consolidate(fx, { failpoint: crashAt('member-artifacts-committed') }), 300000, 'the publication crash');
    assert.strictEqual(crashed.error && crashed.error.code, 'FIXTURE_CRASH', crashed.error && crashed.error.stack);
    assert(published(fx.dir, 'T01'), 'T01 was published by its committed operation');
    const summary = path.join(taskDir(fx.dir, 'T01'), 'T01-SUMMARY.md');
    await refused(fx, summary, flipAfter(fs.readFileSync(summary), '# T01 '), 'reconciliation-unproved-drift', 'a published owner artifact');
    assert.strictEqual(completions(fx.dir).length, 0, 'nothing is acknowledged over a changed artifact');
    // Every restored byte verifies again: the consolidation completes, once.
    const report = await consolidated(fx, 'the restored consolidation');
    assert.deepStrictEqual([report.status, report.members.map(row => row.outcome)], ['consolidated', ['acknowledged', 'acknowledged']]);
    assert.deepStrictEqual([completions(fx.dir).length, chainStates(fx, 0), chainStates(fx, 1)], [2, ACKED, ACKED]);
    targetMatchesMembers(fx, PAIR);
  } finally { await finish(fx); }
});

// ── U5-5: a moved target or a Git conflict ────────────────────────────────────

test('issue343 U5-5 a moved target or a Git conflict integrates nothing and preserves the worktrees and the retained results', async () => {
  const moved = await retainedCohort('u5-moved', PAIR, PAIR_GO);
  try {
    const paths = memberPaths(moved), executed = fs.readFileSync(`${moved.inputs.T02.resultFile}.receipt.json`);
    const refs = PAIR.map(id => fs.readFileSync(path.join(path.dirname(moved.trust.directory), 'retained',
      `${reconciliation.readBatchEvidence(moved.trust).members.find(row => row.task_id === id).member_ref}.json`)));
    write(at(moved.dir, 'docs/moved.txt'), 'the integration branch moved\n');
    git(moved.dir, ['add', '--', 'docs/moved.txt']);
    git(moved.dir, [...COMMIT, 'moved']);
    const report = await consolidated(moved, 'the moved target');
    assert.deepStrictEqual([report.status, report.reason_code, report.conflict.task_id], ['conflict', 'integration-target-moved', 'T01']);
    assert.deepStrictEqual(report.members.map(row => [row.task_id, row.outcome, row.progress_state, row.reason_code]),
      [['T01', 'pending', 'retido', 'integration-target-moved'], ['T02', 'pending', 'retido', 'consolidation-stopped']]);
    for (const id of PAIR) {
      assert(!published(moved.dir, id), `${id}: nothing is published over a moved target`);
      assert(!fs.existsSync(at(moved.dir, `src/${id.toLowerCase()}.js`)), `${id}: nothing is integrated`);
      assert(fs.existsSync(at(paths.get(id), `src/${id.toLowerCase()}.js`)), `${id}'s worktree keeps its result`);
    }
    assert.strictEqual(completions(moved.dir).length, 0, 'nothing is acknowledged');
    assert(fs.readFileSync(`${moved.inputs.T02.resultFile}.receipt.json`).equals(executed), 'the unverified sibling keeps its executed record');
    PAIR.forEach((id, index) => {
      const file = path.join(path.dirname(moved.trust.directory), 'retained',
        `${reconciliation.readBatchEvidence(moved.trust).members.find(row => row.task_id === id).member_ref}.json`);
      assert(fs.readFileSync(file).equals(refs[index]), `${id}: its RetainedRef is unchanged`);
    });
  } finally { await finish(moved); }
  const conflict = await retainedCohort('u5-conflict', PAIR, PAIR_GO);
  try {
    write(at(conflict.dir, 'src/t01.js'), 'module.exports = "operator";\n');
    const first = await consolidated(conflict, 'the conflicting target');
    assert.deepStrictEqual([first.status, first.reason_code, first.conflict], ['conflict', 'integration-conflict', { task_id: 'T01', root_id: 'primary', path: 'src/t01.js' }]);
    for (const id of PAIR) assert(!published(conflict.dir, id), `${id}: nothing is published over a conflict`);
    assert.strictEqual(fs.readFileSync(at(conflict.dir, 'src/t01.js'), 'utf8'), 'module.exports = "operator";\n', 'the operator bytes are never overwritten');
    // The operator resolves the target; the preserved results consolidate without any new inference.
    const spawned = spawnedCount(conflict);
    fs.unlinkSync(at(conflict.dir, 'src/t01.js'));
    const second = await consolidated(conflict, 'the resolved target');
    assert.deepStrictEqual([second.status, second.members.map(row => row.outcome)], ['consolidated', ['acknowledged', 'acknowledged']]);
    targetMatchesMembers(conflict, PAIR);
    assert.strictEqual(spawnedCount(conflict), spawned, 'no second inference after the conflict');
  } finally { await finish(conflict); }
});

// ── U5-6: cleanup ─────────────────────────────────────────────────────────────

test('issue343 U5-6 cleanup retains dirty or needed member worktrees, never forces, and keeps every sibling claim valid', async () => {
  assert(u5.serial && u5.partial, 'the consolidated cohorts of U5-1 and U5-2 are required');
  try {
    // Cohort integration never commits the worker roots: dirty evidence stays reserved.
    const serialPlan = batch.cleanupCohort(u5.serial.scope);
    assert.deepStrictEqual(serialPlan.map(member => [member.task_id, member.roots.map(root => [root.decision, root.reason_code])]),
      [['T01', [['retained', 'member-root-dirty']]], ['T02', [['retained', 'member-root-dirty']]]]);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(u5.serial.consolidation.cleanup)), JSON.parse(JSON.stringify(serialPlan)),
      'the consolidation itself ran the same retaining cleanup');
    // A needs-input sibling is live: every root of that cohort stays reserved.
    const partialPlan = batch.cleanupCohort(u5.partial.scope);
    assert.deepStrictEqual(partialPlan.map(member => [member.task_id, member.roots.map(root => [root.decision, root.reason_code])]),
      [['T01', [['retained', 'batch-members-pending']]], ['T02', [['retained', 'batch-members-pending']]], ['T03', [['retained', 'batch-members-pending']]]]);
    for (const fx of [u5.serial, u5.partial]) {
      for (const root of memberPaths(fx).values()) assert(fs.existsSync(root), `${fx.label}: ${root} is retained`);
      const run = runs.get(fx.dir, fx.scope.run_id);
      assert.doesNotThrow(() => claims.validateHeldClaim(run.write_claim), `${fx.label}: the aggregate claim is still held and valid`);
      assert.doesNotThrow(() => rootsApi.claimGroups(run.write_claim), `${fx.label}: every root of the union, each sibling worktree included, still exists`);
      assert.strictEqual(isolation.cleanupForRun(fx.dir, fx.scope.run_id).repos[0].reason, 'batch-members-pending', `${fx.label}: the run cleanup keeps the batch roots`);
    }
    // Only a live consolidation cohort handle of forge-execution-batch authorizes a cleanup.
    for (const forged of [{}, Object.create(null)]) {
      assert.throws(() => isolation.planBatchCleanup(forged), error => error.code === 'batch-cohort-handle-invalid');
      assert.throws(() => isolation.cleanupBatchMember(forged, 0), error => error.code === 'batch-cohort-handle-invalid');
    }
  } finally {
    await finish(u5.serial);
    await finish(u5.partial);
  }
});

// ── U5-7: native and SVN controls ─────────────────────────────────────────────

test('issue343 U5-7 native and SVN controls keep their current native or serial paths and the consolidation never applies to them', async () => {
  const native = owner('u5-native');
  planSlice(native, { T01: taskPlan('T01'), T02: taskPlan('T02') });
  const svn = owner('u5-svn', { vcs: 'svn' });
  planSlice(svn, { T01: taskPlan('T01'), T02: taskPlan('T02') });
  for (const [dir, host, reason] of [[native, 'claude', 'primary-native'], [svn, 'codex', 'svn-isolation-unavailable']]) {
    const snapshot = loop.create({ mode: 'auto', workflow_id: `wf-${++serial}`, host_runtime: host, max_steps: 10 });
    const result = adapter.invoke(host, 'auto', 'next', { cwd: dir, milestone: M, owner_token: TOKEN, session: SESSION }, snapshot, {}).result;
    assert.deepStrictEqual([result.outcome, result.action, result.unit && result.unit.key], ['dispatch_required', 'dispatch', 'execute-task/T01'],
      `${reason}: ${JSON.stringify(result.controller_result)}`);
    assert.deepStrictEqual([result.controller_result.details.batch.decision, result.controller_result.details.batch.reason_code], ['single', reason]);
    assert.strictEqual(result.snapshot.current_batch, undefined, `${reason}: no current_batch`);
    assert(!fs.existsSync(path.join(dir, '.gsd', 'forge', 'batches')), `${reason}: no batch record exists`);
    // The consolidation and the cleanup have no batch here: they refuse and write nothing.
    const scope = { cwd: dir, milestone: M, host_runtime: host, owner_token: TOKEN, batch_id: `batch-${'0'.repeat(32)}`,
      manifest_sha256: '0'.repeat(64), run_id: 'M-20261108000001-control' };
    await rejectsCode(batch.consolidateCohort(scope, { members: {}, broker_manifest_sha256: '0'.repeat(64) }), 'batch-manifest-invalid', `${reason}: consolidate`);
    assert.throws(() => batch.cleanupCohort(scope), error => error.code === 'batch-manifest-invalid');
    assert(!fs.existsSync(path.join(dir, '.gsd', 'forge', 'batches')), `${reason}: still no batch record`);
  }
  // The CLI `consolidate` refuses malformed, approved or unknown input before any effect.
  const approved = write(path.join(TMP, 'requests', 'u5-approved.json'), JSON.stringify({ schema: batch.CONSOLIDATE_REQUEST_SCHEMA, cwd: native,
    milestone: M, host_runtime: 'claude', owner_token: TOKEN, run_id: 'M-20261108000001-control', manifest_sha256: '0'.repeat(64),
    broker_manifest_sha256: '0'.repeat(64), members: {}, approved: true }));
  const runShaped = write(path.join(TMP, 'requests', 'u5-run-shaped.json'), JSON.stringify({ schema: batch.RUN_REQUEST_SCHEMA, cwd: native,
    milestone: M, host_runtime: 'claude', owner_token: TOKEN, run_id: 'M-20261108000001-control', manifest_sha256: '0'.repeat(64), members: {} }));
  const unknown = write(path.join(TMP, 'requests', 'u5-unknown.json'), JSON.stringify({ schema: batch.CONSOLIDATE_REQUEST_SCHEMA, cwd: native,
    milestone: M, host_runtime: 'claude', owner_token: TOKEN, run_id: 'M-20261108000001-control', manifest_sha256: '0'.repeat(64),
    broker_manifest_sha256: '0'.repeat(64), members: {} }));
  for (const [file, code] of [[approved, 'batch-run-request-invalid'], [runShaped, 'batch-run-request-invalid'], [unknown, 'batch-manifest-invalid']]) {
    const result = spawnSync(process.execPath, [CLI, 'consolidate', '--batch', `batch-${'0'.repeat(32)}`, '--request', file],
      { encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env } });
    assert.strictEqual(result.status, 1, `${path.basename(file)}: ${result.stderr}`);
    assert.strictEqual(result.stdout, '', `${path.basename(file)}: a refusal prints no report`);
    assert.strictEqual(result.stderr.trim().split('\n').pop(), `forge-execution-batch: ${code}`, path.basename(file));
    assert(!result.stderr.includes(TOKEN), `${path.basename(file)}: the owner token is never echoed`);
  }
});

// U5 maintenance witnesses: public runtime and actual Node children, no second inference.
test('issue343 U5-2 a typed timeout preserves its failed receipt and does not cancel the healthy sibling', async () => {
  const fx = await retainedCohort('u5-timeout', PAIR, {
    T01: { ...GO, mode: 'fail', throw_code: 'claude-timeout' }, T02: { ...GO, peers: ['T01'] },
  });
  try {
    assert.deepStrictEqual(fx.report.members.map(row => [row.task_id, row.outcome, row.reason_code]),
      [['T01', 'failed', 'claude-timeout'], ['T02', 'retained', null]]);
    assert.strictEqual(fx.report.members[1].aborted, false);
    const failed = fs.readFileSync(`${fx.inputs.T01.resultFile}.receipt.json`), spawned = spawnedCount(fx);
    const report = await consolidated(fx, 'timeout with healthy sibling');
    assert.deepStrictEqual(report.members.map(row => [row.task_id, row.outcome]), [['T01', 'failed'], ['T02', 'acknowledged']]);
    assert(fs.readFileSync(`${fx.inputs.T01.resultFile}.receipt.json`).equals(failed));
    assert.strictEqual(spawnedCount(fx), spawned);
    assert.deepStrictEqual(completions(fx.dir).map(row => row.unit.key), ['execute-task/T02']);
    assert(fs.existsSync(mark(fx, 'T02', 'finished')) && !alive(readJson(mark(fx, 'T02', 'entered')).pid));
  } finally { await finish(fx); }
});

test('issue343 U5-1 and U5-5 integrate rename deletion binary and POSIX mode-only deltas without changing the target index', async () => {
  const operations = [
    { kind: 'rename', from: 'src/t01/old.bin', path: 'src/t01/new.bin' },
    { kind: 'delete', path: 'src/t01/deleted.txt' },
    { kind: 'binary', path: 'src/t01/bytes.bin', base64: Buffer.from([0, 255, 13, 10, 128]).toString('base64') },
    ...(process.platform === 'win32' ? [] : [{ kind: 'mode', path: 'src/t01/tool.sh', mode: 0o755 }]),
  ];
  const tasks = { T01: taskPlan('T01').replace('writes:\n', 'writes:\n  - "src/t01/**"\n'), T02: taskPlan('T02') };
  const fx = await retainedCohort('u5-operations', PAIR, { T01: { ...GO, operations }, T02: GO }, { tasks, setup(dir) {
    write(at(dir, 'src/t01/old.bin'), Buffer.from([7, 0, 254]));
    write(at(dir, 'src/t01/deleted.txt'), 'delete this tracked preimage\n');
    write(at(dir, 'src/t01/tool.sh'), '#!/bin/sh\necho fixture\n');
    if (process.platform !== 'win32') fs.chmodSync(at(dir, 'src/t01/tool.sh'), 0o644);
  } });
  try {
    const before = targetState(fx.dir), spawned = spawnedCount(fx);
    const old = fs.readFileSync(at(fx.dir, 'src/t01/old.bin'));
    const tool = fs.readFileSync(at(fx.dir, 'src/t01/tool.sh'));
    const report = await consolidated(fx, 'rename deletion binary and mode-only');
    assert.strictEqual(report.status, 'consolidated');
    assert(!fs.existsSync(at(fx.dir, 'src/t01/old.bin')) && !fs.existsSync(at(fx.dir, 'src/t01/deleted.txt')));
    assert(fs.readFileSync(at(fx.dir, 'src/t01/new.bin')).equals(old));
    assert(fs.readFileSync(at(fx.dir, 'src/t01/bytes.bin')).equals(Buffer.from([0, 255, 13, 10, 128])));
    assert(fs.readFileSync(at(fx.dir, 'src/t01/tool.sh')).equals(tool));
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(at(fx.dir, 'src/t01/tool.sh')).mode & 0o111, 0o111);
      const ready = readJson(`${fx.inputs.T01.resultFile}.receipt.json`);
      assert.strictEqual(ready.milestone_delivery.verified_modes['primary::src/t01/tool.sh'], true);
    }
    assert.deepStrictEqual(targetState(fx.dir), before);
    assert.strictEqual(spawnedCount(fx), spawned);
    assert.deepStrictEqual(completions(fx.dir).map(row => row.unit.key), ['execute-task/T01', 'execute-task/T02']);
  } finally { await finish(fx); }
});

test('issue343 ignored declared output integrates and acknowledges without weakening byte verification', async () => {
  const tasks = { T01: taskPlan('T01').replace('writes:\n', 'writes:\n  - "src/declared-ignored.bin"\n')
    .replace('  artifacts:\n', '  artifacts:\n    - path: "src/declared-ignored.bin"\n      provides: "Declared ignored binary"\n      min_lines: 1\n')
    .replace('expected_output:\n', 'expected_output:\n  - src/declared-ignored.bin\n'), T02: taskPlan('T02') };
  const bytes = Buffer.from([0, 255, 42, 13, 10]);
  const fx = await retainedCohort('ignored-output', PAIR, {
    T01: { ...GO, operations: [{ kind: 'binary', path: 'src/declared-ignored.bin', base64: bytes.toString('base64') }] }, T02: GO,
  }, { tasks, setup(dir) { write(at(dir, '.gitignore'), 'build/\n*.log\nsrc/declared-ignored.bin\n'); } });
  try {
    const index = targetState(fx.dir);
    const crashed = await within(consolidate(fx, { failpoint: crashAt('member-integrated') }), 300000, 'ignored-output integration crash');
    assert.strictEqual(crashed.error?.code, 'FIXTURE_CRASH');
    write(at(fx.dir, 'src/declared-ignored.bin'), Buffer.from('tampered ignored output'));
    const refused = await within(consolidate(fx), 300000, 'ignored-output byte tamper');
    assert(refused.error || refused.value?.status !== 'consolidated', 'ignored bytes still require exact verification');
    assert.deepStrictEqual(completions(fx.dir), [], 'tamper never acknowledges the first member');
    write(at(fx.dir, 'src/declared-ignored.bin'), bytes);
    const report = await consolidated(fx, 'ignored declared output');
    assert.strictEqual(report.status, 'consolidated');
    assert(fs.readFileSync(at(fx.dir, 'src/declared-ignored.bin')).equals(bytes));
    assert.deepStrictEqual(targetState(fx.dir), index, 'the target index remains unchanged');
    assert.deepStrictEqual(completions(fx.dir).map(row => row.unit.key), ['execute-task/T01', 'execute-task/T02']);
  } finally { await finish(fx); }
});

test('issue343 U5-5 POSIX executable mode drift conflicts before publication and resumes only after restoring the exact base mode', async () => {
  if (process.platform === 'win32') return; // Windows mode observability is separately refused by isolation.
  const tasks = { T01: taskPlan('T01').replace('writes:\n', 'writes:\n  - "src/t01/**"\n'), T02: taskPlan('T02') };
  const fx = await retainedCohort('u5-mode-drift', PAIR, { T01: { ...GO, operations: [{ kind: 'mode', path: 'src/t01/tool.sh', mode: 0o755 }] }, T02: GO },
    { tasks, setup(dir) { write(at(dir, 'src/t01/tool.sh'), '#!/bin/sh\necho fixture\n'); fs.chmodSync(at(dir, 'src/t01/tool.sh'), 0o644); } });
  try {
    const target = at(fx.dir, 'src/keep.js'), spawned = spawnedCount(fx), before = targetState(fx.dir);
    // Unrelated target mode drift is not the member's verified mode-only delta.
    fs.chmodSync(target, 0o755);
    const stopped = await consolidated(fx, 'mode drift refuses');
    assert.deepStrictEqual([stopped.status, stopped.reason_code, stopped.conflict.path], ['conflict', 'integration-conflict', 'src/keep.js']);
    assert(!published(fx.dir, 'T01') && completions(fx.dir).length === 0);
    assert.strictEqual(fs.statSync(target).mode & 0o111, 0o111);
    fs.chmodSync(target, 0o644);
    const completed = await consolidated(fx, 'restored mode resumes');
    assert.strictEqual(completed.status, 'consolidated');
    assert.strictEqual(fs.statSync(target).mode & 0o111, 0);
    assert.strictEqual(fs.statSync(at(fx.dir, 'src/t01/tool.sh')).mode & 0o111, 0o111);
    assert.strictEqual(spawnedCount(fx), spawned);
    assert.deepStrictEqual(targetState(fx.dir), before);
  } finally { await finish(fx); }
});

test('issue343 U5-3 two real coordinator processes cannot consolidate one live cohort and the fence releases only after the signer joins', async () => {
  const fx = await retainedCohort('u5-coordinators', PAIR, PAIR_GO);
  let first;
  const entered = path.join(TMP, 'coordinator-entered.json'), released = path.join(TMP, 'coordinator-release');
  try {
    const input = write(path.join(TMP, 'coordinator-input.json'), JSON.stringify({ scope: fx.scope, members: fx.inputs, trust: fx.trust }));
    const actor = write(path.join(TMP, 'coordinator-holder.cjs'), [
      "'use strict'; const fs=require('fs');",
      `const batch=require(${JSON.stringify(CLI)});`,
      `const input=JSON.parse(fs.readFileSync(${JSON.stringify(input)},'utf8'));`,
      'let paused=false;',
      'batch.consolidateCohort(input.scope,{members:input.members,broker_manifest_sha256:input.trust.manifest_sha256,failpoint(name){',
      " if(name!=='consolidation-progress-intent'||paused)return;paused=true;",
      ` fs.writeFileSync(${JSON.stringify(entered)},JSON.stringify({pid:process.pid}));`,
      ' const deadline=Date.now()+300000,wait=new Int32Array(new SharedArrayBuffer(4));',
      ` while(!fs.existsSync(${JSON.stringify(released)})){if(Date.now()>deadline)throw new Error('coordinator fixture timeout');Atomics.wait(wait,0,0,20);}`,
      "}}).then(value=>console.log(JSON.stringify(value)),error=>{console.error(error.stack);process.exitCode=1;});",
    ].join('\n'));
    first = runCli([actor], 300000);
    await waitFor(() => fs.existsSync(entered), 300000, 'the first coordinator owns the live consolidation');
    const holder = readJson(entered);
    assert(alive(holder.pid));
    const evidence = reconciliation.readBatchEvidence(fx.trust);
    const second = await freshConsolidate(fx);
    assert.strictEqual(second.code, 1, second.stderr);
    assert.strictEqual(second.stderr.trim().split('\n').pop(), 'forge-execution-batch: batch-consolidation-busy');
    assert(alive(holder.pid), 'the second coordinator cannot terminate the holder');
    assert.deepStrictEqual(reconciliation.readBatchEvidence(fx.trust).generations, evidence.generations, 'no second signer generation while the holder is alive');
    write(released, 'release');
    const joined = await first;
    assert.strictEqual(joined.code, 0, joined.stderr);
    assert(!alive(holder.pid), 'actual first coordinator close joined');
    const resumed = await freshConsolidate(fx);
    assert.strictEqual(resumed.code, 0, resumed.stderr);
    assert.deepStrictEqual(completions(fx.dir).map(row => row.unit.key), ['execute-task/T01', 'execute-task/T02']);
  } finally { write(released, 'release'); if(first) await first; await finish(fx); }
});

test('issue343 U5-4 independent STATE byte drift after terminal intent refuses and preserves the pending operation and locator', async () => {
  const fx = await retainedCohort('u5-state-byte-drift', PAIR, PAIR_GO);
  try {
    const crashed = await within(consolidate(fx, { failpoint: crashAt('controller-terminal-intent') }), 300000, 'the terminal intent crash');
    assert.strictEqual(crashed.error && crashed.error.code, 'FIXTURE_CRASH');
    const evidence = reconciliation.readBatchEvidence(fx.trust);
    assert(evidence.operations.pending, 'a signed terminal intent remains pending');
    const file = state.statePath(fx.dir, M), original = fs.readFileSync(file);
    fs.writeFileSync(file, Buffer.concat([original, Buffer.from(' ')]));
    try {
      const refused = await within(consolidate(fx), 300000, 'independent STATE byte drift');
      assert(refused.error, 'logical equivalence must not authorize independently changed STATE bytes');
      assert.strictEqual(refused.error.code, 'reconciliation-operation-drift', refused.error.stack);
      assert(fs.readFileSync(file).equals(Buffer.concat([original, Buffer.from(' ')])), 'drift is preserved for reconciliation');
      const ack = adapter.invoke('codex', 'auto', 'batch-ack', ackInput(fx), fx.ids.snapshot, {}).result;
      assert.strictEqual(ack.outcome, 'blocked');
      assert(ack.snapshot.current_batch, 'the batch locator remains');
      assert.strictEqual(completions(fx.dir).length, 0, 'no completion over drift');
    } finally { fs.writeFileSync(file, original); }
    const resumed = await consolidated(fx, 'exact STATE restored');
    assert.strictEqual(resumed.status, 'consolidated');
    assert.strictEqual(reconciliation.readBatchEvidence(fx.trust).operations.pending, null);
  } finally { await finish(fx); }
});

test('issue343 U5-4 corrupted committed completion refuses batch-ack and keeps the current batch locator', async () => {
  const fx = u5.serial;
  assert(fx && fx.consolidation, 'the already verified serial cohort is reused');
  const completed = completions(fx.dir)[0];
  assert(completed && completed.phase === 'committed');
  const file = controller.transactionFile(fx.dir, completed.idempotency_key), original = fs.readFileSync(file);
  const invalid = JSON.parse(original);
  invalid.result.status = 'failed';
  assert(!Buffer.from(JSON.stringify(invalid, null, 2) + '\n').equals(original));
  fs.writeFileSync(file, JSON.stringify(invalid, null, 2) + '\n');
  try {
    const ack = adapter.invoke('codex', 'auto', 'batch-ack', ackInput(fx), fx.ids.snapshot, {}).result;
    assert.strictEqual(ack.outcome, 'blocked');
    assert(ack.snapshot.current_batch, 'progress ack cannot clear an unproved completion');
    assert(ack.snapshot.current_batch.members.includes(completed.unit.key));
    assert(!(ack.controller_result.details.acknowledged || []).includes(completed.unit.key));
  } finally { fs.writeFileSync(file, original); }
});

// Real production transports: a local executable implements their wire protocols,
// without replacing runExecute or calling scope.attach from the harness.
const ACTUAL_ADAPTER_PROVIDER = path.join(TMP, 'provider', 'actual-adapter-provider.js');
fs.writeFileSync(ACTUAL_ADAPTER_PROVIDER, `
'use strict';
const fs=require('fs'),path=require('path'),readline=require('readline');
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
async function result(prompt){
 const match=prompt.match(/FORGE_FIXTURE_CONFIG=(\\{[^\\n]+\\})/);if(!match)throw Error('fixture config absent');
 const c=JSON.parse(match[1]);fs.writeFileSync(path.join(c.rendezvous,c.task+'.entered'),String(process.pid));
 if(c.delay_ms)await new Promise(r=>setTimeout(r,c.delay_ms));
 const until=Date.now()+5000;while((c.peers||[]).some(id=>!fs.existsSync(path.join(c.rendezvous,id+'.entered')))){
  if(Date.now()>until)throw Error('actual adapter peer absent');await new Promise(r=>setTimeout(r,10));
 }
 const file='src/'+c.task.toLowerCase()+'.js';
 if(c.status!=='blocked')fs.writeFileSync(file,'module.exports = '+JSON.stringify(c.task)+';\\n');
 fs.writeFileSync(path.join(c.rendezvous,c.task+'.finished'),String(Date.now()));
 return {status:c.status,summary:c.task+' actual adapter '+c.status,files_changed:c.status==='blocked'?[]:[file],
 must_haves_status:[{item:'real fixture',status:c.status==='done'?'met':'unmet',note:'actual child',scope:c.status==='blocked'?'environment':'task',reason:c.status==='blocked'?'network-required':''}]};
}
if(process.argv.includes('app-server')){
 const rl=readline.createInterface({input:process.stdin});rl.on('line',async line=>{try{const m=JSON.parse(line);
  if(m.method==='initialize')send({id:m.id,result:{serverInfo:{name:'fixture'}}});
  else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'thread-fixture'}}});
  else if(m.method==='turn/start'){
   send({id:m.id,result:{turn:{id:'turn-fixture'}}});const value=await result(m.params.input[0].text);
   send({method:'item/completed',params:{item:{id:'answer',type:'agentMessage',text:JSON.stringify(value)}}});
   send({method:'turn/completed',params:{turn:{id:'turn-fixture',status:'completed'}}});
  }
 }catch(e){process.stderr.write(e.message);process.exitCode=1;rl.close();}});
}else{
 const args=process.argv.slice(2),instruction=args[args.indexOf('-p')+1];
 if(args.includes('--session-id'))send({type:'system',subtype:'init',session_id:args[args.indexOf('--session-id')+1],model:args[args.indexOf('--model')+1]});
 const prefix='Read the complete task prompt from this UTF-8 file: ',suffix='. Follow it exactly and return the required structured_output JSON.';
 const prompt=fs.readFileSync(JSON.parse(instruction.slice(prefix.length,-suffix.length)),'utf8');
 result(prompt).then(value=>send({type:'result',subtype:'success',is_error:false,structured_output:value,session_id:args[args.indexOf('--session-id')+1],
  result:['---GSD-WORKER-RESULT---','status: '+value.status,'result_json: '+JSON.stringify(value),'---END-RESULT---'].join('\\n'),
  modelUsage:{[args[args.indexOf('--model')+1]]:{inputTokens:1,outputTokens:1}}})).catch(e=>{process.stderr.write(e.message);process.exitCode=1;});
}
`);
const ACTUAL_ACCOUNT_PRELOAD=path.join(TMP,'provider','actual-account-preload.js');
fs.writeFileSync(ACTUAL_ACCOUNT_PRELOAD,`require(${JSON.stringify(require.resolve('./forge-accounts'))}).resolveLaunch=()=>({name:'isolated-cli-fixture',token:'synthetic-process-fixture-token'});`);
async function actualAdapterCase(label, statuses, options={}) {
  const tasks=options.codex?Object.fromEntries(PAIR.map(id=>[id,taskPlan(id).replace('tier: standard','tier: standard\nworker: codex')])):undefined;
  const previous=xllm.runExecute,oldClaude=process.env.FORGE_XLLM_CLAUDE_BIN,oldCodex=process.env.FORGE_XLLM_CODEX_BIN;
  let fx=null;
  try{
    process.env.FORGE_XLLM_CLAUDE_BIN=ACTUAL_ADAPTER_PROVIDER;process.env.FORGE_XLLM_CODEX_BIN=ACTUAL_ADAPTER_PROVIDER;
    fx=fixture(label,PAIR,{}, {tasks,hostRuntime:options.codex?'claude':'codex'});
    xllm.runExecute=canonicalRunExecute;
    for(const id of PAIR){
      const context=path.join(CHANNELS,label+'-'+id+'-context.md');
      fs.writeFileSync(context,'FORGE_FIXTURE_CONFIG='+JSON.stringify({task:id,status:statuses[id],rendezvous:fx.rendezvous,peers:options.serial?[]:PAIR,delay_ms:id==='T01'?options.delay_ms||0:0})+'\n');
      fx.inputs[id].contextFile=context;
    }
    if(options.preflight)unavailableAccountTask='T02';
    if(options.cli){
      const requestFile=write(path.join(TMP,'requests',label+'-actual-cli.json'),JSON.stringify({schema:batch.RUN_REQUEST_SCHEMA,
        cwd:fx.scope.cwd,milestone:M,host_runtime:fx.scope.host_runtime,owner_token:TOKEN,run_id:fx.scope.run_id,
        manifest_sha256:fx.ids.manifest_sha256,members:fx.inputs}));
      fx.running=settle(runCli(['-r',ACTUAL_ACCOUNT_PRELOAD,CLI,'run','--batch',fx.ids.batch_id,'--request',requestFile],90000).then(cli=>{
        assert.strictEqual(cli.code,0,cli.stderr.slice(-1500));return JSON.parse(cli.stdout.trim().split('\n').pop());
      }));
    }else fx.running=settle(batch.runCohort(fx.scope,{members:fx.inputs,stream:SINK,
      ...(options.serial?{prefsReader:prefs(1)}:{}),
      onMemberControl:control=>{fx.controls.set(control.task_id,control);if(options.cancel&&control.task_id==='T02')control.abort('queued fixture cancellation');
        if(options.captureLease&&control.task_id==='T01')fx.leaseBefore=PAIR.map(id=>({file:lease.leaseFile(fx.dir,'execute-task/'+id),bytes:fs.readFileSync(lease.leaseFile(fx.dir,'execute-task/'+id))}));}}));
    const settled=await within(fx.running,90000,label);if(settled.error)throw settled.error;
    const report=settled.value;assert(report.barrier.sealed,JSON.stringify(report));
    const evidence=reconciliation.readBatchEvidence({directory:report.broker.directory,manifest_sha256:report.broker.manifest_sha256});
    return {fx,report,evidence,barrier:readJson(path.join(report.broker.directory,'barrier.json'))};
  }catch(error){await finish(fx);throw error;}
  finally{unavailableAccountTask=null;xllm.runExecute=previous;process.env.FORGE_XLLM_CLAUDE_BIN=oldClaude;process.env.FORGE_XLLM_CODEX_BIN=oldCodex;}
}
test('issue343 R1 actual production adapters attach both real children before retention',async()=>{
  const {fx,report,barrier}=await actualAdapterCase('actual-production',{T01:'done',T02:'done'},{cli:true});
  try{assert.strictEqual(report.status,'retained');assert(report.members.every(row=>row.process.pid>0&&row.process.join==='joined'));assert(barrier.members.every(row=>row.pid>0&&row.outcome==='retained'));}
  finally{await finish(fx);}
});
test('issue343 R1 actual appserver adapter attaches real JSON-RPC children before retention',async()=>{
 const {fx,report,barrier}=await actualAdapterCase('actual-appserver',{T01:'done',T02:'done'},{codex:true});
 try{assert.strictEqual(report.status,'retained');assert(report.members.every(row=>row.process.pid>0&&row.process.join==='joined'));assert(barrier.members.every(row=>row.pid>0&&row.outcome==='retained'));}
 finally{await finish(fx);}
});
for(const kind of ['cancel','preflight'])test('issue343 R6 actual '+kind+' never-started proof permits the healthy sibling barrier',async()=>{
 const {fx,report,barrier}=await actualAdapterCase('actual-'+kind,{T01:'done',T02:'done'},{[kind]:true,serial:true});
 try{assert.strictEqual(report.members[0].outcome,'retained');const row=barrier.members[1];assert.strictEqual(row.writer_state,'never-started');assert.strictEqual(row.pid,null);assert.strictEqual(row.exit_code,null);assert.strictEqual(row.signal,null);assert(!fs.existsSync(path.join(fx.rendezvous,'T02.entered')));}
 finally{await finish(fx);}
});
for(const status of ['partial','blocked'])test('issue343 R13 actual '+status+' result remains signed residual beside done',async()=>{
 const {fx,report,evidence,barrier}=await actualAdapterCase('actual-'+status,{T01:'done',T02:status});
 try{const row=report.members[1],signed=barrier.members[1],receipt=readJson(fx.inputs.T02.resultFile+'.receipt.json');
  assert.strictEqual(row.result_status,status);assert.strictEqual(row.outcome,'blocked');assert.strictEqual(row.provider_called,true);
  assert.strictEqual(signed.outcome,'residual');assert.strictEqual(signed.result_status,status);assert.strictEqual(signed.provider_called,true);
  assert.strictEqual(evidence.members[1].result_status,status);assert.strictEqual(evidence.members[1].provider_called,true);
  assert.strictEqual(receipt.phase,'residual');assert.strictEqual(receipt.result.status,status);assert.strictEqual(published(fx.dir,'T02'),false);
  assert.strictEqual(completions(fx.dir).length,0);if(status==='blocked')assert.strictEqual(signed.reason,'network-required');
 }finally{await finish(fx);}
});
test('issue343 R4 actual healthy child and queued sibling exceed ordinary TTL without owner heartbeats',async()=>{
 const {fx,report}=await actualAdapterCase('actual-window',{T01:'done',T02:'done'},{serial:true,delay_ms:lease.DEFAULT_TTL_MS+1000,captureLease:true});
 try{assert.strictEqual(report.status,'retained');assert.strictEqual(report.pool.max_concurrent,1);
  for(const snapshot of fx.leaseBefore){assert(fs.readFileSync(snapshot.file).equals(snapshot.bytes),'no heartbeat under S0');const raw=JSON.parse(snapshot.bytes);assert(raw.expires_at-raw.heartbeat_at>lease.DEFAULT_TTL_MS);}
  assert(fs.statSync(path.join(fx.rendezvous,'T02.entered')).mtimeMs>=fs.statSync(path.join(fx.rendezvous,'T01.finished')).mtimeMs,'queued sibling starts only after first writer finished');
 }finally{await finish(fx);}
});
test('issue343 R4 uncovered max-tier serial queue refuses before any provider or S0',async()=>{
 const tasks=Object.fromEntries(PAIR.map(id=>[id,taskPlan(id).replace('tier: standard','tier: max')]));
 const fx=fixture('uncovered-window',PAIR,{}, {tasks});
 try{await rejectsCode(batch.runCohort(fx.scope,{members:fx.inputs,stream:SINK,prefsReader:prefs(1)}),'batch-lease-coverage-insufficient','max queue cannot fit existing lease bound');
  assert(!fs.existsSync(fx.inputs.T01.resultFile+'.receipt.json'));assert(!fs.existsSync(fx.inputs.T02.resultFile+'.receipt.json'));
 }finally{await finish(fx);}
});

// Root adds the two scoped corruption witnesses here: STATE bytes after terminal intent,
// and completed controller proof corruption refusing batch-ack without clearing its locator.

// Auto-deferred cohort plans use a live host adapter; no approval files exist.
function r2AutoInputs(fx) {
  for (const id of fx.names) {
    fs.unlinkSync(path.join(sliceDir(fx.dir), 'tasks', id, `${id}-PLAN-GATE.md`));
    fx.inputs[id].gates = { ...fx.inputs[id].gates, plan: 'skipped', planSkipReason: 'auto-defer', authorizationReference: `fixture-auto:${fx.label}:${id}` };
  }
}
function r2HostAdapter(fx, observations, enabled = () => true) {
  const execution = require('./forge-task-execution'), expected = structuredClone(fx.inputs);
  const plans = Object.fromEntries(fx.names.map(id => [id, digest(fs.readFileSync(path.join(sliceDir(fx.dir), 'tasks', id, `${id}-PLAN.md`)))]));
  return execution.createAutoPlanGateAdapter(scope => {
    const input = expected[scope.taskId];
    let knownRoot = rootsApi.key(scope.codeDir) === rootsApi.key(fx.dir);
    if (!knownRoot) {
      const record = readJson(path.join(fx.dir, '.gsd/forge/batches', fx.ids.batch_id, 'isolation.json'));
      const member = record.members.find(row => row.task_id === scope.taskId);
      const root = member?.roots.find(row => rootsApi.key(row.path) === rootsApi.key(scope.codeDir));
      knownRoot = Boolean(root && isolation.validateWorktreeIdentity(fx.dir, root.path, root.branch).ok);
    }
    const contract = rootsApi.validateContract({ schema_version: 2, owner: fx.dir, primary_root_id: 'primary', code_roots: [{ id: 'primary', path: scope.codeDir, vcs: 'git' }] });
    const authorized = enabled() && Boolean(input) && knownRoot && scope.scope === 'milestone' && scope.phase === 'execute'
      && scope.unitType === 'execute-task' && scope.host === 'codex' && rootsApi.key(scope.owner) === rootsApi.key(fx.dir)
      && scope.milestoneId === M && scope.sliceId === S && scope.workflowId === input.workflowId && scope.dispatchId === input.dispatchId
      && scope.reference === input.gates.authorizationReference && scope.planSha256 === plans[scope.taskId]
      && scope.planFile === fs.realpathSync.native(path.join(sliceDir(fx.dir), 'tasks', scope.taskId, `${scope.taskId}-PLAN.md`))
      && scope.executionContractSha256 === rootsApi.digest(contract);
    observations.push({ task: scope.taskId, codeDir: scope.codeDir, authorized });
    return { authorized, mode: 'auto', reference: scope.reference };
  });
}

test('issue343 R2 automatic cohort runs without manual markers and reattests origin and physical members', async () => {
  const fx = fixture('r2-auto', PAIR, { T01: { peers: ['T02'], hold: false }, T02: { peers: ['T01'], hold: false } });
  const observed = []; let enabled = true;
  try {
    r2AutoInputs(fx); const autoPlanGateAdapter = r2HostAdapter(fx, observed, () => enabled);
    Object.assign(CONFIG, { plan: fx.plan, journal: fx.journal, onSpawn: null });
    fx.running = settle(batch.runCohort(fx.scope, { members: fx.inputs, stream: SINK, autoPlanGateAdapter }));
    const outcome = await within(fx.running, 120000, 'R2 actual auto pool');
    assert(!outcome.error, outcome.error && outcome.error.stack); fx.report = outcome.value;
    assert.strictEqual(fx.report.status, 'retained', JSON.stringify(fx.report));
    assert(fx.report.barrier.sealed && fx.report.members.every(row => row.outcome === 'retained'));
    assert(observed.length > 4 && observed.every(row => row.authorized));
    for (const id of fx.names) {
      assert(observed.some(row => row.task === id && rootsApi.key(row.codeDir) === rootsApi.key(fx.dir)), 'origin authorization was actually observed');
      assert(observed.some(row => row.task === id && rootsApi.key(row.codeDir) !== rootsApi.key(fx.dir)), 'physical member authorization was actually observed');
      assert(!fs.existsSync(path.join(sliceDir(fx.dir), 'tasks', id, `${id}-PLAN-GATE.md`)), 'no synthetic approved marker');
    }
    enabled = false;
    await assert.rejects(batch.consolidateCohort(fx.scope, { members: fx.inputs, broker_manifest_sha256: fx.report.broker.manifest_sha256, autoPlanGateAdapter }), error => error.code === 'execution-auto-gate-not-attested');
    enabled = true;
    const fresh = r2HostAdapter(fx, observed), report = await batch.consolidateCohort(fx.scope, { members: fx.inputs, broker_manifest_sha256: fx.report.broker.manifest_sha256, autoPlanGateAdapter: fresh });
    assert.strictEqual(report.status, 'consolidated', JSON.stringify(report));
    assert(report.members.every(row => row.outcome === 'acknowledged'));
    assertBinding(fx);
  } finally { await finish(fx); }
});

test('issue343 R2 missing, serialized and foreign auto attestation starts no writer', async () => {
  const fx = fixture('r2-refuse', PAIR, { T01: { peers: [], hold: false }, T02: { peers: [], hold: false } });
  try {
    r2AutoInputs(fx); const observed = [], live = r2HostAdapter(fx, observed);
    for (const adapter of [undefined, JSON.parse(JSON.stringify(live))]) {
      await assert.rejects(batch.runCohort(fx.scope, { members: fx.inputs, stream: SINK, autoPlanGateAdapter: adapter }), error => ['batch-member-plan-invalid', 'execution-auto-gate-adapter-required'].includes(error.code));
    }
    const bad = require('./forge-task-execution').createAutoPlanGateAdapter(scope => ({ authorized: true, mode: 'auto', reference: scope.reference + ':foreign' }));
    await assert.rejects(batch.runCohort(fx.scope, { members: fx.inputs, stream: SINK, autoPlanGateAdapter: bad }), error => error.code === 'execution-auto-gate-not-attested');
    for (const field of ['workflowId', 'dispatchId']) {
      const old = fx.inputs.T01[field]; fx.inputs.T01[field] = old + '-foreign';
      await assert.rejects(batch.runCohort(fx.scope, { members: fx.inputs, stream: SINK, autoPlanGateAdapter: live }), error => error.code === 'execution-auto-gate-not-attested'); fx.inputs.T01[field] = old;
    }
    const reference = fx.inputs.T01.gates.authorizationReference; fx.inputs.T01.gates.authorizationReference += ':forged';
    await assert.rejects(batch.runCohort(fx.scope, { members: fx.inputs, stream: SINK, autoPlanGateAdapter: live }), error => error.code === 'execution-auto-gate-not-attested'); fx.inputs.T01.gates.authorizationReference = reference;
    const plan = path.join(sliceDir(fx.dir), 'tasks/T01/T01-PLAN.md'), bytes = fs.readFileSync(plan);fs.appendFileSync(plan, '\nforeign plan edit\n');
    try { await assert.rejects(batch.runCohort(fx.scope, { members: fx.inputs, stream: SINK, autoPlanGateAdapter: live })); } finally { fs.writeFileSync(plan, bytes); }
    assert.strictEqual(fs.readFileSync(fx.journal, 'utf8'), '', 'no synthetic or real transport started');
    assert(!fs.existsSync(path.join(fx.dir, '.gsd/forge/batches', fx.ids.batch_id, 'isolation.json')), 'no member worktree or aggregate claim published');
  } finally { await finish(fx); }
});

test('review R5 R19 partial ACK projects the original roster and terminal custody replays intent effect and commit before a single successor', async () => {
  const fx = await retainedCohort('review-custody', PAIR, PAIR_GO, { tasks: {
    T01: taskPlan('T01'), T02: taskPlan('T02'), T03: taskPlan('T03', ['T02']),
  } });
  try {
    const original = fx.ids.snapshot.last_decision.controller_result.details.dispatch_batch;
    const partial = await consolidate(fx, { failpoint: crashAt('member-acknowledged') });
    assert.strictEqual(partial.error?.code, 'FIXTURE_CRASH');
    const pending = adapter.invoke('codex', 'auto', 'batch-ack', ackInput(fx), fx.ids.snapshot, {}).result;
    assert.strictEqual(pending.reason_code, 'batch-members-pending');
    assert.deepStrictEqual(pending.snapshot.current_batch.members, ['execute-task/T02']);
    const projected = pending.snapshot.last_decision.controller_result.details.dispatch_batch;
    assert.deepStrictEqual(projected.members, [original.members[1]], 'the original index/route/begin/lease binding is preserved');
    const repeated = adapter.invoke('codex', 'auto', 'next', ackInput(fx), pending.snapshot, {}).result;
    assert.strictEqual(repeated.outcome, 'dispatch_required');
    assert.deepStrictEqual(repeated.controller_result.details.dispatch_batch.members, [original.members[1]]);
    assert.strictEqual(repeated.snapshot.step_count, fx.ids.snapshot.step_count, 'no second charge');
    const tampered = JSON.parse(JSON.stringify(pending.snapshot));
    tampered.last_decision.controller_result.details.dispatch_batch.members[0].transaction.generation = 'foreign';
    assert.strictEqual(adapter.invoke('codex', 'auto', 'next', ackInput(fx), tampered, {}).result.outcome, 'blocked');
    for (const point of ['claim-mutation-intent', 'claim-mutation-applied', 'claim-mutation-before-commit']) {
      const interrupted = await consolidate(fx, { failpoint: crashAt(point) });
      assert.strictEqual(interrupted.error?.code, 'FIXTURE_CRASH', point);
      const proof = reconciliation.readBatchRetirement(fx.trust);
      assert.strictEqual(proof.committed, false, point + ': the historical intent is not promoted');
    }
    const report = await consolidated(fx, 'review custody final commit');
    assert.strictEqual(report.retirement.status, 'retired');
    const run = runs.get(fx.dir, fx.scope.run_id);
    assert.strictEqual(run.batch_locator, null);
    assert.strictEqual(run.batch_retirements.length, 1);
    const held = JSON.stringify(run.write_claim), spawned = spawnedCount(fx), completionsBefore = completeEvents(fx.dir).length;
    const replay = await consolidated(fx, 'review terminal read-only replay');
    assert.strictEqual(replay.historical_replay, true);
    assert.strictEqual(spawnedCount(fx), spawned);
    assert.strictEqual(completeEvents(fx.dir).length, completionsBefore);
    for (const memberRoot of memberPaths(fx).values()) {
      assert.strictEqual(batch.memberRootReservation(fx.dir, memberRoot).reserved, true, 'dirty/evidence roots remain exclusive');
    }
    const acked = adapter.invoke('codex', 'auto', 'batch-ack', ackInput(fx), pending.snapshot, {}).result;
    assert.strictEqual(acked.outcome, 'completed');
    const nextClaim = claims.recordClaim(fx.dir, fx.scope.run_id, { schema_version: 2,
      execution_contract: rootsApi.singleContract(fx.dir, fx.dir), source: 'plan-writes', unit: 'execute-task/T03',
      paths: [{ root_id: 'primary', path: 'src/t03.js' }] });
    assert.strictEqual(nextClaim.execution_contract.code_roots.length, run.write_claim.execution_contract.code_roots.length);
    assert.deepStrictEqual(nextClaim.root_baselines, run.write_claim.root_baselines);
    assert(claims.coversRetainedExecution(runs.get(fx.dir, fx.scope.run_id), rootsApi.singleContract(fx.dir, fx.dir), [{ root_id: 'primary', path: 'src/t03.js' }]));
    assert.throws(() => claims.clearClaim(fx.dir, fx.scope.run_id), /batch-claim-owner-operation-required/);
    const next = adapter.invoke('codex', 'auto', 'next', ackInput(fx), acked.snapshot, {}).result;
    assert.strictEqual(next.unit.key, 'execute-task/T03');
    assert.strictEqual(next.action, 'dispatch');
    assert.notStrictEqual(JSON.stringify(runs.get(fx.dir, fx.scope.run_id).write_claim), held, 'new unit reservation is an additive union');
  } finally { await finish(fx); }
});

test('review R5 R7 R16 all ACK then one genuine single delivery then a second cohort keep one run and exclusive dirty custody', async () => {
  const verification=id=>({preferenceCommands:['node src/check-fixture.cjs '+id],bindings:[
    {root_id:'primary',criterion:{kind:'truth',index:0},aspect:'default',coverage:'behavioral',source:{kind:'verification',check_index:0}},
    {root_id:'primary',criterion:{kind:'artifact',index:0},aspect:'declared-property',coverage:'structural',source:{kind:'verification',check_index:0}},
  ]});
  const fx=await retainedCohort('review-sequence',PAIR,PAIR_GO,{verification,setup(dir){
    write(path.join(dir,'src/check-fixture.cjs'),"'use strict';const assert=require('assert'),path=require('path');const id=process.argv[2],file='src/'+id.toLowerCase()+'.js';assert.strictEqual(require(path.resolve(file)),id+':'+file);console.log(id+' observable module value passed');\n");
  },tasks:{T01:taskPlan('T01'),T02:taskPlan('T02'),T03:taskPlan('T03',['T01','T02']),T04:taskPlan('T04',['T03']),T05:taskPlan('T05',['T03'])}});
  let secondFx=null;const cohortTransport=xllm.runExecute;
  try {
    const originalTarget=targetState(fx.dir),first=await consolidated(fx,'first cohort retirement');
    assert.strictEqual(first.retirement.status,'retired');assert.strictEqual(first.post_unit.status,'complete');
    const dirtyRoots=[...memberPaths(fx).values()];
    for(const root of dirtyRoots) {
      assert(git(root,['status','--porcelain']).trim(),'the fixture root is genuinely dirty');
      assert.strictEqual(isolation.validateCodeDirBoundary({workspaceRoot:path.dirname(root),codeDir:root,declaredCodeDir:root,repoRoots:[fx.dir],ownerRoot:fx.dir}).reason_code,'batch-member-root-exclusive');
    }
    const ack=adapter.invoke('codex','auto','batch-ack',ackInput(fx),fx.ids.snapshot,{}).result;
    assert.strictEqual(ack.outcome,'completed');
    const selected=adapter.invoke('codex','auto','next',ackInput(fx),ack.snapshot,{}).result;
    assert.deepStrictEqual([selected.action,selected.unit.key],['dispatch','execute-task/T03']);
    const planFile=path.join(taskDir(fx.dir,'T03'),'T03-PLAN.md');
    const route=resolveDispatch({unitType:'execute-task',cwd:fx.dir,planPath:planFile,roadmapPath:path.join(fx.dir,'.gsd/milestones',M,M+'-ROADMAP.md'),milestoneId:M,unitId:'T03',hostRuntime:'codex'});
    assert.strictEqual(route.dispatch_allowed,true);assert.strictEqual(route.worker_mode,'sidecar');
    const claim=claims.recordClaim(fx.dir,fx.scope.run_id,{schema_version:2,execution_contract:rootsApi.singleContract(fx.dir,fx.dir),source:'plan-writes',unit:'execute-task/T03',paths:[{root_id:'primary',path:'src/t03.js'}]});
    xllm.runExecute=async options=>{
      options.onBeforeSpawn?.();
      const child=spawn(process.execPath,[PROVIDER,'T03',fx.rendezvous,'','src/t03.js',String(options.model),String(options.effort),'90000','go','[]'],{cwd:options.cwd,env:xllm.buildSidecarEnv(options.envPolicy||'minimal'),stdio:['ignore','ignore','pipe'],windowsHide:true});
      let stderr='';child.stderr.on('data',data=>{stderr=(stderr+data).slice(-4000);});
      const joined=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
      options.announce?.('iniciado',{...options.identity,engine:options.engine,model_sent:options.model,effort:options.effort,host:options.hostRuntime,transport:options.engine==='claude'?'claude-cli':'app-server',pid:child.pid,provider_called:'unknown'});
      const close=await joined;assert.strictEqual(close.code,0,stderr);
      return {status:'done',summary:'T03 synthetic single delivery',files_changed:['src/t03.js'],must_haves_status:[]};
    };
    const request={...hostInputs('review-sequence-single',['T03']).T03,unitType:'execute-task',scope:'milestone',phase:'execute',milestoneId:M,sliceId:S,taskId:'T03',cwd:fx.dir,contextRoot:fx.dir,
      planFile,verification:verification('T03'),execution_contract:rootsApi.singleContract(fx.dir,fx.dir),runId:fx.scope.run_id,claim,route,begin_key:selected.controller_result.details.transaction.idempotency_key,
      lease_generation:selected.controller_result.details.transaction.generation};
    const sidecar=require('./forge-unit-sidecar');
    assert.throws(()=>sidecar.validateRecoveryRequest({...request,cwd:dirtyRoots[0],execution_contract:rootsApi.singleContract(fx.dir,dirtyRoots[0])}),/execution-member-handle-required/,'an ordinary unit cannot borrow retained member custody');
    assert.strictEqual(claims.ordinaryRetainedProjection(runs.get(fx.dir,fx.scope.run_id),claim.execution_contract),false,'the whole union cannot become ordinary writer authority');
    assert.throws(()=>sidecar.validateRecoveryRequest({...request,execution_contract:claim.execution_contract}),error=>error.code==='legacy-multiroot-refused','the existing earlier legacy-plan guard also rejects the broad contract');
    const delivered=await sidecar.runUnitSidecar(request);
    assert.strictEqual(delivered.status,'done');assert.strictEqual(readJson(request.resultFile+'.receipt.json').phase,'ready');
    const done=adapter.invoke('codex','auto','complete',{...ackInput(fx),result:delivered},selected.snapshot,{}).result;
    assert.strictEqual(done.outcome,'completed',JSON.stringify(done.controller_result));
    assert.strictEqual(lease.observe(fx.dir,'execute-task/T03').lease,null,'the single unit released its genuine lease');
    xllm.runExecute=cohortTransport;
    const next=adapter.invoke('codex','auto','next',ackInput(fx),done.snapshot,{}).result;
    write(path.join(TMP,'requests','review-sequence-next-observed.json'),JSON.stringify({fx:{label:fx.label,names:fx.names,dir:fx.dir,ids:fx.ids,scope:fx.scope,inputs:fx.inputs,report:fx.report,trust:fx.trust,journal:fx.journal,rendezvous:fx.rendezvous,plan:fx.plan},selected,request,done,next}));
    assert.strictEqual(next.action,'dispatch-batch');
    const data=next.controller_result.details.dispatch_batch;
    assert.deepStrictEqual(data.members.map(row=>row.unit.key),['execute-task/T04','execute-task/T05']);
    assert.notStrictEqual(data.batch_id,fx.ids.batch_id);
    const label='review-sequence-next',rendezvous=fs.mkdtempSync(path.join(TMP,label+'-rendezvous-'));
    const plan=write(path.join(TMP,label+'-providers.json'),JSON.stringify({rendezvous,members:{T04:GO,T05:GO}}));
    const journalFile=write(path.join(TMP,label+'-transport.jsonl'),'');
    secondFx={...fx,label,names:['T04','T05'],ids:{batch_id:data.batch_id,manifest_sha256:data.manifest_sha256,snapshot:next.snapshot},scope:{...fx.scope,batch_id:data.batch_id,manifest_sha256:data.manifest_sha256},rendezvous,plan,journal:journalFile,inputs:hostInputs(label,['T04','T05']),controls:new Map(),running:null};
    for(const id of secondFx.names)secondFx.inputs[id].verification=verification(id);
    write(path.join(TMP,'requests','review-sequence-before-second.json'),JSON.stringify({fx:{label:secondFx.label,names:secondFx.names,dir:secondFx.dir,ids:secondFx.ids,scope:secondFx.scope,inputs:secondFx.inputs,journal:secondFx.journal,rendezvous:secondFx.rendezvous,plan:secondFx.plan},previous:fx.scope,previous_claim:claim}));
    const ran=await within(start(secondFx),300000,'second cohort same run');assert(!ran.error,ran.error?.stack);secondFx.report=ran.value;
    assert.strictEqual(secondFx.report.barrier.sealed,true);secondFx.trust={directory:secondFx.report.broker.directory,manifest_sha256:secondFx.report.broker.manifest_sha256};
    const second=await consolidated(secondFx,'second cohort retirement');
    assert.strictEqual(second.retirement.status,'retired');assert.strictEqual(second.post_unit.status,'complete');
    const run=runs.get(fx.dir,fx.scope.run_id);assert.strictEqual(run.batch_locator,null);assert.strictEqual(run.batch_retirements.length,2);
    const secondIsolation=readJson(path.join(fx.dir,'.gsd/forge/batches',data.batch_id,'isolation.json'));
    assert.deepStrictEqual(secondIsolation.claim,run.write_claim,'actual held claim is the complete immutable union of this cohort');
    assert.strictEqual(secondIsolation.claim.execution_contract.code_roots.length,5,'one integration plus four physically distinct member roots');
    for(const root of claim.execution_contract.code_roots){const current=run.write_claim.execution_contract.code_roots.find(row=>row.identity_sha256===root.identity_sha256);assert(current);assert.deepStrictEqual(run.write_claim.root_baselines[current.id],claim.root_baselines[root.id],'historical baseline is preserved');}
    assert.strictEqual(runs.listAll(fx.dir).length,1,'no substitute run');
    for(const root of dirtyRoots)assert.strictEqual(batch.memberRootReservation(fx.dir,root).reserved,true);
    assert.deepStrictEqual(targetState(fx.dir),originalTarget,'no aggregate commit/index/HEAD mutation');
    assert.deepStrictEqual(controller.readEvents(controller.eventsFile(fx.dir,M)).filter(row=>row.action==='complete'&&row.unit.startsWith('execute-task/')).map(row=>row.unit),['execute-task/T01','execute-task/T02','execute-task/T03','execute-task/T04','execute-task/T05']);
  } finally {xllm.runExecute=cohortTransport;if(secondFx)await finish(secondFx);await finish(fx);}
});

test('review R18 post-unit queue waits for real ready memory and publishes canonical fragments exactly once after all ACKs', async () => {
  const fx = await retainedCohort('review-post-unit',PAIR,PAIR_GO);
  const memoryReceipts=[];
  const policyPrefs=()=>{ const p=require('./forge-prefs').readPrefs(fx.dir);assert(p.ok);return {...p,prefs:{...p.prefs,memory:{...p.prefs.memory,extraction:'always'}}}; };
  try {
    const spawned=spawnedCount(fx);
    const queued=await consolidated(fx,'post-unit queue',{prefsReader:policyPrefs});
    assert.strictEqual(queued.retirement.status,'retired');
    assert.strictEqual(queued.post_unit.status,'pending');
    assert(queued.post_unit.members.every(row=>row.status==='awaiting-memory'));
    assert.throws(()=>controller.beginSerial(fx.dir,{milestone:M,unit:'complete-slice/S01',slice:S,host_runtime:'codex',owner_token:TOKEN,idempotency_key:'before-post-unit'},{}),/batch-post-unit-pending/);
    const pendingView=batch.status(fx.scope);
    assert.strictEqual(pendingView.retirement.post_unit.status,'pending');
    const memory_publications={};
    const sidecar=require('./forge-unit-sidecar');
    const nativeRoute={host_runtime:'codex',worker_engine:'native',resolved_worker_engine:'native',worker_mode:'native',model:'gpt-6-luna',model_resolved:'gpt-6-luna',effort:'medium'};
    const telemetry={model_requested:null,model_resolved:'gpt-6-luna',model_argument:'gpt-6-luna',model_observed:null,model_observed_source:null,
      effort_requested:'medium',effort_resolved:'medium',effort_argument:'medium',effort_transport:'native-argument',effort_transport_value:'medium',
      effort_transport_source:'fixture-native-argument',effort_binding_observed:null,effort_binding_observed_source:null,effort_binding_observed_fingerprint:null,
      effort_applied:null,effort_applied_source:null,capabilities_source:'fixture'};
    for(const [index,id] of PAIR.entries()) {
      const ledger=queued.post_unit.members[index], ready=readJson(ledger.source.file),atTime=new Date().toISOString();
      const request={cwd:fx.dir,contextRoot:fx.dir,unitType:'memory-extract',sourceUnitType:'execute-task',sourceUnitId:id,milestoneId:M,
        workflowId:'fixture-post-unit',dispatchId:'post-memory-'+id,extractionId:'post-memory-'+id,extractedAt:atTime,
        sourceFingerprint:ledger.source.fingerprint,summaryContent:ready.artifacts.find(item=>item.path.endsWith('/'+id+'-SUMMARY.md')).content,sourceResult:JSON.stringify(ready.result),keyDecisions:[],existingMemory:{facts:[],stats:[]},
        route:nativeRoute,hostRuntime:'codex',resultFile:path.join(CHANNELS,'post-memory-'+id+'.json'),publicationSafe:false,
        publicationBoundary:{ownerJoined:true,checkedAt:atTime,protectedSnapshots:[{id:queued.retirement.retirement_id,state:'ended'}]},invocationTelemetry:telemetry};
      const extraction={schema_version:1,status:'done',summary:'Synthetic post-unit proof',questions:[],facts:[{local_id:'fact',category:'gotcha',text:'Preserve '+id+' custody.',confidence_base:0.8}],events:[]};
      const accepted=await sidecar.acceptNativeMemoryResult({...request,rawResult:extraction});
      assert.strictEqual(accepted.publication.status,'deferred','synthetic callback saves ready without owner publication');
      const receiptFile=request.resultFile+'.receipt.json',receiptHash=digest(fs.readFileSync(receiptFile));
      memoryReceipts.push([receiptFile,receiptHash]);
      const file=write(path.join(TMP,'requests','post-memory-'+id+'.json'),JSON.stringify({...request,publicationSafe:true}));
      memory_publications[id]={file,sha256:digest(fs.readFileSync(file))};
    }
    const interrupted=await consolidate(fx,{prefsReader:policyPrefs,memory_publications,failpoint:crashAt('post-unit-applied')});
    assert.strictEqual(interrupted.error?.code,'FIXTURE_CRASH','interrupt only after actual canonical fragment/event effects');
    const pending=reconciliation.readBatchEvidence(fx.trust);
    assert(Number.isSafeInteger(pending.operations.pending));
    assert.strictEqual(pending.surface.matches_operations,true,'the pending intent proves every publisher effect');
    const finished=await consolidated(fx,'post-unit canonical memory publication',{prefsReader:policyPrefs,memory_publications});
    assert.strictEqual(finished.post_unit.status,'complete');
    const events=fs.readFileSync(path.join(fx.dir,'.gsd/forge/events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    const housekeeping=events.filter(row=>row.post_unit_key);
    assert.deepStrictEqual(housekeeping.map(row=>row.event),['memory-policy','memory-policy','memory-publication','memory-publication']);
    assert.strictEqual(new Set(housekeeping.map(row=>row.event_id)).size,4);
    for(const id of PAIR) assert.strictEqual(require('./forge-memory').readFragment(fx.dir,id,{milestoneId:M}).facts.length,1);
    for(const [file,hash] of memoryReceipts) assert.strictEqual(digest(fs.readFileSync(file)),hash,'ready memory remains authentic and immutable');
    const before=fs.readFileSync(path.join(fx.dir,'.gsd/forge/events.jsonl'));
    const replay=await consolidated(fx,'post-unit immutable replay',{prefsReader:policyPrefs,memory_publications});
    assert.strictEqual(replay.historical_replay,true);
    assert.deepStrictEqual(fs.readFileSync(path.join(fx.dir,'.gsd/forge/events.jsonl')),before);
    assert.strictEqual(spawnedCount(fx),spawned,'no new execution inference in any consolidation');
    const unrelated=write(path.join(fx.dir,'.gsd','later-owner-note.md'),'later safe owner work\n');
    assert.strictEqual((await consolidated(fx,'historical facts after next owner boundary')).historical_replay,true);
    assert.strictEqual(fs.readFileSync(unrelated,'utf8'),'later safe owner work\n','historical fact read grants no writer or deletion');
    const queue=path.join(fx.dir,'.gsd/forge/batches',fx.ids.batch_id,'post-unit/m0.json'),bytes=fs.readFileSync(queue);
    fs.appendFileSync(queue,'foreign');
    await assert.rejects(()=>batch.consolidateCohort(fx.scope,{members:fx.inputs,broker_manifest_sha256:fx.trust.manifest_sha256}),/broker-operation-invalid/);
    fs.writeFileSync(queue,bytes);
  } finally { await finish(fx); }
});

(async () => {
  try {
    await runCases();
  } finally {
    console.log(`\n${passed} passed, ${failed} failed`);
    for (const [name, value] of Object.entries(SAVED_ENV)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best-effort cleanup of synthetic fixtures */ }
    if (failed) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
