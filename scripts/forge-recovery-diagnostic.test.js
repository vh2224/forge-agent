#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { fixture } = require('./forge-personal-context.test');
const diagnostic = require('./forge-recovery-diagnostic');
const personal = require('./forge-personal-context');
const recovery = require('./forge-claim-recovery');
const claims = require('./forge-write-claim');
const controller = require('./forge-unit-controller');
const runs = require('./forge-runs');

let passed = 0;
function test(name, fn) {
  const f = fixture();
  f.id = 'TASK-001'; f.work(f.id);
  f.runFile = path.join(f.project, '.gsd', 'forge', 'runs', `${f.id}.json`);
  f.readRun = () => JSON.parse(fs.readFileSync(f.runFile));
  f.writeRun = value => fs.writeFileSync(f.runFile, JSON.stringify(value));
  f.inspect = extra => diagnostic.inspectRecovery({ ...f.options, id: f.id, ...extra });
  try { fn(f); passed++; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}: ${error.stack}`); process.exitCode = 1; }
  finally { f.cleanup(); }
}
function inventory(root) {
  const result = {};
  function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name); const st = fs.lstatSync(file); const rel = path.relative(root, file);
      if (st.isSymbolicLink()) result[rel] = `link:${fs.readlinkSync(file)}`;
      else if (st.isDirectory()) { result[rel] = 'directory'; visit(file); }
      else result[rel] = recovery.sha256(fs.readFileSync(file));
    }
  }
  visit(root); return result;
}
function repeated(f, extra) {
  const before = inventory(f.root); const restores = []; let violations = 0;
  const forbid = (object, key) => {
    const previous = object[key]; if (typeof previous !== 'function') return;
    object[key] = () => { violations++; throw new Error(`forbidden: ${key}`); };
    restores.push(() => { object[key] = previous; });
  };
  for (const key of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync']) forbid(fs, key);
  // Windows realpath uses readdir to resolve casing/8.3 aliases; only the
  // operational registry enumeration is a census.
  const readdir = fs.readdirSync;
  fs.readdirSync = function(dir, ...args) {
    if (/[/\\](runs|transactions|claim-recovery)$/.test(String(dir))) { violations++; throw new Error('census'); }
    return readdir.call(this, dir, ...args);
  };
  restores.push(() => { fs.readdirSync = readdir; });
  for (const key of ['bindWork', 'saveCheckpoint']) forbid(personal, key);
  for (const key of ['inspect', 'apply']) forbid(recovery, key);
  for (const key of ['list', 'listAll', 'listAllDetailed', 'update', 'updateWith']) forbid(runs, key);
  for (const key of ['resume', 'pendingTransactions', 'complete', 'transition', 'begin']) forbid(controller, key);
  const locks = require('./forge-lock'); forbid(locks, 'acquireSync'); forbid(locks, 'releaseHandle');
  const census = require('./forge-claim-stuck'); forbid(census, 'findStuckClaims');
  const oldRestore = recovery.restore;
  recovery.restore = (cwd, id, opts) => { assert.strictEqual(opts.apply, false); return oldRestore(cwd, id, opts); };
  let result;
  try { result = f.inspect(extra); f.inspect(extra); }
  finally { recovery.restore = oldRestore; restores.reverse().forEach(restore => restore()); }
  assert.strictEqual(violations, 0, 'a forbidden mutation or census was attempted');
  assert.deepStrictEqual(inventory(f.root), before, 'diagnostic changed inventory/bytes');
  return result;
}
function release(f, dirty = false, code = path.join(f.project, 'code')) {
  fs.mkdirSync(code, { recursive: true });
  f.writeRun({ ...f.readRun(), active: true, last_heartbeat: 1 });
  claims.recordClaim(f.project, f.id, { at: 2, unit: 'execute-task/T01', source: 'manual', code_dir: code,
    paths: ['a.bin'], vcs_baseline: { vcs: 'git', id: 'baseline' } });
  if (dirty) fs.writeFileSync(path.join(code, 'a.bin'), 'preserved payload');
  const out = recovery.apply(f.project, f.id, { confirmOwnerStopped: true, confirmWorkspaceQuiescent: true,
    io: { fsyncDir() {} }, findStuckClaims: () => ({ stuck: [{ id: f.id }] }),
    workingStatus: () => ({ ok: true, entries: dirty ? [{ path: 'a.bin', kind: 'modified', code: ' M' }] : [] }) });
  assert.strictEqual(out.applied, true, JSON.stringify(out));
  fs.unlinkSync(path.join(f.project, '.gsd', 'forge', 'events.jsonl'));
  return { code, bundle: out.bundle && path.join(f.project, out.bundle) };
}
const hasSource = (r, name, state) => r.sources.some(s => s.name === name && s.state === state);
function sameFile(a, b) {
  try { return path.relative(fs.realpathSync(a), fs.realpathSync(b)) === ''; }
  catch { return typeof a === 'string' && typeof b === 'string' && path.relative(a, b) === ''; }
}

test('unbound ID and isolated SUMMARY do not adopt or conclude; retry is read-only', f => {
  fs.writeFileSync(path.join(f.project, '.gsd', 'tasks', f.id, `${f.id}-SUMMARY.md`), '---\nstatus: DONE\n---');
  const r = repeated(f);
  assert.strictEqual(r.continuity.bound, false); assert.strictEqual(r.continuity.state, 'unproven');
  assert.notStrictEqual(r.continuity.workStatus, 'completed'); assert.strictEqual(r.status, 'partial');
  assert(hasSource(r, 'personal-store', 'missing'));
  assert(!fs.existsSync(path.join(f.home, '.forge-personal')));
});
test('durable clean release survives absent event and does not require bundle', f => {
  release(f); const r = repeated(f);
  assert.strictEqual(r.claim.state, 'released'); assert(r.provenResults.some(p => p.kind === 'claim-release'));
  assert(!r.artifacts.some(a => a.kind === 'claim-bundle'));
});
test('linked bundle verified after release without final event, corrupt payload stays partial', f => {
  const { bundle } = release(f, true);
  let r = repeated(f); assert.strictEqual(r.artifacts.find(a => a.kind === 'claim-bundle').integrity, 'verified');
  fs.writeFileSync(path.join(bundle, 'payload', '0.bin'), 'corrupt');
  r = repeated(f); assert(r.provenResults.some(p => p.kind === 'claim-release'));
  assert(hasSource(r, 'claim-preview', 'integrity-unverified'));
  fs.writeFileSync(path.join(bundle, 'manifest.json'), '{bad');
  r = repeated(f); assert(hasSource(r, 'claim-manifest', 'corrupt'));
  assert.strictEqual(r.artifacts.find(a => a.kind === 'claim-bundle').existence, 'observed');
});
test('orphan bundle proves no release and is not discovered', f => {
  release(f, true); const record = f.readRun(); record.write_claim.released = null; record.active = true; f.writeRun(record);
  const r = repeated(f); assert.strictEqual(r.claim.state, 'held');
  assert(!r.provenResults.some(p => p.kind === 'claim-release')); assert(!r.artifacts.some(a => a.kind === 'claim-bundle'));
});
test('bound decisions/acceptances survive and sources distinguish stale/missing/unreadable', f => {
  f.bind(f.id); const source = path.join(f.project, '.gsd', 'tasks', f.id, `${f.id}-PLAN.md`);
  personal.saveCheckpoint({ ...f.options, id: f.id, intent: 'checkpoint', checkpoint: {
    acceptances: [{ text: 'Plano aprovado', source, resolved: true }], pending: [{ text: 'Decisão pendente', source }],
    lastResult: [{ text: 'Resultado parcial', source }], nextAction: [{ text: 'Inspecionar evidências', source }],
  } });
  let r = repeated(f); assert.strictEqual(r.acceptances[0].text, 'Plano aprovado'); assert.strictEqual(r.pendingDecisions.length, 1);
  assert.strictEqual(r.provenResults.find(p => p.kind === 'personal-checkpoint').evidence.resolved, false);
  assert.notStrictEqual(r.continuity.workStatus, 'completed');
  assert.strictEqual(r.continuity.checkpoint.nextAction[0].text, 'Inspecionar evidências');
  fs.appendFileSync(source, '\nchanged'); r = repeated(f); assert(hasSource(r, 'checkpoint/pending', 'stale'));
  const read = fs.readFileSync;
  try {
    fs.readFileSync = function(file, ...args) { if (sameFile(file, source)) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return read.call(this, file, ...args); };
    r = f.inspect(); assert(hasSource(r, 'checkpoint/pending', 'unreadable'));
  } finally { fs.readFileSync = read; }
  fs.unlinkSync(source); r = repeated(f); assert(hasSource(r, 'checkpoint/pending', 'missing'));
});
test('valid current checkpoint can return zero without implying completion', f => {
  f.bind(f.id); const source = path.join(f.project, '.gsd', 'tasks', f.id, `${f.id}-PLAN.md`);
  personal.saveCheckpoint({ ...f.options, id: f.id, intent: 'checkpoint', checkpoint: { nextAction: [{ text: 'Continuar', source }] } });
  const r = repeated(f); assert.strictEqual(r.status, 'ok'); assert.strictEqual(r.continuity.workStatus, 'open');
});
test('personal store corruption cannot become explicit-inspection fallback', f => {
  f.bind(f.id); const file = path.join(f.home, '.forge-personal', 'context.json');
  fs.writeFileSync(file, '{bad'); assert(hasSource(repeated(f), 'personal-store', 'corrupt'));
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 99, projects: {} }));
  assert(hasSource(repeated(f), 'personal-store', 'schema-unsupported'));
});
test('run missing/corrupt/unreadable/schema mismatch remain distinct', f => {
  const original = fs.readFileSync(f.runFile);
  fs.writeFileSync(f.runFile, '{bad'); assert(hasSource(repeated(f), 'run', 'corrupt'));
  fs.writeFileSync(f.runFile, original); f.writeRun({ ...f.readRun(), id: 'TASK-002' });
  assert(hasSource(repeated(f), 'run-identity', 'schema-invalid'));
  fs.writeFileSync(f.runFile, original);
  const read = fs.readFileSync;
  try {
    fs.readFileSync = function(file, ...args) { if (path.basename(file) === path.basename(f.runFile)) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return read.call(this, file, ...args); };
    assert(hasSource(f.inspect(), 'run', 'unreadable'));
  } finally { fs.readFileSync = read; }
  fs.unlinkSync(f.runFile); assert(hasSource(repeated(f), 'run', 'missing'));
  assert.throws(() => f.inspect({ id: '../TASK-002' }), /invalid-arguments/);
  assert.throws(() => f.inspect({ id: 'I-20260923214113' }), /invalid-arguments/);
});
test('external manifest and checkpoint sources fail before external reads', f => {
  release(f, true); const record = f.readRun(); record.write_claim.released.evidence.bundle = f.otherHome; f.writeRun(record);
  assert(hasSource(repeated(f), 'claim-bundle', 'unsafe-path'));
  f.bind(f.id); const file = path.join(f.home, '.forge-personal', 'context.json');
  const store = JSON.parse(fs.readFileSync(file));
  Object.values(store.projects)[0].bindings[f.id].checkpoint.pending = [{ text: 'unsafe', source: path.join(f.otherHome, 'secret'), hash: 'a'.repeat(64), capturedAt: new Date().toISOString(), resolved: false }];
  fs.writeFileSync(file, JSON.stringify(store));
  const read = fs.readFileSync; let external = 0;
  try {
    fs.readFileSync = function(file, ...args) { if (String(file).startsWith(f.otherHome)) { external++; throw new Error('external'); } return read.call(this, file, ...args); };
    assert(hasSource(f.inspect(), 'personal-sources', 'unsafe-path')); assert.strictEqual(external, 0);
  } finally { fs.readFileSync = read; }
});
test('symlink payload is rejected before preview; no fake coverage on unavailable host', f => {
  const { bundle } = release(f, true); const payload = path.join(bundle, 'payload');
  fs.renameSync(payload, path.join(bundle, 'original-payload'));
  try { fs.symlinkSync(f.otherHome, payload, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { console.log(`SKIP symlink: ${error.code}`); return; } throw error; }
  assert(hasSource(repeated(f), 'claim-bundle', 'unsafe-path'));
});
test('foreign work sources are never opened; internal tokens are not serialized', f => {
  const other = f.work('TASK-002'); f.bind('TASK-002');
  f.writeRun({ ...f.readRun(), owner_token: 'PRIVATE-TOKEN', private: { token: 'PRIVATE-TOKEN' } });
  const read = fs.readFileSync; let foreign = 0;
  try {
    fs.readFileSync = function(file, ...args) { if (String(file).includes('TASK-002') || String(file) === other.source) { foreign++; throw new Error('foreign'); } return read.call(this, file, ...args); };
    const r = f.inspect(); assert.strictEqual(foreign, 0);
    assert(!JSON.stringify(r).includes('PRIVATE-TOKEN')); assert(!diagnostic.renderRecovery(r).includes('owner_token'));
  } finally { fs.readFileSync = read; }
});
test('controller published before phase advancement and committed are not global completion', f => {
  f.work('M005', 'milestone'); const key = 'transaction-key'; const unit = { type: 'execute-task', id: 'T01', key: 'execute-task/T01' };
  const publication = { protocol_version: controller.PROTOCOL_VERSION, idempotency_key: key, milestone: 'M005', unit: unit.key, status: 'succeeded', owner_token: 'PRIVATE-TOKEN' };
  const transaction = { ...publication, unit, phase: 'intent', action: 'complete', result: publication, boundary: null };
  const file = controller.transactionFile(f.project, key); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(transaction));
  const result = controller.resultFile(f.project, key); fs.mkdirSync(path.dirname(result), { recursive: true }); fs.writeFileSync(result, JSON.stringify(publication));
  let r = repeated(f, { id: 'M005', controllerKey: key });
  assert(r.provenResults.some(p => p.kind === 'controller-result-published')); assert.strictEqual(r.status, 'partial');
  assert(!JSON.stringify(r).includes('PRIVATE-TOKEN'));
  fs.writeFileSync(file, JSON.stringify({ ...transaction, phase: 'committed' }));
  r = repeated(f, { id: 'M005', controllerKey: key }); assert.strictEqual(r.controller.transactionCommitted, true); assert.strictEqual(r.controller.globalCompletion, 'unproven');
  fs.writeFileSync(file, JSON.stringify({ ...transaction, milestone: 'M006' }));
  const read = fs.readFileSync; let resultReads = 0;
  try {
    fs.readFileSync = function(target, ...args) { if (String(target) === result) resultReads++; return read.call(this, target, ...args); };
    r = f.inspect({ id: 'M005', controllerKey: key }); assert(hasSource(r, 'controller-identity', 'schema-invalid')); assert.strictEqual(resultReads, 0);
  } finally { fs.readFileSync = read; }
  assert.strictEqual(f.inspect({ controllerKey: key }).controller.reason, 'standalone-task');
});
test('CLI text/JSON and conflicts preserve fixture bytes, reject before mutation', f => {
  const doctor = path.join(__dirname, 'forge-doctor.js');
  const cli = args => spawnSync(process.execPath, [doctor, ...args, '--cwd', f.project], { env: f.env(), encoding: 'utf8', windowsHide: true });
  const before = inventory(f.root);
  for (const flags of [[], ['--json']]) {
    const out = cli(['--diagnose-recovery', f.id, ...flags]); assert.strictEqual(out.status, 1, out.stderr);
    if (flags.length) assert.strictEqual(JSON.parse(out.stdout).continuity.state, 'unproven');
    else assert(out.stdout.includes('Próximo passo seguro:'));
  }
  for (const flags of [['--fix'], ['--apply'], ['--confirm-owner-stopped'], ['--confirm-workspace-quiescent'], ['--recover-claim', f.id], ['--restore-claim', f.id], ['--check', 'all'], ['--regen-projection'], ['--help'], ['--json', 'false'], ['extra'], ['--diagnose-recovery', f.id]]) {
    const out = cli(['--diagnose-recovery', f.id, ...flags]); assert.strictEqual(out.status, 2, `${flags}: ${out.stdout} ${out.stderr}`);
  }
  for (const flags of [['--diagnose-recovery'], ['--controller-key', 'key'], ['--diagnose-recovery', '../escape']]) assert.strictEqual(cli(flags).status, 2);
  assert.deepStrictEqual(inventory(f.root), before);
});

test('R1 recaptured acceptance clears current uncertainty but keeps historical evidence', f => {
  f.bind(f.id); const file = path.join(f.project, '.gsd', 'tasks', f.id, `${f.id}-PLAN.md`);
  const save = () => personal.saveCheckpoint({ ...f.options, id: f.id, intent: 'checkpoint', checkpoint: {
    acceptances: [{ text: 'Plano aprovado', source: file, resolved: true }],
  } });
  assert.strictEqual(save().status, 'ok'); fs.appendFileSync(file, '\nchanged');
  assert.strictEqual(repeated(f).status, 'partial'); assert.strictEqual(save().status, 'ok');
  const r = repeated(f); assert.strictEqual(r.status, 'ok'); assert.strictEqual(r.acceptances.length, 2);
  assert.strictEqual(r.acceptances[0].validity, 'stale'); assert.strictEqual(r.acceptances[1].validity, 'current');
});
test('O1 registry writer defaults and legacy absent address retain bound checkpoint', f => {
  runs.add(f.project, { id: f.id, kind: 'task', session_id: 'isolated-fixture', active: false });
  assert.strictEqual(f.readRun().project, null); f.bind(f.id);
  const file = path.join(f.project, '.gsd', 'tasks', f.id, `${f.id}-PLAN.md`);
  personal.saveCheckpoint({ ...f.options, id: f.id, intent: 'checkpoint', checkpoint: { nextAction: [{ text: 'Continuar', source: file }] } });
  const record = f.readRun();
  for (const value of [null, undefined, '']) {
    f.writeRun({ ...record, project: value }); const r = repeated(f);
    assert.strictEqual(r.continuity.bound, true); assert.strictEqual(r.continuity.checkpoint.nextAction[0].text, 'Continuar');
    assert.strictEqual(r.status, 'ok', JSON.stringify(r));
  }
  for (const value of [false, 7, {}, './relative', f.otherHome]) {
    f.writeRun({ ...record, project: value }); assert(hasSource(repeated(f), 'run-identity', 'schema-invalid'));
  }
});
test('R2 Git worktree alias resolves owner before any .gsd/run read', f => {
  const git = args => {
    const result = spawnSync('git', args, { cwd: f.project, encoding: 'utf8', windowsHide: true });
    assert.strictEqual(result.status, 0, result.stderr); return result;
  };
  git(['init']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  const wt = path.join(f.root, 'validated-alias'); git(['worktree', 'add', '-b', 'fixture-recovery-alias', wt]);
  f.writeRun({ ...f.readRun(), branch: 'fixture-recovery-alias', worktrees: [{ repo: f.project, path: wt }] }); f.bind(f.id);
  const file = path.join(f.project, '.gsd', 'tasks', f.id, `${f.id}-PLAN.md`);
  personal.saveCheckpoint({ ...f.options, id: f.id, intent: 'checkpoint', checkpoint: {
    acceptances: [{ text: 'Aceito', source: file, resolved: true }], pending: [{ text: 'Decidir', source: file }],
    lastResult: [{ text: 'Resultado parcial', source: file }],
  } });
  const inspect = () => repeated(f, { project: undefined, cwd: wt });
  let r = inspect(); assert.strictEqual(r.continuity.bound, true); assert.strictEqual(r.acceptances[0].text, 'Aceito');
  assert.strictEqual(r.pendingDecisions[0].text, 'Decidir'); assert(r.artifacts.some(a => a.kind === 'plan'));
  assert(r.provenResults.some(p => p.kind === 'personal-checkpoint'));
  // A local .gsd must not override a validated personal alias's owner.
  fs.mkdirSync(path.join(wt, '.gsd')); r = inspect(); assert.strictEqual(r.continuity.bound, true);
  const cli = spawnSync(process.execPath, [path.join(__dirname, 'forge-doctor.js'), '--diagnose-recovery', f.id, '--cwd', wt, '--json'], { env: f.env(), encoding: 'utf8', windowsHide: true });
  assert.strictEqual(cli.status, 1); assert.strictEqual(JSON.parse(cli.stdout).continuity.bound, true);
});
test('registered worktree behind a project child link remains valid only through its own root', f => {
  const git = args => {
    const out = spawnSync('git', args, { cwd: f.project, encoding: 'utf8', windowsHide: true });
    assert.strictEqual(out.status, 0, out.stderr);
  };
  git(['init']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  const external = path.join(f.root, 'external'); fs.mkdirSync(external);
  const wt = path.join(external, 'wt'); const link = path.join(f.project, 'link');
  git(['worktree', 'add', '-b', 'fixture-linked-worktree', wt]);
  try { fs.symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { console.log(`SKIP linked worktree: ${error.code}`); return; } throw error; }
  const alias = path.join(link, 'wt');
  f.writeRun({ ...f.readRun(), branch: 'fixture-linked-worktree', worktrees: [{ repo: f.project, path: alias }] });
  release(f, true, alias);
  assert.strictEqual(repeated(f).artifacts.find(a => a.kind === 'claim-bundle').integrity, 'verified');
  const record = f.readRun();
  f.writeRun({ ...record, branch: 'wrong-branch' });
  assert(hasSource(repeated(f), 'claim-bundle', 'unsafe-path'));
  f.writeRun({ ...record, worktrees: [] });
  assert(hasSource(repeated(f), 'claim-bundle', 'unsafe-path'));
});
test('R4 undeclared publications are unread; later valid boundary is superseded', f => {
  f.work('M005', 'milestone'); const key = 'old-key'; const unit = { type: 'execute-task', id: 'T01', key: 'execute-task/T01' };
  const boundary = { protocol_version: controller.PROTOCOL_VERSION, idempotency_key: 'new-key', milestone: 'M005', unit: unit.key,
    kind: 'completed', outcome: 'succeeded', handoff_ready: true };
  const transaction = { protocol_version: controller.PROTOCOL_VERSION, idempotency_key: key, milestone: 'M005', unit, phase: 'committed', action: 'begin', result: null, boundary: null };
  const file = controller.transactionFile(f.project, key); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(transaction));
  const boundaryFile = controller.boundaryFile(f.project, unit); fs.mkdirSync(path.dirname(boundaryFile), { recursive: true }); fs.writeFileSync(boundaryFile, JSON.stringify(boundary));
  const read = fs.readFileSync; let reads = 0;
  try {
    fs.readFileSync = function(target, ...args) { if (sameFile(target, boundaryFile)) reads++; return read.call(this, target, ...args); };
    const r = f.inspect({ id: 'M005', controllerKey: key }); assert.strictEqual(reads, 0); assert(!r.sources.some(s => s.name.startsWith('controller-boundary')));
  } finally { fs.readFileSync = read; }
  fs.writeFileSync(file, JSON.stringify({ ...transaction, action: 'complete', boundary: { ...boundary, idempotency_key: key } }));
  let r = repeated(f, { id: 'M005', controllerKey: key }); assert(hasSource(r, 'controller-boundary-identity', 'superseded'));
  assert(!r.provenResults.some(p => p.kind === 'controller-boundary-published'));
  fs.writeFileSync(boundaryFile, JSON.stringify({ ...boundary, milestone: 'M006' }));
  r = repeated(f, { id: 'M005', controllerKey: key }); assert(hasSource(r, 'controller-boundary-identity', 'schema-invalid'));
});
test('R6 unexpected CLI failure returns sanitized partial without stack/token', f => {
  const doctor = path.join(__dirname, 'forge-doctor.js');
  for (const json of [false, true]) {
    const argv = [process.execPath, doctor, '--diagnose-recovery', f.id, '--cwd', f.project, ...(json ? ['--json'] : [])];
    const code = `require(${JSON.stringify(path.join(__dirname, 'forge-recovery-diagnostic.js'))}).inspectRecovery=()=>{throw new Error('PRIVATE-TOKEN')};process.argv=${JSON.stringify(argv)};require('module')._load(${JSON.stringify(doctor)},null,true);`;
    const out = spawnSync(process.execPath, ['-e', code], { env: f.env(), encoding: 'utf8', windowsHide: true });
    assert.strictEqual(out.status, 1, out.stderr); assert(!`${out.stdout}${out.stderr}`.includes('PRIVATE-TOKEN')); assert.strictEqual(out.stderr, '');
    if (json) {
      const report = JSON.parse(out.stdout);
      assert.deepStrictEqual(Object.keys(report).sort(), Object.keys(diagnostic.createRecoveryReport(f.id)).sort());
      assert(hasSource(report, 'diagnostic', 'internal-error')); assert(report.uncertainties.length);
      assert(!Number.isNaN(Date.parse(report.observedAt))); assert(report.nextSafeStep);
      for (const field of ['sources', 'uncertainties', 'provenResults', 'artifacts', 'pendingDecisions', 'acceptances', 'uncovered']) assert(Array.isArray(report[field]));
    } else {
      assert(out.stdout.includes('Estado: parcial')); assert(out.stdout.includes('falha interna'));
      assert(out.stdout.includes('Próximo passo seguro:'));
    }
  }
});
test('R7 key limit uses UTF-8/base64 bytes and I/O errors retain their category', f => {
  assert.strictEqual(diagnostic.validKey('x'.repeat(187)), true); assert.strictEqual(diagnostic.validKey('x'.repeat(188)), false);
  assert.strictEqual(diagnostic.validKey('é'.repeat(94)), false); assert.strictEqual(diagnostic.validKey('é'.repeat(93)), true);
  for (const code of ['ENAMETOOLONG', 'ENOTDIR', 'ELOOP', 'EMFILE', 'EBUSY']) {
    const read = fs.readFileSync;
    try {
      fs.readFileSync = function(target, ...args) { if (sameFile(target, f.runFile)) throw Object.assign(new Error('private'), { code }); return read.call(this, target, ...args); };
      assert(hasSource(f.inspect(), 'run', code === 'ENAMETOOLONG' ? 'invalid-name' : 'unreadable'));
    } finally { fs.readFileSync = read; }
  }
  const cli = spawnSync(process.execPath, [path.join(__dirname, 'forge-doctor.js'), '--diagnose-recovery', f.id, '--controller-key', 'x'.repeat(300), '--cwd', f.project], { env: f.env(), encoding: 'utf8', windowsHide: true });
  assert.strictEqual(cli.status, 2);
});
test('R8 record/manifest changes during preview cannot verify the earlier artifact', f => {
  const { bundle } = release(f, true); const originalRun = fs.readFileSync(f.runFile);
  const manifestFile = path.join(bundle, 'manifest.json'); const originalManifest = fs.readFileSync(manifestFile);
  const otherBundle = path.join(path.dirname(bundle), 'other-attempt'); fs.cpSync(bundle, otherBundle, { recursive: true });
  const restore = recovery.restore;
  try {
    recovery.restore = (cwd, id, options) => {
      const record = f.readRun(); record.write_claim.released.evidence.bundle = path.relative(f.project, otherBundle); f.writeRun(record);
      return restore(cwd, id, options);
    };
    let r = f.inspect(); assert(hasSource(r, 'claim-preview', 'snapshot-changed')); assert.strictEqual(r.artifacts.find(a => a.kind === 'claim-bundle').integrity, 'unverified');
    fs.writeFileSync(f.runFile, originalRun);
    recovery.restore = (cwd, id, options) => {
      const preview = restore(cwd, id, options); fs.appendFileSync(manifestFile, '\n'); return preview;
    };
    r = f.inspect(); assert(hasSource(r, 'claim-preview', 'snapshot-changed')); assert.strictEqual(r.artifacts.find(a => a.kind === 'claim-bundle').integrity, 'unverified');
  } finally { recovery.restore = restore; fs.writeFileSync(f.runFile, originalRun); fs.writeFileSync(manifestFile, originalManifest); }
  assert.strictEqual(repeated(f).artifacts.find(a => a.kind === 'claim-bundle').integrity, 'verified');
});
test('final R2 phase failures keep observed evidence and continue independent inspections', f => {
  f.id = 'M005'; const work = f.work(f.id, 'milestone');
  f.runFile = path.join(f.project, '.gsd', 'forge', 'runs', `${f.id}.json`);
  release(f, true); f.bind(f.id);
  personal.saveCheckpoint({ ...f.options, id: f.id, intent: 'checkpoint', checkpoint: {
    acceptances: [{ text: 'Plano aceito', source: work.source, resolved: true }],
    lastResult: [{ text: 'Resultado parcial válido', source: work.source }],
  } });
  fs.writeFileSync(path.join(work.dir, `${f.id}-SUMMARY.md`), 'Resumo preservado');
  const key = 'isolated-phases'; const unit = { type: 'execute-task', id: 'T01', key: 'execute-task/T01' };
  const publication = { protocol_version: controller.PROTOCOL_VERSION, idempotency_key: key, milestone: f.id, unit: unit.key, status: 'succeeded' };
  const transactionFile = controller.transactionFile(f.project, key); fs.mkdirSync(path.dirname(transactionFile), { recursive: true });
  fs.writeFileSync(transactionFile, JSON.stringify({ ...publication, unit, action: 'complete', phase: 'intent', result: publication, boundary: null }));
  const resultFile = controller.resultFile(f.project, key); fs.mkdirSync(path.dirname(resultFile), { recursive: true }); fs.writeFileSync(resultFile, JSON.stringify(publication));
  const cases = [
    [personal, 'readPersonalSnapshot', 'personal'],
    [require('./forge-claim-stuck'), 'classifyStuck', 'claim'],
    [recovery, 'restore', 'claim'],
    [controller, 'transactionFile', 'controller'],
  ];
  for (const [module, method, phase] of cases) {
    const original = module[method];
    try {
      module[method] = () => { throw new Error('PRIVATE-TOKEN: unexpected failure'); };
      const r = repeated(f, { controllerKey: key });
      assert.strictEqual(r.status, 'partial'); assert(hasSource(r, phase, 'internal-error'));
      assert(hasSource(r, 'run', 'current')); assert(r.artifacts.some(a => a.kind === 'summary'));
      if (phase !== 'personal') { assert.strictEqual(r.acceptances[0].text, 'Plano aceito'); assert(r.provenResults.some(p => p.kind === 'personal-checkpoint')); }
      if (method !== 'classifyStuck') assert(r.provenResults.some(p => p.kind === 'claim-release'));
      if (phase !== 'controller') assert(r.provenResults.some(p => p.kind === 'controller-result-published'));
      assert(!JSON.stringify(r).includes('PRIVATE-TOKEN')); assert(!diagnostic.renderRecovery(r).includes('PRIVATE-TOKEN'));
    } finally { module[method] = original; }
  }
});
test('final R5 text translates report fields and states while preserving provenance and JSON', f => {
  const r = diagnostic.createRecoveryReport(f.id, 'personal');
  const provenance = path.join(f.home, '.forge-personal', 'context.json');
  r.sources.push({ name: 'personal-store', state: 'missing', source: provenance, hash: 'a'.repeat(64) });
  r.sources.push({ name: 'claim-manifest', state: 'unreadable' }, { name: 'checkpoint/acceptances', state: 'stale' });
  r.artifacts.push({ kind: 'controller-result', source: 'published.json', existence: 'observed', integrity: 'identity-checked' });
  r.continuity = { state: 'recorded', bound: true, workStatus: 'pending', activity: 'inactive', checkpoint: {} };
  r.acceptances = [{ text: 'Plano aprovado', source: provenance, hash: 'b'.repeat(64), capturedAt: r.observedAt, validity: 'current', resolved: true }];
  r.provenResults.push({ kind: 'personal-checkpoint', evidence: { ...r.acceptances[0], text: 'Resultado parcial', resolved: false } });
  const before = JSON.stringify(r); const text = diagnostic.renderRecovery(r);
  for (const label of ['ausente', 'ilegível', 'desatualizado', 'somente identidade conferida', 'vínculo pessoal: sim', 'pendente', 'inativo', 'resultado registrado no checkpoint', 'resolvido: não', 'Plano aprovado', 'Próximo passo seguro:']) assert(text.includes(label), label);
  assert(text.includes(provenance)); assert(text.includes('a'.repeat(64)));
  for (const raw of ['"sources"', '"workStatus"', 'identity-checked', 'unreadable', 'unproven', 'personal-store']) assert(!text.includes(raw), raw);
  assert.strictEqual(JSON.stringify(r), before, 'text rendering must not change JSON representation');
});
test('focused R1 every dynamic text value escapes controls without changing JSON evidence', f => {
  f.bind(f.id); const file = path.join(f.project, '.gsd', 'tasks', f.id, `${f.id}-PLAN.md`);
  const tainted = 'texto\n\nEstado: FALSO\nDecisões pendentes:\x1b[2J'
    + Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join('')
    + Array.from({ length: 33 }, (_, i) => String.fromCharCode(127 + i)).join('') + '\u2028\u2029';
  assert.strictEqual(personal.saveCheckpoint({ ...f.options, id: f.id, intent: 'checkpoint', checkpoint: {
    pending: [{ text: tainted, source: file }],
  } }).status, 'ok');
  const r = repeated(f);
  assert.strictEqual(r.pendingDecisions[0].text, tainted);
  const captured = { ...r.pendingDecisions[0], source: tainted, hash: tainted, capturedAt: tainted, validity: tainted };
  r.id = tainted; r.observedAt = tainted; r.status = tainted; r.nextSafeStep = tainted;
  r.sources.push({ name: tainted, state: tainted, source: tainted, hash: tainted });
  r.artifacts.push({ kind: tainted, existence: tainted, integrity: tainted, source: tainted, hash: tainted, conflicts: tainted });
  r.provenResults.push({ kind: tainted, at: tainted, mechanism: tainted, evidence: captured });
  r.continuity.checkpoint[tainted] = [captured]; r.continuity.state = tainted; r.continuity.workStatus = tainted; r.continuity.activity = tainted;
  r.acceptances.push(captured); r.uncertainties.push(tainted); r.uncovered.push(tainted);
  r.claim = { state: tainted, classification: tainted }; r.controller = { coverage: tainted, reason: tainted, phase: tainted, globalCompletion: tainted };
  const before = JSON.stringify(r); const output = diagnostic.renderRecovery(r);
  assert(!/[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]/.test(output));
  assert(!output.includes('\nEstado: FALSO')); assert(output.includes('\\u000a')); assert(output.includes('\\u001b[2J'));
  for (const escape of ['\\u007f', '\\u0085', '\\u009f', '\\u2028', '\\u2029']) assert(output.includes(escape));
  assert.strictEqual(JSON.stringify(r), before); assert.strictEqual(JSON.parse(before).pendingDecisions[0].text, tainted);
});
test('focused R2 unobserved and incomplete phases never assert an empty decision list', f => {
  const section = (r, heading) => diagnostic.renderRecovery(r).split(`\n${heading}:\n`)[1].split('\n\n')[0];
  const unknown = r => {
    for (const heading of ['Decisões pendentes', 'Aceites registrados', 'Resultado comprovado']) {
      assert(section(r, heading).includes('Observação incompleta'), heading);
      assert(!section(r, heading).includes('Nenhum registro'), heading);
    }
  };
  unknown(diagnostic.createRecoveryReport(f.id, 'diagnostic'));
  const bytes = fs.readFileSync(f.runFile); fs.unlinkSync(f.runFile); unknown(f.inspect()); fs.writeFileSync(f.runFile, '{bad'); unknown(f.inspect()); fs.writeFileSync(f.runFile, bytes);
  f.bind(f.id); const storeFile = path.join(f.home, '.forge-personal', 'context.json'); const store = fs.readFileSync(storeFile);
  fs.writeFileSync(storeFile, '{bad'); unknown(f.inspect()); fs.writeFileSync(storeFile, store);
  const read = personal.readPersonalSnapshot;
  try {
    personal.readPersonalSnapshot = () => { throw new Error('injected'); }; unknown(f.inspect());
    // Deterministic late-phase failure: already assigned continuity survives,
    // but coverage must make the unfinished decision list explicitly unknown.
    personal.readPersonalSnapshot = options => {
      const snapshot = read(options);
      snapshot.works[0].checkpoint.pending = [];
      snapshot.works[0].checkpoint.pending.filter = () => { throw new Error('late phase'); };
      return snapshot;
    };
    const late = f.inspect(); assert.strictEqual(late.coverage.personal, 'incomplete'); assert.strictEqual(late.continuity.bound, true); unknown(late);
  } finally { personal.readPersonalSnapshot = read; }
  const observed = repeated(f); assert.strictEqual(observed.coverage.personal, 'observed');
  assert(section(observed, 'Decisões pendentes').includes('Nenhum registro nas fontes observadas.'));
  assert(section(observed, 'Aceites registrados').includes('Nenhum registro nas fontes observadas.'));
});
test('focused R4 only known source-state pairs are translated; prose and paths stay intact', f => {
  const r = diagnostic.createRecoveryReport(f.id);
  const prose = ['Inspecionar C:/repo/claim: conteúdo: outro/estado', 'Controlador interrompido: publicação pode preceder a fase; não repetir efeitos pelo diagnóstico.',
    'Reserva de escrita travada; exige inspeção e decisão na autoridade original.', 'run: missing; detalhe genérico / caminho'];
  r.sources.push({ name: 'run', state: 'missing' }); r.uncertainties.push('run: missing', ...prose);
  r.sources.push({ name: 'nome/desconhecido', state: 'missing' }); r.uncertainties.push('nome/desconhecido: missing');
  const text = diagnostic.renderRecovery(r);
  assert(text.includes('registro do trabalho: ausente'));
  for (const line of [...prose, 'nome/desconhecido: missing']) assert(text.includes(line), line);
  assert(!text.includes('C: / repo')); assert(!text.includes('Claim:'));
  release(f, true); const record = f.readRun(); record.active = true; record.write_claim.released = null; f.writeRun(record);
  const stuck = diagnostic.renderRecovery(f.inspect()); assert(stuck.includes('Reserva de escrita travada;')); assert(!stuck.includes('Claim:'));
});
if (!process.env.FORGE_TEST_RECOVERY_ANCESTOR_ALIAS) test('OS ancestor aliases preserve diagnosis and child-symlink rejection across the suite', f => {
  const realTemp = path.join(f.root, 'real-temp'); const aliasTemp = path.join(f.root, 'alias-temp');
  fs.mkdirSync(realTemp);
  try { fs.symlinkSync(realTemp, aliasTemp, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { console.log(`SKIP ancestor alias: ${error.code}`); return; } throw error; }
  const code = `require('os').tmpdir=()=>${JSON.stringify(aliasTemp)};require(${JSON.stringify(__filename)});`;
  const out = spawnSync(process.execPath, ['-e', code], {
    env: { ...f.env(), FORGE_TEST_RECOVERY_ANCESTOR_ALIAS: '1' }, encoding: 'utf8', windowsHide: true,
  });
  assert.strictEqual(out.status, 0, `${out.stdout}\n${out.stderr}`);
  assert(out.stdout.includes('PASS symlink payload is rejected'));
  assert(!out.stdout.includes('SKIP symlink'), 'child-symlink rejection must execute with supported ancestor aliases');
});
console.log(`${passed} recovery diagnostic tests passed`);
