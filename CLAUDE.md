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
Milestone (M###) → Slice (S##) → Task (T##)
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

**Regra:** Skills são auto-suficientes (lêem seus próprios arquivos de disco). Não injetar contexto via args — passar apenas IDs (M###, S##).

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
│   └── M###/                    # Cópia movida do diretório de milestone completo
└── milestones/
    └── M###/
        ├── M###-ROADMAP.md      # Slices, dependências, boundary map
        ├── M###-CONTEXT.md      # Decisões de arquitetura (discuss)
        ├── M###-RESEARCH.md     # Pesquisa de codebase
        ├── M###-BRAINSTORM.md   # Brainstorm estruturado
        ├── M###-SCOPE.md        # Contrato de escopo
        ├── M###-SUMMARY.md      # Summary acumulativo
        └── slices/
            └── S##/
                ├── S##-PLAN.md      # Tasks, dependências, acceptance criteria
                ├── S##-CONTEXT.md   # Decisões do slice
                ├── S##-RESEARCH.md  # Pesquisa do slice
                ├── S##-RISK.md      # Avaliação de riscos
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
model: "claude-opus-4-7[1m]"   # modelo base (fallback: claude-opus-4-6 via install-time probe)
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
Modelo agora resolvido por tier (`light`/`standard`/`heavy`) via `PREFS.tier_models`, não por fase. A tabela canônica `unit_type → tier → default_model` vive em `shared/forge-tiers.md`; o algoritmo de 5 passos com exemplos está em `shared/forge-dispatch.md § Tier Resolution`. Override precedence (maior ganha): `tier:` frontmatter explícito > `tag: docs` (força light) > unit_type default. Operador re-roteia um tier inteiro editando `tier_models.<tier>` em `forge-agent-prefs.md § Tier Settings` — zero mudanças de código. O evento `dispatch` em `events.jsonl` é estendido additivamente com os campos `tier` e `reason` (compatível com leitores S03 que ignoram campos desconhecidos).

### Installer re-merge de hooks em upgrades
Instaladores (`install.sh`, `install.ps1`) copiavam `merge-settings.js` atualizado para `~/.claude/forge-settings.js` mas nunca o re-executavam. Usuários que ativaram a statusline antes da v0.7.0 ficavam com `settings.json` sem os hooks `SubagentStart/Stop` e `PreCompact/PostCompact` — o `last_heartbeat` em `auto-mode.json` só era bumpado pelo Bash do orquestrador (antes/depois do dispatch), então workers longos tripavam o stale check da statusline (15 min) e o indicador `AUTO` sumia durante a execução. Fix: após copiar `forge-settings.js`, ambos instaladores detectam via `node` se `statusLine.command` do `~/.claude/settings.json` contém `forge-statusline.js`; se sim, re-executam o `forge-settings.js` no próprio `settings.json`. `merge-settings.js` já é idempotente — só adiciona hooks faltando, preserva todas as outras chaves. Garante que `/forge-update` sempre sincronize hooks mesmo quando o usuário nunca toggla a statusline.

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

- **Nunca edite install.ps1 com strings contendo `\f`** — usar hex escape ou verificar bytes após edição
- **Agentes não acessam tool Agent** — apenas o orquestrador (commands) despacha agentes
- **Workers retornam `---GSD-WORKER-RESULT---`** — formato estruturado que o orquestrador parseia
- **STATE.md é single source of truth** — só o orquestrador e o completer escrevem nele
- **DECISIONS.md é overview global** — append-only, nunca editar ou remover linhas existentes. Não é mais injetado em workers (exceto discuss-milestone como referência de milestones anteriores). Decisões por fase vivem na seção `## Decisions` do CONTEXT.md de cada fase.
- **Testes de instalador:** Rodar com `--dry-run` antes de mudar lógica de cópia
- **Novos comandos:** Seguir padrão dos existentes com bootstrap guard + load context
- **Novos agentes:** Adicionar ao install.sh/install.ps1 glob pattern (já coberto por `forge*.md`)
- **Novos agentes Opus:** Adicionar `thinking: adaptive` e `effort: medium` ao frontmatter
- **Novos agentes Sonnet:** Adicionar `effort: low` ao frontmatter
- **Nova skill:** Criar `skills/forge-<name>/SKILL.md`, invocar via `Skill("forge-<name>")` — nunca via Agent intermediário
- **Skills são auto-suficientes:** Não injetar contexto no prompt — skill lê o que precisa do disco

## Forge Auto-Rules

Regras auto-promovidas do sistema de memória emergente (confidence ≥ 0.85, hits ≥ 3):

- [MEM001] PostCompact recovery handler must write compact-signal.json AFTER compaction completes, not before. Hook re-reads auto-mode.json from disk and deletes signal after recovery check. *(auto-promoted 2026-04-15, confidence:0.95, hits:3)*

- [MEM004] All forge-* skills use disable-model-invocation: true to prevent skill description from being injected into worker context, saving tokens and reducing noise. Confirmed across forge-auto, forge-task, forge-new-milestone, and all other skills. *(auto-promoted 2026-04-15, confidence:0.95, hits:3)*

- [MEM005] Gradual skill migration: move commands to skills/ with thin shims (6–7 lines), not big-bang refactoring. Shims pass $ARGUMENTS through via Skill({skill:"name", args:"$ARGUMENTS"}) to preserve CLI flags. Commands reduced from ~950 total lines to ~20 shim lines. All migrated skills follow disable-model-invocation: true convention. *(auto-promoted 2026-04-15, confidence:0.95, hits:6)*

- [MEM011] Dispatch templates use placeholder substitution (Read-path directives with mandatory vs optional artifacts) instead of inline artifact-reading logic. All 7 dispatch templates standardized: templates are thin data-flow descriptors; workers handle all read I/O. Reduces orchestrator prompt size and ensures fresh state per worker. 24 inlined {content...} placeholders eliminated. Note: forge-next preserves selective memory injection block (lines 123-129) unique to step-by-step execution model. *(auto-promoted 2026-04-15, confidence:0.95, hits:6)*

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
  ignore_list: [package-lock.json, yarn.lock, pnpm-lock.yaml, dist/**, build/**, .next/**, .gsd/**]
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

## Estado atual

- **Milestone ativo:** — (M003 concluído)
- **Fase:** idle — M003 encerrado com sucesso.
- **Próxima ação:** Executar `/forge-new-milestone <descrição>` para iniciar o próximo milestone.
