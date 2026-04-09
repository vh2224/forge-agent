---
description: "Diagnóstico do projeto GSD — valida coerência do STATE, arquivos de milestone/slice/task, e configuração de prefs. Execute antes de uma run longa para detectar problemas cedo."
allowed-tools: Read, Glob, Bash
---

Run a health check on the GSD project in the current directory. Check every item below, collect all findings, then emit the report at the end.

---

## Checks

### 1. Bootstrap files

```bash
ls CLAUDE.md 2>/dev/null && echo "ok" || echo "missing"
ls .gsd/STATE.md 2>/dev/null && echo "ok" || echo "missing"
ls .gsd/PROJECT.md 2>/dev/null && echo "ok" || echo "missing"
```

- CLAUDE.md missing → `[FAIL] CLAUDE.md não encontrado — execute /forge-init`
- STATE.md missing → `[FAIL] .gsd/STATE.md não encontrado — execute /forge-init`
- PROJECT.md missing → `[WARN] .gsd/PROJECT.md não encontrado`

---

### 2. STATE.md coherence

Read `.gsd/STATE.md`. For each field that names a file, verify the file exists:

- `Active Milestone: M###` → check `.gsd/milestones/M###/` directory exists
- `Active Slice: S##` → check `S##-PLAN.md` exists inside the milestone dir
- `Active Task: T##` → check `T##-PLAN.md` exists inside the slice dir

Flag any missing file as `[FAIL] STATE aponta para {file} mas ele não existe`.

---

### 3. ROADMAP integrity

For the active milestone, read `M###-ROADMAP.md`. For each slice listed:

- If marked `[x]` → verify `S##-SUMMARY.md` exists. Missing → `[WARN] S##` marcado como done mas sem SUMMARY
- If marked `[ ]` → verify `S##-PLAN.md` exists if slice is not the first unstarted one. Missing for a non-active slice → `[INFO] S##-PLAN.md` ainda não criado (normal se slice não iniciado)

---

### 4. Task status integrity

For the active slice, read `S##-PLAN.md`. For each task:

- If marked `[x]` → verify `T##-SUMMARY.md` exists. Missing → `[WARN] T##` marcado como done mas sem SUMMARY
- If `T##-PLAN.md` exists and contains `status: RUNNING` → `[WARN] T##` estava em execução quando a sessão terminou — próximo /forge-next vai re-executar

---

### 5. Prefs validation

Read `~/.claude/forge-agent-prefs.md` (skip if missing). Check the Phase → Agent Routing table:

Valid model IDs: `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`

For each row, if the Model ID column contains an unknown value → `[FAIL] Model ID inválido na fase {phase}: {value}`

Also check `.gsd/claude-agent-prefs.md` if it exists, same validation.

---

### 6. Agent files

Check that all required agent files are installed:

```bash
ls ~/.claude/agents/forge-executor.md 2>/dev/null && echo "ok" || echo "missing"
ls ~/.claude/agents/forge-planner.md 2>/dev/null && echo "ok" || echo "missing"
ls ~/.claude/agents/forge-researcher.md 2>/dev/null && echo "ok" || echo "missing"
ls ~/.claude/agents/forge-discusser.md 2>/dev/null && echo "ok" || echo "missing"
ls ~/.claude/agents/forge-completer.md 2>/dev/null && echo "ok" || echo "missing"
ls ~/.claude/agents/forge-memory.md 2>/dev/null && echo "ok" || echo "missing"
```

Any missing → `[FAIL] Agente {name} não instalado — execute bash install.sh`

---

## Report format

```
forge-doctor — diagnóstico do projeto
══════════════════════════════════════

✓  Bootstrap files OK
✓  STATE.md coherent
⚠  S02-SUMMARY.md ausente (marcado [x] no ROADMAP)
✓  Task status OK
✓  Prefs válidos
✗  forge-researcher não instalado — execute bash install.sh

──────────────────────────────────────
FAILs: 1  WARNs: 1  OK: 4

Ação recomendada: resolva os FAILs antes de rodar /forge-auto.
```

Severity:
- `[FAIL]` → mostrar com ✗, bloqueia execução segura
- `[WARN]` → mostrar com ⚠, pode causar comportamento inesperado
- `[INFO]` → mostrar com ℹ, informativo apenas
- `[OK]` → mostrar com ✓

Se FAILs = 0 e WARNs = 0: `✓ Tudo OK — projeto pronto para /forge-auto`
