---
description: "GSD step mode — avança exatamente uma unidade de trabalho e para. Argumentos: 'next' (mesmo que sem argumento), 'auto' (delega para /forge-auto)."
allowed-tools: Read, Bash, Agent
---

## Parse arguments

From `$ARGUMENTS`:
- Empty, `next`, or `step` → **STEP MODE** (execute one unit, stop)
- `auto` → tell the user: "Use `/forge-auto` para modo autônomo." and stop.
- Anything else → treat as STEP MODE (ignore unknown args)

## Bootstrap guard

```bash
ls CLAUDE.md 2>/dev/null && echo "ok" || echo "missing"
ls .gsd/STATE.md 2>/dev/null && echo "ok" || echo "missing"
pwd
```

**Se CLAUDE.md não existe:** Stop. Tell the user:
> Projeto não inicializado. Execute `/forge-init` primeiro — isso cria o `CLAUDE.md` que restaura o contexto automaticamente ao reabrir o chat.

**Se .gsd/STATE.md não existe:** Stop. Tell the user:
> Nenhum projeto GSD encontrado neste diretório. Execute `/forge-init` para começar.

---

## Delegate — não execute nada aqui

Read these files (and ONLY these):
1. `.gsd/STATE.md`
2. `~/.claude/forge-agent-prefs.md` (skip silently if missing)
3. `.gsd/claude-agent-prefs.md` (skip silently if missing)
4. First 80 lines of `.gsd/AUTO-MEMORY.md` (skip silently if missing)

Then call the `forge` agent with this prompt (fill in the actual file contents):

```
STEP MODE.

WORKING_DIR: {absolute path from pwd}

STATE:
{full content of .gsd/STATE.md}

PREFS:
{content of ~/.claude/forge-agent-prefs.md}
{content of .gsd/claude-agent-prefs.md if exists, otherwise "(none)"}

TOP_MEMORIES:
{first 80 lines of AUTO-MEMORY.md, or "(none yet)"}

ARGUMENTS: $ARGUMENTS

Execute exactly ONE unit (the next unit indicated in STATE).
Dispatch it to the appropriate specialized sub-agent — do not execute it yourself.
Return a concise report of what was done and what STATE is now.
```

---

## Surface the result

Display the agent's report to the user. Do not add any summary or follow-up — the user will decide whether to run `/forge-next` again or proceed differently.
