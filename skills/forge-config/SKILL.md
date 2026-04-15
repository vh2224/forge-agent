---
name: forge-config
description: "Configuracoes do Forge — status line, hooks, MCPs."
disable-model-invocation: true
allowed-tools: Bash, Read, AskUserQuestion
---

## Input

$ARGUMENTS

---

## Ler estado atual

```bash
cat ~/.claude/settings.json 2>/dev/null || echo "{}"
```

Parse the JSON. Detect:
- `statusline_active`: true if `settings.statusLine.command` contains `forge-statusline.js`
- `hooks_active`: true if `settings.hooks.PreToolUse` or `PostToolUse` contains an entry with `forge-hook.js`

---

## Routing

**If $ARGUMENTS is empty or "help"** → show config dashboard (see below).

**If $ARGUMENTS is "statusline on"** → enable (see below).

**If $ARGUMENTS is "statusline off"** → disable (see below).

**If $ARGUMENTS starts with "mcps"** → strip the "mcps" prefix and follow the exact same logic as `/forge-mcps` would with the remaining arguments. For example: `mcps add github` → behave as `/forge-mcps add github`. `mcps` alone → behave as `/forge-mcps` (list). See the MCP Management section below.

**Otherwise** → show error: `Opção desconhecida: "$ARGUMENTS". Use /forge-config para ver as opções.`

---

## Dashboard (sem argumentos)

Before printing the dashboard, run the MCP list logic to gather real data:

**Step 1 — Read installed MCPs:**

```bash
echo "==GLOBAL=="
node ~/.claude/forge-settings.js ~/.claude/settings.json --mcp-list 2>/dev/null
echo "==PROJECT=="
node ~/.claude/forge-settings.js .claude/settings.json --mcp-list 2>/dev/null
```

**Step 2 — Read catalog:**

Read `~/.claude/forge-mcps.md`. Extract all MCP names from `### <name>` headings.

**Step 3 — Compute:**
- Count how many catalog MCPs are installed (N_INSTALLED)
- Count total catalog MCPs (N_TOTAL)
- Count custom MCPs not in catalog (N_CUSTOM)
- Build a quick list of installed names with ✓ and not-installed with ○

**Step 4 — Print dashboard:**

```
Forge Config
════════════════════════════════════════

  Comandos disponíveis
  ────────────────────────────────────
  /forge-config statusline on|off    Ativa/desativa status line
  /forge-config mcps                 Lista MCPs (alias de /forge-mcps)
  /forge-mcps                        Gerencia MCPs — lista, add, remove
  /forge-mcps add <nome>             Adiciona um MCP (catálogo ou custom)
  /forge-mcps remove <nome>          Remove um MCP

════════════════════════════════════════

  Status Line                      [ESTADO]
  ────────────────────────────────────
  Substitui a status line nativa do Claude Code.
  Mostra: modelo • projeto • M/S ativo • contexto %
          custo da sessão • tokens enviados/recebidos/cache

  [se ativo:]
  → /forge-config statusline off     Desativar

  [se inativo:]
  → /forge-config statusline on      Ativar

  MCPs (Model Context Protocol)    N_INSTALLED/N_TOTAL
  ────────────────────────────────────
  [For each catalog MCP, print one line:]
    ✓ fetch          Instalado (global)
    ✓ context7       Instalado (global)
    ○ github         Disponível — GitHub oficial (~70 tools)
    ○ postgres       Disponível — Schema, queries (precisa DATABASE_URL)
    ○ redis          Disponível — Filas, cache (precisa REDIS_URL)
    ○ puppeteer      Disponível — Browser automation, screenshots
    ○ sqlite         Disponível — Banco SQLite local

  [If there are custom MCPs (not in catalog), add:]
  Customizados:
    ✓ my-mcp         global

  → /forge-mcps add <nome>            Instalar um MCP
  → /forge-mcps                      Ver detalhes

════════════════════════════════════════
  Reinicie o Claude Code após qualquer alteração.
```

Replace `[ESTADO]` with `✓ ativo` (green) or `○ inativo`.
Replace `N_INSTALLED/N_TOTAL` with actual counts (e.g., `3/7 do catálogo`).

**Short descriptions for catalog MCPs** (use these when showing ○ Disponível):

| MCP | Description |
|-----|------------|
| fetch | Full HTTP client (GET, POST, PUT, DELETE) |
| context7 | Docs atualizadas de libs e frameworks |
| github | GitHub oficial (~70 tools: issues, PRs, Actions) |
| postgres | Schema, queries, migrations (precisa DATABASE_URL) |
| redis | Filas, cache, pub/sub (precisa REDIS_URL) |
| puppeteer | Automação de browser, screenshots, E2E |
| sqlite | Acesso a banco SQLite local |

For installed MCPs, show scope (global/projeto) instead of description since the user already chose to install them.

---

## Garantir que forge-settings.js está instalado

Before running any enable/disable command, check if the script exists:

```bash
test -f ~/.claude/forge-settings.js && echo "exists" || echo "missing"
```

If "missing": look for `repo_path` in `~/.claude/forge-agent-prefs.md` and copy the script:

```bash
REPO=$(grep 'repo_path:' ~/.claude/forge-agent-prefs.md 2>/dev/null | head -1 | sed 's/repo_path: *//')
if [ -n "$REPO" ] && [ -f "$REPO/scripts/merge-settings.js" ]; then
  cp "$REPO/scripts/merge-settings.js" ~/.claude/forge-settings.js && echo "installed"
else
  echo "not-found"
fi
```

If "not-found": print the error below and stop:
```
✗ forge-settings.js não encontrado.

Execute /forge-update para reinstalar os scripts do Forge Agent.
```

---

## Enable — "statusline on"

```bash
node ~/.claude/forge-settings.js ~/.claude/settings.json
```

If exit code is 0, print:
```
✓ Status line ativada

Reinicie o Claude Code para aplicar.
Visualização:
  Forge │ Claude Sonnet 4.6 │ <projeto> │ M001/S01 │ ██░░░░░░░░ 18% │ $0.0000 │ ↑0 ↓0 💾0
```

If exit code != 0, show the error output.

---

## Disable — "statusline off"

```bash
node ~/.claude/forge-settings.js ~/.claude/settings.json --remove
```

If exit code is 0, print:
```
✓ Status line desativada — status line nativa do Claude Code restaurada

Reinicie o Claude Code para aplicar.
```

If exit code != 0, show the error output.

---

## MCP Management

### Garantir que forge-settings.js está instalado

Same check as above — verify `~/.claude/forge-settings.js` exists before any MCP operation.

### Route: "mcps" (list)

If $ARGUMENTS is exactly "mcps" or "mcps list":

**Step 1 — Read what's installed:**

```bash
echo "==GLOBAL=="
node ~/.claude/forge-settings.js ~/.claude/settings.json --mcp-list 2>/dev/null
echo "==PROJECT=="
node ~/.claude/forge-settings.js .claude/settings.json --mcp-list 2>/dev/null
```

Parse the output to build a set of installed MCP names (both scopes).

**Step 2 — Read the catalog:**

Read `~/.claude/forge-mcps.md`. Extract all MCP names from `### <name>` headings.
Known catalog MCPs: `fetch`, `context7`, `github`, `postgres`, `redis`, `puppeteer`, `sqlite`.

**Step 3 — Build the unified view:**

For each catalog MCP, check if it appears in the installed set. Mark:
- `✓` — installed (show which scope: global or projeto)
- `○` — available but not installed

Print the same format as `/forge-mcps` list output.

### Route: "mcps add <name>" / "mcps remove <name>"

Follow the exact same logic as `/forge-mcps add <name>` and `/forge-mcps remove <name>` respectively.
