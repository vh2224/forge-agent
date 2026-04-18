# T04: Migrate forge-new-milestone to skills/forge-new-milestone/SKILL.md + shim

status: DONE

**Slice:** S03  **Milestone:** M001

## Goal

Move the full content of `commands/forge-new-milestone.md` into `skills/forge-new-milestone/SKILL.md` with proper skill frontmatter, then replace `commands/forge-new-milestone.md` with a thin shim.

## Must-Haves

### Truths
- `skills/forge-new-milestone/SKILL.md` contains the complete forge-new-milestone logic (bootstrap, parse flags, steps 1-7: context read, brainstorm, scope clarity, discuss, plan, risk radar, state update)
- `skills/forge-new-milestone/SKILL.md` has frontmatter with `disable-model-invocation: true`
- `commands/forge-new-milestone.md` is reduced to a shim (< 15 lines) that calls `Skill("forge-new-milestone")`
- The shim preserves the same `allowed-tools` list as the original command
- `/forge-new-milestone <description>` via shim produces identical behavior

### Artifacts
- `skills/forge-new-milestone/SKILL.md` — new file, ~215 lines, full forge-new-milestone logic
- `commands/forge-new-milestone.md` — rewritten to shim, < 15 lines

### Key Links
- `commands/forge-new-milestone.md` → `skills/forge-new-milestone/SKILL.md` via Skill("forge-new-milestone")
- `skills/forge-new-milestone/SKILL.md` → `skills/forge-brainstorm/SKILL.md` via Skill("forge-brainstorm")
- `skills/forge-new-milestone/SKILL.md` → `skills/forge-scope-clarity/SKILL.md` via Skill("forge-scope-clarity")
- `skills/forge-new-milestone/SKILL.md` → `skills/forge-risk-radar/SKILL.md` via Skill("forge-risk-radar")

## Steps

1. Read `commands/forge-new-milestone.md` in full
2. Create `skills/forge-new-milestone/SKILL.md`:
   - Frontmatter per ROADMAP spec: name: forge-new-milestone, description, disable-model-invocation: true, allowed-tools: Read, Write, Edit, Bash, Agent, Skill, AskUserQuestion, EnterPlanMode, ExitPlanMode
   - Body: full content of forge-new-milestone.md after its frontmatter
3. Rewrite `commands/forge-new-milestone.md` as a thin shim:
   - Same frontmatter (description + allowed-tools from original)
   - Body: instruction to invoke Skill("forge-new-milestone") and pass $ARGUMENTS through
4. Verify `disable-model-invocation: true` is present
5. Verify shim is under 15 lines

## Standards
- **Target directory:** `skills/forge-new-milestone/` for skill, `commands/` for shim
- **Reuse:** Direct content move — no logic changes
- **Naming:** `SKILL.md` inside skill directory
- **Pattern:** Same migration pattern as T02 and T03

## Context
- Decision: all migrated skills use `disable-model-invocation: true`
- Decision: commands/ become backward-compatible shims
- The shim must pass $ARGUMENTS (includes -fast flag and milestone description)
- Read `commands/forge-new-milestone.md` first
