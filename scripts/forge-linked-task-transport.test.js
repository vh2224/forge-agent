#!/usr/bin/env node
'use strict';

// S03/T05 linked transport: the task horizon and the milestone endpoint hold at every actual
// provider entry of both hosts. Every fixture is a real composition in temporary roots with a
// temporary personal profile: the S02 selection with a linked task, the T01 creation, a real Git
// owner/worktree history completed through the real controller with real runRootVerification
// envelopes and forge-delivery projections, the T02 endpoint and the T03 handoff/start, driven
// through their public APIs with one injected owner clock. Only the external transports are
// simulated (xllm.invokeClaudeTransport and xllm.invokeCodexAppServer, the native host callback),
// while runOwnedChild and startAppServerTurn are observed at their real seams; every override is
// restored in finally. No network, provider, real claim, lease or process of another run is touched.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const SELF = __filename;
const ADMISSION = path.join(__dirname, 'forge-milestone-time-admission.js');
const PROPOSALS = require('./fixtures/milestone-options/proposals.json');
const M = PROPOSALS.milestone, BRANCH = 'forge/' + M;
const CHECK = "const value = require('./result'); require('assert/strict').equal(typeof value, 'number');\n"
  + "if (process.argv[2]) require('assert/strict').equal(value, Number(process.argv[2]));\nconsole.log('PASS shared-source-behavior');\n";
const SUMMARY = `# ${M} Summary\n\nEntrega integrada verificada.\n\n## Forward Intelligence\n\n- Rode node scripts/check.js antes de mexer em result.js.\n\n## Decisões\n\n- Relatório SC4 fica na task ligada — relatório «único».\n`;
const PHASES = Object.freeze(['brainstorm', 'discuss', 'research', 'plan']);
const roots = [], createdNames = new Set();
let serial = 0;

const iso = v => new Date(v).toISOString();
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let loaded = null;
// Modules are loaded once the suite starts (the inert-import check runs in a fresh process).
function m() {
  if (loaded) return loaded;
  loaded = { admission: require('./forge-milestone-time-admission'), horizon: require('./forge-linked-task-horizon'), lts: require('./forge-linked-task-start'),
    time: require('./forge-milestone-time'), selection: require('./forge-milestone-time-selection'), questions: require('./forge-pending-questions'),
    controller: require('./forge-unit-controller'), delivery: require('./forge-delivery'), verify: require('./forge-verify'), codeRoots: require('./forge-code-roots'),
    endpoint: require('./forge-milestone-endpoint'), linked: require('./forge-linked-task'), runs: require('./forge-runs'), digest: require('./forge-code-roots').digest };
  return loaded;
}
function tempRoot(prefix) { const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); roots.push(dir); createdNames.add(path.basename(dir)); return dir; }
function file(cwd, ref) { return path.join(cwd, ...ref.split('/')); }
function write(cwd, ref, value) {
  const target = file(cwd, ref); fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value) + '\n'); return target;
}
function stable(v) { return Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v; }
function ssha(v) { return sha(JSON.stringify(stable(v))); }
function gitIn(cwd) { return args => require('./forge-git-process').git(cwd, args).trim(); }
function commit(git, message) { git(['add', '-A']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', message]); }
// Byte, size and mtime tree (lock directories excluded): equality proves zero writes.
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
function snap(f) { return { gsd: tree(path.join(f.owner, '.gsd')), home: tree(f.home), code: tree(path.join(f.code, 'scripts')) }; }
function unchanged(f, before, label) { assert.deepEqual(snap(f), before, label + ': zero writes'); }

// ---------------------------------------------------------------------------
// Live decision fixture: the trusted host observed the explicit persisted answer.
// ---------------------------------------------------------------------------
function liveAdapter(cwd, o = {}) {
  const { time, questions, digest } = m();
  return { getDecisionHandle(request) {
    const state = questions.continuation({ cwd, identity: request.question.identity_sha256 });
    const row = state.ok ? state.questions.find(q => q.id === request.question.id) : null;
    const clockAt = o.now ?? Date.now(), reference = 'live-' + request.question.id + '-' + (++serial);
    const resolve = () => ({ reference, status: 'resolved', source: 'user-text', resolved_at: iso(clockAt - 60000), answer: row && row.answer, question: { ...request.question } });
    return time.createDecisionAuthority(resolve).issue(reference, { milestone: request.milestone, kind: request.kind,
      request_sha256: digest(request.request), expires_at: clockAt + 600000 }, () => clockAt);
  } };
}
function transaction(cwd, key, fields) {
  const state = {}, unit = fields.unit;
  const record = { protocol_version: '1.0.0', idempotency_key: key, action: fields.action, unit, milestone: fields.milestone, host_runtime: 'codex',
    owner_digest: 'sha256:' + 'f'.repeat(64), lease_generation: 'fixture-generation', phase: 'committed', created_at: iso(fields.at), updated_at: iso(fields.at),
    before: { state_checksum: ssha(state), state }, after: { state_checksum: ssha(state), state, state_patch: {} },
    result: fields.result ? { idempotency_key: key, unit: unit.key, milestone: fields.milestone, status: fields.result } : null,
    event: { idempotency_key: key, unit: unit.key, milestone: fields.milestone, action: fields.action } };
  m().controller.writeAtomic(m().controller.transactionFile(cwd, key), record, false);
}

// ---------------------------------------------------------------------------
// Composed chain fixture: S02 selection with a linked task -> conformant ROADMAP -> canonical
// controller history over a real Git owner and milestone worktree -> T01 task (T02/T03 on demand).
// ---------------------------------------------------------------------------
function chainFixture(opts = {}) {
  const { selection, codeRoots, linked, runs, endpoint } = m();
  const T0 = Date.now() - 20 * 60000;
  const root = tempRoot('forge-ltt-'), owner = path.join(root, 'owner'), code = path.join(root, 'code'), home = path.join(root, 'home');
  fs.mkdirSync(owner); fs.mkdirSync(home); fs.mkdirSync(path.join(root, 'results'));
  const prof = { userHome: home, env: { HOME: home, USERPROFILE: home } };
  const og = gitIn(owner); og(['init', '--quiet', '-b', 'main']);
  write(owner, '.gitignore', '.gsd/\n'); write(owner, 'scripts/result.js', 'module.exports = 1;\n'); write(owner, 'scripts/check.js', CHECK); commit(og, 'r0 initial');
  og(['worktree', 'add', '--quiet', '-b', BRANCH, code]);
  const cg = gitIn(code);
  fs.mkdirSync(path.join(owner, '.gsd/forge'), { recursive: true });
  for (const k of ['SCOPE', 'CONTEXT', 'BRAINSTORM']) write(owner, `.gsd/milestones/${M}/${M}-${k}.md`, `# ${k}\nEscopo sintético\n`);
  assert.equal(selection.enroll(owner, M, { source: 'owner', now: T0 - 3600000 }).status, 'enrolled');
  const before = selection.readSelectionState(owner, M), key = selection.estimateBeginKey(M, before.key_suffix);
  const estimate = { type: 'estimate-milestone', id: M, key: 'estimate-milestone/' + M };
  transaction(owner, key, { action: 'begin', unit: estimate, milestone: M, at: T0 - 1800000 });
  transaction(owner, key + ':complete', { action: 'complete', unit: estimate, milestone: M, at: T0 - 1740000, result: 'succeeded' });
  write(owner, `.gsd/milestones/${M}/${M}-OPTIONS.json`, JSON.stringify(PROPOSALS.base, null, 2));
  assert.equal(selection.prepareBoundary(owner, M, { now: T0 - 600000 }).status, 'materialized');
  for (const label of ['Escolher posição', 'Com task ligada (media)', opts.explicit ? 'Criar sem iniciar' : 'Criar e iniciar após prova']) {
    const opened = selection.nextRound({ cwd: owner, milestone: M });
    assert.equal(opened.status, 'open', JSON.stringify(opened));
    assert.equal(selection.answerRound({ cwd: owner, milestone: M, round: opened.question_id, response: label, source: 'user-text' }).status, 'answered');
  }
  const decided = selection.decide({ cwd: owner, milestone: M, liveAdapter: liveAdapter(owner, { now: T0 }), now: T0, prefsReader: () => ({ ok: true, prefs: {} }) });
  assert.equal(decided.status, 'decided', JSON.stringify(decided));
  const skeleton = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(selection.promptBlock(owner, M))[1]);
  skeleton.allocation = [{ id: 'prep', kind: 'preparation', ms: 600000, nodes: ['PREP'] }, { id: 's1', kind: 'slice', slice: 'S01', ms: 1800000, nodes: ['N1'] },
    { id: 's2', kind: 'slice', slice: 'S02', ms: 1200000, nodes: ['N2'] }, { id: 'int', kind: 'integration', ms: 600000, nodes: ['INT'] },
    { id: 'rev', kind: 'review', ms: 600000, nodes: ['REV'] }, { id: 'cor', kind: 'corrections', ms: 600000, nodes: ['COR'] }];
  const roadmap = `# ${M}: Fixture — Roadmap\n\n## Slices\n\n- [x] **S01: Contrato** \`risk:low\` \`depends:[]\`\n- [x] **S02: Seleção** \`risk:low\` \`depends:[S01]\`\n\n`
    + `## Alocação de tempo\n\n\`\`\`json\n${JSON.stringify(skeleton, null, 2)}\n\`\`\`\n`;
  const timeDir = path.join(owner, '.gsd/forge/time', M), hidden = path.join(root, 'time-aside');
  fs.renameSync(timeDir, hidden);
  const execution = codeRoots.singleContract(owner, code);
  history({ owner, code, cg, execution, roadmap });
  write(owner, `.gsd/milestones/${M}/${M}-SUMMARY.md`, SUMMARY);
  fs.renameSync(hidden, timeDir);
  const allocated = selection.prepareBoundary(owner, M, { now: Date.now() });
  assert.equal(allocated.status, 'allocated', JSON.stringify(allocated));
  const created = linked.createLinkedTask({ cwd: owner, milestone: M, liveAdapter: liveAdapter(owner), now: Date.now(), ...prof });
  assert.equal(created.status, 'created', JSON.stringify(created));
  runs.add(owner, { id: M, kind: 'milestone', session_id: 'fixture-milestone-run', active: false, isolation_mode: 'worktree', branch: BRANCH,
    worktrees: [{ repo: owner, path: code }], project: owner, cwd: owner });
  const f = { root, owner, code, home, prof, og, cg, task: created.task_id };
  f.endpoint = () => {
    assert.equal(endpoint.writeEndpointVerification({ cwd: owner, milestone: M }).status, 'verified');
    assert.equal(endpoint.recordEndpoint({ cwd: owner, milestone: M }).status, 'recorded');
    return endpoint.readEndpoint({ cwd: owner, milestone: M });
  };
  return f;
}
function history(h) {
  const { controller, verify, delivery } = m();
  const dir = `.gsd/milestones/${M}`;
  const inventoryReader = () => ({ slices: [{ id: 'S01', tasks: [{ id: 'T01' }] }, { id: 'S02', tasks: [{ id: 'T01' }] }] });
  const finish = (unit, slice) => {
    require('./forge-state').write(h.owner, { milestone: M, kind: 'milestone', phase: unit.split('/')[0], active_slice: slice || 'S02',
      active_task: unit.startsWith('execute-task/') ? unit.split('/')[1] : '—', next_action: 'complete', auto_mode: 'on' });
    const request = { milestone: M, unit, host_runtime: 'codex', owner_token: 'fixture-owner', ...(slice ? { slice } : {}) };
    const at = Date.now() + 1, o = { now: () => at, prefsReader: () => ({ ok: true, prefs: {} }), inventoryReader };
    const begun = controller.begin(h.owner, { ...request, idempotency_key: unit + ':' + (slice || 'M') + ':begin' }, o);
    const done = controller.complete(h.owner, { ...request, generation: begun.generation, idempotency_key: unit + ':' + (slice || 'M') + ':complete', result: { status: 'succeeded' } }, o);
    assert.equal(done.transaction.phase, 'committed');
  };
  const tasks = [['S01', { writes: ['scripts/result.js', 'scripts/check.js'], output: 'scripts/result.js', verify: ['node scripts/check.js'] }],
    ['S02', { writes: ['scripts/result.js'], output: 'scripts/result.js', verify: ['node scripts/check.js', 'node scripts/check.js 2'], source: 'module.exports = 2;\n' }]];
  const sliceChildren = [];
  for (const [slice, task] of tasks) {
    const sdir = `${dir}/slices/${slice}`, unit = { type: 'task', id: 'T01', slice, milestone: M }, base = `${sdir}/tasks/T01/T01`;
    if (task.source) { write(h.code, 'scripts/result.js', task.source); commit(h.cg, slice + ' legitimately changes the shared source'); }
    const plan = `---\nid: T01\ndepends: []\nwrites:\n${task.writes.map(w => `  - ${w}\n`).join('')}`
      + `must_haves:\n  truths:\n    - observed shared source behavior\n  artifacts: []\n  key_links: []\nexpected_output:\n  - ${task.output}\n`
      + `verify:\n${task.verify.map(c => `  - ${c}\n`).join('')}---\n`;
    write(h.owner, base + '-PLAN.md', plan);
    const gate = verify.runRootVerification(h.execution, { unit, planFingerprint: sha(plan), taskPlanVerify: verify.parsePlanVerify(plan), commandTimeoutMs: 60000 });
    assert.equal(gate.passed, true, JSON.stringify(gate.roots.map(r => r.result.checks.map(c => [c.command, c.exitCode, c.stderr]))));
    write(h.owner, base + '-VERIFY-ENVELOPE.json', gate.roots[0]);
    const input = { schema_version: 2, execution_contract: h.execution, unit, plan: base + '-PLAN.md', plan_fingerprint: sha(plan),
      bindings: [{ criterion: { kind: 'truth', index: 0 }, aspect: 'default', coverage: 'behavioral', source: { kind: 'verification', path: base + '-VERIFY-ENVELOPE.json', check_index: 0 } }] };
    write(h.owner, base + '-DELIVERY-INPUT.json', input);
    const projected = delivery.buildDelivery(input, { ownerRoot: h.owner, codeDir: h.code });
    assert(projected.criteria.every(r => r.status === 'verificado'), JSON.stringify([projected.diagnostics, projected.criteria]));
    write(h.owner, base + '-DELIVERY.json', projected);
    finish('execute-task/T01', slice);
    write(h.owner, `${sdir}/${slice}-PLAN.md`, `# ${slice}\n- [x] T01: verified child\n`); write(h.owner, `${sdir}/${slice}-REVIEW.md`, `# Revisão ${slice}\nSem objeções.\n`);
    const sliceInput = { schema_version: 1, unit: { type: 'slice', id: slice, milestone: M }, plan: `${sdir}/${slice}-PLAN.md`, plan_fingerprint: sha(`# ${slice}\n- [x] T01: verified child\n`),
      expected_children: [{ unit, delivery: base + '-DELIVERY.json' }], bindings: [], facts: { review: { status: 'aprovado', reference: `${slice}-REVIEW.md` } } };
    write(h.owner, `${sdir}/${slice}-DELIVERY-INPUT.json`, sliceInput);
    const sliceDelivery = delivery.buildDelivery(sliceInput, { ownerRoot: h.owner, codeDir: h.code });
    assert(sliceDelivery.criteria.every(r => r.status === 'verificado'), JSON.stringify(sliceDelivery.diagnostics));
    write(h.owner, `${sdir}/${slice}-DELIVERY.json`, sliceDelivery);
    finish('complete-slice/' + slice, slice);
    sliceChildren.push({ unit: { type: 'slice', id: slice, milestone: M }, delivery: `${sdir}/${slice}-DELIVERY.json` });
  }
  write(h.owner, `${dir}/${M}-ROADMAP.md`, h.roadmap);
  const milestoneInput = { schema_version: 2, unit: { type: 'milestone', id: M }, plan: `${dir}/${M}-ROADMAP.md`, plan_fingerprint: sha(h.roadmap),
    execution_contract: h.execution, expected_children: sliceChildren, bindings: [] };
  write(h.owner, `${dir}/${M}-DELIVERY-INPUT.json`, milestoneInput);
  const projection = delivery.buildDelivery(milestoneInput, { ownerRoot: h.owner, codeDir: h.code });
  assert(projection.criteria.length > 0 && projection.criteria.every(r => r.status === 'verificado'), JSON.stringify(projection.diagnostics));
  write(h.owner, `${dir}/${M}-DELIVERY.json`, projection);
  finish('complete-milestone/' + M, null);
}
function startTask(f) {
  return m().lts.startLinkedTask({ cwd: f.owner, taskId: f.task, liveAdapter: liveAdapter(f.owner), codeDir: f.code, base: { kind: 'milestone-branch' },
    isolation: { mode: 'worktree', attached_to: M }, ...f.prof });
}
// Real standalone task delivery of the linked task (forge-task-execution locations).
function taskDelivery(f) {
  const { codeRoots, verify, delivery } = m();
  const T = f.task, prefix = `.gsd/tasks/${T}/${T}`;
  const plan = `---\nid: ${T}\ndepends: []\nwrites:\n  - scripts/result.js\nmust_haves:\n  truths:\n    - linked report behavior verified\n  artifacts: []\n  key_links: []\n`
    + `expected_output:\n  - scripts/result.js\nverify:\n  - node scripts/check.js\n---\n`;
  write(f.owner, prefix + '-PLAN.md', plan);
  const contract = codeRoots.singleContract(f.owner, f.code), unit = { type: 'task', id: T };
  const gate = verify.runRootVerification(contract, { unit, planFingerprint: sha(plan), taskPlanVerify: verify.parsePlanVerify(plan), commandTimeoutMs: 60000 });
  assert.equal(gate.passed, true);
  write(f.owner, prefix + '-VERIFY-ENVELOPE.json', gate.roots[0]);
  const input = { schema_version: 2, execution_contract: contract, unit, plan: prefix + '-PLAN.md', plan_fingerprint: sha(plan),
    bindings: [{ criterion: { kind: 'truth', index: 0 }, aspect: 'default', coverage: 'behavioral', source: { kind: 'verification', path: prefix + '-VERIFY-ENVELOPE.json', check_index: 0 } }] };
  write(f.owner, prefix + '-DELIVERY-INPUT.json', input);
  write(f.owner, prefix + '-DELIVERY.json', JSON.stringify(delivery.buildDelivery(input, { ownerRoot: f.owner, codeDir: f.code }), null, 2) + '\n');
  write(f.owner, prefix + '-SUMMARY.md', '# Summary\n\nTask ligada concluída.\n');
}
// Owner routing preferences of one host route (the real resolver reads them).
function prefs(f, model) {
  write(f.owner, '.gsd/forge-prefs.jsonc', JSON.stringify({ tier_models: { light: model, standard: model, heavy: model, max: model },
    effort: { 'plan-slice': 'medium', 'discuss-milestone': 'medium', 'research-milestone': 'medium', 'plan-milestone': 'medium' } }));
}
function prepRequest(f, host, phase, label, extra = {}) {
  return { schema_version: 1, scope: 'standalone-task', phase, taskId: f.task, cwd: f.code, contextRoot: f.owner, hostRuntime: host,
    workflowId: 'linked-' + label, dispatchId: 'linked-' + label + '-dispatch', resultFile: path.join(f.root, 'results', label + '.json'),
    constraints: { auto_commit: false, deploy: false }, inputs: { brief: 'Task ligada ' + label }, prompt: '## Task Brief\n\n# Task ligada ' + label + '\n', ...extra };
}
// Genuine standalone native EXECUTION of the started linked task (execute-task, phase execute):
// the real code-roots Plan of the native execution fixtures, approved plan gate and security
// checklist in the owner, CODE_DIR distinct from the owner, the real write claim recorded on the
// task's own run and the real native invocation binding of each host (Codex spawn_agent
// arguments; Claude Agent tool with the observed forge-executor frontmatter effort).
const NATIVE_CAPS = Object.freeze({
  codex: { available: true, tool: 'spawn_agent', source: 'fixture-active-tool', models: ['gpt-5.6-sol'], reasoning_efforts: ['medium', 'high'], fork_turns: ['none'] },
  claude: { available: true, tool: 'Agent', source: 'fixture-active-tool', model_aliases: ['sonnet'], effort_transports: ['agent-frontmatter'] } });
const NATIVE_MODELS = Object.freeze({ codex: 'gpt-5.6-sol', claude: 'claude-sonnet-5' });
function executorBinding() {
  const agentPath = path.join(__dirname, '..', 'agents', 'forge-executor.md');
  return { transport: 'agent-frontmatter', agentPath, sourceFingerprint: 'sha256:' + sha(fs.readFileSync(agentPath)) };
}
// o.models/o.caps: an ordered routed candidate list with the matching active host capabilities
// (the recovery case needs a second routed candidate); the defaults keep the single host route.
function nativeExecutionRequest(f, host, label, o = {}) {
  const { codeRoots } = m();
  const caps = o.caps || NATIVE_CAPS[host];
  const T = f.task, dir = path.join(f.owner, '.gsd', 'tasks', T), planFile = path.join(dir, T + '-PLAN.md');
  const contract = codeRoots.validateContract({ schema_version: 2, owner: f.owner, primary_root_id: 'app', code_roots: [{ id: 'app', path: f.code }] });
  const plan = require('./forge-code-roots.test').plan(contract).replaceAll('same.txt', 'scripts/result.js').replace('tier: standard', 'tier: heavy\ndomain: frontend');
  write(f.owner, `.gsd/tasks/${T}/${T}-PLAN.md`, plan);
  write(f.owner, `.gsd/tasks/${T}/${T}-PLAN-GATE.md`, '---\nstatus: approved\n---\n');
  write(f.owner, `.gsd/tasks/${T}/${T}-SECURITY.md`, 'Checklist de segurança obrigatório da task ligada.\n');
  write(f.owner, '.gsd/forge-prefs.jsonc', JSON.stringify({ routing: { frontend: { executor: { heavy: o.models || [NATIVE_MODELS[host]] } } },
    effort: { 'execute-task': 'medium' }, token_budget: { coding_standards: 32 } }));
  const route = require('./forge-dispatch-resolve').resolveDispatch({ cwd: f.owner, unitType: 'execute-task', scope: 'standalone-task', phase: 'execute',
    planPath: planFile, hostRuntime: host, unitId: T });
  assert.deepEqual([route.worker_mode, route.resolved_worker_engine], ['native', host], JSON.stringify(route).slice(0, 300));
  const claims = require('./forge-write-claim');
  if (require('./forge-runs').get(f.owner, T)?.write_claim) claims.clearClaim(f.owner, T);
  const claim = claims.recordClaim(f.owner, T, { schema_version: 2, execution_contract: contract, source: 'plan-writes', unit: 'execute-task/' + T,
    paths: [{ root_id: 'app', path: 'scripts/result.js' }] });
  const taskName = 'linked_native_' + label.replace(/[^a-z0-9]/g, '_');
  const r = { cwd: f.code, contextRoot: f.owner, scope: 'standalone-task', phase: 'execute', unitType: 'execute-task', taskId: T, planFile, route,
    workflowId: 'linked-native-' + label, dispatchId: 'linked-native-' + label, resultFile: path.join(f.root, 'results', 'native-' + label + '.json'),
    gates: { plan: 'approved', security: 'passed', claim: 'proceed' }, constraints: { auto_commit: false, deploy: false },
    runId: T, claim, execution_contract: contract, verification: { preferenceCommands: ['node -e "process.exit(0)"'] },
    nativePromptFile: path.join(f.root, 'results', 'native-' + label + '-prompt.txt'), taskName,
    ...(host === 'claude' ? { effortBinding: executorBinding() } : {}) };
  r.nativeInvocation = require('./forge-native-invocation').buildNativeInvocation({ hostRuntime: host, resolvedDispatch: route, activeCapabilities: caps,
    agentType: 'forge-executor', taskName, forkTurns: 'none', prompt: 'binding preflight', ...(host === 'claude' ? { effortBinding: r.effortBinding } : {}) });
  assert.equal(r.nativeInvocation.ok, true, JSON.stringify(r.nativeInvocation).slice(0, 300));
  if (host === 'claude') assert.equal(r.nativeInvocation.telemetry.effort_binding_observed, 'medium', 'the observed forge-executor frontmatter effort');
  return r;
}
function cleanup() {
  for (const dir of roots.splice(0).reverse()) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
function leftovers(prefix) {
  return fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(prefix) && createdNames.has(n) && fs.existsSync(path.join(os.tmpdir(), n)));
}

// ---------------------------------------------------------------------------
// Fresh-process probes
// ---------------------------------------------------------------------------
function child(payload) {
  // The payload travels on stdin (a retained delivery request exceeds the Windows command line).
  const run = spawnSync(process.execPath, [SELF, '--child'],
    { input: Buffer.from(JSON.stringify(payload)).toString('base64'), encoding: 'utf8', timeout: 90000, env: { ...process.env, ...(payload.home ? { HOME: payload.home, USERPROFILE: payload.home } : {}), ...(payload.env || {}) } });
  assert.equal(run.status, 0, [run.error && run.error.code, run.signal, run.stderr, String(run.stdout || '').slice(-2000)].join('\n'));
  return JSON.parse(run.stdout.trim().split('\n').pop());
}
function childMain() {
  const a = JSON.parse(Buffer.from(fs.readFileSync(0, 'utf8').trim(), 'base64').toString('utf8'));
  if (a.mode === 'inert') {
    // Import is inert: no local module and no filesystem read while the module body runs.
    const Module = require('module'), source = fs.readFileSync(ADMISSION, 'utf8'), saved = Module._load;
    const reads = ['readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'existsSync', 'openSync'], originals = Object.fromEntries(reads.map(k => [k, fs[k]]));
    let exported;
    try {
      Module._load = function (id, parent, ...rest) { if (parent?.filename === ADMISSION && id.startsWith('.')) throw Error('eager local ' + id); return saved.call(this, id, parent, ...rest); };
      for (const k of reads) fs[k] = () => { throw Error('import I/O ' + k); };
      const mod = new Module(ADMISSION, module); mod.filename = ADMISSION; mod.paths = module.paths; mod._compile(source, ADMISSION);
      exported = mod.exports;
    } finally { Module._load = saved; Object.assign(fs, originals); }
    process.stdout.write(JSON.stringify({ reasons: exported.TIME_REASON_CODES, transport: exported.TRANSPORT_REFUSAL_CODES, states: exported.TIME_STATES,
      frozen: ['TIME_REASON_CODES', 'TRANSPORT_REFUSAL_CODES', 'TIME_STATES', 'ADMISSION_DECISIONS'].every(k => Object.isFrozen(exported[k])) }) + '\n');
    return;
  }
  if (a.mode === 'status') {
    // Both public entry directions in a fresh process: the milestone projection composes the
    // linked horizons and the linked projection reads the milestone, without recursion.
    const admission = require('./forge-milestone-time-admission'), horizon = require('./forge-linked-task-horizon');
    const calls = { linked: 0, time: 0, milestoneOnly: 0 };
    const readLinked = horizon.readLinkedStatus, readTime = admission.readTimeStatus, readMilestone = admission.readMilestoneTimeStatus;
    horizon.readLinkedStatus = function (...args) { calls.linked++; return readLinked.apply(this, args); };
    admission.readTimeStatus = function (...args) { calls.time++; return readTime.apply(this, args); };
    admission.readMilestoneTimeStatus = function (...args) { calls.milestoneOnly++; return readMilestone.apply(this, args); };
    const milestone = admission.readTimeStatus(a.cwd, a.milestone, { now: a.now });
    const afterMilestone = { ...calls };
    const linkedView = horizon.readLinkedStatus({ cwd: a.cwd, task: a.task, now: a.now });
    const total = { ...calls };
    // A caller literally named readLinkedStatus and a deep caller (many frames) use the original reader.
    const named = { readLinkedStatus() { return readTime(a.cwd, a.milestone, { now: a.now }); } }.readLinkedStatus();
    const deep = n => n > 0 ? deep(n - 1) : readTime(a.cwd, a.milestone, { now: a.now });
    process.stdout.write(JSON.stringify({ milestone, linked: linkedView, named, deep: deep(400), calls: { afterMilestone, total } }) + '\n');
  }
  if (a.mode === 'claude-owned') {
    // Fresh isolated process: nothing is stubbed. The actual xllm.invokeClaudeTransport packages
    // the turn and reaches its private (lexical) runOwnedChild spawn; only the external account
    // registry, the version probe and the CLI process are fixtures (temporary HOME registry/token
    // file and a fake CLI binary through FORGE_XLLM_CLAUDE_BIN, set by the parent). The common
    // owner guard is observed, never replaced; the injected clock crosses the cap inside the real
    // packaging callback when a.crossing.
    let clock = a.below;
    const now = () => clock;
    const admission = require('./forge-milestone-time-admission'), xllm = require('./forge-xllm');
    const ownerGuard = admission.assertOwnerTransportEntry, guards = [];
    admission.assertOwnerTransportEntry = function (options) {
      guards.push({ task: options?.request?.taskId ?? null, injected: options?.now === now, at: clock });
      return ownerGuard.apply(this, arguments);
    };
    const realTransport = xllm.invokeClaudeTransport.name === 'invokeClaudeTransport' && /invokeClaudeSidecar\(/.test(String(xllm.invokeClaudeTransport));
    let packaged = 0;
    return require('./forge-unit-sidecar').runUnitSidecar(a.request, { now, onPackagedContext: () => { packaged++; if (a.crossing) clock = a.afterCap; } })
      .then(value => ({ ok: true, status: value?.status ?? null }),
        error => ({ ok: false, code: error?.code ?? null, provider_called: error?.provider_called, stage: error?.stage ?? null, layer: error?.layer ?? null }))
      .then(out => { admission.assertOwnerTransportEntry = ownerGuard; process.stdout.write(JSON.stringify({ out, packaged, guards, realTransport }) + '\n'); });
  }
}

// ---------------------------------------------------------------------------
// Transport seams (simulated externally, observed at the real child/app-server seams)
// ---------------------------------------------------------------------------
function seams() {
  const xllm = require('./forge-xllm'), claude = require('./forge-claude-sidecar'), client = require('./forge-appserver-client');
  const saved = { claude: xllm.invokeClaudeTransport, codex: xllm.invokeCodexAppServer, child: claude.runOwnedChild, turn: client.startAppServerTurn };
  const s = { calls: { claude: 0, codex: 0, child: 0, turn: 0 }, prompts: [] };
  const candidate = () => ({ status: 'partial', summary: 'fixture', questions: [], artifacts: [] });
  xllm.invokeClaudeTransport = async options => { s.calls.claude++; s.prompts.push(options.prompt); return { candidate: candidate(), telemetry: null }; };
  xllm.invokeCodexAppServer = async options => { s.calls.codex++; s.prompts.push(options.prompt); return { finalText: JSON.stringify(candidate()) }; };
  claude.runOwnedChild = () => { s.calls.child++; throw Object.assign(Error('real child forbidden'), { code: 'fixture-child-forbidden' }); };
  client.startAppServerTurn = () => { s.calls.turn++; throw Object.assign(Error('real app-server forbidden'), { code: 'fixture-turn-forbidden' }); };
  s.restore = () => { xllm.invokeClaudeTransport = saved.claude; xllm.invokeCodexAppServer = saved.codex; claude.runOwnedChild = saved.child; client.startAppServerTurn = saved.turn; };
  // The real adapter (its packaging and last launch hook) for the pre-spawn seam cases; the
  // child/app-server seams stay observed and forbidden.
  s.realCodex = saved.codex; s.fakeCodex = xllm.invokeCodexAppServer;
  s.total = () => s.calls.claude + s.calls.codex + s.calls.child + s.calls.turn;
  return s;
}
function refusal(code) {
  return error => error && error.code === code && error.provider_called === false;
}
function line(text) { process.stdout.write('ok - T05 linked transport: ' + text + '\n'); }

async function suite() {
  const suiteHome = tempRoot('forge-ltt-home-'), saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const realGsd = path.join(__dirname, '..', '.gsd');
  const realView = () => JSON.stringify(tree(path.join(realGsd, 'forge', 'runs'))) + JSON.stringify(fs.existsSync(path.join(realGsd, 'tasks')) ? fs.readdirSync(path.join(realGsd, 'tasks')) : []);
  const realBefore = realView();
  process.env.HOME = suiteHome; process.env.USERPROFILE = suiteHome;
  const pending = [];
  let passed = false;
  try {
    // =====================================================================
    // Truth 0: exact frozen vocabularies, inert import (fresh process) and unchanged consumers.
    // =====================================================================
    const inert = child({ mode: 'inert' });
    const { admission, horizon, lts, time, controller, linked } = m();
    const recovery = require('./forge-attempt-recovery'), orchestrate = require('./forge-orchestrate');
    const prep = require('./forge-task-preparation'), unit = require('./forge-unit-sidecar'), xllm = require('./forge-xllm');
    const BUDGET = ['milestone-budget-exhausted', 'milestone-budget-draining', 'milestone-time-invalid', 'milestone-clock-unknown'];
    assert.deepEqual(inert.reasons, [...BUDGET, 'time-option-pending', 'milestone-endpoint-closed']);
    assert.deepEqual(inert.transport, [...BUDGET, 'milestone-endpoint-closed', ...horizon.LINKED_TASK_TRANSPORT_CODES]);
    assert.deepEqual(inert.states, ['active', 'warning', 'exhausted', 'draining', 'checkpointed', 'extended', 'endpoint-proven']);
    assert.equal(inert.frozen, true);
    assert.deepEqual([...admission.TRANSPORT_REFUSAL_CODES], inert.transport);
    assert.ok(horizon.LINKED_TASK_TRANSPORT_CODES.every(c => !admission.TIME_REASON_CODES.includes(c)), 'linked codes stay out of the milestone reason list');
    for (const list of [admission.TIME_REASON_CODES, admission.TRANSPORT_REFUSAL_CODES, admission.TIME_STATES]) assert.ok(Object.isFrozen(list));
    // Unchanged consumers classify every new code through the exported lists.
    assert.ok(controller.REASON_CODES.includes('milestone-endpoint-closed') && orchestrate.REASON_CODES.includes('milestone-endpoint-closed'));
    for (const code of ['milestone-endpoint-closed', ...horizon.LINKED_TASK_TRANSPORT_CODES]) {
      const session = recovery.createRecovery({ unit: 'execute-task/T-20261105000000-x', roots_sha256: 'fixture',
        request: { scope: 'standalone-task', phase: 'execute', unitType: 'execute-task', taskId: 'T-20261105000000-x', cwd: suiteHome, contextRoot: suiteHome,
          route: { host_runtime: 'claude', resolved_worker_engine: 'claude', worker_mode: 'sidecar' } } });
      session.record({ reason_code: code, failure_class: 'caller', route: { host_runtime: 'claude' }, layer: 'milestone-time-admission', provider_called: false,
        request_sha256: 'fixture-request', context_sha256: 'fixture-context', request_bytes: 1, context_bytes: 1, duration_ms: 0, budgets: {} });
      const next = await session.next({ inspection: { process_stopped: true, receipt_checked: true, writer_possible: false }, correction: { approved: true },
        validateInvocation: () => { throw Error('unexpected candidate'); } });
      assert.deepEqual([next.action, next.reason_code, next.provider_called], ['stop', code, false], code);
      assert.ok(!session.snapshot().reservations?.length, code + ': no reservation');
    }

    // =====================================================================
    // Fixture F (chained) — blocked lifecycle.
    // =====================================================================
    const started0 = Date.now();
    const F = chainFixture();
    const T = F.task, UNIT = 'execute-task/' + T, prof = F.prof;
    const fixtureMs = Date.now() - started0;
    const taskRequest = { scope: 'standalone-task', phase: 'execute', taskId: T, unitType: 'execute-task', cwd: F.code, contextRoot: F.owner };

    // =====================================================================
    // Truth 2 and key link 0: exclusive context, owner contextRoot, lazy live guard, unlinked clock free.
    // =====================================================================
    const guardCalls = [], statusCalls = [];
    const realAssert = horizon.assertLinkedTaskEntry, realStatus = horizon.readLinkedStatus;
    horizon.assertLinkedTaskEntry = function (input) { guardCalls.push(input); return realAssert.call(this, input); };
    horizon.readLinkedStatus = function (input) { statusCalls.push(input); return realStatus.call(this, input); };
    try {
      let before = snap(F);
      assert.throws(() => admission.assertOwnerTransportEntry({ request: taskRequest }), refusal('predecessor-incomplete'));
      assert.equal(guardCalls.length, 1);
      assert.deepEqual([guardCalls[0].cwd, guardCalls[0].taskId, guardCalls[0].unit], [F.owner, T, UNIT], 'owner contextRoot (not CODE_DIR), task and unit');
      // The admission keeps the guard's own result: the same direct call refuses identically.
      let direct = null; try { realAssert({ cwd: F.owner, taskId: T, unit: UNIT }); } catch (e) { direct = e; }
      let viaOwner = null; try { admission.assertOwnerTransportEntry({ request: taskRequest }); } catch (e) { viaOwner = e; }
      assert.deepEqual([viaOwner.code, viaOwner.stage, viaOwner.layer, viaOwner.provider_called], [direct.code, direct.stage, direct.layer, false]);
      // Validated preparation telemetry identity: the phase contract unit type.
      const validated = prep.validateRequest(prepRequest(F, 'claude', 'research', 'identity'));
      assert.throws(() => admission.assertOwnerTransportEntry({ telemetryIdentity: validated }), refusal('predecessor-incomplete'));
      assert.equal(guardCalls.at(-1).unit, 'research-milestone/' + T);
      // Explicit task context accepted; milestone context is a separate positive path.
      assert.throws(() => admission.assertOwnerTransportEntry({ milestoneTimeContext: { cwd: F.owner, task: T, unit: UNIT } }), refusal('predecessor-incomplete'));
      const milestoneEntry = admission.assertOwnerTransportEntry({ milestoneTimeContext: { cwd: F.owner, milestone: M, unit: 'review-slice/S02' } });
      assert.ok(['admitted', 'no-contract'].includes(milestoneEntry.decision), JSON.stringify(milestoneEntry));
      const invalidContexts = [{ cwd: F.owner, milestone: M, task: T, unit: UNIT }, { cwd: F.owner, unit: UNIT }, { cwd: F.owner, task: T },
        { cwd: F.owner, task: 'T01', unit: 'execute-task/T01' }, { cwd: F.owner, task: T, unit: 'execute-task/T-20261105000000-other' },
        { cwd: F.owner, task: T, unit: UNIT, now: Date.now() }, { cwd: '', task: T, unit: UNIT }, [F.owner, T], 'contexto'];
      for (const context of invalidContexts) {
        assert.throws(() => admission.assertOwnerTransportEntry({ milestoneTimeContext: context }), refusal('milestone-time-invalid'), JSON.stringify(context));
      }
      // Identity divergent from the retained request, or a task context over a milestone request.
      assert.throws(() => admission.assertOwnerTransportEntry({ request: { ...taskRequest, taskId: 'T-20261105000000-other' }, milestoneTimeContext: { cwd: F.owner, task: T, unit: UNIT } }), refusal('milestone-time-invalid'));
      assert.throws(() => admission.assertOwnerTransportEntry({ request: taskRequest, milestoneTimeContext: { cwd: F.code, task: T, unit: UNIT } }), refusal('milestone-time-invalid'));
      assert.throws(() => admission.assertOwnerTransportEntry({ request: { scope: 'milestone', milestoneId: M, unitType: 'plan-slice', sliceId: 'S02', cwd: F.owner },
        milestoneTimeContext: { cwd: F.owner, task: T, unit: UNIT } }), refusal('milestone-time-invalid'));
      unchanged(F, before, 'context validation and blocked refusals');
      // Unlinked task and legacy identifiers: no time state is read and nothing is returned, as before.
      const trapped = ['readContract', 'readOwnerRecord', 'readTaskLink', 'readSelection', 'readJournal', 'readOwnerJournal', 'listOwnerRecords'];
      const originals = Object.fromEntries(trapped.map(name => [name, time[name]]));
      const plain = 'T-20261105120000-plain-task';
      try {
        for (const name of trapped) time[name] = () => { throw new Error('unexpected time access: ' + name); };
        assert.equal(admission.assertOwnerTransportEntry({ request: { ...taskRequest, taskId: plain } }), undefined);
        assert.equal(admission.assertOwnerTransportEntry({ telemetryIdentity: { ...taskRequest, taskId: plain } }), undefined);
        assert.equal(admission.assertOwnerTransportEntry({ request: { ...taskRequest, taskId: 'T01' } }), undefined);
      } finally { Object.assign(time, originals); }
      // A typed task request without any owner root cannot be probed: it fails closed before any provider.
      assert.throws(() => admission.assertOwnerTransportEntry({ request: { scope: 'standalone-task', taskId: plain, phase: 'execute' } }), refusal('linked-task-time-invalid'));
      line('owner transport validates exclusive task context and leaves unlinked requests clock free');

      // =====================================================================
      // Truth 1: endpoint freezes the milestone status and closes new entry; replays continue.
      // =====================================================================
      const preEndpoint = admission.readTimeStatus(F.owner, M, { now: Date.now() });
      assert.equal(preEndpoint.horizon.task.task_id, T);
      assert.equal(preEndpoint.horizon.task.lifecycle, 'blocked');
      assert.equal(preEndpoint.horizon.chain.governs, false);
      assert.ok(!Object.hasOwn(preEndpoint.horizon, 'endpoint_proof'), 'no endpoint key before the proof');
      assert.ok(!Object.hasOwn(admission.summarizeTimeStatus(preEndpoint), 'endpoint'));
      const proof = F.endpoint();
      assert.equal(proof.status, 'valid');
      const at1 = Date.now(), frozen = admission.readTimeStatus(F.owner, M, { now: at1 });
      // The raw status of the proven endpoint is endpoint-proven; the canonical budget label at the
      // frozen consumption is kept separately in budget_state (only in this terminal case).
      assert.equal(frozen.state, 'endpoint-proven');
      assert.ok(['active', 'warning', 'extended'].includes(frozen.budget_state), frozen.budget_state);
      assert.ok(!Object.hasOwn(preEndpoint, 'budget_state'), 'no budget_state key before the endpoint');
      assert.deepEqual(Object.keys(frozen).slice(0, 5), ['contract', 'contract_version', 'state', 'budget_state', 'horizon']);
      assert.deepEqual(frozen.horizon.endpoint_proof, { at: proof.record.endpoint_at, sha256: proof.sha256 });
      assert.equal(frozen.clocks.consumed_ms, proof.record.clock.consumed_ms, 'frozen consumption from the endpoint snapshot');
      assert.equal(frozen.remaining_ms, frozen.horizon.ceiling_ms - proof.record.clock.consumed_ms);
      // The record's snapshot stays pre-endpoint (taken before the freeze).
      assert.ok(m().endpoint.SNAPSHOT_TIME_STATES.includes(proof.record.time_state.state) && proof.record.time_state.state !== 'endpoint-proven');
      const later = admission.readTimeStatus(F.owner, M, { now: at1 + 3600000 });
      assert.deepEqual([later.state, later.budget_state, later.clocks.consumed_ms, later.remaining_ms], [frozen.state, frozen.budget_state, frozen.clocks.consumed_ms, frozen.remaining_ms],
        'elapsed time never consumes after the endpoint');
      const summary = admission.summarizeTimeStatus(frozen);
      assert.equal(summary.state, 'endpoint-proven');
      assert.deepEqual(summary.endpoint, { proven: true, at: proof.record.endpoint_at, sha256: proof.sha256, budget_state: frozen.budget_state });
      assert.deepEqual(Object.keys(summary), ['state', 'ceiling_ms', 'consumed_ms', 'unknown_ms', 'remaining_ms', 'forecast', 'last_warning', 'unknown', 'decision_pending', 'endpoint', 'task', 'chain']);
      assert.deepEqual(summary.chain && summary.chain.governs, false);
      // The genuine budget of the proven endpoint is what the T03 predecessor proof consumes.
      const proven = lts.provePredecessor({ cwd: F.owner, task: T, now: at1, ...prof });
      assert.deepEqual([proven.status, proven.current.state], ['proven', frozen.budget_state], JSON.stringify(proven));
      const linkedNow = realStatus({ cwd: F.owner, milestone: M, now: at1 });
      assert.deepEqual(frozen.horizon.task.ceiling_ms, linkedNow.task_horizon.ceiling_ms);
      assert.deepEqual(frozen.horizon.chain, linkedNow.chain, 'chain from the T04 projection');
      assert.equal(linkedNow.milestone_horizon.state, 'endpoint-proven', 'the T04 milestone horizon carries the public endpoint-proven state');
      assert.ok(!Object.hasOwn(linkedNow.milestone_horizon, 'budget_state'), 'the closed T04 projection keeps its fieldset');
      assert.deepEqual([linkedNow.milestone_horizon.frozen, linkedNow.milestone_horizon.endpoint.proven], [true, true]);
      // New begin, reentry and transport entry are closed; committed replays continue.
      before = snap(F);
      for (const kind of ['begin', 'reenter']) {
        const decision = admission.decideAdmission(F.owner, { milestone: M, unit: 'plan-slice/S03', kind, now: at1 });
        assert.deepEqual([decision.allowed, decision.reason_code], [false, 'milestone-endpoint-closed'], kind);
      }
      assert.throws(() => admission.assertTransportEntry({ cwd: F.owner, milestone: M, unit: 'review-slice/S02', now: at1 }), refusal('milestone-endpoint-closed'));
      assert.throws(() => admission.assertOwnerTransportEntry({ milestoneTimeContext: { cwd: F.owner, milestone: M, unit: 'review-slice/S02' }, now: at1 }), refusal('milestone-endpoint-closed'));
      unchanged(F, before, 'endpoint refusals');
      const replayOptions = { now: () => at1, prefsReader: () => ({ ok: true, prefs: {} }), inventoryReader: () => ({ slices: [{ id: 'S01', tasks: [{ id: 'T01' }] }, { id: 'S02', tasks: [{ id: 'T01' }] }] }) };
      const replay = controller.begin(F.owner, { milestone: M, unit: 'complete-milestone/' + M, host_runtime: 'codex', owner_token: 'fixture-owner',
        idempotency_key: 'complete-milestone/' + M + ':M:begin' }, replayOptions);
      assert.equal(replay.ok, true, 'a committed begin replays after the endpoint');
      // The public bridge: next is blocked by the closed endpoint, never failed.
      const stateFile = file(F.owner, `.gsd/milestones/${M}/${M}-STATE.md`), stateBytes = fs.readFileSync(stateFile);
      pending.push(() => { if (fs.existsSync(F.root)) fs.writeFileSync(stateFile, stateBytes); });
      require('./forge-state').write(F.owner, { milestone: M, kind: 'milestone', phase: 'plan-slice', active_slice: 'S03', active_task: '—', next_action: 'plan', auto_mode: 'on' });
      const next = orchestrate.next({ cwd: F.owner, milestone: M, workflow_id: 'linked-endpoint', owner_token: 'fixture-endpoint-owner', max_steps: 10, host_runtime: 'codex' },
        { now: () => at1, prefsReader: () => ({ ok: true, prefs: { workflow: { skip_discuss: true, skip_research: true } } }),
          inventoryReader: () => ({ roadmap_exists: true, context_exists: true, research_exists: true, slices: [{ id: 'S03', checked: false, plan_exists: false, tasks: [] }] }), ...prof });
      assert.deepEqual([next.outcome, next.reason_code], ['blocked', 'milestone-endpoint-closed'], JSON.stringify(next).slice(0, 400));
      fs.writeFileSync(stateFile, stateBytes);
      // Fresh process: both public directions terminate with the same values.
      const fresh = child({ mode: 'status', cwd: F.owner, milestone: M, task: T, now: at1, home: F.home });
      assert.deepEqual([fresh.milestone.state, fresh.milestone.budget_state], [frozen.state, frozen.budget_state]);
      assert.deepEqual(fresh.milestone.horizon.endpoint_proof, frozen.horizon.endpoint_proof);
      assert.deepEqual(fresh.milestone.horizon.task, frozen.horizon.task);
      assert.deepEqual(fresh.linked.milestone_horizon, realStatus({ cwd: F.owner, task: T, now: at1 }).milestone_horizon);
      // Milestone direction: exactly one composition, whose nested milestone reads go through the
      // explicit milestone-only seam (never the composing public reader). Linked direction: one
      // linked read and only milestone-only reads, so nothing recurses.
      assert.deepEqual(fresh.calls.afterMilestone, { linked: 1, time: 1, milestoneOnly: fresh.calls.afterMilestone.milestoneOnly }, JSON.stringify(fresh.calls));
      assert.ok(fresh.calls.afterMilestone.milestoneOnly >= 1 && fresh.calls.afterMilestone.milestoneOnly <= 4, JSON.stringify(fresh.calls));
      assert.deepEqual([fresh.calls.total.linked - fresh.calls.afterMilestone.linked, fresh.calls.total.time - fresh.calls.afterMilestone.time], [1, 0], JSON.stringify(fresh.calls));
      // Ordinary, named (a caller literally called readLinkedStatus) and deep callers all receive the
      // complete composed projection: no caller name or stack depth decides anything.
      for (const variant of ['named', 'deep']) {
        assert.deepEqual(fresh[variant].horizon.task, frozen.horizon.task, variant + ' caller keeps the task horizon');
        assert.deepEqual(fresh[variant].horizon.chain, frozen.horizon.chain, variant + ' caller keeps the chain horizon');
        assert.equal(fresh[variant].state, 'endpoint-proven');
      }
      const admissionSource = fs.readFileSync(ADMISSION, 'utf8');
      assert.ok(!/\.stack\b|stackTraceLimit|prepareStackTrace|captureStackTrace/.test(admissionSource), 'admission never inspects a stack');
      assert.equal(fresh.linked.task_id, T); assert.equal(fresh.linked.milestone_horizon.endpoint.proven, true);
      line('endpoint freezes milestone status and closes new entry while original replays continue');

      // =====================================================================
      // T03 start: the consumed handoff; the task horizon governs task entries.
      // =====================================================================
      const produced = lts.produceHandoff({ cwd: F.owner, milestone: M, ...prof });
      assert.equal(produced.status, 'produced', JSON.stringify(produced));
      assert.throws(() => admission.assertOwnerTransportEntry({ request: taskRequest }), refusal('linked-task-not-started'));
      const started = startTask(F);
      assert.equal(started.status, 'started', JSON.stringify(started));
      const S = Date.parse(JSON.parse(fs.readFileSync(file(F.owner, `.gsd/forge/time/${M}/linked-task/start.json`), 'utf8')).started_at);
      const C = linked.linkedTaskFor(F.owner, T).link.linked_task.horizon.ceiling_ms;
      const below = S + 60000, afterCap = S + C + 600000;
      const block = lts.consumedHandoffBlock(F.owner, T).replace(/\n$/, '');
      const admitted = admission.assertOwnerTransportEntry({ request: taskRequest, now: below });
      assert.deepEqual([admitted.decision, admitted.task_id, admitted.unit], ['admitted', T, UNIT]);
      assert.equal(Object.hasOwn(admitted, 'timeoutMs') || Object.hasOwn(admitted, 'workers_timeout'), false, 'the task ceiling is never a timeout');
      assert.throws(() => admission.assertOwnerTransportEntry({ request: taskRequest, now: afterCap }), refusal('linked-task-budget-exhausted'));
      assert.deepEqual(horizon.decideLinkedTaskEntry({ cwd: F.owner, taskId: T, unit: UNIT, now: afterCap }).reason_code, 'linked-task-budget-exhausted');
      const composed = admission.readTimeStatus(F.owner, M, { now: afterCap });
      assert.deepEqual([composed.horizon.task.state, composed.horizon.task.remaining_ms < 0, admission.summarizeTimeStatus(composed).state], ['exhausted', true, 'endpoint-proven']);
      assert.ok(statusCalls.length > 0, 'the linked status was loaded lazily');
      line('admission delegates lazily to live task guard and linked status without recursive projection');

      // =====================================================================
      // Truth 4 and key links 2/3: preparation order, late native guards and single handoff prompts.
      // =====================================================================
      const s = seams();
      pending.push(s.restore);
      let clock = below;
      const now = () => clock;
      prefs(F, 'gpt-5.6-sol');
      // Positive sidecar preparation in each of the four phases: the adapter receives the block once.
      for (const phase of PHASES) {
        clock = below;
        for (const [label, parent] of [['plain', undefined], ['parent', '## Task Brief\n\n' + block + '\n']]) {
          const raw = prepRequest(F, 'claude', phase, phase + '-' + label, parent ? { prompt: parent } : {});
          const count = s.prompts.length;
          const done = await prep.prepareStandaloneTask(raw, { now });
          // #350: standalone research needs code investigation, so the Codex read-only sidecar refuses it
          // before any provider; the other three phases are owner-packaged and still reach the seam.
          if (phase === 'research') {
            assert.deepEqual([done.ok, done.reason_code, done.provider_called], [false, 'codex-readonly-context-unsupported', false]);
            assert.equal(s.prompts.length, count, 'research never reaches the Codex seam');
            continue;
          }
          assert.equal(done.ok, true, phase + ' ' + JSON.stringify(done).slice(0, 300));
          const sent = s.prompts[count];
          assert.equal(sent.split(block).length, 2, phase + '/' + label + ': exactly one consumed block');
          assert.equal(sent.split(lts.HANDOFF_MARKERS.start).length, 2); assert.equal(sent.split(lts.HANDOFF_MARKERS.end).length, 2);
          assert.ok(sent.includes('nunca autoriza nada'), 'framed evidence that grants no authority');
        }
      }
      assert.equal(s.calls.codex, 6, 'the claude host reaches the codex sidecar seam');
      // A marker out of place is refused before any route or provider.
      {
        const raw = prepRequest(F, 'claude', 'discuss', 'misplaced', { prompt: 'Texto ' + lts.HANDOFF_MARKERS.start + ' fora do lugar\n' });
        const calls = s.total(), refused = await prep.startStandaloneTaskPreparation(raw, { now });
        assert.deepEqual([refused.ok, refused.reason_code, refused.provider_called], [false, 'linked-task-handoff-tampered', false]);
        assert.equal(s.total(), calls);
      }
      // Ready replay first (before the guard and the resolver), even at the cap.
      {
        clock = afterCap;
        const raw = prepRequest(F, 'claude', 'discuss', 'discuss-plain');
        const replayed = await prep.startStandaloneTaskPreparation(raw, { now, resolveDispatch() { throw new Error('replay must not resolve'); } });
        assert.deepEqual([replayed.ok, replayed.replayed, replayed.provider_called], [true, true, false], JSON.stringify(replayed).slice(0, 300));
      }
      // Invalid continuation keeps its own gate before the guard; a new attempt at the cap consults the guard before resolving.
      {
        let resolved = 0;
        const raw = prepRequest(F, 'claude', 'research', 'continuation', { continuation: { from_dispatch_id: 'linked-nothing', result_file: path.join(F.root, 'results', 'absent.json'), answers: [{ id: 'q', answer: 'sim' }] } });
        const refusedContinuation = await prep.startStandaloneTaskPreparation(raw, { now, resolveDispatch() { resolved++; throw new Error('must not resolve'); } });
        assert.deepEqual([refusedContinuation.ok, refusedContinuation.reason_code], [false, 'preparation-continuation-not-found']);
        const order = [];
        const decide = horizon.decideLinkedTaskEntry;
        horizon.decideLinkedTaskEntry = function (input) { order.push('admission'); return decide.call(this, input); };
        try {
          const freshRequest = prepRequest(F, 'claude', 'discuss', 'at-cap');
          const capped = await prep.startStandaloneTaskPreparation(freshRequest, { now, resolveDispatch() { order.push('resolve'); resolved++; throw new Error('must not resolve'); } });
          assert.deepEqual([capped.ok, capped.status, capped.stage, capped.reason_code, capped.provider_called], [false, 'failure', 'linked-task-admission', 'linked-task-budget-exhausted', false]);
          assert.equal(capped.diagnostic.stage, 'linked-task-admission');
          assert.ok(!fs.existsSync(freshRequest.resultFile + '.receipt.json'), 'no new receipt');
          clock = below;
          const ok = await prep.startStandaloneTaskPreparation(freshRequest, { now, resolveDispatch(options) { order.push('resolve'); return require('./forge-dispatch-resolve').resolveDispatch(options); } });
          assert.equal(ok.action, 'invoke-sidecar');
        } finally { horizon.decideLinkedTaskEntry = decide; }
        assert.deepEqual(order, ['admission', 'admission', 'resolve'], 'admission after replay/continuation and before resolution');
        assert.equal(resolved, 0);
      }
      line('preparation consults linked admission after replay and continuation checks before dispatch resolution');
      line('brainstorm, discuss and plan adapters receive exactly one consumed handoff block; Codex read-only research is refused before the provider');

      // =====================================================================
      // Truth 3 / key link 1: every sidecar launch rechecks before spawn (both engines).
      // =====================================================================
      // The common owner guard is observed (never replaced): every call records its task and the
      // clock it received, so one injected clock is provable at each actual entry.
      const ownerGuard = admission.assertOwnerTransportEntry;
      const guarded = [];
      const observeGuard = () => {
        admission.assertOwnerTransportEntry = function (options) {
          guarded.push({ task: options?.request?.taskId ?? options?.telemetryIdentity?.taskId ?? null, now: options?.now });
          return ownerGuard.apply(this, arguments);
        };
        return () => { admission.assertOwnerTransportEntry = ownerGuard; };
      };
      pending.push(() => { admission.assertOwnerTransportEntry = ownerGuard; });
      const late = {};
      let restoreGuard = observeGuard();
      try {
        for (const [host, model] of [['claude', 'gpt-5.6-sol'], ['codex', 'claude-sonnet-5']]) {
          prefs(F, model);
          clock = below;
          const raw = prepRequest(F, host, 'discuss', host + '-late-cap');
          const selected = await prep.startStandaloneTaskPreparation(raw, { now });
          assert.equal(selected.action, 'invoke-sidecar', JSON.stringify(selected).slice(0, 300));
          late[host] = { raw, delivery: selected.delivery_request };
          const calls = s.total(), count = guarded.length;
          clock = afterCap;
          await assert.rejects(unit.runUnitSidecar(selected.delivery_request, { now }), refusal('linked-task-budget-exhausted'));
          assert.equal(s.total(), calls, host + ': zero transport, child and app-server calls');
          assert.equal(guarded.length, count + 1, host + ': the common owner guard ran at the actual entry');
          const receipt = JSON.parse(fs.readFileSync(raw.resultFile + '.receipt.json', 'utf8'));
          assert.deepEqual([receipt.phase, receipt.failure.reason_code, receipt.failure.provider_called, receipt.failure.layer],
            ['failed', 'linked-task-budget-exhausted', false, 'milestone-time-admission']);
          // Retry of the same dispatch replays the recorded pre-provider failure.
          await assert.rejects(unit.runUnitSidecar(selected.delivery_request, { now }));
          assert.equal(s.total(), calls);
          // Admitted control: the same engine seam is reached below the cap.
          clock = below;
          const control = prepRequest(F, host, 'discuss', host + '-admitted');
          const startedControl = await prep.startStandaloneTaskPreparation(control, { now });
          const enginesBefore = s.calls.claude + s.calls.codex;
          await unit.runUnitSidecar(startedControl.delivery_request, { now });
          assert.equal(s.calls.claude + s.calls.codex, enginesBefore + 1, host + ': admitted control reaches the simulated adapter');
        }
        // The real last launch hook: the actual Codex app-server adapter packages the turn and calls
        // the packaged-context hook synchronously right before startAppServerTurn. The injected clock
        // crosses the cap exactly there; the common guard at that hook refuses (fail-closed) and the
        // observed app-server seam is never reached. The admitted control reaches it.
        xllm.invokeCodexAppServer = s.realCodex;
        try {
          prefs(F, 'gpt-5.6-sol');
          for (const crossing of [true, false]) {
            clock = below;
            const raw = prepRequest(F, 'claude', 'discuss', crossing ? 'packaging-late' : 'packaging-admitted');
            const selected = await prep.startStandaloneTaskPreparation(raw, { now });
            assert.equal(selected.delivery_request.route.resolved_worker_engine, 'codex', JSON.stringify(selected.delivery_request.route).slice(0, 200));
            let packaged = 0;
            const turns = s.calls.turn, children = s.calls.child, count = guarded.length;
            const run = unit.runUnitSidecar(selected.delivery_request, { now, onPackagedContext: () => { packaged++; if (crossing) clock = afterCap; } });
            if (crossing) {
              await assert.rejects(run, error => error.code === 'linked-task-budget-exhausted' && error.provider_called === false, 'refused at the packaging hook');
              assert.equal(packaged, 1, 'the real adapter packaged once and reached its last launch hook');
              assert.equal(s.calls.turn, turns, 'zero app-server turns after the cap crossed at the packaging hook');
              const receipt = JSON.parse(fs.readFileSync(raw.resultFile + '.receipt.json', 'utf8'));
              assert.deepEqual([receipt.phase, receipt.failure.reason_code, receipt.failure.provider_called, receipt.failure.layer],
                ['failed', 'linked-task-budget-exhausted', false, 'milestone-time-admission']);
              assert.ok(guarded.length - count >= 2 && guarded.slice(count).every(g => g.now === now), 'entry and last launch hook ran the common guard with the injected clock');
            } else {
              const reached = await run.then(() => null, error => error);
              assert.ok(packaged >= 1);
              assert.equal(s.calls.turn, turns + 1, 'the admitted control reaches the observed app-server seam: ' + (reached && reached.code));
            }
            assert.equal(s.calls.child, children);
          }
        } finally { xllm.invokeCodexAppServer = s.fakeCodex; }

        // The actual Claude transport down to its owned child: the request is selected below the cap
        // in this process, then run in a fresh isolated process where invokeClaudeTransport,
        // invokeClaudeSidecar and the private runOwnedChild are the real modules (nothing stubbed).
        // Only external I/O is a fixture: a temporary account registry and token file in the
        // fixture HOME (keychain disabled) and a fake CLI binary that records the version probe and
        // the provider child separately. The clock crosses the cap inside the real packaging
        // callback: the common guard refuses before the owned child; the admitted control spawns it.
        {
          prefs(F, 'claude-sonnet-5');
          const fake = path.join(F.root, 'claude-cli');
          const bin = write(fake, 'claude.js', "'use strict';\nconst fs = require('fs'), path = require('path');\n"
            + "if (process.argv.includes('--version')) { fs.appendFileSync(path.join(__dirname, 'version-probes.txt'), 'probe\\n'); process.stdout.write('9.9.9 (Claude Code)\\n'); process.exit(0); }\n"
            + "fs.appendFileSync(path.join(__dirname, 'provider-children.txt'), 'child\\n'); process.exit(3);\n");
          const registry = write(fake, 'forge-accounts.json', { version: 1, active: 'fixture', accounts: { fixture: { name: 'fixture' } } });
          write(F.home, '.claude/forge-accounts-tokens.json', { fixture: 'fixture-token-not-a-credential' });
          const env = { FORGE_ACCOUNTS_REGISTRY: registry, FORGE_KEYCHAIN_DISABLED: '1', FORGE_XLLM_CLAUDE_BIN: bin };
          const children = () => fs.existsSync(path.join(fake, 'provider-children.txt')) ? fs.readFileSync(path.join(fake, 'provider-children.txt'), 'utf8').split('\n').filter(Boolean).length : 0;
          const probes = () => fs.existsSync(path.join(fake, 'version-probes.txt')) ? fs.readFileSync(path.join(fake, 'version-probes.txt'), 'utf8').split('\n').filter(Boolean).length : 0;
          for (const crossing of [true, false]) {
            clock = below;
            const raw = prepRequest(F, 'codex', 'research', crossing ? 'claude-owned-late' : 'claude-owned-admitted');
            const selected = await prep.startStandaloneTaskPreparation(raw, { now });
            assert.deepEqual([selected.action, selected.delivery_request?.route?.resolved_worker_engine, selected.delivery_request?.route?.worker_mode],
              ['invoke-sidecar', 'claude', 'sidecar'], JSON.stringify(selected).slice(0, 300));
            const childrenBefore = children(), probesBefore = probes(), inProcess = s.total();
            const seen = child({ mode: 'claude-owned', request: selected.delivery_request, below, afterCap, crossing, home: F.home, env });
            assert.equal(seen.realTransport, true, 'the actual Claude transport ran in the fresh process');
            assert.equal(seen.packaged, 1, 'the real Claude adapter packaged once and reached its last launch hook');
            assert.ok(seen.guards.length >= 2 && seen.guards.every(g => g.task === F.task && g.injected), 'entry and packaging hook ran the common guard with the injected clock ' + JSON.stringify(seen.guards));
            assert.equal(s.total(), inProcess, 'nothing ran through the in-process simulated seams');
            const receipt = JSON.parse(fs.readFileSync(raw.resultFile + '.receipt.json', 'utf8'));
            if (crossing) {
              assert.equal(seen.guards.at(-1).at, afterCap, 'the refusing guard saw the crossed clock');
              assert.equal(children(), childrenBefore, 'zero provider owned children after the cap crossed at the packaging hook');
              assert.deepEqual([seen.out.ok, seen.out.code, seen.out.provider_called], [false, 'linked-task-budget-exhausted', false], JSON.stringify(seen.out));
              assert.deepEqual([receipt.phase, receipt.failure.reason_code, receipt.failure.provider_called, receipt.failure.layer],
                ['failed', 'linked-task-budget-exhausted', false, 'milestone-time-admission'], JSON.stringify(receipt.failure).slice(0, 300));
            } else {
              assert.equal(children(), childrenBefore + 1, 'the admitted control spawned exactly one owned provider child: ' + JSON.stringify(seen.out));
              assert.notEqual(seen.out.code, 'linked-task-budget-exhausted');
              assert.ok(seen.guards.every(g => g.at === below));
            }
            // The version probe is external CLI I/O, never the provider child.
            assert.ok(probes() - probesBefore <= 1, 'at most one version probe per attempt');
          }
        }

      // Native preparation (codex host): selection below cap, actual callback after the cap.
      prefs(F, 'gpt-5.6-sol');
      const caps = { activeCapabilities: { available: true, tool: 'collaboration.spawn_agent', source: 'fixture-tool-schema', models: ['gpt-5.6-sol'],
        reasoning_efforts: ['medium', 'high'], fork_turns: ['none'] } };
      let hostCalls = 0;
      {
        clock = below;
        const raw = prepRequest(F, 'codex', 'research', 'native-late', caps);
        const selected = await prep.startStandaloneTaskPreparation(raw, { now });
        assert.equal(selected.action, 'invoke-native', JSON.stringify(selected).slice(0, 300));
        assert.equal(selected.invocation.args.message.split(block).length, 2, 'the native handoff carries the block once');
        clock = afterCap;
        const outcome = await selected.invoke(async () => { hostCalls++; return { status: 'done' }; });
        assert.deepEqual([outcome.ok, outcome.reason_code, outcome.provider_called], [false, 'linked-task-budget-exhausted', false], JSON.stringify(outcome).slice(0, 300));
        const second = await selected.invoke(async () => { hostCalls++; return { status: 'done' }; });
        assert.equal(second.reason_code, 'native-handoff-already-invoked');
        const receipt = JSON.parse(fs.readFileSync(raw.resultFile + '.receipt.json', 'utf8'));
        assert.deepEqual([receipt.phase, receipt.failure.provider_called], ['failed', false]);
        assert.equal(hostCalls, 0, 'no host callback after the cap');
      }
      // R43: a native handoff SELECTED below the cap before a close-chain question exists is still refused at the
      // actual callback while that required decision is pending or accepted (zero host calls, pre-provider
      // receipt); a declined decision is completed history and the control entry is admitted again.
      {
        clock = below;
        const raw = prepRequest(F, 'codex', 'research', 'native-close-chain', caps);
        const selected = await prep.startStandaloneTaskPreparation(raw, { now });
        assert.equal(selected.action, 'invoke-native', JSON.stringify(selected).slice(0, 300));
        const opened = lts.prepareLinkedDecision({ cwd: F.owner, task: F.task, action: 'close-chain' });
        assert.equal(opened.status, 'open', JSON.stringify(opened));
        const before = hostCalls;
        const outcome = await selected.invoke(async () => { hostCalls++; return { status: 'done' }; });
        assert.deepEqual([outcome.ok, outcome.reason_code, outcome.provider_called], [false, 'linked-task-time-invalid', false], JSON.stringify(outcome).slice(0, 300));
        assert.equal(hostCalls, before, 'no host callback while the close-chain decision is pending');
        const receipt = JSON.parse(fs.readFileSync(raw.resultFile + '.receipt.json', 'utf8'));
        assert.deepEqual([receipt.phase, receipt.failure.reason_code, receipt.failure.provider_called], ['failed', 'linked-task-time-invalid', false]);
        // The sidecar entries (enterTransport and the Claude packaging hook) call this same common guard: a pending
        // close-chain question refuses before any provider with the preserved pending ID.
        let refusedEntry = null;
        try { horizon.assertLinkedTaskEntry({ cwd: F.owner, taskId: F.task, unit: 'research-milestone/' + F.task, now: clock }); } catch (e) { refusedEntry = e; }
        assert.ok(refusedEntry, 'the sidecar entry guard refuses while the close-chain decision is pending');
        assert.deepEqual([refusedEntry.code, refusedEntry.provider_called, refusedEntry.stage, refusedEntry.details.pending_ids], ['linked-task-time-invalid', false, 'linked-task-admission', [opened.question.id]]);
        assert.equal(lts.answerLinkedDecision({ cwd: F.owner, task: F.task, action: 'close-chain', response: 'linked-task:keep-chain', source: 'user-text' }).status, 'answered');
        assert.doesNotThrow(() => horizon.assertLinkedTaskEntry({ cwd: F.owner, taskId: F.task, unit: 'research-milestone/' + F.task, now: clock }), 'a declined decision does not block');
        process.stdout.write('ok - integrated-R43-late-close-chain-admission transport selected-before-question\n');
      }
      {
        clock = below;
        const raw = prepRequest(F, 'codex', 'brainstorm', 'native-admitted', caps);
        const selected = await prep.startStandaloneTaskPreparation(raw, { now });
        let delivered = null;
        await selected.invoke(async (args) => { hostCalls++; delivered = args; return { status: 'done' }; });
        assert.equal(hostCalls, 1, 'only the admitted native callback ran');
        assert.equal(JSON.stringify(delivered).split(JSON.stringify(block).slice(1, -1)).length, 2, 'admitted native adapter received the block once');
      }
        // Native EXECUTION of the linked task through the public runUnitSidecar, for each supported
        // host binding (Codex spawn_agent; Claude Agent with the observed frontmatter effort). The
        // request is selected and bound below the cap; the clock crosses it at the real packaging
        // hook, or after packaging at the before-invoke announcement (where the guard inside
        // invokeNative now runs with the same injected clock). Only the host callback is simulated.
        const resultFile = file(F.code, 'scripts/result.js'), resultBytes = fs.readFileSync(resultFile);
        pending.push(() => { if (fs.existsSync(F.root)) fs.writeFileSync(resultFile, resultBytes); });
        try {
          for (const [host, value] of [['codex', 3], ['claude', 4]]) {
            for (const crossing of ['packaging', 'before-invoke', null]) {
              clock = below;
              const label = host + '-' + (crossing || 'admitted');
              const r = nativeExecutionRequest(F, host, label);
              let callbacks = 0, packaged = false, crossed = false, delivered = null;
              const count = guarded.length, before = { child: s.calls.child, turn: s.calls.turn, claude: s.calls.claude, codex: s.calls.codex };
              const runtime = { now, activeCapabilities: NATIVE_CAPS[host], readback: async () => ({}),
                onPackagedContext: () => { packaged = true; if (crossing === 'packaging') { clock = afterCap; crossed = true; } },
                announce: stage => { if (crossing === 'before-invoke' && packaged && stage === 'solicitado') { clock = afterCap; crossed = true; } },
                invokeNative: async args => {
                  callbacks++; delivered = args;
                  fs.writeFileSync(resultFile, 'module.exports = ' + value + ';\n');
                  return { status: 'done', summary: 'Execução nativa da task ligada', must_haves_status: [], files_changed: ['scripts/result.js'] };
                } };
              if (crossing) {
                await assert.rejects(unit.runUnitSidecar(r, runtime), error => error.code === 'linked-task-budget-exhausted' && error.provider_called === false
                  && error.stage === 'linked-task-admission' && error.layer === 'milestone-time-admission', label + ': typed pre-provider refusal');
                assert.equal(crossed, true, label + ': the clock crossed at the intended hook');
                assert.equal(callbacks, 0, label + ': zero host callbacks');
                const receipt = JSON.parse(fs.readFileSync(r.resultFile + '.receipt.json', 'utf8'));
                assert.deepEqual([receipt.phase, receipt.failure.reason_code, receipt.failure.provider_called, receipt.failure.layer, receipt.failure.possible_writes],
                  ['failed', 'linked-task-budget-exhausted', false, 'milestone-time-admission', false], label + ' ' + JSON.stringify(receipt.failure).slice(0, 300));
                // The same dispatch never relaunches: the recorded pre-provider failure replays.
                await assert.rejects(unit.runUnitSidecar(r, runtime));
                assert.equal(callbacks, 0);
              } else {
                const done = await unit.runUnitSidecar(r, runtime);
                assert.equal(done.status, 'done', label + ' ' + JSON.stringify(done).slice(0, 300));
                assert.equal(callbacks, 1, label + ': the admitted external transport control ran once');
                assert.ok(JSON.stringify(delivered).includes('Read the complete authorized execution prompt'), 'the host received the bound execution handoff');
                assert.equal(JSON.parse(fs.readFileSync(r.resultFile + '.receipt.json', 'utf8')).phase, 'ready');
              }
              assert.deepEqual({ child: s.calls.child, turn: s.calls.turn, claude: s.calls.claude, codex: s.calls.codex }, before, label + ': no sidecar child, turn or engine');
              const calls = guarded.slice(count);
              assert.ok(calls.length >= 1 && calls.every(g => g.task === F.task && g.now === now), label + ': one injected clock at every common guard ' + calls.length);
            }
          }

          // Public standalone EXECUTION recovery through the own recoverUnitSidecar branch (real
          // recoverAttempt, real reservation, real execute fixture/lifecycle/claim/gates): the first
          // routed native candidate fails with a proven service failure reported by the simulated
          // external host callback; below the cap the recovery selects and reserves the next routed
          // candidate and returns its public native handoff. The clock crosses the cap immediately
          // before that handoff is invoked: the actual entry refuses with zero host callbacks. The
          // admitted control invokes an equivalent handoff below the cap and the callback runs once.
          const recoveryCaps = { ...NATIVE_CAPS.codex, models: ['gpt-5.6-sol', 'gpt-6.1-sol'] };
          for (const crossing of [true, false]) {
            clock = below;
            const label = 'codex-recovery-' + (crossing ? 'late' : 'admitted');
            const r = nativeExecutionRequest(F, 'codex', label, { models: recoveryCaps.models, caps: recoveryCaps });
            const base = { now, activeCapabilities: recoveryCaps, readback: async () => ({}) };
            let failing = 0, callbacks = 0, delivered = null;
            await assert.rejects(unit.runUnitSidecar(r, { ...base, invokeNative: async () => {
              failing++; throw Object.assign(Error('fixture host service unavailable'), { code: 'model-unavailable', provider_called: true }); } }),
            error => error.code === 'model-unavailable', label + ': the original attempt failed at the external host');
            assert.equal(failing, 1);
            const stateFile = r.resultFile + '.recovery.json', receiptFile = r.resultFile + '.receipt.json';
            assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).attempts.at(-1).service_failure_proven, true, label + ': a proven service failure');
            const before = { ...s.calls }, count = guarded.length;
            const recovered = await unit.recoverUnitSidecar(r, { stateFile, receiptFile }, { ...base, processProbe: () => 'stopped', verifyOwnership: () => true });
            const handoff = recovered.result;
            assert.equal(handoff?.action, 'invoke-native', label + ' ' + JSON.stringify(recovered).slice(0, 400));
            assert.deepEqual([recovered.route.worker_mode, recovered.route.model], ['native', 'gpt-6.1-sol'], label + ': the next routed candidate');
            assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).reservations.length, 1, label + ': one reservation, made below the cap');
            assert.equal(guarded.length, count, label + ': selection and reservation never entered a transport');
            const successor = handoff.request.resultFile + '.receipt.json';
            if (crossing) clock = afterCap;
            const invoked = handoff.invoke(async (next, binding) => {
              callbacks++; delivered = { next, binding };
              fs.writeFileSync(resultFile, 'module.exports = 5;\n');
              return { status: 'done', summary: 'Recovery nativo da task ligada', must_haves_status: [], files_changed: ['scripts/result.js'] };
            });
            if (crossing) {
              await assert.rejects(invoked, error => error.code === 'linked-task-budget-exhausted' && error.provider_called === false
                && error.stage === 'linked-task-admission' && error.layer === 'milestone-time-admission', label + ': typed pre-provider refusal');
              assert.equal(callbacks, 0, label + ': zero host callbacks after the cap');
              const row = JSON.parse(fs.readFileSync(successor, 'utf8'));
              assert.deepEqual([row.phase, row.failure.reason_code, row.failure.provider_called, row.failure.layer],
                ['failed', 'linked-task-budget-exhausted', false, 'milestone-time-admission'], label + ' ' + JSON.stringify(row.failure).slice(0, 300));
              assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).reservations.length, 1, label + ': the refusal never selected another candidate');
            } else {
              const done = await invoked;
              assert.equal(done.status, 'done', label + ' ' + JSON.stringify(done).slice(0, 300));
              assert.equal(callbacks, 1, label + ': the admitted recovered handoff reached the external host once');
              assert.equal(delivered.binding.args.model, 'gpt-6.1-sol');
              assert.equal(JSON.parse(fs.readFileSync(successor, 'utf8')).phase, 'ready');
            }
            assert.deepEqual({ ...s.calls }, before, label + ': no sidecar child, turn or engine');
            const calls = guarded.slice(count);
            assert.ok(calls.length >= 1 && calls.every(g => g.task === F.task && g.now === now), label + ': one injected clock at every common guard ' + calls.length);
          }
        } finally {
          fs.writeFileSync(resultFile, resultBytes);
          if (require('./forge-runs').get(F.owner, F.task)?.write_claim) require('./forge-write-claim').clearClaim(F.owner, F.task);
        }

        // Public recovery over real generated history (never a replaced recovery decision).
        // 1) The recorded pre-provider admission refusal stops recovery: no candidate, no reservation.
        {
          const { raw, delivery } = late.claude;
          const stateFile = raw.resultFile + '.recovery.json', receiptFile = raw.resultFile + '.receipt.json';
          assert.ok(fs.existsSync(stateFile), 'the sidecar recorded the recoverable history');
          clock = below;
          const calls = s.total();
          const stopped = await unit.recoverUnitSidecar(delivery, { stateFile, receiptFile }, { now, processProbe: () => 'stopped' });
          assert.deepEqual([stopped.action, stopped.reason_code], ['stop', 'linked-task-budget-exhausted'], JSON.stringify(stopped).slice(0, 300));
          const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          assert.deepEqual([state.attempts.at(-1).reason_code, state.attempts.at(-1).provider_called, state.attempts.at(-1).layer],
            ['linked-task-budget-exhausted', false, 'milestone-time-admission']);
          assert.ok(!(state.reservations || []).length, 'no candidate was reserved');
          assert.equal(s.total(), calls, 'no transport from the stopped recovery');
        }
        // 2) Same-session resume: a real active-budget failure with a session (simulated external
        // Claude transport) below the cap; the public recovery reserves the resume and its actual
        // entry, after the cap, refuses before any spawn and stops without another candidate.
        {
          prefs(F, 'claude-sonnet-5');
          clock = below;
          const raw = prepRequest(F, 'codex', 'plan', 'resume-source');
          const selected = await prep.startStandaloneTaskPreparation(raw, { now });
          assert.deepEqual([selected.action, selected.delivery_request.route.resolved_worker_engine], ['invoke-sidecar', 'claude'], JSON.stringify(selected).slice(0, 300));
          const sessions = require('./forge-claude-session');
          const ref = sessions.createSessionRef({ id: sessions.newSessionId(), accountName: null, configDir: path.join(F.home, '.claude'), cwd: F.code, now: below });
          const fakeClaude = xllm.invokeClaudeTransport;
          xllm.invokeClaudeTransport = async () => { s.calls.claude++;
            throw Object.assign(Error('fixture active worker ceiling'), { code: 'budget-exceeded-while-active', provider_called: true, session: ref }); };
          try { await assert.rejects(unit.runUnitSidecar(selected.delivery_request, { now }), error => error.code === 'budget-exceeded-while-active'); }
          finally { xllm.invokeClaudeTransport = fakeClaude; }
          const stateFile = raw.resultFile + '.recovery.json';
          assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).attempts.at(-1).failure_class, 'active-budget');
          clock = afterCap;
          const calls = s.total();
          const resumed = await unit.recoverUnitSidecar(selected.delivery_request, { stateFile, receiptFile: raw.resultFile + '.receipt.json' },
            { now, processProbe: () => 'stopped', verifyOwnership: () => true });
          assert.deepEqual([resumed.action, resumed.reason_code, resumed.refusal, resumed.provider_called],
            ['stop', 'budget-exceeded-resume-refused', 'linked-task-budget-exhausted', false], JSON.stringify(resumed).slice(0, 300));
          const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          assert.deepEqual(state.reservations.map(row => row.reason), ['same-session-resume'], 'only the single resume reservation');
          assert.equal(s.total(), calls, 'the resume entry never reached a transport');
        }
        // 3) Native candidate: a proven service failure of the first routed candidate (simulated
        // external Claude transport) lets the public recovery select and reserve, below the cap,
        // the next routed candidate (native on the Codex host) and return its public native
        // handoff. The clock advances before that handoff is invoked: the actual entry refuses and
        // the host callback never runs.
        {
          write(F.owner, '.gsd/forge-prefs.jsonc', JSON.stringify({ tier_models: Object.fromEntries(['light', 'standard', 'heavy', 'max'].map(t => [t, ['claude-sonnet-5', 'gpt-5.6-sol']])),
            effort: { 'plan-slice': 'medium', 'discuss-milestone': 'medium', 'research-milestone': 'medium', 'plan-milestone': 'medium' } }));
          clock = below;
          const raw = prepRequest(F, 'codex', 'research', 'native-candidate', caps);
          const selected = await prep.startStandaloneTaskPreparation(raw, { now });
          assert.deepEqual([selected.action, selected.delivery_request?.route?.resolved_worker_engine], ['invoke-sidecar', 'claude'], JSON.stringify(selected).slice(0, 300));
          const fakeClaude = xllm.invokeClaudeTransport;
          xllm.invokeClaudeTransport = async () => { s.calls.claude++;
            throw Object.assign(Error('fixture provider unavailable'), { code: 'model-unavailable', provider_called: true }); };
          try { await assert.rejects(unit.runUnitSidecar(selected.delivery_request, { now }), error => error.code === 'model-unavailable'); }
          finally { xllm.invokeClaudeTransport = fakeClaude; }
          const stateFile = raw.resultFile + '.recovery.json', receiptFile = raw.resultFile + '.receipt.json';
          assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).attempts.at(-1).service_failure_proven, true, 'a proven service failure');
          const calls = s.total();
          let callbacks = 0;
          const recovered = await unit.recoverUnitSidecar(selected.delivery_request, { stateFile, receiptFile }, { now, processProbe: () => 'stopped' });
          assert.equal(recovered.result?.action, 'invoke-native', JSON.stringify(recovered).slice(0, 400));
          const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          assert.equal(state.reservations.length, 1, 'one reservation, made below the cap');
          assert.equal(recovered.route.worker_mode, 'native');
          clock = afterCap;
          const outcome = await recovered.result.invoke(async () => { callbacks++; return { status: 'done' }; });
          assert.deepEqual([outcome.ok, outcome.reason_code, outcome.provider_called], [false, 'linked-task-budget-exhausted', false], JSON.stringify(outcome).slice(0, 300));
          assert.equal(callbacks, 0, 'the reserved native handoff never reached the host after the cap');
          assert.equal(s.total(), calls, 'no transport from the recovered native entry');
        }
      } finally { restoreGuard(); }
      line('sidecar calls the common owner guard at each actual transport entry and records preprovider refusal');
      line('every provider launch and retry rechecks task admission before spawn and stops recovery');
      line('preparation preserves ready replay continuation order late native guards and single handoff prompts');

      // =====================================================================
      // Truth 5 / key link 4: review legs with --budget-task.
      // =====================================================================
      const context = { cwd: F.owner, task: T, unit: UNIT };
      const seen = [];
      const reviewGuard = admission.assertOwnerTransportEntry;
      admission.assertOwnerTransportEntry = function (options) { seen.push(options.milestoneTimeContext); return reviewGuard.apply(this, arguments); };
      const input = write(F.root, 'review-input.json', { objections: [] });
      let reviewControlTurns = 0;
      // Before the review legs only the admitted packaging control reached the observed turn seam.
      const turnsBeforeReview = s.calls.turn + s.calls.child;
      assert.equal(turnsBeforeReview, 1, 'only the admitted packaging control reached a turn seam before review');
      try {
        for (const driver of [xllm.runChallenge, xllm.runDefend, xllm.runRebuttal]) {
          for (const engine of ['codex', 'claude']) {
            clock = afterCap;
            const calls = s.total();
            await assert.rejects(driver({ cwd: F.code, contextRoot: F.owner, milestoneTimeContext: context, now, engine, hostRuntime: engine === 'codex' ? 'claude' : 'codex',
              sidecarDeclared: true, model: engine === 'codex' ? 'gpt-5.6-sol' : 'claude-sonnet-5', effort: 'medium', diffCmd: 'git diff', inputFile: input }), refusal('linked-task-budget-exhausted'));
            assert.equal(s.total(), calls, driver.name + '/' + engine + ': no transport');
            assert.deepEqual(seen.at(-1), context, 'exact task and unit identity reach the common guard');
          }
        }
        // Admitted control: the review driver reaches the observed app-server turn seam (never spawned).
        clock = below;
        const calls = s.total();
        const reached = await xllm.runChallenge({ cwd: F.code, contextRoot: F.owner, milestoneTimeContext: context, now, engine: 'codex', hostRuntime: 'claude', sidecarDeclared: true,
          model: 'gpt-5.6-sol', effort: 'medium', diffCmd: 'git diff' }).then(() => null, error => error);
        assert.equal(s.total(), calls + 1, 'admitted review reaches the observed transport seam');
        assert.notEqual(reached && reached.code, 'linked-task-budget-exhausted');
        reviewControlTurns = s.calls.turn + s.calls.child;
      } finally { admission.assertOwnerTransportEntry = reviewGuard; }
      line('review task budget reaches the common owner guard with exact task and unit identity');
      // Real CLI subprocesses: conflicting flags and a closed task exit 2 with provider_called false.
      const capture = path.join(F.root, 'provider-entry.txt');
      const preload = write(F.root, 'no-provider.cjs', "require('child_process').spawn = () => { throw Error('provider-spawn-forbidden'); };\n"
        + `require(${JSON.stringify(path.join(__dirname, 'forge-appserver-client.js'))}).startAppServerTurn = () => { require('fs').writeFileSync(${JSON.stringify(capture)}, 'entered'); throw Error('provider-spawn-forbidden'); };\n`);
      const cli = extra => spawnSync(process.execPath, ['--require', preload, path.join(__dirname, 'forge-xllm.js'), '--mode', 'challenge', '--engine', 'codex', '--host-runtime', 'claude',
        '--sidecar-declared', '--model', 'gpt-5.6-sol', '--effort', 'medium', '--cwd', F.code, '--context-root', F.owner, '--diff-cmd', 'git diff', ...extra],
      { encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: F.home, USERPROFILE: F.home } });
      const conflicting = cli(['--budget-owner', F.owner, '--budget-task', T, '--budget-milestone', M, '--budget-unit', UNIT]);
      assert.equal(conflicting.status, 2, conflicting.stderr); assert.equal(conflicting.stdout, '');
      assert.ok(conflicting.stderr.includes('"reason_code":"milestone-time-invalid"') && conflicting.stderr.includes('"provider_called":false'), conflicting.stderr);
      assert.ok(!fs.existsSync(capture));
      taskDelivery(F);
      assert.equal(lts.closeLinkedTask({ cwd: F.owner, taskId: T, codeDir: F.code, ...prof }).status, 'closed');
      const closedRun = cli(['--budget-owner', F.owner, '--budget-task', T, '--budget-unit', UNIT]);
      assert.equal(closedRun.status, 2, closedRun.stderr);
      assert.ok(closedRun.stderr.includes('"reason_code":"linked-task-closed"') && closedRun.stderr.includes('"provider_called":false'), closedRun.stderr);
      assert.ok(!fs.existsSync(capture), 'the closed task never reached the transport seam');
      // Without the budget flags the CLI keeps its previous behavior (reaches the provider seam).
      const plainRun = cli([]);
      assert.equal(plainRun.status, 2); assert.ok(fs.existsSync(capture), 'unscoped review reaches the transport seam as before');
      line('review task budget flags carry scoped admission and refuse before any transport');
      assert.equal(s.calls.child + s.calls.turn, reviewControlTurns, 'only the admitted review control reached a (simulated) turn seam');
      assert.ok(reviewControlTurns - turnsBeforeReview <= 1);
      line('both hosts deliver admitted handoffs and refuse late cap resume native recovery review endpoint entries');
      line('immutable admission vocabularies and unchanged consumers classify endpoint and linked refusals');
      process.stdout.write('# fixture build ' + Math.round(fixtureMs / 1000) + ' s\n');
    } finally {
      horizon.assertLinkedTaskEntry = realAssert; horizon.readLinkedStatus = realStatus;
    }
    passed = true;
  } finally {
    for (const restore of pending.splice(0).reverse()) restore();
    process.env.HOME = saved.HOME; process.env.USERPROFILE = saved.USERPROFILE;
    if (saved.HOME === undefined) delete process.env.HOME;
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE;
    cleanup();
  }
  if (passed) {
    assert.deepEqual(leftovers('forge-ltt-'), [], 'every temporary root was removed');
    assert.equal(realView(), realBefore, 'the real runs and tasks are untouched');
  }
}

module.exports = { M, PHASES, chainFixture, startTask, taskDelivery, liveAdapter, prefs, prepRequest, tempRoot, tree, write, file, cleanup, leftovers, iso, sha };
if (require.main === module) {
  if (process.argv[2] === '--child') Promise.resolve(childMain()).catch(error => { console.error(error); process.exitCode = 1; });
  else {
    const t0 = Date.now();
    suite().then(() => process.stdout.write('# linked transport suite ' + Math.round((Date.now() - t0) / 1000) + ' s; simulated transports only, no provider\n'))
      .catch(error => { console.error(error); process.exitCode = 1; });
  }
}
