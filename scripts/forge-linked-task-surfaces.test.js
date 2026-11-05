#!/usr/bin/env node
'use strict';

// S03/T05 linked surfaces: forge-status (personal, inspection and workspace models and
// renderTree), the bounded personal summary and orchestrate status project the closed linked
// horizon of every lifecycle state of a real chain (blocked, handoff-ready, open, started, at the
// cap, draining with a writer, checkpointed, extended, closed and chain-closed), read purely
// (bytes and mtime unchanged) and add nothing for unlinked work. The chains are built by the public
// T01/T02/T03/T04 APIs in temporary roots and profiles (fixtures shared with the transport suite);
// one owner clock is injected at each read boundary (Date.now for the clock-free surface APIs) and
// restored. The explicit chain (open, chain-closed) runs in a concurrent fresh process.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const fx = require('./forge-linked-task-transport.test.js');

const M = fx.M;
const SELF = __filename;
const SUMMARY_KEYS = ['lifecycle', 'state', 'ceiling_ms', 'consumed_ms', 'remaining_ms', 'chain', 'decision_pending'];
const LINKED_KEYS = ['task_id', 'milestone_id', 'lifecycle', 'task', 'milestone', 'chain', 'decision_pending', 'unknown'];
// Every row compares the personal model and render, the summary and orchestrate status; the
// inspection, workspace and milestone-time views are compared on the rows named here.
const FULL_ROWS = new Set(['handoff-ready', 'checkpointed', 'open']);

function line(text) { process.stdout.write('ok - T05 linked surfaces: ' + text + '\n'); }
// The owner clock of one read boundary: the surface APIs read Date.now, restored in finally.
function at(ms, fn) {
  const original = Date.now;
  Date.now = () => ms;
  try { return fn(); } finally { Date.now = original; }
}
function withHome(home, fn) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
// Purity evidence over the whole temporary fixture root: the owner (including .gsd and its
// checked-out sources), the CODE_DIR worktree, the personal profile and the results directory,
// bytes plus size plus mtime of every file. Explicit exclusions (limits): Git metadata ('.git',
// which git itself may refresh) and lock directories ('.locks'); nothing outside the fixture root
// is claimed (no OS-wide purity).
function rootTree(dir) {
  const out = {};
  (function visit(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git' || entry.name === '.locks') continue;
      const target = path.join(d, entry.name), relative = path.relative(dir, target);
      if (entry.isDirectory()) { out[relative] = 'directory'; visit(target); }
      else { const stat = fs.lstatSync(target); out[relative] = [fx.sha(fs.readFileSync(target)), stat.size, stat.mtimeMs]; }
    }
  })(dir);
  return out;
}
function snap(f) {
  const view = rootTree(f.root);
  for (const required of ['owner', 'code', 'home']) assert.equal(view[required], 'directory', 'purity covers the ' + required + ' root');
  return view;
}
// A genuine task PLAN (owner terminal source of the personal snapshot): current reliability.
function plan(id) {
  return `---\nid: ${id}\ndepends: []\nwrites:\n  - scripts/result.js\nmust_haves:\n  truths:\n    - comportamento observável da task\n  artifacts: []\n  key_links: []\n`
    + `expected_output:\n  - scripts/result.js\nverify:\n  - node scripts/check.js\n---\n# ${id}\n`;
}
// The immutable legacy summary entry of an unlinked, open, current, active task with one short
// next action and nothing pending: written from the pre-S03 summary contract (compose), never
// produced by the code under test. Capture sources are canonical personal-context paths, which
// that contract case-folds on win32 only.
function legacySummaryEntry(id, text) {
  const source = `.gsd/tasks/${id}/${id}-BRIEF.md`;
  return { id, kind: 'task', workStatus: 'open', reliability: 'current', activity: 'active',
    nextAction: { text, source: process.platform === 'win32' ? source.toLowerCase() : source, validity: 'current' }, lastResult: null,
    pending: { total: 0, items: [] }, acceptances: { total: 0, items: [] } };
}
function noAbsolute(f, value, label) {
  const text = JSON.stringify(value).toLowerCase();
  for (const p of [f.owner, f.code, f.home, f.root, os.tmpdir()]) {
    for (const form of [p, p.replace(/\\/g, '/'), p.replace(/\\/g, '\\\\')]) assert.ok(!text.includes(form.toLowerCase()), label + ': no absolute path');
  }
}

// Every surface for one state, compared to the current public T04 projection at the same clock.
function surfaces(f, ms, label) {
  const status = require('./forge-status'), summary = require('./forge-personal-summary'), orchestrate = require('./forge-orchestrate');
  const horizon = require('./forge-linked-task-horizon');
  const full = FULL_ROWS.has(label);
  const before = snap(f);
  const out = at(ms, () => withHome(f.home, () => {
    const expected = horizon.summarizeLinkedStatus(horizon.readLinkedStatus({ cwd: f.owner, task: f.task, now: ms, ...f.prof }));
    const personal = status.collect(f.owner, { ...f.prof });
    const inspection = full ? status.collect(f.owner, { id: f.task, ...f.prof }) : null;
    const workspace = full ? status.collect(f.owner, { scope: 'workspace', ...f.prof }) : null;
    const milestoneInspection = full ? status.collect(f.owner, { id: M, ...f.prof }) : null;
    const rendered = summary.renderPersonalSummary({ project: f.owner, ...f.prof });
    const orch = orchestrate.status({ cwd: f.owner });
    return { expected, personal, inspection, workspace, milestoneInspection, brief: JSON.parse(rendered.json), rendered, orch,
      tree: status.renderTree(personal), treeWorkspace: full ? status.renderTree(workspace) : null, treeMilestone: full ? status.renderTree(milestoneInspection) : null };
  }));
  assert.deepEqual(snap(f), before, label + ': surfaces are pure reads (bytes and mtime)');
  const { expected } = out;
  assert.ok(expected && expected.task_id === f.task, label + ': linked projection');
  assert.deepEqual(Object.keys(expected), LINKED_KEYS);
  const work = out.personal.works.find(w => w.id === f.task);
  assert.ok(work, label + ': personal work present');
  assert.deepEqual(work.linked, expected, label + ': personal model consumes the closed projection');
  const orchWork = (out.orch.details.works || []).find(w => w.id === f.task);
  assert.deepEqual(orchWork && orchWork.linked, expected, label + ': orchestrate status');
  // Render: separate horizons, the governing ceiling of each operation, state, decision and unknowns.
  assert.ok(out.tree.includes('Horizonte da task ligada:'), label + ': render block');
  assert.ok(out.tree.includes('governa as operações da task'), label);
  if (expected.milestone) assert.ok(out.tree.includes('governa as operações da milestone'), label);
  if (expected.chain) assert.ok(out.tree.includes('soma, não governa nenhuma operação'), label);
  assert.ok(out.tree.includes('Decisão pendente: ' + (expected.decision_pending ? 'sim' : 'não')), label);
  if (expected.unknown) assert.ok(out.tree.includes('Desconhecido:'), label);
  if (full) {
    assert.deepEqual(out.inspection.works.find(w => w.id === f.task).linked, expected, label + ': inspection');
    const auto = out.workspace.autonomous_tasks.find(t => t.id === f.task);
    assert.ok(auto, label + ': workspace lists the linked task');
    assert.deepEqual(auto.linked, expected, label + ': workspace');
    assert.ok(out.treeWorkspace.includes('governa as operações da task'), label + ': workspace render');
    // Milestone time block: task and chain keys from the same projection; derived chain governs nothing.
    const mwork = out.milestoneInspection.works.find(w => w.id === M);
    assert.ok(mwork && mwork.time, label + ': milestone time block');
    assert.equal(mwork.time.task.task_id, f.task);
    assert.equal(mwork.time.task.governs, 'task-operations');
    assert.equal(mwork.time.task.state, expected.task ? expected.task.state : 'unknown');
    assert.deepEqual([mwork.time.chain.governs, mwork.time.chain.cap_basis], [false, 'derived-sum']);
    assert.ok(out.treeMilestone.includes('Teto da milestone governa as operações da milestone'), label);
  }
  // Personal summary: the closed block within the byte limit, no raw field or absolute path.
  const listed = out.brief.works.find(w => w.id === f.task);
  assert.ok(Buffer.byteLength(out.rendered.json + '\n', 'utf8') <= 4096, label + ': summary within 4096 bytes');
  if (listed) {
    assert.deepEqual(Object.keys(listed.linked), SUMMARY_KEYS, label + ': closed summary block');
    assert.deepEqual(listed.linked, { lifecycle: expected.lifecycle, state: expected.task ? expected.task.state : 'unknown', ceiling_ms: expected.task ? expected.task.ceiling_ms : null,
      consumed_ms: expected.task ? expected.task.consumed_ms : null, remaining_ms: expected.task ? expected.task.remaining_ms : null,
      chain: { consumed_ms: expected.chain ? expected.chain.consumed_ms : null, forecast_low_ms: expected.chain ? expected.chain.forecast_low_ms : null,
        forecast_high_ms: expected.chain ? expected.chain.forecast_high_ms : null }, decision_pending: expected.decision_pending }, label + ': summary block');
  }
  noAbsolute(f, out.brief, label + ' summary'); noAbsolute(f, work.linked, label + ' linked');
  return out;
}

// The explicit chain (create without auto-start): open after the genuine endpoint and handoff,
// then chain-closed by the persisted explicit answer and a live handle. Runs in a fresh process.
function explicitChain() {
  const lts = require('./forge-linked-task-start');
  const home = fx.tempRoot('forge-ltt-surfaces-e-home-');
  process.env.HOME = home; process.env.USERPROFILE = home;
  const rows = [];
  try {
    const E = fx.chainFixture({ explicit: true });
    E.endpoint();
    assert.equal(lts.produceHandoff({ cwd: E.owner, milestone: M, ...E.prof }).status, 'produced');
    const open = surfaces(E, Date.now(), 'open');
    assert.equal(open.expected.lifecycle, 'open');
    rows.push('open/' + open.expected.task.state);
    assert.equal(lts.prepareLinkedDecision({ cwd: E.owner, task: E.task, action: 'close-chain' }).status, 'open');
    assert.equal(lts.answerLinkedDecision({ cwd: E.owner, task: E.task, action: 'close-chain', response: 'linked-task:close-chain', source: 'user-text' }).status, 'answered');
    assert.equal(lts.closeChain({ cwd: E.owner, taskId: E.task, liveAdapter: fx.liveAdapter(E.owner), ...E.prof }).status, 'chain-closed');
    const closed = surfaces(E, Date.now(), 'chain-closed');
    assert.equal(closed.expected.lifecycle, 'chain-closed');
    assert.equal(closed.expected.chain.completed, false, 'chain completion is never inferred from the milestone');
    rows.push('chain-closed/' + closed.expected.task.state);
  } finally { fx.cleanup(); }
  assert.deepEqual(fx.leftovers('forge-ltt-'), []);
  return rows;
}

function childMain() {
  if (process.argv[3] === 'explicit') {
    const rows = explicitChain();
    process.stdout.write(JSON.stringify({ rows }) + '\n');
    return;
  }
  const a = JSON.parse(Buffer.from(process.argv[3], 'base64').toString('utf8'));
  Date.now = () => a.now;
  const status = require('./forge-status'), summary = require('./forge-personal-summary');
  const prof = { userHome: a.home, env: { HOME: a.home, USERPROFILE: a.home } };
  const model = status.collect(a.owner, prof);
  const brief = summary.buildPersonalSummary({ project: a.owner, ...prof });
  process.stdout.write(JSON.stringify({ linked: model.works.find(w => w.id === a.task).linked, summary: brief.works.find(w => w.id === a.task)?.linked ?? null }) + '\n');
}

async function suite() {
  // The explicit chain runs concurrently in a fresh process.
  const explicit = new Promise(resolve => {
    const proc = spawn(process.execPath, [SELF, '--child', 'explicit'], { env: { ...process.env } });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d; }); proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => resolve({ code, stdout, stderr }));
  });
  const horizon = require('./forge-linked-task-horizon'), lts = require('./forge-linked-task-start'), linked = require('./forge-linked-task');
  const runs = require('./forge-runs'), personal = require('./forge-personal-context'), writeClaim = require('./forge-write-claim');
  const recovery = require('./forge-attempt-recovery'), codeRoots = require('./forge-code-roots'), digest = codeRoots.digest;
  const status = require('./forge-status'), summary = require('./forge-personal-summary');
  const prep = require('./forge-task-preparation'), sidecar = require('./forge-unit-sidecar');
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const suiteHome = fx.tempRoot('forge-ltt-surfaces-home-');
  process.env.HOME = suiteHome; process.env.USERPROFILE = suiteHome;
  let passed = false;
  const seenStates = new Set(), protectedSeen = new Set();
  try {
    const F = fx.chainFixture();
    const T = F.task, prof = F.prof;
    // The linked candidate has a genuine PLAN from the start (current reliability): its protection
    // can only come from its linked state, never from a missing or stale source.
    fx.write(F.owner, `.gsd/tasks/${T}/${T}-PLAN.md`, plan(T));
    // Unlinked controls in the same owner and profile: genuine PLAN (current reliability), an
    // active run, one short Unicode next action and nothing pending or accepted, so none of them is
    // protected. Their IDs sort before the linked task: six of them compete with it for the five
    // summary slots, so an unprotected linked work is dropped while a protected one ranks first.
    const controls = [], controlText = {};
    for (let i = 0; i < 6; i++) {
      const id = 'T-20200101000000-controle-' + i, brief = `.gsd/tasks/${id}/${id}-BRIEF.md`;
      assert.ok(id < T, 'control IDs sort before the linked task');
      fx.write(F.owner, brief, `---\nid: ${id}\ndescription: Controle ${i}\n---\n\n# Controle sem vínculo ${i}\n`);
      fx.write(F.owner, `.gsd/tasks/${id}/${id}-PLAN.md`, plan(id));
      runs.add(F.owner, { id, kind: 'task', session_id: 'controle-' + i, active: true, started_at: Date.now(), last_heartbeat: Date.now(), cwd: F.owner, project: F.owner, task_description: 'Controle ' + i });
      assert.equal(personal.bindWork({ project: F.owner, ...prof, id, kind: 'task', intent: 'create' }).status, 'ok');
      controlText[id] = 'Revisar relatório «ação» ' + i + ' ✓';
      assert.equal(personal.saveCheckpoint({ project: F.owner, ...prof, id, intent: 'checkpoint', checkpoint: { nextAction: [{ text: controlText[id], source: fx.file(F.owner, brief), resolved: false }] } }).status, 'ok');
      controls.push(id);
    }
    // Byte baselines of every unlinked control (status model and orchestrate works) before any
    // linked operation; each state below must reproduce exactly these bytes (value and order).
    const controlBytes = model => JSON.stringify((model.works || []).filter(w => controls.includes(w.id)));
    const baseline = at(Date.now(), () => withHome(F.home, () => ({ status: status.collect(F.owner, { ...prof }), orch: require('./forge-orchestrate').status({ cwd: F.owner }) })));
    const controlBefore = baseline.status.works.filter(w => controls.includes(w.id));
    const controlStatusBytes = controlBytes(baseline.status), controlOrchBytes = controlBytes(baseline.orch.details || {});
    assert.equal(controlBefore.length, controls.length);
    for (const w of controlBefore) {
      assert.ok(!Object.hasOwn(w, 'linked') && !Object.hasOwn(w, 'time'), 'unlinked control has no linked or time key');
      assert.deepEqual([w.reliability, w.workStatus], ['current', 'open'], w.id + ': genuine current, open control');
    }
    const check = (f, ms, label, expect) => {
      const out = surfaces(f, ms, label);
      const e = out.expected;
      assert.equal(e.lifecycle, expect.lifecycle, label + ' lifecycle');
      if (expect.state) assert.equal(e.task.state, expect.state, label + ' state');
      seenStates.add(e.lifecycle + '/' + (e.task ? e.task.state : '-'));
      const listed = out.brief.works.find(w => w.id === f.task);
      const linkedWork = out.personal.works.find(w => w.id === f.task);
      if (expect.protected) {
        // Six unprotected current controls compete for five slots: the protected linked work is
        // never dropped and ranks first, while its reliability stays current and nothing unrelated
        // (acceptances, foreign pending captures) protects it.
        assert.ok(listed, label + ': protected linked work is never dropped');
        assert.equal(out.brief.works[0].id, f.task, label + ': protected work ranks first');
        assert.equal(listed.reliability, 'current', label + ': no reliability protection');
        assert.equal(listed.acceptances.total, 0, label + ': no acceptance protection');
        // (The capture source is the canonical path, case-folded on case-insensitive filesystems.)
        const linkRecord = `.gsd/forge/time/${M}/linked-task/`.toLowerCase();
        assert.ok(listed.pending.items.every(item => typeof item.source === 'string' && item.source.toLowerCase().startsWith(linkRecord)),
          label + ': any pending capture is the linked chain\'s own record ' + JSON.stringify(listed.pending));
        protectedSeen.add(label);
      }
      if (expect.unprotected) {
        // The genuinely unprotected equivalent (same work, PLAN, reliability and controls; only the
        // linked state differs) is dropped: the five slots go to the controls, in ID order.
        assert.ok(!listed, label + ': an unprotected linked work competes normally and is dropped');
        assert.deepEqual([linkedWork.reliability, linkedWork.workStatus], ['current', 'open'], label + ': same reliability and status as the controls');
        const listedControls = out.brief.works.map(w => w.id).filter(id => controls.includes(id));
        assert.equal(out.brief.works.length, 5, label + ': all five slots are used');
        assert.deepEqual(listedControls, controls.slice(0, listedControls.length), label + ': controls fill the slots in ID order');
        assert.ok(out.brief.works.every(w => controls.includes(w.id) || w.id === M), label + ': only controls (and the milestone) are listed');
        assert.equal(out.brief.attention, null, label + ': nothing protected was hidden');
      }
      // Unlinked controls: exactly the baseline bytes in the status model and orchestrate status,
      // and the immutable legacy summary entry (bytes) whenever listed.
      assert.equal(controlBytes(out.personal), controlStatusBytes, label + ': unlinked controls keep their exact status bytes');
      assert.equal(controlBytes(out.orch.details || {}), controlOrchBytes, label + ': unlinked controls keep their exact orchestrate bytes');
      for (const id of controls) {
        const s = out.brief.works.find(x => x.id === id);
        if (s) assert.equal(JSON.stringify(s), JSON.stringify(legacySummaryEntry(id, controlText[id])), id + ': legacy summary bytes');
      }
      return out;
    };

    // blocked (before the endpoint): protected, predecessor not proven. Directed unknowns: a task
    // that never started has NO consumption (null, rendered as unknown), never a zero.
    const blocked = check(F, Date.now(), 'blocked', { lifecycle: 'blocked', state: 'not-started', protected: true });
    assert.deepEqual([blocked.expected.task.consumed_ms, blocked.expected.task.remaining_ms, blocked.expected.chain.consumed_ms], [null, null, null], 'unknown is null');
    const blockedListed = blocked.brief.works.find(w => w.id === T).linked;
    assert.ok(blockedListed.consumed_ms === null && blockedListed.consumed_ms !== 0 && blockedListed.chain.consumed_ms === null, 'summary keeps null distinct from zero');
    assert.ok(blocked.tree.includes('consumido desconhecido'), 'render shows the unknown consumption as unknown');
    assert.equal(blocked.expected.decision_pending, false);
    assert.ok(blocked.tree.includes('Decisão pendente: não'));
    // handoff-ready (chained) after the genuine endpoint and handoff.
    F.endpoint();
    assert.equal(lts.produceHandoff({ cwd: F.owner, milestone: M, ...prof }).status, 'produced');
    const ready = check(F, Date.now(), 'handoff-ready', { lifecycle: 'handoff-ready', state: 'not-started' });
    assert.equal(ready.expected.milestone.endpoint_proven, true);
    assert.equal(ready.expected.milestone.frozen, true);
    const mtime = ready.milestoneInspection.works.find(w => w.id === M).time;
    assert.equal(mtime.state, 'endpoint-proven');
    assert.equal(mtime.endpoint.proven, true);
    assert.ok(ready.treeMilestone.includes('Marco final comprovado em'), 'frozen endpoint rendered');
    // started (active) inside the horizon.
    assert.equal(fx.startTask(F).status, 'started');
    const S = Date.parse(JSON.parse(fs.readFileSync(fx.file(F.owner, `.gsd/forge/time/${M}/linked-task/start.json`), 'utf8')).started_at);
    const C = linked.linkedTaskFor(F.owner, T).link.linked_task.horizon.ceiling_ms;
    const active = check(F, S + 60000, 'started', { lifecycle: 'started', state: 'active', unprotected: true });
    assert.ok(active.tree.includes('estado da task: ativa'));
    assert.ok(Number.isSafeInteger(active.expected.task.consumed_ms) && Number.isSafeInteger(active.expected.chain.consumed_ms), 'a started task has a measured consumption');
    assert.equal(active.expected.decision_pending, false);
    // Directed closed invalid projection: an unreadable start record (deliberately corrupt input,
    // restored byte for byte afterwards) yields the closed unknown projection on every surface and
    // keeps the task protected; it never becomes absent or a zero.
    {
      const startRef = `.gsd/forge/time/${M}/linked-task/start.json`, startFile = fx.file(F.owner, startRef);
      const startBytes = fs.readFileSync(startFile), startStat = fs.statSync(startFile);
      fs.writeFileSync(startFile, '{"corrompido":');
      try {
        const before = snap(F);
        const view = at(S + 60000, () => withHome(F.home, () => {
          const expectedInvalid = horizon.summarizeLinkedStatus(horizon.readLinkedStatus({ cwd: F.owner, task: T, now: S + 60000, ...prof }));
          const model = status.collect(F.owner, { ...prof });
          return { expectedInvalid, model, tree: status.renderTree(model), brief: summary.buildPersonalSummary({ project: F.owner, ...prof }),
            orch: require('./forge-orchestrate').status({ cwd: F.owner }) };
        }));
        assert.deepEqual(snap(F), before, 'invalid projection reads are pure');
        assert.deepEqual(view.expectedInvalid, { task_id: T, lifecycle: 'invalid', task: null, milestone: null, chain: null, decision_pending: false, unknown: true });
        assert.deepEqual(view.model.works.find(w => w.id === T).linked, view.expectedInvalid, 'status carries the closed invalid projection');
        assert.deepEqual((view.orch.details.works || []).find(w => w.id === T).linked, view.expectedInvalid, 'orchestrate carries the closed invalid projection');
        assert.ok(view.tree.includes('Ciclo: inválida; horizonte ilegível (desconhecido)'), 'render shows the unreadable horizon as unknown');
        const listedInvalid = view.brief.works.find(w => w.id === T);
        assert.ok(listedInvalid, 'an unreadable linked horizon is protected work');
        assert.equal(view.brief.works[0].id, T);
        assert.deepEqual(listedInvalid.linked, { lifecycle: 'invalid', state: 'unknown', ceiling_ms: null, consumed_ms: null, remaining_ms: null,
          chain: { consumed_ms: null, forecast_low_ms: null, forecast_high_ms: null }, decision_pending: false });
        assert.equal(controlBytes(view.model), controlStatusBytes, 'controls unchanged by an invalid linked horizon');
      } finally { fs.writeFileSync(startFile, startBytes); fs.utimesSync(startFile, startStat.atime, startStat.mtime); }
      assert.ok(fs.readFileSync(startFile).equals(startBytes));
    }
    // A real research attempt of the linked task, selected and bound below the cap through the
    // public preparation start; it is entered later, at the cap, to produce the genuine
    // pre-provider refusal receipt that the drain inspects.
    fx.prefs(F, 'gpt-5.6-sol');
    const drainRaw = fx.prepRequest(F, 'claude', 'research', 'drain-attempt');
    const drainSelected = await prep.startStandaloneTaskPreparation(drainRaw, { now: () => S + 60000 });
    assert.equal(drainSelected.action, 'invoke-sidecar', JSON.stringify(drainSelected).slice(0, 300));
    // exhausted at the cap (frozen milestone consumption, live task consumption).
    const nowX = S + C + 600000;
    const exhausted = check(F, nowX, 'exhausted', { lifecycle: 'started', state: 'exhausted', protected: true });
    assert.ok(exhausted.expected.task.remaining_ms < 0 && exhausted.tree.includes('esgotado (estouro de'));
    assert.equal(exhausted.expected.milestone.consumed_ms, ready.expected.milestone.consumed_ms, 'milestone consumption stays frozen');
    // draining: a held write claim of the task is an open writer.
    const unit = 'execute-task/' + T;
    const held = writeClaim.recordClaim(F.owner, T, { schema_version: 2, source: 'plan-writes', unit, execution_contract: codeRoots.singleContract(F.owner, F.code), paths: ['primary::scripts/result.js'] });
    check(F, nowX, 'draining', { lifecycle: 'started', state: 'draining', protected: true });
    // The genuine host protocol at the cap: the research attempt selected below the cap enters the
    // public sidecar now and the common owner guard refuses it before any transport, recording the
    // real failed receipt (provider_called false). Only external transports are replaced (and must
    // stay untouched); they are restored in finally.
    const xllm = require('./forge-xllm');
    const transports = { claude: xllm.invokeClaudeTransport, codex: xllm.invokeCodexAppServer };
    let transportCalls = 0, attemptSettled = false;
    xllm.invokeClaudeTransport = async () => { transportCalls++; throw Error('provider forbidden in the surfaces suite'); };
    xllm.invokeCodexAppServer = async () => { transportCalls++; throw Error('provider forbidden in the surfaces suite'); };
    try {
      await assert.rejects(sidecar.runUnitSidecar(drainSelected.delivery_request, { now: () => nowX }),
        error => ['linked-task-budget-draining', 'linked-task-budget-exhausted'].includes(error.code) && error.provider_called === false);
    } finally { xllm.invokeClaudeTransport = transports.claude; xllm.invokeCodexAppServer = transports.codex; attemptSettled = true; }
    assert.equal(transportCalls, 0, 'the refused attempt reached no transport');
    const drainReceiptFile = drainRaw.resultFile + '.receipt.json';
    const drainReceipt = JSON.parse(fs.readFileSync(drainReceiptFile, 'utf8'));
    assert.deepEqual([drainReceipt.phase, drainReceipt.failure.provider_called, drainReceipt.failure.layer], ['failed', false, 'milestone-time-admission']);
    // checkpointed: canonical release of the held claim, then the live inspector reports that real
    // attempt; its probe answers from the observed in-process run (settled), never a constant.
    assert.equal(writeClaim.releaseClaim(F.owner, T, { at: Date.now(), mechanism: writeClaim.RELEASE_MECHANISMS.includes('manual') ? 'manual' : writeClaim.RELEASE_MECHANISMS[0], evidence: {} }).ok, true);
    const attemptUnit = drainSelected.delivery_request.unitType + '/' + T;
    let probes = 0;
    const adapter = { inspectAttempt: () => [{ unit: attemptUnit, receipt_path: drainReceiptFile, request: drainSelected.delivery_request }],
      processProbe: receipt => { probes++; return receipt.dispatch_id === drainRaw.dispatchId && attemptSettled ? 'stopped' : 'unknown'; } };
    const inspected = horizon.inspectTaskDrain({ cwd: F.owner, task: T, now: nowX, liveAdapter: adapter, ...prof });
    assert.deepEqual(inspected.writers.map(w => [w.unit, w.classification, w.reason]), [[attemptUnit, 'terminal', 'pre-provider-stop']], JSON.stringify(inspected).slice(0, 400));
    const checkpoint = horizon.checkpointTaskIfDrained({ cwd: F.owner, task: T, now: nowX, liveAdapter: adapter, ...prof });
    assert.ok(['checkpointed', 'partial'].includes(checkpoint.status), JSON.stringify(checkpoint).slice(0, 300));
    assert.ok(probes >= 2, 'the live probe observed the real attempt');
    const cp = check(F, nowX, 'checkpointed', { lifecycle: 'started', state: 'checkpointed', protected: true });
    assert.equal(cp.expected.decision_pending, true);
    assert.ok(cp.tree.includes('Decisão pendente: sim'));
    // extended: the persisted explicit answer plus a fresh live handle.
    const E2 = C + 3600000;
    assert.equal(horizon.prepareTaskExtension({ cwd: F.owner, task: T, ceilingMs: E2, now: nowX }).status, 'open');
    assert.equal(horizon.answerTaskExtension({ cwd: F.owner, task: T, ceilingMs: E2, now: nowX, response: 'Estender o horizonte da task', source: 'user-text' }).status, 'answered');
    const extended = horizon.extendTaskHorizon({ cwd: F.owner, task: T, ceilingMs: E2, now: nowX, liveAdapter: fx.liveAdapter(F.owner, { now: nowX }), ...prof });
    assert.equal(extended.status, 'extended', JSON.stringify(extended).slice(0, 300));
    const ext = check(F, nowX, 'extended', { lifecycle: 'started', state: 'extended', unprotected: true });
    assert.equal(ext.expected.task.extensions, 1);
    assert.equal(ext.expected.decision_pending, false, 'the extension answered the checkpoint decision');
    // closed: verified task delivery and canonical closure; chain completed only with endpoint+closure.
    fx.taskDelivery(F);
    assert.equal(lts.closeLinkedTask({ cwd: F.owner, taskId: T, codeDir: F.code, ...prof }).status, 'closed');
    const closed = check(F, nowX + 60000, 'closed', { lifecycle: 'closed', state: 'completed' });
    assert.equal(closed.expected.chain.completed, true);
    line('status collection and render consume the closed linked projection for actual linked works');

    // Fresh process confirms the persisted projection.
    const fresh = spawnSync(process.execPath, [SELF, '--child', Buffer.from(JSON.stringify({ owner: F.owner, home: F.home, task: T, now: nowX + 60000 })).toString('base64')],
      { encoding: 'utf8', timeout: 90000, env: { ...process.env, HOME: F.home, USERPROFILE: F.home } });
    assert.equal(fresh.status, 0, fresh.stderr);
    const freshView = JSON.parse(fresh.stdout.trim().split('\n').pop());
    assert.deepEqual(freshView.linked, closed.expected, 'fresh process confirms the persisted projection');
    if (freshView.summary) assert.deepEqual(Object.keys(freshView.summary), SUMMARY_KEYS);
    // A private raw value never reaches the summary: only the closed fields exist.
    const rawSummary = at(nowX, () => summary.buildPersonalSummary({ project: F.owner, ...prof }));
    for (const w of rawSummary.works) if (w.linked) assert.deepEqual(Object.keys(w.linked), SUMMARY_KEYS);
    assert.ok(!JSON.stringify(rawSummary).includes('start_sha256') && !JSON.stringify(rawSummary).includes('link_sha256'));
    for (const label of ['blocked', 'exhausted', 'draining', 'checkpointed']) assert.ok(protectedSeen.has(label), label + ' protected');
    line('personal summary consumes the closed linked projection without raw fields or protected work loss');
    line('personal summary stays within4096bytes and protects blocked exhausted draining checkpointed linked work');

    // Unlinked controls: identical key sets before and after every linked operation.
    const controlAfter = at(Date.now(), () => withHome(F.home, () => status.collect(F.owner, { ...prof })));
    assert.equal(controlBytes(controlAfter), controlStatusBytes, 'unlinked controls keep their exact bytes (values and order) after every linked operation');
    // The unlinked summary (no linked work listed) reproduces the immutable legacy entries byte for byte.
    const unlinkedBrief = at(Date.now(), () => summary.buildPersonalSummary({ project: F.owner, ...prof }));
    for (const w of unlinkedBrief.works.filter(x => controls.includes(x.id))) assert.equal(JSON.stringify(w), JSON.stringify(legacySummaryEntry(w.id, controlText[w.id])));
    assert.ok(unlinkedBrief.works.some(x => controls.includes(x.id)), 'controls are listed in the final summary');
    // The explicit chain rows (fresh concurrent process): open and chain-closed.
    const child = await explicit;
    assert.equal(child.code, 0, child.stderr);
    for (const row of JSON.parse(child.stdout.trim().split('\n').pop()).rows) seenStates.add(row);
    line('status models and render show separate governing horizons while unlinked works stay identical');
    const seen = [...seenStates];
    for (const expected of ['blocked/not-started', 'handoff-ready/not-started', 'open/not-started', 'started/active', 'started/exhausted', 'started/draining',
      'started/checkpointed', 'started/extended', 'closed/completed', 'chain-closed/chain-closed']) assert.ok(seen.includes(expected), 'matrix row ' + expected + ' in ' + seen.join(','));
    line('all lifecycle surface projections are pure and absent for unlinked status summary orchestrate');
    passed = true;
  } finally {
    await explicit;
    process.env.HOME = saved.HOME; process.env.USERPROFILE = saved.USERPROFILE;
    if (saved.HOME === undefined) delete process.env.HOME;
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE;
    fx.cleanup();
  }
  if (passed) assert.deepEqual(fx.leftovers('forge-ltt-'), [], 'only the roots created here existed and all were removed');
}

if (require.main === module) {
  if (process.argv[2] === '--child') childMain();
  else {
    const t0 = Date.now();
    suite().then(() => process.stdout.write('# linked surfaces suite ' + Math.round((Date.now() - t0) / 1000) + ' s; pure reads, temporary roots only\n'))
      .catch(error => { console.error(error); process.exitCode = 1; });
  }
}
