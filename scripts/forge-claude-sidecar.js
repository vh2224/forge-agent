#!/usr/bin/env node
// forge-claude-sidecar.js — account-backed Claude execute-process adapter.
//
// This module deliberately owns the one credential exception that the generic
// sidecar environment must not learn about. The default Forge account is
// resolved immediately before launch, its token is placed in one child-only env
// slot, and no ambient provider credential is inherited. The worker's stdout is
// private transport: it is bounded, classified, validated, and never echoed.
//
// Transport: `--output-format json`. Stdout is ONE result object; its `result`
// string carries the worker-result block and its `modelUsage` keys are the only
// accepted proof of which model answered. A result is admitted only when that
// metadata names exactly the requested `--model`; anything else is refused
// before the unit validator runs, so it never reaches acceptance or publication.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { resolveLaunch, TOKEN_ENV } = require('./forge-accounts');
const { parseJsonEnvelope } = require('./forge-worker-result');
const { diagnostic, isSafeModelId } = require('./forge-sidecar-diagnostic');
const { isMalformedId } = require('./forge-model-alias');
const modelPolicy = require('./forge-model-policy');

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
  AUTH_FAILED: 'claude-auth-failed',
  CANCELLED: 'claude-cancelled',
  CLI_VERSION_UNSUPPORTED: 'claude-cli-version-unsupported',
  THINKING_TRANSPORT_UNSUPPORTED: 'thinking-transport-unsupported',
  THINKING_DISABLED_INCOMPATIBLE: 'thinking-disabled-incompatible',
  THINKING_ENABLED_INCOMPATIBLE: 'thinking-enabled-incompatible',
  THINKING_MODE_UNKNOWN: 'thinking-mode-unknown',
  EFFORT_UNSUPPORTED_BY_MODEL: 'effort-unsupported-by-model',
  MODEL_REQUIRED: 'claude-model-required',
  MODEL_SUBSTITUTED: 'claude-model-substituted',
  MODEL_UNVERIFIED: 'claude-model-unverified',
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
// Inline invocation settings: `--setting-sources ''` excludes the user, project
// and local settings files. Managed policy is not a setting source; it may still
// apply and is never bypassed. No settings file is changed.
// switchModelsOnFlag:false covers only the classifier-driven switch; an
// availability fallback is detected afterwards through modelUsage, never
// prevented here.
const CLAUDE_INVOCATION_SETTINGS = '{"disableAllHooks":true,"switchModelsOnFlag":false}';
const OBSERVED_MODEL_SOURCE = 'claude-json-modelUsage';
const WORKER_RESULT_MARKER = '---GSD-WORKER-RESULT---';
const AUTH_ERROR_STATUSES = new Set([401, 403]);
const AUTH_TEXT_RE = /\b(?:401|403)\b|authentication[_ -]?(?:failed|error)|invalid[_ -]?(?:token|api[_ -]?key)|please (?:run )?\/login/i;
// Bounds for the decoded secret walk. Exceeding either is undecidable and fails
// closed; a legitimate result envelope is far below both.
const MAX_DECODED_DEPTH = 128;
const MAX_DECODED_NODES = 1000000;
// A full Claude id (`claude-<family>-...`). Anything else is an alias whose
// version the CLI chooses, so no modelUsage key can prove it.
const FULL_CLAUDE_MODEL_RE = /^claude-[a-z0-9]/;
const MODEL_TIER_RE = /(fable|haiku|sonnet|opus)/;

// Fixed texts, exported so forge-xllm classifies them terminal by identity
// rather than by keyword: a refused identity is never retried automatically.
const CLAUDE_IDENTITY_MESSAGES = Object.freeze({
  [CLAUDE_SIDECAR_REASON_CODES.MODEL_REQUIRED]: 'The Claude sidecar requires an explicit model whose identity it can verify. No worker was launched.',
  [CLAUDE_SIDECAR_REASON_CODES.MODEL_SUBSTITUTED]: 'The Claude result reported a model other than the requested one. The result was not accepted.',
  [CLAUDE_SIDECAR_REASON_CODES.MODEL_UNVERIFIED]: 'The Claude result did not prove the requested model. The result was not accepted.',
});

function sidecarError(code, reason, counts) {
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
    [CLAUDE_SIDECAR_REASON_CODES.AUTH_FAILED]: 'Claude authentication failed. Repair the default account with forge-accounts before retrying.',
    [CLAUDE_SIDECAR_REASON_CODES.CANCELLED]: 'The Claude worker was cancelled.',
    [CLAUDE_SIDECAR_REASON_CODES.CLI_VERSION_UNSUPPORTED]: 'The installed Claude CLI is older than the minimum version the model policy requires for this model. No worker was launched.',
    [CLAUDE_SIDECAR_REASON_CODES.THINKING_TRANSPORT_UNSUPPORTED]: 'The requested thinking mode has no documented Claude CLI argument. No worker was launched and no parameter was invented.',
    [CLAUDE_SIDECAR_REASON_CODES.THINKING_DISABLED_INCOMPATIBLE]: 'Disabled thinking is incompatible with this model. No worker was launched.',
    [CLAUDE_SIDECAR_REASON_CODES.THINKING_ENABLED_INCOMPATIBLE]: 'Enabled thinking is incompatible with this model. No worker was launched.',
    [CLAUDE_SIDECAR_REASON_CODES.THINKING_MODE_UNKNOWN]: 'The requested thinking mode is not documented for this model. No worker was launched.',
    [CLAUDE_SIDECAR_REASON_CODES.EFFORT_UNSUPPORTED_BY_MODEL]: 'The requested effort is not documented for this model. No worker was launched and the effort was not lowered.',
    ...CLAUDE_IDENTITY_MESSAGES,
  };
  const error = new Error(messages[code] || 'Claude sidecar failure.');
  error.code = code;
  if (reason) error.diagnostic = diagnostic(reason, counts);
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

/** Environment for the version probe: the same allowlist, never an account. */
function buildClaudeProbeEnv(sourceEnv = process.env, platform = process.platform) {
  const keys = platform === 'win32'
    ? [...CLAUDE_SIDECAR_ENV_ALLOWLIST, ...WINDOWS_ENV_ALLOWLIST]
    : platform === 'linux'
      ? [...CLAUDE_SIDECAR_ENV_ALLOWLIST, ...LINUX_ENV_ALLOWLIST]
      : CLAUDE_SIDECAR_ENV_ALLOWLIST;
  const env = {};
  for (const key of keys) {
    if (sourceEnv && sourceEnv[key] !== undefined) env[key] = sourceEnv[key];
  }
  return env;
}

const VERSION_PROBE_TIMEOUT_MS = 5000;

/**
 * `claude --version` through the same resolved command, shell:false, short
 * timeout, minimal env. Returns the parsed x.y.z or null (probe failed or the
 * output was not parseable). Output is parsed, never echoed.
 */
function probeClaudeVersion(cmd, prefixArgs, cwd, sourceEnv, runner = spawnSync) {
  try {
    const result = runner(cmd, [...prefixArgs, '--version'], {
      cwd, shell: false, env: buildClaudeProbeEnv(sourceEnv, process.platform),
      encoding: 'utf8', timeout: VERSION_PROBE_TIMEOUT_MS, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024,
    });
    if (!result || result.error || result.status !== 0) return null;
    const parsed = modelPolicy.parseVersion(String(result.stdout || ''));
    return parsed ? parsed.join('.') : null;
  } catch {
    return null;
  }
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

function claudeLaunchIdentity({ model, effort } = {}) {
  const modelSent = normalizeModel(model);
  if (effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    throw sidecarError(CLAUDE_SIDECAR_REASON_CODES.INVALID_OPTIONS);
  }
  return { model_sent: modelSent, effort: effort || null };
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

function parseExecuteCandidate(stdout, validateCandidate) {
  const classified = parseJsonEnvelope(stdout);
  const invalid = reason => sidecarError(CLAUDE_SIDECAR_REASON_CODES.INVALID_RESULT, reason,
    { marker_count: classified.marker_count });
  if (!classified.ok) throw invalid(classified.reason);
  const payload = classified.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalid('schema-invalid');
  if (classified.status !== payload.status) throw invalid('status-mismatch');
  if (validateCandidate) {
    let verdict;
    try { verdict = validateCandidate(payload); } catch { throw invalid('validator-failed'); }
    if (verdict !== true && (!verdict || verdict.ok !== true)) {
      throw invalid(verdict && typeof verdict.reason === 'string' ? verdict.reason : 'schema-invalid');
    }
    return { candidate: payload, classification: { marker_count: classified.marker_count } };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !EXECUTE_STATUS_VALUES.has(payload.status)
    || typeof payload.summary !== 'string' || !payload.summary.trim()
    || !Array.isArray(payload.must_haves_status)
    || !payload.must_haves_status.every(isValidMustHave)
    || !Array.isArray(payload.files_changed)
    || !payload.files_changed.every((file) => typeof file === 'string')
    || classified.status !== payload.status) {
    throw invalid('schema-invalid');
  }

  return {
    candidate: {
      status: payload.status,
      summary: payload.summary,
      must_haves_status: payload.must_haves_status.map(normalizeMustHave),
      files_changed: payload.files_changed.slice(),
    },
    classification: { marker_count: classified.marker_count },
  };
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function tryParseJson(text) {
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; }
}

// JSON.parse keeps the LAST of two equal member names, so a second `result` or
// `modelUsage` would silently replace the first. Runs on text that already
// parsed, so it only has to track strings and nesting.
function hasDuplicateMemberNames(text) {
  const stack = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '{') stack.push(new Set());
    else if (char === '[') stack.push(null);
    else if (char === '}' || char === ']') stack.pop();
    else if (char === '"') {
      let end = index + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const members = stack[stack.length - 1];
      if (members) {
        let next = end + 1;
        while (next < text.length && ' \t\n\r'.includes(text[next])) next++;
        if (text[next] === ':') {
          const name = JSON.parse(text.slice(index, end + 1));
          if (members.has(name)) return true;
          members.add(name);
        }
      }
      index = end;
    }
  }
  return false;
}

// Iterative walk over decoded strings AND property names, so a credential
// hidden behind JSON Unicode escapes is found after decoding. Returns null
// when the bounds are exceeded: undecidable, therefore refused.
function decodedContains(value, needle) {
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > MAX_DECODED_NODES || current.depth > MAX_DECODED_DEPTH) return null;
    if (typeof current.value === 'string') {
      if (current.value.includes(needle)) return true;
      continue;
    }
    if (!current.value || typeof current.value !== 'object') continue;
    for (const key of Object.keys(current.value)) {
      if (key.includes(needle)) return true;
      stack.push({ value: current.value[key], depth: current.depth + 1 });
    }
  }
  return false;
}

function assertNoDecodedSecret(value, token) {
  const found = decodedContains(value, token);
  if (found === true) throw sidecarError(CLAUDE_SIDECAR_REASON_CODES.INVALID_RESULT, 'secret-output');
  if (found === null) throw sidecarError(CLAUDE_SIDECAR_REASON_CODES.INVALID_RESULT, 'payload-limit');
}

/**
 * Validate the one Claude CLI result object. Text around it, concatenated or
 * truncated JSON and duplicate member names are `json-invalid`; a run error is
 * `result-error`; any other shape is `result-envelope-invalid`. The worker text
 * is extracted only from an object that passed every check.
 */
function classifyResultEnvelope(decoded, text) {
  if (!decoded.ok || hasDuplicateMemberNames(text)) return { ok: false, reason: 'json-invalid' };
  const envelope = decoded.value;
  if (!isPlainObject(envelope) || envelope.type !== 'result') return { ok: false, reason: 'result-envelope-invalid' };
  if (envelope.is_error === true || (typeof envelope.subtype === 'string' && envelope.subtype !== 'success')) {
    return { ok: false, reason: 'result-error' };
  }
  if (envelope.is_error !== false || envelope.subtype !== 'success' || typeof envelope.result !== 'string') {
    return { ok: false, reason: 'result-envelope-invalid' };
  }
  return { ok: true, envelope };
}

function modelStem(id) {
  return id.toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
}

function modelTier(id) {
  const match = MODEL_TIER_RE.exec(id.toLowerCase());
  return match ? match[1] : null;
}

/**
 * Admit only exactly one well-formed modelUsage key byte-identical to the
 * requested full id. No equivalence is inferred: another date, a `[1m]`
 * suffix, an alias or a neighbouring version of the same family stays
 * unverified, and an auxiliary second model makes the proof ambiguous. A
 * clearly different model is a substitution and names only that validated id.
 *
 * @returns {string} the observed (= requested) model id
 */
function verifyModelIdentity(modelUsage, requested) {
  const unverified = count => sidecarError(CLAUDE_SIDECAR_REASON_CODES.MODEL_UNVERIFIED,
    'model-unverified', { model_count: count });
  if (!isPlainObject(modelUsage)) throw unverified(0);
  const keys = Object.keys(modelUsage);
  if (keys.length !== 1) throw unverified(keys.length);
  const observed = keys[0];
  if (!isSafeModelId(observed) || isMalformedId(observed) || !isPlainObject(modelUsage[observed])) {
    throw unverified(1);
  }
  if (!FULL_CLAUDE_MODEL_RE.test(requested)) throw unverified(1);
  if (observed === requested) return observed;
  const tier = modelTier(observed);
  if (modelStem(observed) === modelStem(requested) || (tier !== null && tier === modelTier(requested))) {
    throw unverified(1);
  }
  throw sidecarError(CLAUDE_SIDECAR_REASON_CODES.MODEL_SUBSTITUTED, 'model-substituted',
    { model_count: 1, model_observed: observed });
}

function mapSpawnError(error) {
  return error && error.code === 'ENOENT'
    ? sidecarError(CLAUDE_SIDECAR_REASON_CODES.COMMAND_NOT_FOUND)
    : sidecarError(CLAUDE_SIDECAR_REASON_CODES.SPAWN_FAILED);
}

function defaultTerminate(child) {
  try { child.kill('SIGKILL'); } catch { /* the owned process already exited */ }
}

function runOwnedChild({ cmd, args, cwd, env, timeoutMs, terminateChild, onHeartbeat, heartbeatIntervalMs, validateCandidate, signal, requestedModel }) {
  if (signal && signal.aborted) return Promise.reject(sidecarError(CLAUDE_SIDECAR_REASON_CODES.CANCELLED));
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
    const cancel = () => terminateOnce(sidecarError(CLAUDE_SIDECAR_REASON_CODES.CANCELLED));
    if (signal) signal.addEventListener('abort', cancel, { once: true });
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);

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
      if (handler === reject) {
        const reasons = {
          'claude-empty-output': 'output-empty', 'claude-output-limit': 'output-limit',
          'claude-exit-nonzero': 'provider-exit', 'claude-auth-failed': 'authentication-failed',
          'claude-timeout': 'provider-timeout', 'claude-cancelled': 'provider-cancelled',
          'claude-command-not-found': 'provider-unavailable', 'claude-spawn-failed': 'provider-unavailable',
          'claude-model-substituted': 'model-substituted', 'claude-model-unverified': 'model-unverified',
        };
        value.diagnostic = diagnostic(value.diagnostic?.reason || reasons[value.code], {
          ...value.diagnostic, stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes,
          duration_ms: Math.max(0, Date.now() - startedAt),
        });
      }
      settled = true;
      clearTimeout(timer);
      // Every settle path — resolve, close-nonzero, spawn error, timeout,
      // output limit — funnels through here, so the interval cannot outlive
      // the turn and keep the adapter's event loop alive.
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      if (signal) signal.removeEventListener('abort', cancel);
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
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
      const stderr = Buffer.concat(stderrChunks, stderrBytes).toString('utf8');
      const stdout = Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8');
      const trimmed = stdout.trim();
      const decoded = trimmed ? tryParseJson(trimmed) : { ok: false };
      // Precedence: auth, exit, raw secret, empty, envelope, decoded secret,
      // identity, unit parser, candidate secret. A JSON stdout decides auth only
      // by its structured status: token counters such as 401 are data there.
      const structuredAuth = decoded.ok && isPlainObject(decoded.value)
        && AUTH_ERROR_STATUSES.has(decoded.value.api_error_status);
      const textAuth = (code !== 0 || !stdout.includes(WORKER_RESULT_MARKER))
        && AUTH_TEXT_RE.test(decoded.ok ? stderr : `${stderr}\n${stdout}`);
      if (structuredAuth || textAuth) {
        finish(reject, sidecarError(CLAUDE_SIDECAR_REASON_CODES.AUTH_FAILED));
        return;
      }
      if (code !== 0) {
        finish(reject, sidecarError(CLAUDE_SIDECAR_REASON_CODES.EXIT_NONZERO));
        return;
      }
      if (stdout.includes(env[TOKEN_ENV]) || stderr.includes(env[TOKEN_ENV])) {
        finish(reject, sidecarError(CLAUDE_SIDECAR_REASON_CODES.INVALID_RESULT, 'secret-output'));
        return;
      }
      // Captured stderr is intentionally never returned or interpolated into an
      // error. A provider that repeats its environment cannot leak through us.
      stderrChunks = [];
      if (!trimmed) {
        finish(reject, sidecarError(CLAUDE_SIDECAR_REASON_CODES.EMPTY_OUTPUT));
        return;
      }

      let parsed;
      let observedModel;
      try {
        const envelope = classifyResultEnvelope(decoded, trimmed);
        if (!envelope.ok) throw sidecarError(CLAUDE_SIDECAR_REASON_CODES.INVALID_RESULT, envelope.reason);
        assertNoDecodedSecret(envelope.envelope, env[TOKEN_ENV]);
        observedModel = verifyModelIdentity(envelope.envelope.modelUsage, requestedModel);
        parsed = parseExecuteCandidate(envelope.envelope.result, validateCandidate);
        assertNoDecodedSecret(parsed.candidate, env[TOKEN_ENV]);
      } catch (error) {
        finish(reject, error);
        return;
      }
      finish(resolve, {
        candidate: parsed.candidate,
        observedModel,
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
 * @param {string} opts.model model id forwarded to the CLI as `--model <id>`.
 *   Required: absence is `claude-model-required` before any spawn, because the
 *   result is admitted only when modelUsage proves this exact id. Rejected when
 *   it is not a non-empty string or when it could be read as a flag, because it
 *   is interpolated into argv.
 * @param {(pid:number)=>void} [opts.onHeartbeat] called with the real Claude
 *   child pid at spawn and then on the cadence below until the turn settles.
 * @param {number} [opts.heartbeatIntervalMs] cadence for the callback above,
 *   normally the same value the caller publishes as heartbeat_interval_ms.
 *   Validated as a finite positive integer when present.
 * @param {NodeJS.ProcessEnv} [opts.sourceEnv] process env source (testable allowlist)
 * @param {(child:import('child_process').ChildProcess)=>void} [opts.terminateChild]
 * @returns {Promise<{candidate:object,metadata:object,telemetry:object}>} telemetry
 *   carries `model_observed` (the proven id) and `model_observed_source`
 *   (`claude-json-modelUsage`); `effort_applied` stays null.
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
  const launchIdentity = claudeLaunchIdentity(options);
  const model = launchIdentity.model_sent;
  const effort = launchIdentity.effort;
  // Without a requested id there is nothing modelUsage could prove, so the
  // turn would be unverifiable by construction. Refuse before any probe,
  // prompt file or spawn.
  if (!model) {
    const refused = sidecarError(CLAUDE_SIDECAR_REASON_CODES.MODEL_REQUIRED, 'model-required');
    refused.provider_called = false;
    throw refused;
  }
  // Direct adapter callers need the same full thinking policy as the resolver.
  // Refuse before the version probe, prompt file or inference child exists.
  const thinking = modelPolicy.evaluateThinking({ model, effort, transport: 'claude-cli',
    mode: typeof options.thinkingRequested === 'string'
      ? options.thinkingRequested.trim().toLowerCase() : options.thinkingRequested });
  if (!thinking.ok) {
    const refused = sidecarError(thinking.reason_code);
    refused.provider_called = false;
    refused.layer = 'model-policy';
    refused.policy = thinking;
    throw refused;
  }
  // Defense in depth for direct adapter callers (review legs through
  // forge-xllm): an effort a documented entry does not list is refused, never
  // sent or lowered. Clamping entries (legacy caps) keep the exact old argv.
  if (model && effort && modelPolicy.applyEffortPolicy({ model, effort }).unsupported) {
    throw sidecarError(CLAUDE_SIDECAR_REASON_CODES.EFFORT_UNSUPPORTED_BY_MODEL);
  }
  // Only a policy entry that declares a minimum CLI version is probed; every
  // other model keeps the exact previous argv and spawn count.
  let cliVersion = null;
  const policyDiagnostics = [];
  const policy = model ? modelPolicy.transportSupport({ model, transport: 'claude-cli' }) : null;
  if (policy && policy.min_version) {
    const probeCommand = resolveClaudeCommand(sourceEnv);
    const probed = probeClaudeVersion(probeCommand.cmd, probeCommand.prefixArgs, cwd, sourceEnv,
      typeof options.probeRunner === 'function' ? options.probeRunner : spawnSync);
    const verdict = modelPolicy.transportSupport({ model, transport: 'claude-cli', cliVersion: probed });
    cliVersion = verdict.cli_version;
    policyDiagnostics.push(...verdict.diagnostics.filter((item) => item.code === 'transport-version-unverified'));
    if (!verdict.supported) {
      const refused = sidecarError(CLAUDE_SIDECAR_REASON_CODES.CLI_VERSION_UNSUPPORTED);
      refused.policy = { cli_version: cliVersion, min_version: verdict.min_version, model };
      throw refused;
    }
  }
  // Adapter arguments plus the one provider observation this transport can
  // prove (modelUsage). Without readback the applied effort stays unknown.
  const telemetryBase = {
    model_argument: model, effort_sent: effort, effort_applied: null, effort_applied_source: null,
    cli_version: cliVersion, policy_diagnostics: policyDiagnostics,
  };
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
    const args = [...prefixArgs, ...(model ? ['--model', model] : []),
      ...(options.readOnly && options.contextRoot && path.resolve(options.contextRoot) !== cwd ? ['--add-dir', path.resolve(options.contextRoot)] : []),
      ...(Array.isArray(options.writableRoots) ? options.writableRoots.flatMap(root => ['--add-dir', path.resolve(root)]) : []),
      ...(effort ? ['--effort', effort] : []),
      '--no-session-persistence', '--disable-slash-commands',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--setting-sources', '', '--settings', CLAUDE_INVOCATION_SETTINGS,
      '--output-format', 'json',
      '--tools', options.readOnly ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Edit,Write,Bash',
      ...(options.readOnly ? ['--allowedTools', 'Read,Glob,Grep'] : ['--permission-mode', 'acceptEdits']),
      '-p', instruction];
    const env = buildClaudeSidecarEnv(account, sourceEnv, process.platform);
    const { observedModel, ...output } = await runOwnedChild({
      cmd, args, cwd, env, timeoutMs: childTimeoutMs, terminateChild,
      onHeartbeat, heartbeatIntervalMs, validateCandidate: options.validateCandidate, signal: options.signal,
      requestedModel: model,
    });
    return { ...output, telemetry: Object.freeze({ ...telemetryBase,
      model_observed: observedModel, model_observed_source: OBSERVED_MODEL_SOURCE }) };
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
  CLAUDE_IDENTITY_MESSAGES,
  CLAUDE_INVOCATION_SETTINGS,
  OBSERVED_MODEL_SOURCE,
  CLAUDE_SIDECAR_ENV_ALLOWLIST,
  MAX_CAPTURE_BYTES_PER_STREAM,
  MAX_PROMPT_INSTRUCTION_BYTES,
  TIMEOUT_GRACE_MS,
  TEMP_DIR_PREFIX,
  buildClaudeSidecarEnv,
  buildClaudeProbeEnv,
  probeClaudeVersion,
  resolveClaudeCommand,
  deriveChildTimeoutMs,
  parseExecuteCandidate,
  classifyResultEnvelope,
  verifyModelIdentity,
  claudeLaunchIdentity,
  invokeClaudeSidecar,
};
