---
description: "Visualiza ou edita as preferências do agente GSD. Use: /gsd-prefs | /gsd-prefs set research opus | /gsd-prefs skip-research true | /gsd-prefs routing"
allowed-tools: Read, Write, Edit
---

Use the **gsd** agent to manage GSD agent preferences.

## Input
$ARGUMENTS

## Preferences file location
`~/.claude/gsd-agent-prefs.md`

## Operations

**No argument / "show":**
Read `~/.claude/gsd-agent-prefs.md` and display a clean summary:
- Current phase → agent routing table
- Skip rules status
- Dynamic routing config
- Git settings

**"routing":**
Show the full dispatch table — which agent and model handles each unit type.

**"set <phase> <model>"** (e.g. `set research haiku`, `set execute opus`):
Update the routing table for that phase. Valid phases: discuss, research, plan, execute, complete, memory.
Valid models: opus, sonnet, haiku.
1. Update the table row in `~/.claude/gsd-agent-prefs.md`
2. Update the `model:` frontmatter in the corresponding agent file (`~/.claude/agents/gsd-<agent>.md`)
3. Confirm the change

**"skip-research <true|false>":**
Toggle research phase skip. Updates `skip_research` in prefs file.

**"skip-discuss <true|false>":**
Toggle discuss phase skip.

**"git <setting> <value>"** (e.g. `git auto_push true`, `git merge_strategy merge`):
Update a git setting in the prefs file.

**"reset":**
Restore all defaults (opus for research/plan/discuss, sonnet for execute/complete, haiku for memory).

After any change, show the updated routing table.
