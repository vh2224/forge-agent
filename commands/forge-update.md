---
description: "Atualiza o Forge Agent para a versão mais recente do repositório. Faz git pull e reinstala agents/commands/skills. Preserva suas preferências. Use: /forge-update | /forge-update /caminho/para/forge-agent"
allowed-tools: Read, Bash
---

## Encontrar o repositório

**Se `$ARGUMENTS` foi passado:** use esse caminho como repositório.

**Se não foi passado:**

Read `~/.claude/forge-agent-prefs.md` and look for:
```
repo_path: /path/to/forge-agent
```

If `repo_path` is set and non-empty → use it.

If `repo_path` is NOT set or the file doesn't exist, try to auto-detect by checking if the current working directory is a valid forge-agent repo:

```bash
test -f "$(pwd)/install.sh" && grep -q "Forge Agent\|GSD Agent" "$(pwd)/install.sh" 2>/dev/null && echo "found" || echo "not-found"
```

If "found": use `$(pwd)` as REPO_PATH and persist it:
```bash
sed -i '' "s|repo_path:.*|repo_path: $(pwd)|" ~/.claude/forge-agent-prefs.md 2>/dev/null || \
  sed -i "s|repo_path:.*|repo_path: $(pwd)|" ~/.claude/forge-agent-prefs.md 2>/dev/null || \
  echo "repo_path: $(pwd)" >> ~/.claude/forge-agent-prefs.md
```
Tell user: `repo_path detectado automaticamente: {REPO_PATH}` and continue.

If "not-found":
```
Não foi possível encontrar o repositório do Forge Agent.

Passe o caminho como argumento:
  /forge-update /caminho/para/forge-agent

Ou rode o instalador novamente para registrar o caminho:
  bash /caminho/para/forge-agent/install.sh --update
```
Stop.

---

## Verificar que é um repositório válido

```bash
test -f "{REPO_PATH}/install.sh" && echo "valid" || echo "invalid"
test -d "{REPO_PATH}/.git" && echo "git" || echo "no-git"
```

If `invalid`: tell user the path doesn't look like a forge-agent repo and stop.

---

## Capturar versão atual (antes do pull)

```bash
cd "{REPO_PATH}" && git describe --tags --always 2>/dev/null || git log --oneline -1 2>/dev/null || echo "(sem git)"
```

Store as `OLD_VERSION`. Also capture hash:
```bash
cd "{REPO_PATH}" && git rev-parse --short HEAD 2>/dev/null
```
Store as `OLD_HASH`.

---

## Git pull (se é um repositório git)

If `.git` exists:

```bash
cd "{REPO_PATH}" && git pull 2>&1
```

- If output contains `error:` or `fatal:` → show the error and stop.
- If output contains `Already up to date.` → set `GIT_UPDATED=false`. Proceed to reinstall.
- Otherwise → set `GIT_UPDATED=true`. Proceed to reinstall.

> **IMPORTANTE**: SEMPRE prosseguir com a reinstalação, mesmo quando "Already up to date."
> O repo pode estar atualizado mas os arquivos em `~/.claude/` podem estar defasados.
> A reinstalação é idempotente e leva <2s.

If `.git` does NOT exist: skip this step and proceed with reinstall using existing files.

---

## Capturar versão nova (depois do pull)

```bash
cd "{REPO_PATH}" && git describe --tags --always 2>/dev/null || git log --oneline -1 2>/dev/null
```

Store as `NEW_VERSION`.

---

## Reinstalar agents, commands e skills

Detect OS:
```bash
uname -s 2>/dev/null || echo "windows"
```

**On Linux/macOS/Git Bash (uname returns Linux or Darwin):**
```bash
bash "{REPO_PATH}/install.sh" --update 2>&1
```

**On Windows (uname fails or returns something else):**
```bash
powershell -ExecutionPolicy Bypass -File "{REPO_PATH}/install.ps1" -Update 2>&1
```

Capture and display the installer output.

---

## Atualizar .claude/settings.json do projeto atual (se for projeto forge)

After reinstalling, check if the current working directory is a forge project and update its project-level settings:

```bash
test -d "$(pwd)/.gsd" && echo "forge-project" || echo "not-forge"
```

If `forge-project`:
1. Read `.claude/settings.json` in cwd if it exists (parse as JSON); otherwise start with `{}`
2. Set `permissions.defaultMode = "bypassPermissions"`
3. Preserve all other existing keys
4. Write back — create `.claude/` directory if needed

This ensures the project gets the bypass setting even without re-running `/forge-init`.

If `not-forge`: skip silently.

---

## Invalidar cache da status line

After reinstalling, bust the version cache so the status line reflects the new
version immediately instead of waiting up to 10 minutes for cache expiry:

```bash
node -e "
const fs = require('fs'), os = require('os');
const f = os.tmpdir() + '/forge-update-check.json';
try { const c = JSON.parse(fs.readFileSync(f,'utf8')); c.ts = 0; fs.writeFileSync(f, JSON.stringify(c), 'utf8'); } catch {}
" 2>/dev/null || true
```

(This sets `ts=0` in the cache, forcing a refresh on the next prompt render.)

---

## Verificar que preferences foram preservadas

```bash
grep "repo_path" ~/.claude/forge-agent-prefs.md 2>/dev/null | head -1
```

If repo_path is gone from prefs (shouldn't happen, but just in case): re-add it:
```bash
echo "" >> ~/.claude/forge-agent-prefs.md
echo "repo_path: {REPO_PATH}" >> ~/.claude/forge-agent-prefs.md
```

---

## Gerar notas de atualização

Collect full commit messages (title + body) between old and new versions:

```bash
cd "{REPO_PATH}" && git log {OLD_HASH}..HEAD --format="===COMMIT===%n%h %s%n%b" 2>/dev/null
```

Split output by `===COMMIT===` separator. For each commit:

1. **Skip non-user-facing commits** — drop anything that does NOT affect the user's experience with `/forge-*` commands, agents, or installer:
   - `docs:`, `chore:`, `ci:` prefix → skip always
   - Title contains `[skip ci]` → skip
   - **Relevance filter:** If the commit is about CI pipelines, release workflows, changelog generation, internal tooling, GitHub Actions, or any infrastructure that the user never interacts with → skip, even if prefixed with `feat:` or `fix:`. The user doesn't need to know about internal plumbing.

2. **Classify** remaining commits by conventional commit prefix:
   - `feat:` or `feat(...):`  → **Novidades**
   - `fix:` or `fix(...):`    → **Correções**
   - `refactor:` or `refactor(...):` → **Melhorias**
   - `perf:` or `perf(...):`  → **Melhorias**

3. **Synthesize a user-facing description** from the commit body:
   - Read the full body (the paragraph after the title). It explains the WHY and WHAT in detail.
   - Write a 1-2 sentence description in Portuguese (pt-BR) that explains **what changed and why it matters to the user**. Focus on the impact, not implementation details.
   - Do NOT just repeat the commit title translated — use the body to add real context.
   - If the commit has no body (title only), use the title translated to Portuguese as fallback.
   - Strip any `Co-Authored-By` lines from the body before analyzing.

---

## Relatório final

Emit the update report in this exact format:

### If GIT_UPDATED=true (new commits pulled):

```
══════════════════════════════════════
  Forge Agent atualizado
  {OLD_VERSION} → {NEW_VERSION}
══════════════════════════════════════

─── Notas de atualização ───

{If there are entries classified as "Novidades":}
Novidades:
  - {synthesized description}
  - ...

{If there are entries classified as "Correções":}
Correções:
  - {synthesized description}
  - ...

{If there are entries classified as "Melhorias":}
Melhorias:
  - {synthesized description}
  - ...

─────────────────────────────

  ✓ Preferências preservadas
  ✓ Comandos atualizados — já ativos nesta sessão
  ⚠ Se um comando NOVO foi adicionado, reinicie o Claude Code para que apareça no autocomplete
```

### If GIT_UPDATED=false (already up to date, but reinstalled):

```
══════════════════════════════════════
  Forge Agent {NEW_VERSION}
══════════════════════════════════════
  Código já atualizado — arquivos reinstalados.

  ✓ Comandos, agents e skills sincronizados
  ✓ Preferências preservadas
```

**Rules for the report:**
- Each description: 1-2 sentences in Portuguese, max 120 chars per line (break into 2 lines if needed)
- Focus on user impact: "Agora o X faz Y" / "Corrigido problema onde X causava Y"
- If all commits are docs/chore/ci (nothing to show), say: `Atualização interna — sem mudanças visíveis para o usuário.`
- Do NOT add extra commentary, tips, or suggestions after the report
