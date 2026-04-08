---
description: "Cria uma nova milestone GSD. Fluxo completo: brainstorm → discuss → plan. Use -fast para pular brainstorm. Ex: /gsd-new-milestone autenticação OAuth | /gsd-new-milestone -fast pagamentos com Stripe"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent
---

## Bootstrap guard (sempre executar primeiro)

Before doing anything else, run:
```bash
ls CLAUDE.md 2>/dev/null && echo "ok" || echo "missing"
ls .gsd/STATE.md 2>/dev/null && echo "ok" || echo "missing"
```

**Se CLAUDE.md não existe:** Stop and tell the user:
> Projeto não inicializado. Execute `/gsd-init` primeiro — isso cria o `CLAUDE.md` que restaura o contexto automaticamente ao reabrir o chat.

**Se .gsd/STATE.md não existe:** Stop and tell the user:
> Nenhum projeto GSD encontrado neste diretório. Execute `/gsd-init` para começar.

**Se `.gsd/AUTO-MEMORY.md` não existe:** Create it silently before proceeding:
```
<!-- gsd-auto-memory | project: <from PROJECT.md or directory name> | extraction_count: 0 -->
<!-- ranked by: confidence × (1 + hits × 0.1) | cap: 50 active -->
```

---

## Parse flags and description

From `$ARGUMENTS`:
- If starts with `-fast` → set `FAST_MODE=true`, remove `-fast` from description
- Remaining text → milestone description

---

## What the user wants to build

$ARGUMENTS

---

## Phase 0 — Read project context

Always read first:
- `.gsd/PROJECT.md` — what is this project?
- `.gsd/REQUIREMENTS.md` — what are the constraints?
- `.gsd/DECISIONS.md` — what decisions are locked?
- `.gsd/AUTO-MEMORY.md` — gotchas and patterns already learned
- `.gsd/STATE.md` — what milestones already exist? Determine next milestone ID (M001 if none, otherwise M00N+1)

---

## Phase 1 — Brainstorm (skip if FAST_MODE)

**If FAST_MODE=true:**
> ⚡ Fast mode — brainstorm skipped. Proceeding to discuss.

**If FAST_MODE=false:**

Check if `gsd-brainstorm` skill is available:
```bash
ls ~/.agents/skills/gsd-brainstorm/SKILL.md 2>/dev/null || ls ~/.claude/skills/gsd-brainstorm/SKILL.md 2>/dev/null && echo "found" || echo "not found"
```

**If skill found:** Read `~/.agents/skills/gsd-brainstorm/SKILL.md` (or `~/.claude/skills/`) and execute the brainstorm process for this milestone. Save output to `.gsd/milestones/M###/M###-BRAINSTORM.md`.

**If skill not found:** Run an inline brainstorm (3 alternative approaches + top 5 risks + scope boundaries). Save to `.gsd/milestones/M###/M###-BRAINSTORM.md`.

Show the user a brief summary of the brainstorm output before continuing.

---

## Phase 2 — Scope clarity (skip if FAST_MODE)

**If FAST_MODE=false and `gsd-scope-clarity` skill is available:**
```bash
ls ~/.agents/skills/gsd-scope-clarity/SKILL.md 2>/dev/null && echo "found" || echo "not found"
```
If found: read and execute the scope clarity process. Save to `.gsd/milestones/M###/M###-SCOPE.md`.
If not found: skip silently.

---

## Phase 3 — Discuss

Ask the user 3-5 targeted questions about gray areas. If FAST_MODE=false, use the brainstorm and scope outputs to focus questions on genuine unknowns — avoid re-asking what was already resolved.

If FAST_MODE=true, ask questions based only on the project context.

Write decisions to `.gsd/milestones/M###/M###-CONTEXT.md`.

---

## Phase 4 — Plan

Dispatch to **gsd-planner** agent with:
- The milestone description
- Brainstorm output (if generated)
- Scope contract (if generated)
- Context file decisions
- AUTO-MEMORY.md content (top entries)
- DECISIONS.md (last 20 rows)

The planner writes:
- `M###-ROADMAP.md` with 4-10 slices, risk tags, depends, demo sentences, boundary map

---

## Phase 5 — Risk radar on high-risk slices (skip if FAST_MODE)

**If FAST_MODE=false and `gsd-risk-radar` skill available:**
For each slice marked `risk:high` in the roadmap:
- Read skill and run risk assessment
- Save as `S##-RISK.md` in the slice directory

---

## Phase 6 — Finalize

- Update `.gsd/STATE.md`: set this as active milestone, phase = plan-slice (ready to plan first slice)
- Report to user:

```
✓ Milestone M### created

Title: [title]
Slices: [N] slices planned
High-risk slices: [list]

Files created:
  .gsd/milestones/M###/M###-ROADMAP.md
  .gsd/milestones/M###/M###-CONTEXT.md
  [.gsd/milestones/M###/M###-BRAINSTORM.md]  (if not fast)
  [.gsd/milestones/M###/M###-SCOPE.md]       (if scope skill available)

Next: /gsd to plan first slice, or /gsd-auto to execute autonomously.
```
