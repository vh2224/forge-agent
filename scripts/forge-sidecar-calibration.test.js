'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const calibration = require('./forge-sidecar-calibration');
const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-calibration-'));
const options = { userHome };
const id = { model: 'claude-fixture', effort: 'high', phase: 'execute' };
const binding = { receipt: 'fixture-receipt', fingerprint: 'fixture-fingerprint' };
async function concurrentCommits(proposals) {
  const code = `const calibration=require(process.argv[1]);
    process.on('message', () => {
      const result=calibration.commit(JSON.parse(process.argv[2]),
        {receipt:'fixture',fingerprint:'fixture'}, {userHome:process.argv[3]});
      process.send(result, () => process.disconnect());
    }); process.send({ready:true});`;
  const children = proposals.map(proposal => {
    const child = spawn(process.execPath, ['-e', code, require.resolve('./forge-sidecar-calibration'),
      JSON.stringify(proposal), userHome], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let result, stderr = '';
    child.stderr.on('data', bytes => { stderr += bytes; });
    const ready = new Promise((resolve, reject) => {
      child.on('message', value => { if (value.ready) resolve(); else result = value; });
      child.once('error', reject);
      child.once('close', code => { if (!result) reject(Error(`calibration child ${code}: ${stderr}`)); });
    });
    const timer = setTimeout(() => child.kill(), 10000);
    const closed = new Promise(resolve => child.once('close', code => {
      clearTimeout(timer); resolve({ code, result, stderr });
    }));
    return { child, ready, closed };
  });
  let failure;
  try {
    await Promise.all(children.map(item => item.ready));
    for (const item of children) item.child.send('commit');
  } catch (error) { failure = error; }
  const results = await Promise.all(children.map(item => item.closed));
  if (failure) throw failure;
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  return results.map(item => item.result);
}
async function main() {
try {
  let state = calibration.read(id, options);
  assert.equal(state.initial.calibrated, false);
  assert.equal(calibration.silence(state, { first_remote_ms: null, elapsed_ms: 999999 }), null);
  const proposals = [];
  const abandoned = spawnSync(process.execPath, ['-e',
    "const fs=require('fs'),path=require('path'); const dir=process.argv[2]; fs.mkdirSync(path.join(dir,'.gsd'),{recursive:true}); if(!require(process.argv[1]).tryAcquireSync(dir,'calibration',{allowStaleRecovery:false,ttlMs:1}))process.exit(2);",
    require.resolve('./forge-lock'), calibration.directory(options)], { encoding: 'utf8', windowsHide: true });
  assert.equal(abandoned.status, 0, abandoned.stderr);
  assert(calibration.commit(calibration.propose({ ...id, model: 'claude-orphan' }, { initial_sample_ms: 1 }), binding, options).committed,
    'a terminated process cannot permanently disable calibration writes');
  for (let i = 0; i < 5; i++) {
    const proposal = calibration.propose(id, { initial_sample_ms: 100 + i, gap_sample_ms: i ? 200 : null });
    proposals.push(proposal);
    assert(calibration.commit(proposal, binding, options).committed);
    assert(calibration.commit(JSON.parse(JSON.stringify(proposal)), { ...binding, receipt: 'replay' }, options).committed);
  }
  state = calibration.read(id, options);
  assert.equal(state.initial.count, 5); assert(state.initial.calibrated);
  assert.equal(state.initial.threshold_ms, 120000);
  assert.equal(state.gap.count, 4); assert(!state.gap.calibrated);
  const restart = spawnSync(process.execPath, ['-e',
    'process.stdout.write(JSON.stringify(require(process.argv[1]).read(JSON.parse(process.argv[2]), {userHome:process.argv[3]})))',
    require.resolve('./forge-sidecar-calibration'), JSON.stringify(id), userHome], { encoding: 'utf8', windowsHide: true });
  assert.equal(restart.status, 0, restart.stderr);
  assert.deepEqual(JSON.parse(restart.stdout), state, 'fresh process immediately reuses persisted dimensions');
  assert(calibration.silence(state, { first_remote_ms: null, elapsed_ms: 120001 }));
  assert.equal(calibration.silence(state, { first_remote_ms: null, elapsed_ms: 120000 }), null);
  assert.equal(calibration.silence(state, { first_remote_ms: 10, remote_silence_ms: 999999, gap_suspended: true }), null);
  const gap = calibration.propose(id, { initial_sample_ms: null, gap_sample_ms: 40000 });
  assert(calibration.commit(gap, binding, options).committed);
  state = calibration.read(id, options);
  assert.equal(state.initial.count, 5); assert.equal(state.gap.threshold_ms, 175000);
  const file = path.join(calibration.directory(options), 'calibration.json');
  const bytes = fs.readFileSync(file), stat = fs.statSync(file);
  assert.equal(calibration.commit(calibration.propose(id, { initial_sample_ms: 999999, gap_sample_ms: 999999 }), binding, options).noop, 'frozen');
  assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(fs.statSync(file).mtimeMs, stat.mtimeMs);
  assert(!calibration.commit({ ...proposals[0], userHome: 'worker-injected-path' }, binding, options).committed);
  assert(!calibration.commit(proposals[0], {}, options).committed);
  assert.equal(calibration.read({ ...id, effort: 'medium' }, options).initial.count, 0);
  const concurrentId = { ...id, model: 'claude-concurrent' };
  const concurrent = Array.from({ length: 5 }, (_, i) => calibration.propose(concurrentId,
    { initial_sample_ms: 100 + i, gap_sample_ms: 200 + i }));
  const results = await concurrentCommits([...concurrent, concurrent[0]]);
  assert(results.every(result => result.committed || result.diagnostic === 'calibration-busy'));
  const uniqueAccepted = new Set([...concurrent, concurrent[0]]
    .filter((_, index) => results[index].committed).map(proposal => proposal.attempt_sha256));
  assert.equal(calibration.read(concurrentId, options).initial.count, uniqueAccepted.size);
  for (const proposal of concurrent) assert(calibration.commit(proposal, binding, options).committed);
  assert.equal(calibration.read(concurrentId, options).initial.count, 5);
  assert(calibration.read(concurrentId, options).initial.calibrated);
  assert.deepEqual(calibration.read(id, options), state, 'concurrent completions preserve calibrated state');

  let currentBytes = fs.readFileSync(file);
  const lock = require('./forge-lock').tryAcquireSync(calibration.directory(options), 'calibration', { allowStaleRecovery: false });
  assert(lock);
  try {
    assert.equal(calibration.commit(calibration.propose({ ...id, model: 'claude-busy' },
      { initial_sample_ms: 1 }), binding, options).diagnostic, 'calibration-busy');
    assert.deepEqual(fs.readFileSync(file), currentBytes);
  } finally { lock.release(); }

  const retryId = { ...id, model: 'claude-retry' };
  const retryProposal = calibration.propose(retryId, { initial_sample_ms: 1 });
  const retryLock = require('./forge-lock').tryAcquireSync(calibration.directory(options), 'calibration');
  assert(retryLock);
  setTimeout(() => retryLock.release(), 10);
  const retried = await calibration.commitAccepted(retryProposal, binding, options);
  assert.equal(retried.committed, true);
  assert.equal(retried.attempts, 2);
  assert.equal(retried.retry_pending, false);
  assert.equal(calibration.read(retryId, options).initial.count, 1);
  assert((await calibration.commitAccepted(retryProposal, binding, options)).committed);
  assert.equal(calibration.read(retryId, options).initial.count, 1, 'retry/replay cannot learn twice');
  currentBytes = fs.readFileSync(file);

  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === file && from.endsWith('.tmp')) throw Object.assign(Error('fixture interrupted'), { code: 'EIO' });
    return rename(from, to);
  };
  try {
    assert(!calibration.commit(calibration.propose({ ...id, model: 'claude-interrupted' },
      { initial_sample_ms: 1 }), binding, options).committed);
  } finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(file), currentBytes);
  assert(!fs.readdirSync(path.dirname(file)).some(name => name.endsWith('.tmp')));
  const orphan = path.join(path.dirname(file), 'calibration.interrupted.tmp');
  fs.writeFileSync(orphan, 'incomplete');
  assert.deepEqual(calibration.read(id, options), state);
  fs.unlinkSync(orphan);

  const readSync = fs.readSync;
  let raced = false;
  fs.readSync = (...args) => {
    if (!raced) { raced = true; fs.appendFileSync(file, ' '); }
    return readSync(...args);
  };
  try { assert.equal(calibration.read(id, options).diagnostic, 'calibration-unavailable'); }
  finally { fs.readSync = readSync; fs.writeFileSync(file, currentBytes); }
  assert.deepEqual(calibration.read(id, options), state);

  const frozenRecord = JSON.parse(currentBytes).records[proposals[0].key];
  const records = {};
  let lastId;
  for (let i = 0; i < 256; i++) {
    lastId = { ...id, model: `claude-capacity-${i}` };
    const proposal = calibration.propose(lastId, {});
    records[proposal.key] = { ...structuredClone(frozenRecord), identity: proposal.identity };
  }
  fs.writeFileSync(file, JSON.stringify({ version: 1, records }));
  assert(calibration.read(lastId, options).initial.calibrated);
  const fullBytes = fs.readFileSync(file);
  assert(!calibration.commit(calibration.propose(id, { initial_sample_ms: 1 }), binding, options).committed);
  assert.deepEqual(fs.readFileSync(file), fullBytes, 'full store cannot evict calibrated keys');
  assert(calibration.read({ ...id, model: 'claude-capacity-0' }, options).gap.calibrated);
  fs.writeFileSync(file, currentBytes);
  fs.writeFileSync(file, 'broken');
  assert.equal(calibration.read(id, options).diagnostic, 'calibration-unavailable');
  assert(!calibration.commit(gap, binding, options).committed);
  assert.equal(fs.readFileSync(file, 'utf8'), 'broken');
  fs.writeFileSync(file, Buffer.alloc(1048577, 32));
  assert.equal(calibration.read(id, options).diagnostic, 'calibration-unavailable');
  fs.unlinkSync(file);
  const target = path.join(userHome, 'external'); fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(calibration.directory(options), 'calibration.json'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(calibration.read(id, options).diagnostic, 'calibration-unavailable');
  assert(!calibration.commit(gap, binding, options).committed);
  assert.deepEqual(fs.readdirSync(target), []);
  console.log('PASS calibration: restart/replay, concurrent commits, atomic interruption, consistent bounded reads, capacity, frozen no-write and corrupt/symlink refusal');
} finally { fs.rmSync(userHome, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
