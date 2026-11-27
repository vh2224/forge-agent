'use strict';
// Regression: a preparation start refused before its attempt exists (no
// receipt, provider_called:false) must not leave the observed owner window held.
// Before the fix the window stayed held with no same-session exit: settle needed
// a receipt, recover answered "use settle", and every later start of the same
// task was refused with owner-window-coordination-mismatch.
// Hermetic: temporary HOME/owner, no provider, no network.
// Run: node scripts/forge-owner-window-prestart-refusal.test.js   (exit 0 = all pass)
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'),
  crypto = require('crypto'), assert = require('assert/strict');

const lab = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-prestart-refusal-')));
const home = path.join(lab, 'home'), forge = path.join(home, 'forge');
fs.mkdirSync(forge, { recursive: true });
fs.cpSync(path.resolve(__dirname, '../shared'), path.join(forge, 'shared'), { recursive: true });
Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'appdata'),
  LOCALAPPDATA: path.join(home, 'local'), FORGE_HOME: forge, GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: path.join(home, 'no-global-config') });
for (const key of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'FORGE_CLAUDE_OWNER_SESSION_ID', 'FORGE_CLAUDE_OWNER_SOURCE']) delete process.env[key];

const prep = require('./forge-task-preparation'), windows = require('./forge-owner-transport-window'), runs = require('./forge-runs');
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

let seq = 0;
function git(args, cwd) {
  const r = cp.spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(r.status, 0, r.stderr || String(r.error));
}
function fixture() {
  const dir = path.join(lab, 'case-' + (++seq)), cwd = path.join(dir, 'code'), contextRoot = path.join(dir, 'owner');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(contextRoot, '.gsd'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'channels'));
  git(['init', '-q'], cwd);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], cwd);
  fs.writeFileSync(path.join(contextRoot, '.gsd/forge-prefs.jsonc'), JSON.stringify({
    tier_models: Object.fromEntries(['light', 'standard', 'heavy', 'max'].map(k => [k, 'gpt-5.6-sol'])), effort: { 'plan-slice': 'medium' } }));
  const taskId = 'T-2026112700' + String(seq).padStart(4, '0') + '-prestart';
  windows.ensureTask(contextRoot, taskId);
  process.env.CODEX_THREAD_ID = 'prestart-owner-' + seq;
  runs.add(contextRoot, { id: taskId, kind: 'task', session_id: process.env.CODEX_THREAD_ID, host_runtime: 'codex' });
  return { schema_version: 1, scope: 'standalone-task', phase: 'discuss', taskId, cwd, contextRoot, hostRuntime: 'codex',
    workflowId: 'prestart', dispatchId: crypto.randomUUID(), resultFile: path.join(dir, 'channels/result.json'),
    constraints: { auto_commit: false, deploy: false }, inputs: { brief: 'Synthetic isolated task; no provider' },
    // A continuation whose source receipt does not exist: refused at validation, before any attempt.
    continuation: { from_dispatch_id: 'never-dispatched', result_file: path.join(dir, 'channels/missing.json'),
      answers: [{ id: 'q1', answer: 'synthetic answer' }] },
    activeCapabilities: { available: true, tool: 'collaboration.spawn_agent', source: 'fixture-tool-schema',
      models: ['gpt-5.6-sol'], reasoning_efforts: ['medium', 'high'], fork_turns: ['none'] } };
}
const results = [];
async function run(name, action) { await action(); results.push(name); console.log('ok - ' + name); }

(async () => {
  await run('start refused before any attempt releases the window it opened', async () => {
    const q = fixture();
    const refused = await prep.startStandaloneTaskPreparation(q);
    assert.equal(refused.ok, false);
    assert.equal(refused.provider_called, false);
    assert.match(refused.reason_code, /^preparation-continuation-/);
    assert.equal(refused.owner_window, undefined, 'no held window reported');
    assert.equal(windows.observed(q.contextRoot), null, 'window released');
    assert(!fs.existsSync(q.resultFile + '.receipt.json'), 'no receipt was created');
    // The next start of the same task is no longer blocked by a mismatched window.
    const next = { ...q, dispatchId: crypto.randomUUID() };
    const again = await prep.startStandaloneTaskPreparation(next);
    assert.notEqual(again.reason_code, 'owner-window-coordination-mismatch');
    assert.equal(windows.observed(q.contextRoot), null);
  });

  await run('prepareStandaloneTask releases the window on the same pre-attempt refusal', async () => {
    const q = fixture();
    const refused = await prep.prepareStandaloneTask(q);
    assert.equal(refused.ok, false);
    assert.equal(refused.provider_called, false);
    assert.match(refused.reason_code, /^preparation-continuation-/);
    assert.equal(refused.owner_window, undefined, 'nested start must not report a stale held window');
    assert.equal(windows.observed(q.contextRoot), null);
  });

  await run('a window already held without receipt settles through the live host', async () => {
    const q = fixture(), fingerprint = prep.preparationRequestFingerprint(prep.validateRequest(q));
    // Reproduce the pre-fix state: an observed window for a dispatch that never got a receipt.
    windows.coordinatePreparation(prep.validateRequest(q), fingerprint, { create: true, operation: 'start' });
    assert(windows.observed(q.contextRoot), 'window held');
    const challenges = [];
    const adapter = windows.createTransportAdapter(challenge => {
      challenges.push(challenge.operation);
      return { challenge_sha256: digest(challenge), joined: true, possible_writers: 0, reference: 'fixture: no child launched' };
    });
    const closed = await windows.settlePreparation(q, adapter);
    assert.equal(closed.closed, true);
    assert.equal(windows.observed(q.contextRoot), null);
    assert.deepEqual(challenges, ['join-cli-settlement-no-attempt', 'settle-cli-preparation-no-attempt']);
  });

  await run('a held window without receipt stays held when the live host cannot prove the join', async () => {
    const q = fixture(), fingerprint = prep.preparationRequestFingerprint(prep.validateRequest(q));
    windows.coordinatePreparation(prep.validateRequest(q), fingerprint, { create: true, operation: 'start' });
    const adapter = windows.createTransportAdapter(challenge => ({ challenge_sha256: digest(challenge), joined: false, possible_writers: 1, reference: 'unknown' }));
    await assert.rejects(() => windows.settlePreparation(q, adapter), e => e.code === 'owner-window-writer-unproven');
    assert(windows.observed(q.contextRoot), 'still held');
  });

  if (results.length !== 4) { console.error('incomplete', results); process.exitCode = 1; }
  try { fs.rmSync(lab, { recursive: true, force: true }); } catch { /* best effort */ }
})().catch(error => { console.error(error); process.exitCode = 1; });
