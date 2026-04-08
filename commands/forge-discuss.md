---
description: "Abre uma discussão de arquitetura para capturar decisões antes de planejar. Use: /forge-discuss M003 | /forge-discuss S02 | /forge-discuss -fast S02 (pula brainstorm)"
allowed-tools: Read, Write, Bash, Agent
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

## Parse flags and target

From `$ARGUMENTS`:
- If contains `-fast` → `FAST_MODE=true`, strip it
- If remaining is `M###` → discussing a milestone → `TARGET_TYPE=milestone`, `TARGET_ID=M###`
- If remaining is `S##` → discussing a slice → `TARGET_TYPE=slice`, `TARGET_ID=S##`
- If freeform → read STATE.md to find active milestone/slice, use that

---

## Minimal context read (this command, main context)

Read ONLY these files:
- `.gsd/STATE.md` — determine active milestone/slice
- `.gsd/PROJECT.md` — project description
- Relevant `M###-CONTEXT.md` or `S##-CONTEXT.md` if it already exists (skip if not)
- Last 15 rows of `.gsd/DECISIONS.md` — what's already decided (don't re-debate)

Do NOT read: ROADMAP, PLAN files, source code, requirements, or any other file.

---

## Brainstorm (only for milestone discuss, skip if FAST_MODE or brainstorm already done)

If `TARGET_TYPE=milestone` and `FAST_MODE=false`:

```bash
ls .gsd/milestones/{TARGET_ID}/{TARGET_ID}-BRAINSTORM.md 2>/dev/null && echo "exists" || echo "missing"
```

If brainstorm missing: delegate to `forge-planner` agent:

```
Run brainstorm for milestone {TARGET_ID}.
WORKING_DIR: {pwd}
MILESTONE_ID: {TARGET_ID}

PROJECT:
{content of .gsd/PROJECT.md}

SKILL: Check ~/.agents/skills/forge-brainstorm/SKILL.md or ~/.claude/skills/forge-brainstorm/SKILL.md.
If found: execute the skill.
If not found: 3 alternative approaches + top 5 risks + scope boundaries (inline).

Write output to .gsd/milestones/{TARGET_ID}/{TARGET_ID}-BRAINSTORM.md
Return a brief summary (5-8 lines) of key findings.
```

Use the returned summary (do NOT read the full BRAINSTORM.md) to inform the discuss questions.

---

## Discuss (interactive, stays in main context)

Identify 3-5 gray areas not already resolved by:
- Decisions Register (already read)
- Brainstorm summary (if generated above)
- Existing CONTEXT.md (if it already exists)

Focus on genuine architecture/scope choices with real trade-offs. Skip anything already locked.

Ask ALL questions at once — not one by one.

Wait for user answers.

---

## Write decisions

Write (or update) `.gsd/milestones/{M###}/{M###}-CONTEXT.md` or `slices/{S##}/{S##}-CONTEXT.md`:

```markdown
# {TARGET_ID}: {title} — Context
**Gathered:** {date}
**Status:** Ready for planning

## Implementation Decisions
{decisions from user answers}

## Agent's Discretion
{areas where user said "you decide"}

## Deferred Ideas
{ideas for later milestones/slices}
```

Append significant decisions to `.gsd/DECISIONS.md`.

Update `.gsd/STATE.md` — set phase to `plan` (ready to plan this milestone/slice).

---

## Fire memory extraction (fire-and-forget)

After writing the context file, delegate to `forge-memory` agent:

```
Extract memories from this discuss session.
UNIT_TYPE: discuss-{TARGET_TYPE}
UNIT_ID: {TARGET_ID}
WORKING_DIR: {pwd}

DECISIONS_MADE:
{the decisions you just wrote to CONTEXT.md}

AUTO_MEMORY_PATH: .gsd/AUTO-MEMORY.md
```

Do not await this — continue immediately.

---

## Report

Tell the user:
```
✓ Discuss de {TARGET_ID} concluído

Decisões registradas em: .gsd/milestones/{path}/CONTEXT.md
Próximo: /gsd para planejar, ou /forge-auto para executar automaticamente.
```
