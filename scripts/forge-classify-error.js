#!/usr/bin/env node
/**
 * forge-classify-error.js
 *
 * Deterministic error classifier for Forge orchestrator.
 * Regex constants ported verbatim from GSD-2:
 *   C:/Users/VINICIUS/.gsd/agent/extensions/gsd/error-classifier.js
 *
 * Pure JS, zero npm dependencies. CommonJS (matches scripts/ convention).
 * Output shape: { kind, retry, backoffMs? }
 *   kind     — "permanent"|"rate-limit"|"network"|"stream"|"server"|"connection"|"unknown"
 *   retry    — boolean; true for all transient kinds
 *   backoffMs — number (ms) when retry===true; omitted when retry===false
 */

'use strict';

// ── Regex constants — copied verbatim from GSD-2 error-classifier.js ─────────
const PERMANENT_RE    = /auth|unauthorized|forbidden|invalid.*key|invalid.*api|billing|quota exceeded|account/i;
const RATE_LIMIT_RE   = /rate.?limit|too many requests|429/i;
const NETWORK_RE      = /network|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|fetch failed|connection.*reset|dns/i;
const SERVER_RE       = /internal server error|500|502|503|overloaded|server_error|api_error|service.?unavailable/i;
// ECONNRESET/ECONNREFUSED are in NETWORK_RE (same-model retry first).
const CONNECTION_RE   = /terminated|connection.?refused|other side closed|EPIPE|network.?(?:is\s+)?unavailable|stream_exhausted(?:_without_result)?/i;
// Catch-all for V8 JSON.parse errors: all modern variants end with "in JSON at position \d+".
const STREAM_RE       = /in JSON at position \d+|Unexpected end of JSON|SyntaxError.*JSON/i;
const RESET_DELAY_RE  = /reset in (\d+)s/i;

// ── Classification ────────────────────────────────────────────────────────────
/**
 * Classify an error message into one of the ErrorClass kinds.
 *
 * Classification order (matches GSD-2 precedence — MEM038):
 *  1. Permanent (auth/billing/quota) — unless also rate-limited
 *  2. Rate limit (429, rate.?limit, too many requests)
 *  3. Network (ECONNRESET, ETIMEDOUT, socket hang up, fetch failed, dns)
 *  4. Stream truncation (malformed JSON from mid-stream cut)
 *  5. Server (500/502/503, overloaded, server_error)
 *  6. Connection (terminated, ECONNREFUSED, EPIPE, other side closed)
 *  7. Unknown
 *
 * @param {string} errorMsg     — error string to classify
 * @param {number} [retryAfterMs] — optional caller-supplied delay override
 * @returns {{ kind: string, retry: boolean, backoffMs?: number }}
 */
function classifyError(errorMsg, retryAfterMs) {
  const isPermanent  = PERMANENT_RE.test(errorMsg);
  const isRateLimit  = RATE_LIMIT_RE.test(errorMsg);

  // 1. Permanent — but rate limit takes precedence
  if (isPermanent && !isRateLimit) {
    return { kind: 'permanent', retry: false };
  }

  // 2. Rate limit
  if (isRateLimit) {
    if (retryAfterMs != null && retryAfterMs > 0) {
      return { kind: 'rate-limit', retry: true, backoffMs: retryAfterMs };
    }
    const resetMatch = errorMsg.match(RESET_DELAY_RE);
    const delayMs = resetMatch ? Number(resetMatch[1]) * 1000 : 60_000;
    return { kind: 'rate-limit', retry: true, backoffMs: delayMs };
  }

  // 3. Network errors — same-model retry candidate
  if (NETWORK_RE.test(errorMsg)) {
    return { kind: 'network', retry: true, backoffMs: retryAfterMs ?? 3_000 };
  }

  // 4. Stream truncation — downstream symptom of connection drop
  if (STREAM_RE.test(errorMsg)) {
    return { kind: 'stream', retry: true, backoffMs: retryAfterMs ?? 15_000 };
  }

  // 5. Server errors — try fallback model
  if (SERVER_RE.test(errorMsg)) {
    return { kind: 'server', retry: true, backoffMs: retryAfterMs ?? 30_000 };
  }

  // 6. Connection errors — try fallback model
  if (CONNECTION_RE.test(errorMsg)) {
    return { kind: 'connection', retry: true, backoffMs: retryAfterMs ?? 15_000 };
  }

  // 7. Unknown — stop-loop, surface to user (MEM041)
  // If the raw message is an opaque Claude Code tooling string ("success", "error",
  // "unknown", "ok"), this is a tooling_failure (issue #3588), not a provider error.
  return { kind: 'unknown', retry: false };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
/**
 * Returns true for all transient (auto-resumable) error kinds.
 * @param {{ kind: string }} result
 * @returns {boolean}
 */
function isTransient(result) {
  switch (result.kind) {
    case 'network':
    case 'rate-limit':
    case 'server':
    case 'stream':
    case 'connection':
      return true;
    default:
      return false;
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = { classifyError, isTransient };

// ── CLI entrypoint ────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  let msg = null;
  let retryAfterMs = undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--msg' && args[i + 1] !== undefined) {
      msg = args[++i];
    } else if (args[i] === '--retry-after-ms' && args[i + 1] !== undefined) {
      retryAfterMs = Number(args[++i]);
    }
  }

  if (msg !== null) {
    // --msg flag provided
    console.log(JSON.stringify(classifyError(msg, retryAfterMs)));
  } else {
    // Fallback: read from stdin
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => {
      console.log(JSON.stringify(classifyError(input.trim(), retryAfterMs)));
    });
    // If stdin is a TTY (no pipe), nothing to read — exit cleanly
    if (process.stdin.isTTY) {
      console.log(JSON.stringify(classifyError('', retryAfterMs)));
    }
  }
}
