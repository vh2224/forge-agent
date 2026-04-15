---
name: forge-auto
description: GSD auto mode — executa o milestone inteiro de forma autônoma até concluir
disable-model-invocation: true
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
5. `.gsd/AUTO-MEMORY.md` full file (skip silently if missing) — stored as `ALL_MEMORIES` for selective injection per unit
6. `.gsd/CODING-STANDARDS.md` (skip silently if missing)

**Merge order:** later files override earlier ones for any key present. Missing files are skipped silently. Store merged result as `PREFS`.

**Extract effort & thinking from PREFS:**
- `EFFORT_MAP` ← `PREFS.effort` (per-phase effort table; default: opus phases = `medium`, sonnet phases = `low`)
- `THINKING_OPUS` ← `PREFS.thinking.opus_phases` (default: `adaptive`)

Store as: `STATE`, `PREFS`, `ALL_MEMORIES`, `CODING_STANDARDS`.

**CODING_STANDARDS section extraction** — to minimize token usage, extract these named sections from the file for selective injection:
- `CS_LINT` — content of `## Lint & Format Commands` section only
- `CS_STRUCTURE` — content of `## Directory Conventions` + `## Asset Map` + `## Pattern Catalog` sections
- `CS_RULES` — content of `## Code Rules` section only
If CODING-STANDARDS.md is missing, all section variables are `"(none)"`.

Initialize:
```
session_units    = 0
COMPACT_AFTER    = PREFS.compact_after if set and not "unlimited", else "unlimited"
                   (0 or "unlimited" disables context checkpoints entirely — this is the default)
completed_units  = []
```

**Cleanup orphaned tasks** — call `TaskList`. If any tasks have `status: in_progress` (leftover from a previous crashed session), mark them completed to keep the UI clean:
```
TaskUpdate({ taskId: <id>, status: "completed" })
```
Do this for ALL in_progress tasks before starting the loop. Skip if TaskList returns empty.

**Argumentos ignorados** — `/forge-auto` não aceita argumentos. Se o usuário digitou `/forge-auto resume` ou qualquer outro argumento, ignore-o silenciosamente. O auto-resume é automático via detecção abaixo.

**Auto-resume detection** — check for a previous interrupted session:
```bash
cat .gsd/forge/auto-mode.json 2>/dev/null
```
- If `active: true` AND `started_at` is within the last 60 minutes AND milestone is not done:
  → Emit one line: `↺ Retomando forge-auto após interrupção...` and skip the activation step below — go directly to the dispatch loop. The marker is already set.
- Otherwise: proceed normally to activation.

---

## Orchestrate — AUTO MODE

**Activate auto-mode indicator** — write marker so the status line shows `▶ AUTO`:
```bash
mkdir -p .gsd/forge
_forge_now=$(node -e "process.stdout.write(String(Date.now()))")
echo $_forge_now > .gsd/forge/auto-mode-started.txt
echo '{"active":true,"started_at":'$_forge_now',"worker":null}' > .gsd/forge/auto-mode.json
```
`started_at` is persisted to `.gsd/forge/auto-mode-started.txt` so heartbeat writes can read it across bash tool calls (shell state does not persist between tool calls).

You are the orchestrator. Execute the dispatch loop until the milestone is complete or a stop condition is hit.

**AUTONOMY RULE — CRITICAL:** This is FULLY AUTONOMOUS mode. After each unit completes with `status: done`, proceed IMMEDIATELY to the next unit. Do NOT pause to ask the user if they want to continue. Do NOT ask for confirmation between units. Do NOT summarize progress and wait for input. The ONLY reasons to STOP the loop are: milestone complete, worker returned `blocked`/`partial`, or pause requested. Between units, emit the progress line and move on — nothing else.

**COMPACTION RESILIENCE — CRITICAL:** Claude Code may auto-compact the conversation context during a long autonomous run. This is NOT a stopping condition. If you detect that your in-memory variables (`PREFS`, `EFFORT_MAP`, `THINKING_OPUS`, `session_units`, `ALL_MEMORIES`) appear undefined or missing, context was likely compacted. Recovery protocol — execute immediately without telling the user:
1. Read `.gsd/forge/auto-mode.json` — if `active: true`, the loop MUST continue
2. Re-read all context files: `.gsd/STATE.md`, prefs files (all 3 layers), `.gsd/AUTO-MEMORY.md`, `.gsd/CODING-STANDARDS.md`
3. Re-initialize all state variables: merge PREFS, extract EFFORT_MAP and THINKING_OPUS, set `session_units = 0`, re-extract CS sections
4. Continue the dispatch loop from Step 1 immediately
The autonomous loop is active as long as `auto-mode.json` shows `active: true`. Context compaction never deactivates it.

**ISOLATION RULE — CRITICAL:** The orchestrator NEVER implements code or modifies project files directly. The tools `Write`, `Edit`, and `Bash` available to the orchestrator exist EXCLUSIVELY for orchestrator bookkeeping: writing `STATE.md`, `events.jsonl`, `auto-mode.json`, `auto-mode-started.txt`, and `continue.md`. Any code change, file creation, or implementation step — no matter how small — MUST happen inside a worker dispatched via `Agent()`. If you find yourself about to use `Edit` or `Write` on a project file, or running implementation commands via `Bash`, STOP immediately: you are violating context isolation. Call `Agent()` instead.

### Dispatch Loop

Repeat until stop condition:

#### 1. Derive next unit

**Compact recovery check** — before anything else in each iteration:
```bash
cat .gsd/forge/compact-signal.json 2>/dev/null
```
If the file exists:
1. Re-read all context files from disk:
   - `.gsd/STATE.md` → update `STATE`
   - `~/.claude/forge-agent-prefs.md`, `.gsd/claude-agent-prefs.md`, `.gsd/prefs.local.md` → re-merge `PREFS`
   - `.gsd/AUTO-MEMORY.md` → update `ALL_MEMORIES`
   - `.gsd/CODING-STANDARDS.md` → re-extract `CS_LINT`, `CS_STRUCTURE`, `CS_RULES`
2. Re-derive `EFFORT_MAP` and `THINKING_OPUS` from merged PREFS
3. Reset `session_units = 0`
4. Delete the signal: `rm -f .gsd/forge/compact-signal.json`
5. Emit: `↺ Recovery pós-compactação — retomando de: {next_action from STATE.md}`
6. Continue the loop normally (proceed to derive next unit below)

If the file does not exist, skip this block entirely.

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

Use the template from `~/.claude/forge-dispatch.md` for the current `unit_type`.
Substitute placeholders:
- `{WORKING_DIR}` <- current working directory
- `{M###}`, `{S##}`, `{T##}` <- from STATE
- `{unit_effort}`, `{THINKING_OPUS}` <- resolved effort/thinking for this unit
- `{TOP_MEMORIES}` <- RELEVANT_MEMORIES (already filtered in Step 4)
- `{CS_LINT}` <- CS_LINT section (already extracted)
- `{CS_STRUCTURE}` <- CS_STRUCTURE section (already extracted)
- `{CS_RULES}` <- CS_RULES section (already extracted)
- `{auto_commit}` <- PREFS.auto_commit
- `{milestone_cleanup}` <- PREFS.milestone_cleanup
- `{CODING_STANDARDS}` <- full CODING_STANDARDS content (for research templates)

Do NOT read artifact files here — templates now pass paths; workers read their own context.

#### 4. Dispatch

Resolve the model ID for this unit from PREFS.

**Create timeline task** — use `TaskCreate` to show progress in the UI.

Use the icon for the current `unit_type`:
| unit_type | icon |
|-----------|------|
| plan-milestone | ⚙ |
| plan-slice | ⚙ |
| discuss-milestone | 💬 |
| discuss-slice | 💬 |
| research-milestone | 🔬 |
| research-slice | 🔬 |
| execute-task | ⚡ |
| complete-slice | ✔ |
| complete-milestone | 🏁 |
| memory extraction | 🧠 |

```
TaskCreate({
  subject: "{icon} [{M###}/{S##}/{T##}] {unit_type} — {one-liner}",
  description: "{agent_name} ({model_id})",
  activeForm: "{icon} {unit_type} · {agent_name} ({model_id}) · {M###}/{S##}/{T##}"
})
```
Store the returned `taskId` as `current_task_id`. Then immediately mark it as in progress:
```
TaskUpdate({ taskId: current_task_id, status: "in_progress" })
```

**Selective memory injection** — before building the worker prompt, filter `ALL_MEMORIES` to the entries most relevant to this unit:
- For `execute-task`: read keywords from `T##-PLAN.md` title + step names. Include memories whose description shares ≥2 keywords with the plan. Prefer categories `gotcha` and `convention`. Cap at 8 entries.
- For `plan-slice` / `research-slice`: include `architecture` and `pattern` memories related to the milestone scope. Cap at 8 entries.
- For other unit types: include top-5 entries by confidence score.
- If ALL_MEMORIES is empty or no entries match: inject `(none)`.
Store as `RELEVANT_MEMORIES` and use in the worker prompt `## Project Memory` section instead of the raw full file.

**Heartbeat — record active worker** before dispatching:
```bash
_sa=$(cat .gsd/forge/auto-mode-started.txt 2>/dev/null || node -e "process.stdout.write(String(Date.now()))")
_now=$(node -e "process.stdout.write(String(Date.now()))")
echo '{"active":true,"started_at":'$_sa',"last_heartbeat":'$_now',"worker":"UNIT_TYPE/UNIT_ID","worker_started":'$_now'}' > .gsd/forge/auto-mode.json
```
Replace `UNIT_TYPE/UNIT_ID` with the actual values (e.g., `execute-task/T01`). Reading `started_at` from the file ensures it survives across tool calls. `last_heartbeat` is used by the statusline stale check — it resets on every dispatch so long sessions are never incorrectly marked stale.

Then call `Agent(agent_name, worker_prompt)` with a `description` using the same icon:
- Format: `{icon} {unit_id} · {one-liner}`
- Examples:
  - `⚙ S01 · authentication foundation`
  - `⚡ T03 · JWT middleware setup`
  - `🔬 M001 · e-commerce platform`
  - `💬 S02 · payment flow decisions`
  - `✔ S01 · auth slice complete`
  - `🧠 S01 · extract memories`

Wait for the result.

**CRITICAL — Agent() dispatch failure:** If the `Agent()` call itself fails (API error, 500, timeout, tool unavailable, or any exception before the worker even starts), do NOT attempt to execute the work inline in the main context. Instead:
1. Deactivate auto-mode: `echo '{"active":false}' > .gsd/forge/auto-mode.json`
2. Mark the task as in_progress (leave it — signals interruption): skip TaskUpdate
3. Stop the loop immediately and tell the user:
   > ⚠ Falha ao despachar subagente para `{unit_type} {unit_id}`: `{error message}`
   > Execute `/forge-auto` para tentar novamente quando a API estiver disponível.

Executing work inline bypasses context isolation and is NEVER acceptable as a fallback.

**Heartbeat — clear worker field** after Agent() returns:
```bash
_sa=$(cat .gsd/forge/auto-mode-started.txt 2>/dev/null || node -e "process.stdout.write(String(Date.now()))")
_now=$(node -e "process.stdout.write(String(Date.now()))")
echo '{"active":true,"started_at":'$_sa',"last_heartbeat":'$_now',"worker":null}' > .gsd/forge/auto-mode.json
```

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

#### 7. Pause + checkpoint check

After incrementing `session_units`:

**Pause check** — if `.gsd/forge/pause` exists:
```bash
rm -f .gsd/forge/pause
echo '{"active":false}' > .gsd/forge/auto-mode.json
```
Emit and **stop loop**:
```
⏸  Auto-mode pausado após {session_units} unidades.
{completed_units list, one per line}

Execute /forge-auto para retomar a partir de: {next_action from STATE.md}
```

**Context checkpoint** (only fires if the user explicitly set `compact_after` in prefs AND `session_units >= COMPACT_AFTER`):
- Append to events.jsonl: `{"ts":"{ISO8601}","unit":"checkpoint","agent":"orchestrator","milestone":"{M###}","status":"checkpoint","summary":"{session_units} unidades concluídas"}`
- Reset counters: `session_units = 0`, `completed_units = []`
- **Continue the loop immediately** — do NOT stop.

---

## Deactivate auto-mode indicator

Before ANY exit (final report, blocked, partial, or pause), deactivate the marker:
```bash
echo '{"active":false}' > .gsd/forge/auto-mode.json
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
