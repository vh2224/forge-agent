---
# GSD Claude Agent Preferences
# Equivalente ao ~/.gsd/preferences.md mas para os agentes do Claude Code
# Editado via /forge-prefs ou manualmente
version: 1
---

## Modelos disponíveis

| Alias | Model ID | Uso recomendado |
|-------|----------|-----------------|
| `opus` | `claude-opus-4-8[1m]` | Análise profunda, decisões arquiteturais, planejamento |
| `sonnet` | `claude-sonnet-5` | Implementação, execução, tarefas padrão |
| `haiku` | `claude-haiku-4-5-20251001` | Tarefas leves, extração de memórias, operações rápidas |

Você pode usar o alias (`opus`) ou o model ID completo (`claude-opus-4-8[1m]`) em qualquer configuração.

**Fallback automático:** Se `claude-opus-4-8[1m]` não estiver disponível na sua conta (tier/região), o instalador detecta na instalação e faz downgrade para `claude-opus-4-7` nos frontmatters dos agentes. Sem intervenção manual necessária.

## Phase → Agent Routing

| Phase | Agent | Model ID | Alias |
|-------|-------|----------|-------|
| discuss-milestone | forge-discusser | claude-opus-4-8[1m] | opus |
| discuss-slice | forge-discusser | claude-opus-4-8[1m] | opus |
| research-milestone | forge-researcher | claude-opus-4-8[1m] | opus |
| research-slice | forge-researcher | claude-opus-4-8[1m] | opus |
| plan-milestone | forge-planner | claude-opus-4-8[1m] | opus |
| plan-slice | forge-planner | claude-opus-4-8[1m] | opus |
| execute-task | forge-executor | claude-sonnet-5 | sonnet |
| complete-slice | forge-completer | claude-sonnet-5 | sonnet |
| complete-milestone | forge-completer | claude-sonnet-5 | sonnet |
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

Controla a intensidade de raciocínio (tokens gastos por unidade). Eixo **ortogonal ao tier**: o tier escolhe *qual modelo* roda; o effort escolhe *o quão fundo* ele pensa. Escala ordenada (barato → caro): `low < medium < high < xhigh < max`.

Este bloco define o **default por fase** (`unit_type`). É a camada base — sobreposta por `effort:` no frontmatter de cada `T##-PLAN.md` (ver abaixo).

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

### Effort dinâmico por complexidade da task

O `forge-planner` julga a complexidade de cada task e emite `effort:` (e `tier:`) no frontmatter do `T##-PLAN.md`. O orquestrador resolve o effort em **4 passos** (algoritmo canônico em `shared/forge-dispatch.md § Effort Resolution`):

1. **Default por fase** — `effort:` deste bloco para o `unit_type`.
2. **Override de frontmatter** (`execute-task`) — `effort:` no `T##-PLAN.md` vence o default. É o sinal de complexidade da task.
3. **Risk escalation** — `plan-slice` em slice `risk:high` (tier escalado a `max`) também sobe o effort a `max`.
4. **Clamp por modelo** — effort é rebaixado ao teto do modelo resolvido: `haiku`/`sonnet` (tiers `light`/`standard`) **limitam em `medium`**; `opus`/`fable` (tiers `heavy`/`max`) permitem a escala toda.

> **Consequência do clamp:** para uma task *rodar* em `high`/`xhigh`/`max`, ela precisa estar num tier `heavy`/`max` (opus/fable). Setar `effort: xhigh` numa task `standard` (sonnet) não tem efeito — o planner deve subir `tier` junto. O evento `dispatch` em `events.jsonl` registra `effort` + `effort_reason` (incluindo `|clamped:model-cap` quando o clamp dispara) para auditoria.

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

## ID Settings

Controla o formato dos IDs **gerados** para milestones e tasks soltas. A leitura
aceita sempre os dois formatos, independente desta pref.

```
ids:
  format: timestamp        # timestamp | sequential
```

### Semântica

- `timestamp` (default) — `M-<YYYYMMDDHHMMSS>-<slug>` / `T-<YYYYMMDDHHMMSS>-<slug>`.
  Chave primária é o timestamp UTC de 14 dígitos: única, ordenável por criação,
  **sem colisão entre devs/branches paralelos**. Slug cosmético (≤24 chars).
- `sequential` — formato legado `M001`, `M002`, … / `TASK-001`, `TASK-002`, …
  O próximo número é `max + 1` varrendo `.gsd/milestones/` + `.gsd/archive/`
  (milestones) e `.gsd/tasks/` (tasks). IDs timestamp existentes são ignorados
  na numeração (namespaces distintos — sem colisão entre os dois formatos).

> ⚠ `sequential` reintroduz o risco de colisão que motivou o formato timestamp:
> dois devs criando milestone em branches paralelos geram o mesmo `M00N`.
> Use apenas em repositórios de dev único ou com coordenação central de IDs.

### Resolução

Flag `--format` no CLI > pref `ids.format` (cascata user → repo → local, último
ganha) > default `timestamp`. Valor inválido cai silenciosamente em `timestamp`.

### Cross-references

- Lógica central: `scripts/forge-ids.js` (`readIdFormat`, `resolveMilestoneId`,
  `resolveTaskId`, `nextSequential*Id`)
- Consumidores: `skills/forge-new-milestone/SKILL.md`, `skills/forge-task/SKILL.md`,
  `scripts/forge-cli-helpers.js` (`newTaskId`)

## Notification Settings

Controla se o `forge-auto` dispara notificações push (via tool `PushNotification`) nos
pontos de espera humana do loop: blocker não-recuperável, triagem final de review antes
de `complete-milestone`, e Final Report.

```
notifications: on        # on | off
```

### Semântica

- `on` (default) — dispara `PushNotification` do harness nos 3 pontos de espera:
  blocker não-recuperável, triagem final de review (antes de fechar a milestone),
  e Final Report (milestone completa). Em qualquer modo, ausência da tool
  `PushNotification` no harness = **silent-skip** (zero erro no loop).
- `off` — desativa todos os pushes; o loop se comporta de forma idêntica, sem notificação.
- Valor inválido (qualquer coisa diferente de `on`/`off`) cai silenciosamente em `on`.
- A tool `PushNotification` é *deferred* — carregada via `ToolSearch("select:PushNotification")`
  **uma única vez** por janela de contexto, resultado cacheado em `PUSH_AVAILABLE`. Não re-probar
  em cada iteração. Se o contexto for compactado, `PUSH_AVAILABLE` é redefinido para `null` no
  recovery pós-compactação e o probe é reexecutado (1x por janela de contexto, não 1x por processo).

### Cross-references

- Consumidor principal: `skills/forge-auto/SKILL.md` (leitura na ativação em `## Load context`
  + probe único cacheado `PUSH_AVAILABLE` + 3 invokes condicionais nos call-sites de espera)
- Tool: `PushNotification` (deferred — detectada via `ToolSearch`, não via introspecção direta)

### Resolução

Cascata user → repo → local, último ganha. Valor inválido cai em `on`.

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
                                     # mesmo com true, NUNCA remove worktree suja (mudanças não
                                     # commitadas) — cleanup vira skipped (dirty); commit na branch
                                     # forge/{id} primeiro (obrigatório com auto_commit: false)

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

### Quando é aplicado

O setup roda automaticamente na ativação de `/forge-auto`, `/forge-next` e `/forge-task`
(via `scripts/forge-isolation.js --setup`, idempotente). O cleanup roda apenas quando a
milestone/task **completa** (`--cleanup`): `branch` volta para a branch default (a branch
`forge/{id}` é preservada para PR); `worktree` só remove a worktree se
`worktree_cleanup_on_complete: true` **e o working tree estiver limpo** — mudanças não
commitadas nunca são descartadas (status `skipped (dirty)`; com `auto_commit: false`,
commite na branch `forge/{id}` antes do cleanup). Pause/blocked nunca disparam cleanup —
o isolamento sobrevive para o resume.

### Override por run

`forge_isolation.mode` pode ser sobrescrito por run individual via CLI flag (futuro: `/forge-auto M065 --isolation=worktree`). Por enquanto, edite prefs antes de iniciar — a mudança é lida na próxima ativação.

### Cross-references

- `shared/forge-state.md` §2 — campo `isolation_mode` no `runs/{id}.json`
- `shared/forge-dispatch.md § Isolation Header Convention` — header injetado nos worker prompts
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
  standard: claude-sonnet-5              # balanced (execute-task default, research, discuss)
  heavy:    "claude-opus-4-8[1m]"          # deep reasoning (plan-slice default)
  max:      claude-fable-5                 # frontier (plan-milestone, risk:high plan-slice, blocker escalation) — 2x opus cost
```

### How this block works

The orchestrator reads `tier_models` on every dispatch loop iteration. When the tier for a unit
is resolved (see precedence below), the corresponding model ID from this block is injected into
the `Agent()` call. If a key is missing, the system falls back to the canonical defaults defined
in [`shared/forge-tiers.md § Tier → Default Model`](shared/forge-tiers.md).

> **Restrição do mapa ID→alias (M004):** o param `model` da tool `Agent` aceita apenas os aliases
> `sonnet|opus|haiku|fable`. O ID configurado aqui é traduzido por `scripts/forge-model-alias.js`
> (fonte única do mapa: `*haiku*→haiku`, `*sonnet*→sonnet`, `*opus*→opus`, `*fable*→fable`).
> Um ID que não casa com o mapa (ex.: um modelo de outra família) NÃO roteia — o dispatch omite
> `model:` (o frontmatter do agente governa) e registra warning + `model_applied: null` no evento.
> Exemplos que funcionam: `claude-opus-4-8`, `"claude-opus-4-8[1m]"`, `claude-fable-5`,
> `claude-sonnet-5`, `claude-haiku-4-5-20251001`.

### Override precedence (highest wins)

1. **`T##-PLAN.md` frontmatter `tier:`** — explicit assignment; always wins. Example: `tier: heavy`
   on an `execute-task` unit promotes it to opus regardless of all other rules.
2. **`T##-PLAN.md` frontmatter `tag: docs`** — downgrades the unit to `light` unless a `tier:`
   is also set. Intended for documentation-only tasks (no code generation needed).
3. **Risk escalation (`plan-slice` only)** — slice tagged `risk:high` no ROADMAP escala
   `heavy → max` (Fable 5). Mesma checagem que dispara o `forge-risk-radar`.
4. **Unit type default** — the `unit_type → tier` table locked in `shared/forge-tiers.md`.
   Used when no frontmatter override is present.

> **Fable 5 + thinking:** `claude-fable-5` rejeita `thinking: disabled` explícito (HTTP 400).
> Quando o tier `max` resolve para Fable 5, o orquestrador injeta `thinking: adaptive` no header
> do worker independentemente do que a seção `thinking:` deste arquivo diga para a fase.

### How to override globally

Edit the `tier_models` block in this file (or in `.gsd/claude-agent-prefs.md` for repo-level
scope, or `.gsd/prefs.local.md` for personal local scope — latter gitignored). Example: changing
`tier_models.light` from `claude-haiku-4-5-20251001` to `claude-sonnet-5` means the next
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

## Review Settings

Controla o **review gate dialético** que roda no orquestrador antes de `complete-slice` (no diff do slice ainda não-mergeado). Dois agentes se confrontam sobre o código — `forge-reviewer` (challenger, acha bugs/brechas) × `forge-advocate` (defender, o autor) — e o humano só arbitra as objeções em que os dois discordam. O que os dois **concordam** que está quebrado (`concedida`) é corrigido na hora (dispatch `review-fix`); o que fica `aberta` em modo auto sobe ao operador na **triagem final da milestone** (antes do `complete-milestone`). O gate **nunca bloqueia** o `complete-slice`.

```
review:
  mode: enabled       # enabled | disabled
  engine: agents      # agents | workflow — quem roda o debate (Steps 2–5)
  style: dialectic    # dialectic | flags
  rounds: 1           # 0–3 rodadas de réplica do reviewer sobre a defesa
  ask_in_auto: defer  # defer | pause
  fix_conceded: true  # true | false — corrige automaticamente as objeções concedidas
  challenger: claude       # claude | codex — quem desafia (codex via scripts/forge-xllm.js)
  challenger_model:        # (unset) — passa -m <valor> ao codex; vazio = default do CLI
                           #   ex.: challenger_model: gpt-5.2-codex
  advocate_model: claude-fable-5   # modelo do defender (alias via forge-model-alias.js)
                                   #   ex.: advocate_model: claude-opus-4-8  (defesa mais barata)
```

### Exemplo — review cross-model (GPT ataca × Fable 5 defende)

O ganho do multi-LLM: challenger e advocate da MESMA família compartilham pontos cegos; um GPT
desafiando código escrito por Claude acha classes de bug que dois Claudes não acham. Para ativar,
cole em `.gsd/prefs.local.md` (pessoal, gitignored) ou `.gsd/claude-agent-prefs.md` (repo):

```yaml
review:
  challenger: codex            # GPT via Codex CLI assume challenge + réplica
  # challenger_model:          # deixe unset → default do Codex CLI (a OpenAI mantém atual);
  #                            # pin explícito só se precisar: challenger_model: gpt-5.2-codex
  # advocate_model: claude-fable-5   # já é o default — melhor Claude defendendo
```

**Pré-requisitos (uma vez por máquina):** `npm install -g @openai/codex` + `codex login`
(assinatura ChatGPT — recomendado) OU `OPENAI_API_KEY` no ambiente. O forge NÃO instala nem
armazena credenciais — a auth é 100% do Codex CLI. Sem codex disponível (binário, auth, quota,
rede), o gate cai automaticamente no `forge-reviewer` Claude com evento
`review-challenger-fallback` — nunca trava, nunca bloqueia.

### Semântica

- `mode: enabled` (padrão): o gate roda. `disabled`: pula inteiramente — nenhum `S##-REVIEW.md` é gerado.
- `engine: agents` (padrão): o orquestrador despacha `forge-reviewer`/`forge-advocate` via `Agent()` — comportamento atual, byte-a-byte; nenhum pré-requisito de versão ou permissão adicional.
- `engine: workflow`: os Steps 2–5 (challenge → defense → rebuttal × rounds) rodam numa ÚNICA invocação da tool `Workflow` do harness (Claude Code ≥ v2.1.154) com `agentType: forge-reviewer/forge-advocate` — o diálogo inteiro sai do contexto do orquestrador, que recebe só o JSON de resolução e renderiza o `S##-REVIEW.md`. Detecção no Step 0 do gate por introspecção do tool list do orquestrador; **tool ausente → fallback automático para `agents`** com warning de uma linha + evento `review-engine-fallback` em `events.jsonl` — nunca falha, nunca bloqueia o gate.
  - **Pré-requisito de approval:** em `permissions.defaultMode` padrão, **cada run de Workflow pede aprovação do operador** — num `forge-auto` isso pausa o loop de forma invisível. Modo recomendado para `engine: workflow`: `permissions.defaultMode: bypassPermissions` (usuários com a statusline ativa já têm — `merge-settings.js` configura isso automaticamente). Sem bypass, o gate never-blocks cobre: run não retorna → fallback agents com evento `review-engine-fallback`.
  - **Interação com `style`:** `style: flags` ignora `engine` — o single-pass legado roda sempre via agents (um debate de 3 fases não tem forma "flags").
  - **Fallback em dois pontos:** (a) tool ausente no Step 0, `reason: "tool-absent"`; (b) invocação lança throw ou retorna `{outcome:'error'}` (challenge null), `reason: "workflow-error:<stage>"` — em ambos, o gate rerun via caminho agents (Steps 2–5).
- `style: dialectic` (padrão): loop completo challenge → defense → rebuttal → resolução. Objeções `aberta`s sobem ao humano (via `AskUserQuestion` em modo interativo). `style: flags`: single-pass legado — só o reviewer, grava `## ⚠ Review Flags` em `S##-REVIEW.md`, sem defesa nem perguntas. Opt-out do debate.
- `rounds` (padrão `1`): quantas vezes o reviewer replica à defesa do advocate. `0` = sem réplica (toda objeção contestada vira `aberta`). Cap em `3`.
- `ask_in_auto` (padrão `defer`): em `forge-auto`, `defer` **não pausa no meio do loop** — marca as `aberta`s como `deferido → triagem no fim da milestone` e segue (honra a AUTONOMY RULE). **Defer não engole:** todo item deferido é apresentado ao operador na triagem final, antes do `complete-milestone` rodar de fato. `pause` faz o `forge-auto` perguntar ao humano por slice, mesmo no modo autônomo (opt-in).
- `fix_conceded` (padrão `true`): objeções **concedidas** (challenger e advocate concordam que o problema é real) disparam um `review-fix` — `forge-executor` corrige só os itens listados, commit `fix(review): ...`, ainda no branch do slice. Sem re-review do commit de fix (evita ping-pong). `false`: volta ao comportamento legado — concedidas são registradas e (em modo interativo) perguntadas uma vez.
- `challenger` (padrão `claude`): quem roda o papel de challenger (Steps 2/4). `claude` mantém o comportamento atual — os agentes `forge-reviewer`/`forge-advocate` em contexto. `codex` roteia challenge e rebuttal pelo adapter `scripts/forge-xllm.js` (GPT via `codex exec`); valor inválido cai no fallback da whitelist (`claude`). Precede `engine: workflow`: `challenger: codex` força `engine: agents` (o script workflow não roteia codex) — ver `shared/forge-review.md § Step 0 § Precedência`.
- `challenger_model` (padrão unset): nome do modelo — não é credencial — repassado como `--model <valor>` ao adapter quando `challenger: codex`; vazio/unset usa o default do Codex CLI. Ignorado quando `challenger: claude`.
- `advocate_model` (padrão `claude-fable-5`, literal — nunca null): modelo do defender (`forge-advocate`). Resolvido para um alias de dispatch via `scripts/forge-model-alias.js` (única fonte do mapa ID→alias — não duplicar) e passado como `model:` no `Agent()` do Step 3 só quando o alias não é vazio; um id sem alias conhecido omite `model:` (o frontmatter de `agents/forge-advocate.md` governa) e emite um warning de uma linha. **Guard Fable 400:** o frontmatter de `agents/forge-advocate.md` usa `thinking: adaptive` (nunca `disabled`) — Fable 5 retorna HTTP 400 em `thinking` explicitamente desabilitado. **Nota de reinstall:** mudar `advocate_model` (ou o frontmatter de `agents/forge-advocate.md`) só tem efeito em runtime após `/forge-update`/reinstall — as cópias em `~/.claude/` divergem do repo até a sincronização (installed-copies drift).

### Resolução das objeções

| advocate | réplica do reviewer | resolução |
|----------|---------------------|-----------|
| conceded | (qualquer) | **CONCEDIDA** — ambos veem um problema real → **corrigida na hora** (`review-fix`, se `fix_conceded: true`) |
| refuted  | withdrawn | **RESOLVIDA** — o advocate convenceu o reviewer → sem ação |
| refuted  | maintained | **ABERTA** — discordância genuína → humano decide (ao vivo no interativo; triagem final no auto) |
| open     | withdrawn | **RESOLVIDA** — reviewer retirou → sem ação |
| open     | maintained | **ABERTA** — tradeoff real → humano decide (ao vivo no interativo; triagem final no auto) |

### Cross-references

- Spec autoritativa: `shared/forge-review.md` (procedimento completo do gate).
- Engine workflow: `shared/forge-review.md § Engine workflow` (script inline, schemas full-text, tratamento de null/throw por etapa).
- Challenger: `agents/forge-reviewer.md` (challenge mode + rebuttal mode).
- Defender: `agents/forge-advocate.md`.
- Dispatch guard: `skills/forge-auto/SKILL.md` + `skills/forge-next/SKILL.md` (antes de `complete-slice`; idempotente — se `S##-REVIEW.md` já existe, pula). Triagem final: mesmos skills, antes de `complete-milestone` (`shared/forge-review.md § Step 9`).
- Artefato gerado: `.gsd/milestones/{M###}/slices/{S##}/{S##}-REVIEW.md` (per-slice) ou `.gsd/tasks/{TASK_ID}/{TASK_ID}-REVIEW.md` (task solta) — durável com a unidade; limpo por `milestone_cleanup`. Follow-ups da triagem final vão para `.gsd/KNOWLEDGE.md § Review follow-ups` (sobrevive cleanup).
- Dois boundaries: per-slice (gate antes de `complete-slice` em `forge-auto`/`forge-next`) e task solta (`/forge-task` step 5.5, sempre interativo). Ambos honram `mode`/`style`/`rounds`/`fix_conceded`/`engine`/`challenger`/`challenger_model`/`advocate_model`; `ask_in_auto` só se aplica ao `forge-auto`.
- Challenger Codex: `shared/forge-review.md § Step 0` (cascata + precedência vs `engine: workflow`) e `scripts/forge-xllm.js` (adapter — nunca recebe credencial por argv; auth é do próprio Codex CLI).

## Plan Gate Settings

Controla o **conduct interativo de lapidação do plano** que roda no orquestrador entre `plan-slice` e o primeiro `execute-task` (nos modos interativos `forge-task`/`forge-next`). Separado do **scoring** (`plan_check.mode`, que avalia 10 dimensões estruturais): enquanto o plan-checker *pontua*, o plan gate *conduz o handshake* — preview do plano + findings acionáveis + edição opcional + aprovação. Espelha `## Review Settings` na estrutura: bloco fenced → Semântica → Cross-references.

```
plan_gate:
  interactive: always   # always | auto | off   (default: always)
  ask_in_auto: defer    # defer | off            (forge-auto nunca pausa)
```

### Semântica

- `interactive: always` (padrão): o orquestrador conduz o handshake **sempre que existe um plano**, inclusive quando todos os findings do plan-checker são `pass`. O usuário recebe preview + aprovação em todo planejamento interativo. Tradeoff: maximiza controle, adiciona um toque extra de aprovação em planos limpos. Para reduzir o atrito mantendo a cobertura, basta trocar para `auto`.
- `interactive: auto`: o handshake só é conduzido quando há pelo menos um finding `warn` ou `fail` do plan-checker. Em all-pass, o plano é auto-aprovado sem pausa. Reduz atrito a um toque de pref.
- `interactive: off`: comportamento batch atual — plan-checker roda como advisory, resultado gravado em `S##-PLAN-CHECK.md`, e o orquestrador segue para `execute-task` sem handshake. Equivale ao comportamento pré-M002 mesmo em modo interativo.
- `ask_in_auto: defer` (padrão): em `forge-auto`, o handshake interativo **nunca** é conduzido, independente do valor de `interactive`. A degradação é incondicional e honra a AUTONOMY RULE. O valor `off` é semânticamente idêntico para o `forge-auto` (que nunca conduz o gate de qualquer forma); está disponível como sinalizador explícito de intenção.

**Cascade-read (3-file precedence, last-wins):**
O bloco `plan_gate:` é lido em cascata de três arquivos, na ordem abaixo — cada arquivo subsequente sobrescreve chaves do anterior (merge por chave, não substituição do bloco inteiro):
1. `~/.claude/forge-agent-prefs.md` — user-global (este template)
2. `.gsd/claude-agent-prefs.md` — repo shared (commitável; sobrescreve user-global)
3. `.gsd/prefs.local.md` — local personal (gitignored; sobrescreve ambos)

**Snippet de regex de captura (documental — vive nos SKILLs, não aqui):**

```js
// Captura o bloco plan_gate: e todos os seus pares chave: valor indentados
// NUNCA usar \Z (não existe em JS — bug histórico do forge_isolation).
// Usar flag m para ^ âncora por linha.
const m = text.match(/^plan_gate:[ \t]*\n((?:[ \t]+.*\n?)*)/m);
// Sub-keys: /^[ \t]+([\w_]+):[ \t]*(.+)/m por cada linha capturada
```

Os consumidores (`skills/forge-task/SKILL.md`, `skills/forge-next/SKILL.md`) copiam esse snippet idêntico — a pref só documenta o padrão de referência.

### Cross-references

- Spec autoritativa: `shared/forge-plan-gate.md` (contrato completo do gate: preview → findings → editar → re-validar → aprovar/ExitPlanMode).
- Consumidores: `skills/forge-task/SKILL.md` (sempre interativo) + `skills/forge-next/SKILL.md` (interativo em step-mode).
- Scoring peer: `forge-agent-prefs.md § Plan-Check Settings` (avalia 10 dimensões; advisory).
- Review peer: `forge-agent-prefs.md § Review Settings` (gate dialético antes de `complete-slice`; espelha a estrutura desta seção).
- Decisões de arquitetura: `CLAUDE.md § Plan mode interativo` (D1–D7).
- Artefato do scoring (input para o handshake): `.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN-CHECK.md`.

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

## Verifier Settings

Controla o comportamento dos detectores de qualidade no `scripts/forge-verifier.js`.
Postura M003: ambos os sub-detectores nascem **advisory** — emitem flags em `S##-VERIFICATION.md`
mas nunca bloqueiam o fechamento de slice. `blocking` é opt-in, previsto para M004+ após
medir falsos positivos em milestones reais.

```
verifier:
  test_quality: advisory   # advisory | blocking | disabled
                           # advisory  = detecta disabled-test/weak-assertion/no-assertion/
                           #             circular-assertion e registra flags no VERIFICATION.md
                           #             (nunca bloqueia — default seguro M003)
                           # blocking  = mismatches bloqueiam complete-slice (ativa via M004+
                           #             após telemetria de falsos positivos)
                           # disabled  = pula completamente o nível 4 — nenhuma flag gerada
```

### Semântica

- `advisory` (padrão): `verifyArtifact` detecta problemas em arquivos de teste declarados
  (`*.test.*`, `*.spec.*`, `__tests__/`) e os surfaça como seção `## Flags → Test-quality`
  em `S##-VERIFICATION.md`. Nunca altera o veredito 3-level (Exists/Substantive/Wired) —
  aditivo, sem veto.
- `blocking`: reservado para M004+. Quando ativo, a presença de flags `test-quality` em
  artefatos declarados bloqueia o `complete-slice`. Não implementado como veto neste slice —
  apenas o scaffold da pref está presente.
- `disabled`: o gate `isTestFile()` dentro de `verifyArtifact` é pulado — nenhum nível 4
  roda, `test_quality` field não é adicionado aos rows.

### Cross-references

- `scripts/forge-verifier.js` — implementação de `auditTestQuality`, `isTestFile`,
  `TEST_QUALITY_REGEXES` (Level 4); gating `isTestFile(artifactPath)` dentro de `verifyArtifact`.
- Artefato: `S##-VERIFICATION.md` → seção `## Flags` → sub-seção **Test-quality**.
- Decisão locked #4 (S02): test-quality SÓ em artefatos declarados em `must_haves.artifacts`/
  `expected_output`; nunca varredura global do repo.

## Symbol Check Settings

Controla o comportamento do drift guard `scripts/forge-symbol-check.js` que verifica se
os símbolos citados nos planos (`S##-PLAN.md`/`T##-PLAN.md`) existem no código real.
Postura M003: nasce **advisory** — emite `S##-SYMBOL-CHECK.md` mas nunca bloqueia o dispatch.

```
symbol_check:
  mode: advisory           # advisory | disabled
                           # advisory  = resolve cada símbolo via ripgrep/grep, emite
                           #             VERIFIED|MISSING|AMBIGUOUS|UNCHECKABLE no artefato
                           #             S##-SYMBOL-CHECK.md (nunca bloqueia — default seguro)
                           # disabled  = pula o gate completamente — nenhum artefato gerado
```

### Semântica

- `advisory` (padrão): `forge-symbol-check.js --check <plan>` resolve cada símbolo citado
  no plano e registra o estado em `S##-SYMBOL-CHECK.md`. Greenfield exclusion: símbolos
  declarados em `must_haves.artifacts[].path` ou `expected_output` não são flagged como
  `MISSING` (ainda não existem — é esperado). `UNCHECKABLE` é sempre logado explicitamente
  (silêncio nunca mascara gap).
- `disabled`: o gate no orquestrador é pulado entre `plan-slice` e o primeiro `execute-task`.
  Nenhum `S##-SYMBOL-CHECK.md` é gerado.

### Cross-references

- `scripts/forge-symbol-check.js` — implementação do resolver (rung-0: ripgrep/Read);
  CLI `--check <plan>` para invocação standalone.
- Dispatch guard: `skills/forge-auto/SKILL.md` + `skills/forge-next/SKILL.md` (bloco
  "Symbol-check gate" entre plan-check e primeiro execute-task; idempotente — se
  `S##-SYMBOL-CHECK.md` já existe, pula).
- `agents/forge-plan-checker.md` — plan-checker lê `S##-SYMBOL-CHECK.md` como insumo
  se existir (sem nova dimensão — decisão locked #2).
- Artefato gerado: `.gsd/milestones/{M###}/slices/{S##}/{S##}-SYMBOL-CHECK.md`.

## Context Monitor Settings

Controla o context-monitor proativo que avisa o agente worker ANTES de bater no muro
de contexto. A statusline grava o % de contexto restante num bridge file por sessão;
o hook PostToolUse lê e injeta `additionalContext` (WARNING/CRITICAL) conforme severidade.
Complementa — não substitui — o PostCompact recovery reativo. Silent-fail total (MEM008):
nunca aborta uma tool call.

Default `enabled: true` (e não `false`/advisory como os demais gates novos): este componente
é **puramente informativo** — só injeta texto no contexto do agente, nunca bloqueia tool call
nem gate. Risco de falso positivo ≈ zero (no pior caso o agente recebe um aviso desnecessário
e o ignora). Logo é seguro entregar valor desde o dia 1; opt-out trivial via `enabled: false`.

```
context_monitor:
  enabled: true            # true | false — liga/desliga a injeção proativa
  warning_threshold: 0.35  # fração de contexto RESTANTE; ≤ este valor → WARNING
                           #   ("encerre a task atual, não inicie trabalho complexo novo")
  critical_threshold: 0.25 # fração de contexto RESTANTE; ≤ este valor → CRITICAL
                           #   ("pare, salve o estado em continue.md e retorne partial")
```

### Semântica

> **Custo de leitura (decisão registrada — review S03 R1):** o hook lê a cascata de prefs
> (3 arquivos pequenos, regex-only) a cada PostToolUse. Custo aceito: arquivos ficam em page
> cache; mover a leitura para depois do guard do bridge mudaria a semântica de `enabled`
> mid-session. Revisitar apenas se telemetria mostrar custo real.

- `enabled: true` (padrão): a cada PostToolUse, o hook lê o bridge `forge-ctx-${sessionId}.json`
  e — se a leitura não está stale (>60s) — calcula a severidade pelo % restante. Debounce de
  5 tool-uses entre avisos; **escalada de severidade (WARNING→CRITICAL) fura o debounce**.
- `enabled: false`: o branch context-monitor é no-op — nenhuma injeção, nenhum estado escrito.
- `warning_threshold` / `critical_threshold`: frações de contexto RESTANTE (0–1). Aceitam
  também valor percentual (`35`) — normalizado para fração quando > 1. `critical` é testado
  antes de `warning` (mais grave ganha).

### Cross-references

- `scripts/forge-context-monitor.js` — `readContextMonitorPrefs(cwd)` lê estas chaves;
  `severityFor`/`shouldInject`/`buildAdditionalContext` aplicam a lógica.
- `scripts/forge-statusline.js` — escreve o bridge `forge-ctx-${sessionId}.json`
  (`{context_pct_remaining, ts}`) a cada render.
- `scripts/forge-hook.js` — branch PostToolUse lê o bridge e injeta `additionalContext`.
- Complementa o PostCompact recovery em `scripts/forge-hook.js` (reativo no orquestrador) —
  este é proativo no worker.

## Repair Settings

```
repair:
  budget: 2            # max Node Repair attempts per task before falling back to blocked→human
```

### Semântica

- `repair.budget` — orçamento de reparos (RETRY/DECOMPOSE/PRUNE) por task na camada 3 (Node Repair).
  Contador `repair_count` persistido no frontmatter do `T##-PLAN.md`, incrementado ANTES de cada
  reparo (sobrevive compaction). Esgotado → fallback `blocked → humano` (comportamento atual).
- `context_overflow` NUNCA consome budget de repair — pertence à Failure Taxonomy (camada 2).
  Se o context-monitor bridge reportar severidade CRITICAL, Node Repair suprime DECOMPOSE/PRUNE
  e força RETRY ou `blocked` (nunca inicia trabalho novo complexo sob contexto baixo).

### Cross-references

- `shared/forge-dispatch.md § Node Repair` — contrato completo das 3 estratégias + precedência.
- `scripts/forge-repair.js` — classificador determinístico falha→estratégia.
- `skills/forge-auto/SKILL.md` / `skills/forge-next/SKILL.md § Process result` — roteamento.

## Scope Reduction Settings

```
scope_reduction:
  reinject: auto       # auto | off — re-inject dropped must_haves into next slice unit
```

### Semântica

- `auto` (default) — must_haves planejados mas não entregues viram seção
  `## Requisitos pendentes re-injetados` no prompt da próxima unidade do slice + S##-SUMMARY.
- `off` — opt-out da re-injeção automática. PRUNE AINDA registra em S##-CONTEXT § Decisions
  independente deste pref ("nunca some em silêncio").
- Cap de 10 itens re-injetados por unidade; overflow indicado no final da seção.

### Cross-references

- `scripts/forge-repair.js --reinject-diff` — diff planejado−entregue (fonte estruturada).
- `skills/forge-auto/SKILL.md § Post-unit housekeeping` — emite a seção re-injetada.
- `skills/forge-next/SKILL.md § Post-unit housekeeping` — idem (modo interativo).

## Accounts Settings

```
accounts:
  handoff_in_auto: on      # on | off — ao esgotar uma janela no /forge-auto, fazer checkpoint+pausa e indicar a troca de conta
  handoff_threshold: 90    # % de uso (janela mais apertada: 5h ou semanal) que dispara o handoff
```

### Semântica

- O `/forge-auto` checa o uso (via o bridge `forge-ratelimit-<session>.json` que a
  statusline grava) **na fronteira de cada unidade** (Step 7). Se a janela mais
  apertada (5h **ou** semanal) cruzar `handoff_threshold`, o loop faz **checkpoint**
  (`continue.md`), pausa preservando o estado e imprime o comando exato pra relançar
  o `claude` em outra conta registrada. `/forge-auto` retoma do checkpoint ao relançar.
- `handoff_in_auto: off` → desliga a pausa automática; a statusline ainda mostra o
  alerta visual de uso, mas o loop não pausa por esgotamento (você troca manualmente
  via `/forge-accounts use <nome>`).
- O handoff **nunca** é hot-swap (impossível mid-session) — é sempre relaunch.
  Requer ≥1 conta alternativa registrada via `/forge-accounts add` para ter destino;
  sem alternativa, o loop ainda faz checkpoint+pausa e instrui a registrar uma.
- Só fica ativo no modo autônomo (`/forge-auto`). No `/forge-next` (interativo) você
  vê o uso na statusline e decide.

### Cross-references

- `scripts/forge-accounts.js` — registro de contas + comando de relançamento.
- `skills/forge-auto/SKILL.md § Account Handoff Procedure` — implementação do handoff.
- `scripts/forge-statusline.js` — grava o bridge de rate-limit consumido aqui.

## Update Settings

```
repo_path:    # preenchido pelo install.sh — caminho do repositório gsd-agent
```

## Notes

- Para detalhes de `engine: workflow` (script inline, schemas, tratamento de null/throw por etapa), consultar `shared/forge-review.md § Engine workflow`.
- `review.engine` é ignorado quando `review.mode: disabled`.
- Para mudar o modelo de uma fase, edite o bloco `tier_models:` na seção `## Tier Settings` acima.
  A tabela Phase → Agent Routing é informacional; o bloco `tier_models:` é a fonte de verdade.
- Modelos disponíveis: fable (claude-fable-5 — tier max, 2x custo do opus), opus (claude-opus-4-8[1m], fallback claude-opus-4-7), sonnet (claude-sonnet-5), haiku (claude-haiku-4-5-20251001)
- Este arquivo é lido pelo orquestrador gsd.md a cada iteração do loop
- Para mudar comandos de verify, edite o bloco "verification:" acima. Veja scripts/forge-verify.js para a implementação.
