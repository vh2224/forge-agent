---
# GSD Claude Agent Preferences
# Equivalente ao ~/.gsd/preferences.md mas para os agentes do Claude Code
# Editado via /forge-prefs ou manualmente
version: 1
---

## Modelos disponíveis

| Alias | Model ID | Uso recomendado |
|-------|----------|-----------------|
| `opus` | `claude-opus-4-6` | Análise profunda, decisões arquiteturais, planejamento |
| `sonnet` | `claude-sonnet-4-6` | Implementação, execução, tarefas padrão |
| `haiku` | `claude-haiku-4-5-20251001` | Tarefas leves, extração de memórias, operações rápidas |

Você pode usar o alias (`opus`) ou o model ID completo (`claude-opus-4-6`) em qualquer configuração.

## Phase → Agent Routing

| Phase | Agent | Model ID | Alias |
|-------|-------|----------|-------|
| discuss-milestone | forge-discusser | claude-opus-4-6 | opus |
| discuss-slice | forge-discusser | claude-opus-4-6 | opus |
| research-milestone | forge-researcher | claude-opus-4-6 | opus |
| research-slice | forge-researcher | claude-opus-4-6 | opus |
| plan-milestone | forge-planner | claude-opus-4-6 | opus |
| plan-slice | forge-planner | claude-opus-4-6 | opus |
| execute-task | forge-executor | claude-sonnet-4-6 | sonnet |
| complete-slice | forge-completer | claude-sonnet-4-6 | sonnet |
| complete-milestone | forge-completer | claude-sonnet-4-6 | sonnet |
| memory-extract | forge-memory | claude-haiku-4-5-20251001 | haiku |

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
light    → forge-executor  (sonnet)   # tasks de rotina, mudanças simples
standard → forge-executor  (sonnet)   # tasks normais
heavy    → forge-executor  (opus)     # tasks com decisões arquiteturais complexas
```

## Effort Settings

Controla a intensidade de processamento por fase. Opus suporta `low | medium | high | max`. Sonnet suporta `low | medium`.

```
effort:
  plan-milestone:    medium   # opus — decomposição arquitetural
  plan-slice:        medium   # opus — planejamento de tasks
  discuss-milestone: medium   # opus — decisões de arquitetura
  discuss-slice:     medium   # opus — decisões de slice
  research-milestone: medium  # opus — pesquisa de codebase
  research-slice:    medium   # opus — pesquisa de slice
  execute-task:      low      # sonnet — implementação (custo-efetivo)
  complete-slice:    low      # sonnet — summaries e git
  complete-milestone: low     # sonnet — fechamento de milestone
  memory-extract:    low      # haiku — extração leve
```

## Thinking Settings

Controla raciocínio estendido para agentes Opus. `adaptive` = modelo decide quanto pensar.

```
thinking:
  opus_phases: adaptive    # adaptive | disabled
  sonnet_phases: disabled  # sonnet não suporta extended thinking
```

## Git Settings

```
auto_commit: true         # false = agente NÃO faz commits/merges (usuário gerencia git)
merge_strategy: squash    # squash | merge | rebase (ignorado se auto_commit: false)
auto_push: false          # push automático após squash merge (ignorado se auto_commit: false)
main_branch: master       # branch principal
isolation: none           # none | worktree (worktree = branch isolado por milestone)
```

## Auto-mode Settings

```
compact_after: 50      # unidades por sessão antes do checkpoint (0 ou "unlimited" = sem limite)
                       # checkpoint não para o loop — apenas reseta contadores e continua
                       # aumente para milestones grandes, diminua se o contexto encher rápido
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
