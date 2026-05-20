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
```

> **Deprecated:** `isolation: none | worktree` (legacy single-run flag) substituído pelo bloco
> `forge_isolation:` abaixo. Operadores em workspaces existentes não precisam migrar — o orquestrador
> trata ausência de `forge_isolation:` como `mode: shared`.

## Forge Isolation (multi-run)

Controla como múltiplos `/forge-auto`/`/forge-task` simultâneos isolam suas mudanças.
Aplicado a partir do M004 — Multi-Run Workspace. Default mantém comportamento single-run.

```
forge_isolation:
  mode: shared              # shared | branch | worktree
                            # shared   = single working tree; concorrência protegida por file-locks
                            # branch   = cria forge/{M###} em cada repo afetado, commits ali
                            # worktree = cria worktree física por milestone, isolamento total

  branch_pattern: "forge/{M###}"    # nome da branch quando mode=branch
                                    # placeholders: {M###} (milestone ID), {kind}, {id}
  auto_pull_main: true              # git pull main antes de criar branch (idempotente se exists)
  pr_on_complete: false             # opt-in: complete-milestone roda `npm run pr` / `gh pr create`

  worktree_root: ".forge-worktrees"  # diretório raiz onde worktrees são criadas
                                     # path relativo ao workspace; absoluto também aceito
  worktree_cleanup_on_complete: false # remove worktree ao completar milestone

  file_locks: true                   # ativa PreToolUse file-lock check (default true em shared/branch)
                                     # ignorado em mode=worktree (FS já isolado)

  repos:
    auto_detect: true        # walk de subdirs com .git/ na raiz do workspace
    include: []              # globs explícitos; quando definido, ignora auto_detect
    exclude:                 # globs a excluir do auto-detect
      - "node_modules/**"
      - "vendor/**"
      - ".forge-worktrees/**"
```

### Semântica de cada modo

- **shared** (padrão): zero overhead, sem mudança de fluxo git. File-locks (próximo bloco) protegem
  contra writes simultâneos no mesmo arquivo. Recomendado para projetos solo ou início de adoção.
- **branch**: alinhado ao fluxo `pr/BRANCHING.md` (cria `forge/M###`, pull main first, commit ali,
  PR no fim opcional). Conflitos cross-run viram merge-time, resolvidos pelo operador.
- **worktree**: isolamento físico total. Cada milestone roda numa worktree separada — zero risco
  de overlap. Custo: disco × N milestones simultâneas, IDE complexity.

### Override por run

`forge_isolation.mode` pode ser sobrescrito por run individual via CLI flag (futuro: `/forge-auto M065 --isolation=worktree`). Por enquanto, edite prefs antes de iniciar.

### Cross-references

- `shared/forge-state.md` §2 — campo `isolation_mode` no `runs/{id}.json`
- `scripts/forge-repos.js` (S08) — implementação do auto-detect
- `scripts/forge-isolation.js` (S08) — setup/cleanup de branch + worktree

## Multi-Run

```
multi_run:
  stale_cleanup_ms: 1800000     # 30min — registros stale são deletados no próximo boot
  stale_warning_ms: 180000      # 3min — statusline vira amarela
  stale_red_ms: 300000          # 5min — statusline vira vermelha; CLI trata como morto
  refused_when_active_count: 2  # /forge-auto sem ID refuse quando >= N runs ativas
                                # (1 = sempre exige ID; 999 = nunca refuse)
  dashboard_refresh_on:         # eventos que disparam regen do .gsd/STATE.md dashboard
    - boot
    - exit
    - phase_change
  legacy_alias: true            # mantém .gsd/forge/auto-mode.json como mirror do oldest active
                                # false = arquivo só é tocado por código pré-M004 (deprecation path)
```

### Semântica

- **stale_cleanup_ms**: ao boot de qualquer `/forge-*` skill, `runs/*.json` com `last_heartbeat`
  mais velho que esse limite são deletados silenciosamente. Cobre kills sem cleanup.
- **stale_warning_ms** / **stale_red_ms**: visíveis na statusline e dashboard. Não bloqueiam —
  apenas comunicam saúde da run.
- **refused_when_active_count**: comportamento do `/forge-auto` (e similares) sem argumento.
  Threshold de quantas runs ativas exigem ID explícito.
- **dashboard_refresh_on**: pontos do ciclo que chamam `scripts/forge-dashboard.js`. Adicionar
  `tick` cria regen periódico (custoso — não recomendado).

### Cross-references

- `scripts/forge-runs.js` — implementação do cleanup + alias refresh
- `scripts/forge-dashboard.js` — regen do STATE.md
- `skills/forge-auto/SKILL.md` (S06) — refuse logic

## Parallelism

```
parallelism:
  max_concurrent: 3       # máximo de execute-task em paralelo dentro do mesmo slice
                          # range válido: 1-8
  cross_run_overlap: defer  # defer | block
                          # defer = pula task com overlap, escolhe outra ready do batch
                          # block = pausa batch até outra run liberar o arquivo
```

### Semântica

- **max_concurrent**: já existia em M002; controla intra-run parallelism via
  `scripts/forge-parallelism.js`. M004 estende com cross-run check.
- **cross_run_overlap**: comportamento quando o batch atual tem task com `expected_output`
  que sobrepõe `expected_output` de outra run ativa.
  - `defer` (padrão): match com filosofia intra-run; descarta task do batch, escolhe próxima
    ready sem overlap. Re-tenta a deferida no próximo batch.
  - `block`: pausa o dispatch até a outra run liberar (polling com backoff). Pior em latência,
    melhor em fairness.

### Cross-references

- `scripts/forge-parallelism.js` (M002, extended em M004 S07)
- `shared/forge-dispatch.md § Parallel Task Execution`

## Artifact Cleanup

Após um milestone ou task fechar com sucesso, os arquivos de planejamento/execução são arqueologia:
o valor real já foi extraído para AUTO-MEMORY.md, DECISIONS.md e CODING-STANDARDS.md.
Um resumo compacto é sempre gravado em LEDGER.md antes de qualquer cleanup.

```
milestone_cleanup: archive # keep    = mantém tudo
                           # archive = move .gsd/milestones/M###/ → .gsd/archive/M###/ (padrão)
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

## Tier Settings

Controls which concrete model ID each tier alias resolves to at dispatch time. Edit this block
to re-route any tier without touching orchestrator code or agent frontmatters.

```
tier_models:
  light:    claude-haiku-4-5-20251001      # fast, cheap (memory-extract, complete-slice, docs tag)
  standard: claude-sonnet-4-6              # balanced (execute-task default, research, discuss)
  heavy:    "claude-opus-4-7[1m]"          # deepest reasoning (plan-milestone, plan-slice)
```

### How this block works

The orchestrator reads `tier_models` on every dispatch loop iteration. When the tier for a unit
is resolved (see precedence below), the corresponding model ID from this block is injected into
the `Agent()` call. If a key is missing, the system falls back to the canonical defaults defined
in [`shared/forge-tiers.md § Tier → Default Model`](shared/forge-tiers.md).

### Override precedence (highest wins)

1. **`T##-PLAN.md` frontmatter `tier:`** — explicit assignment; always wins. Example: `tier: heavy`
   on an `execute-task` unit promotes it to opus regardless of all other rules.
2. **`T##-PLAN.md` frontmatter `tag: docs`** — downgrades the unit to `light` unless a `tier:`
   is also set. Intended for documentation-only tasks (no code generation needed).
3. **Unit type default** — the `unit_type → tier` table locked in `shared/forge-tiers.md`.
   Used when no frontmatter override is present.

### How to override globally

Edit the `tier_models` block in this file (or in `.gsd/claude-agent-prefs.md` for repo-level
scope, or `.gsd/prefs.local.md` for personal local scope — latter gitignored). Example: changing
`tier_models.light` from `claude-haiku-4-5-20251001` to `claude-sonnet-4-6` means the next
`memory-extract` dispatch will invoke sonnet instead of haiku — **no code change required**.

### How to override per-task

Add a `tier:` or `tag:` field to the frontmatter of the relevant `T##-PLAN.md`:

```yaml
---
id: T12
tier: heavy      # promotes this execute-task to opus
---
```

or

```yaml
---
id: T13
tag: docs        # downgrades to light (haiku) — docs-only task
---
```

### Deprecation note on Phase → Agent Routing table

The **Phase → Agent Routing** table (lines 20–34 of this file) is now **deprecated for
model-selection purposes**. The "Model ID" column of that table is informational only —
the `tier_models:` block above is the single source of truth for which model runs each unit.
The routing table is retained for informational continuity and `skip_discuss`/`skip_research`
skip-rule logic. Do not update model IDs there; update `tier_models:` instead.

### Cross-references

- [`shared/forge-tiers.md`](shared/forge-tiers.md) — canonical `unit_type → tier` and
  `tier → default model` tables. Edit to add new unit types or tiers.
- [`shared/forge-dispatch.md § Tier Resolution`](shared/forge-dispatch.md) — runtime resolution
  algorithm; reads `forge-tiers.md` tables then applies `tier_models:` overrides from prefs.

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

## Evidence Settings

Controla o comportamento do evidence log (PostToolUse) para verificação de claims nos summaries. Bloco **inerte até M003/S02** — nenhum código consome essas chaves ainda; documentadas aqui para que operadores possam pré-configurar antes de S02 entrar no ar.

```
evidence:
  mode: lenient        # lenient | strict | disabled
                       # lenient  = escreve evidence-{unitId}.jsonl; mismatches viram "## Evidence Flags"
                       #            advisory em S##-SUMMARY.md (não bloqueia merge)
                       # strict   = mismatches viram blocker em complete-slice (ativa via M004+)
                       # disabled = hook pula escrita — nenhum evidence log gerado
```

### Semântica (referência — implementação em S02)

- `lenient` (padrão seguro): gera o log, surfacia divergências como seção advisory no SUMMARY do slice. Forge-completer adiciona `## Evidence Flags` quando detecta claims sem contrapartida no log.
- `strict`: mesma coleta; mismatches **bloqueiam** o fechamento do slice. Ativação prevista para M004+ após telemetria de falsos-positivos.
- `disabled`: `scripts/forge-hook.js` PostToolUse branch pula a escrita do arquivo — zero overhead, zero log. Use em sessões de debug curtas ou em ambientes onde o disco está pressionado.

### Cross-references

- `scripts/forge-hook.js` (S02) — consumer; PostToolUse branch lê essa pref antes de gravar `.gsd/forge/evidence-{unitId}.jsonl`.
- `agents/forge-completer.md` (S02) — consumer em `complete-slice`; lê a pref para decidir entre flag advisory e blocker.
- `.gsd/milestones/M003/slices/S02/S02-PLAN.md` — tarefa de consumo efetivo.

## File Audit Settings

Controla o filtro do file-audit (seção `## File Audit` em `S##-SUMMARY.md`) executado pelo `forge-completer` no fechamento de cada slice. O file-audit compara `git diff --name-only --diff-filter=AM` com a união dos `expected_output:` de todos os `T##-PLAN.md` da slice — paths que batem com qualquer padrão em `ignore_list` são excluídos antes do diff (evita ruído de lockfiles e diretórios de build).

```
file_audit:
  ignore_list:
    - "package-lock.json"
    - "yarn.lock"
    - "pnpm-lock.yaml"
    - "dist/**"
    - "build/**"
    - ".next/**"
    - ".gsd/**"
```

### Semântica

- **Padrões suportados:** prefix exato (`package-lock.json`), prefix com wildcard (`dist/**` cobre qualquer path abaixo de `dist/`), e simples `*` como `[^/]*` dentro de um segmento. NÃO usa `minimatch` — parser hand-rolled, zero dependências externas.
- **Aplicação:** tanto o conjunto AM quanto o conjunto `expected_output` são filtrados pelo mesmo matcher antes do diff. Isso garante que um `expected_output: [".gsd/milestones/..."]` também seja desconsiderado se o ignore list cobrir `.gsd/**`.
- **Fallback silencioso:** se o bloco estiver ausente ou a chave `ignore_list` estiver vazia, o consumer usa o default hardcoded idêntico ao mostrado acima. Nenhum erro é levantado.
- **Deleções não auditadas:** `--diff-filter=AM` cobre apenas additions e modifications (decisão M003 D4). Arquivos deletados não aparecem no audit independente do `ignore_list`.

### Cross-references

- `agents/forge-completer.md` sub-step 1.6 — consumer do `file_audit.ignore_list`; escreve a seção `## File Audit` em `S##-SUMMARY.md`.
- `scripts/forge-must-haves.js --check` — fornece a classificação legacy/valid usada pelo completer para decidir se o `expected_output` de um plano entra na união.
- `.gsd/milestones/M003/slices/S02/tasks/T04/T04-PLAN.md` — tarefa que implementa o consumer.

## Checker Memory Settings

Controla a extração de padrões de qualidade do plan-checker e verificador para `.gsd/CHECKER-MEMORY.md`.
Cria um loop de feedback anti-recidivismo: erros recorrentes em planos e verificações são surfaçados como
contexto nas próximas execuções — `forge-planner` recebe padrões de plan-check, `forge-executor` recebe
padrões de verificação.

```
checker_memory:
  mode: enabled     # enabled | disabled
                    # enabled  = forge-completer extrai warn/fail do S##-PLAN-CHECK.md + falhas
                    #            do S##-VERIFICATION.md e file-audit após cada complete-slice
                    # disabled = pula completamente — nenhum CHECKER-MEMORY.md é gerado/atualizado
```

### Semântica

- **Padrões coletados:** dimensões `warn`/`fail` do plan-checker (ex: `acceptance_observable`), falhas do verificador (ex: `substantive_fail`), flags do file-audit (`unexpected`, `missing`).
- **Separação de injeção:** `forge-planner` recebe apenas `## Plan Quality Patterns`; `forge-executor` recebe apenas `## Verification Patterns`. Evita ruído cruzado.
- **Ausência é sinal:** slices sem issues não tocam o arquivo. Histórico limpo = confiança real.
- **Decay automático:** linhas com `Count >= 5 AND Last Seen > 3 milestones atrás` são removidas (padrões resolvidos não contaminam milestones futuros).
- **Durabilidade:** `.gsd/CHECKER-MEMORY.md` vive na raiz de `.gsd/` — nunca é tocado por `milestone_cleanup`, mesmo em modo `delete`.

### Cross-references

- `agents/forge-completer.md` sub-step 1.9 — consumer; escreve/atualiza `CHECKER-MEMORY.md` após cada slice.
- `shared/forge-dispatch.md § plan-slice` — lê `## Plan Quality Patterns` via Read-path.
- `shared/forge-dispatch.md § execute-task` — lê `## Verification Patterns` via Read-path.

## Plan-Check Settings

Controla o gate advisório `forge-plan-checker` que roda entre `plan-slice` e o primeiro `execute-task`. Avalia 10 dimensões estruturais do plano (`completeness`, `must_haves_wellformed`, `ordering`, `dependencies`, `risk_coverage`, `acceptance_observable`, `scope_alignment`, `decisions_honored`, `expected_output_realistic`, `legacy_schema_detect`) e grava `S##-PLAN-CHECK.md`.

```
plan_check:
  mode: advisory     # advisory | blocking | disabled
```

### Semântica

- `advisory` (padrão): o orquestrador invoca o plan-checker, grava `S##-PLAN-CHECK.md`, e prossegue com o primeiro `execute-task` independente do veredicto. Flags servem como documentação para revisão humana no UAT.
- `blocking` (inerte em M003, scaffolded para M004+): o orquestrador enforça um revision-loop — máximo 3 rodadas; a cada rodada o número de `fail` precisa decrescer estritamente (monotônico). Caso contrário, o loop termina e o usuário é notificado com as dimensões ainda falhando. Sem código reordenando o planejamento — o modo apenas pausa a dispatch até o usuário intervir.
- `disabled`: pula o gate completamente. Nenhum `S##-PLAN-CHECK.md` é gerado. Útil para milestones de documentação ou debugging rápido.

### Cross-references

- Consumer: `agents/forge-plan-checker.md` (agente Sonnet advisory; 10 dimensões locked).
- Dispatch guard: `skills/forge-auto/SKILL.md` + `skills/forge-next/SKILL.md` (invocação entre `plan-slice` e primeiro `execute-task`; idempotente — se `S##-PLAN-CHECK.md` já existe, pula).
- Revision loop: `skills/forge-auto/SKILL.md` + `skills/forge-next/SKILL.md` — branch inerte até `plan_check.mode == blocking`.
- Artefato gerado: `.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN-CHECK.md`.
- Documentado em `CLAUDE.md § Anti-Hallucination Layer`.

## Token Budget Settings

O bloco `token_budget` limita o tamanho das seções **opcionais** injetadas nos prompts dos workers, mantendo o consumo de contexto previsível. O orquestrador multiplica cada valor por 4 para obter o limite em caracteres antes de chamar `truncateAtSectionBoundary` (de `scripts/forge-tokens.js`), que usa a heurística `Math.ceil(chars / 4)` para estimar tokens — sem dependências externas, com precisão de ±5–15% para inglês/markdown.

```
token_budget:
  auto_memory:       2000   # cap em tokens do snippet AUTO-MEMORY injetado em cada worker
  ledger_snapshot:   1500   # cap em tokens do snippet do LEDGER.md (quando injetado)
  coding_standards:  3000   # cap compartilhado entre CS_STRUCTURE e CS_RULES
```

### Semântica

- **Valores em tokens, não chars.** O orquestrador multiplica por 4 para chamar `truncateAtSectionBoundary` (cuja API é em chars). Exemplo: `auto_memory: 2000` → `truncateAtSectionBoundary(content, 8000)`.
- **Só aplica a seções OPCIONAIS.** `T##-PLAN`, `S##-CONTEXT`, `M###-SCOPE` são mandatórias — se excederem o budget esperado, o orquestrador levanta blocker `scope_exceeded`, não trunca silenciosamente.
- **Fallback silencioso.** Se o bloco estiver ausente ou uma chave faltar, o helper usa os defaults hardcoded (2000/1500/3000 tokens respectivamente). Nenhum erro é levantado.

### Observação sobre H2 boundary

A truncagem sempre termina numa linha de cabeçalho H2 (`## `), H3 (`### `), ou regra horizontal (`---` / `***`), preservando seções atômicas — nunca corta no meio de um bloco de código ou lista. O marcador `[...truncated N sections]` é inserido ao final do conteúdo truncado para indicar quantas seções foram descartadas.

### Cross-references

- `scripts/forge-tokens.js` — implementação de `countTokens` e `truncateAtSectionBoundary`.
- `shared/forge-dispatch.md ### Token Telemetry` — contrato completo e tabela de placeholders opcionais.
- `skills/forge-status/SKILL.md` — relatório de consumo de tokens por worker.

## Update Settings

```
repo_path:    # preenchido pelo install.sh — caminho do repositório gsd-agent
```

## Notes

- Para mudar o modelo de uma fase, edite o bloco `tier_models:` na seção `## Tier Settings` acima.
  A tabela Phase → Agent Routing é informacional; o bloco `tier_models:` é a fonte de verdade.
- Modelos disponíveis: opus (claude-opus-4-7[1m], fallback claude-opus-4-6), sonnet (claude-sonnet-4-6), haiku (claude-haiku-4-5-20251001)
- Este arquivo é lido pelo orquestrador gsd.md a cada iteração do loop
- Para mudar comandos de verify, edite o bloco "verification:" acima. Veja scripts/forge-verify.js para a implementação.
