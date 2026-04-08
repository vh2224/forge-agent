---
description: "Abre uma discussão de arquitetura para capturar decisões antes de planejar. Use: /gsd-discuss M003 | /gsd-discuss S02 | /gsd-discuss como fazer autenticação"
allowed-tools: Read, Write, Glob, Agent
---

Use the **gsd** agent to run a discuss phase and capture architectural decisions.

## Topic
$ARGUMENTS

## How to resolve scope

- If argument is a milestone ID → discuss milestone-level architecture, write `M###-CONTEXT.md`
- If argument is a slice ID → discuss slice-level decisions, write `S##-CONTEXT.md`
- If freeform text → find the relevant active milestone/slice from STATE.md, discuss that topic

## Your job

1. **Read current context:**
   - `.gsd/STATE.md` — active milestone/slice
   - Relevant ROADMAP / PLAN files
   - `.gsd/DECISIONS.md` — decisions already locked (don't re-debate these)
   - `PROJECT.md` and `REQUIREMENTS.md` if they exist

2. **Identify 3-5 gray areas** — implementation decisions the user should weigh in on. Focus on:
   - Architecture choices with real trade-offs
   - Scope boundaries (in vs. out)
   - Technology/library choices not yet decided
   - Constraints that affect multiple slices/tasks

3. **Ask the questions** — ask all at once, not one by one

4. **Record decisions** in `M###-CONTEXT.md` or `S##-CONTEXT.md`:
   ```markdown
   # M###: Title — Context
   
   **Gathered:** YYYY-MM-DD
   **Status:** Ready for planning
   
   ## Implementation Decisions
   - Decision 1
   - Decision 2
   
   ## Agent's Discretion
   - Areas where user said "you decide"
   
   ## Deferred Ideas
   - Ideas that belong in other slices
   ```

5. **Append significant decisions to `.gsd/DECISIONS.md`**

6. **Update STATE.md** — set phase to plan (ready to plan this milestone/slice)
