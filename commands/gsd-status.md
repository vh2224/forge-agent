---
description: "Mostra o estado atual do projeto GSD — milestone ativo, slice, tarefas pendentes e próxima ação."
allowed-tools: Read, Glob, Bash
---

Use the **gsd** agent. Read these files in order and produce a status dashboard:

1. `.gsd/STATE.md` — current position
2. Active `M###-ROADMAP.md` — slice completion status  
3. Active `S##-PLAN.md` — task completion status (if a slice is active)

Report in this format:
```
## Status GSD

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
