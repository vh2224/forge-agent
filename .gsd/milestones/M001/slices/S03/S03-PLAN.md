# S03 — /forge REPL Shell

**Milestone:** M001 — Forge v1.0: Autonomous, Shell-first, Context-aware
**Depends on:** S01 (PostCompact Recovery), S02 (Lean Orchestrator)
**Risk:** medium

## Objective

Create the `/forge` unified entry point as a thin REPL router (< 300 lines / < 5K tokens), migrate three commands (forge-auto, forge-task, forge-new-milestone) to `skills/` with `disable-model-invocation: true`, and update both install scripts to copy the new skill directories.

## Acceptance Criteria

1. `commands/forge.md` exists, is < 300 lines, implements a REPL loop with AskUserQuestion
2. `skills/forge-auto/SKILL.md` contains the full forge-auto logic; `commands/forge-auto.md` is a thin shim that calls `Skill("forge-auto")`
3. `skills/forge-task/SKILL.md` contains the full forge-task logic; `commands/forge-task.md` is a thin shim
4. `skills/forge-new-milestone/SKILL.md` contains the full forge-new-milestone logic; `commands/forge-new-milestone.md` is a thin shim
5. `install.sh` and `install.ps1` already copy all `skills/*/` directories — verify the three new skill directories are picked up by the existing glob
6. All skills use `disable-model-invocation: true` in frontmatter

## Tasks

- [x] **T01:** Create commands/forge.md — thin REPL router (< 300 lines)
- [x] **T02:** Migrate forge-auto to skills/forge-auto/SKILL.md + shim
- [x] **T03:** Migrate forge-task to skills/forge-task/SKILL.md + shim
- [x] **T04:** Migrate forge-new-milestone to skills/forge-new-milestone/SKILL.md + shim
- [x] **T05:** Verify install.sh + install.ps1 handle new skills

## Key Constraint

- `commands/forge.md` must survive compaction: < 5K tokens budget
- install.ps1 must NOT contain `\f` literal (form feed bug)
- Skills must have `disable-model-invocation: true` to avoid bug #26251
