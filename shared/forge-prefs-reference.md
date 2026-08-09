# Forge Agent — Referência de Preferências

> Documento gerado a partir de [`forge-prefs.schema.json`](../forge-prefs.schema.json)
> via `scripts/forge-prefs-reference.js`. Não editar manualmente — rode
> `node scripts/forge-prefs-reference.js --out shared/forge-prefs-reference.md`
> após qualquer mudança no schema. Todo texto de descrição vem verbatim do campo
> `description` de cada knob no schema — fonte única, zero drift.

## $schema

### `$schema`

- **Tipo:** string
- **Default:** `"forge-prefs.schema.json"`
- **Descrição:** Referência ao schema deste catálogo (hook para tooling de editor). O scaffold emite esta chave como única linha ativa por default.

## skip_discuss

### `skip_discuss`

- **Tipo:** boolean
- **Default:** `false`
- **Descrição:** true = pula a fase discuss (milestone e slice) e vai direto para research/plan. Use quando as decisões de arquitetura já estão registradas.

## skip_research

### `skip_research`

- **Tipo:** boolean
- **Default:** `false`
- **Descrição:** true = pula a fase research de milestone e vai direto para plan. Use em codebases já bem documentados em CODING-STANDARDS.md.

## skip_slice_research

### `skip_slice_research`

- **Tipo:** boolean
- **Default:** `false`
- **Descrição:** true = pula a fase research de slice (research de milestone continua governado por skip_research).

## reassess_after_slice

### `reassess_after_slice`

- **Tipo:** boolean
- **Default:** `false`
- **Descrição:** true = reavalia o ROADMAP após cada slice completado (permite re-priorizar slices restantes com o aprendizado do slice anterior).

## auto_commit

### `auto_commit`

- **Tipo:** boolean
- **Default:** `true`
- **Descrição:** false = agentes NÃO fazem commits/merges — o usuário gerencia o git manualmente. Afeta executor (commit por task), completer (squash-merge) e isolation cleanup.

## merge_strategy

### `merge_strategy`

- **Tipo:** string
- **Default:** `"squash"`
- **Valores permitidos:** `squash`, `merge`, `rebase`
- **Descrição:** Estratégia de merge do branch do slice na main ao completar. Ignorado quando auto_commit: false.

## auto_push

### `auto_push`

- **Tipo:** boolean
- **Default:** `false`
- **Descrição:** true = push automático após o squash-merge do slice/milestone. Ignorado quando auto_commit: false.

## main_branch

### `main_branch`

- **Tipo:** string
- **Default:** `"master"`
- **Descrição:** Nome da branch principal do repositório (alvo dos merges). Ajuste para main em repositórios que usam esse padrão.

## milestone_cleanup

### `milestone_cleanup`

- **Tipo:** string
- **Default:** `"keep"`
- **Valores permitidos:** `keep`, `archive`, `delete`
- **Descrição:** Destino dos artefatos .gsd/milestones/{id}/ após o milestone completar (o LEDGER.md compacto é sempre gravado antes). keep = mantém tudo; archive = move para .gsd/archive/; delete = remove inteiramente. Arquivos duráveis (AUTO-MEMORY, DECISIONS, LEDGER, STATE, CODING-STANDARDS) nunca são tocados.

## task_cleanup

### `task_cleanup`

- **Tipo:** string
- **Default:** `"keep"`
- **Valores permitidos:** `keep`, `archive`, `delete`
- **Descrição:** Destino dos artefatos .gsd/tasks/{id}/ após uma task solta (/forge-task) completar. keep = mantém; archive = move para .gsd/archive/tasks/; delete = remove.

## compact_after

### `compact_after`

- **Tipo:** integer \| string
- **Default:** `"unlimited"`
- **Descrição:** Unidades por sessão do forge-auto antes de um checkpoint manual (reseta contadores e continua — não para o loop). Número inteiro ou "unlimited". Ausente/"unlimited" = sem checkpoint (o Compaction Resilience Protocol cobre o auto-compact sozinho).

## notifications

### `notifications`

- **Tipo:** string
- **Default:** `"on"`
- **Valores permitidos:** `on`, `off`
- **Descrição:** on = forge-auto dispara PushNotification nos 3 pontos de espera humana (blocker não-recuperável, triagem final de review, Final Report). off = loop idêntico, sem push. Tool ausente no harness = silent-skip. Valor inválido cai em on.

## repo_path

### `repo_path`

- **Tipo:** string
- **Default:** `""`
- **Descrição:** Caminho do repositório forge-agent na máquina — preenchido pelo install.sh; usado pela statusline para o update check. Não editar manualmente em condições normais.

## node_path

### `node_path`

- **Tipo:** string
- **Default:** `""`
- **Descrição:** Caminho absoluto do binário node usado pelo Forge.app para rodar os engines. Vazio → descoberta automática (caminhos fixos, gerenciadores de versão, $PATH, shell de login). Preencha quando o app não achar seu node — a variável de ambiente FORGE_NODE_PATH tem precedência sobre esta chave.

## effort

Default de effort (intensidade de raciocínio) por fase (unit_type). Eixo ortogonal ao tier: o tier escolhe QUAL modelo, o effort escolhe o quão fundo ele pensa. Escala ordenada: low < medium < high < xhigh < max. Sobreposto por effort: no frontmatter do T##-PLAN.md e clampado pela capacidade do modelo resolvido (haiku/sonnet limitam em medium).

### `effort.plan-milestone`

- **Tipo:** string
- **Default:** `"medium"`
- **Valores permitidos:** `low`, `medium`, `high`, `xhigh`, `max`
- **Descrição:** Effort da fase plan-milestone (decomposição arquitetural em slices).

### `effort.plan-slice`

- **Tipo:** string
- **Default:** `"medium"`
- **Valores permitidos:** `low`, `medium`, `high`, `xhigh`, `max`
- **Descrição:** Effort da fase plan-slice (planejamento de tasks). Risk escalation: slice risk:high sobe automaticamente para max.

### `effort.discuss-milestone`

- **Tipo:** string
- **Default:** `"medium"`
- **Valores permitidos:** `low`, `medium`, `high`, `xhigh`, `max`
- **Descrição:** Effort da fase discuss-milestone (decisões de arquitetura com o usuário).

### `effort.discuss-slice`

- **Tipo:** string
- **Default:** `"medium"`
- **Valores permitidos:** `low`, `medium`, `high`, `xhigh`, `max`
- **Descrição:** Effort da fase discuss-slice (decisões de escopo do slice).

### `effort.research-milestone`

- **Tipo:** string
- **Default:** `"medium"`
- **Valores permitidos:** `low`, `medium`, `high`, `xhigh`, `max`
- **Descrição:** Effort da fase research-milestone (exploração de codebase).

### `effort.research-slice`

- **Tipo:** string
- **Default:** `"medium"`
- **Valores permitidos:** `low`, `medium`, `high`, `xhigh`, `max`
- **Descrição:** Effort da fase research-slice (pesquisa focada no slice).

### `effort.execute-task`

- **Tipo:** string
- **Default:** `"low"`
- **Valores permitidos:** `low`, `medium`, `high`, `xhigh`, `max`
- **Descrição:** Effort da fase execute-task (implementação). Override por task via effort: no frontmatter do T##-PLAN.md; clamp em medium quando o modelo resolvido é haiku/sonnet.

### `effort.complete-slice`

- **Tipo:** string
- **Default:** `"low"`
- **Valores permitidos:** `low`, `medium`, `high`, `xhigh`, `max`
- **Descrição:** Effort da fase complete-slice (summaries, UAT, merge).

### `effort.complete-milestone`

- **Tipo:** string
- **Default:** `"low"`
- **Valores permitidos:** `low`, `medium`, `high`, `xhigh`, `max`
- **Descrição:** Effort da fase complete-milestone (fechamento, LEDGER, cleanup).

### `effort.memory-extract`

- **Tipo:** string
- **Default:** `"low"`
- **Valores permitidos:** `low`, `medium`, `high`, `xhigh`, `max`
- **Descrição:** Effort da extração de memórias pós-unidade (haiku — leve por design).

## thinking

Extended thinking por família de fase. adaptive = o modelo decide quanto pensar. Guard de thinking: quando o modelo resolvido é claude-fable-5 (qualquer effort) ou claude-opus-5 com effort xhigh/max, o orquestrador força adaptive — ambos retornam HTTP 400 com thinking disabled explícito nessas condições (Opus 5 aceita disabled só com effort high ou menor).

### `thinking.opus_phases`

- **Tipo:** string
- **Default:** `"adaptive"`
- **Valores permitidos:** `adaptive`, `disabled`
- **Descrição:** Thinking das fases que rodam em Opus (discuss/research/plan).

### `thinking.sonnet_phases`

- **Tipo:** string
- **Default:** `"disabled"`
- **Valores permitidos:** `adaptive`, `disabled`
- **Descrição:** Thinking das fases que rodam em Sonnet (execute/complete). Sonnet não suporta extended thinking — manter disabled.

## ids

Formato dos IDs GERADOS para milestones e tasks soltas. A leitura aceita sempre os dois formatos, independente desta pref.

### `ids.format`

- **Tipo:** string
- **Default:** `"timestamp"`
- **Valores permitidos:** `timestamp`, `sequential`
- **Descrição:** timestamp = M-<YYYYMMDDHHMMSS>-<slug> / T-<ts>-<slug> (sem colisão entre branches paralelos). sequential = legado M001/TASK-001 (max+1 varrendo .gsd/milestones/ + .gsd/archive/ e .gsd/tasks/ — risco de colisão entre devs). Valor inválido cai silenciosamente em timestamp.

## forge_isolation

Como múltiplos /forge-auto//forge-task simultâneos isolam suas mudanças (M004 Multi-Run Workspace). Setup roda na ativação; cleanup só no complete — pause/blocked preservam o isolamento para o resume.

### `forge_isolation.mode`

- **Tipo:** string
- **Default:** `"shared"`
- **Valores permitidos:** `shared`, `branch`, `worktree`
- **Descrição:** shared = single working tree, concorrência protegida por file-locks; branch = cria forge/{M###} em cada repo afetado e commita ali; worktree = worktree física por milestone, isolamento total de FS. DEFAULT DERIVADO DA FORMA DO PROJETO (D4), não de mais uma flag: com este pref AUSENTE, o modo base vem do registro de workspaces (~/.claude/forge-gate-workspaces.json) — um workspace (projeto registrado que contém outros projetos registrados: vários repos, várias runs simultâneas plausíveis) nasce worktree, porque é ali que duas runs colidiriam na mesma working tree; projeto solto, pasta contêiner (role folder), diretório fora do registro, registro ausente ou ilegível → shared (uma run por vez; worktree seria custo sem benefício). Falha de derivação é silenciosa e segura: isso roda em toda ativação e shared é o que essas máquinas sempre tiveram. PRECEDÊNCIA: (1) vcs svn curto-circuita tudo → shared (sem equivalente de worktree/branch na Fase 1 do M017); (2) pref EXPLÍCITO sempre vence a derivação, inclusive um shared explícito dentro de um workspace, que é o opt-out do operador; (3) sem pref, a forma decide o modo base; (4) workers.require_worktree eleva por cima do modo base resultante, com as mesmas regras para base derivada e base vinda de pref — base derivada worktree torna a elevação um no-op, e require_worktree false proíbe ELEVAÇÃO, não desfaz o default derivado. O JSON de --effective-mode reporta mode_origin (pref | derived-shape | default), mais shape_role/shape_reason quando a derivação rodou. CONGELADO NO NASCIMENTO DA RUN: o modo efetivo é resolvido UMA vez, na ativação, e gravado no registro da run (forge-runs --add --isolation-mode); cleanup e todo consumidor posterior lêem esse valor congelado e nada recomputa o modo a partir da forma atual do projeto. Uma run que começou shared termina shared mesmo que o projeto vire workspace no meio — senão os dois modos coexistiriam no mesmo repo e nenhum cleanup enxergaria os artefatos do outro; registros legados (anteriores ao campo isolation_mode) caem num fallback que resolve com a derivação por forma DESLIGADA, pelo mesmo motivo. Dogfood: o próprio repo forge-agent é projeto solto (derivaria shared), e seu pref explícito branch vence e o mantém em branch.

### `forge_isolation.branch_pattern`

- **Tipo:** string
- **Default:** `"forge/{M###}"`
- **Descrição:** Nome da branch quando mode = branch/worktree. Placeholders: {M###} (milestone ID), {id}.

### `forge_isolation.auto_pull_main`

- **Tipo:** boolean
- **Default:** `true`
- **Descrição:** true = git fetch origin <default> antes de ramificar — branch/worktree nascem de origin/<default> fresco, nunca da main local stale. Fallback gracioso para o ref local sem remote origin.

### `forge_isolation.pr_on_complete`

- **Tipo:** boolean
- **Default:** `false`
- **Descrição:** true (opt-in) = complete-milestone roda `npm run pr` / `gh pr create` ao fechar.

### `forge_isolation.worktree_root`

- **Tipo:** string
- **Default:** `".forge-worktrees"`
- **Descrição:** Nome do diretório onde as worktrees são criadas (mode = worktree); caminho absoluto também aceito. Precedência do endereço, três casos e nenhum quarto: (1) pref ABSOLUTO vence sempre → <pref>/<runId>/<repo>, nenhum root é consultado; (2) repo sob um ROOT declarado no registro (~/.claude/forge-gate-workspaces.json) → <root>/<dirName>/<runId>/<repo>, onde dirName = layout.worktrees do root quando declarado, senão este pref relativo (root mais profundo vence, mesma regra de containment do codec); (3) sem registro, registro ilegível, ou repo fora de todo root → fallback legado irmão do repo (<pai-do-repo>/<worktree_root>/<runId>/<repo>), sempre reportado na linha do repo (anchor: 'legacy-sibling', mais warn quando o registro existe e não pôde ser lido) — nunca silencioso. layout.worktrees DEVE ser oculto: relativo, sem '..', primeiro segmento começando por '.' — um diretório de worktree não-oculto é varrido pelo ProjectDiscovery e cada .gsd/ dentro dele vira projeto-fantasma; valor inválido faz o setup recusar em voz alta (status: 'error' nomeando o arquivo de registro e o valor), nunca cai em default silencioso. Um worktree_root (pref) não-oculto sob um root não é erro: degrada para o fallback legado com warn. Mudar o endereço depois não órfã nada — o cleanup pergunta ao `git worktree list --porcelain`, não re-deriva a convenção. Exemplo de root com layout: {"path": "~/Development", "primary": true, "layout": {"worktrees": ".forge-worktrees"}}.

### `forge_isolation.worktree_cleanup_on_complete`

- **Tipo:** boolean
- **Default:** `false`
- **Descrição:** true = remove a worktree ao completar a milestone. Mesmo com true, NUNCA remove worktree suja (mudanças não commitadas) — cleanup vira skipped (dirty). Com auto_commit: false, commite na branch forge/{id} antes.

### `forge_isolation.worktree_install_deps`

- **Tipo:** boolean
- **Default:** `true`
- **Descrição:** true = ao provisionar uma worktree (mode = worktree), instala dependências automaticamente detectando o lockfile na raiz do repo (package-lock.json → npm ci, pnpm-lock.yaml → pnpm install, yarn.lock → yarn install). Roda uma vez por run, com timeout de 10 min. Falha no install degrada e avisa — nunca aborta o isolamento. O install executa lifecycle scripts do repo (ex.: postinstall) — quem roda o forge sobre repositório de terceiro/não-confiável deve considerar false.

### `forge_isolation.file_locks`

- **Tipo:** boolean
- **Default:** `true`
- **Descrição:** Ativa o PreToolUse file-lock check contra writes simultâneos no mesmo arquivo (modes shared/branch). Ignorado em mode = worktree (FS já isolado — o hook retorna false automaticamente).

### `forge_isolation.repos.auto_detect`

- **Tipo:** boolean
- **Default:** `true`
- **Descrição:** true = walk de subdiretórios com .git/ na raiz do workspace. Ignorado quando include está definido.

### `forge_isolation.repos.include`

- **Tipo:** array
- **Default:** `[]`
- **Descrição:** Globs explícitos de repos a incluir; quando não-vazio, desliga o auto_detect e usa somente esta lista.

### `forge_isolation.repos.exclude`

- **Tipo:** array
- **Default:** `["node_modules/**","vendor/**",".forge-worktrees/**",".gsd/**","dist/**","build/**",".next/**"]`
- **Descrição:** Globs a excluir do auto-detect. Default real do reader (forge-repos.js DEFAULT_EXCLUDE) — mais amplo que o exemplo do template.

## multi_run

Registro e saúde de runs simultâneas (.gsd/forge/runs/*.json) — staleness, refuse sem ID, refresh do dashboard e alias legado.

### `multi_run.stale_cleanup_ms`

- **Tipo:** integer
- **Default:** `1800000`
- **Descrição:** 30min — registros de run com last_heartbeat mais velho que isso são deletados silenciosamente no boot de qualquer /forge-* skill (cobre kills sem cleanup).

### `multi_run.stale_warning_ms`

- **Tipo:** integer
- **Default:** `180000`
- **Descrição:** 3min — a statusline marca a run como amarela (possível stall). Não bloqueia — só comunica saúde.

### `multi_run.stale_red_ms`

- **Tipo:** integer
- **Default:** `300000`
- **Descrição:** 5min — statusline vermelha; a CLI trata a run como morta. Não bloqueia.

### `multi_run.refused_when_active_count`

- **Tipo:** integer
- **Default:** `2`
- **Descrição:** /forge-auto sem ID explícito recusa quando >= N runs ativas (1 = sempre exige ID; 999 = nunca recusa).

### `multi_run.dashboard_refresh_on`

- **Tipo:** array
- **Default:** `["boot","exit","phase_change"]`
- **Descrição:** Eventos do ciclo que disparam regen do dashboard .gsd/STATE.md via scripts/forge-dashboard.js. Valores válidos: boot, exit, phase_change, tick (tick = regen periódico, custoso — não recomendado).

### `multi_run.legacy_alias`

- **Tipo:** boolean
- **Default:** `true`
- **Descrição:** true = mantém .gsd/forge/auto-mode.json como espelho da run ativa mais antiga (compat pré-M004). false = o arquivo só é tocado por código legado (deprecation path).

## parallelism

Execução paralela de execute-task dentro do mesmo slice + comportamento em overlap entre runs.

### `parallelism.max_concurrent`

- **Tipo:** integer
- **Default:** `3`
- **Descrição:** Máximo de execute-task em paralelo dentro do mesmo slice. Range válido 1–8; 1 desliga o paralelismo mantendo o picking depends-aware.

### `parallelism.cross_run_overlap`

- **Tipo:** string
- **Default:** `"defer"`
- **Valores permitidos:** `defer`, `block`
- **Descrição:** Quando uma task do batch tem expected_output que sobrepõe outra run ativa: defer = pula a task e escolhe outra ready (re-tenta no próximo batch); block = pausa o dispatch até a outra run liberar (polling com backoff).

## retry

Retry Handler para falhas transitórias do Agent() (rate-limit, network, server, stream, connection). Classes permanentes/unknown falham imediatamente; model_refusal/context_overflow/tooling_failure são da Failure Taxonomy, não deste handler.

### `retry.max_transient_retries`

- **Tipo:** integer
- **Default:** `3`
- **Descrição:** Cap de retries transitórios por unidade antes de surfacear o blocker ao usuário.

### `retry.base_backoff_ms`

- **Tipo:** integer
- **Default:** `2000`
- **Descrição:** Delay do primeiro retry (ms); dobrado a cada tentativa (backoff exponencial).

### `retry.max_backoff_ms`

- **Tipo:** integer
- **Default:** `60000`
- **Descrição:** Teto do backoff computado (ms).

## tier_models

Qual model ID concreto cada alias de tier resolve no dispatch. Aceita escalar ou lista [primário, ...fallbacks] — a lista forma a escada intra-tier consumida pela Failure Taxonomy (model_refusal/429/400). O ID é traduzido para alias de Agent() por scripts/forge-model-alias.js; ID não mapeado é pulado com warning.

### `tier_models.light`

- **Tipo:** string \| array
- **Default:** `"claude-haiku-4-5-20251001"`
- **Descrição:** Tier leve — memory-extract, complete-slice, tasks tag: docs. Escalar ou lista de fallback intra-tier.

### `tier_models.standard`

- **Tipo:** string \| array
- **Default:** `"claude-sonnet-5"`
- **Descrição:** Tier padrão — execute-task default, research, discuss. Escalar ou lista de fallback intra-tier.

### `tier_models.heavy`

- **Tipo:** string \| array
- **Default:** `"claude-opus-5"`
- **Descrição:** Tier de raciocínio profundo — plan-slice default. claude-opus-5 tem 1M de contexto por default (sem sufixo [1m]); fonte: forge-tier-chain.js DEFAULT_TIER_MODEL. Escalar ou lista.

### `tier_models.max`

- **Tipo:** string \| array
- **Default:** `"claude-fable-5"`
- **Descrição:** Tier de fronteira — plan-milestone, plan-slice risk:high, escalação de context_overflow. ~2x o custo do opus. Escalar ou lista.

## workers

Eixo workers: qual ENGINE (claude nativo em contexto ou sidecar codex via scripts/forge-xllm.js) executa cada unit_type routável. Ortogonal a tier_models (que escolhe o modelo Claude dentro do worker claude). plan-milestone nunca é coberto (locked em max/Fable).

### `workers.execute-task`

- **Tipo:** string
- **Default:** `"claude"`
- **Valores permitidos:** `claude`, `codex`
- **Descrição:** Engine das unidades execute-task. codex roteia ao sidecar (--mode execute); falha do sidecar reseta ao START_SHA e cai uma única vez no worker Claude (evento worker-engine-fallback). Valor inválido cai em claude.

### `workers.plan-slice`

- **Tipo:** string
- **Default:** `"claude"`
- **Valores permitidos:** `claude`, `codex`
- **Descrição:** Engine das unidades plan-slice. codex roteia ao sidecar --mode plan (read-only — o orquestrador materializa o retorno). Valor inválido cai em claude.

### `workers.timeout`

- **Tipo:** integer
- **Default:** `1800`
- **Descrição:** Segundos — teto do sidecar codex antes do SIGKILL. Só se aplica quando o engine resolvido é codex; inválido/não-positivo cai em 1800.

### `workers.codex_model`

- **Tipo:** string \| null
- **Default:** `null`
- **Descrição:** Repassado como -m <valor> ao codex-cli quando definido; null/unset usa o modelo default do CLI instalado (ex.: gpt-5.6-sol). Ignorado quando o engine é claude.

### `workers.sidecar_on_failure`

- **Tipo:** string
- **Default:** `"retry-then-fallback"`
- **Valores permitidos:** `retry-then-fallback`, `fallback`, `pause-ask`
- **Descrição:** Política ao falhar o sidecar codex. retry-then-fallback (default): Layer-1 retenta o mesmo codex em erro transiente (S02) e só então cai no fallback Claude. fallback: pula o Layer-1 (comportamento pré-S02). pause-ask: retenta transiente e, SÓ na exaustão, pausa + AskUserQuestion (interativo) ou degrada a fallback + evento sidecar-pause-degraded (headless). Valor inválido cai em retry-then-fallback.

### `workers.require_worktree`

- **Tipo:** string \| boolean
- **Default:** `"auto"`
- **Valores permitidos:** `auto`, `true`, `false`, `true`, `false`
- **Descrição:** Elevação estática de isolamento por engine de escrita, resolvida na ativação por scripts/forge-isolation.js resolveEffectiveMode. auto (default): eleva forge_isolation.mode shared→worktree quando um engine externo de escrita (codex via workers.execute-task, ou família gpt/gemini em routing.<domain>.executor) é resolvido p/ execute-task; branch sob auto NÃO eleva. true: sempre exige worktree (eleva shared/branch→worktree). false: nunca eleva — byte-idêntico ao comportamento atual. Paths read-only (plan-slice Branch D, review challenger) não disparam elevação. Falso-positivo aceitável, falso-negativo não.

## sidecars

Eixo sidecars: isolamento do ambiente entregue aos processos externos codex e agy.

### `sidecars.env_policy`

- **Tipo:** string
- **Default:** `"minimal"`
- **Valores permitidos:** `minimal`, `inherit`
- **Descrição:** Política de ambiente dos sidecars. minimal repassa apenas a allowlist; inherit preserva variáveis não sensíveis como escape hatch. Ambas removem tokens, segredos, credenciais e prefixos de provedores antes do spawn.

## routing

### `routing`

- **Tipo:** object
- **Default:** `{}`
- **Descrição:** Eixo routing (M007): roteamento domain-first opt-in com precedência sobre tier_models/workers. Chaves de domínio são ABERTAS (default, backend, frontend, ...). Shape por domínio: { <phase executor|planner>: { <tier>: [cadeia de IDs, cross-engine permitido], fallback: <1 ID Claude mapeado> } }. Célula ausente → domínio default → legado (nunca erro). Cascata last-wins por domínio inteiro. Resolvedor: scripts/forge-routing.js. Somente execute-task (executor) e plan-slice (planner) são capturados; demais unit_types resolvem por tier_models — ver /forge-prefs phases.

## verification

Verification gate (lint/typecheck/test) antes de marcar task como DONE e antes do squash-merge do slice. Discovery chain: T##-PLAN verify: → preference_commands → package.json scripts do allow-list [typecheck, lint, test] → skipped: no-stack.

### `verification.preference_commands`

- **Tipo:** array
- **Default:** `[]`
- **Descrição:** Lista ordenada de comandos shell a executar como gate. Vazio = fallback para o verify: do plano ou auto-detect do package.json. ATENÇÃO: executados no shell do repo — não adicione comandos não revisados.

### `verification.command_timeout_ms`

- **Tipo:** integer
- **Default:** `120000`
- **Descrição:** Timeout por comando (ms). Estouro produz exit 124 sintético — tratado como falha, não como skip.

## evidence

Evidence log (PostToolUse) para verificação de claims nos summaries — cada Bash/Write/Edit grava uma linha JSONL em .gsd/forge/evidence-{unitId}.jsonl.

### `evidence.mode`

- **Tipo:** string
- **Default:** `"lenient"`
- **Valores permitidos:** `lenient`, `strict`, `disabled`
- **Descrição:** lenient = escreve o log; mismatches viram seção advisory '## Evidence Flags' no S##-SUMMARY (não bloqueia). strict = reservado M004+ (mismatches bloqueiam complete-slice). disabled = hook pula a escrita — zero log. Valor inválido cai em lenient.

## file_audit

Filtro do file-audit do forge-completer (seção ## File Audit no S##-SUMMARY): git diff AM vs união dos expected_output das tasks do slice.

### `file_audit.ignore_list`

- **Tipo:** array
- **Default:** `["package-lock.json","yarn.lock","pnpm-lock.yaml","dist/**","build/**",".next/**",".gsd/**","node_modules/**"]`
- **Descrição:** Globs excluídos de ambos os lados do diff (evita ruído de lockfiles e build). Suporta prefix exato, ** (qualquer profundidade) e * dentro de segmento. Bloco ausente/vazio = este default hardcoded, sem erro.

## memory

Política de custo da memória emergente. A seleção de fatos para prompts é determinística; este bloco controla quando vale pagar uma nova chamada de extração.

### `memory.extraction`

- **Tipo:** string
- **Default:** `"adaptive"`
- **Valores permitidos:** `adaptive`, `always`, `disabled`
- **Descrição:** adaptive = extrai em summaries de boundary e em execute-task com sinal durável (decisão, gotcha, padrão); planos/research/discuss já persistem o conhecimento em artefatos próprios e não disparam outro modelo. always = comportamento legado após toda unidade. disabled = nunca despacha forge-memory.

## checker_memory

Loop de feedback anti-recidivismo: extrai padrões warn/fail do plan-checker e do verificador para .gsd/CHECKER-MEMORY.md, injetados nas próximas execuções (planner recebe Plan Quality Patterns; executor recebe Verification Patterns).

### `checker_memory.mode`

- **Tipo:** string
- **Default:** `"enabled"`
- **Valores permitidos:** `enabled`, `disabled`
- **Descrição:** enabled = forge-completer extrai após cada complete-slice. disabled = pula completamente — nenhum CHECKER-MEMORY.md é gerado/atualizado.

## plan_check

Gate do forge-plan-checker entre plan-slice e o primeiro execute-task — pontua 10 dimensões estruturais do plano e grava S##-PLAN-CHECK.md.

### `plan_check.mode`

- **Tipo:** string
- **Default:** `"advisory"`
- **Valores permitidos:** `advisory`, `blocking`, `disabled`
- **Descrição:** advisory = pontua e prossegue independente do veredicto (flags viram documentação). blocking = revision-loop (max 3 rodadas, fails em decremento monotônico; senão pausa e notifica). disabled = pula o gate — nenhum artefato gerado.

## review

Review gate dialético antes de complete-slice (branch ainda não-mergeado): challenger (forge-reviewer) × advocate (forge-advocate), humano arbitra só as objeções abertas. Nunca bloqueia o complete. Spec: shared/forge-review.md.

### `review.mode`

- **Tipo:** string
- **Default:** `"enabled"`
- **Valores permitidos:** `enabled`, `disabled`
- **Descrição:** enabled = o gate roda por slice. disabled = pula inteiramente — nenhum S##-REVIEW.md é gerado.

### `review.engine`

- **Tipo:** string
- **Default:** `"agents"`
- **Valores permitidos:** `agents`, `workflow`
- **Descrição:** Quem roda o debate (Steps 2–5). agents = dispatch via Agent() no orquestrador (default). workflow = uma única invocação da tool Workflow (Claude Code >= 2.1.154; requer bypassPermissions para não pausar o forge-auto); tool ausente/erro → fallback automático para agents. Ignorado quando style: flags.

### `review.style`

- **Tipo:** string
- **Default:** `"dialectic"`
- **Valores permitidos:** `dialectic`, `flags`
- **Descrição:** dialectic = debate completo (challenge → defense → rebuttal → resolução). flags = single-pass legado — só o challenger, sem defesa nem perguntas.

### `review.trigger`

- **Tipo:** string
- **Default:** `"adaptive"`
- **Valores permitidos:** `adaptive`, `always`
- **Descrição:** adaptive = docs-only pula; código comum usa flags (1 chamada); risk:high, checklist de segurança, drift, paths sensíveis ou diff grande usam dialectic. always = preserva o style configurado em todo diff não-vazio. A decisão determinística vem de scripts/forge-cost-policy.js.

### `review.adaptive_flags_lines`

- **Tipo:** integer
- **Default:** `40`
- **Descrição:** Limiar informativo de diff pequeno para a razão de auditoria adaptive-small-diff. Código comum continua em flags acima dele até encontrar um sinal de dialectic.

### `review.adaptive_dialectic_lines`

- **Tipo:** integer
- **Default:** `400`
- **Descrição:** Total de linhas adicionadas+removidas a partir do qual review.trigger: adaptive escala para o debate dialético completo.

### `review.rounds`

- **Tipo:** integer
- **Default:** `1`
- **Valores permitidos:** `0`, `1`, `2`, `3`
- **Descrição:** Rodadas de réplica do reviewer sobre a defesa (0–3). 0 = sem réplica (toda objeção contestada vira aberta).

### `review.ask_in_auto`

- **Tipo:** string
- **Default:** `"defer"`
- **Valores permitidos:** `defer`, `pause`, `gate`
- **Descrição:** defer = no forge-auto, objeções abertas NÃO pausam o loop — vão para a triagem final da milestone (honra a AUTONOMY RULE). pause = pergunta ao humano por slice mesmo em modo autônomo (opt-in). | gate = abre uma pergunta no mailbox (scripts/forge-gate.js) e espera com timeout — o app/CLI responde; sem resposta cai no default declarado, equivalente a defer. Não pausa o loop.

### `review.fix_conceded`

- **Tipo:** boolean
- **Default:** `true`
- **Descrição:** true = objeções concedidas (ambos concordam que o problema é real) disparam um review-fix imediato pelo forge-executor no branch do slice (sem re-review, evita ping-pong). false = concedidas apenas registradas.

### `review.challenger`

- **Tipo:** string
- **Default:** `"claude"`
- **Valores permitidos:** `claude`, `codex`, `gemini`, `auto`
- **Descrição:** Quem desafia (challenge + rebuttal). codex = GPT via o protocolo codex app-server (transporte argv anterior aposentado em M018 S05); gemini = Antigravity CLI agy — ambos via scripts/forge-xllm.js, com fallback automático ao forge-reviewer Claude em qualquer falha. auto = família OPOSTA ao autor do código (reduz viés de auto-preferência). Valor inválido cai em claude.

### `review.advocate`

- **Tipo:** string
- **Default:** `"claude"`
- **Valores permitidos:** `claude`, `auto`
- **Descrição:** Quem defende. auto = MESMA família do autor; enquanto --mode defend externo não existe, autor GPT/Gemini degrada para advocate Claude (evento review-pairing-fallback) — nunca bloqueia.

### `review.challenger_model`

- **Tipo:** string \| null
- **Default:** `null`
- **Descrição:** Modelo repassado ao CLI externo quando o challenger RESOLVIDO não é claude; se claude, fica inerte e emite review-config-inert. null/unset usa o default do CLI.

### `review.advocate_model`

- **Tipo:** string
- **Default:** `"claude-fable-5"`
- **Descrição:** Modelo do defender (forge-advocate), resolvido para alias via scripts/forge-model-alias.js e auditado por scripts/forge-review-audit.js. ID sem alias omite model:. Default literal — nunca null.

### `review.gate_timeout_ms`

- **Tipo:** integer
- **Default:** `1800000`
- **Descrição:** Timeout (ms) da pergunta quando review.ask_in_auto: gate. Sem resposta dentro do prazo, o item é deferido para a triagem final (Step 9) — nunca fechado em silêncio. Default 30min.

## plan_gate

Conduct interativo de lapidação do plano entre plan-slice e o primeiro execute-task (modos interativos forge-task/forge-next): preview + findings acionáveis + edição livre + aprovação. Separado do scoring (plan_check). Spec: shared/forge-plan-gate.md.

### `plan_gate.interactive`

- **Tipo:** string
- **Default:** `"always"`
- **Valores permitidos:** `always`, `auto`, `off`
- **Descrição:** always = conduz o handshake sempre que existe um plano, mesmo all-pass. auto = só quando há warn/fail do plan-checker. off = batch advisory mesmo em modo interativo.

### `plan_gate.ask_in_auto`

- **Tipo:** string
- **Default:** `"defer"`
- **Valores permitidos:** `defer`, `off`
- **Descrição:** forge-auto NUNCA conduz o handshake, incondicionalmente (AUTONOMY RULE). defer e off são semanticamente idênticos para o forge-auto — off existe como sinalizador explícito de intenção.

## token_budget

Cap (em tokens, heurística chars/4) das seções OPCIONAIS injetadas nos prompts dos workers via truncateAtSectionBoundary (scripts/forge-tokens.js). Seções mandatórias nunca são truncadas silenciosamente. Chave ausente = default hardcoded, sem erro.

### `token_budget.auto_memory`

- **Tipo:** integer
- **Default:** `2000`
- **Descrição:** Cap em tokens do snippet AUTO-MEMORY ({TOP_MEMORIES}) injetado em cada worker.

### `token_budget.ledger_snapshot`

- **Tipo:** integer
- **Default:** `1500`
- **Descrição:** Cap em tokens do snippet do LEDGER.md ({LEDGER}) quando injetado.

### `token_budget.coding_standards`

- **Tipo:** integer
- **Default:** `3000`
- **Descrição:** Cap compartilhado entre {CS_STRUCTURE} e {CS_RULES} (contado uma vez por dispatch).

## verifier

Detectores de qualidade do scripts/forge-verifier.js (nível 4 — test-quality) sobre artefatos de teste declarados em must_haves/expected_output.

### `verifier.test_quality`

- **Tipo:** string
- **Default:** `"advisory"`
- **Valores permitidos:** `advisory`, `blocking`, `disabled`
- **Descrição:** advisory = detecta disabled-test/weak-assertion/no-assertion/circular-assertion e registra flags no S##-VERIFICATION.md sem bloquear. blocking = reservado M004+ (flags bloqueiam complete-slice). disabled = pula o nível 4.

## symbol_check

Drift guard scripts/forge-symbol-check.js: verifica se os símbolos citados nos planos existem no código real, entre plan-check e o primeiro execute-task.

### `symbol_check.mode`

- **Tipo:** string
- **Default:** `"advisory"`
- **Valores permitidos:** `advisory`, `disabled`
- **Descrição:** advisory = resolve cada símbolo (ripgrep/grep) e emite VERIFIED|MISSING|AMBIGUOUS|UNCHECKABLE em S##-SYMBOL-CHECK.md, sem bloquear. Greenfield (artefatos ainda não criados) não flagga MISSING. disabled = pula o gate.

## context_monitor

Context-monitor proativo: a statusline grava o % de contexto restante num bridge por sessão; o hook PostToolUse injeta additionalContext (WARNING/CRITICAL) no worker ANTES de bater no muro de contexto. Puramente informativo — nunca bloqueia (por isso nasce enabled).

### `context_monitor.enabled`

- **Tipo:** boolean
- **Default:** `true`
- **Descrição:** true = injeção proativa ativa (debounce de 5 tool-uses; escalada WARNING→CRITICAL fura o debounce). false = branch no-op.

### `context_monitor.warning_threshold`

- **Tipo:** number
- **Default:** `0.35`
- **Descrição:** Fração de contexto RESTANTE que dispara WARNING (encerre a task atual, não inicie trabalho complexo novo). Aceita percentual (35) — normalizado para fração quando > 1.

### `context_monitor.critical_threshold`

- **Tipo:** number
- **Default:** `0.25`
- **Descrição:** Fração de contexto RESTANTE que dispara CRITICAL (pare, salve o estado em continue.md e retorne partial). Testado antes do warning — mais grave ganha.

## repair

Node Repair (camada 3 da recuperação de falhas): estratégias RETRY/DECOMPOSE/PRUNE por task antes do fallback blocked→humano.

### `repair.budget`

- **Tipo:** integer
- **Default:** `2`
- **Descrição:** Máximo de tentativas de reparo por task (repair_count persistido no frontmatter do T##-PLAN.md — sobrevive compaction). Esgotado → blocked → humano. context_overflow nunca consome este budget (pertence à Failure Taxonomy).

## scope_reduction

Re-injeção de must_haves planejados mas não entregues (após um PRUNE) nas próximas unidades do slice.

### `scope_reduction.reinject`

- **Tipo:** string
- **Default:** `"auto"`
- **Valores permitidos:** `auto`, `off`
- **Descrição:** auto = must_haves dropados viram seção 'Requisitos pendentes re-injetados' no prompt da próxima unidade (cap de 10 itens). off = opt-out da re-injeção; o PRUNE ainda registra em S##-CONTEXT § Decisions (nunca some em silêncio).

## accounts

Handoff de conta por esgotamento de janela de uso (5h/semanal) no /forge-auto — checkpoint + pausa + comando de relançamento em outra conta registrada (/forge-accounts). Nunca é hot-swap; sempre relaunch com resume por disco.

### `accounts.handoff_in_auto`

- **Tipo:** string
- **Default:** `"on"`
- **Valores permitidos:** `on`, `off`
- **Descrição:** on = ao cruzar o threshold na fronteira de unidade, o loop faz checkpoint (continue.md), pausa e indica a troca de conta. off = sem pausa automática (a statusline ainda mostra o alerta de uso).

### `accounts.handoff_threshold`

- **Tipo:** integer
- **Default:** `90`
- **Descrição:** % de uso da janela mais apertada (5h OU semanal) que dispara o handoff.

## app

Knobs consumidos exclusivamente pelo app macOS (Forge.app) — não pelo CLI. Resolvidos via forge-prefs.js --resolved sem cwd, ou seja, sempre da camada global (~/.claude/forge-agent-prefs.jsonc); "qual projeto o app preseleciona" é uma preferência por operador, não por projeto.

### `app.default_workspace`

- **Tipo:** string
- **Default:** `""`
- **Descrição:** Caminho absoluto do projeto que o app preseleciona no composer e na folha de nova sessão. Vazio = sem default: o app usa o último projeto usado ou pede — ele NUNCA escolhe um por conta própria.

### `app.session_root_dir`

- **Tipo:** string
- **Default:** `""`
- **Descrição:** Diretório onde uma sessão shell/chat iniciada sem projeto abre. Vazio = $HOME. Um `~/` no início é expandido.
