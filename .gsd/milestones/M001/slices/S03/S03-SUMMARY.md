---
id: S03
milestone: M001
provides:
  - commands/forge.md — unified /forge REPL entry point (126 lines, < 5K tokens, compact-safe)
  - skills/forge-auto/SKILL.md — full forge-auto logic migrated to skill
  - skills/forge-task/SKILL.md — full forge-task logic migrated to skill
  - skills/forge-new-milestone/SKILL.md — full forge-new-milestone logic migrated to skill
  - commands/forge-auto.md — thin 7-line shim
  - commands/forge-task.md — thin 6-line shim
  - commands/forge-new-milestone.md — thin 7-line shim
  - Verified install.sh + install.ps1 broad globs cover all new skill directories
key_files:
  - commands/forge.md
  - skills/forge-auto/SKILL.md
  - skills/forge-task/SKILL.md
  - skills/forge-new-milestone/SKILL.md
  - commands/forge-auto.md
  - commands/forge-task.md
  - commands/forge-new-milestone.md
key_decisions:
  - "/forge REPL loop reads STATE.md after each skill returns — stale status never shown"
  - "allowed-tools included in skill frontmatter per ROADMAP spec (T02-PLAN contradicted itself; ROADMAP won)"
  - "Shims forward $ARGUMENTS to skill per MEM017 — all argument handling stays in the skill"
  - "No edits to install scripts required — existing broad globs already cover all new skill directories"
  - "Exit path in forge.md checks for active auto-mode before deactivating — avoids clobbering auto-mode.json"
patterns_established:
  - "Command → Skill migration: copy body verbatim to skills/forge-<name>/SKILL.md with disable-model-invocation: true + allowed-tools, replace command body with Skill({ skill, args: '$ARGUMENTS' })"
  - "Compact-safe REPL: bootstrap guard + compact recovery check per loop iteration + AskUserQuestion dispatch"
---

Created the `/forge` unified REPL entry point and migrated three heavyweight commands (forge-auto, forge-task, forge-new-milestone) to skill files — shrinking command footprint from ~950 lines total to ~20 lines of shims while keeping all logic intact in isolated skill contexts.

## What Was Built

**T01 — /forge REPL router** created `commands/forge.md` as a 126-line thin router. It runs a bootstrap guard (CLAUDE.md + STATE.md presence), loads STATE.md for project context, auto-resumes if `auto-mode.json` shows active within 60 min (skipping the menu), then enters a persistent `AskUserQuestion` loop with 6 options dispatching to forge-auto, forge-task, forge-new-milestone, forge-status, and forge-help skills. A compact recovery check runs at the top of every loop iteration — the file itself stays well within the < 5K token compaction re-attachment budget.

**T02 — forge-auto migration** extracted the 423-line forge-auto logic into `skills/forge-auto/SKILL.md` (with `disable-model-invocation: true` and full `allowed-tools` list) and replaced `commands/forge-auto.md` with a 7-line shim. A frontmatter contradiction in T02-PLAN.md (one line said omit `allowed-tools`, the next said follow the ROADMAP) was resolved by the ROADMAP spec.

**T03 — forge-task migration** extracted ~300 lines of forge-task logic into `skills/forge-task/SKILL.md` and reduced `commands/forge-task.md` to a 6-line shim. No deviations.

**T04 — forge-new-milestone migration** extracted 215 lines into `skills/forge-new-milestone/SKILL.md` and reduced `commands/forge-new-milestone.md` to a 7-line shim, following the T02/T03 pattern exactly.

**T05 — install verification** confirmed that both `install.sh` (glob `"${REPO_DIR}/skills"/*/`) and `install.ps1` (`Get-ChildItem "$RepoDir\skills" -Directory`) already enumerate every skills subdirectory — zero script edits needed. Dry-run confirmed all three new skill directories and `commands/forge.md` are picked up. Binary scan of `install.ps1` found zero form-feed bytes (0x0C).

## Acceptance Criteria Status

| # | Criterion | Status |
|---|-----------|--------|
| 1 | `commands/forge.md` exists, < 300 lines, REPL with AskUserQuestion | PASS (126 lines) |
| 2 | `skills/forge-auto/SKILL.md` has full logic; shim calls `Skill("forge-auto")` | PASS |
| 3 | `skills/forge-task/SKILL.md` has full logic; shim calls `Skill("forge-task")` | PASS |
| 4 | `skills/forge-new-milestone/SKILL.md` has full logic; shim calls `Skill("forge-new-milestone")` | PASS |
| 5 | install.sh + install.ps1 pick up the three new skill directories | PASS (no edits needed) |
| 6 | All skills use `disable-model-invocation: true` | PASS |

## drill_down_paths

- T01: `.gsd/milestones/M001/slices/S03/tasks/T01/T01-SUMMARY.md`
- T02: `.gsd/milestones/M001/slices/S03/tasks/T02/T02-SUMMARY.md`
- T03: `.gsd/milestones/M001/slices/S03/tasks/T03/T03-SUMMARY.md`
- T04: `.gsd/milestones/M001/slices/S03/tasks/T04/T04-SUMMARY.md`
- T05: `.gsd/milestones/M001/slices/S03/tasks/T05/T05-SUMMARY.md`
