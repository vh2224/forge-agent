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
function release(f, dirty = false) {
  const code = path.join(f.project, 'code'); fs.mkdirSync(code);
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

test('unbound ID and isolated SUMMARY do not adopt or conclude; retry is read-only', f => {
  fs.writeFileSync(path.join(f.project, '.gsd', 'tasks', f.id, `${f.id}-SUMMARY.md`), '---\nstatus: DONE\n---');
  const r = repeated(f);
  assert.strictEqual(r.continuity.bound, false); assert.strictEqual(r.continuity.state, 'unproven');
  assert.notStrictEqual(r.continuity.workStatus, 'completed'); assert.strictEqual(r.status, 'partial');
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
  assert.strictEqual(r.continuity.checkpoint.nextAction[0].text, 'Inspecionar evidências');
  fs.appendFileSync(source, '\nchanged'); r = repeated(f); assert(hasSource(r, 'checkpoint/pending', 'stale'));
  const read = fs.readFileSync;
  try {
    fs.readFileSync = function(file, ...args) { if (path.relative(file, source) === '') throw Object.assign(new Error('denied'), { code: 'EACCES' }); return read.call(this, file, ...args); };
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
console.log(`${passed} recovery diagnostic tests passed`);
