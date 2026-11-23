#!/usr/bin/env node
'use strict';

// Zero-dep standalone suite for forge-resources.js, in the repo's
// check()/assert() style (see forge-dispatch-resolve.test.js). Every
// pressure-dependent assertion uses injection seams (readSignal / now /
// platform / env) — nothing here depends on, or pressurizes, the real
// machine's memory state (W5: the baseline moves while you measure it).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  resolveResourceBudget,
  readPressureSignal,
  REASON_CODES,
  parseArgs,
  runCli,
  degradedContract,
  resetResourceCache,
  acquireCommandBudget,
  releaseCommandBudget,
} = require('./forge-resources.js');
const { POOL_REASON_CODES } = require('./forge-resource-pool.js');

const SCRIPT = path.join(__dirname, 'forge-resources.js');
let passes = 0;
let fails = 0;

function pass(name) {
  passes += 1;
  process.stdout.write(`  ✓ ${name}\n`);
}

function fail(name, detail) {
  fails += 1;
  process.stdout.write(`  ✗ ${name}\n    ${detail || 'assertion failed'}\n`);
}

function assert(condition, name, detail) {
  if (condition) pass(name);
  else fail(name, detail);
}

function assertEqual(actual, expected, name) {
  assert(actual === expected, name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function mkTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-resources-test-'));
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── REASON_CODES is frozen ────────────────────────────────────────────────
(function testFrozenEnum() {
  assert(Object.isFrozen(REASON_CODES), 'REASON_CODES is frozen');
  const requiredMembers = [
    'PRESSURE_NORMAL', 'PRESSURE_WARN', 'PRESSURE_CRITICAL_MEASURED', 'PRESSURE_CRITICAL_FORCED',
    'PLATFORM_UNSUPPORTED_LINUX', 'PLATFORM_UNSUPPORTED_WIN32', 'SYSCTL_SPAWN_FAILED',
    'SYSCTL_PARSE_FAILED', 'SHADOW_WAIT', 'INTERNAL_ERROR_DEGRADED',
  ];
  requiredMembers.forEach((key) => {
    assert(typeof REASON_CODES[key] === 'string' && REASON_CODES[key].length > 0, `REASON_CODES.${key} is defined`);
  });
  let threw = false;
  try { REASON_CODES.NEW_KEY = 'nope'; } catch { threw = true; }
  assert(REASON_CODES.NEW_KEY === undefined, 'REASON_CODES rejects new keys (frozen)', threw ? 'threw as expected in strict mode' : '');
})();

// ── os.freemem() is never used as a signal ────────────────────────────────
(function testNoFreemem() {
  const src = fs.readFileSync(path.join(__dirname, 'forge-resources.js'), 'utf8');
  assert(!/os\.freemem\(/.test(src), 'forge-resources.js never calls os.freemem()');
})();

// ── Forced pressure (D1/B1): admit:false under forced critical ───────────
(function testForcedCritical() {
  resetResourceCache();
  const result = resolveResourceBudget({ env: { FORGE_RESOURCES_PRESSURE: '4' }, cwd: mkTmpDirNoop(), noEvents: true });
  assertEqual(result.admit, false, 'forced critical pressure -> admit:false');
  assertEqual(result.reason, REASON_CODES.PRESSURE_CRITICAL_FORCED, 'forced critical reason names the forced source');
  assert(result.reason !== REASON_CODES.PRESSURE_CRITICAL_MEASURED, 'forced reason is distinct from the measured reason');
  assertEqual(result.source, 'forced-env', 'forced critical source is forced-env');
})();

function mkTmpDirNoop() {
  return process.cwd();
}

// ── Forced pressure: admit:true under forced normal ───────────────────────
(function testForcedNormal() {
  resetResourceCache();
  const result = resolveResourceBudget({ env: { FORGE_RESOURCES_PRESSURE: '1' }, cwd: mkTmpDirNoop(), noEvents: true });
  assertEqual(result.admit, true, 'forced normal pressure -> admit:true');
  assert(result.workers >= 1, 'forced normal workers >= 1', `got ${result.workers}`);
  assert(result.heapMb > 0, 'forced normal heapMb > 0', `got ${result.heapMb}`);
})();

// ── Batched single spawn + TTL cache, via injected reader + clock ────────
(function testBatchedSingleSpawnAndCache() {
  resetResourceCache();
  let spawnCount = 0;
  const injectedReader = () => {
    spawnCount += 1;
    return { ok: true, pressureLevel: 1, ncpu: 4, memBytes: 8 * 1024 * 1024 * 1024, memstatusLevel: 10, swap: { totalM: 100, usedM: 10, freeM: 90 } };
  };
  let clock = 1000;
  const now = () => clock;

  const first = resolveResourceBudget({ platform: 'darwin', readSignal: injectedReader, now, cacheKey: 'test-batch', noEvents: true });
  assertEqual(spawnCount, 1, 'first resolve invokes the reader exactly once');
  const second = resolveResourceBudget({ platform: 'darwin', readSignal: injectedReader, now, cacheKey: 'test-batch', noEvents: true });
  assertEqual(spawnCount, 1, 'second resolve inside TTL reuses the cache (reader NOT re-invoked)');
  assertEqual(first.reason, second.reason, 'cached resolve returns the same reason');

  clock += 5000; // advance well past the ~2s TTL
  resolveResourceBudget({ platform: 'darwin', readSignal: injectedReader, now, cacheKey: 'test-batch', noEvents: true });
  assertEqual(spawnCount, 2, 'resolve after TTL expiry re-invokes the reader');
})();

// ── readPressureSignal itself issues exactly ONE spawnSync call ──────────
(function testReadPressureSignalSingleSpawn() {
  let spawnCalls = 0;
  const fakeSpawn = (cmd, args) => {
    spawnCalls += 1;
    assertEqual(cmd, 'sysctl', 'probe spawns the sysctl binary');
    assert(Array.isArray(args) && args.length === 6 && args[0] === '-n', 'probe requests all 5 keys in one batched call', `args=${JSON.stringify(args)}`);
    return { status: 0, error: null, stdout: '1\n10\ntotal = 5120.00M  used = 4792.00M  free = 328.00M  (encrypted)\n8\n17179869184\n' };
  };
  const signal = readPressureSignal({ spawn: fakeSpawn });
  assertEqual(spawnCalls, 1, 'readPressureSignal calls spawn exactly once (batched)');
  assert(signal.ok === true, 'batched parse succeeds', JSON.stringify(signal));
  assertEqual(signal.pressureLevel, 1, 'parses pressure level from first line');
  assertEqual(signal.ncpu, 8, 'parses ncpu');
  assertEqual(signal.memBytes, 17179869184, 'parses memsize');
  assert(signal.swap && signal.swap.usedM === 4792, 'parses vm.swapusage used value', JSON.stringify(signal.swap));
})();

// ── sysctl spawn/parse failure paths never throw ──────────────────────────
(function testSysctlFailurePaths() {
  const spawnFails = () => ({ status: 1, error: null, stdout: '' });
  const spawnFail = readPressureSignal({ spawn: spawnFails });
  assertEqual(spawnFail.ok, false, 'non-zero exit is treated as spawn failure');
  assertEqual(spawnFail.reason, REASON_CODES.SYSCTL_SPAWN_FAILED, 'spawn failure reason is named');

  const spawnThrows = () => { throw new Error('boom'); };
  const spawnThrow = readPressureSignal({ spawn: spawnThrows });
  assertEqual(spawnThrow.ok, false, 'a throwing spawn never propagates');
  assertEqual(spawnThrow.reason, REASON_CODES.SYSCTL_SPAWN_FAILED, 'throwing spawn reason is named');

  const spawnGarbage = () => ({ status: 0, error: null, stdout: 'not-numeric\ngarbage\n' });
  const parseFail = readPressureSignal({ spawn: spawnGarbage });
  assertEqual(parseFail.ok, false, 'malformed output is treated as parse failure');
  assertEqual(parseFail.reason, REASON_CODES.SYSCTL_PARSE_FAILED, 'parse failure reason is named');
})();

// ── Non-darwin platform degrades fail-open with a named enum reason ──────
(function testPlatformDegradation() {
  resetResourceCache();
  const linux = resolveResourceBudget({ platform: 'linux', noEvents: true });
  assertEqual(linux.admit, true, 'linux degrades fail-open (admit:true)');
  assertEqual(linux.reason, REASON_CODES.PLATFORM_UNSUPPORTED_LINUX, 'linux reason names platform-unsupported:linux');

  const win = resolveResourceBudget({ platform: 'win32', noEvents: true });
  assertEqual(win.admit, true, 'win32 degrades fail-open (admit:true)');
  assertEqual(win.reason, REASON_CODES.PLATFORM_UNSUPPORTED_WIN32, 'win32 reason names platform-unsupported:win32');

  const other = resolveResourceBudget({ platform: 'freebsd', noEvents: true });
  assertEqual(other.admit, true, 'unknown platform degrades fail-open (admit:true)');
  assertEqual(other.reason, REASON_CODES.PLATFORM_UNSUPPORTED_OTHER, 'unknown platform falls back to the generic named reason');
})();

// ── Shadow-wait: emitted without sleeping (injected clock) ───────────────
(function testShadowWaitNoSleep() {
  resetResourceCache();
  const startedAt = Date.now();
  const dir = mkTmpDir();
  fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
  const injectedReader = () => ({ ok: true, pressureLevel: 4, ncpu: 8, memBytes: 16 * 1024 * 1024 * 1024, memstatusLevel: 95, swap: { totalM: 5120, usedM: 4792, freeM: 328 } });
  const result = resolveResourceBudget({
    platform: 'darwin',
    readSignal: injectedReader,
    now: () => 42,
    cacheKey: 'shadow-wait-test',
    cwd: dir,
    prefsResult: { prefs: { resources: { shadow_wait: true, wait_cap_ms: 30000, enforcement: 'clamp' } } },
  });
  assertEqual(result.admit, false, 'critical pressure still refuses admission with shadow_wait on');
  assert(result.shadowWait && result.shadowWait.triggered === true, 'shadow-wait is triggered under critical pressure', JSON.stringify(result.shadowWait));
  assertEqual(result.shadowWait.wouldWaitMs, 30000, 'shadow-wait reports the would-have-waited duration from wait_cap_ms');
  const elapsedMs = Date.now() - startedAt;
  assert(elapsedMs < 500, 'no real sleep occurred (elapsed well under 500ms)', `elapsed=${elapsedMs}ms`);

  const eventsPath = path.join(dir, '.gsd', 'forge', 'events.jsonl');
  assert(fs.existsSync(eventsPath), 'shadow-wait event file was written');
  const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n');
  const shadowLine = lines.find((line) => line.includes('"kind":"shadow-wait"'));
  assert(!!shadowLine, 'a shadow-wait event line was appended', lines.join('\n'));
  cleanup(dir);
})();

// ── Every degradation path returns a member of the frozen enum ───────────
(function testEveryDegradationIsEnumMember() {
  const enumValues = new Set(Object.values(REASON_CODES));
  resetResourceCache();
  const cases = [
    resolveResourceBudget({ env: { FORGE_RESOURCES_PRESSURE: '4' }, noEvents: true }),
    resolveResourceBudget({ env: { FORGE_RESOURCES_PRESSURE: '1' }, noEvents: true }),
    resolveResourceBudget({ platform: 'linux', noEvents: true }),
    resolveResourceBudget({ platform: 'win32', noEvents: true }),
    resolveResourceBudget({ platform: 'darwin', readSignal: () => ({ ok: false, reason: REASON_CODES.SYSCTL_SPAWN_FAILED }), now: () => Date.now(), cacheKey: 'enum-test-1', noEvents: true }),
  ];
  cases.forEach((result, i) => {
    assert(enumValues.has(result.reason), `case[${i}] reason "${result.reason}" is a frozen enum member`);
  });
})();

// ── D7: single N + one Playwright cap, no per-runner weight table ────────
(function testNoPerRunnerWeightTable() {
  const src = fs.readFileSync(path.join(__dirname, 'forge-resources.js'), 'utf8');
  assert(!/weightTable|runnerWeights|weight_table/i.test(src), 'no per-runner weight table symbol exists in the module source');
  resetResourceCache();
  const normal = resolveResourceBudget({ env: { FORGE_RESOURCES_PRESSURE: '1' }, noEvents: true });
  assert(typeof normal.playwrightWorkers === 'number', 'playwrightWorkers is a single numeric cap field', JSON.stringify(normal));
})();

// ── CLI degrades to a safe default and exits 0 on internal failure ───────
(function testCliDegradesAndExitsZero() {
  // Written NEXT TO forge-resources.js (not a separate tmp dir) so its
  // `require('./forge-prefs.js')` still resolves — only the CLI entrypoint
  // is patched to force an internal throw; the module body is untouched.
  // Unique per-process/per-run suffix (PID + timestamp): this repo's own
  // premise is concurrent runs on one machine, so a fixed scratch filename
  // is a self-collision hazard, not a hypothetical (R10). Must stay next to
  // forge-resources.js (not moved to a tmp dir) so `require('./forge-prefs.js')`
  // still resolves relative to this file.
  const brokenScript = path.join(__dirname, `__forge-resources-broken-test-tmp.${process.pid}-${Date.now()}.js`);
  const realSrc = fs.readFileSync(SCRIPT, 'utf8');
  const injected = realSrc.replace(
    'function runCli(args) {\n  const parsed = parseArgs(args || []);',
    "function runCli(args) {\n  if (process.env.__FORGE_RESOURCES_TEST_FORCE_THROW__ === '1') { throw new Error('forced test failure'); }\n  const parsed = parseArgs(args || []);"
  );
  assert(injected !== realSrc, 'broken-CLI fixture patch actually matched runCli()');
  fs.writeFileSync(brokenScript, injected);
  try {
    const cli = spawnSync('node', [brokenScript], { encoding: 'utf8', env: { ...process.env, __FORGE_RESOURCES_TEST_FORCE_THROW__: '1' } });
    assertEqual(cli.status, 0, 'CLI exits 0 even when runCli throws internally');
    let parsed = null;
    try { parsed = JSON.parse(cli.stdout.trim()); } catch (error) { fail('broken CLI stdout is valid JSON', `${error.message}\nstdout=${cli.stdout}\nstderr=${cli.stderr}`); }
    assert(parsed && parsed.reason === REASON_CODES.INTERNAL_ERROR_DEGRADED, 'broken CLI emits the internal-error-degraded contract', JSON.stringify(parsed));
    assert(parsed && parsed.admit === true, 'degraded CLI contract is fail-open (admit:true)', JSON.stringify(parsed));
  } finally {
    try { fs.unlinkSync(brokenScript); } catch { /* ignore */ }
  }
})();

// ── CLI happy path on the real darwin machine ─────────────────────────────
(function testCliHappyPath() {
  // --cwd points at a fresh tmp dir with no .gsd/ so this run cannot append
  // to the real dogfood events.jsonl (R9): resource-admission/degradation
  // events are only written when `<cwd>/.gsd` exists.
  const dir = mkTmpDir();
  const cli = spawnSync('node', [SCRIPT, '--json', '--cwd', dir], { encoding: 'utf8', env: { ...process.env, FORGE_RESOURCES_PRESSURE: '1' } });
  assertEqual(cli.status, 0, 'real CLI exits 0');
  let parsed = null;
  try { parsed = JSON.parse(cli.stdout.trim()); } catch (error) { fail('real CLI stdout is valid one-line JSON', `${error.message}\nstdout=${cli.stdout}`); }
  assert(parsed, 'real CLI produced parseable output');
  if (parsed) {
    ['admit', 'workers', 'heapMb', 'playwrightWorkers', 'reason', 'pressureLevel', 'enforcement', 'shadowWait', 'source'].forEach((key) => {
      assert(Object.prototype.hasOwnProperty.call(parsed, key), `real CLI contract includes stable key "${key}"`, JSON.stringify(parsed));
    });
    assertEqual(parsed.admit, true, 'real CLI forced-normal run admits');
  }
  cleanup(dir);
})();

// ── degradedContract() direct shape check ─────────────────────────────────
(function testDegradedContractShape() {
  const contract = degradedContract();
  assertEqual(contract.reason, REASON_CODES.INTERNAL_ERROR_DEGRADED, 'degradedContract() reason is internal-error-degraded');
  assertEqual(contract.admit, true, 'degradedContract() is fail-open');
})();

// ── parseArgs basic coverage ────────────────────────────────────────────
(function testParseArgs() {
  const parsed = parseArgs(['--cwd', '/tmp/x', '--json', '--platform', 'darwin']);
  assertEqual(parsed.cwd, '/tmp/x', 'parseArgs reads --cwd');
  assertEqual(parsed.asJson, true, 'parseArgs reads --json');
  assertEqual(parsed.platform, 'darwin', 'parseArgs reads --platform');
})();

// ── runCli() is callable as a library function too ────────────────────────
(function testRunCliLibrary() {
  const originalWrite = process.stdout.write;
  let captured = '';
  process.stdout.write = (chunk) => { captured += chunk; return true; };
  // --cwd points at a fresh tmp dir with no .gsd/ so this call cannot append
  // to the real dogfood events.jsonl (R9) — resolveResourceBudget only
  // writes events when `<cwd>/.gsd` exists.
  const dir = mkTmpDir();
  let result;
  try {
    result = runCli(['--platform', 'linux', '--cwd', dir]);
  } finally {
    process.stdout.write = originalWrite;
  }
  assertEqual(result.reason, REASON_CODES.PLATFORM_UNSUPPORTED_LINUX, 'runCli() as a library call returns the resolved contract');
  assert(captured.trim().length > 0, 'runCli() also wrote a JSON line to stdout');
  cleanup(dir);
})();

// ── T02: pool-absent byte-stability (S01 contract stays byte-identical) ──
(function testPoolAbsentByteStability() {
  resetResourceCache();
  const result = resolveResourceBudget({ env: { FORGE_RESOURCES_PRESSURE: '1' }, cacheKey: 'pool-absent-1', noEvents: true });
  const s01StablePrefix = ['admit', 'workers', 'heapMb', 'playwrightWorkers', 'reason', 'pressureLevel', 'enforcement', 'shadowWait', 'source'];
  const expectedKeys = new Set([...s01StablePrefix, 'maxConcurrentClamp']);
  const actualKeys = new Set(Object.keys(result));
  assertEqual(actualKeys.size, expectedKeys.size, 'pool-absent contract key COUNT matches S01 stable prefix + maxConcurrentClamp exactly');
  let allPresent = true;
  expectedKeys.forEach((key) => { if (!actualKeys.has(key)) allPresent = false; });
  assert(allPresent, 'pool-absent contract has every expected key', JSON.stringify([...actualKeys]));
  assert(!Object.prototype.hasOwnProperty.call(result, 'pool'), 'pool-absent contract carries NO "pool" key', JSON.stringify(Object.keys(result)));
})();

// ── T02: injected opts.pool.status discount (pure — no I/O) ──────────────
(function testPoolStatusDiscount() {
  const fixedNcpuReader = (ncpu) => () => ({
    ok: true, pressureLevel: 1, ncpu, memBytes: 8 * 1024 * 1024 * 1024, memstatusLevel: 10,
    swap: { totalM: 100, usedM: 10, freeM: 90 },
  });

  // free < formula -> clamped
  resetResourceCache();
  let r = resolveResourceBudget({
    platform: 'darwin', readSignal: fixedNcpuReader(8), now: Date.now, cacheKey: 'pool-clamp', noEvents: true,
    pool: { status: { ceiling: 8, free: 3 } },
  });
  assertEqual(r.workers, 3, 'free(3) < formula(8) clamps workers down to free');
  assertEqual(r.pool.reason, POOL_REASON_CODES.POOL_CLAMPED_BY_POOL, 'clamped case names pool-clamped-by-pool');
  assertEqual(r.pool.free, 3, 'clamped pool key reports the injected free count');

  // free >= formula -> uncut
  resetResourceCache();
  r = resolveResourceBudget({
    platform: 'darwin', readSignal: fixedNcpuReader(4), now: Date.now, cacheKey: 'pool-uncut', noEvents: true,
    pool: { status: { ceiling: 8, free: 8 } },
  });
  assertEqual(r.workers, 4, 'free(8) >= formula(4) leaves workers uncut');
  assertEqual(r.pool.reason, POOL_REASON_CODES.POOL_GRANTED, 'uncut case names pool-granted');

  // free = 0 -> floor 1
  resetResourceCache();
  r = resolveResourceBudget({
    platform: 'darwin', readSignal: fixedNcpuReader(4), now: Date.now, cacheKey: 'pool-floor', noEvents: true,
    pool: { status: { ceiling: 8, free: 0 } },
  });
  assertEqual(r.workers, 1, 'free=0 floors workers at the minimum grant of 1');
  assertEqual(r.pool.reason, POOL_REASON_CODES.POOL_EXHAUSTED_MINIMUM_GRANT, 'floor case names pool-exhausted-minimum-grant');

  // critical pressure + pool -> admit:false, workers:0 (pool never raises a refusal)
  resetResourceCache();
  r = resolveResourceBudget({
    env: { FORGE_RESOURCES_PRESSURE: '4' }, noEvents: true,
    pool: { status: { ceiling: 8, free: 8 } },
  });
  assertEqual(r.admit, false, 'critical pressure still refuses admission even with a wide-open pool injected');
  assertEqual(r.workers, 0, 'the pool NEVER raises a refused budget above 0 workers');
})();

// ── T02: lifecycle acquire -> release round-trip against a real temp pool ─
(function testLifecycleRoundTrip() {
  const dir = mkTmpDir();
  const poolDir = path.join(dir, 'pool');
  resetResourceCache();
  const acquired = acquireCommandBudget({
    platform: 'darwin',
    readSignal: () => ({ ok: true, pressureLevel: 1, ncpu: 4, memBytes: 8 * 1024 * 1024 * 1024, memstatusLevel: 10, swap: { totalM: 100, usedM: 10, freeM: 90 } }),
    now: Date.now,
    cacheKey: 'lifecycle-round-trip',
    noEvents: true,
    poolDir,
    ncpu: 8,
    commandTimeoutMs: 5000,
  });
  assertEqual(acquired.admit, true, 'lifecycle acquire admits under normal pressure');
  assert(acquired.pool && acquired.pool.handle && Array.isArray(acquired.pool.handle.slots) && acquired.pool.handle.slots.length > 0,
    'lifecycle acquire holds at least one real lease slot', JSON.stringify(acquired.pool));

  const { poolStatus } = require('./forge-resource-pool.js');
  const statusHeld = poolStatus({ poolDir });
  assert(statusHeld.held >= acquired.pool.handle.slots.length, 'poolStatus() shows held slots after acquire', JSON.stringify(statusHeld));

  const released = releaseCommandBudget(acquired.pool.handle, { poolDir });
  assertEqual(released.ok, true, 'release reports ok:true');

  const statusFree = poolStatus({ poolDir });
  assertEqual(statusFree.held, 0, 'poolStatus() shows 0 held slots after release', JSON.stringify(statusFree));
  cleanup(dir);
})();

// ── T02: fail-open when the pool root is broken (poolDir points at a file) ─
(function testAcquireFailOpen() {
  const dir = mkTmpDir();
  const brokenPoolDir = path.join(dir, 'not-a-dir');
  fs.writeFileSync(brokenPoolDir, 'this is a file, not a pool root\n');
  resetResourceCache();
  let threw = false;
  let acquired;
  try {
    acquired = acquireCommandBudget({
      platform: 'darwin',
      readSignal: () => ({ ok: true, pressureLevel: 1, ncpu: 4, memBytes: 8 * 1024 * 1024 * 1024, memstatusLevel: 10, swap: { totalM: 100, usedM: 10, freeM: 90 } }),
      now: Date.now,
      cacheKey: 'lifecycle-fail-open',
      noEvents: true,
      poolDir: brokenPoolDir,
    });
  } catch {
    threw = true;
  }
  assert(!threw, 'a broken pool root never throws out of acquireCommandBudget');
  assertEqual(acquired.admit, true, 'fail-open still returns the formula-only admitted contract');
  assertEqual(acquired.workers, 4, 'fail-open workers fall back to the formula budget (unpooled)');
  assert(acquired.pool && acquired.pool.reason === 'pool-unavailable-fail-open', 'fail-open pool key names pool-unavailable-fail-open', JSON.stringify(acquired.pool));
  cleanup(dir);
})();

// ── T02: maxConcurrentClamp both directions + unreadable-prefs default ───
(function testMaxConcurrentClamp() {
  resetResourceCache();
  let r = resolveResourceBudget({
    platform: 'darwin', readSignal: () => ({ ok: true, pressureLevel: 1, ncpu: 8, memBytes: 8 * 1024 * 1024 * 1024, memstatusLevel: 10, swap: { totalM: 100, usedM: 10, freeM: 90 } }),
    now: Date.now, cacheKey: 'clamp-8', noEvents: true,
    prefsResult: { prefs: { parallelism: { max_concurrent: 3 } } },
  });
  assertEqual(r.workers, 8, 'sanity: formula workers is 8 before clamp assertion');
  assertEqual(r.maxConcurrentClamp, 3, 'pref max_concurrent=3 with workers=8 clamps maxConcurrentClamp to 3');

  resetResourceCache();
  r = resolveResourceBudget({
    platform: 'darwin', readSignal: () => ({ ok: true, pressureLevel: 2, ncpu: 2, memBytes: 8 * 1024 * 1024 * 1024, memstatusLevel: 10, swap: { totalM: 100, usedM: 10, freeM: 90 } }),
    now: Date.now, cacheKey: 'clamp-1', noEvents: true,
    prefsResult: { prefs: { parallelism: { max_concurrent: 3 } } },
  });
  assertEqual(r.workers, 1, 'sanity: formula workers is 1 (level-2, ncpu=2, floor(2/2)=1) before clamp assertion');
  assertEqual(r.maxConcurrentClamp, 1, 'workers=1 with pref max_concurrent=3 clamps to workers (1), never above it');

  resetResourceCache();
  r = resolveResourceBudget({
    platform: 'darwin', readSignal: () => ({ ok: true, pressureLevel: 1, ncpu: 8, memBytes: 8 * 1024 * 1024 * 1024, memstatusLevel: 10, swap: { totalM: 100, usedM: 10, freeM: 90 } }),
    now: Date.now, cacheKey: 'clamp-unreadable', noEvents: true,
    prefsResult: { prefs: {} },
  });
  assertEqual(r.maxConcurrentClamp, 3, 'unreadable/missing parallelism.max_concurrent falls back to the documented default (3)');
})();

// ── R2 fix: acquireCommandBudget must never authorize more workers than
// leases it actually holds. `grant.free_before` is a pre-acquire census,
// separated from the acquire loop by a non-atomic cross-process window; a
// rival can consume slots inside that window. Reproduce deterministically
// by injecting a fake forge-resource-pool.js module whose acquireSlots()
// returns exactly that race shape: free_before(3) > slots actually leased(1).
(function testAcquireNeverExceedsLeasedSlots() {
  const poolPath = require.resolve('./forge-resource-pool.js');
  const real = require(poolPath);
  const fakeGrant = {
    ok: true,
    granted: 1,
    reason: POOL_REASON_CODES.POOL_CLAMPED_BY_POOL,
    ceiling: 4,
    free_before: 3, // stale census: a rival grabbed 2 of these 3 mid-race
    slots: [{ key: 'resource-pool/slot-0', owner_token: 'fake-owner', generation: 1 }],
    ttlMs: 5000,
  };
  const fakePool = {
    ...real,
    ensurePoolRoot: () => ({ ok: true, root: '/tmp/fake-root', ceiling: 4, created: false }),
    acquireSlots: () => fakeGrant,
    releaseSlots: (slots) => ({ ok: true, released: (slots || []).map((s) => ({ key: s.key, ok: true, reason: POOL_REASON_CODES.POOL_RELEASED })) }),
  };
  const originalModule = require.cache[poolPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: fakePool };
  try {
    resetResourceCache();
    const r = acquireCommandBudget({
      platform: 'darwin',
      readSignal: () => ({ ok: true, pressureLevel: 1, ncpu: 4, memBytes: 8 * 1024 * 1024 * 1024, memstatusLevel: 10, swap: { totalM: 100, usedM: 10, freeM: 90 } }),
      now: Date.now,
      cacheKey: 'r2-race',
      noEvents: true,
    });
    assertEqual(r.workers, 1, 'workers follows grant.granted (1 leased), never the stale free_before(3) census');
    assertEqual(r.pool.granted, 1, 'pool.granted reflects the real lease count, not the stale census');
    assertEqual(r.pool.reason, POOL_REASON_CODES.POOL_CLAMPED_BY_POOL, 'pool.reason reflects the real clamped grant, not a recomputed pool-granted');
    assertEqual(r.pool.handle.slots.length, 1, 'the release handle carries exactly the leases actually held');
  } finally {
    if (originalModule) require.cache[poolPath] = originalModule;
    else delete require.cache[poolPath];
  }
})();


// Issue 451: real resource lifecycle telemetry never bypasses an explicit sink.
(function testResourceEventSinkLifecycle() {
  const strict = require('node:assert/strict');
  for (const mode of ['sink', 'throwing-sink', 'no-sink', 'no-events', 'sink-without-gsd']) {
    const dir = mkTmpDir(), poolDir = path.join(dir, 'pool');
    const events = path.join(dir, '.gsd', 'forge', 'events.jsonl');
    const sentinel = '{"retained":true}\n', lines = [];
    let handle;
    try {
      if (mode !== 'sink-without-gsd') {
        fs.mkdirSync(path.dirname(events), { recursive: true });
        fs.writeFileSync(events, sentinel);
      }
      const sink = mode === 'no-sink' ? undefined : line => {
        lines.push(line);
        if (mode === 'throwing-sink') throw new Error('fixture-sink-failure');
      };
      const opts = { cwd: dir, poolDir, env: { FORGE_RESOURCES_PRESSURE: '1' },
        ncpu: 2, commandTimeoutMs: 5000, noEvents: mode === 'no-events', resourceEventSink: sink };
      resetResourceCache();
      const acquired = acquireCommandBudget(opts);
      handle = acquired.pool?.handle;
      strict.equal(acquired.admit, true);
      strict(handle?.slots.length > 0, 'real temporary pool acquired');
      strict.equal(releaseCommandBudget(handle, opts).ok, true);
      strict.equal(require('./forge-resource-pool').poolStatus({ poolDir }).held, 0);
      handle = null;
      const expectedKinds = ['resource-admission', 'resource-pool-granted', 'resource-pool-released'];
      if (mode === 'no-sink') {
        strict.deepEqual(fs.readFileSync(events, 'utf8').slice(sentinel.length).trimEnd().split('\n').map(x => JSON.parse(x).kind), expectedKinds);
      } else {
        strict.deepEqual(lines.map(x => JSON.parse(x).kind), mode === 'no-events' ? [] : expectedKinds);
        strict(lines.every(x => x.endsWith('\n')));
        if (mode === 'sink-without-gsd') strict.equal(fs.existsSync(path.join(dir, '.gsd')), false);
        else strict.equal(fs.readFileSync(events, 'utf8'), sentinel, 'sink failure must not fall back to disk');
      }
      pass('issue451 resource lifecycle ' + mode);
    } finally {
      if (handle) releaseCommandBudget(handle, { cwd: dir, poolDir, noEvents: true });
      cleanup(dir);
    }
  }
})();

process.stdout.write(`\nResults: ${passes} passed, ${fails} failed\n`);
process.exitCode = fails > 0 ? 1 : 0;
