# Sidecar dispatch — executable Branch codex / Branch D (forge-next)

> **Loaded on demand.** Extracted VERBATIM from `skills/forge-next/SKILL.md` on 2026-08-23
> (context diagnosis) — same rationale as `shared/forge-sidecar-auto.md`: a 0%-use path priced
> into every orchestrator turn. Read ONLY after the resolver gate, when
> `WORKER_MODE == sidecar`, or after the one allowed native result
> `not-spawned` changes that same resolved worker to an explicitly declared
> sidecar. Canonical contract: `shared/forge-dispatch.md § Worker Engine Routing`.
> forge-next is the interactive boundary — this variant keeps the TTY pause-ask gates.

**Branch codex — sidecar (`$WORKER_MODE == sidecar` && `$RESOLVED_WORKER_ENGINE == codex` && `$unit_type == execute-task`)** — executable mirror of `shared/forge-dispatch.md § Worker Engine Routing § Sidecar dispatch state machine`. When this branch fires, the native machinery below (timeline task, token telemetry, guarded worker dispatch) is **replaced** by the detached adapter + polling; on any failure it resets and follows the named `worker-engine-fallback` path. `CODE_DIR` resolves to `${WORKER_CWD:-$WORKING_DIR}` (isolation header).

Entry is fail-closed: `DISPATCH_ALLOWED` is already `true` before this file is
loaded. A false verdict prints `DISPATCH_REASON_CODE` + `DISPATCH_HINT` and
stops in the caller; it never reaches this mirror or a fallback. When entry
follows native `not-spawned`, the caller increments its one-shot transition
counter, verifies `RESOLVED_WORKER_ENGINE == HOST_RUNTIME`, then sets
`WORKER_MODE=sidecar`, `SIDECAR_DECLARED=true`, and retains
`DISPATCH_ALLOWED=true`. No other native outcome may enter.

0. **Increment the sidecar attempt counter (`SIDECAR_ATTEMPT`) — BLOCKER cap.** Before dispatching *any* sidecar for this unit, increment a per-unit counter (starts at 1 for the first sidecar dispatch of the unit). It is **hard-capped** by the number of `engine == codex` members in the resolved chain (`$ROUTE_JSON.chain`, ≤3 — the S01 cap). Exceeding the cap → abort the chain to the Claude fallback with `REASON=sidecar-cap-exceeded`. On a cross-engine chain (e.g. `gpt→claude→gpt`) this branch may fire more than once in the same unit; the counter is persisted in the per-attempt state file (below) so it survives an auto-compact:
```bash
CODEX_MEMBERS=$(node -e "process.stdout.write(String((JSON.parse(process.argv[1]).chain||[]).filter(m=>m.engine==='gpt'||m.engine==='codex').length))" "$ROUTE_JSON")
SIDECAR_ATTEMPT=$(( ${SIDECAR_ATTEMPT:-0} + 1 ))
# Gate: the sidecar assumes ONE CODE_DIR that is a git repo (shared/forge-dispatch.md § Branch codex 0.5).
# Executable, never a bare comment. Extends the cap-skip path — refuses BEFORE any --cwd reaches a helper.
if [ -n "$CODE_DIR_REASON" ]; then
  REASON="$CODE_DIR_REASON"        # sidecar-multirepo-unsupported | sidecar-code-dir-undeclared
elif [ "$SIDECAR_ATTEMPT" -gt "${CODEX_MEMBERS:-1}" ]; then
  REASON="sidecar-cap-exceeded"   # → Claude fallback (never a 4th recovery layer)
fi
```
When `REASON` is `sidecar-cap-exceeded` or one of the two `CODE_DIR` refusals set by the gate above, **skip steps 1–4 entirely** (no `START_SHA` capture, no state/result-file allocation, no sidecar launch) and go DIRECTLY to the **Fallback** block below (R3). Steps 1–3 below run **only** in the `else` — they are guarded by the same `if [ "$REASON" != "sidecar-cap-exceeded" ] && [ -z "$CODE_DIR_REASON" ]` condition.

1. **Capture `START_SHA` + the pre-dirty snapshot in ONE atomic write, via the surgical-reset helper.** `--state-init` records `{attempt, start_sha, pre_dirty:[{path,hash}], reason, result_file, code_dir}` in the SAME write (`.gsd/**` excluded), so the snapshot survives the poll loop / an auto-compact (BLOCKER invariant #2 — a snapshot in a shell var is lost the moment the process crosses a Bash-tool boundary). Branch C spans multiple Bash tool invocations, so shell vars do NOT survive — the state file (under `WORKING_DIR/.gsd`, never `CODE_DIR`) is the durable carrier. **The name carries the attempt number `N = SIDECAR_ATTEMPT` (`-attempt-$N`) and NEVER overwrites a prior attempt's file** (audit preserved, post-compact recovery unambiguous — BLOCKER invariant #1). The success AND fallback blocks re-read the state of the **CURRENT** attempt from disk. The whole step is gated on the cap (R3 — the real `if/else` whose cap branch went straight to Fallback above):
```bash
if [ "$REASON" != "sidecar-cap-exceeded" ] && [ -z "$CODE_DIR_REASON" ]; then
  CODE_DIR="${WORKER_CWD:-$WORKING_DIR}"
  N="$SIDECAR_ATTEMPT"                                              # 1, 2, 3 — one per codex member dispatched
  XLLM_STATE=$(node "$FORGE_SCRIPTS_DIR/forge-xllm-state.js" --mode write --dir "$WORKING_DIR/.gsd/forge" --milestone "{M###}" --slice "{S##}" --task "{T##}" --attempt "$N")
  mkdir -p "$WORKING_DIR/.gsd/forge/"
  START_SHA=$(node "$FORGE_SCRIPTS_DIR/forge-surgical-reset.js" --state-init \
    --state "$XLLM_STATE" --cwd "$CODE_DIR" --attempt "$N" --repo-roots-file "$CODE_DIR_ROOTS_FILE")
  # Guard: if --state-init fails (non-zero exit / empty $START_SHA) → REASON="sidecar-state-init-failed"
  # → Fallback directly, with NO reset (nothing was captured, no valid state file to reset from).
  [ -n "$START_SHA" ] || REASON="sidecar-state-init-failed"
fi
```

With `REASON` now set by the guard above, control goes DIRECTLY to the **Fallback** block below (`worker-engine-fallback`) — no dispatch is attempted and no reset runs, since no valid state was ever captured.

2. **No pre-dispatch clean-tree guard — the pre-dirty snapshot IS the guard** (SUPERSEDED, DECISION 39, see S01-CONTEXT.md). A dirty working tree is a **safe precondition**, not a refusal reason: the fallback reset only ever touches paths that changed relative to the snapshot; pre-existing dirty content is provably untouched (re-hash) or the reset aborts entirely (overlap) rather than guessing. `dirty-tree-guard` is no longer a trigger and the sidecar dispatches over a pre-existing dirty tree.

3. **Allocate the result-file OUTSIDE `CODE_DIR`** (S01 contract — codex could overwrite a file inside the workspace) + dispatch detached via `run_in_background: true` (the Bash tool's 600s foreground ceiling does not apply). `--model` is appended only when `$SIDECAR_MODEL` is non-empty; the resolver selects the chain's Codex member, then falls back to `workers.codex_model`. Patch the result-file into the durable state of the CURRENT attempt N via `--state-update` — a READ-MODIFY-WRITE that preserves `start_sha` + `pre_dirty` untouched. **NEVER a plain printf**: a hand-written printf omits `pre_dirty`, clobbering the snapshot and degrading the reset back to whole-tree destruction the moment the Fallback runs:
```bash
RESULT_FILE=$(mktemp -t forge-xllm-result.XXXXXX.json)   # tmpdir, never under $CODE_DIR
node "$FORGE_SCRIPTS_DIR/forge-surgical-reset.js" --state-update \
  --state "$XLLM_STATE" --result-file "$RESULT_FILE"
# Canonical context-parity semantics: shared/forge-dispatch.md § Branch C; Security is a must-have, the bundle informational, and missing files are tolerated.
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
# ↑ dispatched with the Bash tool's run_in_background: true
```

4. **Poll `$RESULT_FILE`** (state `polling`) every ~5–10s: `status==running` → keep polling + liveness check; `status==done` → success (step 5); `status==error` / adapter exit `!= 0` / unparseable JSON → failure with the matching `REASON` (`codex-exit-nonzero` / `codex-timeout` / `codex-invalid-json`) → Fallback. **Orphan:** heartbeat `updated_at` stale beyond the dynamic threshold `max(heartbeat_interval_ms × 4, 30s)` (field absent → assume 15s → 60s) → run the canonical liveness snippet (`shared/forge-dispatch.md § Orphan detection`): `stale-dead` → `kill "$pid"` (from the heartbeat) + `REASON=codex-orphan` → Fallback; `stale-alive` → grace of one more poll cycle, then kill if still stale.
4.25. **Context boundary:** run `CONTEXT_BOUNDARY=$(node "$FORGE_SCRIPTS_DIR/forge-context-boundary.js" --result "$RESULT_FILE" --cwd "$WORKING_DIR" --plan "$PLAN_PATH" --run "${RUN_ID:-{M###}}" --milestone "{M###}" --slice "{S##}" --task "{T##}" --unit "execute-task/{T##}" --step "post-sidecar-poll")` after the terminal poll. Display `.indicator`; the helper durably queues `.additional_context` under the exact run/milestone/slice/unit scope and preserves or creates the canonical slice Continue-Here checkpoint without pausing automatically. Unknown health is always inert.

4.5. **Terminal outcome — runtime evidence materialization (step 7b), on EVERY outcome:** as soon as the poll loop settles a terminal outcome for this dispatch — `done`, **or** a failure `REASON` that Layer-1 transient retry will not retry in place (including `codex-invalid-json` and an unreadable `$RESULT_FILE`) — invoke exactly once `node "$FORGE_SCRIPTS_DIR/forge-evidence-materialize.js" --result "$RESULT_FILE" --unit "execute-task/{T##}" --milestone "{M###}" --slice "{S##}" --cwd "$WORKING_DIR" --json`. **All three axes, never `--unit` alone** (S01 review R2): the file name is the composite key, so an invocation missing the two axes lands under the `_no-milestone_`/`_no-slice_` sentinels, which parse back to `null` and can never match the real `{M###, S##, T##}` at resolution time — written and never found. Step **7b** of `shared/forge-dispatch.md § Sidecar dispatch state machine` owns its outcome enum, naming and census; this mirror only invokes and never restates them (exit 0 always, advisory). It sits **before** the Success/Failure split on purpose (S06 review R9): invoked only from Success, the canonical table's unreadable-result-file row was unreachable from every call site. **One census per terminal outcome, never one per retry** — a Layer-1 in-place retry has not reached a terminal outcome yet and does not invoke it.

5.0. **Orchestrator re-verification (TASK-015):** `REVERIFY=$(node "$FORGE_SCRIPTS_DIR/forge-reverify.js" --result "$RESULT_FILE" --code-dir "$CODE_DIR" --gsd-dir "$WORKING_DIR/.gsd" --apply --json)`. Follow `shared/forge-dispatch.md § Sidecar dispatch state machine` for the formula. `verified` continues with the amended result, `failed` follows Failure, and `no-command` leaves it untouched. Emit `orchestrator_reverification` with `unit:"execute-task/{T##}"`, command, exit code, verdict, entries and ISO timestamp; except for `not-applicable`, add `## Re-verification` to the summary.
5. **Partial promotion boundary:** for valid `status == "partial"`, run `PROMOTION=$(node "$FORGE_SCRIPTS_DIR/forge-env-promote.js" --result "$RESULT_FILE" --plan "$PLAN_PATH" --json)` before Success/Failure. `shared/forge-dispatch.md § Sidecar dispatch state machine` is the named canonical spec for its algorithm and allowlist; do not redefine either in this mirror. `PROMOTION.promote == true` is `done`: add `## Env Constraints` to `T##-SUMMARY.md` (item + reason + note per entry), synthesize `env_constraints[]` into the result block, leave promoted entries out of `must_haves_status.dropped`, and append `sidecar_env_promotion` (`unit:"execute-task/{T##}"`, count, reasons, ISO ts) to events.jsonl. Otherwise, including a legacy no-`scope` payload, follow Failure unchanged.
5.1. **`status == "done"` with unmet env-scope entries (M016 S01 review R1):** run the same `forge-env-promote.js` invocation whenever `status == "done"` but `must_haves_status` still has unmet entries — never accept the `done` label at face value. `verdict == "done-with-verified-env"` → accept, write `## Env Constraints` as above. `verdict == "done-with-unverified-env"` → treat the result as `partial` and follow Failure unchanged; the worker's `done` label is discarded.

5.2. **Corroboration fallback — reachable from BOTH invocations above** (S06 review R8: this used to hang off the `status == "partial"` bullet alone, so the `status == "done"` path ran the same checker and never consumed `fallbacks`): after **either** invocation — the `status == "partial"` boundary or the `status == "done"` with unmet env-scope entries — if `PROMOTION.fallbacks` is non-empty, append one `sidecar_env_corroboration_fallback` line per entry (`unit:"execute-task/{T##}"`) as defined in `shared/forge-dispatch.md § Sidecar dispatch state machine`, regardless of the promotion outcome.

6. **Success — orchestrator assembles the artifacts (`done` state).** Codex NEVER writes `.gsd/**` and NEVER commits (locked — `git log` unchanged, no `.gsd/**` path in `node "$FORGE_SCRIPTS_DIR/forge-vcs.js" --changes --cwd "$CODE_DIR" --since "$START_SHA"`). This delta is synthesized advisory evidence only (step **7a**); `files_changed` remains authoritative from the result JSON. Executable mirror of `shared/forge-dispatch.md § Post-run change set + baseline (canonical — VCS-agnostic)`. The runtime-observed lines of the same artifact were already materialized by step **4.5** above — do **not** invoke the materializer a second time here. Read the JSON and re-read durable state through the helper in `--mode read`; its milestone-qualified canonical path and ordered legacy compatibility are authoritative. State writing is canonical-only via `--state-init`. Besides writing `T##-SUMMARY.md`, **mark the plan `status: DONE`** — add or update that field in the frontmatter of `$PLAN_PATH` (`T##-PLAN.md`), the *same* edit `agents/forge-executor.md` step 13 performs on the Claude path. The sidecar cannot (barred from `.gsd/**`), so the orchestrator does it on its behalf; canonical rationale + measured consequence in `shared/forge-dispatch.md § Sidecar dispatch state machine` (a statusless finished plan reads as unfinished to `forge-doctor` C3a/C9 and to Crash detection, and is re-dispatchable).
```bash
XLLM_STATE=$(node "$FORGE_SCRIPTS_DIR/forge-xllm-state.js" --mode read --dir "$WORKING_DIR/.gsd/forge" --milestone "{M###}" --slice "{S##}" --task "{T##}" --attempt "$N")
START_SHA=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).start_sha" 2>/dev/null)
CODE_DIR=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).code_dir" 2>/dev/null)
RESULT_FILE=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).result_file" 2>/dev/null)
mkdir -p "$WORKING_DIR/.gsd/forge/"
CODEX_MODEL_LABEL="${CODEX_MODEL:-codex-default}"
# shared/forge-dispatch.md § DISPATCH_VCS prelude (canonical — VCS-agnostic)
DISPATCH_VCS=$(node "$FORGE_SCRIPTS_DIR/forge-vcs.js" --detect --field vcs --cwd "${CODE_DIR:-$WORKING_DIR}" 2>/dev/null || echo "unknown")
# shared/forge-dispatch.md § transport prelude — read in THIS fence, from $RESULT_FILE.
# The ONLY shell default permitted is the named degraded value `unknown`.
TRANSPORT=$(node "$FORGE_SCRIPTS_DIR/forge-transport.js" --result "$RESULT_FILE" --field transport 2>/dev/null || echo "unknown")
TRANSPORT_VERSION=$(node "$FORGE_SCRIPTS_DIR/forge-transport.js" --result "$RESULT_FILE" --field transport_version 2>/dev/null)
TRANSPORT_REASON=$(node "$FORGE_SCRIPTS_DIR/forge-transport.js" --result "$RESULT_FILE" --field transport_reason 2>/dev/null)
TRANSPORT_TAIL="\"transport\":\"${TRANSPORT:-unknown}\""
[ -n "$TRANSPORT_VERSION" ] && TRANSPORT_TAIL="$TRANSPORT_TAIL,\"transport_version\":\"$TRANSPORT_VERSION\""
[ -n "$TRANSPORT_REASON" ] && TRANSPORT_TAIL="$TRANSPORT_TAIL,\"transport_reason\":\"$TRANSPORT_REASON\""
echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"dispatch\",\"unit\":\"${unitType}/${unitId}\",\"model\":\"${CODEX_MODEL_LABEL}\",\"host_runtime\":\"${HOST_RUNTIME}\",\"worker_mode\":\"${WORKER_MODE}\",\"dispatch_allowed\":${DISPATCH_ALLOWED},\"reason\":\"${ENGINE_REASON}\",\"slice\":\"{S##}\",\"milestone\":\"${RUN_ID:-{M###}}\",\"input_tokens\":0,\"output_tokens\":0,\"engine\":\"codex\",\"domain\":\"${DOMAIN_USED}\",\"route_source\":\"${ROUTE_SOURCE}\",\"chain_len\":${CHAIN_LEN},\"vcs\":\"${DISPATCH_VCS:-unknown}\",${TRANSPORT_TAIL}}" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
# → proceed to Step 5 (Process result). Do NOT run the Claude machinery below.
```

**Failure (any `reason`):** first evaluate **Layer-1 transient retry** (sidecar parity with the Claude Retry Handler — `shared/forge-dispatch.md § Layer-1 transient retry`); only on a terminal class / exhaustion / unverified reset does control fall through to the **Layer-2** verified-reset + chain walk / `worker-engine-fallback` below:
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
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${M###}" "${S##}" "${T##}" "$SIDECAR_ATTEMPT" "$TRC" "$DELAY_MS" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
  fi
fi
```
**pause-ask gate (policy == `pause-ask`) — forge-next: TTY asks live, headless degrades.** Fires at exactly ONE transition — transient-retry **exhaustion**: `POLICY == pause-ask` AND Layer-1 did **not** re-fire this pass (`$TRANSIENT_RETRY` empty) AND class is `transient` AND the counter is at the cap (`TRC == MAX_TRC`). Terminal classes, `sidecar-cap-exceeded`, `surgical-reset-overlap` (`RC=3`) and `verified-reset-failed` (`RC=2`) all leave `TRC < MAX_TRC` or `ERROR_CLASS != transient`, so they bypass this gate and reach Layer-2 unchanged. With a TTY (`[ -t 1 ]`) set `PAUSE_ASK_GATE=1` to ask the operator live; headless (`claude -p`) degrade to `fallback` + emit `sidecar-pause-degraded`:
```bash
PAUSE_ASK_GATE=""
if [ "$POLICY" = "pause-ask" ] && [ -z "$TRANSIENT_RETRY" ] && [ "$ERROR_CLASS" = "transient" ] && [ "$TRC" -eq "$MAX_TRC" ]; then
  if [ -t 1 ]; then
    PAUSE_ASK_GATE=1   # interactive — ask live via AskUserQuestion below
  else
    mkdir -p "$WORKING_DIR/.gsd/forge/"
    printf '{"ts":"%s","event":"sidecar-pause-degraded","milestone":"%s","slice":"%s","unit":"execute-task/%s","reason":"pause-ask-headless-degrade","transient_retry_count":%s}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${RUN_ID:-${M###}}" "${S##}" "${T##}" "$TRC" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
  fi
fi
```
**If `$TRANSIENT_RETRY` is set** (Layer-1 fired, reset verified `RC=0`): re-enter the **Dispatch (detached) + Poll** steps for the CURRENT attempt `N` — reusing the same `-attempt-$N` state, `$START_SHA`/`pre_dirty` and the fresh `$RESULT_FILE`, WITHOUT re-running Branch C step 0 (so `SIDECAR_ATTEMPT` is NOT incremented and no new attempt file is allocated — `transient_retry_count` ⊥ `SIDECAR_ATTEMPT`). Do NOT run the Layer-2 block below. **Otherwise** — a `terminal` class, exhaustion (`transient_retry_count == max_transient_retries`), or an unverified reset (`RC≠0`, whose abort→fallback accounting Layer-2 owns) — control falls through to the **Layer-2** `worker-engine-fallback` chain walk below **unchanged**.

**If `$PAUSE_ASK_GATE` is set** (TTY present, pause-ask exhaustion): call `AskUserQuestion` with three options — **Retentar codex** (re-enter Layer-1 for one more transient retry against the SAME member: run the Branch C reset→backoff→`--state-update`→re-dispatch sequence with `transient_retry_count` continuing), **Fallback Claude** (take the Layer-2 `worker-engine-fallback` action now), **Pausar milestone** (checkpoint via `continue.md` + `status: paused` and stop the loop — the SAME mechanic as review `ask_in_auto: pause` / account-handoff; do not invent a new pause path). The operator's answer drives control. **Otherwise** (headless degrade, or the gate was not triggered) control falls through unchanged.

**Fallback — `worker-engine-fallback`** (any codex failure trigger — clone of `review-challenger-fallback`, `shared/forge-dispatch.md § Fallback`). One event type, triggers by `REASON` (`codex-exit-nonzero`, `codex-timeout`, `codex-invalid-json`, `codex-orphan`, `surgical-reset-overlap`, `verified-reset-failed`, `sidecar-cap-exceeded`, `sidecar-state-init-failed`, `sidecar-multirepo-unsupported`, `sidecar-code-dir-undeclared`); no retry of the codex work; **not a 4th recovery layer**:
```bash
# Re-read is delegated to the helper — $XLLM_STATE is the -attempt-$N.json of the CURRENT attempt
# (BLOCKER invariant #1) and carries start_sha + pre_dirty (this block may be a later Bash invocation
# — shell vars are gone). BLOCKER invariant #2 — surgical reset via the helper (scoped to CODE_DIR,
# .gsd/** excluded), EXCEPT sidecar-cap-exceeded (no attempt captured a snapshot → nothing to undo).
# The pre-dirty snapshot from step 1 makes it safe to reset even over a pre-existing dirty tree: only
# the codex-authored change set is undone; pre-existing dirty content is re-hashed intact (RC=0) or the
# reset aborts (RC=3 overlap / RC=2 verify-failed). .gsd/** is excluded by the helper's own predicate,
# so it never reverts the orchestrator's own .gsd writes (events.jsonl / evidence) made during the poll.
if [ "$REASON" != "sidecar-cap-exceeded" ] && [ -z "$CODE_DIR_REASON" ]; then
  RESET_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-surgical-reset.js" --reset --state "$XLLM_STATE"); RC=$?
  IS_MULTI_STATE=$(node -e "const s=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(Array.isArray(s.repos)&&s.repos.length>1?'true':'false')" "$XLLM_STATE" 2>/dev/null || echo false)
  # RC=0 → reset verified (only codex-authored changes undone, pre-dirty snapshot intact) → advance.
  # RC=3 → OVERLAP: a pre-dirty path's hash diverged (the sidecar ALSO wrote it) — the helper reset
  #        NOTHING (leftovers stay on disk, visible for the human — never silently discarded).
  # RC=2 → reset ran but post-verification still found a leftover that isn't an intact pre-dirty path.
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

# Cross-engine chain walk (Layer 2) — after the verified reset, resolve the next chain member and,
# if one exists, PERSIST it in the consume-once tier-cursor (same pattern the model_refusal row uses;
# Step 4b consumes it). This is what makes the CODEX_MEMBERS cap non-dead code (R2). forge-next is
# step mode: it executes ONE unit, so the advance is NOT dispatched now — the NEXT /forge-next
# invocation consumes the cursor and dispatches $NEXT (Branch codex if gpt, else the Claude Agent).
# Abort reasons (surgical-reset-overlap / sidecar-cap-exceeded / verified-reset-failed) forbid
# advancement → no cursor, take the generic Claude fallback below.
NEXT=""
if [ "$REASON" != "surgical-reset-overlap" ] && [ "$REASON" != "sidecar-cap-exceeded" ] && [ "$REASON" != "verified-reset-failed" ] && [ -z "$CODE_DIR_REASON" ]; then
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
    exit 1                         # refusal: no fallback event and no alternate worker
  fi
  echo "⚠ worker: codex indisponível ($REASON) — usando forge-executor"
  mkdir -p "$WORKING_DIR/.gsd/forge/"
  HINT_JSON=$(cat "${CODE_DIR_HINT_FILE:-$WORKING_DIR/.gsd/forge/code-dir-hint.json}" 2>/dev/null); [ -n "$HINT_JSON" ] || HINT_JSON='""'
  printf '{"ts":"%s","event":"worker-engine-fallback","milestone":"%s","slice":"%s","unit":"execute-task/%s","reason":"%s","hint":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${M###}" "${S##}" "${T##}" "$REASON" "$HINT_JSON" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
  # CRITICAL, per-dispatch + evidence-based fallback discipline: shared/forge-dispatch.md § Engine Fallback Discipline
fi
```
**If a next member was persisted (`$NEXT` non-empty):** surface "Codex worker failed (`$REASON`). Run `/forge-next` again — it will retry with the next model in the chain (`$NEXT`)." and stop this unit — step mode picks up the advance via the cursor on the next invocation (Step 4b), re-enters the canonical resolver/guard, and routes by the new `WORKER_MODE`. **If `$NEXT` was empty or an abort reason fired:** run the named `worker-engine-fallback`, resolve the fallback member's runtime axes, and enter its native machinery only after an allowed verdict. The fallback fires only on the exhausted/abort path — mutually exclusive with the chain-advance cursor (R2). No retry and no fallback from a runtime refusal.

---

**Branch D — sidecar codex plan (`$WORKER_MODE == sidecar` && `$RESOLVED_WORKER_ENGINE == codex` && `$unit_type == plan-slice`)** — executable mirror of `shared/forge-dispatch.md § Worker Engine Routing § Sidecar dispatch state machine — Branch D`. Read-only twin of Branch codex above: codex only *reads* the codebase + planning context and returns markdown plan content in the result JSON — it never writes `.gsd/**`, so this branch has **no dirty-tree guard, no `START_SHA` capture, no reset**. `CODE_DIR` resolves to `${WORKER_CWD:-$WORKING_DIR}` (isolation header).

0. **Increment the sidecar attempt counter + cap check FIRST (R3).** State is **fresh per attempt** (BLOCKER invariant #1 + #3): on a cross-engine chain with multiple codex members the `-attempt-$N` suffix keeps each attempt's state distinct, and `SIDECAR_ATTEMPT` is hard-capped by the count of `engine == codex` members in `$ROUTE_JSON.chain` (≤3). When the cap is exceeded, **skip steps 1–4 entirely** (no plan-context assembly, no state/result-file allocation, no sidecar launch) and go DIRECTLY to the **Fallback** block below:
```bash
CODEX_MEMBERS=$(node -e "process.stdout.write(String((JSON.parse(process.argv[1]).chain||[]).filter(m=>m.engine==='gpt'||m.engine==='codex').length))" "$ROUTE_JSON")
SIDECAR_ATTEMPT=$(( ${SIDECAR_ATTEMPT:-0} + 1 ))
if [ "$SIDECAR_ATTEMPT" -gt "${CODEX_MEMBERS:-1}" ]; then
  REASON="sidecar-cap-exceeded"   # → Claude forge-planner fallback (never a 4th recovery layer)
fi
```

1. **Assemble the plan-context file (orchestrator)** — temp file OUTSIDE `.gsd/` and `CODE_DIR`, concatenating the exact artifacts the Claude `forge-planner` would receive for this slice: the slice's ROADMAP entry, `M###-CONTEXT.md` (full), `S##-CONTEXT.md` (if it exists), each dependency slice's `T##-SUMMARY.md`/`S##-SUMMARY.md`, `.gsd/CODING-STANDARDS.md`, and `S##-RISK.md` (if it exists). Guarded by the cap (R3 — the real `if/else` whose cap branch went straight to Fallback above):
```bash
if [ "$REASON" != "sidecar-cap-exceeded" ] && [ -z "$CODE_DIR_REASON" ]; then
  CODE_DIR="${WORKER_CWD:-$WORKING_DIR}"
  CTX_FILE=$(mktemp -t forge-plan-context.XXXXXX.md)   # tmpdir, never under $CODE_DIR or .gsd
  # → orchestrator appends the artifacts above (Read + concatenate); absent optional files are skipped.
fi
```

2. **Persist durable state to disk** (no `start_sha` — read-only, nothing to reset). Branch D needs **none of the reset machinery** (read-only — invariant #2 does not apply), only state-fresh-per-attempt + cap. Same cap guard (R3):
```bash
if [ "$REASON" != "sidecar-cap-exceeded" ] && [ -z "$CODE_DIR_REASON" ]; then
  N="$SIDECAR_ATTEMPT"
  XLLM_STATE=$(node "$FORGE_SCRIPTS_DIR/forge-xllm-state.js" --mode write --dir "$WORKING_DIR/.gsd/forge" --milestone "{M###}" --slice "{S##}" --attempt "$N")
  mkdir -p "$WORKING_DIR/.gsd/forge/"
  RESULT_FILE=$(mktemp -t forge-xllm-result.XXXXXX.json)   # tmpdir, never under $CODE_DIR
  printf '{"attempt":%s,"reason":"","result_file":"%s","code_dir":"%s","ctx_file":"%s"}\n' \
    "$N" "$RESULT_FILE" "$CODE_DIR" "$CTX_FILE" > "$XLLM_STATE"
fi
```

3. **Dispatch detached via `run_in_background: true`**, `--mode plan` + `--plan-context` instead of `--plan`; `--model` is appended only when `$SIDECAR_MODEL` is non-empty; the resolver selects the chain's Codex member, then falls back to `workers.codex_model`:
```bash
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-xllm.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
node "$FORGE_SCRIPTS_DIR/forge-xllm.js" --mode plan \
  --host-runtime "$HOST_RUNTIME" --sidecar-declared \
  --plan-context "$CTX_FILE" --result-file "$RESULT_FILE" --cwd "$CODE_DIR" \
  --timeout "$WORKERS_TIMEOUT" \
  $([ -n "$SIDECAR_MODEL" ] && printf -- '--model %s' "$SIDECAR_MODEL")
```

4. **Poll `$RESULT_FILE`** (state `polling`) — identical cadence/orphan-detection to Branch codex step 4: `running` → keep polling + liveness check; `done` → success (step 5); `error` / exit `!= 0` / unparseable JSON → failure (`REASON` = `codex-exit-nonzero` / `codex-invalid-json` — a plan that fails `must_haves` validation in-sidecar also yields `codex-exit-nonzero`, exit 2) → Fallback. **Orphan:** heartbeat `updated_at` stale beyond the dynamic threshold `max(heartbeat_interval_ms × 4, 30s)` (identical canonical orphan detection as Branch codex — see `shared/forge-dispatch.md § Orphan detection`; probe + grace before kill) → `kill "$pid"` + `REASON=codex-orphan` → Fallback. `--timeout` backstop → `codex-timeout`.

5. **Success — orchestrator materializes the plans (`done` state).** Re-read the durable state from disk (shell vars are gone), read the result JSON, and **write** each plan file into `.gsd/**` (creating dirs) — orchestrator ONLY, codex never touched `.gsd/**`:
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
# started_at` bug — a field empty on every run, indistinguishable from "not observed".
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
echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"dispatch\",\"unit\":\"plan-slice/${S##}\",\"model\":\"${CODEX_MODEL:-codex-default}\",\"host_runtime\":\"${HOST_RUNTIME}\",\"worker_mode\":\"${WORKER_MODE}\",\"dispatch_allowed\":${DISPATCH_ALLOWED},\"reason\":\"${ENGINE_REASON}\",\"slice\":\"{S##}\",\"milestone\":\"${RUN_ID:-{M###}}\",\"input_tokens\":0,\"output_tokens\":0,\"engine\":\"codex\",\"domain\":\"${DOMAIN_USED}\",\"route_source\":\"${ROUTE_SOURCE}\",\"chain_len\":${CHAIN_LEN},\"vcs\":\"${DISPATCH_VCS:-unknown}\",${TRANSPORT_TAIL}}" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
```
and **rejoin the normal `plan-slice` completion path**: the **plan-check gate**, the interactive **plan gate** (`forge-next` is always `MODE = interactive`), and the **symbol-check gate** all run over the materialized files exactly as after a Claude `forge-planner` — nothing in those gates changes. No `T##-SUMMARY`/`---GSD-WORKER-RESULT---` is synthesized here — skip Step 5 (Process result) for this dispatch, going straight to the plan-check gate.

**Failure (any `reason`) — read-only, no reset.** First evaluate **Layer-1 transient retry** (same decision + counter + backoff + re-dispatch as Branch C, but **NO surgical-reset step** — read-only twin); only on a terminal class / exhaustion does control fall through to **Layer-2** (discard the result JSON and dispatch a single Claude `forge-planner` for the same slice):
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
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${M###}" "${S##}" "${S##}" "$SIDECAR_ATTEMPT" "$TRC" "$DELAY_MS" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
fi
```
**pause-ask gate (policy == `pause-ask`) — Branch D, forge-next: TTY asks live, headless degrades.** Same exhaustion-only trigger as Branch C (`POLICY == pause-ask` AND `$TRANSIENT_RETRY` empty AND `transient` class AND `TRC == MAX_TRC`); read-only twin so `unit` is `plan-slice/{S##}`. With a TTY set `PAUSE_ASK_GATE=1` to ask live; headless degrade to `fallback` + emit `sidecar-pause-degraded`:
```bash
PAUSE_ASK_GATE=""
if [ "$POLICY" = "pause-ask" ] && [ -z "$TRANSIENT_RETRY" ] && [ "$ERROR_CLASS" = "transient" ] && [ "$TRC" -eq "$MAX_TRC" ]; then
  if [ -t 1 ]; then
    PAUSE_ASK_GATE=1   # interactive — ask live via AskUserQuestion below
  else
    mkdir -p "$WORKING_DIR/.gsd/forge/"
    printf '{"ts":"%s","event":"sidecar-pause-degraded","milestone":"%s","slice":"%s","unit":"plan-slice/%s","reason":"pause-ask-headless-degrade","transient_retry_count":%s}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${RUN_ID:-${M###}}" "${S##}" "${S##}" "$TRC" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
  fi
fi
```
**If `$TRANSIENT_RETRY` is set**: re-enter the Branch D **Dispatch + Poll** for the CURRENT attempt (same state, fresh `$RESULT_FILE`; `SIDECAR_ATTEMPT` untouched); do NOT run the Layer-2 block below. **Otherwise** (terminal class or exhaustion) control falls through to **Layer-2** **unchanged**.

**If `$PAUSE_ASK_GATE` is set** (TTY present, pause-ask exhaustion): call `AskUserQuestion` with three options — **Retentar codex** (re-enter Branch D Layer-1 for one more transient retry: backoff→`--state-update`→re-dispatch `--mode plan`, counter continuing), **Fallback Claude** (discard the result JSON and dispatch a single Claude `forge-planner` now — the Layer-2 action), **Pausar milestone** (checkpoint via `continue.md` + `status: paused` and stop the loop — same mechanic as review-pause / account-handoff). **Otherwise** (headless degrade, or gate not triggered) control falls through unchanged:
```bash
CODE_DIR=$(node -pe "JSON.parse(require('fs').readFileSync('$XLLM_STATE','utf8')).code_dir" 2>/dev/null)
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
  exit 1                           # refusal: no fallback event and no alternate worker
fi
echo "⚠ worker: codex indisponível ($REASON) — usando forge-planner"
mkdir -p "$WORKING_DIR/.gsd/forge/"
HINT_JSON=$(cat "${CODE_DIR_HINT_FILE:-$WORKING_DIR/.gsd/forge/code-dir-hint.json}" 2>/dev/null); [ -n "$HINT_JSON" ] || HINT_JSON='""'
printf '{"ts":"%s","event":"worker-engine-fallback","milestone":"%s","slice":"%s","unit":"plan-slice/%s","reason":"%s","hint":%s}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${M###}" "${S##}" "${S##}" "$REASON" "$HINT_JSON" >> "$WORKING_DIR/.gsd/forge/events.jsonl"
# CRITICAL, per-dispatch + evidence-based fallback discipline: shared/forge-dispatch.md § Engine Fallback Discipline
```
The allowed fallback contract now carries `WORKER_MODE == native`; run Tier
Resolution (step 1.5) and Effort Resolution (step 1.55), then use the
host-native planning machinery. The resolver refusal branch above launches
nothing and emits no fallback event. No retry — not a 4th recovery layer.
