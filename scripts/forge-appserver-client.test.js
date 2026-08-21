#!/usr/bin/env node
'use strict';

/** Standalone Node test for the JSONL app-server client. */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  startAppServerTurn, encodeMessage, decodeLine, INTERRUPT_OUTCOMES, INTERRUPT_GRACE_MS,
  RETENTION_LIMITS, TURN_STATUS_SUCCESS, STDERR_TAIL_BYTES, tailBytes,
  isContextNotification,
} = require('./forge-appserver-client');

assert.strictEqual(isContextNotification({ method: 'thread/started', params: {} }), true);
assert.strictEqual(isContextNotification({ method: 'thread/compacted', params: { cycle_id: 'c1' } }), true);
assert.strictEqual(isContextNotification({ method: 'turn/completed', params: { context_window: { used_percentage: 0 } } }), true);
assert.strictEqual(isContextNotification({ method: 'turn/completed', params: {} }), false);

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-appserver-client-test-'));
}

// Keep this mock dependency-free: it runs under process.execPath, exactly like
// the real app-server process would. It also refuses any post-initialize request
// before the initialized notification, catching an ordering regression.
function writeMockAppServer(dir) {
  const mock = String.raw`
'use strict';
const fs = require('fs');
const mode = process.env.FORGE_APPSERVER_MOCK_MODE || 'happy';
const pidFile = process.env.FORGE_APPSERVER_PID_FILE;
if (pidFile) fs.writeFileSync(pidFile, String(process.pid));
// Independent of any scenario-specific pid file: every mock instance this suite spawns
// registers itself here, so the finally-block sweep can find and kill survivors of ANY
// scenario, not only the ones that happened to opt into FORGE_APPSERVER_PID_FILE. This
// is a safety net for the process table, not a substitute for a scenario's own
// waitForDeath assertion -- those still fail on their own if a kill path regresses.
const registryFile = process.env.FORGE_APPSERVER_REGISTRY_FILE;
if (registryFile) fs.appendFileSync(registryFile, String(process.pid) + '\n');
// A grandchild in the same process group, spawned before the first reply so it is
// guaranteed to exist by the time any timeout fires. killProcessTree's whole reason
// to exist is this process: child.kill() alone leaves it running. It is NOT detached,
// so it belongs to the group the client created and dies with process.kill(-pid).
const grandchildPidFile = process.env.FORGE_APPSERVER_GRANDCHILD_PID_FILE;
if (grandchildPidFile) {
  const grandchild = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
  fs.writeFileSync(grandchildPidFile, String(grandchild.pid));
  if (registryFile) fs.appendFileSync(registryFile, String(grandchild.pid) + '\n');
}
let initialized = false;
let sawInboundReply = false;
// The SERVER stamps what it received, so ordering is proved by the peer's own record
// rather than by reading the client's source and believing it.
const logFile = process.env.FORGE_APPSERVER_LOG_FILE;
function logMethod(message) {
  if (!logFile) return;
  fs.appendFileSync(logFile, JSON.stringify({ method: message.method, params: message.params, at: Date.now() }) + '\n');
}
process.stdout.write('mock app-server banner (not JSON)\n');
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
function reject(message) { send({ id: message.id, error: { code: -32001, message: 'request before initialized' } }); }
let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  pending += chunk;
  let index;
  while ((index = pending.indexOf('\n')) >= 0) {
    const raw = pending.slice(0, index); pending = pending.slice(index + 1);
    if (!raw) continue;
    let message; try { message = JSON.parse(raw); } catch { process.exit(91); }
    if (Object.prototype.hasOwnProperty.call(message, 'jsonrpc')) process.exit(92);
    if (message.id === 77 && message.error && message.error.code === -32601) sawInboundReply = true;
    logMethod(message);
    if (message.method === 'turn/interrupt') {
      // interrupt-ignored deliberately never answers: that is what makes the grace
      // expire instead of being acknowledged.
      if (mode === 'interrupt-acked') { send({ id: message.id, result: {} }); }
      else if (mode === 'interrupt-then-completed') {
        // Order matters and is deliberate. turn/completed {status:'interrupted'} is what
        // a real server emits in response to an interrupt (measured: TurnStatus includes
        // 'interrupted'), and it is emitted FIRST, with the RPC ack delayed. If the ack
        // came in the same chunk, the client's ack-handling microtask would beat the 5ms
        // completion watcher and the session would reject on ORDERING alone — the test
        // would pass with the latch deleted. Delaying the ack hands the watcher several
        // ticks in which an unlatched client resolves the timeout as a SUCCESS.
        send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'interrupted' } } });
        setTimeout(() => { send({ id: message.id, result: {} }); }, 40);
      }
      continue;
    }
    if (message.method === 'initialize') {
      if (mode === 'busy') { send({ id: message.id, error: { code: -32001, message: 'app-server busy' } }); continue; }
      send({ id: message.id, result: { serverInfo: { name: 'mock' } } });
    } else if (message.method === 'initialized') {
      initialized = true;
    } else if (message.method === 'thread/start') {
      if (!initialized) { reject(message); continue; }
      send({ id: message.id, result: { thread: { id: 'thread-1' } } });
    } else if (message.method === 'turn/start') {
      if (!initialized) { reject(message); continue; }
      // The turn never starts, so the client never observes a turnId and must not
      // fabricate one: both TurnInterruptParams fields are required.
      if (mode === 'no-turn-start-reply') continue;
      // R15. A completion naming SOMEBODY ELSE'S turn, followed by ours. Sent in this
      // order on purpose: a client that latches on the first turn/completed it sees
      // resolves on the foreign one.
      if (mode === 'foreign-completion') {
        send({ id: message.id, result: { turn: { id: 'turn-1' } } });
        send({ method: 'turn/completed', params: { turn: { id: 'turn-OTHER', status: 'completed' } } });
        setTimeout(() => { send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } }); }, 15);
        continue;
      }
      // R15. ONLY completions that are not ours: one for another turn, one that names
      // no turn at all. Neither may end this session; it must time out.
      if (mode === 'foreign-only') {
        send({ id: message.id, result: { turn: { id: 'turn-1' } } });
        send({ method: 'turn/completed', params: { turn: { id: 'turn-OTHER', status: 'completed' } } });
        send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
        continue;
      }
      // R15. Our turn, ended by the model failing rather than by success.
      if (mode === 'completed-failed') {
        send({ id: message.id, result: { turn: { id: 'turn-1' } } });
        send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'failed' } } });
        continue;
      }
      // S07 R1. Exit immediately after a successful completion. The setTimeout is 0ms
      // (not a delay that would hide the window) and exists only so the pipe writes
      // flush before process.exit truncates them.
      if (mode === 'exit-after-completed') {
        send({ id: message.id, result: { turn: { id: 'turn-1' } } });
        send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
        setTimeout(() => process.exit(0), 0);
        continue;
      }
      // R16. A long newline-free run, then a normal turn: the client must drop the
      // unterminated line AND resynchronise on the next one.
      if (mode === 'oversized-line') {
        send({ id: message.id, result: { turn: { id: 'turn-1' } } });
        // The terminating newline goes out in a LATER chunk on purpose: written back to
        // back, both land in one read and the client sees a complete (if unparseable)
        // line, never an unterminated one. The overflow only exists while the line is
        // still open.
        process.stdout.write('x'.repeat(3000));
        setTimeout(() => {
          process.stdout.write('\n');
          send({ method: 'item/completed', params: { item: { id: 'item-1' } } });
          send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
        }, 15);
        continue;
      }
      // R16. More of everything the session retains than the caps allow.
      if (mode === 'flood') {
        send({ id: message.id, result: { turn: { id: 'turn-1' } } });
        for (let i = 0; i < 20; i += 1) send({ method: 'item/completed', params: { item: { id: 'item-' + i } } });
        for (let i = 0; i < 3; i += 1) send({ id: 500 + i, method: 'execCommandApproval', params: { command: 'nope' } });
        send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
        continue;
      }
      // R3. Accented stderr: every char is 2 bytes, so the code-unit cap held roughly
      // twice the bytes the constant names.
      if (mode === 'accented-stderr') {
        process.stderr.write('çãéõ'.repeat(4000));
        send({ id: message.id, result: { turn: { id: 'turn-1' } } });
        setTimeout(() => { send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } }); }, 15);
        continue;
      }
      if (mode === 'interrupt-ignored' || mode === 'interrupt-acked' || mode === 'interrupt-then-completed') {
        send({ id: message.id, result: { turn: { id: 'turn-1' }, echoParams: message.params } });
        send({ method: 'turn/started', params: { turn: { id: 'turn-1' } } });
        continue;
      }
      // Echo the params back verbatim: the late-threadId contract is about what the
      // SERVER received, and asserting on the object the caller handed in would prove
      // only that the test can build a literal.
      send({ id: message.id, result: { turn: { id: 'turn-1' }, echoParams: message.params } });
      if (mode === 'timeout') continue;
      if (mode === 'split-multibyte') {
        // Write one JSONL line as raw bytes cut THROUGH a multibyte character, so the
        // client receives the two halves in separate chunks. Decoding each chunk on its
        // own yields U+FFFD; only a decoder that carries state across chunks recovers it.
        const line = Buffer.from(JSON.stringify({ method: 'item/completed', params: { item: { id: 'item-1', type: 'message', text: 'çãé — resumo' } } }) + '\n', 'utf8');
        const cut = line.indexOf(Buffer.from('ã', 'utf8')) + 1;
        process.stdout.write(line.subarray(0, cut));
        setTimeout(() => {
          process.stdout.write(line.subarray(cut));
          send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
        }, 10);
        continue;
      }
      send({ id: 77, method: 'execCommandApproval', params: { command: 'nope' } });
      // Two shapes a real server can emit that route to nothing (R10): a bare object,
      // and a response to an id the client never issued.
      send({ note: 'neither id nor method' });
      send({ id: 4242, result: { stray: true } });
      setTimeout(() => {
        if (!sawInboundReply) { process.stderr.write('client silently ignored inbound request'); process.exit(93); return; }
        send({ method: 'item/completed', params: { item: { id: 'item-1', type: 'message' } } });
        send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
      }, 12);
    }
  }
});
setInterval(() => {}, 1000);
`;
  const file = path.join(dir, 'mock-app-server.js');
  fs.writeFileSync(file, mock, 'utf8');
  return file;
}

function pause(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function expectReject(action, check) {
  let error;
  try { await action(); } catch (caught) { error = caught; }
  assert(error, 'expected a rejected session');
  check(error);
}

async function testHelpers() {
  const encoded = encodeMessage({ jsonrpc: '2.0', id: 3, method: 'initialize' });
  assert.strictEqual(encoded, '{"id":3,"method":"initialize"}\n');
  assert.deepStrictEqual(decodeLine('{"method":"turn/completed"}'), { msg: { method: 'turn/completed' } });
  assert.deepStrictEqual(decodeLine('old banner'), { discard: 'old banner' });
  assert.deepStrictEqual(decodeLine(''), { discard: '' });
}

async function testHappyPath(mock, dir) {
  const events = [];
  const result = await startAppServerTurn({
    cmd: process.execPath,
    args: [mock],
    env: { ...process.env, FORGE_APPSERVER_MOCK_MODE: 'happy' },
    cwd: dir,
    timeoutMs: 1500,
    threadParams: { cwd: dir },
    turnParams: { input: [{ type: 'text', text: 'hello' }] },
    onEvent: event => events.push(event.method),
  });
  assert.strictEqual(result.initializeResult.serverInfo.name, 'mock');
  assert.strictEqual(result.threadStartResult.thread.id, 'thread-1');
  assert.strictEqual(result.turnResult.turn.id, 'turn-1');
  assert.strictEqual(result.items.length, 1);
  assert(events.includes('item/completed') && events.includes('turn/completed'));
  assert.strictEqual(result.inboundRequests.length, 1);
  assert.strictEqual(result.inboundRequests[0].method, 'execCommandApproval');
  // The census names WHY each drop happened. The banner is unparseable; the mock also
  // emits one routable-by-nothing object and one reply to an id nobody awaits, and both
  // of those used to disappear without incrementing anything (R10).
  assert.strictEqual(result.discarded.count, 3);
  assert.match(result.discarded.sample[0], /not JSON/);
  assert.deepStrictEqual(result.discarded.kinds, {
    unparseable: 1, 'non-object': 0, 'no-id-no-method': 1, 'unmatched-response': 1, 'oversized-line': 0,
  });
  // The status is now READ, not inferred from the notification's arrival (R15).
  assert.strictEqual(result.turnStatus, TURN_STATUS_SUCCESS);
  assert.deepStrictEqual(result.turnCompletions, {
    observed: 1, matched: 1, ignored: 0, dropped: 0, records: [{ id: 'turn-1', status: 'completed' }],
  });
  // Present at zero. A retention census that appeared only when something was dropped
  // would be indistinguishable from a counter that never runs (R16).
  assert.deepStrictEqual(result.retention.dropped,
    { notifications: 0, items: 0, inboundRequests: 0, turnCompletions: 0 });
  assert.deepStrictEqual(result.retention.limits, RETENTION_LIMITS);
}

// Regression (R14): the corruption is invisible to JSON parsing (structural chars are
// ASCII) and shows up only inside string content, so it has to be asserted on the text.
async function testSplitMultibyte(mock, dir) {
  const result = await startAppServerTurn({
    cmd: process.execPath,
    args: [mock],
    env: { ...process.env, FORGE_APPSERVER_MOCK_MODE: 'split-multibyte' },
    cwd: dir,
    timeoutMs: 1500,
    threadParams: { cwd: dir },
    turnParams: { input: [{ type: 'text', text: 'hello' }] },
  });
  assert.strictEqual(result.items.length, 1);
  assert.strictEqual(result.items[0].item.text, 'çãé — resumo');
  assert(!result.items[0].item.text.includes('�'), 'multibyte char split across chunks must not decode to U+FFFD');
}

async function testBusy(mock, dir) {
  await expectReject(() => startAppServerTurn({
    cmd: process.execPath, args: [mock], cwd: dir, timeoutMs: 1000,
    env: { ...process.env, FORGE_APPSERVER_MOCK_MODE: 'busy' },
  }), error => {
    assert.strictEqual(error.code, -32001);
    assert.match(error.message, /^forge-appserver-client: app-server busy$/);
  });
}

// The property under test is that the whole PROCESS GROUP dies, not just app-server.
// Before the grandchild existed, this test passed with process.kill(-child.pid) deleted
// outright, because killProcessTree's child.kill('SIGKILL') fallback satisfied the only
// assertion — the property lived in a comment and nowhere in the test. The grandchild is
// unreachable by child.kill and only dies via the negative-pid group signal.
async function testTimeoutKillsGroup(mock, dir, budget) {
  const run = await runTimedOutTurn({
    mock, dir, mode: 'timeout', label: 'timed-out', budget, graceFactor: 1.35,
    wantPid: true, wantGrandchild: true,
  });
  const error = run.error;
  // Anchored regex, unedited in FORM: the interrupt step must not have perturbed the
  // message by so much as a byte, because its exact text is what classifies this as
  // terminal. Only the numeric value follows the measured window.
  assert.match(error.message, timeoutMessagePattern(run.timeoutMs));
  assert.strictEqual(error.timeoutMs, run.timeoutMs);
  // This mode DOES answer turn/start (with turn.id 'turn-1') and then goes silent, so
  // a turnId IS observed and the interrupt IS attempted — it is simply never answered.
  // Measured, against T01-PLAN step 9's assumption that this mode yields no turnId.
  assert.strictEqual(error.interrupt, INTERRUPT_OUTCOMES.GRACE_EXPIRED);
  assert.strictEqual(error.turnId, 'turn-1');
  const pid = await readPidFileWhenWritten(run.pidFile, 'mock must have recorded its pid');
  const grandchildPid = await readPidFileWhenWritten(run.grandchildPidFile,
    'mock must have spawned a grandchild for this test to mean anything');
  await waitForDeath(pid, 'timeout must kill app-server itself');
  if (process.platform !== 'win32') {
    await waitForDeath(grandchildPid,
      'timeout must kill the whole detached process group, not only the app-server process');
  }
}

// S02-PLAN decision 3. The mock answers thread/start with a fixed id and echoes the
// turn/start params it actually received, so each of these asserts on the wire, not on
// the caller's own literal.
async function testTurnParamsFunction(mock, dir) {
  const seen = [];
  const result = await startAppServerTurn({
    cmd: process.execPath, args: [mock], cwd: dir, timeoutMs: 1500,
    env: { ...process.env, FORGE_APPSERVER_MOCK_MODE: 'happy' },
    turnParams: (threadId) => {
      seen.push(threadId);
      return { threadId, input: [{ type: 'text', text: 'hi' }], nested: { echoed: threadId } };
    },
  });
  assert.deepStrictEqual(seen, ['thread-1'], 'turnParams function must be called once with thread.id');
  // The returned object must be what the server got — including the nested placement a
  // static object could never have filled in.
  assert.strictEqual(result.turnResult.echoParams.threadId, 'thread-1');
  assert.strictEqual(result.turnResult.echoParams.nested.echoed, 'thread-1');
}

async function testTurnParamsObjectInjection(mock, dir) {
  const params = { input: [{ type: 'text', text: 'hi' }] };
  const result = await startAppServerTurn({
    cmd: process.execPath, args: [mock], cwd: dir, timeoutMs: 1500,
    env: { ...process.env, FORGE_APPSERVER_MOCK_MODE: 'happy' },
    turnParams: params,
  });
  assert.strictEqual(result.turnResult.echoParams.threadId, 'thread-1', 'threadId must be injected when absent');
  assert.strictEqual(params.threadId, undefined, 'the caller object must not be mutated');

  // An explicit threadId is a fact the caller asserted; injection must not overwrite it.
  const explicit = await startAppServerTurn({
    cmd: process.execPath, args: [mock], cwd: dir, timeoutMs: 1500,
    env: { ...process.env, FORGE_APPSERVER_MOCK_MODE: 'happy' },
    turnParams: { threadId: 'caller-owned', input: [{ type: 'text', text: 'hi' }] },
  });
  assert.strictEqual(explicit.turnResult.echoParams.threadId, 'caller-owned');
}

async function testOnSpawn(mock, dir) {
  const pids = [];
  const pidFile = path.join(dir, 'onspawn.pid');
  const result = await startAppServerTurn({
    cmd: process.execPath, args: [mock], cwd: dir, timeoutMs: 1500,
    env: { ...process.env, FORGE_APPSERVER_MOCK_MODE: 'happy', FORGE_APPSERVER_PID_FILE: pidFile },
    onSpawn: pid => pids.push(pid),
  });
  assert.strictEqual(pids.length, 1, 'onSpawn must fire exactly once');
  assert(Number.isInteger(pids[0]) && pids[0] > 0, `onSpawn must receive a numeric pid, got ${pids[0]}`);
  // It must be the app-server's pid, not some other number that happens to be an integer.
  assert.strictEqual(pids[0], Number(fs.readFileSync(pidFile, 'utf8')));
  assert.strictEqual(result.turnResult.turn.id, 'turn-1');

  // Same treatment as onEvent: a throwing observer does not get to kill the session.
  const survived = await startAppServerTurn({
    cmd: process.execPath, args: [mock], cwd: dir, timeoutMs: 1500,
    env: { ...process.env, FORGE_APPSERVER_MOCK_MODE: 'happy' },
    onSpawn: () => { throw new Error('observer exploded'); },
  });
  assert.strictEqual(survived.turnResult.turn.id, 'turn-1');
}

function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

const alive = (target) => { try { process.kill(target, 0); return true; } catch { return false; } };

// A fixed sleep followed by a liveness assert is a bet on the scheduler: SIGKILL
// delivery and reaping (a grandchild is a zombie until its reparented owner reaps
// it) are not bounded by 150ms on a loaded machine. Polling asserts the SAME
// property -- it must die -- but waits for the observable fact instead of a
// guess, and still fails loudly if it never happens.
async function waitForDeath(pid, message, deadlineMs = 5000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until && alive(pid)) await pause(10);
  assert.strictEqual(alive(pid), false, message);
}

async function readPidFileWhenWritten(file, message, deadlineMs = 5000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until && !fs.existsSync(file)) await pause(10);
  assert(fs.existsSync(file), message);
  const pid = Number(fs.readFileSync(file, 'utf8'));
  assert(Number.isInteger(pid) && pid > 0, `${message} (got ${pid})`);
  return pid;
}

// The timeout message is load-bearing and stays anchored; only the VALUE moves,
// and it is derived from the same arithmetic the client uses, so a change to the
// format still fails here.
function timeoutMessagePattern(timeoutMs) {
  const seconds = String(Number((timeoutMs / 1000).toFixed(3))).replace('.', '\\.');
  return new RegExp(`^forge-appserver-client: timeout after ${seconds}s$`);
}

// Measured, never assumed. Every timed-out scenario races one thing the test does
// not own: the client arms its timer at spawn, so booting node and completing
// initialize/thread/turn has to fit INSIDE timeoutMs. A hard-coded 90ms fits on an
// idle machine and does not fit under contention -- measured 2026-08-07, 24 busy
// processes on 10 cores: 10 of 12 runs failed, every one collapsing to
// SKIPPED_NO_TURN_ID because the handshake never landed. The window cannot be
// lifted out of the race from the test side (the client owns both the spawn and
// the timer), so it is sized from a measurement taken in THIS process under THIS
// load rather than from a constant chosen on an idle laptop.
async function measureHandshakeMs(mock, dir) {
  const started = Date.now();
  await startAppServerTurn({
    cmd: process.execPath, args: [mock], cwd: dir, timeoutMs: 20000,
    env: { ...process.env, FORGE_APPSERVER_MOCK_MODE: 'happy' },
    threadParams: { cwd: dir },
    turnParams: { input: [{ type: 'text', text: 'probe' }] },
  });
  return Date.now() - started;
}

/**
 * Drives one scenario that is expected to time out.
 *
 * The retry barrier is the PEER'S OWN RECORD, not a hope: if the server logged no
 * `turn/start` the handshake provably never landed inside the window, which is
 * starvation of this machine and not a defect of the client. An attempt whose log
 * DOES show turn/start is never retried, so a genuine regression in turnId capture
 * (the same observable symptom, SKIPPED_NO_TURN_ID) still fails on attempt one.
 * No assertion is relaxed anywhere: every caller asserts exactly what it did before.
 */
async function runTimedOutTurn({ mock, dir, mode, label, budget, graceFactor, wantPid = false, wantGrandchild = false }) {
  let timeoutMs = Math.max(90, Math.round(budget));
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const stem = path.join(dir, `${label}-${attempt}`);
    const logFile = `${stem}.log`;
    const pidFile = `${stem}.pid`;
    const grandchildPidFile = `${stem}.grandchild.pid`;
    const env = { ...process.env, FORGE_APPSERVER_MOCK_MODE: mode, FORGE_APPSERVER_LOG_FILE: logFile };
    if (wantPid) env.FORGE_APPSERVER_PID_FILE = pidFile;
    if (wantGrandchild) env.FORGE_APPSERVER_GRANDCHILD_PID_FILE = grandchildPidFile;
    const interruptGraceMs = Math.max(120, Math.round(timeoutMs * graceFactor));
    let error;
    try {
      await startAppServerTurn({ cmd: process.execPath, args: [mock], cwd: dir, timeoutMs, interruptGraceMs, env });
    } catch (caught) { error = caught; }
    assert(error, `${label}: expected a rejected session`);
    const log = readLog(logFile);
    if (!log.some(entry => entry.method === 'turn/start') && attempt < 4) { timeoutMs *= 2; continue; }
    return { error, log, timeoutMs, pidFile, grandchildPidFile, attempts: attempt };
  }
  throw new Error(`${label}: the server never received turn/start inside the window after 4 widening attempts`);
}

// The enum is the contract the tests and smoke Section 98 bind to. Asserting its shape
// here means a rename shows up as a failure instead of as tests quietly comparing
// undefined to undefined.
async function testInterruptOutcomeEnum() {
  assert.deepStrictEqual(INTERRUPT_OUTCOMES, {
    ACKNOWLEDGED: 'acknowledged',
    ERROR: 'error',
    GRACE_EXPIRED: 'grace-expired',
    UNSENT: 'unsent',
    SKIPPED_NO_TURN_ID: 'skipped:no-turn-id',
  });
  assert(Object.isFrozen(INTERRUPT_OUTCOMES), 'the outcome enum must not be mutable at runtime');
  assert.strictEqual(INTERRUPT_GRACE_MS, 2000);
  // Validated only when supplied, like timeoutMs.
  await expectReject(() => startAppServerTurn({ cmd: process.execPath, args: ['x'], interruptGraceMs: 0 }),
    error => assert.match(error.message, /interruptGraceMs must be a positive number/));
}

// Acceptance criterion 1: the interrupt is ignored, so the grace expires, the message is
// unchanged, the outcome is NAMED, and the SIGKILL fallback still takes the whole group.
async function testInterruptIgnored(mock, dir, budget) {
  const run = await runTimedOutTurn({
    mock, dir, mode: 'interrupt-ignored', label: 'ignored', budget, graceFactor: 1.35,
    wantPid: true, wantGrandchild: true,
  });
  const error = run.error;
  assert.match(error.message, timeoutMessagePattern(run.timeoutMs));
  assert.strictEqual(error.interrupt, INTERRUPT_OUTCOMES.GRACE_EXPIRED);
  assert.strictEqual(error.turnId, 'turn-1');
  assert(run.log.some(entry => entry.method === 'turn/interrupt'), 'the server must have received turn/interrupt');
  const pid = await readPidFileWhenWritten(run.pidFile, 'mock must have recorded its pid');
  const grandchildPid = await readPidFileWhenWritten(run.grandchildPidFile, 'mock must have spawned a grandchild');
  await waitForDeath(pid, 'SIGKILL must remain the fallback after the grace expires');
  if (process.platform !== 'win32') {
    await waitForDeath(grandchildPid, 'the fallback must still take the whole process group');
  }
}

// Acceptance criteria 2 and 5: acknowledged, with the params and the ORDER proved by the
// server's own timestamped record rather than by reading the client.
async function testInterruptAcked(mock, dir, budget) {
  const run = await runTimedOutTurn({
    mock, dir, mode: 'interrupt-acked', label: 'acked', budget, graceFactor: 5.5, wantPid: true,
  });
  const error = run.error;
  assert.match(error.message, timeoutMessagePattern(run.timeoutMs));
  assert.strictEqual(error.interrupt, INTERRUPT_OUTCOMES.ACKNOWLEDGED);
  assert.strictEqual(error.turnId, 'turn-1');
  assert(error.turnIdSource, 'the source of the turnId must be recorded, never undefined');
  const log = run.log;
  const interrupt = log.find(entry => entry.method === 'turn/interrupt');
  assert(interrupt, 'the server must have received turn/interrupt');
  assert.strictEqual(interrupt.params.threadId, 'thread-1');
  assert.strictEqual(interrupt.params.turnId, 'turn-1');
  // Order, from the peer's stamps: the interrupt arrived after the turn started.
  const started = log.find(entry => entry.method === 'turn/start');
  assert(started && started.at <= interrupt.at, 'turn/interrupt must be recorded after turn/start');
  const pid = await readPidFileWhenWritten(run.pidFile, 'mock must have recorded its pid');
  await waitForDeath(pid, 'an acknowledged interrupt does not cancel the SIGKILL fallback');
}

// Acceptance criterion 3 — the one that matters most. The server acknowledges and then
// emits turn/completed {status:"interrupted"}. Without the terminality latch the
// notification handler marks turnComplete and the session RESOLVES: a timed-out unit
// would be reported as `done`. This test is red the moment the latch is removed.
async function testInterruptThenCompleted(mock, dir, budget) {
  const run = await runTimedOutTurn({
    mock, dir, mode: 'interrupt-then-completed', label: 'then-completed', budget, graceFactor: 5.5,
  });
  assert.match(run.error.message, timeoutMessagePattern(run.timeoutMs));
  assert.strictEqual(run.error.interrupt, INTERRUPT_OUTCOMES.ACKNOWLEDGED);
  await pause(120);
}

// Acceptance criterion 4: no turn ever started, so no well-formed interrupt exists to
// send. The skip is named and the kill happens anyway.
async function testInterruptNoTurnId(mock, dir, budget) {
  // The barrier matters most here: this scenario's EXPECTED outcome is the same
  // symptom starvation produces, so without the server's own record of turn/start
  // a starved run would "pass" for the wrong reason. runTimedOutTurn only returns
  // once the peer confirms it received the turn it then refuses to answer.
  const run = await runTimedOutTurn({
    mock, dir, mode: 'no-turn-start-reply', label: 'no-turn', budget, graceFactor: 1.35, wantPid: true,
  });
  const error = run.error;
  assert.match(error.message, timeoutMessagePattern(run.timeoutMs));
  assert.strictEqual(error.interrupt, INTERRUPT_OUTCOMES.SKIPPED_NO_TURN_ID);
  assert.strictEqual(error.turnId, null, 'an unobserved turnId is null, never undefined');
  assert.strictEqual(error.turnIdSource, null);
  assert(run.log.some(entry => entry.method === 'turn/start'),
    'the server must have received turn/start; otherwise the skip proves starvation, not the contract');
  assert(!run.log.some(entry => entry.method === 'turn/interrupt'),
    'no interrupt may be sent without both required params');
  const pid = await readPidFileWhenWritten(run.pidFile, 'mock must have recorded its pid');
  await waitForDeath(pid, 'a skipped interrupt still kills');
}

// R15. A `turn/completed` that names another turn must not end this session. The mock
// sends the foreign one FIRST, so a client that latches on arrival resolves on it and
// never even waits for ours.
async function testForeignCompletionIgnored(mock, dir) {
  const result = await startAppServerTurn({
    cmd: process.execPath, args: [mock], cwd: dir, timeoutMs: 4000,
    env: { ...process.env, FORGE_APPSERVER_MOCK_MODE: 'foreign-completion' },
  });
  assert.strictEqual(result.turnStatus, TURN_STATUS_SUCCESS);
  assert.strictEqual(result.turnCompletions.observed, 2);
  assert.strictEqual(result.turnCompletions.matched, 1);
  assert.strictEqual(result.turnCompletions.ignored, 1, 'the foreign completion must be recorded as ignored, not silently dropped');
  // Proof that it resolved on OURS and not on the foreign one that arrived first: the
  // record it matched carries our turn id.
  assert(result.turnCompletions.records.some(entry => entry.id === 'turn-OTHER'));
}

// R15, the stricter half: with ONLY foreign/anonymous completions the session must NOT
// resolve. It times out — which is the honest outcome, since our turn never reported.
async function testForeignOnlyNeverResolves(mock, dir, budget) {
  const run = await runTimedOutTurn({
    mock, dir, mode: 'foreign-only', label: 'foreign-only', budget, graceFactor: 1.35,
  });
  assert.match(run.error.message, timeoutMessagePattern(run.timeoutMs));
  assert.strictEqual(run.error.turnCompletions.matched, 0);
  assert.strictEqual(run.error.turnCompletions.ignored, 2,
    'a completion with a foreign id and one with no id at all must both be visible in the error');
}

// R15. `failed` rides the same notification as `completed` (measured: TurnStatus =
// completed|interrupted|failed|inProgress). Resolving on it reports a failed turn as done.
async function testNonSuccessStatusRejects(mock, dir) {
  await expectReject(() => startAppServerTurn({
    cmd: process.execPath, args: [mock], cwd: dir, timeoutMs: 4000,
    env: { ...process.env, FORGE_APPSERVER_MOCK_MODE: 'completed-failed' },
  }), error => {
    assert.match(error.message, /^forge-appserver-client: turn ended with status failed$/);
    assert.strictEqual(error.turnStatus, 'failed');
    assert.strictEqual(error.turnCompletions.matched, 1);
  });
}

// S07 R1. The child exits right after a successful turn/completed, before settlement.
// Measured as a REAL window: settlement waits on a 5ms poll, the exit lands inside it.
async function testExitAfterCompleted(mock, dir) {
  const result = await startAppServerTurn({
    cmd: process.execPath, args: [mock], cwd: dir, timeoutMs: 4000,
    env: { ...process.env, FORGE_APPSERVER_MOCK_MODE: 'exit-after-completed' },
  });
  assert.strictEqual(result.turnStatus, TURN_STATUS_SUCCESS);
  assert.strictEqual(result.turnResult.turn.id, 'turn-1');
}

// R16. Caps bite AND say so. The limits are overridden rather than flooded past their
// production values: what is under test is that the cap truncates and records, and
// 5000 real notifications would prove the same thing far more slowly.
async function testRetentionCaps(mock, dir) {
  const result = await startAppServerTurn({
    cmd: process.execPath, args: [mock], cwd: dir, timeoutMs: 4000,
    env: { ...process.env, FORGE_APPSERVER_MOCK_MODE: 'flood' },
    retentionLimits: { notifications: 4, items: 3, inboundRequests: 1 },
  });
  assert.strictEqual(result.items.length, 3, 'items must stop at the cap');
  assert.strictEqual(result.notifications.length, 4, 'notifications must stop at the cap');
  assert.strictEqual(result.inboundRequests.length, 1, 'inbound request retention must stop at the cap');
  assert(result.retention.dropped.items >= 17, `dropped items must be counted, got ${result.retention.dropped.items}`);
  assert(result.retention.dropped.notifications >= 17, 'dropped notifications must be counted');
  assert.strictEqual(result.retention.dropped.inboundRequests, 2);
  assert.deepStrictEqual(result.retention.limits.items, 3, 'the census must report the limits actually in force');
  // Capping RETENTION must not cap the protocol duty: every inbound request is still
  // answered, or the server waits forever on the ones we chose not to remember.
  assert.strictEqual(result.turnStatus, TURN_STATUS_SUCCESS);
}

// R16. An unterminated line is dropped once past the cap, named in the same census as
// every other stream discard, and the parser resynchronises on the next newline.
async function testOversizedLine(mock, dir) {
  const result = await startAppServerTurn({
    cmd: process.execPath, args: [mock], cwd: dir, timeoutMs: 4000,
    env: { ...process.env, FORGE_APPSERVER_MOCK_MODE: 'oversized-line' },
    retentionLimits: { stdoutLineChars: 1000 },
  });
  assert.strictEqual(result.discarded.kinds['oversized-line'], 1, 'the dropped line must be named, not silently forgotten');
  assert(result.discarded.sample.some(entry => /^x+$/.test(entry)), 'the census must carry a readable prefix of what it dropped');
  // Resynchronisation: the item AFTER the oversized line was parsed normally.
  assert.strictEqual(result.items.length, 1);
  assert.strictEqual(result.items[0].item.id, 'item-1');
  assert.strictEqual(result.turnStatus, TURN_STATUS_SUCCESS);
}

// R3. The constant says BYTES; it used to slice UTF-16 code units.
async function testStderrTailIsBytes(mock, dir) {
  assert.strictEqual(tailBytes('abc', 10), 'abc');
  assert.strictEqual(tailBytes('abcdef', 3), 'def');
  // 4 chars, 8 bytes. A code-unit cap of 4 would return all of it; a byte cap must not.
  assert.strictEqual(Buffer.byteLength(tailBytes('çãéõ', 4), 'utf8'), 4);
  // Cutting mid-character must drop the partial one, never emit U+FFFD (the R14 defect).
  assert(!tailBytes('çãéõ', 5).includes('�'), 'a byte cut inside a character must not decode to U+FFFD');
  assert.strictEqual(tailBytes('çãéõ', 5), 'éõ');

  const result = await startAppServerTurn({
    cmd: process.execPath, args: [mock], cwd: dir, timeoutMs: 4000,
    env: { ...process.env, FORGE_APPSERVER_MOCK_MODE: 'accented-stderr' },
  });
  const bytes = Buffer.byteLength(result.stderrTail, 'utf8');
  assert(bytes <= STDERR_TAIL_BYTES, `stderrTail must be capped in BYTES, got ${bytes} for cap ${STDERR_TAIL_BYTES}`);
  assert(bytes > STDERR_TAIL_BYTES - 8, `the cap must still keep a full tail, got ${bytes}`);
  assert(!result.stderrTail.includes('�'), 'the byte-accurate tail must not corrupt the first character');
}

// Best-effort hard kill of one pid, by both routes killProcessTree itself uses: the
// negative-pid group signal (catches a detached grandchild) and the direct signal
// (catches a process that is not a group leader). Either or both may legitimately
// no-op if the process is already gone -- that is success, not a fallthrough to hide.
function killPidHard(pid) {
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: false }); } catch { /* best effort */ }
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { /* not a group leader, or already gone */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

// The safety net, not the test. This reads every pid ANY mock instance registered
// this run (see FORGE_APPSERVER_REGISTRY_FILE in the mock source above) and kills
// whatever is still alive. It must never be mistaken for proof that a kill path
// works: the scenario-specific waitForDeath assertions above are what fail loudly
// when a kill path regresses. This only stops leftovers from outliving the process
// when something -- a broken kill path, an assertion that threw mid-scenario -- left
// one behind.
async function sweepSurvivors(registryFile) {
  if (!fs.existsSync(registryFile)) return { registered: 0, swept: 0 };
  const pids = [...new Set(
    fs.readFileSync(registryFile, 'utf8').split('\n').filter(Boolean).map(Number),
  )];
  const survivors = pids.filter(alive);
  survivors.forEach(killPidHard);
  if (survivors.length > 0) {
    const until = Date.now() + 3000;
    while (Date.now() < until && survivors.some(alive)) await pause(10);
  }
  return { registered: pids.length, swept: survivors.length, stillAlive: survivors.filter(alive) };
}

async function main() {
  const dir = makeTempDir();
  const registryFile = path.join(dir, 'pid-registry.log');
  // Every call site below builds its env by spreading `...process.env` (verified by
  // inspection, not assumed), so setting this once here reaches every mock instance
  // this run spawns without editing any of those call sites individually.
  process.env.FORGE_APPSERVER_REGISTRY_FILE = registryFile;
  const mock = writeMockAppServer(dir);
  try {
    await testHelpers();
    await testHappyPath(mock, dir);
    await testTurnParamsFunction(mock, dir);
    await testTurnParamsObjectInjection(mock, dir);
    await testOnSpawn(mock, dir);
    await testSplitMultibyte(mock, dir);
    await testBusy(mock, dir);
    await testForeignCompletionIgnored(mock, dir);
    await testNonSuccessStatusRejects(mock, dir);
    await testExitAfterCompleted(mock, dir);
    await testRetentionCaps(mock, dir);
    await testOversizedLine(mock, dir);
    await testStderrTailIsBytes(mock, dir);
    // Sized from a live measurement rather than a constant: see measureHandshakeMs.
    // The floor keeps an idle machine fast; the multiplier is what survives a suite
    // running alongside 110 siblings.
    const budget = Math.max(90, (await measureHandshakeMs(mock, dir)) * 3);
    await testTimeoutKillsGroup(mock, dir, budget);
    await testInterruptOutcomeEnum();
    await testInterruptIgnored(mock, dir, budget);
    await testInterruptAcked(mock, dir, budget);
    await testInterruptThenCompleted(mock, dir, budget);
    await testInterruptNoTurnId(mock, dir, budget);
    await testForeignOnlyNeverResolves(mock, dir, budget);
    process.stdout.write('forge-appserver-client.test.js: ok\n');
  } finally {
    // Runs whether the try block above threw or not, so a broken kill path still
    // fails its OWN assertion first (waitForDeath, above) -- this only prevents
    // whatever it left behind from surviving the process.
    const sweep = await sweepSurvivors(registryFile);
    if (sweep.swept > 0) {
      process.stderr.write(
        `forge-appserver-client.test.js: WARNING swept ${sweep.swept} leaked mock process(es) ` +
        `out of ${sweep.registered} registered (still alive after sweep: ${(sweep.stillAlive || []).length}). ` +
        'This is a leak signal even on an otherwise-green run.\n',
      );
    }
    delete process.env.FORGE_APPSERVER_REGISTRY_FILE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
