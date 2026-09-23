---
description: "Forge REPL — ponto de entrada unificado. Mostra status do projeto e navega por modo autônomo, tasks, milestones e ajuda."
allowed-tools: Read, Bash, Skill, AskUserQuestion, TaskCreate, TaskUpdate
---

## Load personal context (also on every refresh)

Read `shared/forge-personal-context.md` from the repository or FORGE_HOME.
Resolve the scripts directory, then run:

```bash
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-personal-context.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
node "$FORGE_SCRIPTS_DIR/forge-personal-context.js" --snapshot --cwd . --json
```

This load is read-only. Do not sync instructions, create memory, migrate state,
remove continue.md, read global STATE/auto-mode/compact markers, or discover team work.
Use the snapshot's project, works, pending decisions/acceptances, lastResult,
nextAction and source/hash/capture diagnostics. Show no-bindings distinctly from
error or attention-required. Historical operational prose does not override it.
Technical knowledge remains available through canonical memory/decision projections.

## REPL loop

At the first iteration, after compact recovery, and **after each skill returns**,
repeat the snapshot command above. Do not infer recovery from process activity.
Display personal work and next action with provenance; never select by mtime.
Offer auto, next, task, new-milestone, status, help and sair through the host's
permitted question adapter (`shared/forge-interaction.md`). Unanswered required
choices stay pending. `sair` closes this menu without touching another process.

| Choice | Action |
|---|---|
| auto / next | Run `forge-cli-helpers.js --resolve-args --cwd .` first. Only resume an unambiguous personal candidate. Route a task to `forge-task --resume ID`; a milestone to the chosen auto/next skill with ID. |
| task | Call `forge-task` for the supplied description. |
| new-milestone | Call `forge-new-milestone`. |
| status | Call `forge-status`; workspace diagnostics only when explicitly requested with `--scope workspace`. |
| help | Call `forge-help`. |
| sair | Emit `forge encerrado. Execute /forge para retomar.` and stop. |

For multiple candidates ask for an ID. Zero bindings or attention-required is not
permission to discover or dispatch colleagues' work. Explicit inspection does not
bind; an explicitly selected resume uses the bind contract before reading handoff.
After any skill returns, refresh with --snapshot and return to the menu.
