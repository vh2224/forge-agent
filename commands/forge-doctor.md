---
description: "Diagnóstico e correção do projeto GSD. Use: /forge-doctor | /forge-doctor --fix | /forge-doctor --fix --dry-run"
allowed-tools: Read, Write, Edit, Bash, Glob
---

## Modes
- (no flags) → diagnose only, no writes
- `--fix` → diagnose + fix
- `--fix --dry-run` → show what --fix would do, no writes

FIX_MODE = `--fix` in $ARGUMENTS. DRY_RUN = `--dry-run` in $ARGUMENTS.

## Convention
Each check produces findings. In fix mode, apply the fix. In diagnose/dry-run, only report.
Emit one line per finding: `✓/⚠/✗/🔧/👁/⏭  <message>`.

---

## Pre-flight

Run in parallel:
```bash
ls CLAUDE.md .gsd/STATE.md .gsd/PROJECT.md .gsd/DECISIONS.md .gsd/AUTO-MEMORY.md .gsd/CODING-STANDARDS.md 2>/dev/null
```
Read in parallel: `.gsd/STATE.md`, `.gsd/PROJECT.md`, `~/.claude/forge-agent-prefs.md`, `.gsd/claude-agent-prefs.md`.

STATE missing → `Projeto não inicializado. Execute /forge-init.` and stop.

Extract from STATE: M=ActiveMilestone, S=ActiveSlice, T=ActiveTask, P=Phase.

---

## C1: STATE coherence

**C1a** — If M≠none and `.gsd/milestones/M/` missing:
```bash
ls -d .gsd/milestones/M*/ 2>/dev/null | sort -V | tail -1
```
Fix: set M to last existing (or `none`), S/T=none, P=idle. Edit STATE.

**C1b** — If S≠none and `.gsd/milestones/M/slices/S/` missing:
Fix: read ROADMAP → first `[ ]` slice → set S to it, T=none. If no ROADMAP or no unstarted slice → S=none, P=plan-milestone. Edit STATE.

**C1c** — If T≠none and `tasks/T-PLAN.md` missing in active slice:
Fix: read S-PLAN.md → first task without `status: DONE` in frontmatter → set T to it, P=execute. If none → T=none, P=complete-slice. Edit STATE.

**C1d** — Phase inconsistency (apply first match only):

| Condition | Fix |
|-----------|-----|
| P=resume, no continue.md in active slice | P=execute |
| P=execute, T=none | P=plan-slice (idle if M=none) |
| P=plan-slice, S-PLAN.md exists | P=execute |
| P=complete-slice, slice has pending tasks | P=execute |
| P=plan-milestone, ROADMAP exists | P=plan-slice |
| P≠idle, M=none | P=idle |

---

## C2: Checkbox sync

Scope: ALL slices under active milestone.
```bash
ls -d .gsd/milestones/M/slices/S*/ 2>/dev/null
```

**C2a — Task checkboxes** (per slice, read S-PLAN.md + each T-PLAN.md frontmatter):

| S-PLAN `[ ]`/`[x]` | T-PLAN status | SUMMARY | Action |
|---|---|---|---|
| `[ ]` | DONE | yes | mark `[x]` |
| `[ ]` | DONE | no | mark `[x]` + create SUMMARY stub |
| `[x]` | ≠DONE or missing | — | unmark to `[ ]` |
| `[x]` | DONE | no | create SUMMARY stub |
| `[x]` | DONE | yes | OK |
| `[ ]` | ≠DONE | — | OK |

**C2b — Slice checkboxes** (read ROADMAP, skip if missing):
A slice is done when all its tasks are `[x]` after C2a.

| ROADMAP `[ ]`/`[x]` | All tasks done | SUMMARY | Action |
|---|---|---|---|
| `[ ]` | yes | yes | mark `[x]` |
| `[ ]` | yes | no | mark `[x]` + create SUMMARY stub |
| `[x]` | no | — | unmark to `[ ]` |
| `[x]` | yes | no | create SUMMARY stub |
| `[x]` | yes | yes | OK |
| `[ ]` | no | — | OK |

**Stub formats** (fill M/S/T from context, ISO8601 timestamp for completed_at):

T-SUMMARY stub:
```
---
id: T  parent: S  milestone: M
verification_result: unknown  recovered_by: forge-doctor  completed_at: NOW
---
(verificar via git log)
```

S-SUMMARY stub:
```
---
id: S  milestone: M  status: done  recovered_by: forge-doctor
---
Detalhes nos T-SUMMARY individuais.
```

---

## C3: Stuck tasks (active slice only)

**C3a** — Files with `status: RUNNING`:
```bash
grep -l "status: RUNNING" .gsd/milestones/M/slices/S/tasks/T*-PLAN.md 2>/dev/null
```
Fix: remove `status: RUNNING` line from each.

**C3b** — T-PLAN.md missing required sections (`## Goal`, `## Must-Haves`, `## Steps`, `## Standards`):
Fix: append each missing section as `## Name\n(pendente)`.

---

## C4: Orphan continue.md

```bash
find .gsd/milestones -name "continue.md" 2>/dev/null
```

For each, extract its slice from the path. `active` = belongs to current S.

| P=resume | active | has `## Remaining Work` | Action |
|---|---|---|---|
| yes | yes | yes | OK |
| yes | no | — | delete |
| no | yes | yes | set P=resume in STATE |
| no | yes | no | delete |
| no | no | — | delete |

Also: if active task has `status: DONE` and continue.md exists in that slice → delete.

---

## C5: Prefs

Valid IDs: `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`
Aliases: opus→opus-4-6, sonnet→sonnet-4-6, haiku→haiku-4-5-20251001 (expand to full ID on fix)

Defaults: discuss/research/plan phases → opus-4-6 | execute/complete → sonnet-4-6 | memory → haiku-4-5-20251001

Check both prefs files (already loaded). For each routing table row: alias → expand; invalid ID → replace with default.

---

## C6: Agent files

```bash
ls ~/.claude/agents/forge-{executor,planner,researcher,discusser,completer,memory}.md 2>&1
```
Missing → Fix: `bash "$(grep repo_path ~/.claude/forge-agent-prefs.md | cut -d' ' -f2)/install.sh" --update`
If repo_path unknown → `[SKIP] execute bash install.sh`.

---

## C7: Structural files

| File | Check | Fix |
|------|-------|-----|
| `.gsd/DECISIONS.md` | exists + has `\| # \| When \| Scope...` header | create or fix header (preserve data rows) |
| `.gsd/AUTO-MEMORY.md` | first line starts with `<!-- gsd-auto-memory \|` | create or prepend header |
| `.gsd/CODING-STANDARDS.md` | exists | create via forge-init auto-detection (never overwrite) |
| `M-ROADMAP.md` | contains `## Boundary Map` | append stub `## Boundary Map\n<!-- forge-planner preencherá -->` |
| `.gsd/forge/events.jsonl` | each non-empty line starts with `{` and ends with `}` | rewrite keeping only valid lines |

AUTO-MEMORY header:
```
<!-- gsd-auto-memory | project: NAME | extraction_count: 0 -->
<!-- ranked by: confidence × (1 + hits × 0.1) | cap: 50 active -->
```

CODING-STANDARDS detection (if creating):
```bash
ls package.json pyproject.toml Cargo.toml go.mod pom.xml .eslintrc* tsconfig.json .prettierrc* .editorconfig 2>/dev/null
ls -d src/ lib/ app/ components/ utils/ services/ tests/ __tests__/ 2>/dev/null
```
Use forge-init template to generate the file.

---

## C8: gitignore

```bash
grep -q "prefs.local.md" .gitignore 2>/dev/null || echo missing
```
Missing → append `.gsd/prefs.local.md` to `.gitignore`.

---

## Report

Header line:
- diagnose: `forge-doctor — diagnóstico`
- fix: `forge-doctor --fix — correção`
- dry-run: `forge-doctor --fix --dry-run — preview`

Icons: `✓` OK · `⚠` warn · `✗` fail · `🔧` fixed · `👁` would fix · `⏭` skipped

Footer:
- diagnose: `FAILs: N  WARNs: N  OK: N` + if any issues: `Para corrigir: /forge-doctor --fix`
- fix: `Corrigidos: N  OK: N  Skipped: N` + if all clear: `Projeto pronto para /forge-auto`
- dry-run: same as fix counts + `Nenhum arquivo alterado. Execute /forge-doctor --fix para aplicar.`

Skipped items → list with suggested command.
