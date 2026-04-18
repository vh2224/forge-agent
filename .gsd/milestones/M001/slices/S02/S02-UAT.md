# S02: Lean Orchestrator — UAT Script

**Slice:** S02  **Milestone:** M001  **Written:** 2026-04-15

## Prerequisites

- Forge agent installed (`install.sh` or `install.ps1` run, `~/.claude/forge-dispatch.md` present)
- A test project with at least one pending milestone/slice/task in `.gsd/STATE.md`
- Claude Code open in that test project

## Test Cases

| # | Action | Expected | Pass? |
|---|--------|----------|-------|
| 1 | Open `~/.claude/forge-dispatch.md` and search for `{content of` | Zero matches — all inlined-content placeholders are gone | |
| 2 | Open `~/.claude/forge-dispatch.md` and search for `Read:` or `Read if exists:` | At least one directive per template block (execute-task, plan-slice, plan-milestone, complete-slice, complete-milestone, discuss, research) | |
| 3 | Open `commands/forge-auto.md`, go to Step 3 "Build worker prompt" | No instruction to read artifact files; only placeholder substitution list present (`{WORKING_DIR}`, `{M###}`, etc.) | |
| 4 | Open `commands/forge-next.md`, go to Step 3 "Build worker prompt" | Same as above; selective memory injection block still present below the substitution list | |
| 5 | Run `/forge-next` on a task unit in the test project | Worker prompt dispatched and unit completes without error | |
| 6 | Run `/forge-auto` and let it complete 3+ units | No context overflow error; orchestrator context stays small (under 50K tokens after 3 units per Claude Code token counter) | |
| 7 | Run `/forge-next` on a task whose optional files (e.g. T##-SECURITY.md) do not exist | Worker reads what exists and skips gracefully; no "file not found" crash | |
| 8 | Run `/forge-auto` through a slice boundary (complete-slice unit) | complete-slice worker reads `S##-PLAN.md` and task summaries via Read tool without orchestrator inlining them | |

## Notes

- Tests 5–8 require a live project with `.gsd/` state. A scratch milestone with 3–4 stub tasks is sufficient.
- Token counter visibility: in Claude Code, the current context size is shown in the status bar. Compare before and after running 3 units to verify the lean pattern is in effect.
- If test 7 reveals a crash, check that the template block uses `Read if exists:` (not `Read:`) for that file.
