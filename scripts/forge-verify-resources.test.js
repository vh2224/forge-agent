#!/usr/bin/env node
// forge-verify-resources.test.js — standalone suite for the resource-clamp
// wiring in forge-verify.js#runVerificationGate (S04/T02).
//
// Scope: forge-verify.js is a THIN consumer (D10) of forge-resources.js /
// forge-command-rewrite.js — this suite proves the wiring, not the sizing
// rules or the rewrite logic (those suites live in
// forge-resources.test.js / forge-command-rewrite.test.js).
//
// Run: node scripts/forge-verify-resources.test.js   (exit 0 = all pass)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runVerificationGate } = require('./forge-verify.js');

// ── Test runner boilerplate (mirrors forge-verify.test.js) ────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.stack || e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'not equal'} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ── Fixture helpers ─────────────────────────────────────────────────────────

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A fake "vitest" binary, placed under `dir/bin/vitest` (POSIX-only — a
// shebang script), that dumps `process.env` + `process.argv` to `dumpFile`
// and exits with `exitCode` (default 0). `delayMs` lets the timeout case
// outlive the gate's commandTimeoutMs.
function writeFakeVitest(binDir, dumpFile, { exitCode = 0, delayMs = 0 } = {}) {
  fs.mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, 'vitest');
  const body = `#!/usr/bin/env node
const fs = require('fs');
function dump() {
  fs.writeFileSync(${JSON.stringify(dumpFile)}, JSON.stringify({ env: process.env, argv: process.argv }));
}
${delayMs > 0
    ? `dump(); setTimeout(() => { process.exit(${exitCode}); }, ${delayMs});`
    : `dump(); process.exit(${exitCode});`}
`;
  fs.writeFileSync(binPath, body, { mode: 0o755 });
  return binPath;
}

function poolCensus(poolDir) {
  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'forge-resource-pool.js'),
    '--status', '--json', '--pool-dir', poolDir,
  ], { encoding: 'utf-8' });
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { ok: false, held: -1, ceiling: -1 };
  }
}

const isPosix = process.platform !== 'win32';

// ── Setup: isolated .gsd/ owner + pool dir + a minimal task plan ──────────

let workDir;
let poolDir;
let originalPath;
let originalPressure;
let originalNodeOptions;

function setup() {
  workDir = mkTmpDir('forge-verify-resources-work-');
  fs.mkdirSync(path.join(workDir, '.gsd', 'forge'), { recursive: true });
  poolDir = mkTmpDir('forge-verify-resources-pool-');
  originalPath = process.env.PATH;
  originalPressure = process.env.FORGE_RESOURCES_PRESSURE;
  originalNodeOptions = process.env.NODE_OPTIONS;
  process.env.FORGE_RESOURCE_POOL_DIR = poolDir;
  // Deterministic admission: level 1 (normal), admit:true, cross-platform
  // (this env override is honored regardless of process.platform/darwin —
  // see forge-resources.js#resolveResourceBudget).
  process.env.FORGE_RESOURCES_PRESSURE = '1';
  // Hermetic to any NODE_OPTIONS the outer environment/CI defines — several
  // tests below assert its ABSENCE (clamp OFF) or an exact PARENT-set value
  // (test 3), and an inherited value would make both asserts fail against
  // otherwise-correct preservation behavior (R2).
  delete process.env.NODE_OPTIONS;
}

function teardown() {
  process.env.PATH = originalPath;
  if (originalPressure === undefined) delete process.env.FORGE_RESOURCES_PRESSURE;
  else process.env.FORGE_RESOURCES_PRESSURE = originalPressure;
  if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = originalNodeOptions;
  delete process.env.FORGE_RESOURCE_POOL_DIR;
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(poolDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

setup();

// ── 1. Clamp ON: fixture dumps env/argv — NODE_OPTIONS + worker clamp present ──

test('clamp ON: child dump shows NODE_OPTIONS from the contract (child-observed, not parent-inspected)', () => {
  if (!isPosix) { console.log('    (skipped: posix-only shebang fixture)'); return; }
  const binDir = path.join(workDir, 'bin-on');
  const dumpFile = path.join(workDir, 'dump-on.json');
  writeFakeVitest(binDir, dumpFile);
  process.env.PATH = binDir + path.delimiter + originalPath;

  const result = runVerificationGate({
    cwd: workDir,
    taskPlanVerify: 'vitest',
    gsdDir: path.join(workDir, '.gsd'),
    commandTimeoutMs: 15000,
  });

  assert(fs.existsSync(dumpFile), 'fixture did not run — no dump file written');
  const dump = JSON.parse(fs.readFileSync(dumpFile, 'utf-8'));
  assert(typeof dump.env.NODE_OPTIONS === 'string', 'NODE_OPTIONS missing from child env');
  assert(/--max-old-space-size=\d+/.test(dump.env.NODE_OPTIONS), `NODE_OPTIONS malformed: ${dump.env.NODE_OPTIONS}`);
  assert(typeof dump.env.VITEST_MAX_FORKS === 'string' && dump.env.VITEST_MAX_FORKS.length > 0,
    'VITEST_MAX_FORKS (the worker clamp) missing from child env');
  assertEqual(result.passed, true, 'gate should pass on a clean exit');
});

// ── 2. Clamp OFF (same fixture, non-runner-classified invocation) — mordida ao contrário ──

test('clamp OFF: same fixture body invoked under a non-runner binary name — no NODE_OPTIONS, no worker clamp', () => {
  if (!isPosix) { console.log('    (skipped: posix-only shebang fixture)'); return; }
  const binDir = path.join(workDir, 'bin-off');
  const dumpFile = path.join(workDir, 'dump-off.json');
  // Same dumping fixture BODY as case 1, but the binary's basename is not
  // "vitest"/"jest"/"playwright" — looksLikeRunnerCommand/RUNNER_BIN_RE
  // classify purely on the head token's basename (classifySegment), so
  // renaming the binary — not the invocation shape — is what flips the
  // gate to "not a candidate". This is the "clamp desligado" leg of the
  // same fixture, proving the bite reverses.
  fs.mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, 'not-a-real-runner');
  fs.writeFileSync(binPath, `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(dumpFile)}, JSON.stringify({ env: process.env, argv: process.argv }));
process.exit(0);
`, { mode: 0o755 });
  process.env.PATH = originalPath;

  const result = runVerificationGate({
    cwd: workDir,
    taskPlanVerify: binPath,
    gsdDir: path.join(workDir, '.gsd'),
    commandTimeoutMs: 15000,
  });

  assert(fs.existsSync(dumpFile), 'fixture did not run — no dump file written');
  const dump = JSON.parse(fs.readFileSync(dumpFile, 'utf-8'));
  assert(dump.env.NODE_OPTIONS === undefined, `NODE_OPTIONS should be absent, got ${dump.env.NODE_OPTIONS}`);
  assert(dump.env.VITEST_MAX_FORKS === undefined, 'VITEST_MAX_FORKS should be absent when clamp is off');
  assertEqual(result.passed, true, 'gate should still pass');
});

// ── 3. NODE_OPTIONS preexistente no pai nunca é sobrescrito ────────────────

test('parent NODE_OPTIONS is never overwritten — child sees the PARENT value, not the contract value', () => {
  if (!isPosix) { console.log('    (skipped: posix-only shebang fixture)'); return; }
  const binDir = path.join(workDir, 'bin-nodeopts');
  const dumpFile = path.join(workDir, 'dump-nodeopts.json');
  writeFakeVitest(binDir, dumpFile);
  process.env.PATH = binDir + path.delimiter + originalPath;
  const savedNodeOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--max-old-space-size=42';

  try {
    runVerificationGate({
      cwd: workDir,
      taskPlanVerify: 'vitest',
      gsdDir: path.join(workDir, '.gsd'),
      commandTimeoutMs: 15000,
    });

    const dump = JSON.parse(fs.readFileSync(dumpFile, 'utf-8'));
    assertEqual(dump.env.NODE_OPTIONS, '--max-old-space-size=42', 'parent NODE_OPTIONS was overwritten by the contract');
  } finally {
    // Self-contained (R2): restore whatever NODE_OPTIONS held before this
    // test, rather than blindly deleting it, so the rest of the suite
    // (and teardown) sees exactly the value it started with.
    if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = savedNodeOptions;
  }
});

// ── 4. Variável arbitrária do pai continua chegando ao filho (env não truncado) ──

test('arbitrary parent env var reaches the child unmodified (env is not truncated)', () => {
  if (!isPosix) { console.log('    (skipped: posix-only shebang fixture)'); return; }
  const binDir = path.join(workDir, 'bin-canary');
  const dumpFile = path.join(workDir, 'dump-canary.json');
  writeFakeVitest(binDir, dumpFile);
  process.env.PATH = binDir + path.delimiter + originalPath;
  process.env.FORGE_T02_CANARY = '1';

  runVerificationGate({
    cwd: workDir,
    taskPlanVerify: 'vitest',
    gsdDir: path.join(workDir, '.gsd'),
    commandTimeoutMs: 15000,
  });

  const dump = JSON.parse(fs.readFileSync(dumpFile, 'utf-8'));
  assertEqual(dump.env.FORGE_T02_CANARY, '1', 'arbitrary parent env var did not reach the child');
  delete process.env.FORGE_T02_CANARY;
});

// ── 5. Comando que sai não-zero: veredito correto E censo do pool zerado (W5) ──

test('W5: failing command releases the lease — pool census zeroed after a non-zero exit', () => {
  if (!isPosix) { console.log('    (skipped: posix-only shebang fixture)'); return; }
  const binDir = path.join(workDir, 'bin-fail');
  const dumpFile = path.join(workDir, 'dump-fail.json');
  writeFakeVitest(binDir, dumpFile, { exitCode: 7 });
  process.env.PATH = binDir + path.delimiter + originalPath;

  const result = runVerificationGate({
    cwd: workDir,
    taskPlanVerify: 'vitest',
    gsdDir: path.join(workDir, '.gsd'),
    commandTimeoutMs: 15000,
  });

  assertEqual(result.passed, false, 'gate should report failure');
  assertEqual(result.checks[0].exitCode, 7, 'exit code should be the project exit code (7)');

  const census = poolCensus(poolDir);
  assertEqual(census.ok, true, 'pool status call failed');
  assertEqual(census.held, 0, `lease leaked on the failure path — held=${census.held}`);
});

// ── 6. Timeout: exitCode 124 E censo do pool zerado (W5) ───────────────────

test('W5: timing-out command releases the lease — pool census zeroed after timeout (124)', () => {
  if (!isPosix) { console.log('    (skipped: posix-only shebang fixture)'); return; }
  const binDir = path.join(workDir, 'bin-timeout');
  const dumpFile = path.join(workDir, 'dump-timeout.json');
  writeFakeVitest(binDir, dumpFile, { delayMs: 5000 });
  process.env.PATH = binDir + path.delimiter + originalPath;

  const result = runVerificationGate({
    cwd: workDir,
    taskPlanVerify: 'vitest',
    gsdDir: path.join(workDir, '.gsd'),
    commandTimeoutMs: 300, // shorter than the fixture's 5s delay
  });

  assertEqual(result.passed, false, 'gate should report failure on timeout');
  assertEqual(result.checks[0].exitCode, 124, 'timeout must map to exitCode 124');
  assertEqual(result.checks[0].skipped, 'timeout', 'timeout must set skipped:"timeout"');

  const census = poolCensus(poolDir);
  assertEqual(census.ok, true, 'pool status call failed');
  assertEqual(census.held, 0, `lease leaked on the timeout path — held=${census.held}`);
});

// ── 7. commands.length === 0 → skipped:'no-stack' idêntico nos dois modos ──

test("skipped:'no-stack' is identical whether or not the resources module is reachable", () => {
  const cwdNoStack = mkTmpDir('forge-verify-resources-nostack-');
  try {
    const onResult = runVerificationGate({ cwd: cwdNoStack, commandTimeoutMs: 5000 });
    const offResult = runVerificationGate({
      cwd: cwdNoStack,
      commandTimeoutMs: 5000,
      requireResources: () => { throw new Error('forced: resources unavailable'); },
    });
    assertEqual(onResult.skipped, 'no-stack');
    assertEqual(offResult.skipped, 'no-stack');
    assertEqual(onResult.passed, true);
    assertEqual(offResult.passed, true);
    assertEqual(onResult.checks.length, 0);
    assertEqual(offResult.checks.length, 0);
  } finally {
    fs.rmSync(cwdNoStack, { recursive: true, force: true });
  }
});

// ── 8. Fail-open: resources module forced to fail → byte-identical command + verdict ──

test('fail-open: forced-throwing resources module runs the ORIGINAL command, verdict unchanged', () => {
  if (!isPosix) { console.log('    (skipped: posix-only shebang fixture)'); return; }
  const binDir = path.join(workDir, 'bin-failopen');
  const dumpFile = path.join(workDir, 'dump-failopen.json');
  writeFakeVitest(binDir, dumpFile);
  process.env.PATH = binDir + path.delimiter + originalPath;

  const baseline = runVerificationGate({
    cwd: workDir,
    taskPlanVerify: 'vitest',
    gsdDir: path.join(workDir, '.gsd'),
    commandTimeoutMs: 15000,
    requireResources: () => { throw new Error('forced: resources module broken'); },
  });

  assertEqual(baseline.passed, true, 'gate should still pass with resources forced-broken');
  assertEqual(baseline.checks[0].command, 'vitest', 'the discovered command string must be reported unchanged');
  const dump = JSON.parse(fs.readFileSync(dumpFile, 'utf-8'));
  // The child argv is the UNREWRITTEN command — "vitest" with no inserted
  // env-var prefix — proving the spawn ran byte-identical, not just that
  // the reported `command` field looks unchanged.
  assert(dump.env.NODE_OPTIONS === undefined, 'fail-open must not apply the NODE_OPTIONS overlay');
  assert(dump.env.VITEST_MAX_FORKS === undefined, 'fail-open must not apply the worker clamp');
});

test('fail-open: forced-throwing command-rewrite module runs the ORIGINAL command, verdict unchanged', () => {
  if (!isPosix) { console.log('    (skipped: posix-only shebang fixture)'); return; }
  const binDir = path.join(workDir, 'bin-failopen2');
  const dumpFile = path.join(workDir, 'dump-failopen2.json');
  writeFakeVitest(binDir, dumpFile);
  process.env.PATH = binDir + path.delimiter + originalPath;

  const result = runVerificationGate({
    cwd: workDir,
    taskPlanVerify: 'vitest',
    gsdDir: path.join(workDir, '.gsd'),
    commandTimeoutMs: 15000,
    requireCommandRewrite: () => { throw new Error('forced: command-rewrite module broken'); },
  });

  assertEqual(result.passed, true);
  const dump = JSON.parse(fs.readFileSync(dumpFile, 'utf-8'));
  assert(dump.env.NODE_OPTIONS === undefined, 'fail-open must not apply the NODE_OPTIONS overlay');
});

// ── 9. Comando não reconhecido roda byte-identico + razão contada ──────────

test('unrecognized command ("make test") runs byte-identical, with a named+counted reason', () => {
  const cache = mkTmpDir('forge-verify-resources-make-');
  try {
    fs.mkdirSync(path.join(cache, '.gsd', 'forge'), { recursive: true });
    const eventsPath = path.join(cache, '.gsd', 'forge', 'events.jsonl');
    const before = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, 'utf-8').split('\n').filter(Boolean).length : 0;

    // Baseline: same command run with the wiring entirely absent (simulates
    // "how it ran before this milestone" — requireCommandRewrite forced to
    // fail closes off the whole resource branch, degrading to the historic
    // path with zero env overlay).
    const wiredOff = runVerificationGate({
      cwd: cache,
      taskPlanVerify: 'echo hi',
      gsdDir: path.join(cache, '.gsd'),
      commandTimeoutMs: 5000,
      requireCommandRewrite: () => { throw new Error('wiring disabled'); },
    });
    const wiredOn = runVerificationGate({
      cwd: cache,
      taskPlanVerify: 'echo hi',
      gsdDir: path.join(cache, '.gsd'),
      commandTimeoutMs: 5000,
    });

    assertEqual(wiredOff.checks[0].exitCode, wiredOn.checks[0].exitCode, 'exit code diverged with wiring on vs off');
    assertEqual(wiredOff.checks[0].stdout, wiredOn.checks[0].stdout, 'stdout diverged with wiring on vs off — not byte-identical');
    assertEqual(wiredOff.checks[0].command, wiredOn.checks[0].command);

    const after = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, 'utf-8').split('\n').filter(Boolean) : [];
    const clampSkipped = after.filter(l => {
      try { return JSON.parse(l).kind === 'resource-clamp-skipped'; } catch { return false; }
    });
    assert(clampSkipped.length >= 1, 'resource-clamp-skipped reason was never counted in events.jsonl');
    assert(clampSkipped.some(l => JSON.parse(l).reason === 'intact:not-runner-command'),
      'the "not a runner command" reason must be named, not generic');
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
});

// ── 10. D5: nenhum sinal/kill/suspensão no código novo ─────────────────────

test('D5: no process.kill / child.kill appears anywhere in the new resource-wiring source', () => {
  const src = fs.readFileSync(path.join(__dirname, 'forge-verify.js'), 'utf-8');
  const wiringStart = src.indexOf('// ── Resource wiring (S04/T02) ');
  assert(wiringStart !== -1, 'could not locate the resource-wiring section marker');
  const wiringEnd = src.indexOf('// ── Failure Context ', wiringStart);
  assert(wiringEnd !== -1, 'could not locate the end of the resource-wiring section');
  const wiringSrc = src.slice(wiringStart, wiringEnd);
  assert(!/\.kill\s*\(/.test(wiringSrc), 'found a .kill( call inside the resource-wiring section');
  assert(!/process\.kill/.test(wiringSrc), 'found process.kill inside the resource-wiring section');
});

// ── 11. Vereditos byte-preservados: skipped/timeout/spawn-failure/exit ─────
//     (asserted in both modes: clamp-capable command AND non-candidate)

test('verdict table (no-command / timeout=124 / not-found: 127 on sh, cmd.exe status on win32 / project exit) holds with clamp ON and OFF', () => {
  const cwdTable = mkTmpDir('forge-verify-resources-table-');
  try {
    // no-command
    const noCmdOn = runVerificationGate({ cwd: cwdTable, commandTimeoutMs: 5000 });
    const noCmdOff = runVerificationGate({
      cwd: cwdTable, commandTimeoutMs: 5000,
      requireCommandRewrite: () => { throw new Error('off'); },
    });
    assertEqual(noCmdOn.skipped, 'no-stack');
    assertEqual(noCmdOff.skipped, 'no-stack');

    // spawn failure — a command that cannot be found at all. This is
    // NOT a runner-candidate (unknown binary), so the wiring is a no-op on
    // both legs by construction — asserted explicitly rather than assumed.
    //
    // The exit-code expectation is platform-conditional because the OSes
    // genuinely answer differently: 127 is /bin/sh's "command not found"
    // convention, and forge-verify.js only synthesizes 127 when spawnSync
    // itself errored (result.error set — see forge-verify.js:587-590). On
    // win32 the gate spawns `cmd /c <command>`: cmd.exe launches
    // successfully and reports its OWN status for an unknown command (9009
    // "not recognized"; 1 in some shells/locales), so result.error is never
    // set and production rightly reports what the OS said instead of
    // inventing a 127 the OS never produced. The invariant this table
    // actually protects — a non-zero not-found verdict, byte-identical with
    // the wiring on vs off — is asserted on both platforms.
    const notFoundCmd = 'this-binary-does-not-exist-anywhere-xyz --flag';
    const nfOn = runVerificationGate({ cwd: cwdTable, taskPlanVerify: notFoundCmd, commandTimeoutMs: 5000 });
    const nfOff = runVerificationGate({
      cwd: cwdTable, taskPlanVerify: notFoundCmd, commandTimeoutMs: 5000,
      requireCommandRewrite: () => { throw new Error('off'); },
    });
    if (process.platform === 'win32') {
      // cmd.exe's own named statuses for an unrecognized command.
      const CMD_NOT_FOUND_EXITS = [1, 9009];
      assert(CMD_NOT_FOUND_EXITS.includes(nfOn.checks[0].exitCode),
        `win32 not-found exit must be one of ${JSON.stringify(CMD_NOT_FOUND_EXITS)}, got ${nfOn.checks[0].exitCode}`);
      assertEqual(nfOff.checks[0].exitCode, nfOn.checks[0].exitCode,
        'wiring on vs off must agree on the not-found exit code');
    } else {
      assertEqual(nfOn.checks[0].exitCode, 127);
      assertEqual(nfOff.checks[0].exitCode, 127);
    }

    // project's own exit code, via a plain non-runner command.
    // The code lives in a file instead of `node -e "…"`: on win32 the gate
    // spawns `cmd /c <command>`, and cmd.exe eats the quotes around the inline
    // program — measured, the child then exited 0 and the table asserted
    // nothing. A script path carries no quoting, so the same command string
    // means the same thing to /bin/sh and to cmd.exe.
    // Referenced by basename, resolved against the gate's own cwd: an absolute
    // temp path would drag a space-or-backslash quoting problem back in.
    fs.writeFileSync(path.join(cwdTable, 'exit-three.js'), 'process.exit(3);\n');
    const exitCmd = 'node exit-three.js';
    const exOn = runVerificationGate({ cwd: cwdTable, taskPlanVerify: exitCmd, commandTimeoutMs: 5000 });
    const exOff = runVerificationGate({
      cwd: cwdTable, taskPlanVerify: exitCmd, commandTimeoutMs: 5000,
      requireCommandRewrite: () => { throw new Error('off'); },
    });
    assertEqual(exOn.checks[0].exitCode, 3);
    assertEqual(exOff.checks[0].exitCode, 3);
    assertEqual(exOn.passed, false);
    assertEqual(exOff.passed, false);
  } finally {
    fs.rmSync(cwdTable, { recursive: true, force: true });
  }
});

teardown();

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
