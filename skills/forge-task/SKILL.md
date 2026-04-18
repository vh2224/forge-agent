---
name: forge-task
description: "Task autonoma sem milestone — brainstorm, discuss, plan, execute."
allowed-tools: Read, Write, Edit, Bash, Agent, Skill, AskUserQuestion, TaskCreate, TaskUpdate, TaskList, TaskStop, WebSearch, WebFetch
---

## Parse arguments

From `$ARGUMENTS`:
- If contains `--resume TASK-###` → **RESUME MODE**: set `TASK_ID` to that ID, skip init
- `--skip-brainstorm` or `-skip-brainstorm` → `SKIP_BRAINSTORM = true`
- `--skip-research` or `-skip-research` → `SKIP_RESEARCH = true`
- Remaining text after all flags → `TASK_DESCRIPTION`

If `TASK_DESCRIPTION` is empty AND not resume mode → stop and tell the user:
> Descreva a task: `/forge-task <descrição>`
> Para pular brainstorm: `/forge-task --skip-brainstorm <descrição>`

---

## Bootstrap guard

```bash
ls CLAUDE.md 2>/dev/null && echo "ok" || echo "missing"
pwd
```

**Se CLAUDE.md não existe:** Stop. Tell the user:
> Projeto não inicializado. Execute `/forge-init` primeiro.

> **Note:** `/forge-task` não requer `.gsd/STATE.md` — tasks são independentes de milestones.

---

## Load context

Read ONLY these files:
1. `~/.claude/forge-agent-prefs.md` (skip silently if missing)
2. `.gsd/claude-agent-prefs.md` (skip silently if missing)
3. `.gsd/prefs.local.md` (skip silently if missing)
4. First 40 lines of `.gsd/AUTO-MEMORY.md` (skip silently if missing)
5. `.gsd/CODING-STANDARDS.md` (skip silently if missing)

Store: `PREFS`, `TOP_MEMORIES`.

**CODING_STANDARDS section extraction:**
- `CS_LINT` ← `## Lint & Format Commands` section
- `CS_STRUCTURE` ← `## Directory Conventions` + `## Asset Map` + `## Pattern Catalog` sections
- `CS_RULES` ← `## Code Rules` section
If missing, all section variables are `"(none)"`.

**Resolve effort:**
- `EFFORT_OPUS = PREFS.effort.plan or "medium"`
- `EFFORT_EXEC = PREFS.effort.execute or "low"`

Initialize: `session_units = 0`, `COMPACT_AFTER = PREFS.compact_after || 10`
(0 or "unlimited" in PREFS disables the compact signal entirely)

---

## Determine TASK_ID

```bash
mkdir -p .gsd/tasks
ls .gsd/tasks/ 2>/dev/null | grep -oE 'TASK-[0-9]+' | sort -t- -k2 -n | tail -1
```

- Resume mode: `TASK_ID` already set — skip to Dispatch loop
- No tasks exist: `TASK_ID = TASK-001`
- Otherwise: increment last number → `TASK_ID = TASK-NNN` (zero-padded to 3 digits)

---

## Initialize task (skip if resume mode)

```bash
mkdir -p .gsd/tasks/{TASK_ID}
```

Write `.gsd/tasks/{TASK_ID}/{TASK_ID}-BRIEF.md`:
```markdown
---
id: {TASK_ID}
description: {TASK_DESCRIPTION}
created: {ISO8601 date}
skip_brainstorm: {true|false}
skip_research: {true|false}
---

# {TASK_DESCRIPTION}
```

Show the user:
```
→ Iniciando {TASK_ID}: {TASK_DESCRIPTION}
   Fluxo: {brainstorm →} discuss → research → plan → execute
```

---

## Cleanup orphaned tasks

Call `TaskList`. Mark any tasks with `status: in_progress` as `completed` before starting.

---

## Dispatch loop

Execute steps in order. Each step checks if its output file already exists — if yes, skip (idempotent resume). After each dispatch, increment `session_units`. If `session_units >= COMPACT_AFTER` and the task is not yet done, emit the compact signal and stop.

---

### Step 1 — Brainstorm

**Skip if:**
- `SKIP_BRAINSTORM = true`, OR
- `.gsd/tasks/{TASK_ID}/{TASK_ID}-BRAINSTORM.md` already exists

**Create timeline task:**
```
TaskCreate({ subject: "[{TASK_ID}] brainstorm", activeForm: "brainstorm · forge-planner (opus)" })
TaskUpdate({ taskId: <id>, status: "in_progress" })
```

Dispatch `forge-planner` (opus) with this prompt:
```
Brainstorm for forge-task {TASK_ID}: {TASK_DESCRIPTION}
WORKING_DIR: {WORKING_DIR}
effort: {EFFORT_OPUS}
thinking: adaptive

## Task Brief
{content of {TASK_ID}-BRIEF.md}

## Directory Conventions & Asset Map
{CS_STRUCTURE}

## Prior Decisions
{last 20 rows of .gsd/DECISIONS.md if exists, else "(none)"}

## Project Memory
{TOP_MEMORIES}

## Instructions
Produce a lightweight brainstorm for this task. Write {TASK_ID}-BRAINSTORM.md to
.gsd/tasks/{TASK_ID}/ with exactly these sections:

# Brainstorm: {TASK_DESCRIPTION}
**Date:** YYYY-MM-DD

## Recommended Approach
[One paragraph — best balance of speed, risk, and value for this specific task]

## Alternatives Considered
| Approach | Trade-off |
|----------|-----------|
| ... | ... |

## Top Risks
1. [Specific risk] — [early signal / mitigation]
2. ...

## Out of Scope
- [What this task should NOT touch — be explicit]

## Open Questions for Discuss
- [Specific questions the user must answer before planning]

Keep it concise — this is a scoping aid, not a plan. Max 1 page.
Return ---GSD-WORKER-RESULT---.
```

After result: `TaskUpdate({ status: "completed" })`, `session_units += 1`.

---

### Step 2 — Discuss

**Skip if:** `.gsd/tasks/{TASK_ID}/{TASK_ID}-CONTEXT.md` already exists

**Create timeline task:**
```
TaskCreate({ subject: "[{TASK_ID}] discuss", activeForm: "discuss · forge-discusser (opus)" })
TaskUpdate({ taskId: <id>, status: "in_progress" })
```

Dispatch `forge-discusser` (opus) with this prompt:
```
Discuss forge-task {TASK_ID}: {TASK_DESCRIPTION}
WORKING_DIR: {WORKING_DIR}
effort: {EFFORT_OPUS}
thinking: adaptive

## Task Brief
{content of {TASK_ID}-BRIEF.md}

## Brainstorm Output
{content of {TASK_ID}-BRAINSTORM.md if exists, else "(none — brainstorm was skipped)"}

## Prior Decisions (do not re-debate)
{last 20 rows of .gsd/DECISIONS.md if exists, else "(none)"}

## Project Memory
{TOP_MEMORIES}

## Instructions
Score clarity (scope/acceptance/tech/dependencies/risk). Ask about dimensions below 70.
Write {TASK_ID}-CONTEXT.md to .gsd/tasks/{TASK_ID}/ with sections:
  ## Decisions, ## Agent's Discretion, ## Open Questions, ## Out of Scope
Append significant decisions to .gsd/DECISIONS.md.
Return ---GSD-WORKER-RESULT---.
```

After result: `TaskUpdate({ status: "completed" })`, `session_units += 1`.

---

### Step 3 — Research

**Skip if:**
- `SKIP_RESEARCH = true`, OR
- `.gsd/tasks/{TASK_ID}/{TASK_ID}-RESEARCH.md` already exists

**Create timeline task:**
```
TaskCreate({ subject: "[{TASK_ID}] research", activeForm: "research · forge-researcher (opus)" })
TaskUpdate({ taskId: <id>, status: "in_progress" })
```

Dispatch `forge-researcher` (opus) with this prompt:
```
Research codebase for forge-task {TASK_ID}: {TASK_DESCRIPTION}
WORKING_DIR: {WORKING_DIR}
effort: {EFFORT_OPUS}
thinking: adaptive

## Task Brief
{content of {TASK_ID}-BRIEF.md}

## Task Decisions
{## Decisions section of {TASK_ID}-CONTEXT.md if exists, else "(none)"}

## Current Coding Standards
{full .gsd/CODING-STANDARDS.md or "(none)"}

## Project Memory (known gotchas)
{TOP_MEMORIES}

## Instructions
Explore the codebase relevant to this task. Write {TASK_ID}-RESEARCH.md to
.gsd/tasks/{TASK_ID}/ with:
- ## Summary: what exists today that's relevant
- ## Don't Hand-Roll: libraries/patterns/components already in the codebase to reuse
- ## Common Pitfalls: found in existing code or well-known for this stack
- ## Relevant Code: file:line references for key sections
- ## Reusable Assets: functions/hooks/services to leverage directly
- ## External Research: (include if web searches were done — source URL + 1-line takeaway)

**Web research:** If the Task Brief references specific URLs — fetch them. Do up to 3 targeted
web searches for pitfalls, breaking changes, or best practices relevant to named libraries/APIs.
After writing RESEARCH.md, update .gsd/CODING-STANDARDS.md with any new findings.
Return ---GSD-WORKER-RESULT---.
```

After result: `TaskUpdate({ status: "completed" })`, `session_units += 1`.

---

### Step 4 — Plan

**Skip if:** `.gsd/tasks/{TASK_ID}/{TASK_ID}-PLAN.md` already exists

**Security gate:** Scan `{TASK_ID}-BRIEF.md` + `{TASK_ID}-CONTEXT.md` for:
`auth|token|crypto|password|secret|api.?key|jwt|oauth|permission|role|hash|salt|encrypt|decrypt|session|cookie|credential|sanitize|xss|sql|inject`

If any match AND `.gsd/tasks/{TASK_ID}/{TASK_ID}-SECURITY.md` does not exist:
```
Skill({ skill: "forge-security", args: "{TASK_ID}" })
```

**Create timeline task:**
```
TaskCreate({ subject: "[{TASK_ID}] plan", activeForm: "plan · forge-planner (opus)" })
TaskUpdate({ taskId: <id>, status: "in_progress" })
```

Dispatch `forge-planner` (opus) with this prompt:
```
Plan forge-task {TASK_ID}: {TASK_DESCRIPTION}
WORKING_DIR: {WORKING_DIR}
effort: {EFFORT_OPUS}
thinking: adaptive

## Task Brief
{content of {TASK_ID}-BRIEF.md}

## Task Decisions
{## Decisions section of {TASK_ID}-CONTEXT.md if exists, else "(none)"}

## Research Findings
{content of {TASK_ID}-RESEARCH.md if exists, else "(none — research was skipped)"}

## Security Checklist
{content of {TASK_ID}-SECURITY.md if exists, else "(none)"}

## Directory Conventions & Asset Map
{CS_STRUCTURE}

## Code Rules
{CS_RULES}

## Project Memory
{TOP_MEMORIES}

## Instructions
Write {TASK_ID}-PLAN.md to .gsd/tasks/{TASK_ID}/ with exactly these sections:

## Steps
[Ordered numbered list of implementation steps. Each step is a single concrete action.]

## Must-Haves
[Verifiable acceptance criteria — each item checkable with a command or observable behavior]

## Standards
[Relevant coding rules from CODING-STANDARDS.md for this task's scope]

## Files to Change
[List of files expected to be modified, with one-line reason for each]

Iron rule: this task MUST fit in ONE context window for the executor.
If scope is too large, plan the most valuable subset and note what was deferred in ## Deferred.
Return ---GSD-WORKER-RESULT---.
```

After result: `TaskUpdate({ status: "completed" })`, `session_units += 1`.

---

### Step 5 — Execute

**Skip if:** `.gsd/tasks/{TASK_ID}/{TASK_ID}-SUMMARY.md` already exists (task done).

**Record pre-execute HEAD SHA** (persisted to file so Step 5.5 can diff after executor commits):
```bash
git rev-parse HEAD 2>/dev/null > .gsd/tasks/{TASK_ID}/.start-sha || echo "" > .gsd/tasks/{TASK_ID}/.start-sha
```

**Create timeline task:**
```
TaskCreate({ subject: "[{TASK_ID}] execute", activeForm: "execute · forge-executor (sonnet)" })
TaskUpdate({ taskId: <id>, status: "in_progress" })
```

Dispatch `forge-executor` (sonnet) with this prompt:
```
Execute forge-task {TASK_ID}: {TASK_DESCRIPTION}
WORKING_DIR: {WORKING_DIR}
auto_commit: {PREFS.auto_commit — true or false}
effort: {EFFORT_EXEC}
thinking: disabled

## Task Plan
{content of {TASK_ID}-PLAN.md}

## Research Findings
{content of {TASK_ID}-RESEARCH.md if exists, else "(none)"}

## Lint & Format Commands
{CS_LINT}

## Security Checklist
{content of {TASK_ID}-SECURITY.md if exists, else "(none — no security-sensitive scope)"}

## Task Decisions
{## Decisions section of {TASK_ID}-CONTEXT.md if exists, else "(none)"}

## Project Memory
{TOP_MEMORIES}

## Instructions
Execute all steps in ## Task Plan.
Verify every must-have. Run lint/format if CS_LINT is present.
If ## Security Checklist is present — treat each item as a must-have.
Write {TASK_ID}-SUMMARY.md to .gsd/tasks/{TASK_ID}/ with:
  ---
  id: {TASK_ID}
  description: {TASK_DESCRIPTION}
  status: done
  key_files: [list]
  key_decisions: [list]
  ---
  ## What Was Done
  [Narrative summary of changes made]
  ## Must-Haves Verified
  - [x] item 1
  - [x] item 2
If auto_commit is true: commit with message "feat({TASK_ID}): {one-liner description}".
If auto_commit is false: do NOT run any git commands.
Do NOT modify STATE.md. Return ---GSD-WORKER-RESULT---.
```

**Process result:**
- `status: done` → `TaskUpdate({ status: "completed" })`, proceed to post-task
- `status: partial` → `TaskUpdate` left in_progress, emit compact signal, stop
- `status: blocked` → surface blocker to user, stop

`session_units += 1`

---

### Step 5.5 — Review (advisory)

**Skip if:**
- `review.mode: disabled` in merged prefs, OR
- `{TASK_ID}-SUMMARY.md` already contains `## ⚠ Review Flags` section (idempotent resume)

**Read `review.mode` pref** (same cascade as forge-completer):
```bash
node -e "
const fs=require('fs'),path=require('path'),os=require('os');
const files=[path.join(os.homedir(),'.claude','forge-agent-prefs.md'),
             path.join('{WORKING_DIR}','.gsd','claude-agent-prefs.md'),
             path.join('{WORKING_DIR}','.gsd','prefs.local.md')];
let mode='enabled';
for(const f of files){try{const r=fs.readFileSync(f,'utf8');const m=r.match(/^review:[ \t]*\n[ \t]+mode:[ \t]*(\w+)/m);if(m)mode=m[1].toLowerCase();}catch{}}
process.stdout.write(mode);
"
```
If `disabled` → skip Step 5.5 entirely.

**Compute DIFF_CMD:**
```bash
START_SHA=$(cat .gsd/tasks/{TASK_ID}/.start-sha 2>/dev/null || echo "")
if [ -n "$START_SHA" ] && git rev-parse "$START_SHA" >/dev/null 2>&1 && [ "$START_SHA" != "$(git rev-parse HEAD 2>/dev/null)" ]; then
  DIFF_CMD="git diff ${START_SHA}..HEAD"
else
  DIFF_CMD="git diff HEAD"
fi
```
`git diff HEAD` is the fallback for `auto_commit: false` (working-tree changes) or when no commit happened.

**Pattern scan.** Grep changed files (from `$DIFF_CMD --name-only`) for the same patterns as forge-completer step 4a. Collect `PATTERN_HITS`.

**Create timeline task:**
```
TaskCreate({ subject: "[{TASK_ID}] review", activeForm: "review · forge-reviewer (sonnet)" })
TaskUpdate({ taskId: <id>, status: "in_progress" })
```

**Dispatch forge-reviewer:**
```
Agent("forge-reviewer", "WORKING_DIR: {WORKING_DIR}\nUNIT: task/{TASK_ID}\nDIFF_CMD: {DIFF_CMD}")
```
If the `Agent()` call throws → `LLM_FINDINGS = ""` + one-line note in event log; continue. Review failures never abort the task.

**Merge & append.** Build `## ⚠ Review Flags` section (same rules as forge-completer 4c) and append to `{TASK_ID}-SUMMARY.md`. If both `PATTERN_HITS` and `LLM_FINDINGS` are empty → skip append entirely.

**Follow-up commit** (only if `auto_commit: true` AND the section was written):
```bash
git add .gsd/tasks/{TASK_ID}/{TASK_ID}-SUMMARY.md
git commit -m "chore({TASK_ID}): append review flags"
```
Do NOT amend the `feat({TASK_ID})` commit — create a distinct follow-up. If no section was written, skip the commit.

After: `TaskUpdate({ status: "completed" })`, `session_units += 1`.

Clean up `.start-sha` marker:
```bash
rm -f .gsd/tasks/{TASK_ID}/.start-sha
```

---

## Post-task housekeeping

**Append to event log:**
```bash
mkdir -p .gsd/forge
```
```json
{"ts":"{ISO8601}","unit":"task/{TASK_ID}","agent":"forge-executor","status":"done","summary":"{one-liner from SUMMARY.md}"}
```

**Memory extraction:**
```
Agent("forge-memory", "WORKING_DIR: {WORKING_DIR}\nUNIT_TYPE: execute-task\nUNIT_ID: {TASK_ID}\n\nSUMMARY_CONTENT:\n{content of {TASK_ID}-SUMMARY.md}\n\nRESULT_BLOCK:\n{full ---GSD-WORKER-RESULT--- block verbatim}\n\nKEY_DECISIONS:\n{key_decisions from SUMMARY.md frontmatter, or '(none)'}")
```

**Write ledger entry** — append a compact entry to `.gsd/LEDGER.md` (create if missing, same file used by milestones):
```markdown
## {TASK_ID} — {TASK_DESCRIPTION} · {YYYY-MM-DD}

{2-sentence description of what was done and why it matters}

**Key files:** path/to/file, path/to/file (up to 5)
**Key decisions:** one-liner (if any, else omit line)

---
```
Keep each entry under 10 lines. This is the only task artifact that persists regardless of `task_cleanup` setting.

**Cleanup task artifacts** — based on `task_cleanup` from PREFS (default: `keep`):
- `keep`: do nothing — all files remain in `.gsd/tasks/{TASK_ID}/`
- `archive`: move the task directory to archive:
  ```bash
  mkdir -p .gsd/archive/tasks
  mv .gsd/tasks/{TASK_ID} .gsd/archive/tasks/{TASK_ID}
  ```
- `delete`: remove the task directory entirely:
  ```bash
  rm -rf .gsd/tasks/{TASK_ID}
  ```
In all cases `.gsd/LEDGER.md`, `AUTO-MEMORY.md`, `DECISIONS.md`, and `CODING-STANDARDS.md` are never touched.

**Final report:**
```
✓ {TASK_ID} concluída: {TASK_DESCRIPTION}

Arquivos modificados:
{key_files from SUMMARY.md, one per line}

Must-haves: todos verificados ✓

→ Nova task: /forge-task <descrição>
→ Ver tasks: /forge-status
```

---

## Compact signal

If `session_units >= COMPACT_AFTER` and `{TASK_ID}-SUMMARY.md` does not yet exist:

```
---GSD-COMPACT---
task: {TASK_ID}
session_units: {N}
resume: /forge-task --resume {TASK_ID}
---

Batch de {N} unidades completo para {TASK_ID}.
Execute /forge-task --resume {TASK_ID} para continuar.
```
