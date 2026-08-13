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

### Modelo de agentes (7 agentes + orquestrador)

| Agente | Modelo | Fase | Responsabilidade |
|--------|--------|------|------------------|
| **Orquestrador** | (contexto principal) | — | Dispatch loop: lê STATE, deriva próxima unidade, monta prompt, despacha, processa resultado |
| `forge-planner` | Opus | plan-milestone, plan-slice | Decompõe trabalho em slices/tasks, escreve ROADMAP e PLANs |
| `forge-discusser` | Opus | discuss-milestone, discuss-slice | Identifica ambiguidades, faz perguntas ao usuário, registra decisões |
| `forge-researcher` | Opus | research-milestone, research-slice | Explora codebase, documenta padrões existentes, atualiza CODING-STANDARDS |
| `forge-executor` | Sonnet | execute-task | Implementa código, verifica must-haves, commita, escreve SUMMARY |
| `forge-completer` | Sonnet | complete-slice, complete-milestone | Escreve summaries, UAT scripts, squash-merge, fecha artefatos |
| `forge-memory` | Haiku | pós-unidade | Extrai conhecimento durável do trabalho completado (quality gate: project-specific + non-obvious + durable) |
| `forge-reviewer` | Sonnet | review gate (challenger) | Reviewer adversarial — acha bugs/brechas no diff do slice; em rebuttal mode reage à defesa do advocate. Read-only, advisory |
| `forge-advocate` | Sonnet | review gate (defender) | Autor que defende o código contra as objeções do reviewer — refuta, concede ou marca `open`. Read-only, advisory |
| `forge-plan-checker` | Sonnet | gate plan-slice→execute | Pontua 10 dimensões estruturais do plano (advisory) |
| `forge-worker` | Vários | (template legado) | Template genérico — não usado diretamente |

### Dispatch loop (forge-auto / forge-next)

O orquestrador NÃO é um agente — roda no contexto principal. Ciclo:
1. Lê STATE.md → deriva `unit_type` + `unit_id` da tabela de dispatch
2. **Risk radar gate:** se `unit_type == plan-slice` e slice é `risk:high`, invoca `Skill("forge-risk-radar")` no contexto principal antes de despachar o planner
3. Monta prompt com artefatos `.gsd/` inlined (não resumidos) + `effort` + `thinking` resolvidos de PREFS
4. Despacha via `Agent(subagent_type, prompt)` com modelo configurável
5. Processa `---GSD-WORKER-RESULT---` (done/partial/blocked)
6. Housekeeping: atualiza STATE, appende decisões, extrai memórias
7. Repete (auto) ou para (next)

### Context isolation por unidade

Cada unidade de trabalho roda em agente fresh — zero acúmulo de tokens entre unidades. O orquestrador injeta APENAS os artefatos necessários no prompt do worker. Isso permite milestones com dezenas de tasks sem estourar contexto.

### Sistema de memória emergente

Após cada unidade, `forge-memory` (Haiku) lê o resultado e extrai padrões duráveis:
- Categories: gotcha, convention, architecture, pattern, environment, preference
- Quality gate: 3 perguntas (project-specific? non-obvious? durable?) — todas YES para salvar
- Confidence scoring com decay (memórias não-acessadas perdem confiança)
- Cap de 50 entradas ativas em `.gsd/AUTO-MEMORY.md`
- Memórias são injetadas em cada unidade subsequente

### Configuração multi-camada

Resolução (último sobrescreve):
1. `~/.claude/forge-agent-prefs.md` — user-global
2. `.gsd/claude-agent-prefs.md` — repo shared (commitável)
3. `.gsd/prefs.local.md` — local personal (gitignored)

Configurável: modelos por fase, skip rules (discuss/research), git strategy, auto_push, isolation mode, **effort por fase** (`low|medium|high|max`), **thinking por fase** (`adaptive|disabled`).

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

## Decisões de arquitetura recentes

### Orquestrador no contexto principal (não como agente)
O dispatch loop roda no contexto principal do Claude Code (via commands), não como um agente separado. Isso permite que o orquestrador acesse a tool `Agent` para despachar workers. Decisão tomada após bug onde agente orquestrador não podia spawnar sub-agentes.

### Context isolation obrigatória
Cada unidade roda em agente fresh com contexto isolado. O orquestrador monta o prompt com artefatos inlined. Isso evita acúmulo de tokens e permite milestones grandes.

### Compaction Resilience — forge-auto continua após auto-compact
`forge-auto` é projetado para rodar até a milestone terminar sem intervenção. Quando o Claude Code auto-compacta o contexto (ao atingir ~100-128k tokens), o estado in-memory do orquestrador (`PREFS`, `session_units`, etc.) some. O **Compaction Resilience Protocol** detecta variáveis indefinidas, relê todos os arquivos de estado do disco (`.gsd/STATE.md`, prefs, AUTO-MEMORY) e reinicializa o loop — sem parar, sem avisar o usuário. O sinal persistente é `auto-mode.json` com `active: true`: enquanto esse arquivo existir com active true, o loop nunca deve parar por compactação. `compact_after` nas prefs é opcional e só faz sentido para quem quer checkpoints manuais explícitos.

### Autonomy rule no forge-auto
Adicionada regra explícita AUTONOMY RULE — CRITICAL no forge-auto para impedir que Claude pause entre unidades para pedir confirmação. O comportamento natural do Claude é "check in" após trabalho significativo — a diretiva forte é necessária.

### Memory quality gate (3 perguntas)
Memórias só são salvas se passam em 3 critérios: project-specific, non-obvious, durable. Evita poluição com best practices genéricas ou fixes one-off.

### Ambiguity scoring no discuss
forge-discusser usa scoring por dimensão (scope, acceptance, tech, dependencies, risk) com threshold de 70 pontos. Garante que perguntas importantes sejam feitas antes de planejar.

### Failure taxonomy com auto-recovery
Blockers são classificados por tipo (context_overflow, scope_exceeded, model_refusal, tooling_failure, external_dependency) com estratégia de recovery automática por classe. context_overflow retenta com modelo maior; model_refusal retenta com modelo diferente.

### Rename gsd-* → forge-*
Projeto renomeado de gsd-agent para forge-agent. Agentes renomeados de gsd-* para forge-*. Instaladores precisam limpar arquivos gsd-* legados (bug corrigido em da6453d).

### Install.ps1 usa caminhos com backslash
PowerShell precisa de `\` literal nos paths. Quando arquivo é gerado por Claude, `\f` é interpretado como form feed (0x0C). Corrigido em da6453d — qualquer edição futura no install.ps1 deve verificar que `\f` não vira form feed.

### Coding standards auto-detectados
`/forge-init` detecta lint, format, test configs e escreve `.gsd/CODING-STANDARDS.md`. O researcher enriquece com Asset Map e Pattern Catalog. Executors recebem seções relevantes injetadas no prompt.

### Multi-layer config (3 níveis)
Prefs resolvidas em cascata: user-global → repo shared → local gitignored. Permite configurar modelos por projeto sem afetar outros projetos.

### Event log append-only
Cada dispatch grava uma linha em `.gsd/forge/events.jsonl`. Usado para debugging pós-hoc e como sinal para memória emergente.

### forge-ask é modo conversa — nunca implementa
`/forge-ask` é estritamente read-only para arquivos de projeto. Regras absolutas injetadas no topo do comando:
- Não modifica, cria ou corrige source files — nem uma linha
- Se detectar bug/melhoria: menciona na conversa, não corrige
- Se usuário pedir implementação: redireciona para `/forge-next` ou `/forge-auto`
- Único `Write` permitido: `.gsd/sessions/*.md` e `.gsd/DECISIONS.md` via "salvar decisão"
- Brainstorm disponível via `"brainstorm: X"` — invoca `Skill("forge-brainstorm")`, produz artefato de planejamento, não código
- Auto-sugere brainstorm quando usuário descreve ideia nova sem BRAINSTORM.md existente

### AskUserQuestion no forge-discusser
O discusser usa `AskUserQuestion` (diálogo estruturado com botões) em vez de perguntas brutas em texto. Cada dimensão abaixo do threshold de clareza (< 70) gera uma pergunta com 2–4 opções contextuais geradas pelo Opus. Usuário sempre pode digitar via "Other".

### EnterPlanMode / ExitPlanMode na fase discuss
O forge-discusser chama `EnterPlanMode` no início: fica em modo read-only durante toda a fase de perguntas. Só escreve o CONTEXT.md (o "plano"). Ao terminar, `ExitPlanMode` apresenta o CONTEXT para aprovação antes de planning começar.

### effort + thinking configuráveis por fase
Agentes Opus têm `thinking: adaptive` e `effort: medium` no frontmatter. Agentes Sonnet têm `effort: low`. Configurável via `forge-agent-prefs.md` (seções `effort:` e `thinking:`). O orquestrador lê `EFFORT_MAP` e `THINKING_OPUS` de PREFS e injeta no header do prompt de cada worker.

### WebSearch/WebFetch no forge-researcher
O researcher agora faz 3–5 buscas web após a exploração local: pitfalls conhecidos de dependências, breaking changes em versões pinadas, best practices. Registrado em `## Sources` do RESEARCH.md com nível de confiança.

### Skill composition via Skill tool
Skills são chamadas com `Skill(name, args)` diretamente no contexto do orquestrador. Antes eram delegadas a um subagente (forge-planner) que procurava o SKILL.md no disco — frágil e com cold-start. Regra: skills são auto-suficientes, só passar IDs como args.

### Risk radar automático antes de plan-slice high-risk
O orquestrador checa `risk:high` no ROADMAP antes de despachar `plan-slice`. Se `S##-RISK.md` não existe, invoca `Skill("forge-risk-radar")` no contexto principal. O RISK.md produzido é injetado no prompt do forge-planner.

### Hooks expandidos (SubagentStart/Stop + PreCompact)
`forge-hook.js` agora trata 5 eventos: `PreToolUse`, `PostToolUse` (dispatch tracking), `SubagentStart`/`SubagentStop` (timing real dos workers), `PreCompact` (backup de STATE.md antes de compressão de contexto). `merge-settings.js` registra todos os 5 automaticamente ao ativar a status line.

### TaskList cleanup de tasks órfãs
Ao iniciar `/forge-auto` ou `/forge-next`, o orquestrador chama `TaskList` e marca como `completed` qualquer task em `in_progress` de sessões anteriores interrompidas (Ctrl+C, terminal fechado).

### AskUserQuestion no forge-new-milestone (fase discuss inline)
O Step 4 do `/forge-new-milestone` usa `AskUserQuestion` sequencial em vez de "ask ALL questions at once". Uma pergunta por vez, com 2-4 opções concretas derivadas do contexto. O mesmo vale para os worker prompts de `discuss-milestone` e `discuss-slice` nos templates do orquestrador.

### Security gate automático antes de execute-task
O orquestrador varre `T##-PLAN.md` por keywords de segurança (auth, token, crypto, password, secret, jwt, oauth, etc.) antes de despachar `forge-executor`. Se detectado e `T##-SECURITY.md` não existe → invoca `Skill("forge-security")` no contexto principal. O checklist produzido é injetado no prompt do executor como `## Security Checklist` — tratado como must-have igual ao T##-PLAN.md.

### forge-security skill
Nova skill em `skills/forge-security/SKILL.md`. Analisa o plano de uma task/slice, mapeia domínios de segurança ativos (auth, authz, crypto, input validation, secrets, injection, XSS, transport) e produz checklist focado e stack-específico. Não gera advice genérico — cada item é rastreável a algo no plano. Risk level HIGH se auth/authz/crypto envolvidos.

### Decisões distribuídas por fase — DECISIONS.md como overview
Workers não recebem mais DECISIONS.md. Cada fase injeta decisões do seu próprio escopo:
- `execute-task` → seção `## Decisions` do S##-CONTEXT.md ("Slice Decisions")
- `plan-slice` → M###-CONTEXT.md completo ("Milestone Context") + S##-CONTEXT.md completo ("Slice Context")
- `plan-milestone` → M###-CONTEXT.md completo via "Context (discuss decisions)" — sem DECISIONS.md
- `discuss-slice` → seção `## Decisions` do M###-CONTEXT.md (milestone-level, locked)
- `discuss-milestone` → last 30 rows de DECISIONS.md (decisões de milestones anteriores, sem CONTEXT.md ainda)
DECISIONS.md continua sendo populado (discusser step 5 + orchestrator key_decisions housekeeping) e lido por `/forge-explain decisions` como overview global auditável.

### forge-completer security scan
O `forge-completer` executa um security scan nos arquivos modificados antes de fechar um slice (step 3, antes do lint gate). Detecta padrões suspeitos (eval, innerHTML, SQL concatenado, secrets em logs) e registra em `## ⚠ Security Flags` no S##-SUMMARY.md. É documentação — não bloqueia o complete.

### forge-memory auto-promotion para CLAUDE.md
Após cada extração, `forge-memory` verifica candidatos com `confidence >= 0.85` AND `hits >= 3`. Padrões que passam nesse threshold são promovidos automaticamente para a seção `## Forge Auto-Rules` do `CLAUDE.md` do projeto. Não promove: preference/environment, one-off bug fixes, duplicatas. Fecha o loop capture → promote do sistema de memória emergente.

### forge-researcher Security Considerations
O researcher inclui seção `## Security Considerations` no RESEARCH.md quando o escopo envolve auth, crypto, dados, APIs externas, input do usuário, ou secrets. Omite a seção inteiramente se nenhum desses domínios estiver em escopo.

### auto-mode started_at persistido em arquivo
Shell state não persiste entre chamadas do `Bash` tool — cada chamada inicia uma nova shell. `$FORGE_STARTED_AT` era vazio nas heartbeats subsequentes à ativação, gerando JSON inválido no `auto-mode.json` (`{"active":true,"started_at":,...}`). A statusline falhava no `JSON.parse` e o indicador AUTO desaparecia na transição entre slices. Fix: timestamp gravado em `.gsd/forge/auto-mode-started.txt` na ativação; heartbeats lêem com `cat` (sem dependência de variável de shell).

### forge-auto: proibido executar inline quando Agent() falha
Quando `Agent()` lança exceção (API 500, timeout, tool indisponível), o Claude não tinha instrução explícita e "improvisava" executando o trabalho inline no contexto principal — quebrando o context isolation. Agora há regra CRITICAL: ao falhar o dispatch, desativar auto-mode, parar o loop, e surfacar o erro ao usuário. Executar inline nunca é fallback aceitável.

### forge-auto ignora argumentos (resume é automático)
`/forge-auto` não aceita argumentos. O auto-resume é automático via detecção de `auto-mode.json` (`active: true` + dentro de 60 min). Argumentos como `resume` eram lidos como texto livre, podendo causar comportamento inesperado. Agora há instrução explícita de ignorar silenciosamente qualquer argumento.

### forge-statusline: versão remota no indicador de update
Em vez de `↑ novos commits`, a statusline mostra a versão exata disponível no remoto (ex: `↑ v0.23.0`). Usa duas chamadas `git ls-remote` separadas: HEAD check primeiro, depois `--tags` somente se houver update. Duas chamadas separadas (em vez de uma com padrão entre aspas) evita o bug do Windows onde `cmd.exe` trata aspas simples como literais, fazendo git não encontrar nenhuma tag.

### forge-statusline: cache invalidado após push automático
Após squash-merge + push (quando `auto_push: true`), o cache de 10 minutos do update check ficava com `has_update: false`, impedindo que a statusline refletisse o novo estado imediatamente. O `forge-completer` agora deleta `{tmpdir}/forge-update-check.json` após o push. O `/forge-update` também invalida o cache após reinstalar.

### LEDGER.md — contexto compacto que sobrevive ao cleanup
Após um milestone fechar, os arquivos de milestone/slice/task são arqueologia: o valor real já foi extraído para `AUTO-MEMORY.md`, `DECISIONS.md` e `CODING-STANDARDS.md`. O `forge-completer` (complete-milestone) grava uma entrada compacta (≤15 linhas) em `.gsd/LEDGER.md` antes de qualquer cleanup. Essa entrada resume o que foi construído, slices, key files e key decisions — contexto suficiente para subagentes futuros consultarem sem carregar arqueologia. O LEDGER é append-only e nunca é deletado/arquivado independente da configuração de `milestone_cleanup`.

### milestone_cleanup — arqueologia descartável após milestone concluído
Controlado por `milestone_cleanup: keep|archive|delete` nas prefs. Padrão `keep` (comportamento anterior). `archive` move `.gsd/milestones/M###/` para `.gsd/archive/M###/`. `delete` remove inteiramente. O cleanup acontece no step 6 do `complete-milestone`, depois que o LEDGER.md foi gravado. Arquivos duráveis (`AUTO-MEMORY.md`, `DECISIONS.md`, `CODING-STANDARDS.md`, `STATE.md`, `LEDGER.md`) nunca são tocados.

### MCP management integrado ao Forge
Adicionado gerenciamento de MCPs (Model Context Protocol) com catálogo centralizado em `forge-mcps.md` (shared reference instalado em `~/.claude/`). Sete servidores catalogados: fetch, context7, postgres, redis, github, puppeteer, sqlite + bundle `security` (semgrep, snyk, trivy). MCPs com credenciais (postgres, redis) usam shell wrappers que lêem `.env` em runtime — zero secrets no `settings.json`. `/forge-mcps` é o comando principal; `/forge-config mcps` é alias. `/forge-init` auto-detecta stack e sugere MCPs relevantes.

### PostCompact hook + compact-signal.json recovery
O hook `PostCompact` (não `PreCompact`) escreve `compact-signal.json` em `.gsd/forge/` sempre que o forge-auto está ativo no momento da compactação. No início de cada iteração do loop, o orquestrador verifica a existência desse arquivo: se presente, relê todos os artefatos de estado do disco (`STATE.md`, prefs, `AUTO-MEMORY.md`), reinicializa as variáveis de sessão e deleta o sinal — continuando sem interromper o milestone. Isso fecha o gap que havia no `PreCompact` hook: o hook `Pre` roda antes da compactação ocorrer e não sabe se o contexto será de fato compactado; o `Post` roda após e tem certeza. Implementado em `scripts/forge-hook.js` e detectado em `commands/forge-auto.md`.

### Pesquisa livre na web — combate ao viés de memória interna
Débito técnico identificado: os agentes Forge dependiam quase exclusivamente de `AUTO-MEMORY.md` e conhecimento interno, raramente fazendo buscas web. Resultado: alucinação de APIs, patterns desatualizados, retrabalho em verificação. Correção: `forge-executor` e `forge-discusser` ganharam `WebSearch`/`WebFetch` no frontmatter; todos os agentes (executor, discusser, planner, researcher) têm agora um bloco explícito "pesquise livremente quando incerto" com budget por unidade (3 para executor, 4 para discusser, 5 para planner/researcher). O discusser deve pesquisar fatos externos antes de perguntar ao usuário. Inspirado nas extensões `search-the-web` e `google-search` do gsd-2.

### Brave Search MCP adicionado ao catálogo (opt-in)
`brave-search` adicionado a `shared/forge-mcps.md` como MCP global **opt-in** (não auto-instalado). Requer `BRAVE_API_KEY`. Wrapper shell lê a chave de `.env` em runtime. Útil para search determinístico/estruturado, mas **não é necessário**: o `WebSearch` nativo do Claude Code usa o tool server-side da Anthropic (igual ao gsd-2 native-search.js), sem chave do usuário. Investigação no gsd-2 confirmou: ele só usa Brave/Tavily quando `PREFER_BRAVE_SEARCH=1` ou provider não-Anthropic; caso contrário injeta `web_search` nativo. Logo Brave é ganho marginal (snippets ranqueados, cap previsível 2000q/mês), não requisito.

### Tier 1 MCPs auto-instalados (fetch + context7)
`install.sh` e `install.ps1` auto-instalam `fetch` e `context7` em `~/.claude/settings.json` no final do fluxo — zero credenciais, zero perguntas. Idempotente: checa `--mcp-list` antes. Respeita opt-out: se usuário remover manualmente, arquivo `~/.claude/forge-mcps-skipped.txt` previne re-add em upgrades futuros. MCPs com credenciais (`brave-search`, `github`, `postgres`, etc.) continuam opt-in via `/forge-mcps add <name>` ou sugeridos pelo `/forge-init` baseado na stack detectada.

### Lean orchestrator (workers leem próprios artefatos)
Workers recebem caminhos de arquivo no prompt em vez de conteúdo inlado. Cada worker usa a tool `Read` em seu contexto isolado para carregar apenas o que precisa. O resultado é redução de ~10-50K tokens por unidade para ~500 tokens no prompt do worker — crescimento de contexto do orquestrador cai para zero entre unidades. Exceções mantidas inladas: `TOP_MEMORIES` (pequeno, pré-processado) e `CS_LINT` (poucas linhas, necessário para lint imediato). A dispatch table centralizada em `shared/forge-dispatch.md` é compartilhada entre `forge-auto` e `forge-next`, evitando duplicação. Caminhos passados a workers devem ser absolutos ou relativos ao `WORKING_DIR`; arquivos opcionais usam a diretiva "Read if exists".

### /forge REPL shell como entry point unificado
`/forge.md` é um thin router com budget máximo de 5K tokens (< 300 linhas). Cabe dentro do budget de re-attachment do Claude Code após compactação, garantindo que o loop não seja interrompido mesmo após auto-compact. O REPL mantém um `AskUserQuestion` loop que detecta `compact-signal.json` no início de cada iteração, reinicializa o estado e despacha skills. O `/forge` substitui `/forge-auto` como entry point principal para milestones; `/forge-auto` permanece como alias para compatibilidade retroativa.

### Migração de comandos para skills com shims de compatibilidade
`forge-auto`, `forge-task` e `forge-new-milestone` foram movidos de `commands/` para `skills/` com `disable-model-invocation: true` — flag que evita o bug #26251 onde o Claude invoca o modelo ao carregar a skill como contexto. Os arquivos em `commands/` tornaram-se shims de uma linha que encaminham `$ARGUMENTS` para a skill correspondente via `Skill()`. Migração gradual: apenas esses três comandos de alto uso foram migrados em v1.0; os demais `forge-*` commands permanecem em `commands/` e serão migrados em versões futuras baseado em feedback.

### Compact-safe token budget para /forge e skills
O budget de `/forge.md` é mantido abaixo de 5K tokens para garantir que caiba no budget de re-attachment do Claude Code após compactação (que reserva espaço para `CLAUDE.md` + arquivos de comando ativos + overhead). Skills invocadas via `Skill()` tool rodam em contexto isolado — não consomem budget do `/forge.md`. O pós-compactação acomoda: `CLAUDE.md` (~15K tokens) + `/forge.md` (< 5K) + overhead de re-attachment (~2K) = ~22K tokens, bem dentro do limite mínimo de contexto do Claude Code.

### Tier-only model routing (M002 S04)
Modelo agora resolvido por tier (`light`/`standard`/`heavy`/`max`) via `PREFS.tier_models`, não por fase. A tabela canônica `unit_type → tier → default_model` vive em `shared/forge-tiers.md`; o algoritmo de 5 passos com exemplos está em `shared/forge-dispatch.md § Tier Resolution`. Override precedence (maior ganha): `tier:` frontmatter explícito > `tag: docs` (força light) > risk escalation (`plan-slice` em slice `risk:high` → `max`) > unit_type default. Operador re-roteia um tier inteiro editando `tier_models.<tier>` em `forge-agent-prefs.md § Tier Settings` — zero mudanças de código. O evento `dispatch` em `events.jsonl` é estendido additivamente com os campos `tier` e `reason` (compatível com leitores S03 que ignoram campos desconhecidos).

### Tier `max` — Fable 5 como escalação seletiva (não default)
Com a chegada do Claude Fable 5 (`claude-fable-5`, $10/$50 por MTok — exatamente 2x o Opus 4.8), o roteamento ganhou um quarto tier `max` usado apenas onde raciocínio de fronteira tem maior alavancagem por dólar: (1) **`plan-milestone`** — default `max` (1 unidade por milestone; custo incremental ~$0,25–0,75 vs opus, desprezível perto do ganho de um ROADMAP melhor); (2) **`plan-slice` em slice `risk:high`** — auto-escalação `heavy → max` usando a mesma checagem de ROADMAP do risk radar gate (reason `risk-escalation:high`); (3) **recovery de `context_overflow`** — a escada de retry agora sobe `standard → heavy → max`; se já era `max`, para e surfaceia ao usuário; (4) **`tier: max`** explícito no frontmatter de `T##-PLAN.md`. Os tiers `light`/`standard`/`heavy` permanecem Haiku/Sonnet/Opus — executor, reviewer, advocate, completer e memory não mudam. **Guard obrigatório:** `claude-fable-5` retorna HTTP 400 em `thinking: {type: "disabled"}` explícito (Opus 4.7/4.8 aceitam); sempre que o modelo resolvido for Fable 5, o orquestrador injeta `thinking: adaptive` no header do worker (ou omite a linha), ignorando o pref `thinking: disabled` da fase.

### Installer re-merge de hooks em upgrades
Instaladores (`install.sh`, `install.ps1`) copiavam `merge-settings.js` atualizado para `~/.claude/forge-settings.js` mas nunca o re-executavam. Usuários que ativaram a statusline antes da v0.7.0 ficavam com `settings.json` sem os hooks `SubagentStart/Stop` e `PreCompact/PostCompact` — o `last_heartbeat` em `auto-mode.json` só era bumpado pelo Bash do orquestrador (antes/depois do dispatch), então workers longos tripavam o stale check da statusline (15 min) e o indicador `AUTO` sumia durante a execução. Fix: após copiar `forge-settings.js`, ambos instaladores detectam via `node` se `statusLine.command` do `~/.claude/settings.json` contém `forge-statusline.js`; se sim, re-executam o `forge-settings.js` no próprio `settings.json`. `merge-settings.js` já é idempotente — só adiciona hooks faltando, preserva todas as outras chaves. Garante que `/forge-update` sempre sincronize hooks mesmo quando o usuário nunca toggla a statusline.

### IDs timestamp para milestones e tasks soltas (M001)
Milestones e tasks soltas (`/forge-task`) usam IDs no formato `M-<YYYYMMDDHHMMSS>-<slug>` e `T-<YYYYMMDDHHMMSS>-<slug>` respectivamente (ex.: `M-20260522101500-pagamentos`). O timestamp UTC de 14 dígitos é a chave primária — única, ordenável por criação, sem colisão entre branches paralelos. O slug é cosmético (lowercase, hífens, ≤24 chars) e ignorado nas comparações. Slices `S##` e tasks internas `T##` permanecem sequenciais — são entidades de dono único dentro de um milestone, sem risco de colisão. Toda lógica de ID está centralizada em `scripts/forge-ids.js` (13 exports: `nowTimestamp`, `slugify`, `makeMilestoneId`, `makeTaskId`, `nextSequentialMilestoneId`, `nextSequentialTaskId`, `classify`, `isValid`, `prefixGlob`, `entityKind`, `readIdFormat`, `resolveMilestoneId`, `resolveTaskId`) — zero regex de ID espalhado no codebase. A CLI do módulo aceita `--new-milestone`, `--new-task`, `--classify`, `--slugify`, `--format`, `--cwd`. **Formato de geração é configurável** via pref `ids.format: timestamp | sequential` (default `timestamp`; ver `forge-agent-prefs.md § ID Settings`): `sequential` reativa o formato legado `M00N`/`TASK-00N` (max+1 varrendo `.gsd/milestones/`+`.gsd/archive/` e `.gsd/tasks/`) para quem prefere IDs curtos — com a ressalva documentada de que reintroduz o risco de colisão entre branches paralelos. Resolução: flag `--format` > pref (cascata, último ganha) > default. Leitura aceita ambos os formatos sempre, detectados por prefixo. **Retrocompat:** IDs legados `M###` e `TASK-###` continuam válidos para leitura, `--resume` e `/forge-explain`. Motivação: eliminar a colisão de `M006`/`M006` entre devs em branches paralelos — problema que o esquema sequencial não pode resolver sem coordenação central.

### Review dialético — dois agentes se confrontam, humano arbitra
Inspirado no copilot-review do GitHub, mas reformulado como **debate**: em vez de um agente despejando flags num SUMMARY que ninguém lê, dois agentes independentes se confrontam sobre o código e o humano só decide onde eles genuinamente discordam. **Challenger** = `forge-reviewer` (acha bugs/brechas, formula cada achado como objeção + pergunta). **Defender** = `forge-advocate` (assume ser o autor; refuta, concede ou marca `open` cada objeção). Uma rodada de réplica bounded (`review.rounds`, default 1) deixa o reviewer manter ou retirar cada objeção vendo a defesa. Resolução: `conceded`→**fix imediato** (dispatch `review-fix` ao `forge-executor`, só os itens concedidos, no branch do slice ainda não-mergeado — `review.fix_conceded`, default true; sem re-review do fix para evitar ping-pong), `refuted+withdrawn`/`open+withdrawn`→sem ação, `*+maintained`/`refuted+maintained`→**aberta** (sobe ao humano).

**Boundary: per-slice.** O gate roda no orquestrador (skills `forge-auto`/`forge-next`) **antes de despachar `complete-slice`**, com o branch `gsd/{M###}/{S##}` ainda não-mergeado (diff intacto). **Por que no orquestrador e não no `forge-completer`:** o completer tem `tools: Read, Write, Edit, Bash` — sem `Agent` nem `AskUserQuestion`. Não consegue despachar reviewer/advocate nem perguntar ao humano. (O `Agent("forge-reviewer")` que existia no step 4b do completer era código morto — removido; o completer agora só faz o pattern-scan determinístico e linka o `S##-REVIEW.md`.)

**Postura Ask + autonomia:** em `/forge-next` (interativo) cada objeção `aberta` vira `AskUserQuestion` ao vivo (`manter` / `refatorar` / `follow-up`). Em `/forge-auto` respeita `review.ask_in_auto`: `defer` (default) **não pausa no meio do loop** — marca abertas como `deferido → triagem no fim da milestone` e segue, honrando a AUTONOMY RULE; `pause` (opt-in) pergunta por slice mesmo no modo autônomo. **Defer não engole:** todo item deferido sobe ao operador na **triagem final da milestone** (`shared/forge-review.md § Step 9`) — gate que roda antes de despachar `complete-milestone` (antes do close-out/LEDGER/cleanup), apresenta digest + `AskUserQuestion` por item, despacha um `review-fix/{M###}-triage` para os `refatorar agora` e grava follow-ups em `.gsd/KNOWLEDGE.md § Review follow-ups`. É a **exceção sancionada à AUTONOMY RULE** (todas as slices já terminaram nesse ponto). O Final Report do forge-auto inclui o digest do review. O gate **nunca bloqueia** o `complete-slice` nem o `complete-milestone`; qualquer throw de `Agent()` é registrado e o loop prossegue.

Prefs em `review:` (`mode|style|rounds|ask_in_auto|fix_conceded`). `style: flags` reproduz o comportamento advisory legado (só challenger, sem debate). Spec autoritativa: `shared/forge-review.md` (boundary-agnostic — dois consumidores). Artefato: `S##-REVIEW.md` (o diálogo inteiro — objeção → defesa → réplica → resolução → correção/decisão — auditável; durável com a milestone, limpo por `milestone_cleanup`).

**Dois boundaries:** (1) per-slice — gate antes de `complete-slice` no branch não-mergeado, em `forge-auto`/`forge-next`. (2) **task solta** — `/forge-task` step 5.5 roda o mesmo confronto no diff da task (`git diff {START_SHA}..HEAD`), artefato `{TASK_ID}-REVIEW.md`, sempre `MODE = interactive` (o forge-task já é interativo). Ambos respeitam `review.style`; `flags` = single-pass legado em qualquer um dos dois.

### forge_isolation wired na ativação (antes era código órfão)
`scripts/forge-isolation.js` existia desde M004 mas **nenhum skill o invocava** — `forge_isolation.mode` nas prefs era ignorado e tudo rodava `shared` (a var `ISOLATION_MODE` no bootstrap do forge-auto nunca era atribuída). Agora: (1) **setup** roda na ativação de `forge-auto` (status `activate-new`/`resume`/`legacy` — nunca em `refuse`/`error`), no `## Isolation setup` do `forge-next` e antes do registro no `forge-task` — idempotente, e o mode resolvido é passado a `forge-runs.js --add --isolation-mode`; (2) workers recebem **isolation header** no prompt (`ISOLATION`/`BRANCH`/`CODE_DIR` — convenção em `shared/forge-dispatch.md § Isolation Header Convention`): código vive em `CODE_DIR` (worktree), artefatos `.gsd/**` ficam sempre no workspace original (registry/statusline dependem disso); (3) **cleanup** roda só no complete da milestone/task — pause/blocked preservam branch/worktree para resume; `branch` volta à default mantendo `forge/{id}` para PR, `worktree` só remove com `worktree_cleanup_on_complete: true` E working tree limpo — `cleanupWorktreeOne` faz dirty-check (`git status --porcelain`) antes do `--force`; worktree suja → `skipped (dirty)`, trabalho não commitado nunca é descartado (guard nascido do incidente de 2026-06-10). Se o setup falhar em TODOS os repos com mode != shared → STOP (rodar sem isolamento quando o operador configurou isolamento não é fallback aceitável). Fix acoplado: o regex de `readIsolationPrefs` usava `\Z` (inexistente em JS — vira `Z` literal), então um bloco `forge_isolation:` no fim do arquivo de prefs era silenciosamente ignorado; agora captura linhas indentadas. Regression guard na seção 9 do `forge-smoke.js`.

### forge-isolation ramifica de origin/<def> fresco, não da main local stale
Bug reportado por usuário (2026-06-17): um worktree `forge/M099` nasceu 13 commits atrás do remoto. Causa = pegadinha clássica do git: **ramificar nunca fala com o servidor** — `git worktree add ... <def>` / `git checkout -b` partem do ref **local**, e a `main` local estava parada num commit antigo porque ninguém rodara `git pull` nela. O `setupWorktreeOne` tinha dois furos somados: (a) o `git pull --ff-only` rodava no **checkout principal** (que estava noutra branch) com `catch {}` engolindo o erro — não atualizava `main`; (b) o worktree então nascia da `main` local stale, nem do `origin/main`. **Fix durável na fonte** (inverter a ordem — fetch antes, ramificar de origin depois): novo helper `fetchDefaultBranch(repoPath, def)` roda `git fetch origin <def>` (atualiza o cache remote-tracking sem tocar working tree, independe de qual branch o checkout está) + `git rev-parse --verify origin/<def>`, e retorna `{ ref: 'origin/<def>', fetched: true }`. `setupWorktreeOne` passa a ramificar de `origin/<def>` (campo `base` no resultado para auditoria); `setupBranchOne` faz `git checkout <def>` + `git merge --ff-only origin/<def>`. Fallback gracioso para o ref local quando não há remote `origin` (`gitHasOriginRemote`). Gateado por `auto_pull_main` (default `true`). Regression guard na seção 9 do `forge-smoke.js`: bare origin → clone → avança origin de um 2º checkout (a main local do clone fica stale) → setup com `auto_pull_main:true` deve produzir worktree com `base === 'origin/main'` contendo o commit que a main local não tinha.

### Multi-conta Claude — registro + troca via setup-token, statusline mostra a conta + uso
Suporte a múltiplas contas Claude para contornar o esgotamento de sessão (janela 5h / limite semanal). **Restrição arquitetural dura:** uma sessão do Claude Code **não troca a própria conta no meio** (`/login` mid-session fica preso em 401 — issues #15007/#33811/#60503). Trocar de conta = **relançar** o processo `claude`; o forge preserva estado em disco (`auto-mode.json`, `continue.md`, `STATE.md`), então o `/forge-auto` retoma do ponto exato ao relançar (restart de processo, não hot-swap). **Mecanismo (macOS-safe):** cada conta = um token longo do `claude setup-token` (`sk-ant-oat01-…`, ~1 ano), selecionado no launch via `CLAUDE_CODE_OAUTH_TOKEN` (precedência maior que o login do Keychain). Escolhido em vez de `CLAUDE_CONFIG_DIR` porque no macOS o item do Keychain é compartilhado (serviço fixo `Claude Code-credentials`) → perfis por config-dir não isolam credencial de forma confiável. **Engine:** `scripts/forge-accounts.js` — registro não-secreto em `~/.claude/forge-accounts.json` (nomes/metadados/ativo), tokens no **Keychain** (`forge-account-<nome>`, via `security`) com fallback `~/.claude/forge-accounts-tokens.json` chmod 0600 em Linux/Windows. CLI: `--add/--list/--current/--use/--launch-cmd/--token/--remove [--json]`. O token nunca entra no registro JSON; `--token <nome>` imprime o segredo em stdout de propósito (para `$( )` no comando de relançamento). **UX:** skill `/forge-accounts` (auto-suficiente) **+ wrapper de CLI** `bin/forge-accounts` instalado em `~/.local/bin` pelo `install.sh` (traduz subcomandos → flags: `forge-accounts add trabalho` → `node …/forge-accounts.js --add trabalho`). `forge-accounts add <nome>` é **um comando só**: roda o `claude setup-token`, captura o token da saída (stdout) automaticamente — `runSetupTokenSync` faz `spawnSync` com stdin+stderr herdados (login/browser funcionam) e stdout capturado, regex `sk-ant-oat01-…`, token nunca impresso. Precisa de TTY real → roda no **terminal do usuário**, nunca in-session (sem TTY + evita leak no transcript). `launchCommand` detecta o wrapper no PATH (`which forge-accounts`) e emite a forma curta `CLAUDE_CODE_OAUTH_TOKEN="$(forge-accounts token <nome>)"`, caindo pra forma `node <path>` se ausente (ex.: Windows, onde o wrapper bash não instala). **`use` é troca real, não impressão:** num TTY, `forge-accounts use <nome>` marca a conta como ativa e **lança o `claude`** com `FORGE_ACCOUNT`/`CLAUDE_CODE_OAUTH_TOKEN` setados (token via env, nunca em argv) — um comando, sem copiar/colar. Sem TTY (in-session/`!`/pipe) ou com `--print`, cai pra imprimir o comando de relançamento (não dá pra iniciar sessão de contexto não-interativo). Há também `rename <velho> <novo>` que move o token de slot no Keychain sem refazer `setup-token`. O handoff do `/forge-auto` apresenta `forge-accounts use {NEXT}` em vez da linha longa. **`use` abre nova janela quando faz sentido:** uma sessão rodando não troca a si mesma, então `use` chamado sem TTY (skill/chat) no macOS abre uma **nova janela do Terminal** via `osascript` já na conta — resumindo `/forge-auto` num projeto forge (`openNewTerminal`: launcher temp que busca o token ao vivo, nunca o grava em disco/AppleScript; auto-deleta; `exec claude`). `--new-window` força isso num TTY; `--print` só imprime. Fora do macOS sem TTY → `--print`. Pede permissão de Automação do macOS na 1ª vez. Override de teste: `FORGE_NEW_WINDOW_DRYRUN=1`. **Statusline:** mostra `👤 <nome>` quando a sessão foi lançada com `FORGE_ACCOUNT=<nome>`, ao lado do uso 5h/semana; e grava um bridge `forge-ratelimit-<session>.json` no tmpdir (o `/forge-auto` não lê o JSON da statusline) para o handoff por esgotamento (ver entrada seguinte, PR-B).

### Handoff de conta por esgotamento no /forge-auto
Fecha o loop da multi-conta: o `/forge-auto` reage ao esgotamento de janela trocando de conta sem perder trabalho. **Onde:** Step 7 (fronteira de unidade), **antes** do pause check (esgotamento é mais urgente que um pause enfileirado). **Detecção:** lê o bridge mais recente `forge-ratelimit-*.json` no tmpdir (≤120s = a sessão atual; a statusline do orquestrador renderiza continuamente durante o loop) e pega a janela mais apertada (5h **ou** semanal). Se `used >= accounts.handoff_threshold` (default 90) e `accounts.handoff_in_auto != off`, dispara o `## Account Handoff Procedure`. **Procedimento:** (1) checkpoint via `continue.md` (Continue-Here Protocol) + linha `status:handoff` em events.jsonl; (2) resolve a próxima conta via `forge-accounts --list --json` (candidata = `has_token` E `name != conta-atual`, preferindo mais `days_left`) e pega o comando exato com `--launch-cmd`; (3) desativa só este run (mesma mecânica do pause → para o loop, mas estado recuperável); (4) imprime instruções de relançamento (`CLAUDE_CODE_OAUTH_TOKEN=… claude` + `/forge-auto {RUN_ID}` que retoma sozinho); (5) push. **Sem alternativa registrada:** ainda faz checkpoint+pausa e instrui a registrar uma — nunca trava no 429. **Exceção sancionada à AUTONOMY RULE** (limite externo duro, não decisão de produto). **Gatilho secundário:** 429/quota-exhaustion no `Agent()` (não-transitório, depois do Retry Handler) roteia pro mesmo procedimento. **Nunca é hot-swap** — sempre relaunch; o resume por disco torna a troca transparente. Prefs em `accounts:` (`handoff_in_auto`, `handoff_threshold`) em `forge-agent-prefs.md § Accounts Settings`.

### forge-run — supervisor zero-touch de execução multi-conta
Fecha o ciclo da multi-conta: execução autônoma que **rotaciona contas sozinha** ao esgotar, sem o usuário abrir terminal ou digitar. **Por quê um supervisor externo:** uma sessão que esgota não consegue se reabrir (processo morto não relança a si mesmo) — só um processo fora do `claude` consegue lançar a próxima sessão na conta nova. `bin/forge-run` (instalado em `~/.local/bin`) é esse loop: (1) escolhe a conta mais descansada via `forge-accounts --next-account` (elegível = com token e fora de cooldown; cooldown rastreado em `.gsd/forge/account-cooldowns.json`); (2) roda `claude -p "/forge-auto" --dangerously-skip-permissions` (headless) com `FORGE_ACCOUNT`+`CLAUDE_CODE_OAUTH_TOKEN` setados (token via env, nunca argv); (3) ao sair, decide: **handoff** → marca cooldown + troca de conta + continua; **sem handoff** → para (milestone completa/bloqueio/erro). **Detecção de esgotamento — defesa dupla** (crítico: em headless a statusline NÃO renderiza, então o bridge de `rate_limits` não existe e o check proativo de 90% fica inerte ali): (a) `.gsd/forge/handoff-request.json` que o `/forge-auto` grava ao bater o limite e sair (Step 1b do Account Handoff Procedure); (b) fallback — o supervisor varre a saída do `claude` por `usage limit|rate limit|quota|429|529`. Quando o `resets_at` real é desconhecido, usa cooldown default de 5h, pra não repescolher a conta recém-esgotada (senão loop infinito). Se TODAS as contas estão em cooldown, dorme até o reset mais próximo e retoma. Teto anti-runaway: `--max` (default 200 sessões). Helpers no engine: `--next-account [--cooldowns F]` e `--mark-cooldown <acct> [--resets-at <epoch>] --cooldowns F`. Override `FORGE_ENGINE`/`FORGE_ACCOUNTS_REGISTRY` para dev/teste. **Limitação documentada:** em headless, gates que pedem input (raro: triagem final do milestone via AskUserQuestion) não conseguem perguntar — `review.ask_in_auto: defer` (default) evita asks no meio do loop; a triagem final fica deferida.

### forge-accounts shell-init — `claude` puro entra na conta ativa automaticamente
Lacuna identificada: a seleção de conta só acontece **no launch do processo** (uma sessão não troca a própria conta — ver entradas anteriores), então digitar `claude` puro caía no login padrão do Keychain, ignorando a conta marcada como ativa no registro. O usuário precisava sempre passar por `forge-accounts use` (que relança). Correção no padrão `direnv`/`nvm`/`zoxide`: o engine expõe `forge-accounts shell-init` (`--shell-init`) que **emite** uma função de shell `claude()` (zsh/bash); o instalador adiciona `eval "$(forge-accounts shell-init)"` ao rc do usuário (idempotente via marcador `forge-accounts shell-init`, detecta `$SHELL` → `~/.zshrc`|`~/.bashrc`|`~/.profile`). A função resolve conta+token numa **única** chamada `forge-accounts launch-prep [name]` (imprime `"<name> <token>"`, default quando sem arg) e injeta `FORGE_ACCOUNT`+`CLAUDE_CODE_OAUTH_TOKEN` **apenas naquela invocação** (token nunca vaza pro env do shell). **Guards** mantêm a função inerte quando não deve agir: `CLAUDE_CODE_OAUTH_TOKEN` já setado **sem** `--account` (respeita `forge-accounts use`/`forge-run`), `FORGE_NO_AUTO_ACCOUNT=1` (escape hatch por launch), ou `forge-accounts` ausente do PATH (cai no `claude` puro sem erro). A função chama o wrapper `forge-accounts` (no PATH), nunca caminhos `node` hardcoded — portável e sobrevive a `/forge-update`. **Por que não um alias ou edição manual do rc:** edição manual não é versionada, não passa pelo instalador e some em reinstalação/troca de máquina; o `shell-init` torna isso feature de primeira classe, mantida pelo `install.sh`/`install.ps1`.

### Multi-conta redesenhado — default vs launch, display por identidade, resume run-aware, cross-platform
Quatro problemas estruturais do multi-conta (que cresceu por acreção) foram corrigidos juntos:

**(1) `default` vs `launch` — terminais simultâneos em contas diferentes.** Antes `use` misturava "definir default global" + "lançar", então um 2º terminal noutra conta sobrescrevia o default. Agora separado: `forge-accounts default <nome>` seta o default persistente **sem lançar**; `use <nome>` = default+launch (compat); **`launch <nome>`** lança/abre numa conta **sem** tocar no default; e o shell-init aceita **`claude --account <nome>`** (extraído de `"$@"`, removido dos args repassados) para fixar UM terminal numa conta. Resultado: N terminais em N contas ao mesmo tempo, default global intacto. `launchOrEmit()` é o decisor compartilhado (print/new-window/in-place); `spawnClaudeOnAccount()` o spawn in-place.

**(2) Display por identidade real.** A statusline só mostrava `👤` com `FORGE_ACCOUNT` setado (launch manual = sem badge), e o Claude Code **não passa a conta logada** no JSON da statusline. Agora, sem `FORGE_ACCOUNT`, `accountBadge()` lê `~/.claude.json` (`oauthAccount.accountUuid`/`emailAddress`) e casa contra o registro (`matchAccount`, uuid > email) → `👤 <nome>`; sem match → `👤 <displayName|email> ⚠`. Leitura do arquivo de 110KB é **cacheada por (mtime claude.json, mtime registry)** — render normal faz só 2 `stat()`. Identidade é gravada por conta (`email`/`account_uuid`/`email_source`) via **`forge-accounts set-email <nome>`** (sem `--email` → captura a sessão atual; o usuário afirma estar naquela conta = seguro). **Captura automática por-render foi removida**: uma sessão lançada por token pode não reescrever `~/.claude.json`, então auto-capturar gravaria a identidade errada (provado em teste — `recordIdentity` tem guard anti-clobber, mas o caso de registry virgem ficava exposto). Captura é sempre explícita.

**(3) Resume run-aware (só reinicia auto se havia auto).** `openNewTerminal` forçava `claude "/forge-auto"` sempre que existia `.gsd/`. Agora `forgeAutoArgsFor(cwd)` consulta o registry de runs (`forge-runs.listActive`): **0 ativos → `claude` puro** (sessão normal); **1 ativo → `claude "/forge-auto <RUN_ID>"`** (retoma o run exato); **2+ → `claude` puro** (ambíguo, usuário escolhe). Vale para new-window **e** spawn in-place. `forge-runs` ganhou campo `account` por run (additivo) — passado pelo orquestrador via `--account "${FORGE_ACCOUNT:-}"`.

**(4) Cross-platform.** `openNewTerminal` despacha por `process.platform`: **darwin** osascript (Terminal/iTerm), **linux** `gnome-terminal`/`x-terminal-emulator`/`konsole`/`xterm` (primeiro no PATH via `firstOnPath`), **win32** `.cmd` temporário aberto por `wt.exe new-tab` (fallback `start`) — token buscado live no launcher, nunca em argv; auto-deleta. Shell-init no Windows: `--shell-init-pwsh` emite uma função PowerShell pro `$PROFILE` (mesmos guards + `--account`, remove o token no `finally`); `install.ps1` instala `bin/forge-accounts.cmd` (pass-through trivial — o **normalizador de subcomando no engine**, `normalizeSubcommandArgv`, aceita `forge-accounts <sub> <name>` sem tradução em batch) num dir do PATH e adiciona o hook `Invoke-Expression (& forge-accounts shell-init-pwsh | Out-String)` ao `$PROFILE` (idempotente). **Regra do `\f`:** o bloco novo no `install.ps1` usa `Join-Path` em todo path que envolve `forge*` para nunca emitir um literal `\f`. Regression guards na Section 16 do `forge-smoke.js`.

### Injeção de token via `ANTHROPIC_AUTH_TOKEN` (corrige `CLAUDE_CODE_OAUTH_TOKEN` ignorado)
**Correção de premissa.** As entradas anteriores de multi-conta afirmam que o token do `claude setup-token` é selecionado no launch via `CLAUDE_CODE_OAUTH_TOKEN`, "com precedência maior que o login do Keychain". **Isso está errado no Claude Code ≥2.1.x** e foi a causa de um `401 Invalid credentials → Please run /login` reportado em 2026-06-15. Verificação empírica (`claude -p`, sem nenhuma credencial de precedência maior configurada — zero `ANTHROPIC_*`, zero `apiKeyHelper`):

- `CLAUDE_CODE_OAUTH_TOKEN` **inválido** + login do Keychain válido → autentica via Keychain (token ignorado). O token só passa a valer quando **não há** login de Keychain (`/logout`).
- Como o item do Keychain no macOS é **compartilhado** (`Claude Code-credentials`, serviço fixo), toda sessão rodava na conta logada — o switch por conta era **ilusório**. Quando esse login (expiry ~24h) ficava stale → `401 → /login`, e o token válido nunca era usado como fallback.

**Fix:** todos os caminhos de launch passam a injetar o token via **`ANTHROPIC_AUTH_TOKEN`** (auth-precedence **item 2**, acima do Keychain **item 6** *e* acima do `CLAUDE_CODE_OAUTH_TOKEN` item 5). Verificado: `ANTHROPIC_AUTH_TOKEN` inválido + Keychain válido → **401** (o token é consultado primeiro); token válido + Keychain presente → sucesso, **sem precisar deslogar**. O setup-token `sk-ant-oat01-…` é um Bearer token aceito como `ANTHROPIC_AUTH_TOKEN`. Vantagens sobre a alternativa "logout → token-only": (a) não exige `/logout`, (b) não quebra se o usuário rodar `/login`, (c) launches que bypassam a função Forge (extensão de IDE, ícone do app, Spotlight) **caem no Keychain ainda autenticados** em vez de hard-fail. Constante única `TOKEN_ENV` em `scripts/forge-accounts.js` controla o nome da env var em todos os emissores (`launchCommand`, `openNewTerminal` darwin/linux/win, `shellInit`, `shellInitPwsh`, `spawnClaudeOnAccount`) + `bin/forge-run`. O guard da função shell agora respeita `ANTHROPIC_AUTH_TOKEN` pré-setado (cobre `use`/`forge-run` e um gateway próprio do usuário). Regression guard na Section 16 do `forge-smoke.js` (todo launch path injeta `ANTHROPIC_AUTH_TOKEN`, nunca `CLAUDE_CODE_OAUTH_TOKEN`). **Ressalvas a validar em sessão interativa real:** (1) billing — o `oat01` é token de assinatura, então o uso deve continuar na assinatura, mas confirme que não vira cobrança API avulsa; (2) a statusline de uso 5h/semanal (que alimenta o handoff-por-esgotamento do `/forge-auto`) pode não vir sob `ANTHROPIC_AUTH_TOKEN` — afeta só essa feature, não o switch. **Reportar à Anthropic via `/feedback`:** os docs dizem que `CLAUDE_CODE_OAUTH_TOKEN` (item 5) deveria vencer o Keychain (item 6), mas empiricamente não vence.

### forge-sweep model-invocable ao fim de ciclo (removido disable-model-invocation)
O `forge-sweep` (criado em v1.16.0 com `disable-model-invocation: true` por ser destrutivo) obrigava o usuário a digitar `/forge-sweep --apply` explicitamente — mesmo depois do trabalho já validado e do orquestrador ter anunciado o sweep como próxima etapa. Atrito sem ganho: o gate de validação humana já aconteceu na conversa. Mudança (v1.36.0): removido o flag → a skill é **model-invocable**. Nova seção `## Invocation policy` no `SKILL.md` codifica a regra: o orquestrador só invoca o sweep **ao fim de um milestone/task, após o humano validar o trabalho entregue** (sem frase mágica — o feedback positivo na conversa é o go-ahead); nunca mid-task, em planning ou especulativamente. Fluxo recomendado: invocar **direto com `--apply`** (Step 3 sempre imprime o preview antes de qualquer escrita), e o popup `AskUserQuestion` do Step 5 vira o **único** gate final (um sim/não, lembrete pro dev distraído) — a etapa de "redigite com `--apply`" é eliminada no fluxo de fim de ciclo. **Fallback risk-aware:** NÃO auto-aplicar (cai pra dry-run + autorização explícita) quando o preview expõe risco específico — entry de AUTO-MEMORY flagged `review`, dir de milestone/task pulado por falta de entry no `LEDGER.md`, fase ativa no `STATE.md`, ou working tree sujo. A destrutividade agora é guardada pelo gate conversacional + popup in-skill + fallback, não por bloquear a invocação do modelo. Escopo cirúrgico: só o `forge-sweep` — os outros skills com `disable-model-invocation` (`forge-auto`, `forge-task`, `forge-new-milestone`) são entry points e permanecem como estão.

### Effort dinâmico por complexidade da task (eixo independente do tier)
Antes o `effort` era **estático por fase**: vinha do frontmatter do agente (`forge-executor: low`, agentes Opus: `medium`) com override por `unit_type` em `PREFS.effort`. O `tier`/modelo já era dinâmico (`complexity:`/`tier:` no frontmatter, risk escalation), mas o effort não acompanhava — uma task complexa ganhava modelo melhor sem mais raciocínio. Agora o `effort` é resolvido dinamicamente num passo **Effort Resolution (step 1.55)** que espelha o Tier Resolution e roda logo depois dele (precisa do `$MODEL_ID` para o clamp). É um **eixo dedicado e independente**: `tier:` escolhe *qual modelo*, `effort:` escolhe *o quão fundo ele pensa*. O `forge-planner` julga a complexidade e emite `effort: low|medium|high|xhigh|max` (escala ordenada) no frontmatter de cada `T##-PLAN.md`, ao lado de `tier:`. **Algoritmo (4 passos, precedência):** (1) default por fase de `PREFS.effort`; (2) override de frontmatter `effort:` (execute-task) — `frontmatter-effort:<val>`; (3) risk escalation sync — `plan-slice` em slice `risk:high` (tier já escalado a `max`) sobe effort a `max`; (4) **clamp por capacidade do modelo** — `haiku`/`sonnet` (light/standard) limitam em `medium`, `opus`/`fable` (heavy/max) liberam a escala toda. **Consequência do clamp:** para uma task *rodar* em `high`+, ela precisa estar num tier `heavy`/`max` — setar `effort: xhigh` numa task `standard` (sonnet) é rebaixado a `medium` silenciosamente (registrado como `|clamped:model-cap`). O clamp previne HTTP 400 (Sonnet não aceita `high`+) e config desperdiçada. O evento `dispatch` em `events.jsonl` ganhou os campos `effort` e `effort_reason` (additivo — readers S03 ignoram). Spec canônica: `shared/forge-dispatch.md § Effort Resolution`; guidance do planner: `agents/forge-planner.md § Effort & Tier Hints`; prefs: `forge-agent-prefs.md § Effort Settings`. Regression guard na Section 17 do `forge-smoke.js` (22 asserts: blocos presentes, clamp comportamental, naive resolver removido).

### Indicador de uso 5h/semanal recuperado sob `ANTHROPIC_AUTH_TOKEN` (poll dos headers `unified-*`)
Quando a sessão é lançada com `ANTHROPIC_AUTH_TOKEN` (caminho multi-conta), o Claude Code autentica pelo token e **não popula o campo `rate_limits` da statusline** — as barras ⏱/📅 somem e o handoff proativo por esgotamento fica cego (observação empírica nossa; nenhuma fonte da comunidade documenta — vale `/feedback`). O dado, porém, é alcançável: uma chamada `POST /v1/messages max_tokens:1` com o token `oat01` (via `Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20`) retorna os headers `anthropic-ratelimit-unified-{5h,7d}-{utilization,reset,status}` (janelas da assinatura, account-wide). Verificado: o endpoint dedicado `GET /api/oauth/usage` (custo zero) **não** serve ao setup-token — exige scope `user:profile` que o `oat01` inference-only não tem (403) — então o scrape de header via `/v1/messages` (~9 tokens) é o único método viável pro nosso tipo de token. **Componentes:** (1) `scripts/forge-usage-poll.js` — exporta `fetchUsage(token)`, lê os headers, grava o bridge `forge-ratelimit-<session>.json` (mesmo formato que o orquestrador já consome); self-throttle com **cadência adaptativa** keyed na última utilização (<50% → 15min, 50–70% → 5min, ≥70% → 2min). (2) `forge-statusline.js` — quando `d.rate_limits` falta, **lê** o bridge (≤15min) como fallback; **gate de display em 70%** (só mostra quando 5h OU 7d ≥70%); e **dispara o poll** (detached, throttle ~100s por mtime) a cada render — a statusline é o gatilho confiável em sessão interativa. (3) `forge-hook.js` — dispara o poll no `PostToolUse` (matcher `Agent`), cobrindo o headless do `forge-auto` onde a statusline não renderiza. **Atribuição por-sessão é impossível** (confirmado: `/usage`, headers e endpoint são todos account-wide; feature request fechada como *not planned*) — por isso o bridge é account-wide. **Eficiência testada:** `GET /v1/models` e requests malformados (400) **não** carregam os headers `unified-*`; só inferência bem-sucedida — não há método custo-zero pro setup-token. Regression guard na Section 18 do `forge-smoke.js`.

### Dashboard multi-conta + handoff por folga real (`forge-usage.js`, `--by-usage`)
Pra "usar todas as contas" sem desperdício, faltava ver a folga de cada uma. (1) `scripts/forge-usage.js` — pega o token de cada conta registrada (via `forge-accounts --token`) e imprime a tabela 5h/7d ordenada por folga semanal, marcando a recomendada; `--json` pro consumo por máquina. ~9 tokens por conta polada, on-demand. (2) `forge-accounts.js` ganhou `nextAccountByUsage()` async + flag `--next-account --by-usage` — entre as contas elegíveis (fora de cooldown), escolhe a de **menor utilização 7d real** (polada via `fetchUsage`), com fallback total pro `nextAccount()` (cooldown/most-rested) em qualquer falha (módulo ausente, polls falham, ≤1 elegível) — nunca regride. O `bin/forge-run` passou a usar `--by-usage`, tornando o handoff mwtelles→conta-mais-folgada automático. O comentário do `nextAccount` já antecipava isso ("Headroom can't be queried live outside a session... so we approximate") — agora com `fetchUsage` a folga é consultável de verdade.

### Plan gate interativo — conduct de lapidação no orquestrador (M002)
O handshake interativo de aprovação de planos vive no **orquestrador/skill** (Approach A, LOCKED) — estendendo o plan-check gate existente que já roda no contexto principal na boundary `plan-slice → first execute-task`. O `forge-planner` continua **decompositor batch puro**: sem `EnterPlanMode`/`ExitPlanMode`, sem mode-branching interno. Preserva o invariante "worker stateless, orquestrador conduz o humano". **Mecânica:** preview do plano (arquivo em disco) → cada `warn`/`fail` do `forge-plan-checker` vira `AskUserQuestion` acionável (manter / corrigir-no-ato / deferir) → usuário pode editar o `*-PLAN.md` diretamente em disco (modelo "edição livre"); orquestrador relê + re-valida via `scripts/forge-must-haves.js` (erro de schema = mais um finding; **no-op em planos legacy do forge-task**) → handshake de aprovação único ao final. **Contrato compartilhado:** `shared/forge-plan-gate.md` (boundary-agnóstico, dois consumidores: `forge-task` Step 4 e `forge-next` plan-check gate), espelhando `shared/forge-review.md`. **Pref:**
```yaml
plan_gate:
  interactive: always   # always | auto | off   (default: always)
  ask_in_auto: defer    # defer | off
```
Separada de `plan_check:` (que controla o scoring advisory). `interactive: auto` = conduz só com `warn`/`fail`; `off` = batch atual mesmo em interativo. **Degradação:** `forge-auto` **nunca** conduz o handshake — degrada para batch advisory, independente de `plan_gate.interactive`. `ask_in_auto: defer` é o guard explícito (AUTONOMY RULE intocada). Regression guard no `forge-smoke.js` (S04).

### Fix real $MODEL_ID/tier_models via mapa ID→alias (M004 S02)
A entrada "Tier-only model routing (M002 S04)" acima descrevia uma promessa que nunca foi cumprida em runtime: o `$MODEL_ID` resolvido pela Tier Resolution era um ID completo (ex.: `claude-opus-4-8[1m]`), mas o dispatch chamava `Agent()` **sem o param `model:`** — a tool só aceita os quatro aliases curtos (`haiku|sonnet|opus|fable`), nunca um ID completo, então passar o ID direto teria quebrado a chamada. Resultado prático: editar `tier_models.<tier>` nas prefs não mudava nada — cada worker sempre rodava no `model:` default do próprio frontmatter do agente, silenciosamente. Fix (M004 S02): `scripts/forge-model-alias.js` — mapa canônico único, `modelToAlias(id)` — traduz o ID resolvido para o alias correspondente via substring match em ordem `fable → haiku → sonnet → opus` (o sufixo `[1m]` não precisa de tratamento especial, o substring ainda casa a base do nome). Os skills do loop (`forge-auto`, `forge-next`) agora chamam `Agent(model: <alias>)` com o alias traduzido, nunca o ID cru. **Degradação documentada:** quando `tier_models.<tier>` aponta para um ID que o mapa não reconhece, `modelToAlias` retorna `{ alias: null, mapped: false }`; o orquestrador **omite** o param `model:` (cai para o default do frontmatter do agente invocado) e registra um warning — nunca repassa o ID não mapeado para `Agent()`. O mesmo mapa é reusado por S04 (override do advocate). Fonte canônica única — `shared/forge-tiers.md` e `shared/forge-dispatch.md` apenas descrevem e referenciam o helper, sem reimplementar a tabela em markdown. Com esse fix, a frase "Operador re-roteia um tier inteiro editando `tier_models.<tier>` ... zero mudanças de código" (entrada acima) passa a ser factual — o alias resolvido é o que efetivamente chega ao `Agent()`.

### Challenger Gemini via Antigravity CLI (`agy`) — segundo engine do adapter xllm
O review dialético ganhou um terceiro challenger: `review.challenger: gemini` roteia challenge + rebuttal pelo mesmo `scripts/forge-xllm.js`, agora com `--engine codex|agy` (default `codex` — zero mudança para quem já usa). O engine `agy` invoca `agy --print` headless com quirks empiricamente verificados (agy 1.0.16, 2026-07-15): (1) **stdin DEVE ser `ignore`** — com stdin em pipe aberto não-TTY o agy trava para sempre (foi a causa de dois hangs nos probes); (2) **prompt via arquivo temp** — `-p` só aceita o valor inline no argv e o CreateProcess do Windows capa a command line em ~32K chars (um diff de slice não cabe); como o print mode do agy roda o agente completo (com tools de leitura), o adapter grava o prompt inteiro num tmpfile e passa só uma instrução curta "Read the file at <path>..." no argv; (3) **`--sandbox`** sempre (print mode é agêntico, diferente do `codex exec` inference-only); (4) sem `-o`/`--output-schema` — a resposta é raspada do stdout (que pode conter narração de steps antes do JSON final; `extractLastJsonBlock` já cobre) e um **stdout vazio com exit 0** (issue conhecida de non-TTY upstream) vira throw → exit 2 → fallback pro `forge-reviewer` Claude com evento `review-challenger-fallback`/`gemini-exit-nonzero`; (5) `--print-timeout <t>s` do próprio agy dispara primeiro; o spawnSync mata com +5s de grace. **Auth:** keyring silencioso do login Antigravity (refresh automático) ou `GEMINI_API_KEY`/`ANTIGRAVITY_API_KEY` — o adapter nunca recebe credencial. **Modelos por label com espaços** (`agy models`, ex.: `"Gemini 3.1 Pro (High)"`): o reader de `challenger_model` no Step 0 do `shared/forge-review.md` passou de `(\S+)` para captura até fim-de-linha com strip de aspas e de comentário `#` (de quebra corrigiu o bug latente em que o `challenger_model:` vazio com comentário inline do template capturava `#` como modelo), e os Steps 2/4 expandem `--model "$CHALLENGER_MODEL"` sempre quotado. Precedência `engine: workflow` generalizada: qualquer `challenger != claude` força `engine: agents`. Mock cross-platform para smoke: `FORGE_XLLM_AGY_BIN` (um `.js` é lançado com o Node atual) — diferente do mock codex (shell POSIX), os cenários agy passam também no Windows.

### Baseline Opus 5 (tier heavy) — drop-in no preço do 4.8, guard de thinking estendido
Com o lançamento do Claude Opus 5 (`claude-opus-5`, $5/$25 por MTok — mesmo preço do Opus 4.8, Fable 5 segue exatamente 2x), o tier `heavy` e os agentes Opus (planner, discusser, researcher) migraram de `claude-opus-4-8[1m]` para `claude-opus-5`. **Sem sufixo `[1m]`:** no Opus 5 o contexto de 1M é o default e o máximo do modelo — o ID cru já entrega 1M. O probe dos instaladores agora testa `claude-opus-5` e, em conta sem acesso, faz downgrade dos frontmatters para `claude-opus-4-8[1m]` (baseline anterior). **Guard de thinking estendido (fonte única em `scripts/forge-dispatch-resolve.js` → `thinking_header`):** além do guard do Fable (`thinking: disabled` explícito → HTTP 400 em qualquer effort), o Opus 5 tem thinking ligado por default e só aceita `disabled` com effort `high` ou menor — `disabled` + `xhigh`/`max` retorna HTTP 400. O resolver emite `thinking_header: adaptive` quando o modelo é `claude-fable-5` (sempre) ou `claude-opus-5` com effort resolvido `xhigh`/`max`; com effort ≤ `high` o pref da fase é honrado. O clamp de effort não muda: `claude-opus*` continua liberando a escala completa (`low`→`max`), e o Opus 5 suporta os cinco níveis. Escalação de `context_overflow` (`standard → heavy → max`) agora sobe para Opus 5 antes do Fable. Tests: 2 casos novos em `forge-dispatch-resolve.test.js` (xhigh força adaptive; high honra o pref).

### Rota inerte deixa de depender de narração (TASK-021)
Uma slice inteira podia cair do sidecar para Claude sem que nada além de **uma linha de log** registrasse — caso medido: `lookchina` M127/S03, quatro tasks roteadas para `gpt-5.6-terra` rodaram **4/4 em Claude** por `sidecar-code-dir-undeclared`. O harness tinha imprimido o `hint` com o conserto exato (`repo: freyr`) e a narração da sessão o substituiu por "bug de tooling da frota". **A lição não é que faltava um check — é que o check certo rodou e a narração passou por cima.** Por isso a correção põe a verdade num artefato que o modelo não redige: `scripts/forge-route-audit.js` deriva do `events.jsonl` e escreve ele mesmo a seção `## Route` no `S##-SUMMARY.md`; o `forge-completer` só **invoca** (sub-step 1.85), no molde do `forge-verifier.js`. **Drift por dois sinais** (evento `worker-engine-fallback` **ou** `engine_final != engine_attempted[0]`) porque o cross-engine chain walk troca de engine **sem** emitir evento — ancorar só no fallback perderia a classe inteira. Agregação por chave **composta** `${milestone}|${slice}|${unit}` aplicada **depois** do filtro estrito (`execute-task/T01` sozinho ocorre 12× no log deste repo, cruzando milestones), com `RUN_ID` aceito como **alias** da milestone via `forge-runs.listAll` — sem isso um dispatch gravado como `RUN_ID` e seu fallback gravado como `{M###}` viram duas unidades. Normalizador próprio (`{codex,gpt}→codex`, ausente→`undefined`): herdar o `eventEngine` vizinho, que faz ausente→`claude`, inventaria drift em toda milestone anterior aos campos aditivos. Seção **sempre** emitida, inclusive limpa — silêncio é indistinguível de detector quebrado, que é o defeito de origem. Advisory absoluto: exit 0 sempre. O evento `worker-engine-fallback` ganhou o campo `hint`; **tabela estática `reason → hint` é proibida** (o `hintFor` depende de `declared_repo`/`repos_touched`, então tabela seria verdade model-authored recompilada). **Achado do review que quase escapou:** o `hint` nasceria permanentemente vazio — `$CODE_DIR_HINT` é atribuído num fence do Bash e lido em outro, onde shell state não existe mais (mesma pegadinha do `auto-mode started_at`), e a Branch D nunca o atribuía; corrigido com carrier em disco e **provado em duas invocações separadas**, não por leitura. Sem esse achado a task teria entregue a própria patologia que combate.

### Endereço de run (`run → root → projeto → repo`) + `.gsd/STATE.md` rebaixado a projeção gerada (M-20260802185210-workspace-root-forge/S06)
Uma run deixava de ter identidade além do `cwd`: duas runs no mesmo projeto em branches diferentes eram distinguíveis só pelo acidente de dois nomes de arquivo — nenhum campo do `RunRecord` registrava branch, root ou projeto. `scripts/forge-run-address.js` resolve a cadeia completa `run → root → projeto → repo`, **byte-idêntica de qualquer cwd** (registry-first lookup, cwd como fallback só onde o registry não responde), com cada perna carregando `{path, name, source, reason}` — `source` distingue um fato gravado de um derivado, e cada degradação usa uma razão nomeada (9 ao todo, `null` incluído) em vez de inventar um valor. Os três campos novos (`branch`/`root`/`project`) em `scripts/forge-runs.js` são **aditivos por leitura**, não por migração: o default `null` é aplicado em `get()`/`listAll()` via `withAddressDefaults`, os 7 registros vivos nunca são reescritos, e `null` (não `undefined`) porque `undefined` some no `JSON.stringify` e um consumidor não distinguiria "sem valor" de "campo ausente". `skills/forge-auto/SKILL.md` e `skills/forge-task/SKILL.md` gravam `--branch` **lido de volta** do resultado do isolation setup, nunca derivado como `forge/{id}` — uma string derivada nomeia um branch que pode não existir sempre que `branch_pattern` diverge do default. Paridade Swift: `Run` em `Models.swift` decodifica os três campos opcionais via `Codable` sintetizado (chave ausente vira `nil`), sem introduzir constante compartilhada JS↔Swift — são nomes de propriedade estruturais, não um literal a fixar em `forge-app-workspace-marker.test.js`.

Em paralelo, `.gsd/STATE.md` (raiz) deixou de ser documentado como "single source of truth" nos 8 pontos medidos onde essa instrução sobrevivia (não só os 3 que o ROADMAP citava) — ele é, desde `forge-dashboard.js`, uma **projeção gerada sob lock**; quem grava é `scripts/forge-dashboard.js`, e o registro por-run vive em `M###-STATE.md` (`shared/forge-state.md` §1, que **permanece correto e não foi tocado** — a revogação é sobre o STATE.md da raiz, não sobre o state por-run). **O achado que governa a metade documental:** o critério de demo do ROADMAP (`grep -rn "single source of truth"` não deveria achar nada referido a STATE.md) já estava **verde antes de qualquer trabalho**, porque o `grep` deste shell é uma função sobre `ugrep --ignore-files`, que honra `.gitignore` — e `.gitignore` lista `CLAUDE.md`, o arquivo exato que carregava a afirmação. Só `/usr/bin/grep` ou um argumento de arquivo explícito o alcança. Por isso a aceitação de S06 não é um `grep` de linha de comando: é `scripts/forge-doc-claims.js`, um scanner em processo (`fs`, zero shell-out) com piso anti-silêncio (`scanned === 0` é falha, não passe limpo) e mordida provada em ambas as direções — amarrado à suíte de aceitação (`forge-smoke.js` Seção 88) para que a revogação não possa ser desfeita em silêncio por uma edição futura.

- **Baselines medidas neste fechamento (nunca afirmadas):** `node scripts/run-tests.js` → 75 suítes; `node scripts/forge-smoke.js` → 2006 passed / 0 failed / 6 skipped; `cd app && swift build && swift run ForgeKitTests` → 401 passed.

### Estratificação aditiva do `.gsd/` — truncagem falante, guard direcional de schema, índice por arquivo-fonte (M-20260803205433, PR 1)
O `.gsd/` de um projeto grande serve dois consumidores incompatíveis — dispatch (budget de 1,5–3k tokens, truncava em silêncio) e investigação (quer detalhe, abre dezenas de arquivos para localizar um assunto) — e esta milestone é a primeira de duas PRs deliberadamente separadas por serem 100% aditivas: nenhum formato de dado muda, `SCHEMA-VERSION` não é bumpado, quem instala e não faz mais nada não vê nada quebrar. **S01** consertou os **dois** truncadores reais (achado da discuss — o alvo original era um só): `truncateChars`/`boundStandards`/`truncateContext` em `scripts/forge-prompt.js` (render Claude) e `truncateAtSectionBoundary` em `scripts/forge-tokens.js` (sidecar/CLI) agora emitem um marcador que diz quanto foi cortado e aponta o arquivo/seção para reler o resto, cobrado do mesmo budget que protege (reserva derivada do pior caso de dígitos, não constante fixa — nunca estoura a alocação que existe para respeitar); `shared/forge-dispatch.md § Budgeted Section Injection` foi corrigida para nomear as duas escadas de degradação separadamente, porque uma frase única contradizia uma das duas implementações. Junto veio `scripts/forge-schema-guard.js` — seam direcional (major do dado vs major entendido pela tooling, não igualdade exata) fiado nos 4 leitores do fragment store (`forge-projection.js`, `forge-ledger.js`, `forge-decisions.js`, `forge-memory.js`): fail-open na leitura nos três estados do stamp (ausente, ilegível, ou lixo legível — todos passam limpo; major ≤ entendido também), warn ALTO + resultado parcial quando o dado está à frente, e **duas** condições de recusa de escrita (exit ≠ 0): dado à frente, e stamp presente mas **ilegível** (a segunda veio do dogfood da PR #70 — ver adiante) — o dado é empurrado pelo SVN, o código só chega via `/forge-update`, então o guard só protege se instalado antes do formato mudar. **S02** entregou `scripts/forge-memory-index.js`, um índice `arquivo-fonte → fatos` derivado de `.gsd/memory/*.md`, gerado sob demanda (`--write`) e **nunca injetado** em prompt/template/budget (246 entradas ≈ 2,5k tokens não caberiam no budget de 3.000 do `§ Asset Map`) — cada render carrega uma seção "Cobertura e descarte" incondicional que enumera citações resolvidas/não-resolvidas por motivo e fatos sem citação, porque um gate que não enumera é gate inerte (precedente medido neste repo: Layer 3 do `forge-doctor` acusava 3 corretos e deixava passar o único versionado). O review dialético (challenger codex, família oposta à autoria 100% claude, resolvido por `review.challenger: auto`) levantou 12 objeções nas duas slices — 8 concedidas e corrigidas no branch, 1 refutada e retirada, e as 3 restantes ficaram abertas até a triagem de fim de milestone, todas resolvidas com "refatorar agora" e aplicadas num único commit de fechamento: catch do lazy loader do guard estreitado para só engolir `MODULE_NOT_FOUND` do próprio módulo (o fail-open de `assertWrite` foi preservado ali, marcado com comentário `SCOPE BOUNDARY` nos 4 sites — não era a mesma decisão; **essa preservação foi revista e parcialmente revertida no dogfood da PR #70**, ver o parágrafo seguinte), reserva de `truncateAtSectionBoundary` invertida para sempre reservar o marcador curto e promover para o marcador com ponteiro só se couber (3→7 seções inteiras retidas no fixture), e a contenção de path do índice trocada de comparação léxica para `realpath` real-vs-real (comparar real contra raiz léxica quebraria worktrees — este repo roda de um).

**Correção do dogfood da PR #70 — stamp ilegível fecha a escrita.** O mantenedor mostrou que `.gsd/SCHEMA-VERSION` criado como **diretório** fazia toda escrita do fragment store passar com exit 0 e arquivo em disco: o guard estava inerte exatamente no caso que ele existe para pegar. O `catch` de `assertWrite` que o comentário `SCOPE BOUNDARY` protegia **nunca foi o conserto** — era inalcançável, porque `readSchemaVersion` engolia o `EISDIR` em `null` e `checkSchemaDirection` lia esse `null` como `ahead:false`; consertar o catch teria produzido um gate verde inerte (a patologia da TASK-021, de novo). A informação agora **nasce** onde o errno é visível — `readSchemaVersionDetailed(cwd)` → `{ value, unreadable, errno }` em `scripts/forge-migrate.js`, com a regra `ENOENT` = ausente / qualquer outro errno = ilegível (medida em win32 e POSIX) — e **sobrevive** aos dois pontos de colapso até `assertWrite`, que recusa nomeando o errno e **sem alegar direção** (mensagem própria: reusar `formatSchemaWarning` produziria "o dado (null) está à frente", afirmação sobre um fato que ninguém mediu). Regra durável: **stamp que não pôde ser lido não é evidência de segurança em direção nenhuma** — recusa. Ausente e presente-mas-lixo continuam escrevendo, e a **leitura não mudou em nenhum dos três estados**: a assimetria read/write é o desenho, não um descuido. Provado pela repro do mantenedor invertida em gate (Section 8 das duas suítes do guard + Section 90 (e2) do smoke), cada assert novo verificado falhando com o fix revertido.

### Agrupar época, empacotar o comando, medir antes de limpar (M-20260804003633, PR 2)
Onde a PR 1 foi 100% aditiva, a **PR 2 é a fatia mutante** — e por isso a diferença mais importante entre as duas entradas é que esta é **breaking**. O formato de fragmento passa a ter um container agrupado por época selada (`scripts/forge-epoch.js` deriva `YYYY-QN`, época selada e wrapper dir **do conteúdo do store em runtime** — sem data de corte, sem constante de threshold; `scripts/forge-grouped-file.js` serializa/parseia o container com payload trafegando como `Buffer`, nunca decodificado, para que CRLF, BOM e ausência de newline final sobrevivam ao round-trip, e um membro cujo payload contenha o delimitador seja **recusado e nomeado** em vez de escapado ou truncado). Os **4 leitores do fragment store aprenderam o formato no mesmo slice** (D8: `forge-ledger.js`, `forge-decisions.js`, `forge-memory.js`, e `forge-projection.js`/`forge-memory-index.js` via o acessor `readFragmentText(cwd, entry)` no lugar de `fs.readFileSync(entry.path)`) — leitor que viaja depois do formato é perda de dado no intervalo. `CURRENT_SCHEMA` foi para `fragment-store@2.0.0` **no mesmo commit** que tornou o formato escrevível (D7, commit `0e62d47`), deliberadamente, para que o guard direcional entregue pela PR 1 **dispare** em vez de ficar decorativo: o dado é empurrado sozinho pelo VCS e o código só chega por `/forge-update`, então quem receber dado novo com tooling velho tem a **escrita recusada** em vez de leitores pulando fragmento em silêncio. O achado que quase custou o formato: o id de membro era escrito em ASCII e lido em ASCII, round-trip assimétrico que tornava um container com id não-ASCII permanentemente ilegível **depois** que os originais já tinham sido apagados (R1 blocker do review da S03) — hoje UTF-8 nas três posições de marcador. O comando nasceu **registro de operações**, não script (D4): `scripts/forge-sweep-registry.js` é genérico sobre `{name, description, plan, apply}` com dry-run por default, confirmação só depois do preview computado e isolamento de falha por operação — provado por uma operação falsa que obtém preview e relatório de pulados sem tocar o código do preview —, e `scripts/forge-sweep-project.js` registra exatamente **uma** operação. Na frente dele, um gate de elegibilidade fail-closed (`scripts/forge-sweep-eligibility.js` sobre o export aditivo `workingStatus` de `scripts/forge-vcs.js`, uma única consulta de status classificando as quatro classes; exclusão por **target**, não por membro, nomeando o arquivo ofensor). Wrapper dirs (`.gsd/milestones`, `.gsd/tasks`) só entram atrás de `plan(cwd, { includeWrapperDirs: true })` e a CLI **nunca** expõe o opt-in (D11) — porque `scripts/forge-wrapper-readers.js` congela o inventário dos enumeradores que não aprenderam o container, com teste que varre `scripts/` de verdade e falha por igualdade de conjuntos nos dois sentidos. **A D12 é a lição de processo desta milestone, e ela mudou uma coisa só:** a suíte passa a rodar também na fronteira `complete-slice` (rodou no fecho de S04, S05 e S06, e a execução da S07 é **final e confirmatória**, não a única) — o que ela **não** mudou é a regra de que executor escreve teste e não o executa. O motivo é medido, não teórico: três das seis tasks da S05 auto-reportaram 100% dos must-haves `met` tendo escrito suítes que não passavam, e nada além da execução no fecho pegou isso. **A S04 foi cortada pelo próprio gate, com veredicto `NO-TARGET`**: a assinatura de D9 (vírgula no **valor** de `facts[].source_unit`, não na linha crua) casou **0 fatos em 707 avaliados / 117 fragmentos** do store de referência real, com 0 falsos positivos e um controle negativo medido (grep ingênuo devolve 64, todos vírgula de fim-de-linha JSON) — T02/T03 daquela slice nunca foram despachadas. O corte é informativo porque o resíduo **existe** (~25 entradas, `MEM077` com 11 fontes) mas vive no corpo markdown de `legacy-orphan.md`, fora de `facts[].source_unit`; alargar a assinatura é re-escopo de D9 e decisão do operador, então ficou como backlog nomeado e o detector read-only (`scripts/forge-legacy-residue.js`) permanece no branch. As seis objeções de review que ficaram abertas ao final de S06 (S05 R3/R9/R13/R16 e S06 R3/R4) foram **todas arbitradas** na triagem: S05 R3 fechada **sem mudança de código** — o journal de desfazer da S08 resolveu a substância (`tool-undo` torna `untracked`/`ignored` elegíveis sem `--force`), nenhum dos dois remédios propostos (alargar `--force`, criar `--force-untracked`) foi adotado; S05 R9 fechada — os testes fail-closed já não passam verde sem git, a suíte sai não-zero a menos que `FORGE_ALLOW_NO_GIT=1`; S05 R13 fechada — o hardening `shell:false` foi **mantido** (reverter hardening correto para satisfazer disciplina de escopo pioraria o módulo) e o desvio de escopo ficou **registrado**, não revertido; S05 R16 fechada — o gate D11 continua fechado, mas a contagem de wrapper dirs protegidos passou a ser sempre reportada; S06 R3/R4 fechadas — os rótulos de cobertura foram corrigidos para dizer exatamente o que medem, docs regenerados, nenhum balde novo, a identidade de quatro vias intocada. Depois de S06 veio a **S09**, que remove o eixo de calendário inteiramente: `scripts/forge-sweep-sealed.js` seleciona membros por três provas de fechamento — (a) entrada no ledger, (b) timestamp válido embutido no id, (c) forma de id que `parseStorageKey` recusa como inescrevível — nomeia os containers `sweep-project-NN` sequenciais (sem mais `YYYY-QN`) e carrega o intervalo de datas (`dateRange`) junto com o container; `CURRENT_SCHEMA` subiu para `fragment-store@3.0.0` no mesmo commit que trocou o formato, marcado **breaking**. A regra de elegibilidade foi estreitada três vezes por três mecanismos diferentes, cada uma a mesma forma de falha (uma prova que prova menos do que alega): o risk gate achou um produtor vivo de chaves locais nuas (`skills/forge-sweep/SKILL.md:262` escreve memória sem `--milestone`); um teste de precisão que a própria slice escreveu mostrou que o timestamp de um id de milestone é **criação**, não fechamento; e um challenger independente de família oposta (Codex) argumentou que rejeição pelo parser não é inescrevibilidade permanente — resolvido não estreitando de novo, mas persistindo a prova admitente por membro e fixando a gramática com um teste que nomeia a consequência. Um dogfood contra o store de referência real (só preview, nada aplicado) achou um bug `high` que nenhum mecanismo anterior pegou: as regexes da prova (b) ancoravam em `^ask-<dígitos>`, mas todo id de sessão real carrega um prefixo **duplicado** (`ask-ask-<data>`), então a prova não casava **nenhum** fragmento real — corrigido; o store de referência foi de 222 elegíveis sob o calendário para **508 de 529 membros elegíveis, 21 pulados com motivo, com os totais reconciliando**. **Revisão em toda a milestone: 21 objeções, zero abertas.**

## Convenções de código

- **Linguagem dos artefatos:** Markdown com frontmatter YAML
- **Linguagem da UI/mensagens:** Português (pt-BR)
- **Linguagem do código/scripts:** Inglês
- **Commits:** Conventional commits em inglês (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`)
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
  mode: advisory          # advisory | blocking | disabled   (default advisory)
```

Todos scaffoldados em `forge-agent-prefs.md` e cascateados pela precedência padrão (user → repo → local, last wins).

### Postura advisory por padrão

Somente o check de schema do executor (S01, componente #1) é enforcing em M003. Os outros quatro componentes emitem seções documentais em SUMMARY/VERIFICATION/PLAN-CHECK — nunca bloqueiam o loop. Isso é deliberado: permite que M003 ganhe cobertura sem thrash em falsos positivos enquanto as heurísticas (stub regex, import-chain depth, dimensões de plan-check) amadurecem com uso real.

### Como ativar modos stricter

- `evidence.mode: strict` — reservado para M004+. Em M003 `strict` e `lenient` se comportam de forma idêntica no hook; a diferença no completer é futura.
- `plan_check.mode: blocking` — ativa o revision-loop (max 3 rodadas, decremento monotônico em `fail`). Código já instalado em `skills/forge-auto/SKILL.md` + `skills/forge-next/SKILL.md`, inerte até o pref ser trocado.
- `file_audit.ignore_list` — customize adicionando/removendo globs. Não muda a postura advisory — só o que é flagged.

Antes de ativar qualquer um destes em um projeto de produção: rode ≥ 1 milestone completo em modo advisory para medir a taxa de falsos positivos das heurísticas (regex stub, depth-2 walker, dimension scoring). M003 explicitamente não recomenda flipping defaults em v1.

### Review pairing dinâmico por autoria (M006)
Resolver o challenger e advocate de cada review pela autoria do código reflete a realidade de que desafios independentes (de quem não escreveu) encontram brechas que dois Claudes não acham. `challenger: auto` resolve para a família **OPOSTA** ao autor (reduz viés de auto-preferência — paper arxiv 2404.13076); `advocate: auto` resolve para a **MESMA família** do autor. Autoria é derivada do campo `engine` dos dispatch events (Claude vs Codex) agregada por majority determinística. **`--mode defend` já existe** em `scripts/forge-xllm.js` (docs `:43`, `authorizeSidecar` `:1691`, validação `:2353`), então um autor não-Claude passa a ser defendido pela **própria família** — a degradação para advocate Claude não é mais o caminho normal. Ela continua alcançável de propósito: quem sabe que o adapter falta (cópia instalada antiga, probe falho) passa `defendAvailable: false` e recebe o comportamento histórico, com o evento `review-pairing-fallback: defend-mode-unavailable`. Nunca bloqueia em nenhum dos dois caminhos. Lógica em `scripts/forge-review-pairing.js:223-225`. Lógica em `scripts/forge-review-pairing.js`; Step 0 roda a CLI uma única vez por review. Defaults `challenger: claude` e `advocate: claude` permanecem — flip de `auto` é decisão pós-dogfood. Spec canônica sem redefinição: `shared/forge-review.md § Step 0`.

### `scope: environment` do sidecar deixa de ser desculpa auto-aceita (TASK-020)
`environment` é a **única** categoria que converte "não fiz" em "aceito", e a verificação dessa declaração era **textual, feita sobre um texto que o próprio sidecar escreve**. Resultado medido: **13 alegações falsas em três sessões** — 6× `git-commit-required` na M017, 6× `sandbox-exec-blocked` no projeto lookchina, e a 13ª durante a própria TASK-020. Em todas o trabalho estava correto e nenhuma estava provada; em uma delas **6 de 9** must-haves (toda a prova comportamental de uma task) ficaram sem verificação. **Três buracos que se compunham:** (a) o corroborador de `git-commit-required` era tautológico — `/\bgit\b|commit|push/i` sobre `item + note`, então qualquer note que **mencionasse** git se auto-corroborava (inclusive uma que dizia literalmente *"the task prohibits running any git command"*); agora corrobora **só contra `entry.note`** (nunca o `item`, boilerplate ecoado do plano) e exige operação de **escrita** git via `GIT_WRITE_RE` — o mesmo rigor que `sandbox-exec-blocked` já tinha em `:64-73` e que nunca fora aplicado ao vizinho. (b) `needsReverification` **e** `affectedEntries` filtravam por `reason === 'sandbox-exec-blocked'`, então a rede da TASK-015 nunca disparava para os outros quatro; ambos passam a compartilhar `isReverifiable()` — os **4 reasons de execução bloqueada**. `gsd-write-refused` é **deliberadamente excluído**: a alegação é sobre escrever `.gsd/**`, e uma suíte verde nunca toca esses arquivos, logo seu exit code não pode ser evidência (achado do review R1, arbitrado pelo operador; a versão inicial cobria os 5 e promovia por evidência irrelevante — reproduzido ao vivo). **Trigger e seletor mudam sempre juntos** — estreitar só um produz gate **verde inerte** (dispara, gasta a suíte, não seleciona nada). (c) `resolveVerifyCommand` detectava stack só por `package.json`/`go.mod`/`Cargo.toml`/pytest/`Makefile` e devolvia `null` neste repo zero-dep — mesmo com a rede disparando não havia comando a rodar; agora cai para `.gsd/CODING-STANDARDS.md § Lint & Format Commands → **Test:**`, descartando qualquer trecho que exija parsing de shell (glob, metacaractere, **aspas** e barra invertida — o spawn é `shell:false`, então só passam comandos tokenizáveis sem perda por split em espaço). `--gsd-dir` é encadeado até a CLI e as **4 mirrors** porque em modo worktree o `.gsd/` **não** está sob o `CODE_DIR` e walk-up não o alcança. **Regra operacional durável:** `reason: environment` vindo do sidecar **nunca** é evidência — exige re-execução pelo orquestrador, sempre. **Gaps registrados** em `.gsd/KNOWLEDGE.md § Review follow-ups`: `hasDivergentCommandNotes` não gateia notes sem runner token; o template do `/forge-init` (`commands/forge-init.md:415-419`) **não emite** `- **Test:**`, então projetos novos zero-dep não herdam o fallback de (c) até alguém acrescentar a linha à mão.

### Sinal de sobreposição entre runs — o sinal, não a fila (S07)
Duas runs concorrentes podiam mexer no mesmo arquivo e ninguém sabia disso até o merge. S07 grava exatamente o sinal que uma fila de integração consumiria, e **nada além disso**. **Registro:** `scripts/forge-touch.js --record <run-id>` deriva os toques **do git** — `git diff --name-only <merge-base>..HEAD` (base via `gitDefaultBranch` **importado** de `forge-isolation.js`; uma quarta implementação da relação seria o defeito) **união** `git status --porcelain` — e persiste em `touched` no `RunRecord`, campo **aditivo** pelo mesmo motivo que `branch`/`root`/`project` foram: registro antigo continua legível, nada migra, o arquivo em disco fica byte-idêntico até `--record` dar uma razão real de mudar. **Por que git e não o evidence log:** o log registra *chamadas de tool* (arquivo escrito e revertido conta como toque; arquivo mudado por um `sed` no Bash não conta); git responde a pergunta certa — "o que essa branch mudou em relação à base" — que é a mesma que o merge futuro faria. **Comparação:** `scripts/forge-overlap.js --check` confronta os snapshots e emite `overlap | clean | inconclusive` com **censo** (`runs_examined`, `runs_with_touch_data`, `pairs_compared`, `files_compared`, `skipped[{id,reason}]`), e todo skip tem razão **nomeada e enumerada** — jamais descarte silencioso. **O invariante que carrega a slice inteira:** `clean` é uma *afirmação sobre trabalho feito* ("confrontei estes pares e não achei colisão"), logo **`pairs_compared === 0` é `inconclusive`, nunca `clean`** — um comparador que diz "limpo" sem ter comparado reporta a própria inatividade como boa notícia, e esse relatório é indistinguível byte a byte de um detector quebrado. Essa milestone pagou três rodadas por exatamente essa forma (um `grep` que honrava `.gitignore` e não varria nada; o scanner que o substituiu, cego à própria palavra-alvo; o padrão alargado, ainda evadível por reescrita). O mesmo piso vale um nível abaixo, no registro: `readTouched` devolve `null` para "nunca gravado" e isso **nunca** colapsa com `{examined>0, repos:[]}` = "gravado e honestamente vazio". **Superfícies:** `forge-doctor --check run-overlap` (advisory — `ok: true` sempre, `--check all` continua exit 0 **com** sobreposição presente) e o par record→check invocado por `skills/forge-auto` e `forge-next` antes de despachar `complete-slice`: imprime o flag e segue. **`exit 0` é propriedade do processo**, asserida spawnando a CLI, não afirmada em comentário. **Fronteira travada — o que S07 recusa por decisão, não por falta de tempo:** ordenação de runs, bloqueio de merge, merge especulativo, merge groups, bisect, sugestão de "quem mergeia primeiro", persistência de fila. Isso é **fila de integração** — produto inteiro, decisão do CONTEXT § Deferred Ideas. Um plano futuro que cresça nessa direção está errado por mais elegante que seja; o teste de T02 assere a ausência (nenhuma saída contém ordem recomendada, nenhum código escreve estado de fila). **Gap em pé, tornado legível em vez de escondido:** `discoverRepos` anda **um nível só** (item `I-20260803060030`, a segunda falta pendente da TASK-021) — em vez de mudar a profundidade da varredura sobre dado vivo do operador na última slice, o repo que não resolve entra no censo com `reason: repo-path-unresolved` em vez de sumir, e o item segue aberto para a triagem final. **Sem constante compartilhada JS↔Swift:** S07 não escreve em `app/**`, então o critério #15 (paridade) **não** dispara e `forge-app-workspace-marker.test.js` não foi estendido — e isso é **declaração verificada, não omissão**: a Section 89 do smoke assere por commit (não por range — um fix de UAT da S03 pousou entre T01 e T02 e *toca* `app/`, então atribuição por range acusaria a slice errada) que nenhum commit de S07 toca `app/`, com controle positivo provando que o predicado não é cego.

### `forge-sweep-project` ganha journal de desfazer — o container já era o journal de conteúdo (S08)
A premissa que destrava a slice: `ungroup()` (`scripts/forge-epoch-group.js:397`) já reconstitui cada
membro byte a byte a partir de `unit.id`+`unit.content` — o container **é** o journal de conteúdo,
provado por dois testes (incl. BOM/CRLF). Nenhuma task de S08 duplica bytes de fragmento em lugar
nenhum. O que faltava: (1) `ungroup` **recuperável** após falha parcial — resolvido tornando-o
idempotente (destino já existente com bytes **idênticos**, `Buffer.compare === 0`, conta como
restaurado via campo aditivo `alreadyPresent`, nunca lança; bytes **diferentes** continuam lançando,
o invariante loose-vence-agrupado da S03 R3 fica intacto). A alternativa — staging + promoção
atômica — foi rejeitada: não existe rename multi-arquivo atômico no Windows, e um diretório de
staging sob `.gsd/` recriaria a própria patologia de limpeza que pretendia evitar. (2) registro
persistido de **ponteiros**, nunca conteúdo (W3): `scripts/forge-sweep-journal.js`, JSONL
append-only em `.gsd/forge/sweep-journal.jsonl` (mesmo idioma do `events.jsonl`) — caminhos de
container (relativos POSIX), timestamps, operação, fase e sha256 **advisory** do container
(detecta divergência, não é segunda fonte de bytes). (3) fundamento de elegibilidade nomeado
`tool-undo`, que estende `createEligibility` (S05) para aceitar alvos `untracked`/`ignored` (diretos
ou por ancestral — exatamente o caso do S05 R3: `.gitignore` cobrindo `.gsd/`) quando o journal
existe; `modified`/`added`/`deleted` continuam recusando sempre — estado sujo de arquivo rastreado
sinaliza edição humana em curso, hazard que o undo não endereça (undo devolve bytes pré-apply, o
problema é atropelar a edição). O ramo sem-VCS fica inalterado (herdada 7, travada). (4) semântica
de falha do registro: append de *intent* pré-apply é obrigatório; se falhar **e** qualquer alvo
aceito tiver `basis: 'tool-undo'` → aplicação inteira **recusada** (exit 1, motivo nomeado, zero
mutação) — nunca degrada para "prossegue" (B2); se falhar com todos os alvos `basis: 'vcs'` → warn
em stderr e prossegue (a garantia desses alvos é o VCS, não o journal). (5) superfície de CLI
`--undo <container>`, restaurando via `ungroup`, resolvido estritamente contra containers
registrados no journal — nunca um caminho arbitrário do operador. D11 permanece intacta: a CLI
segue sem nenhum caminho para ativar wrappers, então o journal nunca registra container de
wrapper — mas `ungroup` teve os **dois** ramos consertados (store e wrapper), porque é chamável
como biblioteca sobre containers de wrapper. **Resolve a substância do S05 R3** (o comando deixa de
ser inerte no caso `.gsd/`-ignorado) sem alargar `--force` nem reabrir as duas variantes já
rejeitadas — o item R3 permanece formalmente aberto para o operador fechar na triagem final, junto
com R9/R13/R16 (S05) e R3/R4 (S06). S08 não é coberta por nenhum critério `IN-` do SCOPE original —
foi acrescentada após o review, por decisão do operador em 2026-08-04, com origem em S05 R3.

### O calendário era um proxy ruim para "encerrado" — trocado por três provas diretas (S09)
S03 derivava o rótulo de agrupamento (`YYYY-QN`) do relógio de parede: um projeto ocioso produz um
trimestre selado vazio, um projeto intenso produz um trimestre grosso demais, e há ambiguidade de
fuso/limite em cada virada. O calendário nunca foi o critério real — era um substituto para "ninguém
escreve mais aqui", e um substituto ruim: mede o tempo passado, não se o endereço morreu. S09
substitui o eixo por varredura sob demanda (`sweep-project-NN`, numeração sequencial compartilhada
entre os três stores) disparada porque um operador julgou que já acumulou o suficiente — a mutação
de memória institucional acontece porque um humano olhou e decidiu, não porque outubro chegou, a
postura mais segura para uma operação cujo risco é perder história. `scripts/forge-sweep-sealed.js`
é o módulo que substitui o calendário: `sealedBy(unit, ctx)` só agrupa com prova direta —
**(a) ledger** (entrada para a unidade dona do id), **(b) id-date** (timestamp válido embutido no
próprio id, ou `ask-<data>`) ou **(c) extinct-id** (formato que `parseStorageKey` recusa hoje, então
nenhum caminho em curso pode produzir aquele id). O dano que essas três provas evitam não é visível
quando acontece: `forge-memory.js:692-704` (`writeFragment`) mescla **apenas** contra o caminho
solto — agrupar uma unidade que ainda vai receber escrita faz a próxima gravação começar do zero e
**sombrear** os fatos já acumulados (regra solto-vence-agrupado). Nenhum teste de "agrupou e
desagrupou igual" pega esse dano; só um teste de precisão que cerca uma unidade viva de unidades
elegíveis pega. A prova (c) foi **estreitada** durante T02 por um achado que refutou sua própria
premissa: a hipótese original era que só uma migração one-shot (`forge-memory-migrate.js:451`)
produz chave local nua (ex.: `S02`); falso — `skills/forge-sweep/SKILL.md:262` grava memória sem
`--milestone` e isso está **em curso** hoje, não é arqueologia. Sem esse achado a task teria
agrupado (e sombreado) memória institucional viva sob a bandeira de "formato legado". A assimetria
que decide a direção do estreitamento: falso negativo deixa resíduo solto (inofensivo, estado
atual); falso positivo sombreia memória institucional (não-reversível pelo journal do S08, que
desfaz o container, não a mescla que já aconteceu na próxima escrita). `CURRENT_SCHEMA` sobe para
`fragment-store@3.0.0` no mesmo commit que muda o formato do container (T03) — nunca depois, num
commit separado, porque é a última slice antes da PR e o bump é, na prática, irreversível.
Containers `YYYY-QN` legados continuam **lidos**, nunca escritos ou migrados.

### Worker truncado deixa de ser um ramo que não existe (Layer 0)

Um subagente cuja mensagem final é cortada chega, a jusante, **byte a byte igual** a um que
terminou: nos dois casos a chamada `Agent()` retornou. O bloco `---GSD-WORKER-RESULT---` é a única
coisa que os separa — e ele está ausente exatamente no caso em que importa. O defeito não era uma
heurística fraca: era a **ausência de ramo**. Um `grep` por tratamento de bloco faltante nos três
orquestradores (`skills/forge-{auto,next,task}`) devolvia **zero**: o `Step 5. Process result`
tratava `done`/`partial`/`blocked` e não tinha linha para "nenhum bloco". Sem ramo nomeado o modelo
improvisa — numa sessão medida ele inventou um resume-por-`agentId` enquanto o trabalho de um
executor de 17 min e 300k tokens estava **pronto no disco, não lido**. A improvisação não é o
defeito; o ramo faltante é.

**Layer 0** entra antes das três camadas existentes (Retry Handler / Failure Taxonomy / Node
Repair), e a precedência é a justificativa: as três leem um sinal que o worker **emitiu**; um worker
truncado não emitiu nenhum, então roteá-lo para qualquer uma delas é classificar um valor que
ninguém leu. `scripts/forge-worker-result.js` decide por **marcador + enum de status**, e por mais
nada — o **último** marcador vence (agentes citam o próprio template na prosa, e um placeholder
`blocker: <description>` vazando do template citado vira uma objeção que o worker nunca reportou;
o teste que prova isso precisou ser reescrito depois que um bite mostrou que asserir só sobre
`status` não morde — a sobrescrita de chave concorda com as duas escolhas de marcador).
**Deliberadamente não distinguido:** "o stream cortou" × "o agente esqueceu o bloco". O remédio é o
mesmo, então um rótulo separando os dois compra zero decisão — e a única forma de adivinhá-lo é
heurística de forma de prosa (cerca não fechada, sem pontuação final), o tipo de sinal confiante e
não-medido que este repo já teve que apagar antes.

A recuperação lê **o que o próprio worker escreveu**, nunca inventa: `worker-event` (a linha que o
executor appenda em `{M###}-events.jsonl` **imediatamente antes** do bloco — mesmo precedente do
salvage de `DEFENSE_FILE` em `shared/forge-review.md § Step 3`), ou `summary-file` **E**
`plan-status: DONE` juntos — nunca um sozinho, porque um worker que fez só um está em voo.
`vcs-delta` **nunca** decide: arquivo mudado significa que houve trabalho, não que a task concluiu;
ele existe para separar "não fez nada" de "fez muito e perdemos o relatório", que é a diferença
entre re-despachar barato e re-despachar por cima de trabalho vivo. `must_haves_status` **nunca** é
sintetizado — é a alegação medida do worker sobre os próprios must-haves; ausente, fica ausente,
para o verifier e a Layer 3 rodarem sobre evidência real. Piso anti-silêncio: as 4 sondas são
sempre reportadas com desfecho do conjunto fechado `hit | miss | unavailable`, e `miss` (olhou, não
achou) nunca colapsa em `unavailable` (não conseguiu olhar).

**O hook parou de lavar o escape em sucesso.** `validateForgeSubagentResult` bloqueava o primeiro
stop para pedir o re-emit e, no segundo passe (`stop_hook_active`), falhava aberto — correto, evita
loop infinito — mas retornava **antes de computar `hasBlock`**, e o chamador gravava `status: 'done'`
para um worker que nunca emitiu o contrato: a patologia "truncado é indistinguível de terminado",
carimbada no artefato cuja função é distingui-los. Agora falha aberto **e diz o que houve**
(`contract-missed`), e cada miss vira uma linha em `.gsd/forge/contract-miss.jsonl` com o `agent_id`
— que é o único cabo para o resume. Nunca cria `.gsd/forge` num repo que não é Forge; silent-fail
em tudo (MEM008). **Fronteira:** só o caminho Claude `Agent()`. O sidecar não precisa — o contrato
dele é um JSON em disco e uma resposta cortada já aparece como `codex-invalid-json`, reason terminal
com fallback existente; nada na máquina de estados do sidecar muda.

## Estado atual

- **Milestone ativo:** — nenhum. **M018** (Sidecar multi-LLM autônomo via `codex app-server`) fechada, **mergeada na `master`** em `eaeb556` (fast-forward) e pushada para `origin/master`.
- **Fase:** idle.
- **Última entrega:** M018, 7 slices. Cliente JSON-RPC/stdio para `codex app-server` substitui o `codex exec` — a **ausência** do transporte antigo é provada por scanner in-process (`forge-exec-callsites.js`: `outcome: clean`, 312 arquivos, 0 call sites), não afirmada. Mais: schema pinado + guard de drift que nomeia o campo divergente, capability por turn, evidência de primeira classe com piso anti-silêncio, cobertura de env por reason (dois promovidos a exit code observado, três textuais com razão nomeada), e `turn/interrupt` antes do SIGKILL.
- **Consertos pós-triagem, no mesmo commit:** rota inerte do `worker:` família (um `claude` nu resolvia para alias nulo e a task caía no default do frontmatter, ignorando o modelo do tier); Dimensão 9 do plan-checker (`.gsd/**` × `dispatch_engine`); Branch C marcando `status: DONE` no plano que completou; a mensagem de reparo do `SubagentStop`, que mandava o agente emitir **só** o bloco de resultado — obedecida ao pé da letra, custou 6 defesas do advogado, três voltando como placar nu; e o guard `nested-top-level-key`, achado por dogfood num workspace de dois repos onde **2 de 3 planos** aninhavam `expected_output` sob `must_haves:`, o validador chamava os três de válidos, e o resolvedor de `CODE_DIR` via zero paths.
- **Baselines medidas na master pós-merge (medidas, não afirmadas):** `node scripts/run-tests.js` → **111 suítes**; `node scripts/forge-smoke.js` → **2502 passed / 0 failed / 1 skipped**; `cd app && swift run ForgeKitTests` → **515 passed / 0 failed**.
- **Cópias instaladas:** `~/.claude` sincronizado com a master via `install.sh --update`, conferido arquivo a arquivo com `cmp`. Backup em `~/.claude-backup-20260807-231632`.
- **Próxima ação:** Operador. Quatro itens em aberto, deliberadamente não corrigidos: (1) `GitActivity.Glob` (`app/Sources/ForgeKit/GitActivity.swift:219-227`) casa `X/**` **ancorado na raiz**, enquanto `agents/forge-completer.md:151` afirma prefixo-de-segmento em qualquer profundidade para a **mesma** lista de ignore — divergência medida por probe Swift temporário; (2) o comentário em `app/Sources/ForgeKitTests/main.swift:3086` afirma uma profundidade que o caso não exercita; (3) **S06 R7** (`scripts/forge-reverify.js:181-190`, o atalho de cardinalidade) segue **sem disposição nomeada** — nem corrigida nem listada como follow-up na triagem; (4) o dogfood real num workspace multi-repo de produção ainda não rodou — o `fs-probe` foi provado em umbrella sintético, não no projeto onde a falha 4/4-em-Claude foi medida.

## GSD — Início de sessão obrigatório (dogfood)

Ao iniciar qualquer sessão de trabalho GSD neste projeto, leia em ordem:

1. `.gsd/STATE.md` — posição atual e próxima ação
2. `.gsd/milestones/<ativo>/M*-CONTEXT.md` — decisões de arquitetura do milestone ativo
3. `.gsd/AUTO-MEMORY.md` — conhecimento auto-aprendido (se existir)

Se houver `continue.md` no slice ativo → leia, delete, retome de "Next Action".
Comandos, agentes e metodologia: ver seções acima deste arquivo.
