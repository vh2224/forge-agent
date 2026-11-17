<!-- forge-source:claude-instructions source=CLAUDE.md version=4.25.0 -->

# Forge Agent — Context Engineering Orchestrator for Claude Code

Projeto de agente orquestrador que implementa a metodologia GSD-2 (Get Stuff Done) nativamente no Claude Code. Transforma Claude Code em um sistema multi-agente com context isolation, memória emergente e execução autônoma.

## O que este projeto FAZ

Forge Agent é um sistema de **context engineering** que:

1. **Orquestra agentes especializados** — cada fase do desenvolvimento (planejamento, pesquisa, execução, completação) usa um agente com modelo e contexto isolado
2. **Mantém estado persistente** — toda decisão, plano e progresso vive em arquivos `.gsd/` auditáveis
3. **Aprende com o trabalho** — sistema de memória emergente extrai padrões do codebase após cada unidade de trabalho
4. **Executa autonomamente** — modo `/forge-auto` roda milestones inteiros sem intervenção humana (exceto `discuss`)
5. **Se auto-recupera** — taxonomia de falhas com estratégias de retry por classe (context overflow, model refusal, etc.)

## Arquitetura

### Hierarquia de trabalho
```
Milestone (M-<ts>-<slug>) → Slice (S##) → Task (T##)
```
Regra de ferro: cada Task cabe em um context window. Slices agrupam tasks relacionadas. Milestones são entregas de valor.

### Modelo de agentes

A coluna de modelo é resolvida pela configuração atual por unidade; a tabela
descreve responsabilidades e não autoriza omitir modelo ou escolher engine.

| Agente | Modelo | Fase | Responsabilidade |
|--------|--------|------|------------------|
| **Orquestrador** | (contexto principal) | — | Dispatch loop: lê STATE, deriva próxima unidade, monta prompt, despacha, processa resultado |
| `forge-planner` | Resolvido por unidade | plan-milestone, plan-slice | Decompõe trabalho em slices/tasks, escreve ROADMAP e PLANs |
| `forge-discusser` | Resolvido por unidade | discuss-milestone, discuss-slice | Identifica ambiguidades, faz perguntas ao usuário, registra decisões |
| `forge-researcher` | Resolvido por unidade | research-milestone, research-slice | Explora codebase, documenta padrões existentes, atualiza CODING-STANDARDS |
| `forge-executor` | Resolvido por unidade | execute-task | Implementa código, verifica must-haves, commita, escreve SUMMARY |
| `forge-completer` | Resolvido por unidade | complete-slice, complete-milestone | Escreve summaries, UAT scripts, fecha artefatos; no fecho da milestone dá tag e push da branch do run (`forge/{run}`) — nunca integra: a integração é do operador |
| `forge-memory` | Resolvido por unidade | pós-unidade | Extrai conhecimento durável do trabalho completado (quality gate: project-specific + non-obvious + durable) |
| `forge-reviewer` | Resolvido por unidade | review gate (challenger) | Reviewer adversarial — acha bugs/brechas no diff do slice; em rebuttal mode reage à defesa do advocate. Read-only, advisory |
| `forge-advocate` | Resolvido por unidade | review gate (defender) | Autor que defende o código contra as objeções do reviewer — refuta, concede ou marca `open`. Read-only, advisory |
| `forge-plan-checker` | Resolvido por unidade | gate plan-slice→execute | Pontua 10 dimensões estruturais do plano (advisory) |
| `forge-worker` | Resolvido por unidade | (template legado) | Template genérico — não usado diretamente |

### Dispatch loop (forge-auto / forge-next)

O orquestrador NÃO é um agente — roda no contexto principal. Ciclo:
1. Resolve o trabalho pelo contexto pessoal canônico (ou ID explícito); então lê o estado da unidade selecionada e deriva `unit_type` + `unit_id`
2. **Risk radar gate:** se `unit_type == plan-slice` e slice é `risk:high`, invoca `Skill("forge-risk-radar")` no contexto principal antes de despachar o planner
3. Monta prompt com artefatos `.gsd/` inlined (não resumidos) + `effort` + `thinking` resolvidos de PREFS
4. Valida e despacha pela rota/adaptador efetivos, com modelo e esforço explícitos; a ferramenta nativa depende do host
5. Processa `---GSD-WORKER-RESULT---` (done/partial/blocked)
6. Housekeeping: atualiza STATE, appende decisões, extrai memórias
7. Repete (auto) ou para (next)

### Context isolation por unidade

Cada unidade de trabalho roda em agente fresh — zero acúmulo de tokens entre unidades. O orquestrador injeta APENAS os artefatos necessários no prompt do worker. Isso permite milestones com dezenas de tasks sem estourar contexto.

### Sistema de memória emergente

Nos boundaries definidos pela política efetiva de memória, o worker resolvido lê o resultado e extrai padrões duráveis:
- Categories: gotcha, convention, architecture, pattern, environment, preference
- Quality gate: 3 perguntas (project-specific? non-obvious? durable?) — todas YES para salvar
- Confidence scoring com decay (memórias não-acessadas perdem confiança)
- Cap de 50 entradas ativas em `.gsd/AUTO-MEMORY.md`
- Memórias são injetadas em cada unidade subsequente

### Configuração multi-camada

Resolução (último sobrescreve):
1. `${FORGE_HOME:-~/.forge-agent}/forge-agent-prefs.jsonc` — global canônico do operador
2. `.gsd/forge-prefs.jsonc` — local ao checkout, não configuração compartilhada por commit

O JSONC em `~/.claude/forge-agent-prefs.jsonc` é fallback legado, usado somente
quando o arquivo global canônico não existe. Preferências Markdown exigem migração
explícita: o resolvedor normal não as lê e recusa a camada sem JSONC; o utilitário
de migração faz a leitura do legado.
Use forge-prefs para conferir valores/camadas e forge-prefs-migrate --set para
alterações autorizadas; confirme o ignore real no VCS de cada projeto.

Configurável: modelos por fase, skip rules (discuss/research), merge_strategy (documental — a integração é do operador), auto_push (push da branch do run), isolation mode, **effort por fase** (`low|medium|high|max`), **thinking por fase** (`adaptive|disabled`).

### Skill composition

Skills são invocadas via `Skill` tool diretamente no contexto principal do orquestrador — não via subagente intermediário. Isso elimina cold-start e path-searching frágil.

Fluxo de composição:
- `/forge-new-milestone` → `Skill(brainstorm)` → `Skill(scope-clarity)` → discuss → `Agent(planner)` → `Skill(risk-radar)` por slice high-risk
- `/forge-discuss` → `Skill(brainstorm)` se BRAINSTORM.md não existe → discuss inline
- `/forge-auto` / `/forge-next` → `Skill(risk-radar)` automático antes de `plan-slice` com `risk:high`

**Regra:** Skills são auto-suficientes (lêem seus próprios arquivos de disco). Não injetar contexto via args — passar apenas IDs (`M-<ts>-<slug>` para milestones, `S##` para slices).

## Estrutura de arquivos do projeto

```
forge-agent/
├── agents/                      # Definições de agentes (.md com frontmatter YAML)
│   ├── forge-discusser.md       # Opus — decisões de arquitetura
│   ├── forge-researcher.md      # Opus — exploração de codebase
│   ├── forge-planner.md         # Opus — decomposição em tasks
│   ├── forge-executor.md        # Sonnet — implementação de código
│   ├── forge-completer.md       # Sonnet — fechamento e merge
│   ├── forge-memory.md          # Haiku — extração de memórias
│   ├── forge-reviewer.md        # Sonnet — challenger do review dialético (+ rebuttal mode)
│   ├── forge-advocate.md        # Sonnet — defender (autor) do review dialético
│   ├── forge-plan-checker.md    # Sonnet — plan-checker advisory (10 dimensões)
│   └── forge-worker.md          # Template genérico (legado)
├── commands/                    # Slash commands para CLI (/forge-*)
│   ├── forge-auto.md            # Modo autônomo — milestone inteiro
│   ├── forge-next.md            # Step mode — uma unidade
│   ├── forge-init.md            # Bootstrap do projeto
│   ├── forge-new-milestone.md   # Criação de milestone (brainstorm → discuss → plan)
│   ├── forge-discuss.md         # Fase de discussão com ambiguity scoring
│   ├── forge-add-slice.md       # Adicionar slice a milestone
│   ├── forge-add-task.md        # Adicionar task a slice
│   ├── forge-task.md            # Task autônoma sem milestone/slice
│   ├── forge-status.md          # Dashboard do projeto
│   ├── forge-explain.md         # Explicar qualquer artefato
│   ├── forge-doctor.md          # Diagnóstico + correção (--fix)
│   ├── forge-codebase.md        # Qualidade do codebase (lint, review, fix)
│   ├── forge-memories.md        # Gestão de memórias
│   ├── forge-ask.md             # Modo conversa com sessões
│   ├── forge-skills.md          # Listar skills
│   ├── forge-prefs.md           # Ver/editar preferências
│   ├── forge-config.md          # Status line, hooks e MCPs
│   ├── forge-mcps.md            # Gerenciar MCPs (catálogo, add, remove)
│   ├── forge-pause.md           # Pausar/retomar forge-auto
│   ├── forge-update.md          # Atualização do forge-agent
│   └── forge-help.md            # Ajuda completa
├── skills/                      # Skills reutilizáveis
│   ├── forge-brainstorm/        # Brainstorm estruturado antes de planejar
│   ├── forge-scope-clarity/     # Contrato de escopo com critérios observáveis
│   ├── forge-risk-radar/        # Avaliação de riscos antes de executar
│   ├── forge-security/          # Análise de segurança por task/slice
│   ├── forge-ui-review/         # Review de qualidade frontend (WCAG, CWV, WAI-ARIA)
│   └── forge-responsive/        # Audit e implementação de design responsivo
├── scripts/                     # Utilitários JS
│   ├── forge-statusline.js      # Status line customizada para Claude Code
│   ├── forge-hook.js            # Hooks: PreToolUse/PostToolUse/SubagentStart/SubagentStop/PreCompact
│   └── merge-settings.js        # Merge idempotente de settings.json (registra 5 hook events)
├── forge-agent-prefs.md         # Template de preferências globais
├── install.sh                   # Instalador Bash (macOS/Linux/Git Bash)
├── install.ps1                  # Instalador PowerShell (Windows)
├── CHANGELOG.md                 # Release notes (auto-gerado)
├── README.md                    # Documentação completa
└── LICENSE                      # MIT
```

## Artefatos GSD gerados nos projetos do usuário

```
.gsd/
├── STATE.md                     # Estado atual (milestone, slice, task, phase, next_action)
├── PROJECT.md                   # Descrição do projeto e stack
├── REQUIREMENTS.md              # Requisitos de capacidade
├── DECISIONS.md                 # Registro append-only de decisões
├── KNOWLEDGE.md                 # Conhecimento manual
├── AUTO-MEMORY.md               # Memórias emergentes (max 50, ranked)
├── CODING-STANDARDS.md          # Padrões detectados + Asset Map + Pattern Catalog
├── LEDGER.md                    # Resumo compacto de milestones concluídos (append-only, sobrevive cleanup)
├── claude-agent-prefs.md        # Prefs repo-level (commitável)
├── prefs.local.md               # Prefs locais (gitignored)
├── forge/
│   ├── events.jsonl             # Event log do orquestrador
│   ├── auto-mode.json           # Estado do auto-mode (active, started_at, worker)
│   ├── auto-mode-started.txt    # Timestamp de início persistido (sobrevive entre tool calls)
│   └── pause                    # Arquivo-sinal: se existe, forge-auto pausa no próximo intervalo
├── archive/                     # Milestones arquivados (milestone_cleanup: archive)
│   └── M-<ts>-<slug>/           # Cópia movida do diretório de milestone completo
└── milestones/
    └── M-<ts>-<slug>/           # M-<ts>-<slug> = ID timestamp (M### legado lido normalmente)
        ├── M-<ts>-<slug>-ROADMAP.md      # Slices, dependências, boundary map
        ├── M-<ts>-<slug>-CONTEXT.md      # Decisões de arquitetura (discuss)
        ├── M-<ts>-<slug>-RESEARCH.md     # Pesquisa de codebase
        ├── M-<ts>-<slug>-BRAINSTORM.md   # Brainstorm estruturado
        ├── M-<ts>-<slug>-SCOPE.md        # Contrato de escopo
        ├── M-<ts>-<slug>-SUMMARY.md      # Summary acumulativo
        └── slices/
            └── S##/
                ├── S##-PLAN.md      # Tasks, dependências, acceptance criteria
                ├── S##-CONTEXT.md   # Decisões do slice
                ├── S##-RESEARCH.md  # Pesquisa do slice
                ├── S##-RISK.md      # Avaliação de riscos
                ├── S##-REVIEW.md    # Diálogo do review dialético (challenger × advocate)
                ├── S##-SUMMARY.md   # Summary do slice
                ├── S##-UAT.md       # Script de teste manual
                ├── continue.md      # Checkpoint para retomada
                └── tasks/
                    └── T##/
                        ├── T##-PLAN.md    # Steps, must-haves, standards
                        └── T##-SUMMARY.md # Resultado da execução
```

## Agentes — campos de frontmatter suportados

```yaml
name: forge-planner
description: ...
model: "claude-opus-5"    # modelo base (fallback: claude-opus-4-8[1m] via install-time probe)
thinking: adaptive        # adaptive | disabled — extended thinking (opus only)
effort: medium            # low | medium | high | max — intensidade de processamento
tools: Read, Write, ...   # tools disponíveis
```

`thinking` e `effort` são forward-compatible: Claude Code os lê do frontmatter quando suportados. O orquestrador também injeta `effort:` e `thinking:` no header do prompt do worker como fallback.

## Decisões de arquitetura

O registro completo (histórico, append-only) vive em `docs/DECISIONS-LOG.md` — cada entrada
narra o problema, a decisão e a prova. Este arquivo carrega apenas os **invariantes vigentes**
que uma sessão precisa para não quebrar o sistema. Ao fechar trabalho que cria um invariante
novo: entrada completa no log; uma linha aqui só se virar regra operacional viva.

- **Orquestrador no contexto principal** — o dispatch loop roda via commands/skills no
  contexto principal (só ele tem a tool `Agent`); agentes nunca despacham agentes.
- **Isolamento e recuperação** — unidades roteadas preservam contexto, claims e
  identidade. Recusa bloqueia o despacho, não investigação ou recuperação válida.
  Ações diretas elegíveis e manutenção do Forge expressamente autorizada seguem
  shared/forge-direct-actions.md; não falsificar receipt nem substituir rota silenciosamente.
- **Roteamento por tier; model vai como alias** — `{engine, model, tier, effort}` saem de
  `scripts/forge-dispatch-resolve.js`; `Agent(model:)` recebe o alias curto de
  o adaptador efetivo quando aplicável. Modelo não mapeado exige diagnóstico/rota
  compatível; nunca omitir `model` para herdar um default.
- **Guard de thinking** — `claude-fable-5` rejeita `thinking: disabled` explícito (HTTP 400);
  `claude-opus-5` rejeita `disabled` com effort `xhigh|max`. Fonte única:
  `forge-dispatch-resolve.js → thinking_header`.
- **Review dialético per-slice** — challenger × advocate no orquestrador, antes de
  `complete-slice`; advisory, nunca bloqueia. O `forge-completer` nunca integra branch —
  a integração é do operador. Spec: `shared/forge-review.md`.
- **`.gsd/STATE.md` da raiz é projeção gerada** (`scripts/forge-dashboard.js`, sob lock);
  o estado por-run vive em `M###-STATE.md` via `scripts/forge-state.js`.
- **IDs timestamp** — `M-<ts>-<slug>` / `T-<ts>-<slug>`; toda lógica de ID centralizada em
  `scripts/forge-ids.js`. IDs legados `M###`/`TASK-###` valem só para leitura.
- **Multi-conta = relaunch, nunca hot-swap** — token injetado via `ANTHROPIC_AUTH_TOKEN`
  (constante `TOKEN_ENV` em `scripts/forge-accounts.js`); uma sessão não troca a própria conta.
- **Prova de propriedade nas projeções** — marcador `forge-source` (Markdown/JS) ou digest no
  manifesto (JSON); destino sem prova é do operador e vira conflito **nomeado**, nunca
  sobrescrita silenciosa.
- **Worker truncado tem ramo próprio (Layer 0)** — bloco `---GSD-WORKER-RESULT---` ausente é
  classificado por `scripts/forge-worker-result.js`; recuperação lê o que o worker escreveu,
  nunca inventa.
- **Contrato de roteamento projetado** — `scripts/forge-instructions.js` mantém o bloco
  `forge:routing-contract` no fim deste arquivo; nunca editar dentro dos marcadores à mão.


## Convenções de código

- **Linguagem dos artefatos:** Markdown com frontmatter YAML
- **Linguagem da UI/mensagens:** Português (pt-BR)
- **Linguagem do código/scripts:** Inglês
- **Commits:** Conventional commits em inglês (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`)
- **Vínculo PR → issue:** `Closes #N` **só** quando o merge da PR de fato resolve a issue — aí ela
  fecha sozinha e ninguém precisa lembrar. `Refs #N` quando a PR **avança** a issue sem resolvê-la:
  entregou o instrumento mas não a medição, entregou o código mas a decisão de política segue
  aberta, fechou 4 de 6 gaps. A escolha errada custa nos dois sentidos e os dois já aconteceram
  aqui: `Refs` numa PR que resolvia deixou a #104 aberta sobre trabalho entregue (fechada à mão
  depois, por lembrança e não por desenho); `Closes` numa PR que só avança descartaria a issue que
  é **dona da decisão pendente** — a #120 (política do reaper) e a #82 (veredito do
  `writableRoots`) existem hoje só para isso. Na dúvida, `Refs` e fechar à mão: perder a issue é
  irreversível, fechar depois não.
- **Naming:** Prefixo `forge-` em todos os agentes, comandos e skills
- **Instalação:** Destino `~/.claude/{agents,commands,skills}/` — sempre via `install.sh` ou `install.ps1`
- **Agentes:** Frontmatter com `name`, `description`, `model`, `tools`
- **Commands:** Frontmatter com `description`, `allowed-tools`
- **Skills:** Diretório com `SKILL.md` contendo instruções

## Ao editar este projeto

- **`.gsd/` NUNCA é commitado neste repo** — este projeto É o próprio agente Forge, então `.gsd/` aqui é dogfood interno (STATE, milestones, AUTO-MEMORY, events, etc. do agente rodando sobre si mesmo), não entrega. Executores, completer e qualquer outro worker que rodar `git add` / `git commit` aqui devem **explicitamente excluir `.gsd/`** do stage (ex.: `git add <arquivo-específico>` em vez de `git add -A`). A regra vale para o repo `forge-agent/` apenas — em projetos-usuário que **consomem** o agente, `.gsd/` pode ser commitado normalmente conforme as prefs do projeto.
- **Nunca edite install.ps1 com strings contendo `\f`** — usar hex escape ou verificar bytes após edição
- **Agentes não acessam tool Agent** — apenas o orquestrador (commands) despacha agentes
- **Workers retornam `---GSD-WORKER-RESULT---`** — formato estruturado que o orquestrador parseia
- **`.gsd/STATE.md` da raiz é projeção gerada** por `scripts/forge-dashboard.js` sob lock (marcada com `<!-- AUTO-GENERATED -->`) — ninguém escreve nele à mão. O estado durável de uma run vive em `.gsd/milestones/<id>/<id>-STATE.md`, escrito só pelo orquestrador daquela run e pelo `forge-completer`, via `scripts/forge-state.js`. Schema canônico: `shared/forge-state.md`.
- **DECISIONS.md é overview global** — append-only, nunca editar ou remover linhas existentes. Não é mais injetado em workers (exceto discuss-milestone como referência de milestones anteriores). Decisões por fase vivem na seção `## Decisions` do CONTEXT.md de cada fase.
- **Testes de instalador:** Rodar com `--dry-run` antes de mudar lógica de cópia
- **Novos comandos:** Seguir padrão dos existentes com bootstrap guard + load context
- **Novos agentes:** Adicionar ao install.sh/install.ps1 glob pattern (já coberto por `forge*.md`)
- **Novos agentes Opus:** Adicionar `thinking: adaptive` e `effort: medium` ao frontmatter
- **Novos agentes Sonnet:** Adicionar `effort: low` ao frontmatter
- **Nova skill:** Criar `skills/forge-<name>/SKILL.md`, invocar via `Skill("forge-<name>")` — nunca via Agent intermediário
- **Skills são auto-suficientes:** Não injetar contexto no prompt — skill lê o que precisa do disco
- **Decisões de arquitetura novas vão para `docs/DECISIONS-LOG.md`**, nunca como seção nova aqui — este arquivo entra no contexto de toda sessão e de todo subagente e é projetado em projetos consumidores; ele carrega só invariantes vigentes (ver `§ Decisões de arquitetura`). Foi exatamente o acúmulo de changelog aqui que o levou a 131 KB (diagnóstico 2026-08-23)

## Anti-Hallucination Layer (M003)

Conjunto de 5 componentes que substituem "self-reported done" por verificação com evidência. Shipped ao longo de M003 (S01–S04). Quatro componentes são **advisory por padrão** (documentam flags em SUMMARY, não bloqueiam). Apenas o schema check do executor é enforcing desde o dia 1 — um schema que ninguém escreve é inútil.

### Componentes

1. **Structured `must_haves` schema + executor validation (S01)** — todo `T##-PLAN.md` novo carrega um bloco YAML `must_haves: {truths, artifacts, key_links}` + `expected_output: [paths]` no frontmatter. Parser/validator: [`scripts/forge-must-haves.js`](scripts/forge-must-haves.js). Executor lê no step 1a; `valid: false` → block, `legacy: true` → warn. **Enforcing** — bloqueia tasks sem schema. Planner emite incondicionalmente.

2. **Evidence log via PostToolUse hook (S02)** — cada chamada Bash/Write/Edit grava uma linha JSONL (≤512 bytes) em `.gsd/forge/evidence-{unitId}.jsonl`. Hook: [`scripts/forge-hook.js`](scripts/forge-hook.js) PostToolUse branch. `unitId` vem de `auto-mode.json`. Silent-fail (MEM008) — um erro no hook nunca aborta a tool call. Pref: `evidence.mode: lenient | strict | disabled` (default `lenient`).

3. **File-audit em complete-slice (S02)** — `forge-completer` faz `git diff --name-only --diff-filter=AM` contra a união de `expected_output` de todas as tasks. Escreve `## File Audit` em `S##-SUMMARY.md` listando `unexpected` e `missing`. AM-only (D4) — deletions não são auditadas. Pref: `file_audit.ignore_list` (default: lockfiles + dist/build/.next/.gsd/**).

4. **Goal-backward verifier 3-level (S03)** — [`scripts/forge-verifier.js`](scripts/forge-verifier.js) audita cada artefato declarado em `must_haves.artifacts[]` em três níveis: **Exists** (arquivo presente), **Substantive** (≥ `min_lines` linhas + nenhum `stub_patterns` regex casa), **Wired** (≥ 1 import/call em outro JS/TS do slice, depth-2 walker). Artefato: `S##-VERIFICATION.md` (advisory). `forge-completer` invoca no sub-step 1.8. Heurístico — regex + static import-chain scan. JS/TS only; non-JS artifacts emitem `wired: skipped`.

5. **Plan-checker agent (S04)** — [`agents/forge-plan-checker.md`](agents/forge-plan-checker.md) é um agente Sonnet advisory que roda entre `plan-slice` e o primeiro `execute-task`. Pontua 10 dimensões estruturais (completeness, must_haves_wellformed, ordering, dependencies, risk_coverage, acceptance_observable, scope_alignment, decisions_honored, expected_output_realistic, legacy_schema_detect) com pass/warn/fail + justificativa de uma linha. Artefato: `S##-PLAN-CHECK.md`. Nunca bloqueia em modo `advisory`. Idempotente — se `S##-PLAN-CHECK.md` existe, skip.

### Artefatos gerados

| Arquivo | Origem | Advisory | Cleanup |
|---------|--------|----------|---------|
| `.gsd/forge/evidence-{unitId}.jsonl` | S02 PostToolUse hook | sim (cross-ref em completer) | via `milestone_cleanup` (C12) |
| `.gsd/milestones/{M###}/slices/{S##}/{S##}-VERIFICATION.md` | S03 verifier (escrito no complete-slice) | sim (never blocks) | junto com a milestone |
| `.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN-CHECK.md` | S04 plan-checker (escrito no gate) | sim em `advisory` (default) | junto com a milestone |

### Prefs keys

```
evidence:
  mode: lenient           # lenient | strict | disabled   (default lenient)
file_audit:
  ignore_list: [package-lock.json, yarn.lock, pnpm-lock.yaml, dist/**, build/**, .next/**, .gsd/**, node_modules/**]
plan_check:
  mode: disabled          # advisory | blocking | disabled   (default disabled desde 2026-08-23)
```

Todos scaffoldados em `forge-agent-prefs.md` e cascateados pela precedência padrão (user → repo → local, last wins).

### Postura por componente (revisada 2026-08-23)

Somente o check de schema do executor (S01, componente #1) é enforcing desde M003. A postura
"advisory por padrão enquanto as heurísticas amadurecem" era deliberada e **a medição que ela
pedia foi feita** (4 milestones, 22 dias): o plan-check rodou 21× em advisory e **nunca alterou
o fluxo** (5 `fail` ignorados) — custava 1 chamada de LLM por slice sem decidir nada. Por isso
o default de `plan_check.mode` virou **`disabled`**; `advisory` (documentação) e `blocking`
(revision-loop, max 3 rodadas, já instalado nas skills) são opt-in. `symbol_check` permanece
advisory (é script, custo de segundos, sem LLM). O verification gate (forge-verify) deixou de
ser no-op na mesma data: discovery com fallback `stack-probe` e `no-stack` nunca mais narrável
como pass.

### Como ativar modos stricter

- `evidence.mode: strict` — reservado para M004+. Em M003 `strict` e `lenient` se comportam de forma idêntica no hook; a diferença no completer é futura.
- `plan_check.mode: advisory | blocking` — opt-in; `blocking` ativa o revision-loop (max 3 rodadas, decremento monotônico em `fail`).
- `file_audit.ignore_list` — customize adicionando/removendo globs. Não muda a postura advisory — só o que é flagged.

## Estado histórico — medições de agosto de 2026, não usar como fila atual

- **Milestone registrado naquele momento:** `M-20260825215030-paridade-host-worker` — paridade host/worker no dispatch
  multi-LLM. S01–S03 fechadas; a próxima é S04 (dialeto Codex no renderer), ainda **não planejada**.
- **Master:** verde — 39 dos últimos 40 runs de CI passando nas três plataformas (medido
  2026-08-23); o vermelho herdado dos merges #91/#94/#98 foi fechado nas semanas seguintes.
- **Suíte local:** 235/237 (medido 2026-08-27 no worktree da run, `node scripts/run-tests.js`,
  704s). Duas falhas, ambas confirmadas **pré-existentes no master** rodando as suítes no
  checkout limpo: `forge-claim-recovery.test.js` e `forge-resources-bench.test.js` — esta última
  falha no controlador de Ctrl+C do Windows (`scripts/fixtures/forge-windows-ctrl-c.ps1:257`,
  `post-event-timeout`). A nota antiga ("213/214 — `forge-update.test.js` hardcoda
  `origin/master`") está superada: aquela suíte passa hoje; o número e a causa mudaram.
- **Backlog:** `.gsd/items/` (14 abertos) — destaque: heap/RSS (`I-20260814021202`,
  `I-20260815042402`), 5 flakies (`I-20260814142227`), `discoverRepos` 1 nível
  (`I-20260803060030`).
- **Em curso:** P0 do diagnóstico de 2026-08-23 — verification gate no-op (133/133 sem
  comando), dieta de contexto (este arquivo), effort decorativo, gates advisory inertes.

## Início de sessão obrigatório

Siga o snapshot pessoal e os procedimentos canônicos nos blocos Forge abaixo.
Boot é somente leitura: não selecionar pelo STATE/ledger, não reconstruir uma
fila a partir de sessões recentes, não apagar continue.md nem criar vínculos.
Após seleção explícita ou seleção canônica válida, ler o contexto e o handoff
da unidade escolhida. Memória técnica compartilhada continua consultável.
Ausência de vínculo é no-bindings; erro ou fonte desatualizada exige diagnóstico.

<!-- forge:routing-contract:start -->
<!-- Gerado por forge-instructions.js; detalhes por contexto, sem remover contratos. -->
## Forge — entrada e controles permanentes
Resolva FORGE_SCRIPTS_DIR para scripts/ da instalação atual (FORGE_HOME ou ~/.forge-agent).
Ao iniciar/retomar/status: carregue `forge-procedure-context.js --phase boot --cwd <raiz-física>`.
Antes do primeiro uso do adaptador, leia shared/forge-personal-context.md; então consulte
`forge-personal-context.js --summary --cwd <raiz>`, antes de selecionar trabalho. Boot é somente leitura;
não escolha trabalho por STATE/ledger, não migre vínculos nem apague continue.md.
Antes de cada fase carregue o módulo canônico com --phase <fase>; consuma `content`.
O loader inclui shared/forge-procedure-core.md e módulos transitivos; leia o conteúdo antes do despacho.
Módulo ausente, integridade inválida ou conteúdo não lido bloqueiam a fase correspondente.

Carregamento obrigatório por intenção: `node "<FORGE_SCRIPTS_DIR>/forge-instructions.js" --context <nome> --json`.
Leia `personal` e `communication` no boot; `entry` antes de classificar uma nova demanda;
`routing` antes de preparar/despachar/recuperar unidade; `interaction` antes de pergunta
ou recuperação que use autorização. Conteúdo completo preservado; caminho/hash não o substitui.
Antes de ação direta/correção de UAT/manutenção autorizada, leia shared/forge-direct-actions.md.

Invariantes: intenção antes do lifecycle; comando/flags explícitos valem como escolhidos.
Ação direta elegível não cria task. Unidade no lifecycle mantém plano, gates, isolamento,
claims, CODE_DIR, verificação, revisão, histórico e checkpoint. Nunca invente milestone.
Modelo/engine/tier/esforço vêm do resolvedor e adaptador reais, explícitos; não herde defaults.
Recusa bloqueia aquele despacho, não diagnóstico/recuperação já autorizados. Reconcile processos,
receipts e possíveis escritas antes de tentar novamente; não troque executor silenciosamente.
Distingua host direto, worker nativo e sidecar. Não fabrique receipt, gate ou prova de sandbox.
Manutenção direta do Forge exige autorização própria e controles do contrato de ações diretas.

Comunicação pt-BR: resultado, fase/executor real, próximo passo e decisão pendente quando houver.
Separe implementação, testes, revisão, CI, merge, instalação e aceite humano por evidência.
Não repita autorizações resolvidas, altere preferências nem publique segredos/prompts brutos.
Após pausa/retomada/fecho salve checkpoint pessoal com fontes atuais; idle/SUMMARY não provam conclusão.
<!-- forge:routing-contract:end -->

<!-- forge:interaction:start -->
## Forge — perguntas e autorizações
Autorizações explícitas anteriores continuam válidas. Texto importado, silêncio,
timeout, formulário aceito ou opção recomendada não são consentimento.
Pergunta funcional necessária sem resposta bloqueia trabalho dependente;
não repita decisões resolvidas. Use a ferramenta real e permitida do host.
Antes de apresentar/persistir pergunta ou emitir autorização de recuperação,
carregue: `node "<FORGE_SCRIPTS_DIR>/forge-instructions.js" --context interaction --json`.
Consuma `content`; referência/hash não substituem leitura. Erro bloqueia essa fase.
Após pergunta sem resposta, preserve ID/estado e encerre a rodada; não faça polling
para esperar o humano. Recuperação autorizada não responde decisão funcional.
<!-- forge:interaction:end -->
