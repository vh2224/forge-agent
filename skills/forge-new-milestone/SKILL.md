---
name: forge-new-milestone
description: "Cria um novo milestone GSD. Fluxo: brainstorm, discuss, plan."
allowed-tools: Read, Write, Bash, Agent, Skill, AskUserQuestion, WebSearch, WebFetch
---

## Bootstrap guard

```bash
ls CLAUDE.md 2>/dev/null && echo "ok" || echo "missing"
ls .gsd/STATE.md 2>/dev/null && echo "ok" || echo "missing"
pwd
```

**Se CLAUDE.md não existe:** Stop. Tell the user:
> Projeto não inicializado. Execute `/forge-init` primeiro.

**Se .gsd/STATE.md não existe:** Stop. Tell the user:
> Nenhum projeto GSD encontrado. Execute `/forge-init` para começar.

---

## Parse flags

From `$ARGUMENTS`:
- If starts with `-fast` → `FAST_MODE=true`, strip `-fast` from description
- Remaining text → `MILESTONE_DESC`

---

## Step 1 — Minimal context read (this command, main context)

Read ONLY these small files:
- `.gsd/STATE.md` → determine next milestone ID (M001 if none, else M00N+1)
- `.gsd/PROJECT.md` → project description and stack
- `.gsd/REQUIREMENTS.md` → constraints (or skip if missing)
- Last 10 rows of `.gsd/DECISIONS.md` → locked decisions

Do NOT read anything else. Do NOT read source code.

Set `MILESTONE_ID` = next available M### (e.g. M002 if M001 exists).
Create the milestone directory:
```bash
mkdir -p .gsd/milestones/{MILESTONE_ID}/slices
```

---

## Step 2 — Brainstorm (skip if FAST_MODE)

**If FAST_MODE=true:** Skip to Step 3.

Delegate to an isolated subagent to keep brainstorm output out of main context:

```
Agent({
  description: "Brainstorm {MILESTONE_ID}",
  prompt: "You are running the forge-brainstorm skill for milestone {MILESTONE_ID}: {MILESTONE_DESC}.\nWorking directory: {pwd}\n\nInvoke: Skill({ skill: \"forge-brainstorm\", args: \"{MILESTONE_ID}: {MILESTONE_DESC}\" })\n\nAfter the skill writes the BRAINSTORM.md file, return ONLY:\n- Path of file written\n- Recommended approach (1 paragraph)\n- Top 3 risks (bullet list)\n- Open questions (bullet list)\n\nDo NOT return the full file content."
})
```

After the agent returns, confirm `.gsd/milestones/{MILESTONE_ID}/{MILESTONE_ID}-BRAINSTORM.md` exists and show the user the compact summary returned by the agent (Recommended approach + Top 3 risks + Open questions).

---

## Step 3 — Scope clarity (skip if FAST_MODE)

**If FAST_MODE=true:** Skip to Step 4.

Delegate to an isolated subagent to keep scope clarity output out of main context:

```
Agent({
  description: "Scope clarity {MILESTONE_ID}",
  prompt: "You are running the forge-scope-clarity skill for milestone {MILESTONE_ID}: {MILESTONE_DESC}.\nWorking directory: {pwd}\n\nInvoke: Skill({ skill: \"forge-scope-clarity\", args: \"{MILESTONE_ID}: {MILESTONE_DESC}\" })\n\nAfter the skill writes the SCOPE.md file, return ONLY:\n- Path of file written\n- The In Scope table (markdown)\n- The Out of Scope table (markdown)\n\nDo NOT return the full file content."
})
```

After the agent returns, confirm `.gsd/milestones/{MILESTONE_ID}/{MILESTONE_ID}-SCOPE.md` exists and show the user the In Scope and Out of Scope tables returned by the agent.

---

## Step 4 — Discuss (interactive, stays in main context)

Identify 3-5 genuine architecture/scope gray areas based on:
- The brainstorm output summary (if available from Step 2)
- The scope contract (if available from Step 3)
- The DECISIONS.md locked decisions (avoid re-debating)

Focus only on decisions not yet resolved that materially affect implementation.

**Ask questions one at a time using `AskUserQuestion`** — do NOT dump all questions in a text block.

For each question:
1. Generate 2-4 concrete options derived from the project context (not generic)
2. `AskUserQuestion` adds "Other" automatically — do not add it manually
3. Wait for the answer before moving to the next question
4. If user answers "you decide" → record as "Agent's Discretion" and move on

Write decisions to `.gsd/milestones/{MILESTONE_ID}/{MILESTONE_ID}-CONTEXT.md`:
```markdown
# {MILESTONE_ID}: {MILESTONE_DESC} — Context
**Gathered:** {date}
**Status:** Ready for planning

## Implementation Decisions
- {decision from user answers}

## Agent's Discretion
- {areas where user said "you decide"}

## Deferred Ideas
- {ideas that belong in later milestones}
```

Append significant decisions to `.gsd/DECISIONS.md`.

---

## Step 5 — Plan (delegate to sub-agent)

Read:
- `.gsd/AUTO-MEMORY.md` first 80 lines (or skip if missing)

Then delegate to `forge-planner` agent:

```
Plan milestone {MILESTONE_ID}: {MILESTONE_DESC}
WORKING_DIR: {pwd}

PROJECT:
{content of .gsd/PROJECT.md}

REQUIREMENTS:
{content of .gsd/REQUIREMENTS.md}

CONTEXT (discuss decisions):
{content of {MILESTONE_ID}-CONTEXT.md}

BRAINSTORM:
{content of {MILESTONE_ID}-BRAINSTORM.md, or "(none — fast mode)"}

SCOPE:
{content of {MILESTONE_ID}-SCOPE.md, or "(none — fast mode)"}

DECISIONS:
{full .gsd/DECISIONS.md}

TOP_MEMORIES:
{first 80 lines of AUTO-MEMORY.md}

Write {MILESTONE_ID}-ROADMAP.md with:
- 4-10 slices ordered by risk (high first)
- Each slice: title, description, risk tag, depends tag, demo sentence
- A Boundary Map section showing what each slice produces/consumes
Return ---GSD-WORKER-RESULT--- with list of slices created.
```

---

## Step 6 — Risk radar on high-risk slices (skip if FAST_MODE)

**If FAST_MODE=true:** Skip to Step 7.

Read the ROADMAP and collect ALL slices tagged `risk:high` into a list. Then process each one **to completion before moving to the next**. Do NOT stop, summarize, or report to the user between slices — the loop must complete entirely before proceeding to Step 7.

For EACH `risk:high` slice, in order:

1. Create the slice directory:
```bash
mkdir -p .gsd/milestones/{MILESTONE_ID}/slices/{S##}
```

2. Invoke risk radar for this slice:
```
Skill({ skill: "forge-risk-radar", args: "{MILESTONE_ID} {S##}" })
```

3. Confirm `S##-RISK.md` was written. Then **immediately** continue to the next `risk:high` slice without pausing.

After ALL slices have been processed (or if no `risk:high` slices exist), proceed to Step 7.

---

## Step 7 — Update state and report

Update `.gsd/STATE.md`:
```markdown
# GSD State

**Active Milestone:** {MILESTONE_ID} — {MILESTONE_DESC}
**Active Slice:** none
**Active Task:** none
**Phase:** plan-slice (ready to plan first slice)

## Next Action
Plan first slice: run /forge-next or /forge-auto
```

Report to user:
```
✓ Milestone {MILESTONE_ID} criado

Título: {MILESTONE_DESC}
Slices: {N} slices no roadmap
Slices high-risk: {list or "none"}

Arquivos criados:
  .gsd/milestones/{MILESTONE_ID}/{MILESTONE_ID}-ROADMAP.md
  .gsd/milestones/{MILESTONE_ID}/{MILESTONE_ID}-CONTEXT.md
  [{MILESTONE_ID}-BRAINSTORM.md]  (se não for fast mode)
  [{MILESTONE_ID}-SCOPE.md]       (se skill disponível)

Próximo: /gsd para planejar primeiro slice, ou /forge-auto para executar tudo.
```
