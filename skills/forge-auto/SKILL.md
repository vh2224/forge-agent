---
name: forge-auto
description: "Executa o milestone inteiro de forma autonoma ate concluir."
allowed-tools: Read, Write, Edit, Bash, Agent, Skill, TaskCreate, TaskUpdate, TaskList, TaskStop, SendMessage, WebSearch, WebFetch
---

## Provider-neutral loop authority (S07)

Read `shared/forge-lifecycle.md` before entering the unit loop. Resolve the
current host explicitly as `claude|codex`, then call
`scripts/forge-long-workflow-adapter.js` with `--mode auto`. Preserve the
returned `snapshot` across iterations/compaction; it is the loop identity.

The adapter action is authoritative: `dispatch` permits the existing body below
to execute only the selected unit; `pause` persists/yields at its boundary;
`continue` requests the next iteration; `stop` ends. The prose below may render
prompts and invoke the selected host, but it must not re-select a unit, acquire a
second lease, invent a boundary, or change host. Only an explicit `resume` with
the durable boundary may change `host_runtime`. This adapter never spawns or
implements fallback; dispatch remains the S06 boundary.

## Bootstrap guard

```bash
ls CLAUDE.md 2>/dev/null && echo "ok" || echo "missing"
ls .gsd/STATE.md 2>/dev/null && echo "ok" || echo "missing"
WORKING_DIR=$(pwd)
echo "WORKING_DIR=$WORKING_DIR"

# Resolve runtime scripts dir — prefer local ./scripts (dogfood: edits take effect
# immediately); fall back to ${FORGE_HOME:-$HOME/.forge-agent}/scripts (user-land: installed version).
if [ -f "scripts/forge-parallelism.js" ]; then
  FORGE_SCRIPTS_DIR="scripts"
else
  FORGE_SCRIPTS_DIR="${FORGE_HOME:-$HOME/.forge-agent}/scripts"
fi
echo "FORGE_SCRIPTS_DIR=$FORGE_SCRIPTS_DIR"

# Same resolution for the shared reference specs. The installer COPIES shared/*.md
# into ${FORGE_HOME:-$HOME/.forge-agent}/shared/, so a bare relative `shared/X.md`
# resolves only inside the forge-agent repo itself — in every consumer project it is
# a dead path. Without this, following a spec is a per-session guess.
if [ -f "shared/forge-review.md" ]; then
  FORGE_SHARED_DIR="shared"
else
  FORGE_SHARED_DIR="${FORGE_HOME:-$HOME/.forge-agent}/shared"
fi
echo "FORGE_SHARED_DIR=$FORGE_SHARED_DIR"
```

**Path convention — binding for the whole skill.** Every reference below written as
`shared/<name>.md` MUST be read from `$FORGE_SHARED_DIR/<name>.md`. `shared/` in prose is
the canonical *name* of the spec, never a literal path to open. A spec you could not open
is a hard stop for the step that needs it — never a cue to improvise the procedure from
memory. Same rule for `scripts/<name>.js` → `$FORGE_SCRIPTS_DIR/<name>.js`.

**Se CLAUDE.md não existe:** Stop. Tell the user:
> Projeto não inicializado. Execute `/forge-init` primeiro — isso cria o `CLAUDE.md` que restaura o contexto automaticamente ao reabrir o chat.

**Se .gsd/STATE.md não existe:** Stop. Tell the user:
> Nenhum projeto GSD encontrado neste diretório. Execute `/forge-init` para começar.

---

## Load context

Read ONLY these files:
1. `.gsd/STATE.md`
2. `.gsd/AUTO-MEMORY.md` full file (skip silently if missing) — stored as `ALL_MEMORIES` for selective injection per unit
3. `.gsd/CODING-STANDARDS.md` (skip silently if missing)

**Resolve PREFS via the canonical engine CLI (ONE call — never a 3-file md merge in-context).** The S01 engine (`scripts/forge-prefs.js`) reads the jsonc catalog per layer; legacy Markdown without jsonc hard-stops — see `shared/forge-prefs-cutover.md`. It applies the exact same user-global → repo-shared → local-personal precedence (last wins) that the old inline prose described. Do NOT read/merge `~/.claude/forge-agent-prefs.jsonc` + `.gsd/claude-agent-prefs.jsonc` + `.gsd/prefs.local.jsonc` by hand — that is exactly what the CLI does. See `shared/forge-dispatch.md § Per-unit prefs resolution` for the canonical helper.

```bash
PREFS_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-prefs.js" --resolved --explain --cwd "$WORKING_DIR")
PREFS_EXIT=$?
```

**Loud-stop on parse error (M008-CONTEXT decision #2 — the loop ALWAYS stops on a broken config, NEVER degrades to defaults silently):**
```
If PREFS_EXIT != 0:
  - `$PREFS_JSON` carries `errors[]` ({file,line,message}) on stdout; the CLI already printed a
    human message + "corrija o JSONC…" hint on stderr.
  - Deactivate this run (same mechanic as the Agent()-failure halt): set auto-mode.json/runs entry
    inactive, then STOP the loop.
  - Surface to the operator: arquivo + linha + como-corrigir (from errors[]).
  - When any `errors[]` entry has `code == "legacy-md-without-jsonc"`, re-emit that entry's
    `errors[].message` VERBATIM, without paraphrasing. Use `shared/forge-prefs-cutover.md § Canonical message`
    as the message contract; STOP without retry or handoff loops (headless-safe).
  - Do NOT proceed on WORKERS_ENGINE=claude / effort defaults / any fallback value.
```
`warnings[]` (advisory schema validation, `⚠` on stderr) do NOT stop — only exit≠0 halts.

The resolved object is `{ok, prefs, errors[], warnings[], layers}`. Throughout this skill **`PREFS` = `.prefs`** from this one call. Store as: `STATE`, `PREFS` (the resolved `.prefs` object), `ALL_MEMORIES`, `CODING_STANDARDS`.

**Extract effort & thinking off the resolved `PREFS` object (defaults identical to the old inline snippet):**
- `EFFORT_MAP` ← `PREFS.effort` (per-phase effort table; default: opus/planning phases = `medium`, sonnet/haiku phases = `low`)
- `THINKING_OPUS` ← `PREFS.thinking.opus_phases` (default: `adaptive`)

**CODING_STANDARDS section extraction** — to minimize token usage, extract these named sections from the file for selective injection:
- `CS_LINT` — content of `## Lint & Format Commands` section only
- `CS_STRUCTURE` — content of `## Directory Conventions` + `## Asset Map` + `## Pattern Catalog` sections
- `CS_RULES` — content of `## Code Rules` section only
If CODING-STANDARDS.md is missing, all section variables are `"(none)"`.

**Extract notifications pref off the resolved `PREFS` object:**
- `NOTIFICATIONS_ON` ← `PREFS.notifications`; if absent or not `on`/`off`, default `on`. Store as `NOTIFICATIONS_ON`.

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
# RUN_BRANCH — the branch this run OWNS, read back from what the setup actually
# did, never re-derived by concatenating `forge/` with the run id. Re-deriving a
# naming convention is the exact defect S04 removed from `deriveWorktreePath`:
# the moment `branch_pattern` differs from the default, or a repo failed and was
# never checked out, a derived string names a branch that does not exist.
# Reachable cases, all three real:
#   branch/worktree mode, ≥1 repo ok → that repo's `branch` (all repos of a run
#                                      share one branch name — `resolveBranchName`
#                                      is called once per setup)
#   shared mode                      → `repos: []` by construction (setupForRun
#                                      returns early) → empty → recorded as null
#   every repo errored               → no `status!=='error'` row → empty → null,
#                                      and the ISO_ERRORS rule below already stops
RUN_BRANCH=$(node -e "const r=JSON.parse(process.argv[1]);const b=(r.repos||[]).find(x=>x.branch&&x.status!=='error');process.stdout.write((b&&b.branch)||r.branch||'')" "$ISO_RESULT")
ISO_ERRORS=$(node -e "const r=JSON.parse(process.argv[1]);process.stdout.write((r.repos||[]).filter(x=>x.status==='error').map(x=>x.path+': '+x.error).join('; '))" "$ISO_RESULT")
ELEVATED=$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).elevated||false))" "$ISO_RESULT")
ELEV_REASON=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).elevation_reason||'')" "$ISO_RESULT")
WORKTREES_JSON=$(node -e "const r=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify((r.repos||[]).filter(x=>x.worktree&&x.status!=='error').map(x=>({repo:x.path,path:x.worktree}))))" "$ISO_RESULT")
echo "ISOLATION_MODE=$ISOLATION_MODE"
echo "WORKTREE_DIR=${WORKTREE_DIR:-—}"
echo "ISO_ERRORS=${ISO_ERRORS:-none}"
[ "$ELEVATED" = "true" ] && echo "⚠ require_worktree: elevado a worktree ($ELEV_REASON) → CODE_DIR=${WORKTREE_DIR:-?}"
```

Isolation rules (CRITICAL — the operator configured this; honor it):
- `ISOLATION_MODE == shared` → `WORKER_CWD = $WORKING_DIR`. Nothing else to do.
- `ISOLATION_MODE == branch` → `WORKER_CWD = $WORKING_DIR`. Workers commit on the `forge/{run}` branch the setup just checked out.
- `ISOLATION_MODE == worktree` → `WORKER_CWD = $WORKTREE_DIR` (bootstrap value). **In a multi-repo workspace `WORKER_CWD`/`CODE_DIR` does NOT come from this bootstrap value**: once `$PLAN_PATH` exists, the per-unit resolver (`forge-code-dir.js`, § Per-unit `CODE_DIR` resolution) attributes the unit's declared paths to ONE repo — when it returns `ok`, `WORKER_CWD = $UNIT_CODE_DIR`; on any refusal (`cross-repo`/`undeclared`) `WORKER_CWD` stays `$WORKTREE_DIR`, exactly today's behavior. ALL code reads/writes/commits happen inside the worktree; `.gsd/**` artifacts ALWAYS stay under `$WORKING_DIR` (the original workspace — registry, statusline and other tabs depend on it).
- If `ISO_ERRORS` is non-empty AND every repo failed (`WORKTREE_DIR` empty in worktree mode, or no repo succeeded in branch mode) → STOP. Surface the errors to the user. Running un-isolated when the operator explicitly configured isolation is NOT an acceptable fallback.
- If only some repos failed → emit a warning line listing them and continue.
- When `ISOLATION_MODE != shared`, emit one line so the operator sees isolation took effect: `⛓ Isolation: {mode} → {branch name or worktree path}`.
- `workers.require_worktree` elevation is **static-at-activation** — resolved once by `--setup`, never mid-run. `auto` (default) elevates `shared → worktree` only when `execute-task` resolves to an external write engine (`codex`/gpt/gemini); `true` always elevates; `false` never elevates (byte-identical to prior behavior). Read-only paths (Branch D `plan-slice`, review challenger) are exempt — only `execute-task` triggers detection. Elevation is warn-and-proceed (never blocks); a false-positive elevation is acceptable, a false-negative is not. To keep `shared` regardless, set `workers.require_worktree: false`.

Branch on `$STATUS`:

- **`refuse`** — emit `$MSG` (lists active runs + example commands) and stop. Do NOT continue.
- **`error`** — emit `$MSG` and stop.
- **`legacy`** — zero active runs + no arg + .gsd/STATE.md is single-run legacy format. Run the legacy activation block below (preserves pre-M004 behavior). RUN_ID stays empty; `{M###}` placeholders below resolve from STATE.md as before.
- **`activate-new`** — register the new run:
  ```bash
  SESSION_ID="${CLAUDE_SESSION_ID:-$(node -e "process.stdout.write(require('crypto').randomBytes(8).toString('hex'))")}"
  node "$FORGE_SCRIPTS_DIR/forge-runs.js" --add --id "$RUN_ID" --kind "$RUN_KIND" --session "$SESSION_ID" --isolation-mode "$ISOLATION_MODE" --account "${FORGE_ACCOUNT:-}" --worktrees "$WORKTREES_JSON" --branch "${RUN_BRANCH:-}" --cwd "$WORKING_DIR" > /dev/null
  echo "$MSG"
  ```
  Then continue to legacy activation (which writes auto-mode-started.txt + alias).
- **`resume`** — emit `$MSG`, set `RUN_ID` (already set). Update the existing registry entry with the new session_id (the previous orchestrator process exited; this is a fresh session that needs to own heartbeat updates) and the freshly-resolved isolation mode:
  ```bash
  SESSION_ID="${CLAUDE_SESSION_ID:-$(node -e "process.stdout.write(require('crypto').randomBytes(8).toString('hex'))")}"
  node "$FORGE_SCRIPTS_DIR/forge-runs.js" --update "$RUN_ID" --json "{\"session_id\":\"$SESSION_ID\",\"active\":true,\"isolation_mode\":\"$ISOLATION_MODE\",\"worktrees\":$WORKTREES_JSON,\"branch\":\"$RUN_BRANCH\"}" > /dev/null
  ```
  `branch` is refreshed here for the same reason `isolation_mode` is: it is what the
  setup just resolved, and a record created before the field existed carries `null`.
  Re-recording it on resume heals those without a migration pass. In `shared` mode
  `$RUN_BRANCH` is empty and the field is written on disk as `""` (this interpolation
  bypasses `add()`'s `|| null`) — `forge-runs.js`'s `withAddressDefaults` normalizes
  `''` to `null` on every read (`get()`/`listAll()`), so it is read back as "no
  branch", never as a fabricated `forge/{id}` and never as Swift's `.some("")`.
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
2. Re-read all context files: `.gsd/STATE.md`, `.gsd/AUTO-MEMORY.md`, `.gsd/CODING-STANDARDS.md`; re-resolve PREFS via the single `node "$FORGE_SCRIPTS_DIR/forge-prefs.js" --resolved --cwd "$WORKING_DIR"` call (NOT a 3-file md re-merge) — same loud-stop-on-exit≠0 posture as Load context
3. Re-initialize all state variables: `PREFS` = `.prefs` from that call, extract EFFORT_MAP and THINKING_OPUS, set `session_units = 0`, re-extract CS sections
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
   - Per-run state `.gsd/milestones/{M###}/{M###}-STATE.md` (never the root `.gsd/STATE.md`, which is a generated dashboard) → update `STATE`
   - `PREFS` ← re-resolve via the single `node "$FORGE_SCRIPTS_DIR/forge-prefs.js" --resolved --cwd "$WORKING_DIR"` call (`.prefs`; same loud-stop-on-exit≠0 posture) — NOT a 3-file md re-merge
   - `.gsd/AUTO-MEMORY.md` → update `ALL_MEMORIES`
   - `.gsd/CODING-STANDARDS.md` → re-extract `CS_LINT`, `CS_STRUCTURE`, `CS_RULES`
2. Re-derive `EFFORT_MAP` and `THINKING_OPUS` from the resolved PREFS object
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

**Engine, tier, domain, effort and alias are all resolved in step 1.5 below** by the single `forge-dispatch-resolve.js --json` call. Do NOT resolve any of them here — this block only runs the prefs loud-stop gate and computes the resolver's *file* args (`$PLAN_PATH`, `$ROADMAP_PATH`).

**Prefs gate + resolver args (step 1.45)** — run the M008-CONTEXT #2 prefs loud-stop gate, then set `$PLAN_PATH`/`$ROADMAP_PATH`. As of M012 S02 the **engine decision, tier-chain resolution, domain, effort and alias all collapse into ONE `forge-dispatch-resolve.js` call** made in step 1.5 (a thin caller) — so this block resolves only the *file* inputs to that call. When `ENGINE` resolves to `codex` (routable `execute-task`/`plan-slice`) the Claude `Agent()` dispatch + alias warning are **skipped** (Codex resolves its own model) — they run only on the Claude path, including the fallback.
> Cross-reference: `shared/forge-dispatch.md § Worker Engine Routing` — canonical algorithm (single-call resolver, engine-by-route_source table, sidecar state machine, BLOCKER contract, fallback) + `scripts/forge-dispatch-resolve.js` (S01). This block is the executable mirror; the mechanics are locked there. `plan-slice` engine routing is **active (S03)** — `DISPATCH_ENGINE == codex && unit_type == plan-slice` routes to the sidecar `--mode plan` (read-only, **Branch D**, see Step 4 below). `plan-milestone` is never routed through `workers:`/`routing:` (stays tier `max`/Fable).

```bash
# ── Prefs loud-stop gate (M008-CONTEXT #2) — MUST run before the resolver ─────────
# Canonical per-unit prefs resolution — ONE forge-prefs.js --resolved call (reads the jsonc
# catalog per layer; legacy Markdown without jsonc hard-stops — see shared/forge-prefs-cutover.md;
# NEVER a 3-file `files=[…forge-agent-prefs.jsonc…]` cascade node -e merge, MEM001 M005).
# This explicit gate STAYS even though forge-dispatch-resolve.js also surfaces prefs errors
# (prefs_ok:false → exit 1): a malformed prefs layer must HALT the dispatch, never degrade to a
# fallback value. See shared/forge-dispatch.md § Per-unit prefs resolution.
PREFS_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-prefs.js" --resolved --cwd "$WORKING_DIR")
if [ $? -ne 0 ]; then
  # Loud stop (M008-CONTEXT #2): errors[] ({file,line,message}) on stdout, human hint on stderr.
  # Deactivate the run (same mechanic as the Agent()-failure halt) + surface arquivo+linha+
  # como-corrigir. NEVER degrade to a fallback value on a broken config.
  echo "✗ prefs parse error — dispatch halted (see stderr for arquivo:linha)" >&2
  exit 1
fi
# CRITICAL loud-stop (M008-CONTEXT #2): a nonzero prefs-CLI exit above HALTS the
# dispatch — the `exit 1` fires when this block runs in a shell. In the
# orchestrator loop, mirror the Load-context guard: deactivate this run
# (set auto-mode.json/runs entry inactive, same mechanic as the Agent()-failure
# halt), surface arquivo+linha+como-corrigir from `errors[]`, then STOP the loop.
# Do NOT proceed on a claude/effort-default / any fallback value.

# Resolve ONLY the args the shared resolver needs. No engine/domain/worker/tier/effort parsing
# happens here anymore — forge-dispatch-resolve.js (step 1.5) owns ALL pure resolution and reads
# the PLAN frontmatter + ROADMAP itself. See shared/forge-dispatch.md § Worker Engine Routing.
PLAN_PATH=""
if [ "$unit_type" = "execute-task" ]; then
  PLAN_PATH=".gsd/milestones/${M###}/slices/${S##}/tasks/${T##}/${T##}-PLAN.md"
fi
ROADMAP_PATH=".gsd/milestones/${M###}/${M###}-ROADMAP.md"
# ENGINE / DOMAIN_USED / WORKERS_TIMEOUT / CODEX_MODEL are all resolved by the single
# forge-dispatch-resolve.js call in step 1.5 below (engine-by-route_source decided inside it).
```

**Loud-stop on the per-unit prefs re-resolution above (M008-CONTEXT #2 — NOT a bare comment):** if the `forge-prefs.js --resolved` call at the top of this block exited non-zero, the orchestrator MUST STOP the loop now — exactly as the Load-context guard does: deactivate this run (set `auto-mode.json`/runs entry inactive, same mechanic as the `Agent()`-failure halt), surface arquivo + linha + como-corrigir from `errors[]`, and do **NOT** proceed on `WORKERS_ENGINE=claude` / effort defaults / any fallback value. The `exit 1` inside the guard halts a shell-executed path; this prose halts the orchestrator-interpreted path. `warnings[]` (advisory) never stop — only exit≠0 halts.

`$PLAN_PATH`, `$ROADMAP_PATH` are now set — the *file* inputs the shared resolver reads. `ENGINE`, `$DOMAIN_USED`, `$WORKERS_TIMEOUT`, `$CODEX_MODEL` are resolved **inside** the single `forge-dispatch-resolve.js` call (step 1.5, engine-by-route_source decided within it; `DISPATCH_ENGINE` is the additive normalized dispatch trigger — `gpt→codex`, `gemini→agy`, else `claude`). When the resolved `DISPATCH_ENGINE == codex` AND `unit_type == execute-task` AND `BATCH.length == 1`, take **Branch C** in Step 4 (sidecar). When `DISPATCH_ENGINE == codex` AND `unit_type == plan-slice`, take **Branch D** in Step 4 (sidecar plan, read-only). Otherwise (`DISPATCH_ENGINE == claude`, or a non-routable unit) fall through to the `Agent()` dispatch unchanged — the `claude` path is byte-identical.

**Dispatch resolution (step 1.5)** — resolve `{engine, model, alias, tier, domain, route_source, chain, chain_len, reason, effort, effort_reason}` for this dispatch via the **single `forge-dispatch-resolve.js --json` call**. This one call folds the former Engine Resolution + Tier Resolution + engine-by-route_source + Effort Resolution + Alias Resolution bash — a thin caller now, all pure resolution lives in the resolver. `route_source` is still `tier_models` on the legacy byte-identical path (no `routing:` block / frontmatter `worker:` not applied), `routing`/`frontmatter` otherwise.
> Cross-reference: `shared/forge-dispatch.md § Tier Resolution` + `§ Worker Engine Routing → Single-call resolver` + `§ Effort Resolution` (algorithm) and `shared/forge-tiers.md` (canonical tables). The resolver internally calls `forge-routing.js` (cross-engine chain), `forge-model-alias.js` (alias), and applies the tier/effort defaults + precedence + risk-escalation + model-cap clamp.

```bash
# ── Dispatch resolution (single call to the shared resolver) ─────────────────────
# forge-dispatch-resolve.js reads prefs from $WORKING_DIR (MEM018 — never $CODE_DIR), parses the
# PLAN frontmatter + ROADMAP, and emits the full ordered contract. NEVER reintroduce a bash
# tier/effort default map or a frontmatter/clamp regex here — that pure logic lives ONLY in the
# resolver now (S01). See shared/forge-dispatch.md § Worker Engine Routing.
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-dispatch-resolve.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
ROUTE_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-dispatch-resolve.js" \
  --unit-type "$unit_type" --plan "$PLAN_PATH" --unit-id "$unit_id" \
  --milestone "${RUN_ID:-{M###}}" --roadmap "$ROADMAP_PATH" \
  --cwd "$WORKING_DIR" --json)   # SEMPRE $WORKING_DIR, nunca $CODE_DIR (MEM018)
if [ $? -ne 0 ]; then
  # prefs_ok:false → resolver exit 1 (M008-CONTEXT #2 loud-stop — mirrors the prefs gate above;
  # both stay). Deactivate the run + surface prefs_errors[]; never proceed on a fallback value.
  echo "✗ dispatch resolver halted (prefs error) — see forge-dispatch-resolve.js prefs_errors" >&2
  exit 1
fi
MODEL_ID=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).model)" "$ROUTE_JSON")
MODEL_ALIAS=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).alias||'')" "$ROUTE_JSON")
TIER=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).tier)" "$ROUTE_JSON")
REASON=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).reason)" "$ROUTE_JSON")
DOMAIN_USED=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).domain)" "$ROUTE_JSON")
ROUTE_SOURCE=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).route_source)" "$ROUTE_JSON")
CHAIN_LEN=$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).chain_len))" "$ROUTE_JSON")
ENGINE=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).engine)" "$ROUTE_JSON")
DISPATCH_ENGINE=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).dispatch_engine||'')" "$ROUTE_JSON")
ENGINE_REASON=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).engine_reason)" "$ROUTE_JSON")
EFFORT=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).effort)" "$ROUTE_JSON")
EFFORT_REASON=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).effort_reason)" "$ROUTE_JSON")
WORKERS_TIMEOUT=$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).workers_timeout))" "$ROUTE_JSON")
CODEX_MODEL=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).codex_model||'')" "$ROUTE_JSON")
SIDECAR_MODEL=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).sidecar_model||'')" "$ROUTE_JSON")
THINKING_HEADER=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).thinking_header||'')" "$ROUTE_JSON")
# Raw resolver inputs restored for the failure-taxonomy re-resolution (--next-after / tier escalation).
DOMAIN=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).domain_input||'')" "$ROUTE_JSON")
PLAN_TIER=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).frontmatter_tier||'')" "$ROUTE_JSON")
PLAN_WORKER=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).plan_worker||'')" "$ROUTE_JSON")
MODEL_APPLIED_JSON=$([ -n "$MODEL_ALIAS" ] && printf '"%s"' "$MODEL_ALIAS" || printf 'null')
unit_effort="$EFFORT"
# $ROUTE_JSON.chain carries forward unmodified — consumed by Branch C/D (codex-member cap) and by
# the Failure Taxonomy via `forge-routing.js ... --next-after "$MODEL_ID"` on model_refusal/429/400
# (walks the cross-engine chain → category fallback → ''), BEFORE any cross-tier escalation
# (context_overflow's ladder is separate — re-resolves THROUGH routing at the escalated tier).

# Shadowing warning (risk #3) — routing: configured but not applied (frontmatter/legacy won).
ROUTING_PRESENT=$(node "$FORGE_SCRIPTS_DIR/forge-routing.js" --explain --unit-type "$unit_type" --tier "$TIER" --domain "$DOMAIN_USED" --cwd "$WORKING_DIR" 2>/dev/null | grep -qiE 'routing.*present|present.*true' && echo true || echo false)
if [ "$ROUTE_SOURCE" != "routing" ] && [ "$ROUTING_PRESENT" = "true" ]; then
  echo "⚠ routing: configurado mas não aplicado (route_source=$ROUTE_SOURCE) — frontmatter/legado venceu para $unit_type/$unit_id" >&2
fi
```
`TIER`, `MODEL_ID`, `MODEL_ALIAS`, `ROUTE_JSON` (with `.chain`), `ROUTE_SOURCE`, `CHAIN_LEN`, `DOMAIN_USED`, `ENGINE`, `ENGINE_REASON`, `EFFORT`, `EFFORT_REASON`, `WORKERS_TIMEOUT`, `CODEX_MODEL`, `SIDECAR_MODEL`, `DISPATCH_ENGINE`, `THINKING_HEADER`, `MODEL_APPLIED_JSON`, `unit_effort`, and `REASON` are now set. On `DISPATCH_ENGINE == codex` for a routable `execute-task`/`plan-slice`, take **Branch C/D** in Step 4 (the resolver already emitted `$SIDECAR_MODEL`/`$WORKERS_TIMEOUT` + `$ROUTE_JSON.chain` those branches read). Otherwise use `$MODEL_ID`/`$MODEL_ALIAS` in the `Agent()` call. `$TIER`/`$REASON`/`$DOMAIN_USED`/`$ROUTE_SOURCE`/`$CHAIN_LEN`/`$ENGINE`/`$EFFORT`/`$EFFORT_REASON` are injected into the dispatch event (additive).

> **Thinking guard (Fable 5 + Opus 5):** the resolver emits `$THINKING_HEADER` (`adaptive` when
> `$MODEL_ID` is `claude-fable-5`, or `claude-opus-5` with resolved effort `xhigh`/`max`; else empty).
> When `$THINKING_HEADER` is `adaptive`, inject `thinking: adaptive` in the worker prompt header (or
> omit the `thinking:` line) regardless of the phase's `thinking:` pref — `claude-fable-5` returns
> HTTP 400 on an explicit `thinking: disabled` at any effort, and `claude-opus-5` returns HTTP 400
> when `disabled` is paired with effort `xhigh`/`max` (Opus 4.7/4.8 accept it at any effort).

`unit_effort` (and `$EFFORT`/`$EFFORT_REASON` for the dispatch event) are set by the resolver above. Inject `effort: {unit_effort}` and (for opus/fable phases) `thinking: {THINKING_OPUS}` into the worker prompt header.

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

**Per-task resolution (parallel only):** If `BATCH.length > 1`, the dispatch resolution block above resolved for `$PLAN_PATH` of the **first** task. Before building prompts, re-run the single `forge-dispatch-resolve.js --json` call once per task in the batch (passing that task's `$PLAN_PATH`) so each one carries its own `{TIER, MODEL_ID, MODEL_ALIAS, ENGINE, DOMAIN_USED, ROUTE_SOURCE, CHAIN_LEN, REASON, EFFORT, EFFORT_REASON, DOMAIN, PLAN_TIER, PLAN_WORKER}` (the last three — the raw resolver inputs `domain_input`/`frontmatter_tier`/`plan_worker` — feed that task's failure-taxonomy re-resolution). Security gate (below) also loops over each task in the batch.

**Risk radar gate (plan-slice only):** If `unit_type == plan-slice` and the slice is tagged `risk:high` in ROADMAP, check if `S##-RISK.md` already exists. If not:
```
mkdir -p .gsd/milestones/{M###}/slices/{S##}
Skill({ skill: "forge-risk-radar", args: "{M###} {S##}" })
```
This runs the risk assessment in the current context before the plan-slice agent is dispatched. The produced `S##-RISK.md` will be injected into the worker prompt.

**Security gate (execute-task only):** If `unit_type == execute-task`, run this check for **each task in `BATCH`** (when `BATCH.length > 1`, iterate through every batch member; when `BATCH.length == 1`, run once for the single task).

For each task T## in BATCH: scan the corresponding `T##-PLAN.md` content for security-sensitive keywords using the canonical word-boundary pattern + narrow exception list in `shared/forge-dispatch.md § Security Gate — Keyword Pattern` (formula-once source — do not restate the regex here).

If the base pattern matches (and no exception suppresses it) AND `T##-SECURITY.md` does not already exist in that task's directory:
```
Skill({ skill: "forge-security", args: "{M###} {S##} {T##}" })
```
The produced `T##-SECURITY.md` will be injected into that task's worker prompt as `## Security Checklist`. Skills run in the orchestrator context — loop them serially (fast enough; each is short) before dispatching the batch in parallel.

**Overlap advisory (before complete-slice):** grave o toque desta run e confronte com as demais runs ativas — o sinal existe para ser visto **antes do merge**.
```bash
node "{WORKING_DIR}/scripts/forge-touch.js" --record "{RUN_ID}" --cwd "{WORKING_DIR}" || true
node "{WORKING_DIR}/scripts/forge-overlap.js" --check --cwd "{WORKING_DIR}" || true
```
Imprima o veredicto ao operador e **siga**. O sinal é advisory: **nunca** bloqueia o `complete-slice`, nunca ordena runs, nunca faz merge. Verdict `inconclusive` significa "não havia o que comparar" e **não** deve ser lido como limpo.

**Review gate (before complete-slice):** If `unit_type == complete-slice`, run the **dialectic review** on the slice diff BEFORE dispatching `forge-completer` (the slice branch `gsd/{M###}/{S##}` is still unmerged here, so the diff is intact). This is the challenger × defender confrontation:

1. Idempotency: if `{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-REVIEW.md` already exists → skip the gate, proceed to `complete-slice`.
2. Read `review.{mode,style,rounds,ask_in_auto,engine,challenger,challenger_model}` via the cascade in `shared/forge-review.md § Step 0`. If `mode == disabled` → skip.
   - Challenger routing (`review.challenger: claude|codex|gemini`) follows `shared/forge-review.md § Step 0` + the adapter branch in Steps 2/4 (`--engine codex|agy`) — single fallback to `forge-reviewer` when the external CLI is unavailable.
   - `challenger: codex|gemini` forces `engine: agents` (the `workflow` script cannot route an external CLI) — see the precedence block in the spec.
3. Execute the procedure in **`shared/forge-review.md`** with `MODE = auto`:
   > Antes de despachar cada agente (Challenge e Defense abaixo), exiba o **Spawn Liveness Banner** referenciado em `shared/forge-dispatch.md § Spawn Liveness Banner` com duração estimada para `review-challenger` / `review-advocate`.
   - **Engine** (`shared/forge-review.md § Engine workflow`): se `engine: workflow` e a tool `Workflow` estiver no seu tool list (introspecção — NÃO ToolSearch), os três dispatches abaixo (Challenge/Defense/Rebuttal) são substituídos por UMA invocação Workflow; em tool ausente ou erro → fallback agents com warning + evento `review-engine-fallback`. O render do Step 6 e os Steps 7a/7b/8 não mudam.
   - Challenge → `Agent({ subagent_type: 'forge-reviewer', … })`
   - Defense → `Agent({ subagent_type: 'forge-advocate', … })` — pass `DEFENSE_FILE` (crash rail, `shared/forge-review.md § Step 3`); a defense that comes back missing/short/scoreboard-only is **salvaged from that file** before `review-advocate-unavailable` may be emitted.
   - Rebuttal × `rounds` → `forge-reviewer` in rebuttal mode (DEFENSE injected)
   - The `model:` of `forge-advocate`/`forge-reviewer` comes exclusively from resolved `$ADVOCATE_ALIAS`/`$CHALLENGER_MODEL`; literals are a violation detected by `forge-review-audit.js`.
   - Resolve (Step 5 truth table), write `{S##}-REVIEW.md` (Step 6).
   - **CONCEDED items → fix now (Step 7a):** resolve `RF_ALIAS=$(node "$FORGE_SCRIPTS_DIR/forge-dispatch-resolve.js" --unit-type review-fix --cwd "$WORKING_DIR" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).alias||'')}catch(e){}})")`; dispatch `review-fix/{S##}` with `model: '{RF_ALIAS}'` only when non-empty.
   - **OPEN items → posture (Step 7b):** `ask_in_auto: defer` (default) marks each `**Decisão:** deferido → triagem no fim da milestone` and continues WITHOUT pausing — they are guaranteed to surface at the milestone-final triage gate below. `pause` (opt-in) asks per-slice via `AskUserQuestion`.
   - Append the `review` event to `events.jsonl` (Step 8).
4. The gate **never blocks** — any `Agent()` throw is recorded and the loop proceeds to `complete-slice` regardless.
   - On throw, follow `shared/forge-review.md § Agent unavailability (review-agent-unavailable)`: retry first via `shared/forge-dispatch.md § Retry Handler`; if the agent stays unavailable, emit `review-agent-unavailable` (`review-advocate-unavailable` | `review-challenger-unavailable`) — **never** the CRITICAL failure path of Step 5 below.

   > **REGRA CRÍTICA:** o orquestrador NUNCA produz veredito de review no lugar de um agente indisponível — nem defesa, nem réplica, nem julgamento de objeção alheia. A única ação permitida é registrar a indisponibilidade e escalar ao humano (interativo) ou deferir à triagem final (auto).

   - **Política deste modo (`MODE = auto`):** advogado indisponível — **só depois** de a salvage do `DEFENSE_FILE` não render nenhum veredito (`shared/forge-review.md § Step 3`) — ⇒ objeções ficam `open` cruas, Rebuttal é PULADO, e cada uma é deferida (`**Decisão:** deferido → triagem no fim da milestone`) — o loop **não pausa**, e a triagem final da milestone as apresenta ao operador. Challenger indisponível ⇒ `{S##}-REVIEW.md` mínimo registrando a indisponibilidade (proibido renderizar como limpo — ausência de review não é aprovação) e segue para `complete-slice`.

> Fires ONLY when the derived unit is `complete-slice`. Boundary is per-slice; standalone `/forge-task` keeps its own step-5.5 review. After the gate, dispatch `forge-completer` normally.

**Review triage gate (before complete-milestone):** If `unit_type == complete-milestone`, run the **milestone-final triage** (`shared/forge-review.md § Step 9`) BEFORE dispatching `forge-completer` — i.e., before the milestone is finalized "de fato" (final close-out, LEDGER entry, cleanup):

1. Scan all `{S##}-REVIEW.md` under `.gsd/milestones/{M###}/slices/*/` for pending items: `Decisão: deferido → triagem no fim da milestone`, `Correção: falhou — deferida para triagem final`, or legacy `Decisão: deferido (auto-mode)`.
2. Zero pending → skip silently and dispatch `complete-milestone` normally.
3. Otherwise **fire push (call-site 2):** use Push helper with message `"Forge {RUN_ID} — {N} item(ns) de review aguardam sua triagem antes de fechar a milestone."` (N = count of pending items). Then print the digest table (slice · R# · path:line · objeção · status) and triage each item via `AskUserQuestion` (batched up to 4, header `Review M###`): `Manter abordagem atual` / `Refatorar agora` / `Criar follow-up`.
4. `Refatorar agora` items → ONE `review-fix/{M###}-triage` dispatch to `forge-executor` (slices already merged — fixes are normal commits). Write every decision back into the R#'s `**Decisão:**` line; `Criar follow-up` items create an item per `shared/forge-review.md § Item capture` (source `review/{S##}/{R#}`, status `inbox`, provenance from the digest row) and append ONLY the pointer line `- {I-id} — {title}` to `.gsd/KNOWLEDGE.md § Review follow-ups` (create the section if missing — this survives `milestone_cleanup`; the item is the single destination for full content).
5. Append the `review-triage` event to `events.jsonl`. The triage **never blocks** the milestone close-out.

> **This gate is the explicit exception to the AUTONOMY RULE** — at this point every slice is done; asking the operator here is the designed arbitration moment that `defer` postponed to. It does not fire on pause/blocked/partial exits — only when the derived unit is `complete-milestone`.

**Plan-check gate (between plan-slice and first execute-task):**

After a successful `plan-slice` unit, before dispatching the first `execute-task` for the same slice, run the plan-check gate:

1. **Read `plan_check.mode` via the canonical engine CLI** (single-knob convenience form — reads the jsonc catalog per layer; legacy Markdown without jsonc hard-stops — see `shared/forge-prefs-cutover.md`; NEVER a 3-file cascade node -e merge, MEM001 M005):
   ```bash
   PLAN_CHECK_MODE=$(node "$FORGE_SCRIPTS_DIR/forge-prefs.js" --resolved --key plan_check.mode --cwd "$WORKING_DIR" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{let m=String(JSON.parse(d).value||'').toLowerCase();process.stdout.write((m==='advisory'||m==='blocking'||m==='disabled')?m:'advisory')}catch(e){process.stdout.write('advisory')}})")
   ```
   Store as `PLAN_CHECK_MODE` (default `advisory` on absence/parse error).

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

1. **Read `symbol_check.mode` via the canonical engine CLI** (single-knob convenience form — reads the jsonc catalog per layer; legacy Markdown without jsonc hard-stops — see `shared/forge-prefs-cutover.md`; NEVER a 3-file cascade node -e merge, MEM001 M005):
   ```bash
   SYMBOL_CHECK_MODE=$(node "$FORGE_SCRIPTS_DIR/forge-prefs.js" --resolved --key symbol_check.mode --cwd "$WORKING_DIR" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{let m=String(JSON.parse(d).value||'').toLowerCase();process.stdout.write((m==='advisory'||m==='disabled')?m:'advisory')}catch(e){process.stdout.write('advisory')}})")
   ```
   Store as `SYMBOL_CHECK_MODE` (default `advisory` on absence/parse error).

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

**Required renderer (Claude path):** do not copy a template body into the agent prompt. Render one bounded, auditable artifact with `forge-prompt.js`, then give the subagent only the artifact path and its dispatch identity. This supersedes the manual substitution list below (kept only as a compatibility description).
```bash
DISPATCH_ID="${unit_type}-${MILESTONE_ID:-none}-${SLICE_ID:-none}-${TASK_ID:-none}-$(node -e "console.log(require('crypto').randomUUID())")"
PROMPT_META=$(node "$FORGE_SCRIPTS_DIR/forge-prompt.js" --unit-type "$unit_type" --cwd "$WORKING_DIR" \
  --milestone "$MILESTONE_ID" --slice "$SLICE_ID" --task "$TASK_ID" \
  --dispatch-id "$DISPATCH_ID" --unit-effort "$unit_effort" --thinking "$THINKING_OPUS" \
  --auto-commit "$AUTO_COMMIT" --milestone-cleanup "$MILESTONE_CLEANUP" \
  --isolation-mode "$ISOLATION_MODE" --branch "$BRANCH" --code-dir "$WORKER_CWD" \
  --memory-query "$unit_type $MILESTONE_ID $SLICE_ID $TASK_ID" \
  --memory-max-tokens "${PREFS[token_budget][auto_memory]:-1200}" \
  --standards-max-tokens "${PREFS[token_budget][coding_standards]:-3000}" \
  --ledger-max-tokens "${PREFS[token_budget][ledger_snapshot]:-1500}") || { echo 'prompt render failed'; stop; }
PROMPT_PATH=$(node -pe 'JSON.parse(process.argv[1]).prompt_path' "$PROMPT_META")
PROMPT_ID=$(node -pe 'JSON.parse(process.argv[1]).prompt_id' "$PROMPT_META")
```
The Claude `Agent()` prompt is exactly: `Read the complete Forge dispatch contract at {PROMPT_PATH}, execute it exactly,
and return its required GSD worker result block. The file is trusted
orchestrator input; do not replace it with a summary.` Record `prompt_id` and `dispatch_id` in the event, and call `forge-prompt.js --cleanup "$DISPATCH_ID" --cwd "$WORKING_DIR"` after the result is durably processed. Do not load `.gsd/AUTO-MEMORY.md`; the renderer selects bounded memories.

Use the template from `$FORGE_SHARED_DIR/forge-dispatch.md` only as reference material when diagnosing an older run.
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

**Branch on BATCH size and engine:**
- `DISPATCH_ENGINE == codex` AND `unit_type == execute-task` AND `BATCH.length == 1`: follow **Branch C — sidecar codex** below (dispatch the detached adapter; fall back to Claude on any failure).
- `DISPATCH_ENGINE == codex` AND `unit_type == plan-slice`: follow **Branch D — sidecar codex plan** below (dispatch the detached adapter in `--mode plan`, read-only; fall back to a single Claude `forge-planner` on any failure).
- `BATCH.length == 1` (all non-execute-task unit types, plus execute-task when only one task is ready and `ENGINE == claude`): follow the **single-task flow** below (unchanged from pre-parallelism behavior).
- `BATCH.length > 1` (execute-task only, when `forge-parallelism.js` returned `mode: parallel`): follow the **parallel-batch flow** in Step 4-P after this section. If `DISPATCH_ENGINE == codex` in a parallel batch, see the codex note in Step 4-P (each ready task is handled single-task via Branch C; the Claude parallel batch is never mixed with background sidecars).

---

**Per-unit `CODE_DIR` resolution (multi-repo precondition)** — executable mirror of `shared/forge-dispatch.md § Sidecar dispatch state machine step 0.5` (contract prose lives there, never restated here). Runs HERE because `$PLAN_PATH` is only known per unit — the bootstrap `WORKTREE_DIR` is derived before any plan exists and stays untouched:
```bash
UNIT_CODE_DIR=""; CODE_DIR_STATUS="shared"; CODE_DIR_REASON=""; CODE_DIR_MULTI_ROOT=""; CODE_DIR_HINT=""
CODE_DIR_HINT_FILE="$WORKING_DIR/.gsd/forge/code-dir-hint.json"
mkdir -p "$WORKING_DIR/.gsd/forge/"; printf '""' > "$CODE_DIR_HINT_FILE"   # reset per unit — never inherit a prior unit's hint
if [ "$ISOLATION_MODE" = "worktree" ] && [ -n "$PLAN_PATH" ] && [ -n "$ISO_RESULT" ]; then
  CD_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-code-dir.js" --resolve \
    --iso-result "$ISO_RESULT" --plan "$WORKING_DIR/$PLAN_PATH" --cwd "$WORKING_DIR"); CD_RC=$?
  CD_JSON=${CD_JSON:-'{}'}
  CODE_DIR_STATUS=$(node -e "process.stdout.write((JSON.parse(process.argv[1]).status)||'shared')" "$CD_JSON")
  UNIT_CODE_DIR=$(node -e "process.stdout.write((JSON.parse(process.argv[1]).code_dir)||'')" "$CD_JSON")
  CODE_DIR_REASON=$(node -e "process.stdout.write((JSON.parse(process.argv[1]).reason)||'')" "$CD_JSON")
  CODE_DIR_MULTI_ROOT=$(node -e "process.stdout.write((JSON.parse(process.argv[1]).multi_repo_root)||'')" "$CD_JSON")
  CODE_DIR_HINT=$(node -e "process.stdout.write((JSON.parse(process.argv[1]).hint)||'')" "$CD_JSON")
  # Durable hint (shared/forge-dispatch.md § 0.5): shell state does NOT survive a Bash-tool boundary,
  # so the hint is JSON-encoded HERE and persisted for the worker-engine-fallback emitters to re-read.
  HINT_JSON=$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]||""))' "$CODE_DIR_HINT")
  [ -n "$HINT_JSON" ] || HINT_JSON='""'   # empty substitution would emit `"hint":}` — readEvents would drop the whole event
  printf '%s' "$HINT_JSON" > "$CODE_DIR_HINT_FILE"
  [ "$CD_RC" -eq 0 ] || echo "⚠ CODE_DIR ambíguo ($CODE_DIR_STATUS): $(node -e "process.stdout.write(((JSON.parse(process.argv[1]).repos_touched)||[]).join(', '))" "$CD_JSON") — sidecar recusado, executor Claude segue em ${CODE_DIR_MULTI_ROOT:-$WORKTREE_DIR}${CODE_DIR_HINT:+ — $CODE_DIR_HINT}"
  [ "$CODE_DIR_STATUS" = "ok" ] && [ -n "$UNIT_CODE_DIR" ] && CODE_DIR="$UNIT_CODE_DIR"
  # Refusal in a MULTI-repo workspace: the sidecar needs one git repo, the Claude
  # executor does not. The run root has every worktree under it, so the executor can
  # reach each repo the unit touches; the bootstrap value would drop it inside
  # whichever repo sorted first. Empty on single-repo workspaces → bootstrap, as before.
  [ "$CODE_DIR_STATUS" != "ok" ] && [ -n "$CODE_DIR_MULTI_ROOT" ] && CODE_DIR="$CODE_DIR_MULTI_ROOT"
fi
```
**Never assign to `WORKTREE_DIR` here.** An empty `WORKTREE_DIR` is the "every repo failed" STOP signal of the Isolation rules above — a sidecar refusal must never be mistaken for an isolation failure. The two `CODE_DIR=` lines above are what make the resolved value reach the bash consumers (`--state-init --cwd "$CODE_DIR"`, `forge-xllm --cwd`, `git -C "$CODE_DIR"`) deterministically, without depending on model substitution: status `ok` → the attributed worktree; refusal with a non-empty `multi_repo_root` → the run root holding every worktree, so a genuinely multi-repo unit stops landing in whichever repo sorted first (`multi_repo_root` is empty in a single-repo workspace, which keeps the bootstrap value).

**Branch C — sidecar codex (`DISPATCH_ENGINE == codex && unit_type == execute-task && BATCH.length == 1`):**

Executable mirror of `shared/forge-dispatch.md § Worker Engine Routing` → *Sidecar dispatch state machine* + *BLOCKER — cross-engine sidecar safety contract* + *Fallback*. States: `started → polling → done | failed`. On any failure the work reverts to the next chain member (verified reset first) or the Claude fallback — no 4th recovery layer.

**BLOCKER contract (S02-RISK — cross-engine chain such as `gpt→claude→gpt` dispatches the sidecar more than once per unit):** three invariants — (1) **state fresh per attempt** (`xllm-state-{unitId}-attempt-{N}.json`, `N` = `$SIDECAR_ATTEMPT`, never clobbering a prior attempt); (2) **verified reset** before the next sidecar attempt — the criterion is **exit 0** of `forge-surgical-reset.js --reset` (the codex-authored change set undone, the pre-dirty snapshot re-hashed intact), not `git status --porcelain` clean (a pre-existing dirty path is expected to still show after a correct reset); exit 3/2 abort to the Claude fallback (`surgical-reset-overlap`/`verified-reset-failed`); (3) **hard cap** `SIDECAR_ATTEMPT` ≤ the count of `engine == codex` members in the resolved chain.

```bash
# 0. Increment the per-unit sidecar attempt counter. Starts at 1 for the first sidecar dispatch of
#    the unit; hard-capped by the number of engine==codex members in the resolved chain (≤3, S01).
#    Persisted in the per-attempt state file so it survives an auto-compact mid-unit.
SIDECAR_ATTEMPT="${SIDECAR_ATTEMPT:-0}"; SIDECAR_ATTEMPT=$((SIDECAR_ATTEMPT + 1))
CODEX_MEMBERS=$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).chain.filter(m=>m.engine==='gpt'||m.engine==='codex').length))" "$ROUTE_JSON" 2>/dev/null || echo 1)
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-surgical-reset.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
# Gate: the sidecar assumes ONE CODE_DIR that is a git repo (shared/forge-dispatch.md § Branch codex 0.5).
# Executable, never a bare comment. Extends the cap-skip path: a cross-repo/undeclared verdict refuses
# BEFORE any --cwd reaches a helper — no START_SHA, no state/result-file, no launch.
if [ -n "$CODE_DIR_REASON" ]; then
  REASON="$CODE_DIR_REASON"
elif [ "$SIDECAR_ATTEMPT" -gt "${CODEX_MEMBERS:-1}" ]; then
  # Cap exceeded → go DIRECTLY to the Claude fallback (R3): no snapshot capture, no state/result-file
  # allocation, no sidecar launch. $REASON drives the Fallback block below.
  REASON="sidecar-cap-exceeded"
else
  # 1. Capture START_SHA + the pre-dirty snapshot in ONE atomic write, via the surgical-reset helper.
  #    --state-init records {attempt, start_sha, pre_dirty:[{path,hash}], reason, result_file, code_dir}
  #    in the SAME write (.gsd/** excluded), so the snapshot survives the poll loop / an auto-compact
  #    (BLOCKER item #2 of the S01 risk card — a snapshot in a shell var is lost the moment the process
  #    crosses a Bash-tool boundary). CODE_DIR from the isolation header; in shared mode CODE_DIR ==
  #    WORKING_DIR. The -attempt-$N suffix is the BLOCKER invariant — a second dispatch writes
  #    …-attempt-2.json, NEVER clobbering …-attempt-1.json (audit preserved, recovery unambiguous).
  N="$SIDECAR_ATTEMPT"
  XLLM_STATE=$(node "$FORGE_SCRIPTS_DIR/forge-xllm-state.js" --mode write --dir "$WORKING_DIR/.gsd/forge" --milestone "{M###}" --slice "{S##}" --task "{T##}" --attempt "$N")
  mkdir -p "$WORKING_DIR/.gsd/forge/"
  START_SHA=$(node "$FORGE_SCRIPTS_DIR/forge-surgical-reset.js" --state-init \
    --state "$XLLM_STATE" --cwd "$CODE_DIR" --attempt "$N")
  # Guard: if --state-init fails (non-zero exit / empty $START_SHA) → REASON="sidecar-state-init-failed"
  # → Fallback directly, with NO reset (nothing was captured, no valid state file to reset from).
  [ -n "$START_SHA" ] || REASON="sidecar-state-init-failed"

  # 2. No pre-dispatch clean-tree guard — the pre-dirty snapshot IS the guard (SUPERSEDED, DECISION 39,
  #    see S01-CONTEXT.md). A dirty working tree is a SAFE precondition, not a refusal reason: the
  #    fallback reset only ever touches paths that changed relative to the snapshot; pre-existing dirty
  #    content is provably untouched (re-hash) or the reset aborts entirely (overlap) rather than guessing.

  # 3. Result-file OUTSIDE CODE_DIR (codex must not overwrite it). Patch it into the durable state of
  #    the CURRENT attempt N via --state-update — a READ-MODIFY-WRITE that preserves start_sha + pre_dirty
  #    untouched. NEVER a plain printf: a hand-written printf omits pre_dirty, clobbering the snapshot and
  #    degrading the reset back to whole-tree destruction the moment the Fallback runs.
  RESULT_FILE=$(mktemp -t forge-xllm-result.XXXXXX.json)
  node "$FORGE_SCRIPTS_DIR/forge-surgical-reset.js" --state-update \
    --state "$XLLM_STATE" --result-file "$RESULT_FILE"
fi
```
With `REASON` now set by the guard above, control goes DIRECTLY to the **Fallback** block below (`worker-engine-fallback`) — no dispatch is attempted and no reset runs, since no valid state was ever captured.

When `REASON` is `sidecar-cap-exceeded` or one of the two `CODE_DIR` refusals (`sidecar-multirepo-unsupported` / `sidecar-code-dir-undeclared`) here, **skip the timeline task, dispatch and poll entirely** — go straight to the **Fallback** block below (no sidecar is launched, and no reset runs since no state was captured).

- **Timeline task:** `TaskCreate` with icon `⚡` (same as the Claude execute-task path), model label = `codex${CODEX_MODEL:+ ($CODEX_MODEL)}`; mark `in_progress`.
- **Dispatch (detached):** invoke via the Bash tool with `run_in_background: true` (the 600s foreground ceiling does not apply). `--model` is appended only when `$SIDECAR_MODEL` is non-empty: the resolver selects the chain's Codex member and otherwise falls back to `workers.codex_model`.
  The canonical context-parity semantics live in `shared/forge-dispatch.md § Branch C`: Security is inlined as a must-have and the bundle is informational; missing files are tolerated by the adapter.
  ```bash
  SECURITY_FILE="${PLAN_PATH%-PLAN.md}-SECURITY.md"
  CTX_BUNDLE=$(mktemp -t forge-ctx-bundle.XXXXXX.md)
  node "$FORGE_SCRIPTS_DIR/forge-context-bundle.js" --cwd "$WORKING_DIR" \
    --slice-context "$WORKING_DIR/.gsd/milestones/{M###}/slices/{S##}/{S##}-CONTEXT.md" --out "$CTX_BUNDLE"
  node "$FORGE_SCRIPTS_DIR/forge-xllm.js" --mode execute \
    --plan "$PLAN_PATH" --result-file "$RESULT_FILE" --cwd "$CODE_DIR" \
    --timeout "$WORKERS_TIMEOUT" \
    --security "$SECURITY_FILE" --context-bundle "$CTX_BUNDLE" \
    $([ -n "$SIDECAR_MODEL" ] && printf -- '--model %s' "$SIDECAR_MODEL")
  ```
- **Poll `$RESULT_FILE`** (`polling` state) every ~5–10s: `status == "running"` → keep polling + liveness check; `status == "done"` (exit 0) → **success**; `status == "error"` / adapter exit `!= 0` / unparseable JSON → **failure** (`reason` = `codex-error`/`codex-exit-nonzero`/`codex-invalid-json`). **Orphan:** heartbeat `updated_at` stale beyond the dynamic threshold `max(heartbeat_interval_ms × 4, 30s)` (field absent → assume 15s → 60s) → run the canonical liveness snippet (`shared/forge-dispatch.md § Orphan detection`): `stale-dead` → `kill "$pid"` (from heartbeat) → failure `reason: codex-orphan`; `stale-alive` → grace of one more poll cycle, then kill if still stale. The adapter `--timeout` is the backstop → `codex-timeout`.
- **Terminal outcome — runtime evidence materialization (step 7b), on EVERY outcome:** as soon as the poll loop settles a terminal outcome for this dispatch — `done`, **or** a failure reason that Layer-1 transient retry will not retry in place (including `codex-invalid-json` and an unreadable `$RESULT_FILE`) — invoke exactly once `node "$FORGE_SCRIPTS_DIR/forge-evidence-materialize.js" --result "$RESULT_FILE" --unit "execute-task/{T##}" --cwd "$WORKING_DIR" --json`. Step **7b** of `shared/forge-dispatch.md § Sidecar dispatch state machine` owns its outcome enum, naming and census; this mirror only invokes and never restates them (exit 0 always, advisory). It sits **before** the Success/Failure split on purpose (S06 review R9): invoked only from Success, the canonical table's unreadable-result-file row was unreachable from every call site. **One census per terminal outcome, never one per retry** — a Layer-1 in-place retry has not reached a terminal outcome yet and does not invoke it.
- **Orchestrator re-verification (TASK-015):** `REVERIFY=$(node "$FORGE_SCRIPTS_DIR/forge-reverify.js" --result "$RESULT_FILE" --code-dir "$CODE_DIR" --gsd-dir "$WORKING_DIR/.gsd" --apply --json)`. Follow `shared/forge-dispatch.md § Sidecar dispatch state machine` for the formula. `verified` continues with the amended result, `failed` follows Failure, and `no-command` leaves it untouched. Emit `orchestrator_reverification` with `unit:"execute-task/{T##}"`, command, exit code, verdict, entries and ISO timestamp; except for `not-applicable`, add `## Re-verification` to the summary.
- **Partial promotion boundary:** if the valid result JSON has `status == "partial"`, run `PROMOTION=$(node "$FORGE_SCRIPTS_DIR/forge-env-promote.js" --result "$RESULT_FILE" --plan "$PLAN_PATH" --json)` before selecting Success or Failure. Follow `shared/forge-dispatch.md § Sidecar dispatch state machine` for the canonical algorithm/allowlist; do not duplicate it here. If `PROMOTION.promote == true`, treat it as `done`: write `## Env Constraints` (item + reason + note per entry) in `T##-SUMMARY.md`, synthesize `env_constraints[]` in the result block, omit promoted entries from `must_haves_status.dropped`, and append `sidecar_env_promotion` with unit `execute-task/{T##}`, count, reasons and ISO timestamp to events.jsonl. If false (including old payloads without `scope`), take Failure unchanged.
- **`status == "done"` with unmet env-scope entries (M016 S01 review R1):** run the same `forge-env-promote.js` invocation whenever `status == "done"` but `must_haves_status` still has unmet entries — never accept the `done` label at face value. `verdict == "done-with-verified-env"` → accept, write `## Env Constraints` as above. `verdict == "done-with-unverified-env"` → treat the result as `partial` and follow Failure unchanged (classifier → repair strategy); the worker's `done` label is discarded.
- **Corroboration fallback — reachable from BOTH invocations above** (S06 review R8: this used to hang off the `status == "partial"` bullet alone, so the `status == "done"` path ran the same checker and never consumed `fallbacks`): after **either** invocation — the `status == "partial"` boundary or the `status == "done"` with unmet env-scope entries — if `PROMOTION.fallbacks` is non-empty, append one `sidecar_env_corroboration_fallback` line per entry (`unit:"execute-task/{T##}"`) as defined in `shared/forge-dispatch.md § Sidecar dispatch state machine`, regardless of the promotion outcome.
- **Success (`done`):** first re-read the durable state from disk (the poll loop crossed multiple Bash invocations — shell vars are gone), then the orchestrator reads the JSON and **writes `T##-SUMMARY.md`** (same format as a Claude worker) + assembles the `---GSD-WORKER-RESULT---` block itself. Codex NEVER touches `.gsd/**` and NEVER commits. Consume: `summary` (SUMMARY seed), `must_haves_status` (into the result block), `env_constraints` (promotion audit only), and VCS-derived `files_changed` from the result JSON (**authoritative**); `files_changed_declared` is an untrusted advisory cross-check. `start_sha`/`head_sha` are audit only — `$START_SHA` is authoritative. Append synthesized advisory evidence to `.gsd/forge/evidence-{unitId}.jsonl` with `node "$FORGE_SCRIPTS_DIR/forge-vcs.js" --changes --cwd "$CODE_DIR" --since "$START_SHA"`, tagged `source: codex-sidecar`; preserve the invariant that no `.gsd/**` path appears. Executable mirror of `shared/forge-dispatch.md § Post-run change set + baseline (canonical — VCS-agnostic)`. The runtime-observed lines of the same artifact were already materialized by the terminal-outcome bullet above — do **not** invoke the materializer a second time here. **Also mark the plan `status: DONE`** — add or update that field in the frontmatter of `$PLAN_PATH` (`T##-PLAN.md`), the *same* edit `agents/forge-executor.md` step 13 performs on the Claude path. The sidecar cannot (barred from `.gsd/**`), so the orchestrator does it on its behalf, alongside the SUMMARY write; canonical rationale + measured consequence in `shared/forge-dispatch.md § Sidecar dispatch state machine` (a statusless finished plan reads as unfinished to `forge-doctor` C3a/C9 and to Crash detection, and is re-dispatchable). Then **emit the dispatch event with `engine:"codex"`** and rejoin **Step 5. Process result** exactly as a Claude worker would — downstream verification runs byte-identical:
  **Compatibility de leitura:** use the state helper in read mode; it owns canonical and legacy fallback order.
  ```bash
  XLLM_STATE=$(node "$FORGE_SCRIPTS_DIR/forge-xllm-state.js" --mode read --dir "$WORKING_DIR/.gsd/forge" --milestone "{M###}" --slice "{S##}" --task "{T##}" --attempt "$N")
  START_SHA=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).start_sha" 2>/dev/null)
  CODE_DIR=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).code_dir" 2>/dev/null)
  RESULT_FILE=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).result_file" 2>/dev/null)
  mkdir -p "$WORKING_DIR/.gsd/forge/"
  # shared/forge-dispatch.md § DISPATCH_VCS prelude (canonical — VCS-agnostic)
  DISPATCH_VCS=$(node "$FORGE_SCRIPTS_DIR/forge-vcs.js" --detect --field vcs --cwd "${CODE_DIR:-$WORKING_DIR}" 2>/dev/null || echo "git")
  # shared/forge-dispatch.md § transport prelude — read in THIS fence, from $RESULT_FILE.
  # The ONLY shell default permitted is the named degraded value `unknown`; never
  # `:-app-server`, which would claim an observation nobody made.
  TRANSPORT=$(node "$FORGE_SCRIPTS_DIR/forge-transport.js" --result "$RESULT_FILE" --field transport 2>/dev/null || echo "unknown")
  TRANSPORT_VERSION=$(node "$FORGE_SCRIPTS_DIR/forge-transport.js" --result "$RESULT_FILE" --field transport_version 2>/dev/null)
  TRANSPORT_REASON=$(node "$FORGE_SCRIPTS_DIR/forge-transport.js" --result "$RESULT_FILE" --field transport_reason 2>/dev/null)
  TRANSPORT_TAIL="\"transport\":\"${TRANSPORT:-unknown}\""
  [ -n "$TRANSPORT_VERSION" ] && TRANSPORT_TAIL="$TRANSPORT_TAIL,\"transport_version\":\"$TRANSPORT_VERSION\""
  [ -n "$TRANSPORT_REASON" ] && TRANSPORT_TAIL="$TRANSPORT_TAIL,\"transport_reason\":\"$TRANSPORT_REASON\""
  echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"dispatch\",\"unit\":\"execute-task/${T##}\",\"model\":\"${CODEX_MODEL:-codex-default}\",\"reason\":\"${ENGINE_REASON}\",\"engine\":\"codex\",\"domain\":\"${DOMAIN_USED}\",\"route_source\":\"${ROUTE_SOURCE}\",\"chain_len\":${CHAIN_LEN},\"slice\":\"{S##}\",\"milestone\":\"${RUN_ID:-{M###}}\",\"input_tokens\":0,\"output_tokens\":0,\"vcs\":\"${DISPATCH_VCS:-git}\",${TRANSPORT_TAIL}}" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
  ```
  (`output_tokens` may be `0` — the adapter's token channel is git-derived, not SDK usage; no `tier`/`effort` fields on the codex path since Claude Tier/Effort Resolution was skipped.)

**Failure (any `reason`):** first evaluate **Layer-1 transient retry** (sidecar parity with the Claude Retry Handler — `shared/forge-dispatch.md § Layer-1 transient retry`); only on a terminal class / exhaustion / unverified reset does control fall through to the **Layer-2** verified-reset + chain walk (advance to another codex/claude member) or the Claude fallback:
```bash
# ── Layer-1 transient retry (sidecar parity with the Claude Retry Handler) — runs BEFORE Layer-2 ──
# Strictly upstream of the Layer-2 chain walk below (mirrors how the per-Agent() Retry Handler is
# upstream of the claude-member chain walk). Read error_class off the result JSON (or the adapter-failed
# marker — same field, S02/T01). Absent/unrecognized → terminal: byte-identical to pre-T02 (single-shot
# fallback, never an unbounded retry). codex-timeout / codex-orphan are ALWAYS terminal (a hung/orphaned
# process is never retried in place) regardless of a stale error_class.
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-surgical-reset.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
XLLM_STATE=$(node "$FORGE_SCRIPTS_DIR/forge-xllm-state.js" --mode read --dir "$WORKING_DIR/.gsd/forge" --milestone "{M###}" --slice "{S##}" --task "{T##}" --attempt "$N")
RESULT_FILE=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).result_file" 2>/dev/null || echo "$RESULT_FILE")
ERROR_CLASS=$(node -pe "JSON.parse(require('fs').readFileSync('$RESULT_FILE','utf8')).error_class || 'terminal'" 2>/dev/null || echo terminal)
case "$REASON" in codex-timeout|codex-orphan) ERROR_CLASS="terminal";; esac
TRC=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).transient_retry_count || 0" 2>/dev/null || echo 0)
MAX_TRC=$(printf '%s' "$PREFS_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const r=(JSON.parse(d).prefs.retry||{}).max_transient_retries;process.stdout.write(Number.isInteger(r)&&r>0?String(r):'3')}catch(e){process.stdout.write('3')}})")
BASE_BACKOFF=$(printf '%s' "$PREFS_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const b=(JSON.parse(d).prefs.retry||{}).base_backoff_ms;process.stdout.write(Number.isInteger(b)&&b>0?String(b):'2000')}catch(e){process.stdout.write('2000')}})")
# Sidecar failure policy (§ Sidecar failure policy) — fallback skips Layer-1; pause-ask gates exhaustion below; retry-then-fallback (default) is a no-op guard. Absent/invalid → retry-then-fallback.
POLICY=$(printf '%s' "$PREFS_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{let v=String(((JSON.parse(d).prefs.workers||{}).sidecar_on_failure)||'').toLowerCase();process.stdout.write(['retry-then-fallback','fallback','pause-ask'].includes(v)?v:'retry-then-fallback')}catch(e){process.stdout.write('retry-then-fallback')}})")
TRANSIENT_RETRY=""
if [ "$POLICY" != "fallback" ] && [ "$ERROR_CLASS" = "transient" ] && [ "$TRC" -lt "$MAX_TRC" ]; then
  # Layer-1 fires (policy allows it, transient AND under the cap). Branch C reset FIRST — same helper + verified-reset
  # criterion as Layer-2 (RC=0 required; RC=3 overlap / RC=2 verify-failed do NOT retry — fall through
  # to Layer-2, which owns the abort→fallback accounting; a retry NEVER runs on an unverified tree).
  node "$FORGE_SCRIPTS_DIR/forge-surgical-reset.js" --reset --state "$XLLM_STATE"; RC=$?
  if [ "$RC" = "0" ]; then
    # Exponential backoff base * 2^count (mirrors the Claude Retry Handler step 7). Cross-platform sleep.
    DELAY_MS=$(node -pe "$BASE_BACKOFF * Math.pow(2, $TRC)")
    node -e "setTimeout(()=>{}, $DELAY_MS)"
    # Bump the counter + allocate a fresh result-file via the S01 helper (read-modify-write — NEVER a
    # printf, which would clobber pre_dirty/start_sha). Same -attempt-$N state file; SIDECAR_ATTEMPT is
    # UNTOUCHED (transient_retry_count ⊥ SIDECAR_ATTEMPT — a Layer-1 retry never consumes a chain member).
    RESULT_FILE=$(mktemp -t forge-xllm-result.XXXXXX.json)
    node "$FORGE_SCRIPTS_DIR/forge-surgical-reset.js" --state-update \
      --state "$XLLM_STATE" --transient-retry-count $((TRC + 1)) --result-file "$RESULT_FILE"
    TRC=$((TRC + 1)); TRANSIENT_RETRY=1
    mkdir -p "$WORKING_DIR/.gsd/forge/"
    printf '{"ts":"%s","event":"sidecar-transient-retry","milestone":"%s","slice":"%s","unit":"execute-task/%s","attempt":%s,"transient_retry_count":%s,"backoff_ms":%s}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${RUN_ID:-${M###}}" "${S##}" "${T##}" "$SIDECAR_ATTEMPT" "$TRC" "$DELAY_MS" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
  fi
fi
```
**pause-ask degrade (policy == `pause-ask`) — forge-auto ALWAYS degrades (AUTONOMY RULE), never pauses.** Fires at exactly ONE transition — transient-retry **exhaustion**: `POLICY == pause-ask` AND Layer-1 did **not** re-fire this pass (`$TRANSIENT_RETRY` empty) AND class is `transient` AND the counter is at the cap (`TRC == MAX_TRC`). Terminal classes, `sidecar-cap-exceeded`, `surgical-reset-overlap` (`RC=3`) and `verified-reset-failed` (`RC=2`) all leave `TRC < MAX_TRC` or `ERROR_CLASS != transient`, so they bypass this gate and reach Layer-2 unchanged. On the trigger, degrade to the `fallback` action (fall through to Layer-2) and emit one `sidecar-pause-degraded` event (mirror of `shared/forge-dispatch.md § Sidecar failure policy`):
```bash
if [ "$POLICY" = "pause-ask" ] && [ -z "$TRANSIENT_RETRY" ] && [ "$ERROR_CLASS" = "transient" ] && [ "$TRC" -eq "$MAX_TRC" ]; then
  mkdir -p "$WORKING_DIR/.gsd/forge/"
  printf '{"ts":"%s","event":"sidecar-pause-degraded","milestone":"%s","slice":"%s","unit":"execute-task/%s","reason":"pause-ask-headless-degrade","transient_retry_count":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${RUN_ID:-${M###}}" "${S##}" "${T##}" "$TRC" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
fi
```
**If `$TRANSIENT_RETRY` is set** (Layer-1 fired, reset verified `RC=0`): re-enter the **Dispatch (detached) + Poll** steps for the CURRENT attempt `N` — reusing the same `-attempt-$N` state, `$START_SHA`/`pre_dirty` and the fresh `$RESULT_FILE`, WITHOUT re-running Branch C step 0 (so `SIDECAR_ATTEMPT` is NOT incremented and no new attempt file is allocated — `transient_retry_count` ⊥ `SIDECAR_ATTEMPT`). Do NOT run the Layer-2 block below. **Otherwise** — a `terminal` class, exhaustion (`transient_retry_count == max_transient_retries`), or an unverified reset (`RC≠0`, whose abort→fallback accounting Layer-2 owns) — control falls through to the **Layer-2** chain walk below **unchanged**:
```bash
# Re-read is delegated to the helper. Reconstruct the new slice-qualified state path first and fall
# back to the historical task-only state name when the canonical file is absent; this preserves
# runs that started before the mirror upgrade. Writing remains canonical-only via --state-init.
# $XLLM_STATE points at the …-attempt-$N.json of the CURRENT
# attempt and carries start_sha + pre_dirty (this block may be a later Bash invocation — shell vars
# are gone). BLOCKER item 2 — surgical reset via the helper (scoped to CODE_DIR, .gsd/** excluded),
# EXCEPT sidecar-cap-exceeded (no attempt captured a snapshot → nothing codex-authored to undo). The
# pre-dirty snapshot from step 1 makes it safe to reset even over a pre-existing dirty tree: only the
# codex-authored change set is undone; pre-existing dirty content is re-hashed intact (RC=0) or the
# reset aborts (RC=3 overlap / RC=2 verify-failed). .gsd/** is excluded by the helper's own predicate,
# so it never reverts the orchestrator's own .gsd writes (events.jsonl / evidence) made during the poll.
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-surgical-reset.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
XLLM_STATE=$(node "$FORGE_SCRIPTS_DIR/forge-xllm-state.js" --mode read --dir "$WORKING_DIR/.gsd/forge" --milestone "{M###}" --slice "{S##}" --task "{T##}" --attempt "$N")
if [ "$REASON" != "sidecar-cap-exceeded" ] && [ -z "$CODE_DIR_REASON" ]; then
  RESET_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-surgical-reset.js" --reset --state "$XLLM_STATE"); RC=$?
  # RC=0 → reset verified (only codex-authored changes undone, pre-dirty snapshot intact) → advance.
  # RC=3 → OVERLAP: a pre-dirty path's hash diverged (the sidecar ALSO wrote it) — the helper reset
  #        NOTHING (leftovers stay on disk, visible for the human — never silently discarded).
  # RC=2 → the reset ran but post-verification still found a leftover that isn't an intact pre-dirty path.
  if [ "$RC" = "3" ]; then
    REASON="surgical-reset-overlap"   # emit event with the overlap path list from $RESET_JSON; abort chain
  elif [ "$RC" != "0" ]; then
    REASON="verified-reset-failed"    # abort the chain to the Claude fallback — never inherit a dirty tree
  fi
fi

# Cross-engine chain walk (Layer 2) — advance to the next member unless the trigger forbids it.
# surgical-reset-overlap / sidecar-cap-exceeded / verified-reset-failed abort straight to the Claude
# fallback (no advance). ADVANCED is the mutual-exclusion latch (R1): chain-advance and the generic
# Claude fallback are mutually exclusive — exactly ONE of the two branches below runs.
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-routing.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
ADVANCED=""
if [ "$REASON" != "surgical-reset-overlap" ] && [ "$REASON" != "sidecar-cap-exceeded" ] && [ "$REASON" != "verified-reset-failed" ] && [ -z "$CODE_DIR_REASON" ]; then
  NEXT_ID=$(node "$FORGE_SCRIPTS_DIR/forge-routing.js" \
    --unit-type "$unit_type" --tier "$TIER" --domain "$DOMAIN" \
    --frontmatter-tier "$PLAN_TIER" --frontmatter-worker "$PLAN_WORKER" \
    --cwd "$WORKING_DIR" --next-after "$MODEL_ID")
  # NEXT_ID == '' → chain + category fallback exhausted → the Claude fallback below (never a 4th layer).
  if [ -n "$NEXT_ID" ]; then
    # Engine of the next member = codex when its family is "gpt", claude otherwise (R4 — there is no
    # --engine-of CLI; forge-model-alias.js --family is the sibling mirror's approach).
    NEXT_FAMILY=$(node "$FORGE_SCRIPTS_DIR/forge-model-alias.js" --family "$NEXT_ID" 2>/dev/null)
    MODEL_ID="$NEXT_ID"
    [ "$NEXT_FAMILY" = "gpt" ] && NEXT_ENGINE="codex" || NEXT_ENGINE="claude"
    ADVANCED="1"   # a live next member exists → advance, do NOT take the generic fallback
  fi
fi

if [ -n "$ADVANCED" ]; then
  # Chain advanced (mutually exclusive with the generic fallback — R1). Select + persist the next
  # member and re-enter the appropriate dispatch path; do NOT emit worker-engine-fallback here.
  if [ "$NEXT_ENGINE" = "codex" ]; then
    ENGINE="codex"; DISPATCH_ENGINE="codex"   # → re-enter Branch C step 0 with attempt N+1 (SIDECAR_ATTEMPT
                     #   increments, fresh state, verified-clean tree). NEXT_ENGINE is already the normalized
                     #   dispatch-engine, so the branch gate ($DISPATCH_ENGINE == codex) stays consistent.
  else
    ENGINE="claude"; DISPATCH_ENGINE="claude"  # → single-task Claude dispatch with $MODEL_ID (Tier/Effort
                     #   Resolution runs there). No generic fallback, no fallback event.
  fi
else
  # Chain exhausted (NEXT_ID empty) OR an abort reason (surgical-reset-overlap / sidecar-cap-exceeded /
  # verified-reset-failed) forbids advancement → the generic Claude fallback fires exactly ONCE.
  ENGINE="claude"; DISPATCH_ENGINE="claude"   # unconditionally Claude before re-entering Tier/Effort Resolution + dispatch
  echo "⚠ worker: codex indisponível ($REASON) — usando forge-executor"
  mkdir -p "$WORKING_DIR/.gsd/forge/"
  HINT_JSON=$(cat "${CODE_DIR_HINT_FILE:-$WORKING_DIR/.gsd/forge/code-dir-hint.json}" 2>/dev/null); [ -n "$HINT_JSON" ] || HINT_JSON='""'
  printf '{"ts":"%s","event":"worker-engine-fallback","milestone":"%s","slice":"%s","unit":"execute-task/%s","reason":"%s","hint":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${RUN_ID:-${M###}}" "${S##}" "${T##}" "$REASON" "$HINT_JSON" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
  # CRITICAL, per-dispatch + evidence-based fallback discipline: shared/forge-dispatch.md § Engine Fallback Discipline
fi
```
When `DISPATCH_ENGINE == codex` (chain advanced to a codex member), re-enter **Branch C step 0** with the incremented `SIDECAR_ATTEMPT`. When `DISPATCH_ENGINE == claude` (chain advanced to a claude member, OR the generic fallback fired), **NOW run the Tier/Effort Resolution** (step 1.5/1.55, skipped on the codex path) and dispatch **one** `forge-executor` Claude via the **single-task flow below** (reuse — do not duplicate). This Claude dispatch emits its own `dispatch` event with `engine:"claude"`. The generic Claude fallback (with its `worker-engine-fallback` event) fires **only** when the chain is exhausted or an abort reason forbids advancement — mutually exclusive with chain-advance (R1). Not a 4th recovery layer — the chain walk IS Failure Taxonomy Layer 2 (same layer, new resolver — MEM001), and the fallback fires once, in-band, at dispatch time.

---

**Branch D — sidecar codex plan (`DISPATCH_ENGINE == codex && unit_type == plan-slice`):**

Executable mirror of `shared/forge-dispatch.md § Worker Engine Routing` → *Sidecar dispatch state machine — Branch D* + *BLOCKER contract (state-fresh + cap only)* + *Fallback*. Read-only twin of Branch C: codex only reads the codebase + planning context to reason and returns markdown plan content in the result JSON — it never writes `.gsd/**`, so this branch has **no dirty-tree guard, no `START_SHA` capture, no reset** (BLOCKER item 2 does not apply — nothing codex-authored on disk). Only the **state-fresh-per-attempt** (item 1) and **cap** (item 3) invariants carry over: a multi-codex-member chain for `plan-slice` dispatches the sidecar more than once, so the state file is per-attempt and `SIDECAR_ATTEMPT` is hard-capped. States: `started → polling → done | failed`.

```bash
# 0. Increment the per-unit sidecar attempt counter — hard-capped by the count of engine==codex
#    chain members (BLOCKER item 3; read-only branch, so no reset — just fresh state + cap).
SIDECAR_ATTEMPT="${SIDECAR_ATTEMPT:-0}"; SIDECAR_ATTEMPT=$((SIDECAR_ATTEMPT + 1)); N="$SIDECAR_ATTEMPT"
CODEX_MEMBERS=$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).chain.filter(m=>m.engine==='gpt'||m.engine==='codex').length))" "$ROUTE_JSON" 2>/dev/null || echo 1)
if [ "$SIDECAR_ATTEMPT" -gt "${CODEX_MEMBERS:-1}" ]; then
  # Cap exceeded → go DIRECTLY to the Claude fallback (R3): no plan-context assembly, no state/
  # result-file allocation, no sidecar launch. $REASON drives the Failure/Fallback block below.
  REASON="sidecar-cap-exceeded"
else
  # 1. Assemble the plan-context file (orchestrator) — temp file OUTSIDE .gsd/ and CODE_DIR — so
  #    codex plans from the exact same information the Claude forge-planner would receive:
  #      - the slice's ROADMAP entry from .gsd/milestones/{M###}/{M###}-ROADMAP.md
  #      - M###-CONTEXT.md (full)
  #      - S##-CONTEXT.md (if it exists)
  #      - T##-SUMMARY.md / S##-SUMMARY.md of each dependency slice (prior context)
  #      - .gsd/CODING-STANDARDS.md (Asset Map + Pattern Catalog)
  #      - S##-RISK.md (if it exists)
  CTX_FILE=$(mktemp -t forge-plan-context.XXXXXX.md)   # tmpdir, never under $CODE_DIR or .gsd
  # → orchestrator appends the artifacts above (Read + concatenate); absent optional files are skipped.

  # 2. Persist durable state — Branch D spans multiple Bash invocations (poll loop, possible
  #    auto-compact); shell vars do not survive. No start_sha (read-only; nothing to reset).
  XLLM_STATE=$(node "$FORGE_SCRIPTS_DIR/forge-xllm-state.js" --mode write --dir "$WORKING_DIR/.gsd/forge" --milestone "{M###}" --slice "{S##}" --attempt "$N")
  mkdir -p "$WORKING_DIR/.gsd/forge/"
  RESULT_FILE=$(mktemp -t forge-xllm-result.XXXXXX.json)   # tmpdir, never under $CODE_DIR
  printf '{"attempt":%s,"reason":"","result_file":"%s","code_dir":"%s","ctx_file":"%s"}\n' \
    "$N" "$RESULT_FILE" "$CODE_DIR" "$CTX_FILE" > "$XLLM_STATE"
fi
```
When `REASON == sidecar-cap-exceeded` here, **skip the timeline task, dispatch and poll entirely** — go straight to the **Failure/Fallback** block below (no sidecar is launched).

- **Timeline task:** `TaskCreate` with icon `⚙` (plan-slice), model label = `codex${CODEX_MODEL:+ ($CODEX_MODEL)}`; mark `in_progress`.
- **Dispatch (detached):** invoke via the Bash tool with `run_in_background: true`. `--model` is appended only when `$SIDECAR_MODEL` is non-empty: the resolver selects the chain's Codex member and otherwise falls back to `workers.codex_model`:
  ```bash
  FORGE_SCRIPTS_DIR=$([ -f scripts/forge-xllm.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
  node "$FORGE_SCRIPTS_DIR/forge-xllm.js" --mode plan \
    --plan-context "$CTX_FILE" --result-file "$RESULT_FILE" --cwd "$CODE_DIR" \
    --timeout "$WORKERS_TIMEOUT" \
    $([ -n "$SIDECAR_MODEL" ] && printf -- '--model %s' "$SIDECAR_MODEL")
  ```
- **Poll `$RESULT_FILE`** (`polling` state) — identical cadence/orphan-detection to Branch C step 5: `running` → keep polling + liveness check; `done` → success; `error` / exit `!= 0` / unparseable JSON → failure (`reason` = `codex-exit-nonzero` / `codex-invalid-json`; note plan mode also treats an in-sidecar `must_haves` validation failure as `codex-exit-nonzero`, exit 2); heartbeat `updated_at` stale beyond the dynamic threshold `max(heartbeat_interval_ms × 4, 30s)` (identical canonical orphan detection as Branch C — see `shared/forge-dispatch.md § Orphan detection`; probe + grace before kill) → `kill "$pid"` → failure `reason: codex-orphan`. The adapter `--timeout` is the backstop → `codex-timeout`.
- **Success (`done`):** re-read the durable state from disk (shell vars are gone), read the result JSON, and **materialize** — orchestrator writes, codex never touches `.gsd/**`:
  ```bash
  RESULT_FILE=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).result_file" 2>/dev/null)
  # slice_plan.content    → .gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN.md
  # task_plans[i].content → .gsd/milestones/{M###}/slices/{S##}/tasks/{id}/{id}-PLAN.md  (mkdir -p tasks/{id}/ first)
  ```
  **Path-traversal guard (untrusted codex output):** `task_plans[].id`/`.filename` are UNTRUSTED (codex is external/potentially-compromised). `validatePlanResult` in `forge-xllm.js` is the gate — it rejects (exit 2 → Fallback) any `id` not `^T\d+$` or `filename` not `^[A-Za-z0-9._-]+\.md$` (no `/`, `\`, `..`). Defense in depth: **re-derive the path from the validated `id` alone** (`tasks/{id}/{id}-PLAN.md`); treat `filename` only as an optional equality-check against `{id}-PLAN.md` — **never concatenate the raw `filename` into the path.**
  Then **emit the dispatch event with `engine:"codex"`, unit `plan-slice/{S##}`**:
  ```bash
  # State is RE-RESOLVED here, in the same fence as the echo, on purpose: neither
  # $XLLM_STATE nor $RESULT_FILE is assigned in this fence, and shell state does NOT
  # survive a Bash-tool boundary. Reading the transport in a neighbouring fence is the
  # exact form that produced TASK-021's permanently-empty `hint` and the `auto-mode
  # started_at` bug — a field that is empty on every run and looks like "not observed".
  # Do not "simplify" these two lines away.
  XLLM_STATE=$(node "$FORGE_SCRIPTS_DIR/forge-xllm-state.js" --mode read --dir "$WORKING_DIR/.gsd/forge" --milestone "{M###}" --slice "{S##}" --attempt "$N")
  RESULT_FILE=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).result_file" 2>/dev/null)
  # shared/forge-dispatch.md § DISPATCH_VCS prelude (canonical — VCS-agnostic)
  DISPATCH_VCS=$(node "$FORGE_SCRIPTS_DIR/forge-vcs.js" --detect --field vcs --cwd "${CODE_DIR:-$WORKING_DIR}" 2>/dev/null || echo "git")
  # shared/forge-dispatch.md § transport prelude — only `unknown` may be a shell default.
  TRANSPORT=$(node "$FORGE_SCRIPTS_DIR/forge-transport.js" --result "$RESULT_FILE" --field transport 2>/dev/null || echo "unknown")
  TRANSPORT_VERSION=$(node "$FORGE_SCRIPTS_DIR/forge-transport.js" --result "$RESULT_FILE" --field transport_version 2>/dev/null)
  TRANSPORT_REASON=$(node "$FORGE_SCRIPTS_DIR/forge-transport.js" --result "$RESULT_FILE" --field transport_reason 2>/dev/null)
  TRANSPORT_TAIL="\"transport\":\"${TRANSPORT:-unknown}\""
  [ -n "$TRANSPORT_VERSION" ] && TRANSPORT_TAIL="$TRANSPORT_TAIL,\"transport_version\":\"$TRANSPORT_VERSION\""
  [ -n "$TRANSPORT_REASON" ] && TRANSPORT_TAIL="$TRANSPORT_TAIL,\"transport_reason\":\"$TRANSPORT_REASON\""
  echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"dispatch\",\"unit\":\"plan-slice/${S##}\",\"model\":\"${CODEX_MODEL:-codex-default}\",\"reason\":\"${ENGINE_REASON}\",\"engine\":\"codex\",\"domain\":\"${DOMAIN_USED}\",\"route_source\":\"${ROUTE_SOURCE}\",\"chain_len\":${CHAIN_LEN},\"slice\":\"{S##}\",\"milestone\":\"${RUN_ID:-{M###}}\",\"input_tokens\":0,\"output_tokens\":0,\"vcs\":\"${DISPATCH_VCS:-git}\",${TRANSPORT_TAIL}}" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
  ```
  and **rejoin the normal `plan-slice` completion path**: the **plan-check gate**, the **symbol-check gate** and the interactive **plan_gate** all run over the materialized files exactly as they would after a Claude `forge-planner` — nothing in those gates changes, agnostic of origin. No `T##-SUMMARY`/`---GSD-WORKER-RESULT---` is synthesized here — plan-slice produces plan files, not a task result; skip Step 5 (Process result) and Post-unit housekeeping for this dispatch, going straight to the plan-check gate below.

**Failure (any `reason`) — read-only, no reset:** codex wrote nothing on disk, so there is nothing codex-authored to undo (BLOCKER item 2 skipped for the whole branch). First evaluate **Layer-1 transient retry** (same decision + counter + backoff + re-dispatch as Branch C, but **NO surgical-reset step** — read-only twin); only on a terminal class / exhaustion does control fall through to **Layer-2** (discard the result JSON, then advance the cross-engine chain or degrade to the Claude fallback):
```bash
# ── Layer-1 transient retry (Branch D — read-only twin; NO surgical reset) — runs BEFORE Layer-2 ──
# Identical decision + counter + backoff + re-dispatch to Branch C, but codex wrote nothing on disk
# (read-only), so there is NO surgical-reset step (§ BLOCKER item 2 skipped for the whole branch). The
# result JSON is simply discarded and the SAME codex --mode plan dispatch re-runs after backoff.
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-surgical-reset.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
RESULT_FILE=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).result_file" 2>/dev/null || echo "$RESULT_FILE")
ERROR_CLASS=$(node -pe "JSON.parse(require('fs').readFileSync('$RESULT_FILE','utf8')).error_class || 'terminal'" 2>/dev/null || echo terminal)
case "$REASON" in codex-timeout|codex-orphan) ERROR_CLASS="terminal";; esac
TRC=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).transient_retry_count || 0" 2>/dev/null || echo 0)
MAX_TRC=$(printf '%s' "$PREFS_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const r=(JSON.parse(d).prefs.retry||{}).max_transient_retries;process.stdout.write(Number.isInteger(r)&&r>0?String(r):'3')}catch(e){process.stdout.write('3')}})")
BASE_BACKOFF=$(printf '%s' "$PREFS_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const b=(JSON.parse(d).prefs.retry||{}).base_backoff_ms;process.stdout.write(Number.isInteger(b)&&b>0?String(b):'2000')}catch(e){process.stdout.write('2000')}})")
# Sidecar failure policy (§ Sidecar failure policy) — fallback skips Layer-1; pause-ask gates exhaustion below; retry-then-fallback (default) is a no-op guard. Absent/invalid → retry-then-fallback.
POLICY=$(printf '%s' "$PREFS_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{let v=String(((JSON.parse(d).prefs.workers||{}).sidecar_on_failure)||'').toLowerCase();process.stdout.write(['retry-then-fallback','fallback','pause-ask'].includes(v)?v:'retry-then-fallback')}catch(e){process.stdout.write('retry-then-fallback')}})")
TRANSIENT_RETRY=""
if [ "$POLICY" != "fallback" ] && [ "$ERROR_CLASS" = "transient" ] && [ "$TRC" -lt "$MAX_TRC" ]; then
  # Layer-1 fires (policy allows it, transient AND under the cap). NO surgical reset (read-only branch — nothing to undo).
  DELAY_MS=$(node -pe "$BASE_BACKOFF * Math.pow(2, $TRC)")
  node -e "setTimeout(()=>{}, $DELAY_MS)"
  # Bump the counter + fresh result-file via the S01 helper (read-modify-write). SIDECAR_ATTEMPT UNTOUCHED.
  RESULT_FILE=$(mktemp -t forge-xllm-result.XXXXXX.json)
  node "$FORGE_SCRIPTS_DIR/forge-surgical-reset.js" --state-update \
    --state "$XLLM_STATE" --transient-retry-count $((TRC + 1)) --result-file "$RESULT_FILE"
  TRC=$((TRC + 1)); TRANSIENT_RETRY=1
  mkdir -p "$WORKING_DIR/.gsd/forge/"
  printf '{"ts":"%s","event":"sidecar-transient-retry","milestone":"%s","slice":"%s","unit":"plan-slice/%s","attempt":%s,"transient_retry_count":%s,"backoff_ms":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${RUN_ID:-${M###}}" "${S##}" "${S##}" "$SIDECAR_ATTEMPT" "$TRC" "$DELAY_MS" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
fi
```
**pause-ask degrade (policy == `pause-ask`) — Branch D, forge-auto ALWAYS degrades (AUTONOMY RULE).** Same exhaustion-only trigger as Branch C (`POLICY == pause-ask` AND `$TRANSIENT_RETRY` empty AND `transient` class AND `TRC == MAX_TRC`); read-only twin so `unit` is `plan-slice/{S##}`. Degrade to the `fallback` action (fall through to Layer-2 discard + Claude planner) and emit one `sidecar-pause-degraded` event:
```bash
if [ "$POLICY" = "pause-ask" ] && [ -z "$TRANSIENT_RETRY" ] && [ "$ERROR_CLASS" = "transient" ] && [ "$TRC" -eq "$MAX_TRC" ]; then
  mkdir -p "$WORKING_DIR/.gsd/forge/"
  printf '{"ts":"%s","event":"sidecar-pause-degraded","milestone":"%s","slice":"%s","unit":"plan-slice/%s","reason":"pause-ask-headless-degrade","transient_retry_count":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${RUN_ID:-${M###}}" "${S##}" "${S##}" "$TRC" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
fi
```
**If `$TRANSIENT_RETRY` is set**: re-enter the Branch D **Dispatch + Poll** for the CURRENT attempt (same state, fresh `$RESULT_FILE`; `SIDECAR_ATTEMPT` untouched); do NOT run the Layer-2 block below. **Otherwise** (terminal class or exhaustion) control falls through to **Layer-2** **unchanged**:
```bash
CODE_DIR=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).code_dir" 2>/dev/null)
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-routing.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
# Cross-engine chain walk (Layer 2) — advance to the next member unless the cap was exceeded (the
# only abort reason on this read-only branch). ADVANCED is the mutual-exclusion latch (R1):
# chain-advance and the generic Claude fallback are mutually exclusive — exactly ONE runs.
ADVANCED=""
if [ "$REASON" != "sidecar-cap-exceeded" ]; then
  NEXT_ID=$(node "$FORGE_SCRIPTS_DIR/forge-routing.js" \
    --unit-type "$unit_type" --tier "$TIER" --domain "$DOMAIN" \
    --frontmatter-tier "$PLAN_TIER" --frontmatter-worker "$PLAN_WORKER" \
    --cwd "$WORKING_DIR" --next-after "$MODEL_ID")
  if [ -n "$NEXT_ID" ]; then
    # Engine of the next member = codex when its family is "gpt", claude otherwise (R4 — no
    # --engine-of CLI; forge-model-alias.js --family is the sibling mirror's approach).
    NEXT_FAMILY=$(node "$FORGE_SCRIPTS_DIR/forge-model-alias.js" --family "$NEXT_ID" 2>/dev/null)
    MODEL_ID="$NEXT_ID"
    [ "$NEXT_FAMILY" = "gpt" ] && NEXT_ENGINE="codex" || NEXT_ENGINE="claude"
    ADVANCED="1"   # a live next member exists → advance, do NOT take the generic fallback
  fi
  # NEXT_ID == '' → chain + category fallback exhausted → the Claude fallback below (never a 4th layer).
fi

if [ -n "$ADVANCED" ]; then
  # Chain advanced (mutually exclusive with the generic fallback — R1). Select the next member and
  # re-enter the appropriate dispatch path; do NOT emit worker-engine-fallback here.
  if [ "$NEXT_ENGINE" = "codex" ]; then
    ENGINE="codex"; DISPATCH_ENGINE="codex"   # → re-enter Branch D step 0 (SIDECAR_ATTEMPT increments, fresh state). NEXT_ENGINE is the normalized dispatch-engine → branch gate stays consistent. No fallback event.
  else
    ENGINE="claude"; DISPATCH_ENGINE="claude"  # → single Claude forge-planner with $MODEL_ID (Tier/Effort Resolution runs there). No fallback event.
  fi
else
  # Chain exhausted (NEXT_ID empty) OR the cap forbids advancement → generic Claude fallback fires ONCE.
  ENGINE="claude"; DISPATCH_ENGINE="claude"   # unconditionally Claude before re-entering Tier/Effort Resolution + dispatch
  echo "⚠ worker: codex indisponível ($REASON) — usando forge-planner"
  mkdir -p "$WORKING_DIR/.gsd/forge/"
  HINT_JSON=$(cat "${CODE_DIR_HINT_FILE:-$WORKING_DIR/.gsd/forge/code-dir-hint.json}" 2>/dev/null); [ -n "$HINT_JSON" ] || HINT_JSON='""'
  printf '{"ts":"%s","event":"worker-engine-fallback","milestone":"%s","slice":"%s","unit":"plan-slice/%s","reason":"%s","hint":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${RUN_ID:-${M###}}" "${S##}" "${S##}" "$REASON" "$HINT_JSON" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
  # CRITICAL, per-dispatch + evidence-based fallback discipline: shared/forge-dispatch.md § Engine Fallback Discipline
fi
```
When `DISPATCH_ENGINE == codex` (chain advanced to a codex member), re-enter **Branch D step 0** with the incremented `SIDECAR_ATTEMPT`. When `DISPATCH_ENGINE == claude` (chain advanced to a claude member, OR the generic fallback fired), **NOW run the Tier/Effort Resolution** (step 1.5/1.55, skipped on the codex path — a `risk:high` slice escalates `heavy → max`/Fable exactly as today) and dispatch **one** `forge-planner` Claude via the **single-task flow below** (reuse — do not duplicate). This Claude dispatch emits its own `dispatch` event with `engine:"claude"`. The generic Claude fallback (with its `worker-engine-fallback` event) fires **only** when the chain is exhausted or the cap forbids advancement — mutually exclusive with chain-advance (R1). Not a 4th recovery layer — it fires once, in-band, at dispatch time.

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

**Alias Resolution** — `Agent()`'s `model:` param only accepts `sonnet|opus|haiku|fable`, never a full model ID. `$MODEL_ALIAS` was already resolved by `forge-dispatch-resolve.js` (its `alias` field) in step 1.5 — just warn if it came back empty:
```bash
[ -z "$MODEL_ALIAS" ] && echo "⚠ model \"$MODEL_ID\" sem alias — usando frontmatter do agente" >&2
```

Then call `Agent(agent_name, worker_prompt, model: $MODEL_ALIAS)` when `$MODEL_ALIAS` is non-empty; when empty, call `Agent(agent_name, worker_prompt)` without a `model:` param (degrades to the agent's own frontmatter — the warning above was already echoed). Use a `description` with the same icon:
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
MODEL_APPLIED_JSON=$([ -n "$MODEL_ALIAS" ] && printf '"%s"' "$MODEL_ALIAS" || printf 'null')
# shared/forge-dispatch.md § DISPATCH_VCS prelude (canonical — VCS-agnostic)
DISPATCH_VCS=$(node "$FORGE_SCRIPTS_DIR/forge-vcs.js" --detect --field vcs --cwd "${CODE_DIR:-$WORKING_DIR}" 2>/dev/null || echo "git")
echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"dispatch\",\"unit\":\"${unitType}/${unitId}\",\"model\":\"${MODEL_ID}\",\"tier\":\"${TIER}\",\"reason\":\"${REASON}\",\"effort\":\"${EFFORT}\",\"effort_reason\":\"${EFFORT_REASON}\",\"engine\":\"${ENGINE:-claude}\",\"domain\":\"${DOMAIN_USED}\",\"route_source\":\"${ROUTE_SOURCE}\",\"chain_len\":${CHAIN_LEN},\"slice\":\"{S##}\",\"milestone\":\"${RUN_ID:-{M###}}\",\"input_tokens\":${INPUT_TOKENS},\"output_tokens\":${OUTPUT_TOKENS},\"model_applied\":${MODEL_APPLIED_JSON},\"vcs\":\"${DISPATCH_VCS:-git}\",\"transport\":\"in-process\"}" >> .gsd/forge/events.jsonl
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

> **Codex in a parallel batch (S02):** the sidecar is single-task only — background sidecars are NOT mixed with the Claude parallel `Agent()` batch. When engine routing yields `codex` for tasks in a batch, resolve `ENGINE` **per task** (step 1.45 is per-`PLAN_PATH`, like Tier Resolution) and handle each `codex` task **single-task via Branch C** (sequential), keeping the Claude batch below intact for the `claude` tasks. Do not background-dispatch multiple sidecars concurrently in S02.

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

**h) Output tokens + dispatch events** — once all results are back, emit one `dispatch` event per task (not one per batch), preserving the per-task tier/model/reason/effort fields. The single `forge-dispatch-resolve.js --json` call resolves **per task** in batch mode — each task gets its own `$MODEL_ID_T##`/`$ENGINE_T##`/`$DOMAIN_USED_T##`/`$ROUTE_SOURCE_T##`/`$CHAIN_LEN_T##`/`$EFFORT_T##`/`$EFFORT_REASON_T##` from that task's `$PLAN_PATH` (step 1.5 re-run per-`PLAN_PATH`). (Codex tasks in a batch are handled single-task via Branch C — the Claude parallel batch below is never mixed with background sidecars.)
```bash
for each task in BATCH:
  OUTPUT_TOKENS_T##=$(node "$FORGE_SCRIPTS_DIR/forge-tokens.js" --inline "$result_T##")
  # shared/forge-dispatch.md § DISPATCH_VCS prelude (canonical — VCS-agnostic)
  DISPATCH_VCS=$(node "$FORGE_SCRIPTS_DIR/forge-vcs.js" --detect --field vcs --cwd "${CODE_DIR:-$WORKING_DIR}" 2>/dev/null || echo "git")
  echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"dispatch\",\"unit\":\"execute-task/T##\",\"model\":\"$MODEL_ID_T##\",\"tier\":\"$TIER_T##\",\"reason\":\"$REASON_T##\",\"effort\":\"$EFFORT_T##\",\"effort_reason\":\"$EFFORT_REASON_T##\",\"engine\":\"claude\",\"domain\":\"$DOMAIN_USED_T##\",\"route_source\":\"$ROUTE_SOURCE_T##\",\"chain_len\":$CHAIN_LEN_T##,\"slice\":\"{S##}\",\"milestone\":\"${RUN_ID:-{M###}}\",\"input_tokens\":$INPUT_TOKENS_T##,\"output_tokens\":$OUTPUT_TOKENS_T##,\"batch_size\":${BATCH_LENGTH},\"vcs\":\"${DISPATCH_VCS:-git}\",\"transport\":\"in-process\"}" >> .gsd/forge/events.jsonl
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
- `status: blocked` → apply failure taxonomy before stopping; if no auto-recovery or recovery exhausted:

  <!-- item-capture:blocked:start -->
  Create a work-item so the blocker is not lost, per `shared/forge-review.md § Item capture`. Dedup guard first — skip creation if an open item already exists for this source:
  ```bash
  EXISTING=$(node "$FORGE_SCRIPTS_DIR/forge-items.js" --list --json --cwd "$WORKING_DIR" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const items=JSON.parse(s);const found=(items.items||items||[]).some(i=>i.source==='blocked/{unit_type}/{unit_id}'&&!['done','dropped'].includes(i.status));process.stdout.write(found?'1':'')}catch(e){process.stdout.write('')}})")
  if [ -z "$EXISTING" ]; then
    PAYLOAD=$(node -e "process.stdout.write(JSON.stringify({title: process.argv[1], origin: 'auto', status: 'triaged', source: process.argv[2], milestone: process.argv[3], body: process.argv[4]}))" \
      "[{classe}] {unit_type}/{unit_id} bloqueado — {resumo}" "blocked/{unit_type}/{unit_id}" "${RUN_ID:-{M###}}" "{blocker excerpt}. Recuperações tentadas: {recovery attempts, if any}")
    printf '%s' "$PAYLOAD" | node "$FORGE_SCRIPTS_DIR/forge-items.js" --add --cwd "$WORKING_DIR" || echo "WARN: item capture failed for blocked/{unit_type}/{unit_id} — continuing"
  fi
  ```
  This is a plain Bash call — never behind `AskUserQuestion`, never pauses the loop (AUTONOMY RULE intact). A non-zero `--add` exit is a warning, not a blocker for this stop path.
  <!-- item-capture:blocked:end -->

  Then **fire push (call-site 1):** use Push helper with message `"Forge {RUN_ID} travou — {classe do blocker}: {resumo}. Run pausado, requer ação manual."`, then **deactivate run NOW** (`node "$FORGE_SCRIPTS_DIR/forge-runs.js" --update "$RUN_ID" --json '{"active":false}'` — see `## Deactivate auto-mode indicator`), **stop loop**:

**Failure Taxonomy** (check `blocker` field in result, first match wins):

| Class | Signals | Auto-recovery |
|-------|---------|---------------|
| `context_overflow` | "context limit", "too long", "token" | Climb one tier up, then **re-resolve THROUGH routing** at the escalated tier (keeps the same `$DOMAIN`, so a `routing.<domain>.<phase>.<escalated-tier>` cell — or its `default` fallback — is honored on the retry): `ESCALATED_TIER=heavy` (`standard → heavy → max`); `ROUTE_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-routing.js" --unit-type "$unit_type" --tier "$ESCALATED_TIER" --domain "$DOMAIN" --frontmatter-tier "$PLAN_TIER" --frontmatter-worker "$PLAN_WORKER" --cwd "$WORKING_DIR")`; `MODEL_ID=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).chain[0].id)" "$ROUTE_JSON")`. If already `max` → stop loop, surface to user. Apply the thinking guard (Fable 5 + Opus 5) when escalating tiers. **This ladder is separate — it climbs tiers, it does NOT consume `chain[]` (the intra-tier chain, now cross-engine, walked via `--next-after`).** |
| `scope_exceeded` | "out of scope", "too broad", "multiple tasks" | Stop loop. Tell user: "Task scope too broad — ask forge-planner to split T## into smaller tasks." |
| `model_refusal` | "cannot", "I'm not able", "policy" | Walk the cross-engine chain first (SAME Layer 2, new resolver): `NEXT=$(node "$FORGE_SCRIPTS_DIR/forge-routing.js" --unit-type "$unit_type" --tier "$TIER" --domain "$DOMAIN" --frontmatter-tier "$PLAN_TIER" --frontmatter-worker "$PLAN_WORKER" --cwd "$WORKING_DIR" --next-after "$MODEL_ID")`. If `$NEXT` non-empty → re-inspect the next member's engine (sidecar for `codex`, `Agent()` for `claude`), re-dispatch with `MODEL_ID=$NEXT` (re-resolve `$MODEL_ALIAS` via `forge-model-alias.js`; members with no alias are skipped automatically by `--next-after`). If exhausted (`$NEXT` empty — chain + category fallback consumed) → stop loop, surface to user. **Does not escalate tier (never a 4th layer — MEM001).** |
| `429` | "rate limit", "429", "quota" | Same cross-engine chain walk as `model_refusal` (`forge-routing.js ... --next-after "$MODEL_ID"`). Chain exhausted → stop loop, surface to user. This is a `status: blocked` classification (Layer 2) — distinct from a transient 429 raised as an `Agent()` exception, which the Retry Handler (Layer 1) already handles; do not double-recover the same failure across layers. |
| `400` | "400", "bad request", "invalid" | Same cross-engine chain walk as `model_refusal` (`forge-routing.js ... --next-after "$MODEL_ID"`). Chain exhausted → stop loop, surface to user. |
| `tooling_failure` | "command not found", "permission denied", "ENOENT" | Stop loop. Tell user: "Tooling error — check that required tools are installed and accessible." |
| `external_dependency` | "API", "network", "not running", "connection refused" | Stop loop. Tell user: "External dependency unavailable — resolve and re-run /forge-auto." |
| `unknown` | anything else | Stop loop. Surface raw blocker to user. |

Auto-recovery attempts (context_overflow, model_refusal, 429, 400) count as units toward `COMPACT_AFTER`.

**Before any auto-recovery retry:** If the failed unit spawned a background task (visible via `TaskList` with `status: in_progress` and no owner), call `TaskStop({ task_id: <id> })` to terminate it cleanly before dispatching the retry.

**Node Repair gate (Layer 3 — disjoint from Layers 1 and 2):** Applies ONLY when `unit_type == execute-task`. Trigger: `status: done` AND `S##-VERIFICATION.md` rows show must_have drift (artifacts `substantive:false` / `wired:false`, test-quality flags) OR `status: partial` with must_haves unmet. `Agent()` throws → Layer 1. `status: blocked` → Layer 2. Do NOT overlap. See full spec: `shared/forge-dispatch.md § Node Repair`.

1. **Read prefs via the canonical engine CLI** (single-knob convenience form — reads the jsonc catalog per layer; legacy Markdown without jsonc hard-stops — see `shared/forge-prefs-cutover.md`; NEVER a 3-file cascade node -e merge, MEM001 M005):
   ```bash
   REPAIR_BUDGET=$(node "$FORGE_SCRIPTS_DIR/forge-prefs.js" --resolved --key repair.budget --cwd "$WORKING_DIR" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const v=JSON.parse(d).value;process.stdout.write(Number.isInteger(v)&&v>=0?String(v):'2')}catch(e){process.stdout.write('2')}})")
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
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-decisions.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
DECISIONS_UNIT_ID="${M###:-${task_id:-}}"
if [ -n "$DECISIONS_UNIT_ID" ]; then
  printf '%s' "$key_decisions_json" | node "$FORGE_SCRIPTS_DIR/forge-decisions.js" --write --cwd "$WORKING_DIR"
else
  echo "[forge-auto] WARNING: no unit_id for decisions — skipping fragment write" >&2
fi
```

Where `key_decisions_json` is a JSON object `{ "unit_id": "$DECISIONS_UNIT_ID", "decisions": [...] }` built from the `key_decisions` field of the worker result. The global `.gsd/DECISIONS.md` is rebuilt from fragments during `complete-milestone` (forge-merger, S05). Do NOT write directly to `.gsd/DECISIONS.md` or any `M###-DECISIONS.md` file.

**d) Memory extraction** — first decide whether an extraction is worth a model call; only then dispatch `forge-memory` **in the background** (`run_in_background: true`) so the orchestrator can immediately dispatch the next unit without waiting. Rationale: memory extraction averages 20–40s, runs on Haiku (cheap + fast), and only affects the *next* selective injection.

Run the deterministic policy before preparing the agent prompt. It must emit a `memory-policy` event whether it extracts or skips; malformed policy output or an execution error is **fail-open** (`extract`) so cost optimization never loses durable knowledge:
```bash
MEMORY_POLICY=$(printf '%s' "$RESULT_BLOCK" | node "$FORGE_SCRIPTS_DIR/forge-cost-policy.js" memory \
  --unit-type "$unit_type" --cwd "$WORKING_DIR" --stdin 2>/dev/null) || MEMORY_POLICY='{"decision":"extract","reason":"policy-error"}'
```
If `MEMORY_POLICY.decision != "extract"`, append the event and skip this subsection; do not create a background agent. Otherwise append the event and continue below.

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
{follow-up lines, if any: "R# path:line — <objeção>" → item {I-id} (.gsd/items/)}

Próximo milestone: /forge-new-milestone <descrição>
```

The review digest is built from the `review` / `review-triage` events in `events.jsonl` (fallback: scan the `**Outcome:**` lines of each `{S##}-REVIEW.md`). Omit the section entirely when the milestone had zero objections.

**Fire push (call-site 3):** After printing the Final Report above, use Push helper with message `"Forge {RUN_ID} — milestone completa. {N} slices entregues."` (N = count of slices in the report table).

---

## Worker Prompt Templates

**Read `$FORGE_SHARED_DIR/forge-dispatch.md`** and use the worker prompt template for the current `unit_type`. Substitute all placeholders with actual values from the loaded context.

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

2. Write the per-run state `.gsd/milestones/{M###}/{M###}-STATE.md` (via `scripts/forge-state.js` — never the root `.gsd/STATE.md`) to point to this task with `phase: resume`, then run `node scripts/forge-dashboard.js --cwd "$WORKING_DIR"` to regenerate the dashboard.
3. Emit compact signal and stop.

On resume: STATE has `phase: resume` → read `continue.md`, inline into worker prompt with instruction "Resume from continue.md — skip completed work, start from Next Action."
