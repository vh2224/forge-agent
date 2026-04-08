# GSD Agent for Claude Code

> Workflow de desenvolvimento autônomo para o Claude Code, baseado na metodologia e arquitetura do **[GSD-2](https://github.com/gsd-build/gsd-2)** (MIT).

Planejamento → Execução → Verificação → Git — gerenciado por agentes especializados, com modelo de linguagem diferente por fase e memória emergente que cresce a cada sessão.

> **Este projeto é uma reimplementação não-oficial da metodologia GSD-2 para o sistema nativo de agentes do Claude Code.**
> Todo o crédito pela metodologia, hierarquia Milestone → Slice → Task, estratégia de contexto fresco por unidade, sistema de memória emergente e workflow de fases (discuss → research → plan → execute → verify → summarize → advance) pertence ao projeto original [gsd-build/gsd-2](https://github.com/gsd-build/gsd-2).
> Este repositório não distribui nem modifica código do gsd-2 — apenas reimplementa os conceitos usando arquivos `.md` para o runtime de agentes do Claude Code.

---

## O que é

O [GSD-2 (`gsd-pi`)](https://github.com/gsd-build/gsd-2) é um CLI que roda agentes autônomos *sobre* o Claude Code via Pi SDK. Este projeto implementa o mesmo workflow **dentro** do Claude Code usando o sistema nativo de agentes e slash commands — sem instalar nada além do próprio Claude Code.

**O que você ganha:**

- Mesma hierarquia **Milestone → Slice → Task** do GSD-2
- Contexto fresco por unidade (cada agente roda isolado, sem acumular lixo)
- Agentes especializados por fase com modelos diferentes (Opus para pensar, Sonnet para executar)
- Memória emergente: o sistema aprende padrões e gotchas do seu projeto a cada execução
- Estratégia de git automática: branch por slice, squash merge, commits semânticos
- Tudo persistido em arquivos — recuperável após crash, auditável, versionável

---

## Pré-requisitos

- [Claude Code](https://claude.ai/code) instalado e configurado
- Git

```bash
claude --version   # deve retornar uma versão
```

---

## Instalação

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

O instalador copia os agentes e comandos para `~/.claude/agents/` e `~/.claude/commands/`.  
Suas preferências existentes **não são sobrescritas**.

### Verificar instalação

Abra qualquer projeto com o Claude Code e digite:

```
/gsd-help
```

Se listar os comandos, está instalado corretamente.

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

O agente detecta a stack, cria a estrutura `.gsd/` e o `CLAUDE.md`. A partir daí, toda sessão neste diretório carrega o contexto GSD automaticamente.

```
/gsd-new-milestone autenticação de usuários com NextAuth
```

O agente faz perguntas sobre decisões de arquitetura, planeja os slices, decompõe em tasks e está pronto para executar.

```
/gsd-auto
```

Executa o milestone inteiro de forma autônoma.

---

### Projeto existente (gsd-pi)

Se o projeto já tem `.gsd/` gerenciado pelo gsd-pi:

```bash
cd /projeto-existente
claude
/gsd-init
```

Detecta o estado atual, cria o `CLAUDE.md` e os arquivos de suporte sem tocar no `.gsd/` existente.

---

## Comandos

### Inicialização

| Comando | O que faz |
|---------|-----------|
| `/gsd-init` | Inicializa o projeto. Detecta `.gsd/` existente (gsd-pi) ou cria estrutura nova. Gera `CLAUDE.md`, `AUTO-MEMORY.md` e `claude-agent-prefs.md`. |
| `/gsd-init <descrição>` | Mesmo que acima, passando a descrição do projeto direto para pular a pergunta inicial. |

### Execução

| Comando | O que faz |
|---------|-----------|
| `/gsd` | **Step mode** — executa uma unidade (task, slice ou fase) e para. Ideal para revisar antes de continuar. |
| `/gsd-auto` | **Auto mode** — executa o milestone inteiro de forma autônoma, sem parar entre unidades. Para em blocker ou milestone completo. |

### Planejamento

| Comando | Exemplo | O que faz |
|---------|---------|-----------|
| `/gsd-new-milestone` | `/gsd-new-milestone sistema de pagamentos com Stripe` | Cria milestone completo: discuss → plan → ROADMAP com slices e boundary map. |
| `/gsd-discuss` | `/gsd-discuss M002` ou `/gsd-discuss S03` | Fase de discuss para milestone ou slice específico. Pergunta sobre gray areas e registra decisões. |
| `/gsd-add-slice` | `/gsd-add-slice M002 webhook de pagamentos` | Adiciona slice ao milestone com tasks planejadas e T##-PLAN.md. |
| `/gsd-add-task` | `/gsd-add-task S03 validar assinatura do webhook` | Planeja task específica com steps e must-haves. |

### Visibilidade

| Comando | Exemplo | O que faz |
|---------|---------|-----------|
| `/gsd-status` | `/gsd-status` | Dashboard: milestone ativo, progresso de slices/tasks, próxima ação. |
| `/gsd-explain` | `/gsd-explain M002` · `/gsd-explain S03` · `/gsd-explain decisions` | Explica qualquer artefato sem modificar nada. Aceita: `M###`, `S##`, `T##`, `decisions`, `state`, `all`. |
| `/gsd-memories` | `/gsd-memories` · `/gsd-memories stats` | Gerencia memórias auto-aprendidas. Sub-comandos: `show`, `stats`, `clean`, `export`, `inject`. |
| `/gsd-help` | `/gsd-help` | Ajuda completa com todos os comandos, agentes e arquivos. |

### Configuração

| Comando | Exemplo | O que faz |
|---------|---------|-----------|
| `/gsd-prefs` | `/gsd-prefs` | Mostra configuração atual de modelos, skip rules e git. |
| `/gsd-prefs set` | `/gsd-prefs set research haiku` | Muda o modelo de uma fase. |
| `/gsd-prefs skip-research` | `/gsd-prefs skip-research true` | Ativa/desativa o skip da fase de research. |
| `/gsd-prefs git` | `/gsd-prefs git auto_push true` | Altera configuração de git. |
| `/gsd-prefs reset` | `/gsd-prefs reset` | Restaura todos os padrões. |

---

## Agentes e modelos

Cada fase tem um agente dedicado com modelo configurável:

| Agente | Modelo padrão | Fase | Por que este modelo |
|--------|--------------|------|---------------------|
| `gsd-discusser` | **Opus** | discuss | Precisa entender nuance de requisitos e trade-offs |
| `gsd-researcher` | **Opus** | research | Análise profunda de codebase e identificação de riscos |
| `gsd-planner` | **Opus** | plan | Decomposição arquitetural, boundary maps, task sizing |
| `gsd-executor` | **Sonnet** | execute | Implementação eficiente, boa relação custo/qualidade |
| `gsd-completer` | **Sonnet** | complete | Síntese de summaries, UAT scripts, squash merge |
| `gsd-worker` | **Sonnet** | step mode | Worker genérico para execução manual |
| `gsd-memory` | **Haiku** | pós-unidade | Extração barata de memórias do transcript (fire-and-forget) |

Cada agente roda com **contexto isolado** — equivalente ao `ctx.newSession()` do gsd-pi. O orquestrador (`gsd`) nunca acumula tokens de execução.

### Mudar modelos

```
/gsd-prefs set research haiku    ← pesquisa mais barata
/gsd-prefs set execute opus      ← execução com modelo pesado
```

Ou edite diretamente `~/.claude/gsd-agent-prefs.md` e o frontmatter do agente correspondente em `~/.claude/agents/`.

---

## Como funciona

```
você digita /gsd-auto
        │
        ▼
gsd (orquestrador)
  1. lê ~/.claude/gsd-agent-prefs.md  ← modelo por fase
  2. lê .gsd/claude-agent-prefs.md    ← overrides do projeto
  3. lê .gsd/STATE.md                 ← próxima unidade
  4. lê .gsd/AUTO-MEMORY.md           ← top memórias rankeadas
  5. monta prompt com arquivos inlined
        │
        ├── research? → gsd-researcher (opus,   contexto fresco)
        ├── plan?     → gsd-planner    (opus,   contexto fresco)
        ├── execute?  → gsd-executor   (sonnet, contexto fresco)
        └── complete? → gsd-completer  (sonnet, contexto fresco)
        │
        ▼
  após cada unidade:
    gsd-memory (haiku) extrai memórias do transcript
    memórias rankeadas → injetadas na próxima unidade
    loop → próxima unidade
        │
        ▼
  milestone completo → relatório final
```

### Memória emergente

Após cada unidade, o `gsd-memory` (Haiku) lê o transcript e extrai conhecimento durável:

```
[MEM001] (gotcha)       conf:0.95  hits:3  — watchEffect com flush:post necessário para watchers de rota no Vue 3
[MEM004] (convention)   conf:0.85  hits:2  — widgets React ficam em packages/components/react/src/widgets/
[MEM008] (architecture) conf:0.90  hits:3  — BOLT roda em WebWorker; nunca manipular WebSocket no main thread
```

Memórias são rankeadas por `confidence × (1 + hits × 0.1)`, decaem se não confirmadas, e são injetadas no prompt de cada nova unidade. O agente nunca redescobre o que já aprendeu.

---

## Skills

Skills são módulos de conhecimento especializado que o agente carrega sob demanda. São arquivos `SKILL.md` instalados em `~/.agents/skills/` (ecossistema [skills.sh](https://skills.sh), compatível com gsd-pi) e `~/.claude/skills/`.

### Skills incluídas

O instalador copia automaticamente para ambos os diretórios:

| Skill | O que faz | Quando é usada |
|-------|-----------|----------------|
| `gsd-brainstorm` | Explora alternativas, riscos e limites de escopo antes de planejar | `/gsd-new-milestone` (automático) |
| `gsd-scope-clarity` | Gera contrato de escopo com critérios observáveis e testáveis | `/gsd-new-milestone` (automático) |
| `gsd-risk-radar` | Analisa riscos por slice antes da execução, para slices `risk:high` | `/gsd-new-milestone`, `/gsd-auto` |

### Descobrir skills disponíveis

```
/gsd-skills              ← lista todas as skills instaladas + integrações GSD
/gsd-skills brainstorm   ← detalhes e exemplos de uma skill específica
/gsd-skills --all        ← mapa completo: skill × fase × comando × flag
/gsd-skills install      ← como instalar novas skills
```

### Flag `-fast` — pular skills

```bash
/gsd-new-milestone autenticação OAuth         # brainstorm + scope + discuss + plan
/gsd-new-milestone -fast autenticação OAuth   # só discuss + plan
/gsd-discuss M003                              # com brainstorm (se disponível)
/gsd-discuss -fast M003                        # discuss direto
```

### Instalar skills de outros repositórios

```bash
npx skills add odra/superpowers --skill brainstorm -y
npx skills add <repositório> --skill <nome> -y
# Detectado automaticamente pelo /gsd-skills
```

### Contribuir uma skill

Coloque em `skills/<nome>/SKILL.md` seguindo o formato das skills existentes e abra um PR.

---

## Configuração

### Global — `~/.claude/gsd-agent-prefs.md`

Padrões aplicados a todos os projetos. Criado pelo instalador.

```yaml
# Modelos por fase
research:   opus    → gsd-researcher
planning:   opus    → gsd-planner
execution:  sonnet  → gsd-executor
completion: sonnet  → gsd-completer
memory:     haiku   → gsd-memory

# Skip rules
skip_discuss:        false
skip_research:       false
skip_slice_research: false

# Git
merge_strategy: squash
auto_push:      false
main_branch:    master
```

### Por projeto — `.gsd/claude-agent-prefs.md`

Overrides específicos do projeto. Criado pelo `/gsd-init`.

```yaml
# Overrides só para este projeto
# skip_research: true        ← codebase já bem conhecido
# execute: opus              ← tasks arquiteturalmente complexas
merge_strategy: squash
main_branch: main
```

---

## Arquivos criados no projeto

```
CLAUDE.md                       ← carregado automaticamente pelo Claude Code em toda sessão
.gsd/
  STATE.md                      ← posição atual (milestone/slice/task ativos, próxima ação)
  DECISIONS.md                  ← registro append-only de decisões arquiteturais
  PROJECT.md                    ← descrição do projeto e stack
  REQUIREMENTS.md               ← contrato de capacidades
  KNOWLEDGE.md                  ← conhecimento manual do projeto
  AUTO-MEMORY.md                ← memórias auto-aprendidas (cresce com o uso)
  claude-agent-prefs.md         ← overrides de modelo e git para este projeto
  milestones/
    M001/
      M001-ROADMAP.md           ← slices com checkboxes + boundary map
      M001-CONTEXT.md           ← decisões capturadas no discuss
      M001-RESEARCH.md          ← pesquisa de codebase
      M001-SUMMARY.md           ← resumo acumulado do milestone
      slices/
        S01/
          S01-PLAN.md           ← tasks com checkboxes
          S01-CONTEXT.md        ← decisões do slice
          S01-SUMMARY.md        ← resumo ao completar
          S01-UAT.md            ← script de teste manual (não-bloqueante)
          tasks/
            T01-PLAN.md         ← steps + must-haves
            T01-SUMMARY.md      ← o que foi feito + evidência de verificação
```

---

## Atualizar

```bash
cd gsd-agent
git pull
bash install.sh --update      # macOS/Linux — faz backup antes de atualizar
.\install.ps1 -Update         # Windows
```

O `gsd-agent-prefs.md` e os arquivos de projeto (`.gsd/`) **nunca são sobrescritos** na atualização.

---

## Créditos e atribuição

Este projeto reimplementa os conceitos do **[GSD-2 (gsd-pi)](https://github.com/gsd-build/gsd-2)** para o sistema nativo de agentes do Claude Code.

Os seguintes conceitos, termos e designs são originários do gsd-2 e de seus autores:

- Hierarquia **Milestone → Slice → Task** e a "iron rule" de context window
- Workflow de fases: **discuss → research → plan → execute → verify → summarize → advance**
- Estratégia de contexto fresco por unidade (`ctx.newSession()` → `Agent tool`)
- Sistema de **memória emergente** com extração pós-unidade, scoring por `confidence × (1 + hits × 0.1)`, decay e cap
- Formato dos arquivos de estado: `STATE.md`, `T##-PLAN.md`, `T##-SUMMARY.md`, `S##-PLAN.md`, `ROADMAP.md`, `DECISIONS.md`, `continue.md`
- Estratégia de git branch-per-slice com squash merge
- Tabela de dispatch por estado (discuss → research → plan → execute → complete)
- Routing dinâmico de modelos por fase (research/planning/execution/completion)
- Conceito de **boundary map** no ROADMAP
- Protocolo **continue-here** para recuperação de sessão

Este repositório **não distribui nem modifica nenhum código-fonte do gsd-2**. Apenas reimplementa os conceitos usando arquivos `.md` compatíveis com o runtime de agentes do Claude Code.

Se você usa ou gosta desta metodologia, considere também o projeto original:
**https://github.com/gsd-build/gsd-2**

---

## Licença

MIT — veja [LICENSE](LICENSE)

Este projeto é independente e não é afiliado, endossado ou patrocinado pelos autores do gsd-2.
