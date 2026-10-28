#!/usr/bin/env node
// forge-claude-sidecar.js â€” account-backed Claude execute-process adapter.
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
const workerContract = require('./forge-worker-result-contract');
const streamProtocol = require('./forge-claude-stream');
const calibrationApi = require('./forge-sidecar-calibration');
const calibrationV2 = require('./forge-sidecar-calibration-v2');
const { observation } = calibrationApi;
const liveness = require('./forge-sidecar-liveness');
const { createLocalProof } = require('./forge-sidecar-local-proof');
const claudeSession = require('./forge-claude-session');

const CLAUDE_SIDECAR_REASON_CODES = Object.freeze({
  ACCOUNT_UNAVAILABLE: 'claude-account-unavailable',
  COMMAND_NOT_FOUND: 'claude-command-not-found',
  EXIT_NONZERO: 'claude-exit-nonzero',
  TIMEOUT: 'claude-timeout',
  BUDGET_EXCEEDED: 'budget-exceeded-while-active',
  SILENCE: 'claude-anomalous-silence',
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
  SESSION_MISMATCH: 'claude-session-mismatch',
  SESSION_INVALID: 'claude-session-invalid',
  RESUME_ACCOUNT_MISMATCH: 'claude-resume-account-mismatch',
  RESUME_CONFIG_MISMATCH: 'claude-resume-config-mismatch',
  PERMISSION_POLICY_INVALID: 'claude-permission-policy-invalid',
  PERMISSION_COMMAND_UNSUPPORTED: 'claude-permission-command-unsupported',
  PERMISSION_RESUME_MISMATCH: 'claude-permission-resume-mismatch',
  PERMISSION_CLI_UNVERIFIED: 'claude-permission-cli-unverified',
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
// The only -p text of a same-session resume (S05). The reconciliation that runs
// before a resume restores every root to the attempt baseline, so the resumed
// session remembers edits that may no longer exist on disk.
const CLAUDE_RESUME_INSTRUCTION = 'The previous turn of this same task reached its safety ceiling while it was still '
  + 'active and was stopped. Before this resume, Forge reconciled the workspace to the baseline of the attempt, so edits '
  + 'made earlier in this session may have been reverted. Re-read every file before relying on any earlier edit; the '
  + 'temporary task prompt file no longer exists, so rely on the task as you already read it in this session. Continue '
  + 'the same task and return the required structured_output JSON.';
const TIMEOUT_GRACE_MS = 5000;
const TEMP_DIR_PREFIX = '.forge-claude-sidecar-';
// Only a fallback: forge-xllm always passes the cadence it publishes as
// heartbeat_interval_ms, and the orphan reaper derives staleAfter from that
// published value. A callback wired without a cadence still has to beat.
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15000;
const DEFAULT_LIVENESS_INTERVAL_MS = 1000;
// Progress snapshot cadence (onProgress). Independent of the result-file
// heartbeat above: transitions are emitted immediately, so a 30 s periodic
// snapshot is enough for the host to see the current liveness state.
const DEFAULT_PROGRESS_INTERVAL_MS = 30000;
// Local-proof sampling cadence. Sampling is asynchronous and cached; the 1 s
// watchdog tick only reads the cache and never performs I/O itself.
const DEFAULT_LOCAL_PROOF_INTERVAL_MS = 15000;
// Stand-in when no child pid exists (or the provider cannot be built): the
// platform measured nothing, which is `unavailable`, never a positive proof.
const UNAVAILABLE_LOCAL_PROOF = Object.freeze({ capability: 'unavailable', proof: 'none' });
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
    [CLAUDE_SIDECAR_REASON_CODES.BUDGET_EXCEEDED]: 'The Claude worker was still active when it reached its safety ceiling.',
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
    [CLAUDE_SIDECAR_REASON_CODES.SESSION_MISMATCH]: 'The Claude stream reported a session other than the one Forge started. The result was not accepted.',
    [CLAUDE_SIDECAR_REASON_CODES.SESSION_INVALID]: 'The Claude session reference is invalid. No worker was launched.',
    [CLAUDE_SIDECAR_REASON_CODES.RESUME_ACCOUNT_MISMATCH]: 'The default Claude account differs from the account that started the session. No worker was launched.',
    [CLAUDE_SIDECAR_REASON_CODES.RESUME_CONFIG_MISMATCH]: 'The Claude config dir or workspace differs from the one that started the session. No worker was launched.',
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
function normalizeIntervalMs(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw sidecarError(CLAUDE_SIDECAR_REASON_CODES.INVALID_OPTIONS);
  }
  return value;
}

function normalizeHeartbeatIntervalMs(value) {
  return normalizeIntervalMs(value, DEFAULT_HEARTBEAT_INTERVAL_MS);
}

/** Watchdog cadence (internal; tests inject a short one). Same validation as
 * the heartbeat: a present value is never coerced into a tight loop. */
function normalizeLivenessIntervalMs(value) {
  return normalizeIntervalMs(value, DEFAULT_LIVENESS_INTERVAL_MS);
}

/** Progress snapshot cadence (internal seam; tests inject a short one). */
function normalizeProgressIntervalMs(value) {
  return normalizeIntervalMs(value, DEFAULT_PROGRESS_INTERVAL_MS);
}

/** Local-proof sampling cadence (internal seam; tests inject a short one). */
function normalizeLocalProofIntervalMs(value) {
  return normalizeIntervalMs(value, DEFAULT_LOCAL_PROOF_INTERVAL_MS);
}

/**
 * Roots whose filesystem delta counts as local proof and as a new write: the
 * workspace plus the declared writable roots, exactly what the CLI may write.
 * A read-only unit has none; only the child's CPU can prove life there.
 */
function localProofRoots(cwd, options) {
  if (options.readOnly) return [];
  const extra = Array.isArray(options.writableRoots)
    ? options.writableRoots.filter(root => typeof root === 'string' && root).map(root => path.resolve(root))
    : [];
  return [...new Set([cwd, ...extra])];
}

/** Extra ignored prefixes (Forge result/receipt files); the provider itself
 * always ignores `.git/` and `<root>/.gsd/forge/`. Non-arrays mean none. */
function localProofIgnorePrefixes(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter(item => typeof item === 'string' && item).map(item => path.resolve(item)))]
    : [];
}

/** Only {capability, proof}, plus the opaque sample identity the tracker needs;
 * an invalid provider answer reads as unavailable instead of throwing inside the
 * watchdog tick. */
function currentLocalProof(provider) {
  try {
    const current = provider.current();
    const normalized = liveness.normalizeLocalProof(current);
    return Number.isFinite(current?.sampled_at_ms) ? { ...normalized, sampled_at_ms: current.sampled_at_ms } : normalized;
  } catch {
    return { ...UNAVAILABLE_LOCAL_PROOF };
  }
}

const V2_SOURCES = Object.freeze(['persisted-calibration', 'model-fallback']);
const V2_LIMIT_KEYS = Object.freeze({ initial: 'startMs', gap: 'deadMs' });

/** A resolved v2 dimension (exact or model fallback) carries its own clamped threshold. */
function v2Threshold(calibration, dimension) {
  const d = calibration?.v2?.[dimension];
  return d && Number.isSafeInteger(d.threshold_ms) && V2_SOURCES.includes(d.source) ? d : null;
}

/**
 * Liveness policy for one turn, chosen per dimension without mixing values:
 * v2 exact > v2 model-fallback > v1 gap (S01 rule, deadMs only) > locked default.
 * The v1 initial threshold (always >= 120000) never tightens the 60000 start
 * limit, so it is ignored. An override (tests) can only tighten. Returns the
 * limits and, per dimension, the v2 provenance when v2 set the effective limit.
 */
function livenessPolicyFor(calibration, override) {
  const D = liveness.DEFAULTS;
  const limits = liveness.normalizePolicy(override && typeof override === 'object' ? override : undefined);
  const provenance = { initial: null, gap: null };
  for (const dimension of ['initial', 'gap']) {
    const v2 = v2Threshold(calibration, dimension), key = V2_LIMIT_KEYS[dimension];
    if (v2 && v2.threshold_ms <= limits[key]) {
      limits[key] = v2.threshold_ms;
      provenance[dimension] = { threshold_ms: v2.threshold_ms, source: v2.source };
    }
  }
  const gap = calibration?.v1?.gap;
  if (!v2Threshold(calibration, 'gap') && gap?.calibrated === true && Number.isSafeInteger(gap.threshold_ms)) {
    limits.deadMs = Math.min(limits.deadMs, Math.min(D.deadMs, Math.max(D.suspectMs, gap.threshold_ms)));
  }
  return { limits: liveness.normalizePolicy(limits), provenance };
}

/** Closed calibration block: the state of the effective source per dimension. */
function calibrationView(calibration) {
  const v1 = calibration?.v1, v2 = calibration?.v2;
  const state = dimension => v2Threshold(calibration, dimension) ? v2[dimension].state
    : v1?.[dimension]?.state !== 'uncalibrated' || !v2 ? v1?.[dimension]?.state : v2[dimension].state;
  const v1Effective = !v2Threshold(calibration, 'initial') || !v2Threshold(calibration, 'gap');
  return { diagnostic: v2?.diagnostic || (v1Effective && v1?.diagnostic) || null,
    initial: state('initial'), gap: state('gap') };
}

/** v1 and v2 sources for one identity; the v1 store is only read. */
function readCalibration(input, options) {
  return { v1: calibrationApi.read(input, options), v2: calibrationV2.resolve(input, options),
    // Best-effort censored lower bound; its outcome never reaches the caller.
    censor(dimension, windowMs) {
      try {
        const proposal = calibrationV2.proposeCensored(input, { dimension, window_ms: windowMs });
        calibrationV2.commit(proposal, { fingerprint: proposal.key,
          receipt: `liveness-termination:${proposal.attempt_sha256}` }, options);
      } catch { /* a censored sample is advisory */ }
    } };
}

/** Per-dimension provenance: only a limit below its locked default is calibrated. */
function livenessSource(dimension, thresholdMs) {
  const locked = dimension === 'initial' ? liveness.DEFAULTS.startMs : liveness.DEFAULTS.deadMs;
  return thresholdMs < locked ? liveness.SOURCE_CALIBRATED : liveness.SOURCE_DEFAULT;
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

const TERMINATION_WAIT_MS = 5000;
function defaultTerminate(child) {
  try { child.kill('SIGKILL'); } catch { /* the owned process already exited */ }
}

function runOwnedChild({ cmd, args, cwd, env, timeoutMs, terminateChild, onHeartbeat,
  heartbeatIntervalMs, validateCandidate, signal, requestedModel, resultContract, onProgress, clock, calibration,
  onLiveness, livenessIntervalMs = DEFAULT_LIVENESS_INTERVAL_MS, livenessPolicy,
  proofRoots = [], localProofIgnore = [], localProofFactory = null,
  localProofIntervalMs = DEFAULT_LOCAL_PROOF_INTERVAL_MS, progressIntervalMs = DEFAULT_PROGRESS_INTERVAL_MS }) {
  if (signal?.aborted) return Promise.reject(sidecarError(CLAUDE_SIDECAR_REASON_CODES.CANCELLED));
  let child;
  try {
    child = spawn(cmd, args, { cwd, shell: false, env, stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true, detached: process.platform !== 'win32' });
  } catch (error) { return Promise.reject(mapSpawnError(error)); }

  return new Promise((resolve, reject) => {
    let settled = false, terminationAttempted = false, closed = false, failed = false, spawnFailed = false;
    let resolveExit;
    const exited = new Promise(done => { resolveExit = done; });
    let watchdog, heartbeatTimer, progressTimer, proofTimer, timer, silence = null, transportEnd = null;
    let reportedRemote = false, reportedTerminal = false;
    // Liveness is the primary kill authority (start/silence); timeoutMs is only
    // the safety ceiling, enforced by the tracker on the injected clock and by
    // the real setTimeout backstop below.
    const { limits: policy, provenance } = livenessPolicyFor(calibration, livenessPolicy);
    const calibrationBlock = calibrationView(calibration);
    // A stream cut by liveness or by the ceiling only proves a lower bound. A gap
    // suspended by a tool is an extension by proof, not real silence: no sample.
    function recordCensored(termination, current) {
      try {
        if (current.gap_suspended === true || typeof calibration?.censor !== 'function') return;
        if (termination === 'dead-start') calibration.censor('initial', current.elapsed_ms);
        else if ((termination === 'dead-silence' || termination === 'budget-exceeded-while-active')
          && current.first_remote_ms !== null) calibration.censor('gap', current.remote_silence_ms);
      } catch { /* never alters the termination */ }
    }
    const tracker = liveness.createTracker(policy, timeoutMs);
    // Loop detector: tool-call fingerprints (hashes only) since the last write.
    const progress = liveness.createProgressTracker();
    // Versioned liveness block published in every progress snapshot (S06). It
    // carries only the closed state/reason vocabulary, never fingerprints or text.
    let livenessView = { version: 1, state: 'starting', since_ms: 0, reason: null };
    let livenessTermination = null;
    const reducer = streamProtocol.createReducer({ secret: env[TOKEN_ENV], clock, onRemote: () => {
      if (!reportedRemote) { reportedRemote = true; emit(); }
    }, onEvent: () => {
      if (!reportedTerminal && reducer.snapshot().phase === 'terminal') { reportedTerminal = true; emit(); }
    }, onToolCall: ({ fingerprint }) => {
      try { progress.toolCall(fingerprint); } catch { /* observer only */ }
    } });
    // Local proof of life: sampled asynchronously into a cache, never inside the
    // watchdog tick. Without a child pid there is nothing to measure.
    let proof = { current: () => UNAVAILABLE_LOCAL_PROOF, sample: () => Promise.resolve(), stop() {} };
    if (Number.isSafeInteger(child.pid)) {
      try {
        const provider = (localProofFactory || createLocalProof)({ pid: child.pid, roots: proofRoots,
          ignore: { prefixes: localProofIgnore }, clock, intervalMs: localProofIntervalMs,
          onWrite: () => { try { progress.write(); } catch { /* observer only */ } } });
        if (provider && typeof provider.current === 'function' && typeof provider.sample === 'function') {
          proof = provider;
        }
      } catch { /* a provider that cannot start leaves the proof unavailable */ }
    }
    function sampleProof() {
      try { Promise.resolve(proof.sample()).catch(() => {}); } catch { /* best-effort sampling */ }
    }
    function livenessInputs() {
      const current = currentLocalProof(proof);
      let state;
      try { state = progress.state(); } catch { state = undefined; }
      // sampled_at_ms only reaches the tracker; decisions never carry it.
      return { localProof: { capability: current.capability, proof: current.proof,
        ...(current.sampled_at_ms === undefined ? {} : { sampled_at_ms: current.sampled_at_ms }) }, progress: state };
    }
    const snapshot = () => {
      const current = reducer.snapshot();
      return observation({ ...current, process_exit_observed: closed,
        phase: failed ? 'failed' : closed ? 'closed' : current.phase,
        transport_ms: transportEnd ?? current.transport_ms,
        verification_ms: transportEnd === null ? null : Math.max(0, current.elapsed_ms - transportEnd),
        calibration: calibrationBlock,
        ...(silence ? { silence } : {}),
        liveness: livenessTermination ? { ...livenessView, termination: livenessTermination } : livenessView });
    };
    function bestEffort(callback, value) {
      try { Promise.resolve(callback?.(value)).catch(() => {}); } catch { /* observer only */ }
    }
    function emit() { bestEffort(onProgress, snapshot()); }
    function beat() { bestEffort(onHeartbeat, Number.isSafeInteger(child.pid) ? child.pid : null); }
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watchdog);
      clearInterval(heartbeatTimer);
      clearInterval(progressTimer);
      clearInterval(proofTimer);
      try { proof.stop?.(); } catch { /* best-effort */ }
      signal?.removeEventListener('abort', cancel);
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
      if (!error) { reducer.dispose(); resolve(value); return; }
      failed = true;
      // Only the 'close' event (or a spawn that never produced a process) proves
      // the child is gone; a requested kill never does. Hidden from serialization.
      Object.defineProperty(error, 'awaitExit', { configurable: true, enumerable: false,
        value: waitMs => closed || spawnFailed ? Promise.resolve(true) : Promise.race([exited,
          new Promise(done => { const t = setTimeout(() => done(false), waitMs); t.unref?.(); })]) });
      // Confirmation value only (S05): read through the accessor, never reparsed from stdout.
      if (reducer.sessionId() !== null && error && typeof error === 'object') error.observedSessionId = reducer.sessionId();
      const reasons = { 'claude-timeout': 'provider-timeout', 'claude-cancelled': 'provider-cancelled',
        'claude-exit-nonzero': 'provider-exit', 'claude-auth-failed': 'authentication-failed',
        'claude-output-limit': 'output-limit', 'claude-anomalous-silence': 'anomalous-silence',
        'budget-exceeded-while-active': 'budget-exceeded-while-active' };
      const observed = snapshot();
      error.diagnostic = diagnostic(error.diagnostic?.reason || reasons[error.code] || 'adapter-failed', {
        ...error.diagnostic, observation: observed, stdout_bytes: observed.stdout_bytes,
        stderr_bytes: observed.stderr_bytes, duration_ms: observed.elapsed_ms,
      });
      error.diagnostic.observation = observed;
      emit();
      reducer.dispose();
      reject(error);
    }
    function terminate(error) {
      if (settled) return;
      if (!terminationAttempted) {
        terminationAttempted = true;
        // A requested kill, including its fulfilled promise, never proves exit.
        try { Promise.resolve(terminateChild(child)).catch(() => {}); } catch { /* still unobserved */ }
      }
      finish(error);
    }
    function protocolError(error) {
      const reason = error.reason || 'result-envelope-invalid';
      const code = reason === 'output-limit' ? CLAUDE_SIDECAR_REASON_CODES.OUTPUT_LIMIT
        : reason === 'authentication-failed' ? CLAUDE_SIDECAR_REASON_CODES.AUTH_FAILED
        : reason === 'output-empty' ? CLAUDE_SIDECAR_REASON_CODES.EMPTY_OUTPUT
        : CLAUDE_SIDECAR_REASON_CODES.INVALID_RESULT;
      terminate(sidecarError(code, reason));
    }
    const cancel = () => terminate(sidecarError(CLAUDE_SIDECAR_REASON_CODES.CANCELLED));
    signal?.addEventListener('abort', cancel, { once: true });
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    function ceilingError(decision) {
      // The watchdog passes the decision that already won; the backstop path
      // classifies with the state that held without the ceiling through the same
      // tracker derivation (current proof/progress and earned extension), so a
      // tool whose extension holds is active, not dead, when the ceiling arrives.
      const { state, reason, termination } = decision
        || tracker.assess(reducer.snapshot(), livenessInputs());
      const kind = decision ? termination : liveness.classifyTermination({ cause: 'ceiling', state });
      // A live stream at the ceiling is not a timeout of the destination: it has
      // its own reason code (S03 decision 8). A ceiling reached while still
      // starting (termination null) remains claude-timeout.
      const error = kind === 'budget-exceeded-while-active'
        ? sidecarError(CLAUDE_SIDECAR_REASON_CODES.BUDGET_EXCEEDED, 'budget-exceeded-while-active')
        : sidecarError(CLAUDE_SIDECAR_REASON_CODES.TIMEOUT);
      error.liveness = { version: 1, termination: kind, state, reason };
      if (livenessView.state !== state) {
        livenessView = { version: 1, state, since_ms: livenessView.since_ms, reason: reason ?? null };
      }
      // The final snapshot keeps the active state; a ceiling is not death.
      if (liveness.TERMINATIONS.includes(kind)) {
        livenessTermination = kind;
        recordCensored(kind, reducer.snapshot());
      }
      return error;
    }
    timer = setTimeout(() => { if (!settled) terminate(ceilingError()); }, timeoutMs);
    beat();
    emit();
    if (onHeartbeat) heartbeatTimer = setInterval(beat, heartbeatIntervalMs);
    if (onProgress) progressTimer = setInterval(emit, progressIntervalMs);
    proofTimer = setInterval(sampleProof, localProofIntervalMs);
    proofTimer.unref?.();
    sampleProof();
    // Evaluates current evidence, notifies onLiveness and republishes the view.
    // Shared by the watchdog tick and the terminal paths so the final snapshot
    // never lags behind the last remote event.
    function refreshLiveness() {
      // Synchronous: reads the cached proof and the progress state, no I/O.
      const inputs = livenessInputs();
      const { result, transition } = tracker.evaluate(reducer.snapshot(), inputs);
      if (transition && onLiveness) {
        const loop = transition.to === 'slow-suspect' && transition.reason === 'no-progress'
          && typeof inputs.progress?.fingerprint === 'string';
        bestEffort(onLiveness, loop ? { ...transition, progress: { repeats: inputs.progress.repeats,
          fingerprint_sha256: inputs.progress.fingerprint.slice(0, 16) } } : transition);
      }
      // The initial snapshot already carries starting/0; every other transition
      // is published immediately, after onLiveness.
      if (transition && !(transition.from === null && transition.to === 'starting')) {
        livenessView = { version: 1, state: transition.to, since_ms: transition.at_ms ?? null,
          reason: transition.reason ?? null };
        return { result, transition, published: true };
      }
      return { result, transition, published: false };
    }
    watchdog = setInterval(() => {
      if (settled) return;
      const { result, transition, published } = refreshLiveness();
      if (published) emit();
      if (!result.kill) return;
      if (result.cause === 'liveness') {
        // Every tool kill carries threshold_ms = deadMs, so observation() accepts it.
        const v2 = provenance[result.dimension];
        silence = { dimension: result.dimension, window_ms: result.window_ms, threshold_ms: result.threshold_ms,
          ...(v2 && v2.threshold_ms === result.threshold_ms
            ? { policy: calibrationV2.POLICY, source: v2.source }
            : { policy: liveness.POLICY, source: livenessSource(result.dimension, result.threshold_ms) }),
          cause: 'indeterminate' };
        const error = sidecarError(CLAUDE_SIDECAR_REASON_CODES.SILENCE, 'anomalous-silence');
        if (livenessView.state !== 'dead') {
          livenessView = { version: 1, state: 'dead', since_ms: transition?.at_ms ?? null, reason: result.reason ?? null };
        }
        livenessTermination = result.termination;
        error.liveness = { version: 1, termination: result.termination, state: 'dead', reason: result.reason,
          extension_ms: result.extension_ms ?? null,
          proof: result.proof_capability === undefined ? null
            : { capability: result.proof_capability, proof: result.proof } };
        const current = reducer.snapshot();
        terminate(error);
        recordCensored(result.termination, current);
      } else if (result.cause === 'ceiling') {
        terminate(ceilingError(result));
      }
    }, livenessIntervalMs);
    child.stdout?.on('data', chunk => {
      if (!settled) try { reducer.push(chunk); } catch (error) { protocolError(error); }
    });
    child.stderr?.on('data', chunk => {
      if (!settled) try { reducer.stderr(chunk); } catch (error) { protocolError(error); }
    });
    child.once('error', error => {
      if (!Number.isSafeInteger(child.pid)) spawnFailed = true;
      finish(mapSpawnError(error));
    });
    child.once('close', (code, exitSignal) => {
      closed = true;
      resolveExit(true);
      if (settled) return;
      transportEnd = reducer.snapshot().elapsed_ms;
      try { refreshLiveness(); } catch { /* the view stays at its last published state */ }
      let terminal;
      try { terminal = reducer.end(); }
      catch (error) {
        if (code !== 0 && error.reason !== 'authentication-failed') {
          finish(sidecarError(CLAUDE_SIDECAR_REASON_CODES.EXIT_NONZERO));
        } else protocolError(error);
        return;
      }
      if (code !== 0) { finish(sidecarError(CLAUDE_SIDECAR_REASON_CODES.EXIT_NONZERO)); return; }
      try {
        const observedModel = verifyModelIdentity(terminal.modelUsage, requestedModel);
        const candidate = terminal.structured_output;
        const checked = resultContract.validate(candidate);
        if (!checked.ok) throw sidecarError(CLAUDE_SIDECAR_REASON_CODES.INVALID_RESULT, checked.reason);
        if (validateCandidate) {
          let verdict;
          try { verdict = validateCandidate(candidate); }
          catch { throw sidecarError(CLAUDE_SIDECAR_REASON_CODES.INVALID_RESULT, 'validator-failed'); }
          if (verdict !== true && verdict?.ok !== true) {
            throw sidecarError(CLAUDE_SIDECAR_REASON_CODES.INVALID_RESULT, verdict?.reason || 'validator-failed');
          }
        }
        const observed = observation({ ...snapshot(), model_observed: observedModel });
        bestEffort(onProgress, observed);
        finish(null, { candidate, observedModel, observedSessionId: reducer.sessionId(), metadata: Object.freeze({
          pid: Number.isSafeInteger(child.pid) ? child.pid : null, exit_code: code, signal: exitSignal || null,
          duration_ms: observed.elapsed_ms, stdout_bytes: observed.stdout_bytes, stderr_bytes: observed.stderr_bytes,
          marker_count: 0, command: path.basename(cmd), argv_count: args.length, observation: observed,
        }) });
      } catch (error) {
        if (error.reason) protocolError(error);
        else finish(error);
      }
    });
  });
}

function preSpawnRefusal(code) {
  const refused = sidecarError(code);
  refused.provider_called = false;
  return refused;
}

function invalidLaunchOption() {
  return preSpawnRefusal(CLAUDE_SIDECAR_REASON_CODES.INVALID_OPTIONS);
}

// `session` is absent (legacy argv), exactly `{ persist: true }` or exactly
// `{ resume: ref }`, both only for a plan or execute phase. A resume ref is
// validated first (`claude-session-invalid`), then the phase; every other shape
// is `claude-invalid-options`. All of them refuse before any temp file or spawn.
function sessionMode(session, phase) {
  if (session === undefined || session === null) return { mode: 'none', ref: null };
  if (typeof session !== 'object' || Array.isArray(session)) throw invalidLaunchOption();
  const keys = Object.keys(session);
  if (keys.length !== 1) throw invalidLaunchOption();
  if (keys[0] === 'resume') {
    const ref = session.resume;
    if (!claudeSession.validateSessionRef(ref).ok) {
      throw preSpawnRefusal(CLAUDE_SIDECAR_REASON_CODES.SESSION_INVALID);
    }
    try { claudeSession.assertSessionId(ref.id); }
    catch { throw preSpawnRefusal(CLAUDE_SIDECAR_REASON_CODES.SESSION_INVALID); }
    if (!claudeSession.isEligible({ phase })) throw invalidLaunchOption();
    return { mode: 'resume', ref };
  }
  if (keys[0] !== 'persist' || session.persist !== true) throw invalidLaunchOption();
  if (!claudeSession.isEligible({ phase })) throw invalidLaunchOption();
  return { mode: 'persist', ref: null };
}

// One argv for every mode: start, persisted start and resume differ only in
// `sessionTokens` and the `-p` instruction, so a resume keeps every other
// position (model, effort, add-dir, schema, tools, permissions, settings).
function buildClaudeArgs({ prefixArgs, model, effort, options, cwd, resultContract, sessionTokens, instruction, permissionPolicy }) {
  return [...prefixArgs, ...(model ? ['--model', model] : []),
    ...(options.readOnly && options.contextRoot && path.resolve(options.contextRoot) !== cwd ? ['--add-dir', path.resolve(options.contextRoot)] : []),
    ...(Array.isArray(options.writableRoots) ? options.writableRoots.flatMap(root => ['--add-dir', path.resolve(root)]) : []),
    ...(effort ? ['--effort', effort] : []),
    ...sessionTokens, '--disable-slash-commands',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '', '--settings', CLAUDE_INVOCATION_SETTINGS,
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--json-schema', JSON.stringify(resultContract.schema),
    '--tools', options.readOnly ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Edit,Write,Bash',
    ...(options.readOnly ? ['--allowedTools', 'Read,Glob,Grep'] : ['--permission-mode', 'acceptEdits']),
    ...(permissionPolicy ? ['--allowedTools', ...permissionPolicy.rules] : []),
    '-p', instruction];
}

// Runs the remover and reduces its report to {ok:true} or {ok:false, refused,
// errors}. Paths are config-dir relative; the raw id is masked so only the
// recovery ref ever carries it. Never throws.
function sessionCleanupReport(remover, ref) {
  const mask = (value) => typeof value === 'string' ? value.split(ref.id).join('<session>') : value;
  const entries = (list) => (Array.isArray(list) ? list : []).map((item) => Object.freeze(
    Object.fromEntries(Object.entries(item && typeof item === 'object' ? item : {})
      .filter(([key]) => ['path', 'reason', 'code'].includes(key))
      .map(([key, value]) => [key, mask(value)]))));
  let report;
  try { report = remover(ref); }
  catch (error) {
    report = { ok: false, refused: [], errors: [{ path: '.', code: typeof error?.code === 'string' ? error.code : 'remover-failed' }] };
  }
  if (report && report.ok === true) return Object.freeze({ ok: true });
  return Object.freeze({ ok: false, refused: Object.freeze(entries(report?.refused)),
    errors: Object.freeze(entries(report?.errors)) });
}

/**
 * Launch one Claude worker attempt. There is no retry and no inline fallback.
 *
 * @param {object} opts
 * @param {string} opts.prompt complete task prompt, transported only by file.
 *   Required and non-empty: a vacuous instruction still spawns the real CLI and
 *   spends subscription quota, so absence is a named failure (S03 review R5).
 *   Not required (and ignored) in resume mode, whose instruction is fixed.
 * @param {string} opts.cwd workspace directory that owns the temporary file
 * @param {number} [opts.timeoutMs] parent deadline in milliseconds. This is the
 *   safety ceiling only (the child gets it minus TIMEOUT_GRACE_MS); reaching it
 *   with an active stream rejects with `budget-exceeded-while-active` (diagnostic
 *   reason of the same name); reaching it while still starting rejects with
 *   `claude-timeout`. Both carry `error.liveness.termination`. Start and
 *   silence kills are decided by forge-sidecar-liveness (locked defaults
 *   60000/120000/240000 ms, even without calibration) and reject with
 *   `claude-anomalous-silence` plus `error.liveness.termination`
 *   (`dead-start` | `dead-silence`).
 * @param {number} [opts.timeoutSecs] parent deadline in seconds (same ceiling)
 * @param {(transition:{from:?string,to:string,at_ms:?number,reason:?string})=>void} [opts.onLiveness]
 *   best-effort observer of liveness state transitions; non-functions are ignored.
 * @param {number} [opts.livenessIntervalMs] watchdog cadence (default 1000);
 *   validated as a positive integer when present.
 * @param {{startMs?:number,suspectMs?:number,deadMs?:number,toolExtensionMs?:number}} [opts.livenessPolicy]
 *   override that can only tighten the locked liveness defaults.
 * @param {string[]} [opts.localProofIgnore] absolute path prefixes (Forge
 *   result/receipt files) whose writes never count as local proof or progress;
 *   the provider always ignores `.git/` and `<root>/.gsd/forge/`. A non-array
 *   is treated as empty.
 *
 * Tool waits (a tool_use in flight) depend on the child's local proof of life,
 * sampled every 15000 ms into a cache that the 1 s watchdog only reads. Positive
 * proof (pid alive plus CPU or filesystem delta in cwd/writableRoots) and
 * unavailable proof (the platform cannot measure CPU, e.g. win32; it stays
 * slow-suspect) tolerate at most 660000 ms of silence (deadMs 240000 +
 * toolExtensionMs 420000). No proof where the capability exists, or a dead pid,
 * dies at 240000 ms. Tool kills reject with `claude-anomalous-silence` and
 * `error.liveness.{termination:'dead-silence', reason, extension_ms, proof}`.
 * Five identical tool calls without a new write report one `slow-suspect`
 * transition with reason `no-progress` and `progress:{repeats, fingerprint_sha256}`
 * (16 hex) through onLiveness; it never kills. Internal test seams, not public
 * API: `localProofFactory` replaces createLocalProof and `localProofIntervalMs`
 * replaces the 15000 ms sampling cadence (validated as a positive integer).
 * Every onProgress snapshot carries observation().liveness
 * `{version:1, state, since_ms, reason}` (plus `termination` on the final
 * snapshot of a watchdog kill). Snapshots are emitted every 30000 ms
 * (DEFAULT_PROGRESS_INTERVAL_MS) and immediately on each liveness transition.
 * Internal test seam, not public API: `progressIntervalMs` replaces that
 * cadence; an invalid value is refused before any spawn with provider_called:false.
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
 * @param {{persist:true}} [opts.session] opt-in session persistence, accepted only
 *   for the plan/execute phases (else `claude-invalid-options` before any probe,
 *   temp file or spawn). The argv swaps `--no-session-persistence` for
 *   `--session-id <uuid>` (Forge-generated, strict v4); the stream's
 *   system/init must confirm the same id or the attempt fails with
 *   `claude-session-mismatch`. The session is removed after every outcome
 *   except `budget-exceeded-while-active` under the confirmed id, which keeps it
 *   and sets `error.session` (frozen ref, no token). Success reports
 *   `telemetry.session = {persisted, session_sha256, cleanup}`; a failed removal
 *   after a failure is `error.session_cleanup`. Without `session` the argv is the
 *   legacy one. Internal test seam, not public API: `sessionRemover` replaces
 *   removeSession (validated as a function).
 * @param {{resume:object}} [opts.session] resume mode: `claude -p --resume <id>`
 *   for a ref preserved by a `budget-exceeded-while-active` attempt. Before any
 *   temp file or spawn, and always with `provider_called:false`: an invalid ref
 *   (validateSessionRef/assertSessionId) is `claude-session-invalid`; an
 *   ineligible phase is `claude-invalid-options`; a default account whose name
 *   differs from `ref.account_name` is `claude-resume-account-mismatch`; a
 *   child-env config dir or resolved cwd differing from the ref is
 *   `claude-resume-config-mismatch`. None of these refusals (nor the later
 *   model/thinking/effort/version refusals) removes the session: the recovery
 *   stop owns that cleanup. The argv equals the start argv except for
 *   `--resume <id>` in place of the persistence tokens (never `--session-id`,
 *   `--no-session-persistence` or `--fork-session`) and the fixed
 *   CLAUDE_RESUME_INSTRUCTION as `-p` (no prompt file; telemetry measures the
 *   instruction). Once the attempt starts, the session is removed after every
 *   outcome (at most one resume) and a failure never carries `error.session`;
 *   a different system/init id is `claude-session-mismatch`. Success reports
 *   `telemetry.session = {resumed:true, session_sha256, cleanup}`.
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
  const phase = options.calibrationPhase || (['memory','review','fix','plan'].includes(options.resultProfile) ? options.resultProfile : options.resultProfile === 'preparation' ? 'artifacts' : 'execute');
  // S05 session mode (none | persist | resume). Validated before the version
  // probe, temp file or spawn: an ineligible phase or unknown mode is refused,
  // never downgraded; an invalid resume ref never reaches argv.
  const { mode: sessionModeName, ref: resumeRef } = sessionMode(options.session, phase);
  const permissions = require('./forge-claude-permissions');
  const permissionPolicy = permissions.validatePolicy(options.permissionPolicy, {
    cwd, readOnly: options.readOnly, identity: options.permissionIdentity });
  const permissionDigest = permissionPolicy?.sha256 || null;
  if (resumeRef && (resumeRef.permission_policy_sha256 || null) !== (permissionPolicy?.session_sha256 || null)) {
    throw preSpawnRefusal('claude-permission-resume-mismatch');
  }
  const persistSession = sessionModeName === 'persist';
  // A missing prompt used to become '' and still spawn the real CLI with a
  // vacuous instruction, spending subscription quota to produce an invalid
  // result (S03 review R5). Refuse before any temp file or child exists. A
  // resume sends only the fixed CLAUDE_RESUME_INSTRUCTION.
  if (!resumeRef && (typeof options.prompt !== 'string' || !options.prompt.trim())) {
    throw sidecarError(CLAUDE_SIDECAR_REASON_CODES.MISSING_PROMPT);
  }
  const resultContract = workerContract.contract(options.resultProfile || 'execute', options.resultSchema || options.schema);
  const prompt = resumeRef ? null : options.prompt + '\n\n' + resultContract.instruction('claude-cli');
  const onHeartbeat = typeof options.onHeartbeat === 'function' ? options.onHeartbeat : null;
  const heartbeatIntervalMs = normalizeHeartbeatIntervalMs(options.heartbeatIntervalMs);
  const livenessIntervalMs = normalizeLivenessIntervalMs(options.livenessIntervalMs);
  let progressIntervalMs;
  try { progressIntervalMs = normalizeProgressIntervalMs(options.progressIntervalMs); }
  catch { throw invalidLaunchOption(); }
  const onLiveness = typeof options.onLiveness === 'function' ? options.onLiveness : null;
  if (options.localProofFactory !== undefined && options.localProofFactory !== null
    && typeof options.localProofFactory !== 'function') {
    throw sidecarError(CLAUDE_SIDECAR_REASON_CODES.INVALID_OPTIONS);
  }
  const localProofFactory = options.localProofFactory || null;
  if (options.sessionRemover !== undefined && options.sessionRemover !== null
    && typeof options.sessionRemover !== 'function') {
    throw invalidLaunchOption();
  }
  const sessionRemover = options.sessionRemover || claudeSession.removeSession;
  // The child env is built here (it was built right before spawn) so the
  // session config dir is derived from the env the CLI actually receives.
  const env = buildClaudeSidecarEnv(account, sourceEnv, process.platform);
  let sessionId = null, sessionRef = null;
  if (persistSession) {
    try {
      sessionId = claudeSession.assertSessionId(claudeSession.newSessionId());
      sessionRef = claudeSession.createSessionRef({ id: sessionId, accountName: account.name,
        configDir: claudeSession.configDir(env, process.platform), cwd,
        ...(permissionDigest ? { permissionPolicySha256: permissionPolicy.session_sha256 } : {}) });
    } catch { throw invalidLaunchOption(); }
  } else if (resumeRef) {
    // Same account (by name: the config dir does not change per account), same
    // child-env config dir and same cwd as the session start, or no spawn.
    if (account.name !== resumeRef.account_name) {
      throw preSpawnRefusal(CLAUDE_SIDECAR_REASON_CODES.RESUME_ACCOUNT_MISMATCH);
    }
    if (claudeSession.configDir(env, process.platform) !== resumeRef.config_dir || cwd !== resumeRef.cwd) {
      throw preSpawnRefusal(CLAUDE_SIDECAR_REASON_CODES.RESUME_CONFIG_MISMATCH);
    }
    sessionId = resumeRef.id;
    sessionRef = resumeRef;
  }
  let sessionCleaned = false;
  const cleanupSession = () => {
    if (!sessionRef || sessionCleaned) return null;
    sessionCleaned = true;
    return sessionCleanupReport(sessionRemover, sessionRef);
  };
  const localProofIntervalMs = normalizeLocalProofIntervalMs(options.localProofIntervalMs);
  const proofRoots = localProofRoots(cwd, options);
  const localProofIgnore = localProofIgnorePrefixes(options.localProofIgnore);
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
  // Explicit permission grants also require an observed CLI version. Legacy
  // models without a minimum version keep their previous spawn count.
  let cliVersion = null;
  const policyDiagnostics = [];
  const policy = model ? modelPolicy.transportSupport({ model, transport: 'claude-cli' }) : null;
  if ((policy && policy.min_version) || permissionPolicy) {
    const probeCommand = resolveClaudeCommand(sourceEnv);
    const probed = probeClaudeVersion(probeCommand.cmd, probeCommand.prefixArgs, cwd, sourceEnv,
      typeof options.probeRunner === 'function' ? options.probeRunner : spawnSync);
    if (permissionPolicy && !probed) throw preSpawnRefusal('claude-permission-cli-unverified');
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
    ...(permissionPolicy ? { permission_policy_sha256: permissionDigest,
      permission_rules_count: permissionPolicy.rules.length, managed_permission_policy: 'unknown' } : {}),
  };
  let tempDir = null;
  let primaryError = null;

  try {
    let instruction = CLAUDE_RESUME_INSTRUCTION;
    let promptFile = null;
    if (!resumeRef) {
      tempDir = fs.mkdtempSync(path.join(cwd, TEMP_DIR_PREFIX));
      promptFile = path.join(tempDir, 'prompt.txt');
      fs.writeFileSync(promptFile, prompt, { encoding: 'utf8', mode: 0o600 });
      instruction = 'Read the complete task prompt from this UTF-8 file: '
        + `${JSON.stringify(promptFile)}. Follow it exactly and return the required structured_output JSON.`;
    }
    if (Buffer.byteLength(instruction, 'utf8') > MAX_PROMPT_INSTRUCTION_BYTES) {
      throw sidecarError(CLAUDE_SIDECAR_REASON_CODES.PROMPT_IO);
    }

    const { cmd, prefixArgs } = resolveClaudeCommand(sourceEnv);
    const sessionTokens = resumeRef ? ['--resume', sessionId]
      : persistSession ? ['--session-id', sessionId] : ['--no-session-persistence'];
    if ((permissions.validatePolicy(options.permissionPolicy, {
      cwd, readOnly: options.readOnly, identity: options.permissionIdentity })?.sha256 || null) !== permissionDigest) {
      throw preSpawnRefusal('claude-permission-policy-invalid');
    }
    const args = buildClaudeArgs({ prefixArgs, model, effort, options, cwd, resultContract, sessionTokens, instruction, permissionPolicy });
    // Observe the actual CLI packaging, after instruction/argv construction.
    // Account credentials exist only in env and never enter this measurement.
    // A resume has no prompt file: its packaged context is the fixed instruction.
    require('./forge-attempt-telemetry').observeFinal(options, { cmd, args },
      resumeRef ? instruction : fs.readFileSync(promptFile, 'utf8'), 'claude-cli');
    const { observedModel, observedSessionId, ...output } = await runOwnedChild({
      cmd, args, cwd, env, timeoutMs: childTimeoutMs, terminateChild,
      onHeartbeat, heartbeatIntervalMs, validateCandidate: options.validateCandidate, signal: options.signal,
      requestedModel: model, resultContract, onProgress: options.onProgress, clock: options.monotonicClock,
      calibration: readCalibration({ model, effort: effort || 'medium', phase }, options.calibrationOptions),
      onLiveness, livenessIntervalMs, livenessPolicy: options.livenessPolicy,
      proofRoots, localProofIgnore, localProofFactory, localProofIntervalMs, progressIntervalMs,
    });
    // The stream only confirms the Forge-generated id; it never replaces it.
    if (sessionRef && observedSessionId !== sessionId) {
      throw sidecarError(CLAUDE_SIDECAR_REASON_CODES.SESSION_MISMATCH);
    }
    // Accepted attempts propose v2 samples; commitAccepted dispatches by version.
    const proposal = calibrationV2.propose({ model, effort: effort || 'medium', phase }, output.metadata.observation);
    // A failed removal is reported, never turned into a failure of a valid result.
    const session = sessionRef ? Object.freeze({ [resumeRef ? 'resumed' : 'persisted']: true,
      session_sha256: claudeSession.sessionDigest(sessionId), cleanup: cleanupSession() }) : null;
    return { ...output, telemetry: Object.freeze({ ...telemetryBase,
      model_observed: observedModel, model_observed_source: OBSERVED_MODEL_SOURCE, observation: output.metadata.observation,
      calibration_proposal: proposal, ...(session ? { session } : {}) }) };
  } catch (error) {
    const observedSessionId = error && typeof error === 'object' ? error.observedSessionId : undefined;
    if (error && typeof error === 'object') delete error.observedSessionId;
    const awaitExit = error && typeof error === 'object' ? error.awaitExit : undefined;
    if (error && typeof error === 'object') delete error.awaitExit;
    // Membership in the frozen set, not truthiness: mkdtempSync/writeFileSync
    // above throw native errors that already carry a `.code` (EACCES, ENOSPC,
    // ENOTDIR) and used to escape unwrapped, with a code outside the contract
    // and a path-bearing message (S03 review R2). sidecarError() builds a fresh
    // message, so the original text never reaches the caller.
    primaryError = error && typeof error.code === 'string'
      && CLAUDE_SIDECAR_REASON_CODE_SET.has(error.code)
      ? error : sidecarError(CLAUDE_SIDECAR_REASON_CODES.PROMPT_IO);
    if (sessionRef) {
      // Only an active stream that hit the safety ceiling under the confirmed
      // id keeps its session, for the single same-session resume (S05). A
      // resume never keeps it: at most one resume per unit.
      if (!resumeRef && primaryError.code === CLAUDE_SIDECAR_REASON_CODES.BUDGET_EXCEEDED
        && observedSessionId === sessionId) {
        sessionCleaned = true;
        primaryError.session = sessionRef;
      } else if (typeof awaitExit === 'function'
        && await awaitExit(Number.isSafeInteger(options.terminationWaitMs) && options.terminationWaitMs >= 0
          ? options.terminationWaitMs : TERMINATION_WAIT_MS) !== true) {
        // The owned CLI may still be writing: removing now could be undone by it.
        // Defer to recovery, which removes the session once the process is stopped.
        sessionCleaned = true;
        primaryError.session = sessionRef;
        primaryError.session_cleanup = Object.freeze({ ok: false, pending: true,
          refused: Object.freeze([]), errors: Object.freeze([]) });
      } else {
        const cleanup = cleanupSession();
        if (cleanup && !cleanup.ok) primaryError.session_cleanup = cleanup;
      }
    }
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
  CLAUDE_RESUME_INSTRUCTION,
  TIMEOUT_GRACE_MS,
  TEMP_DIR_PREFIX,
  DEFAULT_PROGRESS_INTERVAL_MS,
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
