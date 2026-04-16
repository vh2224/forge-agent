# T04: Wire Retry Handler into forge-auto skill and forge-next command

status: RUNNING

**Slice:** S01  **Milestone:** M002

## Goal
Patch `skills/forge-auto/SKILL.md` and `commands/forge-next.md` (if it exists; otherwise whichever file implements the step-by-step dispatch loop) so their `Agent()` call sites invoke the Retry Handler defined in `shared/forge-dispatch.md` (T03). Preserve each file's structural quirks — MEM015 forbids mechanical merging.

## Must-Haves

### Truths
- `skills/forge-auto/SKILL.md` Step 4 "Dispatch" has its `Agent(agent_name, worker_prompt)` call wrapped with the Retry Handler flow described in `shared/forge-dispatch.md`. The existing "CRITICAL — Agent() dispatch failure" block is updated (not replaced) so the bail path is reached only AFTER retry exhaustion or when the classifier returns `retry: false`.
- `commands/forge-next.md` (if present) OR the step-mode file equivalent receives the same patch, preserving its unique selective memory injection block that forge-auto does not have (MEM015).
- A new line in each file explicitly references: *"Apply the Retry Handler section of `shared/forge-dispatch.md`"* — do not duplicate the algorithm body; reference only.
- The heartbeat write in `skills/forge-auto/SKILL.md` (`echo '{"active":true,"started_at":...,"worker":"UNIT_TYPE/UNIT_ID",...}' > .gsd/forge/auto-mode.json`) is NOT disturbed; retries reuse the existing heartbeat write path.
- Event log lines for retries use the schema from T03 and are appended to `.gsd/forge/events.jsonl` (NOT a new file, NOT the auto-mode.json file).
- The existing TaskCreate/TaskUpdate flow is preserved: during retries, the task remains `in_progress` (do not mark completed between retries).
- No changes to worker prompt templates in `shared/forge-dispatch.md` — only the dispatch-loop files are patched. T03 already owns the shared section.

### Artifacts
- `skills/forge-auto/SKILL.md` — modified. Step 4 "Dispatch" updated. Diff limited to the Dispatch section and the CRITICAL-failure block.
- `commands/forge-next.md` — modified IF FOUND (see Step 1). If the command is instead a skill at `skills/forge-next/SKILL.md`, patch that. If neither exists yet, document the absence in `T04-SUMMARY.md` and mark the slice OK — the handler in T03 is still the source of truth.

### Key Links
- Both files call `Agent()` → the new guarded invocation calls `node scripts/forge-classify-error.js` (T02) via `Bash` → consults `PREFS.retry.max_transient_retries` (T05) → appends to `events.jsonl`.

## Steps
1. Locate the step-mode dispatch file. Check these paths in order: `commands/forge-next.md`, `skills/forge-next/SKILL.md`. Use `Glob` or `Read`. Record which exists (one or neither) in `T04-SUMMARY.md`.
2. Read `shared/forge-dispatch.md` `### Retry Handler` section (from T03) so you know the reference contract and the wiring snippet.
3. Patch `skills/forge-auto/SKILL.md` Step 4:
   - Locate the `Agent(agent_name, worker_prompt)` dispatch (around line ~239 in current file).
   - Insert: a short guarded-call block before the call, citing `shared/forge-dispatch.md ### Retry Handler` and telling the orchestrator to wrap the dispatch in try/catch.
   - Update the existing "CRITICAL — Agent() dispatch failure" block (lines ~251–258) to clarify: the CRITICAL path is taken ONLY when the classifier returns `retry: false` OR when retries exhaust. Add one line: *"Transient errors (rate-limit, network, server, stream, connection) are handled by the Retry Handler before this block is reached."*
4. Apply the same patch to the forge-next file (whichever of `commands/forge-next.md` / `skills/forge-next/SKILL.md` was found in step 1). Preserve its selective memory injection block (MEM015). Do NOT copy forge-auto's content wholesale — only the try/catch wrap, the CRITICAL clarification line, and the reference to the shared section.
5. Sanity check both files still parse:
   - `node -c` is not applicable to Markdown; instead confirm frontmatter still valid by tailing first 10 lines.
   - Confirm no `Agent(` call has become unreachable.
6. Write `T04-SUMMARY.md` with a before/after excerpt of each patched section (5–8 lines each) and the list of files touched.

## Standards
- **Target directory:** `skills/forge-auto/` and whichever directory owns the step-mode dispatch (to be determined in Step 1).
- **Reuse:** the shared `### Retry Handler` section from `shared/forge-dispatch.md` (T03) — do NOT duplicate the algorithm body in skill/command files. Reference by name only.
- **Naming:** Markdown edits only; no new files.
- **Delta size:** ≤20 lines added per file (the retry algorithm itself lives in T03). If a patch exceeds 30 lines in either file, stop — something is being duplicated that should stay in `shared/forge-dispatch.md`.
- **Frontmatter:** do NOT change `allowed-tools` — `Bash` is already listed in `skills/forge-auto/SKILL.md` and is the tool used for the classifier shell-out.
- **Lint command:** (none — Markdown file, no Markdown linter configured in project).
- **Pattern:** `MEM015` — forge-next.md has a selective memory injection block that forge-auto does not. Respect the divergence. Use as scaffolding for structural awareness, not mechanical copy.

## Context
- MEM015 is load-bearing here: forge-next has `selective memory injection` (step-by-step model); forge-auto does not (autonomous model). Any patch MUST preserve that divergence.
- MEM011 reminder: templates are data-flow descriptors; the Retry Handler is control-flow. Keep them separate — do NOT inline retry logic inside the `execute-task` or `plan-slice` template bodies.
- `skills/forge-auto/SKILL.md` Step 4 CRITICAL block (lines ~251–258) says executing inline on Agent() failure is NEVER acceptable. Retries via the handler do NOT violate this — they re-dispatch via `Agent()`, keeping isolation intact.
- `commands/forge-next.md` may not exist yet. This task must handle the MISSING case gracefully — not as a blocker.
- Key files to read first:
  - `shared/forge-dispatch.md` (new `### Retry Handler` section from T03)
  - `skills/forge-auto/SKILL.md` Step 4 full block
  - Whichever of `commands/forge-next.md` / `skills/forge-next/SKILL.md` exists
  - `.gsd/milestones/M002/M002-ROADMAP.md` S01 Boundary Map — "forge-auto.md + SKILL.md (modified)" and "forge-next.md (modified)"
