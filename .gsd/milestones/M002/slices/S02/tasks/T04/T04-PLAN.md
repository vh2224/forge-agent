# T04: Wire slice-level verify gate into `agents/forge-completer.md` + write `S02-CONTEXT.md`

**Slice:** S02  **Milestone:** M002

## Goal

Modify `agents/forge-completer.md` to invoke `scripts/forge-verify.js` (T01) as
the FIRST step of `complete-slice`, before the existing security scan, lint
gate, and squash-merge. On failure, the completer records the gate result in
`S##-SUMMARY.md` under `## Verification Gate` and returns `blocked` with
`blocker_class: tooling_failure`. Also write `S02-CONTEXT.md` documenting the
task-level vs slice-level split (W4 mitigation from S02-RISK).

## Must-Haves

### Truths

- `agents/forge-completer.md` modified. The existing `## For complete-slice` numbered list (currently 1–8) gains a new step 3 (verify gate) and renumbers:
  - Current step 1 (Write S##-SUMMARY.md) → new step 1 (unchanged).
  - Current step 2 (Write S##-UAT.md) → new step 2 (unchanged).
  - **NEW step 3: Verification gate**:
    ```
    3. **Verification gate** — invoke:
       ```bash
       node scripts/forge-verify.js --cwd {WORKING_DIR} --unit complete-slice/{S##}
       ```
       Parse result:
       - `passed: true` → record the gate result in `S##-SUMMARY.md` under `## Verification Gate` (commands, exit codes, discovery source, total duration, timestamp). Continue to step 4.
       - `skipped: "no-stack"` → record `## Verification Gate: skipped (no-stack)` + one-line explanation in `S##-SUMMARY.md`. Continue to step 4.
       - `passed: false` → record full failure context in `S##-SUMMARY.md` under `## Verification Gate`. STOP — do NOT run security scan, lint, or merge. Return `---GSD-WORKER-RESULT---` with `status: blocked`, `blocker_class: tooling_failure`, and the `formatFailureContext` output as `blocker`.
    ```
  - Current step 3 (Security scan) → new step 4.
  - Current step 4 (Lint gate) → new step 5.
  - Current step 5 (Git squash-merge) → new step 6.
  - Current step 6 (Update M###-SUMMARY.md) → new step 7.
  - Current step 7 (Mark slice [x]) → new step 8.
  - Current step 8 (Update CLAUDE.md Estado atual) → new step 9.
- The `S##-SUMMARY.md` format spec in the completer (under step 1) is extended to note that a `## Verification Gate` section is required (immediately after the existing `## What Was Built` narrative).
- The `## For complete-milestone` section is UNCHANGED — milestone-level verification is out of scope for M002 (per SCOPE.md).
- Frontmatter unchanged: `name: forge-completer`, `model: claude-sonnet-4-6`, `tools: Read, Write, Edit, Bash`. `Bash` already present — no additions needed.
- **Write `S02-CONTEXT.md`** at `.gsd/milestones/M002/slices/S02/S02-CONTEXT.md` documenting the task-level vs slice-level gate split (W4 mitigation):
  - **Frontmatter:** `id: S02`, `milestone: M002`, `phase: implement`, `date: YYYY-MM-DD`.
  - **`## Decisions` section** (required — orchestrator injects this into future execute-task prompts):
    1. **Task-level gate reads `T##-PLAN` frontmatter `verify:`** — executor invokes `forge-verify.js --plan <T##-PLAN>` so per-task commands override the project default. Task plans that omit `verify:` fall through to the discovery chain.
    2. **Slice-level gate reads `prefs.verification.preference_commands`** — completer invokes `forge-verify.js` without `--plan`. The discovery chain skips step 1 (no taskPlanVerify) and lands on preference_commands or package.json allow-list.
    3. **Both invocations share the 3-step discovery chain** (plan → prefs → package.json) but the missing `--plan` at slice-level means step 1 is always empty for the completer.
    4. **Why split at all?** Task-level is for granular "this task broke typecheck" feedback during `partial` retries; slice-level is for pre-merge validation of the whole slice's output. They may run different commands (e.g. task runs fast typecheck; slice runs full test + lint).
    5. **Anti-recursion:** verify failures never route through the Retry Handler (S01). Task-level failures → `partial`; slice-level failures → `blocked` with `tooling_failure`.
  - **`## Out-of-scope reminders`:** milestone-level verification is deferred; Python/Go auto-detect is deferred; dependency audit is deferred.

### Artifacts

- `agents/forge-completer.md` — modified. New step 3 inserted; steps 3–8 renumbered to 4–9. `S##-SUMMARY.md` format spec updated to require `## Verification Gate` section.
- `.gsd/milestones/M002/slices/S02/S02-CONTEXT.md` — new file, ~50–80 lines.

### Key Links

- `agents/forge-completer.md` → `scripts/forge-verify.js` (T01) via `Bash`.
- `agents/forge-completer.md` → `shared/forge-dispatch.md ## Verification Gate` (T02) — agent follows the contract.
- `.gsd/milestones/M002/slices/S02/S02-CONTEXT.md` → consumed by future `execute-task` and `complete-slice` dispatches per `shared/forge-dispatch.md` template's `## Slice Decisions` section.

## Steps

1. Read `agents/forge-completer.md` in full to locate the `## For complete-slice` numbered list (1–8).
2. Read `shared/forge-dispatch.md ## Verification Gate` (T02) to confirm the CLI shape for slice-level (no `--plan` flag).
3. Use `Edit` tool to insert new step 3. Strategy: replace the entire `## For complete-slice` block (steps 1–8) with the updated version including new step 3 and renumbered 4–9. This avoids step-by-step `Edit` calls where off-by-one bugs commonly occur.
4. Update the `S##-SUMMARY.md` format spec (under step 1) to list `## Verification Gate` as a required section. Example new spec:
   ```
   1. Write `S##-SUMMARY.md` — compress all task summaries:
      - YAML frontmatter: id, milestone, provides (up to 8), key_files (up to 10), key_decisions (up to 5), patterns_established
      - One substantive liner for the slice
      - `## What Was Built` narrative
      - `## Verification Gate` section (commands, exit codes, discovery source, total duration) — populated in step 3
      - `drill_down_paths` to each task summary
   ```
5. Create `.gsd/milestones/M002/slices/S02/S02-CONTEXT.md` with the frontmatter, `## Decisions` section (5 decisions), and `## Out-of-scope reminders` section from the Truths above.
6. Verify `agents/forge-completer.md` still parses: file starts with `---`, YAML frontmatter valid, all headings closed, numbered list consistent.
7. Verify `S02-CONTEXT.md` is valid: frontmatter parseable, Markdown well-formed.
8. Write `T04-SUMMARY.md` with:
   - Before/after completer file line counts.
   - List of numbered steps reshuffled (old → new).
   - Confirmation of `S02-CONTEXT.md` creation with line count.
   - One-line verdict.

## Standards

- **Target directory:** `agents/` for completer edits; `.gsd/milestones/M002/slices/S02/` for the new CONTEXT file.
- **Reuse:** CLI shape (`node scripts/forge-verify.js --cwd {WORKING_DIR} --unit complete-slice/{S##}`) copied verbatim from `shared/forge-dispatch.md ## Verification Gate` (T02).
- **Naming:** step 3 heading `Verification gate`; summary section heading `## Verification Gate`; file `S02-CONTEXT.md` (per existing `.gsd/milestones/M###/slices/S##/` naming).
- **Frontmatter:** `agents/forge-completer.md` unchanged; `S02-CONTEXT.md` starts with YAML frontmatter (id, milestone, phase, date).
- **Language:** `S02-CONTEXT.md` may be Portuguese or English — follow the language established by `M002-CONTEXT.md` (English). All code/CLI examples in English.
- **Lint command:** `node -e "require('fs').readFileSync('agents/forge-completer.md','utf8')"` and same for `S02-CONTEXT.md`. No Markdown linter configured.
- **Pattern:** no direct Pattern Catalog entry for agent modification; follow completer's existing voice + structure. CONTEXT.md follows existing shape (see `M002-CONTEXT.md` as reference).

## Context

- **W4 mitigation (from S02-RISK):** this task is the concrete split documentation. Without `S02-CONTEXT.md`, future executors and completers would not know which gate reads from which source.
- **W3 reminder:** the new step 3 returns `blocked` with `blocker_class: tooling_failure` — NOT `external_dependency` (which is reserved for API timeouts). `tooling_failure` signals "the project's own verify commands failed" — orchestrator surfaces this directly to user, does NOT retry.
- **Slice-level gate runs before security scan** — this is intentional. If the code doesn't pass verify, running the security scan on the same (broken) code is wasteful. Security scan runs on the assumption verify passed.
- **`auto_commit: false` interaction:** the verify gate runs regardless of `auto_commit` — it is an evidence-gathering step. The squash-merge (now step 6) still respects `auto_commit: false` (skip silently).
- **MEM011 compliance:** slice-level gate invocation uses `--cwd` only — the script reads `package.json` / prefs from disk itself.
- **Per-phase decisions go in CONTEXT.md, not DECISIONS.md:** per the recent architecture decision in `CLAUDE.md`, `DECISIONS.md` is an append-only overview. Phase-specific decisions (like task-level vs slice-level gate split) live in the relevant `CONTEXT.md`. The orchestrator injects `S##-CONTEXT.md ## Decisions` into subsequent `execute-task` and `complete-slice` prompts.
- **Key files to read first:**
  - `agents/forge-completer.md` (current structure — locate exact step boundaries)
  - `shared/forge-dispatch.md ## Verification Gate` (T02 — CLI contract)
  - `scripts/forge-verify.js` (T01 — exit codes)
  - `.gsd/milestones/M002/M002-CONTEXT.md` (reference for CONTEXT.md shape + language)
  - `.gsd/milestones/M002/slices/S02/S02-RISK.md` W4 (why split)
  - `.gsd/milestones/M002/slices/S02/S02-PLAN.md` criteria 7 (slice-level gate) + 12 (dogfood)
