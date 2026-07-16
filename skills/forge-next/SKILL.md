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

## Isolation setup (branch/worktree)

Apply `forge_isolation` from prefs before dispatching the unit. Idempotent — re-running on every `/forge-next` invocation is safe (`already-on-branch` / `already-exists`). `$ISO_RUN` is the active milestone ID from STATE.md:

```bash
ISO_RUN="<active milestone ID from STATE.md>"
ISO_RESULT=$(node "$FORGE_SCRIPTS_DIR/forge-isolation.js" --setup --run "$ISO_RUN" --cwd "$WORKING_DIR")
ISOLATION_MODE=$(node -e "process.stdout.write((JSON.parse(process.argv[1]).mode)||'shared')" "$ISO_RESULT")
WORKTREE_DIR=$(node -e "const r=JSON.parse(process.argv[1]);const w=(r.repos||[]).find(x=>x.worktree&&x.status!=='error');process.stdout.write(w?w.worktree:'')" "$ISO_RESULT")
ISO_ERRORS=$(node -e "const r=JSON.parse(process.argv[1]);process.stdout.write((r.repos||[]).filter(x=>x.status==='error').map(x=>x.path+': '+x.error).join('; '))" "$ISO_RESULT")
echo "ISOLATION_MODE=$ISOLATION_MODE  WORKTREE_DIR=${WORKTREE_DIR:-—}  ISO_ERRORS=${ISO_ERRORS:-none}"
```

Isolation rules (CRITICAL — the operator configured this; honor it):
- `shared` → `WORKER_CWD = $WORKING_DIR`. Nothing else to do.
- `branch` → `WORKER_CWD = $WORKING_DIR`. Workers commit on the `forge/{run}` branch the setup just checked out.
- `worktree` → `WORKER_CWD = $WORKTREE_DIR`. ALL code reads/writes/commits happen inside the worktree; `.gsd/**` artifacts ALWAYS stay under `$WORKING_DIR`.
- `ISO_ERRORS` non-empty AND no repo succeeded → STOP and surface the errors. Running un-isolated when the operator configured isolation is NOT an acceptable fallback.
- When mode != shared, emit one line: `⛓ Isolation: {mode} → {branch name or worktree path}`.

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

**Depends-aware task pick (execute-task only):** `forge-next` is strictly **sequential** — never dispatches more than one task — but it must still respect `depends:[]` declared in `T##-PLAN.md` frontmatter. Without this, `forge-next` would try to run tasks in STATE-declared order even when a predecessor is incomplete, producing broken dispatches.

After the dispatch table resolves `unit_type == execute-task`, ask `forge-parallelism.js` which task to pick. The script, invoked with `--max-concurrent 1`, returns the **first pending task in plan order whose `depends:[]` are satisfied** (by `T##-SUMMARY.md` existence). Legacy plans (any task missing `depends`/`writes` frontmatter) fall back to the first pending task in plan order — preserving pre-parallelism behavior exactly.

```bash
SLICE_PLAN=".gsd/milestones/${M###}/slices/${S##}/${S##}-PLAN.md"
BATCH_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-parallelism.js" --slice-plan "$SLICE_PLAN" --max-concurrent 1)
PICK_MODE=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).mode)" "$BATCH_JSON")
PICK_ID=$(node -e "const r=JSON.parse(process.argv[1]);const b=r.batch||[];process.stdout.write(b[0]?b[0].id:'')" "$BATCH_JSON")
```

Handle `PICK_MODE`:
- `single` or `legacy` or `parallel` — use `PICK_ID` as `unit_id` (override STATE's T## if different; the picker knows best). `parallel` mode can still happen here because the script computes the full ready set — just take `batch[0]`. The user only sees one dispatch.
- `none` — all tasks complete; re-derive (should flip to `complete-slice`).
- `blocked` — surface to user: `⚠ Dispatch bloqueado: todas as tasks pendentes dependem de unidades não concluídas. Motivo: {reason}`. Stop without dispatching.
- `error` — stop and surface the error.

If STATE's `next_action` referenced a different T## than `PICK_ID`, emit one line so the user sees the swap:
```
↷ Pulando para {PICK_ID} (STATE apontava para {STATE_T##}, mas {STATE_T##} depende de tasks ainda pendentes)
```

**Crash detection:** Before dispatching `execute-task`, read `T##-PLAN.md`. If it contains `status: RUNNING`, the previous session crashed mid-task. Warn the user:
> ⚠ Task {T##} was interrupted (status: RUNNING). Re-executing from scratch.
Then proceed with dispatch normally (the executor will overwrite the partial work).

**Dynamic routing:** If `T##-PLAN.md` contains `complexity: heavy`, route `execute-task` to `forge-executor` on opus.

**Effort is resolved in step 1.55 below** (after tier resolution), because the per-model capability clamp needs the resolved `$MODEL_ID`. Do NOT resolve effort here.

**Route resolution (step 1.45) — engine + domain inputs (single-call resolver).** As of M007 S02 the engine decision and the tier-chain resolution **collapse into ONE call** to `forge-routing.js` (made in Tier Resolution step 4 below — never two calls). This step resolves only the *inputs* that call consumes: `$DOMAIN` (domain metadata), `$PLAN_WORKER` (frontmatter `worker:` override, execute-task only), and the legacy-compat `workers:` reader (`$WORKERS_ENGINE`/`$WORKERS_TIMEOUT`/`$CODEX_MODEL`) used only when `route_source == tier_models`. `$ENGINE` itself is decided **after** the routing call, from its `route_source` (see step 1.5 step 4-engine). Executable mirror of `shared/forge-dispatch.md § Worker Engine Routing` (canonical). `forge-next` is sequential — no parallel-batch — so this is simpler than `forge-auto`; the block contract (vars, reasons, event) is otherwise **byte-identical** to the `forge-auto` mirror.
> Cross-reference: `shared/forge-dispatch.md § Worker Engine Routing` (single-call resolver, route_source table, prefs reader, sidecar state machine, fallback). Any change lands there first, then propagates here.

When the resolved `$ENGINE == codex` **and** `$unit_type == execute-task`, the Claude Tier/Effort machinery below (alias, timeline, guarded `Agent()`) is **skipped** (Codex resolves its own model via the sidecar) — it runs only on the Claude path, including the fallback. When `$ENGINE == codex` **and** `$unit_type == plan-slice`, the Claude machinery is likewise **skipped** — Branch D (sidecar plan, read-only) fires instead. `$ENGINE == claude` (or `codex` for a non-routable unit) → control flows straight to the Claude dispatch (byte-identical to the current loop). `execute-task` and `plan-slice` (**active — S03**) are the two routable unit types.

```bash
# ── Route resolution inputs (engine decided AFTER the routing call — step 1.5 step 4) ──
# Reader — regex-over-raw-prefs (prefs-resolved.json does NOT exist — MEM001 M005):
#   workers.<unit_type> across the 3-file cascade (default-safe claude), [ \t] never \s, no \Z.
WORKERS_CFG=$(WORKING_DIR="$WORKING_DIR" UNIT_TYPE="$unit_type" node -e "
const fs=require('fs'),path=require('path'),os=require('os');
const wd=process.env.WORKING_DIR||process.cwd();
const unit=process.env.UNIT_TYPE||'execute-task';
const files=[path.join(os.homedir(),'.claude','forge-agent-prefs.md'),
             path.join(wd,'.gsd','claude-agent-prefs.md'),
             path.join(wd,'.gsd','prefs.local.md')];
let engine=null,timeout=1800,codexModel=null;
for(const f of files){try{
  const r=fs.readFileSync(f,'utf8');
  const blk=(r.match(/^workers:[ \t]*\n((?:[ \t]+.*\n?)*)/m)||[])[1]||'';
  let m;
  const unitRe=new RegExp('^[ \\\\t]+'+unit.replace(/[-]/g,'\\\\-')+':[ \\\\t]*(\\\\w+)','m');
  if(m=blk.match(unitRe)){const v=m[1].toLowerCase();if(v==='claude'||v==='codex')engine=v;}
  if(m=blk.match(/^[ \t]+timeout:[ \t]*(\d+)/m))timeout=parseInt(m[1],10);
  if(m=blk.match(/^[ \t]+codex_model:[ \t]*(\S+)/m))codexModel=m[1];
}catch(e){}}
if(engine!=='claude'&&engine!=='codex')engine='claude';
if(!Number.isInteger(timeout)||timeout<=0)timeout=1800;
process.stdout.write(JSON.stringify({engine,timeout,codexModel}));
")
WORKERS_ENGINE=$(printf '%s' "$WORKERS_CFG" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).engine||'claude')}catch(e){process.stdout.write('claude')}})")
WORKERS_TIMEOUT=$(printf '%s' "$WORKERS_CFG" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(String(JSON.parse(d).timeout||1800))}catch(e){process.stdout.write('1800')}})")
CODEX_MODEL=$(printf '%s' "$WORKERS_CFG" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).codexModel||'')}catch(e){process.stdout.write('')}})")

# Frontmatter worker: override (execute-task only) — precedence over pref.
PLAN_WORKER=""
if [ "$unit_type" = "execute-task" ]; then
  PLAN_PATH=".gsd/milestones/${M###}/slices/${S##}/tasks/${T##}/${T##}-PLAN.md"
  PLAN_WORKER=$(node -e "
    const fs=require('fs');
    const text=fs.readFileSync('$PLAN_PATH','utf8');
    const m=text.match(/^---[\s\S]*?---/);
    if(!m)process.exit(0);
    let v=((m[0].match(/^worker:[ \t]*(\S+)/m)||[])[1]||'').trim().toLowerCase();
    if(v!=='claude'&&v!=='codex')v='';   // whitelist; invalid → fall through
    process.stdout.write(v);
  ")
fi

# Domain metadata (execute-task frontmatter domain: → slice ROADMAP domain: tag → default).
# Authoritative shape: shared/forge-dispatch.md § Domain metadata. [ \t] never \s.
DOMAIN=""
if [ "$unit_type" = "execute-task" ] && [ -n "$PLAN_PATH" ]; then
  DOMAIN=$(node -e "const fs=require('fs');try{const t=fs.readFileSync('$PLAN_PATH','utf8');const m=t.match(/^---[\s\S]*?---/);process.stdout.write(m?((m[0].match(/^domain:[ \t]*(.+)$/m)||[])[1]||'').trim():'')}catch(e){}" 2>/dev/null)
fi
if [ -z "$DOMAIN" ]; then
  # Fall back to the slice's ROADMAP domain: tag (both execute-task and plan-slice grep the slice line).
  ROADMAP_PATH=".gsd/milestones/${M###}/${M###}-ROADMAP.md"
  DOMAIN=$(grep -E "\b${S##}\b" "$ROADMAP_PATH" 2>/dev/null | grep -oE 'domain:[A-Za-z0-9_-]+' | head -1 | cut -d: -f2)
fi
[ -z "$DOMAIN" ] && DOMAIN="default"
```
`$WORKERS_ENGINE`, `$WORKERS_TIMEOUT`, `$CODEX_MODEL`, `$PLAN_WORKER`, `$DOMAIN` (and `$PLAN_PATH` for execute-task) are now set. `$ENGINE`/`$ENGINE_REASON` are resolved by Tier Resolution step 4 (engine decision by `route_source`) **after** the single `forge-routing.js` call — not here. The Step 4 dispatch then branches on `$ENGINE`.

**Tier resolution (step 1.5)** — resolve `{tier, model, chain, reason}` for this dispatch via the **SINGLE `forge-routing.js` call** (step 4 below), which also resolves `$ENGINE` from `route_source`. Steps 1–3 (tier classification) always run; the routing call in step 4 always runs (it produces the chain + engine). Once `$ENGINE` is known: **when `$ENGINE == codex` && `$unit_type == execute-task`, skip Effort Resolution (step 1.55), the alias resolution and the Claude `Agent()` machinery** — the sidecar resolves its own model. Effort/alias/`Agent()` run only on the Claude path (including the `worker-engine-fallback` path, which re-enters them).
> Cross-reference: `shared/forge-dispatch.md § Tier Resolution` (single-call algorithm) and `shared/forge-tiers.md` (canonical tables).

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

# Step 4: resolve model + cross-engine chain via the SINGLE forge-routing.js call (raw cascade —
# NEVER prefs-resolved.json; MEM001 M005). Replaces the old forge-tier-chain.js --json initial
# resolution; forge-tier-chain.js survives ONLY as an internal legacy reader inside forge-routing.js.
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-routing.js ] && echo scripts || echo "$HOME/.claude/scripts")
ROUTE_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-routing.js" \
  --unit-type "$unit_type" --tier "$TIER" --domain "$DOMAIN" \
  --frontmatter-tier "$PLAN_TIER" --frontmatter-worker "$PLAN_WORKER" \
  --cwd "$WORKING_DIR")     # SEMPRE $WORKING_DIR, nunca $CODE_DIR (MEM018)
MODEL_ID=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).chain[0].id)" "$ROUTE_JSON")
ROUTE_SOURCE=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).source)" "$ROUTE_JSON")
CHAIN_LEN=$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).chain.length))" "$ROUTE_JSON")
DOMAIN_USED=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).domain_used)" "$ROUTE_JSON")
CHAIN0_ENGINE=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).chain[0].engine||'claude')" "$ROUTE_JSON")
# $ROUTE_JSON.chain carries forward unmodified — consumed by the Failure Taxonomy via
# `node "$FORGE_SCRIPTS_DIR/forge-routing.js" ... --next-after "$MODEL_ID"` on model_refusal/429/400
# (walks the cross-engine chain → category fallback → ''), BEFORE any cross-tier escalation
# (context_overflow's ladder is separate — re-resolves THROUGH routing at the escalated tier; see
# the Failure Taxonomy below and shared/forge-dispatch.md § context_overflow).

# Step 4-engine: decide ENGINE by route_source (NOT a separate Engine Resolution step).
# routing/frontmatter → routing drives (chain[0].engine); tier_models → legacy compat (workers pref).
if [ "$ROUTE_SOURCE" = "routing" ] || [ "$ROUTE_SOURCE" = "frontmatter" ]; then
  ENGINE="$CHAIN0_ENGINE";      ENGINE_REASON="route:$ROUTE_SOURCE:$CHAIN0_ENGINE"
elif [ -n "$PLAN_WORKER" ]; then
  ENGINE="$PLAN_WORKER";        ENGINE_REASON="frontmatter-worker:$PLAN_WORKER"
elif [ -n "$WORKERS_ENGINE" ] && [ "$WORKERS_ENGINE" != "claude" ]; then
  ENGINE="$WORKERS_ENGINE";     ENGINE_REASON="workers.$unit_type:$WORKERS_ENGINE"
else
  ENGINE="claude";              ENGINE_REASON="default:claude"
fi

# Step 4-shadow: shadowing warning (risk #3) — routing: configured but not applied (advisory, stderr).
ROUTING_PRESENT=$(FSD="$FORGE_SCRIPTS_DIR" node -e "const p=require('path').resolve(process.env.FSD,'forge-routing.js');try{process.stdout.write(String(require(p).readRoutingConfig(process.argv[1]).present))}catch(e){process.stdout.write('false')}" "$WORKING_DIR" 2>/dev/null || echo false)
if [ "$ROUTE_SOURCE" != "routing" ] && [ "$ROUTING_PRESENT" = "true" ]; then
  echo "⚠ routing: configurado mas não aplicado (route_source=$ROUTE_SOURCE) — frontmatter/legado venceu para $unit_type/$unit_id" >&2
fi

# Step 4b: tier-chain cursor (consume-once) — CROSS-ENGINE. A prior model_refusal/429/400 wrote the
# next chain member (+ its engine) here; consume it so THIS run dispatches $NEXT, not the refused
# primary. Engine re-derived via forge-model-alias.js --family when absent (legacy cursor). Write side: Failure Taxonomy.
TIER_CURSOR_FILE="$WORKING_DIR/.gsd/forge/tier-cursor-${RUN_ID:-legacy}-${unit_type}-${unit_id}.json"
if [ -f "$TIER_CURSOR_FILE" ]; then
  CM=$(node -pe "(JSON.parse(require('fs').readFileSync('$TIER_CURSOR_FILE','utf8')).model)||''" 2>/dev/null)
  CE=$(node -pe "(JSON.parse(require('fs').readFileSync('$TIER_CURSOR_FILE','utf8')).engine)||''" 2>/dev/null)
  rm -f "$TIER_CURSOR_FILE"   # consume-once: delete so the next /forge-next re-resolves from chain[0]
  if [ -n "$CM" ]; then
    MODEL_ID="$CM"; REASON="tier-chain-cursor:$CM"
    # Re-inspect engine → Branch codex or Claude Agent. --family maps id → 'claude'|'gpt'|''; gpt == codex.
    [ -z "$CE" ] && { case "$(node "$FORGE_SCRIPTS_DIR/forge-model-alias.js" --family "$CM" 2>/dev/null)" in gpt) CE=codex;; *) CE=claude;; esac; }
    ENGINE="$CE"; ENGINE_REASON="tier-chain-cursor:$CE"
  fi
fi
```
`TIER`, `MODEL_ID`, `ROUTE_JSON` (`chain`), `ROUTE_SOURCE`, `CHAIN_LEN`, `DOMAIN_USED`, `ENGINE`, `ENGINE_REASON`, and `REASON` are now set. Use `$MODEL_ID`/`$ENGINE` in the dispatch below (Step 4). `$TIER`, `$REASON`, `$DOMAIN_USED`, `$ROUTE_SOURCE`, `$CHAIN_LEN` are injected into the dispatch event.

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

**Review gate (before complete-slice):** If `unit_type == complete-slice`, run the **dialectic review** on the slice diff BEFORE dispatching `forge-completer` (the slice branch `gsd/{M###}/{S##}` is still unmerged here, so the diff is intact). This is the challenger × defender confrontation:

1. Idempotency: if `{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-REVIEW.md` already exists → skip the gate, proceed to `complete-slice`.
2. Read `review.{mode,style,rounds,ask_in_auto,engine,challenger,challenger_model}` via the cascade in `shared/forge-review.md § Step 0`. If `mode == disabled` → skip.
   - Challenger routing (`review.challenger: claude|codex`) follows `shared/forge-review.md § Step 0` + the Codex branch in Steps 2/4 — single fallback to `forge-reviewer` when codex is unavailable.
   - `challenger: codex` forces `engine: agents` (the `workflow` script cannot route Codex) — see the precedence block in the spec.
3. Execute the procedure in **`shared/forge-review.md`** with `MODE = interactive`:
   > Antes de despachar cada agente (Challenge e Defense abaixo), exiba o **Spawn Liveness Banner** (ver `shared/forge-dispatch.md § Spawn Liveness Banner`) com duração estimada para `review-challenger` / `review-advocate`.
   - **Engine** (`shared/forge-review.md § Engine workflow`): se `engine: workflow` e a tool `Workflow` estiver no seu tool list (introspecção — NÃO ToolSearch), os três dispatches abaixo (Challenge/Defense/Rebuttal) são substituídos por UMA invocação Workflow; em tool ausente ou erro → fallback agents com warning + evento `review-engine-fallback`. O render do Step 6 e os Steps 7a/7b/8 não mudam.
   - Challenge → `Agent({ subagent_type: 'forge-reviewer', … })`
   - Defense → `Agent({ subagent_type: 'forge-advocate', … })`
   - Rebuttal × `rounds` → `forge-reviewer` in rebuttal mode (DEFENSE injected)
   - Resolve (Step 5 truth table), write `{S##}-REVIEW.md` (Step 6).
   - **CONCEDED items → fix now (Step 7a):** dispatch `Agent({ subagent_type: 'forge-executor', … })` with `UNIT: review-fix/{S##}` to fix ONLY the conceded items on the still-unmerged slice branch (skip when `review.fix_conceded: false` — then list and ask once, legacy behavior). Mark each `**Correção:** aplicada — commit {sha}` or `falhou — deferida para triagem final`. No re-review of the fix commit.
   - **OPEN items (Step 7b, interactive):** each OPEN objection is put to the user via `AskUserQuestion` — `Manter abordagem` / `Refatorar agora` (dispatches a `review-fix` unit for the accepted items) / `Criar follow-up` — and the decision is written back into `{S##}-REVIEW.md`.
   - Append the `review` event to `events.jsonl` (Step 8).
4. The gate **never blocks** — any `Agent()` throw is recorded and the step proceeds to `complete-slice` regardless.

> Fires ONLY when the derived unit is `complete-slice`. Boundary is per-slice; standalone `/forge-task` keeps its own step-5.5 review. After the gate, dispatch `forge-completer` normally.

**Review triage gate (before complete-milestone):** If `unit_type == complete-milestone`, run the milestone-final triage (`shared/forge-review.md § Step 9`) BEFORE dispatching `forge-completer`. In pure forge-next sessions OPEN items were already decided live per-slice, so this usually finds nothing and skips silently — it exists for mixed sessions (slices run under `forge-auto` with `ask_in_auto: defer`, milestone closed via `forge-next`): scan all `{S##}-REVIEW.md` for pending `deferido`/`falhou — deferida` items, triage each via `AskUserQuestion`, dispatch ONE `review-fix/{M###}-triage` for the `Refatorar agora` items, write decisions back, append the `review-triage` event. Never blocks the close-out.

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
   {"ts":"<ISO-8601>","event":"plan_check","milestone":"{M###}","slice":"{S##}","mode":"{PLAN_CHECK_MODE}","counts":{"pass":N,"warn":N,"fail":N}}
   ```

9. **Branch on `PLAN_CHECK_MODE`:**
   - `advisory` → proceed to the plan gate (interactive) → symbol-check gate → first `execute-task` regardless of counts.
   - `blocking` → enter the **Blocking-mode revision loop** below.
   - (`disabled` already handled in step 2.)

10. **Forward-compatibility note:** future M004+ may add per-dimension enforcement. The current wire passes through all dimension counts to events.jsonl so future code can filter.

> This gate fires ONLY when transitioning from a just-completed `plan-slice` to the first `execute-task` of the same slice. When deriving the next unit (Step 1) results in `execute-task` AND the previous completed unit was `plan-slice` for the same slice, run this gate. For subsequent `execute-task` dispatches within the same slice, the idempotency check (step 3 above) ensures the gate is a no-op.

**Plan gate (interactive) (after plan-check gate, before symbol-check gate):**

Roda o handshake interativo do plan gate (spec autoritativa: `shared/forge-plan-gate.md`) no boundary do `forge-next`: após o `forge-plan-checker` retornar `plan_check_counts` e escrever `{S##}-PLAN-CHECK.md` (plan-check gate acima) e **antes** do symbol-check gate / primeiro `execute-task`. `forge-next` é sempre interativo → `MODE = interactive`. `forge-auto` NÃO executa este gate (`MODE = auto` → degradação auditável; ver `shared/forge-plan-gate.md § Degradation by mode`).

**Binding forge-next (conforme `shared/forge-plan-gate.md` tabela de consumidores):**

| Campo | Valor |
|-------|-------|
| UNIT | `plan-slice/{S##}` |
| PLAN_GLOB | `{S##}-PLAN.md` + `tasks/*/T##-PLAN.md` |
| MODE | `interactive` (forge-next é sempre interativo) |
| Approval marker | `{S##}-PLAN-GATE.md` |
| GATE_MARKER path | `{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN-GATE.md` |

> **R4 (batching de findings — resolvido para planos estruturados):** planos do `forge-next` têm `plan_check_counts` reais e podem ter múltiplos `warn`/`fail` por dimensão e task. Regra operacional: findings `fail` são SEMPRE perguntas individuais; findings `warn` podem ser agrupados em UMA `AskUserQuestion` (até 4 por call) somente quando compartilham a mesma dimensão OU a mesma task-id — caso contrário, perguntas separadas. Cada finding agrupado mantém sua própria resolução registrada individualmente no marker.

> **Não-aninhamento de plan mode:** o `forge-next` roda no contexto do orquestrador, que não carrega plan mode herdado. O gate usa **somente `AskUserQuestion`** — NÃO usa `EnterPlanMode`/`ExitPlanMode`. Ver `shared/forge-plan-gate.md § Plan-mode non-nesting`.

> **NUNCA** usar `{S##}-PLAN-CHECK.md` como marker de aprovação — esse arquivo pertence ao `forge-plan-checker` (agente advisory separado).

**Skip conditions (verificar antes de qualquer bloco bash):**

1. `{S##}-PLAN-GATE.md` já existe com `status: approved` → pular (resume idempotente pós-compactação, não re-pergunta o operador). Prosseguir diretamente ao symbol-check gate.
2. `plan_gate.interactive == off` → pular o gate inteiro; comportamento batch-advisory atual intocado (sem preview, sem `AskUserQuestion`, sem marker).

---

#### Gate Step 0 — Cascade-read da pref `plan_gate:`

```bash
PLAN_GATE_CFG=$(node -e "
const fs=require('fs'),path=require('path'),os=require('os');
const wd=process.env.WORKING_DIR||process.cwd();
const files=[path.join(os.homedir(),'.claude','forge-agent-prefs.md'),
             path.join(wd,'.gsd','claude-agent-prefs.md'),
             path.join(wd,'.gsd','prefs.local.md')];
let interactive='always',askAuto='defer';
for(const f of files){try{
  const r=fs.readFileSync(f,'utf8');
  const blk=(r.match(/^plan_gate:[ \t]*\n((?:[ \t]+.*\n?)*)/m)||[])[1]||'';
  let m;
  if(m=blk.match(/^[ \t]+interactive:[ \t]*(\w+)/m))interactive=m[1].toLowerCase();
  if(m=blk.match(/^[ \t]+ask_in_auto:[ \t]*(\w+)/m))askAuto=m[1].toLowerCase();
}catch(e){}}
if(!['always','auto','off'].includes(interactive))interactive='always';
if(!['defer','off'].includes(askAuto))askAuto='defer';
process.stdout.write(JSON.stringify({interactive,askAuto}));
" WORKING_DIR=\"$WORKING_DIR\")

INTERACTIVE=$(node -e "process.stdout.write(JSON.parse(process.env.PLAN_GATE_CFG).interactive)" PLAN_GATE_CFG="$PLAN_GATE_CFG")
ASK_AUTO=$(node -e    "process.stdout.write(JSON.parse(process.env.PLAN_GATE_CFG).askAuto)"    PLAN_GATE_CFG="$PLAN_GATE_CFG")
```

> **Nota regex (crítica):** o cascade usa `/^plan_gate:[ \t]*\n((?:[ \t]+.*\n?)*)/m` com `[ \t]` e flag `m`. **Nunca use `\Z`** — não existe em JS regex (vira o char literal `Z`, ignorando blocos no fim do arquivo — mesmo bug que quebrou `forge_isolation`). Copiar verbatim da spec.

**Semântica da pref `interactive`:**

| Valor | Comportamento |
|-------|---------------|
| `always` (default) | Conduzir o gate em todo plano — preview + aprovação sempre, mesmo all-pass. |
| `auto` | Conduzir só quando `warn > 0` ou `fail > 0`. Auto-aprovar silenciosamente se `warn==0 && fail==0`. |
| `off` | Pular o gate inteiro — comportamento batch-advisory atual. Ir direto ao symbol-check gate. |

---

#### Gate Step 0a — Idempotency / GATE_MARKER

```bash
GATE_MARKER="$WORKING_DIR/.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN-GATE.md"
```

```bash
if [ -f "$GATE_MARKER" ] && grep -qF "status: approved" "$GATE_MARKER" 2>/dev/null; then
  echo "Plan gate already approved — skipping (resume after compaction)"
  # Prosseguir diretamente ao symbol-check gate
fi
```

**Regras de skip (após ler a pref e verificar idempotência):**

```bash
# skip: interactive off
if [ "$INTERACTIVE" = "off" ]; then
  # Pular gate — comportamento batch-advisory atual
  # Prosseguir ao symbol-check gate
fi

# auto-approve: interactive=auto + all-pass
if [ "$INTERACTIVE" = "auto" ] && [ "${plan_check_counts_warn:-0}" -eq 0 ] && [ "${plan_check_counts_fail:-0}" -eq 0 ]; then
  mkdir -p "$(dirname "$GATE_MARKER")"
  cat > "$GATE_MARKER" << 'EOF'
---
status: approved
approved_at: {ISO8601}
consumer: forge-next
unit: plan-slice/{S##}
---
Plan auto-approved (all-pass, interactive: auto). Execution may proceed.
EOF
  GATE_EDITS=0
  # Append plan-gate event (outcome: skipped — auto-approve silencioso)
  printf '%s\n' "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"plan-gate\",\"milestone\":\"{M###}\",\"unit\":\"plan-slice/{S##}\",\"mode\":\"interactive\",\"interactive\":\"$INTERACTIVE\",\"outcome\":\"skipped\",\"warn\":${plan_check_counts_warn:-0},\"fail\":${plan_check_counts_fail:-0},\"edits\":0}" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
  # Prosseguir ao symbol-check gate
fi

# interactive=always (ou auto com warn/fail > 0) → conduzir o gate
```

---

#### Gate Step 1 — Preview do plano

Ler `{S##}-PLAN.md` do disco — **preview = arquivo em disco, não conteúdo cacheado.**

```bash
SLICE_PLAN_FILE="$WORKING_DIR/.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN.md"
```

Exibir um resumo informacional (sem pergunta ainda):
- Título do milestone + slice (de `{S##}-PLAN.md` frontmatter `title`)
- Número de tasks na slice
- Contagem de `must_haves` (truths + artifacts + key_links) por task
- Dependências de ordenação entre tasks (campo `depends` de cada `T##-PLAN.md`)
- Para cada `T##`: título, `tier`, `effort`, `depends` (lendo os task plans)

O operador lê o plano e se prepara para a revisão de findings no Gate Step 2.

---

#### Gate Step 2 — Lapidação de findings (R4: batching estruturado para forge-next)

Ler os findings de `{S##}-PLAN-CHECK.md` (dimensões com verdict `warn` ou `fail`).

**Ordem de apresentação:** `fail` primeiro (severidade decrescente), depois `warn`.

**R4 (resolvido para forge-next):**
- Findings `fail` → SEMPRE pergunta individual (arbitragem item-a-item — severidade alta demais para agrupar).
- Findings `warn` → podem ser agrupados em UMA `AskUserQuestion` (até 4 por call) somente quando compartilham a **mesma dimensão** OU a **mesma task-id**; caso contrário, perguntas separadas. Cada finding agrupado mantém sua própria resolução registrada individualmente no marker.

Para cada finding individual (ou grupo de warns relacionados), invocar `AskUserQuestion`:

```
Header: "Plano {S##} — <nome da dimensão>  [fail|warn]"
Body:   "<justificativa de uma linha do checker para aquela dimensão/task>"
Options: ["Manter — aceitar assim", "Corrigir no ato", "Deferir — criar follow-up"]
```

Registrar a resolução de cada finding individualmente (para inclusão no marker):
- `Manter` → aceitar o finding sem mudança; anotar no marker como `{dimensão}: mantido`.
- `Corrigir no ato` → prosseguir para Gate Step 3 (edição livre) com intenção de corrigir.
- `Deferir` → aceitar por ora; anotar no marker como `{dimensão}: deferido`.

Se não houver findings `warn`/`fail` (all-pass) e `INTERACTIVE == always` → pular Gate Step 2 (nada a lapidar); ir direto para Gate Step 3 (edição livre opcional).

---

#### Gate Step 3 — Edição livre (escape hatch)

Inicializar contador de edições: `GATE_EDITS=0` (se ainda não definido).

Ao entrar no Gate Step 3: `GATE_EDITS=$((GATE_EDITS + 1))` (conta cada visita ao step, incluindo re-entradas via "Editar mais").

Oferecer ao operador uma janela de edição não-estruturada:

```
AskUserQuestion({
  header: "Edição livre do plano",
  body:   "Edite {S##}-PLAN.md e/ou os T##-PLAN.md no seu editor agora. Confirme quando terminar.",
  options: ["Confirmar — relerei o plano", "Pular — plano está bom"]
})
```

- `Confirmar` → reler `{S##}-PLAN.md` e todos os `T##-PLAN.md` do disco e exibir a versão atualizada ao operador. O orquestrador NÃO usa cache — lê o arquivo atual. Ir para Gate Step 4 (re-validação).
- `Pular` → ir direto para Gate Step 5 (aprovação).

---

#### Gate Step 4 — Re-validação pós-edição (LOOP sobre PLAN_GLOB)

Após edição (caminho `Confirmar` do Gate Step 3), re-validar o schema de todos os planos da slice.

```bash
PLAN_GLOB_FILES=$(find "$WORKING_DIR/.gsd/milestones/{M###}/slices/{S##}" -maxdepth 1 -name "{S##}-PLAN.md"; \
                  find "$WORKING_DIR/.gsd/milestones/{M###}/slices/{S##}/tasks" -name "T*-PLAN.md" 2>/dev/null)
REVALIDATION_BLOCKING=false

for plan in $PLAN_GLOB_FILES; do
  REVALIDATION_STDERR=$(mktemp)
  REVALIDATION=$(node "$FORGE_SCRIPTS_DIR/forge-must-haves.js" --check "$plan" 2>"$REVALIDATION_STDERR")
  REVALIDATION_EXIT=$?

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

  if [ "$LEGACY" = "false" ] && [ "$VALID" = "false" ]; then
    REVALIDATION_BLOCKING=true
    # Surface schema error as a blocking finding for this file
    AskUserQuestion({
      header: "Erro de schema no plano",
      body:   "O arquivo $plan tem erros de schema que impedem a aprovação:\n$ERRORS\nCorrigir o plano (edit + releitura) ou abortar.",
      options: ["Corrigir agora", "Abortar — replanejar"]
    })
    # "Corrigir agora" → voltar ao Gate Step 3, depois re-rodar Gate Step 4
    # "Abortar" → não escrever marker; re-despachar forge-planner; encerrar o gate
  fi
done
```

> **Re-validação é SIGNIFICATIVA para forge-next:** planos estruturados (`must_haves:` YAML) retornam `{legacy:false, valid:true/false}`. `legacy==false && valid==false` em qualquer arquivo da PLAN_GLOB → finding bloqueante. Aprovação só concedida após todos os arquivos atingirem `valid==true` (ou `legacy==true`).

Aprovação só prossegue para Gate Step 5 se `REVALIDATION_BLOCKING=false` ao final do loop.

---

#### Gate Step 5 — Approval handshake

Após os findings serem endereçados e a re-validação passar, apresentar o gate de aprovação final.

> **Não-aninhamento de plan mode:** NÃO usar `EnterPlanMode`/`ExitPlanMode` aqui. O gate usa somente `AskUserQuestion`. Ver `shared/forge-plan-gate.md § Plan-mode non-nesting`.

```
AskUserQuestion({
  header: "Aprovar plano {S##}",
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
consumer: forge-next
unit: plan-slice/{S##}
---
Plan approved by operator. Execution may proceed.
EOF
```

  Prosseguir ao symbol-check gate / primeiro `execute-task`.

- `Editar mais` → voltar ao Gate Step 3.
- `Abortar` → não escrever o marker. Re-despachar `forge-planner` com notas do operador; reiniciar o ciclo de planejamento da slice.

---

#### Event log (plan-gate)

Após o gate fechar (aprovado/abortado/pulado), append uma linha em `{WORKING_DIR}/.gsd/forge/events.jsonl`:

```bash
mkdir -p "$WORKING_DIR/.gsd/forge"
printf '%s\n' "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"plan-gate\",\"milestone\":\"{M###}\",\"unit\":\"plan-slice/{S##}\",\"mode\":\"interactive\",\"interactive\":\"$INTERACTIVE\",\"outcome\":\"{approved|aborted|skipped}\",\"warn\":${plan_check_counts_warn:-0},\"fail\":${plan_check_counts_fail:-0},\"edits\":${GATE_EDITS:-0}}" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
```

Campos:
- `outcome`: `approved` (operador aprovou), `aborted` (operador escolheu replanejar), `skipped` (idempotência atingida, `interactive: off`, ou auto-approve de all-pass).
- `warn` / `fail`: counts de `plan_check_counts` (parseados pelo plan-check gate — já em escopo).
- `edits`: número de vezes que o Gate Step 3 foi visitado (0 = sem edição livre).

> Campos aditivos — readers que ignoram campos desconhecidos permanecem compatíveis (mesma convenção de `tier`/`reason` de M001).

---

**Handoff para symbol-check gate / execute-task:** o symbol-check gate e o primeiro `execute-task` só rodam após o gate aprovar (marker `{S##}-PLAN-GATE.md` escrito com `status: approved`) ou ser pulado (`interactive: off` ou idempotência). A ausência do marker indica que o gate foi abortado — o executor **não** deve ser despachado.

> Este gate dispara SOMENTE na transição de `plan-slice` concluído para o primeiro `execute-task` da mesma slice. A verificação de idempotência (`{S##}-PLAN-GATE.md` existente) garante que seja no-op para dispatches subsequentes de `execute-task` dentro da mesma slice.

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
echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"plan_check\",\"milestone\":\"{M###}\",\"slice\":\"{S##}\",\"mode\":\"blocking\",\"round\":1,\"counts\":{\"pass\":${PASS_COUNT},\"warn\":${WARN_COUNT},\"fail\":${FAIL_COUNT}},\"prev_fail\":null,\"outcome\":\"revised\"}" >> {WORKING_DIR}/.gsd/forge/events.jsonl
```
(Use the actual parsed counts from step 7. `prev_fail: null` for round 1 — there is no prior round.)

**While `prev_fail_count > 0` AND `round < MAX_PLAN_CHECK_ROUNDS`:**

  **a. Back up the prior PLAN-CHECK.md:**
  ```bash
  mv {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN-CHECK.md \
     {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN-CHECK-round{round}.md
  ```

  **b. Collect failing dimensions** from the backed-up `{S##}-PLAN-CHECK-round{round}.md`. Parse the verdict table — rows where `Verdict == "fail"`. Extract dimension names and justifications.

  **c. Increment round:** `round += 1`.

  **d. Re-dispatch plan-slice** with an injected `## Revision Request` section:
  ```
  Agent({
    subagent_type: 'forge-planner',
    prompt: <plan-slice template from shared/forge-dispatch.md>
      + "\n\n## Revision Request (round " + round + ")\n"
      + "The prior plan scored `fail` on these dimensions:\n"
      + "- {dimension 1}: {justification}\n"
      + "...\n"
      + "Revise the slice plan to resolve these failures. Preserve all already-passing dimensions. "
      + "Do NOT reduce scope to hide failures — fix the root cause.\n"
  })
  ```
  If the planner returns `status: blocked`, stop immediately — surface the planner failure without entering the non-decreasing check.

  **e. Re-run the plan-check gate** — dispatch `forge-plan-checker` again using the same template from `shared/forge-dispatch.md § plan-check`, with `{PLAN_CHECK_MODE}: blocking` and `round: {round}`. This produces a new `{S##}-PLAN-CHECK.md`.

  **f. Parse new counts** → `new_fail_count` (from `plan_check_counts.fail`).

  **g. Append events.jsonl line** (I/O errors MUST propagate):
  ```bash
  echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"plan_check\",\"milestone\":\"{M###}\",\"slice\":\"{S##}\",\"mode\":\"blocking\",\"round\":{round},\"counts\":{\"pass\":${NEW_PASS},\"warn\":${NEW_WARN},\"fail\":${new_fail_count}},\"prev_fail\":${prev_fail_count},\"outcome\":\"revised\"}" >> {WORKING_DIR}/.gsd/forge/events.jsonl
  ```

  **h. Monotonic-decrease check:** if `new_fail_count >= prev_fail_count`, TERMINATE (non-decreasing):
  ```bash
  echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"plan_check\",\"milestone\":\"{M###}\",\"slice\":\"{S##}\",\"mode\":\"blocking\",\"round\":{round},\"outcome\":\"terminated-non-decreasing\",\"prev_fail\":${prev_fail_count},\"new_fail\":${new_fail_count}}" >> {WORKING_DIR}/.gsd/forge/events.jsonl
  ```
  Surface to user (see **Termination Surface Block** below — reason: `non-decreasing`). Stop. Do NOT dispatch `execute-task`.

  **i. Update state:** `prev_fail_count = new_fail_count`.

**After the while loop exits:**

- If `prev_fail_count == 0`:
  ```bash
  echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"plan_check\",\"milestone\":\"{M###}\",\"slice\":\"{S##}\",\"mode\":\"blocking\",\"round\":{round},\"outcome\":\"passed\"}" >> {WORKING_DIR}/.gsd/forge/events.jsonl
  ```
  Proceed to `execute-task` dispatch normally. Then emit progress + next action per Step 6.

- Else (rounds exhausted):
  ```bash
  echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"plan_check\",\"milestone\":\"{M###}\",\"slice\":\"{S##}\",\"mode\":\"blocking\",\"round\":{round},\"outcome\":\"terminated-exhausted\"}" >> {WORKING_DIR}/.gsd/forge/events.jsonl
  ```
  Surface to user (see **Termination Surface Block** below — reason: `exhausted`). Stop. Do NOT dispatch `execute-task`.

---

**Termination Surface Block (pt-BR):**

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
```

**events.jsonl outcomes (LOCKED):**
- `"revised"` — a revision round completed
- `"terminated-exhausted"` — rounds exhausted without reaching fail == 0
- `"terminated-non-decreasing"` — fail count did not decrease between rounds
- `"passed"` — fail count reached 0; proceeding to execute-task

### 2. Check skip rules

Read PREFS for `skip_discuss` and `skip_research`. If the current unit type is skipped, advance STATE past it and re-derive (do not count as a unit).

### 3. Build worker prompt

**Selective memory injection** — read memories from the fragment store, then filter to entries relevant to this unit:

```bash
FRAGMENT_LIST=$(node "$FORGE_SCRIPTS_DIR/forge-memory.js" --list 2>/dev/null || echo "[]")
```

If `FRAGMENT_LIST` is a non-empty JSON array, iterate over each `unit_id` in the list:

```bash
# For each unit_id in FRAGMENT_LIST:
FRAGMENT=$(node "$FORGE_SCRIPTS_DIR/forge-memory.js" --read <unit-id> 2>/dev/null || echo "null")
```

Collect fragments where `FRAGMENT` is non-null. Apply the filter rules below to the collected fragments (each fragment has `facts[]`, `category`, `confidence`, `hits`):

- For `execute-task`: read keywords from `T##-PLAN.md` title + step names. Include fragments whose `facts[]` text shares ≥2 keywords with the plan. Prefer categories `gotcha` and `convention`. Cap at 8 entries.
- For `plan-slice` / `research-slice`: include fragments with categories `architecture` and `pattern` related to the milestone scope. Cap at 8 entries.
- For other unit types: include top-5 fragments by `confidence` score.

**Fallback:** If `FRAGMENT_LIST` is an empty array `[]` or `forge-memory.js --list` errors, fall back to `ALL_MEMORIES` (loaded from `.gsd/AUTO-MEMORY.md` at step 5 of `## Load context`) and apply the same filter rules above. This preserves backward compatibility with pre-fragment-store workspaces.

If no entries match after filtering: inject `(none)`.

Store as `RELEVANT_MEMORIES` and use in the worker prompt `## Project Memory` section.

> For human-readable consolidation, run `/forge-doctor --regen-projection` to rebuild the monolith from fragments (writes `AUTO-MEMORY.md` via `forge-memory.js --write-all`). See `forge-projection` in doctor help.

Use the template from `~/.claude/forge-dispatch.md` for the current `unit_type`.
Substitute placeholders:
- `{WORKING_DIR}` <- current working directory (orchestrator workspace — all `.gsd/**` paths)
- `{M###}`, `{S##}`, `{T##}` <- from STATE
- `{unit_effort}`, `{THINKING_OPUS}` <- resolved effort/thinking for this unit
- `{TOP_MEMORIES}` <- RELEVANT_MEMORIES (filtered above)
- `{CS_LINT}` <- CS_LINT section (already extracted)
- `{CS_STRUCTURE}` <- CS_STRUCTURE section (already extracted)
- `{CS_RULES}` <- CS_RULES section (already extracted)
- `{auto_commit}` <- PREFS.auto_commit
- `{milestone_cleanup}` <- PREFS.milestone_cleanup
- `{CODING_STANDARDS}` <- full CODING_STANDARDS content (for research templates)

**Isolation header** — when `ISOLATION_MODE != shared` (resolved in `## Isolation setup`), append these lines to the worker prompt header, immediately after the `WORKING_DIR:` line (see `shared/forge-dispatch.md § Isolation Header Convention`):
```
ISOLATION: {ISOLATION_MODE}
BRANCH: {resolved branch name, e.g. forge/M-20260601...}
CODE_DIR: {WORKER_CWD}
Isolation rule: all source-code reads, writes, builds and git commits happen inside CODE_DIR on branch BRANCH. All .gsd/** artifact paths stay under WORKING_DIR. Never commit from WORKING_DIR when CODE_DIR differs.
```
(In `branch` mode `CODE_DIR == WORKING_DIR` — include the header anyway so the worker commits on the right branch and never switches back to the default branch.)

Do NOT read artifact files here — templates now pass paths; workers read their own context.

### 4. Dispatch

Use `$MODEL_ID` resolved by Tier Resolution (step 1.5) above. Do NOT look up model from PREFS directly — `model = PREFS.tier_models[tier]` is already computed.

**Branch codex — sidecar (`$ENGINE == codex` && `$unit_type == execute-task`)** — executable mirror of `shared/forge-dispatch.md § Worker Engine Routing § Sidecar dispatch state machine`. When this branch fires, the Claude machinery below (timeline task, token telemetry, guarded `Agent()` dispatch) is **replaced** by the detached adapter + polling; on any failure it resets and **falls through to that same Claude machinery** (fallback). When `$ENGINE == claude` (or the unit is not `execute-task`), skip this branch entirely and proceed with the Claude dispatch below — byte-identical to the current loop. `CODE_DIR` resolves to `${WORKER_CWD:-$WORKING_DIR}` (isolation header).

0. **Increment the sidecar attempt counter (`SIDECAR_ATTEMPT`) — BLOCKER cap.** Before dispatching *any* sidecar for this unit, increment a per-unit counter (starts at 1 for the first sidecar dispatch of the unit). It is **hard-capped** by the number of `engine == codex` members in the resolved chain (`$ROUTE_JSON.chain`, ≤3 — the S01 cap). Exceeding the cap → abort the chain to the Claude fallback with `REASON=sidecar-cap-exceeded`. On a cross-engine chain (e.g. `gpt→claude→gpt`) this branch may fire more than once in the same unit; the counter is persisted in the per-attempt state file (below) so it survives an auto-compact:
```bash
CODEX_MEMBERS=$(node -e "process.stdout.write(String((JSON.parse(process.argv[1]).chain||[]).filter(m=>m.engine==='codex').length))" "$ROUTE_JSON")
SIDECAR_ATTEMPT=$(( ${SIDECAR_ATTEMPT:-0} + 1 ))
if [ "$SIDECAR_ATTEMPT" -gt "${CODEX_MEMBERS:-1}" ]; then
  REASON="sidecar-cap-exceeded"   # → Claude fallback (never a 4th recovery layer)
fi
```
When `REASON == sidecar-cap-exceeded`, **skip steps 1–4 entirely** (no `START_SHA` capture, no state/result-file allocation, no sidecar launch) and go DIRECTLY to the **Fallback** block below (R3). Steps 1–3 below run **only** in the `else` — they are guarded by the same `if [ "$REASON" != "sidecar-cap-exceeded" ]` condition.

1. **Capture `START_SHA` (authoritative for the reset — independent of the adapter's own `start_sha`) and persist a FRESH per-attempt state file to disk.** Branch C spans multiple Bash tool invocations (the poll loop) and may cross an auto-compact, so shell vars do NOT survive — the state file (under `WORKING_DIR/.gsd`, never `CODE_DIR`) is the durable carrier of `{attempt, start_sha, reason, result_file, code_dir}`, mirroring `auto-mode-started.txt`. **The name carries the attempt number `N = SIDECAR_ATTEMPT` (`-attempt-$N`) and NEVER overwrites a prior attempt's file** (audit preserved, post-compact recovery unambiguous — BLOCKER invariant #1). The success AND fallback blocks re-read the state of the **CURRENT** attempt from disk. The whole step is gated on the cap (R3 — the real `if/else` whose cap branch went straight to Fallback above):
```bash
if [ "$REASON" != "sidecar-cap-exceeded" ]; then
  CODE_DIR="${WORKER_CWD:-$WORKING_DIR}"
  START_SHA=$(git -C "$CODE_DIR" rev-parse HEAD)
  N="$SIDECAR_ATTEMPT"                                              # 1, 2, 3 — one per codex member dispatched
  XLLM_STATE="$WORKING_DIR/.gsd/forge/xllm-state-${T##}-attempt-${N}.json"
  mkdir -p "$WORKING_DIR/.gsd/forge/"
  printf '{"attempt":%s,"start_sha":"%s","reason":"","result_file":"","code_dir":"%s"}\n' "$N" "$START_SHA" "$CODE_DIR" > "$XLLM_STATE"
fi
```

2. **Clean-tree guard.** Dirty tree → do NOT dispatch the sidecar (never discard uncommitted work); go to Fallback with `REASON=dirty-tree-guard` and **skip the reset** (the dirty work predates the never-launched sidecar). Scope the porcelain to exclude `.gsd/` (orchestrator writes `.gsd` during the flow; `.gsd` may be committed in user projects) — R6:
```bash
if [ -n "$(git -C "$CODE_DIR" status --porcelain -- . ':(exclude).gsd')" ]; then
  REASON="dirty-tree-guard"   # → Fallback below WITHOUT reset, then the Claude dispatch
  printf '{"attempt":%s,"start_sha":"%s","reason":"%s","result_file":"","code_dir":"%s"}\n' "$N" "$START_SHA" "$REASON" "$CODE_DIR" > "$XLLM_STATE"
fi
```

3. **Allocate the result-file OUTSIDE `CODE_DIR`** (S01 contract — codex could overwrite a file inside the workspace) + dispatch detached via `run_in_background: true` (the Bash tool's 600s foreground ceiling does not apply). `--model` appended **only when `$CODEX_MODEL` is non-empty** (null → CLI default). `$XLLM_STATE` is the `-attempt-$N.json` of the CURRENT attempt — never a prior attempt's file:
```bash
RESULT_FILE=$(mktemp -t forge-xllm-result.XXXXXX.json)   # tmpdir, never under $CODE_DIR
printf '{"attempt":%s,"start_sha":"%s","reason":"","result_file":"%s","code_dir":"%s"}\n' "$N" "$START_SHA" "$RESULT_FILE" "$CODE_DIR" > "$XLLM_STATE"
node "$FORGE_SCRIPTS_DIR/forge-xllm.js" --mode execute \
  --plan "$PLAN_PATH" --result-file "$RESULT_FILE" --cwd "$CODE_DIR" \
  --timeout "$WORKERS_TIMEOUT" \
  $([ -n "$CODEX_MODEL" ] && printf -- '--model %s' "$CODEX_MODEL")
# ↑ dispatched with the Bash tool's run_in_background: true
```

4. **Poll `$RESULT_FILE`** (state `polling`) every ~5–10s: `status==running` → keep polling + liveness check; `status==done` → success (step 5); `status==error` / adapter exit `!= 0` / unparseable JSON → failure with the matching `REASON` (`codex-exit-nonzero` / `codex-timeout` / `codex-invalid-json`) → Fallback. **Orphan:** heartbeat `updated_at` stale beyond ~2–3× the 3s cadence (~9s) → `kill "$pid"` (from the heartbeat) + `REASON=codex-orphan` → Fallback.

5. **Success — orchestrator assembles the artifacts (`done` state).** Codex NEVER writes `.gsd/**` and NEVER commits (locked — `git log` unchanged, no `.gsd/**` path in `git -C "$CODE_DIR" diff --name-status $START_SHA`). Read the JSON and **write `T##-SUMMARY.md`** + **build the `---GSD-WORKER-RESULT---` block** yourself from: `summary` (one-liner + narrative seed), `must_haves_status` (carried into the returned result block), `files_changed_declared` (**primary source of the file-audit** — file-granular self-report). Append synthesized advisory evidence derived read-only from `git -C "$CODE_DIR" diff --name-status $START_SHA` (tagged `source: codex-sidecar`) to `.gsd/forge/evidence-{T##}.jsonl` — a documented gap, advisory, never blocks. Emit the `dispatch` event (`engine=codex`) and **rejoin Step 5 (Process result)** exactly as if a Claude `forge-executor` returned — downstream verification (must_haves, verifier, file-audit, review dialético) runs **byte-identical** on codex-authored code. First re-read the durable state (the poll loop crossed multiple Bash invocations — shell vars are gone):
```bash
START_SHA=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).start_sha" 2>/dev/null)
CODE_DIR=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).code_dir" 2>/dev/null)
RESULT_FILE=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).result_file" 2>/dev/null)
mkdir -p "$WORKING_DIR/.gsd/forge/"
CODEX_MODEL_LABEL="${CODEX_MODEL:-codex-default}"
echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"dispatch\",\"unit\":\"${unitType}/${unitId}\",\"model\":\"${CODEX_MODEL_LABEL}\",\"reason\":\"${ENGINE_REASON}\",\"slice\":\"{S##}\",\"milestone\":\"${RUN_ID:-{M###}}\",\"input_tokens\":0,\"output_tokens\":0,\"engine\":\"codex\",\"domain\":\"${DOMAIN_USED}\",\"route_source\":\"${ROUTE_SOURCE}\",\"chain_len\":${CHAIN_LEN}}" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
# → proceed to Step 5 (Process result). Do NOT run the Claude machinery below.
```

**Fallback — `worker-engine-fallback`** (any codex failure trigger — clone of `review-challenger-fallback`, `shared/forge-dispatch.md § Fallback`). One event type, six triggers by `REASON` (`dirty-tree-guard`, `codex-exit-nonzero`, `codex-timeout`, `codex-invalid-json`, `codex-orphan`, `sidecar-cap-exceeded`); no retry of the codex work; **not a 4th recovery layer**:
```bash
# Re-read durable state (this block may be a later Bash invocation — shell vars are gone).
# $XLLM_STATE is the -attempt-$N.json of the CURRENT attempt (BLOCKER invariant #1).
START_SHA=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).start_sha" 2>/dev/null)
CODE_DIR=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).code_dir" 2>/dev/null)
# Reset to START_SHA (scoped to CODE_DIR, excluding .gsd/) — EXCEPT dirty-tree-guard, which skips the reset.
# The .gsd exclusion protects the orchestrator's own .gsd writes (events.jsonl / evidence) made during
# the poll — guarded by the dirty-tree-guard + .gsd exclusion scope, NOT by gitignore (user projects
# may commit .gsd).
if [ "$REASON" != "dirty-tree-guard" ] && [ "$REASON" != "sidecar-cap-exceeded" ]; then
  git -C "$CODE_DIR" checkout "$START_SHA" -- . ':(exclude).gsd' && git -C "$CODE_DIR" clean -fd -e .gsd
  # BLOCKER invariant #2 — VERIFY the reset actually cleaned the tree. A still-dirty tree must NOT be
  # inherited into a subsequent sidecar attempt (cross-engine chain: the next member may be codex).
  # Scope to exclude .gsd/ (orchestrator .gsd writes during the poll; .gsd may be committed) — R6.
  if [ -n "$(git -C "$CODE_DIR" status --porcelain -- . ':(exclude).gsd')" ]; then
    REASON="verified-reset-failed"   # reset left the tree dirty → abort the chain to the Claude fallback
  fi
fi

# Cross-engine chain walk (Layer 2) — after the verified reset, resolve the next chain member and,
# if one exists, PERSIST it in the consume-once tier-cursor (same pattern the model_refusal row uses;
# Step 4b consumes it). This is what makes the CODEX_MEMBERS cap non-dead code (R2). forge-next is
# step mode: it executes ONE unit, so the advance is NOT dispatched now — the NEXT /forge-next
# invocation consumes the cursor and dispatches $NEXT (Branch codex if gpt, else the Claude Agent).
# Abort reasons (dirty-tree-guard / sidecar-cap-exceeded / verified-reset-failed) forbid advancement
# → no cursor, take the generic Claude fallback below.
NEXT=""
if [ "$REASON" != "dirty-tree-guard" ] && [ "$REASON" != "sidecar-cap-exceeded" ] && [ "$REASON" != "verified-reset-failed" ]; then
  NEXT=$(node "$FORGE_SCRIPTS_DIR/forge-routing.js" \
    --unit-type "$unit_type" --tier "$TIER" --domain "$DOMAIN" \
    --frontmatter-tier "$PLAN_TIER" --frontmatter-worker "$PLAN_WORKER" \
    --cwd "$WORKING_DIR" --next-after "$MODEL_ID")
  if [ -n "$NEXT" ]; then
    case "$(node "$FORGE_SCRIPTS_DIR/forge-model-alias.js" --family "$NEXT" 2>/dev/null)" in gpt) NEXT_ENGINE=codex;; *) NEXT_ENGINE=claude;; esac
    TIER_CURSOR_FILE="$WORKING_DIR/.gsd/forge/tier-cursor-${RUN_ID:-legacy}-${unit_type}-${unit_id}.json"
    mkdir -p "$WORKING_DIR/.gsd/forge/"
    printf '{"model":"%s","engine":"%s","ts":"%s"}\n' "$NEXT" "$NEXT_ENGINE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$TIER_CURSOR_FILE"
  fi
fi

# Generic Claude fallback — ONLY when the chain is exhausted ($NEXT empty) or an abort reason forbids
# advancement. Mutually exclusive with the cursor-persist above (a persisted $NEXT means the next
# /forge-next dispatches that member, NOT this fallback).
if [ -z "$NEXT" ]; then
  echo "⚠ worker: codex indisponível ($REASON) — usando forge-executor"
  mkdir -p "$WORKING_DIR/.gsd/forge/"
  printf '{"ts":"%s","event":"worker-engine-fallback","milestone":"%s","slice":"%s","unit":"execute-task/%s","reason":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${M###}" "${S##}" "${T##}" "$REASON" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
fi
```
**If a next member was persisted (`$NEXT` non-empty):** surface "Codex worker failed (`$REASON`). Run `/forge-next` again — it will retry with the next model in the chain (`$NEXT`)." and stop this unit — step mode picks up the advance via the cursor on the next invocation (Step 4b), which re-inspects the engine to route to Branch codex or the Claude Agent. **If `$NEXT` was empty or an abort reason fired:** set `ENGINE=claude`, **run Tier Resolution (step 1.5) and Effort Resolution (step 1.55) now** (they were skipped on the codex path), and dispatch the single `forge-executor` Claude worker via the machinery below. The generic Claude fallback (with its `worker-engine-fallback` event) fires only on the exhausted/abort path — mutually exclusive with the chain-advance cursor (R2). No retry.

---

**Branch D — sidecar codex plan (`$ENGINE == codex` && `$unit_type == plan-slice`)** — executable mirror of `shared/forge-dispatch.md § Worker Engine Routing § Sidecar dispatch state machine — Branch D`. Read-only twin of Branch codex above: codex only *reads* the codebase + planning context and returns markdown plan content in the result JSON — it never writes `.gsd/**`, so this branch has **no dirty-tree guard, no `START_SHA` capture, no reset**. When `$ENGINE == claude` (or the unit is not `plan-slice`), skip this branch entirely. `CODE_DIR` resolves to `${WORKER_CWD:-$WORKING_DIR}` (isolation header).

0. **Increment the sidecar attempt counter + cap check FIRST (R3).** State is **fresh per attempt** (BLOCKER invariant #1 + #3): on a cross-engine chain with multiple codex members the `-attempt-$N` suffix keeps each attempt's state distinct, and `SIDECAR_ATTEMPT` is hard-capped by the count of `engine == codex` members in `$ROUTE_JSON.chain` (≤3). When the cap is exceeded, **skip steps 1–4 entirely** (no plan-context assembly, no state/result-file allocation, no sidecar launch) and go DIRECTLY to the **Fallback** block below:
```bash
CODEX_MEMBERS=$(node -e "process.stdout.write(String((JSON.parse(process.argv[1]).chain||[]).filter(m=>m.engine==='codex').length))" "$ROUTE_JSON")
SIDECAR_ATTEMPT=$(( ${SIDECAR_ATTEMPT:-0} + 1 ))
if [ "$SIDECAR_ATTEMPT" -gt "${CODEX_MEMBERS:-1}" ]; then
  REASON="sidecar-cap-exceeded"   # → Claude forge-planner fallback (never a 4th recovery layer)
fi
```

1. **Assemble the plan-context file (orchestrator)** — temp file OUTSIDE `.gsd/` and `CODE_DIR`, concatenating the exact artifacts the Claude `forge-planner` would receive for this slice: the slice's ROADMAP entry, `M###-CONTEXT.md` (full), `S##-CONTEXT.md` (if it exists), each dependency slice's `T##-SUMMARY.md`/`S##-SUMMARY.md`, `.gsd/CODING-STANDARDS.md`, and `S##-RISK.md` (if it exists). Guarded by the cap (R3 — the real `if/else` whose cap branch went straight to Fallback above):
```bash
if [ "$REASON" != "sidecar-cap-exceeded" ]; then
  CODE_DIR="${WORKER_CWD:-$WORKING_DIR}"
  CTX_FILE=$(mktemp -t forge-plan-context.XXXXXX.md)   # tmpdir, never under $CODE_DIR or .gsd
  # → orchestrator appends the artifacts above (Read + concatenate); absent optional files are skipped.
fi
```

2. **Persist durable state to disk** (no `start_sha` — read-only, nothing to reset). Branch D needs **none of the reset machinery** (read-only — invariant #2 does not apply), only state-fresh-per-attempt + cap. Same cap guard (R3):
```bash
if [ "$REASON" != "sidecar-cap-exceeded" ]; then
  N="$SIDECAR_ATTEMPT"
  XLLM_STATE="$WORKING_DIR/.gsd/forge/xllm-state-${S##}-attempt-${N}.json"
  mkdir -p "$WORKING_DIR/.gsd/forge/"
  RESULT_FILE=$(mktemp -t forge-xllm-result.XXXXXX.json)   # tmpdir, never under $CODE_DIR
  printf '{"attempt":%s,"reason":"","result_file":"%s","code_dir":"%s","ctx_file":"%s"}\n' \
    "$N" "$RESULT_FILE" "$CODE_DIR" "$CTX_FILE" > "$XLLM_STATE"
fi
```

3. **Dispatch detached via `run_in_background: true`**, `--mode plan` + `--plan-context` instead of `--plan`; `--model` appended only when `$CODEX_MODEL` is non-empty:
```bash
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-xllm.js ] && echo scripts || echo "$HOME/.claude/scripts")
node "$FORGE_SCRIPTS_DIR/forge-xllm.js" --mode plan \
  --plan-context "$CTX_FILE" --result-file "$RESULT_FILE" --cwd "$CODE_DIR" \
  --timeout "$WORKERS_TIMEOUT" \
  $([ -n "$CODEX_MODEL" ] && printf -- '--model %s' "$CODEX_MODEL")
```

4. **Poll `$RESULT_FILE`** (state `polling`) — identical cadence/orphan-detection to Branch codex step 4: `running` → keep polling + liveness check; `done` → success (step 5); `error` / exit `!= 0` / unparseable JSON → failure (`REASON` = `codex-exit-nonzero` / `codex-invalid-json` — a plan that fails `must_haves` validation in-sidecar also yields `codex-exit-nonzero`, exit 2) → Fallback. **Orphan:** heartbeat `updated_at` stale beyond ~2–3× cadence → `kill "$pid"` + `REASON=codex-orphan` → Fallback. `--timeout` backstop → `codex-timeout`.

5. **Success — orchestrator materializes the plans (`done` state).** Re-read the durable state from disk (shell vars are gone), read the result JSON, and **write** each plan file into `.gsd/**` (creating dirs) — orchestrator ONLY, codex never touched `.gsd/**`:
```bash
RESULT_FILE=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).result_file" 2>/dev/null)
# slice_plan.content    → .gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN.md
# task_plans[i].content → .gsd/milestones/{M###}/slices/{S##}/tasks/{id}/{id}-PLAN.md  (mkdir -p tasks/{id}/ first)
```
**Path-traversal guard (untrusted codex output):** `task_plans[].id`/`.filename` are UNTRUSTED (codex is external/potentially-compromised). `validatePlanResult` in `forge-xllm.js` is the gate — it rejects (exit 2 → Fallback) any `id` not `^T\d+$` or `filename` not `^[A-Za-z0-9._-]+\.md$` (no `/`, `\`, `..`). Defense in depth: **re-derive the path from the validated `id` alone** (`tasks/{id}/{id}-PLAN.md`); treat `filename` only as an optional equality-check against `{id}-PLAN.md` — **never concatenate the raw `filename` into the path.**
Then **emit the dispatch event with `engine:"codex"`, unit `plan-slice/{S##}`**:
```bash
echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"dispatch\",\"unit\":\"plan-slice/${S##}\",\"model\":\"${CODEX_MODEL:-codex-default}\",\"reason\":\"${ENGINE_REASON}\",\"input_tokens\":0,\"output_tokens\":0,\"engine\":\"codex\",\"domain\":\"${DOMAIN_USED}\",\"route_source\":\"${ROUTE_SOURCE}\",\"chain_len\":${CHAIN_LEN}}" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
```
and **rejoin the normal `plan-slice` completion path**: the **plan-check gate**, the interactive **plan gate** (`forge-next` is always `MODE = interactive`), and the **symbol-check gate** all run over the materialized files exactly as after a Claude `forge-planner` — nothing in those gates changes. No `T##-SUMMARY`/`---GSD-WORKER-RESULT---` is synthesized here — skip Step 5 (Process result) for this dispatch, going straight to the plan-check gate.

**Fallback — read-only, no reset.** Codex wrote nothing on disk, so there is nothing codex-authored to undo; discard the result JSON and dispatch a single Claude `forge-planner` for the same slice:
```bash
CODE_DIR=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).code_dir" 2>/dev/null)
echo "⚠ worker: codex indisponível ($REASON) — usando forge-planner"
mkdir -p "$WORKING_DIR/.gsd/forge/"
printf '{"ts":"%s","event":"worker-engine-fallback","milestone":"%s","slice":"%s","unit":"plan-slice/%s","reason":"%s"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${M###}" "${S##}" "${S##}" "$REASON" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
```
Then set `ENGINE=claude`, **run Tier Resolution (step 1.5) and Effort Resolution (step 1.55) now** (a `risk:high` slice escalates `heavy → max`/Fable exactly as today), and dispatch the single `forge-planner` Claude worker via the plan-slice machinery below. No re-resolution of engine (fallback is unconditionally Claude); no retry — not a 4th recovery layer.

---

**Claude dispatch** (default path, and the fallback target) — the machinery below runs when `$ENGINE == claude`:

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
INPUT_TOKENS=$(node "$FORGE_SCRIPTS_DIR/forge-tokens.js" --inline "$worker_prompt")
```

**Guarded dispatch — apply the Retry Handler section of `shared/forge-dispatch.md`:** Wrap the `Agent()` call in a try/catch. On throw:

1. Capture the exception message into `errorMsg`.
2. Shell out: `node "$FORGE_SCRIPTS_DIR/forge-classify-error.js" --msg "$errorMsg"` → parse `{ kind, retry, backoffMs? }`.
3. If `retry === true` AND `attempt <= PREFS.retry.max_transient_retries` (default 3): increment `attempt`, apply backoff, append a retry event (include `input_tokens: INPUT_TOKENS` from the retry prompt) to `.gsd/forge/events.jsonl`, and re-dispatch. Task stays `in_progress` between retries.
4. Otherwise fall through to the failure taxonomy in Step 5.

> Transient errors (`rate-limit`, `network`, `server`, `stream`, `connection`) are handled by the Retry Handler before this block is reached. The failure taxonomy below is only reached when the classifier returns `retry: false` OR retries are exhausted.

> Antes de despachar o worker, exiba o **Spawn Liveness Banner** (ver `shared/forge-dispatch.md § Spawn Liveness Banner`) com a duração estimada para o `unit_type` sendo executado (consulte a tabela de duração na seção canônica).

**Alias Resolution** — `Agent()`'s `model:` param only accepts `sonnet|opus|haiku|fable`, never a full model ID:
```bash
MODEL_ALIAS=$(node "$FORGE_SCRIPTS_DIR/forge-model-alias.js" --id "$MODEL_ID")
[ -z "$MODEL_ALIAS" ] && echo "⚠ model \"$MODEL_ID\" sem alias — usando frontmatter do agente" >&2
```

Then call `Agent(agent_name, worker_prompt, model: $MODEL_ALIAS)` when `$MODEL_ALIAS` is non-empty; when empty, call `Agent(agent_name, worker_prompt)` without a `model:` param (degrades to the agent's own frontmatter — the warning above was already echoed). Use a `description` that captures what is happening:
- Format: `{unit_type} {unit_id}: {one-liner describing the work}`
- Examples:
  - `plan-slice S01: authentication foundation`
  - `execute-task T03: JWT middleware setup`
  - `research-milestone M001: e-commerce platform`
- For memory extraction: `extract memories from {unit_id}`

Wait for the result. Then:
```bash
OUTPUT_TOKENS=$(node "$FORGE_SCRIPTS_DIR/forge-tokens.js" --inline "$result")
mkdir -p .gsd/forge/
MODEL_APPLIED_JSON=$([ -n "$MODEL_ALIAS" ] && printf '"%s"' "$MODEL_ALIAS" || printf 'null')
echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"dispatch\",\"unit\":\"${unitType}/${unitId}\",\"model\":\"${MODEL_ID}\",\"tier\":\"${TIER}\",\"reason\":\"${REASON}\",\"effort\":\"${EFFORT}\",\"effort_reason\":\"${EFFORT_REASON}\",\"slice\":\"{S##}\",\"milestone\":\"${RUN_ID:-{M###}}\",\"input_tokens\":${INPUT_TOKENS},\"output_tokens\":${OUTPUT_TOKENS},\"model_applied\":${MODEL_APPLIED_JSON},\"engine\":\"${ENGINE:-claude}\",\"domain\":\"${DOMAIN_USED}\",\"route_source\":\"${ROUTE_SOURCE}\",\"chain_len\":${CHAIN_LEN}}" >> .gsd/forge/events.jsonl
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
| `context_overflow` | "context limit", "too long", "token" | "Task too large for one context window. Run `/forge-next` again — it will retry with a more capable model." **Climbs the separate tier ladder (`standard → heavy → max`), does NOT consume `chain[]`** — but S02 re-resolves THROUGH routing at the escalated tier so a domain-specific `routing.<domain>.<phase>.<escalated-tier>` cell is honored: `ROUTE_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-routing.js" --unit-type "$unit_type" --tier "$ESCALATED_TIER" --domain "$DOMAIN" --frontmatter-tier "$PLAN_TIER" --frontmatter-worker "$PLAN_WORKER" --cwd "$WORKING_DIR")` then `MODEL_ID=chain[0].id`. Escalated tier `max` is terminal → `blocked → human`. Persist the cursor `{model, engine, ts}` (engine from `chain[0].engine`) so the next `/forge-next` resumes at the escalated model. |
| `scope_exceeded` | "out of scope", "too broad" | "Task scope too broad. Ask the planner to split T## before continuing." |
| `model_refusal` | "cannot", "I'm not able", "policy" | Walk the **cross-engine chain** via routing: `NEXT=$(node "$FORGE_SCRIPTS_DIR/forge-routing.js" --unit-type "$unit_type" --tier "$TIER" --domain "$DOMAIN" --frontmatter-tier "$PLAN_TIER" --frontmatter-worker "$PLAN_WORKER" --cwd "$WORKING_DIR" --next-after "$MODEL_ID")` — this replaces the old `forge-tier-chain.js --next-after` (SAME Layer 2, new resolver — never a 4th layer). It walks the resolved chain → category fallback → `''`. **Persist the cross-engine cursor:** if `$NEXT` is non-empty, re-derive its engine (`NEXT_FAMILY=$(node "$FORGE_SCRIPTS_DIR/forge-model-alias.js" --family "$NEXT")`; `gpt→codex`, else `claude`) and write `$WORKING_DIR/.gsd/forge/tier-cursor-${RUN_ID:-legacy}-${unit_type}-${unit_id}.json` as `{"model":"$NEXT","engine":"$NEXT_ENGINE","ts":"<ISO8601 now>"}` (`mkdir -p` first) — Step 4b above consumes-and-deletes it on the *next* `/forge-next`, re-inspecting the engine to route to Branch codex or the Claude Agent. If the `$NEXT` member is codex, the verified reset (BLOCKER invariant #2) runs before that next attempt captures `START_SHA`. `forge-next` does not auto-recover mid-unit (step mode surfaces) — surface: "Model refused the task. Run `/forge-next` again — it will retry with the next model in the chain (`$NEXT`)." If `$NEXT` is empty (chain + category fallback exhausted) → do NOT write a cursor; surface "Model refused the task and the chain is exhausted. Adjust the task plan or routing config." |
| `429` | "rate limit", "429", "quota" | Same cross-engine chain-walk + cross-engine cursor-persist semantics as `model_refusal` — surface: "Rate limited. Run `/forge-next` again — it will retry with the next model in the chain (`$NEXT`)." or "chain exhausted" message if `$NEXT` empty (no cursor written). This is a `status: blocked` classification (Layer 2), distinct from a transient 429 raised as an `Agent()` exception (Retry Handler, Layer 1). |
| `400` | "400", "bad request", "invalid" | Same cross-engine chain-walk + cross-engine cursor-persist semantics as `model_refusal`. |
| `tooling_failure` | "command not found", "permission denied", "ENOENT" | "Tooling error — check that required tools are installed." |
| `external_dependency` | "API", "network", "not running" | "External dependency unavailable — resolve it and re-run `/forge-next`." |
| `unknown` | anything else | Surface raw blocker message. |

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
   # is_large_task: derivado deterministicamente do plano (review S04 R6)
   IS_LARGE=$(node "$FORGE_SCRIPTS_DIR/forge-repair.js" --is-large-task "$PLAN" | node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).is_large_task))")
   REPAIR_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-repair.js" --classify '<json-input>')
   # Input: {failure_shape, severity, worker_explained, signals} from result block + S##-VERIFICATION.md + S##-SYMBOL-CHECK.md
   # signals.is_large_task = $IS_LARGE (frontmatter large_task vence; senão heurística >5 steps | >=3 artifacts | >250 linhas)
   # --cwd $CODE_DIR when under isolation (avoids false MISSING in worktree)
   ```
   Capture `{strategy, reason}` from output.

5. **Dispatch strategy** (per `shared/forge-dispatch.md § Node Repair`):
   - `retry` → re-dispatch same `forge-executor` with `## Verification Failures` + `## Repair Hint` (reason) injected.
   - `decompose` → idempotency guard: if `T##.1-PLAN.md` exists → skip dispatch. Otherwise:
     > Antes de despachar o forge-planner em decompose mode, exiba o **Spawn Liveness Banner** (ver `shared/forge-dispatch.md § Spawn Liveness Banner`) — duração estimada `plan-slice`: ~2–4 min.
     ```
     Agent({ subagent_type: 'forge-planner', prompt: <plan-slice template>
       + "\n\nMODE: decompose\nTARGET_TASK: {T##}\n\n## Unmet Must-Haves\n{diff list}\n\n## Why it failed\n{result/SUMMARY excerpt}" })
     ```
     After return, re-derive next unit (sub-tasks `T##.1`, `T##.2` … now visible via `forge-parallelism.js`).
   - `prune` → **`AskUserQuestion`** (interactive — forge-next is always interactive):
     ```
     AskUserQuestion({
       question: "O worker declarou o requisito '{requirement}' impossível de implementar. O que fazer?",
       options: ["Podar e continuar", "Tentar novamente (retry)", "Bloquear para revisão humana"]
     })
     ```
     If "Podar e continuar": write entry to `{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-CONTEXT.md § Decisions` naming pruned requirement + rationale + task ID.
     If "Tentar novamente": override strategy to `retry`, re-classify accordingly.
     If "Bloquear": fall through to `blocked → human`.
   - `blocked` → fall through to existing `blocked → human` path.

6. **Append repair event:**
   ```bash
   echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"repair\",\"unit\":\"execute-task/{T##}\",\"milestone\":\"{M###}\",\"slice\":\"{S##}\",\"task\":\"{T##}\",\"strategy\":\"$REPAIR_STRATEGY\",\"repair_count\":$REPAIR_COUNT_NEW,\"reason\":\"$REPAIR_REASON\"}" >> "$WORKING_DIR/.gsd/milestones/{M###}/{M###}-events.jsonl"
   ```

### 6. Post-unit housekeeping

**a) Append to per-milestone event log** — append one line to `{WORKING_DIR}/.gsd/milestones/{M###}/{M###}-events.jsonl` (M004+; create dir if missing):
```json
{"ts":"{ISO8601}","unit":"{unit_type}/{unit_id}","agent":"{agent_name}","milestone":"{M###}","status":"{done|blocked|partial}","summary":"{one-liner}"}
```
Each entry must be a single line. Append-only is atomic up to PIPE_BUF — event lines are <512B → safe without lockfile. Legacy fallback: `.gsd/forge/events.jsonl` if `{M###}` not resolved.

**b) Update per-milestone STATE** — advance to next unit position via `scripts/forge-state.js --update {M###} --json '{...}'`. Dashboard regen happens separately via `scripts/forge-dashboard.js`.

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
  echo "[forge-next] WARNING: no unit_id for decisions — skipping fragment write" >&2
fi
```

Where `key_decisions_json` is a JSON object `{ "unit_id": "$DECISIONS_UNIT_ID", "decisions": [...] }` built from the `key_decisions` field of the worker result. The global `.gsd/DECISIONS.md` is rebuilt from fragments during `complete-milestone` (forge-merger, S05). Do NOT write directly to `.gsd/DECISIONS.md` or any `M###-DECISIONS.md` file.

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

**d-reinject) Must-haves re-injection diff (scope_reduction)** — runs after memory extraction, before isolation cleanup. Applies to `execute-task` units only.

Read `scope_reduction.reinject` from prefs (3-file cascade; default `auto`). If `off` → skip this step (PRUNE still registers in CONTEXT — independently of this pref).

```bash
REINJECT_RESULT=$(node "$FORGE_SCRIPTS_DIR/forge-repair.js" --reinject-diff \
  --plan "$WORKING_DIR/.gsd/milestones/{M###}/slices/{S##}/tasks/{T##}/{T##}-PLAN.md" \
  --verification "$WORKING_DIR/.gsd/milestones/{M###}/slices/{S##}/{S##}-VERIFICATION.md" \
  --pruned "$PRUNED_IDS" \
  --must-haves-status "$MUST_HAVES_STATUS_JSON" 2>/dev/null || echo '{"dropped":[],"capped":false}')
```

Where `PRUNED_IDS` = comma-separated IDs from any PRUNE decisions made in this unit's repair routing (empty if none); `MUST_HAVES_STATUS_JSON` = `must_haves_status` field from the worker result (if present).

If `dropped.length > 0`: when building the next unit's worker prompt (Step 3), append:

```markdown
## Requisitos pendentes re-injetados

Os seguintes requisitos planejados não foram entregues pela unidade anterior e permanecem em aberto:
{bullet list of dropped items}
{if capped: "⚠ Lista truncada em 10 itens — ver S##-VERIFICATION.md para lista completa."}
```

Also append this same section to `{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-SUMMARY.md`.

**e) Isolation cleanup (complete-milestone only)** — if the unit just processed was `complete-milestone` with `status: done`, release the isolation. No-op when `ISOLATION_MODE == shared`; `branch` mode checks the repo back out to the default branch (the `forge/{run}` branch is kept for PR/merge); `worktree` mode removes the worktree only if `worktree_cleanup_on_complete: true` in prefs. Never run this on partial/blocked — the branch/worktree must survive for resume:
```bash
node "$FORGE_SCRIPTS_DIR/forge-isolation.js" --cleanup --run "$ISO_RUN" --cwd "$WORKING_DIR" || true
```

**f) Emit progress + next action:**
```
✓ [M001/S02/T03] execute-task — JWT auth with refresh rotation  · forge-executor (claude-sonnet-5)
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
