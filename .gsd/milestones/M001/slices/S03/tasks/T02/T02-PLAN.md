# T02: Migrate forge-auto to skills/forge-auto/SKILL.md + shim

status: DONE

**Slice:** S03  **Milestone:** M001

## Goal

Move the full content of `commands/forge-auto.md` into `skills/forge-auto/SKILL.md` with proper skill frontmatter, then replace `commands/forge-auto.md` with a thin shim that invokes `Skill("forge-auto")`.

## Must-Haves

### Truths
- `skills/forge-auto/SKILL.md` contains the complete forge-auto logic (bootstrap guard, load context, orchestrate, dispatch loop, all 7 steps, continue-here protocol)
- `skills/forge-auto/SKILL.md` has frontmatter with `disable-model-invocation: true`
- `commands/forge-auto.md` is reduced to a shim (< 15 lines) that calls `Skill("forge-auto")`
- The shim preserves the same `allowed-tools` list as the original command
- `/forge-auto` via shim produces identical behavior to the original command

### Artifacts
- `skills/forge-auto/SKILL.md` — new file, ~420 lines, full forge-auto logic
- `commands/forge-auto.md` — rewritten to shim, < 15 lines

### Key Links
- `commands/forge-auto.md` → `skills/forge-auto/SKILL.md` via Skill("forge-auto")
- `skills/forge-auto/SKILL.md` → `~/.claude/forge-dispatch.md` via Read (worker templates)

## Steps

1. Read `commands/forge-auto.md` in full (current version, post-S01 and S02 changes)
2. Create `skills/forge-auto/SKILL.md`:
   - Frontmatter: name, description, disable-model-invocation: true, allowed-tools (same list as original command)
   - Body: copy the entire content of forge-auto.md (everything after the frontmatter closing `---`)
3. Rewrite `commands/forge-auto.md` as a thin shim:
   ```yaml
   ---
   description: "GSD auto mode — executa o milestone inteiro de forma autonoma"
   allowed-tools: Read, Write, Edit, Bash, Agent, Skill, TaskCreate, TaskUpdate, TaskList, TaskStop, WebSearch, WebFetch
   ---
   ```
   Body: single instruction to invoke Skill("forge-auto")
4. Verify `skills/forge-auto/SKILL.md` has `disable-model-invocation: true`
5. Verify the shim is under 15 lines

## Standards
- **Target directory:** `skills/forge-auto/` for the skill, `commands/` for the shim
- **Reuse:** Content is a direct move, not a rewrite — preserve all logic exactly
- **Naming:** `SKILL.md` inside the skill directory (convention from existing skills)
- **Pattern:** follows existing skill pattern (see `skills/forge-brainstorm/SKILL.md` for frontmatter)

## Context
- Decision: all migrated skills use `disable-model-invocation: true` (bug #26251)
- Decision: commands/ become shims for backward compatibility
- The forge-auto content has already been modified by S01 (compact recovery) and S02 (lean orchestrator) — use the current version
- Do NOT add `allowed-tools` to the skill frontmatter — existing skills (forge-brainstorm etc.) do not have it. Only the command shim needs allowed-tools.
- Wait — check the ROADMAP: it specifies allowed-tools in the skill frontmatter. Follow the ROADMAP spec.
- Read `commands/forge-auto.md` first to get the current content
