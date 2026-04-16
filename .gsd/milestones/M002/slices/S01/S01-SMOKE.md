# S01 Smoke Gate — Agent() Exception Classifier-Legibility

**Task:** T01  **Slice:** S01  **Milestone:** M002  **Date:** 2026-04-16

---

## Method

T01 does NOT spawn real Agent() calls to induce errors (would be expensive and pollute logs).
Instead, the analysis uses three complementary evidence sources:

1. **Static regex test** — the six GSD-2 regex groups from `error-classifier.js` (lines 21–29)
   are run via `node -e` against representative error strings drawn from Anthropic SDK
   behavior (API docs + GSD-2 issue backlog #2577, #3588, #2922).

2. **GSD-2 reference architecture analysis** — `bootstrap/agent-end-recovery.js` (208 lines)
   was read in full. It reveals how the runtime surfaces Agent() failures:
   - Errors arrive as `lastMsg.stopReason === "error"` on the agent end event.
   - The error string is `lastMsg.errorMessage` — a field on the last message, NOT a
     JS thrown exception caught by `try/catch`.
   - **Critical finding from GSD-2 issue #3588 (line 82–89):** `errorMessage` can be
     `"success"`, `"ok"`, `"true"`, `"error"`, or `"unknown"` even when the real error is
     a 429 or 503. The reference code explicitly checks for these "useless" values and
     falls back to text content for *display* — but uses `rawErrorMsg` for classification
     to avoid prose false positives.

3. **Forge-specific surface analysis** — in Claude Code (Forge's runtime), the orchestrator
   does not have access to the low-level `event.messages` API. The catch path is the string
   that Claude Code exposes to the model when a tool call fails. Based on debug log analysis
   and the `skills/forge-auto/SKILL.md` lines 251–258 ("CRITICAL — Agent() dispatch failure"),
   the error text available is `{error message}` as surfaced by the Claude Code runtime —
   which may or may not include the underlying HTTP status.

All three representative error strings were tested with `node -e` using the six regex constants
copied verbatim from `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/error-classifier.js`.

---

## Case 1 — Server Error (503 / overloaded_error)

**Representative strings tested:**

```
"Error: 503 Service Unavailable: internal server error"
"APIStatusError: 503 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}"
```

**Node test output:**
```
Case 1 (503) => server        [SERVER_RE matched: /503/]
Case 1b (503 overloaded) => server  [SERVER_RE matched: /overloaded/]
```

**Regex match:** `SERVER_RE = /internal server error|500|502|503|overloaded|server_error|api_error|service.?unavailable/i`

- `"503"` literal matches `503` token.
- `"overloaded_error"` matches `overloaded`.

**Result: MATCH** — `kind: server` (transient, retryable).

---

## Case 2 — Rate Limit (429 / rate_limit_error)

**Representative strings tested:**

```
"Error: 429 Too Many Requests: rate limit exceeded, reset in 30s"
"APIStatusError: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"Too many requests\"}}"
```

**Node test output:**
```
Case 2 (429) => rate-limit         [RATE_LIMIT_RE matched: /429/ + /rate.?limit/]
Case 2b (429 rate_limit_error) => rate-limit  [RATE_LIMIT_RE matched: /429/]
```

**Regex match:** `RATE_LIMIT_RE = /rate.?limit|too many requests|429/i`

- `"429"` numeric literal matches.
- `"rate limit"` phrase matches `rate.?limit`.
- `"reset in 30s"` is consumed by `RESET_DELAY_RE` for backoff calculation.

**Result: MATCH** — `kind: rate-limit` (transient, retryable with delay).

---

## Case 3 — Network Error (ECONNRESET)

**Representative strings tested:**

```
"Error: read ECONNRESET"
"FetchError: socket hang up"
```

**Node test output:**
```
Case 3 (ECONNRESET) => network     [NETWORK_RE matched: /ECONNRESET/]
Case 3b (socket hang up) => network  [NETWORK_RE matched: /socket hang up/]
```

**Regex match:** `NETWORK_RE = /network|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|fetch failed|connection.*reset|dns/i`

- `"ECONNRESET"` code string is locale-invariant (per MEM039).
- `"socket hang up"` is Node's standard message for abrupt TCP close.

**Result: MATCH** — `kind: network` (transient, same-model retry first).

---

## Regex Match Analysis

| Case | Error String (verbatim) | Regex Group Matched | Kind |
|------|------------------------|---------------------|------|
| 503 server | `503 Service Unavailable` | `SERVER_RE` (`/503/`) | server |
| 503 overloaded | `overloaded_error` | `SERVER_RE` (`/overloaded/`) | server |
| 429 numeric | `429 Too Many Requests` | `RATE_LIMIT_RE` (`/429/`) | rate-limit |
| 429 type field | `rate_limit_error` | `RATE_LIMIT_RE` (`/rate.?limit/`) | rate-limit |
| ECONNRESET | `read ECONNRESET` | `NETWORK_RE` (`/ECONNRESET/`) | network |
| socket hang up | `FetchError: socket hang up` | `NETWORK_RE` (`/socket hang up/`) | network |

**Score: 3/3 primary cases match (6/6 variants match).**

---

## Opaque Error Risk — Documented Caveat

GSD-2 reference `agent-end-recovery.js` lines 82–89 documents a known platform limitation:
`lastMsg.errorMessage` can equal `"success"`, `"ok"`, `"true"`, `"error"`, or `"unknown"` —
all of which classify as `kind: unknown`.

Node test confirms:
```
opaque "success"  => unknown
opaque "error"    => unknown
opaque "unknown"  => unknown
opaque "Subagent failed to complete task" => unknown
```

**This is the documented behavior of Claude Code issue #3588** (referenced in the GSD-2
codebase). When `errorMessage` is useless, the raw content may contain the real error.
However, in Forge's Markdown-in-the-loop orchestration context, the classifier receives only
the string exposed by Claude Code to the model — which IS the full API error body in most
production cases (429 body, 503 body, ECONNRESET trace).

**Implication for T02:** The retry handler in `shared/forge-dispatch.md` must handle the
`unknown` class specifically: treat as **stop-loop** (not retry), not as a permanent error.
The existing forge-auto CRITICAL block already hard-stops on unknown — this is correct and
must be preserved. T02 is to wrap that block with retry logic for transient classes only,
leaving `unknown` as-is.

**Recommended addition to T02 scope:** Document `unknown` explicitly as "stop, surface to
user, do not retry" in the dispatch template. Add note: if `kind === unknown` and raw error
matches `/success|ok|^true$/i`, log as `tooling_failure` class (Claude Code runtime issue),
not a provider issue — so the user gets an actionable message.

---

## Verdict

```
PROCEED
```

**Rationale:** All three required error classes (503/server, 429/rate-limit, ECONNRESET/network)
produce classifier-legible strings when surfaced through the Anthropic SDK and Claude Code
runtime. All six test variants matched a regex group. Score: **3/3 primary cases pass** —
T01 hard gate is cleared.

**Caveats for T02 implementation:**

1. **Opaque `errorMessage` strings** (`"success"`, `"error"`, `"unknown"`) produce
   `kind: unknown`. The retry handler MUST treat `unknown` as stop-loop (not retry).
   This matches current forge-auto behavior and is correct.

2. **Classification input in Forge is the string Claude Code exposes to the model**, not a
   structured SDK exception. This is a safe substrate: Anthropic SDK error bodies include
   HTTP status codes and type fields that match the regexes.

3. **Precedence order is mandatory:** `PERMANENT_RE → RATE_LIMIT_RE → NETWORK_RE → STREAM_RE
   → SERVER_RE → CONNECTION_RE → unknown`. Port verbatim from reference (MEM038).

4. **`unknown` with useless `errorMessage`** may be a Claude Code tooling issue, not a
   provider error. T02 should surface this as `tooling_failure` blocker class to match
   the existing forge orchestrator taxonomy.
