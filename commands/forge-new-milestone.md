---
description: "Cria uma nova milestone GSD. Fluxo completo: brainstorm → discuss → plan. Use -fast para pular brainstorm. Ex: /forge-new-milestone autenticação OAuth | /forge-new-milestone -fast pagamentos com Stripe"
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

Invoke the brainstorm skill directly in this context:

```
Skill({ skill: "forge-brainstorm", args: "{MILESTONE_ID}: {MILESTONE_DESC}" })
```

The skill reads project context and writes `.gsd/milestones/{MILESTONE_ID}/{MILESTONE_ID}-BRAINSTORM.md` itself.

After the skill completes, read the produced BRAINSTORM.md and show the user a compact summary (Recommended approach + Top 3 risks + Open questions). Do not show the full file.

---

## Step 3 — Scope clarity (skip if FAST_MODE)

**If FAST_MODE=true:** Skip to Step 4.

Invoke the scope clarity skill directly in this context:

```
Skill({ skill: "forge-scope-clarity", args: "{MILESTONE_ID}: {MILESTONE_DESC}" })
```

The skill reads project context and writes `.gsd/milestones/{MILESTONE_ID}/{MILESTONE_ID}-SCOPE.md` itself.

After the skill completes, show the user the **In Scope** and **Out of Scope** tables from the produced SCOPE.md. Do not show the full file.

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

Read the ROADMAP to find slices tagged `risk:high`. For each one, create the slice directory and invoke the risk radar skill:

```bash
mkdir -p .gsd/milestones/{MILESTONE_ID}/slices/{S##}
```

```
Skill({ skill: "forge-risk-radar", args: "{MILESTONE_ID} {S##}" })
```

The skill reads the slice context from disk and writes `S##-RISK.md` itself. Repeat for each `risk:high` slice — call `Skill` once per slice, sequentially.

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
