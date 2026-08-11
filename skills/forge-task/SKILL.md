---
name: forge-task
description: "Task autonoma sem milestone — brainstorm, discuss, plan, execute."
allowed-tools: Read, Write, Edit, Bash, Agent, Skill, AskUserQuestion, TaskCreate, TaskUpdate, TaskList, TaskStop, SendMessage, WebSearch, WebFetch
---

## Provider-neutral loop authority (S07) — does NOT govern this skill

Read `shared/forge-lifecycle.md § milestone-scoped`. The S07 loop authority
(`scripts/forge-long-workflow-adapter.js`, `--mode auto|task`) is **milestone-
scoped in both modes**: `task` there means a milestone unit with a one-unit
budget, not a second selection domain. A standalone task — everything this skill
creates, under `.gsd/tasks/{TASK_ID}/` — has no STATE file and no roadmap, and
`forge-orchestrate` has no branch that can select it. **So this skill owns its
own lifecycle, start to finish.** Dispatch authority for S07 lives in
`/forge-auto` and `/forge-next`, never here.

That is a declared boundary, not an omission to route around:

- **Never pass a milestone id to reach a dispatch.** Measured: the adapter then
  selects *that milestone's* next unit and commits a lease + transaction against
  it — unrelated work dispatched, and a durable trace left on someone else's run.
- Calling `--mode task --command next` **without** a milestone returns
  `outcome: blocked`, `reason_code: task-scope-unsupported`, `action: stop`,
  snapshot unchanged. That is the layer answering correctly. Treat it as
  confirmation to continue with the body below — not as an error to retry, and
  not as a cue to improvise a milestone.

The provider rules that still bind the body are S06's, not S07's: run the task on
one explicitly resolved host, and never infer a worker/model or silently fall
back to another host. Any future dispatch path for standalone tasks has to be
built in `forge-orchestrate` (task-shaped state + selector + lease keying) and
declared here — never simulated from this prose.

## Parse arguments

From `$ARGUMENTS`:
- If contains `--resume <id>` (aceita `T-<ts>-<slug>` ou o legado `TASK-###`) → **RESUME MODE**: set `TASK_ID` to that ID, skip init
- `--attach <run-id>` → `ATTACH_RUN = <run-id>`. A task passa a operar dentro do worktree desse run, na branch dele.
- `--skip-brainstorm` or `-skip-brainstorm` → `SKIP_BRAINSTORM = true`
- `--skip-research` or `-skip-research` → `SKIP_RESEARCH = true`
- Remaining text after all flags → if it matches the item-ID shape and nothing else (`^I-\d{1,14}(-[a-z0-9-]*)?$`, per `shared/forge-items-readback.md § Detecção de referência`) → `ITEM_REF = <that text>` (`TASK_DESCRIPTION` stays unset for now — it is derived from the item's title in `## Item intake`). Otherwise → `TASK_DESCRIPTION = <that text>` exactly as today.

If both `TASK_DESCRIPTION` and `ITEM_REF` are empty AND not resume mode → stop and tell the user:
> Descreva a task: `/forge-task <descrição>`
> Ou aponte para um item: `/forge-task <item-id>`
> Para pular brainstorm: `/forge-task --skip-brainstorm <descrição>`

If `--attach` has no value, stop and tell the user:
> Informe o run a anexar: `/forge-task --attach <run-id> <descrição>`

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

Read:
1. First 40 lines of `.gsd/AUTO-MEMORY.md` (skip silently if missing)
2. `.gsd/CODING-STANDARDS.md` (skip silently if missing)

**Resolve PREFS via the canonical engine CLI (ONE call — never a 3-file md merge in-context).** The S01 engine (`scripts/forge-prefs.js`) reads the jsonc catalog per layer; legacy Markdown without jsonc hard-stops — see `shared/forge-prefs-cutover.md`. It applies the exact same user-global → repo-shared → local-personal precedence (last wins) that the old inline prose described. Do NOT read/merge `~/.claude/forge-agent-prefs.jsonc` + `.gsd/claude-agent-prefs.jsonc` + `.gsd/prefs.local.jsonc` by hand — that is exactly what the CLI does. See `shared/forge-dispatch.md § Per-unit prefs resolution` for the canonical helper.

```bash
if [ -f "scripts/forge-prefs.js" ]; then
  FORGE_SCRIPTS_DIR="scripts"
else
  FORGE_SCRIPTS_DIR="${FORGE_HOME:-$HOME/.forge-agent}/scripts"
fi
# Same resolution for the shared reference specs — the installer COPIES shared/*.md
# into ${FORGE_HOME:-$HOME/.forge-agent}/shared/, so a bare relative `shared/X.md`
# is a dead path in every consumer project.
if [ -f "shared/forge-review.md" ]; then
  FORGE_SHARED_DIR="shared"
else
  FORGE_SHARED_DIR="${FORGE_HOME:-$HOME/.forge-agent}/shared"
fi
WORKING_DIR="${WORKING_DIR:-$(pwd)}"
PREFS_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-prefs.js" --resolved --explain --cwd "$WORKING_DIR")
PREFS_EXIT=$?
```

**Path convention — binding for the whole skill.** Every reference below written as
`shared/<name>.md` MUST be read from `$FORGE_SHARED_DIR/<name>.md`. `shared/` in prose is
the canonical *name* of the spec, never a literal path to open. A spec you could not open
is a hard stop for the step that needs it — never a cue to improvise the procedure from
memory. Same rule for `scripts/<name>.js` → `$FORGE_SCRIPTS_DIR/<name>.js`.

**Loud-stop on parse error (M008-CONTEXT decision #2 — ALWAYS stop on a broken config, NEVER degrade to defaults silently):**
```
If PREFS_EXIT != 0:
  - `$PREFS_JSON` carries `errors[]` ({file,line,message}) on stdout; the CLI already printed a
    human message + "corrija o JSONC…" hint on stderr.
  - Stop this task run (`/forge-task` is single-shot — no auto-mode to deactivate).
  - Surface to the operator: arquivo + linha + como-corrigir (from errors[]).
  - When any `errors[]` entry has `code == "legacy-md-without-jsonc"`, re-emit that entry's
    `errors[].message` VERBATIM, without paraphrasing. Use `shared/forge-prefs-cutover.md § Canonical message`
    as the message contract; STOP without retry or handoff loops (headless-safe).
  - Do NOT proceed on EFFORT_OPUS=medium / WORKERS_ENGINE=claude / any fallback value.
```
`warnings[]` (advisory schema validation, `⚠` on stderr) do NOT stop — only exit≠0 halts.

The resolved object is `{ok, prefs, errors[], warnings[], layers}`. Throughout this skill **`PREFS` = `.prefs`** from this one call. Store as: `PREFS`, `TOP_MEMORIES`.

**CODING_STANDARDS section extraction:**
- `CS_LINT` ← `## Lint & Format Commands` section
- `CS_STRUCTURE` ← `## Directory Conventions` + `## Asset Map` + `## Pattern Catalog` sections
- `CS_RULES` ← `## Code Rules` section
If missing, all section variables are `"(none)"`.

**Resolve the plan/discuss-phase effort off the resolved `PREFS` object** (default identical to the old inline snippet). The **executor** effort is NO longer static here — it is resolved dynamically (with model-cap clamp) by `forge-dispatch-resolve.js` in Step 5 (`$EFFORT`):
- `EFFORT_OPUS = PREFS.effort.plan or "medium"`

Initialize: `session_units = 0`, `COMPACT_AFTER = PREFS.compact_after || 10`
(0 or "unlimited" in PREFS disables the compact signal entirely)

---

## Item intake (skip if no ITEM_REF)

Rules are canonical in `shared/forge-items-readback.md` — this block only wires them; it never restates the resolver contract, the provenance block shape, or the failure posture. Runs BEFORE `TASK_DESCRIPTION` is consumed by `forge-ids.js --new-task` (Multi-run resolution + TASK_ID, next section).

```bash
if [ -n "$ITEM_REF" ]; then
  if [ -f "scripts/forge-items.js" ]; then
    FORGE_SCRIPTS_DIR="scripts"
  else
    FORGE_SCRIPTS_DIR="${FORGE_HOME:-$HOME/.forge-agent}/scripts"
  fi
  WORKING_DIR="${WORKING_DIR:-$(pwd)}"

  ITEM_ID=$(node "$FORGE_SCRIPTS_DIR/forge-items.js" --resolve "$ITEM_REF" --cwd "$WORKING_DIR")
  RESOLVE_RC=$?
  if [ "$RESOLVE_RC" -ne 0 ]; then
    echo "$ITEM_ID" >&2
    exit "$RESOLVE_RC"
  fi

  ITEM_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-items.js" --read "$ITEM_ID" --cwd "$WORKING_DIR")
  READ_RC=$?
  if [ "$READ_RC" -ne 0 ]; then
    echo "$ITEM_JSON" >&2
    exit "$READ_RC"
  fi

  ITEM_STATUS=$(printf '%s' "$ITEM_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);process.stdout.write(o.status||'')})")
  if [ "$ITEM_STATUS" = "done" ] || [ "$ITEM_STATUS" = "dropped" ]; then
    echo "Item $ITEM_ID está $ITEM_STATUS — reabra com: node scripts/forge-items.js --set-status $ITEM_ID triaged" >&2
    exit 1
  fi

  ITEM_TITLE=$(printf '%s' "$ITEM_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);process.stdout.write(o.title||'')})")
  TASK_DESCRIPTION="$ITEM_TITLE"

  ITEM_PROVENANCE=$(printf '%s' "$ITEM_JSON" | node -e "
    let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      const o=JSON.parse(s);
      const lines=['## Item de origem',''];
      const push=(label,val)=>{ if (val !== undefined && val !== null && val !== '') lines.push('- **'+label+':** '+val); };
      push('ID', o.id);
      push('Origem', o.source);
      push('Arquivo', o.file);
      push('SHA', o.sha);
      push('Milestone', o.milestone);
      push('Status', o.status);
      lines.push('');
      if (o.body) lines.push(o.body);
      process.stdout.write(lines.join('\n'));
    });
  ")

  echo "→ Item resolvido: $ITEM_ID — $ITEM_TITLE"
fi
```

- Loud stop on resolve/read failure — never guess, never fall through to treating `$ITEM_REF` as a free-text description.
- `TASK_DESCRIPTION` now carries the item title, so `forge-ids.js --new-task "$TASK_DESCRIPTION"` (next section) mints a meaningful `T-<ts>-<slug>` with no change to the ID logic.
- `ITEM_PROVENANCE` is consumed later by `## Initialize task` (BRIEF) — omitted fields per the omission rule in `shared/forge-items-readback.md`.

---

## Multi-run resolution + TASK_ID

**Resolve scripts dir** for forge-runs.js / forge-cli-helpers.js:
```bash
if [ -f "scripts/forge-runs.js" ]; then
  FORGE_SCRIPTS_DIR="scripts"
else
  FORGE_SCRIPTS_DIR="${FORGE_HOME:-$HOME/.forge-agent}/scripts"
fi
```

**Multi-run check** — refuse if too many active and no explicit resume:
```bash
# Migrate legacy STATE.md FIRST (idempotent) — required before any dashboard regen below
node "$FORGE_SCRIPTS_DIR/forge-runs.js" --migrate-legacy --cwd "$(pwd)" > /dev/null 2>&1 || true

if [ -z "$TASK_ID" ]; then
  RESOLVE=$(node "$FORGE_SCRIPTS_DIR/forge-cli-helpers.js" --resolve-args --args "" --command forge-task)
  STATUS=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).status)" "$RESOLVE")
  if [ "$STATUS" = "refuse" ]; then
    node -e "process.stdout.write(JSON.parse(process.argv[1]).message)" "$RESOLVE"
    exit 0
  fi
fi
```

**Determine TASK_ID:**
```bash
mkdir -p .gsd/tasks
TASK_ID=$(node "$FORGE_SCRIPTS_DIR/forge-ids.js" --new-task "$TASK_DESCRIPTION")
```

- Resume mode: `TASK_ID` already set — skip to Dispatch loop. If the existing BRIEF has an `item:` key, read it for display/verification only (`ITEM_ID = <that value>`) — never re-`--promote` (the original registration already wrote it); `--set-status doing` is not re-issued here either (harmless if it were, but not required, per `shared/forge-items-readback.md § Transição para doing`).
- Formato do `TASK_ID` segue a pref `ids.format` (resolvida pelo próprio forge-ids.js): `timestamp` (default) → `T-<YYYYMMDDHHMMSS>-<slug>` (slug omitido se a descrição for vaga); `sequential` → legado `TASK-00N` (max existente + 1 em `.gsd/tasks/`)

**Isolation setup (branch/worktree)** — apply `forge_isolation` from prefs BEFORE registering the run. An explicit attach validates a registered lender and never creates a worktree; setup remains idempotent (`already-on-branch` / `already-exists`):

On resume, `--attach` is never re-supplied on the command line (the skill's own resume hint is `/forge-task --resume {TASK_ID}` with no `--attach`). If `ATTACH_RUN` were left empty here, resume would silently fall into the `--setup` branch below and provision a brand-new worktree off the default branch — losing the lender's branch and the work already on it. So before branching on `$ATTACH_RUN`, recover an existing attach from the registry when resuming:
```bash
if [ -n "$RESUME_MODE" ] && [ -z "$ATTACH_RUN" ]; then
  EXISTING_ATTACH=$(node -e "
    const runs=require('$FORGE_SCRIPTS_DIR/forge-runs.js');
    const rec=runs.get(process.cwd(), process.argv[1]);
    process.stdout.write((rec && rec.attached_to) ? rec.attached_to : '');
  " "$TASK_ID")
  [ -n "$EXISTING_ATTACH" ] && ATTACH_RUN="$EXISTING_ATTACH" && echo "⛓ Isolation: resumindo attach registrado a $ATTACH_RUN"
fi

if [ -n "$ATTACH_RUN" ]; then
  ISO_RESULT=$(node "$FORGE_SCRIPTS_DIR/forge-isolation.js" --attach "$ATTACH_RUN" --run "$TASK_ID" --cwd "$(pwd)")
  ATTACH_RC=$?
  ISOLATION_MODE="worktree"
  WORKTREE_DIR=$(node -e "process.stdout.write((JSON.parse(process.argv[1]).code_dir)||'')" "$ISO_RESULT")
  ATTACH_BRANCH=$(node -e "process.stdout.write((JSON.parse(process.argv[1]).branch)||'')" "$ISO_RESULT")
  ATTACH_REASON=$(node -e "process.stdout.write((JSON.parse(process.argv[1]).reason)||'')" "$ISO_RESULT")
  ATTACH_ERROR=$(node -e "process.stdout.write((JSON.parse(process.argv[1]).error)||'')" "$ISO_RESULT")
  if [ "$ATTACH_RC" -ne 0 ]; then
    echo "✗ Não foi possível anexar ao run $ATTACH_RUN: $ATTACH_REASON — $ATTACH_ERROR" >&2
    exit "$ATTACH_RC"
  fi
  CODE_DIR="$WORKTREE_DIR"
  BRANCH="$ATTACH_BRANCH"
  RUN_BRANCH="$ATTACH_BRANCH"   # recorded as the lender's branch — the borrower owns no branch of its own
  echo "⛓ Isolation: worktree emprestado de $ATTACH_RUN → $WORKTREE_DIR (branch $ATTACH_BRANCH)"
else
ISO_RESULT=$(node "$FORGE_SCRIPTS_DIR/forge-isolation.js" --setup --run "$TASK_ID" --cwd "$(pwd)")
ISOLATION_MODE=$(node -e "process.stdout.write((JSON.parse(process.argv[1]).mode)||'shared')" "$ISO_RESULT")
WORKTREE_DIR=$(node -e "const r=JSON.parse(process.argv[1]);const w=(r.repos||[]).find(x=>x.worktree&&x.status!=='error');process.stdout.write(w?w.worktree:'')" "$ISO_RESULT")
# RUN_BRANCH — read back from the setup result, never re-derived as `forge/$TASK_ID`.
# The attach path above already set `BRANCH="$ATTACH_BRANCH"` (the LENDER's branch,
# which `forge/{TASK_ID}` would misname); the `r.branch` fallback in the expression
# below covers that result shape too. Reachable cases: branch/worktree with ≥1 repo
# ok → the setup's branch; `shared` → `repos: []` → empty → recorded as null; all
# repos errored → empty → null (the ISO_ERRORS rule below stops anyway).
RUN_BRANCH=$(node -e "const r=JSON.parse(process.argv[1]);const b=(r.repos||[]).find(x=>x.branch&&x.status!=='error');process.stdout.write((b&&b.branch)||r.branch||'')" "$ISO_RESULT")
ISO_ERRORS=$(node -e "const r=JSON.parse(process.argv[1]);process.stdout.write((r.repos||[]).filter(x=>x.status==='error').map(x=>x.path+': '+x.error).join('; '))" "$ISO_RESULT")
ELEVATED=$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).elevated||false))" "$ISO_RESULT")
ELEV_REASON=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).elevation_reason||'')" "$ISO_RESULT")
echo "ISOLATION_MODE=$ISOLATION_MODE  WORKTREE_DIR=${WORKTREE_DIR:-—}  ISO_ERRORS=${ISO_ERRORS:-none}"
[ "$ELEVATED" = "true" ] && echo "⚠ require_worktree: elevado a worktree ($ELEV_REASON) → CODE_DIR=${WORKTREE_DIR:-?}"
fi
```

Isolation rules (CRITICAL — the operator configured this; honor it):
- `shared` → `CODE_DIR = $(pwd)`. Nothing else to do.
- `branch` → `CODE_DIR = $(pwd)`. The executor commits on the `forge/{TASK_ID}` branch the setup just checked out.
- `worktree` → `CODE_DIR = $WORKTREE_DIR` (bootstrap value). **In a multi-repo workspace `CODE_DIR` does NOT come from this bootstrap value**: once `$PLAN_PATH` exists, the per-unit resolver (`forge-code-dir.js`, § Per-unit `CODE_DIR` resolution) attributes the unit's declared paths to ONE repo — when it returns `ok`, `CODE_DIR = $UNIT_CODE_DIR`; on any refusal (`cross-repo`/`undeclared`) `CODE_DIR` stays `$WORKTREE_DIR`, exactly today's behavior. ALL code reads/writes/commits happen inside the worktree; `.gsd/**` artifacts ALWAYS stay under the original workspace.
- `ISO_ERRORS` non-empty AND no repo succeeded → STOP and surface the errors. Running un-isolated when the operator configured isolation is NOT an acceptable fallback.
- When mode != shared, emit one line: `⛓ Isolation: {mode} → {branch name or worktree path}`.
- `workers.require_worktree` elevation is static-at-activation (never mid-run); `auto` (default) elevates `shared→worktree` only when `execute-task` resolves to an external write engine (codex/gpt/gemini); `true` always elevates; `false` never elevates. Read-only paths (Branch D plan-slice, review challenger) are exempt. Warn-and-proceed — never blocks; false-positive acceptable, false-negative not. Keep `shared`: `workers.require_worktree: false`.
- `ATTACH_RC != 0` → **STOP loud** with the JSON `reason` and `error`. Never fall back to setup: the operator requested milestone code, not a new tree based on the default branch.
- Attached worktrees set `CODE_DIR = $WORKTREE_DIR` and `BRANCH = $ATTACH_BRANCH`; the branch is the lender's branch, never `forge/{TASK_ID}`.
- A borrowed worktree is never removed during task cleanup. This is guaranteed by the borrower registry field `attached_to`, not by the skill's good will.

**Register in multi-run registry** (M004+) — only when initializing fresh (not on resume):
```bash
if [ -z "$RESUME_MODE" ]; then
  SESSION_ID="${CLAUDE_SESSION_ID:-$(node -e "process.stdout.write(require('crypto').randomBytes(8).toString('hex'))")}" 
  WORKTREES_JSON=$(node -e "const r=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify((r.repos||[]).filter(x=>x.worktree&&x.status!=='error').map(x=>({repo:x.path,path:x.worktree}))))" "$ISO_RESULT")
  node "$FORGE_SCRIPTS_DIR/forge-runs.js" --add --id "$TASK_ID" --kind task --session "$SESSION_ID" --isolation-mode "$ISOLATION_MODE" --account "${FORGE_ACCOUNT:-}" --worktrees "$WORKTREES_JSON" --attached-to "${ATTACH_RUN:-}" --branch "${RUN_BRANCH:-}" --cwd "$(pwd)" --task-description "$TASK_DESCRIPTION" > /dev/null
  # Regenerate dashboard
  node "$FORGE_SCRIPTS_DIR/forge-dashboard.js" --cwd "$(pwd)" --holder "task:$TASK_ID" > /dev/null || true

  # Item read-back: doing + promoted_to (fresh runs only, per shared/forge-items-readback.md — advisory failure)
  if [ -n "$ITEM_ID" ]; then
    node "$FORGE_SCRIPTS_DIR/forge-items.js" --set-status "$ITEM_ID" doing --cwd "$WORKING_DIR" > /dev/null 2>&1 \
      || echo "⚠ Não foi possível marcar $ITEM_ID como doing (seguindo)" >&2
    node "$FORGE_SCRIPTS_DIR/forge-items.js" --promote "$ITEM_ID" "$TASK_ID" --cwd "$WORKING_DIR" > /dev/null 2>&1 \
      || echo "⚠ Não foi possível registrar promoted_to em $ITEM_ID (seguindo)" >&2
  fi
fi
```

This makes the task visible in `runs/*.json`, statusline, and dashboard. The `.gsd/tasks/{TASK_ID}/` directory continues to hold artifacts (BRIEF, PLAN, SUMMARY) as before — only the run registry is new.

**On task completion** (or any exit path — pause/error): mark inactive:
```bash
node "$FORGE_SCRIPTS_DIR/forge-runs.js" --update "$TASK_ID" --json '{"active":false}' > /dev/null
node "$FORGE_SCRIPTS_DIR/forge-dashboard.js" --cwd "$(pwd)" --holder "task:$TASK_ID" > /dev/null || true
```

---

## Initialize task (skip if resume mode)

```bash
mkdir -p .gsd/tasks/{TASK_ID}
```

Write `.gsd/tasks/{TASK_ID}/{TASK_ID}-BRIEF.md`. When `ITEM_ID` is set, add an `item:` frontmatter key and append `{ITEM_PROVENANCE}` to the body — both omitted entirely for a free-text task, whose BRIEF stays byte-identical to today's. The BRIEF is the single provenance carrier: every downstream `/forge-task` prompt (brainstorm, discuss, research, plan) already inlines `## Task Brief` = this file's content, so one edit here propagates to all four phases without touching their templates.

```markdown
---
id: {TASK_ID}
description: {TASK_DESCRIPTION}
created: {ISO8601 date}
skip_brainstorm: {true|false}
skip_research: {true|false}
item: {ITEM_ID}    # only when ITEM_ID is set — omit the line otherwise
---

# {TASK_DESCRIPTION}

{ITEM_PROVENANCE}   # only when ITEM_ID is set — omit entirely otherwise
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
Append significant decisions to the **fragment store** via `forge-decisions.js --write` (stdin JSON) — do NOT write to `.gsd/DECISIONS.md` directly. Use:
```bash
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-decisions.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
printf '%s' "$key_decisions_json" | node "$FORGE_SCRIPTS_DIR/forge-decisions.js" --write --cwd "$WORKING_DIR"
```
Where `key_decisions_json` is `{ "unit_id": "{TASK_ID}", "decisions": [{when, scope, decision, choice, rationale, revisable}, ...] }`. The global `.gsd/DECISIONS.md` is rebuilt from fragments during `complete-milestone` (forge-merger).
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

**Security gate:** Scan `{TASK_ID}-BRIEF.md` + `{TASK_ID}-CONTEXT.md` for security-sensitive keywords using the canonical word-boundary pattern + narrow exception list in `shared/forge-dispatch.md § Security Gate — Keyword Pattern` (formula-once source — do not restate the regex here).

If the base pattern matches (and no exception suppresses it) AND `.gsd/tasks/{TASK_ID}/{TASK_ID}-SECURITY.md` does not exist:
```
Skill({ skill: "forge-security", args: "{TASK_ID}" })
```

**Create timeline task:**
```
TaskCreate({ subject: "[{TASK_ID}] plan", activeForm: "plan · forge-planner (opus)" })
TaskUpdate({ taskId: <id>, status: "in_progress" })
```

Derive the valid domain list for the header below (reuses `$FORGE_SCRIPTS_DIR`/`$WORKING_DIR` set in Load Context):
```bash
routing_domains=$(node "$FORGE_SCRIPTS_DIR/forge-routing.js" --list-domains --cwd "$WORKING_DIR" \
  | node -e 'const a=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(a.length?a.join(", "):"(none — omit domain:)")')
workspace_repos=$(node "$FORGE_SCRIPTS_DIR/forge-repos.js" --list --cwd "$WORKING_DIR" \
  | node -e 'const l=require("fs").readFileSync(0,"utf8").split("\n").map(s=>s.trim()).filter(Boolean).map(p=>p.split(/[\\/]/).pop());process.stdout.write(l.length>1?l.join(", "):"(single repo — omit repo:)")')
```

Dispatch `forge-planner` (opus) with this prompt:
```
Plan forge-task {TASK_ID}: {TASK_DESCRIPTION}
WORKING_DIR: {WORKING_DIR}
effort: {EFFORT_OPUS}
thinking: adaptive
ROUTING_DOMAINS: {routing_domains}
WORKSPACE_REPOS: {workspace_repos}

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
Write {TASK_ID}-PLAN.md to .gsd/tasks/{TASK_ID}/. Open the file with a `---`-fenced YAML
frontmatter block carrying `tier:` (task complexity: light|standard|heavy), `effort:`
(ordered scale low|medium|high|xhigh|max), `writes:` (an array of the file paths or globs
this task will create or modify — literals or globs, `writes: []` for a docs-only task;
emit it unconditionally, it is what lets a multi-repo workspace attribute this task to ONE
repo), and — only when this task's work maps to a
domain that is an existing key in the resolved `routing:` block of prefs — `domain:`.
When the injected repo list has multiple names, add `repo:` using only one listed name; omit it
when the list is single or absent. Omit `domain:` entirely when no such key applies (resolves to `default`, never an error);
judge domain from the nature of the work, not filenames/keywords. See
`agents/forge-planner.md § Effort & Tier Hints` / `§ Must-Haves Schema` for the canonical
contract. After the frontmatter, include exactly these sections:

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

### Step 4.5 — Plan gate (interactive)

Roda o handshake do plan gate (spec autoritativa: `shared/forge-plan-gate.md`) no boundary do `forge-task`: após o `forge-planner` retornar `{TASK_ID}-PLAN.md` (Step 4) e **antes** do `forge-executor` ser despachado (Step 5). `/forge-task` é uma skill (main context) com `AskUserQuestion`, sempre interativo → `MODE = interactive`.

**Binding forge-task (conforme `shared/forge-plan-gate.md` tabela de consumidores):**

| Campo | Valor |
|-------|-------|
| UNIT | `task/{TASK_ID}` |
| PLAN_FILE | `.gsd/tasks/{TASK_ID}/{TASK_ID}-PLAN.md` (arquivo único) |
| MODE | `interactive` (forge-task é sempre interativo) |
| Approval marker | `{TASK_ID}-PLAN-GATE.md` |
| GATE_MARKER path | `{WORKING_DIR}/.gsd/tasks/{TASK_ID}/{TASK_ID}-PLAN-GATE.md` |

> Nota R4 (resolvida): planos do forge-task são free-text legado e produzem no máximo **1 finding** (`legacy_schema_detect` warn). Não há findings "related" para agrupar. Batching **não é aplicado** — o finding é surfaçado como pergunta direta.

**Skip conditions (topo do Step 4.5 — verificar antes de qualquer bloco bash):**

1. `{TASK_ID}-PLAN-GATE.md` já existe com `status: approved` → pular (resume idempotente pós-compactação, não re-pergunta o operador).
2. `plan_gate.interactive == off` → pular o gate inteiro, ir direto ao outer Step 5 — execute (comportamento batch anterior; sem preview, sem `AskUserQuestion`, sem marker).

---

#### Gate Step 0 — Read `plan_gate` prefs via the canonical prefs CLI

Resolve prefs once through the S01 engine CLI (never a `files=[…forge-agent-prefs.jsonc…]` cascade merge) — see `shared/forge-dispatch.md § Per-unit prefs resolution` and `shared/forge-plan-gate.md § Step 0`.

```bash
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-prefs.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
PREFS_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-prefs.js" --resolved --cwd "$WORKING_DIR")
if [ $? -ne 0 ]; then
  # M008-CONTEXT decision #2 — loud stop, never a silent default. errors[] (file+line)
  # on stdout ($PREFS_JSON); human message + fix hint on stderr. Halt the gate.
  echo "✗ prefs parse error — plan gate halted (see stderr for arquivo:linha)" >&2
  exit 1
fi
# CRITICAL loud-stop (M008-CONTEXT #2): a nonzero prefs-CLI exit above HALTS the
# task. The `exit 1` fires when this block runs in a shell. In the orchestrator,
# STOP this task run now: deactivate the run + surface arquivo+linha+como-corrigir
# from `errors[]`. Do NOT proceed on INTERACTIVE=always / any fallback default.

# Extract plan_gate knobs off .prefs, preserving the exact whitelist + defaults.
INTERACTIVE=$(printf '%s' "$PREFS_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{let v=(JSON.parse(d).prefs.plan_gate||{}).interactive;v=(typeof v==='string')?v.toLowerCase():'';process.stdout.write(['always','auto','off'].includes(v)?v:'always')}catch(e){process.stdout.write('always')}})")
ASK_AUTO=$(printf '%s' "$PREFS_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{let v=(JSON.parse(d).prefs.plan_gate||{}).ask_in_auto;v=(typeof v==='string')?v.toLowerCase():'';process.stdout.write(['defer','off'].includes(v)?v:'defer')}catch(e){process.stdout.write('defer')}})")
```

**Loud-stop on the prefs re-resolution above (M008-CONTEXT #2 — NOT a bare comment):** if the `forge-prefs.js --resolved` call at the top of this block exited non-zero, STOP this task run now — do NOT run the plan gate on fallback values. Deactivate the run, surface arquivo + linha + como-corrigir from `errors[]`, and do **NOT** proceed on `INTERACTIVE=always` / `ASK_AUTO=defer` / any fallback default. The `exit 1` in the guard halts a shell-executed path; this prose halts the orchestrator-interpreted path.

Defaults preserved byte-for-byte: absent `.prefs.plan_gate` (or an out-of-whitelist value) → `INTERACTIVE=always`, `ASK_AUTO=defer` — identical to the old inline cascade. `warnings[]` (advisory) do not stop; only exit≠0 halts.

**Semântica da pref `interactive`:**

| Valor | Comportamento |
|-------|---------------|
| `always` (default) | Conduzir o gate em todo plano — preview + aprovação sempre. |
| `auto` | Conduzir só quando `warn > 0` ou `fail > 0`. Auto-aprovar silenciosamente se tudo passar. (**Nota:** para forge-task legado, `plan_check_counts` não está em escopo — tratar como `always`.) |
| `off` | Pular o gate inteiro — comportamento batch atual. Ir direto ao outer Step 5 (execute). |

Se `INTERACTIVE == off` → **pular o gate.** Ir direto ao outer Step 5 (execute).

---

#### Gate Step 0a — Idempotency / GATE_MARKER

```bash
GATE_MARKER="$WORKING_DIR/.gsd/tasks/{TASK_ID}/{TASK_ID}-PLAN-GATE.md"
```

> **NUNCA** usar `{TASK_ID}-PLAN-CHECK.md` como marker — esse arquivo pertence ao `forge-plan-checker` (agente advisory separado) e não deve ser reutilizado como sinal de aprovação do operador.

```bash
if [ -f "$GATE_MARKER" ] && grep -qF "status: approved" "$GATE_MARKER" 2>/dev/null; then
  echo "Plan gate already approved — skipping (resume after compaction)"
  # Prosseguir diretamente para o outer Step 5 (execute)
fi
```

---

#### Gate Step 1 — Preview do plano

Ler `{TASK_ID}-PLAN.md` do disco — **preview = arquivo em disco, não conteúdo cacheado.** Isso garante que edições em andamento sejam refletidas.

```bash
PLAN_FILE="$WORKING_DIR/.gsd/tasks/{TASK_ID}/{TASK_ID}-PLAN.md"
```

Exibir um resumo informacional (sem pergunta ainda):
- Título da task (de `{TASK_ID}-BRIEF.md` ou cabeçalho do plano)
- Número de seções presentes (`## Steps`, `## Must-Haves`, `## Standards`, `## Files to Change`)
- Número de itens em `## Files to Change`

O operador lê o plano e se prepara para a revisão de findings no Gate Step 2.

---

#### Gate Step 2 — Lapidação do finding (R4: sem batching para forge-task)

Planos do `forge-task` são **legacy free-text** (não há `must_haves:` YAML estruturado em coluna 0). O plan-checker, se rodado, sempre retornaria `warn` em `legacy_schema_detect` (nunca `fail`) — **no máximo 1 finding**.

> **Resolução de R4 (era OPEN em S01):** drop batching para o consumidor forge-task. Com ≤ 1 finding, não há findings "related" para agrupar. O único finding é surfaçado como pergunta direta — sem lógica de batching. (O consumidor `forge-next` em S03 reavaliará batching para planos estruturados com múltiplos findings possíveis.)

> **Nota importante:** o `forge-task` não roda o `forge-plan-checker` no fluxo atual (Step 4 só despacha o planner, não o plan-checker). Portanto `plan_check_counts` não está em escopo. O Step 4.5 trata o plano como legado por definição e oferece preview + edição livre como a rede de segurança primária. O gate é essencialmente: **preview → edição livre → aprovação**, com o aviso de formato legado como único "finding".

Invocar `AskUserQuestion`:
```
Header: "Plano {TASK_ID} — formato legado"
Body:   "O plano está no formato free-text legado (## Steps / ## Must-Haves / ## Standards / ## Files to Change, sem YAML estruturado). Revise o texto do plano diretamente antes de aprovar."
Options: ["Manter — plano está bom", "Corrigir no ato — editar o plano", "Deferir — prosseguir assim"]
```

- `Manter` → ir para Gate Step 3 (edição livre opcional).
- `Corrigir no ato` → ir para Gate Step 3 (edição livre, com intenção de editar).
- `Deferir` → criar um item via `shared/forge-review.md § Item capture`:
  - `source: plan-gate/{TASK_ID}`, `origin: auto`, `status: inbox`, título = resumo do finding do plano legado.
  - Sem `file`/`sha` — este junction não tem nenhum (o payload simplesmente omite essas chaves, nunca um placeholder).
  - Registrar no marker do `{TASK_ID}-PLAN-GATE.md`: `formato legado: deferido → {I-id} — {title}`.
  - Depois, ir para Gate Step 3 (edição livre opcional).

---

#### Gate Step 3 — Edição livre (escape hatch)

Oferecer ao operador uma janela de edição não-estruturada:

```
AskUserQuestion({
  header: "Edição livre do plano",
  body:   "Edite {TASK_ID}-PLAN.md no seu editor agora. Confirme quando terminar.",
  options: ["Confirmar — relerei o plano", "Pular — plano está bom"]
})
```

- `Confirmar` → reler o arquivo do disco (`PLAN_FILE`) e exibir a versão atualizada ao operador. O orquestrador NÃO usa cache — lê o arquivo atual. As edições humanas passam a ser a versão autoritativa do plano. Ir para Gate Step 4 (re-validação).
- `Pular` → ir direto para Gate Step 5 (aprovação).

---

#### Gate Step 4 — Re-validação pós-edição (NO-OP para forge-task — documentado)

Após edição (caminho `Confirmar` do Step 3), re-validar o schema do plano.

```bash
REVALIDATION_STDERR=$(mktemp)
REVALIDATION=$(node scripts/forge-must-haves.js --check "$PLAN_FILE" 2>"$REVALIDATION_STDERR")
REVALIDATION_EXIT=$?
```

**IO-error guard (aplicar antes do JSON.parse):**

```bash
if [ $REVALIDATION_EXIT -ne 0 ] && [ $REVALIDATION_EXIT -ne 2 ]; then
  IO_ERR=$(cat "$REVALIDATION_STDERR")
  LEGACY=false; VALID=false
  ERRORS="[\"IO error from forge-must-haves.js: $IO_ERR\"]"
else
  if ! node -e "JSON.parse(process.env.R)" R="$REVALIDATION" 2>/dev/null; then
    IO_ERR=$(cat "$REVALIDATION_STDERR")
    LEGACY=false; VALID=false
    ERRORS="[\"Non-JSON stdout from forge-must-haves.js (exit $REVALIDATION_EXIT): $IO_ERR\"]"
  else
    LEGACY=$(node -e "process.stdout.write(String(JSON.parse(process.env.R).legacy))" R="$REVALIDATION")
    VALID=$(node -e  "process.stdout.write(String(JSON.parse(process.env.R).valid))"  R="$REVALIDATION")
    ERRORS=$(node -e "process.stdout.write(JSON.stringify(JSON.parse(process.env.R).errors))" R="$REVALIDATION")
  fi
fi
rm -f "$REVALIDATION_STDERR"
```

> **⚠ Pitfall 1 — re-validação é NO-OP para planos forge-task legados:** `node scripts/forge-must-haves.js --check` detecta ausência de `^must_haves:` em coluna 0 e retorna `{legacy:true, valid:true, errors:[]}` (exit 0) — **validando nada.** A rede de segurança para planos legados é a edição livre + reload do Step 3, **não** schema enforcement. Re-validação só é significativa para planos estruturados futuros (`forge-next` com `must_haves:` YAML). NÃO prometer enforcement que não dispara em planos legados.

Se `legacy == false && valid == false` (plano estruturado futuro com erro de schema):

```
AskUserQuestion({
  header: "Erro de schema no plano",
  body:   "O plano tem erros de schema que impedem a aprovação:\n{ERRORS}\nCorrigir o plano (edit + releitura) ou abortar.",
  options: ["Corrigir agora", "Abortar — replanejar"]
})
```

- `Corrigir agora` → voltar ao Gate Step 3, depois re-rodar Gate Step 4.
- `Abortar` → não escrever o marker; retornar o usuário à fase de planejamento.

---

#### Gate Step 5 — Approval handshake

Após os findings serem endereçados e a re-validação passar, apresentar o gate de aprovação final. O `ExitPlanMode` pode ser usado aqui (Agent's Discretion, M002-CONTEXT `§ Agent's Discretion`) — é seguro pois o `forge-task` **não** é invocado dentro de uma fase de discuss, portanto não há plan mode herdado aberto neste ponto (ver `shared/forge-plan-gate.md § Plan-mode non-nesting`).

> **Não-aninhamento de plan mode:** o `forge-discusser` (Step 2) é o único dono do `EnterPlanMode`/`ExitPlanMode` e já fechou seu plan mode antes do planejamento começar. **NÃO adicionar `EnterPlanMode`** em nenhum ponto do Step 4.5 — isso aninharia com o discuss e quebraria a invariante.

```
AskUserQuestion({
  header: "Aprovar plano {TASK_ID}",
  body:   "Plano revisado e validado. Aprovar para iniciar a execução?",
  options: ["Aprovar — iniciar execução", "Editar mais", "Abortar — replanejar"]
})
```

- `Aprovar` → escrever o GATE_MARKER:

```bash
mkdir -p "$(dirname "$GATE_MARKER")"
cat > "$GATE_MARKER" << 'EOF'
---
status: approved
approved_at: {ISO8601}
consumer: forge-task
unit: task/{TASK_ID}
---
Plan approved by operator. Execution may proceed.
EOF
```

  Prosseguir para o outer Step 5 (execute).

- `Editar mais` → voltar ao Gate Step 3.
- `Abortar` → não escrever o marker. Re-despachar o `forge-planner` com notas do operador; reiniciar o ciclo de planejamento.

---

#### Event log

Após o gate fechar (aprovado/abortado/pulado), append uma linha em `.gsd/forge/events.jsonl`:

```bash
mkdir -p "$WORKING_DIR/.gsd/forge"
printf '%s\n' "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"plan-gate\",\"milestone\":\"\",\"unit\":\"task/{TASK_ID}\",\"mode\":\"interactive\",\"interactive\":\"$INTERACTIVE\",\"outcome\":\"{approved|aborted|skipped}\",\"warn\":0,\"fail\":0,\"edits\":{N}}" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
```

Campos:
- `outcome`: `approved` (operador aprovou), `aborted` (operador escolheu replanejar), `skipped` (idempotência atingida ou `interactive: off`).
- `warn` / `fail`: sempre `0` para planos forge-task legados (plan-checker não rodou).
- `edits`: número de vezes que o Step 3 foi visitado (0 = sem edição livre).
- `milestone`: `""` (forge-task fora de milestone por padrão).

---

**Handoff para outer Step 5:** o outer Step 5 (execute) só roda após o gate aprovar (marker `{TASK_ID}-PLAN-GATE.md` escrito com `status: approved`) ou ser pulado (`interactive: off`). A ausência do marker indica que o gate foi abortado — o executor **não** deve ser despachado.

---

### Step 5 — Execute

**Skip if:** `.gsd/tasks/{TASK_ID}/{TASK_ID}-SUMMARY.md` already exists (task done).

**Record pre-execute HEAD SHA** (persisted to file so Step 5.5 can diff after executor commits). In `worktree` mode the commits land in `CODE_DIR` — read HEAD from there:
```bash
node "$FORGE_SCRIPTS_DIR/forge-vcs.js" --baseline --cwd "${CODE_DIR:-.}" > .gsd/tasks/{TASK_ID}/.start-sha 2>/dev/null || echo "" > .gsd/tasks/{TASK_ID}/.start-sha
```

**Dispatch resolution (before dispatch)** — resolve `{engine, model, alias, tier, domain, route_source, chain, chain_len, reason, effort, effort_reason}` for this dispatch via the **single `forge-dispatch-resolve.js --json` call** (S01). As of M012 S02 T02, this ONE call folds the former Engine Resolution + tier/domain routing + dynamic Effort Resolution + alias into a thin caller — `forge-task` is single-task and always interactive, but the engine/fallback mechanics are byte-identical to the `forge-auto`/`forge-next` mirrors, and it now has full domain-first routing parity. `forge-task`'s only `unit_type` is `execute-task` and it is a **loose task** (no roadmap) → no `--roadmap`, so risk-escalation is inert and the routing is always "active".
> Cross-reference: `shared/forge-dispatch.md § Worker Engine Routing` (algorithm, prefs reader, engine-by-route_source table, sidecar state machine, fallback) + `scripts/forge-dispatch-resolve.js` (S01). Any change to the pure resolution lands in the resolver; this block is the executable caller.

```bash
# ── Dispatch resolution (before dispatch; execute-task routes to sidecar) ──────
# The explicit prefs loud-stop gate STAYS even though forge-dispatch-resolve.js also surfaces
# prefs errors — an early, human-actionable halt on a broken config (M008-CONTEXT #2). ONE
# forge-prefs.js --resolved call (reads the jsonc catalog per layer; legacy Markdown without jsonc
# hard-stops — see shared/forge-prefs-cutover.md; NEVER a 3-file cascade node -e merge,
# MEM001 M005). See shared/forge-dispatch.md § Per-unit prefs resolution.
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-prefs.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
PREFS_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-prefs.js" --resolved --cwd "$WORKING_DIR")
if [ $? -ne 0 ]; then
  # Loud stop (M008-CONTEXT #2): errors[] ({file,line,message}) on stdout, human hint on stderr.
  # Stop this task run. NEVER degrade to a claude/effort-default fallback on a broken config.
  echo "✗ prefs parse error — dispatch halted (see stderr for arquivo:linha)" >&2
  exit 1
fi
# CRITICAL loud-stop (M008-CONTEXT #2): a nonzero prefs-CLI exit above HALTS the
# dispatch. The `exit 1` fires when this block runs in a shell. In the
# orchestrator, STOP this task run now: deactivate the run + surface
# arquivo+linha+como-corrigir from `errors[]`. NEVER degrade on a broken config.

# ONE resolver call — engine/model/alias/tier/domain/route_source/chain/effort all resolved inside
# it (frontmatter worker: > routing: > pref > default precedence owned by the resolver, MEM018 reads
# prefs from $WORKING_DIR). Loose task → NO --roadmap (risk-escalation inert). --cwd "$WORKING_DIR".
PLAN_PATH=".gsd/tasks/{TASK_ID}/{TASK_ID}-PLAN.md"
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-dispatch-resolve.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
ROUTE_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-dispatch-resolve.js" \
  --unit-type execute-task --plan "$PLAN_PATH" --unit-id "{TASK_ID}" --cwd "$WORKING_DIR" --json)
if [ $? -ne 0 ]; then
  # Non-zero exit == prefs loud-stop (M008-CONTEXT #2) — the resolver only exits 1 on prefs_ok:false.
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
THINKING_HEADER=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).thinking_header||'')" "$ROUTE_JSON")
MODEL_APPLIED_JSON=$([ -n "$MODEL_ALIAS" ] && printf '"%s"' "$MODEL_ALIAS" || printf 'null')
# The resolver owns sidecar model selection: chain[0].id for a Codex dispatch,
# with workers.codex_model retained as its legacy fallback.
SIDECAR_MODEL=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).sidecar_model||'')" "$ROUTE_JSON")
# $ROUTE_JSON.chain carries forward unmodified — consumed by Branch codex (SIDECAR_MODEL) and by
# the Failure Taxonomy via `forge-routing.js ... --next-after "$MODEL_ID"`.
```
**Loud-stop on the resolution above (M008-CONTEXT #2 — NOT a bare comment):** if either the `forge-prefs.js --resolved` gate OR the `forge-dispatch-resolve.js` call exited non-zero, STOP this task run now — deactivate the run, surface arquivo + linha + como-corrigir from `errors[]`/`prefs_errors`, and do **NOT** proceed on any claude/effort-default fallback value. The `exit 1` guards halt a shell-executed path; this prose halts the orchestrator-interpreted path.

`$ENGINE`, `$ENGINE_REASON`, `$MODEL_ID`, `$MODEL_ALIAS`, `$TIER`, `$REASON`, `$DOMAIN_USED`, `$ROUTE_SOURCE`, `$CHAIN_LEN`, `$EFFORT`, `$EFFORT_REASON`, `$WORKERS_TIMEOUT`, `$CODEX_MODEL`, `$SIDECAR_MODEL`, `$THINKING_HEADER`, `$MODEL_APPLIED_JSON`, `$PLAN_PATH`, and `$ROUTE_JSON` (with `.chain`) are now set. The dispatch below branches on `$DISPATCH_ENGINE` (the additive normalized dispatch trigger — `gpt→codex`, `gemini→agy`, else `claude`; `$ENGINE`/`chain[].engine` stay family for events); the resolved `$EFFORT`/`$TIER`/`$DOMAIN_USED`/`$ROUTE_SOURCE`/`$CHAIN_LEN` are injected into the dispatch event (both paths).

**Per-unit `CODE_DIR` resolution (multi-repo precondition)** — executable mirror of `shared/forge-dispatch.md § Sidecar dispatch state machine step 0.5` (contract prose lives there, never restated here). Runs HERE because `$PLAN_PATH` is only known now — the bootstrap `WORKTREE_DIR` above is derived before any plan exists and stays untouched:
```bash
UNIT_CODE_DIR=""; CODE_DIR_STATUS="shared"; CODE_DIR_REASON=""; CODE_DIR_MULTI_ROOT=""; CODE_DIR_HINT=""
CODE_DIR_HINT_FILE="$WORKING_DIR/.gsd/forge/code-dir-hint.json"
mkdir -p "$WORKING_DIR/.gsd/forge/"; printf '""' > "$CODE_DIR_HINT_FILE"   # reset per unit — never inherit a prior unit's hint
if [ "$ISOLATION_MODE" = "worktree" ] && [ -n "$PLAN_PATH" ] && [ -n "$ISO_RESULT" ]; then
  CD_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-code-dir.js" --resolve \
    --iso-result "$ISO_RESULT" --plan "$WORKING_DIR/$PLAN_PATH" --cwd "$WORKING_DIR" --run "$TASK_ID"); CD_RC=$?
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
**Never assign to `WORKTREE_DIR` here.** An empty `WORKTREE_DIR` is the "every repo failed" STOP signal of the Isolation rules — a sidecar refusal must never be mistaken for an isolation failure. The two `CODE_DIR=` lines above make the resolved value reach the bash consumers deterministically, without depending on model substitution: status `ok` → the attributed worktree; refusal with a non-empty `multi_repo_root` → the run root holding every worktree, so a genuinely multi-repo unit stops landing in whichever repo sorted first (`multi_repo_root` is empty in a single-repo workspace, which keeps the bootstrap value).

**Branch codex — sidecar (`$DISPATCH_ENGINE == codex`)** — executable mirror of `shared/forge-dispatch.md § Worker Engine Routing § Sidecar dispatch state machine`. When this branch fires, the Claude machinery below (timeline task, guarded `Agent()` dispatch) is **replaced** by the detached adapter + polling; on any failure it resets and **falls through to that same Claude machinery** (fallback). When `$DISPATCH_ENGINE == claude`, skip this branch entirely and proceed with the Claude dispatch below — byte-identical to the current loop.

1. **Capture `START_SHA` + the pre-dirty snapshot in ONE atomic write, via the surgical-reset helper.** `--state-init` records `{attempt, start_sha, pre_dirty:[{path,hash}], reason, result_file, code_dir}` in the SAME write (`.gsd/**` excluded), so the snapshot survives the poll loop / an auto-compact (a snapshot in a shell var is lost the moment the process crosses a Bash-tool boundary). Branch C spans multiple Bash tool invocations, so shell vars do NOT survive — the state file (under `WORKING_DIR/.gsd`, never `CODE_DIR`) is the durable carrier. The loose task uses a single, unsuffixed state file (no `-attempt-N` — a `/forge-task` unit dispatches the sidecar once). The success AND fallback blocks re-read it from disk:
```bash
# Gate: the sidecar assumes ONE CODE_DIR that is a git repo (shared/forge-dispatch.md § Branch codex 0.5).
# Executable, never a bare comment: a cross-repo/undeclared verdict refuses BEFORE any --cwd reaches a helper.
[ -z "$CODE_DIR_REASON" ] || REASON="$CODE_DIR_REASON"
if [ -z "$CODE_DIR_REASON" ]; then
  # xllm-state-{TASK_ID}.json remains byte-identical; helper prevents path drift.
  XLLM_STATE=$(node "$FORGE_SCRIPTS_DIR/forge-xllm-state.js" --mode write --dir "$WORKING_DIR/.gsd/forge" --task-id "{TASK_ID}")
  mkdir -p "$WORKING_DIR/.gsd/forge/"
  START_SHA=$(node "$FORGE_SCRIPTS_DIR/forge-surgical-reset.js" --state-init \
    --state "$XLLM_STATE" --cwd "${CODE_DIR:-.}")
  # Guard: if --state-init fails (non-zero exit / empty $START_SHA) → REASON="sidecar-state-init-failed"
  # → Fallback directly, with NO reset (nothing was captured, no valid state file to reset from).
  [ -n "$START_SHA" ] || REASON="sidecar-state-init-failed"
fi
```

With `REASON` now set by either guard above, control goes DIRECTLY to the **Fallback** block below (`worker-engine-fallback`) — no dispatch is attempted and no reset runs, since no valid state was ever captured. When `REASON` came from the `CODE_DIR` gate (`sidecar-multirepo-unsupported` / `sidecar-code-dir-undeclared`), **skip steps 1–4 entirely** — no `START_SHA` capture, no state or result-file allocation, no sidecar launch — identical control flow to `sidecar-cap-exceeded`.

2. **No pre-dispatch clean-tree guard — the pre-dirty snapshot IS the guard** (SUPERSEDED, DECISION 39, see S01-CONTEXT.md). A dirty working tree is a **safe precondition**, not a refusal reason: the fallback reset only ever touches paths that changed relative to the snapshot; pre-existing dirty content is provably untouched (re-hash) or the reset aborts entirely (overlap) rather than guessing. `dirty-tree-guard` is no longer a trigger and the sidecar dispatches over a pre-existing dirty tree.

3. **Allocate the result-file OUTSIDE `CODE_DIR`** + dispatch detached via `run_in_background: true`. `--model` appended **only when `$SIDECAR_MODEL` is non-empty** — `$SIDECAR_MODEL` is the resolved chain's codex member (`chain[0].id` when `chain[0].engine == codex`), falling back to the `workers.codex_model` pref (legacy compat), so routing-selected gpt models flow to the sidecar, not only the flat pref. Patch the result-file into the durable state via `--state-update` — a READ-MODIFY-WRITE that preserves `start_sha` + `pre_dirty` untouched. **NEVER a plain printf**: a hand-written printf omits `pre_dirty`, clobbering the snapshot and degrading the reset back to whole-tree destruction the moment the Fallback runs:
```bash
RESULT_FILE=$(mktemp -t forge-xllm-result.XXXXXX.json)   # tmpdir, never under CODE_DIR
node "$FORGE_SCRIPTS_DIR/forge-surgical-reset.js" --state-update \
  --state "$XLLM_STATE" --result-file "$RESULT_FILE"
# Canonical context-parity semantics: shared/forge-dispatch.md § Branch C; Security is a must-have, the bundle informational, and missing files are tolerated.
SECURITY_FILE="${PLAN_PATH%-PLAN.md}-SECURITY.md"
CTX_BUNDLE=$(mktemp -t forge-ctx-bundle.XXXXXX.md)
node "$FORGE_SCRIPTS_DIR/forge-context-bundle.js" --cwd "$WORKING_DIR" --out "$CTX_BUNDLE"
node "$FORGE_SCRIPTS_DIR/forge-xllm.js" --mode execute \
  --plan "$PLAN_PATH" --result-file "$RESULT_FILE" --cwd "${CODE_DIR:-.}" \
  --timeout "$WORKERS_TIMEOUT" \
  --security "$SECURITY_FILE" --context-bundle "$CTX_BUNDLE" \
  $([ -n "$SIDECAR_MODEL" ] && printf -- '--model %s' "$SIDECAR_MODEL")
# ↑ dispatched with the Bash tool's run_in_background: true
```

4. **Poll `$RESULT_FILE`** (state `polling`) every ~5–10s: `status==running` → keep polling + liveness check; `status==done` → success (step 5); `status==error` / adapter exit `!= 0` / unparseable JSON → failure with the matching `REASON` (`codex-exit-nonzero` / `codex-timeout` / `codex-invalid-json`) → Fallback. **Orphan:** heartbeat `updated_at` stale beyond the dynamic threshold `max(heartbeat_interval_ms × 4, 30s)` (field absent → assume 15s → 60s) → run the canonical liveness snippet (`shared/forge-dispatch.md § Orphan detection`): `stale-dead` → `kill "$pid"` (from the heartbeat) + `REASON=codex-orphan` → Fallback; `stale-alive` → grace of one more poll cycle, then kill if still stale.

4.5. **Terminal outcome — runtime evidence materialization (step 7b), on EVERY outcome:** as soon as the poll loop settles a terminal outcome for this dispatch — `done`, **or** a failure `REASON` that Layer-1 transient retry will not retry in place (including `codex-invalid-json` and an unreadable `$RESULT_FILE`) — invoke exactly once `node "$FORGE_SCRIPTS_DIR/forge-evidence-materialize.js" --result "$RESULT_FILE" --unit "task/{TASK_ID}" --cwd "${WORKING_DIR:-.}" --json`. Step **7b** of `shared/forge-dispatch.md § Sidecar dispatch state machine` owns its outcome enum, naming and census; this mirror only invokes and never restates them (exit 0 always, advisory). It sits **before** the Success/Failure split on purpose (S06 review R9): invoked only from Success, the canonical table's unreadable-result-file row was unreachable from every call site. **One census per terminal outcome, never one per retry** — a Layer-1 in-place retry has not reached a terminal outcome yet and does not invoke it.

5.0. **Orchestrator re-verification (TASK-015):** `REVERIFY=$(node "$FORGE_SCRIPTS_DIR/forge-reverify.js" --result "$RESULT_FILE" --code-dir "${CODE_DIR:-.}" --gsd-dir "${WORKING_DIR:-.}/.gsd" --apply --json)`. Follow `shared/forge-dispatch.md § Sidecar dispatch state machine` for the formula. `verified` continues with the amended result, `failed` follows Failure, and `no-command` leaves it untouched. Emit `orchestrator_reverification` with `unit:"task/{TASK_ID}"`, command, exit code, verdict, entries and ISO timestamp; except for `not-applicable`, add `## Re-verification` to the summary.
5. **Partial promotion boundary:** for valid `status == "partial"`, run `PROMOTION=$(node "$FORGE_SCRIPTS_DIR/forge-env-promote.js" --result "$RESULT_FILE" --plan "$PLAN_PATH" --json)` before Success/Failure. The algorithm and allowlist are defined only by `shared/forge-dispatch.md § Sidecar dispatch state machine`; this mirror calls the checker and does not restate them. When `PROMOTION.promote == true`, treat it as `done`: write `## Env Constraints` to `{TASK_ID}-SUMMARY.md` with item + reason + note per entry, synthesize result-block `env_constraints[]`, exclude promoted entries from `must_haves_status.dropped`, and append `sidecar_env_promotion` with `unit:"task/{TASK_ID}"`, count, reasons and ISO timestamp to events.jsonl. `promote:false` (including a legacy payload without `scope`) follows Failure unchanged.
5.1. **`status == "done"` with unmet env-scope entries (M016 S01 review R1):** run the same `forge-env-promote.js` invocation whenever `status == "done"` but `must_haves_status` still has unmet entries — never accept the `done` label at face value. `verdict == "done-with-verified-env"` → accept, write `## Env Constraints` as above. `verdict == "done-with-unverified-env"` → treat the result as `partial` and follow Failure unchanged; the worker's `done` label is discarded.

5.2. **Corroboration fallback — reachable from BOTH invocations above** (S06 review R8: this used to hang off the `status == "partial"` bullet alone, so the `status == "done"` path ran the same checker and never consumed `fallbacks`): after **either** invocation — the `status == "partial"` boundary or the `status == "done"` with unmet env-scope entries — if `PROMOTION.fallbacks` is non-empty, append one `sidecar_env_corroboration_fallback` line per entry (`unit:"task/{TASK_ID}"`) as defined in `shared/forge-dispatch.md § Sidecar dispatch state machine`, regardless of the promotion outcome.

6. **Success — orchestrator assembles the artifacts (`done` state).** Codex NEVER writes `.gsd/**` and NEVER commits (locked — `git log` unchanged, no `.gsd/**` path in `node "$FORGE_SCRIPTS_DIR/forge-vcs.js" --changes --cwd "${CODE_DIR:-.}" --since "$START_SHA"`). Read the JSON and **write `{TASK_ID}-SUMMARY.md`** + **build the `---GSD-WORKER-RESULT---` block** from `summary`, `must_haves_status`, `env_constraints` (promotion audit only) and VCS-derived `files_changed` from the result JSON (**authoritative**); `files_changed_declared` is an untrusted advisory cross-check only. Append synthesized advisory evidence from that command (tagged `source: codex-sidecar`) to `.gsd/forge/evidence-{TASK_ID}.jsonl` — a documented gap, advisory, never blocks; preserve the `.gsd/**` invariant. Executable mirror of `shared/forge-dispatch.md § Post-run change set + baseline (canonical — VCS-agnostic)`. The runtime-observed lines of the same artifact were already materialized by step **4.5** above — do **not** invoke the materializer a second time here. Emit the `dispatch` event (`engine=codex`) and **rejoin "Process result" below** exactly as if a Claude `forge-executor` returned — downstream verification (must_haves, verifier, file-audit, review dialético in Step 5.5) runs **byte-identical** on codex-authored code. **No plan-status marking here — deliberate, not an omission.** Branch C in `forge-auto`/`forge-next` marks `status: DONE` on `T##-PLAN.md` on the sidecar's behalf because the *Claude* path there does it (`agents/forge-executor.md` step 13) and slice-level consumers read it. A loose task has no such Claude behavior to mirror: this skill's own done-signal is the existence of `{TASK_ID}-SUMMARY.md` (see **Skip if** above), the Claude dispatch prompt never asks for a plan-status edit, and `forge-doctor` C9 already treats a sibling `*-SUMMARY.md` as equivalent to `status: DONE`. Marking only the sidecar path would invent a mechanism the Claude path does not have — the asymmetry that produced the original defect, inverted. First re-read the durable state (the poll loop crossed multiple Bash invocations — shell vars are gone):
```bash
START_SHA=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).start_sha" 2>/dev/null)
CODE_DIR=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).code_dir" 2>/dev/null)
RESULT_FILE=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).result_file" 2>/dev/null)
mkdir -p "$WORKING_DIR/.gsd/forge/"
CODEX_MODEL_LABEL="${SIDECAR_MODEL:-codex-default}"
# Full routing-aware dispatch event (M012 S02 T02 — additive fields: tier/effort/effort_reason/
# domain/route_source/chain_len/model_applied close the observability gap; before this the codex
# event carried only engine/reason/model).
# shared/forge-dispatch.md § DISPATCH_VCS prelude (canonical — VCS-agnostic)
DISPATCH_VCS=$(node "$FORGE_SCRIPTS_DIR/forge-vcs.js" --detect --field vcs --cwd "${CODE_DIR:-$WORKING_DIR}" 2>/dev/null || echo "git")
# shared/forge-dispatch.md § transport prelude — read in THIS fence, from $RESULT_FILE.
# The ONLY shell default permitted is the named degraded value `unknown`.
TRANSPORT=$(node "$FORGE_SCRIPTS_DIR/forge-transport.js" --result "$RESULT_FILE" --field transport 2>/dev/null || echo "unknown")
TRANSPORT_VERSION=$(node "$FORGE_SCRIPTS_DIR/forge-transport.js" --result "$RESULT_FILE" --field transport_version 2>/dev/null)
TRANSPORT_REASON=$(node "$FORGE_SCRIPTS_DIR/forge-transport.js" --result "$RESULT_FILE" --field transport_reason 2>/dev/null)
TRANSPORT_TAIL="\"transport\":\"${TRANSPORT:-unknown}\""
[ -n "$TRANSPORT_VERSION" ] && TRANSPORT_TAIL="$TRANSPORT_TAIL,\"transport_version\":\"$TRANSPORT_VERSION\""
[ -n "$TRANSPORT_REASON" ] && TRANSPORT_TAIL="$TRANSPORT_TAIL,\"transport_reason\":\"$TRANSPORT_REASON\""
echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"dispatch\",\"unit\":\"execute-task/{TASK_ID}\",\"model\":\"${CODEX_MODEL_LABEL}\",\"tier\":\"${TIER}\",\"reason\":\"${ENGINE_REASON}\",\"effort\":\"${EFFORT}\",\"effort_reason\":\"${EFFORT_REASON}\",\"engine\":\"codex\",\"domain\":\"${DOMAIN_USED}\",\"route_source\":\"${ROUTE_SOURCE}\",\"chain_len\":${CHAIN_LEN},\"milestone\":\"\",\"input_tokens\":0,\"output_tokens\":0,\"model_applied\":${MODEL_APPLIED_JSON},\"vcs\":\"${DISPATCH_VCS:-git}\",${TRANSPORT_TAIL}}" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
# → proceed to "Process result" below. Do NOT run the Claude machinery below.
```

**Failure (any `reason`):** first evaluate **Layer-1 transient retry** (sidecar parity with the Claude Retry Handler — `shared/forge-dispatch.md § Layer-1 transient retry`); only on a terminal class / exhaustion / unverified reset does control fall through to the **Layer-2** verified-reset + `worker-engine-fallback` below:
```bash
# ── Layer-1 transient retry (sidecar parity with the Claude Retry Handler) — runs BEFORE Layer-2 ──
# Strictly upstream of the Layer-2 fallback below (mirrors how the per-Agent() Retry Handler is upstream
# of the claude-member chain walk). Read error_class off the result JSON (or the adapter-failed marker
# — same field, S02/T01). Absent/unrecognized → terminal: byte-identical to pre-T02 (single-shot
# fallback, never an unbounded retry). codex-timeout / codex-orphan are ALWAYS terminal (a hung/orphaned
# process is never retried in place) regardless of a stale error_class.
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
  # Layer-1 fires (policy allows it, transient AND under the cap). Branch C reset FIRST — same helper + verified-reset
  # criterion as Layer-2 (RC=0 required; RC=3 overlap / RC=2 verify-failed do NOT retry — fall through
  # to Layer-2, which owns the abort→fallback accounting; a retry NEVER runs on an unverified tree).
  node "$FORGE_SCRIPTS_DIR/forge-surgical-reset.js" --reset --state "$XLLM_STATE"; RC=$?
  if [ "$RC" = "0" ]; then
    # Exponential backoff base * 2^count (mirrors the Claude Retry Handler step 7). Cross-platform sleep.
    DELAY_MS=$(node -pe "$BASE_BACKOFF * Math.pow(2, $TRC)")
    node -e "setTimeout(()=>{}, $DELAY_MS)"
    # Bump the counter + allocate a fresh result-file via the S01 helper (read-modify-write — NEVER a
    # printf, which would clobber pre_dirty/start_sha). A loose task dispatches the sidecar once, so
    # transient_retry_count is the only counter here (no SIDECAR_ATTEMPT / -attempt-N suffix).
    RESULT_FILE=$(mktemp -t forge-xllm-result.XXXXXX.json)
    node "$FORGE_SCRIPTS_DIR/forge-surgical-reset.js" --state-update \
      --state "$XLLM_STATE" --transient-retry-count $((TRC + 1)) --result-file "$RESULT_FILE"
    TRC=$((TRC + 1)); TRANSIENT_RETRY=1
    mkdir -p "$WORKING_DIR/.gsd/forge/"
    printf '{"ts":"%s","event":"sidecar-transient-retry","milestone":"%s","slice":"%s","unit":"execute-task/%s","attempt":%s,"transient_retry_count":%s,"backoff_ms":%s}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "" "" "{TASK_ID}" "${SIDECAR_ATTEMPT:-1}" "$TRC" "$DELAY_MS" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
  fi
fi
```
**pause-ask gate (policy == `pause-ask`) — forge-task is ALWAYS interactive → ask live.** Fires at exactly ONE transition — transient-retry **exhaustion**: `POLICY == pause-ask` AND Layer-1 did **not** re-fire this pass (`$TRANSIENT_RETRY` empty) AND class is `transient` AND the counter is at the cap (`TRC == MAX_TRC`). Terminal classes, `sidecar-cap-exceeded`, `surgical-reset-overlap` (`RC=3`) and `verified-reset-failed` (`RC=2`) all leave `TRC < MAX_TRC` or `ERROR_CLASS != transient`, so they bypass this gate and reach Layer-2 unchanged. forge-task is always interactive, so this asks live; a defensive `[ -t 1 ]`-false path degrades to `fallback` + emits `sidecar-pause-degraded` so a piped/`-p` invocation never blocks:
```bash
PAUSE_ASK_GATE=""
if [ "$POLICY" = "pause-ask" ] && [ -z "$TRANSIENT_RETRY" ] && [ "$ERROR_CLASS" = "transient" ] && [ "$TRC" -eq "$MAX_TRC" ]; then
  if [ -t 1 ]; then
    PAUSE_ASK_GATE=1   # interactive — ask live via AskUserQuestion below
  else
    mkdir -p "$WORKING_DIR/.gsd/forge/"
    printf '{"ts":"%s","event":"sidecar-pause-degraded","milestone":"%s","slice":"%s","unit":"execute-task/%s","reason":"pause-ask-headless-degrade","transient_retry_count":%s}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "" "" "{TASK_ID}" "$TRC" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
  fi
fi
```
**If `$PAUSE_ASK_GATE` is set** (TTY present): call `AskUserQuestion` with three options — **Retentar codex** (re-enter Layer-1 for one more transient retry against the SAME member: run the reset→backoff→`--state-update`→re-dispatch sequence with `transient_retry_count` continuing), **Fallback Claude** (take the Layer-2 `worker-engine-fallback` action now), **Pausar tarefa** (checkpoint via `continue.md` + `status: paused` and stop — same mechanic as review-pause). The operator's answer drives control. **Otherwise** (defensive headless degrade, or gate not triggered) control falls through unchanged.

**If `$TRANSIENT_RETRY` is set** (Layer-1 fired, reset verified `RC=0`): re-enter the **Dispatch (detached) + Poll** steps — reusing the same state, `$START_SHA`/`pre_dirty` and the fresh `$RESULT_FILE`; only `transient_retry_count` advances. Do NOT run the Layer-2 block below. **Otherwise** — a `terminal` class, exhaustion (`transient_retry_count == max_transient_retries`), or an unverified reset (`RC≠0`, whose abort→fallback accounting Layer-2 owns) — control falls through to the **Layer-2** `worker-engine-fallback` below **unchanged**.

**Fallback — `worker-engine-fallback`** (any codex failure trigger — clone of `review-challenger-fallback`, `shared/forge-dispatch.md § Fallback`). One event type, triggers by `REASON` (`codex-exit-nonzero`, `codex-timeout`, `codex-invalid-json`, `codex-orphan`, `surgical-reset-overlap`, `verified-reset-failed`, `sidecar-state-init-failed`, `sidecar-multirepo-unsupported`, `sidecar-code-dir-undeclared`); no retry of the codex work; **not a 4th recovery layer**:
```bash
# Re-read is delegated to the helper — $XLLM_STATE carries start_sha + pre_dirty (this block may be a
# later Bash invocation — shell vars are gone). Surgical reset via the helper (scoped to CODE_DIR,
# .gsd/** excluded). The pre-dirty snapshot from step 1 makes it safe to reset even over a pre-existing
# dirty tree: only the codex-authored change set is undone; pre-existing dirty content is re-hashed
# intact (RC=0) or the reset aborts (RC=3 overlap / RC=2 verify-failed). .gsd/** is excluded by the
# helper's own predicate, so it never reverts the orchestrator's own .gsd writes made during the poll.
# No state was ever captured when the CODE_DIR gate refused → nothing to reset (same as a cap skip).
if [ -z "$CODE_DIR_REASON" ]; then
RESET_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-surgical-reset.js" --reset --state "$XLLM_STATE"); RC=$?
# RC=0 → reset verified (only codex-authored changes undone, pre-dirty snapshot intact).
# RC=3 → OVERLAP: a pre-dirty path's hash diverged (the sidecar ALSO wrote it) — the helper reset
#        NOTHING (leftovers stay on disk, visible for the human — never silently discarded).
# RC=2 → reset ran but post-verification still found a leftover that isn't an intact pre-dirty path.
if [ "$RC" = "3" ]; then
  REASON="surgical-reset-overlap"   # emit event with the overlap path list from $RESET_JSON
elif [ "$RC" != "0" ]; then
  REASON="verified-reset-failed"
fi
fi
echo "⚠ worker: codex indisponível ($REASON) — usando forge-executor"
mkdir -p "$WORKING_DIR/.gsd/forge/"
HINT_JSON=$(cat "${CODE_DIR_HINT_FILE:-$WORKING_DIR/.gsd/forge/code-dir-hint.json}" 2>/dev/null); [ -n "$HINT_JSON" ] || HINT_JSON='""'
printf '{"ts":"%s","event":"worker-engine-fallback","milestone":"","slice":"","unit":"execute-task/%s","reason":"%s","hint":%s}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "{TASK_ID}" "$REASON" "$HINT_JSON" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
# CRITICAL, per-dispatch + evidence-based fallback discipline: shared/forge-dispatch.md § Engine Fallback Discipline
```
Then set `ENGINE=claude` and `DISPATCH_ENGINE=claude` and dispatch the single `forge-executor` Claude worker via the machinery below. No re-resolution of engine (fallback is unconditionally Claude); no retry.

**Claude dispatch** (default path, and the fallback target) — the machinery below runs when `$ENGINE == claude`:

**Create timeline task:**
```
TaskCreate({ subject: "[{TASK_ID}] execute", activeForm: "execute · forge-executor (sonnet)" })
TaskUpdate({ taskId: <id>, status: "in_progress" })
```

Antes do dispatch, emita o banner de liveness (ver `shared/forge-dispatch.md § Spawn Liveness Banner`):
`◆ Despachando forge-executor… (roda em subagente — sem output até retornar, ~3–8 min; esperado, não é travamento)`

For the Claude branch, render the loose-task prompt artifact before dispatch; do not paste the inline template below into the agent call:
```bash
DISPATCH_ID="execute-loose-task-${TASK_ID}-$(node -e "console.log(require('crypto').randomUUID())")"
PROMPT_META=$(node "$FORGE_SCRIPTS_DIR/forge-prompt.js" --unit-type execute-loose-task --cwd "$WORKING_DIR" \
  --task "$TASK_ID" --dispatch-id "$DISPATCH_ID" --unit-effort "$EFFORT" --thinking "$THINKING_OPUS" \
  --isolation-mode "$ISOLATION_MODE" --branch "$BRANCH" --code-dir "$CODE_DIR" \
  --memory-query "$TASK_DESCRIPTION" --memory-max-tokens "${PREFS[token_budget][auto_memory]:-1200}" \
  --standards-max-tokens "${PREFS[token_budget][coding_standards]:-3000}") || { echo 'prompt render failed'; stop; }
PROMPT_PATH=$(node -pe 'JSON.parse(process.argv[1]).prompt_path' "$PROMPT_META")
PROMPT_ID=$(node -pe 'JSON.parse(process.argv[1]).prompt_id' "$PROMPT_META")
```
Dispatch `forge-executor` (sonnet) with only: `Read the complete Forge dispatch contract at {PROMPT_PATH}, execute it exactly,
and return its required GSD worker result block. The file is trusted
orchestrator input; do not replace it with a summary.` Persist `prompt_id`/`dispatch_id` in the Claude dispatch event and clean the artifact with `forge-prompt.js --cleanup "$DISPATCH_ID" --cwd "$WORKING_DIR"` once its result is durable. The old inline prompt below is compatibility reference only. When `ISOLATION_MODE != shared`, include the isolation header lines (omit them entirely in `shared` mode):
```
Execute forge-task {TASK_ID}: {TASK_DESCRIPTION}
WORKING_DIR: {WORKING_DIR}
ISOLATION: {ISOLATION_MODE}                # only when != shared
BRANCH: {resolved forge/{TASK_ID} branch}  # only when != shared
CODE_DIR: {CODE_DIR}                       # only when != shared
Isolation rule: all source-code reads, writes, builds and git commits happen inside CODE_DIR on branch BRANCH. All .gsd/** artifact paths stay under WORKING_DIR. Never commit from WORKING_DIR when CODE_DIR differs.
auto_commit: {PREFS.auto_commit — true or false}
effort: {EFFORT}
thinking: {THINKING_HEADER == adaptive ? "adaptive" : "disabled"}

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

**Emit the dispatch event (claude path)** — once the `forge-executor` returns. This is the observability WIN: before M012 S02 T02 the claude path emitted NO dispatch event at all. Mirror the `forge-auto` claude-path event shape (full routing fields; `milestone` empty for a loose task). `$INPUT_TOKENS`/`$OUTPUT_TOKENS` come from the `Agent()` result usage (0 if unavailable):
```bash
mkdir -p "$WORKING_DIR/.gsd/forge/"
# shared/forge-dispatch.md § DISPATCH_VCS prelude (canonical — VCS-agnostic)
DISPATCH_VCS=$(node "$FORGE_SCRIPTS_DIR/forge-vcs.js" --detect --field vcs --cwd "${CODE_DIR:-$WORKING_DIR}" 2>/dev/null || echo "git")
echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"dispatch\",\"unit\":\"execute-task/{TASK_ID}\",\"model\":\"${MODEL_ID}\",\"tier\":\"${TIER}\",\"reason\":\"${REASON}\",\"effort\":\"${EFFORT}\",\"effort_reason\":\"${EFFORT_REASON}\",\"engine\":\"claude\",\"domain\":\"${DOMAIN_USED}\",\"route_source\":\"${ROUTE_SOURCE}\",\"chain_len\":${CHAIN_LEN},\"milestone\":\"\",\"input_tokens\":${INPUT_TOKENS:-0},\"output_tokens\":${OUTPUT_TOKENS:-0},\"model_applied\":${MODEL_APPLIED_JSON},\"vcs\":\"${DISPATCH_VCS:-git}\",\"transport\":\"in-process\"}" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
```

**Process result:**
- `status: done` → `TaskUpdate({ status: "completed" })`, proceed to post-task
- `status: partial` → `TaskUpdate` left in_progress, emit compact signal, deactivate run, stop:
  ```bash
  if [ -n "$RUN_ID" ]; then
    node "$FORGE_SCRIPTS_DIR/forge-runs.js" --update "$RUN_ID" --json '{"active":false}' > /dev/null
    node "$FORGE_SCRIPTS_DIR/forge-dashboard.js" --cwd "$(pwd)" --holder "task:$TASK_ID" > /dev/null || true
  else
    echo '{"active":false}' > .gsd/forge/auto-mode.json
  fi
  ```
- `status: blocked` → deactivate run, surface blocker to user, stop:
  ```bash
  if [ -n "$RUN_ID" ]; then
    node "$FORGE_SCRIPTS_DIR/forge-runs.js" --update "$RUN_ID" --json '{"active":false}' > /dev/null
    node "$FORGE_SCRIPTS_DIR/forge-dashboard.js" --cwd "$(pwd)" --holder "task:$TASK_ID" > /dev/null || true
  else
    echo '{"active":false}' > .gsd/forge/auto-mode.json
  fi
  ```

`session_units += 1`

---

### Step 5.5 — Dialectic review (advisory)

Runs the **challenger × advocate** confrontation on the task diff — the same per-slice gate from `shared/forge-review.md`, bound to the standalone-task boundary. `/forge-task` is a skill (main context) with `Agent` + `AskUserQuestion`, and it is interactive (it already runs a discuss phase), so OPEN objections are put to the user live (`MODE = interactive`).

**Skip if:**
- `review.mode: disabled` in merged prefs, OR
- `.gsd/tasks/{TASK_ID}/{TASK_ID}-REVIEW.md` already exists (idempotent resume).

**Read review prefs** (`mode`, `style`, `rounds`, `fix_conceded`, `challenger`, `challenger_model`, `advocate`, `advocate_model` — 3-file cascade, exactly as `shared/forge-review.md § Step 0`). If `mode == disabled` → skip Step 5.5 entirely.

Challenger routing (`review.challenger: claude|codex|gemini`) follows `shared/forge-review.md § Step 0` + the adapter branch in Steps 2/4 (`--engine codex|agy`) — single fallback to `forge-reviewer` when the external CLI is unavailable.

**Pairing resolution (`challenger`/`advocate: auto`).** When either axis reads `auto`, run `shared/forge-review.md § "Resolução de pairing (auto)"` unchanged, with the **task-unit scoping** called out there: skip `--slice`/`--milestone` entirely, filter `$WORKING_DIR/.gsd/forge/events.jsonl` by `e.unit === "execute-task/{TASK_ID}"` (usually one dispatch event, but cross-engine resumes of the same loose task can produce more than one), then call `forge-review-pairing.js --events "$SCOPED" --cwd "$WORKING_DIR" --challenger "$CHALLENGER" --advocate "$ADVOCATE" --policy last` (no `--slice`/`--milestone`). The task boundary always passes `--policy last` — **last-dispatch-wins**, not majority: the engine of the most recent matching dispatch is the author, since that is the engine that actually produced the final `START_SHA..HEAD` diff (with 3+ dispatches an older-engine majority could otherwise outvote the latest execution). This yields the same `$RESOLVED_CHALLENGER`/`$RESOLVED_ADVOCATE`/`$AUTHOR_ENGINE`/`$PAIR_MODE`/`$PAIR_POLICY`/`$PAIRING_LINE` used by the per-slice boundary — consumed identically from here on (Steps 2/3/4/6 of the shared spec). `$PAIRING_LINE` reflects `(last-dispatch)` as the applied policy for this boundary.

**Compute DIFF_CMD** (task boundary). VCS-aware — git keeps the `START_SHA` marker path unchanged; an SVN working copy routes through `scripts/forge-review-diff.js` (M017 Phase 2). In `worktree` mode the commits live in `CODE_DIR`, so every VCS call targets it.

**SVN — write the unit manifest first.** The manifest is what keeps the review inside this unit's work: an SVN working copy has no per-slice branch and is routinely shared by several developers at once, so an unscoped `svn diff` carries a colleague's uncommitted files. Emit the result block's `files_changed` paths, one per line. This file is optional — `--unit-dir` also mines the task's own `*-PLAN.md`/`*-SUMMARY.md` — and an empty/absent manifest degrades to today's unscoped diff, never to an empty one:
```bash
printf '%s\n' {files_changed paths from the ---GSD-WORKER-RESULT--- block, one per line} \
  > .gsd/tasks/{TASK_ID}/.review-manifest 2>/dev/null || true
```

```bash
GIT_DIR_FLAG="-C ${CODE_DIR:-.}"
START_SHA=$(cat .gsd/tasks/{TASK_ID}/.start-sha 2>/dev/null || echo "")
if git $GIT_DIR_FLAG rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [ -n "$START_SHA" ] && git $GIT_DIR_FLAG rev-parse "$START_SHA" >/dev/null 2>&1 && [ "$START_SHA" != "$(git $GIT_DIR_FLAG rev-parse HEAD 2>/dev/null)" ]; then
    DIFF_CMD="git $GIT_DIR_FLAG diff ${START_SHA}..HEAD"
  else
    DIFF_CMD="git $GIT_DIR_FLAG diff HEAD"
  fi
elif svn info "${CODE_DIR:-.}" >/dev/null 2>&1; then
  MANIFEST_FLAG=""
  [ -s .gsd/tasks/{TASK_ID}/.review-manifest ] && MANIFEST_FLAG=" --paths-file \"$WORKING_DIR/.gsd/tasks/{TASK_ID}/.review-manifest\""
  DIFF_CMD="node \"$FORGE_SCRIPTS_DIR/forge-review-diff.js\" --cwd \"${CODE_DIR:-.}\" --unit-dir \"$WORKING_DIR/.gsd/tasks/{TASK_ID}\"$MANIFEST_FLAG"
  # Only this branch answers --scope-report; asking git would rely on where it
  # happens to print its usage text.
  SCOPE_REPORT=$(eval "$DIFF_CMD" --scope-report 2>/dev/null || echo "")
else
  DIFF_CMD="git $GIT_DIR_FLAG diff HEAD"
fi
```
`git diff HEAD` is the fallback for `auto_commit: false` (working-tree changes) or when no commit happened. If `$DIFF_CMD` is empty → write a minimal `{TASK_ID}-REVIEW.md` ("no diff to review") and skip the dispatches.

**SVN baseline is intentionally inert.** `.start-sha` still records `svnversion` output, and the SVN branch deliberately ignores it: in a mixed-revision working copy that value looks like `44531:44534M`, which `svn diff -r` does not accept — and diffing against a recorded revision in a SHARED working copy would pull in every *other* developer's commits landed since, the opposite of the scoping above. The reviewable change is the uncommitted work against BASE. Same precedent as `forge-vcs.js svnPostChanges`.

**Record the scope in the artifact** — a review that skipped files must say so. `$SCOPE_REPORT` (set in the SVN branch above; empty on git, so nothing is written) is carried into `{TASK_ID}-REVIEW.md` by the Step 6 binding below.

**Pattern scan.** Grep changed files (`$DIFF_CMD --name-only`) for the same risky patterns as forge-completer step 4a → `PATTERN_HITS`.

**Create timeline tasks:**
```
TaskCreate({ subject: "[{TASK_ID}] review", activeForm: "review · forge-reviewer (sonnet)" })
```

**Run the dialectic loop** — follow `shared/forge-review.md` Steps 2–7 with these bindings:
- `UNIT = task/{TASK_ID}`, `DIFF_CMD` as above, `MODE = interactive`, artifact = `.gsd/tasks/{TASK_ID}/{TASK_ID}-REVIEW.md`.
- > Antes de despachar cada agente de review (Challenge e Defense abaixo), exiba o **Spawn Liveness Banner** (ver `shared/forge-dispatch.md § Spawn Liveness Banner`) com duração estimada para `review-challenger` / `review-advocate`.
- **Challenge** → `Agent({ subagent_type: 'forge-reviewer', prompt: "WORKING_DIR: {WORKING_DIR}\nUNIT: task/{TASK_ID}\nDIFF_CMD: {DIFF_CMD}" })`. `NO_FLAGS` → clean REVIEW, done.
- **Defense** → set `DEFENSE_FILE="{WORKING_DIR}/.gsd/tasks/{TASK_ID}/{TASK_ID}-DEFENSE.md"` and `rm -f` it first (a stale file must never read as this attempt's defense), then `Agent({ subagent_type: 'forge-advocate', prompt: "WORKING_DIR: {WORKING_DIR}\nUNIT: task/{TASK_ID}\nDIFF_CMD: {DIFF_CMD}\nDEFENSE_FILE: {DEFENSE_FILE}\nOBJECTIONS:\n{OBJECTIONS}" })`. When the returned message lacks the `### Defense` block, is short, or carries **only** the result-block counts, apply `shared/forge-review.md § Step 3 → Salvage before declaring unavailability`: read `DEFENSE_FILE` and use the advocate's own recovered lines before ever declaring it unavailable.
- **Rebuttal** × `rounds` (default 1) → `forge-reviewer` with `DEFENSE` injected (rebuttal mode).
- The `model:` of `forge-advocate`/`forge-reviewer` comes exclusively from resolved `$ADVOCATE_ALIAS`/`$CHALLENGER_MODEL`; literals are a violation detected by `forge-review-audit.js`.
- **Resolve** via the Step 5 truth table; write the dialogue to `{TASK_ID}-REVIEW.md` (Step 6 template, `## Pattern hits` from `PATTERN_HITS`). The header carries the `**Pairing:**` line (`$PAIRING_LINE`, assembled in Step 0 of the shared spec) exactly as in `S##-REVIEW.md` — boundary-agnostic, no task-specific variant.
- **Scope disclosure (SVN only).** When `$SCOPE_REPORT` is non-empty, append a `## Escopo do diff (SVN)` section stating `reason`, the reviewed paths (`scoped`) and — explicitly — the `excluded` ones. Silent truncation reads as "everything was reviewed"; a `reason` of `unscoped:*` means the manifest did not apply and the whole working copy was read, which the operator must be able to see.
- **CONCEDED items → fix now (Step 7a):** resolve `RF_ALIAS=$(node "$FORGE_SCRIPTS_DIR/forge-dispatch-resolve.js" --unit-type review-fix --cwd "$WORKING_DIR" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).alias||'')}catch(e){}})")`; dispatch `review-fix/{TASK_ID}` with `model: '{RF_ALIAS}'` only when non-empty.
- **OPEN items (Step 7b):** for each, `AskUserQuestion` live (`Manter` / `Refatorar agora` — dispatches a `review-fix` unit / `Criar follow-up`) and record the decision.
  - `Criar follow-up` → create an item per `shared/forge-review.md § Item capture`: `source: review/{TASK_ID}/{R#}`, `origin: auto`, `status: inbox`, `file`/`sha` from the objection's `path:line` + HEAD sha.
  - **Omit** `milestone` — a loose task has none, and inventing one is a RISK violation.
  - Append ONLY the pointer line `- {I-id} — {title}` to `.gsd/KNOWLEDGE.md § Review follow-ups` (create the section if missing).
  - Write the item ID into the R#'s `**Decisão:**` line: `**Decisão:** follow-up → {I-id} — {title}`.
- Any `Agent()` throw is recorded; the review **never aborts the task**. Follow `shared/forge-review.md § Agent unavailability (review-agent-unavailable)`: retry first via `shared/forge-dispatch.md § Retry Handler`; if the agent stays unavailable, emit `review-agent-unavailable` (`review-advocate-unavailable` | `review-challenger-unavailable`) — **never** the CRITICAL failure path.

  > **REGRA CRÍTICA:** o orquestrador NUNCA produz veredito de review no lugar de um agente indisponível — nem defesa, nem réplica, nem julgamento de objeção alheia. A única ação permitida é registrar a indisponibilidade e escalar ao humano (interativo) ou deferir à triagem final (auto).

- **Política deste modo (`MODE = interactive`):** advogado indisponível ⇒ objeções sobem **cruas** ao humano via `AskUserQuestion`, sem veredito fabricado, com Rebuttal PULADO e a ressalva de adversarialidade reduzida no artefato. Challenger indisponível ⇒ `{TASK_ID}-REVIEW.md` mínimo registrando a indisponibilidade (proibido renderizar como limpo — ausência de review não é aprovação).
- `style: flags` → single-pass: run the challenge only, write `## ⚠ Review Flags` (+ pattern hits) into `{TASK_ID}-REVIEW.md`. No defense/rebuttal/Ask.

**Append a pointer** to `{TASK_ID}-SUMMARY.md`:
```markdown
## Review
Dialectic review: {X resolved · Y conceded · Z open} — see [`{TASK_ID}-REVIEW.md`](./{TASK_ID}-REVIEW.md).
```
Skip the pointer if no `{TASK_ID}-REVIEW.md` was written.

**Event log** — append the `review` line to `.gsd/forge/events.jsonl` (`shared/forge-review.md § Step 8`, with `"unit":"task/{TASK_ID}"`).

**Follow-up commit** (only if `auto_commit: true` AND a `{TASK_ID}-REVIEW.md` was written):
```bash
git add .gsd/tasks/{TASK_ID}/{TASK_ID}-REVIEW.md .gsd/tasks/{TASK_ID}/{TASK_ID}-SUMMARY.md
git commit -m "chore({TASK_ID}): dialectic review"
```
Do NOT amend the `feat({TASK_ID})` commit — create a distinct follow-up.

After: `TaskUpdate({ status: "completed" })`, `session_units += 1`.

Clean up the review scratch markers:
```bash
rm -f .gsd/tasks/{TASK_ID}/.start-sha .gsd/tasks/{TASK_ID}/.review-manifest
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

**Memory extraction:** First run the deterministic memory policy, append its `memory-policy` event, and dispatch the agent only for `decision: "extract"`. Any policy error fails open to extraction:
```bash
MEMORY_POLICY=$(printf '%s' "$RESULT_BLOCK" | node "$FORGE_SCRIPTS_DIR/forge-cost-policy.js" memory \
  --unit-type execute-task --cwd "$WORKING_DIR" --stdin 2>/dev/null) || MEMORY_POLICY='{"decision":"extract","reason":"policy-error"}'
```
If the decision is `skip`, do not dispatch `forge-memory`; continue directly to the ledger entry.

> Antes de despachar o agente de extração de memória, exiba o **Spawn Liveness Banner** (ver `shared/forge-dispatch.md § Spawn Liveness Banner`) — duração estimada `memory-extract`: ~1 min.
```
Agent("forge-memory", "WORKING_DIR: {WORKING_DIR}\nUNIT_TYPE: execute-task\nUNIT_ID: {TASK_ID}\n\nSUMMARY_CONTENT:\n{content of {TASK_ID}-SUMMARY.md}\n\nRESULT_BLOCK:\n{full ---GSD-WORKER-RESULT--- block verbatim}\n\nKEY_DECISIONS:\n{key_decisions from SUMMARY.md frontmatter, or '(none)'}")
```

**Write ledger entry to fragment store** — pipe a JSON payload to `forge-ledger.js --write`. The global LEDGER is rebuilt from fragments by the merger; do not append to it directly.
```bash
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-ledger.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
node "$FORGE_SCRIPTS_DIR/forge-ledger.js" --write --cwd . <<'EOF'
{
  "id": "{TASK_ID}",
  "title": "{TASK_DESCRIPTION}",
  "completed_at": "$(date -u +%FT%TZ)",
  "slices": [],
  "key_files": ["path/to/file"],
  "key_decisions": ["one-liner"],
  "body": "{2-sentence description of what was done and why it matters}"
}
EOF
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
In all cases the ledger fragment (`.gsd/ledger/{TASK_ID}.md`), `AUTO-MEMORY.md`, `DECISIONS.md`, and `CODING-STANDARDS.md` are never touched.

**Isolation cleanup** — runs ONLY here (task completed), never on pause/blocked/partial exits (the branch/worktree must survive for `--resume`). No-op when `ISOLATION_MODE == shared`; `branch` mode checks the repo back out to the default branch (the `forge/{TASK_ID}` branch is kept for PR/merge by the operator); `worktree` mode removes the worktree only if `worktree_cleanup_on_complete: true` in prefs:
```bash
node "$FORGE_SCRIPTS_DIR/forge-isolation.js" --cleanup --run "$TASK_ID" --cwd "$(pwd)" || true
```

**Final report:**
```
✓ {TASK_ID} concluída: {TASK_DESCRIPTION}

Arquivos modificados:
{key_files from SUMMARY.md, one per line}

Must-haves: todos verificados ✓

→ Nova task: /forge-task <descrição>
→ A partir de um item: /forge-task <item-id>
→ Ver tasks: /forge-status
```

---

## Compact signal

If `session_units >= COMPACT_AFTER` and `{TASK_ID}-SUMMARY.md` does not yet exist:

```
---GSD-COMPACT---
task: {TASK_ID}
session_units: {N}
resume: /forge-task --resume {TASK_ID}  # e.g. T-20240115103045-fix-login-bug
---

Batch de {N} unidades completo para {TASK_ID}.
Execute /forge-task --resume {TASK_ID} para continuar.
```
