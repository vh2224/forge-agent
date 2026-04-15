---
name: forge-help
description: "Ajuda completa do Forge Agent — comandos, skills, agentes."
allowed-tools: Read
---

Read `~/.claude/forge-agent-prefs.md` and `.gsd/claude-agent-prefs.md` (if exists) to get current model config. Then display the following help, filling in actual values where marked.

---

Exiba exatamente este conteúdo para o usuário (substituindo os valores dinâmicos indicados):

---

## Forge Agent — Ajuda (v1.0)

Sistema de agentes Claude Code baseado no workflow GSD-2.
Hierarquia: **Milestone → Slice → Task** (iron rule: task cabe em um context window).

---

### Arquitetura v1.0

A partir da v1.0, o Forge Agent usa **3 comandos slash + skills**:

| Tipo | O que é | Como invocar |
|------|---------|--------------|
| Comando slash | `/forge`, `/forge-init`, `/forge-update` | Digitar `/forge` no Claude Code |
| Skill | Tudo o mais (`forge-auto`, `forge-status`, etc.) | Via `/forge` REPL **ou** digitando o nome diretamente |

> **Ponto de entrada recomendado:** `/forge` — REPL com menu interativo que acessa todas as funcionalidades.

---

### Inicialização

| Comando | O que faz |
|---------|-----------|
| `/forge-init` | Detecta projeto existente ou cria estrutura nova. Gera `CLAUDE.md` + `.gsd/` + prefs. Execute uma vez por projeto. |
| `/forge-init <descrição>` | Mesmo que acima, passando a descrição do projeto diretamente. |

---

### Entry point — `/forge`

```
/forge
```

REPL interativo com menu. Acesso a todas as funcionalidades sem memorizar comandos.

**Menu disponível:**
- `auto` — executa o milestone inteiro de forma autônoma
- `task` — cria e executa uma task avulsa
- `new-milestone` — planeja um novo milestone
- `sair` — fecha o REPL  *(status e help também disponíveis digitando)*

---

### Skills de execução

> Acessíveis via `/forge` REPL ou digitando o nome diretamente no Claude Code.

| Skill | O que faz |
|-------|-----------|
| `forge-auto` | **Auto mode** — executa o milestone inteiro de forma autônoma. Para em blocker ou milestone completo. |
| `forge-next` | **Step mode** — executa exatamente uma unidade e para. Ideal para revisar antes de continuar. |
| `forge-task <descrição>` | **Task autônoma** — task standalone sem milestone. Fluxo: brainstorm → discuss → research → plan → execute. |
| `forge-task --skip-brainstorm <descrição>` | Pula brainstorm — vai direto para discuss → plan → execute. |
| `forge-task --resume TASK-001` | Retoma uma task de onde parou. |

---

### Skills de planejamento

| Skill | O que faz |
|-------|-----------|
| `forge-new-milestone <descrição>` | Cria um milestone do zero. Fluxo: brainstorm → scope → discuss → plan → ROADMAP. |
| `forge-discuss <M###\|S##>` | Abre discuss para um milestone ou slice. Registra decisões no CONTEXT file. |
| `forge-add-slice <M###> <descrição>` | Adiciona um slice a um milestone existente. |
| `forge-add-task <S##> <descrição>` | Planeja uma task dentro de um slice. |

---

### Skills de visibilidade

| Skill | O que faz |
|-------|-----------|
| `forge-status` | Dashboard — milestone ativo, progresso de slices e tasks, próxima ação. |
| `forge-explain <alvo>` | Explica qualquer artefato sem modificar nada. Alvos: `M001`, `S03`, `T02`, `decisions`, `state`, `all`. |
| `forge-memories [show\|stats\|clean\|export\|inject]` | Gerencia memórias auto-aprendidas do projeto. |
| `forge-ask [resume\|close\|list]` | Modo conversa — discute ideias, captura decisões, salva sessão. |
| `forge-skills [<nome>\|--all]` | Lista skills disponíveis e detalhes de uso. |
| `forge-help` | Esta tela. |

---

### Skills de manutenção

| Skill | O que faz |
|-------|-----------|
| `forge-doctor [--fix] [--dry-run]` | Diagnóstico do projeto — valida STATE, checkboxes, arquivos. `--fix` corrige automaticamente. |
| `forge-codebase [--fix] [--dry-run] [--paths a,b]` | Qualidade do codebase — estrutura, lint, nomenclatura. `--fix` corrige o que for seguro. |

---

### Skills de configuração

| Skill | O que faz |
|-------|-----------|
| `forge-config [statusline on\|off]` | Dashboard de configurações — status line, hooks, MCPs. |
| `forge-mcps [add\|remove <nome>]` | Gerencia MCPs. Catálogo: `fetch`, `context7`, `github`, `postgres`, `redis`, `puppeteer`, `sqlite`. |
| `forge-prefs [models\|set\|skip-research\|skip-discuss\|git\|reset]` | Gerencia preferências e modelos por fase. |

---

### Comando de atualização

| Comando | O que faz |
|---------|-----------|
| `/forge-update` | Atualiza o Forge Agent (git pull + reinstala agents/commands/skills). Preserva preferências. |
| `/forge-update <caminho>` | Mesmo que acima, especificando o caminho do repositório manualmente. |

---

### Agentes especializados (invocados automaticamente)

Read `~/.claude/forge-agent-prefs.md` to get the current model for each agent, then display:

| Agente | Modelo atual | Usado em |
|--------|-------------|----------|
| `forge-discusser` | **[Phase → Agent Routing: discuss-milestone model]** | discuss-milestone, discuss-slice |
| `forge-researcher` | **[Phase → Agent Routing: research-milestone model]** | research-milestone, research-slice |
| `forge-planner` | **[Phase → Agent Routing: plan-milestone model]** | plan-milestone, plan-slice |
| `forge-executor` | **[Phase → Agent Routing: execute-task model]** | execute-task |
| `forge-completer` | **[Phase → Agent Routing: complete-slice model]** | complete-slice, complete-milestone |
| `forge-memory` | **[Phase → Agent Routing: memory-extract model]** | extração de memórias pós-unidade |

> Modelos: `opus` → `claude-opus-4-6` · `sonnet` → `claude-sonnet-4-6` · `haiku` → `claude-haiku-4-5-20251001`
> Para mudar: `forge-prefs set <fase> <modelo>`

---

### Fluxo típico de trabalho

```
1. cd /seu/projeto
2. /forge-init                     ← uma vez por projeto
3. /forge                          ← entry point de tudo
   → new-milestone <descrição>     ← criar milestone
   → auto                          ← executar de forma autônoma
      ou
   → task <descrição>              ← task pontual sem milestone
4. /forge-update                   ← atualizar o Forge Agent
```

---

### Arquivos de configuração

| Arquivo | Escopo | O que controla |
|---------|--------|----------------|
| `~/.claude/forge-agent-prefs.md` | Global | Modelos por fase, skip rules, git |
| `~/.claude/settings.json` | Global | Status line, hooks, MCPs globais |
| `.claude/settings.json` | Projeto | Bypass permissions, MCPs de projeto |
| `.gsd/claude-agent-prefs.md` | Projeto | Overrides do projeto (sobrescreve global) |
| `CLAUDE.md` | Projeto | Carregado automaticamente em toda sessão |
| `.gsd/AUTO-MEMORY.md` | Projeto | Memórias auto-aprendidas acumuladas |

---

### Estrutura `.gsd/` gerada durante execução

```
.gsd/
  STATE.md                    ← estado atual (milestone, slice, task, fase)
  DECISIONS.md                ← registro global de decisões (append-only)
  LEDGER.md                   ← resumo compacto de milestones concluídos
  PROJECT.md                  ← descrição do projeto e stack
  AUTO-MEMORY.md              ← memórias auto-aprendidas (max 50)
  CODING-STANDARDS.md         ← padrões detectados + Asset Map
  forge/
    events.jsonl              ← event log do orquestrador
    auto-mode.json            ← estado do auto-mode
  milestones/
    M001/
      M001-ROADMAP.md         ← slices com checkboxes + boundary map
      M001-CONTEXT.md         ← decisões do discuss
      M001-RESEARCH.md        ← pesquisa de codebase
      M001-SUMMARY.md         ← resumo acumulado
      slices/
        S01/
          S01-PLAN.md         ← tasks com checkboxes
          S01-CONTEXT.md      ← decisões do slice
          S01-SUMMARY.md      ← resumo ao completar
          S01-UAT.md          ← script de teste manual
          tasks/
            T01-PLAN.md       ← steps + must-haves
            T01-SUMMARY.md    ← o que foi feito + evidência
  tasks/                      ← tasks autônomas (forge-task)
    TASK-001/
      TASK-001-BRIEF.md
      TASK-001-PLAN.md
      TASK-001-SUMMARY.md
```
