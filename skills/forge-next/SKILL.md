---
name: forge-next
description: "Executa exatamente uma unidade de trabalho e para (step mode)."
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash, Agent, Skill, TaskCreate, TaskUpdate, TaskList, TaskStop, SendMessage, WebSearch, WebFetch
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
# immediately); fall back to ${FORGE_HOME:-$HOME/.forge-agent}/scripts (user-land: installed version).
if [ -f "scripts/forge-parallelism.js" ]; then
  FORGE_SCRIPTS_DIR="scripts"
else
  FORGE_SCRIPTS_DIR="${FORGE_HOME:-$HOME/.forge-agent}/scripts"
fi
echo "FORGE_SCRIPTS_DIR=$FORGE_SCRIPTS_DIR"

# Same resolution for the shared reference specs — the installer COPIES shared/*.md
# into ${FORGE_HOME:-$HOME/.forge-agent}/shared/, so a bare relative `shared/X.md`
# is a dead path in every consumer
# project. See the path convention note right below this block.
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
2. `.gsd/AUTO-MEMORY.md` full file (skip silently if missing) — stored as `ALL_MEMORIES` for selective injection
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
  - Surface to the operator: arquivo + linha + como-corrigir (from errors[]).
  - When any `errors[]` entry has `code == "legacy-md-without-jsonc"`, re-emit that entry's
    `errors[].message` VERBATIM, without paraphrasing. Use `shared/forge-prefs-cutover.md § Canonical message`
    as the message contract; STOP without retry or handoff loops (headless-safe).
  - STOP — do NOT dispatch the unit. Do NOT proceed on WORKERS_ENGINE=claude / effort defaults / any fallback value.
```
`warnings[]` (advisory schema validation, `⚠` on stderr) do NOT stop — only exit≠0 halts.

The resolved object is `{ok, prefs, errors[], warnings[], layers}`. Throughout this skill **`PREFS` = `.prefs`** from this one call.

**Extract effort & thinking off the resolved `PREFS` object (defaults identical to the old inline snippet):**
- `EFFORT_MAP` ← `PREFS.effort` (per-phase effort table; default: opus/planning phases = `medium`, sonnet/haiku phases = `low`)
- `THINKING_OPUS` ← `PREFS.thinking.opus_phases` (default: `adaptive`)

Store as: `STATE`, `PREFS` (the resolved `.prefs` object), `ALL_MEMORIES`, `CODING_STANDARDS`.

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
ELEVATED=$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).elevated||false))" "$ISO_RESULT")
ELEV_REASON=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).elevation_reason||'')" "$ISO_RESULT")
echo "ISOLATION_MODE=$ISOLATION_MODE  WORKTREE_DIR=${WORKTREE_DIR:-—}  ISO_ERRORS=${ISO_ERRORS:-none}"
[ "$ELEVATED" = "true" ] && echo "⚠ require_worktree: elevado a worktree ($ELEV_REASON) → CODE_DIR=${WORKTREE_DIR:-?}"
```

Isolation rules (CRITICAL — the operator configured this; honor it):
- `shared` → `WORKER_CWD = $WORKING_DIR`. Nothing else to do.
- `branch` → `WORKER_CWD = $WORKING_DIR`. Workers commit on the `forge/{run}` branch the setup just checked out.
- `worktree` → `WORKER_CWD = $WORKTREE_DIR` (bootstrap value). In a multi-repo workspace, once `$PLAN_PATH` exists the resolver selects the explicit primary repo and emits the complete `repo_roots`/`writable_roots` scope. A fully attributed cross-repo plan is supported; an ambiguous or incomplete plan is refused. `.gsd/**` artifacts ALWAYS stay under `$WORKING_DIR`.
- `ISO_ERRORS` non-empty AND no repo succeeded → STOP and surface the errors. Running un-isolated when the operator configured isolation is NOT an acceptable fallback.
- When mode != shared, emit one line: `⛓ Isolation: {mode} → {branch name or worktree path}`.
- `workers.require_worktree` elevation is static-at-activation (never mid-run); `auto` (default) elevates `shared→worktree` only when `execute-task` resolves to an external write engine (codex/gpt/gemini); `true` always elevates; `false` never elevates. Read-only paths (Branch D plan-slice, review challenger) are exempt. Warn-and-proceed — never blocks; false-positive acceptable, false-negative not. Keep `shared`: `workers.require_worktree: false`.

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

**Resolver args (step 1.45).** As of M012 S02 the entire dispatch resolution (engine decision + tier-chain + domain + effort + alias) **collapses into ONE call** to `forge-dispatch-resolve.js` (made in step 1.5 below). This step resolves only the *file* args that call consumes: `$PLAN_PATH` (execute-task frontmatter source) and `$ROADMAP_PATH` (domain tag + risk-escalation source). Everything else — `$ENGINE`, `$DOMAIN_USED`, `$WORKERS_TIMEOUT`, `$CODEX_MODEL`, `$MODEL_ALIAS`, `$TIER`, `$EFFORT` — is emitted by the resolver. Thin caller of `shared/forge-dispatch.md § Worker Engine Routing` (canonical). `forge-next` is sequential — no parallel-batch — so this is simpler than `forge-auto`; the resolver contract (vars, reasons, event) is otherwise identical to the `forge-auto` mirror.
> Cross-reference: `shared/forge-dispatch.md § Worker Engine Routing` (single-call resolver, route_source table, prefs reader, sidecar state machine, fallback) + `scripts/forge-dispatch-resolve.js` (S01). Any change lands there first, then propagates here.

When the resolved `$DISPATCH_ENGINE == codex` **and** `$unit_type == execute-task`, the Claude machinery below (alias warning, timeline, guarded `Agent()`) is **skipped** (Codex resolves its own model via the sidecar) — it runs only on the Claude path, including the fallback. When `$DISPATCH_ENGINE == codex` **and** `$unit_type == plan-slice`, the Claude machinery is likewise **skipped** — Branch D (sidecar plan, read-only) fires instead. `$DISPATCH_ENGINE == claude` (or `codex` for a non-routable unit) → control flows straight to the Claude dispatch (byte-identical to the current loop). `execute-task` and `plan-slice` (**active — S03**) are the two routable unit types. (`DISPATCH_ENGINE` is the additive normalized dispatch trigger — `gpt→codex`, `gemini→agy`, else `claude`; `$ENGINE`/`chain[].engine` stay family for events.)

```bash
# ── Resolver args (all pure resolution folded into forge-dispatch-resolve.js — step 1.5) ──
# Loud-stop reminder (M008-CONTEXT #2 — NOT a bare comment): prefs were already resolved AND
# loud-stop-guarded by the ONE forge-prefs.js --resolved call at Load context. If that resolution
# exited non-zero the run has ALREADY stopped there; there is no silent-fallback dispatch path.
# No engine/domain/worker/tier/effort parsing happens here anymore — the shared resolver reads
# the PLAN frontmatter + ROADMAP itself. Resolve only the *file* args it needs:
PLAN_PATH=""
if [ "$unit_type" = "execute-task" ]; then
  PLAN_PATH=".gsd/milestones/${M###}/slices/${S##}/tasks/${T##}/${T##}-PLAN.md"
fi
ROADMAP_PATH=".gsd/milestones/${M###}/${M###}-ROADMAP.md"
```
`$PLAN_PATH`, `$ROADMAP_PATH` are now set — the *file* inputs the shared resolver reads. `$ENGINE`/`$ENGINE_REASON`/`$DOMAIN_USED`/`$WORKERS_TIMEOUT`/`$CODEX_MODEL` are resolved **inside** the single `forge-dispatch-resolve.js` call (step 1.5). The Step 4 dispatch then branches on `$ENGINE`.

**Dispatch resolution (step 1.5)** — resolve `{engine, model, alias, tier, domain, route_source, chain, chain_len, reason, effort, effort_reason}` for this dispatch via the **SINGLE `forge-dispatch-resolve.js --json` call**. This one call folds the former Route-resolution-inputs + Tier Resolution + engine-by-route_source + Effort Resolution + Alias Resolution bash — a thin caller now, all pure resolution lives in the resolver. The **tier-chain cursor (Step 4b)** still runs AFTER the resolver as a consume-once override of `$MODEL_ID`/`$ENGINE`/`$DISPATCH_ENGINE`/`$REASON` (the cursor's persisted `engine` is the normalized dispatch-engine — set `$DISPATCH_ENGINE` from it when the cursor is consumed). Once `$DISPATCH_ENGINE` is known: **when `$DISPATCH_ENGINE == codex` && `$unit_type == execute-task`, skip the alias warning and the Claude `Agent()` machinery** — the sidecar resolves its own model. Alias/`Agent()` run only on the Claude path (including the `worker-engine-fallback` path, which re-enters them).
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
  # prefs_ok:false → resolver exit 1 (M008-CONTEXT #2 loud-stop; the Load-context prefs gate stays too).
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
# $ROUTE_JSON.chain carries forward unmodified — consumed by the Failure Taxonomy via
# `node "$FORGE_SCRIPTS_DIR/forge-routing.js" ... --next-after "$MODEL_ID"` on model_refusal/429/400
# (walks the cross-engine chain → category fallback → ''), BEFORE any cross-tier escalation
# (context_overflow's ladder is separate — re-resolves THROUGH routing at the escalated tier; see
# the Failure Taxonomy below and shared/forge-dispatch.md § context_overflow).

# Step 4-shadow: shadowing warning (risk #3) — routing: configured but not applied (advisory, stderr).
# $ROUTING_PRESENT comes from the contract itself — no second routing read.
if [ "$ROUTE_SOURCE" != "routing" ] && [ "$ROUTING_PRESENT" = "true" ]; then
  echo "⚠ routing: configurado mas não aplicado (route_source=$ROUTE_SOURCE) — frontmatter/legado venceu para $unit_type/$unit_id" >&2
fi

# Step 4b: tier-chain cursor (consume-once) — CROSS-ENGINE — runs AFTER the resolver as an override.
# A prior model_refusal/429/400 wrote the next chain member (+ its engine) here; consume it so THIS
# run dispatches $NEXT, not the refused
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
    # $CE is the persisted normalized dispatch-engine (codex/claude) → drive both ENGINE and the branch gate DISPATCH_ENGINE.
    ENGINE="$CE"; ENGINE_REASON="tier-chain-cursor:$CE"; DISPATCH_ENGINE="$CE"
  fi
fi
```
`TIER`, `MODEL_ID`, `MODEL_ALIAS`, `ROUTE_JSON` (`chain`), `ROUTE_SOURCE`, `CHAIN_LEN`, `DOMAIN_USED`, `ENGINE`, `ENGINE_REASON`, `EFFORT`, `EFFORT_REASON`, `WORKERS_TIMEOUT`, `CODEX_MODEL`, `SIDECAR_MODEL`, `THINKING_HEADER`, `unit_effort`, and `REASON` are now set (the tier-chain cursor above may have overridden `MODEL_ID`/`ENGINE`/`REASON`). Use `$MODEL_ID`/`$ENGINE` in the dispatch below (Step 4). `$TIER`, `$REASON`, `$DOMAIN_USED`, `$ROUTE_SOURCE`, `$CHAIN_LEN`, `$EFFORT`, `$EFFORT_REASON` are injected into the dispatch event.

> **Thinking guard (Fable 5 + Opus 5):** the resolver emits `$THINKING_HEADER` (`adaptive` when
> `$MODEL_ID` is `claude-fable-5`, or `claude-opus-5` with resolved effort `xhigh`/`max`; else empty).
> When `$THINKING_HEADER` is `adaptive`, inject `thinking: adaptive` in the worker prompt header (or
> omit the `thinking:` line) regardless of the phase's `thinking:` pref — `claude-fable-5` returns
> HTTP 400 on an explicit `thinking: disabled` at any effort, and `claude-opus-5` returns HTTP 400
> when `disabled` is paired with effort `xhigh`/`max` (Opus 4.7/4.8 accept it at any effort).

`unit_effort` (and `$EFFORT`/`$EFFORT_REASON` for the dispatch event) were set by the resolver above (§ Effort Resolution — unit-type default + frontmatter axis + risk-escalation sync + model-cap clamp). Inject `effort: {unit_effort}` and (for opus/fable phases) `thinking: {THINKING_OPUS}` into the worker prompt header.

**Risk radar gate (plan-slice only):** If `unit_type == plan-slice` and the slice is tagged `risk:high` in ROADMAP, check if `S##-RISK.md` already exists. If not:
```
mkdir -p .gsd/milestones/{M###}/slices/{S##}
Skill({ skill: "forge-risk-radar", args: "{M###} {S##}" })
```
This runs the risk assessment in the current context before the plan-slice agent is dispatched. The produced `S##-RISK.md` will be injected into the worker prompt.

**Security gate (execute-task only):** If `unit_type == execute-task`, scan `T##-PLAN.md` content for security-sensitive keywords using the canonical word-boundary pattern + narrow exception list in `shared/forge-dispatch.md § Security Gate — Keyword Pattern` (formula-once source — do not restate the regex here).

If the base pattern matches (and no exception suppresses it) AND `T##-SECURITY.md` does not already exist in the task directory:
```
Skill({ skill: "forge-security", args: "{M###} {S##} {T##}" })
```
The produced `T##-SECURITY.md` will be injected into the execute-task worker prompt as `## Security Checklist`.

**Cross-run claim gate (execute-task e review-fix):** If `unit_type == execute-task`, run the
**enforcing** cross-run write lease before dispatching. Spec autoritativa: `shared/forge-claim-gate.md`
— the decision table (§ Step 3), the canonical invocation (§ Step 2), B2 e a escalação (§ Step 4) vivem
lá, uma vez só; este bloco só invoca por referência.

`RUN_ID` ausente (step mode sem run registrada, mesmo caso da linha 895) → não há `RunRecord` próprio
para registrar o claim; pular o gate e ecoar o motivo — não há counterpart universe a confrontar sem
uma run própria:
```bash
if [ -z "$RUN_ID" ]; then
  echo "ℹ Claim gate pulado: RUN_ID ausente (step mode sem run registrada) — sem RunRecord próprio para registrar o claim."
else
  # --ready-alternatives: o ready set real da slice, já computado em BATCH_JSON (Step 1) — nunca uma
  # segunda enumeração. Legacy (`BATCH_JSON.mode == legacy`, sem .details.readyCount) → 0 (piso D3).
  READY_ALTERNATIVES=$(node -e "let r;try{r=JSON.parse(process.argv[1])}catch(e){r={}}; const rc=(r.details&&typeof r.details.readyCount==='number')?r.details.readyCount:0; process.stdout.write(String(Math.max(0, rc-1)))" "${BATCH_JSON:-{}}")

  GATE_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-claim-gate.js" --claim-and-check \
    --run "$RUN_ID" \
    --unit "execute-task/$unit_id" \
    --source plan-writes \
    --plan "$PLAN_PATH" \
    ${UNIT_CODE_DIR:+--code-dir "$UNIT_CODE_DIR"} \
    --ready-alternatives "$READY_ALTERNATIVES" \
    --cwd "$WORKING_DIR" \
    --json)
  GATE_EXIT=$?

  # `--code-dir` só quando o resolvedor de código já correu para esta unidade — B2. Neste ponto do
  # fluxo (antes do Step 4) o resolvedor per-unit ainda não rodou; `$UNIT_CODE_DIR` fica vazio salvo
  # se um passe anterior já o deixou setado (idempotência entre invocações). A flag omitida NÃO é
  # uma degradação silenciosa: o claim carrega `code_dir: null`, o escopo contra cada counterpart vira
  # `unknown` e `unknown` continua em escopo — o gate fecha por precaução, nunca abre por suposição.

  # Fail-closed (§ Fail-closed) — exit != 0 ou stdout não-JSON é sempre block/gate-unavailable, loud.
  if [ "$GATE_EXIT" -ne 0 ] || ! printf '%s' "$GATE_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{JSON.parse(d);process.exit(0)}catch(e){process.exit(1)}})"; then
    echo "⛔ Claim gate indisponível (exit $GATE_EXIT) — tratando como block/gate-unavailable. Nenhum dispatch." >&2
    # MODE == interactive: surface direto, sem run a desativar (§ Step 4 passo 3).
  else
    DECISION=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).decision||'')" "$GATE_JSON")
    CAUSE=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).cause||'')" "$GATE_JSON")
    ESCALATION=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).escalation||'')" "$GATE_JSON")
    NOT_COVERED=$(node -e "process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).not_covered||[]))" "$GATE_JSON")
    echo "ℹ Claim gate not_covered: $NOT_COVERED"
  fi
fi
```

Mapeamento por decisão (`MODE == interactive` — `shared/forge-claim-gate.md § Step 3`, agido por
referência, nenhuma tabela restatada aqui):

O gateamento aqui é **afirmativo**, e essa é a diferença de polaridade em relação ao `forge-auto`
(onde a task fica em `BATCH` por default): o dispatch só é alcançado pela linha `proceed`. `$DECISION`
só é atribuída no ramo `else` do fence acima — o ramo fail-closed a deixa **não-atribuída de
propósito**, e valor não-atribuído (ou fora do conjunto de quatro) não casa com nenhuma das linhas
abaixo, portanto nunca alcança a instrução de despachar. Não importar a forma do `forge-auto` aqui é
deliberado.

**O que alcança o dispatch é `advised_action`, nunca `decision`.** O eixo advisory/enforcing é
resolvido **pelo módulo** a partir de `parallelism.claim_gate` (spec § Step 0, § Enforcement) — o
consumidor nunca relê a pref. `advised_action == dispatch` → despachar; qualquer outro valor
(inclusive vazio/desconhecido) → **não** despachar. As quatro linhas abaixo governam a **mensagem**,
não o dispatch. Quando `suppressed_action` está presente (postura `advisory`), prefixar o eco com
`⚠ [advisory]` — a cerca computou a recusa e **não** agiu, e isso é dito, nunca silenciado.

- `proceed` → dispatch normal (Step 4 segue).
- `defer` → se `$BATCH_JSON` (ready set real da slice) tem outra task além desta, dispatchar ELA
  nesta invocação (eco nomeando a troca: "↷ Claim gate: {T##} adiada (colisão com run {counterpart}) —
  despachando {OUTRO_T##} no lugar"); senão surface "unidade adiada por claim overlap com run
  {counterpart} — re-rode /forge-next ou resolva a colisão" e parar (step mode já retorna ao operador
  de toda forma).
- `block` → surface IMEDIATO ao operador, **sem** `--wait` longo (o operador está presente — esperar em
  silêncio é pior UX que avisar): nomear counterpart, causa e paths (`.counterparts[].paths`), e as
  saídas legítimas de `shared/forge-claim-gate.md § Step 4`.
- `refuse` → surface da causa nomeada — `undeclared-writes` (plano sem `writes:` — repair no plano),
  `overlap` (medido — nomear paths e counterpart) e `pathless-conceded-item` (item concedido sem path
  — D7) são causas distintas e NUNCA substituídas uma pela outra — sem dispatch, esperar não resolve.
- `escalation` presente (`wait-ceiling`/`defer-cap`) → mesma mensagem do spec § Step 4; step mode não
  tem loop a desativar (só `MODE == auto` desativa a run).

`not_covered` é ecoado ao operador em toda execução do gate (linha acima) — o Overlap advisory abaixo
permanece intacto e distinto deste gate (um é sinal pós-hoc de toque; este é cerca pré-dispatch, cuja
execução é governada por `parallelism.claim_gate`).

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
3. Execute the procedure in **`shared/forge-review.md`** with `MODE = interactive`:
   > Antes de despachar cada agente (Challenge e Defense abaixo), exiba o **Spawn Liveness Banner** (ver `shared/forge-dispatch.md § Spawn Liveness Banner`) com duração estimada para `review-challenger` / `review-advocate`.
   - **Engine** (`shared/forge-review.md § Engine workflow`): se `engine: workflow` e a tool `Workflow` estiver no seu tool list (introspecção — NÃO ToolSearch), os três dispatches abaixo (Challenge/Defense/Rebuttal) são substituídos por UMA invocação Workflow; em tool ausente ou erro → fallback agents com warning + evento `review-engine-fallback`. O render do Step 6 e os Steps 7a/7b/8 não mudam.
   - Challenge → `Agent({ subagent_type: 'forge-reviewer', … })`
   - Defense → `Agent({ subagent_type: 'forge-advocate', … })` — pass `DEFENSE_FILE` (crash rail, `shared/forge-review.md § Step 3`); a defense that comes back missing/short/scoreboard-only is **salvaged from that file** before `review-advocate-unavailable` may be emitted.
   - Rebuttal × `rounds` → `forge-reviewer` in rebuttal mode (DEFENSE injected)
   - The `model:` of `forge-advocate`/`forge-reviewer` comes exclusively from resolved `$ADVOCATE_ALIAS`/`$CHALLENGER_MODEL`; literals are a violation detected by `forge-review-audit.js`.
   - Resolve (Step 5 truth table), write `{S##}-REVIEW.md` (Step 6).
   - **CONCEDED items → fix now (Step 7a):** resolve `RF_ALIAS=$(node "$FORGE_SCRIPTS_DIR/forge-dispatch-resolve.js" --unit-type review-fix --cwd "$WORKING_DIR" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).alias||'')}catch(e){}})")`; **before dispatching**, run the cross-run claim gate per `shared/forge-review.md § Step 7a → Cross-run claim gate (before the dispatch)` + `shared/forge-claim-gate.md` (same procedure as the execute-task gate above, `--unit "review-fix/{S##}"`, `--conceded` built from the CONCEDED items' `path:line` — act by that spec's decision table, never restated here); dispatch `review-fix/{S##}` with `model: '{RF_ALIAS}'` only when non-empty.
   - **OPEN items (Step 7b, interactive):** each OPEN objection is put to the user via `AskUserQuestion` — `Manter abordagem` / `Refatorar agora` (dispatches a `review-fix` unit for the accepted items) / `Criar follow-up` (creates an item per `shared/forge-review.md § Item capture`, source `review/{S##}/{R#}`, plus the pointer line in `.gsd/KNOWLEDGE.md § Review follow-ups`) — and the decision is written back into `{S##}-REVIEW.md`.
   - Append the `review` event to `events.jsonl` (Step 8).
4. The gate **never blocks** — any `Agent()` throw is recorded and the step proceeds to `complete-slice` regardless.
   - On throw, follow `shared/forge-review.md § Agent unavailability (review-agent-unavailable)`: retry first via `shared/forge-dispatch.md § Retry Handler`; if the agent stays unavailable, emit `review-agent-unavailable` (`review-advocate-unavailable` | `review-challenger-unavailable`) — **never** the CRITICAL failure path.

   > **REGRA CRÍTICA:** o orquestrador NUNCA produz veredito de review no lugar de um agente indisponível — nem defesa, nem réplica, nem julgamento de objeção alheia. A única ação permitida é registrar a indisponibilidade e escalar ao humano (interativo) ou deferir à triagem final (auto).

   - **Política deste modo (`MODE = interactive`):** advogado indisponível — **só depois** de a salvage do `DEFENSE_FILE` não render nenhum veredito (`shared/forge-review.md § Step 3`) — ⇒ objeções sobem **cruas** ao humano via `AskUserQuestion` (Step 7b), sem veredito fabricado, com Rebuttal PULADO e a ressalva de adversarialidade reduzida no artefato. Challenger indisponível ⇒ `{S##}-REVIEW.md` mínimo registrando a indisponibilidade (proibido renderizar como limpo — ausência de review não é aprovação).

> Fires ONLY when the derived unit is `complete-slice`. Boundary is per-slice; standalone `/forge-task` keeps its own step-5.5 review. After the gate, dispatch `forge-completer` normally.

**Slice git guard (around complete-slice):** `complete-slice` never integrates a branch — no unit of the loop does; integration is the operator's act on the delivered `forge/{run}` branch (`agents/forge-completer.md § Git boundary — complete-slice`). Snapshot the checkout **before** dispatching, verify **after** the worker returns:

```bash
# before Agent("forge-completer", ...)
node "$FORGE_SCRIPTS_DIR/forge-slice-git-guard.js" --snapshot --cwd "$CODE_DIR" --gsd-dir "$WORKING_DIR/.gsd" --run "$RUN_ID" --unit "complete-slice/{S##}" > /dev/null
# after it returns
node "$FORGE_SCRIPTS_DIR/forge-slice-git-guard.js" --verify --cwd "$CODE_DIR" --gsd-dir "$WORKING_DIR/.gsd" --run "$RUN_ID" --unit "complete-slice/{S##}"
```

The snapshot is written to `.gsd/forge/` on purpose — shell variables do not survive between Bash calls. `--gsd-dir` and `--run` are **not optional here** (item #112): `--cwd` is the `CODE_DIR`, so without `--gsd-dir` the baseline lands inside the worktree — against the `.gsd/**`-stays-in-the-workspace convention, and as an untracked file that can make `cleanupWorktreeOne` report `skipped (dirty)`; and without `--run` two runs closing the same `{S##}` in one workspace share a file, so one run's baseline answers for the other. The baseline is **spent by the verify** — call `--snapshot` immediately before every dispatch, never once for several verifies, or the second one reports `inconclusive` (never `clean`). Exit `3` = violation (moved checkout, advanced default branch, or new merge commit): print it LOUDLY to the operator with the offending detail, append a `slice-git-violation` event, and **do not push** — nothing is pushed yet, so `git reset --hard` on the default branch still recovers it. Verdict `inconclusive` means nothing was measurable (no git repo, unresolved default branch) and **must not** be read as clean. The guard never blocks the loop; it reports.

**Review triage gate (before complete-milestone):** If `unit_type == complete-milestone`, run the milestone-final triage (`shared/forge-review.md § Step 9`) BEFORE dispatching `forge-completer`. In pure forge-next sessions OPEN items were already decided live per-slice, so this usually finds nothing and skips silently — it exists for mixed sessions (slices run under `forge-auto` with `ask_in_auto: defer`, milestone closed via `forge-next`): scan all `{S##}-REVIEW.md` for pending `deferido`/`falhou — deferida` items, triage each via `AskUserQuestion`, dispatch ONE `review-fix/{M###}-triage` for the `Refatorar agora` items (`Criar follow-up` items create an item per `shared/forge-review.md § Item capture`, source `review/{S##}/{R#}`, plus the pointer line in `.gsd/KNOWLEDGE.md § Review follow-ups`), write decisions back, append the `review-triage` event. Never blocks the close-out.

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

#### Gate Step 0 — Read da pref `plan_gate:` (canonical engine CLI)

Both knobs read via the canonical engine CLI (single-knob convenience form — reads the jsonc catalog per layer; legacy Markdown without jsonc hard-stops — see `shared/forge-prefs-cutover.md`; NEVER a 3-file cascade node -e merge, MEM001 M005). Defaults byte-identical to the old inline cascade: `interactive=always` (whitelist `always|auto|off`), `ask_in_auto=defer` (whitelist `defer|off`).

```bash
INTERACTIVE=$(node "$FORGE_SCRIPTS_DIR/forge-prefs.js" --resolved --key plan_gate.interactive --cwd "$WORKING_DIR" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{let v=String(JSON.parse(d).value||'').toLowerCase();process.stdout.write(['always','auto','off'].includes(v)?v:'always')}catch(e){process.stdout.write('always')}})")
ASK_AUTO=$(node "$FORGE_SCRIPTS_DIR/forge-prefs.js" --resolved --key plan_gate.ask_in_auto --cwd "$WORKING_DIR" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{let v=String(JSON.parse(d).value||'').toLowerCase();process.stdout.write(['defer','off'].includes(v)?v:'defer')}catch(e){process.stdout.write('defer')}})")
```

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
Options: ["Manter — aceitar assim", "Corrigir no ato", "Deferir — vira item no backlog"]
```

Registrar a resolução de cada finding individualmente (para inclusão no marker):
- `Manter` → aceitar o finding sem mudança; anotar no marker como `{dimensão}: mantido`.
- `Corrigir no ato` → prosseguir para Gate Step 3 (edição livre) com intenção de corrigir.
- `Deferir` → cria um item per `shared/forge-review.md § Item capture` (source `plan-gate/{S##}`, `origin: auto`, `status: inbox`, sem `file` — esta junção não tem um) e anota no marker como `{dimensão}: deferido → {I-id} — {title}`.

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

**Required renderer (Claude path):** render the bounded artifact; never paste the historical template body into an agent call.
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
Pass only `Read the complete Forge dispatch contract at {PROMPT_PATH}, execute it exactly,
and return its required GSD worker result block. The file is trusted
orchestrator input; do not replace it with a summary.` to the Claude subagent. Persist both identities in the dispatch event and remove the artifact with `forge-prompt.js --cleanup "$DISPATCH_ID" --cwd "$WORKING_DIR"` after durable result processing. Do not load `.gsd/AUTO-MEMORY.md`; the renderer selects bounded memories. The manual selection/template text below is compatibility reference only.

Only after `Agent()` returns successfully, run `node "$FORGE_SCRIPTS_DIR/forge-context-boundary.js" --action ack --cwd "$WORKING_DIR" --run "${RUN_ID:-$MILESTONE_ID}" --milestone "$MILESTONE_ID" --slice "$SLICE_ID" --task "$TASK_ID" --unit "$unit_type/${TASK_ID:-$SLICE_ID}" --pending-id "$PENDING_CONTEXT_ID"`. Rendering/dispatch failure leaves the durable record pending for retry; an empty id is inert.

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

> For human-readable consolidation, run `/forge-doctor --regen-projection` to rebuild the monolith from fragments (writes `AUTO-MEMORY.md` via `forge-memory.js --write-all`). See `forge-projection` in doctor help.

Use the template from `$FORGE_SHARED_DIR/forge-dispatch.md` for the current `unit_type`.
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

**Heartbeat — record active worker** before dispatching (same block as `forge-auto/SKILL.md § Heartbeat — record active worker`; replicate the form, do not invent another).

Until S01/T02 this skill had **zero** invocations of `forge-runs.js` (measured: `grep -c "forge-runs.js" skills/forge-next/SKILL.md` → `0`), so in step mode `run.worker` was never written and `forge-hook.js::resolveUnitContext` resolved **every** dispatch to `adhoc` — every tool call of every step-mode unit landed in one shared `evidence-…-adhoc.jsonl`. That is cause (a) of IN-2:
```bash
# One spawn (2026-08-24). Step mode NEVER falls back to auto-mode.json (see note
# below), so --run is passed only when a run exists — never the legacy branch.
if [ -n "$RUN_ID" ]; then
  node "$FORGE_SCRIPTS_DIR/forge-runs.js" --heartbeat --run "$RUN_ID" --worker "UNIT_TYPE/UNIT_ID" --worker-slice "SLICE_ID" > /dev/null || true
else
  echo "ℹ worker não registrado: RUN_ID ausente (step mode sem run registrada) — evidence desta unidade cai em adhoc"
fi
```
Replace `UNIT_TYPE/UNIT_ID` with the actual values (e.g. `execute-task/T01`) and `SLICE_ID` with this unit's slice (e.g. `S01`); use `null` **unquoted** when the unit has no slice. Unlike `forge-auto`, step mode does **not** fall back to writing `auto-mode.json`: this skill never activates auto-mode, and asserting `active:true` there would make the statusline (and the handoff check) report an autonomous run that is not happening. An absent `RUN_ID` is announced as a named reason instead.

**Per-unit `CODE_DIR` resolution (multi-repo precondition)** — executable mirror of `shared/forge-dispatch.md § Sidecar dispatch state machine step 0.5` (contract prose lives there, never restated here). Runs HERE because `$PLAN_PATH` is only known per unit — the bootstrap `WORKTREE_DIR` (§ Isolation setup) is derived before any plan exists and stays untouched:
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
**Never assign to `WORKTREE_DIR` here.** An empty `WORKTREE_DIR` is the "every repo failed" STOP signal of the Isolation rules — a sidecar refusal must never be mistaken for an isolation failure. The two `CODE_DIR=` lines above make the resolved value reach the bash consumers deterministically, without depending on model substitution: status `ok` → the attributed worktree; refusal with a non-empty `multi_repo_root` → the run root holding every worktree, so a genuinely multi-repo unit stops landing in whichever repo sorted first (`multi_repo_root` is empty in a single-repo workspace, which keeps the bootstrap value).

**Branch codex / Branch D — sidecar (`$DISPATCH_ENGINE == codex`): executable spec loaded on demand.**

The full executable branch text (state machine, BLOCKER contract mechanics, Layer-1 transient
retry with the TTY pause-ask gate, Layer-2 chain walk, orphan detection, fallback accounting)
lives in **`shared/forge-sidecar-next.md`** — read it NOW (`shared/forge-sidecar-next.md` if it
exists in the working repo, else `${FORGE_HOME:-~/.forge-agent}/shared/forge-sidecar-next.md`),
follow it exactly, and fall through to the **Claude dispatch** below only where that spec says to.
Canonical contract (authoritative, unchanged): `shared/forge-dispatch.md § Worker Engine Routing`.

Non-negotiables that bind even before the spec is read (routing contract, CLAUDE.md):
- NEVER execute the unit inline in the main context, and NEVER substitute
  `Agent("forge-executor")`/`Agent("forge-planner")` for a resolved codex route.
- The ONLY legitimate degradation to Claude is the named `worker-engine-fallback` event written
  to `.gsd/forge/events.jsonl` by the spec's Layer-2 — fallback without the event is silent bypass.
- If neither spec path is readable, that is a broken installation: STOP the run and surface it —
  never improvise the branch from memory.

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

**Alias Resolution** — `Agent()`'s `model:` param only accepts `sonnet|opus|haiku|fable`, never a full model ID. `$MODEL_ALIAS` was already resolved by `forge-dispatch-resolve.js` (its `alias` field) in step 1.5 — just warn if it came back empty:
```bash
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
# shared/forge-dispatch.md § DISPATCH_VCS prelude (canonical — VCS-agnostic)
DISPATCH_VCS=$(node "$FORGE_SCRIPTS_DIR/forge-vcs.js" --detect --field vcs --cwd "${CODE_DIR:-$WORKING_DIR}" 2>/dev/null || echo "git")
echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"dispatch\",\"unit\":\"${unitType}/${unitId}\",\"model\":\"${MODEL_ID}\",\"tier\":\"${TIER}\",\"reason\":\"${REASON}\",\"effort\":\"${EFFORT}\",\"effort_reason\":\"${EFFORT_REASON}\",\"slice\":\"{S##}\",\"milestone\":\"${RUN_ID:-{M###}}\",\"input_tokens\":${INPUT_TOKENS},\"output_tokens\":${OUTPUT_TOKENS},\"model_applied\":${MODEL_APPLIED_JSON},\"engine\":\"${ENGINE:-claude}\",\"domain\":\"${DOMAIN_USED}\",\"route_source\":\"${ROUTE_SOURCE}\",\"chain_len\":${CHAIN_LEN},\"vcs\":\"${DISPATCH_VCS:-git}\",\"transport\":\"in-process\"}" >> .gsd/forge/events.jsonl
```

**Heartbeat — clear worker field** after `Agent()` returns (mirror of `forge-auto/SKILL.md`; keeps the run from advertising a worker that already finished):
```bash
if [ -n "$RUN_ID" ]; then
  node "$FORGE_SCRIPTS_DIR/forge-runs.js" --heartbeat --run "$RUN_ID" --clear > /dev/null || true
fi
```

### 5. Process result

**Update timeline task** — mark the current task based on outcome:
- `status: done` → `TaskUpdate({ taskId: current_task_id, status: "completed" })`
- `status: partial` or `status: blocked` → leave task as `in_progress` (shows it was interrupted)

**5.0 — Contract miss gate (Layer 0), BEFORE any status parsing.** Classify the return instead of eyeballing it for a block:

```bash
CLASSIFY=$(node "$FORGE_SCRIPTS_DIR/forge-worker-result.js" --classify --inline "$result")
SHAPE=$(printf '%s' "$CLASSIFY" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).shape")
```

`SHAPE == complete` → fall through unchanged. Anything else (`absent` / `status-missing` / `empty`) → run the **recovery ladder** in `shared/forge-dispatch.md § Missing worker result (contract miss)` — canonical for the ladder, the salvage bases, the repair wording and the `contract_miss` event; do not restate them here:

```bash
SALVAGE=$(node "$FORGE_SCRIPTS_DIR/forge-worker-result.js" --salvage \
  --unit "execute-task/{T##}" --plan "$PLAN_PATH" \
  --summary "$WORKING_DIR/.gsd/milestones/{M###}/slices/{S##}/tasks/{T##}/{T##}-SUMMARY.md" \
  --events "$WORKING_DIR/.gsd/milestones/{M###}/{M###}-events.jsonl" \
  --events "$WORKING_DIR/.gsd/forge/events.jsonl" \
  --code-dir "$CODE_DIR" --since "$START_SHA" --vcs "${DISPATCH_VCS:-git}")
```

A rung that yields a status hands back a `recovered.block` — parse **that** with the rows below. `/forge-next` is always `MODE = interactive`, so when the ladder reaches rung 4 (`blocked`), show the operator the salvage census verbatim before surfacing: what was probed and what each probe found is the actionable part, not the verdict alone.

Parse the `---GSD-WORKER-RESULT---` block:
- `status: done` → proceed to post-unit housekeeping
- `status: partial` → write `continue.md`, update STATE, emit compact signal, stop
- `status: blocked` → classify failure before surfacing to user:

| Class | Signals | Message to user |
|-------|---------|-----------------|
| `context_overflow` | "context limit", "too long", "token" | "Task too large for one context window. Run `/forge-next` again — it will retry with a more capable model." **Climbs the separate tier ladder (`standard → heavy → max`), does NOT consume `chain[]`** — but S02 re-resolves THROUGH routing at the escalated tier so a domain-specific `routing.<domain>.<phase>.<escalated-tier>` cell is honored: `ROUTE_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-routing.js" --unit-type "$unit_type" --tier "$ESCALATED_TIER" --domain "$DOMAIN" --frontmatter-tier "$PLAN_TIER" --frontmatter-worker "$PLAN_WORKER" --cwd "$WORKING_DIR")` then `MODEL_ID=chain[0].id`. Escalated tier `max` is terminal → `blocked → human`. Persist the cursor `{model, engine, ts}` (engine from `chain[0].engine`) so the next `/forge-next` resumes at the escalated model. |
| `scope_exceeded` | "out of scope", "too broad" | "Task scope too broad. Ask the planner to split T## before continuing." |
| `model_refusal` | "cannot", "I'm not able", "policy" | Walk the **cross-engine chain** via routing: `NEXT=$(node "$FORGE_SCRIPTS_DIR/forge-routing.js" --unit-type "$unit_type" --tier "$TIER" --domain "$DOMAIN" --frontmatter-tier "$PLAN_TIER" --frontmatter-worker "$PLAN_WORKER" --cwd "$WORKING_DIR" --next-after "$MODEL_ID")` — this replaces the old `forge-tier-chain.js --next-after` (SAME Layer 2, new resolver — never a 4th layer). It walks the resolved chain → category fallback → `''`. **Persist the cross-engine cursor:** if `$NEXT` is non-empty, re-derive its engine (`NEXT_FAMILY=$(node "$FORGE_SCRIPTS_DIR/forge-model-alias.js" --family "$NEXT")`; `gpt→codex`, else `claude`) and write `$WORKING_DIR/.gsd/forge/tier-cursor-${RUN_ID:-legacy}-${unit_type}-${unit_id}.json` as `{"model":"$NEXT","engine":"$NEXT_ENGINE","ts":"<ISO8601 now>"}` (`mkdir -p` first) — Step 4b above consumes-and-deletes it on the *next* `/forge-next`, re-inspecting the engine to route to Branch codex or the Claude Agent. If the `$NEXT` member is codex, the verified reset (BLOCKER invariant #2 — `forge-surgical-reset.js --reset` must exit 0) runs before that next attempt captures its snapshot via `--state-init`. `forge-next` does not auto-recover mid-unit (step mode surfaces) — surface: "Model refused the task. Run `/forge-next` again — it will retry with the next model in the chain (`$NEXT`)." If `$NEXT` is empty (chain + category fallback exhausted) → do NOT write a cursor; surface "Model refused the task and the chain is exhausted. Adjust the task plan or routing config." |
| `429` | "rate limit", "429", "quota" | Same cross-engine chain-walk + cross-engine cursor-persist semantics as `model_refusal` — surface: "Rate limited. Run `/forge-next` again — it will retry with the next model in the chain (`$NEXT`)." or "chain exhausted" message if `$NEXT` empty (no cursor written). This is a `status: blocked` classification (Layer 2), distinct from a transient 429 raised as an `Agent()` exception (Retry Handler, Layer 1). |
| `400` | "400", "bad request", "invalid" | Same cross-engine chain-walk + cross-engine cursor-persist semantics as `model_refusal`. |
| `tooling_failure` | "command not found", "permission denied", "ENOENT" | "Tooling error — check that required tools are installed." |
| `external_dependency` | "API", "network", "not running" | "External dependency unavailable — resolve it and re-run `/forge-next`." |
| `unknown` | anything else | Surface raw blocker message. |

**Item capture on terminal stops.** Fires only for the branches above that do NOT persist a retry cursor — `scope_exceeded`, `tooling_failure`, `external_dependency`, `unknown`, and the chain-exhausted / tier-max-terminal sub-branches of `context_overflow`, `model_refusal`, `429`, `400` (i.e. exactly where the table says "blocked → human" / "chain exhausted" / no cursor written). It never fires when `$NEXT`/the escalated tier is non-empty and a cursor is written — the system has not given up yet.

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

**Node Repair gate (Layer 3 — disjoint from Layers 1 and 2):** Applies ONLY when `unit_type == execute-task`. Trigger: `status: done` AND `S##-VERIFICATION.md` rows show must_have drift (artifacts `substantive:false` / `wired:false`, test-quality flags) OR `status: partial` with must_haves unmet. `Agent()` throws → Layer 1. `status: blocked` → Layer 2. Do NOT overlap. See full spec: `shared/forge-dispatch.md § Node Repair`.

1. **Read prefs** via the canonical engine CLI (single-knob convenience form — reads the jsonc catalog per layer; legacy Markdown without jsonc hard-stops — see `shared/forge-prefs-cutover.md`; NEVER a 3-file cascade node -e merge, MEM001 M005; default `2` on absence/parse error):
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

> **BATCH RULE (2026-08-24, turn consolidation):** compose every input FIRST, then execute
> the SHELL of the sub-steps below in **as few Bash invocations as possible — target ONE
> combined fence**. The fences define WHAT runs and in what order, not how many tool calls
> you spend. `Agent()` dispatches and conditional prose branches stay outside.

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
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-decisions.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
DECISIONS_UNIT_ID="${M###:-${task_id:-}}"
if [ -n "$DECISIONS_UNIT_ID" ]; then
  printf '%s' "$key_decisions_json" | node "$FORGE_SCRIPTS_DIR/forge-decisions.js" --write --cwd "$WORKING_DIR"
else
  echo "[forge-next] WARNING: no unit_id for decisions — skipping fragment write" >&2
fi
```

Where `key_decisions_json` is a JSON object `{ "unit_id": "$DECISIONS_UNIT_ID", "decisions": [...] }` built from the `key_decisions` field of the worker result. The global `.gsd/DECISIONS.md` is rebuilt from fragments during `complete-milestone` (forge-merger, S05). Do NOT write directly to `.gsd/DECISIONS.md` or any `M###-DECISIONS.md` file.

**d) Memory extraction** — use the zero-model policy before calling `forge-memory` (blocking when selected):

```bash
MEMORY_POLICY=$(printf '%s' "$RESULT_BLOCK" | node "$FORGE_SCRIPTS_DIR/forge-cost-policy.js" memory \
  --unit-type "$unit_type" --cwd "$WORKING_DIR" --stdin 2>/dev/null) || MEMORY_POLICY='{"decision":"extract","reason":"policy-error"}'
```

Append a `memory-policy` event for every decision. If `MEMORY_POLICY.decision != "extract"`, skip the agent and continue to d-reinject. The fallback is deliberately fail-open (`extract`) when the policy cannot run.

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

Read `scope_reduction.reinject` from prefs (canonical engine CLI, pattern identical to `plan_check.mode`; default `auto`). If `off` → skip this step (PRUNE still registers in CONTEXT — independently of this pref).

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

**d-release) Ask for the claim release (unit boundary)** — runs after the re-injection diff, before
isolation cleanup. Applies to units that went through the claim gate (`execute-task`, `review-fix`);
skip otherwise.

Run the **canonical release invocation** of `shared/forge-claim-gate.md § Release lifecycle`
verbatim, with `RUN_ID`, `WORKING_DIR` and (per the B2 rule stated there) `CODE_DIR` bound to this
dispatch's values. Mechanisms, probes, TTL rule and flag set live in that section — do not restate
them here, and do not add flags it does not list.

**Fail-soft, by decision.** Asking for a release is *measuring*; a measurement that cannot be taken
leaves the claim standing, which is the safe side. A non-zero exit, invalid JSON or a refused
request (`held: true`) echoes one line and the flow **continues** — the deliberate opposite of the
pre-dispatch gate, which is enforcing. The `claim-release` event is written **by the module**
(`shared/forge-dispatch.md § Event claim-release`), never narrated here.

**e) Isolation cleanup (complete-milestone only)** — if the unit just processed was `complete-milestone` with `status: done`, release the isolation. No-op when `ISOLATION_MODE == shared`; `branch` mode checks the repo back out to the default branch (the `forge/{run}` branch is kept for PR/merge); `worktree` mode removes the worktree only if `worktree_cleanup_on_complete: true` in prefs. Never run this on partial/blocked — the branch/worktree must survive for resume:
```bash
node "$FORGE_SCRIPTS_DIR/forge-isolation.js" --cleanup --run "$ISO_RUN" --cwd "$WORKING_DIR" || true
```

**f) Emit progress + next action:**
```
✓ [M001/S02/T03] execute-task — JWT auth with refresh rotation  · forge-executor (claude-sonnet-5)
→ Next: /forge-next para {next unit_type} {unit_id}
```

Display the progress line AND the next action (read from the per-run `M###-STATE.md` you just updated, not the root dashboard). The user needs to know what comes next to decide whether to continue. Do not add summaries, explanations, or other follow-up text beyond these two lines.

Exception — when the unit just processed was `complete-milestone` with `status: done`, add ONE line naming the deliverable:
```
Entregável: branch `forge/{run}` — pronta para push e PR. Pronta para PR — a integração na branch default é do operador; o loop nunca integra.
```

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

2. Write the per-run state `.gsd/milestones/M###/M###-STATE.md` (via `scripts/forge-state.js` — never the root `.gsd/STATE.md`, which is a generated dashboard) to point to this task with `phase: resume`, then run `node scripts/forge-dashboard.js --cwd .` to regenerate the dashboard.
3. Tell the user: "Trabalho parcial salvo. Execute `/forge-next` para retomar de onde parou."

On resume: per-run STATE has `phase: resume` → read `continue.md`, inline into worker prompt with instruction "Resume from continue.md — skip completed work, start from Next Action."
