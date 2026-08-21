#!/usr/bin/env node
// forge-resources-bench.test.js — proves the T04 harness on an INJECTED
// command (never `node scripts/run-tests.js` — running the real suite is
// T06's sanctioned exception, not this task's, S06-PLAN.md).
//
// Run: node scripts/forge-resources-bench.test.js   (exit 0 = all pass)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const bench = require('./forge-resources-bench.js');

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

// Named skip: the reason MUST reach stdout — a silent skip is treated as a
// defect in this repo (indistinguishable from coverage that never existed).
function skip(name, reason) {
  skipped += 1;
  console.log(`  ↷ SKIP ${name}`);
  console.log(`      reason: ${reason}`);
}

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.stack || e.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
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

const createdDirs = [];
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
  createdDirs.push(dir);
  return dir;
}

const BENCH_PATH = path.join(__dirname, 'forge-resources-bench.js');
const WINDOWS_CTRL_C_PATH = path.join(__dirname, 'fixtures', 'forge-windows-ctrl-c.ps1');

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), 'utf8');
  fs.renameSync(temporary, file);
}

async function waitFor(predicate, timeoutMs, stage) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${stage}: timed out after ${timeoutMs}ms`);
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function enumeratePowerShellHosts(probe = (host) => spawnSync(host, [
  '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()',
], { encoding: 'utf8', windowsHide: true })) {
  return ['powershell.exe', 'pwsh.exe'].filter((host) => {
    const result = probe(host);
    return result && !result.error && result.status === 0;
  });
}

function settleWithin(promise, timeoutMs, stage) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${stage}: timed out after ${timeoutMs}ms`)), timeoutMs)),
  ]);
}

// Fast, deterministic, injectable command — never the real suite.
function sleepCommand(ms) {
  return ['node', '-e', `setTimeout(()=>{},${ms})`];
}
function failCommand() {
  return ['node', '-e', 'process.exit(1)'];
}

// ── Unit-level coverage ──────────────────────────────────────────────────

test('cellEnforcement: /off cells resolve to off, /on cells resolve to clamp', () => {
  assertEqual(bench.cellEnforcement('solo/off'), 'off');
  assertEqual(bench.cellEnforcement('batch/off'), 'off');
  assertEqual(bench.cellEnforcement('solo/on'), 'clamp');
  assertEqual(bench.cellEnforcement('batch/on'), 'clamp');
});

test('parseCommand: JSON array form is used verbatim (no shell splitting)', () => {
  const cmd = bench.parseCommand('["node","-e","1+1"]');
  assert(Array.isArray(cmd) && cmd.length === 3, 'expected 3-token argv array');
  assertEqual(cmd[1], '-e');
});

test('parseCommand: bare string falls back to whitespace split (default command)', () => {
  const cmd = bench.parseCommand('node scripts/run-tests.js');
  assertEqual(cmd.join(' '), 'node scripts/run-tests.js');
});

test('planRuns: interleaves cells across repetitions (round-robin, never blocked)', () => {
  const plan = bench.planRuns(['a', 'b'], 3);
  assertEqual(plan.length, 6);
  assertEqual(plan.map((p) => p.cell).join(','), 'a,b,a,b,a,b', 'cells must interleave per repetition');
  assertEqual(plan.map((p) => p.rep).join(','), '1,1,2,2,3,3');
});

test('median: odd length, even length, and single-sample sequences', () => {
  assertEqual(bench.median([10, 20, 30]), 20);
  assertEqual(bench.median([10, 20, 30, 40]), 25);
  assertEqual(bench.median([15]), 15);
  assertEqual(bench.median([]), null);
});

test('writeEnforcement + snapshotPrefsFile + restorePrefsFile: round-trips an ABSENT file back to absent', () => {
  const dir = tmpDir('forge-bench-restore-absent-');
  const prefsPath = bench.localPrefsPath(dir);
  assert(!fs.existsSync(prefsPath), 'precondition: file must not exist yet');
  const snapshot = bench.snapshotPrefsFile(prefsPath);
  assertEqual(snapshot.existed, false);
  bench.writeEnforcement(prefsPath, 'off');
  assert(fs.existsSync(prefsPath), 'writeEnforcement must create the file');
  bench.restorePrefsFile(prefsPath, snapshot);
  assert(!fs.existsSync(prefsPath), 'restore must delete a file that did not exist before');
});

test('writeEnforcement + snapshotPrefsFile + restorePrefsFile: round-trips an EXISTING file byte-identically', () => {
  const dir = tmpDir('forge-bench-restore-existing-');
  const prefsPath = bench.localPrefsPath(dir);
  const original = '{\n  "some_other_key": true,\n  "resources": {\n    "enforcement": "clamp"\n  }\n}\n';
  fs.writeFileSync(prefsPath, original, 'utf8');
  const snapshot = bench.snapshotPrefsFile(prefsPath);
  assertEqual(snapshot.existed, true);
  bench.writeEnforcement(prefsPath, 'off');
  const rewritten = fs.readFileSync(prefsPath, 'utf8');
  assert(rewritten !== original, 'sanity: write must actually change the file');
  assert(JSON.parse(rewritten).resources.enforcement === 'off', 'sanity: write must set the requested value');
  bench.restorePrefsFile(prefsPath, snapshot);
  const restored = fs.readFileSync(prefsPath, 'utf8');
  assertEqual(restored, original, 'restored bytes must be byte-identical to the original');
});

test('writeEnforcement: preserves unrelated keys already in the file', () => {
  const dir = tmpDir('forge-bench-preserve-');
  const prefsPath = bench.localPrefsPath(dir);
  fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  fs.writeFileSync(prefsPath, JSON.stringify({ unrelated: { keep: 'me' }, resources: { enforcement: 'clamp' } }), 'utf8');
  bench.writeEnforcement(prefsPath, 'off');
  const parsed = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
  assertEqual(parsed.unrelated.keep, 'me');
  assertEqual(parsed.resources.enforcement, 'off');
});

test('writeEnforcement: preserves a real JSONC document (comments + unrelated namespaces) — R1', () => {
  const dir = tmpDir('forge-bench-jsonc-');
  const prefsPath = bench.localPrefsPath(dir);
  fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  // Exactly the shape that destroyed the operator's file in T06: JSONC with
  // a comment and a `forge_isolation` block alongside `resources`.
  fs.writeFileSync(prefsPath, [
    '{',
    '  // isolation mode chosen by the operator',
    '  "forge_isolation": { "mode": "branch" },',
    '  "resources": { "enforcement": "clamp" },',
    '}',
    '',
  ].join('\n'), 'utf8');

  bench.writeEnforcement(prefsPath, 'off');
  const parsed = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
  assertEqual(parsed.forge_isolation.mode, 'branch', 'the operator\'s unrelated namespace must survive the write');
  assertEqual(parsed.resources.enforcement, 'off', 'only resources.enforcement may change');
});

test('writeEnforcement: ABORTS on an unparseable document instead of replacing it — R1', () => {
  const dir = tmpDir('forge-bench-jsonc-bad-');
  const prefsPath = bench.localPrefsPath(dir);
  fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  const broken = '{ "forge_isolation": { "mode": "branch" }  <<< not json';
  fs.writeFileSync(prefsPath, broken, 'utf8');

  let threw = false;
  try { bench.writeEnforcement(prefsPath, 'off'); } catch (e) {
    threw = true;
    assert(/recusa escrever/.test(e.message), `expected an explicit refusal, got: ${e.message}`);
  }
  assert(threw, 'writeEnforcement must refuse, never fall back to a fresh document');
  assertEqual(fs.readFileSync(prefsPath, 'utf8'), broken, 'the file must be byte-identical after the refusal');
});

test('summarizeRecords: anti-silence floor — zero ok runs is inconclusive, never clean, never absent', () => {
  const records = [
    { cell: 'solo/off', rep: 1, status: 'aborted:timeout-exceeded', wallMs: 5000, witness: null },
  ];
  const summary = bench.summarizeRecords(records, bench.CELLS);
  assertEqual(summary['solo/off'].verdict, 'inconclusive:zero-ok-runs');
  assertEqual(summary['solo/off'].nOk, 0);
  // control negative: a cell with zero records at all is ALSO in the table.
  assertEqual(summary['solo/on'].verdict, 'inconclusive:no-data');
  assert(Object.prototype.hasOwnProperty.call(summary, 'batch/off'), 'a cell must never be absent from the table');
});

test('summarizeRecords: control negative — a cell with ok runs never falls into the floor', () => {
  const records = [
    { cell: 'solo/off', rep: 1, status: 'ok', wallMs: 100, witness: null },
    { cell: 'solo/off', rep: 2, status: 'ok', wallMs: 120, witness: null },
    { cell: 'solo/off', rep: 3, status: 'ok', wallMs: 110, witness: null },
  ];
  const summary = bench.summarizeRecords(records, ['solo/off']);
  assertEqual(summary['solo/off'].verdict, 'measured');
  assertEqual(summary['solo/off'].nOk, 3);
  assertEqual(summary['solo/off'].median, 110);
});

test('summarizeRecords: aborted corrida stays in the table and is excluded from the median', () => {
  const records = [
    { cell: 'solo/off', rep: 1, status: 'ok', wallMs: 100, witness: null },
    { cell: 'solo/off', rep: 2, status: 'aborted:timeout-exceeded', wallMs: 9999, witness: null },
    { cell: 'solo/off', rep: 3, status: 'ok', wallMs: 200, witness: null },
  ];
  const summary = bench.summarizeRecords(records, ['solo/off']);
  assertEqual(summary['solo/off'].n, 3, 'aborted corrida must count toward n');
  assertEqual(summary['solo/off'].nOk, 2);
  assertEqual(summary['solo/off'].aborted.length, 1);
  assertEqual(summary['solo/off'].median, 150, 'median must be computed over ok runs only (100,200)');
});

test('readJsonlRecords: tolerates a trailing partial/invalid line (interrupted write)', () => {
  const dir = tmpDir('forge-bench-jsonl-');
  const file = path.join(dir, 'out.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ cell: 'solo/off', rep: 1, status: 'ok', wallMs: 1 })}\n{"cell":"solo/of`, 'utf8');
  const records = bench.readJsonlRecords(file);
  assertEqual(records.length, 1, 'only the complete line should parse');
});

test('--dry-run: parseArgs recognises the flag without consuming the next token', () => {
  const args = bench.parseArgs(['--dry-run', '--reps', '3']);
  assertEqual(args.dryRun, true);
  assertEqual(args.reps, '3');
});

test('Windows Ctrl+C fixture: encodes the private-console protocol and forbidden transports stay absent', () => {
  const source = fs.readFileSync(WINDOWS_CTRL_C_PATH, 'utf8');
  for (const required of [
    'FreeConsole()', 'AllocConsole()', 'CREATE_SUSPENDED', 'CreateProcessW',
    'AssignProcessToJobObject', 'SetConsoleCtrlHandler(IntPtr.Zero, true)',
    'ResumeThread', 'GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)',
    'WaitForSingleObject', 'GetExitCodeProcess', 'Publish-JsonAtomic',
    "stage = 'controller-started'", "stage = 'add-type-complete'", "stage = $stage",
  ]) assert(source.includes(required), `fixture must contain ${required}`);
  for (const forbidden of [
    'CREATE_NEW_PROCESS_' + 'GROUP', 'CTRL_' + 'BREAK_EVENT',
    'task' + 'kill', 'Stop-' + 'Process', 'WaitFor' + 'InputIdle',
  ]) assert(!source.includes(forbidden), `fixture must not contain forbidden transport ${forbidden}`);
  const terminateCalls = source.match(/TerminateProcess\(/g) || [];
  assertEqual(terminateCalls.length, 2, 'TerminateProcess may appear only as one declaration and one pre-assignment rollback call');
  assert(/!assignedToJob[\s\S]{0,300}TerminateProcess\(process, 201\)/.test(source),
    'TerminateProcess must remain fenced to rollback of the owned, not-yet-job-assigned process');
  for (const diagnostic of ['invalid-config:', 'child-exit-before-trigger', 'trigger-timeout', 'post-event-timeout']) {
    assert(source.includes(diagnostic), `fixture must preserve named diagnostic ${diagnostic}`);
  }
  const constructor = source.slice(source.indexOf('public ForgeCtrlCSession'));
  assert(constructor.indexOf('FreeConsole()') < constructor.indexOf('CreateProcessW'),
    'runner console must be abandoned before child creation');
  assert(constructor.indexOf('CreateProcessW') < constructor.indexOf('SetConsoleCtrlHandler(IntPtr.Zero, true)'),
    'child must be created before the controller enables inherited Ctrl+C ignore');
});

test('PowerShell host discovery: probes both supported hosts and returns every installed host', () => {
  const probed = [];
  const hosts = enumeratePowerShellHosts((host) => {
    probed.push(host);
    return host === 'pwsh.exe' ? { status: 0 } : { status: 1 };
  });
  assertEqual(probed.join(','), 'powershell.exe,pwsh.exe', 'host discovery must probe the complete supported set');
  assertEqual(hosts.join(','), 'pwsh.exe', 'host discovery must retain each successful probe');
});

test('killTree: a hung taskkill has a finite timeout and falls back only to its owned child handle', () => {
  const calls = [];
  const child = {
    pid: 424242,
    killed: false,
    kill(signal) { calls.push(['child.kill', signal]); return true; },
  };
  const degraded = [];
  const result = bench.killTree(child, {
    platform: 'win32',
    spawnSyncImpl(command, argv, options) {
      calls.push([command, argv, options]);
      return { status: null, error: { code: 'ETIMEDOUT' } };
    },
    reportDegraded: (reason) => degraded.push(reason),
  });
  assertEqual(calls[0][0], 'taskkill');
  assertEqual(calls[0][2].timeout, bench.TASKKILL_TIMEOUT_MS, 'taskkill must carry the production finite timeout');
  assertEqual(calls[1].join(','), 'child.kill,SIGKILL', 'fallback must target only the owned child handle');
  assertEqual(degraded.join(','), 'ETIMEDOUT', 'degradation must be named');
  assertEqual(result.degraded, true);
});

test('SIGINT handler restores preferences before any potentially blocking tree cleanup', () => {
  const source = fs.readFileSync(BENCH_PATH, 'utf8');
  const shutdown = source.slice(source.indexOf('async function completeSignalShutdown'), source.indexOf('function spawnTracked'));
  assert(shutdown.indexOf('closeSpawnFence(') < shutdown.indexOf('await cleanup()'),
    'signal shutdown must close the spawn fence before cleanup yields');
  assert(shutdown.indexOf('await cleanup()') < shutdown.indexOf('restore(true)'),
    'signal shutdown must repair concurrent rewrites after async cleanup');
  assert(shutdown.indexOf('restore(true)') < shutdown.indexOf('exit(signal'),
    'no await may separate successful final restoration from signal exit');
});

test('restorePrefsFile: absent snapshots ignore only ENOENT, never sharing or permission failures', () => {
  const dir = tmpDir('forge-bench-restore-errors-');
  const prefsPath = bench.localPrefsPath(dir);
  const realUnlink = fs.unlinkSync;
  fs.unlinkSync = () => { const error = new Error('sharing violation'); error.code = 'EACCES'; throw error; };
  try {
    let threw = false;
    try { bench.restorePrefsFile(prefsPath, { existed: false, content: null }); } catch (error) {
      threw = error.code === 'EACCES';
    }
    assert(threw, 'non-ENOENT restore failures must propagate');
  } finally { fs.unlinkSync = realUnlink; }
});

// ── Behavioral: runMatrix with an injected fast command ────────────────────

async function runAsyncTests() {

await testAsync('killTreeAsync: a hung taskkill cannot block SIGINT cleanup past its deadline', async () => {
  const { EventEmitter } = require('events');
  const killer = new EventEmitter();
  killer.kill = () => true;
  const ownedSignals = [];
  const child = { pid: 434343, killed: false, kill: (signal) => { ownedSignals.push(signal); return true; } };
  const degraded = [];
  const result = await bench.killTreeAsync(child, {
    platform: 'win32',
    timeoutMs: 10,
    exitConfirmMs: 10,
    spawnImpl: () => killer,
    reportDegraded: (reason) => degraded.push(reason),
  });
  assertEqual(result.reason, 'timeout');
  assertEqual(degraded.join(','), 'timeout');
  assertEqual(ownedSignals.join(','), 'SIGKILL', 'timeout fallback must target only the owned child handle');
});

await testAsync('killAllLiveAsync: real timeout/nonzero/spawn-error paths aggregate degradation', async () => {
  const { EventEmitter } = require('events');
  const cases = [
    {
      expected: 'timeout',
      spawnImpl: () => { const killer = new EventEmitter(); killer.kill = () => true; return killer; },
      timeoutMs: 10,
    },
    {
      expected: 'exit-9',
      spawnImpl: () => {
        const killer = new EventEmitter(); killer.kill = () => true;
        queueMicrotask(() => killer.emit('close', 9)); return killer;
      },
      timeoutMs: 100,
    },
    { expected: 'spawn-exception', spawnImpl: () => { throw new Error('spawn failed'); }, timeoutMs: 100 },
  ];
  for (const scenario of cases) {
    const owned = new EventEmitter();
    owned.pid = 500000 + cases.indexOf(scenario); owned.killed = false;
    owned.kill = () => { queueMicrotask(() => owned.emit('exit', null, 'SIGKILL')); return true; };
    bench.spawnTracked('owned', [], {
      cwd: process.cwd(), timeoutMs: 60000, spawnImpl: () => owned,
    });
    let observed = null;
    try {
      await bench.killAllLiveAsync({
        platform: 'win32', spawnImpl: scenario.spawnImpl, timeoutMs: scenario.timeoutMs,
        reportDegraded: () => {},
      });
    } catch (error) { observed = error; }
    assert(observed && observed.code === 'CLEANUP_DEGRADED', `expected aggregate degradation for ${scenario.expected}`);
    assert(observed.message.includes(scenario.expected), `missing reason ${scenario.expected}: ${observed.message}`);
  }
});

await testAsync('signal shutdown: real degraded cleanup selects exit 75 after final restore', async () => {
  const { EventEmitter } = require('events');
  const owned = new EventEmitter();
  owned.pid = 510000; owned.killed = false;
  owned.kill = () => { queueMicrotask(() => owned.emit('exit', null, 'SIGKILL')); return true; };
  bench.spawnTracked('owned', [], { cwd: process.cwd(), timeoutMs: 60000, spawnImpl: () => owned });
  const killer = new EventEmitter(); killer.kill = () => true;
  const exits = []; const diagnostics = [];
  await bench.completeSignalShutdown({
    signal: 'SIGINT',
    cancellationFence: bench.createSpawnFence(),
    restore: () => ({ ok: true }),
    cleanup: () => bench.killAllLiveAsync({
      platform: 'win32', spawnImpl: () => killer, timeoutMs: 10, reportDegraded: () => {},
    }),
    exit: (code) => exits.push(code),
    writeDiagnostic: (message) => diagnostics.push(message),
  });
  assertEqual(exits.join(','), '75', 'degraded cleanup must never report SIGINT success');
  assert(diagnostics.some((message) => message.includes('cleanup-degraded:timeout')),
    `cleanup degradation must be named: ${diagnostics.join(',')}`);
});

await testAsync('signal shutdown: taskkill exit 128 plus observed owned-child exit remains successful', async () => {
  const { EventEmitter } = require('events');
  const owned = new EventEmitter();
  owned.pid = 520000; owned.killed = false; owned.exitCode = null; owned.signalCode = null;
  owned.kill = () => true;
  bench.spawnTracked('owned', [], { cwd: process.cwd(), timeoutMs: 60000, spawnImpl: () => owned });
  const killer = new EventEmitter(); killer.kill = () => true;
  const exits = [];
  await bench.completeSignalShutdown({
    signal: 'SIGINT', cancellationFence: bench.createSpawnFence(), restore: () => ({ ok: true }),
    cleanup: () => bench.killAllLiveAsync({
      platform: 'win32', timeoutMs: 100, exitConfirmMs: 20,
      spawnImpl: () => {
        queueMicrotask(() => {
          owned.exitCode = 130; owned.emit('exit', 130, null); killer.emit('close', 128);
        });
        return killer;
      },
      reportDegraded: () => {},
    }),
    exit: (code) => exits.push(code), writeDiagnostic: () => {},
  });
  assertEqual(exits.join(','), '130', 'observed natural exit must not be downgraded by taskkill exit 128');
});

await testAsync('signal shutdown: taskkill exit 128 with owned child still live selects exit 75', async () => {
  const { EventEmitter } = require('events');
  const owned = new EventEmitter();
  owned.pid = 530000; owned.killed = false; owned.exitCode = null; owned.signalCode = null;
  owned.kill = () => { queueMicrotask(() => owned.emit('exit', null, 'SIGKILL')); return true; };
  bench.spawnTracked('owned', [], { cwd: process.cwd(), timeoutMs: 60000, spawnImpl: () => owned });
  const killer = new EventEmitter(); killer.kill = () => true;
  const exits = []; const diagnostics = [];
  await bench.completeSignalShutdown({
    signal: 'SIGINT', cancellationFence: bench.createSpawnFence(), restore: () => ({ ok: true }),
    cleanup: () => bench.killAllLiveAsync({
      platform: 'win32', timeoutMs: 100, exitConfirmMs: 10,
      spawnImpl: () => { queueMicrotask(() => killer.emit('close', 128)); return killer; },
      reportDegraded: () => {},
    }),
    exit: (code) => exits.push(code), writeDiagnostic: (message) => diagnostics.push(message),
  });
  assertEqual(exits.join(','), '75', 'unconfirmed tree cleanup must remain degraded');
  assert(diagnostics.some((message) => message.includes('cleanup-degraded:exit-128')),
    `exit-128 degradation must be named: ${diagnostics.join(',')}`);
});

await testAsync('killTreeAsync: child.killed without exit evidence remains degraded', async () => {
  const { EventEmitter } = require('events');
  const owned = new EventEmitter();
  owned.pid = 535000; owned.killed = true; owned.exitCode = null; owned.signalCode = null;
  owned.kill = () => true;
  const killer = new EventEmitter(); killer.kill = () => true;
  const resultPromise = bench.killTreeAsync(owned, {
    platform: 'win32', timeoutMs: 100, exitConfirmMs: 10,
    spawnImpl: () => { queueMicrotask(() => killer.emit('close', 128)); return killer; },
    reportDegraded: () => {},
  });
  const result = await resultPromise;
  assertEqual(result.ok, false, 'child.killed says a signal was sent, not that the process exited');
  assertEqual(result.reason, 'exit-128');
});

await testAsync('killTreeAsync: only exit 128 can use bounded already-exited reclassification', async () => {
  const { EventEmitter } = require('events');
  const runCase = async (name, spawnImpl, prepareOwned = () => {}) => {
    const owned = new EventEmitter();
    owned.pid = 540000; owned.killed = false; owned.exitCode = null; owned.signalCode = null;
    owned.kill = () => true;
    prepareOwned(owned);
    const result = await bench.killTreeAsync(owned, {
      platform: 'win32', timeoutMs: 10, exitConfirmMs: 10, spawnImpl, reportDegraded: () => {},
    });
    assertEqual(result.ok, false, `${name} must remain degraded even when the root exit is observed`);
    assert(!result.alreadyExited, `${name} must not claim tree-wide already-exited proof`);
  };

  await runCase('timeout', () => {
    const killer = new EventEmitter(); killer.kill = () => true; return killer;
  }, (owned) => { owned.exitCode = 0; });
  await runCase('spawn-exception', () => { throw new Error('spawn failed'); }, (owned) => { owned.exitCode = 0; });
  await runCase('exit-5', () => {
    const killer = new EventEmitter(); killer.kill = () => true;
    queueMicrotask(() => killer.emit('close', 5));
    return killer;
  }, (owned) => { owned.exitCode = 0; });
});

await testAsync('spawnTracked: operational error keeps an owned PID available for degraded cancellation cleanup', async () => {
  const { EventEmitter } = require('events');
  const owned = new EventEmitter();
  owned.pid = 545000; owned.killed = false; owned.exitCode = null; owned.signalCode = null;
  owned.kill = () => { throw new Error('owned kill failed'); };
  const killer = new EventEmitter(); killer.kill = () => true;
  let taskkillCalls = 0;
  const run = bench.spawnTracked('owned', [], {
    cwd: process.cwd(), timeoutMs: 60000, spawnImpl: () => owned,
    cleanupOptions: {
      platform: 'win32', timeoutMs: 100, exitConfirmMs: 10,
      spawnImpl: () => { taskkillCalls += 1; return killer; },
      reportDegraded: () => {},
    },
  });
  let nextSpawnCalls = 0;
  const sequence = (async () => {
    const result = await run;
    const next = new EventEmitter(); next.pid = 545001; next.killed = false;
    next.kill = () => true;
    const nextRun = bench.spawnTracked('next', [], {
      cwd: process.cwd(), timeoutMs: 100,
      spawnImpl: () => { nextSpawnCalls += 1; queueMicrotask(() => next.emit('exit', 0, null)); return next; },
    });
    await nextRun;
    return result;
  })();
  owned.emit('error', new Error('operational failure'));
  await Promise.resolve();
  assertEqual(taskkillCalls, 1, 'operational error must start bounded cleanup immediately');
  assertEqual(nextSpawnCalls, 0, 'the next spawn must wait for operational cleanup outcome');
  killer.emit('close', 128);
  const result = await sequence;
  assertEqual(result.signal, 'spawn-error');
  assertEqual(result.cleanupPending, true, 'uncertain operational cleanup must retain ownership');
  assertEqual(result.cleanup && result.cleanup.reason, 'exit-128');
  assertEqual(nextSpawnCalls, 1, 'the next spawn may begin only after cleanup was attempted');

  let cleanupError = null;
  try {
    await bench.killAllLiveAsync({
      platform: 'win32', timeoutMs: 100, exitConfirmMs: 10,
      spawnImpl: () => {
        taskkillCalls += 1;
        const finalKiller = new EventEmitter(); finalKiller.kill = () => true;
        queueMicrotask(() => finalKiller.emit('close', 128));
        return finalKiller;
      },
      reportDegraded: () => {},
    });
  } catch (error) { cleanupError = error; }
  assertEqual(taskkillCalls, 2, 'final cleanup must retry taskkill for the still-owned PID');
  assertEqual(cleanupError && cleanupError.code, 'CLEANUP_DEGRADED');
  assert(String(cleanupError && cleanupError.message).includes('exit-128'),
    `failed owned cleanup must remain degraded: ${cleanupError && cleanupError.message}`);
  owned.emit('exit', null, 'SIGKILL');
});

await testAsync('spawnTracked: SIGINT shares in-flight operational cleanup before any sequential retry', async () => {
  const { EventEmitter } = require('events');
  const owned = new EventEmitter();
  owned.pid = 546000; owned.killed = false; owned.exitCode = null; owned.signalCode = null;
  owned.kill = () => true;
  const firstKiller = new EventEmitter(); firstKiller.kill = () => true;
  const retryKiller = new EventEmitter(); retryKiller.kill = () => true;
  let taskkillCalls = 0;
  const spawnTaskkill = () => {
    taskkillCalls += 1;
    return taskkillCalls === 1 ? firstKiller : retryKiller;
  };
  const run = bench.spawnTracked('owned', [], {
    cwd: process.cwd(), timeoutMs: 60000, spawnImpl: () => owned,
    cleanupOptions: {
      platform: 'win32', timeoutMs: 100, exitConfirmMs: 10,
      spawnImpl: spawnTaskkill, reportDegraded: () => {},
    },
  });
  owned.emit('error', new Error('operational failure'));
  await Promise.resolve();
  const shutdownCleanup = bench.killAllLiveAsync({
    platform: 'win32', timeoutMs: 100, exitConfirmMs: 10,
    spawnImpl: spawnTaskkill, reportDegraded: () => {},
  });
  await Promise.resolve();
  assertEqual(taskkillCalls, 1, 'SIGINT must await the one in-flight taskkill');

  owned.exitCode = 130;
  owned.emit('exit', 130, null);
  firstKiller.emit('close', 128);
  const [runResult, cleanupResult] = await Promise.all([run, shutdownCleanup]);
  assertEqual(taskkillCalls, 1, 'observed exit-128 success must not trigger a retry');
  assertEqual(runResult.cleanup && runResult.cleanup.ok, true);
  assertEqual(cleanupResult.ok, true, 'shared successful cleanup must not become false exit 75');
});

await testAsync('runMatrix finalization: closed signal fence leaves an in-flight cleanup retry exclusively to shutdown', async () => {
  const { EventEmitter } = require('events');
  const owned = new EventEmitter();
  owned.pid = 547000; owned.killed = false; owned.exitCode = null; owned.signalCode = null;
  owned.kill = () => true;
  const killers = [new EventEmitter(), new EventEmitter()];
  killers.forEach((killer) => { killer.kill = () => true; });
  let taskkillCalls = 0;
  const cleanupOptions = {
    platform: 'win32', timeoutMs: 100, exitConfirmMs: 10,
    spawnImpl: () => killers[taskkillCalls++], reportDegraded: () => {},
  };
  const run = bench.spawnTracked('owned', [], {
    cwd: process.cwd(), timeoutMs: 60000, spawnImpl: () => owned, cleanupOptions,
  });
  owned.emit('error', new Error('operational failure'));
  await Promise.resolve();
  const fence = bench.createSpawnFence();
  const exits = [];
  const shutdown = bench.completeSignalShutdown({
    signal: 'SIGINT', cancellationFence: fence, restore: () => ({ ok: true }),
    cleanup: () => bench.killAllLiveAsync(cleanupOptions),
    exit: (code) => exits.push(code), writeDiagnostic: () => {},
  });
  assertEqual(taskkillCalls, 1, 'shutdown must share the first operational cleanup');
  killers[0].emit('close', 128);
  await waitFor(() => taskkillCalls === 2, 100, 'sequential-cleanup-retry');
  assertEqual(taskkillCalls, 2, 'a degraded shared attempt permits one sequential retry');
  let matrixCleanupCalls = 0;
  await bench.finalizeRunMatrix({
    cancellationFence: fence,
    cleanup: async () => { matrixCleanupCalls += 1; },
    restore: () => ({ ok: true }),
    runError: null,
  });
  assertEqual(matrixCleanupCalls, 0, 'closed-fence matrix finalization must not start a competing cleanup');
  assertEqual(taskkillCalls, 2, 'matrix finalization must not create a third taskkill');
  killers[1].emit('close', 128);
  await Promise.all([run, shutdown]);
  assertEqual(exits.join(','), '75', 'one degraded retry must produce the named cleanup failure exit');
  owned.emit('exit', null, 'SIGKILL');
});

await testAsync('signal shutdown: closes spawn fence before yielding and permits zero post-snapshot spawns', async () => {
  const fence = bench.createSpawnFence();
  let releaseCleanup;
  const cleanup = new Promise((resolve) => { releaseCleanup = resolve; });
  const order = [];
  const shutdown = bench.completeSignalShutdown({
    signal: 'SIGINT',
    cancellationFence: fence,
    restore: (force = false) => { order.push(force ? 'restore-final' : 'restore-early'); return { ok: true }; },
    cleanup: () => cleanup,
    exit: (code) => order.push(`exit-${code}`),
    writeDiagnostic: (message) => order.push(`diagnostic-${message}`),
  });
  await Promise.resolve();
  let spawned = 0;
  const fenced = await bench.spawnTracked('never', [], {
    cwd: process.cwd(), timeoutMs: 100, cancellationFence: fence,
    spawnImpl: () => { spawned += 1; throw new Error('must-not-spawn'); },
  });
  assertEqual(fenced.signal, 'spawn-fenced');
  assertEqual(spawned, 0, 'no continuation may spawn after the shutdown snapshot');
  releaseCleanup();
  await shutdown;
  assertEqual(order.join(','), 'restore-early,restore-final,exit-130');
});

await testAsync('signal shutdown: failed final restoration cannot exit 130 and no await follows the final attempt', async () => {
  const fence = bench.createSpawnFence();
  const order = [];
  let calls = 0;
  await bench.completeSignalShutdown({
    signal: 'SIGINT',
    cancellationFence: fence,
    restore: (force = false) => {
      calls += 1;
      order.push(force ? 'restore-final' : 'restore-early');
      if (force) Promise.resolve().then(() => order.push('microtask-after-final'));
      return force ? { ok: false, error: new Error('EACCES') } : { ok: true };
    },
    cleanup: async () => { order.push('cleanup'); },
    exit: (code) => order.push(`exit-${code}`),
    writeDiagnostic: (message) => order.push(`diagnostic-${message}`),
  });
  assertEqual(calls, 2);
  assert(order.indexOf('exit-74') < order.indexOf('microtask-after-final'),
    `exit decision must be synchronous after final restore: ${order.join(',')}`);
  assert(order.some((entry) => entry === 'diagnostic-final-restore-failed:EACCES'),
    `final restore failure must be named: ${order.join(',')}`);
  assert(!order.includes('exit-130'), 'restore failure must never report SIGINT success');
});

test('runMatrix finalization: restore failure replaces false success on a normal path', () => {
  const restoreError = Object.assign(new Error('restore-EACCES'), { code: 'EACCES' });
  let observed = null;
  try { bench.assertRestoration(null, { ok: false, error: restoreError }); } catch (error) { observed = error; }
  assertEqual(observed, restoreError, 'normal completion must become a restoration failure');
});

test('runMatrix finalization: original and restore failures remain together with original as cause', () => {
  const original = new Error('corrida-failed');
  const restoreError = new Error('restore-failed');
  let observed = null;
  try { bench.assertRestoration(original, { ok: false, error: restoreError }); } catch (error) { observed = error; }
  assert(observed instanceof AggregateError, 'dual failure must be AggregateError');
  assertEqual(observed.cause, original, 'original failure must remain the cause');
  assertEqual(observed.errors[0], original);
  assertEqual(observed.errors[1], restoreError);
});

await testAsync('runMatrix finalization: cleanup and restore failures are both preserved in order', async () => {
  const cleanupError = new Error('cleanup-failed');
  const restoreError = new Error('restore-failed');
  let observed = null;
  try {
    await bench.finalizeRunMatrix({
      cancellationFence: bench.createSpawnFence(),
      cleanup: async () => { throw cleanupError; },
      restore: () => ({ ok: false, error: restoreError }),
      runError: null,
    });
  } catch (error) { observed = error; }
  assert(observed instanceof AggregateError, 'dual finalization failure must be AggregateError');
  assertEqual(observed.cause, cleanupError, 'first available failure must be the cause');
  assertEqual(observed.errors.length, 2);
  assertEqual(observed.errors[0], cleanupError);
  assertEqual(observed.errors[1], restoreError);
});

await testAsync('runMatrix finalization: run, cleanup, and restore failures survive as one ordered aggregate', async () => {
  const runError = new Error('run-failed');
  const cleanupError = new Error('cleanup-failed');
  const restoreError = new Error('restore-failed');
  let observed = null;
  try {
    await bench.finalizeRunMatrix({
      cancellationFence: bench.createSpawnFence(),
      cleanup: async () => { throw cleanupError; },
      restore: () => { throw restoreError; },
      runError,
    });
  } catch (error) { observed = error; }
  assert(observed instanceof AggregateError, 'triple failure must be AggregateError');
  assertEqual(observed.cause, runError, 'run failure must remain the cause');
  assertEqual(observed.errors.length, 3);
  assertEqual(observed.errors[0], runError);
  assertEqual(observed.errors[1], cleanupError);
  assertEqual(observed.errors[2], restoreError);
});

await testAsync('runMatrix: writes one JSONL line per corrida with a fresh in-cell witness, and restores prefs on normal exit', async () => {
  const dir = tmpDir('forge-bench-matrix-');
  const prefsPath = bench.localPrefsPath(dir);
  const original = JSON.stringify({ resources: { enforcement: 'clamp' } });
  fs.writeFileSync(prefsPath, original, 'utf8');
  const outFile = path.join(dir, 'out.jsonl');

  const summary = await bench.runMatrix({
    cwd: dir,
    cells: ['solo/off', 'solo/on'],
    reps: 3,
    competitors: 0,
    command: sleepCommand(20),
    timeoutMs: 5000,
    outFile,
  });

  const records = bench.readJsonlRecords(outFile);
  assertEqual(records.length, 6, 'expected 2 cells * 3 reps');
  assert(records.every((r) => r.status === 'ok'), 'all corridas with a fast sleep command must complete ok');
  assert(records.every((r) => r.witness && typeof r.witness.enforcement === 'string'), 'every corrida must carry a witness');

  const offWitnesses = records.filter((r) => r.cell === 'solo/off').map((r) => r.witness.enforcement);
  const onWitnesses = records.filter((r) => r.cell === 'solo/on').map((r) => r.witness.enforcement);
  assert(offWitnesses.every((e) => e === 'off'), `solo/off corridas must witness enforcement=off, got ${offWitnesses}`);
  assert(onWitnesses.every((e) => e === 'clamp'), `solo/on corridas must witness enforcement=clamp, got ${onWitnesses}`);

  assertEqual(summary['solo/off'].verdict, 'measured');
  assertEqual(summary['solo/off'].nOk, 3);

  const restored = fs.readFileSync(prefsPath, 'utf8');
  assertEqual(restored, original, 'prefs must be restored to the original bytes after normal completion');
});

await testAsync('runMatrix: batch cells spawn competitors and record their timing as context, not as the measured number', async () => {
  const dir = tmpDir('forge-bench-batch-');
  const outFile = path.join(dir, 'out.jsonl');
  await bench.runMatrix({
    cwd: dir,
    cells: ['batch/off'],
    reps: 1,
    competitors: 2,
    command: sleepCommand(30),
    timeoutMs: 5000,
    outFile,
  });
  const records = bench.readJsonlRecords(outFile);
  assertEqual(records.length, 1);
  assert(Array.isArray(records[0].competitors) && records[0].competitors.length === 2, 'batch cell must record 2 competitor results');
  assert(typeof records[0].wallMs === 'number', 'the measured number is the measured process wall-clock, not the competitors');
});

await testAsync('runMatrix: restores prefs even when a corrida throws (exception exit path)', async () => {
  const dir = tmpDir('forge-bench-exception-');
  const prefsPath = bench.localPrefsPath(dir);
  const original = JSON.stringify({ resources: { enforcement: 'clamp' } });
  fs.writeFileSync(prefsPath, original, 'utf8');
  const outFile = path.join(dir, 'out.jsonl');

  // Inject a failure into the write path a corrida depends on (same `fs`
  // module object bench.js itself required — the Node module cache shares
  // one exports object, so this patch reaches the module under test) to
  // force a genuine throw out of `runMatrix`, then prove the `finally`
  // block still restored prefs before the rejection propagated.
  const realAppend = fs.appendFileSync;
  fs.appendFileSync = () => { throw new Error('injected-append-failure'); };

  let threw = false;
  try {
    await bench.runMatrix({
      cwd: dir,
      cells: ['solo/off'],
      reps: 3,
      competitors: 0,
      command: sleepCommand(10),
      timeoutMs: 5000,
      outFile,
    });
  } catch (e) {
    threw = true;
    assert(e.message.includes('injected-append-failure'), `expected the injected error to propagate, got: ${e.message}`);
  } finally {
    fs.appendFileSync = realAppend;
  }
  assert(threw, 'runMatrix must propagate the exception, not swallow it');
  const restored = fs.readFileSync(prefsPath, 'utf8');
  assertEqual(restored, original, 'prefs must be restored even when a corrida throws mid-run');
});

await testAsync('runMatrix / --dry-run: the CLI plans without executing anything or touching prefs', async () => {
  const dir = tmpDir('forge-bench-dryrun-');
  const prefsPath = bench.localPrefsPath(dir);
  assert(!fs.existsSync(prefsPath), 'precondition');

  const child = spawn(process.execPath, [
    BENCH_PATH, '--dry-run', '--cwd', dir, '--reps', '3', '--cells', 'solo/off,solo/on',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  await new Promise((resolve) => child.on('exit', resolve));

  assert(!fs.existsSync(prefsPath), 'dry-run must never touch the prefs file');
  const plan = JSON.parse(stdout);
  assertEqual(plan.dryRun, true);
  assertEqual(plan.plan.length, 6, 'dry-run must still report the full interleaved plan');
});

const SIGINT_TEST_NAME = 'runMatrix (via CLI subprocess): SIGINT mid-run leaves an already-finished JSONL line intact and restores prefs byte-identically';
async function runSigintContract(powerShellHost, injectFailureAfterStart = false) {
  const dir = tmpDir(process.platform === 'win32' ? 'forge bench SIGINT Ω-' : 'forge-bench-sigint-');
  const prefsPath = bench.localPrefsPath(dir);
  const original = JSON.stringify({ resources: { enforcement: 'clamp' } });
  fs.writeFileSync(prefsPath, original, 'utf8');
  const outFile = path.join(dir, 'out.jsonl');
  const marker = path.join(dir, 'first-done.marker');
  const blockedMarker = path.join(dir, 'second-started.marker');

  // The claim under test is that a COMPLETED record survives the interrupt,
  // so the fixture must guarantee one exists before SIGINT lands: rep 1
  // exits immediately (dropping a marker), every later rep blocks. The old
  // fixture slept 2000ms on every rep and fired SIGINT at 400ms, so the
  // first append deterministically never happened and the assertion — gated
  // on the file existing — passed over ZERO records.
  const fixture = ['node', '-e',
    `const fs=require('fs');const m=${JSON.stringify(marker)};const b=${JSON.stringify(blockedMarker)};`
    + 'if(fs.existsSync(m)){fs.writeFileSync(b,"1");setTimeout(()=>{},60000);}else{fs.writeFileSync(m,"1");}'];

  const benchArgv = [
    BENCH_PATH, '--cwd', dir, '--reps', '3', '--cells', 'solo/off',
    '--command', JSON.stringify(fixture),
    '--out', outFile, '--timeout-ms', '30000',
  ];
  let child;
  let controllerExit;
  let resultPath = null;
  let nonce = null;
  let started = null;
  let startedPath = null;
  let cancelPath = null;
  let controllerSettled = false;
  let primaryError = null;
  let firstLine = null;
  let stderr = '';
  let earlyExit = null;

  if (process.platform === 'win32') {
    const protocolDir = path.join(dir, 'protocol space Ω');
    fs.mkdirSync(protocolDir, { recursive: true });
    const configPath = path.join(protocolDir, 'config.json');
    const controllerPath = path.join(protocolDir, 'controller.json');
    startedPath = path.join(protocolDir, 'started.json');
    const triggerPath = path.join(protocolDir, 'trigger.json');
    cancelPath = path.join(protocolDir, 'cancel.json');
    resultPath = path.join(protocolDir, 'result.json');
    nonce = `${process.pid}-${Date.now()}-Ω`;
    writeJsonAtomic(configPath, {
      nonce,
      nodePath: process.execPath,
      benchPath: BENCH_PATH,
      cwd: dir,
      argv: benchArgv.slice(1),
      controllerPath,
      startedPath,
      triggerPath,
      cancelPath,
      resultPath,
      triggerTimeoutMs: 60000,
      postEventTimeoutMs: 20000,
    });
    child = spawn(powerShellHost, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', WINDOWS_CTRL_C_PATH, '-ConfigPath', configPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('exit', (code, signal) => { earlyExit = { code, signal }; });
    controllerExit = waitForExit(child).then((exit) => {
      controllerSettled = true;
      return { ...exit, stderr };
    });
  } else {
    child = spawn(process.execPath, benchArgv, { stdio: 'ignore' });
    controllerExit = waitForExit(child).then((exit) => {
      controllerSettled = true;
      return exit;
    });
  }

  try {
    if (process.platform === 'win32') {
      const rawController = await waitFor(
        () => {
          if (earlyExit) throw new Error(`windows-controller-launch: exited ${JSON.stringify(earlyExit)}: ${stderr}`);
          const controllerPath = path.join(dir, 'protocol space Ω', 'controller.json');
          return fs.existsSync(controllerPath) && fs.readFileSync(controllerPath, 'utf8');
        },
        10000,
        'windows-controller-launch',
      );
      const controller = JSON.parse(rawController);
      assertEqual(controller.nonce, nonce, 'controller protocol nonce must match');
      assertEqual(controller.stage, 'controller-started');
      let lastControllerStage = controller.stage;
      let rawStarted;
      try {
        rawStarted = await waitFor(
          () => {
            if (earlyExit) throw new Error(`windows-controller-start: exited ${JSON.stringify(earlyExit)}: ${stderr}`);
            const controllerPath = path.join(dir, 'protocol space Ω', 'controller.json');
            if (fs.existsSync(controllerPath)) {
              const progress = JSON.parse(fs.readFileSync(controllerPath, 'utf8'));
              if (progress.nonce !== nonce) throw new Error('windows-controller-start: progress nonce mismatch');
              lastControllerStage = progress.stage;
            }
            return fs.existsSync(startedPath) && fs.readFileSync(startedPath, 'utf8');
          },
          60000,
          'windows-controller-start',
        );
      } catch (error) {
        throw new Error(`${error.message}; last-stage=${lastControllerStage}`, { cause: error });
      }
      started = JSON.parse(rawStarted);
      assertEqual(started.nonce, nonce, 'started protocol nonce must match');
    }
  // Poll until the first completed corrida is actually on disk — never a
  // fixed sleep, which is what made the old test vacuous.
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (fs.existsSync(outFile)) {
      const lines = fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean);
      if (lines.length >= 1) { firstLine = lines[0]; break; }
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert(firstLine !== null, 'precondition: a completed corrida must be on disk BEFORE the interrupt');
  const before = JSON.parse(firstLine);
  assertEqual(before.status, 'ok', 'precondition: the completed corrida must be an ok record');
  assertEqual(before.rep, 1);
  await waitFor(() => fs.existsSync(blockedMarker), 60000, 'second-workload-started');
  if (injectFailureAfterStart) throw new Error('injected-pre-trigger-failure');

  if (process.platform === 'win32') {
    writeJsonAtomic(path.join(dir, 'protocol space Ω', 'trigger.json'), { nonce, pid: started.pid });
  } else {
    child.kill('SIGINT');
  }
  const exited = await controllerExit;
  if (process.platform === 'win32') {
    assertEqual(exited.code, 0, `windows-controller-exit: ${exited.stderr}`);
    assert(fs.existsSync(resultPath), 'windows-controller-result: result.json must exist');
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    assertEqual(result.nonce, nonce, 'result nonce must match');
    assertEqual(result.pid, started.pid, 'result PID must match started PID');
    assertEqual(result.stage, 'complete', `controller stage: ${JSON.stringify(result)}`);
    assertEqual(result.event, 'CTRL_C_EVENT');
    assertEqual(result.event_sent, true, `GenerateConsoleCtrlEvent failed: ${JSON.stringify(result)}`);
    assertEqual(result.win32_error, 0);
    assertEqual(result.exit_code, 130, `benchmark must exit naturally with 130: ${JSON.stringify(result)}`);
    assertEqual(result.timeout, false);
    assertEqual(result.cleanup_forced, false, `forced cleanup cannot prove SIGINT: ${JSON.stringify(result)}`);
  } else {
    assertEqual(exited.code, 130, `POSIX benchmark must exit with 130, signal=${exited.signal}`);
  }

  const restored = fs.readFileSync(prefsPath, 'utf8');
  assertEqual(restored, original, 'prefs must be restored to original bytes after SIGINT mid-run');

  assert(fs.existsSync(outFile), 'the JSONL file must still exist after the interrupt');
  const lines = fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean);
  assert(lines.length >= 1, 'the finished record must survive the interrupt (never zero records)');
  for (const line of lines) JSON.parse(line); // no torn/partial line
  assertEqual(lines[0], firstLine, 'the exact finished record must survive byte-identically');
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (child && (!controllerSettled || primaryError)) {
      if (!controllerSettled) {
        if (process.platform === 'win32' && started && cancelPath) {
          try { writeJsonAtomic(cancelPath, { nonce, pid: started.pid }); } catch { /* preserve primary failure */ }
        } else if (process.platform !== 'win32') {
          try { child.kill('SIGINT'); } catch { /* process may already be gone */ }
        }
      }
      try {
        const cleanupExit = await settleWithin(controllerExit, 25000, 'controller-cleanup');
        if (primaryError) primaryError.cleanupExit = cleanupExit;
      } catch (cleanupError) {
        const killed = child.kill();
        if (!killed) throw new Error(`controller-cleanup: owned process could not be terminated: ${cleanupError.message}`);
        console.log(`      controller-forced-cleanup: killed owned controller pid=${child.pid} after ${cleanupError.message}`);
        const cleanupExit = await settleWithin(controllerExit, 5000, 'controller-forced-cleanup');
        if (primaryError) primaryError.cleanupExit = { ...cleanupExit, forced: true };
      }
      if (primaryError && resultPath && fs.existsSync(resultPath)) {
        primaryError.cleanupResult = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
      }
      if (primaryError) {
        primaryError.cleanupPrefs = fs.existsSync(prefsPath) ? fs.readFileSync(prefsPath) : null;
        const cleanupLines = fs.existsSync(outFile)
          ? fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean)
          : [];
        for (const line of cleanupLines) JSON.parse(line);
        primaryError.cleanupLines = cleanupLines;
        primaryError.expectedFirstLine = firstLine;
      }
    }
  }
}

async function runAssignmentRollbackContract(powerShellHost) {
  const dir = tmpDir('forge assign rollback Ω-');
  const configPath = path.join(dir, 'config.json');
  const resultPath = path.join(dir, 'result.json');
  const nonce = `rollback-${process.pid}-${Date.now()}-Ω`;
  writeJsonAtomic(configPath, {
    nonce,
    nodePath: process.execPath,
    benchPath: BENCH_PATH,
    cwd: dir,
    argv: ['--dry-run', '--cwd', dir],
    controllerPath: path.join(dir, 'controller.json'),
    startedPath: path.join(dir, 'started.json'),
    triggerPath: path.join(dir, 'trigger.json'),
    cancelPath: path.join(dir, 'cancel.json'),
    resultPath,
    triggerTimeoutMs: 2000,
    postEventTimeoutMs: 2000,
    forceAssignFailure: true,
  });
  const controller = spawn(powerShellHost, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', WINDOWS_CTRL_C_PATH, '-ConfigPath', configPath,
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  controller.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const exited = await settleWithin(waitForExit(controller), 10000, 'assignment-rollback-controller');
  assertEqual(exited.code, 1, `injected assignment failure must be diagnostic: ${stderr}`);
  assert(fs.existsSync(resultPath), `assignment rollback must publish result: ${stderr}`);
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  assert(result.rollback_pid > 0, `rollback must report owned PID: ${JSON.stringify(result)}`);
  assertEqual(result.rollback_exit_observed, true, `rollback must await owned process exit: ${JSON.stringify(result)}`);
  let alive = true;
  try { process.kill(result.rollback_pid, 0); } catch { alive = false; }
  assertEqual(alive, false, `pre-assignment child pid ${result.rollback_pid} survived rollback`);
}

if (process.platform === 'win32') {
  const powerShellHosts = enumeratePowerShellHosts();
  test('Windows Ctrl+C live coverage: at least one supported PowerShell host is installed', () => {
    assert(powerShellHosts.length > 0, 'neither powershell.exe nor pwsh.exe is available; live Windows coverage is mandatory');
  });
  for (const host of powerShellHosts) {
    // eslint-disable-next-line no-await-in-loop
    await testAsync(`${SIGINT_TEST_NAME} [${host}]`, () => runSigintContract(host));
    // eslint-disable-next-line no-await-in-loop
    await testAsync(`Windows Ctrl+C controller: pre-assignment rollback reaps owned child [${host}]`,
      () => runAssignmentRollbackContract(host));
  }
  await testAsync('Windows Ctrl+C controller: pre-trigger assertion failure cancels and reaps the owned tree', async () => {
    let failedAsInjected = false;
    try { await runSigintContract(powerShellHosts[0], true); } catch (error) {
      failedAsInjected = error.message === 'injected-pre-trigger-failure';
      assert(error.cleanupExit && error.cleanupExit.code === 1,
        `cancelled controller must exit diagnostically, got ${JSON.stringify(error.cleanupExit)}`);
      assert(error.cleanupResult && error.cleanupResult.error === 'controller-cancelled-after-graceful-sigint',
        `cancel protocol must be observed, got ${JSON.stringify(error.cleanupResult)}`);
      assertEqual(error.cleanupResult.exit_code, 130, 'cancel must let the benchmark SIGINT handler exit naturally');
      assertEqual(error.cleanupResult.cleanup_forced, false, 'graceful cancel must not kill the Job Object tree');
      assertEqual(error.cleanupPrefs.toString('utf8'), JSON.stringify({ resources: { enforcement: 'clamp' } }),
        'benchmark must restore preferences byte-identically during graceful cancellation');
      assert(error.cleanupLines.length >= 1, 'graceful cancellation must retain completed JSONL records');
      assertEqual(error.cleanupLines[0], error.expectedFirstLine, 'graceful cancellation must preserve the first line byte-identically');
    }
    assert(failedAsInjected, 'the injected pre-trigger failure must propagate after cleanup');
  });
} else {
  await testAsync(SIGINT_TEST_NAME, () => runSigintContract(null));
}

// ── R2: the instrument must observe the CHILD, not the parent's intent ─────

await testAsync('runOneCorrida: an `on` cell is backed by child-written evidence, and the same dump lacks it when enforcement is off', async () => {
  const dir = tmpDir('forge-bench-childevidence-');
  const outFile = path.join(dir, 'out.jsonl');

  await bench.runMatrix({
    cwd: dir,
    cells: ['solo/on', 'solo/off'],
    reps: 3,
    competitors: 0,
    command: sleepCommand(10),
    timeoutMs: 15000,
    outFile,
  });

  const records = bench.readJsonlRecords(outFile);
  const on = records.filter((r) => r.cell === 'solo/on');
  const off = records.filter((r) => r.cell === 'solo/off');
  assertEqual(on.length, 3);
  assertEqual(off.length, 3);

  assert(on.every((r) => r.enforcement && r.enforcement.childObserved),
    `every corrida must carry a child-written dump, got ${JSON.stringify(on.map((r) => r.enforcement))}`);
  assert(on.every((r) => r.enforcement.applied && r.enforcement.reason.startsWith('applied:')),
    `an \`on\` corrida must be corroborated BY THE CHILD, got ${JSON.stringify(on.map((r) => r.enforcement.reason))}`);
  assert(on.every((r) => Number.isFinite(r.enforcement.childHeapMb)),
    'the child must report the heap ceiling it actually received');

  // Control negative on the SAME observation channel: with enforcement off,
  // the child dump exists and carries NO clamp.
  assert(off.every((r) => r.enforcement.childObserved), 'the off cell must also be observed from inside the child');
  assert(off.every((r) => !r.enforcement.applied), 'an off corrida must never be reported as enforced');
  assert(off.every((r) => r.enforcement.reason === bench.ENFORCEMENT_REASONS.OFF),
    `off corridas must name the reason, got ${JSON.stringify(off.map((r) => r.enforcement.reason))}`);
  assert(off.every((r) => r.enforcement.childHeapMb === null),
    'the child must show NO heap clamp when enforcement is off');
});

test('summarizeRecords: an `/on` cell with zero child-corroborated corridas is inconclusive with a named reason, never `measured`', () => {
  const unapplied = [1, 2, 3].map((rep) => ({
    cell: 'solo/on', rep, status: 'ok', wallMs: 100, witness: null,
    enforcement: { applied: false, childObserved: false, reason: bench.ENFORCEMENT_REASONS.NO_DUMP_CHILD },
  }));
  const summary = bench.summarizeRecords(unapplied, ['solo/on']);
  assertEqual(summary['solo/on'].verdict, `inconclusive:enforcement-unapplied:${bench.ENFORCEMENT_REASONS.NO_DUMP_CHILD}`);
  assertEqual(summary['solo/on'].nOk, 3, 'the wall-clocks are still real and still counted');

  // control negative: one corroborated corrida is enough to be `measured`.
  const applied = unapplied.map((r, i) => (i === 0
    ? { ...r, enforcement: { applied: true, childObserved: true, reason: bench.ENFORCEMENT_REASONS.APPLIED_HEAP } }
    : r));
  assertEqual(bench.summarizeRecords(applied, ['solo/on'])['solo/on'].verdict, 'measured');
});

test('evaluateEnforcement: a missing child dump is a named reason, never an `applied` label', () => {
  const e = bench.evaluateEnforcement({
    cell: 'solo/on', argvBefore: ['node', 'x'], argvAfter: ['node', 'x'], dumpRecords: [], disabledReason: null, probeReason: null,
  });
  assertEqual(e.applied, false);
  assertEqual(e.reason, bench.ENFORCEMENT_REASONS.NO_DUMP_CHILD);
  assertEqual(e.childObserved, false);
});

// ── R3: descendants of our own competitors are our cleanup responsibility ──

await testAsync('spawnCompetitor: a timed-out competitor takes its grandchild with it (no orphan survives)', async () => {
  const dir = tmpDir('forge-bench-orphan-');
  const pidFile = path.join(dir, 'grandchild.pid');
  // Parent spawns a long-lived grandchild that records its own pid, then
  // blocks. The harness timeout kills the parent; without a group kill the
  // grandchild would be reparented to PID 1 and keep running.
  const cmd = ['node', '-e',
    `const {spawn}=require('child_process');const fs=require('fs');`
    + `const g=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});`
    + `fs.writeFileSync(${JSON.stringify(pidFile)},String(g.pid));setTimeout(()=>{},60000);`];

  await bench.spawnCompetitor(cmd[0], cmd.slice(1), dir, 1200);
  await new Promise((resolve) => setTimeout(resolve, 500));

  assert(fs.existsSync(pidFile), 'precondition: the grandchild must have been spawned and recorded');
  const gpid = Number(fs.readFileSync(pidFile, 'utf8'));
  let alive = true;
  try { process.kill(gpid, 0); } catch { alive = false; }
  if (alive) { try { process.kill(gpid, 'SIGKILL'); } catch { /* cleanup */ } }
  assert(!alive, `grandchild pid ${gpid} survived the competitor timeout — orphan contaminates later cells`);
});

}

runAsyncTests().then(() => {
  console.log(`\n${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} skipped (named above)` : ''}`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exitCode = failed > 0 ? 1 : 0;
}).finally(() => {
  for (const dir of createdDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
