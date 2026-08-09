#!/usr/bin/env node
'use strict';

/*
 * forge-transport.js — the `transport` field of the `dispatch` event (TASK-022).
 *
 * MEASURED, and the reason this file exists at all:
 *
 * 1. KIND IS DECIDED BY PRESENCE, NEVER BY A KEY INSIDE THE HANDSHAKE OBJECTS.
 *    `grep -rn 'userAgent|cliVersion' scripts/**` returned ZERO occurrences before
 *    this task: not the client, not the probe, not one test knew the shape a real
 *    `codex-cli 0.144.4` emits. Every app-server mock in the suite answers
 *    `initialize` with `{serverInfo:{name:'mock'}}`; the real server answers with
 *    `{userAgent, codexHome, platformFamily, platformOs}` and NO `serverInfo`. An
 *    extractor keyed on either name passes the whole suite green and returns the
 *    degraded value in production. `initializeResult` and `threadStartResult` can
 *    only exist if a live process answered `initialize` and `thread/start`, so
 *    "observed" and "exists" coincide by construction — deriving the kind from
 *    presence alone is immune to that divergence. Remove the presence rule and
 *    reintroduce a key lookup, and the mock × server divergence becomes able to
 *    report a live app-server session as `unknown` with nothing naming it.
 *
 * 2. THE VERSION CHAIN ENDS IN 'unknown', NEVER IN A PARTIAL STRING. The chain is
 *    threadStartResult.thread.cliVersion → the version token of the LEADING
 *    name/version pair of initializeResult.userAgent → 'unknown'. Leading-token
 *    only, because a real userAgent carries an OS version in its parenthetical
 *    (`codex-cli/0.144.4 (Mac OS 26.5.2; arm64)`) and a greedy match would log the
 *    OS version as the CLI version. Both candidates then pass isSafeVersion: the
 *    value is interpolated into a JSONL line by a shell `echo`, so a version
 *    carrying `"` would break the record it is written into. Only the extracted
 *    version travels — never the raw userAgent, which carries OS and architecture.
 *
 * 3. THE REASON SET IS CLOSED, AND THE DEGRADED VALUE IS ALWAYS NAMED. Absence of
 *    a `transport` field means the record predates TASK-022 — it never means
 *    "in-process" and never means "unknown". `transport_reason` is present only
 *    when `transport === 'unknown'`; drop it and a broken extractor is
 *    indistinguishable from a legacy emitter.
 */

const fs = require('fs');

// Closed sets. A value outside either of these has no meaning to any reader.
const TRANSPORT_KINDS = Object.freeze(['app-server', 'in-process', 'unknown']);
const TRANSPORT_REASONS = Object.freeze([
  'no-result-file',        // result file missing / unreadable / unparseable at emit time
  'no-transport-field',    // result file readable, but no appserver.transport (pre-TASK-022 adapter)
  'handshake-not-observed', // envelope present, handshake objects absent (impossible today by construction)
  'invalid-transport-value', // appserver.transport is a string outside TRANSPORT_KINDS
]);

// Bounded and shell-safe: this value is interpolated into a JSONL line by `echo`.
const SAFE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,31}$/;
// Leading `name/version` pair only — the OS version in the parenthetical must not
// win. The trailing lookahead is load-bearing: without it, `codex-cli/1.0"x` would
// match the safe PREFIX `1.0` and log a truncated version as if it were observed.
// The token must end at whitespace or end-of-string, or there is no version here.
// The name part is `[^\s/]+`, NOT `\S+`: `\S+` is greedy and backtracks to the LAST
// slash of the leading token, so `codex-cli/0.144.4/forged` extracted `forged` and
// `a/b/c/9.9` extracted `9.9` — a falsely OBSERVED version where the `unknown` floor
// is required. A multi-slash form is a format this extractor does not understand.
const USER_AGENT_VERSION_RE = /^[^\s/]+\/([A-Za-z0-9][A-Za-z0-9.+-]*)(?=\s|$)/;

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeVersion(value) {
  return typeof value === 'string' && SAFE_VERSION_RE.test(value);
}

/**
 * Extract the observed CLI version from a resolved app-server session.
 * @param {object} session
 * @returns {string} a safe version token, or 'unknown'
 */
function extractVersion(session) {
  if (!isObject(session)) return 'unknown';
  const thread = isObject(session.threadStartResult) ? session.threadStartResult.thread : null;
  if (isObject(thread) && isSafeVersion(thread.cliVersion)) return thread.cliVersion;
  const init = isObject(session.initializeResult) ? session.initializeResult : null;
  if (init && typeof init.userAgent === 'string') {
    const match = USER_AGENT_VERSION_RE.exec(init.userAgent);
    if (match && isSafeVersion(match[1])) return match[1];
  }
  return 'unknown';
}

/**
 * Derive `{kind, version}` from a resolved app-server session.
 * Kind comes from PRESENCE of both handshake results — no inner key is consulted.
 * @param {object} session
 * @returns {{kind: string, version: string}}
 */
function deriveTransport(session) {
  const observed = isObject(session)
    && isObject(session.initializeResult)
    && isObject(session.threadStartResult);
  return {
    kind: observed ? 'app-server' : 'unknown',
    version: observed ? extractVersion(session) : 'unknown',
  };
}

/**
 * Read the transport triple off an adapter result file, for the emitter fence.
 * Advisory: never throws — an unreadable file is a NAMED reason, not a crash.
 * @param {string} resultFilePath
 * @returns {{transport: string, transport_version?: string, transport_reason?: string}}
 */
function readTransportFromResult(resultFilePath) {
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(resultFilePath, 'utf8'));
  } catch {
    return { transport: 'unknown', transport_reason: 'no-result-file' };
  }
  if (!isObject(parsed)) return { transport: 'unknown', transport_reason: 'no-result-file' };
  const appserver = isObject(parsed.appserver) ? parsed.appserver : null;
  const kind = appserver && typeof appserver.transport === 'string' ? appserver.transport : null;
  if (!kind) return { transport: 'unknown', transport_reason: 'no-transport-field' };
  if (kind === 'unknown') {
    // The one degraded value an in-tree producer writes: forge-xllm.js writes
    // `deriveTransport(session).kind`, which returns 'unknown' on exactly one
    // condition — a handshake result object absent. Carry the adapter's own reason
    // when it named one; otherwise name the condition that produced the value.
    const reason = typeof appserver.transport_reason === 'string'
      && TRANSPORT_REASONS.includes(appserver.transport_reason)
      ? appserver.transport_reason
      : 'handshake-not-observed';
    return { transport: 'unknown', transport_reason: reason };
  }
  if (kind !== 'app-server') {
    // Outside the closed set as far as this reader is concerned. Reporting
    // 'handshake-not-observed' here would assert a measurement nobody made — the
    // honest statement is that the result file said something unreadable. This
    // includes 'in-process': it is a shell literal on the Claude emitter path and
    // never a contractual result-file value, so seeing it here is corruption too.
    return { transport: 'unknown', transport_reason: 'invalid-transport-value' };
  }
  // D4: never omitted for this kind. Absence with `app-server` present would be
  // indistinguishable from an emitter that predates this field.
  const version = isSafeVersion(appserver.transport_version) ? appserver.transport_version : 'unknown';
  return { transport: 'app-server', transport_version: version };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// Contract copied from forge-vcs.js:711-722: unknown --field is a named error on
// stderr with exit 1; a known field prints its value + \n on stdout with exit 0.
// A legitimately ABSENT field (transport_reason on an app-server result) prints an
// empty line and exits 0 — absent is not an error, and the fence's `[ -n ... ]`
// test is what turns it into an omitted JSON key.

const CLI_FIELDS = Object.freeze(['transport', 'transport_version', 'transport_reason']);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) out._.push(arg);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[arg.slice(2)] = argv[++i];
    else out[arg.slice(2)] = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.result !== 'string' || !args.result || args._.length !== 0) {
    process.stderr.write('forge-transport: --result <path> is required\n');
    return 1;
  }
  const payload = readTransportFromResult(args.result);
  if (args.field !== undefined) {
    if (typeof args.field !== 'string' || !CLI_FIELDS.includes(args.field)) {
      process.stderr.write(`forge-transport: unknown --field "${args.field}"\n`);
      return 1;
    }
    const value = Object.prototype.hasOwnProperty.call(payload, args.field) ? payload[args.field] : '';
    process.stdout.write(`${value}\n`);
    return 0;
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  return 0;
}

module.exports = {
  TRANSPORT_KINDS,
  TRANSPORT_REASONS,
  isSafeVersion,
  extractVersion,
  deriveTransport,
  readTransportFromResult,
};

if (require.main === module) process.exitCode = main();
