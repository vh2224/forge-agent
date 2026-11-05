#!/usr/bin/env node
'use strict';

// S03/T07: composed end-to-end proof of the milestone time options, the milestone
// time governance, the proven endpoint and the linked task, on host `claude` and
// host `codex`. Each host runs ONE chain in temporary roots: a real Git owner
// (WORKING_DIR) distinct from the milestone worktree (CODE_DIR), a temporary
// personal profile and a temporary FORGE_HOME. Every step goes through the
// current public APIs: the bridge forge-long-workflow-adapter.invoke (next,
// complete, resume-time-option, resume-budget), the embedded selection
// main --decide with an in-process live adapter fixture, the endpoint writer,
// the linked-task handoff/start and the canonical standalone task preparation.
// One injected owner clock per chain: passed as `now` wherever the API takes it,
// and, for the entries that read only the global clock (embedded --decide, the
// fresh endpoint verification stamp and the preparation internals), installed as
// a scoped global Date seam. Only external transports are simulated (xllm
// transports and the native host callback); the real child and app-server seams
// are observed and forbidden. Every seam, the clock and every environment
// variable are restored in finally. No provider, network, real profile, real
// .gsd or productive process is touched. Review records are declared fixture
// payloads through the public delivery format, never an independent review.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');

const SOURCE = path.resolve(__dirname, '..');
// The main thread owns the temporary base; each host worker receives it and never removes it.
const base = isMainThread ? fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-time-chain-'))) : workerData.base;
const savedEnv = { FORGE_HOME: process.env.FORGE_HOME, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
function write(root, relative, content) {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content) + '\n');
  return target;
}
// Routes and procedures depend only on fixtures, never on an operator's installed prefs.
process.env.FORGE_HOME = path.join(base, 'forge-home');
const suiteHome = path.join(base, 'suite-home');
if (isMainThread) {
  const manifest = JSON.parse(fs.readFileSync(path.join(SOURCE, 'shared/forge-procedures.json'), 'utf8'));
  for (const item of manifest.modules.filter(row => row.status === 'ready')) write(process.env.FORGE_HOME, item.path, fs.readFileSync(path.join(SOURCE, item.path)));
  write(process.env.FORGE_HOME, 'shared/forge-procedures.json', JSON.stringify(manifest));
  write(process.env.FORGE_HOME, 'forge-agent-prefs.jsonc', '{}\n');
  fs.mkdirSync(suiteHome);
}
process.env.HOME = suiteHome; process.env.USERPROFILE = suiteHome;

const adapter = require('./forge-long-workflow-adapter');
const controller = require('./forge-unit-controller');
const selection = require('./forge-milestone-time-selection');
const time = require('./forge-milestone-time');
const admission = require('./forge-milestone-time-admission');
const clocks = require('./forge-milestone-time-clock');
const questions = require('./forge-pending-questions');
const sidecar = require('./forge-unit-sidecar');
const resolver = require('./forge-dispatch-resolve');
const state = require('./forge-state');
const lease = require('./forge-unit-lease');
const recovery = require('./forge-attempt-recovery');
const delivery = require('./forge-delivery');
const verify = require('./forge-verify');
const codeRoots = require('./forge-code-roots');
const endpoint = require('./forge-milestone-endpoint');
const linked = require('./forge-linked-task');
const lts = require('./forge-linked-task-start');
const horizon = require('./forge-linked-task-horizon');
const prep = require('./forge-task-preparation');
const personal = require('./forge-personal-context');
const runs = require('./forge-runs');
const xllm = require('./forge-xllm');
const claudeSidecar = require('./forge-claude-sidecar');
const appServer = require('./forge-appserver-client');
const gitProcess = require('./forge-git-process');
const { renderPrompt } = require('./forge-prompt');
const { digest } = codeRoots;
const PROPOSALS = require('./fixtures/milestone-options/proposals.json');

const M = PROPOSALS.milestone, LEGACY = 'M002', BRANCH = 'forge/' + M, ROADMAP = `.gsd/milestones/${M}/${M}-ROADMAP.md`;
const CHECK = "const value = require('./result'); require('assert/strict').equal(typeof value, 'number');\n"
  + "if (process.argv[2]) require('assert/strict').equal(value, Number(process.argv[2]));\nconsole.log('PASS shared-source-behavior');\n";
const SUMMARY = `# ${M} Summary\n\nEntrega integrada verificada.\n\n## Forward Intelligence\n\n- Rode node scripts/check.js antes de mexer em result.js.\n\n## Decisões\n\n- Relatório SC4 fica na task ligada.\n`;
// One roadmap slice realizes both selected slice nodes (N2 depends on N1 inside S01).
const ALLOCATION = [{ id: 'prep', kind: 'preparation', ms: 600000, nodes: ['PREP'] }, { id: 's1', kind: 'slice', slice: 'S01', ms: 3000000, nodes: ['N1', 'N2'] },
  { id: 'int', kind: 'integration', ms: 600000, nodes: ['INT'] }, { id: 'rev', kind: 'review', ms: 600000, nodes: ['REV'] },
  { id: 'cor', kind: 'corrections', ms: 600000, nodes: ['COR'] }];
const prefsReader = () => ({ ok: true, prefs: { workflow: { skip_discuss: true, skip_research: true } } });
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const iso = value => new Date(value).toISOString();
let serial = 0;
let failures = 0;

function ok(name) { process.stdout.write('ok - ' + name + '\n'); }
function file(root, relative) { return path.join(root, ...relative.split('/')); }
function json(root, relative) { return JSON.parse(fs.readFileSync(file(root, relative), 'utf8')); }
function gitIn(cwd) { return args => gitProcess.git(cwd, args).trim(); }
function commit(git, message) { git(['add', '-A']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', message]); }
function tree(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  (function visit(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.locks') continue;
      const target = path.join(d, entry.name), relative = path.relative(dir, target);
      if (entry.isDirectory()) { out[relative] = 'directory'; visit(target); }
      else { const stat = fs.lstatSync(target); out[relative] = [sha(fs.readFileSync(target)), stat.size, stat.mtimeMs]; }
    }
  })(dir);
  return out;
}
function snap(f) { return { gsd: tree(path.join(f.owner, '.gsd')), home: tree(f.home) }; }
function unchanged(f, before, label) { assert.deepEqual(snap(f), before, label + ': zero writes'); }
function transactions(cwd) {
  const dir = controller.transactionDir(cwd);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => controller.readJson(path.join(dir, name))) : [];
}
function beginRecord(f, selected) { return controller.lookupRecord(f.owner, 'transaction', selected.controller_result.details.transaction.idempotency_key); }
// The same injected owner clock for the public entries that take no clock parameter.
function installInjectedClock(f) {
  const RealDate = global.Date;
  class InjectedDate extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(f.clock()); }
    static now() { return f.clock(); }
  }
  global.Date = InjectedDate;
  return () => { global.Date = RealDate; };
}
function withInjectedClock(f, fn) {
  const restore = installInjectedClock(f);
  try { return fn(); } finally { restore(); }
}

// ---------------------------------------------------------------------------
// Chain fixture: real Git owner + milestone worktree, enrolled new milestone
// ---------------------------------------------------------------------------
function attemptRequest(f, begin) {
  const task = begin.unit.type === 'execute-task' ? { taskId: begin.unit.id, phase: 'execute' } : { phase: 'plan' };
  return { cwd: f.owner, contextRoot: f.owner, milestoneId: M, sliceId: begin.after.state.active_slice, unitType: begin.unit.type, scope: 'milestone', ...task,
    route: { host_runtime: f.host, resolved_worker_engine: f.host, tier: 'standard' } };
}
function chain(host) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(base, host + '-')));
  const owner = path.join(root, 'owner'), code = path.join(root, 'code'), home = path.join(root, 'home'), results = path.join(root, 'results');
  for (const dir of [owner, home, results]) fs.mkdirSync(dir);
  const og = gitIn(owner); og(['init', '--quiet', '-b', 'main']);
  write(owner, '.gitignore', '.gsd/\n'); write(owner, 'scripts/result.js', 'module.exports = 1;\n'); write(owner, 'scripts/check.js', CHECK); commit(og, 'r0 initial');
  og(['worktree', 'add', '--quiet', '-b', BRANCH, code]);
  const f = { host, root, owner, code, home, results, og, cg: gitIn(code), start: Date.now(), at: 0, probe: 'alive', receipt: path.join(results, 'receipt.json') };
  f.clock = () => f.start + f.at;
  f.prof = { userHome: home, env: { HOME: home, USERPROFILE: home } };
  f.execution = codeRoots.singleContract(owner, code);
  f.input = { cwd: owner, milestone: M, workflow_id: 'chain-' + host, owner_token: 'chain-owner-' + host, max_steps: 60 };
  f.options = { prefsReader, now: f.clock, ...f.prof,
    // Live drain adapters of the host: the in-flight attempt receipt and a process probe.
    inspectAttempt: ({ begin }) => ({ receipt_path: f.receipt, request: attemptRequest(f, begin), roots: [{ root_id: 'primary', path: f.code }], pending_questions: [] }),
    processProbe: () => f.probe };
  fs.mkdirSync(path.join(owner, '.gsd/forge'), { recursive: true });
  for (const k of ['SCOPE', 'CONTEXT', 'BRAINSTORM']) write(owner, `.gsd/milestones/${M}/${M}-${k}.md`, `# ${k}\nEscopo sintético da cadeia\n`);
  state.write(owner, { milestone: M, kind: 'milestone', phase: 'idle', active_slice: '—', active_task: '—', auto_mode: 'on', next_action: 'plan-milestone' });
  const enrolled = selection.enroll(owner, M, { source: 'forge-auto', now: f.clock() - 3600000 });
  assert.equal(enrolled.status, 'enrolled', JSON.stringify(enrolled));
  // The milestone run of forge-auto owns the registered worktree (the lender of a milestone-branch start).
  runs.add(owner, { id: M, kind: 'milestone', session_id: 'chain-milestone-' + host, active: true, isolation_mode: 'worktree', branch: BRANCH,
    worktrees: [{ repo: owner, path: code }], project: owner, cwd: owner });
  return f;
}
function tick(f, ms = 1000) { f.at += ms; return f.clock(); }
function invoke(f, command, snapshot, extra = {}, options = f.options) {
  tick(f);
  return adapter.invoke(f.host, 'auto', command, { ...f.input, ...extra }, snapshot, options).result;
}
function prefsFile(f) {
  const tiers = Object.fromEntries(['light', 'standard', 'heavy', 'max'].map(tier => [tier, ['claude-sonnet-5']]));
  write(f.owner, '.gsd/forge-prefs.jsonc', JSON.stringify({ tier_models: tiers, routing: { default: { executor: tiers, planner: tiers } },
    effort: { 'plan-milestone': 'medium', 'estimate-milestone': 'medium' } }));
}
// Canonical native acceptance of a planner artifact (no transport, no provider).
async function accept(f, unitType, relative, content) {
  prefsFile(f);
  const id = `${unitType}-${f.host}-${++serial}`;
  const r = { cwd: f.owner, contextRoot: f.owner, milestoneId: M, unitType, dispatchId: id, workflowId: f.input.workflow_id,
    resultFile: path.join(f.results, id + '.json'), prompt: 'Isolated chain fixture only.' };
  r.route = resolver.resolveDispatch({ cwd: f.owner, unitType, milestoneId: M, unitId: M, hostRuntime: f.host });
  assert.equal(sidecar.beginArtifactAttempt(r).state, 'started');
  return sidecar.acceptArtifactResult(r, { status: 'done', summary: 'Fixture delivery', questions: [], artifacts: [{ path: relative, content }] }, { providerCalled: true });
}
// Live host resolver fixture: issues an opaque handle only for the explicit answer the host
// observed for that persisted question; every observation is recorded for the assertions.
function liveAdapter(f, o = {}) {
  const seen = [];
  return { seen, getDecisionHandle(request) {
    const read = questions.continuation({ cwd: f.owner, identity: request.question.identity_sha256 });
    const row = read.ok ? read.questions.find(q => q.id === request.question.id) : null;
    seen.push({ kind: request.kind, milestone: request.milestone, question: request.question.id, answer: row ? row.answer : null,
      request_sha256: request.request_sha256, request_digest: digest(request.request) });
    if (o.raw) return o.raw(request);
    const at = o.now ?? Date.now(), reference = 'live-' + request.question.id + '-' + (++serial);
    const live = { reference, status: 'resolved', answer: row && row.answer, source: 'user-text', resolved_at: iso(at - 60000), question: { ...request.question } };
    return time.createDecisionAuthority(() => live).issue(reference, { milestone: request.milestone, kind: request.kind,
      request_sha256: digest(request.request), expires_at: at + 600000 }, () => at);
  } };
}
// An explicit persisted operator answer plus a fresh live handle (extension of the milestone).
function attested(f, kind, request, answer) {
  const id = 'chain-question-' + (++serial);
  const opened = questions.openQuestions({ cwd: f.owner, milestone: M, unit: 'milestone-time/' + id, decision_set: 'milestone-time-' + kind, questions: [{ id, question: 'Estender o teto da milestone?' }] });
  questions.answer({ cwd: f.owner, identity: opened.identity_sha256, answers: [{ id, answer, source: 'user-text' }] });
  const at = f.clock(), live = { reference: 'chain-' + id, status: 'resolved', answer, source: 'user-text', resolved_at: iso(at - 1000), question: { identity_sha256: opened.identity_sha256, id } };
  return time.createDecisionAuthority(() => live).issue(live.reference, { milestone: M, kind, request_sha256: digest(request), expires_at: at + 60000 }, () => at);
}
function embeddedDecide(f, live) {
  const out = [], previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = f.home; process.env.USERPROFILE = f.home;
  try {
    const status = withInjectedClock(f, () => selection.main(['--decide', '--cwd', f.owner, '--milestone', M, '--json'], { stdout: { write: s => out.push(s) } }, live));
    return { status, result: JSON.parse(out.join('')) };
  } finally { process.env.HOME = previous.HOME; process.env.USERPROFILE = previous.USERPROFILE; }
}

// ---------------------------------------------------------------------------
// Canonical slice/task/milestone artifacts written by the fixture "workers"
// ---------------------------------------------------------------------------
function roadmapText(section) {
  return `# ${M}: Cadeia — Roadmap\n\n## Slices\n\n- [ ] **S01: Contrato e seleção** \`risk:low\` \`depends:[]\`\n`
    + `\n## Alocação de tempo\n\n\`\`\`json\n${JSON.stringify(section, null, 2)}\n\`\`\`\n`;
}
function markSlice(f, slice) {
  const target = file(f.owner, ROADMAP);
  fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(new RegExp(`- \\[ \\] \\*\\*${slice}:`), `- [x] **${slice}:`));
  write(f.owner, `.gsd/milestones/${M}/slices/${slice}/${slice}-SUMMARY.md`, `# ${slice}\nConcluído\n`);
}
function slicePlan(f, slice, tasks) {
  write(f.owner, `.gsd/milestones/${M}/slices/${slice}/${slice}-PLAN.md`, `# ${slice}\n\n## Tasks\n${tasks.map(([id, done]) => `- [${done ? 'x' : ' '}] **${id}: Trabalho ${id}**`).join('\n')}\n`);
}
function taskPlan(f, slice, task, node, spec) {
  const selected = selection.readSelectionState(f.owner, M);
  const text = `---\nid: ${task}\nslice: ${slice}\nmilestone: ${M}\ndepends: [${(spec.depends || []).join(', ')}]\n`
    + `time_options_sha256: ${selected.options_sha256}\ntime_position_id: ${selected.position_id}\ntime_node: ${node}\n`
    + `writes:\n${spec.writes.map(w => `  - ${w}\n`).join('')}must_haves:\n  truths:\n    - observed shared source behavior\n  artifacts: []\n  key_links: []\n`
    + `expected_output:\n  - scripts/result.js\nverify:\n${spec.verify.map(c => `  - ${c}\n`).join('')}---\n# ${task}\n`;
  write(f.owner, `.gsd/milestones/${M}/slices/${slice}/tasks/${task}/${task}-PLAN.md`, text);
}
// Real verification in CODE_DIR, verification envelope and the public delivery builder.
function taskWork(f, slice, task) {
  const prefix = `.gsd/milestones/${M}/slices/${slice}/tasks/${task}/${task}`, plan = fs.readFileSync(file(f.owner, prefix + '-PLAN.md'), 'utf8');
  const unit = { type: 'task', id: task, slice, milestone: M };
  const gate = verify.runRootVerification(f.execution, { unit, planFingerprint: sha(plan), taskPlanVerify: verify.parsePlanVerify(plan), commandTimeoutMs: 60000 });
  assert.equal(gate.passed, true, JSON.stringify(gate.roots.map(r => r.result.checks.map(c => [c.command, c.exitCode, c.stderr]))));
  write(f.owner, prefix + '-VERIFY-ENVELOPE.json', gate.roots[0]);
  const input = { schema_version: 2, execution_contract: f.execution, unit, plan: prefix + '-PLAN.md', plan_fingerprint: sha(plan),
    bindings: [{ criterion: { kind: 'truth', index: 0 }, aspect: 'default', coverage: 'behavioral', source: { kind: 'verification', path: prefix + '-VERIFY-ENVELOPE.json', check_index: 0 } }] };
  write(f.owner, prefix + '-DELIVERY-INPUT.json', input);
  const built = delivery.buildDelivery(input, { ownerRoot: f.owner, codeDir: f.code });
  assert(built.criteria.every(r => r.status === 'verificado'), JSON.stringify([built.diagnostics, built.criteria]));
  write(f.owner, prefix + '-DELIVERY.json', built);
  write(f.owner, prefix + '-SUMMARY.md', `# ${task}\nFeito\n`);
}
function sliceClosure(f, slice, tasks) {
  const dir = `.gsd/milestones/${M}/slices/${slice}`, planText = fs.readFileSync(file(f.owner, `${dir}/${slice}-PLAN.md`), 'utf8');
  // Declared fixture review payload in the public format (not an independent review of the feature).
  write(f.owner, `${dir}/${slice}-REVIEW.md`, `# Revisão ${slice}\n\n**Outcome:** 0 resolved · 0 conceded · 0 open\n`);
  const input = { schema_version: 1, unit: { type: 'slice', id: slice, milestone: M }, plan: `${dir}/${slice}-PLAN.md`, plan_fingerprint: sha(planText),
    expected_children: tasks.map(task => ({ unit: { type: 'task', id: task, slice, milestone: M }, delivery: `${dir}/tasks/${task}/${task}-DELIVERY.json` })),
    bindings: [], facts: { review: { status: 'aprovado', reference: `${slice}-REVIEW.md` } } };
  write(f.owner, `${dir}/${slice}-DELIVERY-INPUT.json`, input);
  const built = delivery.buildDelivery(input, { ownerRoot: f.owner, codeDir: f.code });
  assert(built.criteria.every(r => r.status === 'verificado'), JSON.stringify(built.diagnostics));
  write(f.owner, `${dir}/${slice}-DELIVERY.json`, built);
}
function milestoneClosure(f) {
  const dir = `.gsd/milestones/${M}`, roadmap = fs.readFileSync(file(f.owner, ROADMAP), 'utf8');
  const input = { schema_version: 2, unit: { type: 'milestone', id: M }, plan: ROADMAP, plan_fingerprint: sha(roadmap), execution_contract: f.execution,
    expected_children: ['S01'].map(slice => ({ unit: { type: 'slice', id: slice, milestone: M }, delivery: `${dir}/slices/${slice}/${slice}-DELIVERY.json` })), bindings: [] };
  write(f.owner, `${dir}/${M}-DELIVERY-INPUT.json`, input);
  const built = delivery.buildDelivery(input, { ownerRoot: f.owner, codeDir: f.code });
  assert(built.criteria.length > 0 && built.criteria.every(r => r.status === 'verificado'), JSON.stringify(built.diagnostics));
  write(f.owner, `${dir}/${M}-DELIVERY.json`, built);
  write(f.owner, `${dir}/${M}-SUMMARY.md`, SUMMARY);
}
function expectUnit(result, key, label) {
  assert.equal(result.outcome, 'dispatch_required', label + ': ' + JSON.stringify(result.controller_result || result).slice(0, 600));
  assert.equal(result.unit.key, key, label);
  return result;
}
function completeUnit(f, selected, label) {
  const done = invoke(f, 'complete', selected.snapshot, { result: { status: 'done' } });
  assert.equal(done.outcome, 'completed', label + ': ' + JSON.stringify(done.controller_result || done).slice(0, 600));
  return done;
}

// ---------------------------------------------------------------------------
// Simulated external transports (sidecar engines) and forbidden real seams
// ---------------------------------------------------------------------------
function seams() {
  const saved = { claude: xllm.invokeClaudeTransport, codex: xllm.invokeCodexAppServer, child: claudeSidecar.runOwnedChild, turn: appServer.startAppServerTurn };
  const s = { calls: { claude: 0, codex: 0, child: 0, turn: 0 }, prompts: [] };
  const candidate = () => ({ status: 'partial', summary: 'fixture', questions: [], artifacts: [] });
  xllm.invokeClaudeTransport = async options => { s.calls.claude++; s.prompts.push(options.prompt); return { candidate: candidate(), telemetry: null }; };
  xllm.invokeCodexAppServer = async options => { s.calls.codex++; s.prompts.push(options.prompt); return { finalText: JSON.stringify(candidate()) }; };
  claudeSidecar.runOwnedChild = () => { s.calls.child++; throw Object.assign(Error('real child forbidden'), { code: 'fixture-child-forbidden' }); };
  appServer.startAppServerTurn = () => { s.calls.turn++; throw Object.assign(Error('real app-server forbidden'), { code: 'fixture-turn-forbidden' }); };
  s.total = () => s.calls.claude + s.calls.codex + s.calls.child + s.calls.turn;
  s.restore = () => { xllm.invokeClaudeTransport = saved.claude; xllm.invokeCodexAppServer = saved.codex; claudeSidecar.runOwnedChild = saved.child; appServer.startAppServerTurn = saved.turn; };
  return s;
}
function preparationPrefs(f, model) {
  write(f.owner, '.gsd/forge-prefs.jsonc', JSON.stringify({ tier_models: { light: model, standard: model, heavy: model, max: model },
    effort: { 'plan-slice': 'medium', 'discuss-milestone': 'medium', 'research-milestone': 'medium', 'plan-milestone': 'medium' } }));
}
function prepRequest(f, task, phase, label, extra = {}) {
  return { schema_version: 1, scope: 'standalone-task', phase, taskId: task, cwd: f.code, contextRoot: f.owner, hostRuntime: f.host,
    workflowId: 'chain-' + label, dispatchId: 'chain-' + label + '-dispatch', resultFile: path.join(f.results, label + '.json'),
    constraints: { auto_commit: false, deploy: false }, inputs: { brief: 'Task ligada ' + label }, prompt: '## Task Brief\n\n# Task ' + label + '\n', ...extra };
}
function preparationArtifact(request) {
  const content = request.phase === 'discuss' ? '# Context\n\n## Decisions\n\nUse receipts.\n\n## Open Questions\n\nNone.\n\n## Out of Scope\n\nInstall.\n'
    : "# Research\n\n## Summary\n\nMeasured internally.\n\n## Don't Hand-Roll\n\nReuse resolver.\n\n## Relevant Code\n\nscripts/.\n";
  const value = { status: 'done', summary: request.phase + ' complete', questions: [], artifacts: [{ path: prep.requiredArtifact(request), content }] };
  return `---GSD-WORKER-RESULT---\nstatus: done\nresult_json: ${JSON.stringify(value)}\n---END-RESULT---`;
}
// Native host binding of each host for the preparation phases (the callback itself is the spy).
function nativeRequest(f, task, label) {
  if (f.host === 'codex') {
    preparationPrefs(f, 'gpt-5.6-sol');
    return prepRequest(f, task, 'research', label, { activeCapabilities: { available: true, tool: 'collaboration.spawn_agent', source: 'fixture-tool-schema',
      models: ['gpt-5.6-sol'], reasoning_efforts: ['medium', 'high'], fork_turns: ['none'] } });
  }
  preparationPrefs(f, 'claude-sonnet-5');
  const agent = write(f.results, 'agents/forge-discusser.md', '---\nname: forge-discusser\neffort: medium\n---\n');
  return prepRequest(f, task, 'discuss', label, { activeCapabilities: { available: true, tool: 'Agent', source: 'fixture-tool-schema', model_aliases: ['sonnet'],
    effort_transports: ['agent-frontmatter'] }, effortBinding: { transport: 'agent-frontmatter', agentPath: agent, sourceFingerprint: 'sha256:' + sha(fs.readFileSync(agent)) } });
}
// The sidecar model of each host routes to the other engine (both real engine seams are simulated).
function sidecarModel(f) { return f.host === 'claude' ? 'gpt-5.6-sol' : 'claude-sonnet-5'; }

// ---------------------------------------------------------------------------
// The composed chain of one host
// ---------------------------------------------------------------------------
async function hostChain(host) {
  const f = chain(host);
  process.env.HOME = f.home; process.env.USERPROFILE = f.home;
  const s = seams();
  const spies = { acquire: lease.acquire, kill: process.kill };
  let restoreClock = () => {};
  try {
    // ---- S02: estimate, materialized options and explicit rounds ----------------------
    const first = expectUnit(invoke(f, 'next'), `estimate-milestone/${M}`, 'estimate');
    await accept(f, 'estimate-milestone', `.gsd/milestones/${M}/${M}-OPTIONS.json`, JSON.stringify(PROPOSALS.base, null, 2));
    const estimated = completeUnit(f, first, 'estimate');
    const blocked = invoke(f, 'next', estimated.snapshot);
    assert.deepEqual([blocked.outcome, blocked.reason_code], ['blocked', 'time-option-pending'], JSON.stringify(blocked.controller_result).slice(0, 600));
    const options = blocked.controller_result.details.time_options;
    assert.deepEqual(blocked.snapshot.time_option_block, { milestone: M, options_sha256: options.options_sha256 });
    const media = options.positions.find(row => row.position_id === 'media');
    assert.ok(media && media.status === 'estimated' && media.ceiling_ms > 0, 'the linked-task position carries an estimated ceiling: ' + JSON.stringify(options.positions));
    const answered = [];
    for (const label of ['Escolher posição', 'Com task ligada (media)', 'Criar e iniciar após prova']) {
      const opened = selection.nextRound({ cwd: f.owner, milestone: M });
      assert.equal(opened.status, 'open', JSON.stringify(opened));
      const recorded = selection.answerRound({ cwd: f.owner, milestone: M, round: opened.question_id, response: label, source: 'user-text' });
      assert.equal(recorded.status, 'answered', JSON.stringify(recorded));
      answered.push(recorded.answer);
    }
    assert.deepEqual(answered, ['mode:position', 'option:media', 'linked-task:create-and-start-after-proven-completion']);
    // ---- Embedded main --decide: only the live adapter observing persisted answers decides ----
    const beforeDecide = snap(f);
    const standalone = embeddedDecide(f, undefined);
    assert.deepEqual([standalone.status, standalone.result.reason], [3, 'time-decision-attestation-required'], 'standalone CLI never decides');
    const forged = embeddedDecide(f, liveAdapter(f, { raw: () => ({ approved: true, answer: 'option:media' }) }));
    assert.equal(forged.result.status, 'refused', 'a serialized approval is no live authority: ' + JSON.stringify(forged.result));
    unchanged(f, beforeDecide, 'refused decisions');
    const imported = invoke(f, 'resume-time-option', blocked.snapshot, { approved: true, decision: { approved: true, choice: 'option:media' } });
    assert.equal(imported.reason_code, 'time-option-pending', 'imported approval flags never decide');
    const live = liveAdapter(f);
    const decided = embeddedDecide(f, live);
    assert.equal(decided.status, 0, JSON.stringify(decided.result));
    assert.deepEqual([decided.result.status, decided.result.choice, decided.result.linked_task.status], ['decided', 'option', 'created'], JSON.stringify(decided.result));
    const T = decided.result.linked_task.task_id;
    assert.match(T, /^T-/);
    assert.ok(live.seen.length >= 2 && live.seen.every(row => row.milestone === M && row.request_sha256 === row.request_digest), JSON.stringify(live.seen));
    assert.deepEqual([...new Set(live.seen.map(row => row.kind))], ['activation', 'linked-task'], 'activation and linked-task creation each observed live');
    assert.ok(live.seen.some(row => row.answer === 'option:media') && live.seen.some(row => row.answer === 'linked-task:create-and-start-after-proven-completion'),
      'the live adapter observed the persisted explicit answers: ' + JSON.stringify(live.seen));
    const contract = time.readContract({ cwd: f.owner, milestone: M });
    assert.deepEqual([contract.status, contract.contract.option.id, contract.contract.ceiling_ms], ['valid', 'media', media.ceiling_ms]);
    assert.equal(contract.contract.activated_at, iso(f.clock()), 'activated on the injected owner clock');
    const link = linked.linkedTaskFor(f.owner, T);
    assert.equal(link.link.milestone, M);
    assert.ok(fs.existsSync(file(f.owner, `.gsd/tasks/${T}/${T}-BRIEF.md`)), 'deterministic BRIEF');
    assert.equal(runs.get(f.owner, T).active, false, 'registered inactive run, never runnable before the proof');
    assert.equal(lts.linkedLifecycle(f.owner, T).status, 'blocked');
    const pendingWork = personal.readPersonalSnapshot({ project: f.owner, ...f.prof, id: T });
    assert.equal(pendingWork.status, 'ok');
    const work0 = pendingWork.works.find(w => w.id === T);
    assert.ok(work0 && work0.checkpoint.pending.some(c => !c.resolved), 'the linked task is a pending personal work: ' + JSON.stringify(work0).slice(0, 400));
    ok(`chain-${host}-embedded-decide-observes-persisted-explicit-round-answers`);
    const ceiling = contract.contract.ceiling_ms;

    // ---- resume-time-option, plan-milestone with TIME_SELECTION, conformant roadmap ----
    const plan = expectUnit(invoke(f, 'resume-time-option', blocked.snapshot), `plan-milestone/${M}`, 'resume-time-option');
    assert.equal(plan.snapshot.workflow_id, blocked.snapshot.workflow_id, 'the same snapshot continues');
    const rendered = renderPrompt({ cwd: f.owner, codeDir: SOURCE, templateDir: path.join(SOURCE, 'shared/templates/dispatch'), unitType: 'plan-milestone',
      milestoneId: M, description: 'Cadeia', unitEffort: 'medium', autoCommit: false, memoryMaxTokens: 0, standardsMaxTokens: 0, ledgerMaxTokens: 0, memoryQuery: '', memories: '', ledger: '' });
    for (const piece of ['Opção: media', 'Contrato base: ' + contract.chain[0].sha256, 'Teto:']) assert.ok(rendered.prompt.includes(piece), 'TIME_SELECTION: ' + piece);
    const section = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(selection.promptBlock(f.owner, M))[1]);
    section.allocation = structuredClone(ALLOCATION);
    await accept(f, 'plan-milestone', ROADMAP, roadmapText(section));
    const planned = completeUnit(f, plan, 'plan-milestone');
    const questionFiles = () => fs.existsSync(path.join(f.owner, '.gsd/forge/questions')) ? fs.readdirSync(path.join(f.owner, '.gsd/forge/questions')).sort() : [];
    const questionsBefore = questionFiles();
    // ---- S01 planned with the milestone: two independent N1 tasks (T01 is in flight when the cap
    // arrives) and T03 (N2, after both), each bound to the selected option, position and node ----
    slicePlan(f, 'S01', [['T01', false], ['T02', false], ['T03', false]]);
    taskPlan(f, 'S01', 'T01', 'N1', { writes: ['scripts/result.js'], verify: ['node scripts/check.js'] });
    taskPlan(f, 'S01', 'T02', 'N1', { writes: ['scripts/result.js'], verify: ['node scripts/check.js'] });
    taskPlan(f, 'S01', 'T03', 'N2', { depends: ['T01', 'T02'], writes: ['scripts/result.js'], verify: ['node scripts/check.js', 'node scripts/check.js 2'] });
    const s2exec = expectUnit(invoke(f, 'next', planned.snapshot), 'execute-task/T01', 'S01 execution');
    assert.deepEqual([s2exec.controller_result.details.time_options.boundary.status, time.readContract({ cwd: f.owner, milestone: M }).chain[1].delegation.basis],
      ['allocated', 'activation-delegation'], 'the conformant roadmap became the delegated allocation');
    assert.deepEqual(questionFiles(), questionsBefore, 'the conformant allocation asks no redundant question');
    const inflight = beginRecord(f, s2exec), generation = inflight.lease_generation;
    assert.equal(inflight.time_admission.decision, 'admitted');
    write(f.results, 'receipt.json', { phase: 'executing', recovery_identity_sha256: digest(recovery.requestIdentity(attemptRequest(f, inflight))) });
    // The worker verifies the integrated code and records its plan checkbox; the ACK is still pending.
    taskWork(f, 'S01', 'T01');
    slicePlan(f, 'S01', [['T01', true], ['T02', false], ['T03', false]]);
    // Every instant since the activation consumes (unit work or unknown): the clock crosses the cap.
    f.at = Date.parse(contract.contract.activated_at) + ceiling + 300000 - f.start;
    let acquisitions = 0, kills = 0;
    lease.acquire = (...args) => { acquisitions++; return spies.acquire(...args); };
    process.kill = (pid, signal) => { if (signal !== 0) kills++; return spies.kill(pid, signal); };
    const txBefore = transactions(f.owner).length;
    const draining = invoke(f, 'next');
    assert.deepEqual([draining.outcome, draining.reason_code], ['blocked', 'milestone-budget-draining'], JSON.stringify(draining.controller_result).slice(0, 600));
    assert.equal(draining.controller_result.details.time.checkpoint.status, 'not-drained');
    assert.equal(draining.controller_result.details.time.checkpoint.drain.writers[0].classification, 'healthy');
    assert.equal(transactions(f.owner).length, txBefore, 'the refused entry opened no transaction');
    assert.equal(lease.observe(f.owner, s2exec.unit.key).lease.generation, generation, 'the in-flight lease is untouched');
    assert.equal(lease.observe(f.owner, 'execute-task/T02').lease, null, 'no lease for the refused new unit');
    // The in-flight unit completes through its own legitimate complete.
    completeUnit(f, s2exec, 'in-flight execute-task/T01');
    const completions = transactions(f.owner).filter(row => row.action === 'complete' && row.unit.key === s2exec.unit.key && row.lease_generation === generation);
    assert.deepEqual(completions.map(row => row.phase), ['committed'], 'completed once by the same in-flight generation');
    assert.equal(transactions(f.owner).filter(row => row.action === 'begin' && row.unit.key === s2exec.unit.key).length, 1, 'no new attempt of the in-flight unit');
    const exhausted = invoke(f, 'next');
    assert.deepEqual([exhausted.outcome, exhausted.reason_code], ['blocked', 'milestone-budget-exhausted'], JSON.stringify(exhausted.controller_result).slice(0, 600));
    const checkpoint = exhausted.controller_result.details.time.checkpoint;
    assert.equal(checkpoint.status, 'checkpointed', JSON.stringify(checkpoint));
    assert.ok(checkpoint.record.decision_pending === true && checkpoint.record.overshoot_ms > 0, 'drained checkpoint with overshoot');
    assert.deepEqual([acquisitions, kills], [0, 0], 'no kill, no lease theft, no new attempt');
    lease.acquire = spies.acquire; process.kill = spies.kill;
    // ---- Explicit attested extension and resume-budget with the same snapshot ----
    assert.equal(invoke(f, 'resume-budget', exhausted.snapshot).reason_code, 'budget-extension-required');
    const extended = time.readContract({ cwd: f.owner, milestone: M }).contract.ceiling_ms + 3600000;
    const request = { kind: 'extension', reason: 'Extensão explícita da cadeia', patch: { ceiling_ms: extended } };
    assert.throws(() => time.amendContract({ cwd: f.owner, milestone: M, ...request, now: f.clock() }), error => error.code === 'time-decision-attestation-required');
    time.amendContract({ cwd: f.owner, milestone: M, ...request, now: f.clock(), handle: attested(f, 'extension', request, 'extend:' + extended) });
    const resumed = expectUnit(invoke(f, 'resume-budget', exhausted.snapshot), 'execute-task/T02', 'resume-budget');
    assert.equal(resumed.snapshot.workflow_id, exhausted.snapshot.workflow_id);
    assert.equal(beginRecord(f, resumed).time_admission.decision, 'admitted');
    taskWork(f, 'S01', 'T02');
    slicePlan(f, 'S01', [['T01', true], ['T02', true], ['T03', false]]);
    // T03 (N2) becomes ready only through the verified deliveries and committed completions of T01 and T02.
    const t3 = expectUnit(invoke(f, 'next', completeUnit(f, resumed, 'execute-task/T02').snapshot), 'execute-task/T03', 'N2 task after its dependency');
    write(f.code, 'scripts/result.js', 'module.exports = 2;\n'); commit(f.cg, 'T03 legitimately changes the shared source');
    taskWork(f, 'S01', 'T03');
    slicePlan(f, 'S01', [['T01', true], ['T02', true], ['T03', true]]);
    const s1close = expectUnit(invoke(f, 'next', completeUnit(f, t3, 'execute-task/T03').snapshot), 'complete-slice/S01', 'S01 closure');
    sliceClosure(f, 'S01', ['T01', 'T02', 'T03']);
    const s1done = completeUnit(f, s1close, 'complete-slice/S01');
    markSlice(f, 'S01');
    // ---- The proven slice boundary warns with a stable ID (informative: the next unit is selected) ----
    const close = expectUnit(invoke(f, 'next', s1done.snapshot), `complete-milestone/${M}`, 'complete-milestone');
    const warning = close.controller_result.details.time && close.controller_result.details.time.warning;
    assert.ok(warning && warning.warning && /^[a-f0-9]{64}$/.test(warning.id), 'boundary warning with a stable ID: ' + JSON.stringify(close.controller_result.details.time).slice(0, 600));
    assert.ok(['at-risk', 'exceeds'].includes(warning.classification), warning.classification);
    assert.deepEqual(warning.alternatives, ['extend', 'reduce-scope', 'continue-to-cap'], 'the warning offers explicit alternatives and does not block');
    milestoneClosure(f);
    completeUnit(f, close, 'complete-milestone');
    assert.deepEqual(time.listWarnings({ cwd: f.owner, milestone: M }).records.filter(row => row.warning).map(row => row.id), [warning.id], 'one immutable warning, never duplicated');
    runs.update(f.owner, M, { active: false });
    ok(`chain-${host}-adapter-invoke-preserves-real-controller-boundaries`);

    // ---- Endpoint: fresh composed verification, then the immutable record ----------------
    tick(f, 60000);
    // The committed complete-milestone alone never proves the predecessor.
    const unproven = lts.provePredecessor({ cwd: f.owner, task: T, now: f.clock(), ...f.prof });
    assert.deepEqual([unproven.status, unproven.reason], ['predecessor-incomplete', 'endpoint-unproven'], JSON.stringify(unproven));
    const early = endpoint.recordEndpoint({ cwd: f.owner, milestone: M, now: f.clock() });
    assert.equal(early.status, 'refused', 'no endpoint without the fresh verification: ' + JSON.stringify(early));
    assert.equal(endpoint.readEndpoint({ cwd: f.owner, milestone: M }).status, 'absent');
    tick(f);
    const verified = withInjectedClock(f, () => endpoint.writeEndpointVerification({ cwd: f.owner, milestone: M, now: f.clock() }));
    assert.equal(verified.status, 'verified', JSON.stringify(verified));
    assert.ok(verified.envelopes.length === 1 && verified.envelopes[0].passed && verified.envelopes[0].checks === 2, JSON.stringify(verified.envelopes));
    const envelopeFile = file(f.owner, verified.envelopes[0].reference), envelopeBytes = fs.readFileSync(envelopeFile);
    const altered = JSON.parse(envelopeBytes); altered.result.checks[0].exitCode = 1; altered.result.passed = false;
    fs.writeFileSync(envelopeFile, JSON.stringify(altered) + '\n');
    try {
      tick(f);
      const refused = endpoint.recordEndpoint({ cwd: f.owner, milestone: M, now: f.clock() });
      assert.equal(refused.status, 'refused', 'altered verification evidence never proves: ' + JSON.stringify(refused));
      assert.equal(endpoint.readEndpoint({ cwd: f.owner, milestone: M }).status, 'absent');
    } finally { fs.writeFileSync(envelopeFile, envelopeBytes); }
    tick(f);
    const recorded = endpoint.recordEndpoint({ cwd: f.owner, milestone: M, now: f.clock() });
    assert.equal(recorded.status, 'recorded', JSON.stringify(recorded));
    const proof = endpoint.readEndpoint({ cwd: f.owner, milestone: M });
    assert.equal(proof.status, 'valid');
    assert.equal(proof.record.roots[0].revision, f.cg(['rev-parse', 'HEAD']), 'the endpoint names the integrated CODE_DIR revision');
    assert.equal(proof.record.completion.unit, `complete-milestone/${M}`);
    const frozen = admission.readMilestoneTimeStatus(f.owner, M, { now: f.clock() });
    assert.equal(frozen.state, 'endpoint-proven');
    const activated = Date.parse(time.readContract({ cwd: f.owner, milestone: M }).contract.activated_at);
    const wall0 = f.clock() - activated;
    tick(f, 2 * 3600000);
    const later = admission.readMilestoneTimeStatus(f.owner, M, { now: f.clock() });
    assert.deepEqual([later.state, later.clocks.consumed_ms, later.remaining_ms], [frozen.state, frozen.clocks.consumed_ms, frozen.remaining_ms], 'the milestone clock is frozen');
    assert.ok(f.clock() - activated > wall0, 'elapsed wall time keeps running separately');
    const closedEntry = admission.decideAdmission(f.owner, { milestone: M, unit: 'plan-slice/S03', kind: 'begin', now: f.clock() });
    assert.deepEqual([closedEntry.allowed, closedEntry.reason_code], [false, 'milestone-endpoint-closed']);
    const provenPredecessor = lts.provePredecessor({ cwd: f.owner, task: T, now: f.clock(), ...f.prof });
    assert.deepEqual([provenPredecessor.status, provenPredecessor.endpoint_sha256], ['proven', proof.sha256], JSON.stringify(provenPredecessor));
    ok(`chain-${host}-endpoint-record-follows-fresh-composed-delivery-verification`);

    // ---- Handoff and the chained start with live reattestation -------------------------
    const produced = lts.produceHandoff({ cwd: f.owner, milestone: M, now: tick(f), ...f.prof });
    assert.equal(produced.status, 'produced', JSON.stringify(produced));
    const summaryFile = file(f.owner, `.gsd/milestones/${M}/${M}-SUMMARY.md`), summaryBytes = fs.readFileSync(summaryFile);
    const startArgs = () => ({ cwd: f.owner, taskId: T, codeDir: f.code, base: { kind: 'milestone-branch' }, isolation: { mode: 'worktree', attached_to: M }, now: tick(f), ...f.prof });
    let before = snap(f);
    const noAuthority = lts.startLinkedTask(startArgs());
    assert.deepEqual([noAuthority.status, noAuthority.reason], ['refused', 'linked-task-authorization-required']);
    unchanged(f, before, 'start without live authority');
    fs.appendFileSync(summaryFile, '\n- Item novo depois do handoff.\n');
    try {
      const stale = lts.startLinkedTask({ ...startArgs(), liveAdapter: liveAdapter(f, { now: f.clock() }) });
      assert.deepEqual([stale.status, stale.reason], ['refused', 'linked-task-handoff-stale'], JSON.stringify(stale));
      assert.ok(!fs.existsSync(file(f.owner, `.gsd/forge/time/${M}/linked-task/start.json`)));
    } finally { fs.writeFileSync(summaryFile, summaryBytes); }
    const reattest = liveAdapter(f, { now: f.clock() + 2000 });
    const started = lts.startLinkedTask({ ...startArgs(), liveAdapter: reattest });
    assert.equal(started.status, 'started', JSON.stringify(started));
    assert.ok(reattest.seen.some(row => row.answer === 'linked-task:create-and-start-after-proven-completion'), 'the original decision was reattested live: ' + JSON.stringify(reattest.seen));
    const startRecord = json(f.owner, `.gsd/forge/time/${M}/linked-task/start.json`);
    assert.deepEqual([startRecord.authority.mode, startRecord.base.kind, startRecord.base.roots[0].head, startRecord.base.roots[0].branch],
      ['chained', 'milestone-branch', proof.record.roots[0].revision, BRANCH]);
    const block = lts.consumedHandoffBlock(f.owner, T);
    const brief = fs.readFileSync(file(f.owner, `.gsd/tasks/${T}/${T}-BRIEF.md`), 'utf8');
    assert.equal(brief.split(lts.HANDOFF_MARKERS.start).length, 2, 'the BRIEF carries exactly one handoff block');
    assert.equal(sha(Buffer.from(block)), startRecord.block_sha256);
    const startedRun = runs.get(f.owner, T);
    assert.deepEqual([startedRun.active, startedRun.attached_to], [true, M], 'the task run borrows the milestone worktree');
    const work1 = personal.readPersonalSnapshot({ project: f.owner, ...f.prof, id: T }).works.find(w => w.id === T);
    assert.deepEqual([work1.workStatus, work1.reliability], ['unknown', 'missing'], 'started without PLAN is unknown/missing, never open');
    before = snap(f);
    const second = lts.startLinkedTask({ ...startArgs(), liveAdapter: liveAdapter(f, { now: f.clock() }) });
    assert.deepEqual([second.status, second.reason], ['refused', 'linked-task-already-started']);
    unchanged(f, before, 'second start');
    const continued = lts.continueLinkedTask({ cwd: f.owner, taskId: T, liveAdapter: liveAdapter(f, { now: f.clock() }), now: tick(f) });
    assert.deepEqual([continued.status, continued.authority_mode], ['continued', 'chained'], JSON.stringify(continued));
    ok(`chain-${host}-handoff-start-consumes-current-evidence-with-live-reattestation`);

    // ---- Canonical preparation: the consumed block reaches the sidecar transport and the native callback ----
    // From here on, the internal entries that read the global clock see the same injected owner clock.
    restoreClock = installInjectedClock(f);
    const startedAt = Date.parse(startRecord.started_at), taskCeiling = link.link.linked_task.horizon.ceiling_ms;
    assert.ok(f.clock() - startedAt < taskCeiling / 2, 'preparation happens below the task cap');
    const now = () => f.clock();
    preparationPrefs(f, sidecarModel(f));
    const sidecarRequest = prepRequest(f, T, 'research', host + '-sidecar');
    const count = s.prompts.length;
    const prepared = await prep.prepareStandaloneTask(sidecarRequest, { now });
    assert.equal(prepared.ok, true, JSON.stringify(prepared).slice(0, 400));
    assert.equal(s.prompts.length, count + 1, 'one simulated sidecar transport call');
    assert.equal(s.prompts[count].split(block).length, 2, 'the sidecar prompt carries the consumed block exactly once');
    const nativeSeen = [];
    const native = await prep.prepareStandaloneTask(nativeRequest(f, T, host + '-native'), { now,
      invokeNative: async args => { nativeSeen.push(args); return preparationArtifact(nativeRequest(f, T, host + '-native')); } });
    assert.equal(native.ok, true, JSON.stringify(native).slice(0, 400));
    assert.equal(native.transport, 'native');
    assert.equal(nativeSeen.length, 1, 'the native host callback ran once');
    assert.equal(JSON.stringify(nativeSeen[0]).split(JSON.stringify(block).slice(1, -1)).length, 2, 'the native callback received the consumed block exactly once');
    // Late cap: both entries selected below the task cap, the injected clock crosses it before the provider.
    preparationPrefs(f, sidecarModel(f));
    const selectedSidecar = await prep.startStandaloneTaskPreparation(prepRequest(f, T, 'research', host + '-late-sidecar'), { now });
    assert.equal(selectedSidecar.action, 'invoke-sidecar', JSON.stringify(selectedSidecar).slice(0, 300));
    const selectedNative = await prep.startStandaloneTaskPreparation(nativeRequest(f, T, host + '-late-native'), { now });
    assert.equal(selectedNative.action, 'invoke-native', JSON.stringify(selectedNative).slice(0, 300));
    f.at = startedAt + taskCeiling + 600000 - f.start;
    const transportCalls = s.total();
    await assert.rejects(sidecar.runUnitSidecar(selectedSidecar.delivery_request, { now }),
      error => error.code === 'linked-task-budget-exhausted' && error.provider_called === false);
    let hostCalls = 0;
    const lateOutcome = await selectedNative.invoke(async () => { hostCalls++; return { status: 'done' }; });
    assert.deepEqual([lateOutcome.ok, lateOutcome.reason_code, lateOutcome.provider_called], [false, 'linked-task-budget-exhausted', false], JSON.stringify(lateOutcome).slice(0, 300));
    const reused = await selectedNative.invoke(async () => { hostCalls++; return { status: 'done' }; });
    assert.equal(reused.reason_code, 'native-handoff-already-invoked', 'the native handoff is single-use');
    preparationPrefs(f, sidecarModel(f));
    const fresh = await prep.prepareStandaloneTask(prepRequest(f, T, 'research', host + '-at-cap'), { now });
    assert.deepEqual([fresh.ok, fresh.stage, fresh.reason_code, fresh.provider_called], [false, 'linked-task-admission', 'linked-task-budget-exhausted', false], JSON.stringify(fresh).slice(0, 300));
    // The already published preparation replays first, even at the cap, without any provider.
    const replayed = await prep.startStandaloneTaskPreparation(sidecarRequest, { now });
    assert.deepEqual([replayed.ok, replayed.replayed, replayed.provider_called], [true, true, false], JSON.stringify(replayed).slice(0, 300));
    assert.deepEqual([s.total(), hostCalls], [transportCalls, 0], 'no transport, child, app-server or host callback after the cap');
    ok(`chain-${host}-canonical-preparation-delivers-consumed-block-to-sidecar-and-native-callback`);

    // ---- Status surfaces: three horizons and which ceiling governs each operation ----
    const linkedView = horizon.readLinkedStatus({ cwd: f.owner, task: T, now: f.clock(), ...f.prof });
    assert.deepEqual(linkedView.governs, { milestone_operations: 'milestone-ceiling', task_operations: 'task-ceiling', chain: 'none' });
    assert.deepEqual([linkedView.milestone_horizon.state, linkedView.milestone_horizon.frozen, linkedView.milestone_horizon.endpoint.proven, linkedView.task_horizon.state],
      ['endpoint-proven', true, true, 'exhausted']);
    assert.equal(linkedView.chain.cap_ms, linkedView.milestone_horizon.ceiling_ms + linkedView.task_horizon.ceiling_ms, 'chain cap is the derived sum');
    // The closed summary block consumed by forge-status, orchestrate status and the personal summary.
    const summary = horizon.summarizeLinkedStatus(linkedView);
    assert.deepEqual([summary.task_id, summary.lifecycle, summary.task.state, summary.task.governs], [T, 'started', 'exhausted', 'task-operations']);
    assert.deepEqual([summary.milestone.state, summary.milestone.frozen, summary.milestone.endpoint_proven, summary.milestone.governs], ['endpoint-proven', true, true, 'milestone-operations']);
    assert.deepEqual([summary.chain.cap_basis, summary.chain.governs, summary.chain.completed], ['derived-sum', false, false]);
    assert.equal(summary.unknown, linkedView.unknowns.length > 0, 'unknowns stay visible');

    // ---- Same-root legacy controls: a milestone without contract and an unlinked task ----
    for (const k of ['SCOPE', 'CONTEXT', 'BRAINSTORM']) write(f.owner, `.gsd/milestones/${LEGACY}/${LEGACY}-${k}.md`, `# ${k}\nMilestone sem contrato\n`);
    state.write(f.owner, { milestone: LEGACY, kind: 'milestone', phase: 'idle', active_slice: '—', active_task: '—', auto_mode: 'on', next_action: 'plan-milestone' });
    const legacy = expectUnit(invoke(f, 'next', null, { milestone: LEGACY, workflow_id: 'legacy-' + host }), `plan-milestone/${LEGACY}`, 'legacy milestone');
    assert.equal(legacy.controller_result.details.time_options, undefined);
    assert.equal(legacy.controller_result.details.time, undefined);
    assert.equal(legacy.controller_result.details.transaction.idempotency_key, `forge-orchestrate-next:${LEGACY}:plan-milestone/${LEGACY}`);
    assert.equal(Object.hasOwn(beginRecord(f, legacy), 'time_admission'), false, 'legacy begin carries no time admission');
    const legacyDone = invoke(f, 'complete', legacy.snapshot, { result: { status: 'done' }, milestone: LEGACY, workflow_id: 'legacy-' + host });
    assert.equal(legacyDone.outcome, 'completed');
    assert.ok(!fs.existsSync(path.join(f.owner, '.gsd/forge/time', LEGACY)), 'nothing time-related written for the legacy milestone');
    assert.ok(!/time_admission|ceiling_ms/.test(fs.readFileSync(file(f.owner, `.gsd/milestones/${LEGACY}/${LEGACY}-events.jsonl`), 'utf8')), 'legacy events unchanged');
    const plain = 'T-20261105120000-plain-' + host;
    assert.equal(lts.linkedLifecycle(f.owner, plain), null, 'an unlinked task has no lifecycle');
    const trapped = ['readContract', 'readOwnerRecord', 'readTaskLink', 'readSelection', 'readJournal'];
    const originals = Object.fromEntries(trapped.map(name => [name, time[name]]));
    try {
      for (const name of trapped) time[name] = () => { throw new Error('unexpected time access: ' + name); };
      assert.equal(admission.assertOwnerTransportEntry({ request: { scope: 'standalone-task', phase: 'research', taskId: plain, unitType: 'research-milestone', cwd: f.code, contextRoot: f.owner } }),
        undefined, 'an unlinked task entry reads no time state');
    } finally { Object.assign(time, originals); }
    preparationPrefs(f, sidecarModel(f));
    const plainCount = s.prompts.length;
    const plainPrepared = await prep.prepareStandaloneTask(prepRequest(f, plain, 'research', host + '-plain'), { now });
    assert.equal(plainPrepared.ok, true, JSON.stringify(plainPrepared).slice(0, 300));
    assert.equal(s.prompts.length, plainCount + 1);
    assert.ok(!s.prompts[plainCount].includes(lts.HANDOFF_MARKERS.start), 'unlinked preparation carries no handoff block');
    assert.deepEqual([s.calls.child, s.calls.turn], [0, 0], 'real child and app-server seams never reached');
    ok(`chain-${host}-real-public-milestone-to-linked-task-lifecycle`);
  } finally {
    restoreClock();
    lease.acquire = spies.acquire; process.kill = spies.kill;
    s.restore();
    process.env.HOME = suiteHome; process.env.USERPROFILE = suiteHome;
  }
}

// ---------------------------------------------------------------------------
// Documentation, distribution qualification and the worker inventory
// ---------------------------------------------------------------------------
function read(relative) { return fs.readFileSync(path.join(SOURCE, relative), 'utf8'); }
function sectionOf(text, heading) {
  const from = text.indexOf('\n' + heading + '\n');
  assert.ok(from >= 0, 'section ' + heading);
  const rest = text.slice(from + heading.length + 2), next = rest.search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next);
}
function guideGroup() {
  const guide = read('docs/milestone-time-guide.md'), contract = read('shared/forge-milestone-time.md');
  assert.ok(guide.split('\n').length >= 100, 'substantive guide');
  for (const heading of ['## Adesão e opções de prazo', '## Decisão e alocação', '## Relógios e avisos', '## Teto, drain, checkpoint e extensão', '## Endpoint e congelamento',
    '## Task ligada', '## Comandos', '## Códigos', '## Limites', '## Disponibilidade', '## Fatos separados da entrega']) assert.ok(guide.includes('\n' + heading + '\n'), heading);
  const task = sectionOf(guide, '## Task ligada');
  for (const topic of ['Criação:', 'Bloqueio:', 'Handoff:', 'Início encadeado', 'Início explícito', 'Base comprovada', 'Horizonte:', 'Encerramento da task', 'cadeia (`--close-chain`)']) {
    assert.ok(task.includes(topic), 'linked task topic ' + topic);
  }
  // Every code the guide names is a real code of the current exported vocabularies or canonical contract.
  const exported = new Set([...admission.TRANSPORT_REFUSAL_CODES, ...admission.TIME_REASON_CODES, ...horizon.LINKED_TASK_TRANSPORT_CODES, ...lts.START_REFUSALS,
    ...lts.LIFECYCLE_REFUSALS, ...lts.PREDECESSOR_REASONS, ...selection.TIME_OPTION_REASON_CODES, ...selection.TIME_OPTION_RESUME_CODES]);
  const codes = [...sectionOf(guide, '## Códigos').matchAll(/`([a-z][a-z0-9-]+)`/g)].map(m => m[1]);
  assert.ok(codes.length >= 25, 'codes listed');
  for (const code of codes) assert.ok(exported.has(code) || contract.includes('`' + code + '`'), 'real code ' + code);
  for (const code of horizon.LINKED_TASK_TRANSPORT_CODES) assert.ok(codes.includes(code), 'every task transport code is documented: ' + code);
  for (const code of lts.PREDECESSOR_REASONS) assert.ok(task.includes('`' + code + '`'), 'predecessor reason ' + code);
  // The documented clock classes are the current policy.
  const policy = clocks.CLOCK_POLICY, clockText = sectionOf(guide, '## Relógios e avisos');
  for (const k of policy.classes) assert.ok(clockText.includes('`' + k + '`'), 'clock class ' + k);
  assert.deepEqual(policy.classes.filter(k => policy.consumption[k]).sort(), ['owner-session', 'unit-work', 'unknown'].sort());
  // Every documented CLI exists and exposes main; live actions stay embedded only.
  const commands = sectionOf(guide, '## Comandos');
  const scripts = [...new Set([...commands.matchAll(/scripts\/(forge-[a-z0-9-]+\.js)/g)].map(m => m[1]))];
  assert.ok(scripts.length >= 9);
  for (const script of scripts) assert.equal(typeof require('./' + script).main, 'function', script);
  assert.ok(/só embutid/.test(commands) && commands.includes('Saída 0 sucesso, 2 uso e 3 recusa'));
  // Limits, availability and separated delivery facts.
  const limits = sectionOf(guide, '## Limites');
  for (const item of ['Adaptador vivo embutido obrigatório', 'Guarda de transporte', 'Contexto das pernas de revisão', '`milestone_cleanup`', '`endpoint-sources-missing`']) assert.ok(limits.includes(item), item);
  const availability = sectionOf(guide, '## Disponibilidade');
  for (const item of ['- Implementado:', '- Distribuído:', '- Condicional:', '- Desconhecido:']) assert.ok(availability.includes(item), item);
  assert.ok(/não demonstram execução no cliente/.test(availability));
  const facts = sectionOf(guide, '## Fatos separados da entrega');
  for (const fact of ['Implementação', 'verificação local', 'CI', 'revisão', 'merge', 'release', 'instalação', 'UAT']) assert.ok(facts.includes(fact), fact);
  assert.ok(/UAT humano desta entrega foi dispensado e\nnão foi realizado/.test(facts));
  assert.ok(!/UAT (?:humano )?(?:foi )?(?:realizado|aprovado|executado)/i.test(guide.replace(/não foi realizado|não realizado/g, '')), 'no manual UAT claim');
  assert.ok(!/(?:foi|está) (?:lançad|instalad|publicad)/i.test(guide), 'no release or installation claim');
  ok('chain-guide-operational-portuguese-content-separates-authority-availability-and-delivery-facts');
}
// Immutable pre-T07 preimages measured by the worker on the pre-edit bytes of revision a97856f.
const PLANNING_PREFIX_SHA = 'c429aae73e3a80cccef63fab2eca388764ee5b1306c1d2fbc1ec5a803a97fbb8';
const CHANGELOG_PRE_SHA = '1b8a571086f8e8a3770f418f46aeedb22d074c382ccf3495b75a63612029be2c';
const PANEL_SENTENCE = 'Likewise,\n`docs/forge-communication-panel-distribution.md` remains deferred; this change\nadds no panel installation or release-distribution feature.';
function documentationGroup() {
  const planning = read('docs/planning-cost-diagnosis.md');
  const at = planning.indexOf('## Deferred overlap\n');
  assert.ok(at > 0);
  assert.equal(sha(Buffer.from(planning.slice(0, at), 'utf8')), PLANNING_PREFIX_SHA, 'everything before Deferred overlap is the immutable preimage');
  const overlap = planning.slice(at);
  assert.ok(overlap.includes(PANEL_SENTENCE), 'the panel distribution qualification is preserved verbatim');
  assert.ok(overlap.includes('`docs/milestone-time-options.md` is no longer deferred'), 'the time feature is no longer called deferred');
  assert.ok(!/milestone-time-options\.md` remains deferred/.test(overlap));
  for (const reference of ['`docs/milestone-time-guide.md`', '`shared/forge-milestone-time.md`', '`CHANGELOG.md`']) assert.ok(overlap.includes(reference), reference);
  assert.ok(overlap.includes('Human UAT and actual\nfuture latency improvements require their own evidence.'));
  const changelog = read('CHANGELOG.md');
  assert.ok(changelog.startsWith('## Não lançado\n\n- Prazos de milestone (M-20261101111759-opcoes-prazo-milestones):'), 'feature entry first under Não lançado');
  const entry = changelog.split('\n')[2];
  for (const topic of ['opções de prazo', 'governança de tempo', 'endpoint comprovado', 'task ligada', '`docs/milestone-time-guide.md`']) assert.ok(entry.includes(topic), topic);
  assert.ok(entry.includes('release, instalação e execução no cliente instalado não estão demonstradas') && entry.includes('UAT humano foi dispensado, não realizado'));
  assert.equal(sha(Buffer.from(changelog.replace(entry + '\n', ''), 'utf8')), CHANGELOG_PRE_SHA, 'only the feature entry was added; history unchanged');
  ok('chain-documentation-update-preserves-panel-qualification-and-unreleased-feature-scope');
}
// T07 worker inventory: the fourteen local verification commands, and the owner operations
// that stay pending with their own future evidence. Not an execution of any of them.
const INVENTORY = Object.freeze({
  worker_checks: Object.freeze(['forge-milestone-time-chain', 'forge-milestone-time', 'forge-claude-renderer', 'forge-codex-renderer', 'forge-dispatch-source-guard',
    'forge-communication-evaluation', 'forge-source-manifest', 'forge-procedure-context', 'forge-installer', 'forge-instructions', 'forge-delivery',
    'forge-release-version', 'forge-release-impact', 'forge-update'].map(name => `node scripts/${name}.test.js`)),
  owner_pending: Object.freeze(['consolidação da slice', 'regressão completa `node scripts/run-tests.js`', '`node scripts/forge-smoke.js`', 'security gate final',
    'revisão independente final', 'relatório de entrega por critério', 'auditoria da distribuição', 'PR, checks, merge, release e instalação']),
  uat: 'dispensado, não realizado',
  inventory_satisfied: 'inventory-and-handoff-only',
  downstream_completion_pending: true,
});
function inventoryGroup() {
  assert.equal(INVENTORY.worker_checks.length, 14);
  assert.equal(new Set(INVENTORY.worker_checks).size, 14);
  for (const command of INVENTORY.worker_checks) assert.ok(fs.existsSync(path.join(SOURCE, command.slice('node '.length))), command);
  const guide = read('docs/milestone-time-guide.md'), inventory = guide.slice(guide.indexOf('### Inventário de verificação da T07'));
  const listed = [...inventory.matchAll(/^\d+\. `(node scripts\/[a-z0-9-]+\.test\.js)`$/gm)].map(m => m[1]);
  assert.deepEqual(listed, [...INVENTORY.worker_checks], 'the documented worker checks are exactly the fourteen');
  for (const operation of INVENTORY.owner_pending) assert.ok(inventory.includes(operation), operation);
  assert.ok(inventory.includes('comparada rótulo a rótulo com o\n  baseline do `master` no mesmo ambiente'), 'label-by-label master comparison');
  assert.ok(inventory.includes('pendentes até evidência própria (não fazem parte dos 14)'));
  assert.ok(inventory.includes('UAT humano (S03-UAT): ' + INVENTORY.uat + '.'));
  // The inventory never reports pass/fail of an operation, and downstream work stays pending.
  assert.equal(INVENTORY.downstream_completion_pending, true);
  assert.ok(!Object.keys(INVENTORY).some(key => /pass|result|status/.test(key)));
  assert.ok(!/\b(?:passou|passaram|aprovad[oa]s?|concluíd[oa]s?)\b/i.test(inventory), 'no claim that checks or owner operations already passed');
  // This suite never runs the other thirteen worker checks nor owner operations itself.
  const self = fs.readFileSync(__filename, 'utf8');
  for (const forbidden of ['spawn' + 'Sync', 'execFile' + 'Sync', 'child_' + 'process']) assert.ok(!self.includes(forbidden), 'no nested execution of other suites: ' + forbidden);
  ok('chain-worker-inventory-separates-fourteen-checks-from-pending-owner-delivery-and-waived-uat');
}

async function main() {
  const realGsd = path.join(SOURCE, '.gsd');
  const realView = () => JSON.stringify(tree(path.join(realGsd, 'forge', 'runs'))) + JSON.stringify(fs.existsSync(path.join(realGsd, 'tasks')) ? fs.readdirSync(path.join(realGsd, 'tasks')) : []);
  const realBefore = realView();
  const step = async (name, fn) => {
    try { await fn(); } catch (error) { failures++; process.stdout.write('not ok - ' + name + '\n' + (error && error.stack || error) + '\n'); }
  };
  await step('guide', guideGroup);
  await step('documentation', documentationGroup);
  await step('inventory', inventoryGroup);
  // The two host chains are independent (own roots, profile, clock and module seams): each runs
  // this same suite in its own worker thread, so the hosts proceed in parallel.
  const hostFailures = await Promise.all(['claude', 'codex'].map(host => new Promise(resolve => {
    const worker = new Worker(__filename, { workerData: { host, base } });
    let reported = null;
    worker.on('message', message => { reported = message; });
    worker.on('error', error => { process.stdout.write('not ok - chain-' + host + '\n' + (error && error.stack || error) + '\n'); reported = { failures: 1 }; });
    worker.on('exit', code => resolve(reported ? reported.failures : 1 + Math.abs(code)));
  })));
  failures += hostFailures.reduce((sum, value) => sum + value, 0);
  assert.equal(realView(), realBefore, 'the real owner state was never touched');
}

if (!isMainThread) {
  hostChain(workerData.host).catch(error => { failures++; process.stdout.write('not ok - chain-' + workerData.host + '\n' + (error && error.stack || error) + '\n'); })
    .finally(() => parentPort.postMessage({ failures }));
} else {
  main().catch(error => { failures++; console.error(error); })
    .finally(() => {
      restoreEnv();
      fs.rmSync(base, { recursive: true, force: true });
      if (failures) { process.exitCode = 1; console.log(`${failures} chain group(s) failed`); }
      else console.log('milestone time chain: both hosts, documentation and inventory passed (temporary roots, simulated transports, no provider)');
    });
}
