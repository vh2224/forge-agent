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

# ── Routing contract (multi-LLM) ────────────────────────────────────────────
# The rules the SESSION itself must obey — resolver decides the engine, sidecar
# gets what routes to it, fallback only via `worker-engine-fallback` — live in
# the project's instruction file, refreshed here so a stale copy never governs a
# run. Idempotent, splices only its own marked block, and prints only changes
# and refusals. Advisory: a failure here is reported, never a reason to stop.
node "$FORGE_SCRIPTS_DIR/forge-instructions.js" --sync --cwd "$WORKING_DIR" --no-create --quiet 2>&1 \
  || echo "⚠ routing contract sync falhou (advisory — o loop segue)"
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
  for f in .gsd/forge/runs/*.json; do
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
- `ISOLATION_MODE == worktree` → `WORKER_CWD = $WORKTREE_DIR` (bootstrap value). In a multi-repo workspace, once `$PLAN_PATH` exists the resolver selects the explicit primary repo and emits the complete `repo_roots`/`writable_roots` scope. A fully attributed cross-repo plan is supported; an ambiguous or incomplete plan is refused. `.gsd/**` artifacts ALWAYS stay under `$WORKING_DIR`.
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
# Single-parse (diagnóstico 2026-08-23): ONE emitter replaces the 19 per-field
# `node -e "JSON.parse(...)"` spawns this block used to run. The emitter sets:
# MODEL_ID, MODEL_ALIAS, TIER, REASON, DOMAIN_USED, ROUTE_SOURCE, CHAIN_LEN,
# ENGINE, DISPATCH_ENGINE, ENGINE_REASON, EFFORT, EFFORT_REASON, WORKERS_TIMEOUT,
# CODEX_MODEL, SIDECAR_MODEL, THINKING_HEADER, DOMAIN, PLAN_TIER, PLAN_WORKER,
# ROUTING_PRESENT, MODEL_APPLIED_JSON, unit_effort — all eval-safe single-quoted.
eval "$(printf '%s' "$ROUTE_JSON" | node "$FORGE_SCRIPTS_DIR/forge-dispatch-resolve.js" --shell-exports)"
# $ROUTE_JSON.chain carries forward unmodified — consumed by Branch C/D (codex-member cap) and by
# the Failure Taxonomy via `forge-routing.js ... --next-after "$MODEL_ID"` on model_refusal/429/400
# (walks the cross-engine chain → category fallback → ''), BEFORE any cross-tier escalation
# (context_overflow's ladder is separate — re-resolves THROUGH routing at the escalated tier).

# Shadowing warning (risk #3) — routing: configured but not applied (frontmatter/legacy won).
# $ROUTING_PRESENT comes from the contract itself — no second forge-routing.js spawn.
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

**Cross-run claim gate (step 1.7 — execute-task and review-fix; enforcement resolved BY THE MODULE from `parallelism.claim_gate`, `advisory` on debut):** If `unit_type == execute-task`, before dispatching, fence every task in `BATCH` against the write claims of every other active run sharing the same `CODE_DIR`. Authoritative spec: `shared/forge-claim-gate.md` — this block only **invokes** it; the decision table, the causes and the escalation procedure are formula-once there and are never restated here (S04-PLAN contract #1). This gate is distinct from the Overlap advisory right below: that one is a **post-work, pre-merge signal** (touch/overlap, advisory, never blocks); this one is a **pre-dispatch fence** (claim, enforcing, stops the unit).

Batch order (spec § Step 1 — fixed, not an implementation detail): (1) record the union of the whole ready `BATCH` first, as one claim, before evaluating anything; (2) evaluate per task, each against the counterpart universe; (3) drop every task whose decision is not `proceed`; (4) re-record the union of the survivors.

```bash
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-claim-gate.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")

# B2: --code-dir carries ONLY a value THIS dispatch already resolved. At this point (step 1.7 runs
# BEFORE Step 4's per-unit CODE_DIR resolution) only `shared` isolation already has one — WORKING_DIR
# itself. `worktree`/`branch` modes have not resolved the per-unit CODE_DIR yet, so the flag is
# omitted here on purpose (code_dir: null -> scope unknown -> fail closed, spec contract #7). NEVER
# $WORKTREE_DIR, NEVER a value derived from root+branch+isolation_mode (explicitly prohibited).
# Médio 2 (PR #110): the value travels QUOTED. `$GATE_CODE_DIR_FLAG` unquoted word-split a CODE_DIR
# containing a space, producing a truncated `code_dir` -> fabricated `different-code-dir` -> the pair
# left scope -> silent `proceed`. The canonical shape is the spec's own: `${CODE_DIR:+--code-dir "$CODE_DIR"}`.
GATE_CODE_DIR="" 
[ "$ISOLATION_MODE" = "shared" ] && [ -n "$CODE_DIR" ] && GATE_CODE_DIR="$CODE_DIR"

# Claim extraction, used by every union computation below. `--evaluate` and `--check-only` both carry
# `.claim` (the derived, normalised claim). FAIL CLOSED: a missing/invalid `.claim.paths` exits != 0
# and is NEVER swallowed into `[]` — an empty union is an absent fence, not a permissive one.
EXTRACT_CLAIM_PATHS='let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);if(!j.claim||!Array.isArray(j.claim.paths))throw new Error("resultado sem claim.paths");process.stdout.write(JSON.stringify(j.claim.paths))}catch(e){process.stderr.write("claim-gate: derivação do claim falhou — "+e.message+"\n");process.exit(1)}})'
UNION_ADD='const a=JSON.parse(process.argv[1]),b=JSON.parse(process.argv[2]);process.stdout.write(JSON.stringify(Array.from(new Set([...a,...b]))))'

# claim_union <plan path…> -> JSON array on stdout; exit != 0 on any failed derivation (fail closed).
claim_union() {
  local ACC="[]" P ONE
  for P in "$@"; do
    ONE=$(node "$FORGE_SCRIPTS_DIR/forge-claim-gate.js" --evaluate --plan "$P" \
      --run "$RUN_ID" --cwd "$WORKING_DIR" --json | node -e "$EXTRACT_CLAIM_PATHS") || return 1
    ACC=$(node -e "$UNION_ADD" "$ACC" "$ONE") || return 1
  done
  printf '%s' "$ACC"
}

# record_union <unit label> <JSON array of paths> — the visible fence, verified.
record_union() {
  local CSV; CSV=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).join(','))" "$2") || return 1
  node "$FORGE_SCRIPTS_DIR/forge-claim-gate.js" --claim-and-check --paths "$CSV" --source manual \
    --run "$RUN_ID" --unit "$1" ${GATE_CODE_DIR:+--code-dir "$GATE_CODE_DIR"} --ready-alternatives 0 \
    --cwd "$WORKING_DIR" --json > /dev/null
}

# 1. Union of the whole ready batch, recorded BEFORE any evaluation (visible fence, contract #6).
BATCH_IDS_CSV=$(node -e "process.stdout.write(process.argv.slice(1).join(','))" "${BATCH_TASK_IDS[@]}")
BATCH_UNION_PATHS=$(claim_union "${BATCH_PLAN_PATHS[@]}")   # BATCH_PLAN_PATHS = "$WORKING_DIR/${ENTRY_PLAN_PATH}" of every ENTRY
UNION_EXIT=$?
if [ "$UNION_EXIT" -ne 0 ] || ! record_union "BATCH:$BATCH_IDS_CSV" "$BATCH_UNION_PATHS"; then
  echo "⛔ Claim gate indisponível: a união do batch não pôde ser derivada/gravada — block/gate-unavailable. Nenhum dispatch." >&2
  # Sentinel + explicit drop (see the per-task branch below for why a comment is not enough here).
  CLAIM_GATE_DECISION=block
  CLAIM_GATE_CAUSE=gate-unavailable
  BATCH=()   # explicit drop — § Step 4 (checkpoint + deactivate). STOP.
fi

# 2. Evaluate per task with --check-only, --ready-alternatives = (tasks ready remaining in BATCH − 1).
#    --check-only (NOT --claim-and-check): it evaluates and emits the event while PRESERVING the union
#    recorded in step 1. `recordClaim` is a single slot, so a per-task record here would destroy the
#    fence two lines after writing it and each task would be confronted against itself only.
#    --wait is passed UNCONDITIONALLY: the module polls only when the decision is `block`, which is
#    behaviourally identical to "when the effective posture is block" — and the consumer must not
#    pre-read the posture pref (spec § Step 0).
REMAINING=$(( ${#BATCH[@]} - 1 ))
for ENTRY in "${BATCH[@]}"; do   # ENTRY = {id: T##, planPath}
  GATE_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-claim-gate.js" --check-only --wait \
    --run "$RUN_ID" --unit "execute-task/${ENTRY_ID}" --source plan-writes \
    --plan "$WORKING_DIR/${ENTRY_PLAN_PATH}" ${GATE_CODE_DIR:+--code-dir "$GATE_CODE_DIR"} \
    --ready-alternatives "$REMAINING" --cwd "$WORKING_DIR" --json)
  GATE_EXIT=$?
  REMAINING=$((REMAINING - 1))
  # Fail-closed (spec § Fail-closed): exit != 0 or non-JSON stdout -> block/gate-unavailable, LOUD.
  if [ "$GATE_EXIT" -ne 0 ] || ! printf '%s' "$GATE_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{JSON.parse(d);process.exit(0)}catch(e){process.exit(1)}})"; then
    echo "⛔ Claim gate indisponível (exit $GATE_EXIT) para ${ENTRY_ID} — tratando como block/gate-unavailable. Nenhum dispatch." >&2
    # Sentinel + explicit drop. NOT a bare comment (same rule as the isolation-setup precedent above):
    # in THIS skill a task stays in BATCH by default, so falling through a gate failure would DISPATCH.
    # The assignments below remove that default; the bold halt paragraph after this fence is what the
    # sentinel then makes reachable — it never depends on a comment to carry the halt.
    CLAIM_GATE_DECISION=block
    CLAIM_GATE_CAUSE=gate-unavailable
    SURVIVOR_IDS=(); SURVIVOR_PLAN_PATHS=(); BATCH=()   # explicit drop: no task survives an unavailable gate
    BATCH_CHANGED=1
    break   # § Step 4 (checkpoint + deactivate this run). STOP — never dispatch.
  fi
  # Médio 1 (PR #110): the keep/drop branch is a STATEMENT, never prose. A HEALTHY gate returning
  # `block` used to depend on the model reading a comment, and in THIS skill a task stays in BATCH by
  # default — so an unread comment DISPATCHED. `advised_action` (never `decision`) is what reaches the
  # dispatch: the module owns the advisory/enforcing axis (spec § Step 0, § Enforcement) and the
  # consumer never re-reads the pref. `decision` survives only to pick the message.
  ADVISED=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).advised_action||'')" "$GATE_JSON")
  DECISION=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).decision||'')" "$GATE_JSON")
  SUPPRESSED=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).suppressed_action||'')" "$GATE_JSON")
  case "$ADVISED" in
    dispatch) SURVIVOR_IDS+=("$ENTRY_ID"); SURVIVOR_PLAN_PATHS+=("$ENTRY_PLAN_PATH") ;;
    *)        BATCH_CHANGED=1 ;;   # includes empty/unknown advised_action — default DROP
  esac
  # The echo is keyed on the real verdict, and names the suppression when advisory let it through.
  # `[advisory]` means the fence computed a refusal and did NOT act on it — never silent.
  PREFIX=""; [ -n "$SUPPRESSED" ] && PREFIX="⚠ [advisory] "
  case "$DECISION" in
    proceed) ;;
    defer)   echo "${PREFIX}⤳ ${ENTRY_ID} adiada — claim overlap com run $(node -e "process.stdout.write(((JSON.parse(process.argv[1]).counterparts||[])[0]||{}).id||'?')" "$GATE_JSON")" ;;
    block)   echo "${PREFIX}⛔ ${ENTRY_ID} bloqueada — claim overlap. Sob enforcing o módulo já pollou até o teto (--wait). Se .escalation estiver setada -> § Step 4 (Account Handoff form)." ;;
    refuse)  echo "${PREFIX}⛔ ${ENTRY_ID} recusada — causa: $(node -e "process.stdout.write(JSON.parse(process.argv[1]).cause||'?')" "$GATE_JSON"). Não retentar (esperar não conserta)." ;;
  esac
  # Echo the 3 `.not_covered` boundaries once per slice (first execution of this gate in the session).
done

# 3./4. Drop non-proceed tasks and re-record the union of the SURVIVORS, so the persisted claim
# describes what will actually run (spec § Step 1, items 3 and 4). Leaving the original union in place
# would block counterparts on files this run already decided not to touch.
if [ "$BATCH_CHANGED" = "1" ]; then
  if [ ${#SURVIVOR_IDS[@]} -eq 0 ]; then
    # ZERO SURVIVORS — named, not implicit: nothing will be dispatched this pass, so this run must hold
    # NO fence. The claim is cleared (S03 primitive), and the loop moves to the next unit / stops per
    # the decision that emptied the batch.
    node "$FORGE_SCRIPTS_DIR/forge-write-claim.js" --clear "$RUN_ID" --cwd "$WORKING_DIR" \
      || echo "⚠ claim do batch vazio não pôde ser liberado — a cerca da união segue persistida" >&2
    echo "⤳ Nenhuma task sobreviveu ao claim gate — claim liberado, nada despachado neste passe."
  else
    SURVIVOR_IDS_CSV=$(node -e "process.stdout.write(process.argv.slice(1).join(','))" "${SURVIVOR_IDS[@]}")
    SURVIVOR_UNION_PATHS=$(claim_union "${SURVIVOR_PLAN_PATHS[@]}")
    UNION_EXIT=$?
    if [ "$UNION_EXIT" -ne 0 ] || ! record_union "BATCH:$SURVIVOR_IDS_CSV" "$SURVIVOR_UNION_PATHS"; then
      echo "⛔ Claim gate indisponível: a união dos sobreviventes não pôde ser regravada — block/gate-unavailable." >&2
      # Sentinel + explicit drop (see the per-task branch above for why a comment is not enough here).
      CLAIM_GATE_DECISION=block
      CLAIM_GATE_CAUSE=gate-unavailable
      BATCH=()   # explicit drop — § Step 4 (checkpoint + deactivate). STOP.
    fi
  fi
fi
```

**Escalation (`wait-ceiling`/`defer-cap`, or any `block`/`refuse` that stops a run):** follow spec § Step 4 in the **Account Handoff Procedure** form (below) — checkpoint (`continue.md`), deactivate this run (same deactivation the pause path uses — the event was already written by `--claim-and-check`, do not hand-write a second line), emit the actionable message naming the counterpart run, cause, paths and the three legitimate exits from the spec. **The loop STOPS, it never dispatches** — this is the same CRITICAL rule as the isolation-setup and Account Handoff failures above: when dispatch cannot happen, stop and surface, executing inline is never a fallback.

**Overlap advisory (before complete-slice):** grave o toque desta run e confronte com as demais runs ativas — o sinal existe para ser visto **antes do merge**.
```bash
node "{WORKING_DIR}/scripts/forge-touch.js" --record "{RUN_ID}" --cwd "{WORKING_DIR}" || true
node "{WORKING_DIR}/scripts/forge-overlap.js" --check --cwd "{WORKING_DIR}" || true
```
Imprima o veredicto ao operador e **siga**. O sinal é advisory: **nunca** bloqueia o `complete-slice`, nunca ordena runs, nunca faz merge. Verdict `inconclusive` significa "não havia o que comparar" e **não** deve ser lido como limpo.

**Review gate (before complete-slice):** If `unit_type == complete-slice`, run the **dialectic review** on the slice diff BEFORE dispatching `forge-completer` (the run branch `forge/{run}` is still unmerged here — it stays unmerged until the operator integrates it — so the diff is intact). This is the challenger × defender confrontation:

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
   - **CONCEDED items → fix now (Step 7a):** resolve `RF_ALIAS=$(node "$FORGE_SCRIPTS_DIR/forge-dispatch-resolve.js" --unit-type review-fix --cwd "$WORKING_DIR" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).alias||'')}catch(e){}})")`; **before dispatching**, run the cross-run claim gate exactly as `shared/forge-review.md § Step 7a` prescribes (it in turn references `shared/forge-claim-gate.md § Step 1` for the `--conceded` claim derivation — the path derivation is not repeated here); dispatch `review-fix/{S##}` with `model: '{RF_ALIAS}'` only when non-empty and the gate decision is `proceed`.
   - **OPEN items → posture (Step 7b):** `ask_in_auto: defer` (default) marks each `**Decisão:** deferido → triagem no fim da milestone` and continues WITHOUT pausing — they are guaranteed to surface at the milestone-final triage gate below. `pause` (opt-in) asks per-slice via `AskUserQuestion`.
   - Append the `review` event to `events.jsonl` (Step 8).
4. The gate **never blocks** — any `Agent()` throw is recorded and the loop proceeds to `complete-slice` regardless.
   - On throw, follow `shared/forge-review.md § Agent unavailability (review-agent-unavailable)`: retry first via `shared/forge-dispatch.md § Retry Handler`; if the agent stays unavailable, emit `review-agent-unavailable` (`review-advocate-unavailable` | `review-challenger-unavailable`) — **never** the CRITICAL failure path of Step 5 below.

   > **REGRA CRÍTICA:** o orquestrador NUNCA produz veredito de review no lugar de um agente indisponível — nem defesa, nem réplica, nem julgamento de objeção alheia. A única ação permitida é registrar a indisponibilidade e escalar ao humano (interativo) ou deferir à triagem final (auto).

   - **Política deste modo (`MODE = auto`):** advogado indisponível — **só depois** de a salvage do `DEFENSE_FILE` não render nenhum veredito (`shared/forge-review.md § Step 3`) — ⇒ objeções ficam `open` cruas, Rebuttal é PULADO, e cada uma é deferida (`**Decisão:** deferido → triagem no fim da milestone`) — o loop **não pausa**, e a triagem final da milestone as apresenta ao operador. Challenger indisponível ⇒ `{S##}-REVIEW.md` mínimo registrando a indisponibilidade (proibido renderizar como limpo — ausência de review não é aprovação) e segue para `complete-slice`.

> Fires ONLY when the derived unit is `complete-slice`. Boundary is per-slice; standalone `/forge-task` keeps its own step-5.5 review. After the gate, dispatch `forge-completer` normally.

**Slice git guard (around complete-slice):** `complete-slice` never integrates a branch — no unit of the loop does; integration is the operator's act on the delivered `forge/{run}` branch (`agents/forge-completer.md § Git boundary — complete-slice`). Snapshot the checkout **before** dispatching, verify **after** the worker returns:

```bash
# before Agent("forge-completer", ...)
node "$FORGE_SCRIPTS_DIR/forge-slice-git-guard.js" --snapshot --cwd "$CODE_DIR" --gsd-dir "$WORKING_DIR/.gsd" --run "$RUN_ID" --unit "complete-slice/{S##}" > /dev/null
# after it returns
node "$FORGE_SCRIPTS_DIR/forge-slice-git-guard.js" --verify --cwd "$CODE_DIR" --gsd-dir "$WORKING_DIR/.gsd" --run "$RUN_ID" --unit "complete-slice/{S##}"
```

The snapshot is written to `.gsd/forge/` on purpose — shell variables do not survive between Bash calls. `--gsd-dir` and `--run` are **not optional here** (item #112): `--cwd` is the `CODE_DIR`, so without `--gsd-dir` the baseline lands inside the worktree — against the `.gsd/**`-stays-in-the-workspace convention, and as an untracked file that can make `cleanupWorktreeOne` report `skipped (dirty)`; and without `--run` two runs closing the same `{S##}` in one workspace share a file, so one run's baseline answers for the other. The baseline is **spent by the verify** — call `--snapshot` immediately before every dispatch, never once for several verifies, or the second one reports `inconclusive` (never `clean`). Exit `3` = violation (moved checkout, advanced default branch, or new merge commit): print it LOUDLY, append a `slice-git-violation` event, and **suppress any push for the rest of this run** regardless of `auto_push` — nothing is pushed yet, so `git reset --hard` on the default branch still recovers it. A violation is one of the few conditions worth surfacing mid-loop: an incomplete milestone on the default branch, or a checkout left outside the isolation branch, corrupts every subsequent slice. Verdict `inconclusive` means nothing was measurable and **must not** be read as clean. The guard never blocks the loop; it reports.

**Review triage gate (before complete-milestone):** If `unit_type == complete-milestone`, run the **milestone-final triage** (`shared/forge-review.md § Step 9`) BEFORE dispatching `forge-completer` — i.e., before the milestone is finalized "de fato" (final close-out, LEDGER entry, cleanup):

1. Scan all `{S##}-REVIEW.md` under `.gsd/milestones/{M###}/slices/*/` for pending items: `Decisão: deferido → triagem no fim da milestone`, `Correção: falhou — deferida para triagem final`, or legacy `Decisão: deferido (auto-mode)`.
2. Zero pending → skip silently and dispatch `complete-milestone` normally.
3. Otherwise **fire push (call-site 2):** use Push helper with message `"Forge {RUN_ID} — {N} item(ns) de review aguardam sua triagem antes de fechar a milestone."` (N = count of pending items). Then print the digest table (slice · R# · path:line · objeção · status) and triage each item via `AskUserQuestion` (batched up to 4, header `Review M###`): `Manter abordagem atual` / `Refatorar agora` / `Criar follow-up`.
4. `Refatorar agora` items → ONE `review-fix/{M###}-triage` dispatch to `forge-executor` (nothing has been integrated at this point — the fix commits on the still-checked-out `forge/{run}` branch). **Before dispatching**, run the cross-run claim gate exactly as `shared/forge-review.md § Step 9` prescribes (it references `shared/forge-claim-gate.md § Step 1` for the `--conceded` claim derivation of the triage items — not repeated here); dispatch only when the gate decision is `proceed`. Write every decision back into the R#'s `**Decisão:**` line; `Criar follow-up` items create an item per `shared/forge-review.md § Item capture` (source `review/{S##}/{R#}`, status `inbox`, provenance from the digest row) and append ONLY the pointer line `- {I-id} — {title}` to `.gsd/KNOWLEDGE.md § Review follow-ups` (create the section if missing — this survives `milestone_cleanup`; the item is the single destination for full content).
5. Append the `review-triage` event to `events.jsonl`. The triage **never blocks** the milestone close-out.

> **This gate is the explicit exception to the AUTONOMY RULE** — at this point every slice is done; asking the operator here is the designed arbitration moment that `defer` postponed to. It does not fire on pause/blocked/partial exits — only when the derived unit is `complete-milestone`.

**Plan-check gate (between plan-slice and first execute-task):**

After a successful `plan-slice` unit, before dispatching the first `execute-task` for the same slice, run the plan-check gate:

1. **Read `plan_check.mode` via the canonical engine CLI** (single-knob convenience form — reads the jsonc catalog per layer; legacy Markdown without jsonc hard-stops — see `shared/forge-prefs-cutover.md`; NEVER a 3-file cascade node -e merge, MEM001 M005):
   ```bash
   PLAN_CHECK_MODE=$(node "$FORGE_SCRIPTS_DIR/forge-prefs.js" --resolved --key plan_check.mode --cwd "$WORKING_DIR" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{let m=String(JSON.parse(d).value||'').toLowerCase();process.stdout.write((m==='advisory'||m==='blocking'||m==='disabled')?m:'disabled')}catch(e){process.stdout.write('disabled')}})")
   ```
   Store as `PLAN_CHECK_MODE` (default `disabled` on absence/parse error — flipped 2026-08-23: 21/21 measured advisory runs never changed the flow; `advisory`/`blocking` are opt-in).

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
2. Run `forge-plan-checker` per `plan_check.mode` (default `disabled` — the gate above skips the dispatch entirely unless the operator opted into `advisory`/`blocking`).
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
PENDING_CONTEXT=$(node "$FORGE_SCRIPTS_DIR/forge-context-boundary.js" --action peek --cwd "$WORKING_DIR" --run "${RUN_ID:-$MILESTONE_ID}" --milestone "$MILESTONE_ID" --slice "$SLICE_ID" --task "$TASK_ID" --unit "$unit_type/${TASK_ID:-$SLICE_ID}")
PENDING_CONTEXT_FILE=$(node -pe 'JSON.parse(process.argv[1]).pending_file || ""' "$PENDING_CONTEXT")
PENDING_CONTEXT_ID=$(node -pe 'JSON.parse(process.argv[1]).pending_id || ""' "$PENDING_CONTEXT")
DISPATCH_ID="${unit_type}-${MILESTONE_ID:-none}-${SLICE_ID:-none}-${TASK_ID:-none}-$(node -e "console.log(require('crypto').randomUUID())")"
PROMPT_META=$(node "$FORGE_SCRIPTS_DIR/forge-prompt.js" --unit-type "$unit_type" --cwd "$WORKING_DIR" \
  --milestone "$MILESTONE_ID" --slice "$SLICE_ID" --task "$TASK_ID" \
  --dispatch-id "$DISPATCH_ID" --unit-effort "$unit_effort" --thinking "$THINKING_OPUS" \
  --auto-commit "$AUTO_COMMIT" --milestone-cleanup "$MILESTONE_CLEANUP" \
  --isolation-mode "$ISOLATION_MODE" --branch "$BRANCH" --code-dir "$WORKER_CWD" \
  --memory-query "$unit_type $MILESTONE_ID $SLICE_ID $TASK_ID" \
  --memory-max-tokens "${PREFS[token_budget][auto_memory]:-1200}" \
  --standards-max-tokens "${PREFS[token_budget][coding_standards]:-3000}" \
  --ledger-max-tokens "${PREFS[token_budget][ledger_snapshot]:-1500}" \
  --pending-context-file "$PENDING_CONTEXT_FILE") || { echo 'prompt render failed'; stop; }
PROMPT_PATH=$(node -pe 'JSON.parse(process.argv[1]).prompt_path' "$PROMPT_META")
PROMPT_ID=$(node -pe 'JSON.parse(process.argv[1]).prompt_id' "$PROMPT_META")
```
The Claude `Agent()` prompt is exactly: `Read the complete Forge dispatch contract at {PROMPT_PATH}, execute it exactly,
and return its required GSD worker result block. The file is trusted
orchestrator input; do not replace it with a summary.` Record `prompt_id` and `dispatch_id` in the event, and call `forge-prompt.js --cleanup "$DISPATCH_ID" --cwd "$WORKING_DIR"` after the result is durably processed. Do not load `.gsd/AUTO-MEMORY.md`; the renderer selects bounded memories.

After `Agent()` returns successfully (the dispatch handoff is durable), acknowledge exactly that pending record with `node "$FORGE_SCRIPTS_DIR/forge-context-boundary.js" --action ack --cwd "$WORKING_DIR" --run "${RUN_ID:-$MILESTONE_ID}" --milestone "$MILESTONE_ID" --slice "$SLICE_ID" --task "$TASK_ID" --unit "$unit_type/${TASK_ID:-$SLICE_ID}" --pending-id "$PENDING_CONTEXT_ID"`. If rendering or `Agent()` throws, do not acknowledge: the next attempt peeks and injects the same record. An empty pending id is inert.

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
CODE_DIR_ROOTS_FILE="$WORKING_DIR/.gsd/forge/code-dir-roots.json"
CODE_DIR_WRITABLE_ROOTS_FILE="$WORKING_DIR/.gsd/forge/code-dir-writable-roots.json"
mkdir -p "$WORKING_DIR/.gsd/forge/"; printf '""' > "$CODE_DIR_HINT_FILE"; printf '[]' > "$CODE_DIR_ROOTS_FILE"; printf '[]' > "$CODE_DIR_WRITABLE_ROOTS_FILE"
if [ "$ISOLATION_MODE" = "worktree" ] && [ -n "$PLAN_PATH" ] && [ -n "$ISO_RESULT" ]; then
  CD_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-code-dir.js" --resolve \
    --iso-result "$ISO_RESULT" --plan "$WORKING_DIR/$PLAN_PATH" --cwd "$WORKING_DIR"); CD_RC=$?
  CD_JSON=${CD_JSON:-'{}'}
  CODE_DIR_STATUS=$(node -e "process.stdout.write((JSON.parse(process.argv[1]).status)||'shared')" "$CD_JSON")
  UNIT_CODE_DIR=$(node -e "process.stdout.write((JSON.parse(process.argv[1]).code_dir)||'')" "$CD_JSON")
  CODE_DIR_REASON=$(node -e "process.stdout.write((JSON.parse(process.argv[1]).reason)||'')" "$CD_JSON")
  CODE_DIR_MULTI_ROOT=$(node -e "process.stdout.write((JSON.parse(process.argv[1]).multi_repo_root)||'')" "$CD_JSON")
  CODE_DIR_HINT=$(node -e "process.stdout.write((JSON.parse(process.argv[1]).hint)||'')" "$CD_JSON")
  node -e "const fs=require('fs'),o=JSON.parse(process.argv[1]);fs.writeFileSync(process.argv[2],JSON.stringify(o.repo_roots||[]));fs.writeFileSync(process.argv[3],JSON.stringify(o.writable_roots||[]))" "$CD_JSON" "$CODE_DIR_ROOTS_FILE" "$CODE_DIR_WRITABLE_ROOTS_FILE"
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

**Branch C / Branch D — sidecar (`DISPATCH_ENGINE == codex`): executable spec loaded on demand.**

The full executable branch text (state machine, BLOCKER contract mechanics, Layer-1 transient
retry, Layer-2 chain walk, orphan detection, fallback accounting) lives in
**`shared/forge-sidecar-auto.md`** — read it NOW (`shared/forge-sidecar-auto.md` if it exists in
the working repo, else `${FORGE_HOME:-~/.forge-agent}/shared/forge-sidecar-auto.md`), follow it
exactly, and return to the **Single-task flow** below only where that spec says to (Claude
fallback / chain-advance to a claude member). Canonical contract (authoritative, unchanged):
`shared/forge-dispatch.md § Worker Engine Routing`.

Non-negotiables that bind even before the spec is read (routing contract, CLAUDE.md):
- NEVER execute the unit inline in the main context, and NEVER substitute
  `Agent("forge-executor")`/`Agent("forge-planner")` for a resolved codex route.
- The ONLY legitimate degradation to Claude is the named `worker-engine-fallback` event written
  to `.gsd/forge/events.jsonl` by the spec's Layer-2 — fallback without the event is silent bypass.
- If neither spec path is readable, that is a broken installation: STOP the run and surface it —
  never improvise the branch from memory.

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

**Selective memory injection** — one call to the store's own selector (budget-aware, unit-type-aware keyword scoring), then record which facts were actually injected so ranking learns from real use:

```bash
# --select ranks by (keyword overlap × category preference × confidence·max(1,hits))
# under a token budget. --query-file feeds the unit's plan as the query; fall back
# to --text "" when no plan exists for this unit type.
_mem_json=$(node "$FORGE_SCRIPTS_DIR/forge-memory.js" --select --unit-type "$unit_type" ${PLAN_PATH:+--query-file "$PLAN_PATH"} --limit 8 --max-tokens 2000 --cwd "$WORKING_DIR" 2>/dev/null || echo '{}')
RELEVANT_MEMORIES=$(printf '%s' "$_mem_json" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(j.markdown&&j.markdown.trim()?j.markdown:'(none)')}catch(e){process.stdout.write('(none)')}}")
# Close the usage loop: one kind:'hit' stat per injected fact (measured before this
# existed: every fact in the store carried hits:0 — ranking had no feedback signal).
# Advisory — never blocks the dispatch.
printf '%s' "$_mem_json" | node "$FORGE_SCRIPTS_DIR/forge-memory.js" --hit --cwd "$WORKING_DIR" >/dev/null 2>&1 || true
```

**Fallback:** if the fragment store is empty/absent (`--select` returned no entries and `.gsd/memory/` does not exist — pre-fragment-store workspace), fall back to `ALL_MEMORIES` (loaded from `.gsd/AUTO-MEMORY.md` at Load context) filtered to ≤8 entries sharing keywords with the plan. No hits are recorded on the fallback path (nothing owns the facts).

If nothing matches in either path: set `RELEVANT_MEMORIES` to `(none)`.

Store as `RELEVANT_MEMORIES` and use in the worker prompt `## Project Memory` section instead of the raw full file.

> For human-readable consolidation of the fragment store into `.gsd/AUTO-MEMORY.md`, run `/forge-doctor --regen-projection` (uses `forge-memory.js --write-all` / `forge-projection` internally). The monolith is no longer the runtime source of truth (D9).

**Heartbeat — record active worker** before dispatching (M005+: writes via forge-runs.js when multi-run, legacy auto-mode.json fallback):
```bash
_now=$(node -e "process.stdout.write(String(Date.now()))")
if [ -n "$RUN_ID" ]; then
  # Multi-run: forge-runs.update bumps runs/{id}.json + auto-refreshes legacy alias
  node "$FORGE_SCRIPTS_DIR/forge-runs.js" --update "$RUN_ID" --json "{\"worker\":\"UNIT_TYPE/UNIT_ID\",\"worker_slice\":\"SLICE_ID\",\"worker_started\":$_now,\"last_heartbeat\":$_now,\"active\":true}" > /dev/null
else
  # Legacy single-run path
  _sa=$(cat .gsd/forge/auto-mode-started.txt 2>/dev/null || node -e "process.stdout.write(String(Date.now()))")
  echo "{\"active\":true,\"started_at\":$_sa,\"last_heartbeat\":$_now,\"worker\":\"UNIT_TYPE/UNIT_ID\",\"worker_slice\":\"SLICE_ID\",\"worker_started\":$_now}" > .gsd/forge/auto-mode.json
fi
```
Replace `UNIT_TYPE/UNIT_ID` with the actual values (e.g., `execute-task/T01`), and `SLICE_ID` with the slice this unit belongs to (e.g., `S01`) — use `null` (unquoted) when the unit has no slice (`plan-milestone`, `research-milestone`, a loose task). `worker` carries no slice axis, so **this** field is the only thing that tells the evidence log which slice a tool call belonged to (S01/T02). Multi-run uses each run's own `runs/{id}.json` as source-of-truth; `auto-mode.json` is automatically synced to oldest-active by `forge-runs.refreshLegacyAlias` (eliminates cross-tab race). Legacy mode preserved for pre-M004 workspaces.

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
  node "$FORGE_SCRIPTS_DIR/forge-runs.js" --update "$RUN_ID" --json "{\"worker\":null,\"worker_slice\":null,\"worker_started\":null,\"last_heartbeat\":$_now,\"active\":true}" > /dev/null
else
  _sa=$(cat .gsd/forge/auto-mode-started.txt 2>/dev/null || node -e "process.stdout.write(String(Date.now()))")
  echo "{\"active\":true,\"started_at\":$_sa,\"last_heartbeat\":$_now,\"worker\":null,\"worker_slice\":null}" > .gsd/forge/auto-mode.json
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
  node "$FORGE_SCRIPTS_DIR/forge-runs.js" --update "$RUN_ID" --json "{\"worker\":\"BATCH:$workers_csv\",\"worker_slice\":\"SLICE_ID\",\"worker_started\":$_now,\"last_heartbeat\":$_now,\"active\":true}" > /dev/null
else
  _sa=$(cat .gsd/forge/auto-mode-started.txt 2>/dev/null || node -e "process.stdout.write(String(Date.now()))")
  echo "{\"active\":true,\"started_at\":$_sa,\"last_heartbeat\":$_now,\"worker\":\"BATCH:$workers_csv\",\"worker_slice\":\"SLICE_ID\",\"worker_started\":$_now}" > .gsd/forge/auto-mode.json
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
  node "$FORGE_SCRIPTS_DIR/forge-runs.js" --update "$RUN_ID" --json "{\"worker\":null,\"worker_slice\":null,\"worker_started\":null,\"last_heartbeat\":$_now,\"active\":true}" > /dev/null
else
  _sa=$(cat .gsd/forge/auto-mode-started.txt 2>/dev/null || node -e "process.stdout.write(String(Date.now()))")
  echo "{\"active\":true,\"started_at\":$_sa,\"last_heartbeat\":$_now,\"worker\":null,\"worker_slice\":null}" > .gsd/forge/auto-mode.json
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

**5.0 — Contract miss gate (Layer 0), BEFORE any status parsing.** Never eyeball the return for a block; classify it:

```bash
CLASSIFY=$(node "$FORGE_SCRIPTS_DIR/forge-worker-result.js" --classify --inline "$result")
SHAPE=$(printf '%s' "$CLASSIFY" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).shape")
```

`SHAPE == complete` → fall through to the normal parse below, unchanged. Anything else (`absent` / `status-missing` / `empty`) → run the **recovery ladder** in `shared/forge-dispatch.md § Missing worker result (contract miss)`: salvage from disk → resume the same subagent (`SendMessage`, when present) → re-dispatch → `blocked`. That section is canonical for the ladder, the salvage bases, the repair wording and the `contract_miss` event; **do not restate any of them here**. Salvage invocation for this boundary:

```bash
SALVAGE=$(node "$FORGE_SCRIPTS_DIR/forge-worker-result.js" --salvage \
  --unit "execute-task/{T##}" --plan "$PLAN_PATH" \
  --summary "$WORKING_DIR/.gsd/milestones/{M###}/slices/{S##}/tasks/{T##}/{T##}-SUMMARY.md" \
  --events "$WORKING_DIR/.gsd/milestones/{M###}/{M###}-events.jsonl" \
  --events "$WORKING_DIR/.gsd/forge/events.jsonl" \
  --code-dir "$CODE_DIR" --since "$START_SHA" --vcs "${DISPATCH_VCS:-git}")
```

A rung that yields a status hands back a `recovered.block` — parse **that** with the rows below and continue the loop normally; the run is not stopped for a contract miss that was recovered. **This gate never pauses to ask the user** (AUTONOMY RULE intact): every rung is mechanical, and rung 4 is the existing `blocked` path with its existing item capture. `agent_id` for the resume rung, when needed, comes from the last `phase: "escaped"` line in `.gsd/forge/contract-miss.jsonl`.

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

**e-release) Ask for the claim release (unit boundary)** — runs after re-injection, before progress
tracking. Applies to units that went through the claim gate of step 1.7 (`execute-task`,
`review-fix`); skip otherwise.

Run the **canonical release invocation** of `shared/forge-claim-gate.md § Release lifecycle`
verbatim, with `RUN_ID`, `WORKING_DIR` and (per the B2 rule stated there) `CODE_DIR` bound to this
dispatch's values. The mechanisms, the two probes, the TTL rule and the flag set live in that
section — do not restate them here, and do not add flags it does not list.

**Fail-soft, by decision.** Asking for a release is *measuring*; a measurement that cannot be taken
leaves the claim standing, which is the safe side. A non-zero exit, invalid JSON or a refused
request (`held: true`) echoes one line and the loop **continues** — it never stops the loop, never
deactivates the run and never escalates. This is the deliberate opposite of the pre-dispatch gate of
step 1.7, which is enforcing; the reason for the asymmetry is written in the spec section above.

The `claim-release` event is written **by the module**, not narrated here
(`shared/forge-dispatch.md § Event claim-release`).

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

Entregável: branch `forge/{run}` — pronta para push e PR.
Pronta para PR — a integração na branch default é do OPERADOR; o loop nunca integra.

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
