# T01: Create commands/forge.md — thin REPL router

status: DONE

**Slice:** S03  **Milestone:** M001

## Goal

Create the new `/forge` entry point as a thin REPL router under 300 lines that shows project status and dispatches to skills via `Skill()` calls.

## Must-Haves

### Truths
- `/forge` displays a one-line project status (project name, active milestone, progress)
- `/forge` presents an interactive menu via AskUserQuestion with options: auto, task, new-milestone, status, help, sair
- Each menu option dispatches to the corresponding skill via `Skill()` tool
- After a skill returns, the loop continues (shows menu again)
- "sair" deactivates auto-mode if active and exits the loop
- Compact recovery check runs at the start of each loop iteration (checks compact-signal.json)
- Auto-resume detection: if auto-mode.json shows active:true, calls Skill("forge-auto") automatically
- File is under 300 lines total

### Artifacts
- `commands/forge.md` — new file, < 300 lines, REPL router (exports: /forge slash command)

### Key Links
- `commands/forge.md` → `skills/forge-auto/SKILL.md` via Skill("forge-auto")
- `commands/forge.md` → `skills/forge-task/SKILL.md` via Skill("forge-task")
- `commands/forge.md` → `skills/forge-new-milestone/SKILL.md` via Skill("forge-new-milestone")

## Steps

1. Read the ROADMAP S03-T01 spec for the exact structure and frontmatter
2. Create `commands/forge.md` with frontmatter: description, allowed-tools (Read, Bash, Skill, AskUserQuestion, TaskCreate, TaskUpdate)
3. Write the bootstrap guard section (same pattern as other commands: check CLAUDE.md and .gsd/STATE.md)
4. Write the initialization section: read STATE.md, check compact-signal.json, display one-line status
5. Write the loop: AskUserQuestion with 6 options, dispatch based on response
6. Write the compact recovery check at the top of each iteration
7. Write the auto-resume detection logic
8. Verify the file is under 300 lines — count lines
9. Verify the file content would be under 5K tokens (rough estimate: 300 lines * ~15 tokens/line = 4500)

## Standards
- **Target directory:** `commands/`
- **Reuse:** Follow the same bootstrap guard pattern from `commands/forge-auto.md`
- **Naming:** `forge.md` (no suffix — this is the primary entry point)
- **Pattern:** follows existing command frontmatter pattern (description + allowed-tools)

## Context
- Decision: /forge is a thin REPL router < 5K tokens that survives compaction (M001-CONTEXT.md)
- Decision: compact recovery in /forge loop checks compact-signal.json each iteration
- Decision: auto-resume is automatic via auto-mode.json detection
- Skills dispatched: forge-auto, forge-task, forge-new-milestone, forge-status, forge-help
- AskUserQuestion works inline (not forked) — compatible with REPL loop
- Read `commands/forge-auto.md` first for the bootstrap guard pattern to reuse
