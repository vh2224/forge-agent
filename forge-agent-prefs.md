---
# GSD Claude Agent Preferences
# Equivalente ao ~/.gsd/preferences.md mas para os agentes do Claude Code
# Editado via /forge-prefs ou manualmente
version: 1
---

## Modelos disponíveis

| Alias | Model ID | Uso recomendado |
|-------|----------|-----------------|
| `opus` | `claude-opus-4-7[1m]` | Análise profunda, decisões arquiteturais, planejamento |
| `sonnet` | `claude-sonnet-4-6` | Implementação, execução, tarefas padrão |
| `haiku` | `claude-haiku-4-5-20251001` | Tarefas leves, extração de memórias, operações rápidas |

Você pode usar o alias (`opus`) ou o model ID completo (`claude-opus-4-7[1m]`) em qualquer configuração.

**Fallback automático:** Se `claude-opus-4-7[1m]` não estiver disponível na sua conta (tier/região), o instalador detecta na instalação e faz downgrade para `claude-opus-4-6` nos frontmatters dos agentes. Sem intervenção manual necessária.

## Phase → Agent Routing

| Phase | Agent | Model ID | Alias |
|-------|-------|----------|-------|
| discuss-milestone | forge-discusser | claude-opus-4-7[1m] | opus |
| discuss-slice | forge-discusser | claude-opus-4-7[1m] | opus |
| research-milestone | forge-researcher | claude-opus-4-7[1m] | opus |
| research-slice | forge-researcher | claude-opus-4-7[1m] | opus |
| plan-milestone | forge-planner | claude-opus-4-7[1m] | opus |
| plan-slice | forge-planner | claude-opus-4-7[1m] | opus |
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

## Artifact Cleanup

Após um milestone ou task fechar com sucesso, os arquivos de planejamento/execução são arqueologia:
o valor real já foi extraído para AUTO-MEMORY.md, DECISIONS.md e CODING-STANDARDS.md.
Um resumo compacto é sempre gravado em LEDGER.md antes de qualquer cleanup.

```
milestone_cleanup: keep   # keep    = mantém tudo (padrão seguro)
                          # archive = move .gsd/milestones/M###/ → .gsd/archive/M###/
                          # delete  = remove .gsd/milestones/M###/ inteiramente

task_cleanup: keep        # keep    = mantém tudo (padrão seguro)
                          # archive = move .gsd/tasks/TASK-###/ → .gsd/archive/tasks/TASK-###/
                          # delete  = remove .gsd/tasks/TASK-###/ inteiramente
```

## Auto-mode Settings

```
compact_after: 50      # unidades por sessão antes do checkpoint (0 ou "unlimited" = sem limite)
                       # checkpoint não para o loop — apenas reseta contadores e continua
                       # aumente para milestones grandes, diminua se o contexto encher rápido
```

## Retry Settings

```
retry:
  max_transient_retries: 3      # per-unit cap before surfacing blocker
  base_backoff_ms: 2000         # first retry delay; doubled each attempt
  max_backoff_ms: 60000         # ceiling for computed backoff
```

**Retryable classes** (classifier returns `retry: true`):
`rate-limit`, `network`, `server`, `stream`, `connection` — these are transient; the
Retry Handler will sleep (exponential backoff, capped at `max_backoff_ms`) and reissue
the `Agent()` call up to `max_transient_retries` times.

**Non-retryable classes** (classifier returns `retry: false`):
`permanent` — auth / not-found / bad-request — fail immediately, surface to user.
`unknown` — unrecognised exception text — fail immediately (safe default; no blind retry).
Orchestrator-owned error classes that bypass the handler entirely:
`model_refusal`, `context_overflow`, `tooling_failure` — handled by the failure taxonomy
in `forge-auto` / `forge-next` (dispatch-level, not classifier-level).

See `scripts/forge-classify-error.js` for classifier implementation and
`shared/forge-dispatch.md ### Retry Handler` for the full control-flow algorithm.

## Verification Settings

O verification gate executa comandos de lint/typecheck/test antes de uma task ser marcada como concluída e antes de um slice ser squash-mergeado. Configurável pelo bloco abaixo — ou desabilitado globalmente com `enabled: false`. Quando `preference_commands` estiver vazio, o gate usa a ordem de descoberta descrita na subseção abaixo.

```
verification:
  preference_commands: []        # lista ordenada de comandos shell a executar como gate
                                 # vazio = fallback para T##-PLAN verify: ou auto-detect do package.json
  command_timeout_ms: 120000     # timeout por comando (ms); exit 124 sintético ao estourar
```

### Discovery chain

O gate resolve o conjunto de comandos em até 4 passos (para no primeiro que produzir pelo menos um comando):

1. `T##-PLAN.md` frontmatter `verify:` — task-level only; aceita string `"npm run typecheck && npm test"` ou array `["npm run typecheck", "npm test"]`. Slice-level (completer) pula este passo.
2. `verification.preference_commands` neste arquivo (ou override em `claude-agent-prefs.md` / `prefs.local.md`).
3. `package.json` scripts filtrados pelo allow-list `["typecheck", "lint", "test"]` (nessa ordem; scripts ausentes são ignorados).
4. Nenhum dos anteriores E sem `package.json` / `pyproject.toml` / `go.mod` detectado → `{skipped: "no-stack"}`, exit 0 (repos de documentação não bloqueiam).

### Allow-list

Hardcoded em `scripts/forge-verify.js` como `["typecheck", "lint", "test"]`. O gate **nunca** executa `start`, `dev`, `build`, `prepare`, `postinstall` ou scripts customizados via auto-detect. Para rodar um script fora do allow-list, use `preference_commands` ou declare explicitamente em `T##-PLAN.md` `verify:`.

### Timeout

Default 120 000 ms (2 min) por comando. Timeout produz exit code 124 e é registrado em `events.jsonl` como `{event:"verify", ..., passed: false}`. O check individual recebe `skipped: "timeout"` — mas isso **não é pass**: aciona o caminho normal de falha.

### Skip semantics

`skipped: "no-stack"` no resultado **top-level** significa que o gate inteiro foi ignorado (repo docs-only). Tratado como pass — não bloqueia merge. `skipped: "timeout"` num check **individual** é falha, não skip.

### Security note

> **Atenção:** `preference_commands` e `verify:` em `T##-PLAN.md` são executados no shell do repo com o CWD do projeto. Eles provêm de arquivos confiáveis (controlados por quem tem write access ao repo). NÃO adicione comandos não revisados — qualquer pessoa com acesso de escrita a `.gsd/claude-agent-prefs.md` ou a um `T##-PLAN.md` pode executar comandos shell arbitrários na sua máquina.

### Cross-references

- `scripts/forge-verify.js` — implementação completa (allow-list, sanitização, timeout, result schema).
- `shared/forge-dispatch.md ## Verification Gate` — contrato do gate e integração com o orquestrador.
- `agents/forge-executor.md` (step 10) — invocação no nível de task.
- `agents/forge-completer.md` (step 3 de complete-slice) — invocação no nível de slice.

## Update Settings

```
repo_path:    # preenchido pelo install.sh — caminho do repositório gsd-agent
```

## Notes

- Para mudar o modelo de uma fase, edite a coluna "Model" na tabela acima
  E atualize o frontmatter do agente correspondente em ~/.claude/agents/
- Modelos disponíveis: opus (claude-opus-4-7[1m], fallback claude-opus-4-6), sonnet (claude-sonnet-4-6), haiku (claude-haiku-4-5-20251001)
- Este arquivo é lido pelo orquestrador gsd.md a cada iteração do loop
- Para mudar comandos de verify, edite o bloco "verification:" acima. Veja scripts/forge-verify.js para a implementação.
