---
description: "Inicializa o agente GSD no projeto atual. Detecta projeto gsd-pi existente ou cria estrutura nova. Use: /forge-init | /forge-init <descrição do projeto>"
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

4. **Create `.gsd/claude-agent-prefs.md`** if it doesn't exist (project-level overrides, committed)

5. **Add `.gsd/prefs.local.md` to `.gitignore`** if not already present:
   ```bash
   grep -q "prefs.local.md" .gitignore 2>/dev/null || echo ".gsd/prefs.local.md" >> .gitignore
   ```

6. **Create or update `.gsd/CODING-STANDARDS.md`** — run the **Coding Standards Auto-Detection** step (see below)

7. **Report:**
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
   - .gsd/CODING-STANDARDS.md ✓ (auto-detected)

   Ready. Use /gsd to advance next unit or /forge-auto for autonomous mode.
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
   Create first milestone with /forge-new-milestone <description>
   ```

   **`.gsd/KNOWLEDGE.md`:**
   ```markdown
   # Project Knowledge

   <!-- Lessons learned, patterns, important non-obvious facts -->
   <!-- Written manually or via /forge-memories -->
   ```

   **`.gsd/AUTO-MEMORY.md`:**
   ```markdown
   <!-- gsd-auto-memory | project: <name> | extraction_count: 0 -->
   <!-- ranked by: confidence × (1 + hits × 0.1) | cap: 50 active -->
   ```

3. **Create `CLAUDE.md`** (see template below)

4. **Create `.gsd/claude-agent-prefs.md`** (project-level overrides, committed)

5. **Add `.gsd/prefs.local.md` to `.gitignore`** — personal local overrides should never be committed:
   ```bash
   # Append to .gitignore if not already present
   grep -q "prefs.local.md" .gitignore 2>/dev/null || echo ".gsd/prefs.local.md" >> .gitignore
   ```

6. **Create `.gsd/CODING-STANDARDS.md`** — run the **Coding Standards Auto-Detection** step (see below)

7. **Report:**
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
   - .gsd/CODING-STANDARDS.md    ← auto-detected coding standards
   - .gsd/claude-agent-prefs.md  ← repo shared prefs (commit this)
   .gitignore updated:
   - .gsd/prefs.local.md         ← gitignored personal overrides

   Prefs resolution order (later overrides earlier):
     1. ~/.claude/forge-agent-prefs.md  (user-global)
     2. .gsd/claude-agent-prefs.md      (repo shared)
     3. .gsd/prefs.local.md             (local personal, gitignored)

   Next: /forge-new-milestone <descrição do que entregar primeiro>
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
| `/forge-next` | Avança próxima unidade (step mode) |
| `/forge-auto` | Execução autônoma até milestone completo |
| `/forge-status` | Dashboard do projeto |
| `/forge-doctor` | Diagnóstico — valida STATE, arquivos e prefs |
| `/forge-new-milestone <desc>` | Cria novo milestone |
| `/forge-add-slice <M###> <desc>` | Adiciona slice ao milestone |
| `/forge-add-task <S##> <desc>` | Adiciona task ao slice |
| `/forge-discuss <M###\|S##>` | Discuss phase |
| `/forge-explain <M###\|S##\|T##>` | Explica qualquer artefato |
| `/forge-memories` | Gerencia memórias auto-aprendidas |
| `/forge-prefs` | Configura modelos por fase |

## Agentes especializados

- `forge-discusser` (opus) — decisões de arquitetura
- `forge-researcher` (opus) — pesquisa de codebase
- `forge-planner` (opus) — decomposição em tasks
- `forge-executor` (sonnet) — implementação
- `forge-completer` (sonnet) — summaries e git
- `forge-memory` (haiku) — extração de memórias

## Metodologia

Hierarquia: Milestone → Slice → Task (iron rule: task deve caber em um context window)

Referência completa: `~/.gsd/agent/GSD-WORKFLOW.md`
```

---

## Coding Standards Auto-Detection

This step runs for BOTH Case A and Case B. If `.gsd/CODING-STANDARDS.md` already exists, **update only the `## Detected Config` section** — preserve any user customizations in other sections.

### Detection logic

Run these checks in parallel to detect the project ecosystem:

```bash
# Package managers & configs
ls package.json pyproject.toml pom.xml build.gradle Cargo.toml go.mod Gemfile composer.json 2>/dev/null

# Lint configs
ls .eslintrc .eslintrc.* eslint.config.* .pylintrc .flake8 .golangci.yml .rubocop.yml 2>/dev/null

# Format configs
ls .prettierrc .prettierrc.* prettier.config.* .editorconfig rustfmt.toml .clang-format 2>/dev/null

# Type checking
ls tsconfig.json tsconfig.*.json mypy.ini .mypy.ini pyright*.json 2>/dev/null

# Test configs
ls jest.config.* vitest.config.* pytest.ini conftest.py .rspec 2>/dev/null
```

If `package.json` exists, read it to extract:
- `scripts.lint` → lint command
- `scripts.format` → format command
- `scripts.test` → test command
- `scripts.typecheck` or `scripts.tsc` → type check command

If `pyproject.toml` exists, look for `[tool.ruff]`, `[tool.black]`, `[tool.mypy]`, `[tool.pytest]`.

### Detect directory conventions

```bash
# Map top-level source directories
ls -d src/ lib/ app/ components/ utils/ helpers/ services/ hooks/ types/ models/ controllers/ routes/ middleware/ tests/ __tests__/ spec/ 2>/dev/null
```

Scan 2-3 source files to detect naming conventions (camelCase, snake_case, PascalCase for files/dirs).

### Write `.gsd/CODING-STANDARDS.md`

Use the template below. Fill sections with actual detected findings. For sections where nothing was detected, write `(pending — will be enriched by researcher)` as a **single line** — do NOT write multi-line HTML comments or examples.

**Important:** The generated file must be lean. Every token counts because it's injected into agent prompts. No HTML comments, no examples, no blank placeholder tables.

```markdown
# Coding Standards

## Detected Config

| Tool | Config File | Command |
|------|-------------|---------|
| {detected tool} | {config path} | {run command} |

## Directory Conventions

| Directory | Purpose | Naming |
|-----------|---------|--------|
| {detected dir} | {purpose} | {naming pattern} |

## Code Rules

### Single Responsibility
- Each file exports ONE primary responsibility (one component, one service, one utility set)
- If a file exceeds ~200 lines, consider splitting by responsibility

### Reuse Before Create
- Before creating a new utility, check the Asset Map and existing utils/helpers directories
- Shared logic used by 2+ files belongs in a common location (utils/, helpers/, lib/)
- Do NOT duplicate logic — extract and import

### Naming Conventions
(pending — will be enriched by researcher)

### Import Organization
(pending — will be enriched by researcher)

### Error Handling
- Validate at system boundaries (user input, external APIs, file I/O)
- Trust internal code and framework guarantees — don't over-validate
- Use the project's established error patterns

## Lint & Format Commands

- **Lint:** `{detected lint command or "(none detected)"}`
- **Format:** `{detected format command or "(none detected)"}`
- **Type check:** `{detected typecheck command or "(none detected)"}`

## Asset Map

(pending — will be populated by forge-researcher)

## Pattern Catalog

(pending — will be populated by forge-researcher)
```

If a section has actual detected values, write them. If not, write the single-line `(pending...)` placeholder. Never leave empty tables — either fill them or replace with the pending placeholder.

---

## `.gsd/claude-agent-prefs.md` Template (project-level overrides)

```markdown
---
# GSD Claude Agent Preferences — Project Level
# Overrides ~/.claude/forge-agent-prefs.md for this project
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
