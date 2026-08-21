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
const { spawn } = require('child_process');

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
  ]) assert(source.includes(required), `fixture must contain ${required}`);
  for (const forbidden of [
    'CREATE_NEW_PROCESS_' + 'GROUP', 'CTRL_' + 'BREAK_EVENT', 'Terminate' + 'Process',
    'task' + 'kill', 'Stop-' + 'Process', 'WaitFor' + 'InputIdle',
  ]) assert(!source.includes(forbidden), `fixture must not contain forbidden transport ${forbidden}`);
  for (const diagnostic of ['invalid-config:', 'child-exit-before-trigger', 'trigger-timeout', 'post-event-timeout']) {
    assert(source.includes(diagnostic), `fixture must preserve named diagnostic ${diagnostic}`);
  }
  const constructor = source.slice(source.indexOf('public ForgeCtrlCSession'));
  assert(constructor.indexOf('FreeConsole()') < constructor.indexOf('CreateProcessW'),
    'runner console must be abandoned before child creation');
  assert(constructor.indexOf('CreateProcessW') < constructor.indexOf('SetConsoleCtrlHandler(IntPtr.Zero, true)'),
    'child must be created before the controller enables inherited Ctrl+C ignore');
});

// ── Behavioral: runMatrix with an injected fast command ────────────────────

async function runAsyncTests() {

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
await testAsync(SIGINT_TEST_NAME, async () => {
  const dir = tmpDir(process.platform === 'win32' ? 'forge bench SIGINT Ω-' : 'forge-bench-sigint-');
  const prefsPath = bench.localPrefsPath(dir);
  const original = JSON.stringify({ resources: { enforcement: 'clamp' } });
  fs.writeFileSync(prefsPath, original, 'utf8');
  const outFile = path.join(dir, 'out.jsonl');
  const marker = path.join(dir, 'first-done.marker');

  // The claim under test is that a COMPLETED record survives the interrupt,
  // so the fixture must guarantee one exists before SIGINT lands: rep 1
  // exits immediately (dropping a marker), every later rep blocks. The old
  // fixture slept 2000ms on every rep and fired SIGINT at 400ms, so the
  // first append deterministically never happened and the assertion — gated
  // on the file existing — passed over ZERO records.
  const fixture = ['node', '-e',
    `const fs=require('fs');const m=${JSON.stringify(marker)};`
    + 'if(fs.existsSync(m)){setTimeout(()=>{},60000);}else{fs.writeFileSync(m,"1");}'];

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

  if (process.platform === 'win32') {
    const protocolDir = path.join(dir, 'protocol space Ω');
    fs.mkdirSync(protocolDir, { recursive: true });
    const configPath = path.join(protocolDir, 'config.json');
    const startedPath = path.join(protocolDir, 'started.json');
    const triggerPath = path.join(protocolDir, 'trigger.json');
    resultPath = path.join(protocolDir, 'result.json');
    nonce = `${process.pid}-${Date.now()}-Ω`;
    writeJsonAtomic(configPath, {
      nonce,
      nodePath: process.execPath,
      benchPath: BENCH_PATH,
      cwd: dir,
      argv: benchArgv.slice(1),
      startedPath,
      triggerPath,
      resultPath,
      triggerTimeoutMs: 20000,
      postEventTimeoutMs: 20000,
    });
    child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', WINDOWS_CTRL_C_PATH, '-ConfigPath', configPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    let earlyExit = null;
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('exit', (code, signal) => { earlyExit = { code, signal }; });
    const rawStarted = await waitFor(
      () => {
        if (earlyExit) throw new Error(`windows-controller-start: exited ${JSON.stringify(earlyExit)}: ${stderr}`);
        return fs.existsSync(startedPath) && fs.readFileSync(startedPath, 'utf8');
      },
      10000,
      'windows-controller-start',
    );
    started = JSON.parse(rawStarted);
    assertEqual(started.nonce, nonce, 'started protocol nonce must match');
    controllerExit = waitForExit(child).then((exit) => ({ ...exit, stderr }));
  } else {
    child = spawn(process.execPath, benchArgv, { stdio: 'ignore' });
    controllerExit = waitForExit(child);
  }

  // Poll until the first completed corrida is actually on disk — never a
  // fixed sleep, which is what made the old test vacuous.
  const deadline = Date.now() + 20000;
  let firstLine = null;
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
});

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
