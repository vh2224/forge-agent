#!/usr/bin/env node
// forge-claude-sidecar.js — account-backed Claude execute-process adapter.
//
// This module deliberately owns the one credential exception that the generic
// sidecar environment must not learn about. The default Forge account is
// resolved immediately before launch, its token is placed in one child-only env
// slot, and no ambient provider credential is inherited. The worker's stdout is
// private transport: it is bounded, classified, validated, and never echoed.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { resolveLaunch, TOKEN_ENV } = require('./forge-accounts');
const { classifyReturn } = require('./forge-worker-result');

const CLAUDE_SIDECAR_REASON_CODES = Object.freeze({
  ACCOUNT_UNAVAILABLE: 'claude-account-unavailable',
  COMMAND_NOT_FOUND: 'claude-command-not-found',
  EXIT_NONZERO: 'claude-exit-nonzero',
  TIMEOUT: 'claude-timeout',
  EMPTY_OUTPUT: 'claude-empty-output',
  INVALID_RESULT: 'claude-invalid-result',
  SPAWN_FAILED: 'claude-spawn-failed',
  OUTPUT_LIMIT: 'claude-output-limit',
  PROMPT_IO: 'claude-prompt-io',
  CLEANUP_FAILED: 'claude-cleanup-failed',
  MISSING_PROMPT: 'claude-missing-prompt',
  INVALID_OPTIONS: 'claude-invalid-options',
});

// Membership, not truthiness. Native fs errors carry a `.code` too (EACCES,
// ENOSPC, ENOTDIR), so only a code from this frozen set may pass through the
// wrap unchanged (S03 review R2).
const CLAUDE_SIDECAR_REASON_CODE_SET = new Set(Object.values(CLAUDE_SIDECAR_REASON_CODES));

// An explicit allowlist, not a filtered process.env clone. Keep this list local:
// forge-xllm's generic buildSidecarEnv policy intentionally remains token-free.
const CLAUDE_SIDECAR_ENV_ALLOWLIST = Object.freeze([
  'PATH', 'Path', 'HOME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
]);
const WINDOWS_ENV_ALLOWLIST = Object.freeze([
  'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'PATHEXT', 'APPDATA',
  'LOCALAPPDATA', 'USERPROFILE', 'TEMP', 'TMP',
]);
const LINUX_ENV_ALLOWLIST = Object.freeze([
  'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME',
]);

const EXECUTE_STATUS_VALUES = new Set(['done', 'partial', 'blocked']);
const MUST_HAVE_STATUS_VALUES = new Set(['met', 'unmet', 'unknown']);
const MUST_HAVE_SCOPE_VALUES = new Set(['task', 'environment']);
const ENVIRONMENT_REASON_VALUES = new Set([
  'git-commit-required', 'gsd-write-refused', 'out-of-scope-test-failure',
  'network-required', 'sandbox-exec-blocked',
]);

const MAX_CAPTURE_BYTES_PER_STREAM = 1024 * 1024;
const MAX_PROMPT_INSTRUCTION_BYTES = 4096;
const TIMEOUT_GRACE_MS = 5000;
const TEMP_DIR_PREFIX = '.forge-claude-sidecar-';
// Only a fallback: forge-xllm always passes the cadence it publishes as
// heartbeat_interval_ms, and the orphan reaper derives staleAfter from that
// published value. A callback wired without a cadence still has to beat.
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15000;

function sidecarError(code) {
  const messages = {
    [CLAUDE_SIDECAR_REASON_CODES.ACCOUNT_UNAVAILABLE]: 'No usable default Claude account is available.',
    [CLAUDE_SIDECAR_REASON_CODES.COMMAND_NOT_FOUND]: 'The Claude executable could not be started.',
    [CLAUDE_SIDECAR_REASON_CODES.EXIT_NONZERO]: 'The Claude process exited unsuccessfully.',
    [CLAUDE_SIDECAR_REASON_CODES.TIMEOUT]: 'The Claude process exceeded its child deadline.',
    [CLAUDE_SIDECAR_REASON_CODES.EMPTY_OUTPUT]: 'The Claude process returned empty output.',
    [CLAUDE_SIDECAR_REASON_CODES.INVALID_RESULT]: 'The Claude process returned an invalid worker result.',
    [CLAUDE_SIDECAR_REASON_CODES.SPAWN_FAILED]: 'The Claude process could not be spawned.',
    [CLAUDE_SIDECAR_REASON_CODES.OUTPUT_LIMIT]: 'The Claude process exceeded its output limit.',
    [CLAUDE_SIDECAR_REASON_CODES.PROMPT_IO]: 'The Claude prompt file could not be prepared.',
    [CLAUDE_SIDECAR_REASON_CODES.CLEANUP_FAILED]: 'The Claude prompt directory could not be removed.',
    [CLAUDE_SIDECAR_REASON_CODES.MISSING_PROMPT]: 'The Claude sidecar was given no task prompt.',
    [CLAUDE_SIDECAR_REASON_CODES.INVALID_OPTIONS]: 'The Claude sidecar received an invalid launch option.',
  };
  const error = new Error(messages[code] || 'Claude sidecar failure.');
  error.code = code;
  return error;
}

/**
 * Construct the child environment from positive requirements only.
 *
 * @param {{name:string,token:string}} account resolved default account
 * @param {NodeJS.ProcessEnv} [sourceEnv]
 * @param {NodeJS.Platform} [platform]
 * @returns {NodeJS.ProcessEnv}
 */
function buildClaudeSidecarEnv(account, sourceEnv = process.env, platform = process.platform) {
  if (!account || typeof account.name !== 'string' || !account.name.trim()
    || typeof account.token !== 'string' || !account.token) {
    throw sidecarError(CLAUDE_SIDECAR_REASON_CODES.ACCOUNT_UNAVAILABLE);
  }

  const keys = platform === 'win32'
    ? [...CLAUDE_SIDECAR_ENV_ALLOWLIST, ...WINDOWS_ENV_ALLOWLIST]
    : platform === 'linux'
      ? [...CLAUDE_SIDECAR_ENV_ALLOWLIST, ...LINUX_ENV_ALLOWLIST]
      : CLAUDE_SIDECAR_ENV_ALLOWLIST;
  const env = {};
  for (const key of keys) {
    if (sourceEnv && sourceEnv[key] !== undefined) env[key] = sourceEnv[key];
  }
  env.FORGE_ACCOUNT = account.name;
  env[TOKEN_ENV] = account.token;
  return env;
}

/** Resolve an executable plus fixed prefix args without ever invoking a shell. */
function resolveClaudeCommand(sourceEnv = process.env) {
  const override = sourceEnv && sourceEnv.FORGE_XLLM_CLAUDE_BIN;
  if (typeof override === 'string' && override.trim()) {
    return /\.js$/i.test(override)
      ? { cmd: process.execPath, prefixArgs: [override] }
      : { cmd: override, prefixArgs: [] };
  }
  return { cmd: 'claude', prefixArgs: [] };
}

function parentTimeoutMs(opts) {
  const value = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? Math.floor(opts.timeoutMs)
    : Number.isFinite(opts.timeoutSecs) && opts.timeoutSecs > 0
      ? Math.floor(opts.timeoutSecs * 1000)
      : null;
  if (value !== null && value > TIMEOUT_GRACE_MS) return value;
  throw sidecarError(CLAUDE_SIDECAR_REASON_CODES.TIMEOUT);
}

function deriveChildTimeoutMs(parentMs) {
  if (!Number.isFinite(parentMs) || parentMs <= TIMEOUT_GRACE_MS) {
    throw sidecarError(CLAUDE_SIDECAR_REASON_CODES.TIMEOUT);
  }
  return Math.floor(parentMs - TIMEOUT_GRACE_MS);
}

/** Absence keeps the fallback cadence; a present value is validated, never
 * coerced. 0/NaN/negative reach setInterval as a tight loop. */
function normalizeHeartbeatIntervalMs(value) {
  if (value === undefined || value === null) return DEFAULT_HEARTBEAT_INTERVAL_MS;
  if (!Number.isInteger(value) || value <= 0) {
    throw sidecarError(CLAUDE_SIDECAR_REASON_CODES.INVALID_OPTIONS);
  }
  return value;
}

/** The model id is interpolated into argv, so an absent one is legal but a
 * malformed or flag-shaped one is refused rather than silently dropped
 * (S03 review R5). */
function normalizeModel(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().startsWith('-')) {
    throw sidecarError(CLAUDE_SIDECAR_REASON_CODES.INVALID_OPTIONS);
  }
  return value.trim();
}

function normalizeMustHave(item) {
  const normalized = { item: item.item, status: item.status, note: item.note };
  if (Object.prototype.hasOwnProperty.call(item, 'scope')) normalized.scope = item.scope;
  if (Object.prototype.hasOwnProperty.call(item, 'reason')) normalized.reason = item.reason;
  return normalized;
}

function isValidMustHave(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  if (typeof item.item !== 'string' || !MUST_HAVE_STATUS_VALUES.has(item.status)
    || typeof item.note !== 'string') return false;
  if (Object.prototype.hasOwnProperty.call(item, 'scope')
    && !MUST_HAVE_SCOPE_VALUES.has(item.scope)) return false;
  if (Object.prototype.hasOwnProperty.call(item, 'reason')) {
    if (typeof item.reason !== 'string') return false;
    if (item.reason !== '' && !ENVIRONMENT_REASON_VALUES.has(item.reason)) return false;
  }
  if (item.scope === 'environment' && !ENVIRONMENT_REASON_VALUES.has(item.reason)) return false;
  return true;
}

function parseExecuteCandidate(stdout) {
  let classified;
  try {
    classified = classifyReturn(stdout);
  } catch {
    throw sidecarError(CLAUDE_SIDECAR_REASON_CODES.INVALID_RESULT);
  }
  if (!classified || classified.shape !== 'complete'
    || typeof classified.fields.result_json !== 'string') {
    throw sidecarError(CLAUDE_SIDECAR_REASON_CODES.INVALID_RESULT);
  }

  let payload;
  try {
    payload = JSON.parse(classified.fields.result_json);
  } catch {
    throw sidecarError(CLAUDE_SIDECAR_REASON_CODES.INVALID_RESULT);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !EXECUTE_STATUS_VALUES.has(payload.status)
    || typeof payload.summary !== 'string' || !payload.summary.trim()
    || !Array.isArray(payload.must_haves_status)
    || !payload.must_haves_status.every(isValidMustHave)
    || !Array.isArray(payload.files_changed)
    || !payload.files_changed.every((file) => typeof file === 'string')
    || classified.status !== payload.status) {
    throw sidecarError(CLAUDE_SIDECAR_REASON_CODES.INVALID_RESULT);
  }

  return {
    candidate: {
      status: payload.status,
      summary: payload.summary,
      must_haves_status: payload.must_haves_status.map(normalizeMustHave),
      files_changed: payload.files_changed.slice(),
    },
    classification: classified,
  };
}

function mapSpawnError(error) {
  return error && error.code === 'ENOENT'
    ? sidecarError(CLAUDE_SIDECAR_REASON_CODES.COMMAND_NOT_FOUND)
    : sidecarError(CLAUDE_SIDECAR_REASON_CODES.SPAWN_FAILED);
}

function defaultTerminate(child) {
  try { child.kill('SIGKILL'); } catch { /* the owned process already exited */ }
}

function runOwnedChild({ cmd, args, cwd, env, timeoutMs, terminateChild, onHeartbeat, heartbeatIntervalMs }) {
  const startedAt = Date.now();
  let child;
  try {
    child = spawn(cmd, args, {
      cwd,
      shell: false,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
  } catch (error) {
    return Promise.reject(mapSpawnError(error));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let terminationAttempted = false;
    let terminalFailurePending = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutChunks = [];
    let stderrChunks = [];

    const timer = setTimeout(() => {
      terminateOnce(sidecarError(CLAUDE_SIDECAR_REASON_CODES.TIMEOUT));
    }, timeoutMs);

    // The reaper in shared/forge-dispatch.md derives staleAfter from the
    // published cadence and kills on the second consecutive stale-alive, so a
    // healthy turn that only beats once at spawn is reaped at ~60-90s. The
    // beats carry the real child pid and nothing else — never argv, output, or
    // any environment value.
    const beatPid = Number.isInteger(child.pid) ? child.pid : null;
    let heartbeatTimer = null;
    function beat() {
      try { onHeartbeat(beatPid); } catch { /* heartbeat is best-effort */ }
    }
    if (typeof onHeartbeat === 'function' && beatPid) {
      beat();
      heartbeatTimer = setInterval(beat, heartbeatIntervalMs);
    }

    function finish(handler, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Every settle path — resolve, close-nonzero, spawn error, timeout,
      // output limit — funnels through here, so the interval cannot outlive
      // the turn and keep the adapter's event loop alive.
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      handler(value);
    }

    function terminateOnce(error) {
      if (settled || terminalFailurePending) return;
      terminalFailurePending = true;
      stdoutChunks = [];
      stderrChunks = [];
      if (!terminationAttempted) {
        terminationAttempted = true;
        try { terminateChild(child); } catch { /* stable primary error wins */ }
      }
      finish(reject, error);
    }

    function capture(stream, chunk) {
      if (settled || terminalFailurePending) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (stream === 'stdout') {
        stdoutBytes += buffer.length;
        if (stdoutBytes > MAX_CAPTURE_BYTES_PER_STREAM) {
          terminateOnce(sidecarError(CLAUDE_SIDECAR_REASON_CODES.OUTPUT_LIMIT));
          return;
        }
        stdoutChunks.push(buffer);
      } else {
        stderrBytes += buffer.length;
        if (stderrBytes > MAX_CAPTURE_BYTES_PER_STREAM) {
          terminateOnce(sidecarError(CLAUDE_SIDECAR_REASON_CODES.OUTPUT_LIMIT));
          return;
        }
        stderrChunks.push(buffer);
      }
    }

    if (child.stdout) child.stdout.on('data', (chunk) => capture('stdout', chunk));
    if (child.stderr) child.stderr.on('data', (chunk) => capture('stderr', chunk));

    child.once('error', (error) => {
      finish(reject, mapSpawnError(error));
    });
    child.once('close', (code, signal) => {
      if (settled || terminalFailurePending) return;
      if (code !== 0) {
        finish(reject, sidecarError(CLAUDE_SIDECAR_REASON_CODES.EXIT_NONZERO));
        return;
      }
      const stdout = Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8');
      // Captured stderr is intentionally never returned or interpolated into an
      // error. A provider that repeats its environment cannot leak through us.
      stderrChunks = [];
      if (!stdout.trim()) {
        finish(reject, sidecarError(CLAUDE_SIDECAR_REASON_CODES.EMPTY_OUTPUT));
        return;
      }

      let parsed;
      try {
        parsed = parseExecuteCandidate(stdout);
      } catch (error) {
        finish(reject, error);
        return;
      }
      finish(resolve, {
        candidate: parsed.candidate,
        metadata: Object.freeze({
          pid: Number.isInteger(child.pid) ? child.pid : null,
          exit_code: code,
          signal: signal || null,
          duration_ms: Math.max(0, Date.now() - startedAt),
          stdout_bytes: stdoutBytes,
          stderr_bytes: stderrBytes,
          marker_count: parsed.classification.marker_count,
          command: path.basename(cmd),
          argv_count: args.length,
        }),
      });
    });
  });
}

/**
 * Launch one Claude worker attempt. There is no retry and no inline fallback.
 *
 * @param {object} opts
 * @param {string} opts.prompt complete task prompt, transported only by file.
 *   Required and non-empty: a vacuous instruction still spawns the real CLI and
 *   spends subscription quota, so absence is a named failure (S03 review R5).
 * @param {string} opts.cwd workspace directory that owns the temporary file
 * @param {number} [opts.timeoutMs] parent deadline in milliseconds
 * @param {number} [opts.timeoutSecs] parent deadline in seconds
 * @param {string} [opts.model] model id forwarded to the CLI as `--model <id>`.
 *   Rejected when it is not a non-empty string or when it could be read as a
 *   flag, because it is interpolated into argv.
 * @param {(pid:number)=>void} [opts.onHeartbeat] called with the real Claude
 *   child pid at spawn and then on the cadence below until the turn settles.
 * @param {number} [opts.heartbeatIntervalMs] cadence for the callback above,
 *   normally the same value the caller publishes as heartbeat_interval_ms.
 *   Validated as a finite positive integer when present.
 * @param {NodeJS.ProcessEnv} [opts.sourceEnv] process env source (testable allowlist)
 * @param {(child:import('child_process').ChildProcess)=>void} [opts.terminateChild]
 * @returns {Promise<{candidate:object,metadata:object}>}
 */
async function invokeClaudeSidecar(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};

  // The sole production account lookup. No account name can enter through opts,
  // argv, environment, or a fallback branch.
  let account;
  try { account = resolveLaunch(null); }
  catch { throw sidecarError(CLAUDE_SIDECAR_REASON_CODES.ACCOUNT_UNAVAILABLE); }
  if (!account || typeof account.name !== 'string' || !account.name.trim()
    || typeof account.token !== 'string' || !account.token) {
    throw sidecarError(CLAUDE_SIDECAR_REASON_CODES.ACCOUNT_UNAVAILABLE);
  }

  const cwd = path.resolve(typeof options.cwd === 'string' && options.cwd ? options.cwd : process.cwd());
  const sourceEnv = options.sourceEnv && typeof options.sourceEnv === 'object'
    ? options.sourceEnv : process.env;
  const terminateChild = typeof options.terminateChild === 'function'
    ? options.terminateChild : defaultTerminate;
  const childTimeoutMs = deriveChildTimeoutMs(parentTimeoutMs(options));
  // A missing prompt used to become '' and still spawn the real CLI with a
  // vacuous instruction, spending subscription quota to produce an invalid
  // result (S03 review R5). Refuse before any temp file or child exists.
  if (typeof options.prompt !== 'string' || !options.prompt.trim()) {
    throw sidecarError(CLAUDE_SIDECAR_REASON_CODES.MISSING_PROMPT);
  }
  const prompt = options.prompt;
  const onHeartbeat = typeof options.onHeartbeat === 'function' ? options.onHeartbeat : null;
  const heartbeatIntervalMs = normalizeHeartbeatIntervalMs(options.heartbeatIntervalMs);
  const model = normalizeModel(options.model);
  let tempDir = null;
  let primaryError = null;

  try {
    tempDir = fs.mkdtempSync(path.join(cwd, TEMP_DIR_PREFIX));
    const promptFile = path.join(tempDir, 'prompt.txt');
    fs.writeFileSync(promptFile, prompt, { encoding: 'utf8', mode: 0o600 });

    const instruction = 'Read the complete task prompt from this UTF-8 file: '
      + `${JSON.stringify(promptFile)}. Follow it exactly and finish with its required worker-result block.`;
    if (Buffer.byteLength(instruction, 'utf8') > MAX_PROMPT_INSTRUCTION_BYTES) {
      throw sidecarError(CLAUDE_SIDECAR_REASON_CODES.PROMPT_IO);
    }

    const { cmd, prefixArgs } = resolveClaudeCommand(sourceEnv);
    const args = [...prefixArgs, ...(model ? ['--model', model] : []), '-p', instruction];
    const env = buildClaudeSidecarEnv(account, sourceEnv, process.platform);
    return await runOwnedChild({
      cmd, args, cwd, env, timeoutMs: childTimeoutMs, terminateChild,
      onHeartbeat, heartbeatIntervalMs,
    });
  } catch (error) {
    // Membership in the frozen set, not truthiness: mkdtempSync/writeFileSync
    // above throw native errors that already carry a `.code` (EACCES, ENOSPC,
    // ENOTDIR) and used to escape unwrapped, with a code outside the contract
    // and a path-bearing message (S03 review R2). sidecarError() builds a fresh
    // message, so the original text never reaches the caller.
    primaryError = error && typeof error.code === 'string'
      && CLAUDE_SIDECAR_REASON_CODE_SET.has(error.code)
      ? error : sidecarError(CLAUDE_SIDECAR_REASON_CODES.PROMPT_IO);
    throw primaryError;
  } finally {
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 10 });
      } catch {
        if (!primaryError) throw sidecarError(CLAUDE_SIDECAR_REASON_CODES.CLEANUP_FAILED);
      }
    }
  }
}

module.exports = {
  CLAUDE_SIDECAR_REASON_CODES,
  CLAUDE_SIDECAR_ENV_ALLOWLIST,
  MAX_CAPTURE_BYTES_PER_STREAM,
  MAX_PROMPT_INSTRUCTION_BYTES,
  TIMEOUT_GRACE_MS,
  TEMP_DIR_PREFIX,
  buildClaudeSidecarEnv,
  resolveClaudeCommand,
  deriveChildTimeoutMs,
  parseExecuteCandidate,
  invokeClaudeSidecar,
};
