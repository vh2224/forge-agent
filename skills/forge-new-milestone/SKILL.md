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
- If contains `-session {id}` → `SESSION_ID={id}`, strip `-session {id}` from description
- Remaining text → `MILESTONE_DESC`

---

## Step 1 — Minimal context read (this command, main context)

Read ONLY these small files:
- `.gsd/STATE.md` → determine next milestone ID (M001 if none, else M00N+1)
- `.gsd/PROJECT.md` → project description and stack
- `.gsd/REQUIREMENTS.md` → constraints (or skip if missing)
- Last 10 rows of `.gsd/DECISIONS.md` → locked decisions

If `SESSION_ID` is set: Read `.gsd/sessions/{SESSION_ID}.md` → store as `SESSION_FILE`.

Do NOT read anything else. Do NOT read source code.

Set `MILESTONE_ID` = next available M### (e.g. M002 if M001 exists).
Create the milestone directory:
```bash
mkdir -p .gsd/milestones/{MILESTONE_ID}/slices
```

---

## Step 2 — Brainstorm (skip if FAST_MODE)

**If FAST_MODE=true:** Skip to Step 3.

**If SESSION_ID is set (session-backed milestone):**

Synthesize `SESSION_FILE` into a BRAINSTORM.md directly (no subagent needed — the session IS the brainstorm). Write `.gsd/milestones/{MILESTONE_ID}/{MILESTONE_ID}-BRAINSTORM.md` with this structure:

```markdown
# {MILESTONE_ID}: {MILESTONE_DESC} — Brainstorm
**Source:** forge-ask session {SESSION_ID}
**Date:** {today}

## Context
{Summarize the session topic and motivation in 2-3 sentences, drawn from ## Conversation}

## Recommended Approach
{Derive from the session conversation — what approach emerged as preferred?}

## Alternatives Considered
{List alternatives discussed in the session, or "(none discussed)" if absent}

## Risks
{Extract risks mentioned in the session. If none: derive top 3 from the context.}

## Open Questions
{Copy from session ## Queued Actions or derive from unresolved threads in ## Conversation}

## Key Decisions from Session
{Copy all entries from ## Captured Decisions verbatim}

## Session Conversation Summary
{Paraphrase ## Conversation in 5-8 bullet points capturing the key ideas discussed}
```

Show the user:
```
✓ Brainstorm sintetizado da sessão {SESSION_ID}
  Abordagem recomendada: {1-line summary}
  Riscos identificados: {count}
  Decisões capturadas: {count from ## Captured Decisions}
```

Then proceed to Step 3.

**If SESSION_ID is NOT set (standard flow):**

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

**If SESSION_ID is set:** Pre-populate CONTEXT.md with decisions already captured in the session (from `## Captured Decisions` in `SESSION_FILE`). These are locked — do NOT re-ask them.

Identify only the **remaining** gray areas not already resolved by the session. Focus on decisions that:
- Are NOT covered by `## Captured Decisions` in the session
- Materially affect implementation
- Are not already in DECISIONS.md

If the session thoroughly covered the scope, it may be that 0-2 questions remain. That is fine — do not manufacture questions.

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
{If SESSION_ID: **Session source:** {SESSION_ID}}

## Decisions from Session
{If SESSION_ID: copy all entries from ## Captured Decisions in SESSION_FILE verbatim. Else: omit this section.}

## Implementation Decisions
- {decision from user answers in Step 4 AskUserQuestion}

## Agent's Discretion
- {areas where user said "you decide"}

## Deferred Ideas
- {ideas that belong in later milestones}
```

Append significant decisions to `.gsd/DECISIONS.md` using **`Edit` only** — never `Write` (it replaces the whole file; a PreToolUse hook blocks `Write` on this path). `Read` the file in full first (paginate if large), then `Edit` with `old_string` = current last row and `new_string` = that row + newline + your new row(s). Bash alternative: `cat >> .gsd/DECISIONS.md << 'EOF'` (never `>`).

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

{If SESSION_ID:
SESSION_CONVERSATION:
{content of ## Conversation section from SESSION_FILE — provides rich context about what was discussed, considered, and rejected}
}

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

Read `.gsd/STATE.md` (required before writing), then overwrite with:
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
