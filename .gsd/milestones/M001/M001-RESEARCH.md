# M001: Forge v1 Architecture — Commands vs Skills, REPL Pattern — Research

**Researched:** 2026-04-15
**Domain:** Claude Code extensibility / context engineering
**Confidence:** HIGH

## Summary

The proposed architecture of "single `/forge` command + everything as skills" is viable and aligns with Claude Code's current direction. As of v2.1.3 (Jan 2026), commands and skills have been **merged** -- files in `~/.claude/commands/` and `~/.claude/skills/` both create `/slash-command` entries and work identically. Skills add optional features: supporting files, `disable-model-invocation`, `context: fork`, and dynamic context injection via shell commands. **There is no deprecation of commands** -- existing command files keep working -- but the official recommendation is to write new extensions as skills.

The critical finding for the architecture decision is **how compaction handles skills vs CLAUDE.md**: After auto-compaction, Claude Code re-attaches the most recent invocation of each skill, keeping the first 5,000 tokens of each, sharing a combined budget of 25,000 tokens. Skills are re-attached from most-recently-invoked first, so older skills can be **dropped entirely** if many were invoked. This is fundamentally different from CLAUDE.md, which is always re-read from disk and re-injected fresh after compaction. This means a "single command that invokes many skills" approach has a risk: if the main `/forge` command is large AND it invokes several sub-skills, the `/forge` content itself could be dropped after compaction, losing the orchestration logic. The current multi-command architecture (each command is a separate entry point) actually **avoids this problem** because only one command is active at a time.

**AskUserQuestion** has a 60-second timeout and **cannot be used in subagents** (background subagents auto-deny it; foreground subagents pass it through). This means a REPL pattern using AskUserQuestion in the main context is feasible for interactive flows, but any skill invoked with `context: fork` loses the ability to ask the user questions. Multi-round interview patterns (5-10 rounds) have been demonstrated successfully in community examples. There is no documented turn limit for AskUserQuestion loops -- the constraint is the context window, not a hard cap.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Skill auto-detection | Custom dispatch logic for skill discovery | Native `description` + `when_to_use` frontmatter | Claude Code already matches skills to context automatically; 1,536 char cap on description+when_to_use |
| Context isolation for workers | Manual Agent() dispatch with hand-built prompts | `context: fork` in skill frontmatter + `agent` field | Native support for forked execution with agent type selection |
| Dynamic context injection | Reading files in command preamble | `` !`command` `` syntax in SKILL.md | Preprocesses before content reaches Claude; shell output replaces placeholder |
| Subagent tool restrictions | Prompt-level "do not use X" | `tools` / `disallowedTools` in agent frontmatter | Enforced at runtime, not just advisory |
| Permission auto-approval | Custom tool approval logic | `allowed-tools` in skill frontmatter | Native per-skill tool pre-approval |
| Persistent memory per agent | Custom memory file management | `memory: user\|project\|local` in agent frontmatter | Built-in directory management, auto-injected 200 lines of MEMORY.md |
| Post-compaction recovery | Custom "re-read everything" logic | PostToolUse hook on `compact` matcher | Official lifecycle hook; stdout injected as system message |

## Common Pitfalls

### Pitfall 1: Skill content dropped after compaction
**What goes wrong:** A large skill (>5,000 tokens) invoked early in a long session gets truncated or dropped entirely after compaction if newer skills were invoked after it.
**Why it happens:** Re-attached skills share a 25,000-token combined budget, filled from most-recent first. Each skill capped at 5,000 tokens.
**How to avoid:** Keep skill content under 5,000 tokens. For the orchestration command, this is critical -- the dispatch logic must fit within this budget. Alternatively, move persistent orchestration rules to CLAUDE.md (always re-injected fresh) and keep skills task-specific.

### Pitfall 2: AskUserQuestion fails silently in background subagents
**What goes wrong:** A skill running in a subagent tries to ask the user a question; the call fails and the subagent continues without the answer, potentially making wrong assumptions.
**Why it happens:** Background subagents auto-deny AskUserQuestion. Foreground subagents pass it through, but `context: fork` skills run as subagents.
**How to avoid:** Any skill that needs user input (discuss, brainstorm) must either: (a) run inline (no `context: fork`), or (b) collect all questions upfront before forking. The REPL pattern should run in the main context, not as a forked skill.

### Pitfall 3: Skill description budget exhaustion
**What goes wrong:** With many skills installed, descriptions get truncated to fit the character budget (1% of context window, fallback 8,000 chars), and Claude stops matching skills to user requests.
**Why it happens:** Each skill's combined `description` + `when_to_use` is capped at 1,536 chars, and total budget is limited.
**How to avoid:** Use `disable-model-invocation: true` for skills that should only be invoked explicitly (most forge-* skills). This removes them from the description budget entirely. Only leave auto-detection on for skills where Claude should proactively apply them.

### Pitfall 4: Commands still take priority quirk
**What goes wrong:** A file in `.claude/commands/deploy.md` and `.claude/skills/deploy/SKILL.md` both exist. The skill takes precedence, potentially breaking an expected command.
**Why it happens:** Skills win over commands when names conflict.
**How to avoid:** During migration from commands to skills, remove or rename the command file to avoid ambiguity.

### Pitfall 5: Subagents cannot spawn subagents
**What goes wrong:** A forge-executor subagent tries to delegate a sub-task to another subagent, and the call fails.
**Why it happens:** Subagent nesting is explicitly prohibited -- "Subagents cannot spawn other subagents."
**How to avoid:** All Agent() dispatch must happen from the main context (the orchestrator). Workers/subagents must return results to the orchestrator, which then dispatches the next step. This validates the current forge architecture.

### Pitfall 6: `context: fork` loses conversation history
**What goes wrong:** A forked skill receives only its SKILL.md content + CLAUDE.md, not the conversation history. It starts "cold."
**Why it happens:** By design -- "It won't have access to your conversation history."
**How to avoid:** For the REPL pattern, the main `/forge` command must run inline (NOT forked). Only delegate discrete, self-contained tasks via `context: fork`.

## Relevant Code

### Current Architecture (commands-based)
- `commands/forge-auto.md` (L1-450+) -- Main autonomous loop, dispatch table, Agent() calls, compaction recovery. This is the largest command and contains the orchestrator logic.
- `commands/forge-next.md` -- Step mode, single unit dispatch, same dispatch table.
- `commands/forge-task.md` -- Standalone task flow (brainstorm -> discuss -> research -> plan -> execute).
- `commands/forge-new-milestone.md` -- Milestone creation with Agent() for brainstorm/scope skills.

### Skills (currently 6)
- `skills/forge-brainstorm/SKILL.md` -- Invoked via `Skill()` from commands, auto-sufficient.
- `skills/forge-scope-clarity/SKILL.md`
- `skills/forge-risk-radar/SKILL.md`
- `skills/forge-security/SKILL.md`
- `skills/forge-ui-review/SKILL.md`
- `skills/forge-responsive/SKILL.md`

### Agents (subagent definitions)
- `agents/forge-executor.md` -- Sonnet, code implementation
- `agents/forge-planner.md` -- Opus, decomposition
- `agents/forge-discusser.md` -- Opus, uses AskUserQuestion
- `agents/forge-researcher.md` -- Opus, codebase exploration
- `agents/forge-completer.md` -- Sonnet, slice/milestone closure
- `agents/forge-memory.md` -- Haiku, memory extraction

### Installation
- `install.sh` -- Copies agents to `~/.claude/agents/`, commands to `~/.claude/commands/`, skills to BOTH `~/.agents/skills/` AND `~/.claude/skills/`.

## Architecture Analysis: "Single /forge Command" vs Current Multi-Command

### Option A: Single `/forge` REPL command (proposed v1)
**Pros:**
- Single entry point reduces cognitive load
- REPL loop with AskUserQuestion enables interactive dispatch
- Consolidates orchestrator logic in one place

**Cons:**
- The orchestrator command (forge-auto.md) is already 450+ lines. A unified REPL would be even larger.
- After compaction, skill content capped at 5,000 tokens. If `/forge` exceeds this, orchestration logic is lost.
- REPL pattern runs inline in main context -- all conversation history accumulates, no context isolation between REPL "turns"
- AskUserQuestion has 60-second timeout per question -- adequate for interactive use but creates pressure in autonomous flows

### Option B: Keep multi-command, modernize to skills (recommended hybrid)
**Pros:**
- Each command/skill is self-contained, under 5,000 tokens each -- survives compaction
- `context: fork` for worker skills gets native context isolation
- `disable-model-invocation: true` prevents Claude from auto-triggering forge workflows
- `allowed-tools` per skill replaces manual tool lists
- Dynamic context injection (`` !`command` ``) replaces manual file reading preambles
- Agent frontmatter (`model`, `effort`, `skills` preloading) replaces manual parameter injection

**Cons:**
- Multiple entry points (21 commands currently)
- User needs to know which command to use

### Recommended Hybrid: `/forge` as thin router + skills
1. **One visible command**: `/forge` -- thin REPL that uses AskUserQuestion to determine intent, then invokes the appropriate skill via `Skill()`.
2. **All sub-systems as skills**: `forge-auto`, `forge-task`, `forge-init`, etc. as skills with `disable-model-invocation: true` + `user-invocable: false` (only the router invokes them).
3. **Workers as subagents**: Keep `agents/` for executor, planner, discusser etc. -- these are delegated via Agent() from within the skill context.
4. **Orchestration logic in CLAUDE.md**: Move the dispatch table and state machine rules to CLAUDE.md (survives compaction intact) rather than embedding in the skill/command.

**Key insight**: The dispatch table and state machine (which drives forge-auto) should live in CLAUDE.md or a file that's always re-read, NOT in a skill that can be truncated/dropped after compaction.

### Context Hand-off for Autonomous Mode
The `context: fork` pattern provides native context isolation. However, `forge-auto`'s dispatch loop needs to persist in the main context (it calls Agent() and processes results). The compaction recovery mechanism in the current forge-auto.md (re-read STATE.md, re-initialize variables) is still needed. The PostToolUse hook on `compact` could automate this recovery.

## Security Considerations

| Concern | Risk Level | Recommended Mitigation |
|---------|------------|------------------------|
| `allowed-tools` grants broad permissions | MEDIUM | Use `Bash(git *)` syntax for specific tool+argument patterns, not blanket `Bash` |
| Skills with shell injection (`!`command``) | HIGH | Skills from untrusted sources can execute arbitrary commands at load time. `disableSkillShellExecution: true` in settings disables this for non-managed skills |
| `bypassPermissions` in subagents | HIGH | Never use in forge agents. Use `acceptEdits` or `auto` for worker subagents that need write access |
| Plugin subagents ignore hooks/mcpServers/permissionMode | LOW | Forge agents are personal (not plugins), so this doesn't apply, but worth noting |

## Sources

### Official Documentation (confidence: HIGH)
- Web fetch: `https://code.claude.com/docs/en/skills` -- Complete skill system docs including compaction behavior, frontmatter reference, lifecycle, supporting files. **Key finding**: "Re-attached skills share a combined budget of 25,000 tokens. Claude Code fills this budget starting from the most recently invoked skill, so older skills can be dropped entirely after compaction."
- Web fetch: `https://code.claude.com/docs/en/sub-agents` -- Subagent system docs. **Key finding**: "Subagents cannot spawn other subagents", AskUserQuestion behavior in foreground vs background, `context: fork` loses conversation history, `skills` field for preloading.

### Web Searches (confidence: HIGH)
- Web search: `Claude Code slash commands vs skills difference` -- Confirmed merge in v2.1.3 (Jan 2026). Commands still work but skills are recommended. Skills add directory for supporting files, frontmatter control.
- Web search: `Claude Code context compaction commands re-injected skills behavior` -- CLAUDE.md re-read from disk after compaction. Skills re-attached with 5K token cap per skill, 25K total budget.
- Web search: `Claude Code AskUserQuestion loop timeout limitations` -- 60-second timeout. Subagents cannot use AskUserQuestion (background auto-denies, foreground passes through).
- Web search: `Claude Code Skill tool programmatic invocation vs slash command` -- Both user and Claude can invoke skills. `disable-model-invocation: true` prevents auto-invocation. `user-invocable: false` hides from menu but doesn't block Skill tool.

### Community Examples (confidence: MEDIUM)
- Web fetch: `https://neonwatty.com/posts/interview-skills-claude-code/` -- Multi-round AskUserQuestion patterns (5-10 rounds) demonstrated successfully. No reported context issues.
- Web search: `context engineering claude code orchestrator framework multi-agent 2026` -- Multiple frameworks exist (Ruflo, Shipyard, CodeMachine-CLI) but none implement the "single REPL command" pattern. Most use multi-command or headless CLI patterns.
- Web fetch: `https://medium.com/@joe.njenga/claude-code-merges-slash-commands-into-skills` -- Confirmed merge is integration not deprecation. Existing `.claude/commands/` files keep working.

### GitHub Issues (confidence: MEDIUM)
- Web search result: `github.com/anthropics/claude-code/issues/18721` -- AskUserQuestion limitation in subagents. Subagents are strictly non-interactive.
- Web search result: `github.com/anthropics/claude-code/issues/26251` -- Bug: `disable-model-invocation: true` may prevent user invocation too in some versions. Worth testing.
