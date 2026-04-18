# S03: /forge REPL Shell — UAT Script

**Slice:** S03  **Milestone:** M001  **Written:** 2026-04-15

## Prerequisites

- Forge agent installed (`install.sh` or `install.ps1` run successfully)
- A project with `.gsd/STATE.md` and `CLAUDE.md` present (any forge-initialized project)
- Claude Code CLI available and running in that project directory

## Test Cases

| # | Action | Expected | Pass? |
|---|--------|----------|-------|
| 1 | Run `/forge` in a project without `auto-mode.json` active | Bootstrap guard passes; STATE.md is read; AskUserQuestion menu appears with 6 options | |
| 2 | Inspect `commands/forge.md` line count | File has fewer than 300 lines (target: 126) | |
| 3 | From the `/forge` menu, select "Start forge-auto (full autonomous mode)" | `Skill("forge-auto")` is invoked; forge-auto logic runs normally | |
| 4 | From the `/forge` menu, select "Run a standalone forge-task" | `Skill("forge-task")` is invoked; forge-task prompt/flow runs normally | |
| 5 | From the `/forge` menu, select "Create a new milestone" | `Skill("forge-new-milestone")` is invoked; new-milestone flow begins normally | |
| 6 | Run `/forge-auto` directly (via shim) | Shim delegates to `Skill("forge-auto")` — forge-auto runs identically to pre-migration behavior | |
| 7 | Run `/forge-task <description>` directly | Shim delegates to `Skill("forge-task")` — task executes normally, `$ARGUMENTS` forwarded correctly | |
| 8 | Run `/forge-new-milestone <description>` directly | Shim delegates to `Skill("forge-new-milestone")` — milestone creation flow begins | |
| 9 | Inspect `skills/forge-auto/SKILL.md` frontmatter | Contains `disable-model-invocation: true` | |
| 10 | Inspect `skills/forge-task/SKILL.md` frontmatter | Contains `disable-model-invocation: true` | |
| 11 | Inspect `skills/forge-new-milestone/SKILL.md` frontmatter | Contains `disable-model-invocation: true` | |
| 12 | Run `install.sh --dry-run --update` | Output lists `forge-auto`, `forge-task`, `forge-new-milestone` skill dirs and `commands/forge.md` | |
| 13 | Create a dummy `auto-mode.json` with `active: true` and `started_at` within 60 min; run `/forge` | `/forge` skips the menu and auto-resumes forge-auto via `Skill("forge-auto")` | |
| 14 | Run `/forge` in a directory without `CLAUDE.md` or `.gsd/STATE.md` | Bootstrap guard fires; user sees a clear error message directing them to run `/forge-init` | |

## Notes

- Tests 3–5 verify skill dispatch from the REPL; tests 6–8 verify direct command shims are backward-compatible.
- Test 13 verifies the auto-resume path; this requires the auto-mode.json to have been created by a real or mock forge-auto run.
- The UAT does not require a full forge-auto run to complete — the goal is to confirm dispatch wiring, not end-to-end milestone execution (covered by M001/S01–S02 UAT).
- install.ps1 binary check for form-feed (0x0C) is covered by T05 automated verification; manual re-check only needed if install.ps1 is edited after this slice.
