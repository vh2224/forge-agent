'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { fixture } = require('./forge-personal-context.test');
const helpers = require('./forge-cli-helpers');
const personal = require('./forge-personal-context');
const f = fixture();
try {
  f.work('M001', 'milestone'); f.work('M002', 'milestone', true);
  const first = helpers.resolveRunFromArgs(f.project, '', f.options);
  assert.strictEqual(first.reason, 'no-bindings');
  assert.strictEqual(first.status, 'none');
  assert(!fs.existsSync(path.join(f.home, '.forge-personal')));
  const activeFile = path.join(f.project, '.gsd/forge/runs/M002.json'), activeBefore = fs.readFileSync(activeFile);
  assert.strictEqual(helpers.resolveRunFromArgs(f.project, 'M002', f.options).run_id, 'M002');
  assert.strictEqual(helpers.resolveRunFromArgs(f.project, 'M002', f.options).status, 'resume', 'active legacy classification remains unchanged');
  assert(fs.readFileSync(activeFile).equals(activeBefore));
  assert(!fs.existsSync(path.join(f.home, '.forge-personal')), 'ID resolution/inspection is not binding');
  const legacyFile = path.join(f.project, '.gsd', 'forge', 'runs', 'M001.json');
  const legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
  legacy.write_claim = { generation: 'retained', released: false, writes: ['src/file.js'] };
  legacy.touched = ['src/file.js'];
  fs.writeFileSync(legacyFile, JSON.stringify(legacy));
  const retained = fs.readFileSync(legacyFile);
  const refusedLegacy = helpers.resolveRunFromArgs(f.project, 'M001', f.options);
  assert.strictEqual(refusedLegacy.status, 'refuse');
  assert.strictEqual(refusedLegacy.reason, 'owner-resume-binding-unknown', 'inactive legacy binding is refused already by resolve-args');
  const cliLegacy = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'forge-cli-helpers.js'), '--resolve-args', '--args', 'M001', '--cwd', f.project], { env: f.env(), encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.strictEqual(cliLegacy.status, 0, cliLegacy.stderr); // CLI status protocol, consumed by the skills' case guard
  assert.strictEqual(JSON.parse(cliLegacy.stdout).status, 'refuse');
  assert.strictEqual(JSON.parse(cliLegacy.stdout).reason, 'owner-resume-binding-unknown');
  const runs = require('./forge-runs');
  assert.throws(() => runs.add(f.project, { id: 'M001', kind: 'milestone', session_id: 'replacement' }), { code: 'ERUNEXISTS' });
  assert(fs.readFileSync(legacyFile).equals(retained), 'explicit inactive legacy run and claim remain byte-identical');
  const observedSession = process.env.CODEX_THREAD_ID;
  try {
    process.env.CODEX_THREAD_ID = 'synthetic-inspector';
    assert.throws(() => runs.inspectOwnerResume(f.project, 'M001', { hostRuntime: 'codex', expectedSession: 'synthetic-inspector' }), { code: 'owner-resume-binding-unknown' });
  } finally { if (observedSession === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = observedSession; }
  f.bind('M001');
  assert.strictEqual(helpers.resolveRunFromArgs(f.project, '', f.options).run_id, 'M001', 'inactive bound milestone beats active peer');
  assert.strictEqual(helpers.resolveRunFromArgs(f.project, '', f.options).status, 'refuse');
  assert.strictEqual(helpers.resolveRunFromArgs(f.project, '', f.options).reason, 'owner-resume-binding-unknown');
  assert(fs.readFileSync(legacyFile).equals(retained), 'personal selection never adopts or rewrites inactive legacy claims');
  fs.unlinkSync(path.join(f.project, '.gsd', 'forge', 'runs', 'M001.json'));
  assert.strictEqual(helpers.resolveRunFromArgs(f.project, '', f.options).status, 'activate-new');
  f.work('TASK-001');
  assert.strictEqual(helpers.resolveRunFromArgs(f.project, 'TASK-001', f.options).status, 'refuse');
  assert.strictEqual(helpers.resolveRunFromArgs(f.project, 'TASK-001', f.options).reason, 'owner-resume-binding-unknown');
  fs.unlinkSync(path.join(f.project, '.gsd', 'forge', 'runs', 'TASK-001.json'));
  assert.strictEqual(helpers.resolveRunFromArgs(f.project, 'TASK-001', f.options).status, 'resume');
  assert.strictEqual(helpers.resolveRunFromArgs(f.project, 'TASK-999', f.options).status, 'error');
  f.bind('M002');
  assert.strictEqual(helpers.resolveRunFromArgs(f.project, '', f.options).status, 'refuse');
  assert.strictEqual(personal.selectPersonalWork(f.options).reason, 'selection-required');
  assert(helpers.listActiveSummary(f.project).includes('M002'), 'global technical guard remains global');
  assert.strictEqual(helpers.resolveRunFromArgs(f.project, '../M001', f.options).status, 'error');
  const m3 = f.work('M003', 'milestone');
  // Prepare the milestone artifacts, without pre-registering the run being created.
  fs.unlinkSync(path.join(f.project, '.gsd', 'forge', 'runs', 'M003.json'));
  const record = helpers.activateRun(f.project, { ...f.options, id: 'M003', kind: 'milestone', session_id: 'synthetic' });
  assert.strictEqual(record.id, 'M003');
  assert(personal.readPersonalSnapshot(f.options).works.some(w => w.id === 'M003'));
  assert(fs.existsSync(m3.source));
  const known = fixture();
  try {
    known.work('M004', 'milestone');
    const file = path.join(known.project, '.gsd/forge/runs/M004.json');
    const row = { ...JSON.parse(fs.readFileSync(file)), session_id: 'known-native-owner', host_runtime: 'codex', owner_session_source: 'CODEX_THREAD_ID',
      write_claim: { generation: 'retained-known', released: null, paths: ['src/file.js'] }, touched: ['src/file.js'] };
    fs.writeFileSync(file, JSON.stringify(row)); const before = fs.readFileSync(file);
    assert.strictEqual(runs.knownResumeBinding(Object.freeze(row)), true, 'same canonical pure predicate used by later owner inspection');
    assert.strictEqual(runs.knownResumeBinding({ ...row, owner_session_source: 'legacy-seed' }), false);
    assert.strictEqual(helpers.resolveRunFromArgs(known.project, 'M004', known.options).status, 'resume');
    known.bind('M004');
    assert.strictEqual(helpers.resolveRunFromArgs(known.project, '', known.options).status, 'resume');
    assert(fs.readFileSync(file).equals(before), 'known inactive resolution is classification only, never live owner attestation or claim transfer');
  } finally { known.cleanup(); }
  console.log('PASS cli helpers: explicit resolution, personal default, ambiguity, registration and global guards');
} finally { f.cleanup(); }
