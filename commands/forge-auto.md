---
description: "GSD auto mode — executa o milestone inteiro de forma autônoma. Equivalente ao /forge-auto do gsd-pi."
allowed-tools: Read, Write, Edit, Bash, Agent, Skill, TaskCreate, TaskUpdate, TaskList, TaskStop, WebSearch, WebFetch
---

## Bootstrap guard

```bash
ls CLAUDE.md 2>/dev/null && echo "ok" || echo "missing"
ls .gsd/STATE.md 2>/dev/null && echo "ok" || echo "missing"
pwd
```

**Se CLAUDE.md não existe:** Stop. Tell the user:
> Projeto não inicializado. Execute `/forge-init` primeiro — isso cria o `CLAUDE.md` que restaura o contexto automaticamente ao reabrir o chat.

**Se .gsd/STATE.md não existe:** Stop. Tell the user:
> Nenhum projeto GSD encontrado neste diretório. Execute `/forge-init` para começar.

---

## Load context

Read ONLY these files:
1. `.gsd/STATE.md`
2. `~/.claude/forge-agent-prefs.md` (user-global defaults — skip silently if missing)
3. `.gsd/claude-agent-prefs.md` (repo-level shared prefs — overrides user-global)
4. `.gsd/prefs.local.md` (local personal overrides — gitignored, overrides repo prefs)
5. First 40 lines of `.gsd/AUTO-MEMORY.md` (skip silently if missing)
6. `.gsd/CODING-STANDARDS.md` (skip silently if missing)

**Merge order:** later files override earlier ones for any key present. Missing files are skipped silently. Store merged result as `PREFS`.

**Extract effort & thinking from PREFS:**
- `EFFORT_MAP` ← `PREFS.effort` (per-phase effort table; default: opus phases = `medium`, sonnet phases = `low`)
- `THINKING_OPUS` ← `PREFS.thinking.opus_phases` (default: `adaptive`)

Store as: `STATE`, `PREFS`, `TOP_MEMORIES`, `CODING_STANDARDS`.

**CODING_STANDARDS section extraction** — to minimize token usage, extract these named sections from the file for selective injection:
- `CS_LINT` — content of `## Lint & Format Commands` section only
- `CS_STRUCTURE` — content of `## Directory Conventions` + `## Asset Map` + `## Pattern Catalog` sections
- `CS_RULES` — content of `## Code Rules` section only
If CODING-STANDARDS.md is missing, all section variables are `"(none)"`.

Initialize:
```
session_units = 0
COMPACT_AFTER = 5
completed_units = []
```

**Cleanup orphaned tasks** — call `TaskList`. If any tasks have `status: in_progress` (leftover from a previous crashed session), mark them completed to keep the UI clean:
```
TaskUpdate({ taskId: <id>, status: "completed" })
```
Do this for ALL in_progress tasks before starting the loop. Skip if TaskList returns empty.

---

## Orchestrate — AUTO MODE

**Activate auto-mode indicator** — write marker so the status line shows `▶ AUTO`:
```bash
mkdir -p .gsd/forge && echo '{"active":true,"started_at":'$(date +%s000)'}' > .gsd/forge/auto-mode.json
```

You are the orchestrator. Execute the dispatch loop, repeating until: milestone complete, blocked, or `session_units >= COMPACT_AFTER`.

**AUTONOMY RULE — CRITICAL:** This is FULLY AUTONOMOUS mode. After each unit completes with `status: done`, proceed IMMEDIATELY to the next unit. Do NOT pause to ask the user if they want to continue. Do NOT ask for confirmation between units. Do NOT summarize progress and wait for input. The ONLY reasons to stop the loop are: milestone complete, worker returned `blocked`/`partial`, or `session_units >= COMPACT_AFTER`. Between units, emit the progress line and move on — nothing else.

### Dispatch Loop

Repeat until stop condition:

#### 1. Derive next unit

From STATE, determine `unit_type` and `unit_id` using the dispatch table below.

**Dispatch Table** (evaluate in order — first match wins):

| Condition | unit_type | Agent | Default model |
|-----------|-----------|-------|---------------|
| No active milestone | STOP — tell user "no active milestone" | — | — |
| Milestone has no ROADMAP | plan-milestone | **forge-planner** | opus |
| Milestone has ROADMAP, no CONTEXT, discuss not skipped | discuss-milestone | **forge-discusser** | opus |
| Milestone has no RESEARCH, research not skipped | research-milestone | **forge-researcher** | opus |
| Active slice has no PLAN | plan-slice | **forge-planner** | opus |
| Active slice has PLAN, no RESEARCH, research not skipped | research-slice | **forge-researcher** | opus |
| Active slice has incomplete task | execute-task | **forge-executor** | sonnet |
| All tasks in active slice done, no S##-SUMMARY | complete-slice | **forge-completer** | sonnet |
| All slices complete, no milestone completion marker | complete-milestone | **forge-completer** | sonnet |
| All slices `[x]` in ROADMAP and milestone complete | DONE — emit final report and stop | — | — |

To determine which case applies, read (in order, stop as soon as you find the answer):
1. STATE.md (already loaded) — `next_action` usually tells you directly
2. `M###-ROADMAP.md` — only if STATE is ambiguous about slices/milestone completion
3. `S##-PLAN.md` — only if STATE is ambiguous about tasks within a slice

**Crash detection:** Before dispatching `execute-task`, read `T##-PLAN.md`. If it contains `status: RUNNING`, the previous session crashed mid-task. Warn the user:
> ⚠ Task {T##} was interrupted (status: RUNNING). Re-executing from scratch.
Then proceed with dispatch normally (the executor will overwrite the partial work).

**Dynamic routing:** If `T##-PLAN.md` contains `complexity: heavy`, route `execute-task` to `forge-executor` on opus.

**Resolve effort for this unit:**
```
unit_effort = EFFORT_MAP[unit_type] or ("medium" if opus model else "low")
```
Inject `effort: {unit_effort}` and (for opus phases) `thinking: {THINKING_OPUS}` into the worker prompt header.

**Risk radar gate (plan-slice only):** If `unit_type == plan-slice` and the slice is tagged `risk:high` in ROADMAP, check if `S##-RISK.md` already exists. If not:
```
mkdir -p .gsd/milestones/{M###}/slices/{S##}
Skill({ skill: "forge-risk-radar", args: "{M###} {S##}" })
```
This runs the risk assessment in the current context before the plan-slice agent is dispatched. The produced `S##-RISK.md` will be injected into the worker prompt.

**Security gate (execute-task only):** If `unit_type == execute-task`, scan `T##-PLAN.md` content for security-sensitive keywords:
`auth|token|crypto|password|secret|api.?key|jwt|oauth|permission|role|hash|salt|encrypt|decrypt|session|cookie|credential|sanitize|xss|sql|inject`

If any keyword matches AND `T##-SECURITY.md` does not already exist in the task directory:
```
Skill({ skill: "forge-security", args: "{M###} {S##} {T##}" })
```
The produced `T##-SECURITY.md` will be injected into the execute-task worker prompt as `## Security Checklist`.

#### 2. Check skip rules

Read PREFS for `skip_discuss` and `skip_research`. If the current unit type is skipped, advance STATE past it and re-derive (do not count as a unit).

#### 3. Build worker prompt

Read ONLY the `.gsd/` artifact files the worker needs (templates below). Inline their content — do not summarize or paraphrase.

#### 4. Dispatch

Resolve the model ID for this unit from PREFS.

**Create timeline task** — use `TaskCreate` to show progress in the UI:
```
TaskCreate({
  subject: "[{M###}/{S##}/{T##}] {unit_type} — {one-liner}",
  description: "{agent_name} ({model_id})",
  activeForm: "{unit_type} {unit_id} — {one-liner} · {agent_name}"
})
```
Store the returned `taskId` as `current_task_id`. Then immediately mark it as in progress:
```
TaskUpdate({ taskId: current_task_id, status: "in_progress" })
```

Then call `Agent(agent_name, worker_prompt)` with a `description` that captures what is happening:
- Format: `{unit_type} {unit_id}: {one-liner describing the work}`
- Examples:
  - `plan-slice S01: authentication foundation`
  - `execute-task T03: JWT middleware setup`
  - `research-milestone M001: e-commerce platform`
- For memory extraction: `extract memories from {unit_id}`

Wait for the result.

#### 5. Process result

**Update timeline task** — mark the current task based on outcome:
- `status: done` → `TaskUpdate({ taskId: current_task_id, status: "completed" })`
- `status: partial` or `status: blocked` → leave task as `in_progress` (shows it was interrupted)

Parse the `---GSD-WORKER-RESULT---` block:
- `status: done` → proceed to post-unit housekeeping, then **immediately continue loop** (do NOT pause or ask user)
- `status: partial` → write `continue.md`, update STATE, emit compact signal, **stop loop**
- `status: blocked` → apply failure taxonomy before stopping:

**Failure Taxonomy** (check `blocker` field in result, first match wins):

| Class | Signals | Auto-recovery |
|-------|---------|---------------|
| `context_overflow` | "context limit", "too long", "token" | Retry with `complexity: heavy` routing (opus) — larger context window |
| `scope_exceeded` | "out of scope", "too broad", "multiple tasks" | Stop loop. Tell user: "Task scope too broad — ask forge-planner to split T## into smaller tasks." |
| `model_refusal` | "cannot", "I'm not able", "policy" | Retry once with a different model (sonnet ↔ opus). If fails again → stop loop, surface to user. |
| `tooling_failure` | "command not found", "permission denied", "ENOENT" | Stop loop. Tell user: "Tooling error — check that required tools are installed and accessible." |
| `external_dependency` | "API", "network", "not running", "connection refused" | Stop loop. Tell user: "External dependency unavailable — resolve and re-run /forge-auto." |
| `unknown` | anything else | Stop loop. Surface raw blocker to user. |

Auto-recovery attempts (context_overflow, model_refusal) count as units toward `COMPACT_AFTER`.

**Before any auto-recovery retry:** If the failed unit spawned a background task (visible via `TaskList` with `status: in_progress` and no owner), call `TaskStop({ task_id: <id> })` to terminate it cleanly before dispatching the retry.

#### 6. Post-unit housekeeping

**a) Append to event log** — append one line to `.gsd/forge/events.jsonl` (create `.gsd/forge/` directory if missing):
```json
{"ts":"{ISO8601}","unit":"{unit_type}/{unit_id}","agent":"{agent_name}","milestone":"{M###}","status":"{done|blocked|partial}","summary":"{one-liner}"}
```
Each entry must be a single line. This is the orchestrator-side record; workers may also write their own entries.

**b) Update STATE.md** — advance to next unit position.

**c) Append decisions** — if `key_decisions` in result, append to `.gsd/DECISIONS.md`.

**d) Memory extraction** — call `forge-memory` agent (blocking — await before continuing):

Determine which summary file was just written:
- `execute-task` → `.gsd/milestones/{M###}/slices/{S##}/tasks/{T##}-SUMMARY.md`
- `plan-slice` → `.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN.md`
- `complete-slice` → `.gsd/milestones/{M###}/slices/{S##}/{S##}-SUMMARY.md`
- `plan-milestone` → `.gsd/milestones/{M###}/{M###}-ROADMAP.md`
- `complete-milestone` → `.gsd/milestones/{M###}/{M###}-SUMMARY.md`
- other → use the result block only

Call `forge-memory` agent with:
```
WORKING_DIR: {WORKING_DIR}
UNIT_TYPE: {unit_type}
UNIT_ID: {unit_id}
MILESTONE_ID: {M###}

SUMMARY_CONTENT:
{full content of the summary/plan file read above, or "(none)" if not found}

RESULT_BLOCK:
{full ---GSD-WORKER-RESULT--- block verbatim}

KEY_DECISIONS:
{key_decisions field from result, or "(none)"}
```

**e) Track progress:**
```
session_units += 1
completed_units.append("✓ [M###/S##/T##] {unit_type} — {one-liner}  · {agent} ({model})")
```

#### 7. Compact check

After incrementing `session_units`:
- If `session_units >= COMPACT_AFTER`: ensure STATE.md is updated, emit compact signal, **stop loop**

---

## Deactivate auto-mode indicator

Before ANY exit (compact signal, final report, blocked, or partial), deactivate the marker:
```bash
echo '{"active":false}' > .gsd/forge/auto-mode.json
```

## Compact Signal

When `session_units >= COMPACT_AFTER`, emit and stop:

```
---GSD-COMPACT---
session_units: {N}
last_completed: {unit_type} {unit_id}
state_updated: true
resume: Run /forge-auto to continue from {next_action from STATE.md}
---
```

Followed by human-readable summary:
```
Batch de {N} unidades completo.
{completed_units list, one per line}

Estado salvo. Execute /forge-auto para continuar com: {next_action}.
```

---

## Final Report (milestone complete)

```
✓ Milestone {M###} completo

Slices entregues:
| Slice | Título | Tasks |
|-------|--------|-------|
| S01   | ...    | 3     |

Próximo milestone: /forge-new-milestone <descrição>
```

---

## Worker Prompt Templates

**Read `~/.claude/forge-dispatch.md`** and use the worker prompt template for the current `unit_type`. Substitute all placeholders with actual values from the loaded context.

---

## Continue-Here Protocol

If a worker returns `status: partial`:

1. Write `.gsd/milestones/M###/slices/S##/continue.md`:
```markdown
---
milestone: M###
slice: S##
task: T##
step: {completed_step}
total_steps: {total}
saved_at: {ISO8601}
---

## Completed Work
{from worker result}

## Remaining Work
{from worker result}

## Decisions Made
{from worker result}

## Next Action
{specific next step to resume from}
```

2. Update STATE.md to point to this task with `phase: resume`
3. Emit compact signal and stop.

On resume: STATE has `phase: resume` → read `continue.md`, inline into worker prompt with instruction "Resume from continue.md — skip completed work, start from Next Action."
