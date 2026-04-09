---
description: "GSD step mode — avança exatamente uma unidade de trabalho e para. Argumentos: 'next' (mesmo que sem argumento), 'auto' (delega para /forge-auto)."
allowed-tools: Read, Write, Edit, Bash, Agent
---

## Parse arguments

From `$ARGUMENTS`:
- Empty, `next`, or `step` → **STEP MODE** (execute one unit, stop)
- `auto` → tell the user: "Use `/forge-auto` para modo autônomo." and stop.
- Anything else → treat as STEP MODE (ignore unknown args)

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

Read ONLY these files:
1. `.gsd/STATE.md`
2. `~/.claude/forge-agent-prefs.md` (skip silently if missing)
3. `.gsd/claude-agent-prefs.md` (skip silently if missing)
4. First 80 lines of `.gsd/AUTO-MEMORY.md` (skip silently if missing)

Store as: `STATE`, `PREFS`, `TOP_MEMORIES`.

---

## Orchestrate — STEP MODE

You are the orchestrator. Execute the dispatch loop **exactly once**, then stop.

### 1. Derive next unit

From STATE, determine `unit_type` and `unit_id` using the dispatch table below.

**Dispatch Table** (evaluate in order — first match wins):

| Condition | unit_type | Agent | Default model |
|-----------|-----------|-------|---------------|
| No active milestone | STOP — tell user "no active milestone" | — | — |
| Milestone has no ROADMAP | plan-milestone | **forge-planner** | opus |
| Milestone has ROADMAP, no CONTEXT, discuss not skipped | discuss-milestone | **forge-discusser** | opus |
| Milestone has no RESEARCH, research not skipped | research-milestone | **forge-researcher** | opus |
| Active slice has no PLAN | plan-slice | **forge-planner** | opus |
| Active slice has PLAN, no RESEARCH, research not skipped | research-slice | **forge-researcher** | opus |
| Active slice has incomplete task | execute-task | **forge-executor** | sonnet |
| All tasks in active slice done, no S##-SUMMARY | complete-slice | **forge-completer** | sonnet |
| All slices complete, no milestone completion marker | complete-milestone | **forge-completer** | sonnet |
| All slices `[x]` in ROADMAP and milestone complete | DONE — emit final report | — | — |

To determine which case applies, read (in order, stop as soon as you find the answer):
1. STATE.md (already loaded) — `next_action` usually tells you directly
2. `M###-ROADMAP.md` — only if STATE is ambiguous about slices/milestone completion
3. `S##-PLAN.md` — only if STATE is ambiguous about tasks within a slice

**Crash detection:** Before dispatching `execute-task`, read `T##-PLAN.md`. If it contains `status: RUNNING`, the previous session crashed mid-task. Warn the user:
> ⚠ Task {T##} was interrupted (status: RUNNING). Re-executing from scratch.
Then proceed with dispatch normally (the executor will overwrite the partial work).

**Dynamic routing:** If `T##-PLAN.md` contains `complexity: heavy`, route `execute-task` to `forge-executor` on opus.

### 2. Check skip rules

Read PREFS for `skip_discuss` and `skip_research`. If the current unit type is skipped, advance STATE past it and re-derive (do not count as a unit).

### 3. Build worker prompt

Read ONLY the `.gsd/` artifact files the worker needs (templates below). Inline their content — do not summarize or paraphrase.

### 4. Dispatch

Resolve the model ID for this unit from PREFS. Emit a dispatch line:

```
⟳ [M001/S02/T03] execute-task → forge-executor (claude-sonnet-4-6)
```

Then call `Agent(agent_name, worker_prompt)` with a `description` that captures what is happening:
- Format: `{unit_type} {unit_id}: {one-liner describing the work}`
- Examples:
  - `plan-slice S01: authentication foundation`
  - `execute-task T03: JWT middleware setup`
  - `research-milestone M001: e-commerce platform`
- For memory extraction: `extract memories from {unit_id}`

Wait for the result.

### 5. Process result

Parse the `---GSD-WORKER-RESULT---` block:
- `status: done` → proceed to post-unit housekeeping
- `status: blocked` → surface blocker to user, stop
- `status: partial` → write `continue.md`, update STATE, emit compact signal, stop

### 6. Post-unit housekeeping

**a) Update STATE.md** — advance to next unit position.

**b) Append decisions** — if `key_decisions` in result, append to `.gsd/DECISIONS.md`.

**c) Memory extraction** — call `forge-memory` agent (blocking — await before continuing):

Determine which summary file was just written:
- `execute-task` → `.gsd/milestones/{M###}/slices/{S##}/tasks/{T##}-SUMMARY.md`
- `plan-slice` → `.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN.md`
- `complete-slice` → `.gsd/milestones/{M###}/slices/{S##}/{S##}-SUMMARY.md`
- `plan-milestone` → `.gsd/milestones/{M###}/{M###}-ROADMAP.md`
- `complete-milestone` → `.gsd/milestones/{M###}/{M###}-SUMMARY.md`
- other → use the result block only

Call `forge-memory` agent with:
```
WORKING_DIR: {WORKING_DIR}
UNIT_TYPE: {unit_type}
UNIT_ID: {unit_id}
MILESTONE_ID: {M###}

SUMMARY_CONTENT:
{full content of the summary/plan file read above, or "(none)" if not found}

RESULT_BLOCK:
{full ---GSD-WORKER-RESULT--- block verbatim}

KEY_DECISIONS:
{key_decisions field from result, or "(none)"}
```

**d) Emit progress line:**
```
✓ [M001/S02/T03] execute-task — JWT auth with refresh rotation  · forge-executor (claude-sonnet-4-6)
```

Then stop. Display the progress line to the user. Do not add summaries or follow-up text — the user will decide whether to run `/forge-next` again.

---

## Worker Prompt Templates

### execute-task

```
Execute GSD task {T##} in slice {S##} of milestone {M###}.
WORKING_DIR: {WORKING_DIR}

## Task Plan
{content of T##-PLAN.md}

## Slice Plan (tasks section)
{content of S##-PLAN.md}

## Prior Context
{content of M###-SUMMARY.md if exists, else last S##-SUMMARY.md if exists, else "(none yet)"}

## Decisions Register (last 20 rows)
{last 20 rows of .gsd/DECISIONS.md}

## Project Memory
{TOP_MEMORIES}

## Instructions
Execute all steps. Verify every must-have using the verification ladder.
Write T##-SUMMARY.md. Commit: feat(S##/T##): <one-liner>.
Do NOT modify STATE.md. Return ---GSD-WORKER-RESULT---.
```

### plan-slice

```
Plan GSD slice {S##} of milestone {M###}.
WORKING_DIR: {WORKING_DIR}

## Roadmap Entry + Boundary Map
{relevant section of M###-ROADMAP.md for this slice}

## Milestone Context
{content of M###-CONTEXT.md if exists, else "(none)"}

## Dependency Slice Summaries
{content of S##-SUMMARY.md for each slice listed in depends:[]}

## Decisions Register
{full .gsd/DECISIONS.md}

## Project Memory
{TOP_MEMORIES}

## Instructions
Write S##-PLAN.md and individual T##-PLAN.md files (1-7 tasks).
Iron rule: each task must fit in one context window.
Return ---GSD-WORKER-RESULT---.
```

### plan-milestone

```
Plan GSD milestone {M###}: {description}.
WORKING_DIR: {WORKING_DIR}

## Project
{content of .gsd/PROJECT.md}

## Requirements
{content of .gsd/REQUIREMENTS.md}

## Context (discuss decisions)
{content of M###-CONTEXT.md if exists, else "(none)"}

## Brainstorm Output
{content of M###-BRAINSTORM.md if exists, else "(none)"}

## Scope Contract
{content of M###-SCOPE.md if exists, else "(none)"}

## Decisions Register
{full .gsd/DECISIONS.md}

## Project Memory
{TOP_MEMORIES}

## Instructions
Write M###-ROADMAP.md with 4-10 slices, risk tags, depends, demo sentences, and a Boundary Map section.
Return ---GSD-WORKER-RESULT---.
```

### complete-slice

```
Complete GSD slice {S##} of milestone {M###}.
WORKING_DIR: {WORKING_DIR}

## Task Summaries
{content of each T##-SUMMARY.md in this slice}

## Slice Plan
{content of S##-PLAN.md}

## Current Milestone Summary
{content of M###-SUMMARY.md if exists, else "(none)"}

## Instructions
1. Write S##-SUMMARY.md (compress all task summaries)
2. Write S##-UAT.md (non-blocking human test script)
3. Squash-merge branch gsd/M###/S## to main
4. Update M###-SUMMARY.md with this slice's contribution
5. Mark slice [x] in M###-ROADMAP.md
Return ---GSD-WORKER-RESULT---.
```

### complete-milestone

```
Complete GSD milestone {M###}.
WORKING_DIR: {WORKING_DIR}

## Slice Summaries
{content of each S##-SUMMARY.md in this milestone}

## Milestone Roadmap
{content of M###-ROADMAP.md}

## Milestone Summary
{content of M###-SUMMARY.md}

## Instructions
1. Write final M###-SUMMARY.md
2. Mark milestone as complete in STATE.md (do modify STATE.md for this)
3. Write final git tag or note
Return ---GSD-WORKER-RESULT---.
```

### discuss-milestone / discuss-slice

```
Discuss {milestone M### | slice S##} architecture decisions.
WORKING_DIR: {WORKING_DIR}

## Project
{content of .gsd/PROJECT.md}

## Requirements
{content of .gsd/REQUIREMENTS.md if exists}

## Brainstorm Output (if available)
{content of M###-BRAINSTORM.md if exists, else "(none)"}

## Locked Decisions (do not re-debate)
{full .gsd/DECISIONS.md}

## Project Memory
{TOP_MEMORIES}

## Instructions
Identify 3-5 gray areas not yet resolved. Ask them ALL AT ONCE in a single message.
Record answers in M###-CONTEXT.md (or S##-CONTEXT.md for slice discuss).
Append significant decisions to .gsd/DECISIONS.md.
Return ---GSD-WORKER-RESULT---.

NOTE: You can ask the user questions during this phase.
```

### research-milestone / research-slice

```
Research codebase for GSD {milestone M### | slice S##}: {description}.
WORKING_DIR: {WORKING_DIR}

## What we're building
{context from M###-CONTEXT.md or S##-CONTEXT.md}

## Project
{content of .gsd/PROJECT.md}

## Project Memory (known gotchas)
{TOP_MEMORIES}

## Instructions
Explore the codebase. Produce M###-RESEARCH.md (or S##-RESEARCH.md) with:
- Summary
- Don't Hand-Roll table (what libraries/patterns exist already)
- Common Pitfalls found
- Relevant Code sections
Return ---GSD-WORKER-RESULT---.
```

---

## Continue-Here Protocol

If a worker returns `status: partial`:

1. Write `.gsd/milestones/M###/slices/S##/continue.md`:
```markdown
---
milestone: M###
slice: S##
task: T##
step: {completed_step}
total_steps: {total}
saved_at: {ISO8601}
---

## Completed Work
{from worker result}

## Remaining Work
{from worker result}

## Decisions Made
{from worker result}

## Next Action
{specific next step to resume from}
```

2. Update STATE.md to point to this task with `phase: resume`
3. Tell the user: "Trabalho parcial salvo. Execute `/forge-next` para retomar de onde parou."

On resume: STATE has `phase: resume` → read `continue.md`, inline into worker prompt with instruction "Resume from continue.md — skip completed work, start from Next Action."
