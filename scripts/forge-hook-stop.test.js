#!/usr/bin/env node
// forge-hook-stop.test.js — standalone zero-dep test for the Stop hook branch
// Pattern: same as forge-ids.test.js — spawnSync, assert, process.exit(1) on fail
//
// Covers all 7 cases from S01-RISK Executor notes:
//  1. Block with fresh active run (same session)
//  2. Allow with stop_hook_active: true
//  3. Allow with no .gsd/forge/ dir (cwd no-op)
//  4. Allow with stale heartbeat (>= ACTIVE_THRESHOLD_MS ago)
//  5. Allow with pause file present
//  6. 3 consecutive blocks → 4th is allow (counter exhaust + reset) → 5th blocks again
//  7. Never-steal: unknown session_id + 1 active run of another session → allow, run untouched

'use strict';

const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const HOOK_PATH = path.join(__dirname, 'forge-hook.js');
const ACTIVE_THRESHOLD_MS = 15 * 60 * 1000; // 15 min — mirrors forge-runs.js

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  pass: ${msg}`);
    passed++;
  }
}

// Run the stop hook with a given stdin JSON object and a custom cwd.
// Returns { status, stdout, stderr }.
function runStop(stdinObj, cwdOverride) {
  const result = spawnSync(process.execPath, [HOOK_PATH, 'stop'], {
    input: JSON.stringify(stdinObj),
    encoding: 'utf8',
    cwd: cwdOverride || os.tmpdir(),
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

// Create a tmp workspace with .gsd/forge/ and optionally a runs/ dir with a run file.
// Returns the workspace path.
function makeTmpWorkspace({ withRunsDir = false, runRecord = null, withPause = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhstop-'));
  const forgeDir = path.join(dir, '.gsd', 'forge');
  fs.mkdirSync(forgeDir, { recursive: true });
  if (withPause) {
    fs.writeFileSync(path.join(forgeDir, 'pause'), '', 'utf8');
  }
  if (withRunsDir && runRecord) {
    const runsDir = path.join(forgeDir, 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(
      path.join(runsDir, `${runRecord.id}.json`),
      JSON.stringify(runRecord, null, 2),
      'utf8'
    );
  }
  return dir;
}

// Build a fresh run record (active, fresh heartbeat) for a given session.
// last_heartbeat is a NUMERIC EPOCH — the production format (forge-runs.js
// writes Date.now()). Regression guard: ISO-string fixtures masked a bug where
// Date.parse(numeric-epoch-as-string) → NaN made every real run look stale.
function freshRun(sessionId, id) {
  return {
    id,
    kind: 'milestone',
    session_id: sessionId,
    active: true,
    started_at: Date.now() - 60000,
    last_heartbeat: Date.now(),
    // null, not a unit string: Guard 5.5 (2026-08-24) ALLOWS the stop when a
    // worker is in flight (the orchestrator is legitimately waiting on the
    // async Agent() result). The block scenarios in this suite model an IDLE
    // orchestrator abandoning an active run — worker must be null for that.
    worker: null,
  };
}

// Unique session ID per test case (counter lives in os.tmpdir() shared space).
let _sessionCounter = Date.now();
function uniqueSession() {
  return `test-sess-${_sessionCounter++}`;
}

// Clean up any leftover counter file for a session ID.
function cleanCounter(sessionId) {
  try { fs.unlinkSync(path.join(os.tmpdir(), `forge-stop-blocks-${sessionId}.json`)); } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Case 1: Block with fresh active run (same session)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nCase 1: block with fresh active run (same session)');
{
  const sessId = uniqueSession();
  cleanCounter(sessId);
  const ws = makeTmpWorkspace({
    withRunsDir: true,
    runRecord: freshRun(sessId, 'M001'),
  });

  const res = runStop({ session_id: sessId, cwd: ws });
  assert(res.status === 0, 'exit 0');
  let parsed = null;
  try { parsed = JSON.parse(res.stdout); } catch {}
  assert(parsed !== null, 'stdout is valid JSON');
  assert(parsed && parsed.decision === 'block', "decision === 'block'");
  assert(parsed && typeof parsed.reason === 'string' && parsed.reason.length > 0, 'reason is non-empty string');
  assert(
    parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.hookEventName === 'Stop',
    "hookSpecificOutput.hookEventName === 'Stop'"
  );
  assert(
    parsed && parsed.hookSpecificOutput && typeof parsed.hookSpecificOutput.additionalContext === 'string' &&
    parsed.hookSpecificOutput.additionalContext.includes('.gsd/STATE.md'),
    'additionalContext mentions .gsd/STATE.md'
  );
  cleanCounter(sessId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Case 2: Allow with stop_hook_active: true (same scenario as case 1 + flag)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nCase 2: allow with stop_hook_active: true');
{
  const sessId = uniqueSession();
  cleanCounter(sessId);
  const ws = makeTmpWorkspace({
    withRunsDir: true,
    runRecord: freshRun(sessId, 'M001'),
  });

  const res = runStop({ session_id: sessId, cwd: ws, stop_hook_active: true });
  assert(res.status === 0, 'exit 0');
  assert(res.stdout === '' || (() => {
    try { const p = JSON.parse(res.stdout); return p.decision !== 'block'; } catch { return true; }
  })(), 'no block output');
  cleanCounter(sessId);
}

// Case 2b: stop_hook_active with no stdin field (absent) — counter is primary protection
// Covered implicitly by Case 1 (no field → block). Verify stdin without stop_hook_active key.
console.log('\nCase 2b: stop_hook_active absent → normal block path (already covered by case 1)');
{
  const sessId = uniqueSession();
  cleanCounter(sessId);
  const ws = makeTmpWorkspace({
    withRunsDir: true,
    runRecord: freshRun(sessId, 'M001'),
  });
  const stdinObj = { session_id: sessId, cwd: ws }; // no stop_hook_active key at all
  const res = runStop(stdinObj, ws);
  assert(res.status === 0, 'exit 0 (no field → block)');
  let parsed = null;
  try { parsed = JSON.parse(res.stdout); } catch {}
  assert(parsed && parsed.decision === 'block', "decision === 'block' when field absent");
  cleanCounter(sessId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Case 2c: ISO-string heartbeat tolerance (hand-edited/legacy records)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nCase 2c: block with ISO-string heartbeat (legacy tolerance)');
{
  const sessId = uniqueSession();
  cleanCounter(sessId);
  const isoRun = Object.assign(freshRun(sessId, 'M001'), {
    last_heartbeat: new Date().toISOString(),
  });
  const ws = makeTmpWorkspace({ withRunsDir: true, runRecord: isoRun });
  const res = runStop({ session_id: sessId, cwd: ws });
  assert(res.status === 0, 'exit 0');
  let parsed = null;
  try { parsed = JSON.parse(res.stdout); } catch {}
  assert(parsed && parsed.decision === 'block', "decision === 'block' with ISO heartbeat");
  cleanCounter(sessId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Case 3: Allow with no .gsd/forge/ (empty cwd — no-op)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nCase 3: allow — no .gsd/forge/ in cwd');
{
  const sessId = uniqueSession();
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhstop-empty-'));
  const res = runStop({ session_id: sessId, cwd: emptyDir });
  assert(res.status === 0, 'exit 0');
  assert(res.stdout === '', 'empty stdout (allow)');
}

// ─────────────────────────────────────────────────────────────────────────────
// Case 4: Allow with stale heartbeat (last_heartbeat = now - 16 min)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nCase 4: allow — stale heartbeat (>= 15 min)');
{
  const sessId = uniqueSession();
  cleanCounter(sessId);
  const staleRun = {
    id: 'M001',
    kind: 'milestone',
    session_id: sessId,
    active: true,
    started_at: Date.now() - 20 * 60 * 1000,
    last_heartbeat: Date.now() - (ACTIVE_THRESHOLD_MS + 60000), // 16 min ago (numeric epoch — production format)
    worker: 'execute-task/T01',
  };
  const ws = makeTmpWorkspace({ withRunsDir: true, runRecord: staleRun });

  const res = runStop({ session_id: sessId, cwd: ws });
  assert(res.status === 0, 'exit 0');
  assert(res.stdout === '', 'empty stdout (allow — stale heartbeat)');
  cleanCounter(sessId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Case 5: Allow with pause file present
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nCase 5: allow — pause file present');
{
  const sessId = uniqueSession();
  cleanCounter(sessId);
  const ws = makeTmpWorkspace({
    withRunsDir: true,
    runRecord: freshRun(sessId, 'M001'),
    withPause: true,
  });

  const res = runStop({ session_id: sessId, cwd: ws });
  assert(res.status === 0, 'exit 0');
  assert(res.stdout === '', 'empty stdout (allow — pause file)');
  cleanCounter(sessId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Case 6: 3 consecutive blocks → 4th is allow + reset → 5th blocks again
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nCase 6: counter exhaustion — 3 blocks → allow → blocks again');
{
  const sessId = uniqueSession();
  cleanCounter(sessId);
  const ws = makeTmpWorkspace({
    withRunsDir: true,
    runRecord: freshRun(sessId, 'M001'),
  });
  const stdin = { session_id: sessId, cwd: ws };

  // Calls 1-3: should block
  for (let i = 1; i <= 3; i++) {
    const res = runStop(stdin);
    let parsed = null;
    try { parsed = JSON.parse(res.stdout); } catch {}
    assert(res.status === 0 && parsed && parsed.decision === 'block', `call ${i}: block`);
  }

  // Call 4: counter = 3 → allow + reset
  {
    const res = runStop(stdin);
    assert(res.status === 0, 'call 4: exit 0');
    assert(res.stdout === '', 'call 4: allow (counter exhausted)');
  }

  // Call 5: counter reset → block again
  {
    const res = runStop(stdin);
    let parsed = null;
    try { parsed = JSON.parse(res.stdout); } catch {}
    assert(res.status === 0 && parsed && parsed.decision === 'block', 'call 5: block again after reset');
  }

  cleanCounter(sessId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Case 7: Never-steal — unknown session_id + 1 active run of ANOTHER session → allow, run untouched
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nCase 7: never-steal — unknown session, run of other session stays byte-identical');
{
  const otherSess = uniqueSession();
  const mySess    = uniqueSession();
  cleanCounter(mySess);

  const runRecord = freshRun(otherSess, 'M-other');
  const ws = makeTmpWorkspace({ withRunsDir: true, runRecord });

  // Capture original file bytes
  const runFile = path.join(ws, '.gsd', 'forge', 'runs', 'M-other.json');
  const before = fs.readFileSync(runFile, 'utf8');

  // Run hook as an unknown session (mySess has no matching run)
  const res = runStop({ session_id: mySess, cwd: ws });
  assert(res.status === 0, 'exit 0');
  assert(res.stdout === '', 'allow — no matching run for this session');

  // Verify run file is byte-identical (not claimed or modified)
  const after = fs.readFileSync(runFile, 'utf8');
  assert(before === after, 'runs/M-other.json byte-identical (never touched)');
  cleanCounter(mySess);
}

// ── Guard 5.5: worker in flight → allow + reset (2026-08-24) ─────────────────
// A non-null run.worker means the orchestrator dispatched a unit and is waiting
// on the async Agent() result — ending the turn IS the loop's correct state
// there. Measured before the guard: every wait boundary cost 1 block + 1 filler
// tool call. The stale-heartbeat case above already proves Guard 5 wins first.
{
  const sessId = uniqueSession();
  const inFlight = {
    id: 'M-guard55',
    kind: 'milestone',
    session_id: sessId,
    active: true,
    started_at: Date.now() - 60000,
    last_heartbeat: Date.now(),
    worker: 'execute-task/T07',
  };
  const ws = makeTmpWorkspace({ withRunsDir: true, runRecord: inFlight });
  const res = runStop({ session_id: sessId, cwd: ws });
  assert(res.status === 0, 'guard 5.5: exit 0');
  assert(res.stdout === '', 'guard 5.5: empty stdout (allow — worker in flight)');
  // Counter was reset: a subsequent idle stop (worker null) still blocks fresh.
  const idle = { ...inFlight, worker: null, last_heartbeat: Date.now() };
  const fs2 = require('fs'); const path2 = require('path');
  fs2.writeFileSync(path2.join(ws, '.gsd', 'forge', 'runs', 'M-guard55.json'), JSON.stringify(idle));
  const res2 = runStop({ session_id: sessId, cwd: ws });
  assert(res2.stdout.includes('"decision":"block"'), 'guard 5.5: reset counter — idle stop right after still blocks');
  cleanCounter(sessId);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} assertions: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAIL');
  process.exit(1);
} else {
  console.log('OK');
}
