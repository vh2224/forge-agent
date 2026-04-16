---
name: forge-mcps
description: "Gerencia MCPs — lista, adiciona e remove servidores MCP."
disable-model-invocation: true
allowed-tools: Bash, Read, AskUserQuestion
---

## Input

$ARGUMENTS

---

## Pré-requisito: Claude CLI

Todas as operações usam o CLI oficial `claude mcp`. Claude Code lê MCPs do registry user-scope (`~/.claude.json`), NÃO de `~/.claude/settings.json` — por isso escrever settings.json direto não funciona.

Verifique que o CLI está disponível:

```bash
command -v claude >/dev/null && echo "ok" || echo "missing"
```

Se "missing": `✗ Claude CLI não encontrado no PATH. Instale o Claude Code antes de gerenciar MCPs.` e pare.

---

## Escopos

- **user** (global, todos os projetos) → `claude mcp add <name> -s user ...`
- **project** (commitável, `.mcp.json` na raiz) → `claude mcp add <name> -s project ...`
- **local** (só este projeto, gitignored) → `claude mcp add <name> -s local ...` (default do CLI)

---

## Routing

**Se $ARGUMENTS vazio ou "list"** → listar MCPs.

**Se $ARGUMENTS começa com "add"** → adicionar.

**Se $ARGUMENTS começa com "remove"** → remover.

**Caso contrário** → `Opção desconhecida: "$ARGUMENTS". Use /forge-mcps para ver as opções.`

---

## List (sem argumentos ou "list")

**Step 1 — Listar registrados:**

```bash
claude mcp list 2>/dev/null
```

O output inclui nome e escopo de cada MCP. Parse e construa o conjunto de nomes instalados.

**Step 2 — Ler catálogo:**

Leia `~/.claude/forge-mcps.md`. Extraia nomes de MCP dos headings `### <name>`.
Catálogo conhecido: `fetch`, `context7`, `brave-search`, `github`, `postgres`, `redis`, `puppeteer`, `sqlite`, `semgrep`, `snyk`, `trivy`.
Bundles: `security` (componentes: `semgrep`, `snyk`, `trivy`).

**Step 3 — View unificado:**

```
MCPs — Forge Agent
════════════════════════════════════════

  Configurados:
    ✓ fetch          user      Full HTTP client (GET, POST, PUT, DELETE)

  Disponíveis (não instalados):
    ○ postgres       project   Schema, queries, migrations (precisa DATABASE_URL)

  MCPs customizados (não do catálogo):
    ✓ my-custom-mcp  user      npx -y my-custom-mcp

════════════════════════════════════════
  Adicionar:  /forge-mcps add <nome>
  Remover:    /forge-mcps remove <nome>
```

**Descrições curtas:**

| MCP | Description |
|-----|------------|
| fetch | Full HTTP client (GET, POST, PUT, DELETE) |
| context7 | Docs atualizadas de libs e frameworks |
| brave-search | Busca web estruturada (precisa BRAVE_API_KEY) |
| github | GitHub oficial (~70 tools: issues, PRs, Actions) |
| postgres | Schema, queries, migrations (precisa DATABASE_URL) |
| redis | Filas, cache, pub/sub (precisa REDIS_URL) |
| puppeteer | Automação de browser, screenshots, E2E |
| sqlite | Acesso a banco SQLite local |
| semgrep | SAST — análise estática de segurança (3000+ regras) |
| snyk | All-in-one: SAST + SCA + secrets + IaC + containers |
| trivy | Scanner de vulnerabilidades: containers, filesystem, IaC |

**Bundles:**

```
  Bundles:
    ◈ security       user      SAST + SCA + containers (Semgrep, Snyk, Trivy)
      └─ semgrep ✓, snyk ○, trivy ○
```

---

## Add — "add <name>"

Extraia o nome de $ARGUMENTS (strip "add ").

Leia `~/.claude/forge-mcps.md` para saber se é MCP conhecido ou bundle.

**Se bundle (ex: "security"):**

Para cada componente:

1. Checar se já instalado (`claude mcp list | grep -q "^<name>[: ]"`)
2. Se sim → skip ("já instalado")
3. Se não → seguir fluxo individual abaixo

Handling especial:
- **semgrep:** `command -v semgrep` → se faltar, avisar: `⚠ Semgrep CLI não encontrado. Instale: brew install semgrep`
- **snyk:** `npx -y snyk@latest mcp configure --tool=claude-cli`; checar auth com `npx -y snyk@latest whoami`. Se falhar: `⚠ Snyk não autenticado. Execute: npx snyk auth`
- **trivy:** `command -v trivy` → se faltar: `⚠ Trivy CLI não encontrado. Instale: brew install trivy`. Se presente mas sem plugin: `trivy plugin install mcp`

Summary:
```
Bundle "security" — resultado:
  ✓ semgrep    adicionado (user)
  ✓ snyk       adicionado (user)
  ✓ trivy      adicionado (user)

Reinicie o Claude Code para ativar.
```

**Se MCP conhecido (no catálogo):**

1. Leia o bloco **Config** JSON e o **Scope** default do catálogo.
2. Mapeie scope do catálogo para flag do CLI: `global` → `-s user`; `project` → `-s project`.
3. Se `credentials: yes` no catálogo, verifique se a env var requerida existe em `.env`, `.env.local` ou `.env.development`. Avise se faltar, mas continue.
4. MCPs que precisam de path (sqlite): perguntar via AskUserQuestion.
5. github: checar `gh auth token`; detectar runtime docker/binário; oferecer instalação se nenhum disponível.
6. Registre com `claude mcp add-json` (aceita o JSON completo do catálogo):
   ```bash
   claude mcp add-json <name> '<config-json-from-catalog>' -s user
   ```
   Se o CLI não suportar `add-json` nessa versão, caia para forma posicional:
   ```bash
   claude mcp add <name> -s user [-e KEY=val ...] -- <command> <arg1> <arg2> ...
   ```
7. Print:
   ```
   ✓ MCP "<name>" adicionado (<scope>)

   Reinicie o Claude Code para ativar.
   ```

**Se MCP desconhecido (fora do catálogo):**

AskUserQuestion coletando:
1. Comando (ex: npx, uvx, node, python)
2. Argumentos (ex: -y @meu/mcp-server)
3. Env vars (KEY=val KEY2=val2) — ou "nenhuma"
4. Escopo: user (global) / project (commitável) / local (só aqui)

Rode:
```bash
claude mcp add <name> -s <scope> [-e KEY=val ...] -- <command> <args...>
```

---

## Remove — "remove <name>"

Extraia o nome. Checar se é bundle primeiro.

**Se bundle:** remover cada componente. Summary no fim.

**Se MCP individual:**

O CLI mostra escopo no `list`. Parse para descobrir onde está:
```bash
claude mcp list 2>/dev/null
```

Se encontrado em um único escopo:
```bash
claude mcp remove <name> -s <scope>
```

Se em múltiplos: AskUserQuestion — "MCP '<name>' em user e project. Remover de: user, project, ou ambos?"

Print:
```
✓ MCP "<name>" removido (<scope>)

Reinicie o Claude Code para aplicar.
```

Se não encontrado:
```
✗ MCP "<name>" não encontrado.

Use /forge-mcps para ver os MCPs configurados.
```
