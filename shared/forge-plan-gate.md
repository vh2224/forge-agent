# Forge Plan Gate — Interactive Plan Refinement

Authoritative spec for the **plan gate**: an interactive handshake that presents the plan to the operator, surfaces `forge-plan-checker` findings as actionable questions, and captures explicit approval before execution begins. Two consumers bind it at their own boundary:

| Consumer | Boundary | UNIT | PLAN_GLOB | MODE | Approval marker |
|----------|----------|------|-----------|------|-----------------|
| `forge-task` (Step 4) | standalone task — after `forge-planner` returns `{TASK_ID}-PLAN.md`, before Step 5 (execute) | `task/{TASK_ID}` | `{TASK_ID}-PLAN.md` | `interactive` | `{TASK_ID}-PLAN-GATE.md` |
| `forge-next` (plan-check gate) | per-slice — after `plan-slice` returns, before first `execute-task` | `plan-slice/{S##}` | `{S##}-PLAN.md` + `tasks/*/T##-PLAN.md` | `interactive` | `{S##}-PLAN-GATE.md` |
| `forge-auto` | — | — | — | `auto` | never conducts — see `## Degradation by mode` |

Steps 1–5 below are boundary-agnostic — only the four bindings above differ. Steps are written in slice terms (`{S##}-PLAN.md`, `{S##}-PLAN-GATE.md`); substitute the task bindings when invoked from `forge-task`.

The gate is **not** a second plan-checker pass — it is a human-arbitration moment: the operator previews the plan, addresses checker findings interactively, optionally edits the plan in their editor, and approves before any code is written. The `forge-planner` remains a **stateless batch decomposer** — it does not conduct the gate.

> Why the orchestrator/skill and not the planner: the planner runs in an isolated worker context without `AskUserQuestion`. The gate must live in the orchestrator/skill (main context), which owns both `AskUserQuestion` and `Agent`. See CONTEXT D1.

## Inputs

- `WORKING_DIR` — absolute project root (bash-captured `pwd`, Windows-safe)
- `{M###}` — active milestone id (forge-next only; omit in forge-task)
- `{S##}` — slice being planned (forge-next only)
- `{TASK_ID}` — task id (forge-task only)
- `MODE` — `interactive` (forge-next / forge-task) or `auto` (forge-auto)
- `PLAN_GLOB` — path(s) to plan file(s) per consumer binding above
- `PLAN_FILE` — the single plan file to re-validate in Step 4. Defined per consumer:
  - **`forge-task`**: `PLAN_FILE="{WORKING_DIR}/.gsd/tasks/{TASK_ID}/{TASK_ID}-PLAN.md"` (one file)
  - **`forge-next`**: no scalar `PLAN_FILE`; Step 4 loops over every file matched by `PLAN_GLOB` (`{S##}-PLAN.md` + `tasks/*/T##-PLAN.md`)
- `plan_check_counts` — `{pass, warn, fail}` (parsed from the plan-checker `---GSD-WORKER-RESULT---` block; already in scope after the existing plan-check dispatch in forge-next; not applicable in forge-task legacy plans)

## Step 0 — Read plan_gate prefs (via the canonical prefs CLI)

Resolve prefs once through the S01 engine CLI (`scripts/forge-prefs.js --resolved`, the canonical per-unit helper defined in `shared/forge-dispatch.md § Per-unit prefs resolution`) — it reads the JSONC catalog per layer, and legacy Markdown without JSONC hard-stops with the canonical repair message in `shared/forge-prefs-cutover.md`, so no `files=[…]` 3-file cascade merge is re-implemented here. Read the `plan_gate.*` knobs off `.prefs`:

```bash
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-prefs.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
PREFS_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-prefs.js" --resolved --cwd "$WORKING_DIR")
if [ $? -ne 0 ]; then
  # M008-CONTEXT decision #2 — loud stop, never a silent default. errors[] (file+line)
  # on stdout ($PREFS_JSON); human message + fix hint on stderr. Halt the gate loop.
  echo "✗ prefs parse error — plan gate halted (see stderr for arquivo:linha)" >&2
  # ...deactivate run + STOP...
fi

# Extract plan_gate knobs off .prefs, preserving the exact whitelist + defaults.
INTERACTIVE=$(printf '%s' "$PREFS_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{let v=(JSON.parse(d).prefs.plan_gate||{}).interactive;v=(typeof v==='string')?v.toLowerCase():'';process.stdout.write(['always','auto','off'].includes(v)?v:'always')}catch(e){process.stdout.write('always')}})")
ASK_AUTO=$(printf '%s' "$PREFS_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{let v=(JSON.parse(d).prefs.plan_gate||{}).ask_in_auto;v=(typeof v==='string')?v.toLowerCase():'';process.stdout.write(['defer','off'].includes(v)?v:'defer')}catch(e){process.stdout.write('defer')}})")
```

Defaults preserved byte-for-byte: absent `.prefs.plan_gate` (or an out-of-whitelist value) → `INTERACTIVE=always`, `ASK_AUTO=defer` — identical to the old inline cascade.

**Pref semantics:**

| `interactive` value | Meaning |
|---------------------|---------|
| `always` (default) | Conduct the gate on every plan, including all-pass. Preview + approval every time. |
| `auto` | Conduct only when the plan-checker returned `warn > 0` or `fail > 0`. Auto-approve silently when all 10 dimensions pass. |
| `off` | Skip the gate entirely — batch advisory current behavior. Proceed straight to execution. |

- `interactive == off` → **skip the gate.** Proceed straight to execution (same as current behavior before this feature).
- `MODE == auto` (forge-auto) → **skip the gate regardless of `interactive`.** See `## Degradation by mode`.
- `interactive == auto` AND `plan_check_counts.warn == 0` AND `plan_check_counts.fail == 0` → **auto-approve.** Skip conduct, write approval marker, proceed. (Not applicable to forge-task legacy plans — see `## Step 4`.)

**Resolution note:** prefs parsing (block capture, `[ \t]` class, EOF-safe boundaries, `\Z` avoidance) now lives entirely in `scripts/forge-prefs.js` (S01) — the gate only extracts resolved knobs off `.prefs`. The whitelist fallbacks above (`always`/`defer` on absent or invalid) are the gate's own concern; the CLI resolves values without defaulting them.

## Step 0a — Idempotency / approval marker

The **approval marker** for each consumer is a small file written when the operator approves the plan:

| Consumer | Marker file |
|----------|-------------|
| `forge-next` | `{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN-GATE.md` |
| `forge-task` | `{WORKING_DIR}/.gsd/tasks/{TASK_ID}/{TASK_ID}-PLAN-GATE.md` (or the task dir in the active milestone) |

These markers are **not** `{S##}-PLAN-CHECK.md`. That file is owned by `forge-plan-checker` (a separate advisory agent) and must not be reused as an approval signal — doing so would conflate the checker's structural score with the operator's explicit approval.

**Idempotency check:**

Set `GATE_MARKER` per consumer before running this check:

```bash
# forge-next variant:
GATE_MARKER="{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN-GATE.md"

# forge-task variant (substitute this instead):
# GATE_MARKER="{WORKING_DIR}/.gsd/tasks/{TASK_ID}/{TASK_ID}-PLAN-GATE.md"
# (If the task runs inside a milestone use:)
# GATE_MARKER="{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/tasks/{TASK_ID}/{TASK_ID}-PLAN-GATE.md"
```

```bash
if [ -f "$GATE_MARKER" ] && grep -qF "status: approved" "$GATE_MARKER" 2>/dev/null; then
  echo "Plan gate already approved — skipping (resume after compaction)"
  # Proceed directly to execution
fi
```

If the marker exists and contains `status: approved` → skip the gate. A resume after compaction must not re-prompt the operator for a plan they already approved.

## Step 1 — Preview the plan

Present the plan to the operator before any findings are surfaced:

1. Read `{S##}-PLAN.md` (or `{TASK_ID}-PLAN.md`) from disk — **preview = file on disk, not cached content.** This ensures any in-flight edits are reflected.
2. Echo a summary: milestone + slice/task title, number of tasks (forge-next), must_haves count, ordering dependencies.
3. For `forge-next`: also list each `T##` title, its `tier`, `effort`, and `depends` from the task plans.

The preview is informational — no questions yet. The operator reads the plan and prepares for the finding review in Step 2.

## Step 2 — Refine findings (AskUserQuestion per finding)

Surface each `warn` and `fail` from `plan_check_counts` as an actionable question.

For `forge-next`:
- Read the findings from `{S##}-PLAN-CHECK.md` (written by the plan-checker dispatch that already ran).
- For each dimension with verdict `warn` or `fail` (in severity order: `fail` first): invoke `AskUserQuestion` with:
  - **Header:** `Plan {S##} — <dimension name>`
  - **Body:** the checker's one-line justification for that finding
  - **Options:** `Manter` / `Corrigir no ato` / `Deferir`

For `forge-task`:
- `forge-task` plans are **legacy free-text** (no structured `must_haves:` YAML) — the plan-checker always returns `warn` on `legacy_schema_detect` (never `fail`). Surface this one finding and ask the operator to review the plan text directly.
- If `interactive == always`: conduct regardless (preview + one question per warn/fail).
- If `interactive == auto` AND `plan_check_counts.warn == 0` AND `plan_check_counts.fail == 0`: auto-approve (legacy plans rarely reach all-pass, but the path is valid — write marker and proceed).

**Resolution per option:**
- `Manter` — accept the finding as-is, no change. Record in the marker.
- `Corrigir no ato` — operator corrects the plan now. Proceed to Step 3 (free-file edit).
- `Deferir` — create an item via `shared/forge-review.md § Item capture` (source `plan-gate/{S##}` for `forge-next`, `plan-gate/{TASK_ID}` for `forge-task`; `origin: auto`, `status: inbox`; no `file` — this junction has none). Record in the marker: `{dimensão}: deferido → {I-id} — {title}`. If `--add` fails, `§ Item capture`'s advisory-failure rule applies: the durable fallback is always `.gsd/KNOWLEDGE.md § Review follow-ups` (never the marker alone — the marker is cleaned by `milestone_cleanup`, so a marker-only note would silently vanish).

Batch up to 4 findings per `AskUserQuestion` call when findings are low-severity (all `warn`) and related. Keep `fail`-severity findings as individual questions.

## Step 3 — Free-file edit escape hatch

After the guided finding review, offer the operator an unstructured edit window:

```
AskUserQuestion({
  header: "Edição livre do plano",
  body: "Edite {S##}-PLAN.md (ou {TASK_ID}-PLAN.md) no seu editor agora. Confirme quando terminar.",
  options: ["Confirmar — relerei o plano", "Pular — plano está bom"]
})
```

- `Confirmar` → re-read the plan file from disk and display the updated plan to the operator. The orchestrator does NOT cache the plan — it always reads the current file. This applies the human's edits as the authoritative plan version.
- `Pular` → proceed to Step 4.

This escape hatch covers changes that the plan-checker did not flag: reordering tasks, rephrasing must_haves, adjusting scope — anything the operator wants to change before approving.

## Step 4 — Post-edit re-validation

After any edit (Step 3 `Confirmar` path), re-validate the plan schema.

**`forge-task` (single file):**

```bash
REVALIDATION_STDERR=$(mktemp)
REVALIDATION=$(node "$FORGE_SCRIPTS_DIR/forge-must-haves.js" --check "$PLAN_FILE" 2>"$REVALIDATION_STDERR")
REVALIDATION_EXIT=$?
```

**`forge-next` (loop over all plan files in the slice):**

```bash
for plan in $PLAN_GLOB; do
  REVALIDATION_STDERR=$(mktemp)
  REVALIDATION=$(node "$FORGE_SCRIPTS_DIR/forge-must-haves.js" --check "$plan" 2>"$REVALIDATION_STDERR")
  REVALIDATION_EXIT=$?
  # Apply the IO-error guard and JSON.parse guard below per iteration
done
```

**IO-error guard (apply before JSON.parse in both variants):**

```bash
if [ $REVALIDATION_EXIT -ne 0 ] && [ $REVALIDATION_EXIT -ne 2 ]; then
  # Exit code other than 0/2 → IO error (file not found, permission denied, etc.)
  # Stderr has the human-readable message; stdout may be empty or non-JSON.
  IO_ERR=$(cat "$REVALIDATION_STDERR")
  # Surface as a blocking finding — do NOT silently abort.
  # Treat as valid=false with a synthetic error message.
  LEGACY=false; VALID=false
  ERRORS="[\"IO error from forge-must-haves.js: $IO_ERR\"]"
else
  # Safe to JSON.parse stdout; guard against empty/non-JSON stdout.
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

**CLI contract:** `node "$FORGE_SCRIPTS_DIR/forge-must-haves.js" --check <plan.md>` → prints JSON to stdout:

| Exit | stdout | stderr | Meaning |
|------|--------|--------|---------|
| 0 | `{legacy: true,  valid: true,  errors: []}` | — | Legacy free-text plan; nothing validated. |
| 0 | `{legacy: false, valid: true,  errors: []}` | — | Structured plan, schema valid. |
| 2 | `{legacy: false, valid: false, errors: ["<msg>"]}` | — | Structured plan, schema error (also covers IO errors: file not found, permission denied — written to stderr, stdout may be empty). |
| other | empty or non-JSON | human-readable error | Unexpected CLI failure; treat as blocking (surface stderr message). |

**IO error note:** exit 2 covers both schema errors and IO errors (file not found, permission denied). In either case the human-readable message is written to stderr. Consumers MUST capture stderr and, if stdout is empty or non-JSON, treat the result as a blocking finding and surface the stderr content — not as a silent abort.

**Critical asymmetry — Pitfall 1 (must be understood by both consumers):**

`forge-task` plans are **legacy free-text** (`## Steps` / `## Must-Haves` / `## Standards` / `## Files to Change`, no structured `must_haves:` YAML frontmatter). The CLI's `hasStructuredMustHaves()` detects no `^must_haves:` at column 0 and short-circuits to `{legacy:true, valid:true, errors:[]}` — **validating nothing.** Re-validation is a **no-op for the forge-task consumer**. The safety net for legacy plans is the free-text edit + reload in Step 3, not schema enforcement.

Re-validation is **meaningful only for the forge-next consumer** (structured `must_haves:` plans produced by `plan-slice`).

**Blocking finding:** if `legacy == false && valid == false` → surface the schema errors as a blocking finding:

```
AskUserQuestion({
  header: "Erro de schema no plano",
  body: "O plano tem erros de schema que impedem a aprovação:\n{ERRORS}\nCorrigir o plano (edit + releitura) ou abortar.",
  options: ["Corrigir agora", "Abortar — replanejar"]
})
```

- `Corrigir agora` → return to Step 3 (free-file edit), then re-run Step 4.
- `Abortar` → do not write the approval marker. Return the user to the planning phase.

Approval is **not granted** until `valid == true` (or `legacy == true` with the understanding that schema is unchecked).

## Step 5 — Approval handshake

After findings are addressed and re-validation passes, present the final approval gate:

```
AskUserQuestion({
  header: "Aprovar plano {S##}",  // or {TASK_ID}
  body: "Plano revisado e validado. Aprovar para iniciar a execução?",
  options: ["Aprovar — iniciar execução", "Editar mais", "Abortar — replanejar"]
})
```

- `Aprovar` → write the approval marker:

```bash
mkdir -p "$(dirname "$GATE_MARKER")"
cat > "$GATE_MARKER" << 'EOF'
---
status: approved
approved_at: {ISO8601}
consumer: {forge-next|forge-task}
unit: {UNIT}
---
Plan approved by operator. Execution may proceed.
EOF
```

  Then proceed to execution (forge-next: first `execute-task`; forge-task: Step 5).

- `Editar mais` → return to Step 3.
- `Abortar` → do not write the marker. Re-dispatch `forge-planner` with operator notes; restart the plan-slice/plan-task cycle.

**Plan-mode note for `forge-task`:** the approval handshake is the natural close of the planning phase. If `forge-task` uses `ExitPlanMode` here (Agent's Discretion, M002-CONTEXT), that is valid — the orchestrator/skill is **not** inside any inherited plan mode at this point (see `## Plan-mode non-nesting`). For `forge-next`, the orchestrator does not use `EnterPlanMode` or `ExitPlanMode` — the gate runs via `AskUserQuestion` only.

## Degradation by mode

**`MODE = auto` (forge-auto) NEVER conducts the plan gate handshake.** This is unconditional — it applies regardless of the `plan_gate.interactive` pref value. Setting `interactive: always` does not cause `forge-auto` to pause and ask.

The guard is `ask_in_auto: defer` (the default). When `forge-auto` reaches the plan boundary:

1. Run `forge-planner` (batch — unchanged).
2. Run `forge-plan-checker` (batch advisory — unchanged).
3. **Skip this gate entirely.** No preview, no `AskUserQuestion`, no approval marker.
4. Proceed directly to execution.

This mirrors the `review.ask_in_auto: defer` guard in `shared/forge-review.md § Step 7b auto branch`: the AUTONOMY RULE protects the middle of the loop, and plan-gate conduct is incompatible with autonomous operation.

The `forge-smoke.js` Section 19 smoke guard anchors exactly this section:
- **Positive asserts:** `forge-next` and `forge-task` consume the gate in interactive MODE.
- **Negative assert:** `forge-auto` does NOT conduct the handshake (grep for `MODE == auto` / `MODE = auto` degradation pattern).
- **Negative assert:** `plan_gate.interactive: always` does not appear as a standalone conduct trigger in `forge-auto` (MODE-gating precedes pref-gating).

> `ask_in_auto: off` is a reserved value (same shape as `review:`) but has no distinct behavior from `defer` at this gate — `forge-auto` never conducts regardless. The key is present for schema symmetry.

## Plan-mode non-nesting

`forge-discusser` is the **sole owner** of `EnterPlanMode` / `ExitPlanMode`. It enters at discuss Step 0 and **closes at Step 4** (before planning begins). Discuss and plan-gate are sequential, non-overlapping phases — by the time the plan gate opens, `forge-discusser` has already called `ExitPlanMode` and returned.

Consequences:

- **`forge-planner`** (batch decomposer, D1) does NOT gain `EnterPlanMode` or `ExitPlanMode`. It runs in an isolated worker context without interactive tools.
- **`forge-next` plan gate** runs in the orchestrator context, which holds no inherited plan mode. The gate uses `AskUserQuestion` only — no `EnterPlanMode`.
- **`forge-task` plan gate** may use `ExitPlanMode` as the approval handshake (Agent's Discretion, M002-CONTEXT `§ Agent's Discretion`). This is safe: `forge-task` is not invoked inside a discuss phase, so there is no open plan mode to nest with.
- **S02/S03 must NOT** add `EnterPlanMode` to the planner or wrap the plan gate in a new plan mode that would nest with discuss's.

Validate via grep: `agents/forge-planner.md` must not contain `EnterPlanMode`.

## Event log

Append one line to `{WORKING_DIR}/.gsd/forge/events.jsonl` when the gate completes (approved or aborted):

```json
{"ts":"<ISO-8601>","event":"plan-gate","milestone":"{M###}","unit":"{UNIT}","mode":"{MODE}","interactive":"{interactive}","outcome":"approved|aborted|skipped","warn":N,"fail":N,"edits":N}
```

Field semantics:
- `outcome`: `approved` (operator approved), `aborted` (operator chose to replan), `skipped` (mode=auto, interactive=off, or idempotency hit).
- `warn` / `fail`: counts from `plan_check_counts` (0 when not applicable — forge-task legacy plans).
- `edits`: number of times Step 3 was visited (0 = no free-file edit).

These are **additive fields** (readers that ignore unknown keys stay compatible — same convention as `tier`/`reason` from CONTEXT M001).

For `forge-task`, `{M###}` may be omitted or set to `""` if the task runs outside a milestone.

## Cross-references

- `skills/forge-task/SKILL.md` — consumer: insert plan gate after Step 4 (plan) and before Step 5 (execute). Binding: `UNIT=task/{TASK_ID}`, `PLAN_GLOB={TASK_ID}-PLAN.md`, `MODE=interactive`, marker=`{TASK_ID}-PLAN-GATE.md`.
- `skills/forge-next/SKILL.md` — consumer: insert plan gate after the plan-check gate (`:287-342`) and before the first `execute-task` dispatch. Binding: `UNIT=plan-slice/{S##}`, `PLAN_GLOB={S##}-PLAN.md + tasks/*/T##-PLAN.md`, `MODE=interactive`, marker=`{S##}-PLAN-GATE.md`.
- `skills/forge-auto/SKILL.md` — MODE=auto; gate is skipped unconditionally. No wiring change needed beyond confirming the skip in the event log.
- `agents/forge-plan-checker.md` — the plan-checker runs before this gate and produces `plan_check_counts: {pass, warn, fail}`. The gate reads these counts. The checker's artifact `{S##}-PLAN-CHECK.md` is NOT the approval marker.
- `scripts/forge-must-haves.js` — re-validation CLI in Step 4. Command: `node "$FORGE_SCRIPTS_DIR/forge-must-haves.js" --check <plan.md>` → `{legacy, valid, errors}` JSON to stdout. Exit 0 for legacy-or-valid, exit 2 for malformed structured plan. **Legacy plans always return `{legacy:true, valid:true}` — no schema enforcement.**
- `forge-agent-prefs.jsonc § Plan Gate Settings` — the `plan_gate:` pref block (`interactive`, `ask_in_auto`). Resolved via the prefs CLI in Step 0 above.
- `shared/forge-review.md § Item capture` — canonical procedure for `Deferir` item creation (invocation, payload fields, pointer-line format, advisory-failure rule). Not restated here.
- Approval marker: `{S##}-PLAN-GATE.md` (per-slice) or `{TASK_ID}-PLAN-GATE.md` (per-task), written in Step 5. Not committed; cleaned by `milestone_cleanup` with the slice artifacts.
- Artifact: `.gsd/items/*.md` — work items created by `Deferir` resolutions (durable; never cleaned by `milestone_cleanup`).
- `scripts/forge-items.js` — the CLI backing `--add`, invoked via the canonical procedure in `shared/forge-review.md § Item capture`.
