---
description: "Corrige problemas no projeto GSD — repara STATE, arquivos ausentes, frontmatter, prefs e estrutura. Use: /forge-fix | /forge-fix --dry-run (apenas mostra o que faria)"
allowed-tools: Read, Write, Edit, Bash, Glob
---

Run a health check on the GSD project and **fix every issue found**. Collect all findings, apply fixes, then emit the report at the end.

## Input
$ARGUMENTS

If `$ARGUMENTS` contains `--dry-run`: do NOT write any files. Run all checks, list what would be fixed, but skip all write/edit operations. Report with `[DRY RUN]` prefix.

---

## Pre-flight

```bash
ls CLAUDE.md 2>/dev/null && echo "claude:ok" || echo "claude:missing"
ls .gsd/STATE.md 2>/dev/null && echo "state:ok" || echo "state:missing"
ls .gsd/PROJECT.md 2>/dev/null && echo "project:ok" || echo "project:missing"
```

If `.gsd/STATE.md` is missing → tell user `Projeto GSD não inicializado. Execute /forge-init primeiro.` and **stop**. The fix command cannot operate without a base structure.

---

## Fix 1: STATE.md coherence

Read `.gsd/STATE.md`. Extract the active milestone, slice, task, and phase.

**1a. Milestone pointer**
If `Active Milestone: M###` and `.gsd/milestones/M###/` does NOT exist:
- Scan `.gsd/milestones/` for existing milestone directories
- If any exist → set Active Milestone to the last one (highest M number). Set slice/task to `none`, phase to `idle`
- If none exist → set all to `none`, phase to `idle`
- **FIX:** Edit STATE.md with corrected values
- **LOG:** `[FIXED] STATE.md apontava para M### inexistente → corrigido para {new value}`

**1b. Slice pointer**
If `Active Slice: S##` and the slice directory or `S##-PLAN.md` does NOT exist inside the active milestone:
- Scan the milestone's `slices/` for existing slice directories
- Read `M###-ROADMAP.md` to find the first `[ ]` (unstarted) slice
- Set Active Slice to that, Active Task to `none`
- **FIX:** Edit STATE.md
- **LOG:** `[FIXED] STATE.md apontava para S## inexistente → corrigido para {new value}`

**1c. Task pointer**
If `Active Task: T##` and `T##-PLAN.md` does NOT exist inside the active slice:
- Read `S##-PLAN.md` to find the first `[ ]` (unstarted) task
- Set Active Task to that task, phase to `execute`
- **FIX:** Edit STATE.md
- **LOG:** `[FIXED] STATE.md apontava para T## inexistente → corrigido para {new value}`

**1d. Phase vs state consistency**
- If phase is `resume` but no `continue.md` exists in the active slice dir → set phase to `execute`
- If phase is `execute` but Active Task is `none` → set phase to `plan-slice` (or `idle` if no slice)
- **FIX:** Edit STATE.md
- **LOG:** `[FIXED] Phase "{old}" inconsistente → corrigido para "{new}"`

If STATE is already coherent → `[OK] STATE.md coerente`

---

## Fix 2: ROADMAP integrity

For the active milestone, read `M###-ROADMAP.md`. If the file does NOT exist:
- **SKIP** — this is a FAIL that requires `/forge-next` to run discuss/plan. Log: `[SKIP] M###-ROADMAP.md ausente — execute /forge-next para gerar`
- Continue to next check.

If it exists, for each slice listed:

**2a. Done slice without summary**
If marked `[x]` and `S##-SUMMARY.md` does NOT exist:
- Check if all tasks in that slice's `S##-PLAN.md` are marked `[x]`
- If yes → create a stub `S##-SUMMARY.md`:
  ```markdown
  ---
  id: S##
  milestone: M###
  status: done
  recovered_by: forge-fix
  ---

  ## Summary
  Slice completado. Summary gerado automaticamente pelo forge-fix — detalhes nos T##-SUMMARY.md individuais.
  ```
- If not all tasks are done → unmark the slice: change `[x]` to `[ ]` in the ROADMAP
- **LOG:** `[FIXED] S## marcado [x] sem SUMMARY → {created stub | unmarked}`

**2b. Missing Boundary Map**
If `## Boundary Map` section is absent from the ROADMAP:
- Append a stub section:
  ```markdown

  ## Boundary Map

  <!-- Será preenchido pelo forge-planner na próxima execução -->
  ```
- **LOG:** `[FIXED] Boundary Map ausente no ROADMAP → stub adicionado`

If ROADMAP is consistent → `[OK] ROADMAP íntegro`

---

## Fix 3: Task status integrity

For the active slice, read `S##-PLAN.md`. If it does NOT exist → `[SKIP] S##-PLAN.md ausente`. Continue.

For each task listed:

**3a. Done task without summary**
If marked `[x]` and `T##-SUMMARY.md` does NOT exist:
- Create a minimal stub:
  ```markdown
  ---
  id: T##
  parent: S##
  milestone: M###
  verification_result: unknown
  recovered_by: forge-fix
  completed_at: <current ISO8601>
  ---

  Task completada. Summary recuperado automaticamente pelo forge-fix.

  ## Files Created/Modified
  (verificar via git log)
  ```
- **LOG:** `[FIXED] T## marcado [x] sem SUMMARY → stub criado`

**3b. Stuck RUNNING status**
If `T##-PLAN.md` contains `status: RUNNING` in frontmatter:
- Remove the `status: RUNNING` line (or the entire frontmatter block if `status` is the only field)
- This allows the next `/forge-next` to re-execute the task cleanly
- **LOG:** `[FIXED] T## com status: RUNNING → removido (será re-executado)`

**3c. Task plan missing required sections**
Read each `T##-PLAN.md` that exists. Check for these required sections:
- `## Goal`
- `## Must-Haves`
- `## Steps`

If any section is missing:
- Append the missing section with a placeholder:
  ```markdown
  ## {Section Name}
  (pendente — será preenchido na próxima execução do planner)
  ```
- **LOG:** `[FIXED] T##-PLAN.md sem seção {Section} → stub adicionado`

If all tasks are consistent → `[OK] Tasks íntegras`

---

## Fix 4: Prefs validation

Read `~/.claude/forge-agent-prefs.md` (skip if missing).
Also read `.gsd/claude-agent-prefs.md` (skip if missing).

Valid model IDs: `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`

Valid aliases that should be expanded: `opus` → `claude-opus-4-6`, `sonnet` → `claude-sonnet-4-6`, `haiku` → `claude-haiku-4-5-20251001`

For each Phase → Agent Routing table row:
- If Model ID is a valid alias → expand to full ID
- If Model ID is completely invalid → replace with the default for that phase (use the defaults from the template in forge-init)
- **FIX:** Edit the prefs file
- **LOG:** `[FIXED] Model ID na fase {phase}: "{old}" → "{new}"`

If all prefs are valid → `[OK] Prefs válidos`

---

## Fix 5: Agent files

Check all 6 required agents exist:

```bash
ls ~/.claude/agents/forge-executor.md ~/.claude/agents/forge-planner.md ~/.claude/agents/forge-researcher.md ~/.claude/agents/forge-discusser.md ~/.claude/agents/forge-completer.md ~/.claude/agents/forge-memory.md 2>/dev/null
```

If any are missing:
- Check if the install.sh path is known from prefs (`repo_path`)
- If yes → run `bash "{repo_path}/install.sh" --update 2>&1`
- **LOG:** `[FIXED] Agentes reinstalados via install.sh`
- If repo_path unknown → `[SKIP] Agentes ausentes — execute bash /path/to/install.sh`

If all agents present → `[OK] Agentes instalados`

---

## Fix 6: Structural files

**6a. DECISIONS.md**
If `.gsd/DECISIONS.md` exists, read it. Check that it has the table header:
```
| # | When | Scope | Decision | Choice | Rationale | Revisable? |
|---|------|-------|----------|--------|-----------|------------|
```

If the table header is missing or malformed → rewrite the file preserving any existing rows but fixing the header format.
- **LOG:** `[FIXED] DECISIONS.md — header da tabela corrigido`

If `.gsd/DECISIONS.md` does NOT exist → create it from template (see forge-init).
- **LOG:** `[FIXED] DECISIONS.md criado`

**6b. AUTO-MEMORY.md**
If `.gsd/AUTO-MEMORY.md` exists, read the first 2 lines. If the header comment (`<!-- gsd-auto-memory ...`) is missing:
- Prepend the header:
  ```
  <!-- gsd-auto-memory | project: <from PROJECT.md> | extraction_count: 0 -->
  <!-- ranked by: confidence × (1 + hits × 0.1) | cap: 50 active -->
  ```
- **LOG:** `[FIXED] AUTO-MEMORY.md — header restaurado`

If `.gsd/AUTO-MEMORY.md` does NOT exist → create with header only.
- **LOG:** `[FIXED] AUTO-MEMORY.md criado`

**6c. CODING-STANDARDS.md**
If `.gsd/CODING-STANDARDS.md` does NOT exist:
- Run the Coding Standards Auto-Detection logic from forge-init (detect configs, directories, commands)
- Write the file
- **LOG:** `[FIXED] CODING-STANDARDS.md criado (auto-detected)`

If it exists → `[OK]` (don't overwrite user customizations)

**6d. Orphan continue.md**
If `continue.md` exists in the active slice dir but STATE phase is NOT `resume`:
- Read it to check if it has useful content
- If it has `## Remaining Work` with content → update STATE phase to `resume`
- If it's empty or trivial → delete it
- **LOG:** `[FIXED] continue.md órfão → {phase set to resume | deleted}`

**6e. events.jsonl**
If `.gsd/forge/events.jsonl` exists, validate each line is valid JSON:
```bash
# Count invalid lines
python3 -c "
import json, sys
bad = 0
with open('.gsd/forge/events.jsonl') as f:
    lines = f.readlines()
for i, line in enumerate(lines):
    line = line.strip()
    if not line: continue
    try: json.loads(line)
    except: bad += 1; print(f'line {i+1}', file=sys.stderr)
print(bad)
" 2>/tmp/forge-fix-bad-lines.txt
```

If bad lines > 0 → remove them (filter to only valid JSON lines) and rewrite the file.
- **LOG:** `[FIXED] events.jsonl — {N} linhas inválidas removidas`

If all structural files are fine → `[OK] Arquivos estruturais OK`

---

## Fix 7: gitignore hygiene

Check that `.gsd/prefs.local.md` is in `.gitignore`:
```bash
grep -q "prefs.local.md" .gitignore 2>/dev/null && echo "ok" || echo "missing"
```

If missing → append:
```bash
echo ".gsd/prefs.local.md" >> .gitignore
```
- **LOG:** `[FIXED] .gitignore — adicionado .gsd/prefs.local.md`

If already present → no log needed, skip silently.

---

## Report format

```
forge-fix — correção do projeto
═══════════════════════════════

✓  STATE.md coerente
🔧 S02 marcado [x] sem SUMMARY → stub criado
🔧 T03 com status: RUNNING → removido
✓  Prefs válidos
✓  Agentes instalados
🔧 DECISIONS.md criado
✓  .gitignore OK

──────────────────────────────
Corrigidos: 3  OK: 4  Skipped: 0

Projeto pronto para /forge-auto.
```

Icons:
- `✓` → already OK, no fix needed
- `🔧` → fixed automatically
- `⏭` → skipped (needs manual action or another command)

If `--dry-run` was passed, replace `🔧` with `👁` and add `[DRY RUN]` to each line. Append:
```
Nenhum arquivo foi alterado. Execute /forge-fix sem --dry-run para aplicar.
```

If there were skipped items, list recommended actions:
```
Ações manuais necessárias:
  - M002-ROADMAP.md ausente → execute /forge-next
  - Agentes ausentes → execute bash install.sh
```
