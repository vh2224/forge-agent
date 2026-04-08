---
description: "GSD auto mode — executa o milestone inteiro de forma autônoma. Equivalente ao /gsd auto do gsd-pi."
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent
---

## Bootstrap guard (sempre executar primeiro)

Before doing anything else, run:
```bash
ls CLAUDE.md 2>/dev/null && echo "ok" || echo "missing"
ls .gsd/STATE.md 2>/dev/null && echo "ok" || echo "missing"
```

**Se CLAUDE.md não existe:** Stop and tell the user:
> Projeto não inicializado. Execute `/gsd-init` primeiro — isso cria o `CLAUDE.md` que restaura o contexto automaticamente ao reabrir o chat.

**Se .gsd/STATE.md não existe:** Stop and tell the user:
> Nenhum projeto GSD encontrado neste diretório. Execute `/gsd-init` para começar.

**Se `.gsd/AUTO-MEMORY.md` não existe:** Create it silently before proceeding:
```
<!-- gsd-auto-memory | project: <from PROJECT.md or directory name> | extraction_count: 0 -->
<!-- ranked by: confidence × (1 + hits × 0.1) | cap: 50 active -->
```

---


Use the **gsd** agent in **AUTO MODE**.

Read `.gsd/STATE.md` to determine the active milestone and next pending unit. Then run the full orchestration loop:

1. Derive next unit from STATE.md using the dispatch table
2. Build a focused prompt with inlined file content for that unit
3. Dispatch to the `gsd-worker` sub-agent (fresh context per unit)
4. Parse the worker result, advance state, loop
5. Repeat until: milestone complete OR blocker requires human input OR 3 consecutive failures

**Stop conditions:**
- All slices in the active milestone are marked `[x]` in the ROADMAP → report milestone complete
- Worker returns `status: blocked` → surface the blocker and stop
- 3 consecutive failures on the same unit → escalate to user with diagnosis

**Do not ask for confirmation between units.** Run autonomously. Emit one progress line per unit as you go.

$ARGUMENTS
