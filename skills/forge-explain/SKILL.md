---
name: forge-explain
description: "Explica qualquer artefato GSD: milestone, slice, task, decisões, estado atual. Use: /forge-explain M002 | /forge-explain S03 | /forge-explain T02 | /forge-explain decisions"
disable-model-invocation: true
allowed-tools: Read, Glob
---

Use the **forge** agent to explain a GSD artifact. Do NOT execute or modify anything — only read and explain.

## What to explain
$ARGUMENTS

## How to resolve what to read

- If argument is a milestone ID (M###) → read `M###-ROADMAP.md`, `M###-CONTEXT.md`, `M###-SUMMARY.md` (whichever exist)
- If argument is a slice ID (S##) → find its `S##-PLAN.md`, `S##-CONTEXT.md`, `S##-SUMMARY.md` in the active milestone
- If argument is a task ID (T##) → find its `T##-PLAN.md` and `T##-SUMMARY.md` in the active slice
- If argument is a forge-task ID (TASK-###) → read `.gsd/tasks/TASK-###/TASK-###-BRIEF.md`, `TASK-###-CONTEXT.md`, `TASK-###-PLAN.md`, `TASK-###-SUMMARY.md` (whichever exist). Show: description, current phase, decisions made, what was done (if complete).
- If argument is "tasks" → glob `.gsd/tasks/*/TASK-*-BRIEF.md` and for each task show: ID, description, current phase (inferred from which files exist), status (done/in-progress/pending)
- If argument is "decisions" → read `.gsd/DECISIONS.md` (global overview — all decisions ever appended across milestones) AND glob `.gsd/milestones/**/M*-CONTEXT.md` and `.gsd/milestones/**/*S*-CONTEXT.md` to list which phases have phase-scoped decisions. Show: (1) full DECISIONS.md content grouped by milestone if possible, (2) table of "Phase → CONTEXT file → decision count" for quick navigation
- If argument is "state" or empty → read `.gsd/STATE.md` and active ROADMAP
- If argument is "all" → read STATE.md + all ROADMAPs + summarize the entire project arc

## Output format

- Start with a one-paragraph plain-language summary of what this artifact is about
- List key facts (scope, status, risk, dependencies)
- If it's a task/slice: list must-haves and current status (done/pending)
- If it's a milestone: show slice breakdown with completion status
- End with: "Next action: ..." 

No markdown code blocks, no YAML — explain it conversationally.
