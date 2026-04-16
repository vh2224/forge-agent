# T05: Prefs block + end-to-end demo + S01 summary

status: DONE
**Slice:** S01  **Milestone:** M002

## Goal
Add the `retry:` preferences block to `forge-agent-prefs.md` (the shipped template that `install.sh`/`install.ps1` copies to `~/.claude/forge-agent-prefs.md`), run a three-case end-to-end demo exercising the full retry loop (503, 429, ECONNRESET), and collect transcripts into `S01-SUMMARY.md`. This is the slice acceptance step.

## Must-Haves

### Truths
- `forge-agent-prefs.md` gains a new `## Retry Settings` section with a fenced `retry:` block containing:
  ```
  retry:
    max_transient_retries: 3      # per-unit cap before surfacing blocker
    base_backoff_ms: 2000         # first retry delay; doubled each attempt
    max_backoff_ms: 60000         # ceiling for computed backoff
  ```
  Each key has an inline comment. Block is placed BEFORE the `## Update Settings` section.
- Prose explanation beneath the block describes which classes are retryable (`rate-limit`, `network`, `server`, `stream`, `connection`) vs not (`permanent`, `unknown`, plus orchestrator-owned classes `model_refusal`, `context_overflow`, `tooling_failure`).
- Demo transcript exercises all three scenarios from T01's smoke harness using the real retry handler (not a mock). For each:
  - Raw exception text captured.
  - `forge-classify-error.js` output (JSON).
  - `events.jsonl` retry lines appended during the run.
  - Outcome (recovered / exhausted / permanent → surface).
- `S01-SUMMARY.md` follows the standard Forge summary format:
  - `## Goal`, `## Outcome`, `## Artefacts produced`, `## Demo transcripts`, `## Decisions locked`, `## Follow-ups for next slices` (callouts to S02/S03/S04 consumers).
- Summary explicitly notes which classifier cases still show `kind: "unknown"` (if any) so S02's verify gate can decide whether to treat them as retryable during `npm test` flakes.

### Artifacts
- `forge-agent-prefs.md` — modified. New `## Retry Settings` section added, ~15–25 lines. Pre-existing sections untouched.
- `.gsd/milestones/M002/slices/S01/S01-SUMMARY.md` — new. Full slice summary with three demo transcripts, ~120–200 lines.
- `.gsd/forge/events.jsonl` — appended to during the demo (not created new).

### Key Links
- `forge-agent-prefs.md` is consumed by `skills/forge-auto/SKILL.md` "Load context" Step 2 and by the T03 Retry Handler section of `shared/forge-dispatch.md` via `PREFS.retry.*` reads.

## Steps
1. Confirm T02, T03, T04 summaries all exist and indicate `status: done`. If any are missing, do not proceed — return `blocked` with a pointer.
2. Read current `forge-agent-prefs.md` to locate the insertion point (immediately before `## Update Settings`, which is near line ~118).
3. Add the `## Retry Settings` section with the fenced block specified above and the prose explanation. Cross-reference `scripts/forge-classify-error.js` and `shared/forge-dispatch.md ### Retry Handler`.
4. Run the three-case demo. For each case:
   a. Reuse the T01 smoke harness mechanism to force the error shape.
   b. Let the patched skill/command (T04) attempt dispatch — the Retry Handler should fire.
   c. After the run, `cat .gsd/forge/events.jsonl | tail -n 20` to capture retry lines.
   d. Record: input exception text, classifier JSON, events.jsonl excerpt, final outcome.
5. Additional edge case: force 4 consecutive transient errors to verify `max_transient_retries: 3` exhausts correctly and surfaces the expected "retries exhausted" blocker. Capture the user-facing message exactly.
6. Write `S01-SUMMARY.md` with all five transcripts (3 happy-path recoveries + 1 exhaustion + 1 permanent-error bail-out showing it did NOT retry).
7. Update the `S01-PLAN.md` acceptance criteria checkboxes from `[ ]` to `[x]` inline.
8. Write `T05-SUMMARY.md` pointing at the prefs diff and the `S01-SUMMARY.md` file.

## Standards
- **Target directory:** `./` (project root) for `forge-agent-prefs.md`; `.gsd/milestones/M002/slices/S01/` for summary artefacts.
- **Reuse:** T01's smoke harness mechanism — do not invent a new way to force errors.
- **Naming:** `S01-SUMMARY.md` (uppercase, matches existing convention); `T05-SUMMARY.md` (task summary standard).
- **Prefs style:** match existing blocks in `forge-agent-prefs.md` — fenced with triple backticks + no language tag, inline `# comments`, kebab or snake case (existing file uses `snake_case` for keys — follow suit: `max_transient_retries`, not `maxTransientRetries`).
- **Lint command:** (none — Markdown + docs only, no linter configured in project.)
- **Pattern:** no matching entry in Pattern Catalog (project lacks `.gsd/CODING-STANDARDS.md`).

## Context
- M002-CONTEXT locked: `max_transient_retries: 3`, backoff 2s/4s/8s, retryable classes = `rate_limit, network, server, stream`. This task ships those exact defaults.
- GSD-2's `"connection"` class IS transient per T02's `isTransient()` table. Retryable list in the prefs explanation should include `connection` even though M002-CONTEXT only named four — the runtime behaviour is what governs.
- MEM022: `allowed-tools` must be in skill frontmatter. Irrelevant to this task (no new tool use introduced).
- Do NOT touch `STATE.md`. Summaries and prefs only.
- Key files to read first:
  - `forge-agent-prefs.md` (insertion target, note style)
  - T02/T03/T04 summaries
  - `.gsd/milestones/M002/slices/S01/S01-PLAN.md` (acceptance criteria checklist)
  - `.gsd/milestones/M002/M002-CONTEXT.md` Implementation Decisions
