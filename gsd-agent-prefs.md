---
# GSD Claude Agent Preferences
# Equivalente ao ~/.gsd/preferences.md mas para os agentes do Claude Code
# Editado via /gsd-prefs ou manualmente
version: 1
---

## Phase → Agent Routing

| Phase | Agent | Model | When |
|-------|-------|-------|------|
| discuss-milestone | gsd-discusser | opus | Captura decisões antes de planejar |
| discuss-slice | gsd-discusser | opus | Decisões de slice específico |
| research-milestone | gsd-researcher | opus | Pesquisa pesada de codebase |
| research-slice | gsd-researcher | opus | Pesquisa de slice |
| plan-milestone | gsd-planner | opus | Decomposição em slices + boundary map |
| plan-slice | gsd-planner | opus | Decomposição em tasks + T##-PLANs |
| execute-task | gsd-executor | sonnet | Implementação de tarefa |
| complete-slice | gsd-completer | sonnet | Summary + UAT + squash merge |
| complete-milestone | gsd-completer | sonnet | Summary final do milestone |
| memory-extract | gsd-memory | haiku | Extração de memórias (fire-and-forget) |

## Phase Skip Rules

```
skip_discuss: false        # true = pula discuss, vai direto para research/plan
skip_research: false       # true = pula research, vai direto para plan
skip_slice_research: false # true = pula research de slice
reassess_after_slice: false # true = reavalia roadmap após cada slice
```

## Dynamic Routing Overrides

Quando uma task é marcada como "simples" pelo planner, o orquestrador pode
usar um agente mais leve. Configurado pelo planner no T##-PLAN.md via
`complexity: light | standard | heavy`.

```
light    → gsd-executor  (sonnet)   # tasks de rotina, mudanças simples
standard → gsd-executor  (sonnet)   # tasks normais
heavy    → gsd-executor  (opus)     # tasks com decisões arquiteturais complexas
```

## Git Settings

```
merge_strategy: squash    # squash | merge | rebase
auto_push: false          # push automático após squash merge
main_branch: master       # branch principal
isolation: none           # none | worktree (worktree = branch isolado por milestone)
```

## Update Settings

```
repo_path:    # preenchido pelo install.sh — caminho do repositório gsd-agent
```

## Notes

- Para mudar o modelo de uma fase, edite a coluna "Model" na tabela acima
  E atualize o frontmatter do agente correspondente em ~/.claude/agents/
- Modelos disponíveis: opus (claude-opus-4-6), sonnet (claude-sonnet-4-6), haiku (claude-haiku-4-5-20251001)
- Este arquivo é lido pelo orquestrador gsd.md a cada iteração do loop
