# T03: Migrate forge-task to skills/forge-task/SKILL.md + shim

status: DONE

**Slice:** S03  **Milestone:** M001

## Goal

Move the full content of `commands/forge-task.md` into `skills/forge-task/SKILL.md` with proper skill frontmatter, then replace `commands/forge-task.md` with a thin shim.

## Must-Haves

### Truths
- `skills/forge-task/SKILL.md` contains the complete forge-task logic (parse args, bootstrap, load context, determine TASK_ID, init task, cleanup orphaned tasks, dispatch loop with 5 steps, post-task housekeeping, compact signal)
- `skills/forge-task/SKILL.md` has frontmatter with `disable-model-invocation: true`
- `commands/forge-task.md` is reduced to a shim (< 15 lines) that calls `Skill("forge-task")`
- The shim preserves the same `allowed-tools` list as the original command
- `/forge-task <description>` via shim produces identical behavior to the original command

### Artifacts
- `skills/forge-task/SKILL.md` — new file, ~475 lines, full forge-task logic
- `commands/forge-task.md` — rewritten to shim, < 15 lines

### Key Links
- `commands/forge-task.md` → `skills/forge-task/SKILL.md` via Skill("forge-task")

## Steps

1. Read `commands/forge-task.md` in full
2. Create `skills/forge-task/SKILL.md`:
   - Frontmatter per ROADMAP spec: name: forge-task, description, disable-model-invocation: true, allowed-tools: Read, Write, Edit, Bash, Agent, Skill, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
   - Body: full content of forge-task.md after its frontmatter
3. Rewrite `commands/forge-task.md` as a thin shim:
   - Same frontmatter (description + allowed-tools from original)
   - Body: instruction to invoke Skill("forge-task") and pass $ARGUMENTS through
4. Verify `disable-model-invocation: true` is present
5. Verify shim is under 15 lines

## Standards
- **Target directory:** `skills/forge-task/` for skill, `commands/` for shim
- **Reuse:** Direct content move — no logic changes
- **Naming:** `SKILL.md` inside skill directory
- **Pattern:** Same migration pattern as T02

## Context
- Decision: all migrated skills use `disable-model-invocation: true`
- Decision: commands/ become backward-compatible shims
- The shim must pass $ARGUMENTS to the skill so flags like --skip-brainstorm and --resume work
- Read `commands/forge-task.md` first
