# GSD Agent for Claude Code

Agentes Claude Code baseados na metodologia [GSD-2](https://github.com/gsd-build/gsd-2).

Transforma o Claude Code em um sistema de desenvolvimento autônomo: planejamento → execução → verificação → git — tudo gerenciado por agentes especializados com modelos diferentes por fase.

---

## O que é

O GSD-2 (`gsd-pi`) é um CLI que roda agentes autônomos sobre o Claude Code. Este projeto implementa o mesmo workflow **dentro** do Claude Code, usando o sistema de agentes e slash commands nativos.

**Resultado:** mesma metodologia Milestone → Slice → Task, mesma lógica de contexto fresco por unidade, mesmo sistema de memória emergente — sem instalar nada além do Claude Code.

---

## Instalação

### Pré-requisito

[Claude Code](https://claude.ai/code) instalado (`claude --version`).

### macOS / Linux / Windows (Git Bash)

```bash
git clone https://github.com/<seu-usuario>/gsd-agent
cd gsd-agent
bash install.sh
```

### Windows (PowerShell)

```powershell
git clone https://github.com/<seu-usuario>/gsd-agent
cd gsd-agent
.\install.ps1
```

### Atualizar para nova versão

```bash
git pull
bash install.sh --update      # macOS/Linux
.\install.ps1 -Update         # Windows
```

O instalador faz backup automático dos arquivos existentes antes de atualizar.

---

## Primeiros passos

### Projeto novo

```bash
cd /seu/projeto
claude
```

```
/gsd-init minha plataforma de e-commerce com Next.js e Stripe
```

### Projeto existente (gsd-pi)

```bash
cd /projeto-com-gsd
claude
```

```
/gsd-init
```

Detecta o `.gsd/` existente e cria o `CLAUDE.md` + arquivos de suporte.

### Começar a trabalhar

```
/gsd-new-milestone autenticação de usuários    ← cria milestone com discuss + plan
/gsd-auto                                       ← executa tudo até completar
```

Ou step a step:

```
/gsd                                            ← executa uma unidade e para
/gsd                                            ← continua quando quiser
```

---

## Comandos

| Comando | Descrição |
|---------|-----------|
| `/gsd-init [descrição]` | Inicializa o projeto. Detecta gsd-pi existente ou cria estrutura nova. |
| `/gsd` | Step mode — executa uma unidade e para para revisão. |
| `/gsd-auto` | Auto mode — executa o milestone inteiro de forma autônoma. |
| `/gsd-status` | Dashboard: milestone, slices, tasks, próxima ação. |
| `/gsd-new-milestone <desc>` | Cria milestone com discuss → plan automáticos. |
| `/gsd-discuss <M###\|S##>` | Captura decisões de arquitetura antes de planejar. |
| `/gsd-add-slice <M###> <desc>` | Adiciona slice com tasks planejadas ao milestone. |
| `/gsd-add-task <S##> <desc>` | Planeja uma task específica dentro de um slice. |
| `/gsd-explain <alvo>` | Explica M###, S##, T##, decisions, state ou all. |
| `/gsd-memories [show\|stats\|clean\|export\|inject]` | Gerencia memórias auto-aprendidas. |
| `/gsd-prefs [set\|show\|reset]` | Configura modelos por fase. |
| `/gsd-help` | Ajuda completa com todos os comandos e arquivos. |

---

## Agentes por fase

| Agente | Modelo padrão | Responsabilidade |
|--------|--------------|-----------------|
| `gsd-discusser` | Opus | Identifica gray areas, faz perguntas, registra decisões |
| `gsd-researcher` | Opus | Pesquisa codebase, identifica pitfalls, escreve research.md |
| `gsd-planner` | Opus | Decompõe em slices/tasks, escreve ROADMAP e T##-PLAN.md |
| `gsd-executor` | Sonnet | Implementa task, verifica must-haves, commita |
| `gsd-completer` | Sonnet | Escreve summaries, UAT, squash merge |
| `gsd-worker` | Sonnet | Worker genérico para step mode |
| `gsd-memory` | Haiku | Extrai memórias do transcript após cada unidade |

Modelos configuráveis via `/gsd-prefs set <fase> <opus|sonnet|haiku>`.

---

## Como funciona

```
/gsd-auto
    │
    ▼
gsd (orquestrador)
  lê STATE.md → determina próxima unidade
  lê AUTO-MEMORY.md → memórias rankeadas
  monta prompt com arquivos inlined
    │
    ├── research-milestone → gsd-researcher (opus,  contexto fresco)
    ├── plan-slice         → gsd-planner    (opus,  contexto fresco)
    ├── execute-task       → gsd-executor   (sonnet, contexto fresco)
    ├── complete-slice     → gsd-completer  (sonnet, contexto fresco)
    │
    ▼
  após cada unidade:
    gsd-memory (haiku) extrai memórias do transcript
    memórias rankeadas injetadas na próxima unidade
    loop até milestone completo
```

Cada agente roda com **contexto isolado** — equivalente ao `ctx.newSession()` do gsd-pi. O orquestrador não consome tokens de execução.

---

## Arquivos criados por projeto

```
CLAUDE.md                       ← carregado automaticamente pelo Claude Code
.gsd/
  STATE.md                      ← posição atual (lido em toda sessão)
  DECISIONS.md                  ← registro append-only de decisões
  PROJECT.md                    ← descrição do projeto
  AUTO-MEMORY.md                ← conhecimento auto-aprendido (cresce com uso)
  claude-agent-prefs.md         ← overrides de modelo e git por projeto
  milestones/
    M001/
      M001-ROADMAP.md
      M001-CONTEXT.md
      slices/S01/
        S01-PLAN.md
        tasks/T01-PLAN.md
        tasks/T01-SUMMARY.md
```

---

## Configuração

### Global (`~/.claude/gsd-agent-prefs.md`)

```yaml
# Altere modelos por fase:
research: opus      → gsd-researcher
planning: opus      → gsd-planner
execution: sonnet   → gsd-executor
completion: sonnet  → gsd-completer
memory: haiku       → gsd-memory
```

### Por projeto (`.gsd/claude-agent-prefs.md`)

```yaml
# Overrides só para este projeto:
skip_research: true
merge_strategy: squash
main_branch: main
```

---

## Baseado em

- [GSD-2 / gsd-pi](https://github.com/gsd-build/gsd-2) — metodologia e workflow
- [Claude Code Agents](https://claude.ai/code) — runtime de execução

---

## Licença

MIT
