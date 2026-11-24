'use strict';
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const runs = require('./forge-runs'), hook = require('./forge-hook'), lock = require('./forge-lock');
const base = fs.realpathSync.native(os.tmpdir());
const lab = fs.realpathSync.native(fs.mkdtempSync(path.join(base, 'forge-owner-336-')));
const marker = 'owned-336-heartbeat-fixture';
fs.writeFileSync(path.join(lab, '.owner'), marker);
const live = path.join(lab, 'live'); fs.mkdirSync(live);
let serial = 0;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(hostRuntime = 'codex', sessionId = 'owner-A') {
  const cwd = path.join(lab, 'project-' + (++serial)); fs.mkdirSync(cwd); fs.mkdirSync(path.join(cwd, '.gsd'));
  runs.add(cwd, { id: 'M001', kind: 'milestone', session_id: sessionId, ...(hostRuntime ? { host_runtime: hostRuntime } : {}),
    started_at: 1000, last_heartbeat: 1000, active: true });
  return cwd;
}
function alias(cwd) { return path.join(cwd, '.gsd', 'forge', 'auto-mode.json'); }
function state(cwd) {
  const files = [runs.runFile(cwd, 'M001'), alias(cwd)];
  return files.map(file => fs.existsSync(file) ? sha(fs.readFileSync(file)) : null);
}
function fire(cwd, sessionId, preload) {
  const args = [...(preload ? ['--require', preload] : []), path.join(__dirname, 'forge-hook.js'), 'subagent-start'];
  const result = spawnSync(process.execPath, args, { input: JSON.stringify({ session_id: sessionId, cwd, agent_type: 'fixture', agent_id: 'fixture', host_runtime: 'codex' }),
    env: { ...process.env, TEMP: live, TMP: live, TMPDIR: live }, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  return result;
}
function legacy(record) {
  const cwd = path.join(lab, 'legacy-' + (++serial)); fs.mkdirSync(cwd); fs.mkdirSync(path.join(cwd, '.gsd', 'forge'), { recursive: true });
  fs.writeFileSync(alias(cwd), JSON.stringify(record)); return cwd;
}

try {
  // This first public-hook regression fails on the original source: the sole
  // foreign run is adopted, and its heartbeat/alias change.
  for (const [host, session] of [['codex', 'owner-A'], ['claude', 'owner-A']]) {
    const cwd = fixture(host, session), before = state(cwd);
    fire(cwd, 'other-B'); assert.deepEqual(state(cwd), before, 'foreign session must not adopt or heartbeat the sole active run');
    assert.equal(runs.get(cwd, 'M001').session_id, session);
  }
  const sameSessionOtherHost = fixture('codex', 'same-session'), beforeOtherHost = state(sameSessionOtherHost);
  fire(sameSessionOtherHost, 'same-session');
  assert.deepEqual(state(sameSessionOtherHost), beforeOtherHost, 'Claude hook cannot heartbeat the same session string of a Codex run');
  console.log('PASS #336 actual hooks never adopt lone active runs or heartbeat foreign session/host ownership');

  const readOnly = fixture('claude', 'owner-A'), beforeRead = state(readOnly);
  assert.equal(hook.resolveRunForSession(readOnly, 'owner-A').id, 'M001');
  assert.equal(hook.resolveRunForSession(readOnly, 'owner-A', 'codex'), null);
  assert.equal(hook.resolveRunForSession(readOnly, ''), null);
  assert.equal(hook.resolveRunForSession(readOnly, 'owner-A', 'unknown'), null);
  assert.deepEqual(state(readOnly), beforeRead);
  runs.add(readOnly, { id: 'M002', kind: 'milestone', session_id: 'owner-A', host_runtime: 'claude', active: true });
  const duplicateBefore = state(readOnly); assert.equal(hook.resolveRunForSession(readOnly, 'owner-A'), null);
  fire(readOnly, 'owner-A'); assert.deepEqual(state(readOnly), duplicateBefore, 'duplicate matching runs are not a unique owner');
  const unknown = fixture(null, 'owner-A'), unknownBefore = state(unknown);
  fire(unknown, 'owner-A'); assert.deepEqual(state(unknown), unknownBefore, 'missing host identity remains unknown');
  console.log('PASS #336 session plus host resolution is unique, bounded and read only; missing and ambiguous identity never writes');

  const owned = fixture('claude', 'owner-A'); fire(owned, 'owner-A');
  assert(runs.get(owned, 'M001').last_heartbeat > 1000);
  assert.equal(JSON.parse(fs.readFileSync(alias(owned), 'utf8')).last_heartbeat, runs.get(owned, 'M001').last_heartbeat);
  const codex = fixture('codex', 'owner-C');
  const update = runs.bumpOwnedHeartbeat(codex, 'M001', { sessionId: 'owner-C', hostRuntime: 'codex' }, 9000);
  assert.equal(update.updated, true); assert.equal(runs.get(codex, 'M001').last_heartbeat, 9000);
  assert.equal(JSON.parse(fs.readFileSync(alias(codex), 'utf8')).last_heartbeat, 9000);
  const ownedApiBefore = state(codex);
  for (const owner of [{ sessionId: '', hostRuntime: 'codex' }, { sessionId: 'owner-C', hostRuntime: 'unknown' }, { sessionId: 'foreign', hostRuntime: 'codex' }]) {
    assert.equal(runs.bumpOwnedHeartbeat(codex, 'M001', owner, 10000).updated, false);
    assert.deepEqual(state(codex), ownedApiBefore);
  }
  runs.bumpHeartbeat(codex, 'M001', 11000);
  assert.equal(runs.get(codex, 'M001').last_heartbeat, 11000, 'the existing trusted internal API is preserved');
  console.log('PASS #336 matching Claude hook and explicitly supplied Codex owner API update their own record and pure alias; trusted bumpHeartbeat remains compatible');

  for (const change of [{ session_id: 'new-owner' }, { host_runtime: 'codex' }, { active: false }]) {
    const cwd = fixture('claude', 'owner-A'), saved = lock.acquireProcessSync;
    let winner = null, fired = 0;
    lock.acquireProcessSync = function (...args) {
      if (args[0] === cwd && args[1] === 'runs-ownership' && !fired) {
        fired++; runs.update(cwd, 'M001', change); winner = state(cwd);
      }
      return saved.apply(this, args);
    };
    let out;
    try { out = runs.bumpOwnedHeartbeat(cwd, 'M001', { sessionId: 'owner-A', hostRuntime: 'claude' }, 12000); }
    finally { lock.acquireProcessSync = saved; }
    assert.equal(fired, 1); assert.equal(out.updated, false); assert.deepEqual(state(cwd), winner, 'the real canonical owner change at mutex acquisition wins');
  }
  console.log('PASS #336 heartbeat rechecks the current owner under the real registry/run mutator lock and preserves a concurrent canonical ownership change');

  const broken = fixture('claude', 'owner-A'); fs.writeFileSync(runs.runFile(broken, 'M002'), '{');
  const beforeBroken = state(broken); fire(broken, 'owner-A'); assert.deepEqual(state(broken), beforeBroken);
  const throwing = fixture('claude', 'owner-A'), preload = path.join(lab, 'refuse-owned-heartbeat.cjs');
  fs.writeFileSync(preload, 'require(' + JSON.stringify(require.resolve('./forge-runs')) + ').bumpOwnedHeartbeat=()=>{throw new Error("fixture-registry-refusal")};\n');
  const beforeThrow = state(throwing); fire(throwing, 'owner-A', preload); assert.deepEqual(state(throwing), beforeThrow);
  console.log('PASS #336 unreadable registry and a refused registry update never fall back to mutating the alias');

  for (const record of [{ active: true, started_at: 1000, last_heartbeat: 1000 },
    { active: true, session_id: 'other', host_runtime: 'claude', last_heartbeat: 1000 },
    { active: true, session_id: 'owner-A', host_runtime: 'codex', last_heartbeat: 1000 }]) {
    const cwd = legacy(record), before = fs.readFileSync(alias(cwd)); fire(cwd, 'owner-A');
    assert(fs.readFileSync(alias(cwd)).equals(before)); assert(!fs.existsSync(runs.runsDir(cwd)));
  }
  const legitimateLegacy = legacy({ active: true, session_id: 'owner-A', host_runtime: 'claude', started_at: 1000, last_heartbeat: 1000 });
  fire(legitimateLegacy, 'owner-A');
  const legacyUpdated = JSON.parse(fs.readFileSync(alias(legitimateLegacy), 'utf8'));
  assert(legacyUpdated.last_heartbeat > 1000); assert.equal(legacyUpdated.session_id, 'owner-A');
  assert.equal(legacyUpdated.host_runtime, 'claude'); assert(!fs.existsSync(runs.runsDir(legitimateLegacy)));
  const becomingModern = legacy({ active: true, session_id: 'owner-A', host_runtime: 'claude', last_heartbeat: 1000 });
  const savedRegistryLock = lock.acquireProcessSync;
  let modernWinner = null, registered = 0;
  lock.acquireProcessSync = function (...args) {
    if (args[0] === becomingModern && args[1] === 'runs-ownership' && !registered) {
      registered++;
      runs.add(becomingModern, { id: 'M001', kind: 'milestone', session_id: 'new-modern-owner', host_runtime: 'codex', active: true, last_heartbeat: 1234 });
      modernWinner = state(becomingModern);
    }
    return savedRegistryLock.apply(this, args);
  };
  let legacyRace;
  try { legacyRace = runs.bumpLegacyOwnedHeartbeat(becomingModern, { sessionId: 'owner-A', hostRuntime: 'claude' }, 20000); }
  finally { lock.acquireProcessSync = savedRegistryLock; }
  assert.equal(registered, 1); assert.equal(legacyRace, false); assert.deepEqual(state(becomingModern), modernWinner);
  console.log('PASS #336 legacy heartbeat requires the already matching explicit session/host and never creates a registry or adopts identity');
} finally {
  assert.equal(fs.realpathSync.native(lab), lab); assert.equal(path.dirname(lab), base);
  assert.equal(fs.readFileSync(path.join(lab, '.owner'), 'utf8'), marker);
  fs.rmSync(lab, { recursive: true });
}
