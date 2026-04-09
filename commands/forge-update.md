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
cd "{REPO_PATH}" && git log --oneline -1 2>/dev/null || echo "(sem git)"
```

Store as `OLD_COMMIT` (hash + message). Also store just the hash as `OLD_HASH`.

---

## Git pull (se é um repositório git)

If `.git` exists:

```bash
cd "{REPO_PATH}" && git pull 2>&1
```

- If output contains `Already up to date.` → tell user "Forge Agent já está na versão mais recente." and stop.
- If output contains `error:` or `fatal:` → show the error and stop.
- Otherwise: proceed to reinstall.

If `.git` does NOT exist: skip this step and proceed with reinstall using existing files.

---

## Capturar versão nova (depois do pull)

```bash
cd "{REPO_PATH}" && git log --oneline -1 2>/dev/null
```

Store as `NEW_COMMIT`.

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

```
══════════════════════════════════════
  Forge Agent atualizado com sucesso
══════════════════════════════════════

  De:   {OLD_COMMIT}
  Para: {NEW_COMMIT}

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

  Preferências preservadas ✓
  Para ver detalhes: git log --oneline {OLD_HASH}..HEAD
```

**Rules for the report:**
- Each description: 1-2 sentences in Portuguese, max 120 chars per line (break into 2 lines if needed)
- Focus on user impact: "Agora o X faz Y" / "Corrigido problema onde X causava Y"
- If all commits are docs/chore/ci (nothing to show), say: `Atualização interna — sem mudanças visíveis para o usuário.`
- Do NOT add extra commentary, tips, or suggestions after the report
