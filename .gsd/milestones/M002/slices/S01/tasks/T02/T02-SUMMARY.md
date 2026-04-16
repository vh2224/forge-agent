---
id: T02
parent: S01
milestone: M002
provides: [scripts/forge-classify-error.js — classifyError + isTransient, CLI mode (--msg / stdin), CommonJS module export]
requires: [T01 smoke gate (PROCEED)]
affects: [S01, M002]
key_files: [scripts/forge-classify-error.js]
key_decisions:
  - "Output shape changed from GSD-2 {kind, retryAfterMs} to Forge {kind, retry, backoffMs} — adds explicit boolean and renames field for clarity"
  - "unknown kind always retry:false; opaque tooling strings (success/error/ok) map here per MEM041"
new_helpers:
  - "classifyError — scripts/forge-classify-error.js — classifies error string into {kind, retry, backoffMs}"
  - "isTransient — scripts/forge-classify-error.js — returns true for the 5 transient error kinds"
duration: 10min
verification_result: pass
completed_at: 2026-04-16T00:00:00Z
---

Port of GSD-2 error-classifier.js to CommonJS CLI module with Forge output shape.

## What Happened

1. Read GSD-2 reference at `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/error-classifier.js` — 6 regex constants copied verbatim.
2. Verified T01 smoke gate: **PROCEED** (3/3 primary cases pass).
3. Created `scripts/forge-classify-error.js` (~120 lines):
   - Shebang + header comment referencing GSD-2 source
   - 6 regex constants (PERMANENT_RE, RATE_LIMIT_RE, NETWORK_RE, SERVER_RE, CONNECTION_RE, STREAM_RE) + RESET_DELAY_RE — verbatim from reference
   - `classifyError(errorMsg, retryAfterMs)` with exact precedence order (MEM038)
   - `isTransient(result)` helper
   - `module.exports = { classifyError, isTransient }`
   - CLI guard: `--msg` / `--retry-after-ms` flags + stdin fallback
4. Output shape adapted from GSD-2 (`{kind, retryAfterMs}`) to Forge spec (`{kind, retry, backoffMs}`).
5. No opaque-caveat seventh regex added — T01 verdict was plain PROCEED; opaque handling is documented via `kind: unknown, retry: false` return value.

## Smoke Test Results

| Command | Expected | Actual | Pass |
|---------|----------|--------|------|
| `echo '500 internal server error' \| node scripts/forge-classify-error.js` | `{"kind":"server","retry":true,"backoffMs":30000}` | `{"kind":"server","retry":true,"backoffMs":30000}` | PASS |
| `node scripts/forge-classify-error.js --msg "429 rate limit reset in 45s"` | `{"kind":"rate-limit","retry":true,"backoffMs":45000}` | `{"kind":"rate-limit","retry":true,"backoffMs":45000}` | PASS |
| `node scripts/forge-classify-error.js --msg "ECONNRESET"` | `{"kind":"network","retry":true,"backoffMs":3000}` | `{"kind":"network","retry":true,"backoffMs":3000}` | PASS |
| `node scripts/forge-classify-error.js --msg "401 unauthorized"` | `{"kind":"permanent","retry":false}` | `{"kind":"permanent","retry":false}` | PASS |

**Verdict: 4/4 smoke tests pass. Syntax check: PASS.**

## Deviations

- GSD-2 uses `retryAfterMs` as the return field name; Forge spec requires `backoffMs`. Renamed on port.
- GSD-2 omits `retry` boolean; added per must-have spec.
- `createRetryState` / `resetRetryState` / `isTransientNetworkError` not ported — out of scope per T02-PLAN context notes.

## Files Created/Modified

- `scripts/forge-classify-error.js` — created (new)
- `.gsd/milestones/M002/slices/S01/tasks/T02/T02-PLAN.md` — status updated to RUNNING/DONE
- `.gsd/milestones/M002/slices/S01/tasks/T02/T02-SUMMARY.md` — created (this file)
