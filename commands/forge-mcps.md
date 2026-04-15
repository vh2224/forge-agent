---
description: "Gerencia MCPs do Forge Agent — lista, adiciona e remove servidores MCP. Use: /forge-mcps | /forge-mcps add <nome> | /forge-mcps remove <nome>"
allowed-tools: Bash, Read, AskUserQuestion
---

## Input

$ARGUMENTS

---

## Garantir que forge-settings.js está instalado

Before running any operation, check if the script exists:

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

## Routing

**If $ARGUMENTS is empty or "list"** → show MCP list (see below).

**If $ARGUMENTS starts with "add"** → add MCP (see below).

**If $ARGUMENTS starts with "remove"** → remove MCP (see below).

**Otherwise** → show error: `Opção desconhecida: "$ARGUMENTS". Use /forge-mcps para ver as opções.`

---

## List (sem argumentos ou "list")

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
Known catalog MCPs: `fetch`, `context7`, `github`, `postgres`, `redis`, `puppeteer`, `sqlite`, `semgrep`, `snyk`, `trivy`.
Known bundles: `security` (components: `semgrep`, `snyk`, `trivy`).

**Step 3 — Build the unified view:**

For each catalog MCP, check if it appears in the installed set. Mark:
- `✓` — installed (show which scope: global or projeto)
- `○` — available but not installed

Print:

```
MCPs — Forge Agent
════════════════════════════════════════

  Configurados:
    ✓ fetch          global    Full HTTP client (GET, POST, PUT, DELETE)
    ✓ context7       global    Docs atualizadas de libs e frameworks
    ✓ github         global    GitHub oficial (~70 tools: issues, PRs, Actions)
    (list only MCPs that ARE installed, with scope and short description)

  Disponíveis (não instalados):
    ○ postgres       projeto   Schema, queries, migrations (precisa DATABASE_URL)
    ○ redis          projeto   Filas, cache, pub/sub (precisa REDIS_URL)
    ○ puppeteer      projeto   Automação de browser, screenshots, E2E
    ○ sqlite         projeto   Acesso a banco SQLite local
    (list only MCPs that are NOT installed)

  (if ALL catalog MCPs are installed, replace "Disponíveis" section with:)
    Todos os MCPs do catálogo estão instalados.

  (if NO MCPs are installed, replace "Configurados" section with:)
    Nenhum MCP configurado.

  MCPs customizados (não do catálogo):
    ✓ my-custom-mcp  global    npx -y my-custom-mcp
    (list any installed MCPs whose name does NOT match a catalog entry)
    (if none, omit this section entirely)

════════════════════════════════════════
  Adicionar:  /forge-mcps add <nome>
  Remover:    /forge-mcps remove <nome>
```

**Short descriptions for catalog MCPs** (use these fixed strings):

| MCP | Description |
|-----|------------|
| fetch | Full HTTP client (GET, POST, PUT, DELETE) |
| context7 | Docs atualizadas de libs e frameworks |
| github | GitHub oficial (~70 tools: issues, PRs, Actions) |
| postgres | Schema, queries, migrations (precisa DATABASE_URL) |
| redis | Filas, cache, pub/sub (precisa REDIS_URL) |
| puppeteer | Automação de browser, screenshots, E2E |
| sqlite | Acesso a banco SQLite local |
| semgrep | SAST — análise estática de segurança (3000+ regras) |
| snyk | All-in-one: SAST + SCA + secrets + IaC + containers |
| trivy | Scanner de vulnerabilidades: containers, filesystem, IaC |

**Short descriptions for bundles:**

| Bundle | Description |
|--------|------------|
| security | SAST + SCA + containers (Semgrep, Snyk, Trivy) |

When listing, show bundles in a separate section after individual MCPs:

```
  Bundles:
    ◈ security       global    SAST + SCA + containers (Semgrep, Snyk, Trivy)
      └─ semgrep ✓, snyk ○, trivy ○
    (show ✓ for installed components, ○ for missing)

  (if no bundles exist in catalog, omit this section)
```

---

## Add — "add <name>"

Extract the MCP name from $ARGUMENTS (strip "add " prefix).

Read `~/.claude/forge-mcps.md` (the MCP catalog) to check if it's a known MCP or bundle.

**If bundle (e.g., "security"):**

Read the bundle definition from the catalog. For each component in the bundle:

1. Check if already installed (via `--mcp-list`)
2. If already installed → skip, note as "já instalado"
3. If not installed → follow the individual MCP add flow below

Special handling per component:
- **semgrep:** Check `command -v semgrep`. If missing, warn:
  ```
  ⚠ Semgrep CLI não encontrado. Instale antes de usar:
    brew install semgrep   # ou: pip install semgrep
  ```
  Add the config regardless (will fail at runtime until installed).
- **snyk:** Run `npx -y snyk@latest mcp configure --tool=claude-cli` (special install).
  Check auth: `npx -y snyk@latest whoami 2>/dev/null`. If fails, warn:
  ```
  ⚠ Snyk não autenticado. Execute antes de usar:
    npx snyk auth          # free tier disponível
  ```
- **trivy:** Check `command -v trivy`. If missing, warn:
  ```
  ⚠ Trivy CLI não encontrado. Instale antes de usar:
    brew install trivy
  ```
  If found but MCP plugin missing (`trivy plugin list 2>/dev/null | grep -q mcp`), auto-install:
  ```bash
  trivy plugin install mcp
  ```
  Add the config.

After processing all components, print summary:
```
Bundle "security" — resultado:
  ✓ semgrep    adicionado (global)
  ✓ snyk       adicionado (global)
  ✓ trivy      adicionado (global)
  ─ <name>     já instalado

  ⚠ Pré-requisitos pendentes (listados acima)

Reinicie o Claude Code para ativar.
```

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

---

## Remove — "remove <name>"

Extract the MCP name. Check if it's a bundle first.

**If bundle (e.g., "security"):**

For each component in the bundle, check if installed and remove:
```bash
for name in semgrep snyk trivy; do
  node ~/.claude/forge-settings.js ~/.claude/settings.json --mcp-list 2>/dev/null | grep -q "$name" && echo "$name:global"
  node ~/.claude/forge-settings.js .claude/settings.json --mcp-list 2>/dev/null | grep -q "$name" && echo "$name:project"
done
```

Remove each found component from its scope. Print summary:
```
Bundle "security" removido:
  ✓ semgrep    removido (global)
  ✓ snyk       removido (global)
  ✓ trivy      removido (global)
  ─ <name>     não encontrado

Reinicie o Claude Code para aplicar.
```

**If individual MCP:**

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

Use /forge-mcps para ver os MCPs configurados.
```
