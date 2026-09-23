'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const personal = require('./forge-personal-context');

// Shared sanitized fixture builder for the public integration suite.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-personal-'));
  const project = path.join(root, 'wc');
  const home = path.join(root, 'alice');
  const otherHome = path.join(root, 'bob');
  for (const dir of [project, home, otherHome]) fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(project, '.svn'));
  fs.writeFileSync(path.join(root, 'LAB-MANIFEST.json'), JSON.stringify({ purpose: 'isolated personal-context fixtures', root }));
  const options = { project, cwd: project, userHome: home, env: { FORGE_HOME: path.join(root, 'shared-forge') } };
  function work(id, kind = 'task', active = false) {
    const dir = path.join(project, '.gsd', kind === 'task' ? 'tasks' : 'milestones', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(project, '.gsd', 'forge', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(project, '.gsd', 'forge', 'runs', `${id}.json`), JSON.stringify({ id, kind, project, cwd: project, active }));
    const source = path.join(dir, `${id}-${kind === 'task' ? 'PLAN' : 'STATE'}.md`);
    fs.writeFileSync(source, kind === 'task' ? '---\nstatus: RUNNING\n---\nPlan\n' : `---\nmilestone: ${id}\nkind: milestone\n---\n**Phase:** idle\n**Next Action:** Plan slice\n`);
    return { dir, source };
  }
  function bind(id, extra = {}) {
    const result = personal.bindWork({ ...options, id, intent: 'create', ...extra });
    assert.strictEqual(result.status, 'ok', JSON.stringify(result));
    return result;
  }
  function env(userHome = home) {
    return { ...process.env, HOME: userHome, USERPROFILE: userHome, FORGE_HOME: options.env.FORGE_HOME,
      CODEX_HOME: path.join(userHome, '.codex'), CLAUDE_CONFIG_DIR: path.join(userHome, '.claude') };
  }
  return { root, project, home, otherHome, options, work, bind, env,
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); } };
}
async function main() {
  const f = fixture();
  try {
    const a = f.work('TASK-001'); f.work('TASK-002');
    const storeFile = path.join(f.home, '.forge-personal', 'context.json');
    assert.strictEqual(personal.readPersonalSnapshot(f.options).reason, 'no-bindings');
    assert(!fs.existsSync(path.dirname(storeFile)), 'read must not mkdir');
    f.bind('TASK-001'); f.bind('TASK-002', { userHome: f.otherHome });
    assert.strictEqual(f.bind('TASK-001', { intent: 'explicit-resume' }).reason, 'already-bound');
    assert.deepStrictEqual(personal.readPersonalSnapshot(f.options).works.map(w => w.id), ['TASK-001']);
    assert.strictEqual(personal.readPersonalSnapshot({ userHome: f.home, cwd: f.root }).reason, 'project-unresolved');
    assert.deepStrictEqual(personal.readPersonalSnapshot({ ...f.options, userHome: f.otherHome }).works.map(w => w.id), ['TASK-002']);
    // A valid project this profile never bound is `no-bindings`, not a broken
    // namespace — with the store absent AND with the store holding another
    // project. Neither case may mutate or create anything.
    const second = path.join(f.root, 'wc2');
    fs.mkdirSync(path.join(second, '.gsd', 'tasks'), { recursive: true });
    const storeBytes = fs.readFileSync(storeFile);
    assert.strictEqual(personal.readPersonalSnapshot({ userHome: f.home, cwd: second }).reason, 'no-bindings');
    assert.deepStrictEqual(personal.readPersonalSnapshot({ userHome: f.home, cwd: second }).works, []);
    const unusedHome = path.join(f.root, 'carol');
    assert.strictEqual(personal.readPersonalSnapshot({ userHome: unusedHome, cwd: second }).reason, 'no-bindings');
    assert(!fs.existsSync(unusedHome), 'a no-bindings read created the personal namespace');
    assert.deepStrictEqual(fs.readFileSync(storeFile), storeBytes, 'a no-bindings read mutated the store');
    // The ambient directory may arrive relative; resolving it is the caller's
    // contract, not the operator's.
    const relative = path.relative(process.cwd(), f.project) || '.';
    assert.deepStrictEqual(personal.readPersonalSnapshot({ userHome: f.home, cwd: relative }).works.map(w => w.id), ['TASK-001']);
    assert.strictEqual(personal.bindWork({ ...f.options, id: '../../escape', intent: 'create' }).reason, 'invalid-id');
    assert.strictEqual(personal.bindWork({ ...f.options, id: 'TASK-001', intent: 'inspect' }).reason, 'intent-required');
    assert.strictEqual(personal.bindWork({ ...f.options, project: './wc', id: 'TASK-001', intent: 'create' }).status, 'error');
    const checkpoint = {
      pending: [{ text: 'UAT waiting for environment', source: a.source }],
      nextAction: [{ text: 'Wait for environment', source: a.source }],
      acceptances: [{ text: 'Plan approved', source: a.source, resolved: true }],
      lastResult: [{ text: 'Implementation verified', source: a.source }],
    };
    assert.strictEqual(personal.saveCheckpoint({ ...f.options, id: 'TASK-001', intent: 'checkpoint', checkpoint }).status, 'ok');
    let work = personal.readPersonalSnapshot(f.options).works[0];
    assert.strictEqual(work.activity, 'inactive');
    assert.strictEqual(work.workStatus, 'pending');
    assert.strictEqual(work.nextAction.text, 'Wait for environment');
    assert.strictEqual(personal.selectPersonalWork(f.options).reason, 'attention-required');
    const before = fs.readFileSync(storeFile);
    for (let i = 0; i < 3; i++) personal.readPersonalSnapshot(f.options);
    assert.deepStrictEqual(fs.readFileSync(storeFile), before);
    fs.appendFileSync(a.source, 'Changed by authoritative workflow\n');
    work = personal.readPersonalSnapshot(f.options).works[0];
    assert.strictEqual(work.reliability, 'needs-reconciliation');
    assert.strictEqual(work.checkpoint.acceptances[0].text, 'Plan approved');
    assert.strictEqual(work.checkpoint.acceptances[0].validity, 'stale');
    assert.strictEqual(work.lastResult, null);
    fs.unlinkSync(a.source);
    assert.strictEqual(personal.readPersonalSnapshot(f.options).works[0].checkpoint.pending[0].validity, 'missing');
    assert.strictEqual(personal.saveCheckpoint({ ...f.options, id: 'TASK-001', intent: 'checkpoint', checkpoint: { nextAction: [{ text: 'escape', source: path.join(f.root, 'LAB-MANIFEST.json') }] } }).status, 'error');
    assert.deepStrictEqual(fs.readFileSync(storeFile), before);
    fs.writeFileSync(a.source, '---\nstatus: RUNNING\n---\nPlan\n');
    // A failed rename must preserve the previous store byte for byte.
    const rename = fs.renameSync;
    fs.renameSync = function (from, to) { if (to === storeFile) throw Object.assign(new Error('publish denied'), { code: 'EACCES' }); return rename.apply(this, arguments); };
    try {
      assert.strictEqual(personal.saveCheckpoint({ ...f.options, id: 'TASK-001', intent: 'checkpoint', checkpoint: { pending: [] } }).reason, 'write-failed');
    } finally { fs.renameSync = rename; }
    assert.deepStrictEqual(fs.readFileSync(storeFile), before);
    const lock = require('./forge-lock');
    const release = lock.releaseHandle;
    lock.releaseHandle = handle => { release(handle); return { ok: false, reason: 'injected-cleanup-failure' }; };
    try {
      const partial = personal.saveCheckpoint({ ...f.options, id: 'TASK-001', intent: 'checkpoint', checkpoint: {} });
      assert.strictEqual(partial.status, 'partial');
      assert.strictEqual(partial.cleanup[0].reason, 'lock-release-failed');
    } finally { lock.releaseHandle = release; }
    assert.deepStrictEqual(fs.readFileSync(storeFile), before);
    fs.writeFileSync(storeFile, '{broken');
    assert.strictEqual(personal.readPersonalSnapshot(f.options).reason, 'corrupt');
    assert.strictEqual(personal.bindWork({ ...f.options, id: 'TASK-001', intent: 'create' }).reason, 'corrupt');
    assert.strictEqual(fs.readFileSync(storeFile, 'utf8'), '{broken');
    fs.writeFileSync(storeFile, '{"schemaVersion":99,"projects":{}}');
    assert.strictEqual(personal.readPersonalSnapshot(f.options).reason, 'schema-unsupported');
    fs.writeFileSync(storeFile, '{"schemaVersion":1,"projects":{"invalid":{}}}');
    assert.strictEqual(personal.readPersonalSnapshot(f.options).reason, 'schema-invalid');
    const malformedTypes = JSON.parse(before);
    Object.values(malformedTypes.projects)[0].aliases = [{ path: true, repo: f.project, branch: 'invalid' }];
    fs.writeFileSync(storeFile, JSON.stringify(malformedTypes));
    assert.strictEqual(personal.readPersonalSnapshot(f.options).reason, 'schema-invalid');
    assert.strictEqual(personal.readPersonalSnapshot({ ...f.options, project: true }).reason, 'project-unanchored');
    fs.writeFileSync(storeFile, before);
    const malformedAlias = JSON.parse(before);
    Object.values(malformedAlias.projects)[0].aliases = [{ repo: f.otherHome, path: f.otherHome, branch: 'foreign' }];
    fs.writeFileSync(storeFile, JSON.stringify(malformedAlias));
    assert.strictEqual(personal.readPersonalSnapshot(f.options).reason, 'schema-invalid');
    fs.writeFileSync(storeFile, before);
    const read = fs.readFileSync;
    fs.readFileSync = function (file) { if (file === storeFile) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return read.apply(this, arguments); };
    try { assert.strictEqual(personal.readPersonalSnapshot(f.options).reason, 'unreadable'); } finally { fs.readFileSync = read; }
    // Atomic concurrent writers from independent processes retain both updates.
    f.work('TASK-003'); f.work('TASK-004');
    const results = await Promise.all(['TASK-003', 'TASK-004'].map(id => new Promise(resolve => {
      const child = spawn(process.execPath, [path.join(__dirname, 'forge-personal-context.js'), '--bind', '--project', f.project, '--id', id, '--intent', 'create'], { env: f.env(), windowsHide: true });
      let output = ''; child.stdout.on('data', chunk => { output += chunk; });
      child.on('close', code => resolve({ code, output }));
    })));
    for (const result of results) assert.strictEqual(result.code, 0, result.output);
    assert.deepStrictEqual(personal.readPersonalSnapshot(f.options).works.map(w => w.id).sort(), ['TASK-001', 'TASK-003', 'TASK-004']);
    assert.strictEqual(personal.selectPersonalWork(f.options).reason, 'selection-required');
    // Summary by itself does not complete a loose task; explicit final capture does.
    const summary = path.join(a.dir, 'TASK-001-SUMMARY.md');
    fs.writeFileSync(summary, '---\nstatus: DONE\n---\nVerified\n');
    assert.notStrictEqual(personal.readPersonalSnapshot(f.options).works[0].workStatus, 'completed');
    assert.strictEqual(personal.saveCheckpoint({ ...f.options, id: 'TASK-001', intent: 'checkpoint', checkpoint: {
      pending: [], nextAction: [], lastResult: [{ text: 'Task complete, UAT reconciled', source: summary, resolved: true }],
    } }).status, 'ok');
    assert.strictEqual(personal.readPersonalSnapshot(f.options).works[0].workStatus, 'completed');
    // The latest acceptance supersedes history even when source/hash are unchanged.
    const accept = resolved => personal.saveCheckpoint({ ...f.options, id: 'TASK-001', intent: 'checkpoint', checkpoint: {
      acceptances: [{ text: 'Final UAT approval', source: summary, resolved }],
    } });
    assert.strictEqual(accept(false).status, 'ok');
    assert.strictEqual(personal.readPersonalSnapshot(f.options).works[0].workStatus, 'pending');
    assert.strictEqual(accept(true).status, 'ok');
    assert.strictEqual(personal.readPersonalSnapshot(f.options).works[0].workStatus, 'completed');
    assert.strictEqual(accept(false).status, 'ok');
    assert.strictEqual(personal.readPersonalSnapshot(f.options).works[0].workStatus, 'pending');
    assert.strictEqual(accept(true).status, 'ok');
    const history = personal.readPersonalSnapshot(f.options).works[0].checkpoint.acceptances.filter(c => c.text === 'Final UAT approval');
    assert.deepStrictEqual(history.map(c => c.resolved), [false, true, false, true]);
    assert.strictEqual(new Set(history.map(c => c.hash)).size, 1);
    accept(true);
    assert.strictEqual(personal.readPersonalSnapshot(f.options).works[0].checkpoint.acceptances.length, 5);
    const run = path.join(f.project, '.gsd', 'forge', 'runs', 'TASK-003.json');
    fs.writeFileSync(run, '{broken');
    assert.strictEqual(personal.readPersonalSnapshot(f.options).works.find(w => w.id === 'TASK-003').reliability, 'run-corrupt');
    assert.strictEqual(personal.selectPersonalWork(f.options).selected.id, 'TASK-004');
    // Symlink/junction source escapes are rejected before opening target contents.
    const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret'), 'must not read');
    fs.symlinkSync(outside, path.join(f.project, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.strictEqual(personal.saveCheckpoint({ ...f.options, id: 'TASK-001', intent: 'checkpoint', checkpoint: { nextAction: [{ text: 'unsafe', source: 'escape/secret' }] } }).status, 'error');
    const redirectedHome = path.join(f.root, 'redirected-home'); fs.mkdirSync(redirectedHome);
    fs.symlinkSync(path.join(f.otherHome, '.forge-personal'), path.join(redirectedHome, '.forge-personal'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.strictEqual(personal.readPersonalSnapshot({ ...f.options, userHome: redirectedHome }).reason, 'namespace-invalid');
    // Expose only validated, coherent milestone state to status consumers.
    const milestone = f.work('M005', 'milestone'); f.bind('M005');
    const validState = fs.readFileSync(milestone.source, 'utf8');
    const snapshotWork = () => personal.readPersonalSnapshot(f.options).works.find(w => w.id === 'M005');
    assert.strictEqual(snapshotWork().state.milestone, 'M005');
    fs.writeFileSync(milestone.source, validState.replace('milestone: M005', 'milestone: M006'));
    assert.strictEqual(snapshotWork().state, null);
    assert.strictEqual(snapshotWork().reliability, 'state-invalid');
    fs.writeFileSync(milestone.source, 'Unstructured state');
    assert.strictEqual(snapshotWork().state, null);
    assert.strictEqual(snapshotWork().reliability, 'state-invalid');
    fs.writeFileSync(milestone.source, validState);
    const stateReader = require('./forge-state');
    const readState = stateReader.read;
    try {
      stateReader.read = function (project, id) {
        if (id === 'M005') fs.appendFileSync(milestone.source, 'changed between reads');
        return readState.apply(this, arguments);
      };
      assert.strictEqual(snapshotWork().reliability, 'state-changed');
      assert.strictEqual(snapshotWork().state, null);
      stateReader.read = function (project, id) {
        if (id === 'M005') throw Object.assign(new Error('fixture denied'), { code: 'EACCES' });
        return readState.apply(this, arguments);
      };
      assert.strictEqual(snapshotWork().reliability, 'state-unreadable');
      assert.strictEqual(snapshotWork().state, null);
    } finally { stateReader.read = readState; }
    fs.writeFileSync(milestone.source, validState);
    personal.saveCheckpoint({ ...f.options, id: 'M005', intent: 'checkpoint', checkpoint: {
      nextAction: [{ text: 'Current personal action', source: milestone.source }],
    } });
    assert.strictEqual(snapshotWork().state.next_action, 'Current personal action');
    fs.appendFileSync(milestone.source, 'changed checkpoint source');
    assert.strictEqual(snapshotWork().state, null);
    assert.strictEqual(snapshotWork().reliability, 'needs-reconciliation');
    assert.strictEqual(snapshotWork().nextAction.validity, 'reconciliation-required');
    fs.unlinkSync(milestone.source);
    assert.strictEqual(snapshotWork().state, null);
    console.log('PASS personal context: isolation, evidence, corruption, atomic failure, concurrency and terminal reconciliation');
  } finally { f.cleanup(); }
}
module.exports = { fixture };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
