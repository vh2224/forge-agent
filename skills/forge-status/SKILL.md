---
name: forge-status
description: "Dashboard do projeto — milestone ativo, slices, proxima acao."
allowed-tools: Read, Glob, Bash
---

## Bootstrap guard (sempre executar primeiro)

Before doing anything else, run these in parallel:
```bash
ls CLAUDE.md 2>/dev/null && echo "ok" || echo "missing"
ls .gsd/STATE.md 2>/dev/null && echo "ok" || echo "missing"
```

```bash
REPO=$(grep 'repo_path:' ~/.claude/forge-agent-prefs.md 2>/dev/null | cut -d: -f2 | tr -d ' ')
if [ -n "$REPO" ] && [ -d "$REPO/.git" ]; then
  LOCAL=$(cd "$REPO" && git describe --tags --always 2>/dev/null)
  REMOTE=$(cd "$REPO" && git ls-remote --tags origin 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)
  echo "FORGE_VERSION=$LOCAL"
  [ -n "$REMOTE" ] && [ "$REMOTE" != "$(cd "$REPO" && git describe --tags --abbrev=0 2>/dev/null)" ] && echo "FORGE_UPDATE=$REMOTE" || echo "FORGE_UPDATE=none"
else
  echo "FORGE_VERSION=unknown"
  echo "FORGE_UPDATE=none"
fi
```

**Se CLAUDE.md não existe:** Stop and tell the user:
> Projeto não inicializado. Execute `/forge-init` primeiro — isso cria o `CLAUDE.md` que restaura o contexto automaticamente ao reabrir o chat.

**Se .gsd/STATE.md não existe:** Stop and tell the user:
> Nenhum projeto GSD encontrado neste diretório. Execute `/forge-init` para começar.

<!-- pre-S05: kept for bootstrap init — AUTO-MEMORY.md creation is a write-path init, not a monolith read; fragment-store projection is used for display. This block only runs when the file is absent (first-time setup). -->
**Se `.gsd/AUTO-MEMORY.md` não existe:** Create it silently before proceeding:
```
<!-- gsd-auto-memory | project: <from PROJECT.md or directory name> | extraction_count: 0 -->
<!-- ranked by: confidence × (1 + hits × 0.1) | cap: 50 active -->
```

---

## Run engine (pass-through cru)

```bash
if command -v forge-status >/dev/null 2>&1; then
  forge-status $ARGUMENTS
else
  ENGINE="$HOME/.claude/scripts/forge-status.js"
  [ -f "$ENGINE" ] || ENGINE="$(grep 'repo_path:' ~/.claude/forge-agent-prefs.md 2>/dev/null | cut -d: -f2 | tr -d ' ')/scripts/forge-status.js"
  node "$ENGINE" $ARGUMENTS
fi
```

**Repasse a saída do comando acima exatamente como está (verbatim) ao usuário.** NÃO resuma, NÃO reformate, NÃO re-renderize em outro layout — o engine já produz o dashboard final. Qualquer reprocessamento gasta tokens à toa e quebra o propósito zero-token desta skill.

$ARGUMENTS
