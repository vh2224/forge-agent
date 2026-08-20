#!/usr/bin/env node
'use strict';

/**
 * forge-appserver-probe: thin CLI driver over forge-appserver-client's wire
 * framing (encodeMessage/decodeLine), used to
 * measure premises W5 (handshake under buildSidecarEnv('minimal')), A1
 * (outputSchema with apps/MCP active by default) and A2 (sandboxPolicy.networkAccess
 * per turn) against the real `codex app-server` binary.
 *
 * This script only DRIVES turns and prints raw wire traffic + a verdict. It
 * never asserts pass/fail on the caller's behalf beyond infra failures
 * (missing binary, spawn failure) — exit 2. A measured premise that fails is
 * NOT an infra failure: the verdict is printed and the process exits 0,
 * because the probe measures, it does not gate.
 *
 * Env is ALWAYS buildSidecarEnv('minimal') (W5) — never process.env directly —
 * because this probe exists to prove production will work, and production
 * uses that env.
 */

const { encodeMessage, decodeLine } = require('./forge-appserver-client');
const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_SECS = 120;

const PROBES = [
  'handshake', 'a1', 'a2', 'a4-ok', 'a4-fail', 'a4-denied',
  'model-thread-only', 'model-turn-only', 'model-conflict', 'nongit-cwd', 'nongit-write',
  'crossroot-write',
  'cap-networked', 'cap-workspace', 'cap-readonly',
  'evidence-runtime',
];

/**
 * A malformed flag must not be able to impersonate a refuted premise.
 *
 * Before this, `--timeout 90s` produced NaN, setTimeout(NaN) fired on the next tick,
 * and the process printed `VERDICT: falhou — timeout after NaNs` and exited 0 — the
 * same channel, the same shape and the same exit code as a genuinely measured failure,
 * ready to be pasted into an artifact as evidence. Unknown args were dropped in silence.
 * Operator error is now a usage error: stderr and exit 2, never a VERDICT line.
 */
function parseArgs(argv) {
  const out = { probe: null, timeoutSecs: DEFAULT_TIMEOUT_SECS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--probe' || arg === '--timeout') {
      const value = argv[i + 1];
      i += 1;
      if (value === undefined || value.startsWith('--')) return { error: `${arg} requires a value` };
      if (arg === '--probe') {
        if (!PROBES.includes(value)) return { error: `unknown probe "${value}" (expected one of: ${PROBES.join('|')})` };
        out.probe = value;
      } else {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds <= 0) return { error: `--timeout must be a positive number of seconds, got "${value}"` };
        out.timeoutSecs = seconds;
      }
    } else return { error: `unknown argument: ${arg}` };
  }
  if (!out.probe) return { error: 'missing required --probe' };
  return out;
}

function resolveCommand() {
  // Late require (sanctioned idiom) — the probe never sits in forge-xllm's
  // own require graph.
  const { resolveCodexCommand, buildSidecarEnv } = require('./forge-xllm');
  const { cmd, prefixArgs } = resolveCodexCommand();
  const env = buildSidecarEnv('minimal');
  return { cmd, args: prefixArgs, env };
}

// Single-quoted: an unquoted `touch ${target}` splits a path containing a space into
// two wrong files, the declared target stays absent, and the probe prints the
// premise as proven off a path bug (S03 review R4). Shared by every probe whose
// ground truth is "does this exact path exist after the turn".
const shellQuote = (p) => `'${String(p).replace(/'/g, `'\\''`)}'`;

function printVerdict(probeName, verdict, reason) {
  process.stdout.write(`\nVERDICT: ${probeName} = ${verdict} — ${reason}\n`);
}

function logWire(direction, payload) {
  process.stdout.write(`${direction} ${payload}\n`);
}

/**
 * Raw handshake: initialize -> initialized -> thread/start, with no turn/start
 * at all (zero inference cost). startAppServerTurn always drives a full turn,
 * so this probe drives the wire directly instead — reusing only the wire
 * encode/decode helpers from forge-appserver-client (Reuse Before Create for
 * the framing; the handshake shape itself is intentionally distinct because
 * the client contract always completes a turn).
 */
function runProbeHandshake({ cmd, args, env, timeoutSecs, threadParams = { approvalPolicy: 'never' } }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = '';
    let stderrTail = '';
    let nextId = 1;
    const pending = new Map();
    let child;

    // Kill, then WAIT FOR THE REAP before handing control back.
    //
    // Measured (2026-08-19, two runs of `--probe crossroot-write` against codex
    // 0.146.0 on Windows): the arm that follows another arm died reproducibly with
    // `failed to initialize sqlite state runtime under ~/.codex`. The kill above is
    // `/F` — the OS tears the process down without letting it close its sqlite
    // handles, and the NEXT app-server spawned against the same CODEX_HOME cannot
    // initialize the state runtime while those handles are still held.
    //
    // Resolving before the child is reaped is what turned an ordering detail into a
    // failed measurement: the caller starts the next session immediately. The wait is
    // BOUNDED — a probe that hangs waiting for a corpse would be a worse defect than
    // the one it fixes — and its expiry is silent by design: the exit code of a
    // process we already force-killed carries no information about the measurement.
    const reap = (fn, value) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return fn(value);
      let done = false;
      const go = () => { if (done) return; done = true; clearTimeout(guard); fn(value); };
      const guard = setTimeout(go, REAP_TIMEOUT_MS);
      child.once('exit', go);
    };

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child && child.pid) {
        try {
          if (process.platform === 'win32') require('child_process').spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false });
          else process.kill(-child.pid, 'SIGKILL');
        } catch { /* already gone */ }
      }
      reap(fn, value);
    };

    const send = (message) => {
      const wire = encodeMessage(message);
      logWire('>>', wire.trimEnd());
      child.stdin.write(wire);
    };
    const request = (method, params) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      send({ id, method, params });
    });
    const handleMessage = (message) => {
      logWire('<<', JSON.stringify(message));
      if (message && Object.prototype.hasOwnProperty.call(message, 'id') && message.method) {
        // inbound server request — reject politely, same as the client does.
        send({ id: message.id, error: { code: -32601, message: 'forge-appserver-probe: inbound request refused' } });
        return;
      }
      if (message && Object.prototype.hasOwnProperty.call(message, 'id')) {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.rej(new Error(message.error.message || `JSON-RPC error ${message.error.code}`));
        else waiter.res(message.result);
      }
    };
    const consumeStdout = () => {
      let index;
      while ((index = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, index);
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        const decoded = decodeLine(line);
        if (decoded.discard !== undefined) {
          if (decoded.discard.trim()) logWire('..', `[discarded] ${decoded.discard}`);
        } else handleMessage(decoded.msg);
      }
    };

    try {
      child = spawn(cmd, [...args, 'app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    } catch (error) {
      reject(Object.assign(new Error(`spawn failed: ${error.message}`), { infra: true }));
      return;
    }
    child.on('error', error => finish(reject, Object.assign(new Error(`spawn failed: ${error.code || error.message}`), { infra: true })));
    // Without this the server dying between thread/start and turn/start raises an
    // unhandled EPIPE from the send() write: no exit 2, no VERDICT line — the two
    // channels the header promises are the only two, so neither may be bypassed.
    // The close/timeout handlers below are what diagnose it (same shape as
    // forge-appserver-client.js:202).
    child.stdin.on('error', () => { /* diagnosed by the close handler or the timeout */ });
    child.stdout.on('data', chunk => { stdoutBuffer += chunk.toString('utf8'); consumeStdout(); });
    child.stderr.on('data', chunk => { stderrTail += chunk.toString('utf8'); });
    child.on('close', (code, signal) => {
      if (!settled) finish(reject, new Error(`app-server exited ${signal ? `by signal ${signal}` : `with code ${code}`} — stderr: ${stderrTail.slice(-2000)}`));
    });

    const timer = setTimeout(() => {
      finish(reject, new Error(`timeout after ${timeoutSecs}s`));
    }, timeoutSecs * 1000);

    (async () => {
      try {
        const initializeResult = await request('initialize', { clientInfo: { name: 'forge-appserver-probe', version: '1' } });
        send({ method: 'initialized', params: {} });
        const threadStartResult = await request('thread/start', threadParams);
        finish(resolve, { initializeResult, threadStartResult });
      } catch (error) {
        if (!settled) finish(reject, error);
      }
    })();
  });
}

/**
 * Full initialize -> initialized -> thread/start -> turn/start -> turn/completed
 * session, for probes a1/a2 which need a real turn.
 *
 * forge-appserver-client's startAppServerTurn takes turnParams as a single
 * static object supplied before the call, but TurnStartParams.threadId is
 * REQUIRED and only known after thread/start replies (confirmed against the
 * pinned schema and against the live server: turn/start without threadId
 * returns "Invalid request: missing field `threadId`"). That is a real gap in
 * the T01 client's shape, not something this probe can paper over without
 * editing forge-appserver-client.js (out of this task's declared writes), so
 * a1/a2 drive the wire directly — reusing only encodeMessage/decodeLine
 * (the framing contract) from the client, exactly as the handshake probe does.
 */
// How long to wait for a force-killed app-server to be reaped before moving on. See
// `reap` below: bounded so the probe can never hang on it.
const REAP_TIMEOUT_MS = 4000;
// Delay before the single retry described in the crossroot arm runner.
const RETRY_DELAY_MS = 1500;

function runProbeSession({ cmd, args, env, timeoutSecs, threadParams, buildTurnParams }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = '';
    let stderrTail = '';
    let nextId = 1;
    let turnComplete = false;
    const pending = new Map();
    const items = [];
    const startedItems = [];
    const notifications = [];
    const inboundRequests = [];
    let child;

    // Kill, then WAIT FOR THE REAP before handing control back.
    //
    // Measured (2026-08-19, two runs of `--probe crossroot-write` against codex
    // 0.146.0 on Windows): the arm that follows another arm died reproducibly with
    // `failed to initialize sqlite state runtime under ~/.codex`. The kill above is
    // `/F` — the OS tears the process down without letting it close its sqlite
    // handles, and the NEXT app-server spawned against the same CODEX_HOME cannot
    // initialize the state runtime while those handles are still held.
    //
    // Resolving before the child is reaped is what turned an ordering detail into a
    // failed measurement: the caller starts the next session immediately. The wait is
    // BOUNDED — a probe that hangs waiting for a corpse would be a worse defect than
    // the one it fixes — and its expiry is silent by design: the exit code of a
    // process we already force-killed carries no information about the measurement.
    const reap = (fn, value) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return fn(value);
      let done = false;
      const go = () => { if (done) return; done = true; clearTimeout(guard); fn(value); };
      const guard = setTimeout(go, REAP_TIMEOUT_MS);
      child.once('exit', go);
    };

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child && child.pid) {
        try {
          if (process.platform === 'win32') require('child_process').spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false });
          else process.kill(-child.pid, 'SIGKILL');
        } catch { /* already gone */ }
      }
      reap(fn, value);
    };

    const send = (message) => {
      const wire = encodeMessage(message);
      logWire('>>', wire.trimEnd());
      child.stdin.write(wire);
    };
    const request = (method, params) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      send({ id, method, params });
    });
    const handleMessage = (message) => {
      logWire('<<', JSON.stringify(message));
      if (message && Object.prototype.hasOwnProperty.call(message, 'id') && message.method) {
        // RECORD BEFORE REFUSING. This handler answers -32601 and returns before the
        // notifications push, so an inbound request never reaches `notifications` —
        // filtering that array for a guessed method name ('approval/request') produced
        // an empty list BY CONSTRUCTION, and S01-PREMISES then reasoned from that
        // silence. Record every inbound request by its actual method, exactly as
        // forge-appserver-client.js already does, and let the caller read the list.
        inboundRequests.push({ id: message.id, method: message.method, params: message.params });
        send({ id: message.id, error: { code: -32601, message: 'forge-appserver-probe: inbound request refused' } });
        return;
      }
      if (message && Object.prototype.hasOwnProperty.call(message, 'id')) {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.rej(new Error(message.error.message || `JSON-RPC error ${message.error.code}`));
        else waiter.res(message.result);
        return;
      }
      if (message && message.method) {
        notifications.push(message);
        if (message.method === 'item/completed') items.push(message.params == null ? message : message.params);
        // An item that starts and never completes is NOT "no item": A4 asks whether
        // the item is emitted at all, and collecting only item/completed renders a
        // started-but-uncompleted command as "nenhum item" — a false negative in the
        // direction that looks conservative, on the class that carries S06.
        if (message.method === 'item/started') startedItems.push(message.params == null ? message : message.params);
        if (message.method === 'turn/completed') turnComplete = true;
      }
    };
    const consumeStdout = () => {
      let index;
      while ((index = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, index);
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        const decoded = decodeLine(line);
        if (decoded.discard !== undefined) {
          if (decoded.discard.trim()) logWire('..', `[discarded] ${decoded.discard}`);
        } else handleMessage(decoded.msg);
      }
    };

    try {
      child = spawn(cmd, [...args, 'app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    } catch (error) {
      reject(Object.assign(new Error(`spawn failed: ${error.message}`), { infra: true }));
      return;
    }
    child.on('error', error => finish(reject, Object.assign(new Error(`spawn failed: ${error.code || error.message}`), { infra: true })));
    // Without this the server dying between thread/start and turn/start raises an
    // unhandled EPIPE from the send() write: no exit 2, no VERDICT line — the two
    // channels the header promises are the only two, so neither may be bypassed.
    // The close/timeout handlers below are what diagnose it (same shape as
    // forge-appserver-client.js:202).
    child.stdin.on('error', () => { /* diagnosed by the close handler or the timeout */ });
    child.stdout.on('data', chunk => { stdoutBuffer += chunk.toString('utf8'); consumeStdout(); });
    child.stderr.on('data', chunk => { stderrTail += chunk.toString('utf8'); });
    child.on('close', (code, signal) => {
      if (!settled) finish(reject, new Error(`app-server exited ${signal ? `by signal ${signal}` : `with code ${code}`} — stderr: ${stderrTail.slice(-2000)}`));
    });

    const timer = setTimeout(() => {
      finish(reject, new Error(`timeout after ${timeoutSecs}s`));
    }, timeoutSecs * 1000);

    (async () => {
      try {
        const initializeResult = await request('initialize', { clientInfo: { name: 'forge-appserver-probe', version: '1' } });
        send({ method: 'initialized', params: {} });
        const threadStartResult = await request('thread/start', threadParams);
        const threadId = threadStartResult && threadStartResult.thread && threadStartResult.thread.id;
        if (!threadId) throw new Error('thread/start result did not include thread.id');
        const turnParams = buildTurnParams(threadId);
        const turnResult = await request('turn/start', turnParams);
        if (!turnComplete) {
          await new Promise((done, failWait) => {
            const watch = setInterval(() => {
              if (settled) { clearInterval(watch); failWait(new Error('session ended before turn completed')); }
              else if (turnComplete) { clearInterval(watch); done(); }
            }, 25);
          });
        }
        finish(resolve, { initializeResult, threadStartResult, turnResult, items, startedItems, notifications, inboundRequests });
      } catch (error) {
        if (!settled) finish(reject, error);
      }
    })();
  });
}

async function probeHandshake({ timeoutSecs }) {
  const { cmd, args, env } = resolveCommand();
  process.stdout.write(`# probe handshake: cmd=${cmd} args=${JSON.stringify(args)} env_keys=${Object.keys(env).sort().join(',')}\n`);
  try {
    const result = await runProbeHandshake({ cmd, args, env, timeoutSecs });
    if (result && result.threadStartResult) {
      printVerdict('handshake', 'provada', 'initialize->initialized->thread/start completou sob buildSidecarEnv(\'minimal\')');
    } else {
      printVerdict('handshake', 'falhou', 'thread/start não retornou resultado');
    }
  } catch (error) {
    if (error.infra) {
      process.stderr.write(`forge-appserver-probe: infra failure — ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    printVerdict('handshake', 'falhou', error.message.replace(/\n/g, ' '));
  }
}

/**
 * A1's schema and prompt, and why they look like this.
 *
 * The first version asked the model to "Reply with exactly the JSON object {"ok": true}
 * and nothing else" while declaring a schema of exactly that shape. Under the very
 * precondition A1 exists to test (openai/codex#15451 — outputSchema silently ignored
 * when MCP/tools are live) the model emits {"ok":true} anyway, BECAUSE THE PROMPT SAID
 * SO. Honored and ignored produced byte-identical output, so the probe could only ever
 * print `provada`. A probe that cannot fail measures nothing.
 *
 * The prompt now asks a plain question whose natural answer is prose, and says nothing
 * about JSON or about any field name. If `outputSchema` is honored the reply is
 * {"answer":4}; if it is ignored the reply is "4" or "2 + 2 = 4" — distinguishable.
 */
const A1_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'integer' } },
  required: ['answer'],
  additionalProperties: false,
};
const A1_PROMPT = 'What is 2 plus 2?';

// Only the final answer counts: the a4-denied trace shows phase:"commentary" messages
// in the same stream, and the old loop took the first parseable agentMessage of any phase.
function finalAnswerTexts(result) {
  return result.items
    .filter(entry => entry && entry.item && entry.item.type === 'agentMessage' && entry.item.phase === 'final_answer')
    .map(entry => entry.item.text)
    .filter(text => typeof text === 'string');
}

// Full schema conformance, not `typeof parsed.answer`: A1_OUTPUT_SCHEMA declares
// additionalProperties:false, so {"answer":4,"note":"…"} is a VIOLATION, and the old
// check passed it.
function conformsToA1Schema(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return false; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const keys = Object.keys(parsed);
  return keys.length === 1 && keys[0] === 'answer' && Number.isInteger(parsed.answer);
}

async function runOneA1Turn({ cmd, args, env, timeoutSecs, withSchema }) {
  const result = await runProbeSession({
    cmd,
    args,
    env,
    timeoutSecs,
    threadParams: { approvalPolicy: 'never' },
    buildTurnParams: (threadId) => {
      const params = { threadId, input: [{ type: 'text', text: A1_PROMPT }] };
      if (withSchema) params.outputSchema = A1_OUTPUT_SCHEMA;
      return params;
    },
  });
  const texts = finalAnswerTexts(result);
  return { result, texts, conforms: texts.some(conformsToA1Schema) };
}

async function probeA1({ timeoutSecs }) {
  const { cmd, args, env } = resolveCommand();
  process.stdout.write(`# probe a1: cmd=${cmd} args=${JSON.stringify(args)} apps/MCP left at default (W2 — never disabled)\n`);
  try {
    process.stdout.write('# --- positive: outputSchema declared on turn/start ---\n');
    const positive = await runOneA1Turn({ cmd, args, env, timeoutSecs, withSchema: true });
    process.stdout.write(`# positive final_answer texts: ${JSON.stringify(positive.texts)} conforms=${positive.conforms}\n`);

    // The negative control is the whole point: same prompt, NO outputSchema. If this
    // turn also returns schema-conforming JSON, then conformance is not evidence that
    // the field was read, and the verdict must say so instead of claiming `provada`.
    process.stdout.write('# --- negative control: same prompt, NO outputSchema ---\n');
    const negative = await runOneA1Turn({ cmd, args, env, timeoutSecs, withSchema: false });
    process.stdout.write(`# negative final_answer texts: ${JSON.stringify(negative.texts)} conforms=${negative.conforms}\n`);

    if (positive.conforms && !negative.conforms) {
      printVerdict('a1', 'provada', `outputSchema honrado — com o schema o item final conforma (${JSON.stringify(positive.texts)}), sem ele não conforma (${JSON.stringify(negative.texts)}); o prompt não pede JSON, então o controle negativo distingue`);
    } else if (!positive.conforms) {
      printVerdict('a1', 'falhou', `outputSchema ignorado — com o schema declarado o item final não conforma: ${JSON.stringify(positive.texts)}`);
    } else {
      printVerdict('a1', 'parcial', `discriminador nulo — o controle negativo (sem outputSchema) também produziu JSON conformante (${JSON.stringify(negative.texts)}), então conformar não prova que o campo foi lido`);
    }
  } catch (error) {
    if (error.infra) {
      process.stderr.write(`forge-appserver-probe: infra failure — ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    printVerdict('a1', 'falhou', error.message.replace(/\n/g, ' '));
  }
}

async function runOneA2Turn({ cmd, args, env, timeoutSecs, networkAccess }) {
  const command = 'curl -sS -m 8 -o /dev/null -w "%{http_code}" https://example.com';
  const result = await runProbeSession({
    cmd,
    args,
    env,
    timeoutSecs,
    threadParams: { approvalPolicy: 'never' },
    buildTurnParams: (threadId) => ({
      threadId,
      input: [{ type: 'text', text: `Run this exact shell command and report its output verbatim: ${command}` }],
      // SandboxPolicy discriminates on `type` (confirmed against the live
      // thread/start response's own `sandbox.type` field), not `mode`.
      sandboxPolicy: networkAccess
        ? { type: 'workspaceWrite', networkAccess: true }
        : { type: 'workspaceWrite', networkAccess: false },
    }),
  });
  // item/completed params wrap the real item under `.item` (same shape confirmed
  // for a1's agentMessage items).
  const commandItems = result.items
    .filter(entry => entry && entry.item && entry.item.type === 'commandExecution')
    .map(entry => entry.item);
  return { result, commandItems };
}

async function probeA2({ timeoutSecs }) {
  const { cmd, args, env } = resolveCommand();
  process.stdout.write(`# probe a2: cmd=${cmd} args=${JSON.stringify(args)} — sandboxPolicy.networkAccess on turn/start params (W3: app-server path only)\n`);
  try {
    process.stdout.write('# --- positive: networkAccess=true on turn ---\n');
    const positive = await runOneA2Turn({ cmd, args, env, timeoutSecs, networkAccess: true });
    process.stdout.write(`# positive commandExecution items: ${JSON.stringify(positive.commandItems)}\n`);

    process.stdout.write('# --- negative control: networkAccess=false on turn ---\n');
    const negative = await runOneA2Turn({ cmd, args, env, timeoutSecs, networkAccess: false });
    process.stdout.write(`# negative commandExecution items: ${JSON.stringify(negative.commandItems)}\n`);

    // Read the structured fields, never a substring of the serialized item. The old
    // discriminator was `JSON.stringify(commandItems).includes('200')`, and that string
    // also carries durationMs: durationMs:1200 is a false positive, durationMs:200 on an
    // otherwise-failed command is another, and exitCode was extracted here and then
    // never asserted on at all.
    const summarize = (side) => side.commandItems.map(item => ({ exitCode: item.exitCode, status: item.status, aggregatedOutput: item.aggregatedOutput }));
    const gotHttp200 = (side) => side.commandItems.some(item => item.exitCode === 0
      && typeof item.aggregatedOutput === 'string' && /(^|\D)200(\D|$)/.test(item.aggregatedOutput));
    const positiveExit = positive.commandItems.map(i => i.exitCode).find(v => v !== undefined);
    const negativeExit = negative.commandItems.map(i => i.exitCode).find(v => v !== undefined);

    if (!positive.commandItems.length || !negative.commandItems.length) {
      printVerdict('a2', 'falhou', `um dos lados não emitiu commandExecution (positivo=${positive.commandItems.length}, negativo=${negative.commandItems.length}) — sem item estruturado não há o que discriminar`);
    } else if (gotHttp200(positive) && !gotHttp200(negative)) {
      printVerdict('a2', 'provada', `networkAccess:true no turn liberou rede (exitCode:0 com 200 em aggregatedOutput), negado sem ele — positivo=${JSON.stringify(summarize(positive))} negativo=${JSON.stringify(summarize(negative))}`);
    } else if (!gotHttp200(positive)) {
      printVerdict('a2', 'falhou', `mesmo com networkAccess:true a rede não retornou 200 com exitCode:0 — positivo=${JSON.stringify(summarize(positive))}`);
    } else {
      printVerdict('a2', 'parcial', `discriminador nulo — o controle negativo também obteve 200 com exitCode:0 (positivo=${positiveExit} negativo=${negativeExit}) — positivo=${JSON.stringify(summarize(positive))} negativo=${JSON.stringify(summarize(negative))}`);
    }
  } catch (error) {
    if (error.infra) {
      process.stderr.write(`forge-appserver-probe: infra failure — ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    printVerdict('a2', 'falhou', error.message.replace(/\n/g, ' '));
  }
}

/* ------------------------------------------------------------------ S03 ---
 * Capability probes use the same real-wire fixture as A2 but split its two
 * network policies into individually pasteable measurements.  `readonly` has
 * an intentionally different criterion: A4 established that a sandbox denial
 * may emit no commandExecution item, therefore absence of a write effect is
 * the declared B3 observation and the item census remains evidence, not an
 * invented failure condition.
 */
// The curl arms print `%{http_code}`, so a 200 in aggregatedOutput WITH exitCode:0 is
// the only reading that means "the request completed". The sibling A2 arm was hardened
// to require exactly this (`gotHttp200`) after `.includes('200')` proved to match
// durationMs:1200; the capability arms kept the loose "any exitCode:0" and would call a
// turn `provada` on any command that merely exited cleanly (S03 review R1). One
// definition, used by both, so they cannot drift apart again.
function hasHttp200(commandItems) {
  return commandItems.some(item => item.exitCode === 0
    && typeof item.aggregatedOutput === 'string' && /(^|\D)200(\D|$)/.test(item.aggregatedOutput));
}

// `cwd` and `threadSandbox` are optional and default to absent, so every existing
// caller keeps byte-identical thread/start params. They exist for the M2 write probe,
// whose whole question is what the SERVER does with a cwd it cannot see git in.
async function runCapabilityTurn({ timeoutSecs, sandboxPolicy, command, cwd, threadSandbox }) {
  const { cmd, args, env } = resolveCommand();
  const threadParams = { approvalPolicy: 'never' };
  if (cwd !== undefined) threadParams.cwd = cwd;
  if (threadSandbox !== undefined) threadParams.sandbox = threadSandbox;
  const result = await runProbeSession({
    cmd,
    args,
    env,
    timeoutSecs,
    threadParams,
    buildTurnParams: (threadId) => ({
      threadId,
      input: [{ type: 'text', text: `Run this exact shell command and report its output verbatim: ${command}` }],
      sandboxPolicy,
    }),
  });
  const pickCommands = (entries) => entries
    .filter(entry => entry && entry.item && entry.item.type === 'commandExecution')
    .map(entry => entry.item);
  const commandItems = pickCommands(result.items);
  // A4 asks whether the item is EMITTED, and this file already encodes that lesson
  // twice (runProbeSession, runOneA4Turn). These probes read only completed items, so
  // a started-and-never-completed command rendered as "nenhum item" — which is the
  // SAME rendering as the class-(c) denial the readonly verdict is built on
  // (S03 review R3).
  const completedIds = new Set(commandItems.map(item => item.id));
  const startedOnly = pickCommands(result.startedItems || []).filter(item => !completedIds.has(item.id));
  return { result, commandItems, startedOnly };
}

async function probeCapNetworked({ timeoutSecs }) {
  const command = 'curl -sS -m 8 -o /dev/null -w "%{http_code}" https://example.com';
  process.stdout.write(`# probe cap-networked: ${command} — sandboxPolicy={type:workspaceWrite,networkAccess:true}\n`);
  try {
    const { commandItems, startedOnly } = await runCapabilityTurn({
      timeoutSecs, command, sandboxPolicy: { type: 'workspaceWrite', networkAccess: true },
    });
    process.stdout.write(`# commandExecution items: ${JSON.stringify(commandItems)}\n`);
    process.stdout.write(`# commandExecution started-without-completion: ${JSON.stringify(startedOnly)}\n`);
    if (hasHttp200(commandItems)) {
      printVerdict('cap-networked', 'provada', `curl em policy networked retornou 200 com exitCode:0: ${JSON.stringify(commandItems)}`);
    } else {
      printVerdict('cap-networked', 'falhou', `nenhum commandExecution com exitCode:0 E 200 em aggregatedOutput: ${JSON.stringify(commandItems)} started-only=${JSON.stringify(startedOnly)}`);
    }
  } catch (error) {
    if (error.infra) { process.stderr.write(`forge-appserver-probe: infra failure — ${error.message}\n`); process.exitCode = 2; return; }
    printVerdict('cap-networked', 'falhou', error.message.replace(/\n/g, ' '));
  }
}

async function probeCapWorkspace({ timeoutSecs }) {
  const command = 'curl -sS -m 8 -o /dev/null -w "%{http_code}" https://example.com';
  process.stdout.write(`# probe cap-workspace: ${command} — sandboxPolicy={type:workspaceWrite,networkAccess:false}\n`);
  try {
    const { commandItems, startedOnly } = await runCapabilityTurn({
      timeoutSecs, command, sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });
    process.stdout.write(`# commandExecution items: ${JSON.stringify(commandItems)}\n`);
    process.stdout.write(`# commandExecution started-without-completion: ${JSON.stringify(startedOnly)}\n`);
    const denied = commandItems.some(item => item.exitCode === 6
      || /Could not resolve host/i.test(String(item.aggregatedOutput || '')));
    // A denial claim requires that NO arm of this turn actually reached the network:
    // "one item looks denied" alongside a successful 200 is not a denial (R1).
    if (denied && !hasHttp200(commandItems)) {
      printVerdict('cap-workspace', 'provada', `rede negada como classe (b): exitCode:6 ou Could not resolve host, e nenhum 200 com exitCode:0: ${JSON.stringify(commandItems)}`);
    } else if (denied) {
      printVerdict('cap-workspace', 'inconclusiva', `sinal de negação convive com um 200/exitCode:0 no MESMO turn — a negação não está isolada: ${JSON.stringify(commandItems)}`);
    } else {
      printVerdict('cap-workspace', 'falhou', `não observou a negação de rede classe (b): ${JSON.stringify(commandItems)} started-only=${JSON.stringify(startedOnly)}`);
    }
  } catch (error) {
    if (error.infra) { process.stderr.write(`forge-appserver-probe: infra failure — ${error.message}\n`); process.exitCode = 2; return; }
    printVerdict('cap-workspace', 'falhou', error.message.replace(/\n/g, ' '));
  }
}

async function probeCapReadonly({ timeoutSecs }) {
  const fs = require('fs');
  const path = require('path');
  const target = path.join(process.cwd(), `forge-cap-readonly-probe-${process.pid}-${Date.now()}`);
  const command = `touch ${shellQuote(target)}`;
  // Label CAP-RO, not B3: B3 is already taken by the model-precedence block below
  // (B3_MODEL_A / B3_VERDICTS) — two premises under one label in one file (R5).
  process.stdout.write(`# probe cap-readonly: ${command} — sandboxPolicy={type:readOnly,networkAccess:false}; critério CAP-RO declarado: alvo ausente pós-turn + braço de controle permissivo + censo commandExecution (A4 classe c)\n`);
  try {
    const { commandItems, startedOnly } = await runCapabilityTurn({
      timeoutSecs, command, sandboxPolicy: { type: 'readOnly', networkAccess: false },
    });
    const exists = fs.existsSync(target);
    process.stdout.write(`# commandExecution items: ${commandItems.length} ${JSON.stringify(commandItems)}\n`);
    process.stdout.write(`# commandExecution started-without-completion: ${JSON.stringify(startedOnly)}\n`);
    process.stdout.write(`# readonly target exists after turn: ${exists}\n`);
    if (exists) {
      printVerdict('cap-readonly', 'falhou', `arquivo-alvo existe pós-turn apesar de readOnly; commandExecution items: ${commandItems.length}`);
    } else if (commandItems.length === 0 && startedOnly.length === 0) {
      // "Ausente + nenhum item" é byte-idêntico entre "readOnly negou a escrita" e "o
      // modelo nunca tentou escrever". Sem braço de controle permissivo isso é uma
      // premissa se auto-provando — exatamente o que a4-denied ganhou depois da
      // patologia da TASK-020 (S03 review R2). MESMO comando, policy permissiva.
      let controlExists;
      let controlError;
      try {
        const control = await runCapabilityTurn({
          timeoutSecs, command, sandboxPolicy: { type: 'dangerFullAccess' },
        });
        controlExists = fs.existsSync(target);
        process.stdout.write(`# CONTROL (dangerFullAccess) items: ${JSON.stringify(control.commandItems)} target exists: ${controlExists}\n`);
      } catch (error) {
        controlError = error.message.replace(/\n/g, ' ');
        process.stdout.write(`# CONTROL NÃO MEDIDO: ${controlError}\n`);
      }
      if (controlExists === true) {
        printVerdict('cap-readonly', 'provada', 'os dois braços diferem: readOnly não produziu o arquivo, o controle dangerFullAccess produziu com o MESMO comando — a causa é a política do sandbox');
      } else {
        printVerdict('cap-readonly', 'inconclusiva', `arquivo ausente nos DOIS braços${controlError ? ` (controle não medido: ${controlError})` : ''} — "readOnly negou" é indistinguível de "o modelo nunca tentou"; nenhum commandExecution emitido (A4 classe c)`);
      }
    } else {
      printVerdict('cap-readonly', 'provada', `arquivo ausente pós-turn com comando emitido; commandExecution items: ${commandItems.length}, started-only: ${startedOnly.length} (evidência adicional A4 registrada)`);
    }
  } catch (error) {
    if (error.infra) { process.stderr.write(`forge-appserver-probe: infra failure — ${error.message}\n`); process.exitCode = 2; return; }
    printVerdict('cap-readonly', 'falhou', error.message.replace(/\n/g, ' '));
  } finally {
    // A successful unexpected write is evidence above, but leave no probe litter.
    try { if (fs.existsSync(target)) fs.unlinkSync(target); } catch { /* diagnostic already printed */ }
  }
}

/**
 * A4 probes — three classes of command under approvalPolicy:"never", each
 * driving exactly one command via a real turn (W1 — the happy path alone
 * proves nothing; the DENIED class is the one that decides A4).
 */
async function runOneA4Turn({ cmd, args, env, timeoutSecs, promptText, sandboxPolicy }) {
  const result = await runProbeSession({
    cmd,
    args,
    env,
    timeoutSecs,
    threadParams: { approvalPolicy: 'never' },
    buildTurnParams: (threadId) => ({
      threadId,
      input: [{ type: 'text', text: promptText }],
      sandboxPolicy: sandboxPolicy || { type: 'workspaceWrite', networkAccess: false },
    }),
  });
  const pickCommands = (entries) => entries
    .filter(entry => entry && entry.item && entry.item.type === 'commandExecution')
    .map(entry => entry.item);
  const commandItems = pickCommands(result.items);
  // A4 asks whether the item is EMITTED. item/started is an emission; collecting only
  // item/completed renders a started-and-never-completed command as "nenhum item",
  // which is the same rendering as the class-(c) denial that carries S06's decision.
  const completedIds = new Set(commandItems.map(item => item.id));
  const startedOnly = pickCommands(result.startedItems).filter(item => !completedIds.has(item.id));
  // Any inbound server->client request seen mid-turn despite approvalPolicy:"never"
  // (issue #21982 [WEB]) — observation only, never a verdict. Recorded by runProbeSession
  // at the point of refusal, under whatever method the server actually used; the old
  // filter guessed the name 'approval/request' against an array these never reach.
  return { result, commandItems, startedOnly, inboundRequests: result.inboundRequests };
}

// The three A4 classes share one rendering of "no completed commandExecution", so the
// started-but-uncompleted case cannot be lost in one of them and named in another.
function reportA4Emission(name, commandItems, startedOnly) {
  if (startedOnly.length) {
    printVerdict(name, 'parcial', `commandExecution foi iniciado mas nunca completou (${startedOnly.length} item(ns) com item/started sem item/completed) — o item é emitido, mas sem exitCode observável: ${JSON.stringify(startedOnly)}`);
  } else {
    printVerdict(name, 'falhou', 'nenhum item commandExecution emitido (nem item/started nem item/completed) — turn calou ou estagnou sem sinalizar');
  }
}

async function runProbeA4Ok({ timeoutSecs }) {
  const { cmd, args, env } = resolveCommand();
  process.stdout.write('# probe a4-ok: /bin/echo forge-a4-ok — expect commandExecution exitCode:0\n');
  try {
    const { commandItems, startedOnly, inboundRequests } = await runOneA4Turn({
      cmd, args, env, timeoutSecs,
      promptText: 'Run this exact shell command and report its output verbatim: /bin/echo forge-a4-ok',
    });
    process.stdout.write(`# commandExecution items: ${JSON.stringify(commandItems)}\n`);
    process.stdout.write(`# commandExecution started-without-completion: ${JSON.stringify(startedOnly)}\n`);
    process.stdout.write(`# inbound server requests despite approvalPolicy:never — ${inboundRequests.length} recebida(s): ${JSON.stringify(inboundRequests)}\n`);
    const exitCode = commandItems.map(i => i.exitCode).find(v => v !== undefined);
    if (commandItems.length && exitCode === 0) {
      printVerdict('a4-ok', 'provada', `commandExecution emitido com exitCode:0 (${commandItems.length} item(ns))`);
    } else if (commandItems.length) {
      printVerdict('a4-ok', 'parcial', `commandExecution emitido mas exitCode inesperado: ${exitCode}`);
    } else {
      reportA4Emission('a4-ok', commandItems, startedOnly);
    }
  } catch (error) {
    if (error.infra) {
      process.stderr.write(`forge-appserver-probe: infra failure — ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    printVerdict('a4-ok', 'falhou', error.message.replace(/\n/g, ' '));
  }
}

async function runProbeA4Fail({ timeoutSecs }) {
  const { cmd, args, env } = resolveCommand();
  process.stdout.write("# probe a4-fail: sh -c 'exit 7' — expect commandExecution exitCode:7 (runs and fails, not denied)\n");
  try {
    const { commandItems, startedOnly, inboundRequests } = await runOneA4Turn({
      cmd, args, env, timeoutSecs,
      promptText: "Run this exact shell command and report its output verbatim: sh -c 'exit 7'",
    });
    process.stdout.write(`# commandExecution items: ${JSON.stringify(commandItems)}\n`);
    process.stdout.write(`# commandExecution started-without-completion: ${JSON.stringify(startedOnly)}\n`);
    process.stdout.write(`# inbound server requests despite approvalPolicy:never — ${inboundRequests.length} recebida(s): ${JSON.stringify(inboundRequests)}\n`);
    const exitCode = commandItems.map(i => i.exitCode).find(v => v !== undefined);
    if (commandItems.length && exitCode === 7) {
      printVerdict('a4-fail', 'provada', `commandExecution emitido com exitCode:7 (roda e falha, não é negação)`);
    } else if (commandItems.length) {
      printVerdict('a4-fail', 'parcial', `commandExecution emitido mas exitCode inesperado: ${exitCode}`);
    } else {
      reportA4Emission('a4-fail', commandItems, startedOnly);
    }
  } catch (error) {
    if (error.infra) {
      process.stderr.write(`forge-appserver-probe: infra failure — ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    printVerdict('a4-fail', 'falhou', error.message.replace(/\n/g, ' '));
  }
}

async function runProbeA4Denied({ timeoutSecs }) {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { cmd, args, env } = resolveCommand();
  // The target must be a path the CURRENT USER owns and could write with no sandbox at
  // all. `/usr/local` (the previous target) is root-owned on stock macOS, so `touch`
  // there fails EACCES for a normal user without any sandbox — a non-zero exit code
  // there proves nothing about the denial class. This is the TASK-020 pathology
  // (attribution without discrimination) and it is what the control arm below exists
  // to prevent: only a DIFFERENCE between the two arms names `sandbox-exec-blocked`.
  const target = path.join(os.homedir(), 'forge-a4-denied-probe');
  const promptText = `Run this exact shell command and report its output verbatim: touch ${target}`;
  process.stdout.write(`# probe a4-denied: touch ${target} (fora das writable roots, dono = usuário atual) — arm A sob workspaceWrite, arm B (controle) sob dangerFullAccess\n`);
  try {
    const { commandItems, startedOnly, inboundRequests } = await runOneA4Turn({
      cmd, args, env, timeoutSecs, promptText,
    });
    process.stdout.write(`# commandExecution items: ${JSON.stringify(commandItems)}\n`);
    process.stdout.write(`# commandExecution started-without-completion: ${JSON.stringify(startedOnly)}\n`);
    process.stdout.write(`# inbound server requests despite approvalPolicy:never (issue #21982) — ${inboundRequests.length} recebida(s): ${JSON.stringify(inboundRequests)}\n`);
    const exitCode = commandItems.map(i => i.exitCode).find(v => v !== undefined);
    if (commandItems.length && exitCode !== undefined && exitCode !== 0) {
      // Control arm: SAME command, permissive policy. Without it, "exit != 0" is
      // consistent with a plain filesystem error and the verdict would be a guess.
      let controlExit;
      let controlError;
      try {
        const control = await runOneA4Turn({
          cmd, args, env, timeoutSecs, promptText,
          sandboxPolicy: { type: 'dangerFullAccess' },
        });
        process.stdout.write(`# CONTROL (dangerFullAccess) commandExecution items: ${JSON.stringify(control.commandItems)}\n`);
        controlExit = control.commandItems.map(i => i.exitCode).find(v => v !== undefined);
      } catch (error) {
        controlError = error.message.replace(/\n/g, ' ');
        process.stdout.write(`# CONTROL NÃO MEDIDO: ${controlError}\n`);
      } finally {
        // The control arm, if it works, really creates the file — remove it rather
        // than leaving probe droppings in the operator's home.
        try { fs.rmSync(target, { force: true }); } catch { /* best effort */ }
      }
      if (controlExit === 0) {
        printVerdict('a4-denied', 'provada', `os dois braços diferem: workspaceWrite exitCode:${exitCode}, controle dangerFullAccess exitCode:0 no MESMO comando — a causa é a política do sandbox, sandbox-exec-blocked observável`);
      } else if (controlExit === undefined) {
        printVerdict('a4-denied', 'inconclusiva', `comando falhou (exitCode:${exitCode}) mas o controle não foi medido${controlError ? ` (${controlError})` : ' (nenhum commandExecution no braço de controle)'} — a causa NÃO está isolada; este exit code não distingue negação de sandbox de erro comum de filesystem`);
      } else {
        printVerdict('a4-denied', 'inconclusiva', `comando falhou nos DOIS braços (workspaceWrite exitCode:${exitCode}, dangerFullAccess exitCode:${controlExit}) — a causa NÃO está isolada e não pode ser atribuída ao sandbox`);
      }
    } else if (commandItems.length) {
      printVerdict('a4-denied', 'parcial', `commandExecution emitido mas exitCode não indica negação: ${exitCode}`);
    } else {
      reportA4Emission('a4-denied', commandItems, startedOnly);
    }
  } catch (error) {
    if (error.infra) {
      process.stderr.write(`forge-appserver-probe: infra failure — ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    printVerdict('a4-denied', 'falhou', error.message.replace(/\n/g, ' '));
  }
}

/* ------------------------------------------------------------------ B3 ---
 * Where does `model` have to be set: `thread/start`, `turn/start`, or both?
 *
 * The one thing these probes may NOT do is assert on the field they just sent.
 * Echoing back a request parameter proves the probe can fill in a struct; it says
 * nothing about which model produced the turn. So every verdict below is read from
 * the SERVER's own messages, and each read-back is tagged with the surface it came
 * from and whether that surface is thread-scoped or turn-scoped.
 *
 * That distinction is the whole measurement. `thread/start`'s result already echoes
 * `model` (S01 saw `"model":"gpt-5.6-sol"` there), so a conflict probe that accepted
 * that field as evidence would print `thread-wins` in BOTH worlds — the R3 failure
 * of S01, repeated. Only a turn-scoped surface can distinguish them, and if no such
 * surface exists the honest verdict is `indistinguishable`, named as such.
 *
 * Model ids: both are non-default (the CLI default observed in S01 is `gpt-5.6-sol`),
 * so a turn that silently fell back to the default is distinguishable from BOTH
 * arms — the exact class of bug D12 says B3 exists to prevent.
 */
const B3_MODEL_A = 'gpt-5.6-terra';
const B3_MODEL_B = 'gpt-5.6-luna';
const B3_DEFAULT_MODEL = 'gpt-5.6-sol'; // observed default (S01 W5 trace); never sent by these probes
const B3_PROMPT = 'What is 2 plus 2?';
const B3_VERDICTS = ['thread-wins', 'turn-wins', 'indistinguishable'];

// Walk every value, not a guessed set of paths: the point is to find `model`
// WHEREVER the server chose to put it, including places this probe does not know
// about yet. A hardcoded path list would render "field moved in 0.145" as
// "no read-back surface exists".
function collectModelFields(node, path, out) {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((value, index) => collectModelFields(value, `${path}[${index}]`, out));
    return out;
  }
  for (const key of Object.keys(node)) {
    const value = node[key];
    const next = path ? `${path}.${key}` : key;
    if (key === 'model' && typeof value === 'string') out.push({ path: next, model: value });
    else collectModelFields(value, next, out);
  }
  return out;
}

// Scope by the message that carried the field. `turn/*` and `item/*` are produced by
// the turn; `thread/*` and the thread/start result describe the thread's configuration
// and would report our own thread param back to us.
function scopeOfSurface(surface) {
  if (/^turn\//.test(surface) || /^item\//.test(surface)) return 'turn';
  if (/^thread\//.test(surface)) return 'thread';
  return 'other';
}

function collectModelReadbacks(result) {
  const surfaces = [
    { surface: 'initialize.result', node: result.initializeResult },
    { surface: 'thread/start.result', node: result.threadStartResult },
    { surface: 'turn/start.result', node: result.turnResult },
  ];
  for (const notification of result.notifications || []) {
    surfaces.push({ surface: `${notification.method}.params`, node: notification.params });
  }
  const readbacks = [];
  for (const entry of surfaces) {
    for (const hit of collectModelFields(entry.node, '', [])) {
      readbacks.push({ surface: entry.surface, scope: scopeOfSurface(entry.surface), path: hit.path, model: hit.model });
    }
  }
  return readbacks;
}

function reportReadbacks(readbacks) {
  process.stdout.write(`# model read-backs (${readbacks.length}): ${JSON.stringify(readbacks)}\n`);
  const turnScoped = readbacks.filter(entry => entry.scope === 'turn');
  process.stdout.write(`# turn-scoped read-backs (${turnScoped.length}): ${JSON.stringify(turnScoped)}\n`);
  return turnScoped;
}

async function runB3Turn({ cmd, args, env, timeoutSecs, threadModel, turnModel }) {
  const threadParams = { approvalPolicy: 'never' };
  if (threadModel) threadParams.model = threadModel;
  return runProbeSession({
    cmd,
    args,
    env,
    timeoutSecs,
    threadParams,
    buildTurnParams: (threadId) => {
      const params = {
        threadId,
        input: [{ type: 'text', text: B3_PROMPT }],
        // Same posture as S02 decision 8; the sandbox is not what B3 measures, but
        // leaving it implicit would let a policy change perturb the model probe.
        sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      };
      if (turnModel) params.model = turnModel;
      return params;
    },
  });
}

// The control arms. These do not decide B3 — they establish whether ANY turn-scoped
// surface reports a model at all, which is the precondition for the conflict arm to
// be able to distinguish its two worlds.
async function runB3Control(name, { timeoutSecs, threadModel, turnModel }) {
  const { cmd, args, env } = resolveCommand();
  process.stdout.write(`# probe ${name}: thread.model=${JSON.stringify(threadModel)} turn.model=${JSON.stringify(turnModel)} (CLI default is ${B3_DEFAULT_MODEL}, sent by neither)\n`);
  try {
    const result = await runB3Turn({ cmd, args, env, timeoutSecs, threadModel, turnModel });
    const readbacks = collectModelReadbacks(result);
    const turnScoped = reportReadbacks(readbacks);
    const sent = threadModel || turnModel;
    if (!readbacks.length) {
      printVerdict(name, 'no-readback', 'nenhuma superfície do servidor reportou um campo `model` — nada foi lido de volta');
    } else if (turnScoped.length) {
      printVerdict(name, 'readback-turn-scoped', `superfície turn-scoped reporta model=${JSON.stringify(turnScoped.map(e => e.model))} (enviado: ${sent}) — ${JSON.stringify(turnScoped.map(e => `${e.surface}:${e.path}`))}`);
    } else {
      printVerdict(name, 'readback-thread-scoped-only', `só superfícies thread-scoped reportam model=${JSON.stringify(readbacks.map(e => e.model))} (enviado: ${sent}); nenhuma superfície do turn reporta modelo — ${JSON.stringify(readbacks.map(e => `${e.surface}:${e.path}`))}`);
    }
  } catch (error) {
    // The turn did not complete, so nothing was measured. This is NOT a verdict and
    // must never be shaped like one — a "not measured" line that reads like a result
    // is exactly what gets pasted into an artifact as evidence.
    process.stdout.write(`# NOT MEASURED (${name}): ${error.message.replace(/\n/g, ' ')}\n`);
    process.stderr.write(`forge-appserver-probe: ${name} did not complete — ${error.message}\n`);
    process.exitCode = 2;
  }
}

async function probeModelConflict({ timeoutSecs }) {
  const { cmd, args, env } = resolveCommand();
  process.stdout.write(`# probe model-conflict: thread.model=${B3_MODEL_A} turn.model=${B3_MODEL_B} (distintos entre si e do default ${B3_DEFAULT_MODEL})\n`);
  process.stdout.write(`# verdict enum: ${B3_VERDICTS.join(' | ')} — decidido SÓ por superfície turn-scoped; o eco de thread/start.result é o próprio parâmetro que mandamos e não vale como leitura\n`);
  let result;
  try {
    result = await runB3Turn({ cmd, args, env, timeoutSecs, threadModel: B3_MODEL_A, turnModel: B3_MODEL_B });
  } catch (error) {
    // A rejected model id is a result the artifact must carry, but it is not a B3
    // verdict: with no completed turn there is nothing to read back from.
    process.stdout.write(`# NOT MEASURED (model-conflict): ${error.message.replace(/\n/g, ' ')}\n`);
    process.stderr.write(`forge-appserver-probe: model-conflict did not complete — ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  const readbacks = collectModelReadbacks(result);
  const turnScoped = reportReadbacks(readbacks);
  const models = new Set(turnScoped.map(entry => entry.model));
  if (!turnScoped.length) {
    printVerdict('model-conflict', 'indistinguishable',
      `nenhuma superfície turn-scoped reporta \`model\` — os dois mundos (thread vence / turn vence) produzem leituras idênticas, logo a precedência não é observável neste protocolo. Read-backs disponíveis (todos thread/other-scoped, portanto eco do que enviamos): ${JSON.stringify(readbacks)}`);
  } else if (models.has(B3_MODEL_B) && !models.has(B3_MODEL_A)) {
    printVerdict('model-conflict', 'turn-wins',
      `superfície turn-scoped reporta ${B3_MODEL_B} (o model do turn/start), não ${B3_MODEL_A} (o do thread/start): ${JSON.stringify(turnScoped)}`);
  } else if (models.has(B3_MODEL_A) && !models.has(B3_MODEL_B)) {
    printVerdict('model-conflict', 'thread-wins',
      `superfície turn-scoped reporta ${B3_MODEL_A} (o model do thread/start), não ${B3_MODEL_B} (o do turn/start): ${JSON.stringify(turnScoped)}`);
  } else {
    // Both present, or neither (e.g. the default) — the read-back exists but does not
    // decide. Saying "thread-wins" here would be a verdict by construction.
    printVerdict('model-conflict', 'indistinguishable',
      `a superfície turn-scoped existe mas não decide: reporta ${JSON.stringify([...models])} — nem só ${B3_MODEL_A} nem só ${B3_MODEL_B}. Detalhe: ${JSON.stringify(turnScoped)}`);
  }
}

/* ------------------------------------------------------------------ M2 ---
 * Does the app-server accept a cwd that is not a git repository?
 *
 * `runExecute` today reaches SVN working copies through `codex exec
 * --skip-git-repo-check`. If the app-server refuses a non-git cwd, that support
 * disappears with the transport swap, and the consequence has to be written down
 * rather than discovered by an SVN user.
 */
async function probeNonGitCwd({ timeoutSecs }) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { cmd, args, env } = resolveCommand();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-nongit-cwd-'));
  // Assert the precondition instead of assuming it: a tmpdir that turned out to be
  // inside a git repo would make `works` meaningless.
  const hasGit = fs.existsSync(path.join(dir, '.git'));
  process.stdout.write(`# probe nongit-cwd: cwd=${dir} .git present=${hasGit} (must be false for this probe to mean anything)\n`);
  if (hasGit) {
    process.stderr.write('forge-appserver-probe: nongit-cwd precondition failed — tmpdir contains .git\n');
    process.exitCode = 2;
    return;
  }
  // Disconfounding control, zero inference cost (handshake only — `sandbox` is already
  // in the thread/start result). The non-git thread comes up read-only; without this
  // control we could not tell whether that is caused by the cwd NOT BEING A GIT REPO or
  // merely by passing an explicit `cwd` at all. Same params, same field, git cwd.
  // Verify the control's precondition instead of asserting it in the label: launched
  // from a non-git directory BOTH arms are non-git, and a line that still reads "IS a
  // git repo" is a printed lie about a comparison that never discriminated anything.
  const gitCheck = require('child_process').spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const controlIsGit = gitCheck.status === 0 && String(gitCheck.stdout).trim() === 'true';
  let controlMeasured = false;
  if (!controlIsGit) {
    process.stdout.write(`# CONTROL NOT MEASURED: process.cwd()=${process.cwd()} não é um repositório git (git rev-parse --is-inside-work-tree != true) — sem braço de controle o veredito fica confundido entre "cwd não-git" e "cwd explícito"\n`);
  } else {
    try {
      const control = await runProbeHandshake({
        cmd, args, env, timeoutSecs,
        threadParams: { approvalPolicy: 'never', cwd: process.cwd() },
      });
      const controlThread = control.threadStartResult || {};
      controlMeasured = true;
      process.stdout.write(`# CONTROL (explicit cwd that IS a git repo: ${process.cwd()}): sandbox=${JSON.stringify(controlThread.sandbox)} permissionProfile=${JSON.stringify(controlThread.activePermissionProfile)}\n`);
    } catch (error) {
      process.stdout.write(`# CONTROL NOT MEASURED: ${error.message.replace(/\n/g, ' ')} — o veredito abaixo fica confundido entre "cwd não-git" e "cwd explícito"\n`);
    }
  }
  const controlNote = controlMeasured
    ? 'CONTROL medido (cwd git explícito)'
    : 'CONTROL NÃO MEDIDO — a comparação sandbox/permissionProfile não discrimina "cwd não-git" de "cwd explícito"';
  try {
    const result = await runProbeSession({
      cmd,
      args,
      env,
      timeoutSecs,
      threadParams: { approvalPolicy: 'never', cwd: dir },
      buildTurnParams: (threadId) => ({
        threadId,
        input: [{ type: 'text', text: B3_PROMPT }],
        sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      }),
    });
    const threadResult = result.threadStartResult || {};
    const echoedCwd = threadResult.thread ? threadResult.thread.cwd : undefined;
    process.stdout.write(`# thread.cwd echoed by server: ${JSON.stringify(echoedCwd)}\n`);
    // `works` is about acceptance, and acceptance is not capability. The sandbox the
    // server chose for this thread is printed next to the verdict so that a downgrade
    // cannot hide behind a green line.
    process.stdout.write(`# NON-GIT thread sandbox=${JSON.stringify(threadResult.sandbox)} permissionProfile=${JSON.stringify(threadResult.activePermissionProfile)} (compare with the CONTROL line above)\n`);
    printVerdict('nongit-cwd', 'works',
      `handshake + turn completaram com cwd fora de repositório git (thread.cwd=${JSON.stringify(echoedCwd)}); nenhum erro de git-repo-check foi emitido. ATENÇÃO: aceitar não é poder escrever — veja a linha NON-GIT thread sandbox acima contra o CONTROL. ${controlNote}`);
  } catch (error) {
    const message = error.message.replace(/\n/g, ' ');
    printVerdict('nongit-cwd', 'refused', `a sessão não completou com cwd não-git: ${message}. ${controlNote}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* --------------------------------------------------------------- S04/T04 ---
 * evidence-runtime: the measurement the whole S04 slice rests on.
 *
 * IN-4 asks for a line of evidence whose `exit_code` was OBSERVED IN THE EVENT
 * STREAM rather than inferred from the working tree afterwards. The declared
 * exit code is deliberately 7, not 0: a zero is the value a defaulting bug
 * produces for free, so a green built on it could not distinguish "read from
 * the stream" from "nobody read anything". Seven can only come from the process
 * the runtime actually ran.
 *
 * The items are then classified through the REAL forge-evidence-admit, so what
 * this probe prints is the same evidence the orchestrator would materialize —
 * not a parallel reimplementation that could agree with itself while the
 * production path disagreed.
 */
const EVIDENCE_EXPECTED_EXIT = 7;

async function probeEvidenceRuntime({ timeoutSecs }) {
  const command = `sh -c 'echo forge-evidence-runtime-probe; exit ${EVIDENCE_EXPECTED_EXIT}'`;
  process.stdout.write(`# probe evidence-runtime: ${command} — sandboxPolicy={type:workspaceWrite,networkAccess:false}; `
    + `critério: >=1 commandExecution com exitCode NUMÉRICO vindo do stream (esperado ${EVIDENCE_EXPECTED_EXIT}) + censo por tipo\n`);
  try {
    const { result, commandItems, startedOnly } = await runCapabilityTurn({
      timeoutSecs, command, sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });

    // Census by variant name over EVERY item/completed of the turn — not just the
    // commandExecution ones. "Which types arrived" is the number that tells a
    // reader whether a turn that produced no evidence was empty or merely full of
    // prose; printing only the admissible ones would hide exactly that.
    const items = result.items.map((entry) => (entry && entry.item ? entry.item : entry));
    const typesSeen = {};
    for (const item of items) {
      const name = item && typeof item.type === 'string' ? item.type : '<missing>';
      typesSeen[name] = (typesSeen[name] || 0) + 1;
    }

    const { buildRuntimeEvidence } = require('./forge-evidence-admit');
    const evidence = buildRuntimeEvidence(items, { unit: 'probe/evidence-runtime', turnStatus: 'completed' });

    process.stdout.write(`# items_received: ${items.length}\n`);
    process.stdout.write(`# types_seen: ${JSON.stringify(typesSeen)}\n`);
    process.stdout.write(`# commandExecution items: ${JSON.stringify(commandItems)}\n`);
    process.stdout.write(`# commandExecution started-without-completion: ${JSON.stringify(startedOnly)}\n`);
    process.stdout.write(`# census: ${JSON.stringify(evidence.census)}\n`);
    process.stdout.write(`# entries: ${JSON.stringify(evidence.entries)}\n`);

    const observedExits = commandItems
      .map((item) => item.exitCode)
      .filter((value) => typeof value === 'number');
    const entryExits = evidence.entries
      .filter((entry) => entry.kind === 'command')
      .map((entry) => entry.exit_code);

    if (commandItems.length === 0) {
      // Absence of the item is NOT a measured zero. Saying anything about
      // exit_code here would be the inference this probe exists to replace.
      printVerdict('evidence-runtime', 'falhou',
        `nenhum commandExecution completou (started-only=${startedOnly.length}); sem item estruturado o exit_code não foi medido — types_seen=${JSON.stringify(typesSeen)}`);
    } else if (observedExits.includes(EVIDENCE_EXPECTED_EXIT) && entryExits.includes(EVIDENCE_EXPECTED_EXIT)) {
      printVerdict('evidence-runtime', 'provada',
        `exit_code ${EVIDENCE_EXPECTED_EXIT} lido do stream de item/completed e carregado para a entry runtime `
        + `(census.admitted=${evidence.census.admitted}, items_received=${evidence.census.items_received}, `
        + `types_seen=${JSON.stringify(typesSeen)}); entries=${JSON.stringify(evidence.entries)}`);
    } else if (observedExits.length > 0) {
      printVerdict('evidence-runtime', 'parcial',
        `o stream trouxe exitCode numérico (${JSON.stringify(observedExits)}) mas não o ${EVIDENCE_EXPECTED_EXIT} declarado — `
        + `o comando executado divergiu do pedido; entries=${JSON.stringify(entryExits)}`);
    } else {
      printVerdict('evidence-runtime', 'falhou',
        `commandExecution presente porém sem exitCode numérico: ${JSON.stringify(commandItems)}`);
    }
  } catch (error) {
    if (error.infra) {
      process.stderr.write(`forge-appserver-probe: infra failure — ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    printVerdict('evidence-runtime', 'falhou', error.message.replace(/\n/g, ' '));
  }
}

/* --------------------------------------------------------------- M2/write ---
 * Does the turn's `sandboxPolicy` OVERRIDE the readOnly a non-git cwd inherits?
 *
 * S02/M2 measured that a thread started with a non-git cwd comes up
 * `sandbox:{type:readOnly}` / profile `:read-only` even though the turn sends
 * `workspaceWrite` — but it read that off `thread/start.result`, which is emitted
 * BEFORE the turn ever applies its override. So "the thread is read-only" and "the
 * turn cannot write" are two different claims, and only the first was measured.
 *
 * The ground truth here is a FILE ON DISK, never a field read back off a request we
 * sent (the M2 read-back blindness) and never "the turn completed" (the silent-success
 * class this milestone exists to kill). `fs.existsSync` after the turn is the whole
 * verdict; every wire field printed alongside is diagnostic, not evidence.
 *
 * Arm B is the disconfounding control the a4-denied/cap-readonly mold requires: the
 * SAME command under the SAME policy in a cwd that IS git. Without it, "file absent"
 * is byte-identical between "the sandbox denied the write" and "the model never tried",
 * which is exactly the TASK-020 pathology (attribution without discrimination).
 */
const NONGIT_WRITE_VERDICTS = { OVERRIDES: 'a', MECHANISM: 'b', NO_MECHANISM: 'c' };

async function probeNonGitWrite({ timeoutSecs }) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { spawnSync } = require('child_process');

  const isGitRepo = (dir) => {
    const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return r.status === 0 && String(r.stdout).trim() === 'true';
  };

  const nonGitDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-m2w-nongit-')));
  const gitDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-m2w-git-')));
  // `git init` runs in a throwaway tmpdir the probe just created — never the operator's
  // repository. This is the only way to get a WRITE control that isolates git-ness.
  const init = spawnSync('git', ['init', '-q'], { cwd: gitDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  // Preconditions are ASSERTED, never assumed: a treatment dir that turned out to be
  // inside a repo, or a control dir where `git init` silently failed, would make every
  // verdict below meaningless while still printing green.
  const treatmentIsGit = isGitRepo(nonGitDir);
  const controlIsGit = isGitRepo(gitDir);
  process.stdout.write(`# probe nongit-write: TREATMENT cwd=${nonGitDir} is-git=${treatmentIsGit} (must be false) | CONTROL cwd=${gitDir} is-git=${controlIsGit} (must be true; git init status=${init.status})\n`);
  if (treatmentIsGit || !controlIsGit) {
    process.stderr.write('forge-appserver-probe: nongit-write precondition failed — treatment must be non-git and control must be git\n');
    process.exitCode = 2;
    fs.rmSync(nonGitDir, { recursive: true, force: true });
    fs.rmSync(gitDir, { recursive: true, force: true });
    return;
  }

  const runArm = async (label, dir, { sandboxPolicy, threadSandbox, note }) => {
    // Per-arm target. Two arms sharing one path in one dir makes `exists` after arm N
    // report arm A's leftover file as if arm N had written it — the probe would grade
    // its own contamination. Caught by the negative control on the first real run.
    const target = path.join(dir, `forge-write-probe-${label}.txt`);
    const command = `touch ${shellQuote(target)}`;
    const arm = { label, dir, target };
    process.stdout.write(`\n# --- ARM ${label} ${note} ---\n# cwd=${dir} sandboxPolicy=${JSON.stringify(sandboxPolicy)} threadSandbox=${JSON.stringify(threadSandbox)}\n# command=${command}\n`);
    // "Exists after" is evidence only if it did NOT exist before. Assert, don't assume.
    try { fs.rmSync(target, { force: true }); } catch { /* asserted next */ }
    const presentBefore = fs.existsSync(target);
    process.stdout.write(`# precondition — target absent before turn: ${!presentBefore}\n`);
    if (presentBefore) {
      arm.error = 'precondition failed: target present before the turn';
      arm.exists = false;
      process.stdout.write(`# ARM ${label} NÃO MEDIDO: ${arm.error}\n`);
      return arm;
    }
    try {
      const r = await runCapabilityTurn({ timeoutSecs, command, sandboxPolicy, cwd: dir, threadSandbox });
      const ts = r.result.threadStartResult || {};
      arm.exists = fs.existsSync(target);
      arm.items = r.commandItems;
      arm.startedOnly = r.startedOnly;
      arm.threadSandbox = ts.sandbox;
      arm.profile = ts.activePermissionProfile;
      arm.gitInfo = ts.thread ? ts.thread.gitInfo : undefined;
      // The harness can run the command through a path that never surfaces a
      // commandExecution item, leaving the denial visible ONLY in the model's own
      // text. That text is NARRATION, and this repo's standing rule (TASK-020) is
      // that sidecar prose is never evidence — so it is collected as corroboration
      // and labelled as such, never promoted to the ground truth, which stays the
      // file on disk.
      arm.narration = (r.result.items || [])
        .map(e => (e && e.item ? e.item : e))
        .filter(i => i && i.type === 'agentMessage' && typeof i.text === 'string' && i.text.trim())
        .map(i => i.text.trim());
      arm.denialNarrated = arm.narration.some(t => /not permitted|permission denied|read-only file system|operation not permitted/i.test(t));
      process.stdout.write(`# agentMessage narration: ${JSON.stringify(arm.narration)}\n# denial signature in narration (corroboração, NÃO evidência): ${arm.denialNarrated}\n`);
      process.stdout.write(`# thread/start.result sandbox=${JSON.stringify(arm.threadSandbox)} activePermissionProfile=${JSON.stringify(arm.profile)} gitInfo=${JSON.stringify(arm.gitInfo)}\n`);
      // Reported per arm, always — including when it is null. A precondition that is
      // only mentioned when it bites reads, on the quiet runs, exactly like a check
      // that stopped running.
      const refusal = policyRefusal(arm);
      process.stdout.write(`# recusa por POLÍTICA neste braço: ${refusal ? refusal.detail : 'nenhuma'}\n`);
      process.stdout.write(`# commandExecution items: ${JSON.stringify(arm.items)}\n`);
      process.stdout.write(`# commandExecution started-without-completion: ${JSON.stringify(arm.startedOnly)}\n`);
      process.stdout.write(`# GROUND TRUTH — target exists after turn: ${arm.exists}\n`);
    } catch (error) {
      arm.error = error.message.replace(/\n/g, ' ');
      arm.exists = false;
      process.stdout.write(`# ARM ${label} NÃO MEDIDO: ${arm.error}\n`);
    }
    return arm;
  };

  const WORKSPACE_WRITE = { type: 'workspaceWrite', networkAccess: false };
  try {
    // Arm A — exactly what forge-appserver-client sends today.
    const a = await runArm('A', nonGitDir, {
      sandboxPolicy: WORKSPACE_WRITE,
      note: 'TREATMENT: cwd não-git + turn sandboxPolicy workspaceWrite (o que o cliente manda hoje)',
    });
    // Arm B — positive control. SAME command, SAME policy, cwd that IS git.
    const b = await runArm('B', gitDir, {
      sandboxPolicy: WORKSPACE_WRITE,
      note: 'CONTROLE POSITIVO: cwd git + MESMO comando e MESMA policy — isola a git-ness',
    });

    if (a.exists) {
      // NEGATIVE control, and the verdict does not exist without it. "A wrote the file"
      // is byte-identical between "the turn's sandboxPolicy overrode the thread's
      // readOnly" and "no sandbox is enforced on this machine at all" — under the second
      // reading arm A proves nothing about override. Same cwd, same command, ONLY the
      // turn's sandboxPolicy flipped to readOnly: if that denies the write, the turn's
      // policy is demonstrably the thing that governs, and A's success IS the override.
      const n = await runArm('N', nonGitDir, {
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        note: 'CONTROLE NEGATIVO: MESMO cwd não-git, MESMO comando, turn sandboxPolicy readOnly — deve NÃO escrever',
      });
      if (n.exists) {
        printVerdict('nongit-write', 'inconclusiva',
          `A escreveu, mas o CONTROLE NEGATIVO no MESMO cwd com sandboxPolicy readOnly TAMBÉM escreveu — o sandbox não está sendo aplicado neste ambiente, então a escrita de A não pode ser atribuída a uma sobreposição do turn. N=${JSON.stringify({ items: n.items, error: n.error })}`);
        return;
      }
      const nAttempted = (n.items || []).length > 0 || (n.startedOnly || []).length > 0;
      let basis;
      if (nAttempted) {
        basis = `negação OBSERVADA no protocolo: sob readOnly o comando foi emitido e o arquivo não apareceu (${JSON.stringify(n.items)})`;
      } else if (n.denialNarrated) {
        basis = `sob readOnly NENHUM commandExecution foi emitido, mas a narração do modelo cita uma negação do SO (${JSON.stringify(n.narration)}) — isso é CORROBORAÇÃO, não evidência de protocolo (regra da TASK-020: prosa do sidecar nunca é prova). A evidência continua sendo o arquivo: presente em A, ausente em N`;
      } else {
        basis = `base MAIS FRACA, dita com todas as letras: sob readOnly o harness não emitiu commandExecution e a narração não cita negação — uma negação NÃO foi observada; o provado é que a policy do turn ALTEROU o comportamento (em A o comando rodou com exitCode:0 e o arquivo apareceu; em N, mesmo cwd e mesmo comando, nada apareceu), logo a policy do turn é consumida e não ignorada`;
      }
      printVerdict('nongit-write', NONGIT_WRITE_VERDICTS.OVERRIDES,
        `classe (a): o turn SOBREPÕE o readOnly herdado. Num cwd não-git cujo thread/start devolveu ${JSON.stringify(a.threadSandbox)}/${JSON.stringify(a.profile)}, o arquivo foi escrito DE VERDADE com sandboxPolicy workspaceWrite (A), e NÃO foi escrito no MESMO cwd com sandboxPolicy readOnly (N) — a única variável entre A e N é a policy do turn. ${basis}. A regressão de SVN NÃO existe neste caminho. Controle git (B) escreveu=${b.exists}`);
      return;
    }
    if (!b.exists) {
      // Both arms absent: nothing is attributable to git-ness. Saying "denied" here
      // would be the self-proving premise the control exists to prevent.
      printVerdict('nongit-write', 'inconclusiva',
        `arquivo ausente nos DOIS braços (A não-git e B git, mesmo comando) — "o sandbox negou" é indistinguível de "o modelo nunca tentou"; a git-ness NÃO foi isolada. A=${JSON.stringify({ items: a.items, startedOnly: a.startedOnly, error: a.error })} B=${JSON.stringify({ items: b.items, startedOnly: b.startedOnly, error: b.error })}`);
      return;
    }

    // A absent + B present => git-ness gates the write. The regression is real; now find
    // out whether the protocol offers any lever that reopens it.
    process.stdout.write(`\n# A ausente + B presente => a git-ness do cwd controla a escrita. Buscando mecanismo de contorno no protocolo (não há equivalente de --skip-git-repo-check no schema 0.144.4).\n`);
    const c = await runArm('C', nonGitDir, {
      sandboxPolicy: { ...WORKSPACE_WRITE, writableRoots: [nonGitDir] },
      note: 'MECANISMO 1: cwd não-git + writableRoots explícito no turn sandboxPolicy',
    });
    if (c.exists) {
      printVerdict('nongit-write', NONGIT_WRITE_VERDICTS.MECHANISM,
        `classe (b): o turn sozinho não sobrepõe (braço A não escreveu), mas writableRoots EXPLÍCITO no sandboxPolicy do turn escreveu num cwd não-git. Mecanismo nomeado: sandboxPolicy.writableRoots=[cwd]. Controle git=${b.exists}`);
      return;
    }
    const d = await runArm('D', nonGitDir, {
      sandboxPolicy: WORKSPACE_WRITE,
      threadSandbox: 'workspace-write',
      note: 'MECANISMO 2: cwd não-git + thread/start sandbox:"workspace-write" (SandboxMode)',
    });
    if (d.exists) {
      printVerdict('nongit-write', NONGIT_WRITE_VERDICTS.MECHANISM,
        `classe (b): o turn sozinho não sobrepõe (A) e writableRoots não bastou (C), mas thread/start sandbox:"workspace-write" escreveu num cwd não-git. Mecanismo nomeado: ThreadStartParams.sandbox. Controle git=${b.exists}`);
      return;
    }
    printVerdict('nongit-write', NONGIT_WRITE_VERDICTS.NO_MECHANISM,
      `classe (c): o turn NÃO sobrepõe o readOnly herdado (A ausente, controle git B presente) e NENHUM mecanismo do protocolo o reabriu — writableRoots (C) e ThreadStartParams.sandbox (D) também não escreveram. O schema 0.144.4 não tem equivalente de --skip-git-repo-check. Decisão do operador: colide com a D6.`);
  } finally {
    fs.rmSync(nonGitDir, { recursive: true, force: true });
    fs.rmSync(gitDir, { recursive: true, force: true });
  }
}

/* ----------------------------------------------------------- cross-root ---
 * Does `sandboxPolicy.writableRoots` ENLARGE the writable set, or does it only
 * DELIMIT inside a root the server already granted?
 *
 * The existing arm C of `nongit-write` cannot answer this: it sends
 * `writableRoots: [nonGitDir]` where `nonGitDir` IS the cwd, so it asks "does the
 * field reopen the cwd", not "does the field open a directory OUTSIDE it". This
 * probe puts the target in a SIBLING repo B while the turn runs with cwd = A.
 *
 * Geometry (asserted, never assumed): A and B are two sibling throwaway git repos
 * under os.tmpdir(), realpath'd; the target of the treatment arm lives in B and is
 * provably NOT a descendant of A.
 *
 * The four arms all carry the SAME POLICY_BASE, so the only variable between
 * CTRL-DENY and TREAT is `writableRoots` itself. `excludeSlashTmp` /
 * `excludeTmpdirEnvVar` are emitted true in every arm as a best-effort narrowing —
 * this does NOT assume the runtime honours them. If it ignores them, the one who
 * says so is CTRL-DENY (it writes into B without the field) and the prescribed
 * outcome is `inconclusiva`, never positive.
 */
const CROSSROOT_VERDICTS = {
  PROVADA: 'provada',
  FALHOU: 'falhou',
  INCONCLUSIVA: 'inconclusiva',
  PARCIAL: 'parcial',
  UNKNOWN: 'unknown',
};

// The re-run prescribed by both inconclusive routes: siege A and B outside os.tmpdir().
const CROSSROOT_RERUN = 'Re-rodada prescrita (variante ii): recriar A e B FORA de os.tmpdir() e repetir os quatro braços.';

/**
 * EXECUTION EVIDENCE (review R1).
 *
 * `exists === false` is byte-identical between "the sandbox denied the write" and
 * "the model completed the turn without ever running the touch". The ladder used to
 * read the first meaning out of the second by assumption. It no longer does: every
 * arm whose claim rests on an ABSENCE must carry evidence that the command actually
 * ran in that arm.
 *
 * Three admissible kinds, ordered strongest first — and each one is NAMED in the
 * verdict reason, never folded into a boolean:
 *
 *  - `write-effect` — the target appeared. Something executed; no further proof is
 *    conceivable or needed. (Arms that WROTE never need an item.)
 *  - `item` — a COMPLETED `commandExecution` citing this arm's target, with its exit
 *    status carried when the server supplied one.
 *  - `control` — the arm emitted no item, and a PERMISSIVE arm against the SAME
 *    target directory did run and did write. This is the shape `probeCapReadonly`
 *    (:631-654) already established for exactly this ambiguity: it does not prove
 *    THIS arm ran, it proves the turn executes this command in this shape when the
 *    sandbox allows it, which is what separates a sandbox denial from a model
 *    refusal. Deliberately reused rather than reinvented, and deliberately labelled
 *    weaker than `item`.
 *
 * Absent all three the answer is `unknown` = NOT MEASURED. Never `falhou`.
 */
const CROSSROOT_EXEC = { WRITE: 'write-effect', ITEM: 'item', CONTROL: 'control', NONE: 'none' };

// A completed commandExecution citing this arm's target. `status` is checked when the
// server supplied it (the real 0.144.4 items carry `status:"completed"`); the probe's
// own collector already drops started-without-completion items, so absence of the
// field is not treated as a failure.
function completedExecFor(arm) {
  if (!arm || !Array.isArray(arm.items)) return null;
  const completed = arm.items.filter(i => i && i.type === 'commandExecution'
    && (i.status === undefined || i.status === 'completed'));
  if (completed.length === 0) return null;
  const target = typeof arm.target === 'string' && arm.target ? arm.target : null;
  const matched = target
    ? completed.filter(i => typeof i.command === 'string' && i.command.includes(target))
    : completed;
  if (matched.length === 0) return null;
  const item = matched[0];
  const exit = (item.exitCode === undefined || item.exitCode === null)
    ? 'sem exit status'
    : `exitCode:${item.exitCode}`;
  return {
    item,
    detail: target
      ? `commandExecution completado citando o alvo (${exit})`
      : `commandExecution completado, alvo não confrontado — braço sem target (${exit})`,
  };
}

/**
 * `control` is only admissible from an arm that (a) targets the same directory,
 * (b) actually wrote, and (c) itself carries direct execution evidence. Anything
 * weaker would be one absence corroborating another.
 */
function armExecution(arm, control) {
  if (!arm) return { kind: CROSSROOT_EXEC.NONE, detail: 'braço ausente' };
  if (arm.exists === true) {
    return { kind: CROSSROOT_EXEC.WRITE, detail: 'o alvo apareceu — o comando executou, por efeito' };
  }
  const direct = completedExecFor(arm);
  if (direct) return { kind: CROSSROOT_EXEC.ITEM, detail: direct.detail };
  if (control && control.arm && control.arm.exists === true && completedExecFor(control.arm)
      && control.arm.targetDir !== undefined && arm.targetDir !== undefined
      && control.arm.targetDir === arm.targetDir) {
    return {
      kind: CROSSROOT_EXEC.CONTROL,
      detail: `sem commandExecution próprio; CONTROLE PERMISSIVO ${control.label} rodou e escreveu no MESMO diretório-alvo (evidência MAIS FRACA que item próprio: prova que o turn executa este comando nesta forma quando o sandbox permite, logo a ausência aqui é negação do sandbox e não recusa do modelo)`,
    };
  }
  return { kind: CROSSROOT_EXEC.NONE, detail: 'nenhum commandExecution completado citando o alvo e nenhum controle permissivo no mesmo diretório-alvo' };
}

/**
 * PURE. No I/O, no binary, no network — that is what makes the must-haves
 * checkable without the sidecar being reachable.
 *
 * `unknown` is NEW vocabulary in this file and it means, with all the letters:
 * NOT MEASURED. It never means "measured and negative". A probe that failed to
 * run (spawn, auth, network, timeout) has produced no evidence about
 * `writableRoots`, and degrading that silence into `falhou` would manufacture a
 * measurement out of an outage — the exact failure class this repo keeps paying
 * for. Note that a TIMEOUT does not carry `error.infra` (runProbeSession only
 * sets `infra` on spawn failure), so treating `!infra` as "measured" would grade
 * a timeout as a measurement. It is treated as `unknown` here.
 *
 * Evaluation order — first match wins.
 */
/**
 * Did the POLICY refuse this arm's command, as opposed to the command never having
 * been run?
 *
 * The distinction is the whole reason this helper exists. Rule (2) below reads
 * `ctrlAttempt.exists === false` as "the turn does not execute the command in this
 * shape" — true when the model never issued it, and FALSE when the model issued it
 * and the server declined. Measured on 2026-08-19: every arm came back
 * `status: "declined"` / `rejected: blocked by policy`, on a thread that
 * `thread/start` had already opened as `readOnly` with
 * `activePermissionProfile: ":read-only"`, because a throwaway `mkdtemp` directory
 * is not in the operator's codex trust list. Reporting that as "the turn does not
 * execute this shape" would be a measurement about the COMMAND published from a fact
 * about the DIRECTORY.
 *
 * Two independent signals, both from the server, neither inferred from narration:
 *   - `declined` — a commandExecution the server itself marked refused. Strongest:
 *     it proves the command reached the sandbox and was turned away.
 *   - `readOnlyThread` — thread/start answered `readOnly` while the arm asked for
 *     `workspaceWrite`. Proves the session could never have written, whatever the
 *     model did afterwards.
 *
 * Either one alone is enough to disqualify the run as a measurement of
 * `writableRoots`; both are reported so the operator sees which fired.
 */
function policyRefusal(arm) {
  if (!arm) return null;
  const items = Array.isArray(arm.items) ? arm.items : [];
  const declined = items.filter(i => i && i.type === 'commandExecution' && i.status === 'declined');
  const readOnlyThread = Boolean(
    (arm.threadSandbox && arm.threadSandbox.type === 'readOnly')
    || (arm.profile && arm.profile.id === ':read-only'),
  );
  if (declined.length === 0 && !readOnlyThread) return null;
  const parts = [];
  if (declined.length > 0) {
    parts.push(`${declined.length} commandExecution com status:"declined" (o servidor recusou o comando, ele NÃO deixou de ser emitido)`);
  }
  if (readOnlyThread) {
    parts.push(`thread/start abriu sandbox=${JSON.stringify(arm.threadSandbox)} profile=${JSON.stringify(arm.profile)} embora o braço tenha pedido workspaceWrite`);
  }
  return { declined: declined.length > 0, readOnlyThread, detail: parts.join('; ') };
}

function crossRootVerdict({ ctrlAttempt, ctrlDeny, treat, replaceCheck }) {
  const V = CROSSROOT_VERDICTS;

  // (1) Any DECISIVE arm that did not run at all => unknown. Never `falhou`.
  const decisive = [
    ['CTRL-ATTEMPT', ctrlAttempt],
    ['CTRL-DENY', ctrlDeny],
    ['TREAT', treat],
  ];
  for (const [label, arm] of decisive) {
    if (!arm || arm.error) {
      const message = arm && arm.error ? arm.error : 'braço ausente do resultado';
      return {
        verdict: V.UNKNOWN,
        reason: `braço ${label} NÃO MEDIDO (${message}) — sem os três braços decisivos não há medição sobre writableRoots. "unknown" significa NÃO MEDIDO e nunca "medido e negativo".`,
      };
    }
  }

  // (1b) PRECONDITION, and it MUST precede (2). When the positive control did not
  // write AND the server refused by policy, the environment — not the command shape —
  // is what stopped the measurement. Rule (2) would name the command shape, which is
  // a claim about something nobody tested here.
  //
  // `unknown` is the right verdict and not a new one: NOT MEASURED is exactly what
  // happened. What this branch adds is a reason an operator can act on, instead of a
  // diagnosis pointing at the wrong subject.
  const attemptRefusal = policyRefusal(ctrlAttempt);
  if (ctrlAttempt.exists === false && attemptRefusal) {
    return {
      verdict: V.UNKNOWN,
      reason: 'PRECONDIÇÃO NÃO SATISFEITA — o CONTROLE POSITIVO não escreveu nem dentro do próprio cwd, e a causa medida é recusa por POLÍTICA, não forma do comando: '
        + `${attemptRefusal.detail}. Um diretório recém-criado por mkdtemp não está na lista de trust do codex, e trust NÃO é herdado do diretório pai (medido: repetir com A e B sob uma raiz confiada dá o mesmo readOnly). `
        + 'Enquanto todo comando é recusado, nenhum braço pode escrever e NADA sobre writableRoots é atribuível. "unknown" significa NÃO MEDIDO e nunca "medido e negativo". '
        + 'Remédio: rodar os braços num diretório confiado, ou abrir a thread com sandbox de escrita já em thread/start.',
    };
  }

  // (2) The turn never executed the command in this shape: absence is noise, not denial.
  if (ctrlAttempt.exists === false) {
    return {
      verdict: V.INCONCLUSIVA,
      reason: `CTRL-ATTEMPT não escreveu DENTRO do próprio cwd (A) — nesta forma o turn não executa o comando (ou excludeSlashTmp/excludeTmpdirEnvVar fecharam o próprio cwd), então a ausência nos demais braços é ruído e não negação. ${CROSSROOT_RERUN}`,
    };
  }

  // (2b) CTRL-DENY rests entirely on an ABSENCE, so it must carry execution evidence
  // (R1). Without it, "the sandbox denied" is indistinguishable from "the model never
  // ran the touch" — and reporting a model non-compliance as a sandbox denial is the
  // exact substitution this probe exists to refuse. `unknown` = NOT MEASURED.
  const denyExec = armExecution(ctrlDeny, { label: 'TREAT', arm: treat });
  if (ctrlDeny.exists === false && denyExec.kind === CROSSROOT_EXEC.NONE) {
    return {
      verdict: V.UNKNOWN,
      reason: `CTRL-DENY não escreveu, mas NÃO HÁ EVIDÊNCIA DE EXECUÇÃO desse braço (${denyExec.detail}) — "o sandbox negou" é indistinguível de "o modelo não rodou o comando". "unknown" significa NÃO MEDIDO e nunca "medido e negativo". ${CROSSROOT_RERUN}`,
    };
  }

  // (3) Negative control wrote => B was already writable; the field is not what did it.
  if (ctrlDeny.exists === true) {
    return {
      verdict: V.INCONCLUSIVA,
      reason: `CONTROLE NEGATIVO escreveu em B SEM writableRoots — B já era gravável, logo nenhuma escrita em B pode ser atribuída ao campo. Degradar este caso para positivo é proibido. ${CROSSROOT_RERUN}`,
    };
  }

  // (4) Treatment wrote where the control could not: the field ENLARGES.
  if (treat.exists === true) {
    let replace;
    if (!replaceCheck || replaceCheck.error) {
      const message = replaceCheck && replaceCheck.error ? replaceCheck.error : 'braço ausente do resultado';
      replace = `REPLACE-CHECK NÃO MEDIDO: ${message} — soma vs. substituição fica em aberto, dito e não inferido`;
    } else if (replaceCheck.exists === true) {
      replace = 'REPLACE-CHECK escreveu dentro de A: semântica de SOMA — writableRoots acrescenta B sem fechar a raiz implícita do cwd';
    } else {
      // Same asymmetry as CTRL-DENY, one level down: calling this arm "REPLACEMENT"
      // without execution evidence would publish a production risk manufactured out
      // of a model that simply did not run the touch (R1). Not measured is SAID.
      const replaceExec = armExecution(replaceCheck, { label: 'CTRL-ATTEMPT', arm: ctrlAttempt });
      replace = replaceExec.kind === CROSSROOT_EXEC.NONE
        ? `REPLACE-CHECK NÃO MEDIDO: o alvo dentro de A não apareceu, mas não há evidência de execução do braço (${replaceExec.detail}) — soma vs. substituição fica EM ABERTO; ler esta ausência como semântica de substituição seria inventar a medição`
        : `REPLACE-CHECK NÃO escreveu dentro de A (execução evidenciada: ${replaceExec.detail}): semântica de SUBSTITUIÇÃO — risco de produção nomeado, emitir writableRoots fecharia o próprio cwd em silêncio`;
    }
    return {
      verdict: V.PROVADA,
      reason: `writableRoots ALARGA a escrita: com cwd=A o alvo em B (fora de A) foi escrito COM o campo e NÃO foi escrito SEM ele — a única variável entre os dois braços é writableRoots. Evidência de execução do CTRL-DENY: ${denyExec.detail}. ${replace}.`,
    };
  }

  // (5) TREAT did not write either — the only route to a MEASURED negative. It carries
  // the same burden as CTRL-DENY, and here no permissive same-dir control can exist
  // (TREAT is itself the permissive arm), so only direct item evidence admits it.
  const treatExec = armExecution(treat, null);
  if (treatExec.kind === CROSSROOT_EXEC.NONE) {
    return {
      verdict: V.UNKNOWN,
      reason: `TREAT não escreveu e NÃO HÁ EVIDÊNCIA DE EXECUÇÃO desse braço (${treatExec.detail}) — sem ela, "writableRoots não alarga" seria uma recusa do modelo reportada como negação do sandbox. "unknown" significa NÃO MEDIDO e nunca "medido e negativo". ${CROSSROOT_RERUN}`,
    };
  }

  // (6) Measured and negative: the field delimits, it does not enlarge.
  return {
    verdict: V.FALHOU,
    reason: `writableRoots NÃO alarga: com cwd=A o alvo em B não foi escrito nem com o campo (TREAT, execução evidenciada: ${treatExec.detail}), enquanto o CTRL-ATTEMPT provou que o turn de fato executa comandos nesta forma. Evidência de execução do CTRL-DENY: ${denyExec.detail}. O campo delimita dentro de uma raiz já concedida.`,
  };
}

async function probeCrossRootWrite({ timeoutSecs }) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { spawnSync } = require('child_process');

  // Step 1 — handshake precondition, zero inference cost. A probe that could not
  // even open a session must never print a negative verdict about writableRoots.
  const { cmd, args, env } = resolveCommand();
  let binaryVersion = 'unknown';
  try {
    const hs = await runProbeHandshake({ cmd, args, env, timeoutSecs });
    const init = (hs && hs.initializeResult) || {};
    const thread = (hs && hs.threadStartResult && hs.threadStartResult.thread) || {};
    // Real shape measured in TASK-022: userAgent on initialize, cliVersion on the thread.
    binaryVersion = thread.cliVersion || init.userAgent || 'unknown';
    process.stdout.write(`# binary version (medida no handshake): ${binaryVersion}\n`);
    process.stdout.write(`# thread/start.result runtimeWorkspaceRoots=${JSON.stringify(hs.threadStartResult && hs.threadStartResult.runtimeWorkspaceRoots)}\n`);
  } catch (error) {
    if (error.infra) {
      process.stderr.write(`forge-appserver-probe: infra failure — ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    printVerdict('crossroot-write', CROSSROOT_VERDICTS.UNKNOWN,
      `handshake não fechou (${error.message.replace(/\n/g, ' ')}) — NADA foi medido sobre writableRoots. "unknown" é NÃO MEDIDO, nunca "medido e negativo".`);
    return;
  }

  const isGitRepo = (dir) => {
    const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return r.status === 0 && String(r.stdout).trim() === 'true';
  };

  // Local copy, declared: `isWithin` exists twice in scripts/ and NEITHER is exported
  // (forge-prompt.js:89, forge-memory-index.js:28). This is a copy by necessity, not
  // a reuse someone forgot.
  const isWithin = (root, candidate) => {
    const rel = path.relative(root, candidate);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };

  // Step 2 — two SIBLING throwaway git repos. Both are git on purpose: this task's
  // question is not about git-ness, so that variable is removed by holding it fixed.
  const dirA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-xroot-a-')));
  const dirB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-xroot-b-')));
  // `git init` runs only in tmpdirs this probe just created — never the operator's repo.
  const initA = spawnSync('git', ['init', '-q'], { cwd: dirA, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const initB = spawnSync('git', ['init', '-q'], { cwd: dirB, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  const cleanup = () => {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  };

  // Step 3 — preconditions ASSERTED, never assumed.
  const aIsGit = isGitRepo(dirA);
  const bIsGit = isGitRepo(dirB);
  process.stdout.write(`# probe crossroot-write: A(cwd)=${dirA} is-git=${aIsGit} (git init status=${initA.status}) | B(alvo)=${dirB} is-git=${bIsGit} (git init status=${initB.status})\n`);
  if (!aIsGit || !bIsGit) {
    process.stderr.write('forge-appserver-probe: crossroot-write precondition failed — A e B precisam ser repos git\n');
    process.exitCode = 2;
    cleanup();
    return;
  }

  const targetsInB = ['CTRL-DENY', 'TREAT'].map(label => path.join(dirB, `forge-write-probe-${label}.txt`));
  const geometryOk = dirA !== dirB
    && !isWithin(dirA, dirB) && !isWithin(dirB, dirA)
    && targetsInB.every(t => !isWithin(dirA, t));
  process.stdout.write(`# geometria: A!==B=${dirA !== dirB} A⊅B=${!isWithin(dirA, dirB)} B⊅A=${!isWithin(dirB, dirA)} alvos-em-B-fora-de-A=${targetsInB.every(t => !isWithin(dirA, t))}\n`);
  if (!geometryOk) {
    process.stderr.write('forge-appserver-probe: crossroot-write geometry assert failed — o alvo precisa estar FORA do cwd; medir a geometria errada e chamar de veredito é exatamente o erro que este probe existe para atacar\n');
    process.exitCode = 2;
    cleanup();
    return;
  }

  /**
   * Local copy of probeNonGitWrite's `runArm` (:1213). DELIBERATE duplication, not an
   * oversight: probeNonGitWrite produced a PUBLISHED verdict, and hoisting the helper
   * to module scope would put that verdict at regression risk in exchange for reusing
   * ~40 lines. A future reader who "fixes" this duplication is undoing a decision.
   * Two mandatory differences from the original: `timeoutSecs` is a parameter, and
   * `targetDir` is separate from `cwd` — that separation IS what this task measures.
   */
  const runArm = async (label, { cwd, targetDir, sandboxPolicy, note }) => {
    // Per-arm target (Pitfall 3): two arms sharing a path make arm N report arm A's
    // leftover file as its own write.
    const target = path.join(targetDir, `forge-write-probe-${label}.txt`);
    const command = `touch ${shellQuote(target)}`;
    const arm = { label, cwd, targetDir, target };
    process.stdout.write(`\n# --- ARM ${label} ${note} ---\n# cwd=${cwd} targetDir=${targetDir} sandboxPolicy=${JSON.stringify(sandboxPolicy)}\n# command=${command}\n`);
    try { fs.rmSync(target, { force: true }); } catch { /* asserted next */ }
    const presentBefore = fs.existsSync(target);
    process.stdout.write(`# precondition — target absent before turn: ${!presentBefore}\n`);
    if (presentBefore) {
      arm.error = 'precondition failed: target present before the turn';
      arm.exists = false;
      process.stdout.write(`# ARM ${label} NÃO MEDIDO: ${arm.error}\n`);
      return arm;
    }
    try {
      // One bounded retry, and ONLY for the state-runtime contention named in
      // `reap` above. The reap fixes the cause; this covers the residue (a handle
      // the OS has not released yet). Any other error falls straight through —
      // retrying an unknown failure would turn a measurement into a coin flip.
      let r;
      try {
        r = await runCapabilityTurn({ timeoutSecs, command, sandboxPolicy, cwd });
      } catch (first) {
        if (!/failed to initialize sqlite state runtime/i.test(first.message || '')) throw first;
        process.stdout.write(`# ARM ${label}: state runtime ocupado — uma nova tentativa após ${RETRY_DELAY_MS}ms (causa nomeada, nunca retry cego)\n`);
        await new Promise(res => setTimeout(res, RETRY_DELAY_MS));
        r = await runCapabilityTurn({ timeoutSecs, command, sandboxPolicy, cwd });
      }
      const ts = r.result.threadStartResult || {};
      arm.exists = fs.existsSync(target);
      arm.items = r.commandItems;
      arm.startedOnly = r.startedOnly;
      arm.threadSandbox = ts.sandbox;
      arm.profile = ts.activePermissionProfile;
      arm.gitInfo = ts.thread ? ts.thread.gitInfo : undefined;
      // Narration is CORROBORATION, never evidence (TASK-020). It never enters the ladder.
      arm.narration = (r.result.items || [])
        .map(e => (e && e.item ? e.item : e))
        .filter(i => i && i.type === 'agentMessage' && typeof i.text === 'string' && i.text.trim())
        .map(i => i.text.trim());
      arm.denialNarrated = arm.narration.some(t => /not permitted|permission denied|read-only file system|operation not permitted/i.test(t));
      process.stdout.write(`# agentMessage narration: ${JSON.stringify(arm.narration)}\n# denial signature in narration (corroboração, NÃO evidência): ${arm.denialNarrated}\n`);
      process.stdout.write(`# thread/start.result sandbox=${JSON.stringify(arm.threadSandbox)} activePermissionProfile=${JSON.stringify(arm.profile)} gitInfo=${JSON.stringify(arm.gitInfo)}\n`);
      // Reported per arm, always — including when it is null. A precondition that is
      // only mentioned when it bites reads, on the quiet runs, exactly like a check
      // that stopped running.
      const refusal = policyRefusal(arm);
      process.stdout.write(`# recusa por POLÍTICA neste braço: ${refusal ? refusal.detail : 'nenhuma'}\n`);
      process.stdout.write(`# commandExecution items: ${JSON.stringify(arm.items)}\n`);
      process.stdout.write(`# commandExecution started-without-completion: ${JSON.stringify(arm.startedOnly)}\n`);
      process.stdout.write(`# GROUND TRUTH — target exists after turn: ${arm.exists}\n`);
    } catch (error) {
      arm.error = error.message.replace(/\n/g, ' ');
      arm.exists = false;
      process.stdout.write(`# ARM ${label} NÃO MEDIDO: ${arm.error}\n`);
    }
    return arm;
  };

  // Identical in every arm, so the ONLY variable between CTRL-DENY and TREAT is
  // writableRoots. The two exclude* flags are a best-effort narrowing whose failure
  // is DETECTED by CTRL-DENY, not assumed away.
  const POLICY_BASE = {
    type: 'workspaceWrite',
    networkAccess: false,
    excludeSlashTmp: true,
    excludeTmpdirEnvVar: true,
  };

  try {
    const ctrlAttempt = await runArm('CTRL-ATTEMPT', {
      cwd: dirA, targetDir: dirA, sandboxPolicy: POLICY_BASE,
      note: 'CONTROLE POSITIVO: cwd=A, alvo DENTRO de A — prova que o turn de fato executa comandos nesta forma; sem ele, ausência é ruído e não negação',
    });
    const ctrlDeny = await runArm('CTRL-DENY', {
      cwd: dirA, targetDir: dirB, sandboxPolicy: POLICY_BASE,
      note: 'CONTROLE NEGATIVO: cwd=A, alvo em B, SEM writableRoots — se escrever, B já era gravável e nada é atribuível ao campo',
    });
    const treat = await runArm('TREAT', {
      cwd: dirA, targetDir: dirB, sandboxPolicy: { ...POLICY_BASE, writableRoots: [dirB] },
      note: 'TRATAMENTO: cwd=A, alvo em B, COM writableRoots:[B] — a pergunta da task',
    });
    // Runs on EVERY path that reaches a measured verdict, including the positive one:
    // "B appeared" alone does not distinguish SUM from REPLACEMENT, and replacement
    // means production would break in silence the day someone emits the field.
    const replaceCheck = await runArm('REPLACE-CHECK', {
      cwd: dirA, targetDir: dirA, sandboxPolicy: { ...POLICY_BASE, writableRoots: [dirB] },
      note: 'cwd=A, alvo DENTRO de A, COM writableRoots:[B] — writableRoots SOMA B ou SUBSTITUI a raiz implícita do cwd?',
    });

    const { verdict, reason } = crossRootVerdict({ ctrlAttempt, ctrlDeny, treat, replaceCheck });

    // Step 8 — fifth arm, gated on a measured negative only (Decisão 6).
    if (verdict === CROSSROOT_VERDICTS.FALHOU) {
      process.stdout.write('\n# --- ARM RUNTIME-ROOTS (gated: só roda com writableRoots medido negativo) ---\n');
      const target = path.join(dirB, 'forge-write-probe-RUNTIME-ROOTS.txt');
      const command = `touch ${shellQuote(target)}`;
      let fifthWrote = false;
      let fifthError = null;
      let fifthItems = [];
      try { fs.rmSync(target, { force: true }); } catch { /* asserted next */ }
      if (fs.existsSync(target)) {
        fifthError = 'precondition failed: target present before the turn';
      } else {
        try {
          // runCapabilityTurn accepts only cwd/threadSandbox as thread params (:537-539),
          // so the seam for an arbitrary thread-level field is runProbeSession itself.
          // Not one line of runCapabilityTurn is edited — it is module scope, shared by
          // the three cap-* probes.
          const fifth = await runProbeSession({
            cmd, args, env, timeoutSecs,
            threadParams: { approvalPolicy: 'never', cwd: dirA, runtimeWorkspaceRoots: [dirB] },
            buildTurnParams: (threadId) => ({
              threadId,
              input: [{ type: 'text', text: `Run this exact shell command and report its output verbatim: ${command}` }],
              sandboxPolicy: POLICY_BASE,
            }),
          });
          fifthWrote = fs.existsSync(target);
          // R2: this arm used to look at nothing but `fs.existsSync`. Its NEGATIVE
          // branch therefore appended "também não escreveu" to the primary verdict
          // with no way to tell a sandbox denial from a model that never ran the
          // command. Collect the same evidence the four main arms carry.
          fifthItems = (fifth.items || [])
            .filter(entry => entry && entry.item && entry.item.type === 'commandExecution')
            .map(entry => entry.item);
        } catch (error) {
          fifthError = error.message.replace(/\n/g, ' ');
        }
      }
      const fifthExec = armExecution({ exists: fifthWrote, items: fifthItems, target }, null);
      process.stdout.write(`# GROUND TRUTH — RUNTIME-ROOTS target exists after turn: ${fifthWrote} (error=${JSON.stringify(fifthError)})\n`);
      process.stdout.write(`# RUNTIME-ROOTS commandExecution items: ${JSON.stringify(fifthItems)}\n# RUNTIME-ROOTS evidência de execução: ${fifthExec.kind} — ${fifthExec.detail}\n`);
      // ONE caveat string for BOTH branches (Decisão 6 + review R2): the weaker
      // posture is a property of the ARM, not of the outcome, so it cannot live only
      // where the arm happened to write.
      const FIFTH_CAVEAT = 'CAVEAT PROBATÓRIO OBRIGATÓRIO: runtimeWorkspaceRoots NÃO é coberto pelo schema pinado (shared/schemas/codex-appserver-pin.json não modela params de ThreadStart) e este braço não tem controle positivo próprio (nada análogo ao CTRL-ATTEMPT) — postura probatória MAIS FRACA que a da ladder de quatro braços, e não deve ser reportado com a mesma confiança.';
      if (fifthWrote) {
        printVerdict('crossroot-write', CROSSROOT_VERDICTS.PARCIAL,
          `${reason} PORÉM o braço thread-level escreveu em B com ThreadStartParams.runtimeWorkspaceRoots:[B] (execução evidenciada: ${fifthExec.detail}). ${FIFTH_CAVEAT} Versão do binário: ${binaryVersion}.`);
        return;
      }
      // An absence here is only reportable as "did not write" if the command is
      // evidenced to have run at all.
      let fifthPhrase;
      if (fifthError) {
        fifthPhrase = `NÃO FOI MEDIDO (${fifthError})`;
      } else if (fifthExec.kind === CROSSROOT_EXEC.NONE) {
        fifthPhrase = `NÃO FOI MEDIDO: o alvo não apareceu, mas não há evidência de execução do braço (${fifthExec.detail}) — "não escreveu" seria indistinguível de "o modelo não rodou o comando"`;
      } else {
        fifthPhrase = `não escreveu (execução evidenciada: ${fifthExec.detail})`;
      }
      printVerdict('crossroot-write', verdict,
        `${reason} O braço thread-level runtimeWorkspaceRoots também ${fifthPhrase}. ${FIFTH_CAVEAT} Versão do binário: ${binaryVersion}.`);
      return;
    }

    printVerdict('crossroot-write', verdict, `${reason} Versão do binário: ${binaryVersion}.`);
  } finally {
    cleanup();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.error) {
    process.stderr.write(`forge-appserver-probe: ${opts.error}\n`);
    process.stderr.write(`Usage: forge-appserver-probe --probe <${PROBES.join('|')}> [--timeout <seconds>]\n`);
    process.exitCode = 2;
    return;
  }
  if (opts.probe === 'handshake') await probeHandshake(opts);
  else if (opts.probe === 'a1') await probeA1(opts);
  else if (opts.probe === 'a2') await probeA2(opts);
  else if (opts.probe === 'a4-ok') await runProbeA4Ok(opts);
  else if (opts.probe === 'a4-fail') await runProbeA4Fail(opts);
  else if (opts.probe === 'a4-denied') await runProbeA4Denied(opts);
  else if (opts.probe === 'model-thread-only') await runB3Control('model-thread-only', { ...opts, threadModel: B3_MODEL_A, turnModel: null });
  else if (opts.probe === 'model-turn-only') await runB3Control('model-turn-only', { ...opts, threadModel: null, turnModel: B3_MODEL_A });
  else if (opts.probe === 'model-conflict') await probeModelConflict(opts);
  else if (opts.probe === 'cap-networked') await probeCapNetworked(opts);
  else if (opts.probe === 'cap-workspace') await probeCapWorkspace(opts);
  else if (opts.probe === 'cap-readonly') await probeCapReadonly(opts);
  else if (opts.probe === 'evidence-runtime') await probeEvidenceRuntime(opts);
  else if (opts.probe === 'nongit-write') await probeNonGitWrite(opts);
  else if (opts.probe === 'crossroot-write') await probeCrossRootWrite(opts);
  else await probeNonGitCwd(opts);
}

if (require.main === module) {
  main();
}

module.exports = {
  runProbeHandshake, runProbeSession, resolveCommand,
  runProbeA4Ok, runProbeA4Fail, runProbeA4Denied,
  runCapabilityTurn, probeCapNetworked, probeCapWorkspace, probeCapReadonly,
  probeEvidenceRuntime, EVIDENCE_EXPECTED_EXIT,
  collectModelFields, scopeOfSurface, collectModelReadbacks,
  probeModelConflict, probeNonGitCwd, B3_VERDICTS,
  probeNonGitWrite, NONGIT_WRITE_VERDICTS, shellQuote,
  probeCrossRootWrite, crossRootVerdict, CROSSROOT_VERDICTS,
  armExecution, CROSSROOT_EXEC,
  // Exported so the precondition gate is provable without the sidecar being
  // reachable — same reason crossRootVerdict is pure and exported.
  policyRefusal,
};
