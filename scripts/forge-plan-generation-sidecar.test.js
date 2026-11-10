#!/usr/bin/env node
'use strict';

// forge-plan-generation-sidecar.test.js — issue 343 U0c: strict admission of newly
// generated slice plans at the planner transport (forge-xllm runPlan: both engines and
// the Claude provisional finalizer) and at the owner sidecar publisher
// (forge-unit-sidecar), plus the read-only recheck of an enrolled generation
// immediately before a milestone execute-task spawn.
//
//   U0c-1 the Claude planner branch refuses missing declarations before success;
//   U0c-2 the app-server planner branch refuses missing declarations before success;
//   U0c-3 the owner publisher refuses stripped or tampered evidence before any artifact byte;
//   U0c-4 a valid candidate publishes and replays with zero provider calls; legacy ready
//         bytes are preserved;
//   U0c-5 a sidecar execute refuses an altered generation before spawn.
//   U0d   enrolled records come from the real native begin/complete (no
//         post-commit attach); the evidence is read only from the checksum-covered
//         completion.result; the marker binds the slice's open enrolled lineage; a
//         both-stripped known-new receipt refuses by that independent controller origin,
//         while a slice with no enrolled lineage keeps the explicit, tested unanchored
//         limit; the direct execute shares the native classification (open, ended,
//         corrupt, foreign, ambiguous) before any provider call.
//
// Provider stubs come from FORGE_XLLM_CLAUDE_BIN and FORGE_XLLM_CODEX_BIN and append
// every provider turn to one counter file outside every root; destination hashes are
// measured before and after each refusal. Only the account lookup is substituted:
// transports, controller, resolver, receipts and the publisher are real. Everything is
// synthetic and local: no provider, network or operator history.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-plan-generation-sidecar-')));
const providers = path.join(root, 'providers');
const calibrationHome = path.join(root, 'calibration');
const profile = path.join(root, 'profile');
fs.mkdirSync(providers);
fs.mkdirSync(calibrationHome);
fs.mkdirSync(profile);
const CALLS = path.join(providers, 'calls.txt');
const CLAUDE_BIN = path.join(providers, 'claude.js');
const CODEX_BIN = path.join(providers, 'codex-app-server.js');

function stageProcedures(destination) {
  const source = path.resolve(__dirname, '..');
  const { loadManifest, loadAllProcedureContexts } = require('./forge-procedure-context');
  const options = { cwd: source, forgeHome: source };
  const { manifest } = loadManifest(options);
  loadAllProcedureContexts(options);
  for (const relative of ['shared/forge-procedures.json', ...manifest.modules.filter(item => item.status === 'ready').map(item => item.path)]) {
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, relative), target);
  }
}

// A route depends only on its fixture, never on an operator's live routing table.
const savedEnv = { FORGE_HOME: process.env.FORGE_HOME, FORGE_XLLM_CLAUDE_BIN: process.env.FORGE_XLLM_CLAUDE_BIN,
  FORGE_XLLM_CODEX_BIN: process.env.FORGE_XLLM_CODEX_BIN };
process.env.FORGE_HOME = path.join(root, 'forge-home');
fs.mkdirSync(process.env.FORGE_HOME);
stageProcedures(process.env.FORGE_HOME);
fs.writeFileSync(path.join(process.env.FORGE_HOME, 'forge-agent-prefs.jsonc'), '{}\n');
process.env.FORGE_XLLM_CLAUDE_BIN = CLAUDE_BIN;
process.env.FORGE_XLLM_CODEX_BIN = CODEX_BIN;

// The Claude stub: the version probe never counts; every other launch is one provider
// turn that returns the payload file's candidate with the requested model proved.
fs.writeFileSync(CLAUDE_BIN, String.raw`'use strict';
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('2.1.310 (Claude Code)\n'); process.exit(0); }
fs.appendFileSync(path.join(__dirname, 'calls.txt'), 'claude\n');
const payload = JSON.parse(fs.readFileSync(path.join(__dirname, 'claude-payload.json'), 'utf8'));
const candidate = payload.candidate;
const model = args[args.indexOf('--model') + 1];
const sessionAt = args.indexOf('--session-id');
if (sessionAt >= 0) process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: args[sessionAt + 1] }) + '\n');
const block = ['---GSD-WORKER-RESULT---', 'status: ' + candidate.status, 'result_json: ' + JSON.stringify(candidate), '---END-RESULT---'].join('\n');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: candidate, result: block,
  usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { [model]: { inputTokens: 1, outputTokens: 1 } } }) + '\n');
if (payload.linger) setTimeout(() => {}, 1000);
`);
// The app-server stub speaks the measured codex-cli shape; each turn is one provider turn.
fs.writeFileSync(CODEX_BIN, String.raw`'use strict';
const fs = require('fs');
const path = require('path');
let initialized = false;
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  pending += chunk;
  let end;
  while ((end = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, end); pending = pending.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      send({ id: message.id, result: { userAgent: 'codex-cli/0.144.4 (Mac OS 26.5.2; arm64)', codexHome: '/h',
        platformFamily: 'mac', platformOs: 'Mac OS 26.5.2' } });
    } else if (message.method === 'initialized') initialized = true;
    else if (message.method === 'thread/start') {
      if (!initialized) process.exit(92);
      send({ id: message.id, result: { thread: { id: 't1', cliVersion: '0.144.4' } } });
    } else if (message.method === 'turn/start') {
      if (!initialized) process.exit(93);
      fs.appendFileSync(path.join(__dirname, 'calls.txt'), 'codex\n');
      const text = fs.readFileSync(path.join(__dirname, 'codex-payload.json'), 'utf8');
      send({ id: message.id, result: { turn: { id: 'turn-1' } } });
      send({ method: 'item/completed', params: { item: { type: 'agentMessage', phase: 'final_answer', text } } });
      send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
    }
  }
});
setInterval(() => {}, 1000);
`);

const accounts = require('./forge-accounts');
const originalLookup = accounts.resolveLaunch;
accounts.resolveLaunch = () => ({ name: 'fixture', token: 'fixture-only-never-a-real-account' });
delete require.cache[require.resolve('./forge-claude-sidecar')];
const claude = require('./forge-claude-sidecar');
// The real watchdog, armed only for the provisional case (forge-claude-provisional.test.js):
// after the terminal arrives the clock jumps, the lingering child is captured, not killed.
const originalInvoke = claude.invokeClaudeSidecar;
const watchdog = { armed: false, terminalSeen: false, child: null };
claude.invokeClaudeSidecar = options => (watchdog.armed ? originalInvoke({ ...options, timeoutMs: 20000,
  monotonicClock: () => performance.now() + (watchdog.terminalSeen ? 4000000 : 0), livenessIntervalMs: 10,
  onProgress: snapshot => { options.onProgress?.(snapshot); if (snapshot.phase === 'terminal') watchdog.terminalSeen = true; },
  terminateChild: owned => { watchdog.child = owned; }, terminationWaitMs: 0 }) : originalInvoke(options));
const xllm = require('./forge-xllm');
const unit = require('./forge-unit-sidecar');
const pv = require('./forge-plan-validation');
const codeRoots = require('./forge-code-roots');
const controller = require('./forge-unit-controller');
const state = require('./forge-state');
const repair = require('./forge-repair');
const provisional = require('./forge-claude-provisional');
const { resolveDispatch } = require('./forge-dispatch-resolve');

const M = 'M001';
const S = 'S01';
const prefsReader = () => ({ ok: true, prefs: { workflow: { skip_discuss: true, skip_research: true } } });
const PREFS = { routing: { default: { planner: { heavy: ['claude-opus-5'], max: ['claude-fable-5'] }, executor: { standard: ['claude-sonnet-5'] } } },
  tier_models: { standard: 'claude-sonnet-5', heavy: 'claude-opus-5', max: 'claude-fable-5' },
  effort: { 'plan-slice': 'medium', 'execute-task': 'medium' } };

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
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
// The sidecar's canonical record digest (sorted keys), to reseal deliberate forgeries.
function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]));
}
function canonicalDigest(value) { return sha(JSON.stringify(canonicalJson(value))); }
function resealMarker(marker) { const { marker_sha256: ignored, ...body } = marker; return { ...body, marker_sha256: canonicalDigest(body) }; }
function resealEvidence(evidence) { const { validation_sha256: ignored, ...body } = evidence; return { ...body, validation_sha256: canonicalDigest(body) }; }
function calls() { return fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean).length : 0; }
function claudeReturns(candidate, options = {}) {
  fs.writeFileSync(path.join(providers, 'claude-payload.json'), JSON.stringify({ candidate, linger: options.linger === true }));
}
function codexReturns(candidate) { fs.writeFileSync(path.join(providers, 'codex-payload.json'), JSON.stringify(candidate)); }
function hashes(files) { return files.map(file => (fs.existsSync(file) ? sha(fs.readFileSync(file)) : null)); }
// Child processes inherit the staged FORGE_HOME and stubs, with a private profile.
function childEnv() { return { ...process.env, HOME: profile, USERPROFILE: profile }; }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
async function refusal(promise) {
  try { await promise; } catch (error) { return error; }
  throw new Error('expected a refusal, got a result');
}

// ── Synthetic plans ───────────────────────────────────────────────────────────

// A new task plan with the structured must_haves the strict product parser admits.
// `depends` is the frontmatter line (null omits it); `writes: null` omits the writes key.
function taskPlan(id, options = {}) {
  const file = options.file || `src/${id.toLowerCase()}.js`;
  const lines = ['---', 'tier: standard', ...(options.capability ? [`capability: ${options.capability}`] : [])];
  if (options.depends !== null) lines.push(options.depends || 'depends: []');
  if (options.writes !== null) lines.push('writes:', `  - "${file}"`);
  lines.push('must_haves:', '  truths:', `    - "${id} fixture behavior is observable"`, '  artifacts:', `    - path: "${file}"`,
    '      provides: "fixture module"', '      min_lines: 1', '  key_links: []', 'expected_output:', `  - ${file}`,
    '---', '', `# ${id}: Fixture task`, '', 'Prose never counts as a declaration.', '');
  return lines.join('\n');
}
// The S-plan task list in the forge-status parsePlanTasks grammar.
function slicePlan(ids) {
  return [`# ${S}: Fixture slice`, '', '## Tasks', '', ...ids.map(id => `- [ ] **${id}**: ${id} fixture task`), '', 'Slice prose.', ''].join('\n');
}
function candidate(plans) {
  const ids = Object.keys(plans);
  return { status: 'done', summary: 'Synthetic slice plan.', slice_plan: { filename: `${S}-PLAN.md`, content: slicePlan(ids) },
    task_plans: ids.map(id => ({ id, filename: `${id}-PLAN.md`, content: plans[id] })) };
}
const VALID = () => candidate({ T01: taskPlan('T01'), T02: taskPlan('T02', { depends: 'depends: [T01]' }) });
const MISSING_DEPENDS = () => candidate({ T01: taskPlan('T01'), T02: taskPlan('T02', { depends: null }) });
const MISSING_WRITES = () => candidate({ T01: taskPlan('T01', { writes: null }) });

// ── Owner fixtures ────────────────────────────────────────────────────────────

let sequence = 0;
function gitRepo(dir) {
  for (const args of [['init', '-q'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']]) {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
    assert.strictEqual(result.status, 0, result.stderr);
  }
}
// One owner that is also the CODE_DIR (a Git work tree), as the bidirectional suite uses.
function owner(label) {
  const dir = path.join(root, `${label}-${++sequence}`);
  fs.mkdirSync(path.join(dir, '.gsd', 'milestones', M), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gsd', 'forge-prefs.jsonc'), JSON.stringify(PREFS));
  fs.writeFileSync(path.join(dir, '.gsd', 'milestones', M, `${M}-ROADMAP.md`), '# Roadmap\n\n- [ ] **S01: Work** `depends:[]`\n');
  fs.writeFileSync(path.join(dir, '.gsd', 'milestones', M, `${M}-CONTEXT.md`), '# Decisions\n');
  gitRepo(dir);
  return dir;
}
function sliceDir(dir) { return path.join(dir, '.gsd', 'milestones', M, 'slices', S); }
function taskFile(dir, id) { return path.join(sliceDir(dir), 'tasks', id, `${id}-PLAN.md`); }
function planTargets(dir, ids = ['T01', 'T02']) { return [path.join(sliceDir(dir), `${S}-PLAN.md`), ...ids.map(id => taskFile(dir, id))]; }
function publishPlan(dir, plan) {
  fs.mkdirSync(sliceDir(dir), { recursive: true });
  fs.writeFileSync(path.join(sliceDir(dir), `${S}-PLAN.md`), plan.slice_plan.content);
  for (const task of plan.task_plans) {
    fs.mkdirSync(path.dirname(taskFile(dir, task.id)), { recursive: true });
    fs.writeFileSync(taskFile(dir, task.id), task.content);
  }
}
function planRequest(dir, label) {
  const id = `${label}-${++sequence}`;
  const promptFile = path.join(root, `prompt-${id}.md`);
  fs.writeFileSync(promptFile, '# Selected unit\nPlan the synthetic fixture slice only.\n');
  return { unitType: 'plan-slice', scope: 'milestone', phase: 'plan', milestoneId: M, sliceId: S,
    cwd: dir, contextRoot: dir, route: resolveDispatch({ cwd: dir, unitType: 'plan-slice', hostRuntime: 'codex', milestoneId: M, unitId: S }),
    workflowId: `workflow-${id}`, dispatchId: `dispatch-${id}`, resultFile: path.join(root, `result-${id}.json`),
    constraints: { auto_commit: false, deploy: false }, promptFile };
}
function executeRequest(dir, label) {
  const id = `${label}-${++sequence}`;
  const promptFile = path.join(root, `prompt-${id}.md`);
  fs.writeFileSync(promptFile, '# Selected unit\nExecute the synthetic fixture task only.\n');
  const planFile = taskFile(dir, 'T01');
  return { unitType: 'execute-task', scope: 'milestone', phase: 'execute', milestoneId: M, sliceId: S, taskId: 'T01',
    cwd: dir, contextRoot: dir, planFile,
    route: resolveDispatch({ cwd: dir, unitType: 'execute-task', hostRuntime: 'codex', milestoneId: M, unitId: 'T01', planPath: planFile }),
    workflowId: `workflow-${id}`, dispatchId: `dispatch-${id}`, resultFile: path.join(root, `result-${id}.json`),
    constraints: { auto_commit: false, deploy: false }, promptFile };
}
function runtime(extra = {}) { return { calibrationOptions: { userHome: calibrationHome }, ...extra }; }
function receiptOf(request) { return readJson(`${request.resultFile}.receipt.json`); }
// The controller's record checksum (sha256 of the sorted-key JSON), to recompose a deliberate
// self-consistent forgery of a stored controller record.
function recordDigest(value) { return canonicalDigest(value); }
// Rewrites one stored controller record through the controller's own writer. Used ONLY for
// named forgeries: every genuine record below comes from the real native begin/complete.
function rewriteRecord(dir, key, mutate) {
  const record = JSON.parse(JSON.stringify(controller.lookupRecord(dir, 'transaction', key)));
  mutate(record);
  controller.writeAtomic(controller.transactionFile(dir, key), record);
}
function controllerRequest(extra) { return { milestone: M, unit: `plan-slice/${S}`, host_runtime: 'claude', session: 'session-neutral', ...extra }; }
// Issue 343 U0d: the real native begin enrolls itself; the suite only reads that enrollment.
function beginPlanSlice(dir, key) {
  state.write(dir, { milestone: M, kind: 'milestone', phase: 'plan-slice', active_slice: S, active_task: '—', next_action: 'plan', auto_mode: 'on' });
  const begun = controller.begin(dir, controllerRequest({ owner_token: `owner-${key}`, idempotency_key: key }), { prefsReader });
  assert.strictEqual(begun.ok, true, JSON.stringify(begun));
  const record = controller.lookupRecord(dir, 'transaction', key);
  const enrollment = { owner: fs.realpathSync.native(dir), milestone: M, slice: S, begin_key: key,
    lease_generation: record.lease_generation, owner_digest: record.owner_digest };
  assert.deepStrictEqual(record[pv.TRANSACTION_FIELDS.generation], JSON.parse(JSON.stringify(pv.buildPlanGeneration(enrollment))),
    'the real begin carries its own enrollment');
  return { begun, enrollment, generation: record[pv.TRANSACTION_FIELDS.generation] };
}
// Explicit historical OldSchema fixture, derived from public 1da8887's
// makeTransaction/defaultStatePatch begin shape. This is synthetic test data,
// never a production source anchor, ancient timestamp or stripped current begin.
// Lease/storage/readback/checksums are real; no current begin is created/de-enrolled.
function historicalNativeBeginFixture(dir, key) {
  const leaseApi = require('./forge-unit-lease'), ownerToken = 'old-schema-' + key;
  const held = leaseApi.acquire(dir, 'plan-slice/' + S, { host_runtime: 'claude', owner_token: ownerToken, session: 'old-schema-test' });
  assert.strictEqual(held.ok, true);
  const now = new Date().toISOString(), unitKey = { type: 'plan-slice', id: S, key: 'plan-slice/' + S };
  const before = { milestone: M, kind: 'milestone', phase: 'plan-slice', active_slice: S, active_task: '—', next_action: 'plan', auto_mode: 'on' };
  state.write(dir, before);
  const ownerDigest = 'sha256:' + sha(ownerToken);
  const patch = { phase: 'plan-slice', active_task: '—', host_runtime: 'claude', owner: ownerDigest, heartbeat: now };
  const after = { ...before, ...patch };
  const logicalBefore = controller.logicalState(state.read(dir, M)), logicalAfter = controller.logicalState(after);
  const event = { protocol_version: controller.PROTOCOL_VERSION, idempotency_key: key, ts: now,
    event: 'unit-began', action: 'begin', unit: unitKey.key, milestone: M, host_runtime: 'claude', outcome: 'running', reason_code: 'begin' };
  const record = { protocol_version: controller.PROTOCOL_VERSION, idempotency_key: key, action: 'begin', unit: unitKey,
    milestone: M, host_runtime: 'claude', owner_digest: ownerDigest, lease_generation: held.generation, phase: 'committed',
    created_at: now, updated_at: now, before: { state_checksum: recordDigest(logicalBefore), state: logicalBefore },
    after: { state_checksum: recordDigest(logicalAfter), state: logicalAfter, state_patch: patch }, result: null, event, boundary: null };
  controller.writeAtomic(controller.transactionFile(dir, key), record);
  controller.writeAtomic(controller.eventsFile(dir, M), JSON.stringify({ ...event, sequence: 1 }) + '\n', true);
  state.write(dir, after);
  assert.deepStrictEqual(controller.lookupRecord(dir, 'transaction', key), record);
  assert.strictEqual(controller.incompleteUnits(dir, M).length, 1);
  assert.strictEqual(pv.classifySliceGeneration(dir, { milestone: M, slice: S }).status, 'unenrolled');
  return { begun: held, record };
}
// The real native completion of that begin: the controller admits the owner plan files and
// writes plan_validation inside the committed result (no post-commit attach).
function completePlanSlice(dir, seam, key) {
  const completed = controller.complete(dir, controllerRequest({ owner_token: seam.begun.owner_token, generation: seam.begun.generation,
    idempotency_key: key, result: { status: 'succeeded', summary: 'planned' } }), { prefsReader });
  assert.strictEqual(completed.transaction.phase, 'committed');
  return controller.lookupRecord(dir, 'transaction', key);
}
// A pre-requirement (old-format) ready receipt of one request, built explicitly: historical
// bytes without depends/writes, never backfilled, and no owner plan records.
function legacyReceipt(request, ids = ['T01']) {
  const loc = unit.locations(request);
  const legacyTask = taskPlan('T01', { depends: null, writes: null });
  const legacySlice = '# S01: Historical slice\n\n- [ ] **T01**: historical task\n';
  const artifacts = [{ path: loc.required[0], content: legacySlice, before: null },
    ...ids.map(id => ({ path: `${loc.slice}/tasks/${id}/${id}-PLAN.md`, content: legacyTask, before: null }))];
  const record = { phase: 'ready', fingerprint: unit.artifactFingerprint(request), dispatch_id: request.dispatchId,
    before: Object.fromEntries(artifacts.map(item => [item.path, null])), started_at: '2026-11-01T00:00:00.000Z', route: request.route,
    input_pending_questions: [], request_fingerprint: null, preparation_identity: null,
    result: { status: 'done', protocol_version: 2, summary: 'Historical slice plan.',
      slice_plan: { filename: 'S01-PLAN.md', content: legacySlice },
      task_plans: [{ id: 'T01', filename: 'T01-PLAN.md', content: legacyTask }],
      dispatch_id: request.dispatchId, workflow_id: request.workflowId, host_runtime: 'codex', worker_engine: 'claude' },
    route_identity: unit.routeIdentity(request.route, request.unitType), provider_called: true,
    telemetry: { model_requested: null, model_resolved: request.route.model_resolved || null }, artifacts };
  return { record, legacySlice, legacyTask };
}

const transportRepo = path.join(root, 'transport-repo');
fs.mkdirSync(transportRepo);
gitRepo(transportRepo);
const planContext = path.join(root, 'plan-context.md');
fs.writeFileSync(planContext, '# Plan context\n\nPlan the synthetic fixture slice only.\n');
function claudePlan(label, extra = {}) {
  const resultFile = path.join(root, `transport-claude-${label}.json`);
  return { resultFile, run: xllm.runPlan({ engine: 'claude', hostRuntime: 'codex', sidecarDeclared: true, model: 'claude-sonnet-5',
    effort: 'medium', envPolicy: 'minimal', timeoutSecs: 30, cwd: transportRepo, planContextFile: planContext, resultFile,
    dispatchId: `u0c-claude-${label}`, calibrationOptions: { userHome: calibrationHome }, ...extra }) };
}
function codexPlan(label) {
  const resultFile = path.join(root, `transport-codex-${label}.json`);
  return { resultFile, run: xllm.runPlan({ cwd: transportRepo, planContextFile: planContext, resultFile, timeoutSecs: 10,
    dispatchId: `u0c-codex-${label}` }) };
}
function assertAdmissionRefusal(error, code, label) {
  assert.strictEqual(error.code, code, `${label}: ${error.message}`);
  assert.strictEqual(error.provider_called, true, `${label}: the planner was already contacted`);
  assert.strictEqual(error.stage, 'plan-admission', `${label}: the named admission stage`);
}

// ── U0c-1 / U0c-2: the planner transport ──────────────────────────────────────

function nativeFixture(label, options = {}) {
  const native = require('./forge-native-invocation');
  const dir = owner('native346-' + label), content = taskPlan('T01');
  fs.mkdirSync(path.dirname(taskFile(dir, 'T01')), { recursive: true });fs.writeFileSync(taskFile(dir, 'T01'), content);
  const route = resolveDispatch({ cwd: dir, unitType: 'plan-slice', hostRuntime: options.sidecar ? 'codex' : 'claude', milestoneId: M, unitId: S });
  const capabilities = { available: true, tool: 'Agent', source: 'synthetic-active-schema-fixture', model_aliases: ['opus', 'sonnet'], model_ids: [route.model, 'claude-sonnet-5'], effort_transports: ['agent-argument'], reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'] };
  const invokeOptions = { hostRuntime: 'claude', resolvedDispatch: route, activeCapabilities: capabilities, agentType: 'forge-planner', prompt: 'Synthetic existing native plan.', terminalResult: xllm.validatePlanResult };
  if (!options.sidecar) assert.strictEqual(native.preflightNativeBinding(invokeOptions).ok, true);
  const seam = options.noBegin ? null : options.historical
    ? historicalNativeBeginFixture(dir, 'native346-' + label) : beginPlanSlice(dir, 'native346-' + label);
  const request = { unitType: 'plan-slice', scope: 'milestone', phase: 'plan', milestoneId: M, sliceId: S, cwd: dir, contextRoot: dir,
    execution_contract: codeRoots.singleContract(dir, dir), hostRuntime: route.host_runtime, activeCapabilities: capabilities, route,
    workflowId: 'native346-' + label, dispatchId: 'native346-' + label, resultFile: path.join(root, 'native346-' + label + '.json') };
  if (!options.noAttempt) unit.beginArtifactAttempt(request);
  const response = { status: 'done', summary: 'Synthetic native plan.', questions: [], artifacts: [{ path: unit.locations(request).required[0], content: content + '\n' + slicePlan(['T01']) }] };
  return { dir, content, request, seam, response, invokeOptions };
}

async function main() {
  await test('issue343 native346 facade admits existing native plans and refuses imported authority or changed sources', async () => {
    const native = require('./forge-native-invocation');
    const originalCalls = calls(), good = nativeFixture('good');let hostCalls = 0;
    const returned = await native.invokeNative(good.invokeOptions, async args => { hostCalls++;assert.strictEqual(args.model, good.request.route.model);assert.strictEqual(args.effort, good.request.route.effort);return { ...candidate({ T01: good.content }), slice_plan: { filename: 'S01-PLAN.md', content: good.response.artifacts[0].content } }; });
    assert.strictEqual(returned.ok, true);assert.strictEqual(hostCalls, 1);
    assert.strictEqual(good.response.artifacts[0].content, returned.result.slice_plan.content, 'publish exactly the same validated native return, no host enrichment');
    const metadata = { providerCalled: true, telemetry: returned.telemetry };
    // Owner fields from an imported worker object cannot enable publication.
    await assert.rejects(unit.acceptArtifactResult(good.request, { ...good.response, native_plan_admission: { approved: true } }, metadata), error => error.code === 'plan-generation-marker-untrusted');
    assert.strictEqual(fs.existsSync(planTargets(good.dir, ['T01'])[0]), false);
    const invalidTask = good.content.replace(/^depends:.*\n/m, '');fs.writeFileSync(taskFile(good.dir, 'T01'), invalidTask);
    const beforeInvalid = hashes(planTargets(good.dir, ['T01']));
    await assert.rejects(unit.acceptArtifactResult(good.request, good.response, metadata), error => error.code === 'plan-declaration-depends-missing');
    assert.deepStrictEqual(hashes(planTargets(good.dir, ['T01'])), beforeInvalid, 'admission refusal writes no owner plan bytes');
    fs.writeFileSync(taskFile(good.dir, 'T01'), good.content);
    const published = await unit.acceptArtifactResult(good.request, good.response, metadata);
    assert.strictEqual(published.record.phase, 'ready');assert.strictEqual(hostCalls, 1, 'same saved native response, no second invocation');
    assert.strictEqual(fs.readFileSync(planTargets(good.dir, ['T01'])[0], 'utf8'), good.response.artifacts[0].content);
    assert(published.record.native_plan_admission);assert(!Object.hasOwn(published.record, 'plan_generation'), 'post-return admission never fabricates a started sidecar marker');
    const receiptPath = good.request.resultFile + '.receipt.json', originalReceipt = fs.readFileSync(receiptPath);
    const stripped = JSON.parse(originalReceipt);delete stripped.native_plan_admission;fs.writeFileSync(receiptPath, JSON.stringify(stripped));
    const beforeStripped = hashes(planTargets(good.dir, ['T01']));
    await assert.rejects(unit.replayArtifactAttempt(good.request), error => error.code === 'plan-generation-marker-missing');
    assert.deepStrictEqual(hashes(planTargets(good.dir, ['T01'])), beforeStripped, 'an enrolled begin never becomes legacy by deleting the new proof');fs.writeFileSync(receiptPath, originalReceipt);
    const forged = JSON.parse(originalReceipt);forged.native_plan_admission.begin_checksum = '0'.repeat(64);fs.writeFileSync(receiptPath, JSON.stringify(forged));
    const beforeForged = hashes(planTargets(good.dir, ['T01']));
    await assert.rejects(unit.replayArtifactAttempt(good.request), error => error.code === 'plan-validation-invalid');
    assert.deepStrictEqual(hashes(planTargets(good.dir, ['T01'])), beforeForged);fs.writeFileSync(receiptPath, originalReceipt);
    fs.writeFileSync(taskFile(good.dir, 'T01'), good.content.replace('fixture behavior is observable', 'changed original goal'));
    await assert.rejects(unit.replayArtifactAttempt(good.request), error => error.code === 'plan-validation-source-mismatch');
    assert(fs.readFileSync(receiptPath).equals(originalReceipt));fs.writeFileSync(taskFile(good.dir, 'T01'), good.content);
    const completed = completePlanSlice(good.dir, good.seam, 'native346-good-complete');assert(completed.result.plan_validation);
    await unit.replayArtifactAttempt(good.request);assert(fs.readFileSync(receiptPath).equals(originalReceipt), 'ready replay is byte-preserving');
    const noBegin = nativeFixture('no-begin', { noBegin: true }), noBeginBefore = hashes(planTargets(noBegin.dir, ['T01']));
    await assert.rejects(unit.acceptArtifactResult(noBegin.request, noBegin.response, { providerCalled: true }), error => error.code === 'plan-generation-begin-invalid');
    assert.deepStrictEqual(hashes(planTargets(noBegin.dir, ['T01'])), noBeginBefore);
    const sidecar = nativeFixture('sidecar', { sidecar: true }), sidecarBefore = hashes(planTargets(sidecar.dir, ['T01']));
    await assert.rejects(unit.acceptArtifactResult(sidecar.request, sidecar.response, { providerCalled: true }), error => error.code === 'plan-generation-transport-required');
    assert.deepStrictEqual(hashes(planTargets(sidecar.dir, ['T01'])), sidecarBefore);
    const historical = nativeFixture('historical', { historical: true });
    const oldTask = taskPlan('T01', { depends: null, writes: null });
    fs.writeFileSync(taskFile(historical.dir, 'T01'), oldTask);
    // The old native facade publishes only its returned S-plan artifact. Existing
    // old task bytes deliberately fail current declarations and remain untouched.
    assert.throws(() => require('./forge-must-haves').validateTaskDeclarations(oldTask, { taskId: 'T01', requireExplicit: true }), error => error.code === 'plan-declaration-depends-missing');
    const oldResult = await unit.acceptArtifactResult(historical.request, historical.response, { providerCalled: true });
    assert.strictEqual(oldResult.record.phase, 'ready');
    assert(!Object.hasOwn(oldResult.record, 'native_plan_admission'));
    assert(!Object.hasOwn(oldResult.record, 'plan_generation'));
    assert.strictEqual(fs.readFileSync(taskFile(historical.dir, 'T01'), 'utf8'), oldTask);
    const historicalBytes = fs.readFileSync(historical.request.resultFile + '.receipt.json');
    await unit.replayArtifactAttempt(historical.request);
    assert(fs.readFileSync(historical.request.resultFile + '.receipt.json').equals(historicalBytes), 'old ready bytes are not backfilled');
    const lostLease = nativeFixture('historical-lost-lease', { historical: true }), beforeLostLease = hashes(planTargets(lostLease.dir, ['T01']));
    const leaseApi = require('./forge-unit-lease');
    assert(leaseApi.release(lostLease.dir, 'plan-slice/' + S, lostLease.seam.begun.owner_token, lostLease.seam.begun.generation).ok);
    assert(leaseApi.acquire(lostLease.dir, 'plan-slice/' + S, { host_runtime: 'claude', owner_token: 'foreign-old-schema-owner' }).ok);
    await assert.rejects(unit.acceptArtifactResult(lostLease.request, lostLease.response, { providerCalled: true }), error => error.code === 'plan-generation-begin-invalid');
    assert.deepStrictEqual(hashes(planTargets(lostLease.dir, ['T01'])), beforeLostLease);
    assert.strictEqual(calls(), originalCalls, 'native compatibility uses no sidecar provider');
  });
  await test('issue343 native346 saved admission and historical begin reconcile through the original facade without inference', async () => {
    const api = require('./forge-artifact-reconciliation'), native = require('./forge-native-invocation');
    const originalCalls = calls();
    for (const historical of [false, true]) {
      const label = historical ? 'reconcile-historical' : 'reconcile-enrolled';
      const f = nativeFixture(label, { historical, noAttempt: true });
      const fingerprint = unit.artifactFingerprint(f.request);
      const broker = await api.startBroker({ owner: f.dir, manifestFile: path.join(root, label + '-manifest.json'),
        dispatchId: f.request.dispatchId, request_sha256: fingerprint, execution_contract: f.request.execution_contract });
      f.request.ownerBroker = broker;
      try {
        unit.beginArtifactAttempt(f.request);
        let nativeCalls = 0;
        const outcome = await native.invokeNative(f.invokeOptions, async () => {
          nativeCalls++;
          return { ...candidate({ T01: f.content }), slice_plan: { filename: 'S01-PLAN.md', content: f.response.artifacts[0].content } };
        });
        assert.strictEqual(outcome.ok, true);assert.strictEqual(nativeCalls, 1);
        assert.strictEqual(f.response.artifacts[0].content, outcome.result.slice_plan.content, 'saved artifacts are exactly the original validated native return');
        await broker.append('.gsd/forge/events.jsonl', JSON.stringify({ event: 'synthetic-owner-progress', label }) + '\n');
        const responseAnchor = await broker.bindResponse(f.response);
        const withoutBroker = { ...f.request };delete withoutBroker.ownerBroker;
        await assert.rejects(unit.acceptArtifactResult(withoutBroker, f.response,
          { providerCalled: true, telemetry: outcome.telemetry, enforceReadOnlySurface: true, responseAnchor }), error => error.code === 'artifact-direct-write-detected');
        unit.failArtifactAttempt(f.request, 'artifact-direct-write-detected', 'synthetic signed owner append', true);
        const receiptFile = f.request.resultFile + '.receipt.json', original = fs.readFileSync(receiptFile), saved = JSON.parse(original);
        assert.strictEqual(saved.phase, 'failed');assert(saved.saved_candidate);
        assert.strictEqual(Object.hasOwn(saved, 'native_plan_admission'), !historical);
        const options = { manifest: broker.manifest, proofs: broker.proofs(), trust: { manifest_sha256: broker.manifest_sha256, request_sha256: fingerprint } };
        await broker.close();
        const before = hashes(planTargets(f.dir, ['T01']));
        if (!historical) {
          const stripped = JSON.parse(original);delete stripped.native_plan_admission;fs.writeFileSync(receiptFile, JSON.stringify(stripped));
          await assert.rejects(unit.reconcileArtifactAttempt(f.request, options), error => error.code === 'plan-generation-marker-missing');
          assert.deepStrictEqual(hashes(planTargets(f.dir, ['T01'])), before, 'enrolled missing admission publishes zero bytes');
          fs.writeFileSync(receiptFile, original);
        }
        await assert.rejects(unit.reconcileArtifactAttempt(f.request, { ...options,
          beforePublish() { fs.writeFileSync(receiptFile, JSON.stringify({ ...saved, synthetic_receipt_race: true })); } }),
          error => error.code === 'reconciliation-receipt-raced');
        assert.deepStrictEqual(hashes(planTargets(f.dir, ['T01'])), before, 'raced parent receipt publishes zero bytes');fs.writeFileSync(receiptFile, original);
        const recovered = await unit.reconcileArtifactAttempt(f.request, options);
        assert.strictEqual(recovered.provider_called, false);assert.strictEqual(recovered.replayed, true);
        assert.strictEqual(nativeCalls, 1, 'saved response is recovered with no native reinvocation');
        assert(fs.readFileSync(receiptFile).equals(original), 'failed parent receipt remains byte-identical');
        assert.strictEqual(fs.readFileSync(planTargets(f.dir, ['T01'])[0], 'utf8'), f.response.artifacts[0].content);
        const replay = await unit.reconcileArtifactAttempt(f.request, options);
        assert.strictEqual(replay.child_receipt, recovered.child_receipt);
        assert(fs.readFileSync(receiptFile).equals(original));
      } finally { await broker.close(); }
    }
    assert.strictEqual(calls(), originalCalls, 'reconciliation never invokes a synthetic sidecar provider');
  });
  await test('issue343 U0c-1 Claude planner branch refuses missing declarations before success', async () => {
    for (const [label, plan, code] of [['depends', MISSING_DEPENDS(), 'plan-declaration-depends-missing'],
      ['writes', MISSING_WRITES(), 'plan-declaration-writes-missing']]) {
      claudeReturns(plan);
      const before = calls(), call = claudePlan(`missing-${label}`);
      assertAdmissionRefusal(await refusal(call.run), code, `Claude missing ${label}`);
      assert.strictEqual(calls(), before + 1, `Claude missing ${label}: exactly one provider turn`);
      const written = readJson(call.resultFile);
      assert.strictEqual(written.status, 'running', `Claude missing ${label}: no success result-file (${written.status})`);
      assert(Number.isInteger(written.output_tokens), 'the spent output tokens stay recorded');
    }
    claudeReturns(VALID());
    const before = calls(), control = claudePlan('valid');
    const result = await control.run;
    assert.deepStrictEqual([result.status, readJson(control.resultFile).status, calls()], ['done', 'done', before + 1], 'explicit declarations pass the same branch');
  });

  await test('issue343 U0c-1 the Claude provisional finalizer applies the same refusal without a second inference', async () => {
    claudeReturns(MISSING_DEPENDS(), { linger: true });
    watchdog.armed = true; watchdog.terminalSeen = false; watchdog.child = null;
    const call = claudePlan('provisional', { provisionalStoreRoot: path.join(root, 'provisional-store') });
    let failure;
    try { failure = await refusal(call.run); } finally { watchdog.armed = false; }
    assert(provisional.describe(failure)?.private_ref, `the real watchdog retains the terminal (code=${failure.code})`);
    assert(watchdog.child && watchdog.terminalSeen, 'the watchdog fired after the terminal result');
    await new Promise(resolve => {
      const child = watchdog.child;
      if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('close', resolve);
    });
    const before = calls();
    const stopped = observed => observed === watchdog.child && watchdog.child.exitCode === 0;
    const live = { assertCurrent: () => true,
      proveStopped: observed => ({ child: observed, process_stopped: stopped(observed), descendants_stopped: stopped(observed) }),
      reconcileRoot: identity => ({ root_id: identity.root_id, process_stopped: true, reconciled: true, original_snapshot_preserved: true }) };
    assertAdmissionRefusal(await refusal(provisional.resume(failure, live)), 'plan-declaration-depends-missing', 'provisional finalizer');
    assert.strictEqual(calls(), before, 'the finalizer reuses the retained output: zero second inference');
    assert.notStrictEqual(readJson(call.resultFile).status, 'done', 'no success result-file');
    assert.strictEqual(provisional.describe(failure).state, 'unvalidated', 'a refused finalization never consumes the retained candidate');
  });

  await test('issue343 U0c-2 app-server planner branch refuses missing declarations before success', async () => {
    for (const [label, plan, code] of [['writes', MISSING_WRITES(), 'plan-declaration-writes-missing'],
      ['depends', MISSING_DEPENDS(), 'plan-declaration-depends-missing']]) {
      codexReturns(plan);
      const before = calls(), call = codexPlan(`missing-${label}`);
      assertAdmissionRefusal(await refusal(call.run), code, `app-server missing ${label}`);
      assert.strictEqual(calls(), before + 1, `app-server missing ${label}: exactly one turn`);
      assert.strictEqual(readJson(call.resultFile).status, 'running', `app-server missing ${label}: no success result-file`);
    }
    codexReturns(VALID());
    const before = calls(), control = codexPlan('valid');
    const result = await control.run;
    assert.deepStrictEqual([result.status, result.appserver.transport, calls()], ['done', 'app-server', before + 1], 'explicit declarations pass');
    // The historical Branch D CLI: exit 2 and a named adapter-failed result, never done.
    const cli = (label, plan) => {
      codexReturns(plan);
      const resultFile = path.join(root, `branch-d-${label}.json`);
      const child = spawnSync(process.execPath, [path.join(__dirname, 'forge-xllm.js'), '--mode', 'plan', '--plan-context', planContext,
        '--result-file', resultFile, '--cwd', transportRepo, '--dispatch-id', `u0c-branch-d-${label}`],
      { cwd: transportRepo, encoding: 'utf8', windowsHide: true, timeout: 120000, env: childEnv() });
      assert.strictEqual(child.status, 2, `${label}: ${child.stderr}`);
      return readJson(resultFile);
    };
    const beforeCli = calls();
    const missing = cli('missing-depends', MISSING_DEPENDS());
    assert.deepStrictEqual([missing.status, missing.reason_code], ['adapter-failed', 'plan-declaration-depends-missing']);
    // The pre-U0c smoke Section 27 happy-path payload: no task list, no declarations.
    const historical = candidate({ T01: taskPlan('T01', { depends: null, writes: null }) });
    historical.slice_plan.content = '# S99: slice plan\n\ntasks: T01\n';
    const smoke = cli('historical-shape', historical);
    assert.deepStrictEqual([smoke.status, smoke.reason_code], ['adapter-failed', 'plan-task-list-empty']);
    assert.strictEqual(calls(), beforeCli + 2, 'one turn per CLI run');
  });

  // ── U0c-3 / U0c-4: the owner publisher ──────────────────────────────────────

  await test('issue343 U0c-1 through the owner sidecar: the Claude transport refusal leaves no artifact byte', async () => {
    const dir = owner('refused'), request = planRequest(dir, 'refused'), targets = planTargets(dir);
    claudeReturns(MISSING_DEPENDS());
    const before = calls(), bytesBefore = hashes(targets);
    const error = await refusal(unit.runUnitSidecar(request, runtime()));
    assert.deepStrictEqual([error.code, error.provider_called], ['plan-declaration-depends-missing', true]);
    assert.strictEqual(calls(), before + 1);
    assert.deepStrictEqual(hashes(targets), bytesBefore, 'destination hashes unchanged');
    const receipt = receiptOf(request);
    assert.deepStrictEqual([receipt.phase, receipt.failure.reason_code, receipt.failure.provider_called],
      ['failed', 'plan-declaration-depends-missing', true]);
    assert(receipt.plan_generation && !Object.hasOwn(receipt, 'plan_validation'), 'the marker exists; no evidence was built');
    assert.strictEqual(readJson(request.resultFile).status, 'adapter-failed');
  });

  await test('issue343 U0c-3 the owner publisher admits returned bytes independently of the transport and never accepts a worker marker', async () => {
    const original = xllm.runPlan;
    let transportCalls = 0;
    try {
      for (const [label, returned, code] of [
        ['writes missing past the transport', MISSING_WRITES(), 'plan-declaration-writes-missing'],
        ['a worker plan_validation', { ...VALID(), plan_validation: { approved: true } }, 'plan-generation-marker-untrusted'],
        ['a worker plan_generation', { ...VALID(), plan_generation: { requirement: pv.REQUIREMENT } }, 'plan-generation-marker-untrusted'],
      ]) {
        const dir = owner('publisher-gate'), request = planRequest(dir, 'publisher-gate'), targets = planTargets(dir);
        xllm.runPlan = async () => { transportCalls++; return JSON.parse(JSON.stringify(returned)); };
        const before = transportCalls, bytesBefore = hashes(targets);
        const error = await refusal(unit.runUnitSidecar(request, runtime()));
        assert.deepStrictEqual([error.code, error.provider_called], [code, true], `${label}: ${error.message}`);
        assert.strictEqual(transportCalls, before + 1);
        assert.deepStrictEqual(hashes(targets), bytesBefore, `${label}: no artifact byte`);
        const receipt = receiptOf(request);
        assert.deepStrictEqual([receipt.phase, receipt.failure.reason_code], ['failed', code], label);
        assert(!Object.hasOwn(receipt, 'plan_validation'), `${label}: no evidence`);
        // The returned bytes were preserved before the refusal, never as replay authority.
        assert.deepStrictEqual(readJson(`${request.resultFile}.returned.json`).result, returned, `${label}: returned bytes preserved`);
      }
    } finally { xllm.runPlan = original; }
  });

  await test('issue343 U0c-4 valid candidate publishes and replays with zero provider calls; issue343 U0c-3 stripped or tampered evidence refuses before any artifact byte', async () => {
    const dir = owner('publisher'), request = planRequest(dir, 'publisher'), targets = planTargets(dir), plan = VALID();
    claudeReturns(plan);
    const before = calls();
    let atPackaging = null;
    const result = await unit.runUnitSidecar(request, runtime({ onPackagedContext: () => {
      atPackaging = { receipt: receiptOf(request), calls: calls() };
    } }));
    assert.strictEqual(result.status, 'done');
    assert.strictEqual(calls(), before + 1, 'one provider turn');
    // The owner's marker is durable in the started receipt before the provider turn.
    assert(atPackaging && atPackaging.calls === before && atPackaging.receipt.phase === 'started', 'observed before the spawn');
    assert(atPackaging.receipt.plan_generation && !Object.hasOwn(atPackaging.receipt, 'plan_validation'), 'marker first, evidence later');
    const contents = [plan.slice_plan.content, ...plan.task_plans.map(task => task.content)];
    assert.deepStrictEqual(targets.map(file => fs.readFileSync(file, 'utf8')), contents, 'the exact returned bytes are published');
    const receiptFile = `${request.resultFile}.receipt.json`, receipt = receiptOf(request);
    const marker = receipt.plan_generation, evidence = receipt.plan_validation;
    assert.strictEqual(receipt.phase, 'ready');
    assert.deepStrictEqual(atPackaging.receipt.plan_generation, marker, 'the ready record keeps the started marker');
    assert.deepStrictEqual([marker.kind, marker.requirement, marker.fingerprint, marker.dispatch_id, marker.workflow_id, marker.owner,
      marker.milestone, marker.slice, marker.begin], ['sidecar-plan-generation', pv.REQUIREMENT, unit.artifactFingerprint(request),
      request.dispatchId, request.workflowId, codeRoots.key(fs.realpathSync.native(dir)), M, S, null]);
    assert.deepStrictEqual([evidence.kind, evidence.marker_sha256, evidence.task_ids], ['sidecar-plan-validation', marker.marker_sha256, ['T01', 'T02']]);
    assert.deepStrictEqual([evidence.source.slice_plan, ...evidence.source.task_plans].map(entry => entry.sha256), hashes(targets),
      'the evidence binds the published bytes');
    // The owner files written from the candidate admit to the same semantic digest (U0b collector).
    const scope = { owner: fs.realpathSync.native(dir), milestone: M, slice: S };
    assert.strictEqual(pv.validateNewSlicePlan(pv.collectOwnerSlicePlan(dir, { milestone: M, slice: S }), scope).semantic_sha256,
      evidence.semantic_sha256);
    // In-process replay: no provider turn, receipt untouched.
    const receiptBytes = fs.readFileSync(receiptFile);
    assert.strictEqual((await unit.runUnitSidecar(request, runtime())).status, 'done');
    assert.strictEqual(calls(), before + 1, 'replay performs zero provider calls');
    assert(fs.readFileSync(receiptFile).equals(receiptBytes), 'replay never rewrites the receipt');

    // U0c-3: every forgery refuses under the owner lock before any artifact byte.
    const remove = () => { for (const file of targets) fs.rmSync(file, { force: true }); };
    const t02 = '.gsd/milestones/M001/slices/S01/tasks/T02/T02-PLAN.md';
    const forgeries = [
      ['the evidence stripped', record => { delete record.plan_validation; }, 'plan-validation-missing'],
      ['the marker stripped', record => { delete record.plan_generation; }, 'plan-generation-marker-missing'],
      ['an evidence digest edited', record => { record.plan_validation.semantic_sha256 = 'f'.repeat(64); }, 'plan-validation-invalid'],
      ['an imported approved flag on the evidence', record => { record.plan_validation.approved = true; }, 'plan-validation-invalid'],
      ['an imported approved flag on the marker', record => { record.plan_generation.approved = true; }, 'plan-generation-marker-invalid'],
      ['the candidate bytes edited', record => {
        const item = record.artifacts.find(row => row.path === t02);
        item.content = item.content.replace('depends: [T01]\n', '');
      }, 'plan-validation-source-mismatch'],
      ['an artifact outside the admitted set', record => {
        record.artifacts.push({ path: '.gsd/milestones/M001/slices/S01/tasks/T03/T03-PLAN.md', content: taskPlan('T03'), before: null });
      }, 'plan-validation-source-mismatch'],
      ['the candidate and its evidence resealed consistently', record => {
        const item = record.artifacts.find(row => row.path === t02);
        item.content = item.content.replace('depends: [T01]\n', '');
        const entry = record.plan_validation.source.task_plans.find(row => row.id === 'T02');
        entry.sha256 = sha(item.content);
        entry.bytes = Buffer.byteLength(item.content, 'utf8');
        record.plan_validation = resealEvidence(record.plan_validation);
      }, 'plan-declaration-depends-missing'],
      ['a resealed marker of another dispatch', record => {
        record.plan_generation = resealMarker({ ...record.plan_generation, dispatch_id: 'another-dispatch' });
        record.plan_validation = resealEvidence({ ...record.plan_validation, dispatch_id: 'another-dispatch',
          marker_sha256: record.plan_generation.marker_sha256 });
      }, 'plan-generation-marker-invalid'],
    ];
    for (const [label, mutate, code] of forgeries) {
      const record = JSON.parse(receiptBytes.toString('utf8'));
      mutate(record);
      fs.writeFileSync(receiptFile, JSON.stringify(record, null, 2) + '\n');
      remove();
      const callsBefore = calls();
      const error = await refusal(unit.runUnitSidecar(request, runtime()));
      assert.strictEqual(error.code, code, `${label}: ${error.message}`);
      assert.deepStrictEqual(hashes(targets), targets.map(() => null), `${label}: no artifact byte was written`);
      assert.strictEqual(calls(), callsBefore, `${label}: zero provider calls`);
      fs.writeFileSync(receiptFile, receiptBytes);
    }
    // A fresh process replays the genuine ready receipt from its saved content alone.
    const requestFile = path.join(root, 'publisher-request.json');
    fs.writeFileSync(requestFile, JSON.stringify(request));
    const child = spawnSync(process.execPath, [path.join(__dirname, 'forge-unit-sidecar.js'), '--request', requestFile],
      { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 120000, env: childEnv() });
    assert.strictEqual(child.status, 0, child.stderr);
    assert.strictEqual(JSON.parse(child.stdout.trim().split('\n').at(-1)).status, 'done');
    assert.deepStrictEqual(targets.map(file => fs.readFileSync(file, 'utf8')), contents, 'fresh-process replay restores the admitted bytes');
    assert(fs.readFileSync(receiptFile).equals(receiptBytes), 'the genuine receipt stays byte-identical');
    assert.strictEqual(calls(), before + 1, 'fresh-process replay performs zero provider calls');
  });

  await test('issue343 U0c-4 a pre-requirement legacy ready receipt replays byte-identically, unrewritten, with zero provider calls', async () => {
    const dir = owner('legacy'), request = planRequest(dir, 'legacy'), targets = planTargets(dir, ['T01']);
    // Historical bytes without depends/writes: never backfilled, never re-admitted on replay.
    const { record: legacy, legacySlice, legacyTask } = legacyReceipt(request);
    assert.throws(() => require('./forge-must-haves').validateTaskDeclarations(legacyTask, { taskId: 'T01', requireExplicit: true }),
      error => error.code === 'plan-declaration-depends-missing', 'the historical plan is genuinely legacy');
    // U0d: its legacy classification comes from the controller (no enrolled lineage for the
    // slice), never from the receipt's own shape, begin:null, age or an imported flag.
    assert.strictEqual(pv.classifySliceGeneration(dir, { milestone: M, slice: S }).status, 'unenrolled');
    const receiptFile = `${request.resultFile}.receipt.json`, bytes = Buffer.from(JSON.stringify(legacy, null, 2) + '\n');
    fs.writeFileSync(receiptFile, bytes);
    const before = calls();
    assert.strictEqual((await unit.runUnitSidecar(request, runtime())).status, 'done');
    assert.deepStrictEqual(targets.map(file => fs.readFileSync(file, 'utf8')), [legacySlice, legacyTask], 'historical bytes published as recorded');
    assert(fs.readFileSync(receiptFile).equals(bytes), 'the legacy receipt is never rewritten');
    assert.strictEqual(calls(), before, 'zero provider calls');
    // The same historical record named as a new generation must carry coherent evidence.
    fs.writeFileSync(receiptFile, JSON.stringify({ ...legacy, plan_validation: { approved: true } }, null, 2) + '\n');
    for (const file of targets) fs.rmSync(file, { force: true });
    assert.strictEqual((await refusal(unit.runUnitSidecar(request, runtime()))).code, 'plan-generation-marker-missing');
    assert.deepStrictEqual(hashes(targets), [null, null], 'an imported flag waives nothing and writes nothing');
  });

  await test('issue343 U0c-4 the marker binds the real committed begin when the owner supplies its enrollment; a forged one refuses before any receipt', async () => {
    const dir = owner('begin'), seam = beginPlanSlice(dir, 'plan-begin-u0c-seam');
    for (const [label, forged] of [['another-lease', pv.buildPlanGeneration({ ...seam.enrollment, lease_generation: 'lease-forged' })],
      ['approved-flag', { ...seam.generation, approved: true }],
      ['another-slice', pv.buildPlanGeneration({ ...seam.enrollment, slice: 'S02' })]]) {
      const request = planRequest(dir, `begin-${label}`), before = calls();
      const error = await refusal(unit.runUnitSidecar(request, runtime({ planGeneration: forged })));
      assert.deepStrictEqual([error.code, error.provider_called], ['plan-generation-begin-invalid', false], `${label}: ${error.message}`);
      assert(!fs.existsSync(`${request.resultFile}.receipt.json`), `${label}: refused before any receipt`);
      assert.strictEqual(calls(), before, `${label}: zero provider calls`);
    }
    claudeReturns(VALID());
    const request = planRequest(dir, 'begin-bound');
    assert.strictEqual((await unit.runUnitSidecar(request, runtime({ planGeneration: seam.generation }))).status, 'done');
    assert.deepStrictEqual(receiptOf(request).plan_generation.begin, { generation_key: seam.generation.generation_key,
      begin_key: 'plan-begin-u0c-seam', lease_generation: seam.enrollment.lease_generation });
    // U0d: without any supplied enrollment the attempt still binds the slice's OPEN enrolled
    // controller lineage (the canonical classification); begin:null remains only for a slice
    // with no enrolled lineage (an unlinked producer).
    const auto = owner('begin-auto'), autoSeam = beginPlanSlice(auto, 'plan-begin-u0d-auto');
    assert.strictEqual(pv.classifySliceGeneration(auto, { milestone: M, slice: S }).status, 'open');
    claudeReturns(VALID());
    const autoRequest = planRequest(auto, 'begin-auto');
    assert.strictEqual((await unit.runUnitSidecar(autoRequest, runtime())).status, 'done');
    assert.deepStrictEqual(receiptOf(autoRequest).plan_generation.begin, { generation_key: autoSeam.generation.generation_key,
      begin_key: 'plan-begin-u0d-auto', lease_generation: autoSeam.enrollment.lease_generation });
    // The native completion of that same lineage admits exactly the published plan bytes.
    const completion = completePlanSlice(auto, autoSeam, 'plan-complete-u0d-auto');
    assert.strictEqual(completion.result[pv.TRANSACTION_FIELDS.validation].graph_sha256, receiptOf(autoRequest).plan_validation.graph_sha256);
    assert.strictEqual(pv.assertSliceGeneration(auto, { milestone: M, slice: S }).status, 'current');
  });

  // ── U0d C3: provenance of a ready record without either owner record ─────────

  await test('issue343 U0d C3 a known-new receipt with both owner records stripped refuses by the enrolled controller lineage; the unanchored limit is explicit', async () => {
    // Known-new: produced under a real native enrollment, so the marker binds that lineage.
    const dir = owner('stripped'), seam = beginPlanSlice(dir, 'plan-begin-u0d-stripped'), targets = planTargets(dir);
    claudeReturns(VALID());
    const request = planRequest(dir, 'stripped');
    assert.strictEqual((await unit.runUnitSidecar(request, runtime())).status, 'done');
    const receiptFile = `${request.resultFile}.receipt.json`, genuine = fs.readFileSync(receiptFile);
    const record = JSON.parse(genuine.toString('utf8'));
    assert.strictEqual(record.plan_generation.begin.begin_key, 'plan-begin-u0d-stripped', 'the marker binds the open enrolled lineage');
    const { plan_generation: _marker, plan_validation: _evidence, ...stripped } = record;
    const strippedBytes = Buffer.from(JSON.stringify(stripped, null, 2) + '\n');
    const replay = async (label, expected) => {
      fs.writeFileSync(receiptFile, strippedBytes);
      for (const file of targets) fs.rmSync(file, { force: true });
      const before = calls();
      const error = await refusal(unit.runUnitSidecar(request, runtime()));
      assert.strictEqual(error.code, expected, `${label}: ${error.message}`);
      assert.deepStrictEqual(hashes(targets), targets.map(() => null), `${label}: no artifact byte`);
      assert.strictEqual(calls(), before, `${label}: zero provider calls`);
      assert(fs.readFileSync(receiptFile).equals(strippedBytes), `${label}: the receipt is never rewritten`);
    };
    // While the lineage is open, and after its native completion: the slice is enrolled.
    await replay('both stripped while the enrolled lineage is open', 'plan-generation-marker-missing');
    fs.writeFileSync(receiptFile, genuine);
    assert.strictEqual((await unit.runUnitSidecar(request, runtime())).status, 'done', 'the genuine receipt replays');
    completePlanSlice(dir, seam, 'plan-complete-u0d-stripped');
    assert.strictEqual(pv.classifySliceGeneration(dir, { milestone: M, slice: S }).status, 'completed');
    await replay('both stripped after the native completion', 'plan-generation-marker-missing');
    // An old-format ready receipt over an enrolled slice is refused too: its legacy shape alone
    // proves nothing when the controller shows an enrolled lineage.
    const anchored = owner('legacy-anchored');
    beginPlanSlice(anchored, 'plan-begin-u0d-legacy');
    const legacyRequest = planRequest(anchored, 'legacy-anchored'), legacyTargets = planTargets(anchored, ['T01']);
    fs.writeFileSync(`${legacyRequest.resultFile}.receipt.json`, JSON.stringify(legacyReceipt(legacyRequest).record, null, 2) + '\n');
    const before = calls();
    assert.strictEqual((await refusal(unit.runUnitSidecar(legacyRequest, runtime()))).code, 'plan-generation-marker-missing');
    assert.deepStrictEqual([hashes(legacyTargets), calls()], [[null, null], before], 'an enrolled slice publishes no unvalidated byte');
    // EXPLICIT LIMIT (unanchored): with no enrolled controller lineage for the slice, nothing
    // canonical tells a stripped new receipt from a historical one, so it replays with the
    // historical semantics, unrewritten. Detection is not universal; history is never revalidated.
    const unlinked = owner('stripped-unlinked'), unlinkedRequest = planRequest(unlinked, 'stripped-unlinked'), unlinkedTargets = planTargets(unlinked);
    claudeReturns(VALID());
    assert.strictEqual((await unit.runUnitSidecar(unlinkedRequest, runtime())).status, 'done');
    const unlinkedFile = `${unlinkedRequest.resultFile}.receipt.json`;
    const unlinkedRecord = readJson(unlinkedFile);
    assert.strictEqual(unlinkedRecord.plan_generation.begin, null, 'an unlinked producer: begin:null proves no origin by itself');
    const { plan_generation: _m, plan_validation: _e, ...unlinkedStripped } = unlinkedRecord;
    const unlinkedBytes = Buffer.from(JSON.stringify(unlinkedStripped, null, 2) + '\n');
    fs.writeFileSync(unlinkedFile, unlinkedBytes);
    for (const file of unlinkedTargets) fs.rmSync(file, { force: true });
    const unlinkedBefore = calls();
    assert.strictEqual((await unit.runUnitSidecar(unlinkedRequest, runtime())).status, 'done', 'the documented unanchored limit');
    assert.deepStrictEqual([fs.readFileSync(unlinkedFile).equals(unlinkedBytes), calls()], [true, unlinkedBefore]);
  });

  // ── U0c-5: the sidecar execute pre-spawn recheck ────────────────────────────

  await test('issue343 U0c-5 sidecar execute refuses an altered generation before spawn; checkbox and repair_count edits pass', async () => {
    const dir = owner('execute');
    const plan = candidate({ T01: taskPlan('T01', { file: 'fixture-output.txt', capability: 'readonly' }),
      T02: taskPlan('T02', { file: 'other-output.txt', capability: 'readonly', depends: 'depends: [T01]' }) });
    fs.writeFileSync(path.join(dir, 'fixture-output.txt'), 'Existing output verified by the readonly fixture.\n');
    const seam = beginPlanSlice(dir, 'plan-begin-u0c-execute');
    publishPlan(dir, plan);
    // U0d: the real native completion admits the owner plan and nests plan_validation in its
    // checksum-covered result; nothing is attached after the commit.
    const completion = completePlanSlice(dir, seam, 'plan-complete-u0c-execute');
    const scope = { owner: fs.realpathSync.native(dir), milestone: M, slice: S };
    const validation = pv.verifyPlanValidation(completion.result[pv.TRANSACTION_FIELDS.validation], seam.generation);
    assert.strictEqual(pv.semanticDigest(validation),
      pv.validateNewSlicePlan(pv.collectOwnerSlicePlan(dir, { milestone: M, slice: S }), scope).semantic_sha256);
    assert(!Object.hasOwn(completion, pv.TRANSACTION_FIELDS.validation), 'no top-level evidence');
    assert.strictEqual(pv.assertCurrentGeneration(dir, { milestone: M, slice: S, validation_key: 'plan-complete-u0c-execute' }).status, 'current');
    const t02 = taskFile(dir, 'T02'), t02Bytes = fs.readFileSync(t02);
    const recordFiles = ['plan-begin-u0c-execute', 'plan-complete-u0c-execute'].map(key => controller.transactionFile(dir, key));
    const recordBytes = recordFiles.map(file => fs.readFileSync(file));
    claudeReturns({ status: 'done', summary: 'Execution fixture', must_haves_status: [], files_changed: [] });
    const refusedBeforeSpawn = async (label, request, runtimeExtra, code) => {
      const before = calls();
      const error = await refusal(unit.runUnitSidecar(request, runtime(runtimeExtra)));
      assert.deepStrictEqual([error.code, error.provider_called], [code, false], `${label}: ${error.message}`);
      assert.strictEqual(calls(), before, `${label}: zero provider calls`);
      const receipt = receiptOf(request);
      assert.deepStrictEqual([receipt.phase, receipt.failure.reason_code, receipt.failure.provider_called, receipt.failure.layer,
        receipt.failure.possible_writes, receipt.failure.reconciliation_required],
      ['failed', code, false, 'plan-generation-admission', false, false], label);
    };
    // Drift already present at the execute entry (another member's writes changed).
    fs.writeFileSync(t02, t02Bytes.toString('utf8').replace('  - "other-output.txt"', '  - "moved-output.txt"'));
    try {
      await refusedBeforeSpawn('writes drift at entry', executeRequest(dir, 'execute-drift'), {}, 'plan-generation-drift');
      assert.deepStrictEqual(recordFiles.map(file => fs.readFileSync(file)), recordBytes, 'the recheck writes no controller record');
    } finally { fs.writeFileSync(t02, t02Bytes); }
    // Drift introduced after entry, while the adapter packages: the last-spawn hook refuses.
    let mutated = false;
    try {
      await refusedBeforeSpawn('depends drift while packaging', executeRequest(dir, 'execute-late'), { onPackagedContext: () => {
        if (!mutated) { mutated = true; fs.writeFileSync(t02, t02Bytes.toString('utf8').replace('depends: [T01]', 'depends: []')); }
      } }, 'plan-generation-drift');
      assert(mutated, 'the packaging hook ran');
    } finally { fs.writeFileSync(t02, t02Bytes); }
    // Forged evidence on the committed completion, where the evidence lives (completion.result).
    const restoreRecords = () => recordFiles.forEach((file, index) => fs.writeFileSync(file, recordBytes[index]));
    const nested = record => record.result[pv.TRANSACTION_FIELDS.validation];
    const forgeries = [
      // Self-consistent: the result checksum is recomposed, so the evidence verifier refuses.
      ['an approved flag on the nested evidence', record => {
        nested(record).approved = true;
        record.boundary.result_checksum = recordDigest(record.result);
      }, 'plan-validation-invalid'],
      // Storage-level: the same edit without its result checksum (record-conflict).
      ['the nested evidence edited without its result checksum', record => { nested(record).approved = true; }, 'plan-generation-evidence-invalid'],
      // An isolated top-level alias is never read as evidence.
      ['an isolated top-level alias', record => {
        record[pv.TRANSACTION_FIELDS.validation] = nested(record);
        delete record.result[pv.TRANSACTION_FIELDS.validation];
        record.boundary.result_checksum = recordDigest(record.result);
      }, 'plan-generation-evidence-invalid'],
      // Foreign: a self-consistent completion of the same lease for another owner digest.
      ['a completion of another owner', record => { record.owner_digest = `sha256:${'9'.repeat(64)}`; }, 'plan-generation-lineage-mismatch'],
    ];
    for (const [label, mutate, code] of forgeries) {
      rewriteRecord(dir, 'plan-complete-u0c-execute', mutate);
      try {
        await refusedBeforeSpawn(label, executeRequest(dir, 'execute-forged'), {}, code);
      } finally { restoreRecords(); }
    }
    // Ambiguous: a second, consistently stored terminal transition of the same lineage.
    {
      const key = 'plan-complete-u0d-duplicate';
      const duplicate = JSON.parse(JSON.stringify(completion));
      for (const part of [duplicate, duplicate.event, duplicate.result, duplicate.boundary]) part.idempotency_key = key;
      duplicate.boundary.result_checksum = recordDigest(duplicate.result);
      duplicate.boundary.event_checksum = recordDigest(duplicate.event);
      const file = controller.transactionFile(dir, key);
      controller.writeAtomic(file, duplicate);
      try {
        await refusedBeforeSpawn('two terminals of one enrolled lineage', executeRequest(dir, 'execute-ambiguous'), {}, 'plan-generation-ambiguous');
      } finally { fs.rmSync(file, { force: true }); }
    }
    assert.deepStrictEqual(recordFiles.map(file => fs.readFileSync(file)), recordBytes, 'the recheck never rewrites a controller record');
    // A direct sidecar execute (no native first begin) in a slice whose enrolled lineage is still
    // open, or ended without a successful completion, refuses before the provider.
    const plannedOwner = (label, finish) => {
      const owned = owner(label);
      fs.writeFileSync(path.join(owned, 'fixture-output.txt'), 'Existing output verified by the readonly fixture.\n');
      const begun = beginPlanSlice(owned, `plan-begin-${label}`);
      publishPlan(owned, plan);
      if (finish) finish(owned, begun);
      return owned;
    };
    const open = plannedOwner('execute-open');
    await refusedBeforeSpawn('an open enrolled lineage with its plan present', executeRequest(open, 'execute-open'), {}, 'plan-generation-pending');
    const ended = plannedOwner('execute-ended', (owned, begun) => {
      const failedPlan = controller.fail(owned, controllerRequest({ owner_token: begun.begun.owner_token, generation: begun.begun.generation,
        idempotency_key: 'plan-fail-u0d-ended', result: { status: 'failed', reason_code: 'worker-failed' } }), { prefsReader });
      assert.strictEqual(failedPlan.transaction.phase, 'committed');
    });
    await refusedBeforeSpawn('an enrolled lineage ended without completion', executeRequest(ended, 'execute-ended'), {}, 'plan-generation-completion-missing');
    // Control: a checked box and the real repair_count increment change no declaration.
    const slicePlanFile = path.join(sliceDir(dir), `${S}-PLAN.md`);
    fs.writeFileSync(slicePlanFile, fs.readFileSync(slicePlanFile, 'utf8').replace('- [ ] **T02**', '- [x] **T02**'));
    assert.strictEqual(repair.incrementRepairCount(t02), 1);
    const before = calls();
    const result = await unit.runUnitSidecar(executeRequest(dir, 'execute-control'), runtime());
    assert.deepStrictEqual([result.status, calls()], ['done', before + 1], 'the enrolled generation is current: one spawn');
  });
}

main()
  .catch(error => { failed++; console.log(`  ✗ suite aborted\n      ${error && error.stack ? error.stack : error}`); })
  .finally(() => {
    accounts.resolveLaunch = originalLookup;
    claude.invokeClaudeSidecar = originalInvoke;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); } catch { /* best-effort cleanup */ }
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
  });
