---
name: forge-add-slice
description: "Adiciona um slice a um milestone existente e planeja suas tasks."
allowed-tools: Read, Write, Edit, Glob
---

## Bootstrap guard (sempre executar primeiro)

Before doing anything else, run:
```bash
ls CLAUDE.md 2>/dev/null && echo "ok" || echo "missing"
ls .gsd/STATE.md 2>/dev/null && echo "ok" || echo "missing"
```

**Se CLAUDE.md não existe:** Stop and tell the user:
> Projeto não inicializado. Execute `/forge-init` primeiro — isso cria o `CLAUDE.md` que restaura o contexto automaticamente ao reabrir o chat.

**Se .gsd/STATE.md não existe:** Stop and tell the user:
> Nenhum projeto GSD encontrado neste diretório. Execute `/forge-init` para começar.

**Se `.gsd/AUTO-MEMORY.md` não existe:** Create it silently before proceeding:
```
<!-- gsd-auto-memory | project: <from PROJECT.md or directory name> | extraction_count: 0 -->
<!-- ranked by: confidence × (1 + hits × 0.1) | cap: 50 active -->
```

---


## Input
$ARGUMENTS

## Parse the input
- First token that is a valid milestone ID — `M###` legacy (e.g. `M003`) or `M-<ts>-<slug>` timestamp
  (e.g. `M-20260522143012-auth`) → milestone ID (use active milestone from STATE.md if not specified).
  If unsure whether a token is a valid milestone ID, shell out:
  `node "$FORGE_SCRIPTS_DIR/forge-ids.js" --classify <token>`
  (`legacy` or `timestamp` output both count; any non-zero exit means not a milestone ID).
- Remaining text → slice description / goal

## Your job

1. **Read milestone context:**
   - `<milestone-id>-ROADMAP.md` — existing slices, boundary map, next slice ID (S0N+1)
   - `<milestone-id>-CONTEXT.md` — architecture decisions that constrain this slice
   - `.gsd/DECISIONS.md` — locked decisions
   - Summaries of completed slices that this new slice might depend on

2. **Determine insertion point:**
   - What slice ID comes next?
   - Where does this slice fit in the dependency chain?
   - What risk level? (high/medium/low)

3. **Plan the slice:**
   - Write `S##-PLAN.md` with: Goal, Demo sentence, Must-Haves, Tasks list (1-7 tasks), Files Likely Touched
   - Write individual `T##-PLAN.md` files for each task (each must fit in one context window)
   - Each T##-PLAN.md needs: Goal, Must-Haves (Truths + Artifacts + Key Links), Steps (3-10), Context

4. **Update the milestone:**
   - Add the new slice entry to `<milestone-id>-ROADMAP.md` with `- [ ]`, risk tag, depends tag, demo sentence
   - Update the Boundary Map section with what this slice produces/consumes

5. **If this is the next slice to execute**, write `.gsd/milestones/<id>/<id>-STATE.md` (per-run state, via `scripts/forge-state.js` — never hand-edit the root `.gsd/STATE.md`, which is a generated dashboard) to point at it, then run `node scripts/forge-dashboard.js --cwd .` to regenerate the dashboard.

6. Report: slice ID, task breakdown, estimated scope
