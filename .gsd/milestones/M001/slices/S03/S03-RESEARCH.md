# S03: /forge REPL Shell — Research

**Researched:** 2026-04-15
**Domain:** Claude Code commands/skills architecture
**Confidence:** HIGH

## Summary

The three commands targeted for migration (forge-auto, forge-task, forge-new-milestone) are 422, 474, and 214 lines respectively. At ~10 tokens/line, forge-auto is ~4,200 tokens and forge-task is ~4,740 tokens — both within the 5K skill re-attachment budget but forge-task is borderline. forge-new-milestone at 214 lines (~2,100 tokens) has generous room. The install scripts already have broad glob patterns (`skills/*/` in bash, `Get-ChildItem "$RepoDir\skills" -Directory` in PowerShell) that will automatically pick up any new skill directories — T05 is primarily verification, not modification.

No existing skill uses `disable-model-invocation: true` in its frontmatter. This is a new pattern being introduced by S03. The ROADMAP specifies this field for all three migrated skills to prevent bug #26251. The field has been discussed and decided (see DECISIONS.md row from 2026-04-15) but has zero precedent in the current skills directory. Testing is essential.

The shim pattern for commands is straightforward: keep the same frontmatter (description + allowed-tools) and replace the body with a single `Skill("forge-<name>")` call. The `$ARGUMENTS` variable must be forwarded — forge-task uses `$ARGUMENTS` for `--resume`, `--skip-brainstorm`, `--skip-research` flags; forge-new-milestone uses it for `-fast` flag and milestone description. forge-auto explicitly ignores arguments but should still forward them for consistency (the skill ignores them internally).

## Token Size Analysis

| Command | Lines | Est. Tokens | Fits 5K? | Notes |
|---------|-------|-------------|----------|-------|
| forge-auto.md | 422 | ~4,200 | YES (tight) | Largest file. Worker Prompt Templates section references forge-dispatch.md — content stays in SKILL.md |
| forge-task.md | 474 | ~4,740 | BORDERLINE | Most lines. Has inline dispatch templates (not shared via forge-dispatch.md). Could trim whitespace/comments |
| forge-new-milestone.md | 214 | ~2,100 | YES (ample) | Smallest. Clean migration |

**forge-task.md risk:** At 474 lines, this is the largest command. If the 5K budget is strict (token-counted, not line-estimated), it may exceed. Mitigation: strip blank lines between sections (the original has generous spacing), compress inline code block examples. The dispatch templates in forge-task are inline (not in forge-dispatch.md) so they cannot be moved out without refactoring the dispatch architecture.

## Install Script Analysis

### install.sh (lines 149-161)
```bash
for skill_dir in "${REPO_DIR}/skills"/*/; do
  skill_name="$(basename "$skill_dir")"
  for target in "$SKILLS_DIR_AGENTS" "$SKILLS_DIR_CLAUDE"; do
    dst="${target}/${skill_name}"
    ...
    cp -r "${skill_dir}"* "$dst/"
  done
done
```
Glob `skills/*/` matches any subdirectory. New directories `skills/forge-auto/`, `skills/forge-task/`, `skills/forge-new-milestone/` will be picked up automatically. Copies to both `~/.agents/skills/` and `~/.claude/skills/`.

### install.ps1 (lines 121-133)
```powershell
foreach ($skillDir in Get-ChildItem "$RepoDir\skills" -Directory) {
    $skillName = $skillDir.Name
    foreach ($target in @($SkillsDirAgents, $SkillsDirClaude)) {
        ...
        Copy-Item "$($skillDir.FullName)\*" $dst -Recurse -Force
    }
}
```
Same broad glob. Will pick up new directories automatically. No `\f` risk in this block.

### commands/forge.md glob coverage
Both installers use `forge*.md` glob for commands. `forge.md` starts with `forge` — it matches. Verified.

## Existing Skill Frontmatter Pattern

All six existing skills use this frontmatter pattern:
```yaml
---
name: forge-<name>
description: <one-line description>
---
```

Fields observed: `name`, `description` only. No skill currently uses:
- `disable-model-invocation`
- `allowed-tools`
- `thinking` / `effort`

The ROADMAP spec adds `disable-model-invocation: true` and `allowed-tools: [list]` to the migrated skills. This is a NEW pattern — the executor must verify Claude Code actually supports these fields in skill frontmatter (not just command frontmatter).

## $ARGUMENTS Forwarding Pattern

Commands access `$ARGUMENTS` as a magic variable injected by Claude Code when a slash command is invoked. Current usage patterns:

| Command | How $ARGUMENTS is used |
|---------|----------------------|
| forge-task | `--resume TASK-###`, `--skip-brainstorm`, `--skip-research`, remaining text = description |
| forge-new-milestone | `-fast` flag, remaining text = milestone description |
| forge-auto | Explicitly ignores all arguments (documented in the command) |
| forge-ask | `resume`, `close`, `list`, or free text |
| forge-discuss | Similar flag/text parsing |

**Key question for shims:** When a command shim calls `Skill("forge-auto")`, does the skill receive `$ARGUMENTS`? The Skill tool documentation suggests skills receive arguments via the `args` parameter of the `Skill()` call, not via `$ARGUMENTS`. The shims may need to pass: `Skill({ skill: "forge-auto", args: "$ARGUMENTS" })`.

**Pattern from existing code:** In forge-new-milestone, Skill() calls pass args explicitly:
```
Skill({ skill: "forge-brainstorm", args: "{MILESTONE_ID}: {MILESTONE_DESC}" })
```

So the shims should forward: `Skill({ skill: "forge-task", args: "$ARGUMENTS" })` and the skill body should parse from args instead of `$ARGUMENTS`.

## AskUserQuestion Loop Pattern

**forge-new-milestone.md** (Step 4) is the clearest example of AskUserQuestion in a sequential loop:
- Asks 3-5 questions one at a time
- Each question has 2-4 concrete options
- "Other" is added automatically by the tool
- Waits for answer before next question
- Records decisions in CONTEXT.md

**forge.md REPL pattern** (from T01-PLAN) will be different: a persistent loop with AskUserQuestion presenting a menu of 6 options, dispatching to skills, then showing the menu again. This is not an interrogation loop but a command router. The "sair" option exits. Compact recovery check runs at the top of each iteration.

No existing command implements this persistent REPL-style loop. This is a new pattern for T01.

## Common Pitfalls

### Pitfall 1: $ARGUMENTS vs Skill args
**What goes wrong:** Shim calls `Skill("forge-task")` without forwarding arguments. Skill body still references `$ARGUMENTS` which is empty in skill context.
**Why it happens:** `$ARGUMENTS` is a slash-command-only magic variable. Skills receive args via `Skill({ args: "..." })`.
**How to avoid:** Shims must forward: `Skill({ skill: "forge-task", args: "$ARGUMENTS" })`. Skill body must parse from the skill args mechanism, not `$ARGUMENTS`. Test: `/forge-task --skip-brainstorm my task` should work through the shim.

### Pitfall 2: forge-task token budget
**What goes wrong:** forge-task.md at 474 lines may exceed 5K token re-attachment budget after compaction.
**Why it happens:** Lines are a rough proxy for tokens. Dense code blocks and long inline templates inflate token count.
**How to avoid:** After creating `skills/forge-task/SKILL.md`, count tokens more precisely. If over budget, strip excessive whitespace between sections (20+ blank lines can be reduced to 1-2).

### Pitfall 3: allowed-tools in skill frontmatter
**What goes wrong:** Claude Code may not support `allowed-tools` in skill frontmatter (only documented for commands).
**Why it happens:** Skills and commands have different frontmatter schemas. The ROADMAP assumes allowed-tools works for skills.
**How to avoid:** Test with a minimal skill that has `allowed-tools` in frontmatter. If unsupported, the tools restriction may need to live in the skill body as instructions rather than frontmatter enforcement.

### Pitfall 4: disable-model-invocation preventing Skill() calls
**What goes wrong:** Bug #26251 — `disable-model-invocation: true` may prevent even explicit `Skill()` invocations, not just auto-detection.
**Why it happens:** The flag's implementation may be overly broad in some Claude Code versions.
**How to avoid:** Test immediately after T02 (first migration). If the flag blocks Skill() calls, fall back to removing it and relying on the skill name (non-catchy names like "forge-auto" are unlikely to auto-trigger).

### Pitfall 5: install.ps1 form feed bug
**What goes wrong:** Any string containing `\f` in PowerShell source is interpreted as form feed (0x0C) when the file is generated by Claude.
**Why it happens:** Claude's output processing interprets backslash escape sequences.
**How to avoid:** T05 must grep for `\f` in install.ps1 after any edits. Currently the file is clean. The three new skill directory names (forge-auto, forge-task, forge-new-milestone) do not contain `f` after a backslash, so this risk is low for S03.

## Relevant Code

| File | Role | Lines |
|------|------|-------|
| `commands/forge-auto.md` | Source for T02 migration | 422 |
| `commands/forge-task.md` | Source for T03 migration | 474 |
| `commands/forge-new-milestone.md` | Source for T04 migration | 214 |
| `install.sh` lines 149-161 | Skills glob (already covers new dirs) | 13 |
| `install.ps1` lines 121-133 | Skills glob (already covers new dirs) | 13 |
| `shared/forge-dispatch.md` | Worker prompt templates (referenced by forge-auto) | — |
| `skills/forge-brainstorm/SKILL.md` | Existing skill pattern (frontmatter: name+description only) | 132 |
| `skills/forge-security/SKILL.md` | Existing skill pattern with multi-step process | 126 |

## Asset Map — Reusable Code

| Asset | Path | Exports | Use When |
|-------|------|---------|----------|
| Bootstrap guard pattern | `commands/forge-auto.md` lines 8-18 | CLAUDE.md + STATE.md check | Creating any new command or skill that needs project context |
| Load context pattern | `commands/forge-auto.md` lines 24-52 | PREFS, STATE, ALL_MEMORIES, CODING_STANDARDS | Any orchestrator command that needs full project context |
| Skill invocation pattern | `commands/forge-new-milestone.md` lines 55-58 | Agent wrapping Skill() | When a command needs to call a skill via isolated subagent |
| Direct Skill pattern | `commands/forge-auto.md` lines 157, 166 | Skill() inline | When orchestrator calls skill in main context |
| AskUserQuestion sequential | `commands/forge-new-milestone.md` lines 91-97 | One-at-a-time questions | Interactive discuss/decision phases |
| Heartbeat write pattern | `commands/forge-auto.md` lines 232-235 | auto-mode.json write | Any command that tracks active worker state |
| Compact recovery pattern | `commands/forge-auto.md` lines 102-118 | compact-signal.json check | Commands that survive compaction |
| Dispatch table | `commands/forge-auto.md` lines 122-135 | unit_type derivation | Any orchestrator that needs to determine next work unit |

## Coding Conventions Detected

- **File naming:** `forge-<name>.md` for commands, `SKILL.md` inside `skills/forge-<name>/` for skills
- **Function naming:** N/A (markdown-based, no functions)
- **Directory structure:** `commands/` flat, `skills/<name>/` one dir per skill, `agents/` flat
- **Import style:** N/A (no imports — files reference each other by convention name)
- **Error patterns:** Bootstrap guard at top of every command (check CLAUDE.md + STATE.md)
- **Test patterns:** `--dry-run` flag on install scripts; no unit tests for commands/skills

## Pattern Catalog — Recurring Structures

| Pattern | When to Use | Files to Create | Key Steps |
|---------|-------------|-----------------|-----------|
| Command → Skill migration | Moving command logic to a reusable skill | `skills/forge-<name>/SKILL.md`, update `commands/forge-<name>.md` to shim | 1. Copy command body to SKILL.md 2. Add skill frontmatter (name, description, disable-model-invocation) 3. Replace command body with `Skill("forge-<name>")` 4. Keep command allowed-tools identical 5. Test both paths |
| Bootstrap guard | Creating any command that needs project state | N/A (inline pattern) | 1. `ls CLAUDE.md` check 2. `ls .gsd/STATE.md` check (if needed) 3. Stop with user message if missing |
| Skill frontmatter | Creating a new skill | `skills/forge-<name>/SKILL.md` | 1. `name:` field 2. `description:` one-liner 3. `disable-model-invocation: true` (if not auto-triggered) 4. Body in XML-like sections: objective, essential_principles, process, success_criteria |

## Security Considerations

No security-sensitive scope in S03. Commands/skills being migrated do not handle auth, crypto, user input, or secrets directly. Omitted.

## Sources

- File reads: `commands/forge-auto.md` — 422 lines, full orchestrator with dispatch loop, compaction resilience, failure taxonomy
- File reads: `commands/forge-task.md` — 474 lines, standalone task flow with 5 dispatch steps (brainstorm, discuss, research, plan, execute)
- File reads: `commands/forge-new-milestone.md` — 214 lines, milestone creation with brainstorm/scope/discuss/plan/risk-radar steps
- File reads: `install.sh` lines 149-161 — skills glob `"${REPO_DIR}/skills"/*/` copies all skill dirs to two targets
- File reads: `install.ps1` lines 121-133 — `Get-ChildItem "$RepoDir\skills" -Directory` copies all skill dirs
- File reads: 6 existing skills — all use `name` + `description` only frontmatter, no `disable-model-invocation` or `allowed-tools`
- File reads: `commands/forge-new-milestone.md` — AskUserQuestion sequential pattern at Step 4
- File reads: `.gsd/DECISIONS.md` — confirms `disable-model-invocation: true` decision for all migrated skills
