---
description: "Cria uma nova milestone GSD. Fluxo completo: brainstorm → discuss → plan. Use -fast para pular brainstorm. Ex: /gsd-new-milestone autenticação OAuth | /gsd-new-milestone -fast pagamentos com Stripe"
allowed-tools: Read, Write, Bash, Agent
---

## Bootstrap guard

```bash
ls CLAUDE.md 2>/dev/null && echo "ok" || echo "missing"
ls .gsd/STATE.md 2>/dev/null && echo "ok" || echo "missing"
pwd
```

**Se CLAUDE.md não existe:** Stop. Tell the user:
> Projeto não inicializado. Execute `/gsd-init` primeiro.

**Se .gsd/STATE.md não existe:** Stop. Tell the user:
> Nenhum projeto GSD encontrado. Execute `/gsd-init` para começar.

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

Delegate to `gsd-planner` agent:

```
Run the gsd-brainstorm skill for a new milestone.
WORKING_DIR: {pwd}
MILESTONE_ID: {MILESTONE_ID}
MILESTONE_DESC: {MILESTONE_DESC}

PROJECT:
{content of .gsd/PROJECT.md}

REQUIREMENTS:
{content of .gsd/REQUIREMENTS.md}

DECISIONS (last 10 rows):
{last 10 rows of .gsd/DECISIONS.md}

SKILL: Check ~/.agents/skills/gsd-brainstorm/SKILL.md or ~/.claude/skills/gsd-brainstorm/SKILL.md.
If found: execute the skill.
If not found: run inline brainstorm — 3 alternative approaches + top 5 risks + scope boundaries.

Write output to .gsd/milestones/{MILESTONE_ID}/{MILESTONE_ID}-BRAINSTORM.md
Return a brief summary (5-10 lines) of the brainstorm key findings.
```

Show the brainstorm summary to the user before continuing.

---

## Step 3 — Scope clarity (skip if FAST_MODE)

**If FAST_MODE=true:** Skip to Step 4.

Delegate to `gsd-planner` agent:

```
Run scope clarity for milestone {MILESTONE_ID}.
WORKING_DIR: {pwd}
MILESTONE_ID: {MILESTONE_ID}
MILESTONE_DESC: {MILESTONE_DESC}

BRAINSTORM (if available):
{summary from Step 2, or content of BRAINSTORM.md}

PROJECT:
{content of .gsd/PROJECT.md}

SKILL: Check ~/.agents/skills/gsd-scope-clarity/SKILL.md or ~/.claude/skills/gsd-scope-clarity/SKILL.md.
If found: execute the skill.
If not found: produce a brief in/out/deferred classification and observable criteria.

Write output to .gsd/milestones/{MILESTONE_ID}/{MILESTONE_ID}-SCOPE.md
Return the scope contract summary (what's IN vs OUT).
```

Show the scope contract to the user briefly.

---

## Step 4 — Discuss (interactive, stays in main context)

Ask the user 3-5 targeted questions about gray areas. Base them on:
- The brainstorm output summary (if available from Step 2)
- The scope contract (if available from Step 3)
- The DECISIONS.md locked decisions (avoid re-debating)

Focus only on genuine architecture/scope decisions not yet resolved.
Ask ALL questions at once — not one by one.

Wait for user answers.

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

Then delegate to `gsd-planner` agent:

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

Read the ROADMAP to find slices tagged `risk:high`.

For each high-risk slice, delegate to `gsd-planner` agent:

```
Run risk radar for slice {S##} of milestone {MILESTONE_ID}.
WORKING_DIR: {pwd}

SLICE ENTRY:
{relevant roadmap entry}

MILESTONE CONTEXT:
{content of {MILESTONE_ID}-CONTEXT.md}

SKILL: Check ~/.agents/skills/gsd-risk-radar/SKILL.md or ~/.claude/skills/gsd-risk-radar/SKILL.md.
If found: execute the skill.
If not found: produce a brief risk analysis covering technical, dependency, and scope-creep risks.

Write output to .gsd/milestones/{MILESTONE_ID}/slices/{S##}/{S##}-RISK.md
Return a one-line risk summary.
```

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
Plan first slice: run /gsd or /gsd-auto
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

Próximo: /gsd para planejar primeiro slice, ou /gsd-auto para executar tudo.
```
