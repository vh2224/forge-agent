---
name: forge-add-task
description: "Adiciona uma task a um slice existente."
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
- Token matching `S\d+` → slice ID (use active slice from STATE.md if not specified)  
- Token matching `T\d+` → specific task ID to plan (plan next available ID if not specified)
- Remaining text → task description / goal

## Owner validation CLI

`Bash` is exposed only for `node`, and this skill uses it only for the owner validation gate of new plan bytes (`shared/forge-plan-gate.md § New task declarations`) and, after admission, the existing STATE/dashboard helpers of step 5. Run no other shell command here. Each call prints one JSON line; exit 0 is `{"ok":true,...}`, exit 1 a named refusal `{"ok":false,"code","detail"}` and exit 2 a usage error:
```bash
node "$([ -f scripts/forge-plan-validation.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")/forge-plan-validation.js" begin-mutation --operation add-task --milestone "<M>" --slice "<S##>" --task "<T##>" --owner "<absolute owner path>" --cwd "<absolute owner path>"
node "$([ -f scripts/forge-plan-validation.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")/forge-plan-validation.js" finish-mutation --ref "<mutation_ref>" --cwd "<absolute owner path>"
```
A refusal is never bypassed by writing the files anyway, editing the mutation chain or reporting the task as ready.

## Your job

1. **Read slice context:**
   - Active `M###-ROADMAP.md` — which milestone owns this slice?
   - `S##-PLAN.md` — existing tasks, next task ID (T0N+1), slice must-haves
   - `S##-CONTEXT.md` — slice-level decisions (if exists)
   - `M###-CONTEXT.md` — milestone architecture decisions
   - `.gsd/DECISIONS.md` — locked decisions
   - Summaries from completed tasks in this slice (for continuity)

   **Open the owner intent before writing any plan byte:** run `begin-mutation` above with the new task ID. Keep `mutation.mutation_ref` from its output; the targets it lists are the only plan files this skill may write. `plan-mutation-boundary-deferred` (a begin, lease or transaction of the milestone is open) means stop and retry later; any other refusal code stops this skill with that code. The same request over an already open intent replays it.

2. **Write `T##-PLAN.md`** with the complete frontmatter at column 0 — every new task declares all four blocks; none is optional or inferred:
   - `depends` — explicit task IDs of this slice that must finish first, `[]` only when there is no predecessor;
   - `writes` — every product file or glob the task creates, modifies or deletes; `writes: []` only when it truly writes no product file; never a `.gsd`, `.git` or `.svn` path;
   - `must_haves` — exactly `truths`, `artifacts` (`path`, `provides`, `min_lines`) and `key_links` (`from`, `to`, `via`);
   - `expected_output` — the flat list of produced paths.

   A missing, bare-empty, scalar, duplicate or malformed declaration is refused by `finish-mutation`; it never becomes a legacy or sequential plan.
   ```markdown
   ---
   depends: []
   writes:
     - "path/to/file.ts"
   must_haves:
     truths:
       - "Observable outcome 1"
     artifacts:
       - path: "path/to/file.ts"
         provides: "description"
         min_lines: 20
     key_links:
       - from: "file-a.ts"
         to: "file-b.ts"
         via: "import of functionX"
   expected_output:
     - path/to/file.ts
   ---

   # T##: Task Title
   
   **Slice:** S##
   **Milestone:** M###
   
   ## Goal
   One sentence.
   
   ## Must-Haves
   
   ### Truths
   - Observable outcome 1
   
   ### Artifacts
   - `path/to/file.ts` — description (min N lines, exports: ...)
   
   ### Key Links
   - `file-a.ts` → `file-b.ts` via import of functionX
   
   ## Steps
   1. ...
   
   ## Context
   - Relevant prior decisions
   - Key files to read first
   ```

3. **Update `S##-PLAN.md`** — add `- [ ] **T##: Title**` entry

4. **Admit before declaring ready:** run `finish-mutation` with the kept `mutation_ref`. Only `{"ok":true,"admission":{"status":"admitted"|"replayed",...}}` makes the task executable. A refusal writes nothing and keeps the intent and your plan bytes: fix exactly the named problem in the announced files and run `finish-mutation` again. Until an admission exists, the new task stays unready across restart (every execute begin of the milestone refuses `plan-mutation-pending`); report it as pending, never as ready.

5. **If this task is now the active one** (only after step 4 admitted it), write `.gsd/milestones/<id>/<id>-STATE.md` (per-run state, via `scripts/forge-state.js` — never hand-edit the root `.gsd/STATE.md`, which is a generated dashboard) to point at it, then run `node scripts/forge-dashboard.js --cwd .` to regenerate the dashboard.

6. Report: task ID, goal, must-haves count, estimated complexity, and the admission status (`admitted`, or the refusal code that keeps it pending)

**Iron rule:** If the task as described won't fit in one context window (~200k tokens), split it into two tasks and plan both.
