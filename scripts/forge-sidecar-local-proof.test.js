'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  LIMITS, DEFAULT_IGNORE_DIRS, createLocalProof, pidAlive, fsFingerprint, linuxCpuTreeMs, darwinCpuTreeMs,
  parseProcStat, parsePsTime, parsePsOutput, sumProcessTree,
} = require('./forge-sidecar-local-proof');

const tests = [];
const test = (name, run) => tests.push({ name, run });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const CPU_PLATFORMS = new Set(['linux', 'darwin']);
const HOST_HAS_CPU = CPU_PLATFORMS.has(process.platform);

// Scripted readers + fake clock: each reader returns the next queued value
// (a function value is invoked, so it may throw).
function scripted({ alive = [true], cpu = [0], fsPrints = [null] } = {}) {
  const queues = { alive: alive.slice(), cpu: cpu.slice(), fsPrints: fsPrints.slice() };
  const next = (queue) => {
    const value = queue.length > 1 ? queue.shift() : queue[0];
    return typeof value === 'function' ? value() : value;
  };
  const calls = { pidAlive: 0, cpuTreeMs: 0, fsFingerprint: 0 };
  return {
    calls,
    readers: {
      pidAlive: async () => { calls.pidAlive++; return next(queues.alive); },
      cpuTreeMs: async () => { calls.cpuTreeMs++; return next(queues.cpu); },
      fsFingerprint: async () => { calls.fsFingerprint++; return next(queues.fsPrints); },
    },
  };
}
const fakeClock = () => { const clock = () => clock.now; clock.now = 1000; return clock; };
const print = (count, bytes = 10, mtime_max = 5) => ({ count, bytes, mtime_max, truncated: false });

function assertMirrors(state) {
  assert.equal(state.available, state.capability === 'available');
  assert.equal(state.proven, state.proof === 'positive');
  assert.equal(state.scope, 'child-pid');
}

test('limits and ignore defaults are locked and frozen', () => {
  assert.deepEqual(LIMITS, { MIN_CPU_DELTA_MS: 50, MAX_DEPTH: 8, MAX_ENTRIES: 20000, MAX_PROCESSES: 4096,
    PS_TIMEOUT_MS: 2000, DEFAULT_INTERVAL_MS: 15000 });
  assert.deepEqual(DEFAULT_IGNORE_DIRS, ['.git']);
  assert(Object.isFrozen(LIMITS) && Object.isFrozen(DEFAULT_IGNORE_DIRS));
});

test('no sample yet is unavailable/none with the closed shape', () => {
  const proof = createLocalProof({ pid: 1, readers: scripted().readers });
  assert.deepEqual(proof.current(), { capability: 'unavailable', proof: 'none', available: false, proven: false,
    scope: 'child-pid', pid_alive: null, cpu: { available: false, delta_ms: 0 },
    fs: { available: false, changed: false, truncated: false }, sampled_at_ms: null, age_ms: null });
});

test('cpu delta 49 is none and 50 is positive on linux', async () => {
  for (const [delta, expected] of [[49, 'none'], [50, 'positive']]) {
    const proof = createLocalProof({ pid: 7, platform: 'linux', clock: fakeClock(),
      readers: scripted({ cpu: [1000, 1000 + delta] }).readers });
    const first = await proof.sample();
    assert.equal(first.cpu.delta_ms, 0);
    assert.equal(first.proof, 'none');
    const second = await proof.sample();
    assert.equal(second.cpu.delta_ms, delta);
    assert.equal(second.capability, 'available');
    assert.equal(second.proof, expected);
    assertMirrors(second);
  }
});

test('three-state matrix across platforms', async () => {
  // linux idle: measured and stopped
  let proof = createLocalProof({ pid: 7, platform: 'linux', readers: scripted({ cpu: [10, 10] }).readers });
  await proof.sample();
  let state = await proof.sample();
  assert.deepEqual([state.capability, state.proof], ['available', 'none']);
  // win32 idle: cpu unmeasurable, no fs delta
  proof = createLocalProof({ pid: 7, platform: 'win32', roots: ['r'],
    readers: scripted({ cpu: [null], fsPrints: [print(1), print(1)] }).readers });
  await proof.sample();
  state = await proof.sample();
  assert.deepEqual([state.capability, state.proof], ['unavailable', 'none']);
  assert.equal(state.fs.available, true);
  // win32 with fs change: positive while capability stays unavailable
  proof = createLocalProof({ pid: 7, platform: 'win32', roots: ['r'],
    readers: scripted({ cpu: [null], fsPrints: [print(1), print(2)] }).readers });
  await proof.sample();
  state = await proof.sample();
  assert.deepEqual([state.capability, state.proof], ['unavailable', 'positive']);
  assertMirrors(state);
  // dead pid is negative everywhere
  for (const platform of ['linux', 'darwin', 'win32']) {
    proof = createLocalProof({ pid: 7, platform, readers: scripted({ alive: [false] }).readers });
    state = await proof.sample();
    assert.deepEqual([state.capability, state.proof, state.pid_alive], ['available', 'negative', false]);
    assertMirrors(state);
  }
  // pid reader error / unknown
  for (const alive of [() => { throw new Error('boom'); }, null]) {
    proof = createLocalProof({ pid: 7, platform: 'linux', readers: scripted({ alive: [alive], cpu: [0, 500] }).readers });
    await proof.sample();
    state = await proof.sample();
    assert.deepEqual([state.capability, state.proof, state.pid_alive], ['unavailable', 'none', null]);
  }
});

test('fs change calls onWrite once per change', async () => {
  let writes = 0;
  const proof = createLocalProof({ pid: 7, platform: 'linux', roots: ['r'], onWrite: () => { writes++; },
    readers: scripted({ cpu: [0], fsPrints: [print(1), print(2), print(2), print(2, 11), print(2, 11, 9)] }).readers });
  const changed = [];
  for (let index = 0; index < 5; index++) changed.push((await proof.sample()).fs.changed);
  assert.deepEqual(changed, [false, true, false, true, true]);
  assert.equal(writes, 3);
});

test('onWrite errors are swallowed', async () => {
  const proof = createLocalProof({ pid: 7, platform: 'linux', roots: ['r'], onWrite: () => { throw new Error('x'); },
    readers: scripted({ fsPrints: [print(1), print(2)] }).readers });
  await proof.sample();
  assert.equal((await proof.sample()).proof, 'positive');
});

test('stale positive degrades to none with the last capability; negative never expires', async () => {
  for (const [platform, cpu, prints, capability] of [
    ['linux', [0, 100], [null], 'available'],
    ['darwin', [0, 100], [null], 'available'],
    ['win32', [null], [print(1), print(2)], 'unavailable'],
  ]) {
    const clock = fakeClock();
    const proof = createLocalProof({ pid: 7, platform, roots: ['r'], intervalMs: 1000, clock,
      readers: scripted({ cpu, fsPrints: prints }).readers });
    await proof.sample();
    assert.equal((await proof.sample()).proof, 'positive');
    clock.now += 2000;
    assert.equal(proof.current().proof, 'positive');
    assert.equal(proof.current().age_ms, 2000);
    clock.now += 1;
    const stale = proof.current();
    assert.deepEqual([stale.capability, stale.proof, stale.proven], [capability, 'none', false]);
    assertMirrors(stale);
  }
  const clock = fakeClock();
  const scriptedDead = scripted({ alive: [false] });
  const proof = createLocalProof({ pid: 7, platform: 'linux', intervalMs: 1000, clock, readers: scriptedDead.readers });
  await proof.sample();
  clock.now += 1e9;
  assert.equal(proof.current().proof, 'negative');
  await proof.sample();
  assert.equal(scriptedDead.calls.pidAlive, 1, 'negative is final: no further I/O');
});

test('cpu reader error is unavailable, never an exception', async () => {
  const proof = createLocalProof({ pid: 7, platform: 'linux',
    readers: scripted({ cpu: [() => { throw new Error('proc'); }] }).readers });
  const state = await proof.sample();
  assert.deepEqual(state.cpu, { available: false, delta_ms: 0 });
  assert.deepEqual([state.capability, state.proof], ['unavailable', 'none']);
});

test('cpu gap resets the baseline instead of inflating the next delta', async () => {
  const proof = createLocalProof({ pid: 7, platform: 'linux', readers: scripted({ cpu: [0, null, 500, 510] }).readers });
  for (let index = 0; index < 3; index++) await proof.sample();
  assert.equal(proof.current().cpu.delta_ms, 0);
  assert.equal((await proof.sample()).cpu.delta_ms, 10);
});

test('concurrent sample() calls share one in-flight sample', async () => {
  const fake = scripted();
  const proof = createLocalProof({ pid: 7, platform: 'linux', readers: fake.readers });
  const first = proof.sample();
  const second = proof.sample();
  assert.equal(first, second);
  await first;
  assert.equal(fake.calls.pidAlive, 1);
  await proof.sample();
  assert.equal(fake.calls.pidAlive, 2);
});

test('stop() prevents further I/O', async () => {
  const fake = scripted();
  const proof = createLocalProof({ pid: 7, platform: 'linux', readers: fake.readers });
  await proof.sample();
  proof.stop();
  await proof.sample();
  assert.equal(fake.calls.pidAlive, 1);
});

test('empty roots leave fs unavailable without calling the reader', async () => {
  const fake = scripted();
  const proof = createLocalProof({ pid: 7, platform: 'linux', readers: fake.readers });
  assert.equal((await proof.sample()).fs.available, false);
  assert.equal(fake.calls.fsFingerprint, 0);
});

test('pidAlive: invalid pid is null, own pid is alive', async () => {
  for (const pid of [0, -1, 1.5, '12', null, undefined]) assert.equal(await pidAlive(pid), null);
  assert.equal(await pidAlive(process.pid), true);
});

test('proc stat parser survives spaces and parentheses in comm', () => {
  const tail = 'S 42 1 1 0 -1 4194560 100 0 0 0 30 20 0 0 20 0 1 0 100 1000 10';
  assert.deepEqual(parseProcStat(`99 (we ird) )name) ${tail}`), { pid: 99, ppid: 42, cpu_ms: 500 });
  assert.equal(parseProcStat('garbage'), null);
  assert.equal(parseProcStat(null), null);
});

test('ps time parser and tree sum', () => {
  assert.equal(parsePsTime('0:00.05'), 50);
  assert.equal(parsePsTime('12:03.50'), 723500);
  assert.equal(parsePsTime('1:00:00.00'), 3600000);
  assert.equal(parsePsTime('1-00:00:01.00'), 86401000);
  assert.equal(parsePsTime('bad'), null);
  const rows = parsePsOutput('  10   1   0:01.00\n  11  10   0:00.50\n  12  11   0:00.25\n  13   1   9:00.00\nnoise\n');
  assert.equal(rows.length, 4);
  assert.equal(sumProcessTree(rows, 10), 1750);
  assert.equal(sumProcessTree(rows, 999), null);
});

test('linux reader walks a fake /proc tree', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-proc-'));
  try {
    const stat = (pid, ppid, utime) => `${pid} (n ame) S ${ppid} 0 0 0 0 0 0 0 0 0 ${utime} 0 0 0`;
    for (const [pid, ppid, utime] of [[10, 1, 100], [11, 10, 50], [12, 11, 5], [20, 1, 999]]) {
      fs.mkdirSync(path.join(root, String(pid)));
      fs.writeFileSync(path.join(root, String(pid), 'stat'), stat(pid, ppid, utime));
    }
    fs.mkdirSync(path.join(root, 'self'));
    assert.equal(await linuxCpuTreeMs(10, { procRoot: root }), 1550);
    assert.equal(await linuxCpuTreeMs(404, { procRoot: root }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('darwin reader uses fixed argv without shell and tolerates errors', async () => {
  let seen = null;
  const ok = (file, args, opts, callback) => { seen = { file, args, opts }; callback(null, '5 1 0:01.00\n6 5 0:00.10\n'); };
  assert.equal(await darwinCpuTreeMs(5, { execFile: ok }), 1100);
  assert.equal(seen.file, 'ps');
  assert.deepEqual(seen.args, ['-A', '-o', 'pid=,ppid=,time=']);
  assert.equal(seen.opts.timeout, 2000);
  assert.equal(seen.opts.windowsHide, true);
  assert.equal(seen.opts.shell, undefined);
  assert.equal(await darwinCpuTreeMs(5, { execFile: (f, a, o, cb) => cb(new Error('timeout')) }), null);
  assert.equal(await darwinCpuTreeMs(5, { execFile: () => { throw new Error('spawn'); } }), null);
  assert.equal(await darwinCpuTreeMs(-1), null);
});

// ---------------------------------------------------------------- real fs

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-local-proof-'));
  for (const dir of ['src', '.git', path.join('.gsd', 'forge'), path.join('deep', '.git')]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'src', 'seed.txt'), 'seed');
  return root;
}

test('real fs: forge/git/receipt writes are filtered, src write is detected once', async () => {
  const root = tempRoot();
  try {
    let writes = 0;
    const proof = createLocalProof({ pid: process.pid, roots: [root], onWrite: () => { writes++; },
      ignore: { prefixes: [path.join(root, 'out.json')] } });
    const base = await proof.sample();
    assert.equal(base.fs.available, true);
    fs.writeFileSync(path.join(root, '.git', 'x'), 'x');
    fs.writeFileSync(path.join(root, 'deep', '.git', 'x'), 'x');
    fs.writeFileSync(path.join(root, '.gsd', 'forge', 'x'), 'x');
    fs.writeFileSync(path.join(root, 'out.json'), '{}');
    fs.writeFileSync(path.join(root, 'out.json.receipt.json'), '{}');
    const filtered = await proof.sample();
    assert.equal(filtered.fs.changed, false);
    assert.equal(writes, 0);
    fs.writeFileSync(path.join(root, 'src', 'x'), 'payload');
    const detected = await proof.sample();
    assert.equal(detected.fs.changed, true);
    assert.equal(detected.proof, 'positive');
    assert.equal(writes, 1);
    assert.equal((await proof.sample()).fs.changed, false);
    assert.equal(writes, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('real fs: prefixes compare case-insensitively on win32 only', async () => {
  const root = tempRoot();
  try {
    const before = await fsFingerprint([root], { prefixes: [path.join(root, 'OUT.json')] }, process.platform);
    fs.writeFileSync(path.join(root, 'out.json.receipt.json'), '{}');
    const after = await fsFingerprint([root], { prefixes: [path.join(root, 'OUT.json')] }, process.platform);
    if (process.platform === 'win32') assert.equal(after.count, before.count);
    else assert.equal(after.count, before.count + 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('real fs: depth and entry limits report truncated honestly; missing roots are null', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-local-proof-'));
  try {
    let dir = root;
    for (let level = 0; level < LIMITS.MAX_DEPTH + 2; level++) { dir = path.join(dir, `d${level}`); fs.mkdirSync(dir); }
    assert.equal((await fsFingerprint([root])).truncated, true);
    const flat = path.join(root, 'flat');
    fs.mkdirSync(flat);
    for (let index = 0; index < 5; index++) fs.writeFileSync(path.join(flat, `f${index}`), 'x');
    const capped = await fsFingerprint([flat], {}, process.platform, { ...LIMITS, MAX_ENTRIES: 3 });
    assert.deepEqual([capped.count, capped.truncated], [3, true]);
    const full = await fsFingerprint([flat]);
    assert.deepEqual([full.count, full.bytes, full.truncated], [5, 5, false]);
    assert.equal(await fsFingerprint([path.join(root, 'missing')]), null);
    assert.equal(await fsFingerprint([]), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('real fs: entry budget bounds lstat work (R4)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-local-proof-'));
  const original = fs.promises.lstat;
  try {
    for (let index = 0; index < 100; index++) fs.writeFileSync(path.join(root, `f${index}`), 'x');
    let calls = 0;
    fs.promises.lstat = (...args) => { calls++; return original.apply(fs.promises, args); };
    const capped = await fsFingerprint([root], {}, process.platform, { ...LIMITS, MAX_ENTRIES: 3 });
    fs.promises.lstat = original;
    assert.deepEqual([capped.count, capped.truncated], [3, true]);
    assert.ok(calls <= 1 + 3, `lstat calls bounded by budget, got ${calls}`);
  } finally { fs.promises.lstat = original; fs.rmSync(root, { recursive: true, force: true }); }
});

test('real fs: depth truncation skips only its subtree (R5)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-local-proof-'));
  try {
    let dir = path.join(root, 'zdeep');
    fs.mkdirSync(dir);
    for (let level = 0; level < LIMITS.MAX_DEPTH + 2; level++) { dir = path.join(dir, `d${level}`); fs.mkdirSync(dir); }
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.txt'), 'abcd');
    const print = await fsFingerprint([root]);
    assert.equal(print.truncated, true);
    assert.equal(print.bytes, 4);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- real child

function spawnChild(source) {
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const lines = [];
  const waiters = [];
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      lines.push(buffer.slice(0, index).trim());
      buffer = buffer.slice(index + 1);
      for (const waiter of waiters.splice(0)) waiter();
    }
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const waitFor = async (line, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (!lines.includes(line)) {
      if (Date.now() > deadline) throw new Error(`child did not print ${line}`);
      await Promise.race([new Promise(resolve => waiters.push(resolve)), sleep(50)]);
    }
  };
  const kill = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.race([exited, sleep(2000)]);
  };
  return { child, waitFor, kill, exited };
}

const BUSY = "console.log('ready');const end=Date.now()+350;while(Date.now()<end){}"
  + "console.log('done');setTimeout(()=>{},20000);";
const IDLE = "console.log('ready');setTimeout(()=>{},20000);";

test('real child: busy child is measured on linux/darwin; win32 reports cpu unavailable', async () => {
  const runner = spawnChild(BUSY);
  try {
    await runner.waitFor('ready');
    const proof = createLocalProof({ pid: runner.child.pid });
    await proof.sample();
    await runner.waitFor('done');
    const state = await proof.sample();
    if (HOST_HAS_CPU) {
      assert.equal(state.cpu.available, true);
      assert(state.cpu.delta_ms >= LIMITS.MIN_CPU_DELTA_MS, `cpu delta ${state.cpu.delta_ms}`);
      assert.deepEqual([state.capability, state.proof], ['available', 'positive']);
    } else {
      assert.equal(state.cpu.available, false);
      console.log(`SKIP cpu (${process.platform})`);
    }
  } finally { await runner.kill(); }
});

test('real child: idle without writes is none (available on linux/darwin, unavailable on win32); killed is negative', async () => {
  const root = tempRoot();
  const runner = spawnChild(IDLE);
  try {
    await runner.waitFor('ready');
    await sleep(150); // let startup work settle before the baseline
    const proof = createLocalProof({ pid: runner.child.pid, roots: [root] });
    await proof.sample();
    await sleep(200);
    const idle = await proof.sample();
    assert.equal(idle.pid_alive, true);
    assert.equal(idle.proof, 'none', `idle cpu delta ${idle.cpu.delta_ms}`);
    assert.equal(idle.capability, HOST_HAS_CPU ? 'available' : 'unavailable');
    fs.writeFileSync(path.join(root, 'src', 'x'), 'payload');
    const written = await proof.sample();
    assert.deepEqual([written.fs.changed, written.proof], [true, 'positive']);
    runner.child.kill();
    await runner.exited;
    const dead = await proof.sample();
    assert.deepEqual([dead.pid_alive, dead.capability, dead.proof], [false, 'available', 'negative']);
  } finally {
    await runner.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function main() {
  let failures = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}`); console.error(error); }
  }
  console.log(`${tests.length - failures}/${tests.length} sidecar local proof tests passed`);
  if (failures) process.exitCode = 1;
}

if (require.main === module) main();
