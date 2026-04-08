---
description: "Inicializa o agente GSD no projeto atual. Detecta projeto gsd-pi existente ou cria estrutura nova. Use: /gsd-init | /gsd-init <descrição do projeto>"
allowed-tools: Read, Write, Edit, Bash, Glob
---

You are initializing GSD agent support for the current project directory. Follow the detection flow below exactly.

## Input
$ARGUMENTS

---

## Step 1: Detect project state

Run these checks in parallel:

```bash
# Check for existing gsd-pi structure
ls .gsd/ 2>/dev/null
ls .gsd/STATE.md 2>/dev/null
ls .gsd/PROJECT.md 2>/dev/null
ls CLAUDE.md 2>/dev/null
```

---

## Step 2: Route based on detection

### Case A: `.gsd/` exists (existing gsd-pi project)

The project is already managed by gsd-pi. Your job is to:

1. **Read current state:**
   - `.gsd/STATE.md` — where are we?
   - `.gsd/PROJECT.md` — what is this project?
   - Active `M###-ROADMAP.md` (if milestone active)

2. **Create or update `CLAUDE.md`** in project root (see template below)
   - If CLAUDE.md already exists: add the GSD section only if not already present

3. **Create `.gsd/AUTO-MEMORY.md`** if it doesn't exist (empty, with header only)

4. **Create `.gsd/claude-agent-prefs.md`** if it doesn't exist (project-level overrides)

5. **Report:**
   ```
   ✓ GSD agent initialized on existing project

   Project: <name from PROJECT.md>
   Active milestone: M### — Title (or "none")
   Slices: X done / Y total
   Next action: <from STATE.md>

   Files created:
   - CLAUDE.md ✓
   - .gsd/AUTO-MEMORY.md ✓
   - .gsd/claude-agent-prefs.md ✓

   Ready. Use /gsd to advance next unit or /gsd-auto for autonomous mode.
   ```

---

### Case B: No `.gsd/` — new project

1. **Gather project info:**
   - If `$ARGUMENTS` has a description → use it as project description
   - Otherwise → ask: "Descreva o projeto em 2-3 frases. O que ele faz e qual o stack principal?"

2. **Create `.gsd/` structure:**

   **`.gsd/PROJECT.md`:**
   ```markdown
   # Project: <name>

   <description from user or inferred from codebase>

   ## Stack
   <detect from package.json, requirements.txt, pom.xml, etc.>

   ## Repository
   <current directory path>

   ## Initialized
   <date>
   ```

   **`.gsd/REQUIREMENTS.md`:**
   ```markdown
   # Requirements

   <!-- Add capability requirements here as they are defined -->
   <!-- Format: R### | class | status | description | why -->
   ```

   **`.gsd/DECISIONS.md`:**
   ```markdown
   # Decisions Register

   <!-- Append-only. Never edit or remove existing rows.
        To reverse a decision, add a new row that supersedes it. -->

   | # | When | Scope | Decision | Choice | Rationale | Revisable? |
   |---|------|-------|----------|--------|-----------|------------|
   ```

   **`.gsd/STATE.md`:**
   ```markdown
   # GSD State

   **Active Milestone:** none
   **Active Slice:** none
   **Active Task:** none
   **Phase:** idle

   ## Next Action
   Create first milestone with /gsd-new-milestone <description>
   ```

   **`.gsd/KNOWLEDGE.md`:**
   ```markdown
   # Project Knowledge

   <!-- Lessons learned, patterns, important non-obvious facts -->
   <!-- Written manually or via /gsd-memories -->
   ```

   **`.gsd/AUTO-MEMORY.md`:**
   ```markdown
   <!-- gsd-auto-memory | project: <name> | extraction_count: 0 -->
   <!-- ranked by: confidence × (1 + hits × 0.1) | cap: 50 active -->
   ```

3. **Create `CLAUDE.md`** (see template below)

4. **Create `.gsd/claude-agent-prefs.md`** (project-level overrides)

5. **Report:**
   ```
   ✓ GSD agent initialized (new project)

   Project: <name>
   Structure created: .gsd/

   Files created:
   - CLAUDE.md
   - .gsd/PROJECT.md
   - .gsd/REQUIREMENTS.md
   - .gsd/DECISIONS.md
   - .gsd/STATE.md
   - .gsd/KNOWLEDGE.md
   - .gsd/AUTO-MEMORY.md
   - .gsd/claude-agent-prefs.md

   Next: /gsd-new-milestone <descrição do que entregar primeiro>
   ```

---

## CLAUDE.md Template

Write this to `CLAUDE.md` (or append GSD section if file already exists):

```markdown
# GSD — Projeto gerenciado com agentes Claude

Este projeto usa o workflow GSD para planejamento e execução autônoma.

## Início de sessão obrigatório

Ao iniciar qualquer sessão neste projeto, leia em ordem:

1. `.gsd/STATE.md` — posição atual e próxima ação
2. `.gsd/milestones/<ativo>/M###-CONTEXT.md` — decisões de arquitetura do milestone
3. `.gsd/AUTO-MEMORY.md` — conhecimento auto-aprendido (se existir)

Se houver `continue.md` no slice ativo → leia, delete, retome de "Next Action".

## Comandos disponíveis

| Comando | Descrição |
|---------|-----------|
| `/gsd` | Avança próxima unidade (step mode) |
| `/gsd-auto` | Execução autônoma até milestone completo |
| `/gsd-status` | Dashboard do projeto |
| `/gsd-new-milestone <desc>` | Cria novo milestone |
| `/gsd-add-slice <M###> <desc>` | Adiciona slice ao milestone |
| `/gsd-add-task <S##> <desc>` | Adiciona task ao slice |
| `/gsd-discuss <M###\|S##>` | Discuss phase |
| `/gsd-explain <M###\|S##\|T##>` | Explica qualquer artefato |
| `/gsd-memories` | Gerencia memórias auto-aprendidas |
| `/gsd-prefs` | Configura modelos por fase |

## Agentes especializados

- `gsd-discusser` (opus) — decisões de arquitetura
- `gsd-researcher` (opus) — pesquisa de codebase
- `gsd-planner` (opus) — decomposição em tasks
- `gsd-executor` (sonnet) — implementação
- `gsd-completer` (sonnet) — summaries e git
- `gsd-memory` (haiku) — extração de memórias

## Metodologia

Hierarquia: Milestone → Slice → Task (iron rule: task deve caber em um context window)

Referência completa: `~/.gsd/agent/GSD-WORKFLOW.md`
```

---

## `.gsd/claude-agent-prefs.md` Template (project-level overrides)

```markdown
---
# GSD Claude Agent Preferences — Project Level
# Overrides ~/.claude/gsd-agent-prefs.md for this project
# Leave empty to use global defaults
version: 1
project: <project name>
---

## Phase Overrides (uncomment to override global)

<!-- execute: opus    # use opus for execution in this project -->
<!-- skip_research: true -->
<!-- skip_discuss: false -->

## Git Settings

merge_strategy: squash
main_branch: master
auto_push: false
```
