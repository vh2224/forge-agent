#!/usr/bin/env node
'use strict';

/**
 * Minimal stdio client for `codex app-server`.
 *
 * Exports: startAppServerTurn, encodeMessage, decodeLine.
 * CLI: prints usage only; the real probe is deliberately owned by T04.
 */

const { spawn, spawnSync } = require('child_process');
const { StringDecoder } = require('string_decoder');

const STDERR_TAIL_BYTES = 4096;
const DISCARDED_SAMPLE_LIMIT = 5;

// The ONLY TurnStatus that means the turn did what we asked. Measured, not assumed:
// `codex app-server generate-json-schema` (codex-cli 0.144.4) defines
// `v2/TurnStatus = ["completed","interrupted","failed","inProgress"]`, and
// `TurnCompletedNotification = {threadId, turn}` with `turn.id` and `turn.status`
// both REQUIRED. So three of the four statuses can legitimately ride a
// `turn/completed`, and treating the notification's arrival as success reports an
// interrupted or failed turn as `done` (S02 R15).
const TURN_STATUS_SUCCESS = 'completed';

// Retention caps (S02 R16). Everything the session accumulates for the caller grew
// without bound until the turn ended, so a long or hostile turn could grow memory
// without limit. Each cap is paired with a counter in the `retention` census below:
// a cap that truncates silently would replace an unbounded buffer with an unbounded
// LIE, which is the defect class this milestone exists to remove.
const RETENTION_LIMITS = Object.freeze({
  notifications: 5000,
  items: 5000,
  inboundRequests: 500,
  // A turn emits one of these. Anything past 50 is a flood, and the first ones are
  // the ones worth keeping (a match, if it exists, is among them).
  turnCompletions: 50,
  // One JSONL line. Codex items legitimately carry diffs and file contents, so this
  // is generous on purpose; it exists to stop an endless newline-free stream, not to
  // second-guess payload size.
  stdoutLineChars: 4 * 1024 * 1024,
});

// How long a timed-out session waits for the server to answer `turn/interrupt`
// before falling back to SIGKILL. Overridable only via `interruptGraceMs` in
// options, which is test-only in the same sense as forge-xllm's
// `heartbeatIntervalMs`: production never passes it. Deliberately NOT a pref —
// a pref is a contract someone has to maintain, and nobody would ever tune this.
const INTERRUPT_GRACE_MS = 2000;

// The outcome of the interrupt attempt is the ONLY thing that distinguishes
// "we asked the server to stop and it did" from "we killed it without warning".
// If this were absent, undefined, or a free-form sentence, those two would be
// indistinguishable in the reported error — which is the exact silent-failure
// shape this milestone exists to remove. Every value below is followed by the
// SIGKILL fallback: naming the outcome changes the record, never the fate.
const INTERRUPT_OUTCOMES = Object.freeze({
  ACKNOWLEDGED: 'acknowledged',
  ERROR: 'error',
  GRACE_EXPIRED: 'grace-expired',
  UNSENT: 'unsent',
  SKIPPED_NO_TURN_ID: 'skipped:no-turn-id',
});

// Pitfall 7: the app-server wire dialect is JSONL but does not use a jsonrpc
// member. Removing it here is intentional, rather than relying on callers to
// remember an easy-to-miss protocol difference.
function encodeMessage(message) {
  const wireMessage = { ...message };
  delete wireMessage.jsonrpc;
  return `${JSON.stringify(wireMessage)}\n`;
}

// stdout is the protocol channel (codex#7852), so an old banner or diagnostic
// must be observable instead of crashing the stream parser or disappearing.
function decodeLine(line) {
  const text = String(line);
  if (!text.trim()) return { discard: text };
  try {
    return { msg: JSON.parse(text) };
  } catch {
    return { discard: text };
  }
}

// Formal Codex context signals only. Keeping the original notification unchanged is
// intentional: the adapter, not this transport, owns interpretation and validation.
function isContextNotification(message) {
  if (!message || typeof message !== 'object' || typeof message.method !== 'string') return false;
  if (message.method === 'thread/started' || message.method === 'thread/compacted') return true;
  const params = message.params && typeof message.params === 'object' ? message.params : null;
  return !!params && (!!params.context_window || !!params.contextWindow);
}

/**
 * `turn/start` requires `threadId`, and the id only exists AFTER `thread/start`
 * replies — S01 measured the refusal verbatim against the live 0.144.4 server:
 * `Invalid request: missing field \`threadId\``. A caller that must build its turn
 * params before calling us therefore cannot name the thread it is about to talk to.
 *
 * So `turnParams` is resolved late, in two accepted shapes (S02-PLAN decision 3):
 *  - a function `(threadId) => params` — the shape real consumers use (S02 runExecute,
 *    S05 runPlan), because they need the id inside nested fields we must not guess at;
 *  - a plain object — kept for retrocompat, with `threadId` injected when absent. An
 *    explicit `threadId` in the object is NEVER overwritten: a caller resuming a thread
 *    it started elsewhere is stating a fact we have no standing to correct.
 */
function resolveTurnParams(turnParams, threadId) {
  if (typeof turnParams === 'function') return turnParams(threadId);
  const params = { ...(turnParams || {}) };
  if (params.threadId === undefined && threadId !== undefined) params.threadId = threadId;
  return params;
}

/**
 * Keep the last `maxBytes` BYTES of `text` (S07 R3).
 *
 * `String.prototype.slice(-n)` counts UTF-16 code units, so `stderrTail.slice(-4096)`
 * under a constant named `..._BYTES` kept up to 4096 CODE UNITS — which for pt-BR
 * stderr (accented Latin-1 range: 2 bytes each) is up to ~8 KiB, and for emoji or CJK
 * diagnostics up to ~12–16 KiB. Renaming the constant to `_CHARS` was the other option
 * and was rejected: the cap exists to bound what we hold and report in memory, and
 * memory is measured in bytes. So the code is made to match the name, not the reverse.
 *
 * Cutting at an arbitrary byte offset can land mid-character, which would decode to
 * U+FFFD — the exact corruption S02 R14 fixed on stdout. The leading continuation
 * bytes (0b10xxxxxx) are therefore dropped, losing at most one partial character.
 */
function tailBytes(text, maxBytes) {
  const value = String(text);
  const buf = Buffer.from(value, 'utf8');
  if (buf.length <= maxBytes) return value;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xC0) === 0x80) start += 1;
  return buf.subarray(start).toString('utf8');
}

function sessionError(message, details) {
  const error = new Error(`forge-appserver-client: ${message}`);
  if (details) Object.assign(error, details);
  return error;
}

function killProcessTree(child) {
  if (!child || !child.pid) return;
  // A detached POSIX child owns a process group. Killing only app-server leaks
  // tools it spawned; Windows has no negative-pid groups (codex#7852).
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false }); } catch { /* best effort */ }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

/**
 * Run one initialize/thread/turn conversation. All execution dependencies are
 * injected: this module intentionally neither imports forge-xllm nor reads prefs.
 */
function startAppServerTurn(options) {
  const opts = options || {};
  const {
    cmd,
    args = [],
    env = process.env,
    cwd,
    timeoutMs = 30000,
    interruptGraceMs,
    threadParams = {},
    turnParams = {},
    retentionLimits,
    onEvent,
    onSpawn,
  } = opts;
  if (!cmd || typeof cmd !== 'string') {
    return Promise.reject(sessionError('cmd is required'));
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(sessionError('timeoutMs must be a positive number'));
  }
  // Validated exactly like timeoutMs, but only WHEN SUPPLIED: absent means the
  // module default, and rejecting `undefined` would break every real caller.
  if (interruptGraceMs !== undefined && (!Number.isFinite(interruptGraceMs) || interruptGraceMs <= 0)) {
    return Promise.reject(sessionError('interruptGraceMs must be a positive number'));
  }
  const graceMs = interruptGraceMs === undefined ? INTERRUPT_GRACE_MS : interruptGraceMs;
  // Overridable for the same reason and in the same sense as interruptGraceMs: driving
  // a 5000-notification flood through a mock to prove the cap bites would trade a real
  // assertion for a slow one. Production never passes it; each supplied key is
  // validated exactly like timeoutMs, and an unknown key is a caller error rather than
  // a silently ignored setting.
  const limits = { ...RETENTION_LIMITS };
  if (retentionLimits !== undefined) {
    if (!retentionLimits || typeof retentionLimits !== 'object' || Array.isArray(retentionLimits)) {
      return Promise.reject(sessionError('retentionLimits must be an object'));
    }
    for (const [key, value] of Object.entries(retentionLimits)) {
      if (!Object.prototype.hasOwnProperty.call(RETENTION_LIMITS, key)) {
        return Promise.reject(sessionError(`unknown retentionLimits key: ${key}`));
      }
      if (!Number.isInteger(value) || value <= 0) {
        return Promise.reject(sessionError(`retentionLimits.${key} must be a positive integer`));
      }
      limits[key] = value;
    }
  }

  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let timer = null;
    let stdoutBuffer = '';
    let stderrTail = '';
    let nextId = 1;
    // True once a line has overflowed `limits.stdoutLineChars`: the rest of that line,
    // up to and including its newline, is dropped rather than re-parsed as a fresh
    // (and guaranteed-unparseable) line.
    let skippingOversizedLine = false;
    // Once the timeout fires the session is TERMINAL. This latch is what makes that
    // true, and removing it is not cosmetic. It is now the SECOND guard against the
    // same pathology — the status check in the completion path is the first — and it
    // stays deliberately: belt and suspenders is the arbitrated posture here, and T01
    // measured that the two existing latch guards (the watcher and the explicit
    // pre-settle check) are already redundant with each other. What the latch alone
    // still owns is the MESSAGE: during the interrupt grace the session is doomed but
    // not settled, so without it the interrupted completion would settle first and
    // replace the load-bearing `timeout after Ns` with something classifyError reads
    // differently.
    let timedOut = false;
    // `turn/interrupt` params are {threadId, turnId} and BOTH are required, so both
    // must be visible to the timeout handler. They used to live inside the async IIFE,
    // where the timer could not see them at all.
    let threadId;
    let turnId;
    let turnIdSource;
    const pending = new Map();
    const items = [];
    const notifications = [];
    const inboundRequests = [];
    // A census, not a line counter. `count` used to cover only unparseable lines, so
    // the two shapes that actually indicate a protocol violation — valid JSON carrying
    // neither id nor method, and a response to an id nobody is waiting on — vanished
    // with no record at all. Those are precisely the class this counter exists to make
    // observable, so each drop now lands in a named bucket (D8: no silent discard).
    const discarded = {
      count: 0,
      kinds: {
        unparseable: 0, 'non-object': 0, 'no-id-no-method': 0, 'unmatched-response': 0,
        // A line that never ends. The bytes are dropped and the drop is named, in the
        // same census as every other stream-level discard (R16).
        'oversized-line': 0,
      },
      sample: [],
    };
    const discard = (kind, text) => {
      discarded.count += 1;
      discarded.kinds[kind] += 1;
      if (discarded.sample.length < DISCARDED_SAMPLE_LIMIT) discarded.sample.push(text);
    };
    // Same idiom one level up: `discarded` records what never made it out of the
    // stream, `retention` records what was HANDLED in full but not kept. The two are
    // separate because conflating them would report a delivered notification as a
    // protocol violation. Both are always present, including at zero — a census that
    // appears only when non-empty is indistinguishable from a broken counter.
    const retention = { limits: { ...limits }, dropped: { notifications: 0, items: 0, inboundRequests: 0, turnCompletions: 0 } };
    const keep = (list, value, bucket) => {
      if (list.length >= limits[bucket]) { retention.dropped[bucket] += 1; return false; }
      list.push(value);
      return true;
    };
    // Every turn/completed observed, recorded rather than collapsed into a boolean.
    // Deferring the match is not a stylistic choice: real servers (and every mock in
    // this repo) send the turn/start REPLY and the turn/completed notification in the
    // same stdout chunk, and the reply's continuation — the code that assigns turnId —
    // runs in a microtask AFTER the synchronous consumeStdout loop that handled both.
    // Matching at arrival time would therefore see turnId === undefined and reject a
    // perfectly legitimate completion. Matching at CHECK time sees the resolved id.
    const completions = [];
    const recordCompletion = (message) => {
      const params = message.params || {};
      const turn = params.turn || {};
      // Accessor order mirrors readTurnStatus in forge-xllm.js rather than inventing a
      // second convention: the schema requires params.turn, the flat fallback tolerates
      // an older/looser emitter without letting it fabricate a match.
      const id = typeof turn.id === 'string' ? turn.id
        : (typeof params.turnId === 'string' ? params.turnId : null);
      const status = typeof turn.status === 'string' ? turn.status
        : (typeof params.status === 'string' ? params.status : null);
      keep(completions, { id, status }, 'turnCompletions');
    };
    // The latch, derived. `null` means "no completion for THIS turn yet"; a record with
    // a non-success status is still a match — it ends the wait, it just does not end it
    // as a success. An absent id (null) can never equal a turnId string, so a
    // completion that does not name its turn never resolves this session.
    const matchedCompletion = () => {
      if (!turnId) return null;
      for (let i = completions.length - 1; i >= 0; i -= 1) {
        if (completions[i].id === turnId) return completions[i];
      }
      return null;
    };
    const completionCensus = () => {
      const matched = completions.filter(entry => turnId && entry.id === turnId).length;
      return {
        observed: completions.length,
        matched,
        ignored: completions.length - matched,
        dropped: retention.dropped.turnCompletions,
        records: completions.slice(),
      };
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (child && child.stdin) {
        try { child.stdin.end(); } catch { /* stream closed concurrently */ }
      }
    };
    const settle = (fn, value, stopChild) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (stopChild) killProcessTree(child);
      fn(value);
    };
    const fail = (message, details, stopChild) => {
      const tail = tailBytes(stderrTail, STDERR_TAIL_BYTES);
      settle(reject, sessionError(message, { ...details, stderrTail: tail }), stopChild);
    };
    const send = (message) => {
      if (settled || !child || !child.stdin || child.stdin.destroyed) return false;
      try {
        child.stdin.write(encodeMessage(message));
        return true;
      } catch (error) {
        fail(`write failed: ${error.message}`, null, true);
        return false;
      }
    };
    const request = (method, params) => new Promise((requestResolve, requestReject) => {
      const id = nextId++;
      pending.set(id, { resolve: requestResolve, reject: requestReject, method });
      if (!send({ id, method, params })) {
        pending.delete(id);
        // Named so the timeout handler can tell "the stream was already gone"
        // (UNSENT) from "the server answered with an RPC error" (ERROR). Additive
        // field only; no existing caller reads it.
        requestReject(sessionError(`could not send ${method}`, { unsent: true }));
      }
    });
    const rejectInboundRequest = (message) => {
      // Pitfall 6/#21982: id + method is a server request, never a response.
      const record = { id: message.id, method: message.method, params: message.params };
      // Retention is capped; the REPLY below is not. Refusing to answer a request we
      // chose not to remember would leave the server waiting forever.
      keep(inboundRequests, record, 'inboundRequests');
      send({ id: message.id, error: {
        code: -32601,
        message: `forge-appserver-client: inbound request refused: ${message.method}`,
      } });
    };
    const handleMessage = (message) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        discard('non-object', JSON.stringify(message));
        return;
      }
      if (Object.prototype.hasOwnProperty.call(message, 'id') && message.method) {
        rejectInboundRequest(message);
        return;
      }
      if (Object.prototype.hasOwnProperty.call(message, 'id')) {
        const waiter = pending.get(message.id);
        // A reply to an id we never sent (or already settled) is a protocol violation,
        // not noise: record it instead of returning into silence.
        if (!waiter) { discard('unmatched-response', JSON.stringify(message)); return; }
        pending.delete(message.id);
        if (message.error) {
          const rpcError = sessionError(message.error.message || `JSON-RPC error ${message.error.code}`, {
            code: message.error.code,
            rpcError: message.error,
          });
          waiter.reject(rpcError);
        } else {
          waiter.resolve(message.result);
        }
        return;
      }
      if (message.method) {
        keep(notifications, message, 'notifications');
        if (message.method === 'item/completed') keep(items, message.params == null ? message : message.params, 'items');
        // First non-empty source wins, and which one won is recorded rather than
        // inferred: turn/started can arrive BEFORE the turn/start reply, so silently
        // preferring one would make the captured id depend on server timing.
        if (message.method === 'turn/started' && !turnId) {
          const startedId = message.params && message.params.turn ? message.params.turn.id : undefined;
          if (startedId) { turnId = startedId; turnIdSource = 'turn/started'; }
        }
        try { if (typeof onEvent === 'function') onEvent(message); } catch { /* observer cannot control session */ }
        if (message.method === 'turn/completed') recordCompletion(message);
        return;
      }
      // Valid JSON object with neither id nor method: routable by nothing, and until
      // now dropped off the end of this function without a trace.
      discard('no-id-no-method', JSON.stringify(message));
    };
    const consumeStdout = (flush) => {
      let index;
      if (skippingOversizedLine) {
        const end = stdoutBuffer.indexOf('\n');
        if (end === -1) { stdoutBuffer = ''; return; }
        stdoutBuffer = stdoutBuffer.slice(end + 1);
        skippingOversizedLine = false;
      }
      while ((index = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, index);
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        const decoded = decodeLine(line);
        if (decoded.discard !== undefined) discard('unparseable', decoded.discard);
        else handleMessage(decoded.msg);
      }
      if (flush && stdoutBuffer) {
        const decoded = decodeLine(stdoutBuffer);
        stdoutBuffer = '';
        if (decoded.discard !== undefined) discard('unparseable', decoded.discard);
        else handleMessage(decoded.msg);
      }
      // Whatever is left is an INCOMPLETE line. Held forever it is an unbounded
      // buffer, so past the cap it is dropped — with a named record and a readable
      // prefix, because a stream that grows past 4 MiB with no newline is a symptom
      // somebody will have to diagnose from this error alone.
      if (!skippingOversizedLine && stdoutBuffer.length > limits.stdoutLineChars) {
        discard('oversized-line', stdoutBuffer.slice(0, 200));
        stdoutBuffer = '';
        skippingOversizedLine = true;
      }
    };

    try {
      child = spawn(cmd, [...args, 'app-server'], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      fail(`spawn failed: ${error.message}`, null, false);
      return;
    }
    // The pid must escape this module the moment it exists: the adapter's heartbeat
    // (S02 decision 9, timer-driven) and the orphan reaper both key on it, and today
    // the pid is only visible here. Called exactly once, wrapped like onEvent — an
    // observer that throws does not get to take the session down with it.
    try { if (typeof onSpawn === 'function') onSpawn(child.pid); } catch { /* observer cannot control session */ }
    child.on('error', error => fail(`spawn failed: ${error.code || error.message}`, null, true));
    child.stdin.on('error', () => { /* close/error is diagnosed by request or child exit */ });
    // Decode across chunk boundaries: a multibyte character split between two reads
    // decodes to U+FFFD if each chunk is toString()'d on its own. JSON's structural
    // characters are ASCII so parsing survives, which is exactly why the corruption is
    // silent — it lands inside string CONTENT (agentMessage text, pt-BR summaries).
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    child.stdout.on('data', chunk => { stdoutBuffer += stdoutDecoder.write(chunk); consumeStdout(false); });
    child.stdout.on('end', () => { stdoutBuffer += stdoutDecoder.end(); consumeStdout(true); });
    child.stderr.on('data', chunk => {
      stderrTail += stderrDecoder.write(chunk);
      // Byte-counted like the constant says (R3): the old code trimmed at 2x the cap in
      // UTF-16 code units, so accented stderr was held at roughly twice the intended
      // size before the report-time slice trimmed it again, also in code units.
      if (Buffer.byteLength(stderrTail, 'utf8') > STDERR_TAIL_BYTES * 2) {
        stderrTail = tailBytes(stderrTail, STDERR_TAIL_BYTES * 2);
      }
    });
    child.on('close', (code, signal) => {
      // `timedOut` and not merely `settled`: during the interrupt grace the session is
      // already doomed but NOT yet settled, so a child that dies in that window would
      // win the race and replace "timeout after Ns" with an exit message. That would
      // lose the terminal classification measured in forge-xllm's classifyErrorClass.
      //
      // The third clause closes S07 R1, and the window it closes is REAL, not
      // theoretical: settlement is not synchronous with the arrival of turn/completed.
      // The notification is recorded in handleMessage, but the code that settles waits
      // on a 5ms polling interval, so between "the turn finished successfully" and
      // "the promise resolved" there are up to ~5ms in which this handler would fire
      // and reject a SUCCESSFUL turn with an exit message. Every mock in this repo
      // hides it by sleeping 50ms before exiting; a server that exits promptly does
      // not. `pending.size === 0` keeps the guard honest — with a request still
      // outstanding the child's exit means that request will never be answered, and
      // staying silent there would trade a wrong error for a hang until the timeout.
      if (!settled && !timedOut && !(matchedCompletion() && pending.size === 0)) {
        fail(`app-server exited ${signal ? `by signal ${signal}` : `with code ${code}`}`, null, false);
      }
    });
    timer = setTimeout(() => {
      // Set FIRST, before anything that can await: every guard below reads it, and a
      // notification processed while this handler is suspended must already see it.
      timedOut = true;
      const seconds = Number((timeoutMs / 1000).toFixed(3));
      // This string is load-bearing. classifyErrorClass forces `terminal` only for the
      // agy message; this one reaches classifyError, which returns {kind:'unknown',
      // retry:false} => terminal. A different string can be read as `transient` and get
      // a hung turn retried in place. Do not reword it.
      const finish = (outcome) => fail(`timeout after ${seconds}s`, {
        timeoutMs,
        interrupt: outcome,
        turnId: turnId || null,
        turnIdSource: turnIdSource || null,
        turnCompletions: completionCensus(),
        retention,
        discarded,
      }, true);

      // Both params are required by TurnInterruptParams, so with no turn observed there
      // is nothing well-formed to send. The kill still happens — the skip is recorded,
      // not converted into an excuse for doing nothing.
      if (!threadId || !turnId) { finish(INTERRUPT_OUTCOMES.SKIPPED_NO_TURN_ID); return; }

      let graceTimer = null;
      const attempt = request('turn/interrupt', { threadId, turnId });
      // If the grace timer wins the race, this rejection arrives with nobody listening
      // and modern Node terminates the process on unhandledRejection. The race below
      // does not count as a listener once it has already resolved.
      attempt.catch(() => { /* outcome is decided by the race; see GRACE_EXPIRED */ });
      const classified = attempt.then(
        () => INTERRUPT_OUTCOMES.ACKNOWLEDGED,
        (error) => (error && error.unsent ? INTERRUPT_OUTCOMES.UNSENT : INTERRUPT_OUTCOMES.ERROR),
      );
      const graced = new Promise((graceResolve) => {
        graceTimer = setTimeout(() => graceResolve(INTERRUPT_OUTCOMES.GRACE_EXPIRED), graceMs);
      });
      Promise.race([classified, graced]).then((outcome) => {
        if (graceTimer) clearTimeout(graceTimer);
        finish(outcome);
      });
    }, timeoutMs);

    (async () => {
      try {
        const initializeResult = await request('initialize', { clientInfo: { name: 'forge-appserver-client', version: '1' } });
        if (!send({ method: 'initialized', params: {} })) throw sessionError('could not send initialized');
        const threadStartResult = await request('thread/start', threadParams);
        threadId = threadStartResult && threadStartResult.thread ? threadStartResult.thread.id : undefined;
        const turnResult = await request('turn/start', resolveTurnParams(turnParams, threadId));
        // Second source. Only fills the gap left by turn/started, so a server that
        // notified first keeps its attribution instead of having it overwritten.
        if (!turnId && turnResult && turnResult.turn && turnResult.turn.id) {
          turnId = turnResult.turn.id;
          turnIdSource = 'turn/start';
        }
        let completion = matchedCompletion();
        if (!completion) {
          completion = await new Promise((done, failWait) => {
            const watch = setInterval(() => {
              // `timedOut` is checked alongside `settled` because the interrupt grace is
              // a window where the session is doomed but not yet settled. A
              // turn/completed arriving there would otherwise reach done() and resolve.
              if (settled || timedOut) { clearInterval(watch); failWait(sessionError('session ended before turn completed')); }
              else {
                const found = matchedCompletion();
                if (found) { clearInterval(watch); done(found); }
              }
            }, 5);
          });
        }
        // Explicit, not a consequence of the ordering above: ordering does not survive
        // the next refactor, and the cost of it not surviving is a timeout reported as
        // a success.
        // Explicit, not a consequence of the ordering above: ordering does not survive
        // the next refactor, and the cost of it not surviving is a timeout reported as a
        // success. Measured during T01: with BOTH this guard and the watcher guard
        // removed, the interrupt-then-completed scenario resolves instead of rejecting.
        if (timedOut) return;
        // The turn ENDED — that is all the notification proves. Whether it ended the
        // way we asked is `status`, and only `completed` is success (S02 R15): the
        // schema admits `interrupted`, `failed` and `inProgress` on this same
        // notification, and resolving on any of them reports a turn that was killed or
        // that errored as a `done` unit. `null` is here too: a completion with no
        // readable status is not evidence of success, and calling it one would be the
        // same optimism readTurnStatus refuses.
        if (completion.status !== TURN_STATUS_SUCCESS) {
          fail(`turn ended with status ${completion.status === null ? 'unknown' : completion.status}`, {
            turnStatus: completion.status,
            turnId: turnId || null,
            turnCompletions: completionCensus(),
          }, true);
          return;
        }
        settle(resolve, {
          initializeResult,
          threadStartResult,
          turnResult,
          items,
          notifications,
          contextNotifications: notifications.filter(isContextNotification),
          inboundRequests,
          discarded,
          // Additive, and never omitted when empty: a caller must be able to tell "kept
          // everything" from "this field is not reported".
          retention,
          turnStatus: completion.status,
          turnCompletions: completionCensus(),
          stderrTail: tailBytes(stderrTail, STDERR_TAIL_BYTES),
        }, true);
      } catch (error) {
        // `timedOut` as well as `settled`, for the same reason as child.on('close'):
        // the watcher above rejects as soon as the latch trips, and during the grace the
        // session is not settled yet — so this handler would win the race and report
        // "session ended before turn completed" INSTEAD of the timeout, losing both the
        // interrupt outcome and the terminal classification. Measured: without this
        // guard the anchored timeout assertion fails with exactly that message.
        if (!settled && !timedOut) {
          const message = error && error.message ? error.message.replace(/^forge-appserver-client: /, '') : String(error);
          fail(message, error && error.code !== undefined ? { code: error.code, rpcError: error.rpcError } : null, true);
        }
      }
    })();
  });
}

module.exports = {
  startAppServerTurn,
  encodeMessage,
  decodeLine,
  isContextNotification,
  resolveTurnParams,
  // Exported so tests and smoke Section 98 bind to the CONSTANT, never to the literal
  // string. Bound to a literal, a rename would pass silently and the enum would be
  // decoration.
  INTERRUPT_OUTCOMES,
  INTERRUPT_GRACE_MS,
  // Same reason as INTERRUPT_OUTCOMES: tests bind to the constant, never the literal.
  RETENTION_LIMITS,
  TURN_STATUS_SUCCESS,
  STDERR_TAIL_BYTES,
  tailBytes,
};

if (require.main === module) {
  process.stderr.write('Usage: require(\'./forge-appserver-client\').startAppServerTurn(options)\n');
  process.exitCode = 2;
}
