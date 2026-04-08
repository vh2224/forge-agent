---
description: "Cria uma nova milestone GSD: faz discuss para capturar decisões, depois planeja (ROADMAP + slices). Use: /gsd-new-milestone <descrição do que entregar>"
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


Use the **gsd** agent to create a new milestone.

## What the user wants to build
$ARGUMENTS

## Your job

1. **Read project context first:**
   - `.gsd/PROJECT.md` (if exists) — what is this project?
   - `.gsd/REQUIREMENTS.md` (if exists) — what are the constraints?
   - `.gsd/DECISIONS.md` (if exists) — what decisions are locked?
   - `.gsd/STATE.md` — what milestones already exist? What's the next milestone ID?

2. **Determine next milestone ID** (M001 if none, otherwise M00N+1)

3. **Discuss phase** — Ask the user 3-5 targeted questions about gray areas in the scope (architecture choices, scope boundaries, technology decisions). Write answers to `.gsd/milestones/M###/M###-CONTEXT.md`.

4. **Plan phase** — Based on discussion + project context:
   - Decompose into 4-10 slices ordered by risk (highest risk first)
   - Write `M###-ROADMAP.md` with checkboxes, `risk:` tags, `depends:[]` tags, demo sentences
   - Include a **Boundary Map** section
   - Create `.gsd/milestones/M###/` directory structure

5. **Update STATE.md** — set this as the active milestone, phase: plan-slice (ready to plan first slice)

6. Report: milestone ID, vision, slice list with risk levels
