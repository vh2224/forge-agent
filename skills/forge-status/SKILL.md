---
name: forge-status
description: "Dashboard do projeto — milestone ativo, slices, proxima acao."
allowed-tools: Read, Glob, Bash
---

## Personal status (read-only)

Follow `shared/forge-personal-context.md` from the repository or FORGE_HOME.
No initialization writes, instruction sync, auto-memory creation, global STATE
fallback, run adoption or continue.md deletion are part of status.

```bash
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-status.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
node "$FORGE_SCRIPTS_DIR/forge-status.js" $ARGUMENTS
```

Repasse a saída verbatim. Default is personal; ID is explicit inspection without
binding; `--scope workspace` is an explicitly requested global diagnostic.
Do not append team ledger/activities to personal output or infer completion from
inactivity. Shared technical knowledge uses canonical memory/decision projections.
