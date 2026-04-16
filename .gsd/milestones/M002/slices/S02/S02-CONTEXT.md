---
id: S02
milestone: M002
phase: implement
date: 2026-04-16
---

# S02: Verification Gate — Context

## Decisions

1. **Task-level gate reads `T##-PLAN` frontmatter `verify:`** — the executor invokes `forge-verify.js --plan <T##-PLAN.md> --cwd <WORKING_DIR> --unit execute-task/{T##}`. If the task plan's YAML frontmatter includes a `verify:` key, those commands take priority over all other sources. Task plans that omit `verify:` fall through to the discovery chain (prefs → package.json → no-stack).

2. **Slice-level gate reads `prefs.verification.preference_commands`** — the completer invokes `forge-verify.js --cwd <WORKING_DIR> --unit complete-slice/{S##}` without a `--plan` flag. Because there is no `--plan`, the discovery chain skips step 1 (task-plan source is always empty at slice level) and resolves to `preference_commands` from the project prefs, then the `package.json` allow-list, then graceful skip.

3. **Both invocations share the same 3-step discovery chain** (plan → prefs → package.json) but the missing `--plan` at slice level means step 1 is always empty for the completer. The script is the same binary — only the caller-supplied flags differ.

4. **Why split task-level and slice-level?** Task-level is for granular "this task broke typecheck" feedback during `partial` retries — the executor can diagnose and fix the single task's output before writing `T##-SUMMARY.md`. Slice-level is for pre-merge validation of the whole slice's cumulative output — all tasks have completed and the question is "is the slice safe to merge?". They may run different command sets (e.g., task runs fast typecheck only; slice runs full test + lint), and they have different failure semantics (partial vs blocked).

5. **Anti-recursion: verify failures never route through the Retry Handler** — task-level failures return `partial` (executor stops, orchestrator can re-dispatch); slice-level failures return `blocked` with `blocker_class: tooling_failure` (completer stops, orchestrator surfaces to user, does NOT retry automatically). The Retry Handler (S01) handles `Agent()` exceptions only — it never receives verification results. These two control-flow paths are mutually exclusive.

## Out-of-scope reminders

- **Milestone-level verification** is deferred — `complete-milestone` is unchanged in M002. The `## For complete-milestone` section of `forge-completer.md` has no verification gate.
- **Python / Go auto-detect** in the discovery chain is deferred — current package.json allow-list covers JS/TS stacks only.
- **Dependency audit** (e.g. `npm audit`) is deferred — not part of the verification gate scope in M002.
