---
description: "Visualiza e altera configurações do Forge Agent (status line, hooks). Use: /forge-config | /forge-config statusline on | /forge-config statusline off"
allowed-tools: Bash, Read
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
