---
description: "Adiciona uma task a um slice existente. Use: /gsd-add-task S02 implementar refresh token rotation | /gsd-add-task T04 (task específica no slice ativo)"
allowed-tools: Read, Write, Edit, Glob
---

Use the **gsd** agent to add or plan a specific task within a slice.

## Input
$ARGUMENTS

## Parse the input
- Token matching `S\d+` → slice ID (use active slice from STATE.md if not specified)  
- Token matching `T\d+` → specific task ID to plan (plan next available ID if not specified)
- Remaining text → task description / goal

## Your job

1. **Read slice context:**
   - Active `M###-ROADMAP.md` — which milestone owns this slice?
   - `S##-PLAN.md` — existing tasks, next task ID (T0N+1), slice must-haves
   - `S##-CONTEXT.md` — slice-level decisions (if exists)
   - `M###-CONTEXT.md` — milestone architecture decisions
   - `.gsd/DECISIONS.md` — locked decisions
   - Summaries from completed tasks in this slice (for continuity)

2. **Write `T##-PLAN.md`:**
   ```markdown
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

4. **Update STATE.md** if this task is now the active one

5. Report: task ID, goal, must-haves count, estimated complexity

**Iron rule:** If the task as described won't fit in one context window (~200k tokens), split it into two tasks and plan both.
