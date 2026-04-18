# T03: Add Retry Handler section to `shared/forge-dispatch.md`

status: DONE
**Slice:** S01  **Milestone:** M002

## Goal
Add a new `### Retry Handler` section to `shared/forge-dispatch.md` that documents the markdown-prose algorithm the orchestrator follows when `Agent()` throws a transient error. The section centralises retry logic so both `skills/forge-auto/SKILL.md` and `commands/forge-next.md` (T04) can reference it instead of duplicating instructions.

## Must-Haves

### Truths
- `shared/forge-dispatch.md` contains a new section `### Retry Handler` placed AFTER the existing template blocks (after `research-milestone / research-slice`) so it is a shared utility, not a per-unit template.
- The section prescribes the exact control flow a worker prompt writer or orchestrator block must follow:
  1. Wrap the `Agent()` call in try/catch.
  2. On throw, capture the exception text verbatim into a variable.
  3. Shell out via `Bash`: `node scripts/forge-classify-error.js --msg "<escaped text>"`.
  4. Parse the JSON. If `retry === false`, bail to the existing CRITICAL failure block (deactivate auto-mode, surface to user).
  5. If `retry === true`, increment an in-memory `attempt` counter (starts at 0).
  6. Compute backoff: prefer `backoffMs` from classifier; override with exponential schedule `2000 * 2^(attempt-1)` (so 2s/4s/8s) capped at `backoffMs` ceiling when present.
  7. Sleep via `Bash` (`sleep $((delay_s))` on Unix, PowerShell `Start-Sleep` on Windows — use `node -e "setTimeout(()=>{},N).unref()"` for cross-platform).
  8. Append retry event to `events.jsonl`.
  9. If `attempt > PREFS.retry.max_transient_retries`, bail with a "retries exhausted" blocker message routed through the CRITICAL path.
  10. Re-dispatch the same `Agent()` call with the same prompt.
- Event log line format (single line, valid JSON):
  ```
  {"ts":"{ISO8601}","event":"retry","unit":"{unit_type}/{unit_id}","class":"{kind}","attempt":N,"backoff_ms":N,"model":"{model_id}"}
  ```
- `max_transient_retries` defaults to `3` when `PREFS.retry` is absent (pref block ships in T05).
- The section includes a small compatibility note: ECONNRESET-style `kind:"connection"` is also treated as transient, matching T02's `isTransient()` table.
- The section is self-contained — a reader patching `skills/forge-auto/SKILL.md` in T04 should be able to copy a 6–10 line snippet verbatim into the Dispatch step.

### Artifacts
- `shared/forge-dispatch.md` — modified. New `### Retry Handler` section appended after the existing `research-milestone / research-slice` template. Roughly 60–90 lines including the algorithm, the JSON schema, and a "How to wire this into a dispatch template" mini-howto.

### Key Links
- `shared/forge-dispatch.md` consumes `scripts/forge-classify-error.js` (T02) via Bash shell-out.
- `skills/forge-auto/SKILL.md` and `commands/forge-next.md` will consume this new section in T04.

## Steps
1. Read the current `shared/forge-dispatch.md` to find the correct insertion point (end of file, after the `research-milestone / research-slice` template's closing ` ``` `).
2. Draft the `### Retry Handler` section with the following subsections:
   - `#### When to apply` — after any `Agent()` call that throws; only for transient classes.
   - `#### Algorithm` — numbered steps matching the 10-step flow above, expressed as Markdown instructions the orchestrator will follow.
   - `#### Event log format` — the JSON line schema.
   - `#### Prefs contract` — expects `PREFS.retry.max_transient_retries` (default 3); explains per-class behaviour.
   - `#### Wiring into a dispatch template` — reference snippet showing where to place the try/catch relative to the `TaskCreate` / heartbeat / `Agent()` block.
3. Include a brief cross-reference block pointing to `scripts/forge-classify-error.js --msg` invocation syntax so worker-template writers know what CLI signature to call.
4. Add explicit reminder: permanent / model_refusal / context_overflow / tooling_failure kinds are NOT handled here — they fall through to the existing Failure Taxonomy in `skills/forge-auto/SKILL.md` Step 5.
5. Verify the file still parses cleanly as Markdown (run `node -e "require('fs').readFileSync('shared/forge-dispatch.md','utf8')"` to confirm readability) and that no existing template block was disturbed.
6. Write `T03-SUMMARY.md` with the diff summary and a pointer to the new line range.

## Standards
- **Target directory:** `shared/` — documentation / worker-prompt source of truth, per existing file placement.
- **Reuse:** the dispatch-loop CRITICAL block in `skills/forge-auto/SKILL.md` (lines ~251–258) as the "bail" path for exhausted retries and non-transient classes — don't invent a new user message.
- **Naming:** section heading `### Retry Handler` (title case, matches neighbouring sections).
- **Markdown style:** match existing headings (triple-backtick code fences for worker prompt bodies, JSON in fenced blocks, numbered lists for algorithms).
- **Lint command:** (none — Markdown file; no Markdown linter configured in project.)
- **Pattern:** no matching entry in Pattern Catalog (project lacks `.gsd/CODING-STANDARDS.md`).

## Context
- M002-CONTEXT locked: `max_transient_retries: 3`, backoff exponencial 2s/4s/8s. Retryable: `rate_limit`, `network`, `server`, `stream`. Non-retryable uses existing strategy. T03 implements that exact contract.
- The existing `### execute-task` / `### plan-slice` / etc. templates are DATA FLOW descriptors (MEM011). The Retry Handler is a CONTROL FLOW utility. Place it separately; do not mix into a data-flow template.
- MEM015 reminder: `forge-next.md` Step 3 has a unique selective memory injection block not present in forge-auto. The Retry Handler section must be structurally independent so it can be dropped into both files without conflict in T04.
- Key files to read first:
  - `shared/forge-dispatch.md` (insertion target)
  - `skills/forge-auto/SKILL.md` Step 4 (the Dispatch block to be wrapped) + Step 5 (Failure Taxonomy — the bail path)
  - `.gsd/milestones/M002/M002-CONTEXT.md` Implementation Decisions
