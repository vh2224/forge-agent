---
description: "Exibe ajuda completa do agente GSD — comandos, agentes, fluxo de trabalho e configurações."
allowed-tools: Read
---

Read `~/.claude/gsd-agent-prefs.md` and `.gsd/claude-agent-prefs.md` (if exists) to show current config. Then display the following help, filling in the actual current values where marked.

---

Exiba exatamente este conteúdo para o usuário (substituindo os valores dinâmicos indicados):

---

## GSD Agent — Ajuda

Sistema de agentes Claude Code baseado no workflow GSD-2.
Hierarquia: **Milestone → Slice → Task** (iron rule: task cabe em um context window).

---

### Inicialização

| Comando | O que faz |
|---------|-----------|
| `/gsd-init` | Detecta projeto existente (gsd-pi) ou cria estrutura nova. Gera `CLAUDE.md` + `.gsd/AUTO-MEMORY.md` + `.gsd/claude-agent-prefs.md`. Execute uma vez por projeto. |
| `/gsd-init <descrição>` | Mesmo que acima, mas já passa a descrição do projeto para pular a pergunta inicial. |

---

### Execução

| Comando | O que faz |
|---------|-----------|
| `/gsd` | **Step mode** — lê `STATE.md`, executa exatamente uma unidade (task, slice, fase) e para. Ideal para revisar o que foi feito antes de continuar. |
| `/gsd-auto` | **Auto mode** — executa o milestone inteiro de forma autônoma, unidade por unidade, sem pausas. Para apenas em blocker ou milestone completo. Equivalente ao `/gsd auto` do gsd-pi. |

---

### Planejamento

| Comando | O que faz |
|---------|-----------|
| `/gsd-new-milestone <descrição>` | Cria um novo milestone do zero. Passa por discuss (captura decisões), depois planeja slices e escreve o ROADMAP completo com boundary map. |
| `/gsd-discuss <M###\|S##>` | Abre a fase de discuss para um milestone ou slice específico. Faz perguntas sobre gray areas e registra decisões no CONTEXT file. Use antes de planejar quando houver dúvidas arquiteturais. |
| `/gsd-add-slice <M###> <descrição>` | Adiciona um slice a um milestone existente. Planeja as tasks (T##-PLAN.md) e atualiza o ROADMAP. |
| `/gsd-add-task <S##> <descrição>` | Planeja uma task específica dentro de um slice. Cria o T##-PLAN.md com steps e must-haves. |

---

### Visibilidade

| Comando | O que faz |
|---------|-----------|
| `/gsd-status` | Dashboard do projeto — milestone ativo, progresso de slices e tasks, próxima ação. |
| `/gsd-explain <alvo>` | Explica qualquer artefato sem modificar nada. Alvos válidos: `M001`, `S03`, `T02`, `decisions`, `state`, `all`. |
| `/gsd-memories` | Gerencia as memórias auto-aprendidas do projeto. Sub-comandos: `show` (padrão), `stats`, `clean`, `export`, `inject`. |
| `/gsd-skills` | Lista todas as skills disponíveis e como integrá-las com os comandos GSD. |
| `/gsd-skills <nome>` | Detalhes, exemplos e flags de uma skill específica. |
| `/gsd-skills --all` | Mapa completo: skill × fase GSD × comando × flag de skip. |
| `/gsd-skills install` | Como instalar novas skills do ecossistema skills.sh. |
| `/gsd-help` | Esta tela. |

---

### Configuração

| Comando | O que faz |
|---------|-----------|
| `/gsd-prefs` | Mostra configuração atual (modelos por fase, skip rules, git settings). |
| `/gsd-prefs set <fase> <modelo>` | Muda o modelo de uma fase. Ex: `/gsd-prefs set research haiku`, `/gsd-prefs set execute opus`. |
| `/gsd-prefs skip-research <true\|false>` | Ativa/desativa o skip da fase de research. |
| `/gsd-prefs skip-discuss <true\|false>` | Ativa/desativa o skip da fase de discuss. |
| `/gsd-prefs git <chave> <valor>` | Altera configuração git. Ex: `/gsd-prefs git auto_push true`. |
| `/gsd-prefs reset` | Restaura todos os padrões globais. |

---

### Agentes especializados (invocados automaticamente)

| Agente | Modelo atual | Usado em |
|--------|-------------|----------|
| `gsd-discusser` | **[ler de gsd-agent-prefs.md]** | discuss-milestone, discuss-slice |
| `gsd-researcher` | **[ler de gsd-agent-prefs.md]** | research-milestone, research-slice |
| `gsd-planner` | **[ler de gsd-agent-prefs.md]** | plan-milestone, plan-slice |
| `gsd-executor` | **[ler de gsd-agent-prefs.md]** | execute-task |
| `gsd-completer` | **[ler de gsd-agent-prefs.md]** | complete-slice, complete-milestone |
| `gsd-worker` | **[ler de gsd-agent-prefs.md]** | step mode (genérico) |
| `gsd-memory` | **[ler de gsd-agent-prefs.md]** | extração de memórias (fire-and-forget) |

> Modelos disponíveis: `opus` (claude-opus-4-6) · `sonnet` (claude-sonnet-4-6) · `haiku` (claude-haiku-4-5-20251001)

---

### Fluxo típico de trabalho

```
1. Navegar até o projeto
2. /gsd-init                        ← uma vez por projeto
3. /gsd-new-milestone <descrição>   ← criar primeiro milestone
4. /gsd-status                      ← ver o que foi criado
5. /gsd                             ← avançar step a step
   ou
   /gsd-auto                        ← rodar tudo de uma vez
6. /gsd-memories                    ← ver o que o agente aprendeu
```

---

### Arquivos de configuração

| Arquivo | Escopo | O que controla |
|---------|--------|----------------|
| `~/.claude/gsd-agent-prefs.md` | Global | Modelos padrão por fase, skip rules, git |
| `.gsd/claude-agent-prefs.md` | Projeto | Overrides do projeto (sobrescreve o global) |
| `CLAUDE.md` | Projeto | Carregado automaticamente pelo Claude Code em toda sessão |
| `.gsd/AUTO-MEMORY.md` | Projeto | Conhecimento auto-aprendido acumulado |
| `~/.gsd/agent/GSD-WORKFLOW.md` | Global | Referência completa da metodologia |

---

### Arquivos GSD gerados durante execução

```
.gsd/
  STATE.md                    ← estado atual (lido em toda sessão)
  DECISIONS.md                ← registro de decisões (append-only)
  PROJECT.md                  ← descrição do projeto
  REQUIREMENTS.md             ← contrato de capacidades
  KNOWLEDGE.md                ← conhecimento manual do projeto
  AUTO-MEMORY.md              ← memórias auto-aprendidas
  milestones/
    M001/
      M001-ROADMAP.md         ← slices com checkboxes + boundary map
      M001-CONTEXT.md         ← decisões capturadas no discuss
      M001-RESEARCH.md        ← pesquisa de codebase
      M001-SUMMARY.md         ← resumo acumulado do milestone
      slices/
        S01/
          S01-PLAN.md         ← tasks com checkboxes
          S01-CONTEXT.md      ← decisões do slice
          S01-SUMMARY.md      ← resumo ao completar o slice
          S01-UAT.md          ← script de teste manual
          tasks/
            T01-PLAN.md       ← steps + must-haves
            T01-SUMMARY.md    ← o que foi feito + evidência
```
