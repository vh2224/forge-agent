---
description: "Mostra o estado atual do projeto GSD — milestone ativo, slice, tarefas pendentes e próxima ação."
allowed-tools: Read, Glob, Bash
---

## Bootstrap guard (sempre executar primeiro)

Before doing anything else, run these in parallel:
```bash
ls CLAUDE.md 2>/dev/null && echo "ok" || echo "missing"
ls .gsd/STATE.md 2>/dev/null && echo "ok" || echo "missing"
```

```bash
REPO=$(grep 'repo_path:' ~/.claude/forge-agent-prefs.md 2>/dev/null | cut -d: -f2 | tr -d ' ')
if [ -n "$REPO" ] && [ -d "$REPO/.git" ]; then
  LOCAL=$(cd "$REPO" && git describe --tags --always 2>/dev/null)
  REMOTE=$(cd "$REPO" && git ls-remote --tags origin 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)
  echo "FORGE_VERSION=$LOCAL"
  [ -n "$REMOTE" ] && [ "$REMOTE" != "$(cd "$REPO" && git describe --tags --abbrev=0 2>/dev/null)" ] && echo "FORGE_UPDATE=$REMOTE" || echo "FORGE_UPDATE=none"
else
  echo "FORGE_VERSION=unknown"
  echo "FORGE_UPDATE=none"
fi
```

**Se CLAUDE.md não existe:** Stop and tell the user:
> Projeto não inicializado. Execute `/forge-init` primeiro — isso cria o `CLAUDE.md` que restaura o contexto automaticamente ao reabrir o chat.

**Se .gsd/STATE.md não existe:** Stop and tell the user:
> Nenhum projeto GSD encontrado neste diretório. Execute `/forge-init` para começar.

**Se `.gsd/AUTO-MEMORY.md` não existe:** Create it silently before proceeding:
```
<!-- gsd-auto-memory | project: <from PROJECT.md or directory name> | extraction_count: 0 -->
<!-- ranked by: confidence × (1 + hits × 0.1) | cap: 50 active -->
```

---


Read these files in order and produce a status dashboard:

1. `.gsd/STATE.md` — current position
2. Active `M###-ROADMAP.md` — slice completion status  
3. Active `S##-PLAN.md` — task completion status (if a slice is active)

Report in this format:
```
## Status GSD

**Forge Agent:** {FORGE_VERSION}  {if FORGE_UPDATE != none: "⚠ Nova versão disponível: {FORGE_UPDATE} — /forge-update"}
**Milestone ativo:** M### — Title
**Progresso:** X/Y slices concluídos

### Slices
- [x] S01: Title
- [ ] S02: Title  ← ativo
  - [x] T01: done
  - [ ] T02: pending  ← próxima tarefa
  - [ ] T03: pending

### Próxima ação
<exact next action from STATE.md>

### Blockers
<list or "Nenhum">
```

$ARGUMENTS
