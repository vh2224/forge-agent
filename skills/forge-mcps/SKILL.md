---
name: forge-mcps
description: "Gerencia MCPs — lista, adiciona e remove servidores MCP."
disable-model-invocation: true
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
    (list only MCPs that ARE installed, with scope and short description)

  Disponíveis (não instalados):
    ○ postgres       projeto   Schema, queries, migrations (precisa DATABASE_URL)
    (list only MCPs that are NOT installed)

  MCPs customizados (não do catálogo):
    ✓ my-custom-mcp  global    npx -y my-custom-mcp
    (if none, omit this section entirely)

════════════════════════════════════════
  Adicionar:  /forge-mcps add <nome>
  Remover:    /forge-mcps remove <nome>
```

**Short descriptions for catalog MCPs:**

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

**Bundles section:**

```
  Bundles:
    ◈ security       global    SAST + SCA + containers (Semgrep, Snyk, Trivy)
      └─ semgrep ✓, snyk ○, trivy ○
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
- **semgrep:** Check `command -v semgrep`. If missing, warn: `⚠ Semgrep CLI não encontrado. Instale antes de usar: brew install semgrep`
- **snyk:** Run `npx -y snyk@latest mcp configure --tool=claude-cli`. Check auth: `npx -y snyk@latest whoami 2>/dev/null`. If fails, warn: `⚠ Snyk não autenticado. Execute: npx snyk auth`
- **trivy:** Check `command -v trivy`. If missing, warn: `⚠ Trivy CLI não encontrado. Instale antes de usar: brew install trivy`. If found but plugin missing, auto-install: `trivy plugin install mcp`

After processing all components, print summary:
```
Bundle "security" — resultado:
  ✓ semgrep    adicionado (global)
  ✓ snyk       adicionado (global)
  ✓ trivy      adicionado (global)

Reinicie o Claude Code para ativar.
```

**If known MCP (found in catalog):**

1. Read the MCP's **Config** JSON and **Scope** from the catalog entry
2. Use the catalog's **default scope** automatically:
   - global-scoped MCPs → TARGET = `~/.claude/settings.json`
   - project-scoped MCPs → TARGET = `.claude/settings.json`
3. If the MCP has `credentials: yes` in the catalog, verify the required env var exists in `.env`, `.env.local`, or `.env.development`. Warn if missing but proceed.
4. For MCPs that need a path argument (sqlite): ask for the path via AskUserQuestion
5. For github MCP: check `gh auth token`; detect docker/binary runtime; offer to install if neither available.
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

Build the config JSON and run:
```bash
node ~/.claude/forge-settings.js <TARGET> --mcp-add <name> '<json-config>'
```

---

## Remove — "remove <name>"

Extract the MCP name. Check if it's a bundle first.

**If bundle:** Remove each component from its scope. Print summary.

**If individual MCP:**

Check which scopes have it:
```bash
node ~/.claude/forge-settings.js .claude/settings.json --mcp-list 2>/dev/null | grep -q "<name>" && echo "project-has" || echo "project-no"
node ~/.claude/forge-settings.js ~/.claude/settings.json --mcp-list 2>/dev/null | grep -q "<name>" && echo "global-has" || echo "global-no"
```

If found in both scopes, use AskUserQuestion: "MCP '<name>' encontrado em ambos os escopos. Remover de: global, projeto, ou ambos?"

If found in one scope:
```bash
node ~/.claude/forge-settings.js <TARGET> --mcp-remove <name>
```

Print:
```
✓ MCP "<name>" removido (<scope>)

Reinicie o Claude Code para aplicar.
```

If not found in either:
```
✗ MCP "<name>" não encontrado em nenhum escopo.

Use /forge-mcps para ver os MCPs configurados.
```
