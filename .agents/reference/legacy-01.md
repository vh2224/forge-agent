# Histórico preservado — parte 1

Evidência da entrada anterior, não é política vigente nem fila atual. Consulte ../project-policy.md e contratos atuais antes de agir. Leia somente quando necessário.

---

`````text
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


`````
