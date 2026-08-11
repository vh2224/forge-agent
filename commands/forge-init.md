---
description: "Inicializa o Forge Agent no projeto atual. Detecta projeto gsd-pi existente ou cria estrutura nova. Configura o fragment-store layout (.gsd/ledger/, .gsd/decisions/, .gsd/memory/) com ignore rules para os caches de projeção. Use: /forge-init | /forge-init <descrição do projeto>"
allowed-tools: Read, Write, Edit, Bash, Glob, AskUserQuestion
---

You are initializing Forge Agent support for the current project directory. Follow the detection flow below exactly.

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

## Step 1.5: Git guarantee

Run this check once, before routing (covers both Case A and Case B below):

```bash
git rev-parse --git-dir 2>/dev/null
```

If it succeeds (exit 0 — the current directory or an ancestor is already a git repo), do nothing and proceed to Step 2.

If it fails (no git anywhere in the tree), use `AskUserQuestion` with two options:
- **Inicializar git agora (Recommended)** — sidecar multi-LLM, isolation e review dialético dependem de git.
- **Seguir sem git** — recursos degradados.

If the user approves initialization:
```bash
git init -b main
```
- Create `.gitignore` **only if it does not already exist** (`[ -f .gitignore ] || ...` — NEVER overwrite an existing `.gitignore`), with a minimal set: `node_modules/`, `dist/`, `.env*`, `*.log`.
- Create an initial commit `chore: initial commit` **only** if the repo was just created (no existing commits — `git rev-parse --verify HEAD` fails before the commit), staging explicitly with `git add -A` (run AFTER the `.gitignore` is in place, so `node_modules/`, `dist/`, `.env*`, `*.log` are already excluded from the snapshot). This initial commit snapshots the current tree minus the ignores above — nothing more.

If the user declines, print a one-line warning listing degraded features: sidecar codex (START_SHA/reset/files_changed), isolation branch/worktree, `auto_commit`, review dialético diffs (`git diff`).

---

## Step 2: Route based on detection

### Case A: `.gsd/` exists (existing gsd-pi project)

<!-- Compatibilidade: este fluxo não lê conteúdo dos prefs .md legados; apenas preserva arquivos existentes. -->

The project is already managed by gsd-pi. Your job is to:

1. **Read current state:**
   - `.gsd/STATE.md` — where are we?
   - `.gsd/PROJECT.md` — what is this project?
   - Active `M###-ROADMAP.md` (if milestone active)

2. **Create or update `CLAUDE.md`** in project root (see template below)
   - If CLAUDE.md already exists: add the GSD section only if not already present

3. **Create `.gsd/AUTO-MEMORY.md`** if it doesn't exist (empty, with header only)

4. **Create `.gsd/forge-prefs.jsonc`** only when no preferences file exists yet:
   - If `.gsd/forge-prefs.jsonc`, `.gsd/claude-agent-prefs.md`, or `.gsd/prefs.local.md` already exists, preserve it and do not force a migration. Migration of legacy preferences belongs to `/forge-update`.
   - Otherwise, create the curated local preferences scaffold with:
     ```bash
     FORGE_SCRIPTS_DIR=$([ -f scripts/forge-prefs.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
     node "$FORGE_SCRIPTS_DIR/forge-prefs.js" --setup-scaffold \
       --out .gsd/forge-prefs.jsonc
     ```
     (No `--schema-ref` — the engine auto-computes the relative path from `.gsd/forge-prefs.jsonc` to the installed `~/.claude/forge-prefs.schema.json`.)
   - If `node` is unavailable, report that the scaffold was skipped. Do not recreate either legacy `.md` file.

5. **Keep existing preference files backward-compatible:** Case A does not migrate or overwrite legacy `.md` preferences. The local JSONC file is gitignored by the shared preference tooling when it is created; do not reimplement `.gitignore` editing here.
   - When step 4 creates `.gsd/forge-prefs.jsonc`, run the same helper:
     ```bash
     FORGE_SCRIPTS_DIR=$([ -f scripts/forge-prefs-migrate.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
     node -e "require('$FORGE_SCRIPTS_DIR/forge-prefs-migrate.js').ensureGitignore(process.cwd())"
     ```
   - If a JSONC or legacy preference file already exists, leave both the file and its ignore state untouched.

6. **Apply Layer 1 ignore rules** — run:
   ```bash
   node scripts/forge-ignore.js --apply
   ```
   Captures detected VCS and count of added rules for the final report.

7. **Create or update `.claude/settings.json`** — run the **Project Settings Merge** step (see below)

8. **Create or update `.gsd/CODING-STANDARDS.md`** — run the **Coding Standards Auto-Detection** step (see below)

9. **MCP Setup** — run the **MCP Setup** step (see below). Detect stack, suggest MCPs, ask user.

10. **Report:**
    ```
    ✓ Forge Agent inicializado em projeto existente

    Project: <name from PROJECT.md>
    Active milestone: M### — Title (or "none")
    Slices: X done / Y total
    Next action: <from STATE.md>
    VCS detected: <git|svn|none>
    Ignore rules added: <N> (or "(none — already up to date)")

    Files created:
    - CLAUDE.md ✓
    - .claude/settings.json ✓ (bypass permissions + MCPs)
    - .gsd/AUTO-MEMORY.md ✓
    - .gsd/forge-prefs.jsonc ✓ (created when no existing prefs were found; otherwise preserved)
    - .gsd/CODING-STANDARDS.md ✓ (auto-detected)

    MCPs configured:
    - <name>: <status> (or "nenhum MCP configurado")

    Ready. Use /gsd to advance next unit or /forge-auto for autonomous mode.
    ```

---

### Case B: No `.gsd/` — new project

1. **Gather project info:**
   - If `$ARGUMENTS` has a description → use it as project description
   - Otherwise → ask: "Descreva o projeto em 2-3 frases. O que ele faz e qual o stack principal?"

2. **Ask about git management:**
   - Ask: "Deseja que o Forge Agent gerencie os commits automaticamente? (sim/não)"
   - Keep the answer as the active `auto_commit` value for the local JSONC preferences scaffold.
   - `sim` → use `auto_commit=true`
   - `não` → use `auto_commit=false`
   - Git repo presence was already handled once in Step 1.5 above (git guarantee) — no need to check again here.

3. **Create `.gsd/` structure:**

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

4. **Create the curated local preferences JSONC** using the answer from step 2:
   ```bash
   FORGE_SCRIPTS_DIR=$([ -f scripts/forge-prefs.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
   node "$FORGE_SCRIPTS_DIR/forge-prefs.js" --setup-scaffold \
     --out .gsd/forge-prefs.jsonc \
     --set-active auto_commit=<true|false conforme resposta>
   ```
   (No `--schema-ref` — the engine auto-computes the relative path from `.gsd/forge-prefs.jsonc` to the installed `~/.claude/forge-prefs.schema.json`.)
   The scaffold is local and curated, and the active `auto_commit` value must be the answer selected by the user. If `node` is unavailable, report an informative fallback and skip this scaffold; global preference resolution through the engine CLI still applies. Do not recreate `.gsd/claude-agent-prefs.md` or `.gsd/prefs.local.md`.

5. **Add `.gsd/forge-prefs.jsonc` to `.gitignore` by reusing the migration helper:**
   ```bash
   FORGE_SCRIPTS_DIR=$([ -f scripts/forge-prefs-migrate.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
   node -e "require('$FORGE_SCRIPTS_DIR/forge-prefs-migrate.js').ensureGitignore(process.cwd())"
   ```
   Do not replace this with a `grep`/`echo` implementation. If `node` is unavailable, report that the helper was skipped alongside the scaffold fallback.

6. **Apply Layer 1 ignore rules** — run:
   ```bash
   node scripts/forge-ignore.js --apply
   ```
   This writes VCS ignore rules for the projection cache files (`LEDGER.md`, `DECISIONS.md`,
   `AUTO-MEMORY.md` under `.gsd/`). The fragment-store directories (`.gsd/ledger/`,
   `.gsd/decisions/`, `.gsd/memory/`, `.gsd/checker-memory/`) are created lazily on first
   write — `/forge-init` does not pre-create them. See [docs/fragment-store.md](../docs/fragment-store.md)
   for the full fragment-store + projection architecture.

   Captures detected VCS and count of added rules for the final report.

7. **Create or update `.claude/settings.json`** — run the **Project Settings Merge** step (see below)

8. **Create `.gsd/CODING-STANDARDS.md`** — run the **Coding Standards Auto-Detection** step (see below)

9. **MCP Setup** — run the **MCP Setup** step (see below). Detect stack, suggest MCPs, ask user.

10. **Report:**
    ```
    ✓ Forge Agent inicializado (projeto novo)

    Project: <name>
    Structure created: .gsd/
    VCS detected: <git|svn|none>
    Ignore rules added: <N> (or "(none — already up to date)")

    Files created:
    - CLAUDE.md
    - .claude/settings.json       ← bypass permissions + MCPs (commit this)
    - .gsd/PROJECT.md
    - .gsd/REQUIREMENTS.md
    - .gsd/DECISIONS.md
    - .gsd/STATE.md
    - .gsd/KNOWLEDGE.md
    - .gsd/AUTO-MEMORY.md
    - .gsd/CODING-STANDARDS.md    ← auto-detected coding standards
    - .gsd/forge-prefs.jsonc      ← setup inicial guiado (local, gitignored)
    .gitignore updated:
    - .gsd/forge-prefs.jsonc      ← gitignored local preferences

    MCPs configured:
    - <name>: <status> (or "nenhum MCP configurado")

    Prefs resolution order (later overrides earlier):
      1. ~/.claude/forge-agent-prefs.jsonc  (global)
      2. .gsd/forge-prefs.jsonc             (local, gitignored — sobrescreve)

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
| `/forge-doctor` | Diagnóstico e correção — valida STATE, checkboxes, arquivos e prefs. Use `--fix` para corrigir |
| `/forge-codebase` | Qualidade do codebase — estrutura, nomenclatura e responsabilidade. Use `--paths a,b` para escopo e `--fix` para correções seguras |
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

Referência completa: `/forge-help`
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
- **Test:** `{detected test command or "(none detected)"}`

`- **Test:**` is not decoration: `resolveVerifyCommand` in `scripts/forge-reverify.js` falls back to
this exact line when no stack detector matches (zero-dep projects), so omitting it leaves orchestrator
re-verification with no command to run and an unproven `environment` claim gets accepted by default.
Write ONE command inside backticks, spawnable without a shell (no quotes, globs, pipes or `$`).

## Asset Map

(pending — will be populated by forge-researcher)

## Pattern Catalog

(pending — will be populated by forge-researcher)
```

If a section has actual detected values, write them. If not, write the single-line `(pending...)` placeholder. Never leave empty tables — either fill them or replace with the pending placeholder.

---

## Project Settings Merge

Create or update `.claude/settings.json` in the project root with the Forge Agent required settings. This file is committed to the repo so every team member gets the correct settings automatically when they open the project in Claude Code.

**Logic:**

1. Read `.claude/settings.json` if it exists (parse as JSON); otherwise start with `{}`
2. Set `permissions.defaultMode = "bypassPermissions"` — required for forge-auto unattended execution
3. Preserve all other existing keys untouched
4. Write back to `.claude/settings.json`

**Minimum resulting file:**

```json
{
  "permissions": {
    "defaultMode": "bypassPermissions"
  }
}
```

**Important notes:**
- `skipDangerousModePermissionPrompt` is NOT set here — Claude Code ignores it in project settings (by design). It is set in `~/.claude/settings.json` by the Forge Agent installer (`install.sh` / `install.ps1`).
- If `.claude/` directory doesn't exist, create it.
- This file should be committed to version control so all collaborators benefit automatically.

---

## MCP Setup

Configure MCP servers for enhanced agent capabilities. Read `${FORGE_HOME:-$HOME/.forge-agent}/shared/forge-mcps.md` (the MCP catalog) for available MCPs, detection patterns, config templates, and credential safety rules.

### Step 1: Detect stack and check existing MCPs

First, check what's already configured globally:
```bash
node ~/.claude/forge-settings.js ~/.claude/settings.json --mcp-list 2>/dev/null
```

Then run the detection commands from the catalog's **Detection Logic** section to identify which project-scoped MCPs are relevant.

Also check for existing env vars:
```bash
grep -h 'DATABASE_URL\|REDIS_URL\|REDIS_HOST\|GITHUB_TOKEN' .env .env.local .env.development 2>/dev/null
```

### Step 2: Ask the user

Build a recommendation list from detection results. For each MCP in the catalog:
- **always recommended** MCPs (fetch, context7) → mark `[✓]` if not already global
- **detected** MCPs → mark `[✓]`
- **not detected** MCPs → mark `[ ]`
- **already configured globally** → mark `[✓ global]` (won't be added again)

Use AskUserQuestion to present findings:

```
MCPs para este projeto:

  [✓ global] fetch — HTTP client (já configurado globalmente)
  [✓ global] context7 — docs de libs (já configurado globalmente)
  [✓] postgres — acesso ao banco (detectado: prisma/)
      DATABASE_URL: <found in .env | "não encontrada — adicione ao .env">
  [ ] redis — filas e cache (não detectado)
  [ ] puppeteer — browser automation (não detectado)
  [ ] sqlite — banco local (não detectado)

Quais MCPs deseja configurar? Pode:
  1. Aceitar as recomendações acima
  2. Adicionar/remover da lista (ex: "sem postgres, adicionar redis")
  3. Pular — nenhum MCP por agora

Também pode adicionar MCPs depois com /forge-mcps add <nome>
```

Adapt the list based on actual detection results. Only show MCPs relevant to the detected stack.

### Step 3: Configure based on response

For each MCP the user confirmed, read its **Config** JSON from the catalog:

**Global-scoped MCPs** (fetch, context7, github):
- Check if already exists in `~/.claude/settings.json` → skip if yes
- Otherwise add to global settings:
  ```bash
  node ~/.claude/forge-settings.js ~/.claude/settings.json --mcp-add <name> '<config-from-catalog>'
  ```

**Project-scoped MCPs with credentials** (postgres, redis):
- Use the **safe config** (shell wrapper) from the catalog — NEVER put credentials in settings.json
- Verify the required env var exists in `.env`:
  - If found: print `  <ENV_VAR> encontrada em .env ✓`
  - If NOT found: warn `  ⚠ Adicione <ENV_VAR> ao .env antes de usar o MCP`
- Add to project settings:
  ```bash
  node ~/.claude/forge-settings.js .claude/settings.json --mcp-add <name> '<safe-config-from-catalog>'
  ```

**Project-scoped MCPs without credentials** (puppeteer, sqlite):
- For sqlite: ask for the database file path via AskUserQuestion
- Add to project settings using config from catalog

**Custom MCPs:**
Gather: name, command, args, env vars, has-credentials. Apply credential safety rules from catalog. Add to appropriate scope.

### Step 4: Skip option

If the user chooses to skip, do not configure any MCPs. Print:
```
  MCPs: nenhum configurado (adicione depois com /forge-mcps add)
```

---

## Local preferences (JSONC)

For a new project, `/forge-init` creates the curated `.gsd/forge-prefs.jsonc` through
`scripts/forge-prefs.js --setup-scaffold` and applies the user's `auto_commit` answer.
The file is local and gitignored. Existing legacy `.md` preferences are preserved for
backward compatibility; migration is handled by `/forge-update`.
