---
name: forge-next
description: "Executa exatamente uma unidade de trabalho e para (step mode)."
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash, Agent, Skill, TaskCreate, TaskUpdate, TaskList, TaskStop, WebSearch, WebFetch
---

## Parse arguments

From `$ARGUMENTS`:
- Empty, `next`, or `step` → **STEP MODE** (execute one unit, stop)
- `auto` → tell the user: "Use `/forge-auto` para modo autônomo." and stop.
- Anything else → treat as STEP MODE (ignore unknown args)

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
5. `.gsd/AUTO-MEMORY.md` full file (skip silently if missing) — stored as `ALL_MEMORIES` for selective injection
6. `.gsd/CODING-STANDARDS.md` (skip silently if missing)

**Merge order:** later files override earlier ones for any key present. Missing files are skipped silently. Store merged result as `PREFS`.

**Extract effort & thinking from PREFS:**
- `EFFORT_MAP` ← `PREFS.effort` (per-phase effort table; default: opus phases = `medium`, sonnet phases = `low`)
- `THINKING_OPUS` ← `PREFS.thinking.opus_phases` (default: `adaptive`)

Store as: `STATE`, `PREFS`, `ALL_MEMORIES`, `CODING_STANDARDS`.

**Cleanup orphaned tasks** — call `TaskList`. If any tasks have `status: in_progress` (leftover from a previous session), mark them completed before creating new tasks:
```
TaskUpdate({ taskId: <id>, status: "completed" })
```
Skip if TaskList returns empty.

**CODING_STANDARDS section extraction** — to minimize token usage, extract these named sections from the file for selective injection:
- `CS_LINT` — content of `## Lint & Format Commands` section only
- `CS_STRUCTURE` — content of `## Directory Conventions` + `## Asset Map` + `## Pattern Catalog` sections
- `CS_RULES` — content of `## Code Rules` section only
If CODING-STANDARDS.md is missing, all section variables are `"(none)"`.

---

## Orchestrate — STEP MODE

You are the orchestrator. Execute the dispatch loop **exactly once**, then stop.

### 1. Derive next unit

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
| All slices `[x]` in ROADMAP and milestone complete | DONE — emit final report | — | — |

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

### 2. Check skip rules

Read PREFS for `skip_discuss` and `skip_research`. If the current unit type is skipped, advance STATE past it and re-derive (do not count as a unit).

### 3. Build worker prompt

**Selective memory injection** — filter `ALL_MEMORIES` to entries relevant to this unit:
- For `execute-task`: read keywords from `T##-PLAN.md` title + step names. Include memories whose description shares ≥2 keywords with the plan. Prefer categories `gotcha` and `convention`. Cap at 8 entries.
- For `plan-slice` / `research-slice`: include `architecture` and `pattern` memories related to the milestone scope. Cap at 8 entries.
- For other unit types: include top-5 entries by confidence score.
- If no entries match: inject `(none)`.
Store as `RELEVANT_MEMORIES` and use in the worker prompt `## Project Memory` section.

Use the template from `~/.claude/forge-dispatch.md` for the current `unit_type`.
Substitute placeholders:
- `{WORKING_DIR}` <- current working directory
- `{M###}`, `{S##}`, `{T##}` <- from STATE
- `{unit_effort}`, `{THINKING_OPUS}` <- resolved effort/thinking for this unit
- `{TOP_MEMORIES}` <- RELEVANT_MEMORIES (filtered above)
- `{CS_LINT}` <- CS_LINT section (already extracted)
- `{CS_STRUCTURE}` <- CS_STRUCTURE section (already extracted)
- `{CS_RULES}` <- CS_RULES section (already extracted)
- `{auto_commit}` <- PREFS.auto_commit
- `{milestone_cleanup}` <- PREFS.milestone_cleanup
- `{CODING_STANDARDS}` <- full CODING_STANDARDS content (for research templates)

Do NOT read artifact files here — templates now pass paths; workers read their own context.

### 4. Dispatch

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

<!-- token-telemetry-integration -->
Per `shared/forge-dispatch.md § Token Telemetry` — compute input tokens, dispatch, capture output tokens, append dispatch event (I/O errors MUST propagate):
```bash
INPUT_TOKENS=$(node scripts/forge-tokens.js --inline "$worker_prompt")
```

**Guarded dispatch — apply the Retry Handler section of `shared/forge-dispatch.md`:** Wrap the `Agent()` call in a try/catch. On throw:

1. Capture the exception message into `errorMsg`.
2. Shell out: `node scripts/forge-classify-error.js --msg "$errorMsg"` → parse `{ kind, retry, backoffMs? }`.
3. If `retry === true` AND `attempt <= PREFS.retry.max_transient_retries` (default 3): increment `attempt`, apply backoff, append a retry event (include `input_tokens: INPUT_TOKENS` from the retry prompt) to `.gsd/forge/events.jsonl`, and re-dispatch. Task stays `in_progress` between retries.
4. Otherwise fall through to the failure taxonomy in Step 5.

> Transient errors (`rate-limit`, `network`, `server`, `stream`, `connection`) are handled by the Retry Handler before this block is reached. The failure taxonomy below is only reached when the classifier returns `retry: false` OR retries are exhausted.

Then call `Agent(agent_name, worker_prompt)` with a `description` that captures what is happening:
- Format: `{unit_type} {unit_id}: {one-liner describing the work}`
- Examples:
  - `plan-slice S01: authentication foundation`
  - `execute-task T03: JWT middleware setup`
  - `research-milestone M001: e-commerce platform`
- For memory extraction: `extract memories from {unit_id}`

Wait for the result. Then:
```bash
OUTPUT_TOKENS=$(node scripts/forge-tokens.js --inline "$result")
mkdir -p .gsd/forge/
echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"dispatch\",\"unit\":\"${unitType}/${unitId}\",\"model\":\"${modelId}\",\"input_tokens\":${INPUT_TOKENS},\"output_tokens\":${OUTPUT_TOKENS}}" >> .gsd/forge/events.jsonl
```

### 5. Process result

**Update timeline task** — mark the current task based on outcome:
- `status: done` → `TaskUpdate({ taskId: current_task_id, status: "completed" })`
- `status: partial` or `status: blocked` → leave task as `in_progress` (shows it was interrupted)

Parse the `---GSD-WORKER-RESULT---` block:
- `status: done` → proceed to post-unit housekeeping
- `status: partial` → write `continue.md`, update STATE, emit compact signal, stop
- `status: blocked` → classify failure before surfacing to user:

| Class | Signals | Message to user |
|-------|---------|-----------------|
| `context_overflow` | "context limit", "too long", "token" | "Task too large for one context window. Run `/forge-next` again — it will retry with a more capable model." |
| `scope_exceeded` | "out of scope", "too broad" | "Task scope too broad. Ask the planner to split T## before continuing." |
| `model_refusal` | "cannot", "I'm not able", "policy" | "Model refused the task. Try `/forge-next` again or adjust the task plan." |
| `tooling_failure` | "command not found", "permission denied", "ENOENT" | "Tooling error — check that required tools are installed." |
| `external_dependency` | "API", "network", "not running" | "External dependency unavailable — resolve it and re-run `/forge-next`." |
| `unknown` | anything else | Surface raw blocker message. |

### 6. Post-unit housekeeping

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

**d) Emit progress + next action:**
```
✓ [M001/S02/T03] execute-task — JWT auth with refresh rotation  · forge-executor (claude-sonnet-4-6)
→ Next: /forge-next para {next unit_type} {unit_id}
```

Display the progress line AND the next action (read from the STATE.md you just updated). The user needs to know what comes next to decide whether to continue. Do not add summaries, explanations, or other follow-up text beyond these two lines.

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
3. Tell the user: "Trabalho parcial salvo. Execute `/forge-next` para retomar de onde parou."

On resume: STATE has `phase: resume` → read `continue.md`, inline into worker prompt with instruction "Resume from continue.md — skip completed work, start from Next Action."
