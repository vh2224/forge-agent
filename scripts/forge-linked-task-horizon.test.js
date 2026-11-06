#!/usr/bin/env node
'use strict';

// S03/T04 linked task horizon: the task clock (S01 consumption table over the task sources),
// admission at the exact lifecycle and the current task ceiling, the live receipt/process drain
// that never kills, steals or releases, the immutable checkpoint, the attested chained extension,
// the read-only chain status and the CLI. Every fixture is a real composition in temporary roots
// with a temporary personal profile: the S02 selection with a linked task, the T01 creation, a real
// Git owner/worktree history completed through the real controller with real runRootVerification
// envelopes and forge-delivery projections, the T02 endpoint, the T03 handoff/start/closure, real
// forge-pending-questions answers and createDecisionAuthority with fixture resolvers, real write
// claims, real receipts inspected by forge-attempt-recovery and real live/dead child processes.
// One injected clock drives every horizon call. No network or provider; cleanup in finally.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
// Imported first: loading the module must not load any local dependency.
const horizon = require('./forge-linked-task-horizon');
const LOADED_AT_IMPORT = Object.keys(require.cache).filter(k => /scripts[\\/]forge-(?!linked-task-horizon\.)[^\\/]+\.js$/.test(k) && !k.endsWith('.test.js'));
const lts = require('./forge-linked-task-start');
const time = require('./forge-milestone-time');
const selection = require('./forge-milestone-time-selection');
const questions = require('./forge-pending-questions');
const controller = require('./forge-unit-controller');
const delivery = require('./forge-delivery');
const verify = require('./forge-verify');
const codeRoots = require('./forge-code-roots');
const clock = require('./forge-milestone-time-clock');
const endpoint = require('./forge-milestone-endpoint');
const admission = require('./forge-milestone-time-admission');
const linked = require('./forge-linked-task');
const personal = require('./forge-personal-context');
const runs = require('./forge-runs');
const recovery = require('./forge-attempt-recovery');
const writeClaim = require('./forge-write-claim');
const lease = require('./forge-unit-lease');
const ids = require('./forge-ids');
const { digest } = require('./forge-code-roots');
const PROPOSALS = require('./fixtures/milestone-options/proposals.json');
const M = PROPOSALS.milestone, BRANCH = 'forge/' + M, SCRIPT = path.join(__dirname, 'forge-linked-task-horizon.js');
const SCHEMA = path.join(__dirname, '..', 'shared', 'schemas', 'forge-linked-task-horizon.schema.json');
const REAL_HOME = os.homedir();
const CHECK = "const value = require('./result'); require('assert/strict').equal(typeof value, 'number');\n"
  + "if (process.argv[2]) require('assert/strict').equal(value, Number(process.argv[2]));\nconsole.log('PASS shared-source-behavior');\n";
const SUMMARY = `# ${M} Summary\n\nEntrega integrada verificada.\n\n## Forward Intelligence\n\n- Rode node scripts/check.js antes de mexer em result.js.\n\n## Decisões\n\n- Relatório SC4 fica na task ligada.\n`;
const roots = [], createdNames = new Set(), children = [];
let serial = 0;

const iso = v => new Date(v).toISOString();
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function line(text) { process.stdout.write('ok - T04 linked horizon: ' + text + '\n'); }
function tempRoot(prefix) { const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); roots.push(dir); createdNames.add(path.basename(dir)); return dir; }
function file(cwd, ref) { return path.join(cwd, ...ref.split('/')); }
function write(cwd, ref, value) {
  const target = file(cwd, ref); fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value) + '\n'); return target;
}
function json(cwd, ref) { return JSON.parse(fs.readFileSync(file(cwd, ref), 'utf8')); }
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
function snap(f) { return { gsd: tree(path.join(f.owner, '.gsd')), home: tree(f.home) }; }
function unchanged(f, before, label) { assert.deepEqual(snap(f), before, label + ': zero writes'); }
function recordRef(name) { return `.gsd/forge/time/${M}/linked-task/${name}.json`; }
function noAbsolute(f, value, label) {
  const text = JSON.stringify(value);
  for (const p of [f.owner, f.code, f.home, f.root, os.tmpdir()]) {
    for (const form of [p, p.replace(/\\/g, '/'), p.replace(/\\/g, '\\\\')]) assert(!text.toLowerCase().includes(form.toLowerCase()), label + ' has no absolute path');
  }
}
function ownerLockGuard() {
  const recon = require('./forge-artifact-reconciliation'), original = recon.withOwnerLock, seen = { calls: 0, nested: 0 };
  let depth = 0;
  recon.withOwnerLock = (...args) => { seen.calls++; if (depth) { seen.nested++; throw new Error('nested owner lock'); } depth++; try { return original(...args); } finally { depth--; } };
  return { seen, restore() { recon.withOwnerLock = original; } };
}
// Counts every call that could kill a process, steal a lease or release/rewrite a claim or run.
function effectSpies() {
  const calls = [], restores = [];
  const wrap = (owner, name, label) => {
    if (typeof owner[name] !== 'function') return;
    const original = owner[name];
    owner[name] = function (...args) { calls.push(label + '.' + name); return original.apply(this, args); };
    restores.push(() => { owner[name] = original; });
  };
  for (const name of ['acquire', 'heartbeat', 'release', 'recover', 'openProtectedWindow', 'withTerminalGuard', 'releaseTerminal']) wrap(lease, name, 'lease');
  for (const name of ['recordClaim', 'clearClaim', 'releaseClaim', 'recoverClaim']) wrap(writeClaim, name, 'claim');
  for (const name of ['add', 'update', 'updateWith', 'remove']) wrap(runs, name, 'runs');
  const kill = process.kill, signals = [];
  process.kill = (pid, signal) => { signals.push(signal === undefined ? 'SIGTERM' : signal); return kill.call(process, pid, signal); };
  restores.push(() => { process.kill = kill; });
  return { calls, signals, restore() { for (const r of restores.splice(0).reverse()) r(); } };
}

// ---------------------------------------------------------------------------
// Live decision fixtures (the trusted host observed the explicit persisted answer)
// ---------------------------------------------------------------------------
function liveAdapter(cwd, o = {}) {
  const calls = [];
  return { calls, getDecisionHandle(request) {
    calls.push(request);
    if (o.before) o.before(request);
    if (o.raw) return o.raw(request);
    if (o.throws) throw new Error('host adapter failed');
    const state = questions.continuation({ cwd, identity: request.question.identity_sha256 });
    const row = state.ok ? state.questions.find(q => q.id === request.question.id) : null;
    const clockAt = o.now ?? Date.now(), reference = 'live-' + request.question.id;
    const resolve = () => ({ reference, status: 'resolved', source: 'user-text', resolved_at: iso(clockAt - 60000), answer: o.answer ?? (row && row.answer), question: { ...request.question } });
    const handle = time.createDecisionAuthority(resolve).issue(reference, { milestone: o.milestone || request.milestone, kind: request.kind,
      request_sha256: o.requestSha ?? digest(request.request), expires_at: o.expires ?? clockAt + 600000 }, () => clockAt);
    if (o.after) o.after(request);
    return handle;
  } };
}
function transaction(cwd, key, fields) {
  const state = {}, unit = fields.unit;
  const record = { protocol_version: '1.0.0', idempotency_key: key, action: fields.action, unit, milestone: fields.milestone, host_runtime: 'codex',
    owner_digest: 'sha256:' + 'f'.repeat(64), lease_generation: 'fixture-generation', phase: 'committed', created_at: iso(fields.at), updated_at: iso(fields.at),
    before: { state_checksum: ssha(state), state }, after: { state_checksum: ssha(state), state, state_patch: {} },
    result: fields.result ? { idempotency_key: key, unit: unit.key, milestone: fields.milestone, status: fields.result } : null,
    event: { idempotency_key: key, unit: unit.key, milestone: fields.milestone, action: fields.action } };
  controller.writeAtomic(controller.transactionFile(cwd, key), record, false);
}

// ---------------------------------------------------------------------------
// Composed chain fixture: S02 selection with a linked task -> conformant ROADMAP -> canonical
// controller history over a real Git owner and milestone worktree -> T01 task (T02/T03 on demand).
// ---------------------------------------------------------------------------
function chainFixture() {
  const T0 = Date.now() - 20 * 60000;
  const root = tempRoot('forge-lth-'), owner = path.join(root, 'owner'), code = path.join(root, 'code'), home = path.join(root, 'home');
  fs.mkdirSync(owner); fs.mkdirSync(home);
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
  for (const label of ['Escolher posição', 'Com task ligada (media)', 'Criar e iniciar após prova']) {
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
// Real standalone task delivery of the linked task (forge-task-execution locations).
function taskDelivery(f) {
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
function workOf(f) {
  const s = personal.readPersonalSnapshot({ project: f.owner, ...f.prof, id: f.task });
  assert.equal(s.status, 'ok'); return s.works.find(w => w.id === f.task);
}
function startTask(f) {
  return lts.startLinkedTask({ cwd: f.owner, taskId: f.task, liveAdapter: liveAdapter(f.owner), codeDir: f.code, base: { kind: 'milestone-branch' },
    isolation: { mode: 'worktree', attached_to: M }, ...f.prof });
}
function child(payload) {
  const args = Buffer.from(JSON.stringify(payload)).toString('base64');
  const run = spawnSync(process.execPath, [__filename, '--child', args], { encoding: 'utf8', timeout: 240000, env: { ...process.env, HOME: payload.home, USERPROFILE: payload.home } });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split('\n').pop());
}
function childMain() {
  const a = JSON.parse(Buffer.from(process.argv[3], 'base64').toString('utf8'));
  const fresh = require('./forge-linked-task-horizon');
  const result = a.mode === 'clock' ? fresh.readTaskClock({ cwd: a.cwd, task: a.task, now: a.now })
    : fresh.decideLinkedTaskEntry({ cwd: a.cwd, taskId: a.task, unit: a.unit, now: a.now });
  process.stdout.write(JSON.stringify(result) + '\n');
}
function cli(f, args) {
  const run = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 240000, env: { ...process.env, HOME: f.home, USERPROFILE: f.home } });
  return { status: run.status, stdout: run.stdout, json: (() => { try { return JSON.parse(run.stdout.trim().split('\n').pop()); } catch { return null; } })() };
}
function foreignQuestions(f, n) {
  const made = [];
  for (let i = 0; i < n; i++) made.push(questions.openQuestions({ cwd: f.owner, milestone: 'M002', unit: 'milestone-time/foreign-' + i, decision_set: 'milestone-time-linked-task',
    questions: [{ id: 'x' + i, question: 'Alheia?' }] }).identity_sha256);
  return () => { for (const id of made) for (const suffix of ['.json', '.origin.json']) fs.rmSync(path.join(f.owner, '.gsd/forge/questions', id + suffix), { force: true }); };
}
function prepared(f, ceilingMs, now, response = 'Estender o horizonte da task') {
  const p = horizon.prepareTaskExtension({ cwd: f.owner, task: f.task, ceilingMs, now });
  assert.equal(p.status, 'open', JSON.stringify(p));
  if (response) assert.equal(horizon.answerTaskExtension({ cwd: f.owner, task: f.task, ceilingMs, now, response, source: 'user-text' }).status, 'answered');
  return p;
}
// A real receipt of one standalone attempt, bound to its request by the canonical recovery identity.
function receiptFor(f, name, request, fields) {
  const identity = digest(recovery.requestIdentity(recovery.canonicalRequest(request)));
  return write(f.root, 'receipts/' + name + '.json', { schema_version: 1, recovery_identity_sha256: identity, ...fields });
}

async function suite() {
  const suiteHome = tempRoot('forge-lth-home-'), saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const realStore = path.join(REAL_HOME, '.forge-personal', 'context.json'), realBefore = fs.existsSync(realStore) ? sha(fs.readFileSync(realStore)) : null;
  const realGsd = path.join(__dirname, '..', '.gsd');
  const realView = () => JSON.stringify(tree(path.join(realGsd, 'forge', 'runs'))) + JSON.stringify(fs.existsSync(path.join(realGsd, 'tasks')) ? fs.readdirSync(path.join(realGsd, 'tasks')) : []);
  const realGsdBefore = realView();
  process.env.HOME = suiteHome; process.env.USERPROFILE = suiteHome;
  let passed = false;
  try {
    // =======================================================================
    // Truth 0: inert exports, distinct closed admission codes and the clock policy.
    // =======================================================================
    const source = fs.readFileSync(SCRIPT, 'utf8');
    assert.deepEqual(LOADED_AT_IMPORT, [], 'importing the module loads no local module');
    for (const name of ['readTaskClock', 'decideLinkedTaskEntry', 'assertLinkedTaskEntry', 'appendTaskJournal', 'inspectTaskDrain', 'checkpointTaskIfDrained',
      'extendTaskHorizon', 'readLinkedStatus', 'summarizeLinkedStatus', 'main']) assert.equal(typeof horizon[name], 'function', name);
    assert.deepEqual(horizon.TASK_CLOCK_POLICY, { id: 'forge-linked-task-clock', version: 1 });
    assert.deepEqual(horizon.LINKED_TASK_TRANSPORT_CODES, ['predecessor-incomplete', 'linked-task-not-started', 'linked-task-budget-exhausted', 'linked-task-budget-draining',
      'linked-task-time-invalid', 'linked-task-clock-unknown', 'linked-task-chain-closed', 'linked-task-closed']);
    assert.deepEqual(horizon.TASK_STATES, ['not-started', 'active', 'exhausted', 'draining', 'checkpointed', 'extended', 'completed', 'chain-closed', 'unknown']);
    for (const list of [horizon.TASK_CLOCK_POLICY, horizon.LINKED_TASK_TRANSPORT_CODES, horizon.TASK_STATES, horizon.HORIZON_REFUSALS, horizon.HORIZON_RECORD_FIELDS,
      horizon.TASK_DRAIN_STATES, horizon.TASK_WRITER_CLASSES]) assert.ok(Object.isFrozen(list));
    const allCodes = [...horizon.LINKED_TASK_TRANSPORT_CODES, ...horizon.HORIZON_REFUSALS];
    for (const code of allCodes) {
      assert.ok(!/timeout|terminated|network/.test(code), code);
      assert.ok(code !== 'budget-exceeded-while-active' && !code.startsWith('milestone-budget-'), code);
    }
    // S03/T05: the linked codes are exactly the tail of the admission transport refusals (so every
    // transport consumer classifies them) and stay absent from the milestone TIME_REASON_CODES.
    assert.deepEqual(horizon.LINKED_TASK_TRANSPORT_CODES.filter(c => admission.TIME_REASON_CODES.includes(c)), [], 'distinct from the milestone reason vocabulary');
    assert.deepEqual(admission.TRANSPORT_REFUSAL_CODES.slice(-horizon.LINKED_TASK_TRANSPORT_CODES.length), [...horizon.LINKED_TASK_TRANSPORT_CODES], 'exactly the linked transport literals');
    assert.ok(admission.TRANSPORT_REFUSAL_CODES.slice(0, -horizon.LINKED_TASK_TRANSPORT_CODES.length).every(c => admission.TIME_REASON_CODES.includes(c)), 'the remaining refusals are milestone codes');
    assert.equal(new Set(horizon.LINKED_TASK_TRANSPORT_CODES).size, 8);
    assert.deepEqual(horizon.TASK_UNIT_TYPES, [...['brainstorm', 'discuss', 'research', 'plan'].map(p => require('./forge-task-preparation').phaseContract(p).unitType), 'execute-task'],
      'task units are the real preparation unit types plus execution');
    assert.ok(!/\b(?:TODO|TBD|FIXME)\b/.test(source), 'no stub markers');
    assert.ok(source.split('\n').length >= 280 && fs.readFileSync(__filename, 'utf8').split('\n').length >= 280 && fs.readFileSync(SCHEMA, 'utf8').split('\n').length >= 40, 'artifact minimum sizes');
    // The task clock reuses the S01 consumption table instead of a second policy.
    assert.equal(clock.CLOCK_POLICY.consumption['human-wait'], false); assert.equal(clock.CLOCK_POLICY.consumption.unknown, true);
    line('inert exports preserve distinct task admission codes and clock policy');

    // =======================================================================
    // Fixtures: F (the governed chained task) and D (the chain closed before start).
    // =======================================================================
    const F = chainFixture(), T = F.task;
    const D = chainFixture();

    // Admission before the endpoint and before the start (exact lifecycle).
    let provider = 0;
    const transport = (f, unit, now) => { horizon.assertLinkedTaskEntry({ cwd: f.owner, taskId: f.task, unit, now }); provider++; return 'provider-called'; };
    const refusedAs = (f, unit, now, code) => {
      let error = null;
      try { transport(f, unit, now); } catch (e) { error = e; }
      assert.ok(error, 'refused ' + code);
      assert.deepEqual([error.code, error.provider_called, error.stage, error.layer], [code, false, 'linked-task-admission', 'milestone-time-admission']);
      assert.ok(!('timeoutMs' in (error.details || {})) && !('workers_timeout' in (error.details || {})));
      return error;
    };
    let before = snap(F);
    refusedAs(F, 'execute-task/' + T, Date.now(), 'predecessor-incomplete');
    const blockedStatus = horizon.readLinkedStatus({ cwd: F.owner, task: T, now: Date.now(), ...F.prof });
    assert.deepEqual([blockedStatus.predecessor.lifecycle, blockedStatus.predecessor.status, blockedStatus.predecessor.reason, blockedStatus.task_horizon.state,
      blockedStatus.milestone_horizon.endpoint.proven, blockedStatus.chain.consumed_ms], ['blocked', 'predecessor-incomplete', 'endpoint-unproven', 'not-started', false, null]);
    unchanged(F, before, 'blocked admission and predecessor status');
    F.endpoint();
    assert.equal(lts.produceHandoff({ cwd: F.owner, milestone: M, ...F.prof }).status, 'produced');
    before = snap(F);
    refusedAs(F, 'plan-milestone/' + T, Date.now(), 'linked-task-not-started');
    unchanged(F, before, 'not-started admission');
    const startClockBefore = horizon.readTaskClock({ cwd: F.owner, task: T, now: Date.now() });
    assert.equal(startClockBefore.status, 'not-started');
    const started = startTask(F);
    assert.equal(started.status, 'started', JSON.stringify(started));
    const S = Date.parse(json(F.owner, recordRef('start')).started_at), C = linked.linkedTaskFor(F.owner, T).link.linked_task.horizon.ceiling_ms;
    const at = s => iso(S + s * 1000);
    assert.ok(Number.isSafeInteger(C) && C > 1300000, 'the link horizon is the task ceiling');

    // D: explicit attested chain closure before any start.
    refusedAs(D, 'execute-task/' + D.task, Date.now(), 'predecessor-incomplete');
    const closing = lts.prepareLinkedDecision({ cwd: D.owner, task: D.task, action: 'close-chain' });
    assert.equal(closing.status, 'open');
    assert.equal(lts.answerLinkedDecision({ cwd: D.owner, task: D.task, action: 'close-chain', response: 'linked-task:close-chain', source: 'user-text' }).status, 'answered');
    assert.equal(lts.closeChain({ cwd: D.owner, taskId: D.task, liveAdapter: liveAdapter(D.owner), ...D.prof }).status, 'chain-closed');

    // =======================================================================
    // Truth 1 (part): the real task clock — overlaps, waits, unknown, effort and restart.
    // =======================================================================
    const guard = ownerLockGuard();
    const q1 = questions.openQuestions({ cwd: F.owner, task: T, workflow_id: T, unit: 'execute-task/' + T, decision_set: 'task-question', questions: [{ id: 'q-task-1', question: 'Formato do relatório?' }] });
    const q4 = questions.openQuestions({ cwd: F.owner, unit: 'plan-milestone/' + T, decision_set: 'task-question', questions: [{ id: 'q-task-4', question: 'Qual ambiente?' }] });
    const q3 = questions.openQuestions({ cwd: F.owner, milestone: M, unit: 'milestone-time/fora-da-task', decision_set: 'task-question', questions: [{ id: 'q-milestone-3', question: 'Da milestone?' }] });
    const sessionA = digest('sessao-a'), sessionB = digest('sessao-b');
    const appendOk = record => { const r = horizon.appendTaskJournal({ cwd: F.owner, task: T, record }); assert.equal(r.status, 'appended', JSON.stringify(r)); };
    appendOk({ type: 'presence', session_sha256: sessionA, boundary: 'session-start', at: at(60) });
    appendOk({ type: 'presence', session_sha256: sessionB, boundary: 'session-start', at: at(120) });
    appendOk({ type: 'presence', session_sha256: sessionA, boundary: 'next', at: at(180) });
    appendOk({ type: 'presence', session_sha256: sessionB, boundary: 'next', at: at(240) });
    appendOk({ type: 'presence', session_sha256: sessionA, boundary: 'session-end', at: at(300) });
    appendOk({ type: 'wait-start', wait_id: 'w1', class: 'human', source: { kind: 'pending-question', ref: q1.identity_sha256 + ':q-task-1' }, at: at(400) });
    questions.answer({ cwd: F.owner, identity: q1.identity_sha256, answers: [{ id: 'q-task-1', answer: 'markdown', source: 'user-text' }] });
    appendOk({ type: 'wait-end', wait_id: 'w1', class: 'human', source: { kind: 'pending-question', ref: q1.identity_sha256 + ':q-task-1' }, at: at(500) });
    appendOk({ type: 'wait-start', wait_id: 'w2', class: 'pause', source: { kind: 'operator', ref: 'pausa explícita do operador' }, at: at(600) });
    appendOk({ type: 'wait-end', wait_id: 'w2', class: 'pause', source: { kind: 'operator', ref: 'pausa explícita do operador' }, at: at(700) });
    appendOk({ type: 'wait-start', wait_id: 'w3', class: 'human', source: { kind: 'pending-question', ref: q3.identity_sha256 + ':q-milestone-3' }, at: at(800) });
    appendOk({ type: 'wait-end', wait_id: 'w3', class: 'human', source: { kind: 'pending-question', ref: q3.identity_sha256 + ':q-milestone-3' }, at: at(900) });
    appendOk({ type: 'wait-start', wait_id: 'w4', class: 'human', source: { kind: 'pending-question', ref: q4.identity_sha256 + ':q-task-4' }, at: at(1000) });
    const now1 = S + 1200000;
    const c1 = horizon.readTaskClock({ cwd: F.owner, task: T, now: now1 });
    assert.equal(c1.status, 'measured', JSON.stringify(c1));
    assert.deepEqual(c1.policy, horizon.TASK_CLOCK_POLICY);
    assert.deepEqual(c1.consumption_policy, { id: clock.CLOCK_POLICY.id, version: clock.CLOCK_POLICY.version });
    assert.equal(c1.consumption.by_class['owner-session'], 240000, 'overlapping sessions are united, never summed');
    assert.equal(c1.overlap_ms, 120000 + 0, 'the overlap is measured and excluded');
    assert.equal(c1.consumption.by_class['human-wait'], 300000, 'workflow wait closed by wait-end plus unit-view wait still pending');
    assert.equal(c1.consumption.by_class.pause, 100000, 'explicit pause does not consume');
    assert.equal(c1.consumption.unknown_ms, 560000, 'everything without a source consumes as unknown, including a foreign question wait');
    assert.equal(c1.consumption.consumed_ms, 800000);
    assert.equal(c1.consumption.consumed_ms, Object.entries(c1.consumption.by_class).filter(([k]) => clock.CLOCK_POLICY.consumption[k]).reduce((s, [, v]) => s + v, 0));
    assert.deepEqual(c1.effort.worker, { status: 'unknown', reason: 'task-worker-evidence-unavailable' }, 'effort is unknown, never zero');
    assert.ok(c1.gaps.some(g => g.reason === 'wait-end-missing' && g.start === at(800) && g.end === at(900)), 'the foreign question wait is a named unknown gap');
    assert.ok(c1.gaps.some(g => g.reason === 'no-source' && g.start === at(0) && g.end === at(60)));
    assert.equal(c1.frozen, false);
    // A fresh process recomputes the same clock from the persisted sources: every gap is preserved.
    const fresh = child({ mode: 'clock', cwd: F.owner, task: T, now: now1, home: F.home });
    assert.deepEqual(fresh, c1, 'restart in a fresh process preserves consumption and gaps');
    // An unreadable or excess question census never turns a wait into zero consumption.
    const restore = foreignQuestions(F, 65);
    const overflow = horizon.readTaskClock({ cwd: F.owner, task: T, now: now1 });
    assert.ok(overflow.unknowns.includes('question-census-unknown'), JSON.stringify(overflow.unknowns));
    assert.equal(overflow.consumption.consumed_ms, c1.consumption.consumed_ms + 300000, 'unconfirmed question waits consume as unknown');
    restore();
    // A tampered journal fails closed (and the admission with it).
    const journalRef = `.gsd/forge/time/${M}/linked-task/journal.jsonl`, journalBytes = fs.readFileSync(file(F.owner, journalRef));
    fs.appendFileSync(file(F.owner, journalRef), '{"type":"presence","forjado":true}\n');
    assert.deepEqual([horizon.readTaskClock({ cwd: F.owner, task: T, now: now1 }).status, horizon.readTaskClock({ cwd: F.owner, task: T, now: now1 }).reason], ['invalid', 'linked-task-time-invalid']);
    refusedAs(F, 'execute-task/' + T, now1, 'linked-task-time-invalid');
    fs.writeFileSync(file(F.owner, journalRef), journalBytes);
    assert.equal(horizon.readTaskClock({ cwd: F.owner, task: T, now: now1 }).status, 'measured');
    // w4 is closed by its wait-end: from now on everything without a source consumes again.
    questions.answer({ cwd: F.owner, identity: q4.identity_sha256, answers: [{ id: 'q-task-4', answer: 'local', source: 'user-text' }] });
    appendOk({ type: 'wait-end', wait_id: 'w4', class: 'human', source: { kind: 'pending-question', ref: q4.identity_sha256 + ':q-task-4' }, at: at(1200) });
    assert.equal(horizon.readTaskClock({ cwd: F.owner, task: T, now: now1 }).consumption.consumed_ms, 800000, 'a closed wait keeps its non-consuming span');

    // =======================================================================
    // Truth 2: exact lifecycle and the current task ceiling govern admission, zero provider calls.
    // =======================================================================
    const unit = 'execute-task/' + T;
    const admitted = horizon.decideLinkedTaskEntry({ cwd: F.owner, taskId: T, unit, now: now1 });
    assert.deepEqual([admitted.allowed, admitted.decision, admitted.consumed_ms, admitted.ceiling_ms, admitted.start_sha256],
      [true, 'admitted', 800000, C, lts.linkedLifecycle(F.owner, T).start_sha256]);
    for (const key of ['timeoutMs', 'workers_timeout', 'timeout_ms']) assert.ok(!(key in admitted), 'the task ceiling never becomes a worker timeout: ' + key);
    assert.equal(transport(F, unit, now1), 'provider-called');
    const providerAfterAdmitted = provider;
    // The unlinked fast path reads no time state at all.
    const trapped = ['readContract', 'readOwnerRecord', 'readTaskLink', 'readSelection', 'readJournal', 'readOwnerJournal', 'listOwnerRecords'];
    const originals = Object.fromEntries(trapped.map(name => [name, time[name]]));
    try {
      for (const name of trapped) time[name] = () => { throw new Error('unexpected time access: ' + name); };
      assert.deepEqual(horizon.decideLinkedTaskEntry({ cwd: F.owner, taskId: 'T-20261105120000-plain-task', unit: 'execute-task/T-20261105120000-plain-task', now: now1 }),
        { allowed: true, decision: 'unlinked' });
    } finally { Object.assign(time, originals); }
    // Marker without index and an invalid index fail closed.
    const markerTask = 'T-20261105120001-marker-only';
    write(F.owner, `.gsd/tasks/${markerTask}/${markerTask}-BRIEF.md`, `---\nid: ${markerTask}\nlinked_milestone: ${M}\n---\n# x\n`);
    before = snap(F);
    refusedAs({ owner: F.owner, task: markerTask }, 'execute-task/' + markerTask, now1, 'linked-task-time-invalid');
    unchanged(F, before, 'marker without index');
    fs.rmSync(file(F.owner, `.gsd/tasks/${markerTask}`), { recursive: true });
    const badIndex = 'T-20261105120002-bad-index';
    write(F.owner, `.gsd/forge/time-links/${badIndex}.json`, '{"schema_version":1,"kind":"forjado"}\n');
    refusedAs({ owner: F.owner, task: badIndex }, 'execute-task/' + badIndex, now1, 'linked-task-time-invalid');
    fs.rmSync(file(F.owner, `.gsd/forge/time-links/${badIndex}.json`));
    // A clock that cannot be measured is unknown, never zero.
    refusedAs(F, unit, S - 60000, 'linked-task-clock-unknown');
    refusedAs(D, 'execute-task/' + D.task, Date.now(), 'linked-task-chain-closed');
    refusedAs(F, 'execute-task/T-20261105120003-other', now1, 'linked-task-time-invalid');
    // At the cap: exhausted, or draining while another writer of the task is open.
    const nowX = S + C + 700000;
    const exhaustedAt = horizon.readTaskClock({ cwd: F.owner, task: T, now: nowX });
    assert.equal(exhaustedAt.consumption.consumed_ms, C + 300000);
    refusedAs(F, unit, nowX, 'linked-task-budget-exhausted');
    assert.equal(horizon.decideLinkedTaskEntry({ cwd: F.owner, taskId: T, unit, now: nowX, reportedAttempts: [{ unit: 'plan-milestone/' + T }] }).reason_code, 'linked-task-budget-draining');
    const v1claim = writeClaim.recordClaim(F.owner, T, { schema_version: 2, source: 'plan-writes', unit, execution_contract: codeRoots.singleContract(F.owner, F.code), paths: ['primary::scripts/result.js'] });
    assert.equal(horizon.decideLinkedTaskEntry({ cwd: F.owner, taskId: T, unit, now: nowX }).reason_code, 'linked-task-budget-draining', 'a held claim of another generation is an open writer');
    assert.equal(horizon.decideLinkedTaskEntry({ cwd: F.owner, taskId: T, unit, now: nowX, claimGeneration: v1claim.generation }).reason_code, 'linked-task-budget-exhausted', 'the entry own claim is not another writer');
    assert.equal(provider, providerAfterAdmitted, 'no refused entry ever reached the provider');

    // =======================================================================
    // Truth 6 (part): protected task windows and the schema-validated journal boundary.
    // =======================================================================
    before = snap(F);
    const deferred = horizon.appendTaskJournal({ cwd: F.owner, task: T, record: { type: 'presence', session_sha256: null, boundary: 'status', at: at(1300) } });
    assert.deepEqual([deferred.status, deferred.reason, deferred.detail], ['refused', 'linked-task-boundary-deferred', 'task-execution-claim-held']);
    unchanged(F, before, 'journal inside a protected task window');
    assert.ok(writeClaim.isHeld(runs.get(F.owner, T).write_claim), 'the held claim is never released by the horizon');

    // =======================================================================
    // Truth 3: live receipt and process drain never kills, steals, releases or hides unknowns.
    // =======================================================================
    const request = { unitType: 'execute-task', scope: 'standalone-task', taskId: T, cwd: F.code, contextRoot: F.owner, route: { host_runtime: 'claude' }, phase: 'execute' };
    const alive = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); children.push(alive);
    const deadPid = spawnSync(process.execPath, ['-e', '0']).pid;
    const liveReceipt = receiptFor(F, 'alive', request, { phase: 'started', process_pid: alive.pid });
    const deadReceipt = receiptFor(F, 'dead', request, { phase: 'failed', process_pid: deadPid, failure: { reason_code: 'worker-exited', provider_called: true } });
    const savedReceipt = receiptFor(F, 'saved', request, { phase: 'ready', process_pid: deadPid, result: { status: 'done' } });
    const preReceipt = receiptFor(F, 'pre-provider', request, { phase: 'failed', failure: { reason_code: 'linked-task-budget-exhausted', provider_called: false } });
    const foreignReceipt = write(F.root, 'receipts/foreign.json', { schema_version: 1, recovery_identity_sha256: 'a'.repeat(64), phase: 'ready', process_pid: deadPid });
    const probe = r => (r.process_pid === alive.pid ? 'alive' : 'stopped');
    const adapterOf = (attempts, o = {}) => ({ calls: 0, inspectAttempt(q) { this.calls++; assert.equal(q.task, T); if (o.during) o.during(); return typeof attempts === 'function' ? attempts() : attempts; },
      processProbe: o.probe || probe });
    const attempt = (receipt, extra = {}) => ({ unit, receipt_path: receipt, request: { ...request, ...extra } });
    const drainCase = (adapter, label) => {
      const spies = effectSpies(), b = snap(F);
      let drained, check;
      try {
        drained = horizon.inspectTaskDrain({ cwd: F.owner, task: T, now: nowX, liveAdapter: adapter });
        check = horizon.checkpointTaskIfDrained({ cwd: F.owner, task: T, now: nowX, liveAdapter: adapter, ...F.prof });
      } finally { spies.restore(); }
      assert.deepEqual(spies.calls, [], label + ': no lease, claim or run mutation');
      assert.ok(spies.signals.every(s => s === 0), label + ': only signal 0 probes, never a kill');
      unchanged(F, b, label + ' refused checkpoint');
      assert.equal(check.status, 'not-drained', label + ' ' + JSON.stringify(check));
      return drained;
    };
    let d = drainCase(undefined, 'no adapter');
    assert.deepEqual([d.state, d.reason, d.claim], ['incomplete-unknown', 'host-inspector-required', 'held']);
    d = drainCase(adapterOf({ forged: true }), 'invalid census');
    assert.ok(d.state === 'incomplete-unknown' && d.unknowns.includes('attempt-census-invalid'));
    d = drainCase(adapterOf(Array.from({ length: 65 }, () => attempt(preReceipt))), 'overflow census');
    assert.ok(d.state === 'incomplete-unknown' && d.unknowns.includes('attempt-census-overflow'));
    d = drainCase(adapterOf([attempt(liveReceipt)]), 'live writer');
    assert.deepEqual([d.state, d.writers[0].classification, d.writers[0].reason], ['draining', 'healthy', 'process-alive']);
    process.kill(alive.pid, 0);
    assert.equal(alive.exitCode, null, 'the live writer survives every inspection');
    d = drainCase(adapterOf([attempt(deadReceipt)]), 'dead writer');
    assert.deepEqual([d.state, d.writers[0].classification], ['draining', 'dead-requires-failure-consumption']);
    d = drainCase(adapterOf([attempt(savedReceipt)]), 'saved response');
    assert.deepEqual([d.state, d.writers[0].classification], ['draining', 'saved-response-requires-publication']);
    d = drainCase(adapterOf([attempt(liveReceipt)], { probe: () => 'maybe' }), 'unknown probe');
    assert.deepEqual([d.state, d.writers[0].reason], ['incomplete-unknown', 'process-probe-unknown']);
    d = drainCase(adapterOf([attempt(path.join(F.root, 'receipts', 'missing.json'))]), 'missing receipt');
    assert.deepEqual([d.state, d.writers[0].reason], ['incomplete-unknown', 'receipt-missing']);
    d = drainCase(adapterOf([attempt(foreignReceipt)]), 'foreign receipt');
    assert.deepEqual([d.state, d.writers[0].reason], ['incomplete-unknown', 'receipt-identity-mismatch']);
    d = drainCase(adapterOf(() => { throw new Error('adapter down'); }), 'adapter failure');
    assert.equal(d.state, 'incomplete-unknown');
    d = drainCase(adapterOf([attempt(preReceipt)]), 'terminal writer under a held claim');
    assert.deepEqual([d.state, d.claim, d.writers[0].classification], ['draining', 'held', 'terminal'], 'an old-generation live claim still counts');
    refusedAs(F, unit, nowX, 'linked-task-budget-draining');
    // The canonical owner flow releases the claim; the released history is not an active writer.
    const releasedAt = Date.now();
    assert.equal(writeClaim.releaseClaim(F.owner, T, { at: releasedAt, mechanism: writeClaim.RELEASE_MECHANISMS.includes('manual') ? 'manual' : writeClaim.RELEASE_MECHANISMS[0], evidence: {} }).ok, true);
    const releasedClaim = runs.get(F.owner, T).write_claim;
    assert.ok(!writeClaim.isHeld(releasedClaim) && releasedClaim.generation === v1claim.generation, 'the same-generation claim is really released');
    // Negative controls: a same-generation released claim proves neither the publication of a stopped
    // ready/executed/saved_candidate result nor the consumption of a failed/abandoned receipt. Imported
    // published/consumed flags are data, never host evidence; each case stays draining and writes nothing.
    const finished = receiptFor(F, 'finished', request, { phase: 'ready', process_pid: deadPid, result: { status: 'done' }, published: true });
    const executed = receiptFor(F, 'executed', request, { phase: 'executed', process_pid: deadPid, provider_called: true, execution: { status: 'done' }, published: true });
    const candidate = receiptFor(F, 'candidate', request, { phase: 'failed', process_pid: deadPid, saved_candidate: { status: 'done' },
      failure: { reason_code: 'worker-exited', provider_called: true }, published: true });
    const flagged = receiptFor(F, 'flagged', request, { phase: 'ready', provider_called: false, result: { status: 'done' } });
    const failedAfter = receiptFor(F, 'failed-after', request, { phase: 'failed', process_pid: deadPid, failure: { reason_code: 'worker-exited', provider_called: true }, consumed: true });
    const abandoned = receiptFor(F, 'abandoned', request, { phase: 'abandoned', failure: { reason_code: 'worker-abandoned', provider_called: false }, consumed: true });
    const own = { claim: v1claim };
    for (const [receipt, label] of [[finished, 'stopped ready'], [executed, 'stopped executed'], [candidate, 'stopped saved candidate'], [flagged, 'ready with a pre-provider flag']]) {
      d = drainCase(adapterOf([attempt(receipt, own), attempt(preReceipt, own)]), label + ' after the same-generation release');
      assert.deepEqual([d.state, d.claim, d.writers.map(w => w.classification)], ['draining', 'released', ['saved-response-requires-publication', 'terminal']], label);
      assert.equal(d.writers[0].reason, 'saved-response-replay-required', label);
    }
    for (const [receipt, label] of [[failedAfter, 'failed receipt'], [deadReceipt, 'dead writer'], [abandoned, 'abandoned pre-provider receipt']]) {
      d = drainCase(adapterOf([attempt(receipt, own)]), label + ' after the same-generation release');
      assert.deepEqual([d.state, d.claim, d.writers[0].classification, d.writers[0].reason], ['draining', 'released', 'dead-requires-failure-consumption', 'existing-consume-failure-required'], label);
    }
    // Genuinely reconciled positive: the real receipt is inspected by inspectReceipt, the live probe attests
    // the stopped process, the provider was never called and the canonical claim is released.
    let probed = 0;
    const ready = adapterOf([attempt(preReceipt, own)], { probe: r => { probed++; return probe(r); } });
    const readyDrain = horizon.inspectTaskDrain({ cwd: F.owner, task: T, now: nowX, liveAdapter: ready });
    assert.deepEqual([readyDrain.state, readyDrain.claim, readyDrain.writers.map(w => w.reason)], ['drained', 'released', ['pre-provider-stop']]);
    assert.ok(probed > 0 && ready.calls === 1, 'the drain came from the live attempt and process adapters');
    // Competing canonical personal writer at the real mutex boundary: its capture survives, the outer update refuses safely.
    write(F.owner, 'notes/independent.md', 'captura independente\n');
    const independentSource = file(F.owner, 'notes/independent.md'), INDEPENDENT = 'Revisar notas independentes';
    const isIndependent = c => c.text === INDEPENDENT && path.basename(c.source) === 'independent.md';
    const originalSave = personal.saveCheckpoint;
    let competed = 0;
    personal.saveCheckpoint = function (options) {
      if (!competed++) {
        const work = workOf(F);
        const keep = (work.checkpoint.pending || []).map(c => ({ text: c.text, source: c.source, resolved: c.resolved }));
        assert.equal(originalSave({ project: F.owner, ...F.prof, id: T, intent: 'checkpoint', checkpoint: { pending: [...keep, { text: INDEPENDENT, source: independentSource }] } }).status, 'ok');
      }
      return originalSave.call(this, options);
    };
    let first;
    const spies = effectSpies();
    try { first = horizon.checkpointTaskIfDrained({ cwd: F.owner, task: T, now: nowX, liveAdapter: ready, ...F.prof }); }
    finally { personal.saveCheckpoint = originalSave; spies.restore(); }
    assert.deepEqual(spies.calls, []); assert.ok(spies.signals.every(s => s === 0));
    assert.deepEqual([first.status, first.reason, first.detail, first.checkpoint?.version], ['partial', 'linked-task-personal-conflict', 'checkpoint-conflict', 1], JSON.stringify(first));
    assert.ok(workOf(F).checkpoint.pending.some(isIndependent), 'the independent committed capture survives');
    const cpRef = `.gsd/forge/time/${M}/linked-task/checkpoints/1.json`, cpBytes = fs.readFileSync(file(F.owner, cpRef)), cpMtime = fs.statSync(file(F.owner, cpRef)).mtimeMs;
    const cp = JSON.parse(cpBytes);
    assert.ok(horizon.validateCheckpointRecord(cp));
    assert.deepEqual([cp.version, cp.ceiling_ms, cp.consumed_ms, cp.overshoot_ms, cp.decision_pending, cp.drain.claim, cp.drain.writers.length],
      [1, C, C + 300000, 300000, true, 'released', 1]);
    assert.deepEqual(cp.pending_decision.alternatives, ['extend-task-horizon', 'close-chain']);
    const second = horizon.checkpointTaskIfDrained({ cwd: F.owner, task: T, now: nowX, liveAdapter: ready, ...F.prof });
    assert.deepEqual([second.status, second.personal, second.overshoot_ms], ['unchanged', 'saved', 300000], JSON.stringify(second));
    const work1 = workOf(F);
    assert.ok(work1.checkpoint.pending.some(isIndependent) &&work1.checkpoint.pending.some(c => c.text === cp.next_action));
    assert.deepEqual(work1.checkpoint.nextAction.map(c => c.text), [cp.next_action]);
    const third = horizon.checkpointTaskIfDrained({ cwd: F.owner, task: T, now: nowX + 1000, liveAdapter: ready, ...F.prof });
    assert.deepEqual([third.status, third.personal], ['unchanged', 'unchanged']);
    assert.ok(fs.readFileSync(file(F.owner, cpRef)).equals(cpBytes) && fs.statSync(file(F.owner, cpRef)).mtimeMs === cpMtime, 'the checkpoint is immutable');
    assert.equal(guard.seen.nested, 0, 'no nested owner lock');
    refusedAs(F, unit, nowX, 'linked-task-budget-exhausted');
    assert.equal(horizon.readLinkedStatus({ cwd: F.owner, task: T, now: nowX, ...F.prof }).task_horizon.state, 'checkpointed');
    line('live receipt and process drain never kills steals releases or hides unknown writers');

    // =======================================================================
    // Truth 4: a fresh scoped live decision alone extends the immutable chained task horizon.
    // =======================================================================
    const E1 = C + 1000, E2 = C + 3600000, E3 = E2 + 600000, E3b = E2 + 1200000;
    const extend = (ceilingMs, adapter, extra = {}) => horizon.extendTaskHorizon({ cwd: F.owner, task: T, ceilingMs, now: nowX, liveAdapter: adapter, ...F.prof, ...extra });
    const refusedExtension = (label, reason, fn) => { const b = snap(F), r = fn(); assert.deepEqual([r.status, r.reason], ['refused', reason], label + ' ' + JSON.stringify(r)); unchanged(F, b, label); return r; };
    refusedExtension('no adapter', 'linked-task-authorization-required', () => horizon.extendTaskHorizon({ cwd: F.owner, task: T, ceilingMs: E1, now: nowX }));
    refusedExtension('imported approval', 'linked-task-authorization-required', () => extend(E1, JSON.parse(JSON.stringify({ approved: true, getDecisionHandle: 'approved' })), { approved: true }));
    refusedExtension('no question', 'linked-task-extension-request-required', () => extend(E1, liveAdapter(F.owner, { now: nowX })));
    refusedExtension('not increased', 'linked-task-extension-invalid', () => horizon.prepareTaskExtension({ cwd: F.owner, task: T, ceilingMs: C, now: nowX }));
    const restoreForeign = foreignQuestions(F, 65);
    refusedExtension('census overflow', 'linked-task-question-census-unknown', () => horizon.prepareTaskExtension({ cwd: F.owner, task: T, ceilingMs: E1, now: nowX }));
    restoreForeign();
    const p1 = prepared(F, E1, nowX, null);
    assert.deepEqual([p1.kind, p1.expected, p1.request], ['linked-task', ['linked-task:extend:' + E1], { milestone: M, task_id: T, link_sha256: linked.linkedTaskFor(F.owner, T).link_sha256, ceiling_ms: E1 }]);
    const origin = JSON.parse(fs.readFileSync(path.join(F.owner, '.gsd/forge/questions', p1.question.identity_sha256 + '.origin.json'), 'utf8')).identity;
    assert.deepEqual([origin.milestone, origin.task, origin.workflow_id, origin.decision_set], [M, T, T, 'milestone-time-linked-task'], 'one decision seen by the milestone and the task workflow');
    refusedExtension('unanswered', 'linked-task-extension-request-required', () => extend(E1, liveAdapter(F.owner, { now: nowX })));
    const keepCeiling = C + 2000;
    prepared(F, keepCeiling, nowX, 'Manter o horizonte');
    refusedExtension('declined', 'linked-task-authorization-revoked', () => extend(keepCeiling, liveAdapter(F.owner, { now: nowX })));
    assert.equal(horizon.answerTaskExtension({ cwd: F.owner, task: T, ceilingMs: E1, now: nowX, response: 'linked-task:extend:' + E1, source: 'user-text' }).status, 'answered');
    refusedExtension('other scope', 'linked-task-authorization-required', () => extend(E1, liveAdapter(F.owner, { now: nowX, requestSha: digest({ ...p1.request, ceiling_ms: E2 }) })));
    refusedExtension('expired', 'linked-task-authorization-required', () => extend(E1, liveAdapter(F.owner, { now: nowX, expires: nowX - 1 })));
    refusedExtension('serialized handle', 'linked-task-authorization-required', () => extend(E1, { getDecisionHandle: r => JSON.parse(JSON.stringify(liveAdapter(F.owner, { now: nowX }).getDecisionHandle(r))) }));
    refusedExtension('adapter failure', 'linked-task-authorization-required', () => extend(E1, liveAdapter(F.owner, { throws: true })));
    refusedExtension('changed answer', 'linked-task-authorization-revoked', () => extend(E1, liveAdapter(F.owner, { now: nowX, answer: 'linked-task:extend:' + E2 })));
    // R47: an interruption after the immutable extension publication leaves the old cap's captures pending;
    // retries (also after a genuine conditional-save conflict) complete ONLY that personal release, with no
    // second extension, no higher ceiling and no new consent. The embedded main below performs the final recovery.
    {
      const ext1Ref = `.gsd/forge/time/${M}/linked-task/extensions/0001.json`;
      const interrupted = extend(E1, liveAdapter(F.owner, { now: nowX }), { failpoint: name => name === 'after-extension' });
      assert.deepEqual([interrupted.status, interrupted.reason, interrupted.detail], ['partial', 'linked-task-operation-failed', 'failpoint-after-extension'], JSON.stringify(interrupted));
      const ext1Bytes = fs.readFileSync(file(F.owner, ext1Ref));
      assert.equal(horizon.readLinkedStatus({ cwd: F.owner, task: T, now: nowX, ...F.prof }).task_horizon.ceiling_ms, E1, 'the published extension already governs');
      assert.ok(workOf(F).checkpoint.pending.some(c => c.text === cp.next_action), 'the old cap capture is still pending after the interruption');
      // Genuine conditional-save conflict: a concurrent independent winner commits before the release is saved.
      const baseSave = personal.saveCheckpoint;
      let raced = 0;
      personal.saveCheckpoint = function (options) {
        if (!raced++) {
          const work = workOf(F), keep = (work.checkpoint.pending || []).map(c => ({ text: c.text, source: c.source, resolved: c.resolved }));
          assert.equal(baseSave({ project: F.owner, ...F.prof, id: T, intent: 'checkpoint', checkpoint: { pending: [...keep, { text: 'Nota concorrente da extensão', source: independentSource }] } }).status, 'ok');
        }
        return baseSave.call(this, options);
      };
      let conflicted;
      try { conflicted = extend(E1, liveAdapter(F.owner, { now: nowX })); } finally { personal.saveCheckpoint = baseSave; }
      assert.deepEqual([conflicted.status, conflicted.reason, conflicted.detail], ['refused', 'linked-task-personal-conflict', 'checkpoint-conflict'], JSON.stringify(conflicted));
      assert.ok(workOf(F).checkpoint.pending.some(c => c.text === 'Nota concorrente da extensão') && workOf(F).checkpoint.pending.some(c => c.text === cp.next_action), 'the competing winner is preserved and the release still pending');
      assert.ok(fs.readFileSync(file(F.owner, ext1Ref)).equals(ext1Bytes), 'the immutable extension is never rewritten');
      assert.equal(fs.readdirSync(file(F.owner, `.gsd/forge/time/${M}/linked-task/extensions`)).length, 1, 'no second extension');
      // A fresh scope never recovers: an unrelated value keeps its ordinary named refusals and writes nothing.
      refusedExtension('other value is not a recovery', 'linked-task-extension-request-required', () => extend(E1 + 1, liveAdapter(F.owner, { now: nowX })));
      refusedExtension('recovery needs live authority', 'linked-task-authorization-required', () => horizon.extendTaskHorizon({ cwd: F.owner, task: T, ceilingMs: E1, now: nowX, ...F.prof }));
      refusedExtension('recovery reattests the persisted answer', 'linked-task-authorization-required', () => extend(E1, liveAdapter(F.owner, { now: nowX, expires: nowX - 1 })));
    }
    // The standalone CLI refuses before any read; only the embedded main with the live adapter extends.
    before = snap(F);
    const standalone = cli(F, ['--extend', '--cwd', F.owner, '--task', T, '--ceiling-ms', String(E1), '--json']);
    assert.deepEqual([standalone.status, standalone.json.reason], [3, 'linked-task-authorization-required']);
    unchanged(F, before, 'standalone CLI extension');
    const out = { text: '', write(v) { this.text += v; } };
    // The embedded host process runs with the operator's profile (HOME), as a real CLI host does.
    process.env.HOME = F.home; process.env.USERPROFILE = F.home;
    try { assert.equal(horizon.main(['--extend', '--cwd', F.owner, '--task', T, '--ceiling-ms', String(E1), '--json'], { stdout: out }, liveAdapter(F.owner)), 0, out.text); }
    finally { process.env.HOME = suiteHome; process.env.USERPROFILE = suiteHome; }
    const ext1 = JSON.parse(out.text);
    assert.deepEqual([ext1.status, ext1.sequence, ext1.previous_ceiling_ms, ext1.ceiling_ms, ext1.personal], ['extended', 1, C, E1, 'saved']);
    // R47: the embedded recovery completed ONLY the personal release of the already published extension.
    assert.equal(ext1.recovered, true);
    assert.equal(fs.readdirSync(file(F.owner, `.gsd/forge/time/${M}/linked-task/extensions`)).length, 1, 'recovery never publishes a second extension');
    assert.ok(!workOf(F).checkpoint.pending.some(c => c.text === cp.next_action) && !workOf(F).checkpoint.nextAction.some(c => c.text === cp.next_action), 'the old cap captures are released');
    assert.ok(workOf(F).checkpoint.pending.some(c => c.text === 'Nota concorrente da extensão') && workOf(F).checkpoint.pending.some(isIndependent), 'independent captures survive the recovery');
    process.stdout.write('ok - integrated-R47-published-extension-personal-replay\n');
    noAbsolute(F, ext1, 'embedded extension output');
    const r1 = json(F.owner, `.gsd/forge/time/${M}/linked-task/extensions/0001.json`);
    assert.ok(horizon.validateExtensionRecord(r1));
    assert.deepEqual([r1.previous_sha256, r1.decision.answer], [lts.linkedLifecycle(F.owner, T).start_sha256, 'linked-task:extend:' + E1]);
    assert.ok(!workOf(F).checkpoint.pending.some(c => c.text === cp.next_action) && workOf(F).checkpoint.pending.some(isIndependent),
      'the decided checkpoint capture leaves; the independent one stays');
    // The consumed decision is never reused: the same value again is a smaller-or-equal ceiling.
    refusedExtension('replayed decision', 'linked-task-extension-invalid', () => extend(E1, liveAdapter(F.owner, { now: nowX })));
    // After the drained checkpoint admission only returns with a later extension AND a positive balance.
    refusedAs(F, unit, nowX, 'linked-task-budget-exhausted');
    prepared(F, E2, nowX);
    const ext2 = extend(E2, liveAdapter(F.owner, { now: nowX }));
    assert.deepEqual([ext2.status, ext2.sequence, ext2.previous_ceiling_ms, ext2.ceiling_ms], ['extended', 2, E1, E2], JSON.stringify(ext2));
    const r2 = json(F.owner, `.gsd/forge/time/${M}/linked-task/extensions/0002.json`);
    assert.equal(r2.previous_sha256, digest(r1), 'chained by previous_sha256');
    const back = horizon.decideLinkedTaskEntry({ cwd: F.owner, taskId: T, unit, now: nowX });
    assert.deepEqual([back.allowed, back.ceiling_ms, back.remaining_ms], [true, E2, E2 - (C + 300000)]);
    assert.equal(horizon.readLinkedStatus({ cwd: F.owner, task: T, now: nowX, ...F.prof }).task_horizon.state, 'extended');
    // A tampered or forged extension fails closed.
    const r2Ref = `.gsd/forge/time/${M}/linked-task/extensions/0002.json`, r2Bytes = fs.readFileSync(file(F.owner, r2Ref));
    write(F.owner, r2Ref, { ...r2, ceiling_ms: E2 + 1, decision: { ...r2.decision, answer: 'linked-task:extend:' + (E2 + 1) } });
    refusedAs(F, unit, nowX, 'linked-task-time-invalid');
    fs.writeFileSync(file(F.owner, r2Ref), r2Bytes);
    write(F.owner, `.gsd/forge/time/${M}/linked-task/extensions/0003.json`, { ...r2, sequence: 3, previous_sha256: digest(r2), previous_ceiling_ms: E2, ceiling_ms: E2 + 5000,
      decision: { ...r2.decision, answer: 'linked-task:extend:' + (E2 + 5000) } });
    refusedAs(F, unit, nowX, 'linked-task-time-invalid');
    fs.rmSync(file(F.owner, `.gsd/forge/time/${M}/linked-task/extensions/0003.json`));
    assert.equal(horizon.decideLinkedTaskEntry({ cwd: F.owner, taskId: T, unit, now: nowX }).allowed, true);
    // Late revalidation: the host callback legitimately publishes an intervening extension before
    // returning a genuine handle; the outer action refuses with zero additional effects.
    prepared(F, E3b, nowX);
    let afterCallback = null, nested = null;
    const intervening = liveAdapter(F.owner, { now: nowX, before() {
      prepared(F, E3, nowX);
      nested = extend(E3, liveAdapter(F.owner, { now: nowX }));
    }, after() { afterCallback = snap(F); } });
    const conflict = extend(E3b, intervening);
    assert.equal(nested.status, 'extended', JSON.stringify(nested));
    assert.deepEqual([conflict.status, conflict.reason], ['refused', 'linked-task-extension-conflict'], JSON.stringify(conflict));
    unchanged(F, afterCallback, 'outer extension after the intervening publication');
    assert.equal(json(F.owner, `.gsd/forge/time/${M}/linked-task/extensions/0003.json`).ceiling_ms, E3, 'the intervening immutable extension is intact');
    refusedExtension('consumed decision is not rebased', 'linked-task-extension-request-required', () => extend(E3b, liveAdapter(F.owner, { now: nowX })));
    assert.equal(guard.seen.nested, 0);
    line('fresh scoped live decision alone extends immutable chained task horizon');

    // R46: a completed non-authorizing extension choice (keep-horizon) is retained history; a later explicit
    // request for the SAME ceiling opens a new decision generation bound to its own live authority.
    {
      const G = chainFixture(); G.endpoint();
      assert.equal(lts.produceHandoff({ cwd: G.owner, milestone: M, ...G.prof }).status, 'produced');
      assert.equal(startTask(G).status, 'started');
      const GT = G.task, gnow = Date.now() + 5000, Cg = linked.linkedTaskFor(G.owner, GT).link.linked_task.horizon.ceiling_ms, V = Cg + 4321;
      const gExtend = adapter => horizon.extendTaskHorizon({ cwd: G.owner, task: GT, ceilingMs: V, now: gnow, liveAdapter: adapter, ...G.prof });
      const g1 = prepared(G, V, gnow, 'Manter o horizonte');
      assert.deepEqual([g1.generation, g1.sequence], [1, 1]);
      const declinedBefore = snap(G), declined = gExtend(liveAdapter(G.owner, { now: gnow }));
      assert.deepEqual([declined.status, declined.reason], ['refused', 'linked-task-authorization-revoked'], JSON.stringify(declined));
      unchanged(G, declinedBefore, 'a declined generation never authorizes');
      const g2 = horizon.prepareTaskExtension({ cwd: G.owner, task: GT, ceilingMs: V, now: gnow });
      assert.deepEqual([g2.status, g2.generation, g2.answer], ['open', 2, null], JSON.stringify(g2));
      assert.ok(g2.question.id !== g1.question.id && g2.question.identity_sha256 !== g1.question.identity_sha256 && g2.question.id.endsWith('-g2'), 'a new question identity per generation');
      assert.deepEqual(g2.expected, ['linked-task:extend:' + V]);
      assert.deepEqual(horizon.prepareTaskExtension({ cwd: G.owner, task: GT, ceilingMs: V, now: gnow }).question, g2.question, 'an unanswered generation stays stable');
      assert.equal(gExtend(liveAdapter(G.owner, { now: gnow })).reason, 'linked-task-extension-request-required', 'the unanswered new generation does not authorize');
      const answeredG2 = horizon.answerTaskExtension({ cwd: G.owner, task: GT, ceilingMs: V, now: gnow, response: 'linked-task:extend:' + V, source: 'user-text' });
      assert.deepEqual([answeredG2.status, answeredG2.question], ['answered', g2.question], JSON.stringify(answeredG2));
      const stored = q => questions.continuation({ cwd: G.owner, identity: q.identity_sha256 }).questions.find(row => row.id === q.id);
      assert.equal(stored(g1.question).answer, 'linked-task:keep-horizon', 'the declined generation remains history, never rewritten');
      assert.equal(stored(g2.question).answer, 'linked-task:extend:' + V);
      // A handle bound to the declined generation never extends: authority is the current generation.
      const stale = gExtend(liveAdapter(G.owner, { now: gnow, raw: request => liveAdapter(G.owner, { now: gnow }).getDecisionHandle({ ...request, question: g1.question, expected: ['linked-task:extend:' + V] }) }));
      assert.equal(stale.status, 'refused', JSON.stringify(stale));
      const extended = gExtend(liveAdapter(G.owner, { now: gnow }));
      assert.deepEqual([extended.status, extended.sequence, extended.previous_ceiling_ms, extended.ceiling_ms], ['extended', 1, Cg, V], JSON.stringify(extended));
      const record = json(G.owner, `.gsd/forge/time/${M}/linked-task/extensions/0001.json`);
      assert.ok(horizon.validateExtensionRecord(record));
      assert.deepEqual([record.decision.question, record.decision.answer], [g2.question, 'linked-task:extend:' + V], 'the record binds the live generation');
      assert.equal(horizon.readLinkedStatus({ cwd: G.owner, task: GT, now: gnow, ...G.prof }).task_horizon.ceiling_ms, V, 'the generation-2 extension is attested by every reader');
      assert.equal(stored(g1.question).answer, 'linked-task:keep-horizon');
      process.stdout.write('ok - integrated-R46-extension-decision-generations\n');

      // R43: an entry selected below the cap BEFORE a close-chain decision was opened or answered is still refused
      // at the actual provider entry (the same bounded read-only gate as start/continue), with zero writes.
      const unitG = 'execute-task/' + GT, entry = () => horizon.decideLinkedTaskEntry({ cwd: G.owner, taskId: GT, unit: unitG, now: gnow });
      assert.deepEqual([entry().allowed, entry().decision], [true, 'admitted'], 'selected below the cap before any close-chain question');
      const closing = lts.prepareLinkedDecision({ cwd: G.owner, task: GT, action: 'close-chain' });
      assert.equal(closing.status, 'open', JSON.stringify(closing));
      const pendingBefore = snap(G), pending = entry();
      assert.deepEqual([pending.allowed, pending.reason_code, pending.details.decision, pending.details.pending_ids], [false, 'linked-task-time-invalid', 'close-chain-pending', [closing.question.id]], JSON.stringify(pending));
      assert.ok(horizon.LINKED_TASK_TRANSPORT_CODES.includes(pending.reason_code), 'classified in the canonical transport vocabulary');
      let thrown = null; try { horizon.assertLinkedTaskEntry({ cwd: G.owner, taskId: GT, unit: unitG, now: gnow }); } catch (e) { thrown = e; }
      assert.deepEqual([thrown.code, thrown.provider_called, thrown.stage, thrown.details.pending_ids], ['linked-task-time-invalid', false, 'linked-task-admission', [closing.question.id]]);
      unchanged(G, pendingBefore, 'pending close-chain refusal writes nothing');
      // Declined (keep-chain) is completed history: the entry is admitted again.
      assert.equal(lts.answerLinkedDecision({ cwd: G.owner, task: GT, action: 'close-chain', response: 'linked-task:keep-chain', source: 'user-text' }).status, 'answered');
      assert.deepEqual([entry().allowed, entry().decision], [true, 'admitted'], 'a declined close-chain decision does not block');
      // Census fail-closed: 65 foreign question states make the decision census unknown, never "no questions".
      const flood = foreignQuestions(G, 65);
      try { const unknown = entry(); assert.deepEqual([unknown.allowed, unknown.reason_code], [false, 'linked-task-time-invalid'], JSON.stringify(unknown)); } finally { flood(); }
      assert.equal(entry().allowed, true, 'the bounded census is readable again');
      // A new generation answered to close the chain, closure not yet published: refused as the chain being closed.
      const second = lts.prepareLinkedDecision({ cwd: G.owner, task: GT, action: 'close-chain' });
      assert.deepEqual([second.status, second.generation], ['open', 2], JSON.stringify(second));
      assert.equal(entry().reason_code, 'linked-task-time-invalid', 'the new generation is pending again');
      assert.equal(lts.answerLinkedDecision({ cwd: G.owner, task: GT, action: 'close-chain', response: 'linked-task:close-chain', source: 'user-text' }).status, 'answered');
      const decidedBefore = snap(G), decided = entry();
      assert.deepEqual([decided.allowed, decided.reason_code, decided.details.decision], [false, 'linked-task-chain-closed', 'chain-closure-decided'], JSON.stringify(decided));
      assert.ok(!fs.existsSync(file(G.owner, recordRef('chain-closure'))), 'no chain-closure.json was published: the persisted decision alone blocks');
      unchanged(G, decidedBefore, 'accepted close-chain refusal writes nothing');
      process.stdout.write('ok - integrated-R43-late-close-chain-admission\n');
    }

    // =======================================================================
    // Truth 5: read-only bounded status separating milestone, task and the nongoverning chain.
    // =======================================================================
    before = snap(F);
    const st = horizon.readLinkedStatus({ cwd: F.owner, task: T, now: nowX, ...F.prof });
    const byMilestone = horizon.readLinkedStatus({ cwd: F.owner, milestone: M, now: nowX, ...F.prof });
    const drainRead = horizon.inspectTaskDrain({ cwd: F.owner, task: T, now: nowX });
    const clockRead = horizon.readTaskClock({ cwd: F.owner, task: T, now: nowX });
    unchanged(F, before, 'status, drain inspection and clock are pure reads (bytes and mtime)');
    assert.deepEqual(byMilestone, st, 'the milestone view projects the same link');
    assert.equal(drainRead.state, 'not-applicable');
    const mstatus = admission.readTimeStatus(F.owner, M, { now: nowX }), mclock = clock.readClock({ cwd: F.owner, milestone: M, now: nowX }), contract = time.readContract({ cwd: F.owner, milestone: M });
    assert.equal(mclock.frozen, true, 'the milestone clock is frozen at its endpoint');
    assert.deepEqual(st.governs, { milestone_operations: 'milestone-ceiling', task_operations: 'task-ceiling', chain: 'none' });
    assert.deepEqual([st.milestone_horizon.ceiling_ms, st.milestone_horizon.consumed_ms, st.milestone_horizon.frozen, st.milestone_horizon.endpoint.proven],
      [mstatus.horizon.ceiling_ms, mclock.consumption.consumed_ms, true, true]);
    assert.deepEqual([st.task_horizon.ceiling_ms, st.task_horizon.base_ceiling_ms, st.task_horizon.extensions, st.task_horizon.consumed_ms, st.task_horizon.remaining_ms, st.task_horizon.state],
      [E3, C, 3, clockRead.consumption.consumed_ms, E3 - clockRead.consumption.consumed_ms, 'extended']);
    assert.notEqual(st.task_horizon.ceiling_ms, st.milestone_horizon.ceiling_ms);
    assert.deepEqual(st.chain, { forecast: contract.contract.chain_forecast ? { low_ms: contract.contract.chain_forecast.low_ms, high_ms: contract.contract.chain_forecast.high_ms } : null,
      consumed_ms: mclock.consumption.consumed_ms + clockRead.consumption.consumed_ms, cap_ms: mstatus.horizon.ceiling_ms + E3, cap_basis: 'derived-sum', governs: false, completed: false });
    assert.ok(st.unknowns.includes('unattributed-time'), 'the unknown task time stays visible');
    noAbsolute(F, st, 'status');
    assert.ok(time.isPublicData(st));
    const summary = horizon.summarizeLinkedStatus(st);
    assert.deepEqual(Object.keys(summary), ['task_id', 'milestone_id', 'lifecycle', 'task', 'milestone', 'chain', 'decision_pending', 'unknown']);
    assert.deepEqual([summary.task.state, summary.task.ceiling_ms, summary.chain.governs, summary.chain.cap_basis, summary.milestone.frozen, summary.lifecycle],
      ['extended', E3, false, 'derived-sum', true, 'started']);
    assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 2048, 'the surface block is bounded');
    assert.equal(horizon.summarizeLinkedStatus(null), null);
    assert.equal(horizon.readLinkedStatus({ cwd: F.owner, task: 'T-20261105120000-plain-task', now: nowX }), null, 'unlinked status reads nothing');
    const dStatus = horizon.readLinkedStatus({ cwd: D.owner, task: D.task, now: Date.now(), ...D.prof });
    assert.deepEqual([dStatus.predecessor.lifecycle, dStatus.task_horizon.state, dStatus.task_horizon.consumed_ms, dStatus.chain.consumed_ms, dStatus.chain.governs],
      ['chain-closed', 'chain-closed', null, null, false], 'unknown or absent task consumption is null, never zero');
    line('read only bounded status separates milestone task and nongoverning derived chain');

    // =======================================================================
    // Late closure inside the live drain callback, frozen clock and the closed lifecycle.
    // =======================================================================
    taskDelivery(F);
    const independentWork = workOf(F);
    // Both fixture-authored independent notes have now finished. Keep the earlier isIndependent
    // predicate unchanged: R47 must continue proving that TWO distinct captures survived the race.
    const resolvedSource = source => {
      try { const resolved = fs.realpathSync.native(source); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; }
      catch { return null; }
    };
    const fixtureSource = resolvedSource(independentSource);
    assert.ok(fixtureSource);
    const finishedByIndependentWriter = c => [INDEPENDENT, 'Nota concorrente da extensão'].includes(c.text) && resolvedSource(c.source) === fixtureSource;
    assert.deepEqual(independentWork.checkpoint.pending.filter(finishedByIndependentWriter).map(c => c.text).sort(),
      [INDEPENDENT, 'Nota concorrente da extensão'].sort(), 'only the two fixture-authored notes finish here');
    const preservedPending = independentWork.checkpoint.pending.filter(c => !finishedByIndependentWriter(c)).map(c => ({ text: c.text, source: c.source, resolved: c.resolved }));
    assert.equal(originalSave({ project: F.owner, ...F.prof, id: T, intent: 'checkpoint', checkpoint: {
      pending: preservedPending } }).status, 'ok', 'the independent writer finishes only its own two captures');
    assert.deepEqual(workOf(F).checkpoint.pending.map(c => ({ text: c.text, source: c.source, resolved: c.resolved })), preservedPending,
      'every nonmatching pending capture is preserved');
    const nowY = nowX + 4000000;
    const liveAtClose = horizon.readTaskClock({ cwd: F.owner, task: T, now: nowY });
    assert.equal(liveAtClose.consumption.consumed_ms, C + 4300000);
    let closedInCallback = null, afterClose = null;
    const closingAdapter = adapterOf(() => {
      closedInCallback = lts.closeLinkedTask({ cwd: F.owner, taskId: T, codeDir: F.code, now: nowY, ...F.prof });
      afterClose = snap(F);
      return [];
    });
    const lateCheckpoint = horizon.checkpointTaskIfDrained({ cwd: F.owner, task: T, now: nowY, liveAdapter: closingAdapter, ...F.prof });
    assert.equal(closedInCallback.status, 'closed', JSON.stringify(closedInCallback));
    assert.deepEqual([lateCheckpoint.status, lateCheckpoint.reason], ['refused', 'linked-task-closed'], JSON.stringify(lateCheckpoint));
    unchanged(F, afterClose, 'outer checkpoint after the legitimate closure');
    assert.ok(fs.readFileSync(file(F.owner, cpRef)).equals(cpBytes), 'the earlier checkpoint is retained');
    assert.ok(!fs.existsSync(file(F.owner, `.gsd/forge/time/${M}/linked-task/checkpoints/4.json`)));
    const frozenA = horizon.readTaskClock({ cwd: F.owner, task: T, now: nowY }), frozenB = horizon.readTaskClock({ cwd: F.owner, task: T, now: nowY + 7200000 });
    assert.deepEqual([frozenA.frozen, frozenA.horizon.ended_at, frozenA.consumption], [true, iso(nowY), frozenB.consumption], 'the closed clock is frozen');
    assert.equal(frozenA.consumption.consumed_ms, C + 4300000);
    // R45: the verified clock is retained in the immutable closure; unrelated later growth of the global question
    // census (65 foreign states) never reclassifies a confirmed wait of the CLOSED horizon, which stays frozen.
    {
      const closureRef = recordRef('closure'), closureBytes = fs.readFileSync(file(F.owner, closureRef)), closed = JSON.parse(closureBytes.toString('utf8'));
      assert.deepEqual(Object.keys(closed).slice(-2), ['fingerprint', 'clock'], 'the retained clock is the last closure key');
      assert.deepEqual([closed.clock.consumption.consumed_ms, closed.clock.consumption.unknown_ms], [frozenA.consumption.consumed_ms, frozenA.consumption.unknown_ms]);
      assert.deepEqual([closed.clock.consumption, closed.clock.waits, closed.clock.unknowns], [liveAtClose.consumption, liveAtClose.waits, liveAtClose.unknowns], 'the retained clock IS the live clock verified at the closure instant');
      assert.ok(closed.clock.consumption.by_class['human-wait'] > 0, 'the closed horizon contains a confirmed non-consuming wait');
      const handoffSchema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared', 'schemas', 'forge-linked-task-handoff.schema.json'), 'utf8')).$defs.closure;
      assert.deepEqual(handoffSchema.required, lts.HANDOFF_RECORD_FIELDS.closure, 'the retained clock is an optional last key');
      assert.deepEqual(handoffSchema.properties.clock.required, lts.HANDOFF_RECORD_FIELDS.closure_clock);
      const flood = foreignQuestions(F, 65);
      try {
        const grown = horizon.readTaskClock({ cwd: F.owner, task: T, now: nowY + 7200000 });
        assert.equal(grown.status, 'measured', JSON.stringify(grown));
        assert.deepEqual([grown.frozen, grown.consumption, grown.waits, grown.unknowns], [true, liveAtClose.consumption, liveAtClose.waits, liveAtClose.unknowns], 'census growth never reclassifies the closed horizon');
        assert.ok(!grown.unknowns.includes('question-census-unknown'));
      } finally { flood(); }
      // A retained clock edited in canonical form (any inconsistency with the horizon partition) fails closed.
      for (const edit of [c => { c.consumption.consumed_ms += 1000; }, c => { c.consumption.by_class['human-wait'] += 1000; }, c => { c.policy.version = 2; }]) {
        const forged = JSON.parse(closureBytes.toString('utf8')); edit(forged.clock);
        fs.writeFileSync(file(F.owner, closureRef), JSON.stringify(forged) + '\n');
        try { assert.equal(horizon.readTaskClock({ cwd: F.owner, task: T, now: nowY + 1000 }).status, 'invalid', 'inconsistent retained clock'); }
        finally { fs.writeFileSync(file(F.owner, closureRef), closureBytes); }
      }
      assert.equal(horizon.readTaskClock({ cwd: F.owner, task: T, now: nowY + 1000 }).status, 'measured');
      process.stdout.write('ok - integrated-R45-frozen-clock-census-independence\n');
    }
    before = snap(F);
    const frozenJournal = horizon.appendTaskJournal({ cwd: F.owner, task: T, record: { type: 'presence', session_sha256: null, boundary: 'status', at: iso(nowY - 1000) } });
    assert.deepEqual([frozenJournal.status, frozenJournal.reason], ['refused', 'linked-task-closed'], 'the journal is frozen');
    unchanged(F, before, 'closed journal');
    refusedAs(F, unit, nowY, 'linked-task-closed');
    refusedExtension('closed task', 'linked-task-closed', () => horizon.prepareTaskExtension({ cwd: F.owner, task: T, ceilingMs: E3 + 1, now: nowY }));
    assert.equal(lts.closeLinkedTask({ cwd: F.owner, taskId: T, codeDir: F.code, now: nowY, ...F.prof }).status, 'unchanged', 'historical closure replay stays available');
    const closedStatus = horizon.readLinkedStatus({ cwd: F.owner, task: T, now: nowY + 1000, ...F.prof });
    assert.deepEqual([closedStatus.task_horizon.state, closedStatus.task_horizon.frozen, closedStatus.chain.completed], ['completed', true, true], 'chain completion needs endpoint and task closure');
    assert.equal(guard.seen.nested, 0);
    guard.restore();
    line('real task clock preserves overlaps waits unknown effort restart and frozen closure');
    line('exact lifecycle and current task ceiling govern admission with zero provider calls');

    // =======================================================================
    // Truth 6: schema validators and protected owner boundaries govern every task record.
    // =======================================================================
    const schema = JSON.parse(fs.readFileSync(SCHEMA, 'utf8')), F6 = horizon.HORIZON_RECORD_FIELDS;
    assert.equal(schema.$id, 'urn:forge:linked-task-horizon:v1');
    for (const [def, fields] of [['journal_presence', F6.presence], ['journal_wait', F6.wait], ['checkpoint', F6.checkpoint], ['extension', F6.extension],
      ['decision', F6.decision], ['drain', F6.drain], ['writer', F6.writer], ['pending_decision', F6.pending_decision]]) {
      assert.deepEqual(schema.$defs[def].required, [...fields], def + ' required fields match the validator');
      assert.deepEqual(Object.keys(schema.$defs[def].properties), [...fields], def + ' properties match');
      assert.equal(schema.$defs[def].additionalProperties, false);
    }
    assert.deepEqual(schema['x-transport-codes'], [...horizon.LINKED_TASK_TRANSPORT_CODES]);
    assert.deepEqual(schema['x-task-states'], [...horizon.TASK_STATES]);
    assert.deepEqual(schema['x-drain-states'], [...horizon.TASK_DRAIN_STATES]);
    assert.deepEqual(schema['x-writer-classes'], [...horizon.TASK_WRITER_CLASSES]);
    assert.deepEqual(schema.$defs.journal_presence.properties.boundary.enum, ['session-start', 'next', 'complete', 'status', 'session-end']);
    assert.deepEqual(schema.$defs.journal_wait.properties.class.enum, [...time.WAIT_CLASSES]);
    assert.deepEqual(schema.$defs.journal_wait.properties.type.enum, time.JOURNAL_TYPES.filter(t => t !== 'presence'));
    assert.deepEqual(schema.$defs.pending_decision.properties.alternatives.const, cp.pending_decision.alternatives);
    assert.deepEqual(Object.keys(cp), [...F6.checkpoint], 'the real checkpoint has the exact key order');
    assert.deepEqual(Object.keys(r1), [...F6.extension], 'the real extension has the exact key order');
    for (const row of fs.readFileSync(file(F.owner, journalRef), 'utf8').trim().split('\n').map(l => JSON.parse(l))) {
      assert.deepEqual(Object.keys(row), [...(row.type === 'presence' ? F6.presence : F6.wait)]);
    }
    // Total timestamps: calendar/date-range invalid input is a named refusal, valid leap days pass.
    for (const value of ['2026-02-30T00:00:00.000Z', '2027-02-29T00:00:00.000Z', '2026-13-01T00:00:00.000Z', '2026-01-01T24:00:00.000Z']) {
      assert.equal(horizon.validateExtensionRecord({ ...r1, extended_at: value }), false, value);
      assert.equal(horizon.validateCheckpointRecord({ ...cp, at: value }), false, value);
    }
    assert.equal(horizon.validateExtensionRecord({ ...r1, extended_at: '2028-02-29T00:00:00.000Z' }), true, 'leap day');
    assert.equal(horizon.readTaskClock({ cwd: F.owner, task: T, now: 8.64e15 + 1 }).reason, 'linked-task-time-invalid', 'date-range-invalid now');
    const r1Ref = `.gsd/forge/time/${M}/linked-task/extensions/0001.json`, r1Bytes = fs.readFileSync(file(F.owner, r1Ref));
    write(F.owner, r1Ref, { ...r1, extended_at: '2026-02-30T00:00:00.000Z' });
    before = snap(F);
    assert.equal(horizon.readTaskClock({ cwd: F.owner, task: T, now: nowY }).reason, 'linked-task-time-invalid');
    assert.equal(horizon.readLinkedStatus({ cwd: F.owner, task: T, now: nowY, ...F.prof }).reason, 'linked-task-time-invalid');
    unchanged(F, before, 'calendar-invalid record at the public boundary');
    fs.writeFileSync(file(F.owner, r1Ref), r1Bytes);
    // Canonical typed IDs: the real T01 probe and forge-ids are the oracle, never a copied regex.
    const candidates = ['T-20261105120000-plain', 'T-20261105-120000-Mixed-Slug', 'task-001', 'TASK-20261105-120000-x', 'T-20261105120000-' + 'x'.repeat(130),
      'M001', 'T-20261105120000/../x', 'C:\\temp\\T-1', '`T-20261105120000`', 'T-20261105120000\u0007', 'token=abc'];
    for (const id of candidates) {
      const oracle = linked.linkedTaskFor(F.owner, id) === null ? 'unlinked' : 'linked-task-time-invalid';
      const got = horizon.decideLinkedTaskEntry({ cwd: F.owner, taskId: id, unit: 'execute-task/' + id, now: nowY });
      assert.equal(got.allowed ? got.decision : got.reason_code, oracle, 'typed ID ' + JSON.stringify(id));
      const typed = typeof id === 'string' && !/[\\/\0]/.test(id) && ids.isValid(id) && ids.entityKind(id) === 'task';
      assert.equal(horizon.validateExtensionRecord({ ...r1, task_id: id }), typed && time.isPublicData(id), 'record task ID ' + JSON.stringify(id));
    }
    assert.ok(candidates.some(id => linked.linkedTaskFor(F.owner, id) === null) && candidates.some(id => linked.linkedTaskFor(F.owner, id) !== null), 'positive and negative controls');
    line('schema validators and protected owner boundaries govern every task record');

    // =======================================================================
    // Truth 7 (fresh-process CLI): owner actions, public projection and named refusals.
    // =======================================================================
    before = snap(F);
    const cStatus = cli(F, ['--status', '--cwd', F.owner, '--task', T, '--json']);
    assert.deepEqual([cStatus.status, cStatus.json.task_horizon.state, cStatus.json.chain.governs], [0, 'completed', false]);
    noAbsolute(F, cStatus.json, 'CLI status');
    const cAdmit = cli(F, ['--admit', '--cwd', F.owner, '--task', T, '--unit', unit, '--json']);
    assert.deepEqual([cAdmit.status, cAdmit.json.allowed, cAdmit.json.reason_code], [3, false, 'linked-task-closed']);
    const cUnlinked = cli(F, ['--admit', '--cwd', F.owner, '--task', 'T-20261105120000-plain', '--unit', 'execute-task/T-20261105120000-plain', '--json']);
    assert.deepEqual([cUnlinked.status, cUnlinked.json], [0, { allowed: true, decision: 'unlinked' }]);
    const cNull = cli(F, ['--status', '--cwd', F.owner, '--task', 'T-20261105120000-plain', '--json']);
    assert.deepEqual([cNull.status, cNull.stdout.trim()], [0, 'null']);
    for (const unsafe of [path.join(F.owner, 'segredo'), 'token=abc123', 'C:\\Users\\x\\task']) {
      const r = cli(F, ['--admit', '--cwd', F.owner, '--task', unsafe, '--unit', 'execute-task/x', '--json']);
      assert.equal(r.status, 3);
      assert.ok(!r.stdout.includes(unsafe) && !r.stdout.includes('abc123') && !r.stdout.toLowerCase().includes(F.owner.toLowerCase()), 'unsafe argument is never reflected');
      assert.equal(r.json.reason_code ?? r.json.reason, 'linked-task-time-invalid');
    }
    const cDrain = cli(F, ['--checkpoint', '--cwd', F.owner, '--task', T, '--json']);
    assert.deepEqual([cDrain.status, cDrain.json.reason], [3, 'linked-task-closed']);
    const cUsage = cli(F, ['--extend', '--cwd', F.owner, '--task', T, '--json']);
    assert.equal(cUsage.status, 2);
    const cHuman = cli(F, ['--status', '--cwd', F.owner, '--task', T]);
    assert.ok(cHuman.status === 0 && /horizonte completed/.test(cHuman.stdout), 'pt-BR human output');
    const cInspect = cli(F, ['--inspect-drain', '--cwd', F.owner, '--task', T, '--json']);
    assert.deepEqual([cInspect.status, cInspect.json.state, cInspect.json.reason], [0, 'not-applicable', 'linked-task-closed']);
    unchanged(F, before, 'fresh-process CLI reads and refusals');
    // Owner journal actions through the CLI: frozen after closure, refused after the chain closure, zero writes.
    const dBefore = snap(D);
    const cPresence = cli(D, ['--presence', 'session-start', '--cwd', D.owner, '--task', D.task, '--session', 'sessao-cli', '--json']);
    assert.deepEqual([cPresence.status, cPresence.json.reason], [3, 'linked-task-chain-closed']);
    const cWait = cli(D, ['--wait-start', 'w-cli', '--class', 'pause', '--source-kind', 'operator', '--source-ref', 'pausa', '--cwd', D.owner, '--task', D.task, '--json']);
    assert.deepEqual([cWait.status, cWait.json.reason], [3, 'linked-task-chain-closed']);
    unchanged(D, dBefore, 'CLI journal on a closed chain');
    const cWaitEnd = cli(F, ['--wait-end', 'w-cli', '--class', 'pause', '--source-kind', 'operator', '--source-ref', 'pausa', '--cwd', F.owner, '--task', T, '--json']);
    assert.deepEqual([cWaitEnd.status, cWaitEnd.json.reason], [3, 'linked-task-closed']);
    unchanged(F, before, 'CLI journal on a closed task');
    const freshAdmission = child({ mode: 'admit', cwd: F.owner, task: T, unit, now: nowY, home: F.home });
    assert.deepEqual([freshAdmission.allowed, freshAdmission.reason_code], [false, 'linked-task-closed']);
    passed = true;
  } finally {
    process.env.HOME = saved.HOME; process.env.USERPROFILE = saved.USERPROFILE;
    if (saved.HOME === undefined) delete process.env.HOME;
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE;
    for (const c of children.splice(0)) { try { c.kill(); } catch { /* already gone */ } }
    for (const dir of roots.splice(0).reverse()) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  if (passed) {
    assert.ok(roots.length === 0 && children.length === 0);
    const left = fs.readdirSync(os.tmpdir()).filter(n => /^forge-lth-/.test(n) && fs.existsSync(path.join(os.tmpdir(), n)));
    assert.deepEqual(left.filter(n => createdNames.has(n)), [], 'every temporary root was removed');
    assert.equal(fs.existsSync(realStore) ? sha(fs.readFileSync(realStore)) : null, realBefore, 'the real personal profile is untouched');
    assert.equal(realView(), realGsdBefore, 'the real runs and tasks are untouched');
    line('real temporary profiles lifecycle Git questions and fresh process CLI fixtures clean up');
  }
}

if (process.argv[2] === '--child') childMain();
else {
  const started = Date.now();
  suite().then(() => console.log('PASS forge-linked-task-horizon suite (' + Math.round((Date.now() - started) / 1000) + ' s)'))
    .catch(e => { console.error(e); process.exitCode = 1; });
}
