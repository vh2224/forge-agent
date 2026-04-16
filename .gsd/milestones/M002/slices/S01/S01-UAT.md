# S01: Error classifier + retry integration — UAT Script

**Slice:** S01  **Milestone:** M002  **Written:** 2026-04-16

---

## Prerequisites

- Node.js available on PATH (`node --version` should succeed).
- Working directory is the repo root: `C:/DEV/forge-agent`.
- Git Bash or equivalent Unix-compatible shell.

---

## Test Cases

| # | Action | Expected | Pass? |
|---|--------|----------|-------|
| 1 | `node scripts/forge-classify-error.js --msg "503 Service Unavailable"` | Outputs `{"kind":"server","retry":true,"backoffMs":30000}` | |
| 2 | `node scripts/forge-classify-error.js --msg "429 Too Many Requests"` | Outputs `{"kind":"rate-limit","retry":true,"backoffMs":30000}` | |
| 3 | `node scripts/forge-classify-error.js --msg "ECONNRESET read ECONNRESET"` | Outputs `{"kind":"network","retry":true,"backoffMs":3000}` | |
| 4 | `node scripts/forge-classify-error.js --msg "401 Unauthorized"` | Outputs `{"kind":"permanent","retry":false}` (no `backoffMs`) | |
| 5 | `echo "503 Service Unavailable" \| node scripts/forge-classify-error.js` | Same output as test 1 (stdin fallback works) | |
| 6 | `node scripts/forge-classify-error.js --msg "503 Service Unavailable" --retry-after-ms 45000` | `backoffMs` is 45000 (provider hint wins over base 30000) | |
| 7 | `node -e "const {classifyError,isTransient}=require('./scripts/forge-classify-error.js'); console.log(isTransient(classifyError('ECONNRESET')))"` | Prints `true` | |
| 8 | `node -e "const {classifyError,isTransient}=require('./scripts/forge-classify-error.js'); console.log(isTransient(classifyError('401 Unauthorized')))"` | Prints `false` | |
| 9 | Open `shared/forge-dispatch.md` and locate `### Retry Handler` | Section exists after line 280; contains sub-sections: "When to apply", "Algorithm", "Event log format", "Prefs contract", "Worked examples", "Wiring snippet" | |
| 10 | In `shared/forge-dispatch.md ### Retry Handler` worked examples, verify `errorMsg` does NOT appear in any `events.jsonl` sample line | Event log entries use only `class`, `attempt`, `backoff_ms`, `model` — no `errorMsg` field | |
| 11 | Open `skills/forge-auto/SKILL.md` and locate Step 4 Dispatch | Contains a "Guarded dispatch" block with `try { ... Agent(...) }` structure referencing `shared/forge-dispatch.md ### Retry Handler`; the CRITICAL block headline reads `(permanent / retries exhausted)` | |
| 12 | Open `skills/forge-next/SKILL.md` and locate the `Agent()` dispatch site | Same guarded-dispatch block present; selective memory injection block (MEM015, ~lines 123-129) is intact and unchanged | |
| 13 | Open `forge-agent-prefs.md` and locate `## Retry Settings` | Section exists with fenced block containing `max_transient_retries: 3`, `base_backoff_ms: 2000`, `max_backoff_ms: 60000`; prose below explains retryable vs non-retryable classes | |
| 14 | `node --check scripts/forge-classify-error.js` | Exits 0 with no output (syntax valid) | |

---

## Notes

- Tests 1–8 are fully automated (run in terminal, compare stdout).
- Tests 9–13 are manual artifact inspections.
- Test 14 is the lint gate — must pass before the slice is considered closed.
- No network calls required for any test case.
- `kind: unknown` (opaque error strings) is intentionally `retry: false` — not a bug. See S01-SUMMARY.md § Unknown/partial coverage.
