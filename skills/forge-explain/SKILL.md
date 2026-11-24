---
name: forge-explain
description: "Explica artefatos GSD: M###, S##, T##, decisions, state."
allowed-tools: Read, Glob
---

Use the **forge** agent to explain a GSD artifact. Do NOT execute or modify anything — only read and explain.

## What to explain
$ARGUMENTS

## How to resolve what to read

- If argument is a milestone ID (`M###` legacy or `M-<ts>-<slug>` timestamp) → read `<id>-ROADMAP.md`, `<id>-CONTEXT.md`, `<id>-SUMMARY.md` (whichever exist). Use the full `<id>` as the file-name prefix — do not hard-code `M###-`.
- If argument is a slice ID (S##) → find its `S##-PLAN.md`, `S##-CONTEXT.md`, `S##-SUMMARY.md` in the active milestone
- If argument is a task ID (T##) → find its `T##-PLAN.md` and `T##-SUMMARY.md` in the active slice
- If argument is an autonomous-task ID (`TASK-###` legacy or `T-<ts>-<slug>` timestamp) → read `.gsd/tasks/<id>/<id>-BRIEF.md`, `<id>-CONTEXT.md`, `<id>-PLAN.md`, `<id>-SUMMARY.md` (whichever exist). Show: description, current phase, decisions made, what was done (if complete).
- If argument is "tasks" → glob `.gsd/tasks/*/` directories and for each read the `*-BRIEF.md` inside; show for each task: ID, description, current phase (inferred from which files exist), status (done/in-progress/pending)
- Routing is by ID prefix/shape: `M` or `M-` → milestone; `T-`, `TASK-`, or `task-` → autonomous task; bare `S##` or `T##` → slice/internal task in the active milestone. This mirrors `scripts/forge-ids.js entityKind()` semantics — that function is the source of truth.
<!-- pre-S05: monolith → projection. This used to Read .gsd/DECISIONS.md directly. Now uses forge-projection.js --render decisions to support fragment-store repos that have no legacy DECISIONS.md monolith. -->
- If argument is "decisions" → run `node scripts/forge-projection.js --render decisions` (stdout = rendered global DECISIONS table from fragments or monolith) AND glob `.gsd/milestones/**/M*-CONTEXT.md` and `.gsd/milestones/**/*S*-CONTEXT.md` to list which phases have phase-scoped decisions. Show: (1) projection output grouped by milestone if possible, (2) table of "Phase → CONTEXT file → decision count" for quick navigation
- If argument is "state" or empty → read `.gsd/STATE.md` and active ROADMAP
- If argument is "all" → read STATE.md + all ROADMAPs + summarize the entire project arc

## Output format

- Start with a one-paragraph plain-language summary of what this artifact is about
- List key facts (scope, status, risk, dependencies)
- If it's a task/slice: list must-haves and current status (done/pending)
- If it's a milestone: show slice breakdown with completion status
- End with: "Next action: ..." 

No markdown code blocks, no YAML — explain it conversationally.
