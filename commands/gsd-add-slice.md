---
description: "Adiciona um novo slice a uma milestone existente e planeja suas tasks. Use: /gsd-add-slice M002 autenticação OAuth com refresh token"
allowed-tools: Read, Write, Edit, Glob
---

Use the **gsd** agent to add a new slice to an existing milestone.

## Input
$ARGUMENTS

## Parse the input
- First token that matches `M\d+` → milestone ID (use active milestone from STATE.md if not specified)
- Remaining text → slice description / goal

## Your job

1. **Read milestone context:**
   - `M###-ROADMAP.md` — existing slices, boundary map, next slice ID (S0N+1)
   - `M###-CONTEXT.md` — architecture decisions that constrain this slice
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
   - Add the new slice entry to `M###-ROADMAP.md` with `- [ ]`, risk tag, depends tag, demo sentence
   - Update the Boundary Map section with what this slice produces/consumes

5. **Update STATE.md** if this is the next slice to execute

6. Report: slice ID, task breakdown, estimated scope
