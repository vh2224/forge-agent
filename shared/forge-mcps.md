# Forge MCP Catalog

Single source of truth for available MCPs. Read by `forge-init` (detection + setup) and `forge-config` (add/remove/list).

Agents: read this file at `~/.claude/forge-mcps.md` when handling MCP operations. Do NOT inline catalog data in commands.

---

## Catalog

### fetch

- **Package:** `@anthropic-ai/mcp-server-fetch`
- **Command:** `npx`
- **Args:** `["-y", "@anthropic-ai/mcp-server-fetch"]`
- **Env:** none
- **Scope:** global
- **Credentials:** none
- **Detect:** always recommended (universal HTTP utility)
- **Config:**
  ```json
  {
    "command": "npx",
    "args": ["-y", "@anthropic-ai/mcp-server-fetch"]
  }
  ```
- **Value:** Full HTTP client — GET, POST, PUT, DELETE with headers, auth, body. More capable than native WebFetch for API testing and integration verification.

### context7

- **Package:** `@upstash/context7-mcp`
- **Command:** `npx`
- **Args:** `["-y", "@upstash/context7-mcp@latest"]`
- **Env:** none
- **Scope:** global
- **Credentials:** none
- **Detect:** always recommended (any project benefits from up-to-date library docs)
- **Config:**
  ```json
  {
    "command": "npx",
    "args": ["-y", "@upstash/context7-mcp@latest"]
  }
  ```
- **Value:** Fetches current documentation for libraries and frameworks. Prevents hallucinated APIs and outdated patterns. Essential for coding agents.

### postgres

- **Package:** `@modelcontextprotocol/server-postgres`
- **Command:** `/bin/sh` (shell wrapper for env var safety)
- **Args:** `["-c", "[ -f .env ] && set -a && . .env; exec npx -y @modelcontextprotocol/server-postgres \"$DATABASE_URL\""]`
- **Env:** `DATABASE_URL` (read from .env at runtime, never stored in settings.json)
- **Scope:** project
- **Credentials:** yes — DATABASE_URL contains connection string with password
- **Detect:**
  ```
  file_exists: prisma/schema.prisma, drizzle.config.*, knexfile.*, ormconfig.*
  dep_match: package.json → pg, typeorm, sequelize, prisma, drizzle-orm, knex
  dep_match: requirements.txt/pyproject.toml → sqlalchemy, psycopg2, django
  dir_exists: migrations/ with *.sql files
  ```
- **Config (safe — no credentials in file):**
  ```json
  {
    "command": "/bin/sh",
    "args": ["-c", "[ -f .env ] && set -a && . .env; exec npx -y @modelcontextprotocol/server-postgres \"$DATABASE_URL\""]
  }
  ```
- **Value:** Schema introspection, typed query results, migration validation. Persistent connection — agent runs N queries without reconnecting.
- **Requirement:** `DATABASE_URL` must be set in `.env` (gitignored) or shell environment.

### redis

- **Package:** `redis-mcp-server`
- **Command:** `/bin/sh` (shell wrapper for env var safety)
- **Args:** `["-c", "[ -f .env ] && set -a && . .env; exec npx -y redis-mcp-server"]`
- **Env:** `REDIS_URL` (read from .env at runtime)
- **Scope:** project
- **Credentials:** yes — REDIS_URL may contain auth credentials
- **Detect:**
  ```
  dep_match: package.json → redis, ioredis, bullmq, bull, @nestjs/bull
  dep_match: requirements.txt/pyproject.toml → redis, celery, rq
  service_match: docker-compose.yml → redis service
  env_match: .env* → REDIS_URL or REDIS_HOST
  ```
- **Config (safe — no credentials in file):**
  ```json
  {
    "command": "/bin/sh",
    "args": ["-c", "[ -f .env ] && set -a && . .env; exec npx -y redis-mcp-server"]
  }
  ```
- **Value:** Queue inspection, cache debugging, pub/sub monitoring. No need for redis-cli locally.
- **Requirement:** `REDIS_URL` must be set in `.env` (gitignored) or shell environment.

### github

- **Server:** `github/github-mcp-server` (official GitHub MCP server — Go binary)
- **Command:** `/bin/sh` (shell wrapper — auto-detects token from `gh auth`)
- **Env:** `GITHUB_PERSONAL_ACCESS_TOKEN` (auto-detected from `gh auth token`)
- **Scope:** global
- **Credentials:** yes — GitHub token (auto-detected, never stored in settings.json)
- **Detect:**
  ```
  git_remote: origin contains github.com
  ```
- **Install detection:** the agent must check which runtime is available before configuring:
  ```bash
  # Option 1: Docker (preferred — no install needed)
  docker image inspect ghcr.io/github/github-mcp-server >/dev/null 2>&1 && echo "docker-cached" || \
    (command -v docker >/dev/null 2>&1 && echo "docker-available" || echo "no-docker")
  # Option 2: Local binary
  command -v github-mcp-server >/dev/null 2>&1 && echo "binary-found" || echo "no-binary"
  # Token
  gh auth token >/dev/null 2>&1 && echo "gh-auth-ok" || echo "gh-auth-missing"
  ```
- **Config (Docker — recommended):**
  ```json
  {
    "command": "/bin/sh",
    "args": ["-c", "export GITHUB_PERSONAL_ACCESS_TOKEN=${GITHUB_PERSONAL_ACCESS_TOKEN:-$(gh auth token 2>/dev/null)}; exec docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server"]
  }
  ```
- **Config (local binary — if Docker unavailable):**
  ```json
  {
    "command": "/bin/sh",
    "args": ["-c", "export GITHUB_PERSONAL_ACCESS_TOKEN=${GITHUB_PERSONAL_ACCESS_TOKEN:-$(gh auth token 2>/dev/null)}; exec github-mcp-server stdio"]
  }
  ```
- **Binary install (if neither Docker nor binary found):**
  ```bash
  # macOS/Linux — download latest release
  ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/'); OS=$(uname -s | tr A-Z a-z)
  curl -fsSL "https://github.com/github/github-mcp-server/releases/latest/download/github-mcp-server_${OS}_${ARCH}.tar.gz" | tar xz -C /usr/local/bin github-mcp-server
  # or via Go
  go install github.com/github/github-mcp-server/cmd/github-mcp-server@latest
  ```
- **Value:** Full GitHub platform access — the most comprehensive GitHub MCP available.
- **Capabilities (19 toolsets, ~70+ tools):**

  | Toolset | Tools | What it does |
  |---------|-------|-------------|
  | **issues** | create, list, get, update, comment, search, sub-issues, labels | Full issue management |
  | **pull_requests** | create, list, get, update, merge, review, pending reviews, branch update | Full PR workflow |
  | **actions** | list workflows/runs/jobs, get details, trigger, re-run, cancel, get logs | CI/CD management |
  | **projects** | list, get, write items, fields, status updates | GitHub Projects v2 boards |
  | **repos** | create, fork, branch, files, commits, releases, tags, code search | Repository operations |
  | **discussions** | list, get, comments, categories | Community discussions |
  | **security** | code scanning, dependabot, secret scanning alerts | Security monitoring |
  | **notifications** | list, dismiss, manage subscriptions | Notification management |
  | **context** | get_me, teams, team members | User/org context |

- **Token scopes needed:**
  - `repo` — repos, issues, PRs, Actions
  - `read:org` — org info, teams
  - `read:project` or `project` — Projects v2 read/write
  - `notifications` — notification management
  - `gist` — gist operations
  - Tip: `gh auth login --scopes repo,read:org,project,notifications` to add missing scopes
- **Note:** Replaces the deprecated `@modelcontextprotocol/server-github` npm package. The old npm package had only 26 tools and no Actions/Projects support. This official server from GitHub has ~70+ tools.

### puppeteer

- **Package:** `@anthropic-ai/mcp-server-puppeteer`
- **Command:** `npx`
- **Args:** `["-y", "@anthropic-ai/mcp-server-puppeteer"]`
- **Env:** none
- **Scope:** project
- **Credentials:** none
- **Detect:**
  ```
  dep_match: package.json → puppeteer, playwright, cypress, @playwright/test
  file_exists: playwright.config.*, cypress.config.*
  ```
- **Config:**
  ```json
  {
    "command": "npx",
    "args": ["-y", "@anthropic-ai/mcp-server-puppeteer"]
  }
  ```
- **Value:** Browser automation — navigate, screenshot, interact with pages. Useful for E2E testing, visual verification, and scraping during development.

### sqlite

- **Package:** `@modelcontextprotocol/server-sqlite`
- **Command:** `npx`
- **Args:** `["-y", "@modelcontextprotocol/server-sqlite", "<db-path>"]`
- **Env:** none
- **Scope:** project
- **Credentials:** none (local file)
- **Detect:**
  ```
  dep_match: package.json → better-sqlite3, sqlite3, sql.js
  dep_match: requirements.txt/pyproject.toml → sqlite3, aiosqlite
  file_exists: *.db, *.sqlite, *.sqlite3 in project root
  ```
- **Config:**
  ```json
  {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-sqlite", "<db-path>"]
  }
  ```
- **Value:** SQLite database access — schema, queries, data inspection. No external server needed.

---

## Scope Rules

- **global** (`~/.claude/settings.json`) — MCPs useful across all projects. Not committed to git.
  - Default global: `fetch`, `context7`, `github`
- **project** (`.claude/settings.json`) — MCPs that need project-specific config. Committed to git.
  - Default project: `postgres`, `redis`, `puppeteer`, `sqlite`

## Default Scope Map

Used by forge-config and forge-init to skip scope question for known MCPs:

| MCP | Default Scope | Reason |
|-----|--------------|--------|
| fetch | global | Universal utility, no config needed |
| context7 | global | Universal utility, no config needed |
| github | global | One token works everywhere |
| postgres | project | Project-specific database |
| redis | project | Project-specific service |
| puppeteer | project | E2E testing is project-specific |
| sqlite | project | Database file is project-specific |

## Credential Safety

MCPs marked `credentials: yes` MUST NOT store secrets in `.claude/settings.json` (committed to git).

**Safe pattern for credential MCPs (postgres, redis):**
Use a shell wrapper that reads from `.env` (gitignored) at runtime:
```json
{
  "command": "/bin/sh",
  "args": ["-c", "[ -f .env ] && set -a && . .env; exec npx -y <package> \"$ENV_VAR\""]
}
```
This way `.claude/settings.json` contains only the command template, never the actual credential.

**For github:** auto-detect token via `gh auth token` at runtime using shell wrapper. No manual token setup needed if user has `gh` authenticated. The wrapper: `export GITHUB_PERSONAL_ACCESS_TOKEN=${GITHUB_PERSONAL_ACCESS_TOKEN:-$(gh auth token 2>/dev/null)}`. If `gh` is not authenticated, warn the user to run `gh auth login --scopes repo,read:org,project,notifications`.

**For non-credential MCPs:** config can be stored directly in settings.json.

## Detection Logic

Used by `forge-init` to auto-detect which MCPs to recommend.

```bash
# Postgres indicators
ls prisma/schema.prisma drizzle.config.* knexfile.* ormconfig.* 2>/dev/null
grep -l '"pg"\|"typeorm"\|"sequelize"\|"prisma"\|"drizzle-orm"\|"knex"' package.json 2>/dev/null
grep -l 'sqlalchemy\|psycopg\|django' requirements.txt pyproject.toml 2>/dev/null

# Redis indicators
grep -l '"redis"\|"ioredis"\|"bullmq"\|"bull"\|"@nestjs/bull"' package.json 2>/dev/null
grep -l 'redis\|celery\|rq' requirements.txt pyproject.toml 2>/dev/null
grep -l 'redis' docker-compose.yml docker-compose.yaml 2>/dev/null

# Puppeteer/Playwright indicators
grep -l '"puppeteer"\|"playwright"\|"cypress"\|"@playwright/test"' package.json 2>/dev/null
ls playwright.config.* cypress.config.* 2>/dev/null

# SQLite indicators
grep -l '"better-sqlite3"\|"sqlite3"\|"sql.js"' package.json 2>/dev/null
grep -l 'sqlite3\|aiosqlite' requirements.txt pyproject.toml 2>/dev/null
ls *.db *.sqlite *.sqlite3 2>/dev/null

# GitHub remote
git remote get-url origin 2>/dev/null | grep -q 'github.com' && echo "github-detected"

# GitHub runtime (for config selection)
command -v docker >/dev/null 2>&1 && echo "docker-available" || echo "no-docker"
command -v github-mcp-server >/dev/null 2>&1 && echo "github-mcp-binary" || echo "no-binary"
gh auth token >/dev/null 2>&1 && echo "gh-auth-ok" || echo "gh-auth-missing"

# Check for existing env vars
grep -h 'DATABASE_URL\|REDIS_URL\|REDIS_HOST' .env .env.local .env.development 2>/dev/null
```

## Custom MCPs

Users can add any MCP. The agent should gather:
1. MCP name (identifier)
2. Command (e.g., `npx`, `uvx`, path to binary)
3. Arguments
4. Environment variables (if any)
5. Whether it has credentials (determines if shell wrapper is needed)

Apply scope based on whether it needs credentials:
- No credentials → can go in project `.claude/settings.json`
- Has credentials → use shell wrapper pattern or global settings
