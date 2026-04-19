---
name: forge-auto
description: "Executa o milestone inteiro de forma autonoma ate concluir."
allowed-tools: Read, Write, Edit, Bash, Agent, Skill, TaskCreate, TaskUpdate, TaskList, TaskStop, WebSearch, WebFetch
---

## Bootstrap guard

```bash
ls CLAUDE.md 2>/dev/null && echo "ok" || echo "missing"
ls .gsd/STATE.md 2>/dev/null && echo "ok" || echo "missing"
WORKING_DIR=$(pwd)
echo "WORKING_DIR=$WORKING_DIR"
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

**Tier resolution (step 1.5)** — resolve `{tier, model, reason}` for this dispatch.
> Cross-reference: `shared/forge-dispatch.md § Tier Resolution` (algorithm) and `shared/forge-tiers.md` (canonical tables).

```bash
# ── Tier Resolution ────────────────────────────────────────────────────────────
# Step 1: unit-type default
declare -A TIER_DEFAULTS=(
  [memory-extract]="light" [complete-slice]="light" [complete-milestone]="light"
  [research-milestone]="standard" [research-slice]="standard"
  [discuss-milestone]="standard" [discuss-slice]="standard" [execute-task]="standard"
  [plan-milestone]="heavy" [plan-slice]="heavy"
)
TIER="${TIER_DEFAULTS[$unit_type]:-standard}"
REASON="unit-type:$unit_type"

# Step 2: parse frontmatter (execute-task only)
if [ "$unit_type" = "execute-task" ]; then
  PLAN_PATH=".gsd/milestones/${M###}/slices/${S##}/tasks/${T##}/${T##}-PLAN.md"
  PLAN_TIER=$(node -e "const fs=require('fs');const t=fs.readFileSync('$PLAN_PATH','utf8');const m=t.match(/^---[\s\S]*?---/);if(!m)process.exit(0);const r=(m[0].match(/^tier:\s*(.+)$/m)||[])[1]||'';process.stdout.write(r.trim())")
  PLAN_TAG=$(node  -e "const fs=require('fs');const t=fs.readFileSync('$PLAN_PATH','utf8');const m=t.match(/^---[\s\S]*?---/);if(!m)process.exit(0);const r=(m[0].match(/^tag:\s*(.+)$/m)||[])[1]||'';process.stdout.write(r.trim())")

  # Step 3: apply precedence (first match wins)
  if [ -n "$PLAN_TIER" ]; then
    TIER="$PLAN_TIER"; REASON="frontmatter-override:$PLAN_TIER"
  elif [ "$PLAN_TAG" = "docs" ]; then
    TIER="light"; REASON="frontmatter-tag:docs"
  fi
fi

# Step 4: resolve model — PREFS.tier_models[tier] with fallback to forge-tiers.md defaults
MODEL_ID=$(node -e "
  let p={};try{p=JSON.parse(require('fs').readFileSync('.gsd/prefs-resolved.json','utf8'));}catch(e){}
  const d={'light':'claude-haiku-4-5-20251001','standard':'claude-sonnet-4-6','heavy':'claude-opus-4-7'};
  const tier='$TIER';
  const validTiers=['light','standard','heavy'];
  const t=validTiers.includes(tier)?tier:'standard';
  process.stdout.write((p.tier_models||{})[t]||d[t]);
")
```
`TIER`, `MODEL_ID`, and `REASON` are now set. Use `$MODEL_ID` in the `Agent()` call below (Step 4). `$TIER` and `$REASON` are injected into the dispatch event.

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

**Plan-check gate (between plan-slice and first execute-task):**

After a successful `plan-slice` unit, before dispatching the first `execute-task` for the same slice, run the plan-check gate:

1. **Read `plan_check.mode` from the 3-file prefs cascade:**
   ```bash
   PLAN_CHECK_MODE=$(node -e "
   const fs=require('fs'),path=require('path'),os=require('os');
   const wd=process.env.WORKING_DIR||process.cwd();
   const files=[path.join(os.homedir(),'.claude','forge-agent-prefs.md'),
                path.join(wd,'.gsd','claude-agent-prefs.md'),
                path.join(wd,'.gsd','prefs.local.md')];
   let mode='advisory';
   for(const f of files){try{const r=fs.readFileSync(f,'utf8');const m=r.match(/^plan_check:[ \t]*\n[ \t]+mode:[ \t]*(\w+)/m);if(m)mode=m[1].toLowerCase();}catch(e){}}
   if(mode!=='advisory'&&mode!=='blocking'&&mode!=='disabled')mode='advisory';
   process.stdout.write(mode);
   " WORKING_DIR="$WORKING_DIR")
   ```
   Store as `PLAN_CHECK_MODE`.

2. **If `PLAN_CHECK_MODE == "disabled"`:** skip — do not invoke the plan-checker. Proceed to first `execute-task`.

3. **Idempotency check:** if `{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN-CHECK.md` already exists, skip — do not re-invoke the plan-checker.

4. **Aggregate MUST_HAVES_CHECK_RESULTS:**
   Use `$WORKING_DIR` (captured in bootstrap via `pwd` — always forward-slash, Windows-safe). For each `T##-PLAN.md`:
   ```bash
   for plan in "$WORKING_DIR/.gsd/milestones/{M###}/slices/{S##}/tasks/T"/T*-PLAN.md; do
     node scripts/forge-must-haves.js --check "$plan"
   done
   ```
   Capture stdout JSON. Build an array of `{task_id, legacy, valid, errors}`. Serialize to JSON as `MUST_HAVES_CHECK_RESULTS`.

5. **Fill the plan-check template** from `shared/forge-dispatch.md § plan-check` with `$WORKING_DIR` (not raw CWD — always use the bash-captured variable), `{M###}`, `{S##}`, `{PLAN_CHECK_MODE}`, `{MUST_HAVES_CHECK_RESULTS}`.

6. **Dispatch:**
   ```
   Agent({ subagent_type: 'forge-plan-checker', prompt: <filled-template> })
   ```

7. **Parse the worker result** — extract `plan_check_counts: {pass, warn, fail}` from the `---GSD-WORKER-RESULT---` block.

8. **Append to `{WORKING_DIR}/.gsd/forge/events.jsonl`** (I/O errors MUST propagate — no silent-fail):
   ```json
   {"ts":"<ISO-8601>","event":"plan_check","milestone":"{M###}","slice":"{S##}","mode":"{PLAN_CHECK_MODE}","counts":{"pass":N,"warn":N,"fail":N}}
   ```

9. **Branch on `PLAN_CHECK_MODE`:**
   - `advisory` → proceed to first `execute-task` regardless of counts.
   - `blocking` → enter the **Blocking-mode revision loop** below.
   - (`disabled` already handled in step 2.)

10. **Forward-compatibility note:** future M004+ may add per-dimension enforcement. The current wire passes through all dimension counts to events.jsonl so future code can filter.

> This gate fires ONLY when transitioning from a just-completed `plan-slice` to the first `execute-task` of the same slice. When deriving the next unit (Step 1) results in `execute-task` AND the previous completed unit was `plan-slice` for the same slice, run this gate. For subsequent `execute-task` dispatches within the same slice, the idempotency check (step 3 above) ensures the gate is a no-op.

**Blocking-mode revision loop (activated ONLY when `PLAN_CHECK_MODE == "blocking"`):**

Constants (LOCKED — changing requires a new milestone decision):
```
MAX_PLAN_CHECK_ROUNDS = 3
```

State for the loop:
- `round = 1` (the initial plan-check above was round 1; its result is already in `plan_check_counts`)
- `prev_fail_count = plan_check_counts.fail` (from the step 7 parse result)

**Append first-round events.jsonl entry** (round 1 = the initial gate run):
```bash
echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"plan_check\",\"milestone\":\"{M###}\",\"slice\":\"{S##}\",\"mode\":\"blocking\",\"round\":1,\"counts\":{\"pass\":${PASS_COUNT},\"warn\":${WARN_COUNT},\"fail\":${FAIL_COUNT}},\"prev_fail\":null,\"outcome\":\"revised\"}" >> {WORKING_DIR}/.gsd/forge/events.jsonl
```
(Use the actual parsed counts from step 7. `prev_fail: null` for round 1 — there is no prior round.)

**While `prev_fail_count > 0` AND `round < MAX_PLAN_CHECK_ROUNDS`:**

  **a. Back up the prior PLAN-CHECK.md:**
  ```bash
  mv {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN-CHECK.md \
     {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN-CHECK-round{round}.md
  ```
  This preserves the prior round's results for audit. Round 1 backup → `{S##}-PLAN-CHECK-round1.md`. Round 2 backup → `{S##}-PLAN-CHECK-round2.md`.

  **b. Collect failing dimensions** from the backed-up `{S##}-PLAN-CHECK-round{round}.md`. Parse the verdict table — rows where `Verdict == "fail"`. Extract dimension names and justifications into a list.

  **c. Increment round:** `round += 1`.

  **d. Re-dispatch plan-slice** with an injected `## Revision Request` section:
  ```
  Agent({
    subagent_type: 'forge-planner',
    prompt: <plan-slice template from shared/forge-dispatch.md>
      + "\n\n## Revision Request (round " + round + ")\n"
      + "The prior plan scored `fail` on these dimensions:\n"
      + "- {dimension 1}: {justification}\n"
      + "- {dimension 2}: {justification}\n"
      + "...\n"
      + "Revise the slice plan to resolve these failures. Preserve all already-passing dimensions. "
      + "Do NOT reduce scope to hide failures — fix the root cause.\n"
  })
  ```
  Wait for the planner result. If the planner returns `status: blocked`, terminate immediately (do not enter the non-decreasing check — surfacing the planner failure takes precedence).

  **e. Re-run the plan-check gate** — dispatch `forge-plan-checker` again using the same template from `shared/forge-dispatch.md § plan-check`, with `{PLAN_CHECK_MODE}: blocking` and `round: {round}` passed in the prompt. This produces a new `{S##}-PLAN-CHECK.md` (overwriting any prior file — the backup in step (a) already preserved the previous round).

  **f. Parse new counts** → `new_fail_count` (from the worker result `plan_check_counts.fail`).

  **g. Append events.jsonl line** (I/O errors MUST propagate — no silent-fail):
  ```bash
  echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"plan_check\",\"milestone\":\"{M###}\",\"slice\":\"{S##}\",\"mode\":\"blocking\",\"round\":{round},\"counts\":{\"pass\":${NEW_PASS},\"warn\":${NEW_WARN},\"fail\":${new_fail_count}},\"prev_fail\":${prev_fail_count},\"outcome\":\"revised\"}" >> {WORKING_DIR}/.gsd/forge/events.jsonl
  ```

  **h. Monotonic-decrease check:** if `new_fail_count >= prev_fail_count`, TERMINATE (non-decreasing):
  - Overwrite the `outcome` field in the events.jsonl line just written — or append a corrective entry:
    ```bash
    echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"plan_check\",\"milestone\":\"{M###}\",\"slice\":\"{S##}\",\"mode\":\"blocking\",\"round\":{round},\"outcome\":\"terminated-non-decreasing\",\"prev_fail\":${prev_fail_count},\"new_fail\":${new_fail_count}}" >> {WORKING_DIR}/.gsd/forge/events.jsonl
    ```
  - Surface to user (see **Termination Surface Block** below — reason: `non-decreasing`).
  - Deactivate auto-mode: `echo '{"active":false}' > {WORKING_DIR}/.gsd/forge/auto-mode.json`
  - **Stop loop.** Do NOT dispatch the first `execute-task` for this slice. Return.

  **i. Update state:** `prev_fail_count = new_fail_count`.

**After the while loop exits:**

- If `prev_fail_count == 0`:
  - Append events.jsonl:
    ```bash
    echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"plan_check\",\"milestone\":\"{M###}\",\"slice\":\"{S##}\",\"mode\":\"blocking\",\"round\":{round},\"outcome\":\"passed\"}" >> {WORKING_DIR}/.gsd/forge/events.jsonl
    ```
  - Proceed to the first `execute-task` dispatch normally.

- Else (`round == MAX_PLAN_CHECK_ROUNDS` and `prev_fail_count > 0`):
  - Append events.jsonl:
    ```bash
    echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"plan_check\",\"milestone\":\"{M###}\",\"slice\":\"{S##}\",\"mode\":\"blocking\",\"round\":{round},\"outcome\":\"terminated-exhausted\"}" >> {WORKING_DIR}/.gsd/forge/events.jsonl
    ```
  - Surface to user (see **Termination Surface Block** below — reason: `exhausted`).
  - Deactivate auto-mode: `echo '{"active":false}' > {WORKING_DIR}/.gsd/forge/auto-mode.json`
  - **Stop loop.** Do NOT dispatch the first `execute-task` for this slice. Return.

---

**Termination Surface Block (pt-BR):**

Emit to the user when terminating (either `non-decreasing` or `exhausted`):

```
⚠  Plan-check blocking mode: terminando loop de revisão.
   Motivo: {non-decreasing — fail não diminuiu entre rodadas | exhausted — rodadas esgotadas sem convergência}
   Rodada atual: {round}/3
   Dimensões ainda falhando:
     - {dim1}: {justification}
     - {dim2}: {justification}
     ...

Ação necessária: edite os T##-PLAN.md para resolver as dimensões listadas acima, depois:
  - delete {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN-CHECK.md
  - rode `/forge-next` para reexecutar o gate (ou `/forge-auto` para continuar autônomo).

Os arquivos de backup das rodadas anteriores estão em:
  {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN-CHECK-round1.md
  {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN-CHECK-round2.md  (se round >= 2)
```

---

## Plan-Check Revision Loop

**Purpose:** when `plan_check.mode: blocking` is set in prefs, the orchestrator does not proceed to `execute-task` if the plan-check gate finds structural failures. Instead, it enters this revision loop, which repeatedly re-plans and re-checks until the plan is clean or the loop terminates.

**Activation:** only when `PLAN_CHECK_MODE == "blocking"`. Default (`advisory`) never enters this loop — the plan-checker result is informational only and the orchestrator proceeds immediately to `execute-task`.

**Round semantics:**
- Round 1 = the initial gate run (step 6 dispatch above). Already captured in `plan_check_counts`.
- Rounds 2 and 3 = revision iterations triggered by this loop.
- At most `MAX_PLAN_CHECK_ROUNDS = 3` rounds total (LOCKED constant — not a pref key).

**Backup filenames:**
- Before round 2 replanning: `{S##}-PLAN-CHECK-round1.md` (backup of round 1 results)
- Before round 3 replanning: `{S##}-PLAN-CHECK-round2.md` (backup of round 2 results)
- Final `{S##}-PLAN-CHECK.md` = the last round's results (whatever round terminates the loop)

**Termination conditions (both stop the loop and surface to user):**
1. `terminated-non-decreasing` — new fail count ≥ prev fail count (replanning made things worse or stagnated)
2. `terminated-exhausted` — reached `MAX_PLAN_CHECK_ROUNDS` (3) and still has failures

**Pass condition:** `fail_count == 0` at any point → `outcome: passed` → proceed to `execute-task`.

**User-surface contract:** on termination, emit the structured pt-BR block above. User must edit plans manually and delete `{S##}-PLAN-CHECK.md` to reset. The T03 idempotency check will treat the deleted file as a fresh gate trigger on the next `/forge-next` or `/forge-auto` run.

**events.jsonl outcomes (LOCKED):**
- `"revised"` — a revision round completed (plan was re-dispatched and re-checked)
- `"terminated-exhausted"` — rounds exhausted without reaching fail == 0
- `"terminated-non-decreasing"` — fail count did not decrease between rounds
- `"passed"` — fail count reached 0; proceeding to execute-task

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

Use `$MODEL_ID` resolved by Tier Resolution (step 1.5) above — do NOT re-read from PREFS Phase-routing table.

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

<!-- token-telemetry-integration -->
Per `shared/forge-dispatch.md § Token Telemetry` — compute input tokens, dispatch, capture output tokens, append dispatch event (I/O errors MUST propagate):
```bash
INPUT_TOKENS=$(node scripts/forge-tokens.js --inline "$worker_prompt")
```

Then call `Agent(agent_name, worker_prompt)` with a `description` using the same icon:
- Format: `{icon} {unit_id} · {one-liner}`
- Examples:
  - `⚙ S01 · authentication foundation`
  - `⚡ T03 · JWT middleware setup`
  - `🔬 M001 · e-commerce platform`
  - `💬 S02 · payment flow decisions`
  - `✔ S01 · auth slice complete`
  - `🧠 S01 · extract memories`

Wait for the result. Then:
```bash
OUTPUT_TOKENS=$(node scripts/forge-tokens.js --inline "$result")
mkdir -p .gsd/forge/
echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"dispatch\",\"unit\":\"${unitType}/${unitId}\",\"model\":\"${MODEL_ID}\",\"tier\":\"${TIER}\",\"reason\":\"${REASON}\",\"input_tokens\":${INPUT_TOKENS},\"output_tokens\":${OUTPUT_TOKENS}}" >> .gsd/forge/events.jsonl
```

**Guarded dispatch — apply the Retry Handler section of `shared/forge-dispatch.md`:** Wrap the `Agent()` call in a try/catch. On throw:

1. Capture the exception message into `errorMsg`.
2. Shell out: `node scripts/forge-classify-error.js --msg "$errorMsg"` → parse `{ kind, retry, backoffMs? }`.
3. If `retry === true` AND `attempt <= PREFS.retry.max_transient_retries` (default 3): increment `attempt`, apply backoff, append a retry event (include `input_tokens: INPUT_TOKENS` from the retry prompt) to `.gsd/forge/events.jsonl`, and re-dispatch. Task stays `in_progress` between retries. Heartbeat write is NOT disturbed.
4. Otherwise fall through to the CRITICAL path below.

> Transient errors (`rate-limit`, `network`, `server`, `stream`, `connection`) are handled by the Retry Handler before this block is reached. The CRITICAL path below is only reached when the classifier returns `retry: false` OR retries are exhausted.

**CRITICAL — Agent() dispatch failure (permanent / retries exhausted):** Do NOT attempt to execute the work inline. Instead:
1. Deactivate auto-mode: `echo '{"active":false}' > .gsd/forge/auto-mode.json`
2. Mark the task as in_progress (leave it — signals interruption): skip TaskUpdate
3. Stop the loop immediately and tell the user:
   > ⚠ Falha ao despachar subagente para `{unit_type} {unit_id}`: `{kind}` (não surfaçar `errorMsg`)
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

**c) Append decisions** — if `key_decisions` in result, append to `.gsd/DECISIONS.md` using **`Edit` only** (never `Write` — it replaces the entire file and destroys existing rows; a PreToolUse hook blocks `Write` here). `Read` the file in full first (paginate if needed), then `Edit` with `old_string` = the current last row and `new_string` = that row + newline + your new row(s). Bash alternative: `cat >> .gsd/DECISIONS.md << 'EOF'` (never `>`).

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
