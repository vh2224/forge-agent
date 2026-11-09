---
name: forge-add-slice
description: "Adiciona um slice a um milestone existente e planeja suas tasks."
allowed-tools: Read, Write, Edit, Glob, Bash(node:*)
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

## Owner validation CLI

`Bash` is exposed only for `node`, and this skill uses it only for the owner validation gate of new plan bytes (`shared/forge-plan-gate.md § New task declarations`), the existing `forge-ids.js --classify` input check and, after admission, the existing STATE/dashboard helpers of step 6. Run no other shell command here. Each call prints one JSON line; exit 0 is `{"ok":true,...}`, exit 1 a named refusal `{"ok":false,"code","detail"}` and exit 2 a usage error:
```bash
node "$([ -f scripts/forge-plan-validation.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")/forge-plan-validation.js" begin-mutation --operation add-slice --milestone "<milestone-id>" --slice "<S##>" --task "<T01>" --task "<T02>" --owner "<absolute owner path>" --cwd "<absolute owner path>"
node "$([ -f scripts/forge-plan-validation.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")/forge-plan-validation.js" finish-mutation --ref "<mutation_ref>" --cwd "<absolute owner path>"
```
A refusal is never bypassed by writing the files anyway, editing the mutation chain or reporting the slice as ready.

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

3. **Open the owner intent before writing any plan byte:** run `begin-mutation` above with the new slice ID and one `--task` per planned task ID. Keep `mutation.mutation_ref`; the targets it lists are the only plan files this skill may write. `plan-mutation-slice-exists` means the slice already has a plan (use `/forge-add-task` instead); `plan-mutation-boundary-deferred` means stop and retry later; any other refusal code stops this skill with that code.

4. **Plan the slice:**
   - Write `S##-PLAN.md` with: Goal, Demo sentence, Must-Haves, Tasks list (1-7 tasks, exactly the announced IDs), Files Likely Touched
   - Write individual `T##-PLAN.md` files for each task (each must fit in one context window)
   - Each T##-PLAN.md needs: Goal, Must-Haves (Truths + Artifacts + Key Links), Steps (3-10), Context, and the complete column-0 frontmatter of every new task: explicit `depends` (task IDs of this slice, `[]` only without a predecessor), explicit `writes` (every product file or glob; `writes: []` only when the task truly writes no product file; never `.gsd`, `.git` or `.svn`), `must_haves` (`truths`, `artifacts`, `key_links`) and `expected_output` — the same schema as `/forge-add-task` step 2. A missing, bare-empty, scalar, duplicate or malformed declaration, an unknown or self reference or a cycle is refused at admission; it never becomes a legacy or sequential slice.

5. **Admit before declaring ready:** run `finish-mutation` with the kept `mutation_ref`. A new slice is admitted only as a fully valid graph. A refusal writes nothing and keeps the intent and your plan bytes: fix exactly the named problem and run it again. Until an admission exists the slice stays unready across restart; report it as pending, never as ready.

6. **Update the milestone (only after step 5 admitted the slice):**
   - Add the new slice entry to `<milestone-id>-ROADMAP.md` with `- [ ]`, risk tag, an explicit `depends:[…]` tag in backticks, demo sentence
   - Update the Boundary Map section with what this slice produces/consumes
   - **If this is the next slice to execute**, write `.gsd/milestones/<id>/<id>-STATE.md` (per-run state, via `scripts/forge-state.js` — never hand-edit the root `.gsd/STATE.md`, which is a generated dashboard) to point at it, then run `node scripts/forge-dashboard.js --cwd .` to regenerate the dashboard.

7. Report: slice ID, task breakdown, estimated scope, and the admission status (`admitted`, or the refusal code that keeps it pending)
