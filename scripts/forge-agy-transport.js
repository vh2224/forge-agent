'use strict';

const fs = require('fs');
const path = require('path');
const { spawn: nativeSpawn } = require('child_process');
const liveness = require('./forge-sidecar-liveness');
const { diagnostic } = require('./forge-sidecar-diagnostic');
const { createReducer } = require('./forge-agy-stream');

// agy review transport: bounded capability probe, argv planning and the async
// process owner for `--output-format stream-json`. Helpers owned by forge-xllm
// are injected (resolveCommand, buildSidecarEnv, terminateChild,
// assertSafeForCmdShell) so this module never imports the adapter back, and it
// never loads Claude/app-server session code (IN-15/D11).

const AGY_REASON_CODES = Object.freeze({
  timeout: 'agy-timeout',
  cancelled: 'agy-cancelled',
  outputLimit: 'agy-output-limit',
  streamInvalid: 'agy-stream-invalid',
  anomalousSilence: 'agy-anomalous-silence',
  exitNonzero: 'agy-exit-nonzero',
  budgetExceeded: 'budget-exceeded-while-active',
  exitUnconfirmed: 'agy-process-exit-unconfirmed',
});
const AGY_LIVENESS = Object.freeze({ supervised: 'stream-json', legacy: 'unsupported-legacy' });
const CAPABILITY_SOURCES = Object.freeze(['advertised', 'not-advertised', 'probe-failed', 'probe-timeout',
  'probe-spawn-failed']);
const EFFORT_VALUES = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const PROBE_DEFAULTS = Object.freeze({ timeoutMs: 5000, maxBytes: 262144 });
const EXIT_WAIT_MS = 2000;
const WATCHDOG_MS = 1000;
const STDERR_TAIL_BYTES = 4096;
const STDERR_SNIPPET = 200;

function requireDeps(deps) {
  for (const name of ['resolveCommand', 'buildSidecarEnv', 'terminateChild', 'assertSafeForCmdShell']) {
    if (!deps || typeof deps[name] !== 'function') throw new TypeError(`agy transport dependency missing: ${name}`);
  }
  return deps;
}

function codedError(message, code, reason, counts, extra = {}) {
  return Object.assign(new Error(message), { code, diagnostic: diagnostic(reason, counts), ...extra });
}

/** R3: the prompt lives under the cwd because `--sandbox` roots the agent there. */
function createPromptFile({ cwd, prompt }) {
  let tmpDir;
  try {
    tmpDir = fs.mkdtempSync(path.join(cwd, '.forge-xllm-'));
  } catch (e) {
    throw new Error(`failed to create tmpdir: ${e.message}`);
  }
  const promptFile = path.join(tmpDir, 'prompt.txt');
  const cleanup = () => {
    // Best-effort: the prompt file contains diff excerpts.
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  try {
    fs.writeFileSync(promptFile, prompt, 'utf8');
  } catch (e) {
    cleanup();
    throw e;
  }
  const inline = `Read the file at ${promptFile} and follow the instructions in it exactly. `
    + 'Your entire response must be ONLY the JSON object it specifies — no prose, no markdown fences.';
  return { tmpDir, promptFile, inline, cleanup };
}

// One option's help region: its own line plus indented continuation lines, up
// to the next option line, a blank line or an unindented section header.
function optionRegion(lines, option) {
  const token = new RegExp(`(^|[\\s,])${option}(?=$|[\\s=,<\\[])`);
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(token);
    if (!match || !/^\s*-/.test(lines[i])) continue;
    const region = [lines[i].slice(match.index + match[1].length)];
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim() || /^\s*-/.test(lines[j]) || !/^\s/.test(lines[j])) break;
      region.push(lines[j]);
    }
    const text = region.join('\n');
    const next = text.match(/\s--[A-Za-z]/);
    return next ? text.slice(0, next.index) : text;
  }
  return null;
}

function hasWord(text, word) {
  return new RegExp(`(^|[^A-Za-z0-9_-])${word}(?![A-Za-z0-9_-])`).test(text);
}

/** Pure: help text only enables known flags; no byte of it ever becomes argv. */
function parseAgyHelp(text) {
  const lines = String(text || '').split(/\r?\n/);
  const output = optionRegion(lines, '--output-format');
  const effort = optionRegion(lines, '--effort');
  return { stream: output !== null && hasWord(output, 'stream-json'), effort: effort !== null,
    effort_values: effort === null ? [] : EFFORT_VALUES.filter(value => hasWord(effort, value)) };
}

function unconfirmedError(pid, cause, extra = {}) {
  return codedError(`agy process exit unconfirmed (pid ${pid})`, AGY_REASON_CODES.exitUnconfirmed,
    'adapter-failed', {}, { ownership_pending: true, ownership: { state: 'pending', pid }, cause_code: cause, ...extra });
}

/** Kill the owned tree once, then wait (bounded) for close; sending a signal is not an exit. */
function terminateAndWait(child, deps, state, waitMs) {
  return new Promise(resolve => {
    let timer = null;
    const done = confirmed => { clearTimeout(timer); resolve(confirmed); };
    // Parent close does not prove that descendants exited (including ignored stdio).
    let killed = false;
    let requesting = true;
    state.onClose = () => { if (!requesting) done(killed); };
    try {
      // A parent signal (ok) is not tree termination: the tree step must report success itself.
      const result = deps.terminateChild(child);
      killed = killed || (result?.ok === true && result.tree_terminated === true);
    } catch { /* unconfirmed ownership */ }
    requesting = false;
    if (state.closed) return done(killed);
    timer = setTimeout(() => done(false), waitMs);
  });
}

/**
 * Bounded `--help` probe, run on every invocation (no cache). A probe whose
 * process was never created or whose exit was observed may answer stream:false;
 * an unconfirmed exit refuses instead, so no fallback starts beside it.
 */
async function probeAgyCapabilities(deps, options = {}) {
  const { resolveCommand, buildSidecarEnv, assertSafeForCmdShell } = requireDeps(deps);
  const spawn = deps.spawn || nativeSpawn;
  const { cwd, envPolicy = 'minimal' } = options;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : PROBE_DEFAULTS.timeoutMs;
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : PROBE_DEFAULTS.maxBytes;
  const exitWaitMs = Number.isSafeInteger(options.exitWaitMs) && options.exitWaitMs > 0 ? options.exitWaitMs : EXIT_WAIT_MS;
  const { cmd, prefixArgs, viaCmdShell } = resolveCommand();
  const argv = [...prefixArgs, '--help'];
  if (viaCmdShell) assertSafeForCmdShell(argv);
  const started = Date.now();
  const outcome = (source, parsed = { stream: false, effort: false, effort_values: [] }, bytes = 0) => ({
    stream: parsed.stream, effort: parsed.effort, effort_values: parsed.effort_values,
    source, help_bytes: bytes, probe_ms: Date.now() - started });

  let child;
  try {
    child = spawn(cmd, argv, {
      cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      detached: process.platform !== 'win32', env: buildSidecarEnv(envPolicy) });
  } catch {
    return outcome('probe-spawn-failed');
  }
  return new Promise((resolve, reject) => {
    const state = { closed: false, onClose: null };
    const parts = [];
    let bytes = 0, failed = null, settled = false, timer = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.removeListener('data', collect);
      child.stderr.removeListener('data', collect);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      state.onClose = null;
      fn(value);
    };
    const abort = async source => {
      if (failed) return;
      failed = source;
      clearTimeout(timer);
      const confirmed = await terminateAndWait(child, deps, state, exitWaitMs);
      if (confirmed) settle(resolve, outcome(source, undefined, bytes));
      else settle(reject, unconfirmedError(child.pid, source, { capability_source: source }));
    };
    const collect = chunk => {
      if (failed) return;
      bytes += chunk.length;
      if (bytes > maxBytes) return abort('probe-failed');
      parts.push(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const onError = () => {
      // No pid: the process was never created, so nothing can still be running.
      if (!Number.isInteger(child.pid)) settle(resolve, outcome('probe-spawn-failed'));
      else abort('probe-failed');
    };
    const onClose = code => {
      state.closed = true;
      if (state.onClose) return state.onClose();
      if (failed || settled) return;
      if (code !== 0) return abort('probe-failed');
      const parsed = parseAgyHelp(Buffer.concat(parts).toString('utf8'));
      settle(resolve, outcome(parsed.stream ? 'advertised' : 'not-advertised', parsed, bytes));
    };
    child.on('error', onError);
    child.on('close', onClose);
    timer = setTimeout(() => abort('probe-timeout'), timeoutMs);
  });
}

/**
 * Pure argv plan. The legacy argv is unchanged; stream flags and `--effort` are
 * added only when the probe advertised them. An explicit effort that cannot be
 * honoured is refused before any provider process, never downgraded.
 */
function planAgyArgs({ probe, effort, model, inline, timeoutSecs }) {
  const args = ['--sandbox', '-p', inline, '--print-timeout', `${timeoutSecs}s`];
  const stream = probe?.stream === true;
  if (stream) args.push('--output-format', 'stream-json');
  if (model) args.push('--model', model);
  if (effort !== undefined && effort !== null) {
    if (!stream || probe.effort !== true || !EFFORT_VALUES.includes(effort)
        || !Array.isArray(probe.effort_values) || !probe.effort_values.includes(effort)) {
      throw Object.assign(new Error('agy cannot honour the explicit effort; no worker was substituted'),
        { code: 'effort-transport-unsupported', provider_called: false });
    }
    args.push('--effort', effort);
  }
  return args;
}

function reducerError(error, counts) {
  const reason = error?.reason;
  if (reason === 'output-limit') {
    return codedError('agy output limit exceeded', AGY_REASON_CODES.outputLimit, 'output-limit', counts);
  }
  if (reason === 'output-empty') {
    return codedError('agy-output-empty', 'agy-output-empty', 'output-empty', counts);
  }
  if (['result-envelope-invalid', 'result-error', 'duplicate-terminal'].includes(reason)) {
    return codedError(`agy stream invalid (${reason})`, AGY_REASON_CODES.streamInvalid, reason, counts);
  }
  return codedError('agy stream invalid', AGY_REASON_CODES.streamInvalid, 'adapter-failed', counts);
}

/**
 * Async owner of one `--output-format stream-json` review process. Liveness uses
 * the neutral tracker with locked DEFAULTS and no local proof; the ceiling is the
 * effective timeout, identical to `--print-timeout`. Success settles only on
 * close with exit 0 and a valid SUCCESS result. Every failure kills the owned
 * tree and waits for close; an unconfirmed exit rejects with ownership pending.
 */
function runAgyStream(deps, options) {
  const { resolveCommand, buildSidecarEnv, assertSafeForCmdShell } = requireDeps(deps);
  const spawn = deps.spawn || nativeSpawn;
  const { cwd, args, timeoutSecs, envPolicy = 'minimal', signal, onHeartbeat, onLiveness } = options;
  const ceilingMs = timeoutSecs * 1000;
  const intervalMs = Number.isSafeInteger(options.livenessIntervalMs) && options.livenessIntervalMs > 0
    ? options.livenessIntervalMs : WATCHDOG_MS;
  const exitWaitMs = Number.isSafeInteger(options.exitWaitMs) && options.exitWaitMs > 0 ? options.exitWaitMs : EXIT_WAIT_MS;
  const { cmd, prefixArgs, viaCmdShell } = resolveCommand();
  if (viaCmdShell) assertSafeForCmdShell([...prefixArgs, ...args]);
  if (signal?.aborted) {
    return Promise.reject(codedError('agy cancelled', AGY_REASON_CODES.cancelled, 'provider-cancelled', {},
      { provider_called: false }));
  }
  const reducer = createReducer({ clock: options.clock });
  const tracker = liveness.createTracker(options.livenessPolicy || liveness.DEFAULTS, ceilingMs);
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const state = { closed: false, onClose: null };
    let settled = false, failing = false, watchdog = null, backstop = null;
    let stderrTail = Buffer.alloc(0), child = null;
    const counts = () => {
      const snap = reducer.snapshot();
      return { stdout_bytes: snap.stdout_bytes, stderr_bytes: snap.stderr_bytes, duration_ms: Date.now() - started };
    };
    const cancel = () => fail(codedError('agy cancelled', AGY_REASON_CODES.cancelled, 'provider-cancelled', counts()));
    const processSignals = options.processSignals !== false;

    function release() {
      clearInterval(watchdog);
      clearTimeout(backstop);
      signal?.removeEventListener?.('abort', cancel);
      if (processSignals) {
        process.removeListener('SIGINT', cancel);
        process.removeListener('SIGTERM', cancel);
      }
    }
    function finish(error, value) {
      if (settled) return;
      settled = true;
      release();
      if (child) {
        child.removeListener('spawn', onSpawn);
        child.removeListener('error', onError);
        child.removeListener('close', onClose);
        child.stdout.removeListener('data', onStdout);
        child.stderr.removeListener('data', onStderr);
      }
      state.onClose = null;
      reducer.dispose();
      if (error) reject(error); else resolve(value);
    }
    async function fail(error) {
      if (settled || failing) return;
      failing = true;
      release();
      if (!child || !Number.isInteger(child.pid)) return finish(error);
      const confirmed = await terminateAndWait(child, deps, state, exitWaitMs);
      finish(confirmed ? error : unconfirmedError(child.pid, error.code));
    }
    function silenceError(result) {
      const termination = liveness.TERMINATIONS.includes(result.termination) ? result.termination
        : liveness.classifyTermination({ cause: 'liveness', state: result.state, dimension: result.dimension });
      return codedError(`agy anomalous silence (${termination})`, AGY_REASON_CODES.anomalousSilence,
        'anomalous-silence', counts(), { liveness: { version: 1, termination, state: result.state, reason: result.reason } });
    }
    function ceilingError(state) {
      if (state === 'working' || state === 'slow-suspect') {
        return codedError(`agy budget exceeded while active after ${timeoutSecs}s`, AGY_REASON_CODES.budgetExceeded,
          'budget-exceeded-while-active', counts(),
          { liveness: { version: 1, termination: 'budget-exceeded-while-active', state, reason: null } });
      }
      return codedError(`agy timeout after ${timeoutSecs}s`, AGY_REASON_CODES.timeout, 'provider-timeout', counts());
    }
    function evaluate() {
      if (settled || failing) return;
      const { result, transition } = tracker.evaluate(reducer.snapshot());
      if (transition && typeof onLiveness === 'function') {
        // Observer only: a throwing observer never changes the session.
        try { onLiveness({ version: 1, state: transition.to, since_ms: transition.at_ms, reason: transition.reason }); } catch { /* ignore */ }
      }
      if (!result.kill) return;
      if (result.cause === 'ceiling') {
        fail(ceilingError(result.termination === 'budget-exceeded-while-active' ? result.state : 'starting'));
      } else fail(silenceError(result));
    }

    try {
      child = spawn(cmd, [...prefixArgs, ...args], {
        cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        detached: process.platform !== 'win32', env: buildSidecarEnv(envPolicy) });
    } catch (e) {
      return finish(new Error(`agy spawn failed: ${e.code || e.message}`));
    }
    function onSpawn() {
      try { if (typeof onHeartbeat === 'function') onHeartbeat(child.pid); } catch { /* observer only */ }
    }
    function onError(e) {
      if (!Number.isInteger(child.pid)) return finish(new Error(`agy spawn failed: ${e.code || e.message}`));
      fail(codedError('agy process error', AGY_REASON_CODES.streamInvalid, 'adapter-failed', counts()));
    }
    function onStdout(chunk) {
      if (settled || failing) return;
      try { reducer.push(chunk); } catch (e) { fail(reducerError(e, counts())); }
    }
    function onStderr(chunk) {
      if (settled || failing) return;
      stderrTail = Buffer.concat([stderrTail, chunk]);
      if (stderrTail.length > STDERR_TAIL_BYTES) stderrTail = stderrTail.subarray(stderrTail.length - STDERR_TAIL_BYTES);
      try { reducer.stderr(chunk); } catch (e) { fail(reducerError(e, counts())); }
    }
    function onClose(code, closeSignal) {
      state.closed = true;
      if (state.onClose) return state.onClose();
      if (settled || failing) return;
      if (code !== 0) {
        const tail = stderrTail.toString('utf8').trim().slice(-STDERR_SNIPPET);
        return fail(codedError(`agy exited ${code ?? closeSignal}${tail ? `: ${tail}` : ''}`,
          AGY_REASON_CODES.exitNonzero, 'provider-exit', counts()));
      }
      let terminal;
      try { terminal = reducer.end(); } catch (e) { return fail(reducerError(e, counts())); }
      finish(null, terminal.text);
    }
    child.on('spawn', onSpawn);
    child.on('error', onError);
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.on('close', onClose);
    signal?.addEventListener?.('abort', cancel, { once: true });
    if (processSignals) {
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
    }
    watchdog = setInterval(evaluate, intervalMs);
    backstop = setTimeout(() => {
      if (settled || failing) return;
      const assessed = tracker.assess(reducer.snapshot());
      fail(assessed.state === 'dead' ? silenceError(assessed) : ceilingError(assessed.state));
    }, ceilingMs);
  });
}

module.exports = { createPromptFile, probeAgyCapabilities, parseAgyHelp, planAgyArgs, runAgyStream,
  AGY_REASON_CODES, AGY_LIVENESS, CAPABILITY_SOURCES, EFFORT_VALUES, PROBE_DEFAULTS };
