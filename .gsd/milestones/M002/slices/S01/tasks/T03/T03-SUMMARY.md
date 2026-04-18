---
id: T03
parent: S01
milestone: M002
provides:
  - "### Retry Handler section in shared/forge-dispatch.md (lines 283–441)"
  - "10-step algorithm: catch → classify → branch → backoff → sleep → log → retry"
  - "Event log format spec (class/attempt/backoff_ms — never errorMsg)"
  - "3 worked examples: 429 rate-limit, 503 server, ECONNRESET network"
  - "Drop-in wiring snippet for forge-auto and forge-next dispatch blocks"
requires:
  - "T02 (scripts/forge-classify-error.js) — classifier CLI consumed by handler"
affects: [S01, forge-auto, forge-next]
key_files:
  - shared/forge-dispatch.md
key_decisions:
  - "Retry Handler placed after research-milestone/research-slice template (line 283) — structurally separate from the 7 data-flow templates per MEM011"
  - "backoff = Math.min(classifier.backoffMs, 2000*2^(attempt-1)) — respects provider hint but caps at exponential ceiling"
  - "errorMsg NEVER written to events.jsonl — only class/attempt/backoff_ms/model"
duration: 15min
verification_result: pass
completed_at: 2026-04-16T00:00:00Z
---

Added `### Retry Handler` control-flow section (161 lines) to `shared/forge-dispatch.md` after the `research-milestone / research-slice` template, keeping it structurally independent from all 7 data-flow templates.

## What Happened

- Read `shared/forge-dispatch.md` to find insertion point (line 279, end of research template).
- Appended the Retry Handler section with 5 subsections: When to apply, Algorithm (10 steps), Event log format, Prefs contract (with kind-table), and Worked examples (3 scenarios), plus a Wiring snippet.
- Security checklist enforced:
  - `errorMsg` does NOT appear in the event log format spec or worked examples — only `class`/`attempt`/`backoff_ms`/`model`.
  - Shell invocation documented as `--msg "$errorMsg"` (double-quoted) throughout, with an explicit warning note about shell-injection risk if implementors copy examples without preserving quotes.
  - Worked example entries use placeholder values (`"class":"rate-limit"`, `attempt:1`), not real SDK traces.
- Verified: `node -e "require('fs').readFileSync(...)"` passes (Total lines: 441, all 7 existing templates intact, `errorMsg` absent from event log entries).
- Committed: `fa9f213`.

## Security Flags

No violations found. Both security checklist blockers verified:

1. **Event log entries never include errorMsg** — confirmed by grep: `"errorMsg"` does not appear in any event log line in the document.
2. **Shell quoting** — all invocation examples use `--msg "$errorMsg"` (double-quoted). Explicit warning note added: "Implementors who copy this example verbatim MUST preserve the double-quotes — bare `--msg $errorMsg` is a shell-injection risk."

## Deviations

None. Section placed exactly at insertion point specified by S01-RESEARCH.md (after research-slice template, before EOF).

## Files Created/Modified

- `shared/forge-dispatch.md` — 161 lines appended (lines 283–441). No existing lines modified.
