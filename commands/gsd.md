---
description: "GSD step mode — avança uma unidade de trabalho e para. Use /gsd auto para modo autônomo."
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


Use the **gsd** agent in **step mode**.

Read `.gsd/STATE.md` to find the next pending unit. Execute exactly one unit (one task, or one phase like plan/research/discuss/complete-slice). After the unit is done:
1. Write the appropriate artifact (summary, plan, research, etc.)
2. Update `.gsd/STATE.md` with the new position and next action
3. Report what was done in one concise paragraph
4. **Stop** — do not proceed to the next unit

If there is a `continue.md` in the active slice directory, resume from it instead (read it, delete it, execute from "Next Action").

$ARGUMENTS
