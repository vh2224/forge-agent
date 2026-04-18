---
status: DONE
---

# T02: Add `## Verification Gate` section to `shared/forge-dispatch.md`

**Slice:** S02  **Milestone:** M002

## Goal

Document the verification-gate contract in `shared/forge-dispatch.md` so both
`forge-executor` (task-level) and `forge-completer` (slice-level) invoke the
gate identically. Define: when the gate runs, CLI shape, how to inject
`formatFailureContext()` output into retry prompts, events.jsonl schema, and
the anti-recursion rule preventing infinite verify↔retry loops.

## Must-Haves

### Truths

- New section `## Verification Gate` added to `shared/forge-dispatch.md`, positioned after the existing `### Retry Handler` (S01) and before the first dispatch template. Section is ~100–150 lines of Markdown prose (no code blocks for logic — this is a contract doc; fenced blocks only for CLI examples).
- Section contains these sub-headings, in order:
  1. **Purpose** — one paragraph: the gate blocks a worker from returning `done` unless `scripts/forge-verify.js` exits 0.
  2. **Invocation points** — table listing: (a) `execute-task` worker → runs between "verify must-haves" and "write T##-SUMMARY"; (b) `complete-slice` worker → runs as step 3, before the existing security scan.
  3. **CLI shape** — exact commands for each invocation point:
     - Task-level: `node scripts/forge-verify.js --plan {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/tasks/{T##}/{T##}-PLAN.md --cwd {WORKING_DIR} --unit execute-task/{T##}`
     - Slice-level: `node scripts/forge-verify.js --cwd {WORKING_DIR} --unit complete-slice/{S##}` (NO `--plan` — slice-level reads from prefs).
  4. **Discovery chain** — ordered list restating T01's chain (plan.verify → prefs.preference_commands → package.json allow-list → no-stack). One-paragraph "why this order" rationale.
  5. **Failure handling** — how the worker reacts to non-zero exit:
     - Executor: return `partial`, include failure context from `formatFailureContext()` as `## Verification Failures` in the next retry prompt, do NOT write T##-SUMMARY (task stays `RUNNING`).
     - Completer: STOP the squash-merge, write the failure context into `S##-SUMMARY.md` under `## Verification Gate` (with exit codes + discovery source + per-command durations), return `blocked` with `blocker_class: tooling_failure`.
  6. **Skip handling** — on `skipped:"no-stack"` (docs-only repo) or `skipped:"timeout"` per-check:
     - `no-stack` → log event, continue as pass (do not treat as failure).
     - Per-check `timeout` → individual check is marked failed (exit 124), overall gate fails. Surface in failure context.
  7. **Events.jsonl schema** — exact JSON shape for `event:"verify"`:
     ```
     {"ts":"<ISO8601>","event":"verify","unit":"execute-task/T##"|"complete-slice/S##","milestone":"M###","slice":"S##","task":"T##"?,"discovery_source":"task-plan"|"preference"|"package-json"|"none","commands":["npm run typecheck","npm test"],"passed":true|false,"skipped":"no-stack"|"timeout"?,"duration_ms":1234}
     ```
     Note: `task` key omitted at slice-level; `skipped` key omitted when not applicable.
  8. **Anti-recursion rule** — explicit instruction: the Retry Handler (S01) classifies `Agent()` exceptions only. Verify exit codes (non-zero) go STRAIGHT to `partial`/`blocked` — do NOT re-classify or retry. The `--from-verify` sentinel is documented as reserved for future orchestrator-side guards but is not used by the current dispatch flow.
- Existing `execute-task` template (line ~8) modified to add `## Verification Gate` step AFTER the "Verify every must-have" line and BEFORE "Write T##-SUMMARY.md":
  ```
  Run verification gate: node scripts/forge-verify.js --plan {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/tasks/{T##}/{T##}-PLAN.md --cwd {WORKING_DIR} --unit execute-task/{T##}
  If exit code != 0 and not skipped → include formatFailureContext output as ## Verification Failures in retry prompt, return partial.
  If exit code == 0 or skipped → continue to summary.
  ```
- Existing `complete-slice` template (line ~141) modified: step 3 becomes verify gate; existing step 3 (security scan) becomes step 4; step 4 (lint gate) becomes step 5; steps renumber accordingly:
  ```
  3. Run verification gate: node scripts/forge-verify.js --cwd {WORKING_DIR} --unit complete-slice/{S##}
     Record result in S##-SUMMARY.md ## Verification Gate section (commands, exit codes, discovery source, total duration).
     If exit code != 0 and not skipped:no-stack → stop, return blocked with blocker_class: tooling_failure.
  4. Security scan — (existing step 3 content, unchanged except for number)
  5. Lint gate — (existing step 4 content, unchanged except for number)
  ... etc
  ```
- **Token budget check:** measure `shared/forge-dispatch.md` size before and after edits. Goal: stay under 1000 lines. After S01's 161-line Retry Handler, the file is ~660 lines; this task adds ~150 lines → ~810 total. If actual measurement exceeds 950 lines, extract the `## Verification Gate` section to a new file `shared/forge-verify-gate.md` and leave a one-line pointer in `forge-dispatch.md`. Record the decision in T02-SUMMARY.md.
- Markdown is well-formed: frontmatter-less content; headings in hierarchy; no broken tables; consistent code-block fencing (``` for shell, none for inline commands).

### Artifacts

- `shared/forge-dispatch.md` — modified. New `## Verification Gate` section (~100–150 lines). Two dispatch templates modified (`execute-task`, `complete-slice`).
- `shared/forge-verify-gate.md` — NEW FILE ONLY IF the budget check forces extraction. Otherwise omit.

### Key Links

- `shared/forge-dispatch.md ## Verification Gate` → `scripts/forge-verify.js` (T01) via `node` invocation.
- `shared/forge-dispatch.md ## Verification Gate` references `shared/forge-dispatch.md ### Retry Handler` (S01) for anti-recursion rule.
- Consumed by T03 (`agents/forge-executor.md`) and T04 (`agents/forge-completer.md`).

## Steps

1. Read `shared/forge-dispatch.md` in full. Note the existing `### Retry Handler` section's style (voice, code-block usage, level of detail) and match it in the new `## Verification Gate` section.
2. Measure current file size: `wc -l shared/forge-dispatch.md` (Bash) or `node -e "console.log(require('fs').readFileSync('shared/forge-dispatch.md','utf8').split('\n').length)"`.
3. Locate the insertion point: after the existing Retry Handler section, before the first `### <template>` heading for dispatch templates. If Retry Handler ends with a horizontal rule `---`, insert after that rule.
4. Write the new `## Verification Gate` section with all eight sub-headings above. Use the CLI shapes, JSON schema, and anti-recursion rule verbatim as specified.
5. Edit the `### execute-task` template (line ~8 area): insert the verify-gate directive between "Verify every must-have" and "Write T##-SUMMARY". Use `Edit` tool with exact string match — do NOT rewrite the whole template.
6. Edit the `### complete-slice` template (line ~141 area): renumber steps. The existing numbered list has 5–7 steps; insert new step 3 (verify gate) and renumber 3→4, 4→5, etc. All existing content preserved; only numbers and the new insertion change.
7. Re-measure file size. If > 950 lines: extract `## Verification Gate` section to `shared/forge-verify-gate.md`, replace in-place with a 3-line pointer: `## Verification Gate` heading + `See: shared/forge-verify-gate.md`. Document the decision in T02-SUMMARY.md.
8. Verify the file is still parseable Markdown. Quick sanity: `grep -c "^## " shared/forge-dispatch.md` should match expected heading count.
9. Write `T02-SUMMARY.md` with:
   - Pre- and post-edit line counts.
   - List of sub-sections added.
   - List of templates modified (names + which steps shifted).
   - Extraction decision (yes/no + rationale).
   - Confirmation that the `execute-task` and `complete-slice` template edits preserved all surrounding content.

## Standards

- **Target directory:** `shared/` — matches convention (doc consumed by multiple skills/commands). If extraction needed, `shared/forge-verify-gate.md`.
- **Reuse:** reference existing `### Retry Handler` section as style template. Match its voice (prose over prescriptive lists where possible, fenced blocks only for CLI examples).
- **Naming:** section heading `## Verification Gate` (capital G per convention used for `### Retry Handler`); file name (if extracted) `forge-verify-gate.md` per `forge-<topic>.md` pattern.
- **Lint command:** `node -e "require('fs').readFileSync('shared/forge-dispatch.md','utf8')"` to confirm the file is readable. No Markdown linter configured.
- **Pattern:** `follows: Dispatch template (shared)` from `CODING-STANDARDS.md ## Pattern Catalog` — Read-path directives for mandatory artifacts (`Read and follow:`), absolute paths via `{WORKING_DIR}/.gsd/...` (MEM010), placeholder substitution over inline content (MEM011).

## Context

- **MEM011 compliance:** the gate section documents CLI invocation with `--plan <path>` — orchestrator passes the path, the script reads the file. No inlined content.
- **MEM010 compliance:** all example paths in the new section use `{WORKING_DIR}/.gsd/...` absolute form.
- **S01 context:** the `### Retry Handler` section is a peer — do not duplicate its classification logic. This new section strictly handles the orchestrator ↔ verify.js contract, not error classification.
- **W6 mitigation:** the budget check (step 7) is the concrete mitigation for the "dispatch.md token pressure" warning in S02-RISK.md.
- **Key files to read first:**
  - `shared/forge-dispatch.md` (existing structure — especially `### Retry Handler` for style reference)
  - `scripts/forge-verify.js` (T01 output — contract source of truth for CLI flags and return shape)
  - `.gsd/milestones/M002/slices/S02/S02-PLAN.md` (for acceptance criteria 10 on template injections)
  - `.gsd/milestones/M002/slices/S02/S02-RISK.md` W3 (anti-recursion), W6 (token pressure)
