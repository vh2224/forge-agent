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

# Resolve runtime scripts dir — prefer local ./scripts (dogfood: edits take effect
# immediately); fall back to ~/.claude/scripts (user-land: installed version).
if [ -f "scripts/forge-parallelism.js" ]; then
  FORGE_SCRIPTS_DIR="scripts"
else
  FORGE_SCRIPTS_DIR="$HOME/.claude/scripts"
fi
echo "FORGE_SCRIPTS_DIR=$FORGE_SCRIPTS_DIR"
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

**Extract notifications pref from PREFS:**
- `NOTIFICATIONS_ON` ← match `^notifications:[ \t]*(\S+)` (single-line, no `\s`, no `\Z`) in the merged prefs text; if absent or not `on`/`off`, default `on`. Store as `NOTIFICATIONS_ON`.

Initialize:
```
session_units    = 0
COMPACT_AFTER    = PREFS.compact_after if set and not "unlimited", else "unlimited"
                   (0 or "unlimited" disables context checkpoints entirely — this is the default)
completed_units  = []
PUSH_AVAILABLE   = null   # sentinel: not yet probed this session
```

**Probe PushNotification (1x per session, cached):**
Run `ToolSearch("select:PushNotification")` exactly once. If the result contains an entry for `PushNotification`, set `PUSH_AVAILABLE = true`; otherwise `PUSH_AVAILABLE = false`. Never re-probe — use the cached value for all subsequent call-sites. PushNotification is a deferred tool; `ToolSearch` is the correct detection method (not tool-list introspection).

**Push helper (define-once, use-thrice):**
To fire a notification at any of the 3 call-sites: if `NOTIFICATIONS_ON != "on"` OR `PUSH_AVAILABLE != true` → silent-skip (no error, no log). Otherwise call:
```
PushNotification({ title: "Forge — {RUN_ID}", message: <mensagem pt-BR> })
```
Use this helper at every call-site below. Never duplicate the guard logic.

**Cleanup orphaned tasks** — call `TaskList`. If any tasks have `status: in_progress` (leftover from a previous crashed session), mark them completed to keep the UI clean:
```
TaskUpdate({ taskId: <id>, status: "completed" })
```
Do this for ALL in_progress tasks before starting the loop. Skip if TaskList returns empty.

**Argumentos ignorados** — `/forge-auto` não aceita argumentos. Se o usuário digitou `/forge-auto resume` ou qualquer outro argumento, ignore-o silenciosamente. O auto-resume é automático via detecção abaixo.

**Auto-resume detection** — check for a previous interrupted session.

Read `auto-mode.json` and compute heartbeat freshness in one shot:
```bash
AUTO_STATE=$(node -e "
try {
  const a = JSON.parse(require('fs').readFileSync('.gsd/forge/auto-mode.json','utf8'));
  if (a.active !== true) { process.stdout.write('inactive'); return; }
  const last = a.last_heartbeat || a.worker_started || a.started_at || 0;
  const age = Date.now() - last;
  process.stdout.write(age > 300000 ? 'stale' : 'fresh');
} catch { process.stdout.write('inactive'); }
")
COMPACT_SIGNAL=$(test -f .gsd/forge/compact-signal.json && echo "yes" || echo "no")
```

Branch on `$AUTO_STATE`:

- **`inactive`** — no prior session; proceed normally to activation.
- **`stale`** — previous session died (Ctrl+C, terminal kill, OOM). The marker is lying. Clear it silently (M005+ aware of runs/*.json registry) and proceed normally to activation as a fresh start:
  ```bash
  # Clean any active runs in registry first
  for f in .gsd/forge/runs/*.json 2>/dev/null; do
    [ -f "$f" ] || continue
    node "$FORGE_SCRIPTS_DIR/forge-runs.js" --update "$(basename "$f" .json)" --json '{"active":false}' >/dev/null 2>&1 || true
  done
  echo '{"active":false}' > .gsd/forge/auto-mode.json
  ```
  Do NOT emit a resume message.
- **`fresh`** — heartbeat within the last 5 minutes.
  - If `$COMPACT_SIGNAL == "yes"` → Compact recovery path: skip ALL initialization (activation, load context, etc.). Go directly to the dispatch loop. The compact recovery check at the top of iteration 1 will re-read state from disk and delete the signal.
  - Otherwise → a session is genuinely in flight (concurrent Claude instance, or just-reopened within 5 min). Emit one line: `↺ Retomando forge-auto após interrupção...` and skip the activation step below — go directly to the dispatch loop. The marker is already set.

---

## Orchestrate — AUTO MODE

### Multi-run activation (M004+)

Resolve which run this invocation operates on, based on `$ARGUMENTS` and the active-run registry. This block runs BEFORE the legacy single-run activation below.

**Step 0 — Migrate legacy STATE.md (idempotent; required BEFORE dashboard regen):**
If the workspace has a pre-M004 single-run `.gsd/STATE.md` (no `<!-- AUTO-GENERATED -->` header) AND no `runs/*.json` exists yet, migrate the legacy state to per-milestone format. This MUST run before any dashboard regeneration — otherwise the legacy state data is destroyed by the dashboard overwrite.

```bash
node "$FORGE_SCRIPTS_DIR/forge-runs.js" --migrate-legacy --cwd "$WORKING_DIR" > /dev/null 2>&1 || true
```

The script is idempotent: returns `{migrated: false, reason: "already dashboard"}` if already migrated, or `{migrated: false, reason: "no Active Milestone field"}` if STATE.md doesn't have legacy format. Either case is a no-op. Successful migration creates `M###-STATE.md` from the legacy fields (Active Slice/Task/Phase/Auto-mode/Next Action preserved verbatim).

```bash
RESOLVE=$(node "$FORGE_SCRIPTS_DIR/forge-cli-helpers.js" --resolve-args --args "$ARGUMENTS" --command forge-auto)
STATUS=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).status)" "$RESOLVE")
RUN_ID=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).run_id || '')" "$RESOLVE")
RUN_KIND=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).kind || '')" "$RESOLVE")
MSG=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).message || '')" "$RESOLVE")
```

**Isolation setup (branch/worktree)** — when `$STATUS` resolves to `activate-new`, `resume`, or `legacy`, apply `forge_isolation` from prefs BEFORE the per-status registry actions below. For `refuse`/`error`, skip entirely — never touch git on a refused invocation. The script is idempotent (re-running on resume is a no-op: `already-on-branch` / `already-exists`). In legacy mode (`RUN_ID` empty), substitute `$ISO_RUN` with the active milestone ID from STATE.md.

```bash
ISO_RUN="${RUN_ID:-<active milestone ID from STATE.md>}"
ISO_RESULT=$(node "$FORGE_SCRIPTS_DIR/forge-isolation.js" --setup --run "$ISO_RUN" --cwd "$WORKING_DIR")
ISOLATION_MODE=$(node -e "process.stdout.write((JSON.parse(process.argv[1]).mode)||'shared')" "$ISO_RESULT")
WORKTREE_DIR=$(node -e "const r=JSON.parse(process.argv[1]);const w=(r.repos||[]).find(x=>x.worktree&&x.status!=='error');process.stdout.write(w?w.worktree:'')" "$ISO_RESULT")
ISO_ERRORS=$(node -e "const r=JSON.parse(process.argv[1]);process.stdout.write((r.repos||[]).filter(x=>x.status==='error').map(x=>x.path+': '+x.error).join('; '))" "$ISO_RESULT")
echo "ISOLATION_MODE=$ISOLATION_MODE"
echo "WORKTREE_DIR=${WORKTREE_DIR:-—}"
echo "ISO_ERRORS=${ISO_ERRORS:-none}"
```

Isolation rules (CRITICAL — the operator configured this; honor it):
- `ISOLATION_MODE == shared` → `WORKER_CWD = $WORKING_DIR`. Nothing else to do.
- `ISOLATION_MODE == branch` → `WORKER_CWD = $WORKING_DIR`. Workers commit on the `forge/{run}` branch the setup just checked out.
- `ISOLATION_MODE == worktree` → `WORKER_CWD = $WORKTREE_DIR`. ALL code reads/writes/commits happen inside the worktree; `.gsd/**` artifacts ALWAYS stay under `$WORKING_DIR` (the original workspace — registry, statusline and other tabs depend on it).
- If `ISO_ERRORS` is non-empty AND every repo failed (`WORKTREE_DIR` empty in worktree mode, or no repo succeeded in branch mode) → STOP. Surface the errors to the user. Running un-isolated when the operator explicitly configured isolation is NOT an acceptable fallback.
- If only some repos failed → emit a warning line listing them and continue.
- When `ISOLATION_MODE != shared`, emit one line so the operator sees isolation took effect: `⛓ Isolation: {mode} → {branch name or worktree path}`.

Branch on `$STATUS`:

- **`refuse`** — emit `$MSG` (lists active runs + example commands) and stop. Do NOT continue.
- **`error`** — emit `$MSG` and stop.
- **`legacy`** — zero active runs + no arg + .gsd/STATE.md is single-run legacy format. Run the legacy activation block below (preserves pre-M004 behavior). RUN_ID stays empty; `{M###}` placeholders below resolve from STATE.md as before.
- **`activate-new`** — register the new run:
  ```bash
  SESSION_ID="${CLAUDE_SESSION_ID:-$(node -e "process.stdout.write(require('crypto').randomBytes(8).toString('hex'))")}"
  node "$FORGE_SCRIPTS_DIR/forge-runs.js" --add --id "$RUN_ID" --kind "$RUN_KIND" --session "$SESSION_ID" --isolation-mode "$ISOLATION_MODE" --account "${FORGE_ACCOUNT:-}" --cwd "$WORKING_DIR" > /dev/null
  echo "$MSG"
  ```
  Then continue to legacy activation (which writes auto-mode-started.txt + alias).
- **`resume`** — emit `$MSG`, set `RUN_ID` (already set). Update the existing registry entry with the new session_id (the previous orchestrator process exited; this is a fresh session that needs to own heartbeat updates) and the freshly-resolved isolation mode:
  ```bash
  SESSION_ID="${CLAUDE_SESSION_ID:-$(node -e "process.stdout.write(require('crypto').randomBytes(8).toString('hex'))")}"
  node "$FORGE_SCRIPTS_DIR/forge-runs.js" --update "$RUN_ID" --json "{\"session_id\":\"$SESSION_ID\",\"active\":true,\"isolation_mode\":\"$ISOLATION_MODE\"}" > /dev/null
  ```
  Without this, `forge-hook.resolveBySessionId` won't match — heartbeats fall back to legacy `auto-mode.json` and `runs/{id}.json` becomes stale.

For all non-legacy paths, the `MILESTONE_DIR` for downstream substitution is `.gsd/milestones/$RUN_ID/` (if kind=milestone) or null (if kind=task). Where bash blocks below reference `{M###}`, substitute `$RUN_ID` (`$RUN_ID` may be a legacy `M###` or a timestamp `M-<ts>-<slug>` ID — the substitution is format-agnostic). Workers receive `{M###}` resolved in their prompt header via the dispatch templates.

**Regenerate dashboard** after registry change:
```bash
node "$FORGE_SCRIPTS_DIR/forge-dashboard.js" --cwd "$WORKING_DIR" --holder "auto:$RUN_ID" > /dev/null || true
```

**Bootstrap + re-load per-milestone STATE (M004+, CRITICAL — must run before dispatch loop):**

The initial `## Load context` step above read `.gsd/STATE.md`, which is now a dashboard (auto-generated, no Active Slice/Task/Phase fields). The orchestrator needs the per-milestone STATE to derive the next unit. Bootstrap if absent (brand-new milestone), then re-load:

```bash
if [ -n "$RUN_ID" ] && [ "$RUN_KIND" = "milestone" ]; then
  PER_MILESTONE_STATE=".gsd/milestones/$RUN_ID/$RUN_ID-STATE.md"
  if [ ! -f "$PER_MILESTONE_STATE" ]; then
    # Brand-new milestone: no STATE file. Bootstrap with plan-milestone phase
    # so the dispatch loop knows what to do first.
    mkdir -p ".gsd/milestones/$RUN_ID"
    node "$FORGE_SCRIPTS_DIR/forge-state.js" --create "$RUN_ID" \
      --phase plan-milestone \
      --next-action "Plan milestone $RUN_ID — decompose into slices via forge-planner" \
      --auto-mode on \
      --isolation-mode "${ISOLATION_MODE:-shared}" \
      --cwd "$WORKING_DIR" > /dev/null
    echo "→ Bootstrapped $PER_MILESTONE_STATE (plan-milestone phase)"
  fi
  # Override the STATE variable from Load context with per-milestone content.
  # This is the source of truth for `## Dispatch Loop` to derive next_unit.
  STATE=$(cat "$PER_MILESTONE_STATE")
fi
```

For `RUN_KIND=task` runs, STATE is not file-backed (tasks live in `runs/{id}.json` directly per D-M004-12) — `/forge-task` is the canonical entry for those; this skill only handles milestones.

For legacy mode (`STATUS=legacy`, `RUN_ID=""`), STATE was already loaded from `.gsd/STATE.md` in the original format — no override needed.

### Activate auto-mode indicator (legacy single-run alias)

Write marker so the status line shows `▶ AUTO`. With M005+, all `started_at` lives in `runs/{id}.json` (per-run, no sharing). Only legacy mode writes `auto-mode.json` + `auto-mode-started.txt` directly:

```bash
mkdir -p .gsd/forge
if [ -z "$RUN_ID" ]; then
  # Legacy single-run path: write shared files (no contention because legacy ⇒ 1 tab)
  _forge_now=$(node -e "process.stdout.write(String(Date.now()))")
  echo $_forge_now > .gsd/forge/auto-mode-started.txt
  echo '{"active":true,"started_at":'$_forge_now',"worker":null}' > .gsd/forge/auto-mode.json
fi
# Multi-run path: `runs/{id}.json.started_at` was set by forge-runs.add earlier (in Multi-run activation).
# `auto-mode.json` is automatically mirrored from oldest-active by refreshLegacyAlias.
# `auto-mode-started.txt` is NOT written in multi-run — each tab reads its own started_at from runs/.
```

You are the orchestrator. Execute the dispatch loop until the milestone is complete or a stop condition is hit.

**AUTONOMY RULE — CRITICAL:** This is FULLY AUTONOMOUS mode. After each unit completes with `status: done`, proceed IMMEDIATELY to the next unit. Do NOT pause to ask the user if they want to continue. Do NOT ask for confirmation between units. Do NOT summarize progress and wait for input. The ONLY reasons to STOP the loop are: milestone complete, worker returned `blocked`/`partial`, or pause requested. Between units, emit the progress line and move on — nothing else. **Single sanctioned exception:** the review triage gate before `complete-milestone` (see Dispatch guards) MAY ask the user — every slice is done at that point, so arbitrating deferred review items there does not violate this rule.

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
3a. Reset `PUSH_AVAILABLE = null` and re-execute `ToolSearch("select:PushNotification")` at the next opportunity (same "not yet probed" semantics as activation — the probe runs once per context window, not once per process)
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

**Effort is resolved in step 1.55 below** (after tier resolution), because the per-model capability clamp needs the resolved `$MODEL_ID`. Do NOT resolve effort here.

**Tier resolution (step 1.5)** — resolve `{tier, model, reason}` for this dispatch.
> Cross-reference: `shared/forge-dispatch.md § Tier Resolution` (algorithm) and `shared/forge-tiers.md` (canonical tables).

```bash
# ── Tier Resolution ────────────────────────────────────────────────────────────
# Step 1: unit-type default
declare -A TIER_DEFAULTS=(
  [memory-extract]="light" [complete-slice]="light" [complete-milestone]="light"
  [research-milestone]="standard" [research-slice]="standard"
  [discuss-milestone]="standard" [discuss-slice]="standard" [execute-task]="standard"
  [plan-milestone]="max" [plan-slice]="heavy"
)
TIER="${TIER_DEFAULTS[$unit_type]:-standard}"
REASON="unit-type:$unit_type"

# Step 2: parse frontmatter (execute-task only)
if [ "$unit_type" = "execute-task" ]; then
  PLAN_PATH=".gsd/milestones/${M###}/slices/${S##}/tasks/${T##}/${T##}-PLAN.md"
  PLAN_TIER=$(node -e "const fs=require('fs');const t=fs.readFileSync('$PLAN_PATH','utf8');const m=t.match(/^---[\s\S]*?---/);if(!m)process.exit(0);const r=(m[0].match(/^tier:\s*(.+)$/m)||[])[1]||'';process.stdout.write(r.trim())")
  PLAN_TAG=$(node  -e "const fs=require('fs');const t=fs.readFileSync('$PLAN_PATH','utf8');const m=t.match(/^---[\s\S]*?---/);if(!m)process.exit(0);const r=(m[0].match(/^tag:\s*(.+)$/m)||[])[1]||'';process.stdout.write(r.trim())")
  PLAN_EFFORT=$(node -e "const fs=require('fs');const t=fs.readFileSync('$PLAN_PATH','utf8');const m=t.match(/^---[\s\S]*?---/);if(!m)process.exit(0);const r=(m[0].match(/^effort:\s*(.+)$/m)||[])[1]||'';process.stdout.write(r.trim())")

  # Step 3: apply precedence (first match wins)
  if [ -n "$PLAN_TIER" ]; then
    TIER="$PLAN_TIER"; REASON="frontmatter-override:$PLAN_TIER"
  elif [ "$PLAN_TAG" = "docs" ]; then
    TIER="light"; REASON="frontmatter-tag:docs"
  fi
fi

# Step 3b: risk escalation (plan-slice only) — risk:high slice escalates heavy → max.
# Same ROADMAP check that triggers the risk radar gate below.
if [ "$unit_type" = "plan-slice" ]; then
  ROADMAP_PATH=".gsd/milestones/${M###}/${M###}-ROADMAP.md"
  if grep -E "${S##}.*risk:[[:space:]]*high" "$ROADMAP_PATH" >/dev/null 2>&1; then
    TIER="max"; REASON="risk-escalation:high"
  fi
fi

# Step 4: resolve model — PREFS.tier_models[tier] with fallback to forge-tiers.md defaults
MODEL_ID=$(node -e "
  let p={};try{p=JSON.parse(require('fs').readFileSync('.gsd/prefs-resolved.json','utf8'));}catch(e){}
  const d={'light':'claude-haiku-4-5-20251001','standard':'claude-sonnet-5','heavy':'claude-opus-4-8','max':'claude-fable-5'};
  const tier='$TIER';
  const validTiers=['light','standard','heavy','max'];
  const t=validTiers.includes(tier)?tier:'standard';
  process.stdout.write((p.tier_models||{})[t]||d[t]);
")
```
`TIER`, `MODEL_ID`, and `REASON` are now set. Use `$MODEL_ID` in the `Agent()` call below (Step 4). `$TIER` and `$REASON` are injected into the dispatch event.

> **Fable 5 thinking guard:** if `$MODEL_ID` is `claude-fable-5`, inject `thinking: adaptive` in the
> worker prompt header (or omit the `thinking:` line) regardless of the phase's `thinking:` pref —
> `claude-fable-5` returns HTTP 400 on an explicit `thinking: disabled` (Opus 4.7/4.8 accept it).

**Effort resolution (step 1.55)** — resolve `$EFFORT` for this dispatch. Runs **after** tier resolution because the per-model capability clamp needs `$MODEL_ID`.
> Cross-reference: `shared/forge-dispatch.md § Effort Resolution` (algorithm, scale, clamp table).

```bash
# ── Effort Resolution (after Tier Resolution; needs $MODEL_ID) ────────────────────
# Ordered scale (cheap → expensive reasoning): low < medium < high < xhigh < max
# Step 1: unit-type default — PREFS.effort (EFFORT_MAP) wins; fallback to built-in defaults.
declare -A EFFORT_DEFAULTS=(
  [plan-milestone]="medium" [plan-slice]="medium"
  [discuss-milestone]="medium" [discuss-slice]="medium"
  [research-milestone]="medium" [research-slice]="medium"
  [execute-task]="low" [complete-slice]="low" [complete-milestone]="low"
  [memory-extract]="low"
)
EFFORT="${EFFORT_MAP[$unit_type]:-${EFFORT_DEFAULTS[$unit_type]:-low}}"
EFFORT_REASON="unit-type:$unit_type"

# Step 2: dedicated frontmatter axis (execute-task only) — effort: in T##-PLAN wins, independent of tier:
if [ "$unit_type" = "execute-task" ] && [ -n "$PLAN_EFFORT" ]; then
  EFFORT="$PLAN_EFFORT"; EFFORT_REASON="frontmatter-effort:$PLAN_EFFORT"
fi

# Step 3: risk escalation sync — a risk:high plan-slice (TIER bumped to max) also gets max effort.
if [ "$unit_type" = "plan-slice" ] && [ "$REASON" = "risk-escalation:high" ]; then
  EFFORT="max"; EFFORT_REASON="risk-escalation:high"
fi

# Step 4: clamp to the resolved model's capability ceiling — prevents HTTP 400s + wasted config.
# haiku/sonnet cap at medium; opus/fable allow the full scale.
EFFORT_CLAMPED=$(node -e "
  const rank={low:0,medium:1,high:2,xhigh:3,max:4};
  const model='$MODEL_ID';
  const cap=(/^claude-(haiku|sonnet)/.test(model))?'medium':'max';
  let e='$EFFORT'; if(!(e in rank)) e='medium';
  process.stdout.write(rank[e]>rank[cap]?cap:e);
")
if [ "$EFFORT_CLAMPED" != "$EFFORT" ]; then
  EFFORT_REASON="${EFFORT_REASON}|clamped:model-cap"; EFFORT="$EFFORT_CLAMPED"
fi
unit_effort="$EFFORT"
```
`unit_effort` (and `$EFFORT`/`$EFFORT_REASON` for the dispatch event) are now set. Inject `effort: {unit_effort}` and (for opus/fable phases) `thinking: {THINKING_OPUS}` into the worker prompt header.

**Batch determination (step 1.6 — execute-task only):** When `unit_type == execute-task`, the dispatch is no longer strictly single-task. Invoke `scripts/forge-parallelism.js` to compute a **ready batch** — a set of tasks in the active slice whose `depends:[]` are satisfied AND whose `writes:[]` don't overlap with each other.

```bash
SLICE_PLAN=".gsd/milestones/${M###}/slices/${S##}/${S##}-PLAN.md"
MAX_CONCURRENT=$(node -e "
  let p={};try{p=JSON.parse(require('fs').readFileSync('.gsd/prefs-resolved.json','utf8'));}catch(e){}
  process.stdout.write(String((p.parallelism && p.parallelism.max_concurrent) || 3));
")
BATCH_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-parallelism.js" --slice-plan "$SLICE_PLAN" --max-concurrent "$MAX_CONCURRENT")
echo "$BATCH_JSON"
```

Parse the JSON. Field semantics:

| `mode` | Meaning | Action |
|--------|---------|--------|
| `parallel` | `batch.length ≥ 2` — multiple ready tasks, no `writes` conflicts | Parallel dispatch path (Step 4 branch B) |
| `single` | `batch.length == 1` — modern plan, only one task currently ready | Single dispatch path (Step 4 branch A) |
| `legacy` | At least one task in slice is missing `depends` or `writes` frontmatter | Single dispatch with `batch[0]` — preserves behavior for pre-parallelism plans |
| `blocked` | Pending tasks exist but none have satisfied deps (or all ready tasks were filtered out) | Error — emit `reason` to user, deactivate auto-mode, stop loop |
| `none` | All tasks complete | Advance STATE, re-derive unit_type (should flip to `complete-slice`) |
| `error` | Script crash | Stop loop, surface reason |

Store the parsed batch as `BATCH = [{id, planPath}, ...]`. For non-execute-task unit_types, treat `BATCH = [{id: unit_id, planPath: (n/a)}]` implicitly — the rest of the flow below is unchanged for them.

When `mode == "parallel"`, emit one line so the user sees the parallelism in action:
```
⇉ Batch paralelo: T01, T02, T03 (3 independent tasks ready)
```

When `mode == "legacy"`, emit one line (the first time per slice — not every iteration):
```
↻ Legacy plan — dispatching sequentially (no depends/writes frontmatter)
```

**Per-task resolution (parallel only):** If `BATCH.length > 1`, the Tier Resolution block above resolved for `$PLAN_PATH` of the **first** task. Before building prompts, re-run the frontmatter parse (steps 2–3 of Tier Resolution) once per task in the batch so each one carries its own `{TIER, MODEL_ID, REASON}`. The unit-type default and model lookup steps don't change. Security gate (below) also loops over each task in the batch.

**Risk radar gate (plan-slice only):** If `unit_type == plan-slice` and the slice is tagged `risk:high` in ROADMAP, check if `S##-RISK.md` already exists. If not:
```
mkdir -p .gsd/milestones/{M###}/slices/{S##}
Skill({ skill: "forge-risk-radar", args: "{M###} {S##}" })
```
This runs the risk assessment in the current context before the plan-slice agent is dispatched. The produced `S##-RISK.md` will be injected into the worker prompt.

**Security gate (execute-task only):** If `unit_type == execute-task`, run this check for **each task in `BATCH`** (when `BATCH.length > 1`, iterate through every batch member; when `BATCH.length == 1`, run once for the single task).

For each task T## in BATCH: scan the corresponding `T##-PLAN.md` content for security-sensitive keywords:
`auth|token|crypto|password|secret|api.?key|jwt|oauth|permission|role|hash|salt|encrypt|decrypt|session|cookie|credential|sanitize|xss|sql|inject`

If any keyword matches AND `T##-SECURITY.md` does not already exist in that task's directory:
```
Skill({ skill: "forge-security", args: "{M###} {S##} {T##}" })
```
The produced `T##-SECURITY.md` will be injected into that task's worker prompt as `## Security Checklist`. Skills run in the orchestrator context — loop them serially (fast enough; each is short) before dispatching the batch in parallel.

**Review gate (before complete-slice):** If `unit_type == complete-slice`, run the **dialectic review** on the slice diff BEFORE dispatching `forge-completer` (the slice branch `gsd/{M###}/{S##}` is still unmerged here, so the diff is intact). This is the challenger × defender confrontation:

1. Idempotency: if `{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-REVIEW.md` already exists → skip the gate, proceed to `complete-slice`.
2. Read `review.{mode,style,rounds,ask_in_auto,engine}` via the cascade in `shared/forge-review.md § Step 0`. If `mode == disabled` → skip.
3. Execute the procedure in **`shared/forge-review.md`** with `MODE = auto`:
   > Antes de despachar cada agente (Challenge e Defense abaixo), exiba o **Spawn Liveness Banner** referenciado em `shared/forge-dispatch.md § Spawn Liveness Banner` com duração estimada para `review-challenger` / `review-advocate`.
   - **Engine** (`shared/forge-review.md § Engine workflow`): se `engine: workflow` e a tool `Workflow` estiver no seu tool list (introspecção — NÃO ToolSearch), os três dispatches abaixo (Challenge/Defense/Rebuttal) são substituídos por UMA invocação Workflow; em tool ausente ou erro → fallback agents com warning + evento `review-engine-fallback`. O render do Step 6 e os Steps 7a/7b/8 não mudam.
   - Challenge → `Agent({ subagent_type: 'forge-reviewer', … })`
   - Defense → `Agent({ subagent_type: 'forge-advocate', … })`
   - Rebuttal × `rounds` → `forge-reviewer` in rebuttal mode (DEFENSE injected)
   - Resolve (Step 5 truth table), write `{S##}-REVIEW.md` (Step 6).
   - **CONCEDED items → fix now (Step 7a):** dispatch `Agent({ subagent_type: 'forge-executor', … })` with `UNIT: review-fix/{S##}` to fix ONLY the conceded items on the still-unmerged slice branch (skip when `review.fix_conceded: false`). On success mark each `**Correção:** aplicada — commit {sha}`; on failure mark `falhou — deferida para triagem final`. No re-review of the fix commit.
   - **OPEN items → posture (Step 7b):** `ask_in_auto: defer` (default) marks each `**Decisão:** deferido → triagem no fim da milestone` and continues WITHOUT pausing — they are guaranteed to surface at the milestone-final triage gate below. `pause` (opt-in) asks per-slice via `AskUserQuestion`.
   - Append the `review` event to `events.jsonl` (Step 8).
4. The gate **never blocks** — any `Agent()` throw is recorded and the loop proceeds to `complete-slice` regardless.

> Fires ONLY when the derived unit is `complete-slice`. Boundary is per-slice; standalone `/forge-task` keeps its own step-5.5 review. After the gate, dispatch `forge-completer` normally.

**Review triage gate (before complete-milestone):** If `unit_type == complete-milestone`, run the **milestone-final triage** (`shared/forge-review.md § Step 9`) BEFORE dispatching `forge-completer` — i.e., before the milestone is finalized "de fato" (final close-out, LEDGER entry, cleanup):

1. Scan all `{S##}-REVIEW.md` under `.gsd/milestones/{M###}/slices/*/` for pending items: `Decisão: deferido → triagem no fim da milestone`, `Correção: falhou — deferida para triagem final`, or legacy `Decisão: deferido (auto-mode)`.
2. Zero pending → skip silently and dispatch `complete-milestone` normally.
3. Otherwise **fire push (call-site 2):** use Push helper with message `"Forge {RUN_ID} — {N} item(ns) de review aguardam sua triagem antes de fechar a milestone."` (N = count of pending items). Then print the digest table (slice · R# · path:line · objeção · status) and triage each item via `AskUserQuestion` (batched up to 4, header `Review M###`): `Manter abordagem atual` / `Refatorar agora` / `Criar follow-up`.
4. `Refatorar agora` items → ONE `review-fix/{M###}-triage` dispatch to `forge-executor` (slices already merged — fixes are normal commits). Write every decision back into the R#'s `**Decisão:**` line; `Criar follow-up` items also append to `.gsd/KNOWLEDGE.md § Review follow-ups` (survives `milestone_cleanup`).
5. Append the `review-triage` event to `events.jsonl`. The triage **never blocks** the milestone close-out.

> **This gate is the explicit exception to the AUTONOMY RULE** — at this point every slice is done; asking the operator here is the designed arbitration moment that `defer` postponed to. It does not fire on pause/blocked/partial exits — only when the derived unit is `complete-milestone`.

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
   for plan in "$WORKING_DIR/.gsd/milestones/{M###}/slices/{S##}/tasks"/T*/T*-PLAN.md; do
     node "$FORGE_SCRIPTS_DIR/forge-must-haves.js" --check "$plan"
   done
   ```
   Capture stdout JSON. Build an array of `{task_id, legacy, valid, errors}`. Serialize to JSON as `MUST_HAVES_CHECK_RESULTS`.

5. **Fill the plan-check template** from `shared/forge-dispatch.md § plan-check` with `$WORKING_DIR` (not raw CWD — always use the bash-captured variable), `{M###}`, `{S##}`, `{PLAN_CHECK_MODE}`, `{MUST_HAVES_CHECK_RESULTS}`.

6. **Dispatch:**
   > Antes de despachar o plan-checker, exiba o **Spawn Liveness Banner** (ver `shared/forge-dispatch.md § Spawn Liveness Banner`) — duração estimada `plan-check`: ~1–2 min.
   ```
   Agent({ subagent_type: 'forge-plan-checker', prompt: <filled-template> })
   ```

7. **Parse the worker result** — extract `plan_check_counts: {pass, warn, fail}` from the `---GSD-WORKER-RESULT---` block.

8. **Append to `{WORKING_DIR}/.gsd/forge/events.jsonl`** (I/O errors MUST propagate — no silent-fail):
   ```json
   {"ts":"<ISO-8601>","event":"plan_check","milestone":"${RUN_ID:-{M###}}","slice":"{S##}","mode":"{PLAN_CHECK_MODE}","counts":{"pass":N,"warn":N,"fail":N}}
   ```

9. **Branch on `PLAN_CHECK_MODE`:**
   - `advisory` → proceed to first `execute-task` regardless of counts.
   - `blocking` → enter the **Blocking-mode revision loop** below.
   - (`disabled` already handled in step 2.)

10. **Forward-compatibility note:** future M004+ may add per-dimension enforcement. The current wire passes through all dimension counts to events.jsonl so future code can filter.

> This gate fires ONLY when transitioning from a just-completed `plan-slice` to the first `execute-task` of the same slice. When deriving the next unit (Step 1) results in `execute-task` AND the previous completed unit was `plan-slice` for the same slice, run this gate. For subsequent `execute-task` dispatches within the same slice, the idempotency check (step 3 above) ensures the gate is a no-op.

### Plan gate — degradação no modo auto (NUNCA conduz)

**Plan-gate degradation (auditable) — forge-auto NEVER conducts the interactive handshake:**

`forge-auto` (`MODE = auto`) **never conducts** the plan gate handshake defined in `shared/forge-plan-gate.md`. This is **unconditional over `MODE = auto`** — it applies regardless of the `plan_gate.interactive` pref value. Setting `interactive: always` does NOT cause `forge-auto` to pause and ask.

The path in `forge-auto` at the plan boundary:
1. Run `forge-planner` (batch — unchanged).
2. Run `forge-plan-checker` (advisory — unchanged, handled by the gate above).
3. **Skip the interactive gate entirely.** No preview, no `AskUserQuestion`, no approval marker.
4. Proceed directly to `execute-task`.

`ask_in_auto: defer` (default) is the explicit guard — it mirrors `review.ask_in_auto: defer` from `shared/forge-review.md`. The AUTONOMY RULE protects the middle of the loop; plan-gate conduct is incompatible with autonomous operation.

**Spec authority:** `shared/forge-plan-gate.md § Degradation by mode`.

**Symbol-check gate (between plan-slice and first execute-task, after plan-check gate):**

After the plan-check gate completes (or is skipped), run the symbol-check gate before dispatching the first `execute-task` for the same slice. This gate runs via Bash shell-out — NOT via `Agent()` — so there is no liveness banner and return is immediate. See `shared/forge-dispatch.md § symbol-check` for artifact format and event schema.

1. **Read `symbol_check.mode` from the 3-file prefs cascade:**
   ```bash
   SYMBOL_CHECK_MODE=$(node -e "
   const fs=require('fs'),path=require('path'),os=require('os');
   const wd=process.env.WORKING_DIR||process.cwd();
   const files=[path.join(os.homedir(),'.claude','forge-agent-prefs.md'),
                path.join(wd,'.gsd','claude-agent-prefs.md'),
                path.join(wd,'.gsd','prefs.local.md')];
   let mode='advisory';
   for(const f of files){try{const r=fs.readFileSync(f,'utf8');const m=r.match(/^symbol_check:[ \t]*\n[ \t]+mode:[ \t]*(\w+)/m);if(m)mode=m[1].toLowerCase();}catch(e){}}
   if(mode!=='advisory'&&mode!=='disabled')mode='advisory';
   process.stdout.write(mode);
   " WORKING_DIR="$WORKING_DIR")
   ```
   Store as `SYMBOL_CHECK_MODE`.

2. **If `SYMBOL_CHECK_MODE == "disabled"`:** skip — proceed to first `execute-task`.

3. **Idempotency check:** if `{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-SYMBOL-CHECK.md` already exists, skip — proceed to first `execute-task`.

4. **Run symbol-check for each T##-PLAN.md in the slice:**
   ```bash
   SYMBOL_CHECK_RESULTS="["
   FIRST=1
   TOTAL_VERIFIED=0; TOTAL_MISSING=0; TOTAL_AMBIGUOUS=0; TOTAL_UNCHECKED=0; TOTAL_GREENFIELD=0
   for plan in "$WORKING_DIR/.gsd/milestones/{M###}/slices/{S##}/tasks"/T*/T*-PLAN.md; do
     # --cwd: raiz de busca de código = CODE_DIR (worktree isolation) — WORKING_DIR só vale p/ .gsd/** (review S02 R6)
     result=$(node "$FORGE_SCRIPTS_DIR/forge-symbol-check.js" --check "$plan" --cwd "${WORKER_CWD:-$WORKING_DIR}")
     if [ $FIRST -eq 0 ]; then SYMBOL_CHECK_RESULTS="$SYMBOL_CHECK_RESULTS,"; fi
     SYMBOL_CHECK_RESULTS="$SYMBOL_CHECK_RESULTS$result"
     FIRST=0
     TOTAL_VERIFIED=$((TOTAL_VERIFIED + $(echo "$result" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(String(d.counts.verified||0))")))
     TOTAL_MISSING=$((TOTAL_MISSING   + $(echo "$result" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(String(d.counts.missing||0))")))
     TOTAL_AMBIGUOUS=$((TOTAL_AMBIGUOUS + $(echo "$result" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(String(d.counts.ambiguous||0))")))
     TOTAL_UNCHECKED=$((TOTAL_UNCHECKED + $(echo "$result" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(String(d.counts.uncheckable||0))")))
     TOTAL_GREENFIELD=$((TOTAL_GREENFIELD + $(echo "$result" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(String(d.counts.greenfield||0))")))
   done
   SYMBOL_CHECK_RESULTS="$SYMBOL_CHECK_RESULTS]"
   ```
   Aggregate `{verified, missing, ambiguous, unchecked, greenfield}` totals across all tasks.

5. **Write `S##-SYMBOL-CHECK.md`** to `{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-SYMBOL-CHECK.md` (see `shared/forge-dispatch.md § symbol-check` for format). Then **append the `symbol_check` event** to `{WORKING_DIR}/.gsd/forge/events.jsonl` (I/O errors MUST propagate — no silent-fail):
   ```json
   {"ts":"<ISO-8601>","event":"symbol_check","milestone":"${RUN_ID:-{M###}}","slice":"{S##}","mode":"{SYMBOL_CHECK_MODE}","counts":{"verified":N,"missing":N,"ambiguous":N,"unchecked":N,"greenfield":N}}
   ```

6. **Proceed to first `execute-task` ALWAYS** (advisory). MISSING or AMBIGUOUS symbols are documented in `S##-SYMBOL-CHECK.md` for informational use — they NEVER block the execute-task dispatch.

> This gate fires ONLY when transitioning from a just-completed `plan-slice` to the first `execute-task` of the same slice. Fires AFTER the plan-check gate. The idempotency check (step 3 above) makes it a no-op for subsequent `execute-task` dispatches within the same slice.

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
echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"plan_check\",\"milestone\":\"${RUN_ID:-{M###}}\",\"slice\":\"{S##}\",\"mode\":\"blocking\",\"round\":1,\"counts\":{\"pass\":${PASS_COUNT},\"warn\":${WARN_COUNT},\"fail\":${FAIL_COUNT}},\"prev_fail\":null,\"outcome\":\"revised\"}" >> {WORKING_DIR}/.gsd/forge/events.jsonl
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
  echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"plan_check\",\"milestone\":\"${RUN_ID:-{M###}}\",\"slice\":\"{S##}\",\"mode\":\"blocking\",\"round\":{round},\"counts\":{\"pass\":${NEW_PASS},\"warn\":${NEW_WARN},\"fail\":${new_fail_count}},\"prev_fail\":${prev_fail_count},\"outcome\":\"revised\"}" >> {WORKING_DIR}/.gsd/forge/events.jsonl
  ```

  **h. Monotonic-decrease check:** if `new_fail_count >= prev_fail_count`, TERMINATE (non-decreasing):
  - Overwrite the `outcome` field in the events.jsonl line just written — or append a corrective entry:
    ```bash
    echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"plan_check\",\"milestone\":\"${RUN_ID:-{M###}}\",\"slice\":\"{S##}\",\"mode\":\"blocking\",\"round\":{round},\"outcome\":\"terminated-non-decreasing\",\"prev_fail\":${prev_fail_count},\"new_fail\":${new_fail_count}}" >> {WORKING_DIR}/.gsd/forge/events.jsonl
    ```
  - Surface to user (see **Termination Surface Block** below — reason: `non-decreasing`).
  - Deactivate run (M005+ pattern):
    ```bash
    if [ -n "$RUN_ID" ]; then
      node "$FORGE_SCRIPTS_DIR/forge-runs.js" --update "$RUN_ID" --json '{"active":false}' > /dev/null
    else
      echo '{"active":false}' > {WORKING_DIR}/.gsd/forge/auto-mode.json
    fi
    ```
  - **Stop loop.** Do NOT dispatch the first `execute-task` for this slice. Return.

  **i. Update state:** `prev_fail_count = new_fail_count`.

**After the while loop exits:**

- If `prev_fail_count == 0`:
  - Append events.jsonl:
    ```bash
    echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"plan_check\",\"milestone\":\"${RUN_ID:-{M###}}\",\"slice\":\"{S##}\",\"mode\":\"blocking\",\"round\":{round},\"outcome\":\"passed\"}" >> {WORKING_DIR}/.gsd/forge/events.jsonl
    ```
  - Proceed to the first `execute-task` dispatch normally.

- Else (`round == MAX_PLAN_CHECK_ROUNDS` and `prev_fail_count > 0`):
  - Append events.jsonl:
    ```bash
    echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"plan_check\",\"milestone\":\"${RUN_ID:-{M###}}\",\"slice\":\"{S##}\",\"mode\":\"blocking\",\"round\":{round},\"outcome\":\"terminated-exhausted\"}" >> {WORKING_DIR}/.gsd/forge/events.jsonl
    ```
  - Surface to user (see **Termination Surface Block** below — reason: `exhausted`).
  - Deactivate run (M005+ pattern):
    ```bash
    if [ -n "$RUN_ID" ]; then
      node "$FORGE_SCRIPTS_DIR/forge-runs.js" --update "$RUN_ID" --json '{"active":false}' > /dev/null
    else
      echo '{"active":false}' > {WORKING_DIR}/.gsd/forge/auto-mode.json
    fi
    ```
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
- `{WORKING_DIR}` <- current working directory (orchestrator workspace — all `.gsd/**` paths)
- `{M###}`, `{S##}`, `{T##}` <- from STATE
- `{unit_effort}`, `{THINKING_OPUS}` <- resolved effort/thinking for this unit
- `{TOP_MEMORIES}` <- RELEVANT_MEMORIES (already filtered in Step 4)
- `{CS_LINT}` <- CS_LINT section (already extracted)
- `{CS_STRUCTURE}` <- CS_STRUCTURE section (already extracted)
- `{CS_RULES}` <- CS_RULES section (already extracted)
- `{auto_commit}` <- PREFS.auto_commit
- `{milestone_cleanup}` <- PREFS.milestone_cleanup
- `{CODING_STANDARDS}` <- full CODING_STANDARDS content (for research templates)

**Isolation header** — when `ISOLATION_MODE != shared` (resolved at activation), append these lines to the worker prompt header, immediately after the `WORKING_DIR:` line (see `shared/forge-dispatch.md § Isolation Header Convention`):
```
ISOLATION: {ISOLATION_MODE}
BRANCH: {resolved branch name, e.g. forge/M-20260601...}
CODE_DIR: {WORKER_CWD}
Isolation rule: all source-code reads, writes, builds and git commits happen inside CODE_DIR on branch BRANCH. All .gsd/** artifact paths stay under WORKING_DIR. Never commit from WORKING_DIR when CODE_DIR differs.
```
(In `branch` mode `CODE_DIR == WORKING_DIR` — include the header anyway so the worker commits on the right branch and never switches back to the default branch.)

Do NOT read artifact files here — templates now pass paths; workers read their own context.

#### 4. Dispatch

**Branch on BATCH size:**
- `BATCH.length == 1` (all non-execute-task unit types, plus execute-task when only one task is ready): follow the **single-task flow** below (unchanged from pre-parallelism behavior).
- `BATCH.length > 1` (execute-task only, when `forge-parallelism.js` returned `mode: parallel`): follow the **parallel-batch flow** in Step 4-P after this section.

---

**Single-task flow (BATCH.length == 1):**

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

**Selective memory injection** — before building the worker prompt, source memory entries from the fragment store via the `forge-memory.js` API (D9):

```bash
# 1. List all available fragment unit IDs
_frag_list=$(node "$FORGE_SCRIPTS_DIR/forge-memory.js" --list --cwd "$WORKING_DIR" 2>/dev/null || echo "[]")
```

If `_frag_list` is a non-empty JSON array (fragment store is populated):
- For each `unit_id` in the list, read its fragment:
  ```bash
  _frag=$(node "$FORGE_SCRIPTS_DIR/forge-memory.js" --read <unit_id> --cwd "$WORKING_DIR" 2>/dev/null)
  ```
  Each fragment has `facts[]`, `category`, `confidence`, `hits`.
- Apply filter to `facts[]` entries using the same selection logic:
  - For `execute-task`: read keywords from `T##-PLAN.md` title + step names. Include facts that share ≥2 keywords with the plan. Prefer categories `gotcha` and `convention`. Cap at 8 entries total across all fragments.
  - For `plan-slice` / `research-slice`: include facts from fragments with `category` = `architecture` or `pattern` related to the milestone scope. Cap at 8 entries.
  - For other unit types: include top-5 facts by fragment `confidence` score.
- Collect matching facts into `RELEVANT_MEMORIES` string (same shape as before — one bullet per fact).

If `_frag_list` is `[]` or errors (pre-fragment-store workspace — fragment store not yet populated):
- Fall back to `ALL_MEMORIES` (loaded from `.gsd/AUTO-MEMORY.md` at step 5 of Load context) using the same filter logic above.

If no entries match in either path: set `RELEVANT_MEMORIES` to `(none)`.

Store as `RELEVANT_MEMORIES` and use in the worker prompt `## Project Memory` section instead of the raw full file.

> For human-readable consolidation of the fragment store into `.gsd/AUTO-MEMORY.md`, run `/forge-doctor --regen-projection` (uses `forge-memory.js --write-all` / `forge-projection` internally). The monolith is no longer the runtime source of truth (D9).

**Heartbeat — record active worker** before dispatching (M005+: writes via forge-runs.js when multi-run, legacy auto-mode.json fallback):
```bash
_now=$(node -e "process.stdout.write(String(Date.now()))")
if [ -n "$RUN_ID" ]; then
  # Multi-run: forge-runs.update bumps runs/{id}.json + auto-refreshes legacy alias
  node "$FORGE_SCRIPTS_DIR/forge-runs.js" --update "$RUN_ID" --json "{\"worker\":\"UNIT_TYPE/UNIT_ID\",\"worker_started\":$_now,\"last_heartbeat\":$_now,\"active\":true}" > /dev/null
else
  # Legacy single-run path
  _sa=$(cat .gsd/forge/auto-mode-started.txt 2>/dev/null || node -e "process.stdout.write(String(Date.now()))")
  echo "{\"active\":true,\"started_at\":$_sa,\"last_heartbeat\":$_now,\"worker\":\"UNIT_TYPE/UNIT_ID\",\"worker_started\":$_now}" > .gsd/forge/auto-mode.json
fi
```
Replace `UNIT_TYPE/UNIT_ID` with the actual values (e.g., `execute-task/T01`). Multi-run uses each run's own `runs/{id}.json` as source-of-truth; `auto-mode.json` is automatically synced to oldest-active by `forge-runs.refreshLegacyAlias` (eliminates cross-tab race). Legacy mode preserved for pre-M004 workspaces.

<!-- token-telemetry-integration -->
Per `shared/forge-dispatch.md § Token Telemetry` — compute input tokens, dispatch, capture output tokens, append dispatch event (I/O errors MUST propagate):
```bash
INPUT_TOKENS=$(node "$FORGE_SCRIPTS_DIR/forge-tokens.js" --inline "$worker_prompt")
```

> Antes de despachar o worker principal, exiba o **Spawn Liveness Banner** (ver `shared/forge-dispatch.md § Spawn Liveness Banner`) com a duração estimada para o `unit_type` sendo executado (consulte a tabela de duração na seção canônica).

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
OUTPUT_TOKENS=$(node "$FORGE_SCRIPTS_DIR/forge-tokens.js" --inline "$result")
mkdir -p .gsd/forge/
echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"dispatch\",\"unit\":\"${unitType}/${unitId}\",\"model\":\"${MODEL_ID}\",\"tier\":\"${TIER}\",\"reason\":\"${REASON}\",\"effort\":\"${EFFORT}\",\"effort_reason\":\"${EFFORT_REASON}\",\"input_tokens\":${INPUT_TOKENS},\"output_tokens\":${OUTPUT_TOKENS}}" >> .gsd/forge/events.jsonl
```

**Guarded dispatch — apply the Retry Handler section of `shared/forge-dispatch.md`:** Wrap the `Agent()` call in a try/catch. On throw:

1. Capture the exception message into `errorMsg`.
2. Shell out: `node "$FORGE_SCRIPTS_DIR/forge-classify-error.js" --msg "$errorMsg"` → parse `{ kind, retry, backoffMs? }`.
3. If `retry === true` AND `attempt <= PREFS.retry.max_transient_retries` (default 3): increment `attempt`, apply backoff, append a retry event (include `input_tokens: INPUT_TOKENS` from the retry prompt) to `.gsd/forge/events.jsonl`, and re-dispatch. Task stays `in_progress` between retries. Heartbeat write is NOT disturbed.
4. Otherwise fall through to the CRITICAL path below.

> Transient errors (`rate-limit`, `network`, `server`, `stream`, `connection`) are handled by the Retry Handler before this block is reached. The CRITICAL path below is only reached when the classifier returns `retry: false` OR retries are exhausted.

**CRITICAL — Agent() dispatch failure (permanent / retries exhausted):** Do NOT attempt to execute the work inline. Instead:
1. Deactivate run (M005+ pattern):
   ```bash
   if [ -n "$RUN_ID" ]; then
     node "$FORGE_SCRIPTS_DIR/forge-runs.js" --update "$RUN_ID" --json '{"active":false}' > /dev/null
   else
     echo '{"active":false}' > .gsd/forge/auto-mode.json
   fi
   ```
2. Mark the task as in_progress (leave it — signals interruption): skip TaskUpdate
3. Stop the loop immediately and tell the user:
   > ⚠ Falha ao despachar subagente para `{unit_type} {unit_id}`: `{kind}` (não surfaçar `errorMsg`)
   > Execute `/forge-auto` para tentar novamente quando a API estiver disponível.

Executing work inline bypasses context isolation and is NEVER acceptable as a fallback.

**Heartbeat — clear worker field** after Agent() returns (M005+ pattern):
```bash
_now=$(node -e "process.stdout.write(String(Date.now()))")
if [ -n "$RUN_ID" ]; then
  node "$FORGE_SCRIPTS_DIR/forge-runs.js" --update "$RUN_ID" --json "{\"worker\":null,\"worker_started\":null,\"last_heartbeat\":$_now,\"active\":true}" > /dev/null
else
  _sa=$(cat .gsd/forge/auto-mode-started.txt 2>/dev/null || node -e "process.stdout.write(String(Date.now()))")
  echo "{\"active\":true,\"started_at\":$_sa,\"last_heartbeat\":$_now,\"worker\":null}" > .gsd/forge/auto-mode.json
fi
```

---

#### 4-P. Parallel-batch flow (execute-task only, BATCH.length > 1)

This branch runs ONLY when `forge-parallelism.js` returned `mode: parallel` for an `execute-task` unit. All tasks in `BATCH` have satisfied `depends:[]` and non-overlapping `writes:[]`.

**a) Per-task resolution** — for each task `T##` in BATCH, already resolved (Per-task resolution step above) so each task has its own `{TIER, MODEL_ID, REASON, SECURITY_PATH, PLAN_PATH}`. Build a **per-task worker prompt** using the same substitution rules as Step 3 (templates from `forge-dispatch.md`, memory filter per-task, coding standards sections, etc.).

**b) Create N timeline tasks** — emit one `TaskCreate` per batch member (icon `⚡`, one-liner from T##-PLAN.md). Store returned IDs in parallel array `task_ids = [id1, id2, ...]`. Mark each `in_progress` via `TaskUpdate`.

**c) Heartbeat — record multi-worker** before parallel dispatching (M005+ pattern):
```bash
_now=$(node -e "process.stdout.write(String(Date.now()))")
# workers_csv = "execute-task/T01,execute-task/T02,..." built from BATCH
if [ -n "$RUN_ID" ]; then
  node "$FORGE_SCRIPTS_DIR/forge-runs.js" --update "$RUN_ID" --json "{\"worker\":\"BATCH:$workers_csv\",\"worker_started\":$_now,\"last_heartbeat\":$_now,\"active\":true}" > /dev/null
else
  _sa=$(cat .gsd/forge/auto-mode-started.txt 2>/dev/null || node -e "process.stdout.write(String(Date.now()))")
  echo "{\"active\":true,\"started_at\":$_sa,\"last_heartbeat\":$_now,\"worker\":\"BATCH:$workers_csv\",\"worker_started\":$_now}" > .gsd/forge/auto-mode.json
fi
```
Use a single `BATCH:<csv>` worker label so the statusline shows the parallel group without special-casing.

**d) Compute per-task INPUT_TOKENS** — loop and capture each:
```bash
INPUT_TOKENS_T01=$(node "$FORGE_SCRIPTS_DIR/forge-tokens.js" --inline "$prompt_T01")
INPUT_TOKENS_T02=$(node "$FORGE_SCRIPTS_DIR/forge-tokens.js" --inline "$prompt_T02")
# ... for each task in BATCH
```

**e) Dispatch ALL N Agent() calls IN ONE RESPONSE MESSAGE** — this is the critical Claude Code semantic: multiple tool-use blocks in a single assistant turn execute concurrently. Emit **all N `Agent()` calls inside the same assistant message** (not sequential messages).

**⚠ CRITICAL — tool-call shape (read before dispatching):**

The built-in description of the `Agent` tool suggests `run_in_background: true` for "genuinely independent work to do in parallel." **That guidance does NOT apply here.** In this flow we parallelize BUT we need the results back in the SAME turn to process them and drive the next loop iteration. Violating this has already caused a 3+ hour hang in production where 3 backgrounded executors completed but the orchestrator never picked up their results.

- The parallel semantic in Claude Code is: **foreground multi-call = parallel-with-results.** Background is fire-and-forget (e.g., `forge-memory` step 6d) — you do not await it.
- **Never pass these params** on the parallel executor dispatch: `run_in_background`, `isolation`, `model` override, or any field other than `subagent_type`, `description`, `prompt`.
- The only Agent() call in this whole SKILL that legitimately takes `run_in_background: true` is the `forge-memory` dispatch in step 6d (single-task path) and its equivalent in step 4-P/j. Executors never.
- UI tell: if after dispatching you see `⎿ Backgrounded agent` under any of the N calls, you've already broken the contract. See step (f) fail-fast below.

Example shape (N=3), exact and minimal:

> Antes de despachar o batch paralelo de executors abaixo, exiba o **Spawn Liveness Banner** (ver `shared/forge-dispatch.md § Spawn Liveness Banner`) — duração estimada para `execute-task`: ~1–5 min (varia conforme a complexidade da task).

```
Agent({ subagent_type: "forge-executor", description: "⚡ T01 · <one-liner>", prompt: "<prompt_T01>" })
Agent({ subagent_type: "forge-executor", description: "⚡ T02 · <one-liner>", prompt: "<prompt_T02>" })
Agent({ subagent_type: "forge-executor", description: "⚡ T03 · <one-liner>", prompt: "<prompt_T03>" })
```

**f) Await all results — and fail fast if the shape is wrong.** Claude Code returns all N results together in the same turn when step (e) was done correctly. Collect them as `results = [{taskId: "T01", result: "..."}, ...]` preserving BATCH order.

**Fail-fast check (execute BEFORE processing any result):** if the tool-result payload for any of the N `Agent()` calls is the background-dispatch acknowledgement shape (contains "Backgrounded agent" / agent ID without the `---GSD-WORKER-RESULT---` block), the contract was violated in step (e). Treat this as a permanent failure:

1. Do NOT wait for background completion notifications — they may arrive later but the dispatch loop is not resumable from a half-state like this.
2. Deactivate run (M005+ pattern — records reason in registry for post-hoc audit):
   ```bash
   if [ -n "$RUN_ID" ]; then
     node "$FORGE_SCRIPTS_DIR/forge-runs.js" --update "$RUN_ID" --json '{"active":false}' > /dev/null
   else
     echo '{"active":false}' > .gsd/forge/auto-mode.json
   fi
   ```
3. Append one `blocked` event per affected task to `events.jsonl` with `reason: "parallel_dispatch_backgrounded"` and `batch_size: N`.
4. Leave STATE.md at its pre-batch position — when the user resumes via `/forge`, heartbeat-stale detection will pick up from there.
5. Surface a single user-facing message naming the skill file and step (e) as the violation point, and stop the loop.

This branch is a safety net, not a retry path. The right fix is to not background in step (e) — the CRITICAL block above covers that.

**g) Guarded dispatch for the batch** — wrap the whole N-way dispatch in the same try/catch semantics as the single path. Classification rules:
- If ANY single task throws transiently (`retry: true`): currently the simplest contract is to re-dispatch **only the failed task** with `attempt` incremented, while accepting the already-returned results for the others. The retry runs as its own single Agent() call immediately after — no need to re-batch.
- If ANY task throws permanently (classifier `retry: false`, or retries exhausted): apply the CRITICAL path — deactivate auto-mode, surface to user, stop loop. Other batch results are discarded (STATE still reflects the pre-batch position).
- Transient/retry events append to `events.jsonl` with `unit: "execute-task/T##"` (per-task, not per-batch).

**h) Output tokens + dispatch events** — once all results are back, emit one `dispatch` event per task (not one per batch), preserving the per-task tier/model/reason/effort fields. Effort resolves **per task** in batch mode exactly as tier does — each task gets its own `$EFFORT_T##`/`$EFFORT_REASON_T##` from the Effort Resolution algorithm (step 1.55) run against that task's `$MODEL_ID_T##`:
```bash
for each task in BATCH:
  OUTPUT_TOKENS_T##=$(node "$FORGE_SCRIPTS_DIR/forge-tokens.js" --inline "$result_T##")
  echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"dispatch\",\"unit\":\"execute-task/T##\",\"model\":\"$MODEL_ID_T##\",\"tier\":\"$TIER_T##\",\"reason\":\"$REASON_T##\",\"effort\":\"$EFFORT_T##\",\"effort_reason\":\"$EFFORT_REASON_T##\",\"input_tokens\":$INPUT_TOKENS_T##,\"output_tokens\":$OUTPUT_TOKENS_T##,\"batch_size\":${BATCH_LENGTH}}" >> .gsd/forge/events.jsonl
```

The extra `batch_size` field lets post-hoc analysis separate parallel from sequential dispatches without breaking S03 telemetry readers (which ignore unknown fields).

**i) Heartbeat — clear worker field** after all Agent() calls return (M005+ pattern):
```bash
_now=$(node -e "process.stdout.write(String(Date.now()))")
if [ -n "$RUN_ID" ]; then
  node "$FORGE_SCRIPTS_DIR/forge-runs.js" --update "$RUN_ID" --json "{\"worker\":null,\"worker_started\":null,\"last_heartbeat\":$_now,\"active\":true}" > /dev/null
else
  _sa=$(cat .gsd/forge/auto-mode-started.txt 2>/dev/null || node -e "process.stdout.write(String(Date.now()))")
  echo "{\"active\":true,\"started_at\":$_sa,\"last_heartbeat\":$_now,\"worker\":null}" > .gsd/forge/auto-mode.json
fi
```

**j) Process each result serially** — iterate `results` in order and for each, run the full Step 5 (Process result) + Step 6 (Post-unit housekeeping) pipeline. Specifically:
- For each `{taskId, result}`:
  - Parse `---GSD-WORKER-RESULT---` and `TaskUpdate` based on status.
  - Append events.jsonl (Step 6a).
  - Update STATE.md (Step 6b) — each task advance is independent; do not skip.
  - Append decisions (Step 6c).
  - Memory extraction (Step 6d) — dispatch `forge-memory` **in the background** so memory extraction doesn't block the next unit's dispatch.
  - Track progress (Step 6e) — `session_units += 1` per task completed.
- If any task returned `status: partial` or `status: blocked`, follow the existing partial/blocked handling (write `continue.md`, stop loop, etc.) — but AFTER processing all other `done` results so their work isn't lost.

**k) Re-enter the dispatch loop** — after all results are processed, loop back to step 1 (derive next unit). The next iteration will usually be another `execute-task` in the same slice (batch exhausted → possibly a new batch) or a `complete-slice` if this batch finished all tasks.

---

#### 5. Process result

**Update timeline task** — mark the current task based on outcome:
- `status: done` → `TaskUpdate({ taskId: current_task_id, status: "completed" })`
- `status: partial` or `status: blocked` → leave task as `in_progress` (shows it was interrupted)

Parse the `---GSD-WORKER-RESULT---` block:
- `status: done` → proceed to post-unit housekeeping, then **immediately continue loop** (do NOT pause or ask user)
- `status: partial` → write `continue.md`, update STATE, emit compact signal, **fire push (call-site 1):** use Push helper with message `"Forge {RUN_ID} travou — partial: {resumo do blocker}. Run pausado, requer ação manual."`, then **deactivate run NOW** (`node "$FORGE_SCRIPTS_DIR/forge-runs.js" --update "$RUN_ID" --json '{"active":false}'` — see `## Deactivate auto-mode indicator`), **stop loop**
- `status: blocked` → apply failure taxonomy before stopping; if no auto-recovery or recovery exhausted: **fire push (call-site 1):** use Push helper with message `"Forge {RUN_ID} travou — {classe do blocker}: {resumo}. Run pausado, requer ação manual."`, then **deactivate run NOW** (`node "$FORGE_SCRIPTS_DIR/forge-runs.js" --update "$RUN_ID" --json '{"active":false}'` — see `## Deactivate auto-mode indicator`), **stop loop**:

**Failure Taxonomy** (check `blocker` field in result, first match wins):

| Class | Signals | Auto-recovery |
|-------|---------|---------------|
| `context_overflow` | "context limit", "too long", "token" | Retry one tier up: `standard → heavy` (opus), `heavy → max` (fable). If already `max` → stop loop, surface to user. Apply the Fable 5 thinking guard when escalating to `max`. |
| `scope_exceeded` | "out of scope", "too broad", "multiple tasks" | Stop loop. Tell user: "Task scope too broad — ask forge-planner to split T## into smaller tasks." |
| `model_refusal` | "cannot", "I'm not able", "policy" | Retry once with a different model (sonnet ↔ opus). If fails again → stop loop, surface to user. |
| `tooling_failure` | "command not found", "permission denied", "ENOENT" | Stop loop. Tell user: "Tooling error — check that required tools are installed and accessible." |
| `external_dependency` | "API", "network", "not running", "connection refused" | Stop loop. Tell user: "External dependency unavailable — resolve and re-run /forge-auto." |
| `unknown` | anything else | Stop loop. Surface raw blocker to user. |

Auto-recovery attempts (context_overflow, model_refusal) count as units toward `COMPACT_AFTER`.

**Before any auto-recovery retry:** If the failed unit spawned a background task (visible via `TaskList` with `status: in_progress` and no owner), call `TaskStop({ task_id: <id> })` to terminate it cleanly before dispatching the retry.

**Node Repair gate (Layer 3 — disjoint from Layers 1 and 2):** Applies ONLY when `unit_type == execute-task`. Trigger: `status: done` AND `S##-VERIFICATION.md` rows show must_have drift (artifacts `substantive:false` / `wired:false`, test-quality flags) OR `status: partial` with must_haves unmet. `Agent()` throws → Layer 1. `status: blocked` → Layer 2. Do NOT overlap. See full spec: `shared/forge-dispatch.md § Node Repair`.

1. **Read prefs:**
   ```bash
   REPAIR_BUDGET=$(node -e "
   const fs=require('fs'),path=require('path'),os=require('os');
   const wd=process.env.WORKING_DIR||process.cwd();
   const files=[path.join(os.homedir(),'.claude','forge-agent-prefs.md'),
                path.join(wd,'.gsd','claude-agent-prefs.md'),
                path.join(wd,'.gsd','prefs.local.md')];
   let v=2;
   for(const f of files){try{const r=fs.readFileSync(f,'utf8');const m=r.match(/^repair:[ \t]*\n[ \t]+budget:[ \t]*(\d+)/m);if(m)v=parseInt(m[1]);}catch(e){}}
   process.stdout.write(String(v));
   " WORKING_DIR="$WORKING_DIR")
   ```

2. **Context-monitor suppression (S03 bridge):** read `$(node -e "require('os').tmpdir()")/forge-ctx-${SESSION_ID}.json`; if absent/unreadable → treat as non-CRITICAL. If `severity == "CRITICAL"` → suppress DECOMPOSE and PRUNE (force RETRY or blocked).

3. **Budget check (via helper — review S04 R9; NUNCA improvisar edit de YAML):**
   ```bash
   PLAN="$WORKING_DIR/.gsd/milestones/{M###}/slices/{S##}/tasks/{T##}/{T##}-PLAN.md"
   REPAIR_COUNT=$(node "$FORGE_SCRIPTS_DIR/forge-repair.js" --read-budget "$PLAN" | node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).repair_count))")
   if [ "$REPAIR_COUNT" -ge "$REPAIR_BUDGET" ]; then
     : # budget exhausted → fall through to blocked → human
   else
     # incrementa ANTES do dispatch (persiste em disco — sobrevive compaction); throw se frontmatter ausente
     REPAIR_COUNT_NEW=$(node "$FORGE_SCRIPTS_DIR/forge-repair.js" --increment-budget "$PLAN" | node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).repair_count))")
   fi
   ```

4. **Classify:**
   ```bash
   # is_large_task: derivado DETERMINISTICAMENTE do plano (review S04 R6) — frontmatter
   # large_task: true|false vence; senão heurística (>5 steps | >=3 artifacts | >250 linhas)
   IS_LARGE=$(node "$FORGE_SCRIPTS_DIR/forge-repair.js" --is-large-task "$PLAN" | node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).is_large_task))")
   # Demais campos: substituir '...' e os zeros pelos sinais REAIS — result block do worker
   # (failure_shape, worker_explained, must_haves_status), linhas do S##-VERIFICATION.md
   # (substantive_false, wired_false, missing_artifacts), S##-SYMBOL-CHECK.md (symbol_missing),
   # nível 4 do verifier (test_quality.{disabled,weak}) e severidade do context-monitor (severity).
   REPAIR_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-repair.js" --classify \
     "$(node -e "process.stdout.write(JSON.stringify({failure_shape:'...',severity:'...',worker_explained:'...',signals:{missing_artifacts:0,substantive_false:0,wired_false:0,symbol_missing:0,test_quality:{disabled:0,weak:0},is_large_task:process.argv[1]==='true'}}))" "$IS_LARGE")")
   ```
   Capture `{strategy, reason}` from output.

5. **Dispatch strategy** (per `shared/forge-dispatch.md § Node Repair`):
   - `retry` → re-dispatch same `forge-executor` with `## Verification Failures` + `## Repair Hint` (reason) injected. Liveness banner: duração estimada `execute-task`.
   - `decompose` → idempotency guard: if `T##.1-PLAN.md` exists → skip dispatch. Otherwise:
     > Antes de despachar o forge-planner em decompose mode, exiba o **Spawn Liveness Banner** (ver `shared/forge-dispatch.md § Spawn Liveness Banner`) — duração estimada `plan-slice`: ~2–4 min.
     ```
     Agent({ subagent_type: 'forge-planner', prompt: <plan-slice template>
       + "\n\nMODE: decompose\nTARGET_TASK: {T##}\n\n## Unmet Must-Haves\n{diff list}\n\n## Why it failed\n{result/SUMMARY excerpt}" })
     ```
     After return, re-derive next unit (sub-tasks `T##.1`, `T##.2` … now visible via `forge-parallelism.js` — regex extended in T03).
   - `prune` → write entry to `{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-CONTEXT.md § Decisions` (WORKING_DIR, not CODE_DIR) naming pruned requirement + rationale + task ID. In `forge-auto` with `review.ask_in_auto: defer`: **do NOT pause** — register and continue (AUTONOMY RULE).
   - `blocked` → fall through to existing `blocked → human` path.

6. **Append repair event:**
   ```bash
   echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"repair\",\"unit\":\"execute-task/{T##}\",\"milestone\":\"${RUN_ID:-{M###}}\",\"slice\":\"{S##}\",\"task\":\"{T##}\",\"strategy\":\"$REPAIR_STRATEGY\",\"repair_count\":$REPAIR_COUNT_NEW,\"reason\":\"$REPAIR_REASON\"}" >> "$WORKING_DIR/.gsd/milestones/{M###}/{M###}-events.jsonl"
   ```

#### 6. Post-unit housekeeping

**a) Append to per-milestone event log** — append one line to `{WORKING_DIR}/.gsd/milestones/{M###}/{M###}-events.jsonl` (M004+; create dir if missing):
```json
{"ts":"{ISO8601}","unit":"{unit_type}/{unit_id}","agent":"{agent_name}","milestone":"${RUN_ID:-{M###}}","status":"{done|blocked|partial}","summary":"{one-liner}"}
```
Each entry must be a single line. This is the orchestrator-side record; workers may also write their own entries to the SAME file. Append-only is atomic up to PIPE_BUF (~4KB POSIX / single-write NTFS) — event lines are <512B → safe without lockfile.

**Legacy:** if running pre-M004 (no `{M###}` resolved), append to `.gsd/forge/events.jsonl` global as before.

**b) Update per-milestone STATE** — advance to next unit position via `scripts/forge-state.js --update {M###} --json '{...}'`. The global `.gsd/STATE.md` dashboard is regenerated separately via `scripts/forge-dashboard.js` (called on boot/exit/phase-change per `multi_run.dashboard_refresh_on` pref).

**c) Append decisions** — if `key_decisions` in result, write to the fragment store via `forge-decisions.js --write` (stdin JSON):

<!-- pre-S03: this used to Edit/cat >> {M###}-DECISIONS.md or .gsd/DECISIONS.md directly -->

Partition rule:
- Milestone-bound task (T## inside a slice, `{M###}` is set) → `unit_id = {M###}`
- Loose `/forge-task` run (no milestone, `{task-id}` is set) → `unit_id = {task-id}`

```bash
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-decisions.js ] && echo scripts || echo "$HOME/.claude/scripts")
DECISIONS_UNIT_ID="${M###:-${task_id:-}}"
if [ -n "$DECISIONS_UNIT_ID" ]; then
  printf '%s' "$key_decisions_json" | node "$FORGE_SCRIPTS_DIR/forge-decisions.js" --write --cwd "$WORKING_DIR"
else
  echo "[forge-auto] WARNING: no unit_id for decisions — skipping fragment write" >&2
fi
```

Where `key_decisions_json` is a JSON object `{ "unit_id": "$DECISIONS_UNIT_ID", "decisions": [...] }` built from the `key_decisions` field of the worker result. The global `.gsd/DECISIONS.md` is rebuilt from fragments during `complete-milestone` (forge-merger, S05). Do NOT write directly to `.gsd/DECISIONS.md` or any `M###-DECISIONS.md` file.

**d) Memory extraction** — dispatch `forge-memory` agent **in the background** (`run_in_background: true`) so the orchestrator can immediately dispatch the next unit without waiting for memory extraction to finish. Rationale: memory extraction averages 20–40s, runs on Haiku (cheap + fast), and the extracted memories only affect the *next* selective injection — not the current dispatch decision. Running it in parallel with the next unit is the single highest-leverage parallelism win (one extraction per unit, every unit).

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

Pass `run_in_background: true` to the `Agent()` call. The orchestrator does NOT await this — it proceeds immediately to Step 6e. When the background agent finishes, AUTO-MEMORY.md is updated on disk and will be picked up by the next unit's selective injection filter. If the background agent fails silently, the loss is bounded to that one extraction — the next unit's extraction will still run and AUTO-MEMORY accumulates.

**e-reinject) Must-haves re-injection diff (scope_reduction)** — runs after memory extraction, before progress tracking. Applies to `execute-task` units only.

Read `scope_reduction.reinject` from prefs (3-file cascade, pattern identical to `plan_check.mode`; default `auto`). If `off` → skip this step (PRUNE still registers in CONTEXT — independently of this pref).

```bash
REINJECT_RESULT=$(node "$FORGE_SCRIPTS_DIR/forge-repair.js" --reinject-diff \
  --plan "$WORKING_DIR/.gsd/milestones/{M###}/slices/{S##}/tasks/{T##}/{T##}-PLAN.md" \
  --verification "$WORKING_DIR/.gsd/milestones/{M###}/slices/{S##}/{S##}-VERIFICATION.md" \
  --pruned "$PRUNED_IDS" \
  --must-haves-status "$MUST_HAVES_STATUS_JSON" 2>/dev/null || echo '{"dropped":[],"capped":false}')
```

Where `PRUNED_IDS` = comma-separated IDs from any PRUNE decisions made in this unit's repair routing (empty if none); `MUST_HAVES_STATUS_JSON` = `must_haves_status` field from the worker result (if present).

If `dropped.length > 0`: store for the **next unit of the same slice**. When building the next unit's worker prompt (Step 3 `## Build worker prompt`), append:

```markdown
## Requisitos pendentes re-injetados

Os seguintes requisitos planejados não foram entregues pela unidade anterior e permanecem em aberto:
{bullet list of dropped items}
{if capped: "⚠ Lista truncada em 10 itens — ver S##-VERIFICATION.md para lista completa."}
```

Also append this same section to `{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-SUMMARY.md` (create section if not present; append if exists). Items pruned via PRUNE are excluded from the diff (already registered in CONTEXT — do not re-inject).

**e) Track progress:**
```
session_units += 1
completed_units.append("✓ [M###/S##/T##] {unit_type} — {one-liner}  · {agent} ({model})")
```

#### 7. Pause + checkpoint check

After incrementing `session_units`:

**Maintenance gate check** — runs FIRST, before the rate-limit handoff and pause checks (a fired maintenance trigger halts before any more dispatch work happens, per `shared/forge-maintenance.md`). Resolve `MAINTENANCE_IN_AUTO` via the 3-file prefs cascade (same `node -e` pattern used for `plan_check.mode`/`symbol_check.mode`):

```bash
MAINTENANCE_IN_AUTO=$(node -e "
const fs=require('fs'),path=require('path'),os=require('os');
const wd=process.env.WORKING_DIR||process.cwd();
const files=[path.join(os.homedir(),'.claude','forge-agent-prefs.md'),
             path.join(wd,'.gsd','claude-agent-prefs.md'),
             path.join(wd,'.gsd','prefs.local.md')];
let mode='stop';
for(const f of files){try{const r=fs.readFileSync(f,'utf8');const m=r.match(/^maintenance:[ \t]*\n[ \t]+in_auto:[ \t]*(\w+)/m);if(m)mode=m[1].toLowerCase();}catch(e){}}
if(mode!=='stop'&&mode!=='defer'&&mode!=='off')mode='stop';
process.stdout.write(mode);
" WORKING_DIR="$WORKING_DIR")
```

- `MAINTENANCE_IN_AUTO == off` → skip this entire check — do not even run detection. Fall through to the Rate-limit handoff check.
- The gate only ever fires in repos that opted in: `detectMode` (called below) resolves `maintenance.enabled` (default `false`) via the same prefs cascade — a repo that never sets `maintenance.enabled: true` always gets `mode: "normal"` back, so `forge-auto` never STOPs for it regardless of `MAINTENANCE_IN_AUTO`.
- **`mode` is fired-axis-driven, not baseline-driven** (S05-M2 review fix): `detectMode` returns `mode: "maintenance"` **only** when a count-trigger actually fired (`firedAxes.length > 0`). A `baseline.available: true` result with no fired axis is `mode: "normal"` — it must NEVER halt `forge-auto` on its own; it is informational only (per the AUTONOMY RULE).
- Otherwise, run detection (`shared/forge-maintenance.md § Step 1`):
  ```bash
  DETECT=$(node "$FORGE_SCRIPTS_DIR/forge-maintenance-gate.js" --detect --cwd "$WORKING_DIR")
  MAINT_MODE=$(echo "$DETECT" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).mode)")
  BASELINE_AVAILABLE=$(echo "$DETECT" | node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).baseline.available))")
  ```
  - `MAINT_MODE == normal` → append the `maintenance-detected` event to `events.jsonl` (`{"ts":"<ISO>","event":"maintenance-detected","mode":"normal","fired":[],"baseline":<BASELINE_AVAILABLE>}`) — per `shared/forge-maintenance.md § Step 1`, detection ran and must be audited regardless of which branch fires. If `BASELINE_AVAILABLE == true`, print a single calm, non-blocking one-liner (e.g. `ℹ baseline disponível — rode /forge-sweep manualmente para consolidar`) — **do not** ask, do not halt, do not go to the Maintenance Gate Procedure. Then fall through to the Rate-limit handoff check.
  - `MAINT_MODE == maintenance` AND `MAINTENANCE_IN_AUTO == stop` → go to `## Maintenance Gate Procedure` (stop path). Do NOT continue to the next unit — the loop halts here.
  - `MAINT_MODE == maintenance` AND `MAINTENANCE_IN_AUTO == defer` → go to `## Maintenance Gate Procedure` (defer path), then fall through to the Rate-limit handoff check. Never block on missing input or a 429 — this is the headless-friendly path (`bin/forge-run`).

**NEVER apply maintenance inline here.** The ISOLATION RULE forbids the orchestrator from mutating project files directly — the apply cascade (Steps 3–5 of `shared/forge-maintenance.md`) runs only inside `/forge-sweep` or an interactive `forge-next` session. This gate only detects, announces, and (on `stop`) halts the loop; it never dispatches the confirm/apply steps itself. **This STOP is the sanctioned AUTONOMY-RULE exception** — same posture as the milestone review-triage gate and the account-handoff stop below: maintenance is destructive-ish (consolidates and prunes loose finalized units, `.bak`-protected and verified) and inherently needs a human in the loop, so halting here does not violate the AUTONOMY RULE that otherwise forbids `forge-auto` from pausing mid-loop for confirmation.

**Rate-limit handoff check** — runs BEFORE the pause check. Detects when this account's usage window is exhausted and hands off to another account (account exhaustion is more urgent than a queued pause). Gated by prefs: resolve `HANDOFF_IN_AUTO` (`accounts.handoff_in_auto`, default `on`) and `HANDOFF_THRESHOLD` (`accounts.handoff_threshold`, default `90`). If `HANDOFF_IN_AUTO == off`, skip this entire check.

Read the freshest rate-limit bridge the statusline wrote (most-recently-modified `forge-ratelimit-*.json` in the tmpdir, within 120s — that is this session's; the orchestrator's own statusline renders continuously while the loop runs):

```bash
node -e '
const fs=require("fs"),os=require("os"),path=require("path");
const dir=os.tmpdir(); let best=null;
try { for (const f of fs.readdirSync(dir)) {
  if(!/^forge-ratelimit-.*\.json$/.test(f))continue;
  const p=path.join(dir,f),st=fs.statSync(p);
  if(Date.now()-st.mtimeMs>120000)continue;
  if(!best||st.mtimeMs>best.m)best={m:st.mtimeMs,p};
}} catch{}
if(!best){console.log(JSON.stringify({available:false}));process.exit(0);}
let rl={};try{rl=JSON.parse(fs.readFileSync(best.p,"utf8"));}catch{}
const wins=[["5h",rl.five_hour],["7d",rl.seven_day]].filter(([,w])=>w&&typeof w.used_percentage==="number");
if(!wins.length){console.log(JSON.stringify({available:false}));process.exit(0);}
wins.sort((a,b)=>b[1].used_percentage-a[1].used_percentage);
const [label,w]=wins[0];
console.log(JSON.stringify({available:true,window:label,used:Math.round(w.used_percentage),resets_at:w.resets_at||null,account:rl.account||null}));
'
```

- If `available == false` → no usage data (API-key user, or statusline never rendered rate_limits). Skip — fall through to the Pause check.
- If `available == true` AND `used >= HANDOFF_THRESHOLD` → **trigger the handoff**: go to `## Account Handoff Procedure`, passing `{window, used, resets_at, account}`. That procedure checkpoints, deactivates this run, emits the relaunch instructions, fires a push, and **stops the loop**. Do NOT continue to the next unit.
- Otherwise → fall through to the Pause check.

**Pause check** — multi-run-aware (M004). Checks the run-scoped pause file first, then the legacy global pause file (for compat):

```bash
# M004 scoped: .gsd/forge/pause-{RUN_ID} where RUN_ID is this orchestrator's run id (e.g. M065)
PAUSE_SCOPED=".gsd/forge/pause-${RUN_ID}"
PAUSE_LEGACY=".gsd/forge/pause"

if [ -f "$PAUSE_SCOPED" ] || [ -f "$PAUSE_LEGACY" ]; then
  rm -f "$PAUSE_SCOPED" "$PAUSE_LEGACY"
  # Deactivate THIS run only — never touches other runs' state
  node "$FORGE_SCRIPTS_DIR/forge-runs.js" --update "$RUN_ID" --json '{"active":false}' >/dev/null 2>&1 || \
    echo '{"active":false}' > .gsd/forge/auto-mode.json   # legacy fallback
fi
```

`RUN_ID` was set during activation (see Step "Activate auto-mode indicator" above; multi-run version sets `RUN_ID=$ARGUMENTS` or derives from STATE.md when called with no args + single-run workspace).

Emit and **stop loop**:
```
⏸  Auto-mode pausado após {session_units} unidades.
{completed_units list, one per line}

Execute /forge-auto {RUN_ID} para retomar a partir de: {next_action from STATE.md}
```

**Context checkpoint** (only fires if the user explicitly set `compact_after` in prefs AND `session_units >= COMPACT_AFTER`):
- Append to events.jsonl: `{"ts":"{ISO8601}","unit":"checkpoint","agent":"orchestrator","milestone":"${RUN_ID:-{M###}}","status":"checkpoint","summary":"{session_units} unidades concluídas"}`
- Reset counters: `session_units = 0`, `completed_units = []`
- **Continue the loop immediately** — do NOT stop.

---

## Deactivate auto-mode indicator

Before ANY exit (final report, blocked, partial, or pause), deactivate the marker (M005+ pattern):
```bash
if [ -n "$RUN_ID" ]; then
  node "$FORGE_SCRIPTS_DIR/forge-runs.js" --update "$RUN_ID" --json '{"active":false}' > /dev/null
  node "$FORGE_SCRIPTS_DIR/forge-dashboard.js" --cwd "$WORKING_DIR" > /dev/null || true
else
  echo '{"active":false}' > .gsd/forge/auto-mode.json
fi
```

---

## Maintenance Gate Procedure

Invoked from Step 7 when `MAINT_MODE == maintenance`. Full spec: `shared/forge-maintenance.md` — this procedure only wires the STOP/defer postures documented there (Rules 2–4); it does not re-implement detection, the RED warning renderer, or the apply cascade.

**Stop path** (`maintenance.in_auto: stop`, the default — `shared/forge-maintenance.md § Rules (LOCKED) #2`):
1. Render the announce (Step 1) and the RED warning (Step 2) from `shared/forge-maintenance.md`, verbatim via `renderRedWarning(detection)` — do not summarize or truncate it.
2. Print the cascade instructions: "Rode `/forge-sweep` ou `/forge-next` para conduzir a maintenance com o double-confirm por eixo."
3. Deactivate this run — see `## Deactivate auto-mode indicator` above (same pattern as pause/handoff: `forge-runs.js --update "$RUN_ID" --json '{"active":false}'`, legacy fallback `echo '{"active":false}' > .gsd/forge/auto-mode.json`).
4. Append the `maintenance-detected` event to `events.jsonl` per `shared/forge-maintenance.md § Step 8` (`{"ts":"<ISO>","event":"maintenance-detected","mode":"maintenance","fired":[...],"baseline":<bool>}`).
5. Emit and **STOP the loop**:
   ```
   ⏸  Auto-mode parado — maintenance pendente (SWEEP PRECISA DE MAINTENANCE).
   {firedAxes summary, one line per axis}

   Rode /forge-sweep ou /forge-next para consolidar. Depois execute /forge-auto {RUN_ID} para retomar.
   ```
   Do not proceed to the next unit.

**Defer path** (`maintenance.in_auto: defer` — `shared/forge-maintenance.md § Rules (LOCKED) #3`, mirrors `bin/forge-run`'s own posture and the account-handoff sentinel pattern):
1. Render the announce (Step 1) only — no RED warning needed for a non-blocking defer.
2. Write `.gsd/forge/maintenance-request.json`: `{"run_id":"{RUN_ID}","fired":<firedAxes>,"baseline":<bool>,"ts":"{ISO8601}"}` so a supervisor (`bin/forge-run`) or the next interactive session picks it up and surfaces it. Harmless without a supervisor — a plain `/forge-auto` just leaves the file, overwritten on the next detection.
3. Append the `maintenance-detected` event to `events.jsonl` with an added `"deferred":true` field.
4. **Continue the loop** — do not stop, do not block on the missing human input or a 429. This is the headless-friendly path used by `bin/forge-run`.

**Idempotency:** if a STOP was already surfaced for this boundary and the same fired state persists across an interrupted/resumed run, re-detecting is fine — it just re-surfaces the same warning. The gate never loop-applies maintenance itself in either path.

---

## Account Handoff Procedure

Invoked from Step 7 when the active account's tightest usage window crossed `HANDOFF_THRESHOLD`. Inputs: `{window, used, resets_at, account}` (account = this session's `FORGE_ACCOUNT`, or null for the default Keychain login). **This is a sanctioned stop** — account exhaustion is a hard external limit, not an AUTONOMY-RULE violation. The handoff is always a *relaunch* (a running session cannot switch its own account); on-disk state makes `/forge-auto` resume seamlessly.

**1. Checkpoint.** Write `continue.md` for the active slice per `## Continue-Here Protocol` (so the next session resumes exactly here). Append an events.jsonl line:
`{"ts":"{ISO8601}","unit":"account-handoff","agent":"orchestrator","milestone":"${RUN_ID:-{M###}}","status":"handoff","summary":"janela {window} em {used}% — checkpoint + troca de conta"}`

**1b. Supervisor sentinel.** Write `.gsd/forge/handoff-request.json` so the `forge-run` supervisor (if one is driving this headless session) switches accounts and resumes automatically: `{"run_id":"{RUN_ID}","account":"{account}","window":"{window}","used":{used},"resets_at":{resets_at|null},"ts":"{ISO8601}"}`. Harmless without a supervisor — a plain `/forge-auto` just leaves the file (cleared on the next supervised run). The supervisor consumes and deletes it.

**2. Resolve the next account.** List registered accounts and pick a candidate with a token that is NOT the current one:

```bash
node "$FORGE_SCRIPTS_DIR/forge-accounts.js" --list --json
```

From the JSON, candidates = accounts where `has_token == true` AND `name != {account}` (when `{account}` is null, every token-bearing account qualifies). Prefer one with the most `days_left` if several. The switch command for the chosen `NEXT` is simply `forge-accounts use {NEXT}` (in a terminal it launches claude on that account directly).

**3. Deactivate this run** — see `## Deactivate auto-mode indicator` (deactivate `$RUN_ID` only; never touches other runs). This is what stops the loop; the marker staying recoverable lets the relaunched session resume.

**4. Emit the handoff message and STOP the loop.**

If a `NEXT` candidate exists:
```
⚠  Conta esgotada — janela {window} em {used}%. Checkpoint salvo.
   Milestone {RUN_ID} pausado em: {next_action from STATE.md}

   Para continuar na conta '{NEXT}', rode no seu terminal:
     forge-accounts use {NEXT}     ← abre o Claude Code nessa conta
   Depois: /forge-auto {RUN_ID}    ← retoma do checkpoint automaticamente
```

If NO alternative account is registered:
```
⚠  Conta esgotada — janela {window} em {used}%. Checkpoint salvo.
   Milestone {RUN_ID} pausado em: {next_action from STATE.md}

   Nenhuma conta alternativa registrada. Registre uma e retome:
     forge-accounts add <nome>      (no terminal; precisa de `claude setup-token`)
     forge-accounts use <nome>      → abre o Claude Code nessa conta
   Depois: /forge-auto {RUN_ID}
```

**5. Fire push** (reuse the Push helper): message `"Forge {RUN_ID} — conta esgotada (janela {window} {used}%). Checkpoint salvo; troque de conta para retomar."`

**Secondary trigger (429 on dispatch):** if `Agent()` fails with a usage-limit / quota-exhaustion error (not a transient network/stream error — those go through the Retry Handler), route here instead of the generic CRITICAL stop: run this same procedure with `{window: "5h", used: 100, resets_at: null, account}` (best-effort, since the bridge may lag the real 429). Everything else is identical.

---

## Final Report (milestone complete)

**Isolation cleanup** — runs ONLY here (milestone complete), never on pause/blocked/partial exits (the branch/worktree must survive for resume). No-op when `ISOLATION_MODE == shared`. In `branch` mode it checks the repo back out to the default branch (the `forge/{run}` branch is kept for PR/merge by the operator). In `worktree` mode it removes the worktree only if `worktree_cleanup_on_complete: true` in prefs:

```bash
node "$FORGE_SCRIPTS_DIR/forge-isolation.js" --cleanup --run "${RUN_ID:-<active milestone ID>}" --cwd "$WORKING_DIR" || true
```

If the cleanup output contains `status: "error"` entries, surface them in the final report (advisory — do not fail the milestone).

```
✓ Milestone {M###} completo

Slices entregues:
| Slice | Título | Tasks |
|-------|--------|-------|
| S01   | ...    | 3     |

⚖ Review — digest da milestone:
| Slice | Objeções | Corrigidas (concedidas) | Triadas | Follow-ups |
|-------|----------|-------------------------|---------|------------|
| S01   | 5        | 2                       | 1       | 0          |
{follow-up lines, if any: "R# path:line — <objeção>" → .gsd/KNOWLEDGE.md § Review follow-ups}

Próximo milestone: /forge-new-milestone <descrição>
```

The review digest is built from the `review` / `review-triage` events in `events.jsonl` (fallback: scan the `**Outcome:**` lines of each `{S##}-REVIEW.md`). Omit the section entirely when the milestone had zero objections.

**Fire push (call-site 3):** After printing the Final Report above, use Push helper with message `"Forge {RUN_ID} — milestone completa. {N} slices entregues."` (N = count of slices in the report table).

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
