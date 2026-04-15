---
description: "Visualiza e altera configurações do Forge Agent (status line, hooks, MCPs). Use: /forge-config | /forge-config statusline on | /forge-config mcps | /forge-config mcps add <nome>"
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

**If $ARGUMENTS starts with "mcps"** → route to MCP management (see below).

**Otherwise** → show error: `Opção desconhecida: "$ARGUMENTS". Use /forge-config para ver as opções.`

---

## Dashboard (sem argumentos)

Print:

```
Forge Config
────────────────────────────────────────

  Status Line                    [ESTADO]
  ─────────────────────────────────────
  Substitui a status line nativa do Claude Code.
  Mostra: modelo • projeto • M/S ativo • contexto %
          custo da sessão • tokens enviados/recebidos/cache
  Hooks:  registra cada dispatch do forge em tempo real

  [se ativo:]
  Para desativar:  /forge-config statusline off
  Reinicie o Claude Code para aplicar.

  [se inativo:]
  Para ativar:     /forge-config statusline on
  Reinicie o Claude Code para aplicar.

  MCPs (Model Context Protocol)
  ─────────────────────────────────────
  Globais (~/.claude/settings.json):
    [run: node ~/.claude/forge-settings.js ~/.claude/settings.json --mcp-list]

  Projeto (.claude/settings.json):
    [run: node ~/.claude/forge-settings.js .claude/settings.json --mcp-list]

  Catálogo: fetch, context7, postgres, redis, github, puppeteer, sqlite

  Gerenciar:
    /forge-config mcps               Lista MCPs configurados
    /forge-config mcps add <nome>    Adiciona um MCP do catálogo ou customizado
    /forge-config mcps remove <nome> Remove um MCP

────────────────────────────────────────
```

Replace `[ESTADO]` with `✓ ativo` (green) or `○ inativo`.

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

```bash
echo "── MCPs Globais (~/.claude/settings.json) ──"
node ~/.claude/forge-settings.js ~/.claude/settings.json --mcp-list
echo ""
echo "── MCPs do Projeto (.claude/settings.json) ──"
node ~/.claude/forge-settings.js .claude/settings.json --mcp-list
```

Print the output formatted:

```
MCPs Configurados
────────────────────────────────────────

  Globais (~/.claude/settings.json):
    <name>: <command + args>
    (or "nenhum")

  Projeto (.claude/settings.json):
    <name>: <command + args>
    (or "nenhum")

────────────────────────────────────────
Adicionar:  /forge-config mcps add <nome>
Remover:    /forge-config mcps remove <nome>
```

### Route: "mcps add <name>"

If $ARGUMENTS starts with "mcps add":

Extract the MCP name. Read `~/.claude/forge-mcps.md` (the MCP catalog) to check if it's a known MCP.

**If known MCP (found in catalog):**

1. Read the MCP's **Config** JSON and **Scope** from the catalog entry
2. Use the catalog's **default scope** automatically — do NOT ask scope question:
   - global-scoped MCPs → TARGET = `~/.claude/settings.json`
   - project-scoped MCPs → TARGET = `.claude/settings.json`
3. If the MCP has `credentials: yes` in the catalog:
   - Verify the required env var exists in `.env`, `.env.local`, or `.env.development`
   - If found: proceed (the shell wrapper in the config reads it at runtime)
   - If NOT found: warn the user:
     ```
     ⚠ <MCP> precisa de <ENV_VAR> em .env para funcionar.
       A config usa shell wrapper que lê de .env em runtime — nenhuma credencial fica em settings.json.
       Adicione a variável ao .env antes de usar.
     ```
   - Proceed with the add regardless (config is safe, just won't work until env var is set)
4. For MCPs that need a path argument (sqlite): ask for the path via AskUserQuestion
5. For github MCP — special handling:
   a. Check `gh auth token` — if fails, warn: "Execute `gh auth login --scopes repo,read:org,project,notifications` antes de usar o MCP."
   b. Detect runtime:
      ```bash
      command -v docker >/dev/null 2>&1 && echo "docker" || echo "no-docker"
      command -v github-mcp-server >/dev/null 2>&1 && echo "binary" || echo "no-binary"
      ```
   c. If Docker available → use Docker config from catalog
   d. If binary available → use binary config from catalog
   e. If neither → offer to install: "GitHub MCP precisa de Docker ou binário local. Instalar o binário? (s/n)"
      If yes: run the binary install commands from the catalog, then use binary config
      If no: skip
6. Run:
   ```bash
   node ~/.claude/forge-settings.js <TARGET> --mcp-add <name> '<config-json-from-catalog>'
   ```
7. Print:
   ```
   ✓ MCP "<name>" adicionado (<scope>)

   Reinicie o Claude Code para ativar.
   ```

**If unknown MCP (not in catalog):**

Use AskUserQuestion to gather all at once:
```
MCP "<name>" não está no catálogo. Preciso de:
1. Comando (ex: npx, uvx, node, python)
2. Argumentos (ex: -y @meu/mcp-server)
3. Variáveis de ambiente (ex: API_KEY=xxx) — ou "nenhuma"
4. Tem credenciais/senhas? (sim/não)
5. Escopo: global (todos os projetos) ou projeto (só este)?
```

- If has credentials → use shell wrapper pattern from catalog's Credential Safety section
- Build the config JSON and run:
```bash
node ~/.claude/forge-settings.js <TARGET> --mcp-add <name> '<json-config>'
```

Print result:
```
✓ MCP "<name>" adicionado (<scope>)

Reinicie o Claude Code para ativar.
```

### Route: "mcps remove <name>"

Extract the MCP name. Check which scopes have it:

```bash
node ~/.claude/forge-settings.js .claude/settings.json --mcp-list 2>/dev/null | grep -q "<name>" && echo "project-has" || echo "project-no"
node ~/.claude/forge-settings.js ~/.claude/settings.json --mcp-list 2>/dev/null | grep -q "<name>" && echo "global-has" || echo "global-no"
```

If found in both scopes, use AskUserQuestion: "MCP '<name>' encontrado em ambos os escopos. Remover de: global, projeto, ou ambos?"

If found in one scope, remove from that scope:
```bash
node ~/.claude/forge-settings.js <TARGET> --mcp-remove <name>
```

Print which scope it was removed from:
```
✓ MCP "<name>" removido (<scope>)

Reinicie o Claude Code para aplicar.
```

If not found in either:
```
✗ MCP "<name>" não encontrado em nenhum escopo.

Use /forge-config mcps para ver os MCPs configurados.
```
