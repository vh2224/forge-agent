'use strict';

// Focused regression suite for the issue 440 review-fix S02 corrections (R1, R2, R4,
// R5). Everything runs in temporary laboratories removed in finally; the transport
// is synthetic (`mock`): no provider, account, network or real owner is touched.
//   R1  authenticated custody-failed reaches the Claude adapter as a pre-transport
//       failure (real Windows CreateProcessW failure on a readable invalid image).
//   R2  a failed external refusal recording stays repairable on the same classification.
//   R4  a pending-window owner event is retried once the window is free.
//   R5  SVN property changes are refused before any backup/reset (real svnadmin lab).
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const abandon = require('./forge-attempt-abandon');
const recovery = require('./forge-attempt-recovery');
const roots = require('./forge-code-roots');
const lab = require('./forge-code-roots.test');
const { activityRequest } = require('./forge-issues-429-432.test');
const { recoveryDispatchId } = require('./forge-recovery-dispatch-id');

const WIN = process.platform === 'win32';
const source = path.resolve(__dirname, '..');
const { digest } = roots;
const put = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const text = file => fs.readFileSync(file, 'utf8');
const LAB = fs.realpathSync.native(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'forge-i440-review-fix-')));
let counter = 0;
const dirOf = label => { const dir = path.join(LAB, `${label}-${++counter}`); fs.mkdirSync(dir); return dir; };
const results = [];

// ── R1: process-tree custody failure reaches the Claude adapter ─────────────
const binding = () => ({ dispatch_id: 'fixture-r1', fingerprint: 'fixture-fingerprint', recovery_identity_sha256: 'a'.repeat(64),
  unit: 'execute-task/T01', claim_generation: 1, lease_generation: 1 });
function loadAdapter() {
  const accounts = require('./forge-accounts'), original = accounts.resolveLaunch;
  accounts.resolveLaunch = () => ({ name: 'fixture-default', token: 'fixture-token-never-print' });
  const adapterPath = require.resolve('./forge-claude-sidecar');
  delete require.cache[adapterPath];
  try { return require(adapterPath); } finally { accounts.resolveLaunch = original; }
}
// The actual adapter, a synthetic command and the member-scope spawn hook; the real
// Claude provider is never invoked (the custody supervisor starts a local fixture).
async function invokeAdapter(spawnImpl) {
  const adapter = loadAdapter(), batch = require('./forge-execution-batch'), original = batch.currentMemberProcessScope;
  const work = dirOf('work'), fixture = path.join(LAB, 'claude-fixture.js');
  fs.writeFileSync(fixture, 'process.exit(0);\n');
  batch.currentMemberProcessScope = () => ({ spawn: spawnImpl });
  try {
    const value = await adapter.invokeClaudeSidecar({ cwd: work, prompt: 'review fix r1', model: 'claude-fixture-model', timeoutMs: 120000,
      sourceEnv: { ...process.env, FORGE_XLLM_CLAUDE_BIN: fixture }, terminateChild: child => child.kill('SIGKILL'),
      provisionalStoreRoot: path.join(LAB, 'private-terminals'), calibrationOptions: { userHome: path.join(LAB, 'calibration-home') } });
    return { value };
  } catch (error) { return { error }; } finally { batch.currentMemberProcessScope = original; }
}
const journalRows = file => text(file).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
async function r1CustodyFailure() {
  if (!WIN) { console.log('ENV r1 "custody supervisor is win32-only; the census path has no CreateProcessW stage"'); return; }
  const tree = require('./forge-process-tree');
  const status = tree.preparationStatus(await tree.prepareCustody());
  assert.equal(status.available, true, `native custody must run on win32 (blocker, never a skip): ${JSON.stringify(status)}`);
  const owner = dirOf('owner');
  // A readable "MZ" file passes the executable pre-validation, but CreateProcessW rejects it.
  const invalid = path.join(dirOf('image'), 'invalid-image.exe');
  fs.writeFileSync(invalid, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(254, 0x90)]));
  const reserved = path.join(LAB, 'exit-reserved.js');
  fs.writeFileSync(reserved, `process.exit(${tree.RESERVED_EXIT});\n`);
  const started = [];
  const startTree = (command, args, opts) => {
    const run = tree.startAttemptTree({ command, args, options: { cwd: opts.cwd, env: opts.env, stdio: opts.stdio, windowsHide: true },
      resultFile: path.join(dirOf('attempt'), 'result.json'), binding: binding(), roots: [owner] });
    started.push(run);
    return run;
  };
  try {
    // Public tree behaviour: the authenticated failure is branded on the consumed child.
    const direct = startTree(invalid, [], { cwd: owner, stdio: ['ignore', 'pipe', 'pipe'] });
    const seen = [], out = [];
    direct.child.on('error', error => seen.push(error));
    direct.child.stdout.on('data', chunk => out.push(chunk));
    await new Promise(resolve => direct.child.once('close', resolve));
    assert.equal(seen.length, 1, 'one branded error');
    assert.equal(tree.isCustodyFailure(seen[0]), true); assert.equal(seen[0].code, 'process-tree-custody-failed');
    const rows = journalRows(direct.tree.journalFile);
    assert.deepEqual(rows.map(row => row.event), ['supervisor-started', 'custody-failed']);
    assert.deepEqual([rows[1].stage, rows[1].root_started], ['root-create', 0]);
    assert.equal(out.length, 0, 'no root/provider output');
    const proof = direct.tree.prove();
    assert.deepEqual([proof.status, proof.reason_code], ['unknown', 'process-tree-custody-failed']);

    // Positive through the actual adapter: named pre-transport failure, provider never called.
    const failed = await invokeAdapter((cmd, args, opts) => startTree(invalid, [], opts).child);
    assert(failed.error, 'the adapter must fail');
    assert.equal(failed.error.code, 'claude-spawn-failed', failed.error.code);
    assert.equal(failed.error.provider_called, false); assert.equal(failed.error.custody_reason, 'process-tree-custody-failed');
    const adapterRun = started.at(-1), adapterRows = journalRows(adapterRun.tree.journalFile);
    assert(adapterRows.some(row => row.event === 'custody-failed' && row.root_started === 0));
    assert(!adapterRows.some(row => row.event === 'custody-established'), 'no root was ever created');

    // Negative: a legitimate child that exits with the same reserved number is a plain nonzero exit.
    const legit = await invokeAdapter((cmd, args, opts) => startTree(process.execPath, [reserved], opts).child);
    assert(legit.error); assert.equal(legit.error.code, 'claude-exit-nonzero', legit.error.code);
    assert.equal(legit.error.custody_reason, undefined); assert.notEqual(legit.error.provider_called, false);
    const legitRows = journalRows(started.at(-1).tree.journalFile);
    assert(legitRows.some(row => row.event === 'custody-established') && legitRows.some(row => row.event === 'root-exited' && row.exit_code === tree.RESERVED_EXIT));
    assert(!legitRows.some(row => row.event === 'custody-failed'));

    // Negative: a forged error, or a bare reserved exit from a plain child, is never branded.
    const forged = await invokeAdapter((cmd, args, opts) => {
      const child = cp.spawn(process.execPath, [reserved], { cwd: opts.cwd, env: opts.env, stdio: opts.stdio, windowsHide: true });
      setImmediate(() => child.emit('error', Object.assign(new Error('forged'), { code: 'process-tree-custody-failed' })));
      return child;
    });
    assert(forged.error); assert.equal(forged.error.code, 'claude-spawn-failed');
    assert.equal(forged.error.custody_reason, undefined); assert.notEqual(forged.error.provider_called, false);
    const bare = await invokeAdapter((cmd, args, opts) => cp.spawn(process.execPath, [reserved], { cwd: opts.cwd, env: opts.env, stdio: opts.stdio, windowsHide: true }));
    assert.equal(bare.error.code, 'claude-exit-nonzero'); assert.equal(bare.error.custody_reason, undefined);
  } finally { for (const run of started) { try { await run.tree.join(); } catch { /* best effort */ } try { run.child.kill(); } catch { /* gone */ } } }
}

// ── Recovery/abandon fixture (git roots, real controller, protected activity) ─
const SECTION = 'user:forge-routing-continuity', REFERENCE = 'conversation:issue-440-review-fix-fixture';
const MOCK_FAILURE = 'claude-exit-nonzero';
const HELPER = "const fs=require('fs'),p=require('path'),cp=require('child_process');const wait=Number(process.argv[1]);"
  + "for(const d of process.argv.slice(2))fs.writeFileSync(p.join(d,'same.txt'),'after\\n');"
  + "const g=cp.spawn(process.execPath,['-e','setTimeout(()=>{},'+wait+')'],{stdio:'ignore'});g.on('exit',()=>process.exit(0));";
function authority(f) {
  put(path.join(f.profile, '.codex/AGENTS.md'), `<!-- ${SECTION}:start -->\nFixture standing authorization.\n<!-- ${SECTION}:end -->\n`);
  const adapter = require('./forge-interaction').createRecoveryAuthorizationAdapter(observed => ({ ...observed,
    received: true, answer: 'authorize', resolved_at: Date.now() - 1000 }), { resolveProfile: () => f.profile });
  recovery.bindRecoveryAuthorization({ adapter, reference: REFERENCE, registration: { host: 'codex', section: SECTION } });
  return { adapter, reference: REFERENCE };
}
function liveAdapter(f) {
  return abandon.createAbandonmentAdapter({
    attestWriter: challenge => {
      if (!f.parent || f.parent.exitCode === null) return { status: 'running' };
      return { status: 'stopped', binding_sha256: digest(challenge), writer_identity: `mock-transport:${f.parent.pid}`,
        evidence_reference: 'mock:joined-transport-child', dispatch_id: challenge.dispatch_id, fingerprint: challenge.fingerprint,
        receipt_sha256: challenge.receipt_sha256, execution_identity_sha256: challenge.execution_identity_sha256,
        roots_sha256: challenge.roots_sha256, descendants_sha256: challenge.descendants_sha256 };
    },
    attestRoot: challenge => ({ binding_sha256: digest(challenge), status: 'stopped', root_id: challenge.root_id, evidence_reference: `mock:root:${challenge.root_id}` }),
    revalidateAttribution: challenge => ({ observed: true, journal_sha256: challenge.journal_sha256, attempt_sha256: challenge.attempt_sha256,
      reference: 'mock:live-attribution-revalidation' }),
  });
}
async function withFixture(fn) {
  const f = lab.fixture(), env = { ...process.env };
  const xllm = require('./forge-xllm'), activity = require('./forge-protected-owner-activity'), sidecar = require('./forge-unit-sidecar');
  const previous = xllm.runExecute;
  try {
    const home = path.join(f.dir, 'home'); fs.mkdirSync(home);
    f.profile = path.join(f.dir, 'profile'); fs.mkdirSync(f.profile);
    Object.assign(process.env, { HOME: home, USERPROFILE: home, FORGE_HOME: source });
    const request = activityRequest(f, 'claude');
    const tiers = ['light', 'standard', 'heavy', 'max'], chain = ['gpt-6.1-sol', 'gpt-5.6-terra'];
    put(path.join(f.owner, '.gsd/forge-prefs.jsonc'), JSON.stringify({ tier_models: Object.fromEntries(tiers.map(tier => [tier, chain])) }));
    request.route = require('./forge-dispatch-resolve').resolveDispatch({ cwd: f.owner, unitType: 'execute-task', milestoneId: 'M001',
      unitId: 'T01', planPath: request.planFile, hostRuntime: 'claude' });
    assert.equal(request.route.worker_mode, 'sidecar');
    put(path.join(f.a, 'operator.txt'), 'operator\r\n');
    Object.assign(f, { request, calls: 0, parent: null });
    f.authority = authority(f);
    f.files = sidecar.artifactAttemptFiles(request);
    f.stateFile = `${f.files.resultFile}.recovery.json`; f.recordFile = `${f.files.resultFile}.abandon.jsonl`;
    f.adapter = liveAdapter(f);
    xllm.runExecute = async runOptions => {
      f.calls++;
      runOptions.onBeforeSpawn?.();
      const scope = activity.currentScope(); assert(scope, 'mock transport inside the protected activity scope');
      const dirs = request.execution_contract.code_roots.map(root => root.path);
      f.parent = scope.spawn(process.execPath, ['-e', HELPER, '150', ...dirs], { cwd: runOptions.cwd, env: xllm.buildSidecarEnv('minimal'), windowsHide: true, stdio: 'ignore' });
      assert.equal(await new Promise((resolve, reject) => { f.parent.once('error', reject); f.parent.once('close', resolve); }), 0);
      throw Object.assign(new Error('mock transport failure after the controlled helper exited'), { code: MOCK_FAILURE });
    };
    await assert.rejects(sidecar.runUnitSidecar(request, {}), error => error.code === MOCK_FAILURE);
    return await fn(f);
  } finally { xllm.runExecute = previous; process.env = env; try { f.cleanup(); } catch { /* lab already gone */ } }
}
const runtime = (f, extra = {}) => ({ processProbe: () => (f.parent && f.parent.exitCode === null ? 'running' : 'stopped'),
  recoveryAuthorization: { adapter: f.authority.adapter, reference: f.authority.reference }, ...extra });
const recover = (f, runtimeExtra = {}) => require('./forge-unit-sidecar').recoverUnitSidecar(f.request,
  { stateFile: f.stateFile, receiptFile: f.files.receiptFile, abandonment: f.adapter }, runtime(f, runtimeExtra));
const abandonInput = (f, extra = {}) => ({ request: f.request, adapter: f.adapter, processProbe: runtime(f).processProbe,
  recoveryAuthorization: runtime(f).recoveryAuthorization, ...extra });
const readState = f => (fs.existsSync(f.stateFile) ? JSON.parse(text(f.stateFile)) : null);
const recordRows = f => (fs.existsSync(f.recordFile) ? text(f.recordFile).trim().split('\n').map(line => JSON.parse(line)) : []);
const eventsFile = f => path.join(f.owner, '.gsd/forge/events.jsonl');
const ownerEvents = (f, name) => (fs.existsSync(eventsFile(f)) ? text(eventsFile(f)).trim().split('\n').map(line => JSON.parse(line)) : []).filter(row => row.event === name);
function spyOn(target, name, calls) {
  const original = target[name];
  target[name] = function spied(...args) { calls.push({ name, request: !!args[0]?.request }); return original.apply(this, args); };
  return () => { target[name] = original; };
}

// ── R2: a failed external refusal recording is repairable ───────────────────
async function r2RefusalRepair() {
  await withFixture(async f => {
    const surgical = require('./forge-surgical-reset'), calls = [];
    const undo = [spyOn(abandon, 'abandonAttempt', calls), spyOn(abandon, 'recordSuccessorAdmission', calls),
      spyOn(surgical, 'backupResetTargets', calls), spyOn(surgical, 'resetClaimedAttempt', calls)];
    const real = abandon.recordRefusal;
    try {
      // Failure after the session classification is persisted, before the external recording.
      let injected = 0;
      abandon.recordRefusal = async () => { injected++; throw Object.assign(new Error('injected EBUSY'), { code: 'EBUSY' }); };
      let thrown = null;
      try { await recover(f, { recoveryAuthorization: undefined }); } catch (error) { thrown = error; }
      assert.equal(injected, 1, 'the external seam was attempted');
      assert(thrown === null || thrown.code === 'EBUSY');
      assert.equal(readState(f).replay_refusals.length, 1, 'classification already saved in the session');
      assert.deepEqual(recordRows(f), [], 'no durable record yet'); assert.deepEqual(ownerEvents(f, 'attempt-replay-refused'), []);
      abandon.recordRefusal = real;
      // The exact same classification, same authorized continuation: repaired once.
      const repaired = await recover(f, { recoveryAuthorization: undefined });
      assert.equal(repaired.reason_code, 'replay-refusal-authority-missing', JSON.stringify(repaired));
      assert.deepEqual(recordRows(f).map(row => row.kind), ['refusal', 'owner-event']);
      assert.equal(ownerEvents(f, 'attempt-replay-refused').length, 1);
      assert.equal(readState(f).replay_refusals.length, 1, 'classification not duplicated in the session');
      const bytes = fs.readFileSync(f.recordFile), events = fs.readFileSync(eventsFile(f));
      await recover(f, { recoveryAuthorization: undefined });
      assert(fs.readFileSync(f.recordFile).equals(bytes), 'a later repeat appends nothing');
      assert(fs.readFileSync(eventsFile(f)).equals(events), 'a later repeat emits no second event');
      assert.equal(readState(f).replay_refusals.length, 1);
      assert.deepEqual(calls.filter(row => row.request || /^(backup|reset)/.test(row.name)), [], 'zero mutation-capable calls');
      assert.equal(f.calls, 1, 'no new invocation');
    } finally { abandon.recordRefusal = real; for (const restore of undo) restore(); }
  });
}

// ── R4: a pending-window admission event is retried ─────────────────────────
async function r4PendingWindowRetry() {
  if (!WIN) { console.log('ENV r4 "native custody is required to abandon an attempt; win32 only"'); return; }
  await withFixture(async f => {
    const done = await abandon.abandonAttempt(abandonInput(f, { emitEvents: true }));
    assert.equal(done.status, 'abandoned', JSON.stringify(done));
    const successor = { dispatch_id: recoveryDispatchId(f.request.dispatchId, 'review-fix-r4') };
    // The admission itself is recorded without publishing its owner event.
    const admitted = await abandon.recordSuccessorAdmission({ ...abandonInput(f), successor });
    assert.equal(admitted.status, 'successor-admitted', JSON.stringify(admitted));
    const rowsOf = () => recordRows(f).filter(row => row.kind === 'owner-event' && row.event === 'attempt-successor-admitted');
    assert.deepEqual(rowsOf(), []);
    // Busy owner window: the event is recorded as pending-window and no owner byte is written.
    const windows = require('./forge-owner-transport-window');
    const cap = windows.open(f.owner, { kind: 'artifact-preparation', task_id: 'T99', dispatch_id: 'fixture-fence', request_sha256: 'a'.repeat(64) });
    const before = fs.readFileSync(eventsFile(f));
    try {
      const pending = abandon.appendRecoveryEvent({ request: f.request, event: 'attempt-successor-admitted', reason_code: null });
      assert.equal(pending.owner_event, 'pending-window', JSON.stringify(pending));
      assert(fs.readFileSync(eventsFile(f)).equals(before), 'busy window: no owner byte');
      // Still busy: a repeat stays pending and records nothing new.
      assert.equal(abandon.appendRecoveryEvent({ request: f.request, event: 'attempt-successor-admitted', reason_code: null }).owner_event, 'pending-window');
    } finally { windows.close(cap, challenge => ({ challenge_sha256: digest(challenge), joined: true, possible_writers: 0, reference: 'mock:fence-closed' })); }
    assert.deepEqual(rowsOf().map(row => row.status), ['pending-window']);
    assert.deepEqual(ownerEvents(f, 'attempt-successor-admitted'), []);
    // The window is available again: the same admission publishes the pending event.
    const retried = await abandon.recordSuccessorAdmission({ ...abandonInput(f, { emitEvents: true }), successor });
    assert.equal(retried.status, 'successor-admitted', JSON.stringify(retried));
    const published = ownerEvents(f, 'attempt-successor-admitted');
    assert.equal(published.length, 1); assert.equal(published[0].reason_code, null); assert.equal(published[0].dispatch_id, f.request.dispatchId);
    assert.deepEqual(rowsOf().map(row => row.status), ['pending-window', 'appended']);
    // Later duplicates publish nothing more.
    const bytes = fs.readFileSync(eventsFile(f)), record = fs.readFileSync(f.recordFile);
    await abandon.recordSuccessorAdmission({ ...abandonInput(f, { emitEvents: true }), successor });
    assert(fs.readFileSync(eventsFile(f)).equals(bytes)); assert(fs.readFileSync(f.recordFile).equals(record));
    assert.equal(ownerEvents(f, 'attempt-successor-admitted').length, 1);
  });
}

// ── R5: SVN properties are never lost behind a "verified" backup ────────────
const svnOut = (bin, args, cwd) => lab.command(bin, args, cwd);
function svnReady() {
  for (const bin of ['svn', 'svnadmin']) {
    const run = cp.spawnSync(bin, ['--version', '--quiet'], { encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, `${bin} is required for the R5 regression (a missing SVN is a blocker, never a skip)`);
  }
}
function svnFixture(withDirectory) {
  const f = lab.fixture('svn');
  if (withDirectory) {
    for (const dir of [f.a, f.b]) { svnOut('svn', ['mkdir', 'sub'], dir); svnOut('svn', ['commit', '-m', 'dir'], dir); svnOut('svn', ['update'], dir); }
  }
  return f;
}
const reset = () => require('./forge-surgical-reset');
const ok = () => {};
function assertRefusedBeforeMutation(f, stateFile, claims, backupDir, expectedPaths) {
  const stateBytes = fs.readFileSync(stateFile);
  const refused = reset().backupResetTargets(stateFile, { backupDir, claims });
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.reason_code, 'reset-target-changed', JSON.stringify(refused));
  assert.equal(refused.detail, 'svn-properties-unrecoverable'); assert.deepEqual(refused.paths, expectedPaths);
  assert.equal(fs.existsSync(backupDir), false, 'no backup directory or manifest is created');
  assert(fs.readFileSync(stateFile).equals(stateBytes), 'state untouched');
  // A hand-built backup handle cannot make the reset run either.
  const forged = reset().resetClaimedAttempt(stateFile, { backup: { manifest_file: path.join(backupDir, 'manifest.json'), manifest_sha256: 'b'.repeat(64) }, claims, assertUnchanged: ok });
  assert.equal(forged.ok, false);
}
async function r5SvnProperties() {
  svnReady();
  // Clean file whose only worker change is a property.
  const file = svnFixture(false);
  try {
    const stateFile = path.join(file.dir, 'prop-file.json');
    reset().initState(stateFile, { cwd: file.a, attempt: 'svn-prop-file', executionContract: file.contract });
    svnOut('svn', ['propset', 'worker-prop', 'worker value', 'same.txt'], file.a);
    assertRefusedBeforeMutation(file, stateFile, ['alpha::same.txt', 'beta::same.txt'], path.join(file.dir, 'prop-file.abandon', 'backup'), ['same.txt']);
    assert.equal(svnOut('svn', ['propget', 'worker-prop', 'same.txt'], file.a), 'worker value', 'worker property value is still present');
    assert.equal(fs.readFileSync(path.join(file.a, 'same.txt'), 'utf8'), 'before\n');
    assert(/^\s*M/m.test(svnOut('svn', ['status', 'same.txt'], file.a)) || /M/.test(svnOut('svn', ['status', 'same.txt'], file.a).slice(0, 2)), 'no svn revert happened');
  } finally { file.cleanup(); }
  // Directory property.
  const dir = svnFixture(true);
  try {
    const stateFile = path.join(dir.dir, 'prop-dir.json');
    reset().initState(stateFile, { cwd: dir.a, attempt: 'svn-prop-dir', executionContract: dir.contract });
    svnOut('svn', ['propset', 'dir-prop', 'dir value', 'sub'], dir.a);
    assertRefusedBeforeMutation(dir, stateFile, ['alpha::sub', 'beta::sub'], path.join(dir.dir, 'prop-dir.abandon', 'backup'), ['sub']);
    assert.equal(svnOut('svn', ['propget', 'dir-prop', 'sub'], dir.a), 'dir value', 'directory property value is still present');
    assert(/M/.test(svnOut('svn', ['status', 'sub'], dir.a).slice(0, 2)), 'no svn revert happened');
  } finally { dir.cleanup(); }
  // Content-only change with unchanged properties keeps working through the same seams.
  const plain = svnFixture(false);
  try {
    const stateFile = path.join(plain.dir, 'content.json'), claims = ['alpha::same.txt', 'beta::same.txt'];
    reset().initState(stateFile, { cwd: plain.a, attempt: 'svn-content', executionContract: plain.contract });
    for (const root of [plain.a, plain.b]) fs.writeFileSync(path.join(root, 'same.txt'), 'worker svn bytes\r\n');
    const backup = reset().backupResetTargets(stateFile, { backupDir: path.join(plain.dir, 'content.abandon', 'backup'), claims });
    assert.equal(backup.ok, true, JSON.stringify(backup));
    const done = reset().resetClaimedAttempt(stateFile, { backup, claims, assertUnchanged: ok });
    assert.equal(done.ok, true, JSON.stringify(done));
    for (const root of [plain.a, plain.b]) assert.equal(fs.readFileSync(path.join(root, 'same.txt'), 'utf8'), 'before\n');
  } finally { plain.cleanup(); }
}

const cases = [
  { name: 'R1 authenticated custody failure reaches the Claude adapter as a pre-transport failure', fn: r1CustodyFailure },
  { name: 'R2 a failed external refusal recording is repaired on the same classification', fn: r2RefusalRepair },
  { name: 'R4 a pending-window successor event is retried and published exactly once', fn: r4PendingWindowRetry },
  { name: 'R5 SVN property changes refuse before any backup or reset', fn: r5SvnProperties },
];
async function main() {
  try {
    for (const row of cases) {
      const started = Date.now();
      try { await row.fn(); results.push(true); console.log(`PASS ${row.name} (${Date.now() - started} ms)`); }
      catch (error) { results.push(false); console.log(`FAIL ${row.name}: ${error && error.stack}`); }
    }
  } finally { fs.rmSync(LAB, { recursive: true, force: true }); }
  const passed = results.filter(Boolean).length;
  console.log(`${passed}/${cases.length} forge-issue-440-review-fix cases passed (platform ${process.platform}, transport mock, provider_calls 0)`);
  if (passed !== cases.length) process.exitCode = 1;
}
module.exports = { cases };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
