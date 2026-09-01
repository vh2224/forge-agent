# Sidecar dispatch — executable Branch C / Branch D (forge-auto)

> **Loaded on demand.** Extracted VERBATIM from `skills/forge-auto/SKILL.md` on 2026-08-23
> (context diagnosis): these two branches cost ~11.5k tokens in EVERY orchestrator turn while
> 86/86 measured dispatches ran `engine: claude` — a 0%-use path priced into 100% of turns.
> The orchestrator reads this file ONLY after the resolver gate, when the
> normalized `WORKER_MODE == sidecar`, or after the one allowed native result
> `not-spawned` changes that same resolved worker to an explicitly declared
> sidecar. The canonical, authoritative contract is unchanged:
> `shared/forge-dispatch.md § Worker Engine Routing` — this file remains its executable mirror.
> All $VARIABLES below are the ones set by the forge-auto dispatch steps ($ROUTE_JSON,
> $SIDECAR_MODEL, $WORKERS_TIMEOUT, $CODE_DIR, $WORKING_DIR, $FORGE_SCRIPTS_DIR, ...).

**Branch C — sidecar codex (`WORKER_MODE == sidecar && RESOLVED_WORKER_ENGINE == codex && unit_type == execute-task && BATCH.length == 1`):**

Entry is fail-closed: `DISPATCH_ALLOWED` is already `true` before this file is
loaded. A false verdict prints `DISPATCH_REASON_CODE` + `DISPATCH_HINT` and
stops in the caller; it never reaches this mirror or a fallback. When entry
follows native `not-spawned`, the caller increments its one-shot transition
counter, verifies `RESOLVED_WORKER_ENGINE == HOST_RUNTIME`, then sets
`WORKER_MODE=sidecar`, `SIDECAR_DECLARED=true`, and retains
`DISPATCH_ALLOWED=true`. No other native outcome may enter.

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
    --state "$XLLM_STATE" --cwd "$CODE_DIR" --attempt "$N" --repo-roots-file "$CODE_DIR_ROOTS_FILE")
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
    --host-runtime "$HOST_RUNTIME" --sidecar-declared \
    --plan "$PLAN_PATH" --result-file "$RESULT_FILE" --cwd "$CODE_DIR" --context-root "$WORKING_DIR" \
    --writable-roots-file "$CODE_DIR_WRITABLE_ROOTS_FILE" \
    --timeout "$WORKERS_TIMEOUT" \
    --security "$SECURITY_FILE" --context-bundle "$CTX_BUNDLE" \
    $([ -n "$SIDECAR_MODEL" ] && printf -- '--model %s' "$SIDECAR_MODEL")
  ```
- **Poll `$RESULT_FILE`** (`polling` state) every ~5–10s: `status == "running"` → keep polling + liveness check; `status == "done"` (exit 0) → **success**; `status == "error"` / adapter exit `!= 0` / unparseable JSON → **failure** (`reason` = `codex-error`/`codex-exit-nonzero`/`codex-invalid-json`). **Orphan:** heartbeat `updated_at` stale beyond the dynamic threshold `max(heartbeat_interval_ms × 4, 30s)` (field absent → assume 15s → 60s) → run the canonical liveness snippet (`shared/forge-dispatch.md § Orphan detection`): `stale-dead` → `kill "$pid"` (from heartbeat) → failure `reason: codex-orphan`; `stale-alive` → grace of one more poll cycle, then kill if still stale. The adapter `--timeout` is the backstop → `codex-timeout`.
- **Context boundary (after terminal poll, before success/failure):** run `CONTEXT_BOUNDARY=$(node "$FORGE_SCRIPTS_DIR/forge-context-boundary.js" --result "$RESULT_FILE" --cwd "$WORKING_DIR" --plan "$PLAN_PATH" --run "${RUN_ID:-{M###}}" --milestone "{M###}" --slice "{S##}" --task "{T##}" --unit "execute-task/{T##}" --step "post-sidecar-poll")`. Display `.indicator`; the helper durably queues non-empty `.additional_context` under the exact run/milestone/slice/unit scope. `.checkpoint_required:true` means it preserved the canonical slice `continue.md` or atomically created its protocol-complete shape and recorded one consumption marker; continue the run at the next safe boundary, never auto-pause. Unknown health yields `ctx ?`, no context, and no checkpoint.
- **Terminal outcome — runtime evidence materialization (step 7b), on EVERY outcome:** as soon as the poll loop settles a terminal outcome for this dispatch — `done`, **or** a failure reason that Layer-1 transient retry will not retry in place (including `codex-invalid-json` and an unreadable `$RESULT_FILE`) — invoke exactly once `node "$FORGE_SCRIPTS_DIR/forge-evidence-materialize.js" --result "$RESULT_FILE" --unit "execute-task/{T##}" --milestone "{M###}" --slice "{S##}" --cwd "$WORKING_DIR" --json`. **All three axes, never `--unit` alone** (S01 review R2): the file name is the composite key, so an invocation missing the two axes lands under the `_no-milestone_`/`_no-slice_` sentinels, which parse back to `null` and can never match the real `{M###, S##, T##}` at resolution time — written and never found. Step **7b** of `shared/forge-dispatch.md § Sidecar dispatch state machine` owns its outcome enum, naming and census; this mirror only invokes and never restates them (exit 0 always, advisory). It sits **before** the Success/Failure split on purpose (S06 review R9): invoked only from Success, the canonical table's unreadable-result-file row was unreachable from every call site. **One census per terminal outcome, never one per retry** — a Layer-1 in-place retry has not reached a terminal outcome yet and does not invoke it.
- **Orchestrator re-verification (TASK-015):** `REVERIFY=$(node "$FORGE_SCRIPTS_DIR/forge-reverify.js" --result "$RESULT_FILE" --code-dir "$CODE_DIR" --gsd-dir "$WORKING_DIR/.gsd" --apply --json)`. Follow `shared/forge-dispatch.md § Sidecar dispatch state machine` for the formula. `verified` continues with the amended result, `failed` follows Failure, and `no-command` leaves it untouched. Emit `orchestrator_reverification` with `unit:"execute-task/{T##}"`, command, exit code, verdict, entries and ISO timestamp; except for `not-applicable`, add `## Re-verification` to the summary.
- **Partial promotion boundary:** if the valid result JSON has `status == "partial"`, run `PROMOTION=$(node "$FORGE_SCRIPTS_DIR/forge-env-promote.js" --result "$RESULT_FILE" --plan "$PLAN_PATH" --json)` before selecting Success or Failure. Follow `shared/forge-dispatch.md § Sidecar dispatch state machine` for the canonical algorithm/allowlist; do not duplicate it here. If `PROMOTION.promote == true`, treat it as `done`: write `## Env Constraints` (item + reason + note per entry) in `T##-SUMMARY.md`, synthesize `env_constraints[]` in the result block, omit promoted entries from `must_haves_status.dropped`, and append `sidecar_env_promotion` with unit `execute-task/{T##}`, count, reasons and ISO timestamp to events.jsonl. If false (including old payloads without `scope`), take Failure unchanged.
- **`status == "done"` with unmet env-scope entries (M016 S01 review R1):** run the same `forge-env-promote.js` invocation whenever `status == "done"` but `must_haves_status` still has unmet entries — never accept the `done` label at face value. `verdict == "done-with-verified-env"` → accept, write `## Env Constraints` as above. `verdict == "done-with-unverified-env"` → treat the result as `partial` and follow Failure unchanged (classifier → repair strategy); the worker's `done` label is discarded.
- **Corroboration fallback — reachable from BOTH invocations above** (S06 review R8: this used to hang off the `status == "partial"` bullet alone, so the `status == "done"` path ran the same checker and never consumed `fallbacks`): after **either** invocation — the `status == "partial"` boundary or the `status == "done"` with unmet env-scope entries — if `PROMOTION.fallbacks` is non-empty, append one `sidecar_env_corroboration_fallback` line per entry (`unit:"execute-task/{T##}"`) as defined in `shared/forge-dispatch.md § Sidecar dispatch state machine`, regardless of the promotion outcome.
- **Success (`done`):** first re-read the durable state from disk (the poll loop crossed multiple Bash invocations — shell vars are gone), then the orchestrator reads the JSON and **writes `T##-SUMMARY.md`** (same format as a Claude worker) + assembles the `---GSD-WORKER-RESULT---` block itself. Codex NEVER touches `.gsd/**` and NEVER commits. Consume: `summary` (SUMMARY seed), `must_haves_status` (into the result block), `env_constraints` (promotion audit only), and VCS-derived `files_changed` from the result JSON (**authoritative**); `files_changed_declared` is an untrusted advisory cross-check. `start_sha`/`head_sha` are audit only — `$START_SHA` is authoritative. Append synthesized advisory evidence to the file resolved by `buildEvidenceFileName` (S01/T03 — `EVIDENCE_FILE=$(node -e "process.stdout.write(require('$FORGE_SCRIPTS_DIR/forge-evidence-path.js').buildEvidenceFileName({milestone:'{M###}',slice:'{S##}',unit:'execute-task/{T##}'}))")`, under `$WORKING_DIR/.gsd/forge/` — never interpolated locally as `evidence-{unitId}.jsonl`) with `node "$FORGE_SCRIPTS_DIR/forge-vcs.js" --changes --cwd "$CODE_DIR" --since "$START_SHA"`, tagged `source: codex-sidecar`; preserve the invariant that no `.gsd/**` path appears. Executable mirror of `shared/forge-dispatch.md § Post-run change set + baseline (canonical — VCS-agnostic)`. The runtime-observed lines of the same artifact were already materialized by the terminal-outcome bullet above — do **not** invoke the materializer a second time here. **Also mark the plan `status: DONE`** — add or update that field in the frontmatter of `$PLAN_PATH` (`T##-PLAN.md`), the *same* edit `agents/forge-executor.md` step 13 performs on the Claude path. The sidecar cannot (barred from `.gsd/**`), so the orchestrator does it on its behalf, alongside the SUMMARY write; canonical rationale + measured consequence in `shared/forge-dispatch.md § Sidecar dispatch state machine` (a statusless finished plan reads as unfinished to `forge-doctor` C3a/C9 and to Crash detection, and is re-dispatchable). Then **emit the dispatch event with `engine:"codex"`** and rejoin **Step 5. Process result** exactly as a Claude worker would — downstream verification runs byte-identical:
  **Compatibility de leitura:** use the state helper in read mode; it owns canonical and legacy fallback order.
  ```bash
  XLLM_STATE=$(node "$FORGE_SCRIPTS_DIR/forge-xllm-state.js" --mode read --dir "$WORKING_DIR/.gsd/forge" --milestone "{M###}" --slice "{S##}" --task "{T##}" --attempt "$N")
  START_SHA=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).start_sha" 2>/dev/null)
  CODE_DIR=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).code_dir" 2>/dev/null)
  RESULT_FILE=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).result_file" 2>/dev/null)
  mkdir -p "$WORKING_DIR/.gsd/forge/"
  # shared/forge-dispatch.md § DISPATCH_VCS prelude (canonical — VCS-agnostic)
  DISPATCH_VCS=$(node "$FORGE_SCRIPTS_DIR/forge-vcs.js" --detect --field vcs --cwd "${CODE_DIR:-$WORKING_DIR}" 2>/dev/null || echo "unknown")
  # shared/forge-dispatch.md § transport prelude — read in THIS fence, from $RESULT_FILE.
  # The ONLY shell default permitted is the named degraded value `unknown`; never
  # `:-app-server`, which would claim an observation nobody made.
  TRANSPORT=$(node "$FORGE_SCRIPTS_DIR/forge-transport.js" --result "$RESULT_FILE" --field transport 2>/dev/null || echo "unknown")
  TRANSPORT_VERSION=$(node "$FORGE_SCRIPTS_DIR/forge-transport.js" --result "$RESULT_FILE" --field transport_version 2>/dev/null)
  TRANSPORT_REASON=$(node "$FORGE_SCRIPTS_DIR/forge-transport.js" --result "$RESULT_FILE" --field transport_reason 2>/dev/null)
  TRANSPORT_TAIL="\"transport\":\"${TRANSPORT:-unknown}\""
  [ -n "$TRANSPORT_VERSION" ] && TRANSPORT_TAIL="$TRANSPORT_TAIL,\"transport_version\":\"$TRANSPORT_VERSION\""
  [ -n "$TRANSPORT_REASON" ] && TRANSPORT_TAIL="$TRANSPORT_TAIL,\"transport_reason\":\"$TRANSPORT_REASON\""
  echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"dispatch\",\"unit\":\"execute-task/${T##}\",\"model\":\"${CODEX_MODEL:-codex-default}\",\"host_runtime\":\"${HOST_RUNTIME}\",\"worker_mode\":\"${WORKER_MODE}\",\"dispatch_allowed\":${DISPATCH_ALLOWED},\"reason\":\"${ENGINE_REASON}\",\"engine\":\"codex\",\"domain\":\"${DOMAIN_USED}\",\"route_source\":\"${ROUTE_SOURCE}\",\"chain_len\":${CHAIN_LEN},\"slice\":\"{S##}\",\"milestone\":\"${RUN_ID:-{M###}}\",\"input_tokens\":0,\"output_tokens\":0,\"vcs\":\"${DISPATCH_VCS:-unknown}\",${TRANSPORT_TAIL}}" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
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
  IS_MULTI_STATE=$(node -e "const s=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(Array.isArray(s.repos)&&s.repos.length>1?'true':'false')" "$XLLM_STATE" 2>/dev/null || echo false)
  # RC=0 → reset verified (only codex-authored changes undone, pre-dirty snapshot intact) → advance.
  # RC=3 → OVERLAP: a pre-dirty path's hash diverged (the sidecar ALSO wrote it) — the helper reset
  #        NOTHING (leftovers stay on disk, visible for the human — never silently discarded).
  # RC=2 → the reset ran but post-verification still found a leftover that isn't an intact pre-dirty path.
  if [ "$IS_MULTI_STATE" = "true" ] && [ "$RC" != "0" ]; then
    REASON="multi-repo-reset-unverified"
  elif [ "$RC" = "3" ]; then
    REASON="surgical-reset-overlap"   # emit event with the overlap path list from $RESET_JSON; abort chain
  elif [ "$RC" != "0" ]; then
    REASON="verified-reset-failed"    # abort the chain to the Claude fallback — never inherit a dirty tree
  fi
fi
if [ "$REASON" = "multi-repo-reset-unverified" ]; then
  node "$FORGE_SCRIPTS_DIR/forge-runs.js" --update "$RUN_ID" --json '{"active":false}' > /dev/null 2>&1 || true
  echo "✗ fallback bloqueado: reset multi-repo não foi integralmente verificado; inspeção humana obrigatória" >&2
  exit 1
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
  # Chain advanced (mutually exclusive with the generic fallback — R1). Re-resolve the selected
  # member's runtime identity/posture; branch only on the resulting WORKER_MODE.
  NEXT_MODEL_ID="$MODEL_ID"
  NEXT_ROUTE_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-dispatch-resolve.js" --unit-type "$unit_type" \
    --host-runtime "$HOST_RUNTIME" --worker-engine "$NEXT_ENGINE" --cwd "$WORKING_DIR" --json)
  [ $? -eq 0 ] || { echo "✗ next-member resolver halted" >&2; exit 1; }
  NEXT_EXPORTS=$(printf '%s' "$NEXT_ROUTE_JSON" | node "$FORGE_SCRIPTS_DIR/forge-dispatch-resolve.js" --shell-exports)
  [ $? -eq 0 ] || { echo "✗ next-member resolver exports invalid" >&2; exit 1; }
  eval "$NEXT_EXPORTS"
  MODEL_ID="$NEXT_MODEL_ID"; ENGINE="$NEXT_ENGINE"; DISPATCH_ENGINE="$NEXT_ENGINE"
  if [ "$DISPATCH_ALLOWED" != "true" ]; then
    printf '✗ %s\n%s\n' "$DISPATCH_REASON_CODE" "$DISPATCH_HINT" >&2
    exit 1                         # refusal: no fallback event and no alternate worker
  fi
  # WORKER_MODE=sidecar → Branch C step 0; WORKER_MODE=native → host-native flow.
else
  # Chain exhausted (NEXT_ID empty) OR an abort reason (surgical-reset-overlap / sidecar-cap-exceeded /
  # verified-reset-failed) forbids advancement → resolve the named Claude fallback exactly ONCE.
  FALLBACK_TRIGGER="$REASON"
  FALLBACK_ROUTE_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-dispatch-resolve.js" --unit-type "$unit_type" \
    --host-runtime "$HOST_RUNTIME" --worker-engine claude --cwd "$WORKING_DIR" --json)
  [ $? -eq 0 ] || { echo "✗ fallback resolver halted" >&2; exit 1; }
  FALLBACK_EXPORTS=$(printf '%s' "$FALLBACK_ROUTE_JSON" | node "$FORGE_SCRIPTS_DIR/forge-dispatch-resolve.js" --shell-exports)
  [ $? -eq 0 ] || { echo "✗ fallback resolver exports invalid" >&2; exit 1; }
  eval "$FALLBACK_EXPORTS"
  REASON="$FALLBACK_TRIGGER"
  if [ "$DISPATCH_ALLOWED" != "true" ]; then
    printf '✗ %s\n%s\n' "$DISPATCH_REASON_CODE" "$DISPATCH_HINT" >&2
    exit 1                         # refusal is not worker-engine-fallback
  fi
  echo "⚠ worker: codex indisponível ($REASON) — usando forge-executor"
  mkdir -p "$WORKING_DIR/.gsd/forge/"
  HINT_JSON=$(cat "${CODE_DIR_HINT_FILE:-$WORKING_DIR/.gsd/forge/code-dir-hint.json}" 2>/dev/null); [ -n "$HINT_JSON" ] || HINT_JSON='""'
  printf '{"ts":"%s","event":"worker-engine-fallback","milestone":"%s","slice":"%s","unit":"execute-task/%s","reason":"%s","hint":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${RUN_ID:-${M###}}" "${S##}" "${T##}" "$REASON" "$HINT_JSON" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
  # CRITICAL, per-dispatch + evidence-based fallback discipline: shared/forge-dispatch.md § Engine Fallback Discipline
fi
```
On chain advance, re-enter the canonical resolver/guard for the selected member. `WORKER_MODE == sidecar` re-enters **Branch C step 0** with the incremented `SIDECAR_ATTEMPT`; `WORKER_MODE == native` runs the host-native single-task flow. The native Claude path emits its own `dispatch` event with `engine:"claude"` and the resolved runtime axes. The generic Claude fallback (with its `worker-engine-fallback` event) fires **only** when the chain is exhausted or an abort reason forbids advancement — mutually exclusive with chain-advance (R1). Not a 4th recovery layer — the chain walk IS Failure Taxonomy Layer 2 (same layer, new resolver — MEM001), and the fallback fires once, in-band, at dispatch time.

---

**Branch D — sidecar codex plan (`WORKER_MODE == sidecar && RESOLVED_WORKER_ENGINE == codex && unit_type == plan-slice`):**

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
    --host-runtime "$HOST_RUNTIME" --sidecar-declared \
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
  DISPATCH_VCS=$(node "$FORGE_SCRIPTS_DIR/forge-vcs.js" --detect --field vcs --cwd "${CODE_DIR:-$WORKING_DIR}" 2>/dev/null || echo "unknown")
  # shared/forge-dispatch.md § transport prelude — only `unknown` may be a shell default.
  TRANSPORT=$(node "$FORGE_SCRIPTS_DIR/forge-transport.js" --result "$RESULT_FILE" --field transport 2>/dev/null || echo "unknown")
  TRANSPORT_VERSION=$(node "$FORGE_SCRIPTS_DIR/forge-transport.js" --result "$RESULT_FILE" --field transport_version 2>/dev/null)
  TRANSPORT_REASON=$(node "$FORGE_SCRIPTS_DIR/forge-transport.js" --result "$RESULT_FILE" --field transport_reason 2>/dev/null)
  TRANSPORT_TAIL="\"transport\":\"${TRANSPORT:-unknown}\""
  [ -n "$TRANSPORT_VERSION" ] && TRANSPORT_TAIL="$TRANSPORT_TAIL,\"transport_version\":\"$TRANSPORT_VERSION\""
  [ -n "$TRANSPORT_REASON" ] && TRANSPORT_TAIL="$TRANSPORT_TAIL,\"transport_reason\":\"$TRANSPORT_REASON\""
  echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"dispatch\",\"unit\":\"plan-slice/${S##}\",\"model\":\"${CODEX_MODEL:-codex-default}\",\"host_runtime\":\"${HOST_RUNTIME}\",\"worker_mode\":\"${WORKER_MODE}\",\"dispatch_allowed\":${DISPATCH_ALLOWED},\"reason\":\"${ENGINE_REASON}\",\"engine\":\"codex\",\"domain\":\"${DOMAIN_USED}\",\"route_source\":\"${ROUTE_SOURCE}\",\"chain_len\":${CHAIN_LEN},\"slice\":\"{S##}\",\"milestone\":\"${RUN_ID:-{M###}}\",\"input_tokens\":0,\"output_tokens\":0,\"vcs\":\"${DISPATCH_VCS:-unknown}\",${TRANSPORT_TAIL}}" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
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
  # Chain advanced (mutually exclusive with the generic fallback — R1). Re-resolve the selected
  # member's runtime identity/posture; branch only on the resulting WORKER_MODE.
  NEXT_MODEL_ID="$MODEL_ID"
  NEXT_ROUTE_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-dispatch-resolve.js" --unit-type "$unit_type" \
    --host-runtime "$HOST_RUNTIME" --worker-engine "$NEXT_ENGINE" --cwd "$WORKING_DIR" --json)
  [ $? -eq 0 ] || { echo "✗ next-member resolver halted" >&2; exit 1; }
  NEXT_EXPORTS=$(printf '%s' "$NEXT_ROUTE_JSON" | node "$FORGE_SCRIPTS_DIR/forge-dispatch-resolve.js" --shell-exports)
  [ $? -eq 0 ] || { echo "✗ next-member resolver exports invalid" >&2; exit 1; }
  eval "$NEXT_EXPORTS"
  MODEL_ID="$NEXT_MODEL_ID"; ENGINE="$NEXT_ENGINE"; DISPATCH_ENGINE="$NEXT_ENGINE"
  if [ "$DISPATCH_ALLOWED" != "true" ]; then
    printf '✗ %s\n%s\n' "$DISPATCH_REASON_CODE" "$DISPATCH_HINT" >&2
    exit 1                         # refusal: no fallback event and no alternate worker
  fi
  # WORKER_MODE=sidecar → Branch D step 0; WORKER_MODE=native → host-native flow.
else
  # Chain exhausted (NEXT_ID empty) OR the cap forbids advancement → resolve the named Claude fallback ONCE.
  FALLBACK_TRIGGER="$REASON"
  FALLBACK_ROUTE_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-dispatch-resolve.js" --unit-type "$unit_type" \
    --host-runtime "$HOST_RUNTIME" --worker-engine claude --cwd "$WORKING_DIR" --json)
  [ $? -eq 0 ] || { echo "✗ fallback resolver halted" >&2; exit 1; }
  FALLBACK_EXPORTS=$(printf '%s' "$FALLBACK_ROUTE_JSON" | node "$FORGE_SCRIPTS_DIR/forge-dispatch-resolve.js" --shell-exports)
  [ $? -eq 0 ] || { echo "✗ fallback resolver exports invalid" >&2; exit 1; }
  eval "$FALLBACK_EXPORTS"
  REASON="$FALLBACK_TRIGGER"
  if [ "$DISPATCH_ALLOWED" != "true" ]; then
    printf '✗ %s\n%s\n' "$DISPATCH_REASON_CODE" "$DISPATCH_HINT" >&2
    exit 1                         # refusal is not worker-engine-fallback
  fi
  echo "⚠ worker: codex indisponível ($REASON) — usando forge-planner"
  mkdir -p "$WORKING_DIR/.gsd/forge/"
  HINT_JSON=$(cat "${CODE_DIR_HINT_FILE:-$WORKING_DIR/.gsd/forge/code-dir-hint.json}" 2>/dev/null); [ -n "$HINT_JSON" ] || HINT_JSON='""'
  printf '{"ts":"%s","event":"worker-engine-fallback","milestone":"%s","slice":"%s","unit":"plan-slice/%s","reason":"%s","hint":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${RUN_ID:-${M###}}" "${S##}" "${S##}" "$REASON" "$HINT_JSON" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
  # CRITICAL, per-dispatch + evidence-based fallback discipline: shared/forge-dispatch.md § Engine Fallback Discipline
fi
```
On chain advance, re-enter the canonical resolver/guard for the selected member. `WORKER_MODE == sidecar` re-enters **Branch D step 0** with the incremented `SIDECAR_ATTEMPT`; `WORKER_MODE == native` runs the host-native planning flow, including Tier/Effort Resolution. That native path emits its own `dispatch` event with `engine:"claude"` and the resolved runtime axes. The generic Claude fallback (with its `worker-engine-fallback` event) fires **only** when the chain is exhausted or the cap forbids advancement — mutually exclusive with chain-advance (R1). Not a 4th recovery layer — it fires once, in-band, at dispatch time.
