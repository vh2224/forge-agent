---
description: "Abre uma discussão de arquitetura para capturar decisões antes de planejar. Use: /gsd-discuss M003 | /gsd-discuss S02 | /gsd-discuss como fazer autenticação"
allowed-tools: Read, Write, Glob, Agent, Bash
---

## Bootstrap guard (sempre executar primeiro)

Before doing anything else, check project initialization:

```bash
ls CLAUDE.md 2>/dev/null && echo "ok" || echo "missing"
ls .gsd/STATE.md 2>/dev/null && echo "ok" || echo "missing"
```

**Se CLAUDE.md não existe:**
Stop. Tell the user:
> Projeto não inicializado. Execute `/gsd-init` primeiro para criar o `CLAUDE.md` e a estrutura `.gsd/`. Isso garante que o contexto seja restaurado automaticamente ao reabrir o chat.

**Se .gsd/STATE.md não existe:**
Stop. Tell the user:
> Nenhum projeto GSD encontrado neste diretório. Execute `/gsd-init` para começar.

**Se `.gsd/AUTO-MEMORY.md` não existe:** Create it now:
```
<!-- gsd-auto-memory | project: <infer from PROJECT.md or directory name> | extraction_count: 0 -->
<!-- ranked by: confidence × (1 + hits × 0.1) | cap: 50 active -->
```

---

## Topic
$ARGUMENTS

## How to resolve scope

- If argument is a milestone ID → discuss milestone-level architecture, write `M###-CONTEXT.md`
- If argument is a slice ID → discuss slice-level decisions, write `S##-CONTEXT.md`
- If freeform text → find the relevant active milestone/slice from STATE.md, discuss that topic

## Your job

1. **Read current context:**
   - `.gsd/STATE.md` — active milestone/slice
   - Relevant ROADMAP / PLAN files
   - `.gsd/DECISIONS.md` — decisions already locked (don't re-debate these)
   - `PROJECT.md` and `REQUIREMENTS.md` if they exist

2. **Identify 3-5 gray areas** — implementation decisions the user should weigh in on. Focus on:
   - Architecture choices with real trade-offs
   - Scope boundaries (in vs. out)
   - Technology/library choices not yet decided
   - Constraints that affect multiple slices/tasks

3. **Ask the questions** — ask all at once, not one by one

4. **Record decisions** in `M###-CONTEXT.md` or `S##-CONTEXT.md`:
   ```markdown
   # M###: Title — Context

   **Gathered:** YYYY-MM-DD
   **Status:** Ready for planning

   ## Implementation Decisions
   - Decision 1
   - Decision 2

   ## Agent's Discretion
   - Areas where user said "you decide"

   ## Deferred Ideas
   - Ideas that belong in other slices
   ```

5. **Append significant decisions to `.gsd/DECISIONS.md`**

6. **Update STATE.md** — set phase to plan (ready to plan this milestone/slice)

7. **After completing** — invoke the `gsd-memory` agent with the transcript of this session so learnings are persisted to `.gsd/AUTO-MEMORY.md`.
