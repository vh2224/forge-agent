'use strict';
// Issue 282: the milestone v2 ready record carries the owner-generated task
// marker, so publication checks the S##-PLAN box and the controller advances.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sidecar = require('./forge-unit-sidecar');
const xllm = require('./forge-xllm');
const controller = require('./forge-unit-controller');
const delivery = require('./forge-delivery');
const fixtures = require('./forge-code-roots.test');
const runs = require('./forge-runs');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const ROADMAP = '# M001: Fixture — Roadmap\n\n## Slices\n- [ ] **S01: Slice do marcador** `risk:high` `depends:[]`\n';
// T01.1 is already done, so after T01 the controller's next unchecked task is T02.
const SLICE_PLAN = '# S01: Slice do marcador\n\n## Tasks\n- [ ] **T01: Primeira task** `est:1h`\n- [x] **T01.1: Subtask de prefixo parecido**\n- [ ] **T02: Segunda task**\n';
const OTHER_PLAN = '# S02: Outra slice\n\n## Tasks\n- [ ] **T01: Mesmo id em outra slice**\n';
const MARKED_PLAN = SLICE_PLAN.replace('- [ ] **T01: Primeira', '- [x] **T01: Primeira');
const SLICE_PLAN_PATH = '.gsd/milestones/M001/slices/S01/S01-PLAN.md';
const OTHER_PLAN_PATH = '.gsd/milestones/M001/slices/S02/S02-PLAN.md';
const PREFS = { skip_discuss: true, skip_research: true };

let transportCalls = 0;
let workerHook = null;
const realRunExecute = xllm.runExecute;
const realRename = fs.renameSync;
let renameHook = null;

// The frontmatter worker pins the Claude sidecar family, so an operator routing
// profile cannot turn this fixture into a native Codex route.
const taskPlan = contract => fixtures.plan(contract).replace('tier: standard\n', 'tier: standard\nworker: claude\n');
function setup(dispatchId, slicePlan = SLICE_PLAN) {
  const lab = fixtures.fixture();
  const milestone = path.join(lab.owner, '.gsd/milestones/M001');
  const base = path.join(milestone, 'slices/S01');
  fs.mkdirSync(path.join(base, 'tasks/T01'), { recursive: true });
  fs.mkdirSync(path.join(milestone, 'slices/S02'), { recursive: true });
  fs.writeFileSync(path.join(milestone, 'M001-ROADMAP.md'), ROADMAP);
  fs.writeFileSync(path.join(base, 'S01-RESEARCH.md'), '# S01 research\n');
  fs.writeFileSync(path.join(lab.owner, SLICE_PLAN_PATH), slicePlan);
  fs.writeFileSync(path.join(lab.owner, OTHER_PLAN_PATH), OTHER_PLAN);
  const request = { unitType: 'execute-task', scope: 'milestone', phase: 'execute', milestoneId: 'M001', sliceId: 'S01', taskId: 'T01',
    cwd: lab.a, contextRoot: lab.owner, execution_contract: lab.contract, workflowId: 'marker-fixture', dispatchId,
    resultFile: path.join(lab.dir, `${dispatchId}.json`), prompt: 'Fixture only.',
    planFile: path.join(base, 'tasks/T01/T01-PLAN.md'), verification: { preferenceCommands: ['node -e "process.exit(0)"'] } };
  fs.writeFileSync(request.planFile, taskPlan(lab.contract));
  fs.writeFileSync(path.join(lab.owner, '.gsd/forge-prefs.jsonc'), JSON.stringify({ tier_models: Object.fromEntries(
    ['light', 'standard', 'heavy', 'max'].map(tier => [tier, ['claude-sonnet-5']])), effort: { 'plan-slice': 'medium' } }));
  request.route = require('./forge-dispatch-resolve').resolveDispatch({ cwd: request.contextRoot, unitType: request.unitType,
    milestoneId: request.milestoneId, unitId: request.taskId, planPath: request.planFile, hostRuntime: 'codex' });
  request.runId = `marker-${dispatchId}`;
  request.claim = { schema_version: 2, generation: crypto.randomUUID(), execution_contract: lab.contract,
    paths: ['alpha', 'beta'].map(root_id => ({ root_id, path: 'same.txt' })) };
  request.gates = { plan: 'skipped', planSkipReason: 'interactive-off', claim: 'proceed', security: 'not-applicable' };
  runs.add(lab.owner, { id: request.runId, kind: 'milestone', session_id: 'fixture', write_claim: request.claim });
  const read = relative => fs.readFileSync(path.join(lab.owner, relative), 'utf8');
  const write = (relative, value) => fs.writeFileSync(path.join(lab.owner, relative), value);
  const receiptFile = `${request.resultFile}.receipt.json`;
  const receipt = () => JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  const next = () => {
    const state = { milestone: 'M001' };
    return controller.selectNextUnit({ state, inventory: controller.discoverInventory(lab.owner, 'M001', state), prefs: PREFS });
  };
  return { lab, request, read, write, receiptFile, receipt, next, cleanup: () => lab.cleanup() };
}
function crashOnce(predicate) {
  let armed = true;
  renameHook = (from, to) => {
    if (armed && predicate(path.resolve(to), from)) {
      armed = false;
      throw Object.assign(new Error('simulated publication crash'), { code: 'EIO' });
    }
  };
}
function publishedMatch(f, artifacts) {
  for (const item of artifacts) assert.strictEqual(f.read(item.path), item.content, item.path);
}
function checkedCount(text) { return (text.match(/^- \[x\] \*\*T01:/gm) || []).length; }

async function main() {
  xllm.runExecute = async () => {
    transportCalls++;
    const { lab } = workerHook.fixture;
    fs.writeFileSync(path.join(lab.a, 'same.txt'), 'worker alpha\n');
    fs.writeFileSync(path.join(lab.b, 'same.txt'), 'worker beta\n');
    workerHook.during?.();
    return { status: 'done', summary: 'Marker fixture', files_changed: ['alpha::same.txt', 'beta::same.txt'], must_haves_status: [] };
  };
  fs.renameSync = (from, to) => { renameHook?.(from, to); return realRename(from, to); };
  try {
    helperContracts();
    await publicationAndSelection();
    await crashBeforeMarker();
    await partialCrashReplay();
    await conflictDuringDispatch();
    await conflictBeforePublication();
    await executedReplayManualMark();
    await alreadyCheckedBeforeCapture();
    await legacyReadyReplay();
    await legacyMilestoneBookkeeping();
    releaseAnchors();
  } finally {
    xllm.runExecute = realRunExecute;
    fs.renameSync = realRename;
  }
}

function helperContracts() {
  const f = setup('helpers');
  try {
    const root = fs.realpathSync(f.lab.owner);
    const before = sha(SLICE_PLAN);
    const marker = sidecar.createTaskMarker(f.request, root, before);
    assert.deepStrictEqual(marker, { path: SLICE_PLAN_PATH, content: MARKED_PLAN, before });
    assert.strictEqual(f.read(SLICE_PLAN_PATH), SLICE_PLAN, 'createTaskMarker never writes');
    assert.strictEqual(sidecar.verifyTaskMarker(f.request, marker, before), true);
    console.log('PASS task-marker helpers: createTaskMarker derives the slice plan path from validated IDs and returns markChecked of the recorded preimage');

    assert.throws(() => sidecar.createTaskMarker(f.request, root, sha('outra preimagem')), error => error.code === 'task-marker-preimage-changed');
    assert.throws(() => sidecar.createTaskMarker(f.request, root, undefined), error => error.code === 'task-marker-preimage-required');
    assert.strictEqual(f.read(SLICE_PLAN_PATH), SLICE_PLAN);
    console.log('PASS task-marker helpers: divergent preimage fails with task-marker-preimage-changed and nothing is written');

    f.write(SLICE_PLAN_PATH, MARKED_PLAN);
    assert.strictEqual(sidecar.createTaskMarker(f.request, root, sha(MARKED_PLAN)), null);
    const absent = '# S01\n\n## Tasks\n- [ ] **T02: Segunda task**\n';
    f.write(SLICE_PLAN_PATH, absent);
    assert.strictEqual(sidecar.createTaskMarker(f.request, root, sha(absent)), null);
    const prefixFirst = '# S01\n\n## Tasks\n- [ ] **T01.1: Subtask antes**\n- [ ] T01: Formato simples\n- [ ] **T010: Outro id**\n';
    f.write(SLICE_PLAN_PATH, prefixFirst);
    assert.strictEqual(sidecar.createTaskMarker(f.request, root, sha(prefixFirst)).content,
      prefixFirst.replace('- [ ] T01: Formato', '- [x] T01: Formato'));
    f.write(SLICE_PLAN_PATH, SLICE_PLAN);
    console.log('PASS task-marker helpers: already checked or absent task line yields no marker and unchanged bytes');
    console.log('PASS task-marker namespace: an unchecked T01.1 or T010 line is never marked for T01');

    for (const request of [{ ...f.request, scope: 'standalone-task', milestoneId: undefined, sliceId: undefined },
      { ...f.request, unitType: 'plan-slice' }]) {
      assert.throws(() => sidecar.createTaskMarker(request, root, before), error => error.code === 'task-marker-scope-invalid');
    }
    for (const request of [{ ...f.request, sliceId: '../S01' }, { ...f.request, taskId: 'T01/../../x' }, { ...f.request, milestoneId: '..' }]) {
      assert.throws(() => sidecar.createTaskMarker(request, root, before), /invalid-(slice|task|milestone)/);
    }
    console.log('PASS task-marker helpers: standalone and non-execute units get no slice marker; invalid IDs never form a path');

    const invalid = error => error.code === 'task-marker-invalid';
    assert.throws(() => sidecar.verifyTaskMarker({ ...f.request, sliceId: 'S02' }, marker, before), invalid);
    console.log('PASS verifyTaskMarker refuses another slice');
    assert.throws(() => sidecar.verifyTaskMarker({ ...f.request, taskId: 'T02' }, marker, before), invalid);
    assert.throws(() => sidecar.verifyTaskMarker({ ...f.request, taskId: 'T01.1' }, marker, before), invalid);
    console.log('PASS verifyTaskMarker refuses another taskId, including a similar prefix');
    assert.throws(() => sidecar.verifyTaskMarker(f.request, marker, sha('divergente')), invalid);
    assert.throws(() => sidecar.verifyTaskMarker(f.request, { ...marker, before: sha('divergente') }, before), invalid);
    console.log('PASS verifyTaskMarker refuses a divergent before');
    for (const content of [MARKED_PLAN + 'Linha extra.\n', MARKED_PLAN.replace('- [ ] **T02', '- [x] **T02'),
      MARKED_PLAN.replace('- [x] **T01.1', '- [ ] **T01.1')]) {
      assert.throws(() => sidecar.verifyTaskMarker(f.request, { ...marker, content }, before), invalid);
    }
    assert.throws(() => sidecar.verifyTaskMarker(f.request, { ...marker, path: OTHER_PLAN_PATH }, before), invalid);
    assert.throws(() => sidecar.verifyTaskMarker(f.request, { ...marker, extra: true }, before), invalid);
    console.log('PASS verifyTaskMarker refuses altered content, path or shape');

    const loc = sidecar.locations(f.request);
    assert(!loc.allowed.includes(SLICE_PLAN_PATH), 'locations().allowed stays without the slice plan');
    const required = loc.required.map(p => ({ path: p, content: '{}' }));
    const verdict = sidecar.inspectArtifacts({ status: 'done', summary: 'Worker', questions: [],
      artifacts: [{ path: SLICE_PLAN_PATH, content: MARKED_PLAN }, ...required] }, loc.allowed, loc.required, Infinity, loc.rules);
    assert.strictEqual(verdict.reason, 'artifact-path-invalid');
    console.log('PASS worker boundary: a worker result carrying the S01-PLAN is refused with artifact-path-invalid');
  } finally { f.cleanup(); }
}

async function publicationAndSelection() {
  const f = setup('publish');
  const renderOptions = [];
  const render = delivery.renderDeliveryMarkdown;
  delivery.renderDeliveryMarkdown = (output, options) => { renderOptions.push(options); return render(output, options); };
  try {
    workerHook = { fixture: f };
    transportCalls = 0;
    assert.strictEqual(f.next().unit.id, 'T01', 'before publication the controller selects T01');
    const planBytes = fs.readFileSync(f.request.planFile);
    const result = await sidecar.runUnitSidecar(f.request);
    assert.strictEqual(result.status, 'done');
    assert.strictEqual(transportCalls, 1);
    const ready = f.receipt();
    assert.strictEqual(ready.phase, 'ready');
    const paths = ready.artifacts.map(item => item.path);
    const unit = '.gsd/milestones/M001/slices/S01/tasks/T01/T01';
    for (const expected of [`${unit}-SUMMARY.md`, `${unit}-DELIVERY-INPUT.json`, `${unit}-DELIVERY.json`,
      `${unit}-VERIFICATION-alpha-ENVELOPE.json`, `${unit}-ARTIFACT-beta-ENVELOPE.json`]) assert(paths.includes(expected), expected);
    const marker = ready.artifacts[ready.artifacts.length - 1];
    assert.strictEqual(marker.path, SLICE_PLAN_PATH, 'the owner marker is the last ready artifact');
    assert.strictEqual(paths.filter(p => p === SLICE_PLAN_PATH).length, 1);
    assert.strictEqual(marker.before, ready.before[SLICE_PLAN_PATH]);
    assert.strictEqual(marker.before, sha(SLICE_PLAN));
    assert.strictEqual(sidecar.verifyTaskMarker(f.request, { path: marker.path, content: marker.content, before: marker.before }, ready.before[SLICE_PLAN_PATH]), true);
    publishedMatch(f, ready.artifacts);
    console.log('PASS T01 publication: ready record holds SUMMARY, DELIVERY-INPUT, DELIVERY, envelopes and the owner marker last with the started before');

    const published = f.read(SLICE_PLAN_PATH);
    assert.strictEqual(published, MARKED_PLAN);
    const lines = published.split('\n'), original = SLICE_PLAN.split('\n');
    assert.deepStrictEqual(lines.map((line, i) => line === original[i] ? null : i).filter(i => i !== null), [3], 'only the T01 line changed');
    assert(published.includes('- [x] **T01.1: Subtask'), 'T01.1 line keeps its bytes');
    assert(published.includes('- [ ] **T02: Segunda'), 'T02 stays unchecked');
    assert.strictEqual(f.read(OTHER_PLAN_PATH), OTHER_PLAN, 'another slice plan is never marked');
    console.log('PASS T01 publication: S01-PLAN has only the T01 line checked; T01.1, T02 and S02-PLAN keep their bytes');

    assert(fs.readFileSync(f.request.planFile).equals(planBytes), 'executed T01-PLAN keeps its sha256');
    assert(!/status:\s*done/i.test(fs.readFileSync(f.request.planFile, 'utf8')));
    console.log('PASS T01 publication: executed T01-PLAN keeps the same sha256 and gains no DONE status');

    const selection = f.next();
    assert.strictEqual(selection.unit.type, 'execute-task');
    assert.strictEqual(selection.unit.id, 'T02');
    console.log('PASS controller: discoverInventory + selectNextUnit select execute-task T02 after T01 publication');

    assert(renderOptions.length >= 1 && renderOptions.every(options => options.summary === false), JSON.stringify(renderOptions));
    const summary = f.read(`${unit}-SUMMARY.md`);
    const historical = render(JSON.parse(f.read(`${unit}-DELIVERY.json`)), { detailReference: './T01-DELIVERY.json', summary: false });
    assert(summary.endsWith(historical), 'SUMMARY keeps the historical table-only delivery bytes');
    console.log('PASS canonical SUMMARY: executeDeliveryArtifacts passes summary:false and keeps the historical delivery bytes');

    const receiptBytes = fs.readFileSync(f.receiptFile);
    const stats = ready.artifacts.map(item => [item.path, fs.statSync(path.join(f.lab.owner, item.path)).mtimeMs]);
    const replay = await sidecar.runUnitSidecar(f.request);
    assert.strictEqual(replay.status, 'done');
    assert.strictEqual(transportCalls, 1, 'replay never calls the transport again');
    assert(fs.readFileSync(f.receiptFile).equals(receiptBytes), 'ready receipt bytes are preserved');
    for (const [relative, mtime] of stats) assert.strictEqual(fs.statSync(path.join(f.lab.owner, relative)).mtimeMs, mtime, relative);
    publishedMatch(f, ready.artifacts);
    assert.strictEqual(checkedCount(f.read(SLICE_PLAN_PATH)), 1);
    console.log('PASS ready replay: transport counter stays 1, no published artifact rewritten and ready receipt bytes preserved');
  } finally { delivery.renderDeliveryMarkdown = render; workerHook = null; f.cleanup(); }
}

async function crashBeforeMarker() {
  const f = setup('crash-marker');
  try {
    workerHook = { fixture: f };
    transportCalls = 0;
    const markerFile = path.resolve(f.lab.owner, SLICE_PLAN_PATH);
    crashOnce(to => to === markerFile);
    await assert.rejects(sidecar.runUnitSidecar(f.request), /simulated publication crash/);
    renameHook = null;
    const ready = f.receipt();
    assert.strictEqual(ready.phase, 'ready');
    publishedMatch(f, ready.artifacts.slice(0, -1));
    assert.strictEqual(f.read(SLICE_PLAN_PATH), SLICE_PLAN, 'checkbox stays unchecked until replay');
    assert.strictEqual(f.next().unit.id, 'T01');
    await sidecar.runUnitSidecar(f.request);
    assert.strictEqual(transportCalls, 1);
    publishedMatch(f, ready.artifacts);
    assert.strictEqual(checkedCount(f.read(SLICE_PLAN_PATH)), 1);
    assert.strictEqual(f.next().unit.id, 'T02');
    console.log('PASS crash before marker: delivery published, checkbox unchecked until replay; replay marks once without transport');
  } finally { renameHook = null; workerHook = null; f.cleanup(); }
}

async function partialCrashReplay() {
  const f = setup('crash-partial');
  try {
    workerHook = { fixture: f };
    transportCalls = 0;
    const inputFile = path.resolve(f.lab.owner, '.gsd/milestones/M001/slices/S01/tasks/T01/T01-DELIVERY-INPUT.json');
    crashOnce(to => to === inputFile);
    await assert.rejects(sidecar.runUnitSidecar(f.request), /simulated publication crash/);
    renameHook = null;
    const ready = f.receipt();
    assert.strictEqual(ready.phase, 'ready');
    assert.strictEqual(fs.existsSync(inputFile), false);
    assert.strictEqual(f.read(SLICE_PLAN_PATH), SLICE_PLAN);
    await sidecar.runUnitSidecar(f.request);
    assert.strictEqual(transportCalls, 1);
    publishedMatch(f, ready.artifacts);
    assert.strictEqual(f.read(SLICE_PLAN_PATH), MARKED_PLAN);
    assert.strictEqual(checkedCount(f.read(SLICE_PLAN_PATH)), 1);
    console.log('PASS partial crash: replay completes the same final bytes and marks the S01-PLAN exactly once');
  } finally { renameHook = null; workerHook = null; f.cleanup(); }
}

async function conflictDuringDispatch() {
  const f = setup('conflict-dispatch');
  const edited = `${SLICE_PLAN}\nNota do operador durante o dispatch.\n`;
  try {
    workerHook = { fixture: f, during: () => f.write(SLICE_PLAN_PATH, edited) };
    transportCalls = 0;
    await assert.rejects(sidecar.runUnitSidecar(f.request), error => error.code === 'execution-protected-metadata');
    workerHook = { fixture: f };
    assert.strictEqual(f.read(SLICE_PLAN_PATH), edited, 'operator bytes preserved');
    await assert.rejects(sidecar.runUnitSidecar(f.request));
    assert.strictEqual(transportCalls, 1, 'no second inference after the conflict');
    assert.strictEqual(f.read(SLICE_PLAN_PATH), edited, 'no recapture overwrites the operator edit');
    console.log('PASS conflict during dispatch: unrelated S01-PLAN edit fails closed with execution-protected-metadata and keeps operator bytes without recapture');
  } finally { workerHook = null; f.cleanup(); }
}

async function conflictBeforePublication() {
  const f = setup('conflict-publication');
  const edited = `${SLICE_PLAN}\nNota do operador antes da publicação.\n`;
  try {
    workerHook = { fixture: f };
    transportCalls = 0;
    const summaryFile = path.resolve(f.lab.owner, '.gsd/milestones/M001/slices/S01/tasks/T01/T01-SUMMARY.md');
    crashOnce(to => to === summaryFile);
    await assert.rejects(sidecar.runUnitSidecar(f.request), /simulated publication crash/);
    renameHook = null;
    const saved = f.receipt();
    f.write(SLICE_PLAN_PATH, edited);
    await assert.rejects(sidecar.runUnitSidecar(f.request), error => error.code === 'execution-protected-metadata');
    assert.strictEqual(transportCalls, 1);
    assert.strictEqual(f.read(SLICE_PLAN_PATH), edited, 'operator bytes preserved');
    const after = f.receipt();
    assert.strictEqual(after.artifacts[after.artifacts.length - 1].before, sha(SLICE_PLAN), 'original preimage kept, never recaptured');
    assert.deepStrictEqual(after.artifacts, saved.artifacts);
    console.log('PASS conflict before publication: ready replay over an edited S01-PLAN fails closed with execution-protected-metadata, keeps operator bytes and the original preimage');
  } finally { renameHook = null; workerHook = null; f.cleanup(); }
}

async function executedReplayManualMark() {
  const f = setup('executed-replay');
  try {
    workerHook = { fixture: f };
    transportCalls = 0;
    const receiptPath = path.resolve(f.receiptFile);
    crashOnce((to, from) => to === receiptPath && /"phase": "ready"/.test(fs.readFileSync(from, 'utf8')));
    await assert.rejects(sidecar.runUnitSidecar(f.request), /simulated publication crash/);
    renameHook = null;
    assert.strictEqual(f.receipt().phase, 'executed');
    assert.strictEqual(f.read(SLICE_PLAN_PATH), SLICE_PLAN);
    f.write(SLICE_PLAN_PATH, MARKED_PLAN);
    await assert.rejects(sidecar.runUnitSidecar(f.request), error => error.code === 'execution-protected-metadata');
    assert.strictEqual(f.read(SLICE_PLAN_PATH), MARKED_PLAN, 'manual owner marking preserved');
    assert.strictEqual(f.receipt().phase, 'executed', 'no ready record from a recaptured preimage');
    console.log('PASS executed replay: manual marking since the original preimage fails closed with execution-protected-metadata and no recapture');
    f.write(SLICE_PLAN_PATH, SLICE_PLAN);
    await sidecar.runUnitSidecar(f.request);
    assert.strictEqual(transportCalls, 1);
    const ready = f.receipt();
    const marker = ready.artifacts[ready.artifacts.length - 1];
    assert.strictEqual(marker.path, SLICE_PLAN_PATH);
    assert.strictEqual(marker.before, sha(SLICE_PLAN));
    assert.strictEqual(f.read(SLICE_PLAN_PATH), MARKED_PLAN);
    console.log('PASS executed replay: the marker is recreated from the same recorded preimage without transport');
  } finally { renameHook = null; workerHook = null; f.cleanup(); }
}

async function alreadyCheckedBeforeCapture() {
  const f = setup('already-checked', MARKED_PLAN);
  try {
    workerHook = { fixture: f };
    transportCalls = 0;
    await sidecar.runUnitSidecar(f.request);
    const ready = f.receipt();
    assert(!ready.artifacts.some(item => item.path === SLICE_PLAN_PATH), 'already checked line produces no marker');
    assert.strictEqual(f.read(SLICE_PLAN_PATH), MARKED_PLAN);
    const bytes = fs.readFileSync(f.receiptFile);
    await sidecar.runUnitSidecar(f.request);
    assert(fs.readFileSync(f.receiptFile).equals(bytes));
    assert.strictEqual(transportCalls, 1);
    console.log('PASS already checked before capture: no marker artifact, unchanged plan bytes and idempotent replay');
  } finally { workerHook = null; f.cleanup(); }
}

async function legacyReadyReplay() {
  const f = setup('legacy-ready');
  try {
    workerHook = { fixture: f };
    transportCalls = 0;
    const markerFile = path.resolve(f.lab.owner, SLICE_PLAN_PATH);
    crashOnce(to => to === markerFile);
    await assert.rejects(sidecar.runUnitSidecar(f.request), /simulated publication crash/);
    renameHook = null;
    // A ready receipt persisted before this repair carries no marker artifact.
    const legacy = f.receipt();
    legacy.artifacts = legacy.artifacts.filter(item => item.path !== SLICE_PLAN_PATH);
    fs.writeFileSync(f.receiptFile, JSON.stringify(legacy, null, 2) + '\n');
    const bytes = fs.readFileSync(f.receiptFile);
    await sidecar.runUnitSidecar(f.request);
    assert.strictEqual(transportCalls, 1);
    assert(fs.readFileSync(f.receiptFile).equals(bytes), 'legacy ready receipt bytes preserved');
    assert.strictEqual(f.read(SLICE_PLAN_PATH), SLICE_PLAN, 'legacy ready replay never gains a marker');
    publishedMatch(f, legacy.artifacts);
    console.log('PASS legacy ready receipt: replay stays idempotent and never gains a marker');
  } finally { renameHook = null; workerHook = null; f.cleanup(); }
}

async function legacyMilestoneBookkeeping() {
  const f = setup('legacy-milestone');
  try {
    const roots = require('./forge-code-roots');
    const single = roots.singleContract(f.lab.owner, f.lab.a);
    fs.writeFileSync(f.request.planFile, taskPlan(single));
    const request = { ...f.request, execution_contract: undefined, claim: undefined, gates: undefined, runId: undefined };
    request.route = require('./forge-dispatch-resolve').resolveDispatch({ cwd: request.contextRoot, unitType: request.unitType,
      milestoneId: request.milestoneId, unitId: request.taskId, planPath: request.planFile, hostRuntime: 'codex' });
    workerHook = { fixture: f };
    transportCalls = 0;
    xllm.runExecute = async () => {
      transportCalls++;
      fs.writeFileSync(path.join(f.lab.a, 'same.txt'), 'worker alpha\n');
      return { status: 'done', summary: 'Legacy fixture', files_changed: ['same.txt'], must_haves_status: [] };
    };
    try { await sidecar.runUnitSidecar(request); }
    finally {
      xllm.runExecute = async () => { throw new Error('unexpected transport'); };
    }
    const ready = f.receipt();
    assert.strictEqual(ready.milestone_delivery, undefined);
    const last = ready.artifacts[ready.artifacts.length - 1];
    assert.strictEqual(last.path, SLICE_PLAN_PATH, 'legacy markChecked stays after executeDeliveryArtifacts');
    assert(ready.artifacts.findIndex(item => item.path.endsWith('T01-SUMMARY.md')) < ready.artifacts.length - 1);
    assert.strictEqual(f.read(SLICE_PLAN_PATH), MARKED_PLAN);
    assert.strictEqual(transportCalls, 1);
    console.log('PASS legacy milestone without execution_contract: existing markChecked bookkeeping unchanged after delivery artifacts');
  } finally {
    workerHook = null; f.cleanup();
  }
}

function releaseAnchors() {
  const source = fs.readFileSync(path.join(__dirname, 'forge-unit-sidecar.js'), 'utf8');
  for (const literal of ['terminalResult', 'preflightExecutionVerification']) assert(source.includes(literal), literal);
  assert.strictEqual(typeof sidecar.createTaskMarker, 'function');
  assert.strictEqual(typeof sidecar.verifyTaskMarker, 'function');
  assert.strictEqual(typeof sidecar.markChecked, 'function');
  console.log('PASS release anchors: terminalResult and preflightExecutionVerification present; marker helpers exported beside markChecked');
}

main().then(() => console.log('forge-milestone-task-marker: all scenarios passed')).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
