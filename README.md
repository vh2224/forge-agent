# Forge Agent for Claude Code

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
git clone https://github.com/<seu-usuario>/forge-agent
cd forge-agent
bash install.sh
```

### Windows (PowerShell)

```powershell
git clone https://github.com/<seu-usuario>/forge-agent
cd forge-agent
.\install.ps1
```

O instalador copia os agentes e comandos para `~/.claude/agents/` e `~/.claude/commands/`.  
Suas preferências existentes **não são sobrescritas**.

### Verificar instalação

Abra qualquer projeto com o Claude Code e digite:

```
/forge-help
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
/forge-init minha plataforma de e-commerce com Next.js e Stripe
```

O agente detecta a stack, cria a estrutura `.gsd/` e o `CLAUDE.md`. A partir daí, toda sessão neste diretório carrega o contexto GSD automaticamente.

```
/forge-new-milestone autenticação de usuários com NextAuth
```

O agente faz perguntas sobre decisões de arquitetura, planeja os slices, decompõe em tasks e está pronto para executar.

```
/forge-auto
```

Executa o milestone inteiro de forma autônoma.

---

### Projeto existente (gsd-pi)

Se o projeto já tem `.gsd/` gerenciado pelo gsd-pi:

```bash
cd /projeto-existente
claude
/forge-init
```

Detecta o estado atual, cria o `CLAUDE.md` e os arquivos de suporte sem tocar no `.gsd/` existente.

---

## Comandos

### Inicialização

| Comando | O que faz |
|---------|-----------|
| `/forge-init` | Inicializa o projeto. Detecta `.gsd/` existente (gsd-pi) ou cria estrutura nova. Gera `CLAUDE.md`, `AUTO-MEMORY.md` e `claude-agent-prefs.md`. |
| `/forge-init <descrição>` | Mesmo que acima, passando a descrição do projeto direto para pular a pergunta inicial. |

### Execução

| Comando | O que faz |
|---------|-----------|
| `/forge-next` | **Step mode** — executa uma unidade (task, slice ou fase) e para. Ideal para revisar antes de continuar. |
| `/forge-auto` | **Auto mode** — executa o milestone inteiro de forma autônoma, sem parar entre unidades. Para em blocker ou milestone completo. |

### Planejamento

| Comando | Exemplo | O que faz |
|---------|---------|-----------|
| `/forge-new-milestone` | `/forge-new-milestone sistema de pagamentos com Stripe` | Cria milestone completo: discuss → plan → ROADMAP com slices e boundary map. |
| `/forge-discuss` | `/forge-discuss M002` ou `/forge-discuss S03` | Fase de discuss para milestone ou slice específico. Pergunta sobre gray areas e registra decisões. |
| `/forge-add-slice` | `/forge-add-slice M002 webhook de pagamentos` | Adiciona slice ao milestone com tasks planejadas e T##-PLAN.md. |
| `/forge-add-task` | `/forge-add-task S03 validar assinatura do webhook` | Planeja task específica com steps e must-haves. |

### Visibilidade

| Comando | Exemplo | O que faz |
|---------|---------|-----------|
| `/forge-status` | `/forge-status` | Dashboard: milestone ativo, progresso de slices/tasks, próxima ação. |
| `/forge-codebase` | `/forge-codebase` | Qualidade do codebase — estrutura, nomenclatura e responsabilidade. Use `--paths a,b` para escopo e `--fix` para correções seguras. |
| `/forge-explain` | `/forge-explain M002` · `/forge-explain S03` · `/forge-explain decisions` | Explica qualquer artefato sem modificar nada. Aceita: `M###`, `S##`, `T##`, `decisions`, `state`, `all`. |
| `/forge-memories` | `/forge-memories` · `/forge-memories stats` | Gerencia memórias auto-aprendidas. Sub-comandos: `show`, `stats`, `clean`, `export`, `inject`. |
| `/forge-help` | `/forge-help` | Ajuda completa com todos os comandos, agentes e arquivos. |

### Configuração

| Comando | Exemplo | O que faz |
|---------|---------|-----------|
| `/forge-config` | `/forge-config` | Mostra todas as opções de configuração do Forge e seu estado atual. |
| `/forge-config statusline on` | `/forge-config statusline on` | Ativa a status line do Forge no Claude Code (substitui a nativa). |
| `/forge-config statusline off` | `/forge-config statusline off` | Desativa a status line e restaura a nativa do Claude Code. |
| `/forge-prefs` | `/forge-prefs` | Mostra configuração atual de modelos, skip rules e git. |
| `/forge-prefs set` | `/forge-prefs set research haiku` | Muda o modelo de uma fase. |
| `/forge-prefs skip-research` | `/forge-prefs skip-research true` | Ativa/desativa o skip da fase de research. |
| `/forge-prefs git` | `/forge-prefs git auto_push true` | Altera configuração de git. |
| `/forge-prefs reset` | `/forge-prefs reset` | Restaura todos os padrões. |

---

## Agentes e modelos

Cada fase tem um agente dedicado com modelo configurável:

| Agente | Modelo padrão | Fase | Por que este modelo |
|--------|--------------|------|---------------------|
| `forge-discusser` | **Opus** | discuss | Precisa entender nuance de requisitos e trade-offs |
| `forge-researcher` | **Opus** | research | Análise profunda de codebase e identificação de riscos |
| `forge-planner` | **Opus** | plan | Decomposição arquitetural, boundary maps, task sizing |
| `forge-executor` | **Sonnet** | execute | Implementação eficiente, boa relação custo/qualidade |
| `forge-completer` | **Sonnet** | complete | Síntese de summaries, UAT scripts, squash merge |
| `forge-worker` | **Sonnet** | step mode | Worker genérico para execução manual |
| `forge-memory` | **Haiku** | pós-unidade | Extração barata de memórias do transcript (fire-and-forget) |

Cada agente roda com **contexto isolado** — equivalente ao `ctx.newSession()` do gsd-pi. O orquestrador (`forge`) nunca acumula tokens de execução.

### Mudar modelos

```
/forge-prefs set research haiku    ← pesquisa mais barata
/forge-prefs set execute opus      ← execução com modelo pesado
```

Ou edite diretamente `~/.claude/forge-agent-prefs.md` e o frontmatter do agente correspondente em `~/.claude/agents/`.

---

## Como funciona

```
você digita /forge-auto
        │
        ▼
forge (orquestrador)
  1. lê ~/.claude/forge-agent-prefs.md  ← modelo por fase
  2. lê .gsd/claude-agent-prefs.md    ← overrides do projeto
  3. lê .gsd/STATE.md                 ← próxima unidade
  4. lê .gsd/AUTO-MEMORY.md           ← top memórias rankeadas
  5. monta prompt com arquivos inlined
        │
        ├── research? → forge-researcher (opus,   contexto fresco)
        ├── plan?     → forge-planner    (opus,   contexto fresco)
        ├── execute?  → forge-executor   (sonnet, contexto fresco)
        └── complete? → forge-completer  (sonnet, contexto fresco)
        │
        ▼
  após cada unidade:
    forge-memory (haiku) extrai memórias do transcript
    memórias rankeadas → injetadas na próxima unidade
    loop → próxima unidade
        │
        ▼
  milestone completo → relatório final
```

### Memória emergente

Após cada unidade, o `forge-memory` (Haiku) lê o transcript e extrai conhecimento durável:

```
[MEM001] (gotcha)       conf:0.95  hits:3  — watchEffect com flush:post necessário para watchers de rota no Vue 3
[MEM004] (convention)   conf:0.85  hits:2  — widgets React ficam em packages/components/react/src/widgets/
[MEM008] (architecture) conf:0.90  hits:3  — BOLT roda em WebWorker; nunca manipular WebSocket no main thread
```

Memórias são rankeadas por `confidence × (1 + hits × 0.1)`, decaem se não confirmadas, e são injetadas no prompt de cada nova unidade. O agente nunca redescobre o que já aprendeu.

---

## Perfil de engenharia (o que este agente otimiza)

- **Bytes e tokens**: contexto enxuto, arquivos de prompt pequenos, evitar inflação de tokens.
- **Performance e previsibilidade**: builds e lint consistentes (um lockfile, scripts padrão).
- **Código limpo**: responsabilidade única por arquivo, convenções de nome claras.
- **Segurança de mudanças**: correções automáticas apenas quando mecanicamente seguras.
- **Evidência**: diagnósticos que geram plano ao invés de refactors silenciosos.

---

## Skills

Skills são módulos de conhecimento especializado que o agente carrega sob demanda. São arquivos `SKILL.md` instalados em `~/.agents/skills/` (ecossistema [skills.sh](https://skills.sh), compatível com gsd-pi) e `~/.claude/skills/`.

### Skills incluídas

O instalador copia automaticamente para ambos os diretórios:

| Skill | O que faz | Quando é usada |
|-------|-----------|----------------|
| `forge-brainstorm` | Explora alternativas, riscos e limites de escopo antes de planejar | `/forge-new-milestone` (automático) |
| `forge-scope-clarity` | Gera contrato de escopo com critérios observáveis e testáveis | `/forge-new-milestone` (automático) |
| `forge-risk-radar` | Analisa riscos por slice antes da execução, para slices `risk:high` | `/forge-new-milestone`, `/forge-auto` |
| `forge-responsive` | Audit de design responsivo — breakpoints, fluid layout, mobile-first, anti-patterns | Manual ou via `/forge-codebase` |
| `forge-ui-review` | Review de componentes UI — acessibilidade (WCAG 2.1 AA), performance, arquitetura | Manual ou via `/forge-codebase` |

### Descobrir skills disponíveis

```
/forge-skills              ← lista todas as skills instaladas + integrações GSD
/forge-skills brainstorm   ← detalhes e exemplos de uma skill específica
/forge-skills --all        ← mapa completo: skill × fase × comando × flag
/forge-skills install      ← como instalar novas skills
```

### Flag `-fast` — pular skills

```bash
/forge-new-milestone autenticação OAuth         # brainstorm + scope + discuss + plan
/forge-new-milestone -fast autenticação OAuth   # só discuss + plan
/forge-discuss M003                              # com brainstorm (se disponível)
/forge-discuss -fast M003                        # discuss direto
```

### Instalar skills de outros repositórios

```bash
npx skills add odra/superpowers --skill brainstorm -y
npx skills add <repositório> --skill <nome> -y
# Detectado automaticamente pelo /forge-skills
```

### Contribuir uma skill

Coloque em `skills/<nome>/SKILL.md` seguindo o formato das skills existentes e abra um PR.

---

## Status Line

O Forge instala uma status line customizada para o Claude Code que substitui a nativa. Ela não é ativada automaticamente — você escolhe quando habilitar.

```
Forge │ Claude Sonnet 4.6 │ meu-projeto │ M001/S02 │ █████░░░░░ 47% │ $0.0042 │ ↑12k ↓3k 💾8k
✓ forge-executor: implement auth middleware  2m ago (3 units)
```

| Campo | O que mostra |
|-------|-------------|
| `Claude Sonnet 4.6` | Modelo ativo na sessão |
| `meu-projeto` | Pasta atual |
| `M001/S02` | Milestone e slice ativos (lido de `.gsd/STATE.md`) |
| `█████░░░░░ 47%` | Uso da context window |
| `$0.0042` | Custo acumulado da sessão |
| `↑12k ↓3k 💾8k` | Tokens enviados / recebidos / cache |
| Segunda linha | Último sub-agente despachado pelo forge: tipo, descrição, tempo e total de units |

A segunda linha aparece após o primeiro dispatch do forge e atualiza a cada step.

### Ativar

```
/forge-config statusline on
```

Reinicie o Claude Code para aplicar. O comando modifica apenas as chaves `statusLine` e `hooks` do `~/.claude/settings.json` — todas as suas outras configurações são preservadas.

### Desativar

```
/forge-config statusline off
```

Remove as chaves do forge do `settings.json` e restaura a status line nativa do Claude Code.

---

## Configuração

### Global — `~/.claude/forge-agent-prefs.md`

Padrões aplicados a todos os projetos. Criado pelo instalador.

```yaml
# Modelos por fase
research:   opus    → forge-researcher
planning:   opus    → forge-planner
execution:  sonnet  → forge-executor
completion: sonnet  → forge-completer
memory:     haiku   → forge-memory

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

Overrides específicos do projeto. Criado pelo `/forge-init`.

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
cd forge-agent
git pull
bash install.sh --update      # macOS/Linux — faz backup antes de atualizar
.\install.ps1 -Update         # Windows
```

O `forge-agent-prefs.md` e os arquivos de projeto (`.gsd/`) **nunca são sobrescritos** na atualização.

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
