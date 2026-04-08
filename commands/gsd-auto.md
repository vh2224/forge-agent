---
description: "GSD auto mode — executa o milestone inteiro de forma autônoma. Equivalente ao /gsd auto do gsd-pi."
allowed-tools: Read, Bash, Agent
---

## Bootstrap guard

```bash
ls CLAUDE.md 2>/dev/null && echo "ok" || echo "missing"
ls .gsd/STATE.md 2>/dev/null && echo "ok" || echo "missing"
pwd
```

**Se CLAUDE.md não existe:** Stop. Tell the user:
> Projeto não inicializado. Execute `/gsd-init` primeiro — isso cria o `CLAUDE.md` que restaura o contexto automaticamente ao reabrir o chat.

**Se .gsd/STATE.md não existe:** Stop. Tell the user:
> Nenhum projeto GSD encontrado neste diretório. Execute `/gsd-init` para começar.

---

## Delegate — não execute nada aqui

Read these files (and ONLY these):
1. `.gsd/STATE.md`
2. `~/.claude/gsd-agent-prefs.md` (skip silently if missing)
3. `.gsd/claude-agent-prefs.md` (skip silently if missing)
4. First 80 lines of `.gsd/AUTO-MEMORY.md` (skip silently if missing)

Then call the `gsd` agent with this prompt (fill in the actual file contents):

```
AUTO MODE.

WORKING_DIR: {absolute path from pwd}

STATE:
{full content of .gsd/STATE.md}

PREFS:
{content of ~/.claude/gsd-agent-prefs.md}
{content of .gsd/claude-agent-prefs.md if exists, otherwise "(none)"}

TOP_MEMORIES:
{first 80 lines of AUTO-MEMORY.md, or "(none yet)"}

ARGUMENTS: $ARGUMENTS

Run the full auto-mode orchestration loop. For each unit, dispatch to the
appropriate specialized sub-agent — never execute any unit yourself.
Return a final summary of all units completed this session.
```

---

## Surface the result

After the `gsd` agent returns:

- If result contains `---GSD-COMPACT---`: tell the user:
  > Batch completo. O orquestrador processou N unidades nesta sessão e salvou o estado. Execute `/gsd-auto` novamente para continuar de onde parou.

- Otherwise: display the agent's final summary to the user.
