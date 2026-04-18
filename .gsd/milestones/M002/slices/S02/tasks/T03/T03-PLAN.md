# T03: Wire task-level verify gate into `agents/forge-executor.md`

status: DONE

**Slice:** S02  **Milestone:** M002

## Goal

Modify `agents/forge-executor.md` to invoke `scripts/forge-verify.js` (T01) at
the correct process step, using the contract documented in `shared/forge-dispatch.md
## Verification Gate` (T02). On non-zero exit, the executor refuses `done` and
returns `partial` with the failure context injected into the next retry prompt.
On skip (`no-stack`), the executor continues normally.

## Must-Haves

### Truths

- `agents/forge-executor.md` modified. The existing `## Process` section (currently steps 1–12) gains a new step between step 9 ("Verify every must-have") and step 10 ("Git commit"):
  ```
  10. **Verification gate** — invoke:
      ```bash
      node scripts/forge-verify.js --plan {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/tasks/{T##}/{T##}-PLAN.md --cwd {WORKING_DIR} --unit execute-task/{T##}
      ```
      Parse the JSON result:
      - `passed: true` and (no `skipped` OR `skipped: "no-stack"`) → continue to step 11.
      - `passed: false` → STOP. Return `---GSD-WORKER-RESULT---` with `status: partial` and include the `formatFailureContext` output as `## Verification Failures` in the `blocker` field (truncated to 10 KB). Do NOT write T##-SUMMARY.md. Do NOT commit. Do NOT mark the task `DONE` in frontmatter.
      - `skipped: "no-stack"` at top level → treat as pass; record `discoverySource: "none"` in T##-SUMMARY.md `## Verification` section.
  ```
- All subsequent steps renumbered: old 10 (git commit) → 11; old 11 (write summary) → 12; old 12 (mark DONE) → 13. Keep the `2.5` step as-is (Security Checklist).
- T##-SUMMARY.md format updated: the `## Verification` section is added (required when gate ran). Shape:
  ```
  ## Verification

  - Gate: passed | skipped (no-stack)
  - Discovery source: package-json | task-plan | preference | none
  - Commands:
    - `npm run typecheck` (exit 0, 4200ms)
    - `npm test` (exit 0, 12500ms)
  - Total duration: 16700ms
  ```
  Record even on `no-stack` (for audit trail).
- New process-level instruction in the `## Process` intro or a dedicated `## Verification Gate` subsection: on gate failure, the `blocker` text must preserve the `formatFailureContext` output VERBATIM (not summarized) so the next retry sees the actual stderr, not a paraphrase.
- The existing `## Verification Ladder` section (Static / Lint & Format / Command / Behavioral / Human) is UPDATED: add a note that "Tier 2 (Lint & Format) is now enforced automatically by the verification gate (step 10). Executors should still run lint proactively during development but the gate is the final checkpoint." Do NOT remove the ladder — it remains guidance during step-by-step execution.
- Preserve the existing "2.5 Security Checklist" logic verbatim.
- Preserve the existing "Research Freely", "Helper-First Protocol", "DRY Guard", and "Summary Format" sections untouched.
- The frontmatter (`name`, `model`, `effort`, `tools`) is unchanged. `tools` already includes `Bash` — no additions needed.

### Artifacts

- `agents/forge-executor.md` — modified. Step 10 inserted; steps 10–12 renumbered to 11–13; `## Verification Ladder` note added; `## Summary Format` `## Verification` section mentioned as required.

### Key Links

- `agents/forge-executor.md` → `scripts/forge-verify.js` (T01) via `Bash` tool invocation.
- `agents/forge-executor.md` → `shared/forge-dispatch.md ## Verification Gate` (T02) — agent follows the contract.

## Steps

1. Read `agents/forge-executor.md` in full to locate the current `## Process` numbered list (1–12) and the `## Verification Ladder` subsection.
2. Read `shared/forge-dispatch.md ## Verification Gate` (T02 output) to confirm the CLI shape and failure-handling contract.
3. Read `scripts/forge-verify.js` (T01 output) to confirm the exit code semantics (0 = pass or no-stack, 1 = any failed check).
4. Use `Edit` tool to insert new step 10:
   - Match the exact text of the existing step 10 ("Git commit (only if `auto_commit: true` ...)") and prepend the new step with proper numbering.
   - Or: replace the entire `## Process` numbered list block with the updated version (cleaner, less risk of off-by-one).
5. Use `Edit` tool to renumber subsequent steps (11 → 12, 12 → 13) carefully — step numbers appear in the body of step 2.5 ("Mark task as in-flight") and step 12 ("Mark task complete"), so check both.
6. Add the `## Verification` section requirement to the `## Summary Format` section (below the YAML frontmatter spec). Example:
   ```markdown
   Follow with: **one substantive liner** + `## What Happened` + `## Deviations` + `## Files Created/Modified` + `## Verification`
   ```
7. Add the short note to `## Verification Ladder`: "The verification gate (process step 10) enforces lint/typecheck/test automatically. The ladder below remains operational guidance during development." Place the note directly under the `## Verification Ladder` heading, before the numbered list.
8. Verify the file is still parseable Markdown: `grep -c "^## " agents/forge-executor.md` should return the expected count (pre-count + 0 if `## Verification Gate` is a sub-point of `## Process`, or +1 if added as own section). Also check frontmatter is intact (file starts with `---`, YAML valid).
9. Write `T03-SUMMARY.md` with:
   - Before/after line counts.
   - Diff summary: new step 10 text (one line), renumbering list (old → new).
   - Confirmation that frontmatter is unchanged.
   - Quick smoke: grep confirms `node scripts/forge-verify.js` appears exactly once in the file.

## Standards

- **Target directory:** `agents/` — modifying existing file only; no new agents.
- **Reuse:** CLI shape copied verbatim from `shared/forge-dispatch.md ## Verification Gate` (T02). Do NOT re-derive or paraphrase.
- **Naming:** section heading `## Verification Gate` or inline within `## Process` step 10; consistency with existing `## Verification Ladder`.
- **Frontmatter:** unchanged — `name: forge-executor`, `model: claude-sonnet-4-6`, `effort: low`, `tools: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch`. Per `CODING-STANDARDS.md` Frontmatter Conventions, Sonnet agents use `effort: low` (preserve).
- **Lint command:** `node -e "require('fs').readFileSync('agents/forge-executor.md','utf8')"` to confirm readable. No Markdown linter configured.
- **Pattern:** no direct Pattern Catalog entry (agent modification is a tracked-but-unpatterned activity). Follow the voice + structure of the existing file.

## Context

- **W4 mitigation:** task-level gate uses `--plan` flag (T##-PLAN frontmatter `verify:` read); slice-level gate (T04) omits `--plan`. Both paths are the same binary — discovery chain handles the difference.
- **W3 mitigation:** executor treats verify failures as `partial`, NOT as `Agent()` exceptions. The Retry Handler (S01) is for orchestrator-level exceptions; verify failures bypass it entirely. The executor's `partial` return signals the orchestrator to re-dispatch the worker with the failure context — this is the retry loop, and it is classifier-free.
- **Anti-recursion:** because verify runs at step 10 (after must-haves verified), a re-dispatch with injected failure context re-runs steps 1–10. If the failure persists after N re-dispatches, the orchestrator surfaces a permanent blocker. The script itself is not recursive.
- **MEM011 compliance:** executor's `Bash` invocation passes paths only (`--plan {path} --cwd {path}`). `forge-verify.js` reads the files itself.
- **Key files to read first:**
  - `agents/forge-executor.md` (current structure — locate exact insertion points)
  - `shared/forge-dispatch.md ## Verification Gate` (T02 — contract source)
  - `scripts/forge-verify.js` (T01 — exit code semantics)
  - `.gsd/milestones/M002/slices/S02/S02-PLAN.md` criterion 6 (task-level gate blocks `done`)
