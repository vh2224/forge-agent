---
description: "Forge REPL — ponto de entrada unificado. Mostra status do projeto e navega por modo autônomo, tasks, milestones e ajuda."
allowed-tools: Read, Bash, Skill, AskUserQuestion, TaskCreate, TaskUpdate
---

## Bootstrap guard

```bash
ls CLAUDE.md 2>/dev/null && echo "ok" || echo "missing"
ls .gsd/STATE.md 2>/dev/null && echo "ok" || echo "missing"
pwd
```

**Se CLAUDE.md não existe:** Stop. Tell the user:
> Projeto não inicializado. Execute `/forge-init` primeiro — isso cria o `CLAUDE.md` que restaura o contexto automaticamente ao reabrir o chat.

**Se .gsd/STATE.md não existe:** Stop. Tell the user:
> Nenhum projeto GSD encontrado neste diretório. Execute `/forge-init` para começar.

---

## Load context

Read ONLY this file:
1. `.gsd/STATE.md` — store as `STATE`

> AUTO-MEMORY is NOT loaded here. It will be passed to workers at dispatch time by forge-auto/forge-task/forge-next.

From STATE extract:
- `PROJECT_NAME` ← `project` field (or filename fallback)
- `ACTIVE_MILESTONE` ← `active_milestone` field (or `—` if none)
- `NEXT_ACTION` ← `next_action` field (or `—` if none)

---

## Auto-resume detection

Check if auto-mode is already active:

```bash
cat .gsd/forge/auto-mode.json 2>/dev/null
```

If `active: true` AND `started_at` is within the last 60 minutes AND milestone is not done:
→ Emit one line: `↺ Auto-mode ativo — retomando forge-auto...`
→ Call `Skill("forge-auto")` immediately (skip the menu loop entirely)
→ After skill returns, exit

---

## REPL loop

Display one-line status then enter the menu loop. Repeat until user selects "sair".

**Status line format:**
```
forge  ·  {PROJECT_NAME}  ·  {ACTIVE_MILESTONE}  ·  {NEXT_ACTION}
```

---

### Loop iteration

At the start of EVERY iteration, run the compact recovery check:

```bash
cat .gsd/forge/compact-signal.json 2>/dev/null
```

If the file exists:
1. Re-read `.gsd/STATE.md` → update `STATE`, `PROJECT_NAME`, `ACTIVE_MILESTONE`, `NEXT_ACTION`
2. Delete the signal: `rm -f .gsd/forge/compact-signal.json`
3. Check auto-mode:
   ```bash
   cat .gsd/forge/auto-mode.json 2>/dev/null
   ```
   If `active: true` (regardless of elapsed time):
   → Emit: `↺ Recovery pós-compactação — retomando forge-auto de: {NEXT_ACTION}`
   → Call `Skill("forge-auto")` immediately — **do NOT show the menu**
   → After skill returns, continue the REPL loop normally
   
   If auto-mode is not active:
   → Emit: `↺ Recovery pós-compactação — retomando de: {NEXT_ACTION}`
   → Fall through to menu normally

If the file does not exist, skip this block entirely.

---

### Menu

After the compact recovery check, show the menu via AskUserQuestion:

```
AskUserQuestion({
  question: "forge · {PROJECT_NAME} · {ACTIVE_MILESTONE}\n{NEXT_ACTION}\n\nO que você quer fazer?",
  options: [
    "auto — modo autônomo (executa o milestone até concluir)",
    "task — criar e executar uma task avulsa",
    "new-milestone — planejar um novo milestone",
    "sair — fechar o forge  |  status · help também disponíveis"
  ]
})
```

**Dispatch based on response:**

| Response starts with | Action |
|----------------------|--------|
| `auto` | Call `Skill("forge-auto")`. After skill returns, continue loop. |
| `task` | Call `Skill("forge-task")`. After skill returns, continue loop. |
| `new-milestone` | Call `Skill("forge-new-milestone")`. After skill returns, continue loop. |
| `status` | Call `Skill("forge-status")`. After skill returns, continue loop. |
| `help` | Call `Skill("forge-help")`. After skill returns, continue loop. |
| `sair` | Deactivate auto-mode if active, then exit (see below). |

**After each skill returns**, re-read STATE.md to refresh `PROJECT_NAME`, `ACTIVE_MILESTONE`, `NEXT_ACTION`, then go back to the top of the loop (compact recovery check → menu).

---

## Exit ("sair")

Deactivate auto-mode indicator if it was active:

```bash
cat .gsd/forge/auto-mode.json 2>/dev/null | grep '"active":true' && \
  echo '{"active":false}' > .gsd/forge/auto-mode.json || true
```

Emit:
```
forge encerrado. Execute /forge para retomar a qualquer momento.
```

Stop. Do not continue the loop.
