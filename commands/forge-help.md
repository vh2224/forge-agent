---
description: "Exibe ajuda completa do agente GSD — comandos, agentes, fluxo de trabalho e configurações."
allowed-tools: Read
---

Read `~/.claude/forge-agent-prefs.md` and `.gsd/claude-agent-prefs.md` (if exists) to show current config. Then display the following help, filling in the actual current values where marked.

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
| `/forge-init` | Detecta projeto existente (gsd-pi) ou cria estrutura nova. Gera `CLAUDE.md` + `.gsd/AUTO-MEMORY.md` + `.gsd/claude-agent-prefs.md`. Execute uma vez por projeto. |
| `/forge-init <descrição>` | Mesmo que acima, mas já passa a descrição do projeto para pular a pergunta inicial. |

---

### Execução

| Comando | O que faz |
|---------|-----------|
| `/forge-next` | **Step mode** — executa exatamente uma unidade e para. Ideal para revisar antes de continuar. |
| `/forge-next` | Explícito step mode — mesmo que `/gsd`. Mais legível em scripts ou quando você quer deixar a intenção clara. |
| `/forge-auto` | **Auto mode** — executa o milestone inteiro de forma autônoma, sem pausas. Para em blocker ou milestone completo. |

---

### Planejamento

| Comando | O que faz |
|---------|-----------|
| `/forge-new-milestone <descrição>` | Cria um novo milestone do zero. Passa por discuss (captura decisões), depois planeja slices e escreve o ROADMAP completo com boundary map. |
| `/forge-discuss <M###\|S##>` | Abre a fase de discuss para um milestone ou slice específico. Faz perguntas sobre gray areas e registra decisões no CONTEXT file. Use antes de planejar quando houver dúvidas arquiteturais. |
| `/forge-add-slice <M###> <descrição>` | Adiciona um slice a um milestone existente. Planeja as tasks (T##-PLAN.md) e atualiza o ROADMAP. |
| `/forge-add-task <S##> <descrição>` | Planeja uma task específica dentro de um slice. Cria o T##-PLAN.md com steps e must-haves. |

---

### Visibilidade

| Comando | O que faz |
|---------|-----------|
| `/forge-status` | Dashboard do projeto — milestone ativo, progresso de slices e tasks, próxima ação. |
| `/forge-doctor` | Diagnóstico do projeto — valida STATE, arquivos de milestone/slice/task e prefs. Execute antes de uma run longa. |
| `/forge-explain <alvo>` | Explica qualquer artefato sem modificar nada. Alvos válidos: `M001`, `S03`, `T02`, `decisions`, `state`, `all`. |
| `/forge-memories` | Gerencia as memórias auto-aprendidas do projeto. Sub-comandos: `show` (padrão), `stats`, `clean`, `export`, `inject`. |
| `/forge-ask` | Modo conversa com o agente — discute ideias, captura decisões, salva sessão automaticamente. Se o chat cair, `/forge-ask resume` retoma. |
| `/forge-ask resume` | Retoma a última sessão de conversa aberta. |
| `/forge-ask close` | Fecha e arquiva a sessão atual com um resumo. |
| `/forge-ask list` | Lista todas as sessões salvas. |
| `/forge-skills` | Lista todas as skills disponíveis e como integrá-las com os comandos GSD. |
| `/forge-skills <nome>` | Detalhes, exemplos e flags de uma skill específica. |
| `/forge-skills --all` | Mapa completo: skill × fase GSD × comando × flag de skip. |
| `/forge-skills install` | Como instalar novas skills do ecossistema skills.sh. |
| `/forge-help` | Esta tela. |

---

### Manutenção

| Comando | O que faz |
|---------|-----------|
| `/forge-update` | Atualiza o GSD Agent para a versão mais recente (git pull + reinstala agents/commands/skills). Preserva suas preferências. |
| `/forge-update <caminho>` | Mesmo que acima, mas especificando o caminho do repositório manualmente. |

---

### Configuração

| Comando | O que faz |
|---------|-----------|
| `/forge-prefs` | Mostra configuração atual (modelos por fase, skip rules, git settings). |
| `/forge-prefs models` | Lista os modelos disponíveis com model IDs completos e recomendações de uso. |
| `/forge-prefs set <fase> <modelo>` | Muda o modelo de uma fase. Aceita alias (`opus`, `sonnet`, `haiku`) ou model ID completo (`claude-opus-4-6`). Ex: `/forge-prefs set execute claude-opus-4-6`. |
| `/forge-prefs skip-research <true\|false>` | Ativa/desativa o skip da fase de research. |
| `/forge-prefs skip-discuss <true\|false>` | Ativa/desativa o skip da fase de discuss. |
| `/forge-prefs git <chave> <valor>` | Altera configuração git. Ex: `/forge-prefs git auto_push true`. |
| `/forge-prefs reset` | Restaura todos os padrões globais. |

---

### Agentes especializados (invocados automaticamente)

Read `~/.claude/forge-agent-prefs.md` to get the current model for each agent, then display:

| Agente | Model ID atual | Usado em |
|--------|---------------|----------|
| `forge-discusser` | **[Phase → Agent Routing: discuss]** | discuss-milestone, discuss-slice |
| `forge-researcher` | **[Phase → Agent Routing: research]** | research-milestone, research-slice |
| `forge-planner` | **[Phase → Agent Routing: plan]** | plan-milestone, plan-slice |
| `forge-executor` | **[Phase → Agent Routing: execute]** | execute-task |
| `forge-completer` | **[Phase → Agent Routing: complete]** | complete-slice, complete-milestone |
| `forge-memory` | **[Phase → Agent Routing: memory]** | extração de memórias |

> Modelos disponíveis: `opus` → `claude-opus-4-6` · `sonnet` → `claude-sonnet-4-6` · `haiku` → `claude-haiku-4-5-20251001`
> Para listar detalhes: `/forge-prefs models` · Para mudar: `/forge-prefs set <fase> <modelo>`

---

### Fluxo típico de trabalho

```
1. Navegar até o projeto
2. /forge-init                        ← uma vez por projeto
3. /forge-new-milestone <descrição>   ← criar primeiro milestone
4. /forge-status                      ← ver o que foi criado
5. /gsd                             ← avançar step a step
   ou
   /forge-auto                        ← rodar tudo de uma vez
6. /forge-memories                    ← ver o que o agente aprendeu
```

---

### Arquivos de configuração

| Arquivo | Escopo | O que controla |
|---------|--------|----------------|
| `~/.claude/forge-agent-prefs.md` | Global | Modelos padrão por fase, skip rules, git |
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
