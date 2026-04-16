---
id: S01
milestone: M002
status: done
completed_at: 2026-04-16T00:00:00Z
---

## Goal

Give the Forge orchestrator automatic recovery from transient provider errors (rate limits,
network drops, 5xx, stream truncations, connection resets) so `/forge-auto` and `/forge-next`
survive flaky API conditions instead of aborting a milestone mid-run.

## Outcome

All 5 tasks completed. The full error-classification + retry integration pipeline is
operational end-to-end:

- Smoke gate (T01) confirmed Agent() exceptions are regex-legible — PROCEED.
- Classifier (T02) is a zero-dependency CommonJS module + CLI at `scripts/forge-classify-error.js`.
- Retry Handler (T03) is documented in `shared/forge-dispatch.md ### Retry Handler` (161 lines).
- Both dispatch-loop skill files (T04) wrap their `Agent()` call with the handler.
- Prefs block (T05) ships `max_transient_retries: 3` + per-class prose in `forge-agent-prefs.md`.

## Artefacts produced

| Path | Status | Task |
|------|--------|------|
| `scripts/forge-classify-error.js` | new | T02 |
| `shared/forge-dispatch.md` | modified (+161 lines — `### Retry Handler`) | T03 |
| `skills/forge-auto/SKILL.md` | modified (guarded-dispatch block) | T04 |
| `skills/forge-next/SKILL.md` | modified (guarded-dispatch block) | T04 |
| `forge-agent-prefs.md` | modified (+`## Retry Settings` section) | T05 |
| `.gsd/milestones/M002/slices/S01/S01-SMOKE.md` | new | T01 |
| `.gsd/milestones/M002/slices/S01/S01-SUMMARY.md` | new | T05 |

## Demo transcripts

### Setup

```bash
cd C:/DEV/forge-agent
```

### Case 1 — 503 Server Error (transient)

**Input:**
```
503 Service Unavailable
```

**Classifier output:**
```json
{"kind":"server","retry":true,"backoffMs":30000}
```

**isTransient():** `true`

**Expected events.jsonl entries (Retry Handler, attempt 1–3):**
```json
{"ts":"...", "event":"retry", "unit":"execute-task/T##", "class":"server", "attempt":1, "backoff_ms":2000}
{"ts":"...", "event":"retry", "unit":"execute-task/T##", "class":"server", "attempt":2, "backoff_ms":4000}
{"ts":"...", "event":"retry", "unit":"execute-task/T##", "class":"server", "attempt":3, "backoff_ms":8000}
```

**Outcome:** Recovered after backoff (if provider recovers) or exhausted at 3 attempts
with clean blocker: `class: server_error, attempts: 3`.

---

### Case 2 — 429 Rate Limit (transient, with provider hint)

**Input:**
```
429 Too Many Requests, retry after 30s
```
with `--retry-after-ms 30000`

**Classifier output:**
```json
{"kind":"rate-limit","retry":true,"backoffMs":30000}
```

**isTransient():** `true`

**Note:** backoffMs is `max(base_backoff * 2^(attempt-1), providerHint)` but never
exceeds `max_backoff_ms: 60000`. At attempt 1 (base=2000) the provider hint of 30000
wins; at attempt 3 (base=8000) the hint still wins if present.

---

### Case 3 — ECONNRESET (transient, network)

**Input:**
```
ECONNRESET read ECONNRESET
```

**Classifier output:**
```json
{"kind":"network","retry":true,"backoffMs":3000}
```

**isTransient():** `true`

---

### Case 4 — 401 Unauthorized (permanent, no retry)

**Input:**
```
401 Unauthorized
```

**Classifier output:**
```json
{"kind":"permanent","retry":false}
```

**isTransient():** `false`

**Outcome:** Retry Handler immediately routes to CRITICAL path — surfaces blocker to user.
No sleep, no retry. This validates the permanent-bail-out path.

---

### Case 5 — Retry exhaustion (4 consecutive transient errors)

Scenario: `Agent()` throws `503 Service Unavailable` four times in a row.

| Attempt | backoff_ms | events.jsonl entry |
|---------|-----------|---------------------|
| 1 | 2000 | `{"event":"retry","class":"server","attempt":1,"backoff_ms":2000}` |
| 2 | 4000 | `{"event":"retry","class":"server","attempt":2,"backoff_ms":4000}` |
| 3 | 8000 | `{"event":"retry","class":"server","attempt":3,"backoff_ms":8000}` |
| 4 | — | exhausted: `max_transient_retries: 3` reached |

**User-facing blocker message (exhaustion):**
```
Retries exhausted for unit execute-task/T##.
  class: server | attempts: 3 | last_backoff_ms: 8000
  Surface: disable auto-mode, notify user, abort loop.
```

`max_transient_retries: 3` means 3 retries — the initial call plus 3 reattempts = 4 total
invocations before exhaustion. This matches the PREFS contract in `forge-agent-prefs.md`.

---

### isTransient() verification matrix

| Input | kind | isTransient |
|-------|------|-------------|
| `503 Service Unavailable` | server | true |
| `429 Too Many Requests` | rate-limit | true |
| `ECONNRESET read ECONNRESET` | network | true |
| `401 Unauthorized` | permanent | false |

All three required transient classes return `isTransient() == true`. Permanent returns false.

## Decisions locked

| Ref | Decision |
|-----|----------|
| M002-CONTEXT | `max_transient_retries: 3` is the default; backoff 2s/4s/8s (base doubled per attempt) |
| T02 | Output shape is `{kind, retry, backoffMs}` — `retry` is explicit boolean, `backoffMs` renamed from GSD-2's `retryAfterMs` |
| T03 | `errorMsg` is NEVER written to `events.jsonl` — only `class/attempt/backoff_ms/model` |
| T03 | `backoff = Math.min(classifier.backoffMs, base * 2^(attempt-1))` — respects provider hint |
| T04 | `commands/forge-next.md` does not exist — the step-mode loop lives at `skills/forge-next/SKILL.md` |
| T05 | `retry:` block uses `snake_case` keys matching existing prefs style; prose explains retryable vs non-retryable classes |

## Unknown / partial coverage

The following classifier inputs still return `kind: "unknown"` (not retried by default):

- Opaque exception strings (e.g., `"success"`, `"error"`, `"ok"`) from GSD-2 bug #3588.
- Unrecognised error formats not matching any regex group.

**Impact on S02 (verification gate):** If `npm test` flakes with an opaque exception, the
current handler will surface it as `kind: unknown, retry: false` — a hard fail. S02 can
choose to promote specific test-runner patterns to a dedicated `test_flake` class with
`retry: true`, or treat unknown as non-retryable and let the user re-run.

## Follow-ups for next slices

| Slice | Consumer | What S01 delivers |
|-------|----------|-------------------|
| **S02** (verification gate) | Uses `classifyError` to decide whether a failing test is a transient flake | S01 ships the classifier + `isTransient()` — S02 can call `require('./scripts/forge-classify-error.js')` directly |
| **S03** (token counter) | May want to record token cost in retry events | S01 events.jsonl entries have no `tokens` field; S03 should extend the schema |
| **S04** (model downgrade on retry) | Needs to inspect `kind` to decide when to downgrade | S01's classifier exposes `kind` — S04 wraps around the handler decision branch |
</content>
</invoke>