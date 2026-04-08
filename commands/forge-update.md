---
description: "Atualiza o GSD Agent para a versão mais recente do repositório. Faz git pull e reinstala agents/commands/skills. Preserva suas preferências. Use: /forge-update | /forge-update /caminho/para/gsd-agent"
allowed-tools: Read, Bash
---

## Encontrar o repositório

**Se `$ARGUMENTS` foi passado:** use esse caminho como repositório.

**Se não foi passado:**

Read `~/.claude/forge-agent-prefs.md` and look for:
```
repo_path: /path/to/gsd-agent
```

If `repo_path` is set and non-empty → use it.

If `repo_path` is NOT set or the file doesn't exist:
```
Não foi possível encontrar o repositório do GSD Agent.

Passe o caminho como argumento:
  /forge-update /caminho/para/gsd-agent

Ou rode o instalador novamente para registrar o caminho:
  bash /caminho/para/gsd-agent/install.sh --update
```
Stop.

---

## Verificar que é um repositório válido

```bash
test -f "{REPO_PATH}/install.sh" && echo "valid" || echo "invalid"
test -d "{REPO_PATH}/.git" && echo "git" || echo "no-git"
```

If `invalid`: tell user the path doesn't look like a gsd-agent repo and stop.

---

## Mostrar versão atual

```bash
cd "{REPO_PATH}" && git log --oneline -1 2>/dev/null || echo "(sem git)"
```

Tell user: `Versão atual: {commit hash and message}`

---

## Git pull (se é um repositório git)

If `.git` exists:

```bash
cd "{REPO_PATH}" && git pull 2>&1
```

- If output contains `Already up to date.` → tell user "Já está na versão mais recente." and stop.
- If output contains `error:` or `fatal:` → show the error and stop.
- Otherwise: show what changed (lines starting with `|` or filenames in the pull output).

If `.git` does NOT exist: skip this step and proceed with reinstall using existing files.

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

## Relatório final

```
✓ GSD Agent atualizado

De:  {commit hash antes do pull}
Para: {commit hash depois do pull, ou "mesmo" se já estava atualizado}

Arquivos atualizados:
  ~/.claude/agents/forge*.md
  ~/.claude/commands/forge*.md
  ~/.claude/skills/gsd-*/SKILL.md

Preferências preservadas: ~/.claude/forge-agent-prefs.md ✓

Para ver o que mudou: git log --oneline {REPO_PATH}
```

Se o pull não encontrou mudanças, diga ao usuário que o GSD Agent já estava na versão mais recente e nenhum arquivo foi alterado.
