# S03 — Token counter + context budget

**Milestone:** M002
**Risk:** low
**Depends:** [S01]
**Planned:** 2026-04-16

---

## Goal

Give the Forge orchestrator coarse-grained observability of context usage
(tokens consumed per dispatch, cumulative per milestone) plus a safe
context-budget truncation helper so large optional sections (AUTO-MEMORY,
LEDGER snapshot, CODING-STANDARDS) never blow up a worker prompt. Port the
`Math.ceil(chars/4)` heuristic from GSD-2 into a dependency-free Node
`scripts/forge-tokens.js` (module + CLI); wire `{event:"dispatch", ...,
input_tokens, output_tokens}` telemetry into `shared/forge-dispatch.md` so
every worker dispatch emits a line to `events.jsonl`; extend `/forge-status`
(the `forge-status` skill) with a **Token usage** block that aggregates those
lines for the active milestone; introduce `token_budget:` prefs block with
defaults per optional section. Mandatory sections (`T##-PLAN`, `S##-CONTEXT`,
`M###-SCOPE`) surface an explicit error when they exceed their budget —
optional sections truncate at the nearest H2 (`## `) boundary with a
`[...truncated N sections]` marker.

---

## Acceptance criteria

1. **Heuristic is explicit and testable.** `scripts/forge-tokens.js` exports
   `countTokens(text)` returning `Math.ceil(text.length / 4)` (no provider
   SDKs, no npm deps). CLI mode: `node scripts/forge-tokens.js --file <path>`
   prints single-line JSON `{tokens, chars, method:"heuristic"}`; stdin is
   also accepted when no `--file` is passed. Exit code 0 on successful
   computation, exit code 2 on CLI parse errors. Matches Hybrid C approach:
   deterministic Node for execution paths.

2. **Boundary-aware truncation exists and is safe.** Module also exports
   `truncateAtSectionBoundary(content, budgetChars, {mandatory?: boolean,
   label?: string})`. When `mandatory === true` and `content.length >
   budgetChars`, the function throws an Error with message
   `"Context budget exceeded for mandatory section {label}: {actual} chars > {budget} budget"`.
   When optional and oversize, the function splits `content` on a regex
   matching top-level boundaries (`^## `, `^### `, or a line containing only
   `---` / `***`) keeping sections atomic, drops the smallest suffix needed
   to fit within budget, then appends the marker `\n\n[...truncated N sections]`
   (N = count of dropped sections, 1-based). If `content.length <=
   budgetChars`, returns input verbatim (no marker). Zero-boundary input
   that is still oversize after fit-check is truncated at
   `budgetChars - marker.length` with the marker appended — documented as the
   fallback branch.

3. **Dispatch telemetry lands on disk.** `shared/forge-dispatch.md` has a
   new control-flow section `### Token Telemetry` (sibling to the existing
   `### Retry Handler` per MEM011 — templates stay data-flow; telemetry is
   control-flow). The section instructs the orchestrator to (a) compute
   `input_tokens = countTokens(finalPrompt)` AFTER all placeholder
   substitutions but BEFORE `Agent()` is invoked, (b) capture `output_tokens`
   from the worker result or recompute via `countTokens(result.text)` when
   the SDK does not surface usage, (c) append
   `{"ts":"{ISO}","event":"dispatch","unit":"{unit_type}/{unit_id}","model":"{model_id}","input_tokens":N,"output_tokens":N}`
   to `.gsd/forge/events.jsonl` as one line. Retry path adds `input_tokens`
   to the existing `event:"retry"` entry (the retry re-dispatch IS a new
   input). Telemetry I/O is NOT wrapped in try/catch — same contract as the
   verify gate in S02 (telemetry is not silent-fail).

4. **Both dispatch loops consume the new section.** `skills/forge-auto/SKILL.md`
   Step 4 (Dispatch) and `skills/forge-next/SKILL.md` (equivalent dispatch
   step) explicitly cite `### Token Telemetry` from `shared/forge-dispatch.md`.
   MEM015 preserved — each file is patched independently; no mechanical
   template merge. MEM018 budget: forge-auto stays under ~4.5K tokens
   post-patch.

5. **Optional-section injections gain budgets.** The `TOP_MEMORIES`,
   `CS_STRUCTURE`, `CS_RULES`, and `LEDGER` (future) placeholders in
   dispatch templates become budgeted via
   `truncateAtSectionBoundary(content, PREFS.token_budget.<key> * 4)`
   (heuristic: 1 token ≈ 4 chars). `shared/forge-dispatch.md` gains a
   **Budgeted Section Injection** subsection describing how to wire it.
   Mandatory placeholders (`T##-PLAN`, `S##-CONTEXT`, `M###-SCOPE`) are
   identified in a table and are NOT wrapped — instead, each dispatch
   template's pre-flight step computes their char length and throws via
   `truncateAtSectionBoundary(content, budget, {mandatory: true, label})`
   if exceeded. The throw propagates to the orchestrator's catch path and
   surfaces as a blocker (`scope_exceeded`) — no silent truncation.

6. **`/forge-status` renders a Token usage block.** `skills/forge-status/SKILL.md`
   gains a new **Token usage** report section below "Próxima ação". It reads
   `.gsd/forge/events.jsonl`, filters `event:"dispatch"` lines whose `unit`
   starts with a known unit_type for the active milestone (by matching
   STATE.md's current `M###`; lines not associated with a milestone are
   counted as a global sum), and outputs a pt-BR block:
   ```
   ### Token usage (M###)
   - Total input:  12 345 tokens
   - Total output:  3 421 tokens
   - Dispatches:   18 (por fase: plan-slice 2 · execute-task 14 · complete-slice 2)
   ```
   Numbers formatted with thin-space thousands separators. If no dispatch
   lines exist yet, section prints `Sem dados de telemetria ainda.`

7. **Prefs contract.** `forge-agent-prefs.md` gains a `token_budget:` block
   with keys `auto_memory: 2000`, `ledger_snapshot: 1500`,
   `coding_standards: 3000` (tokens, not chars). Inline docs explain these
   are per-optional-section caps, NOT per-unit caps. Also documents that
   mandatory sections (`T##-PLAN`, `S##-CONTEXT`, `M###-SCOPE`) have no cap
   — oversize mandatory sections surface as blockers. Handler falls back to
   defaults when block is missing.

8. **Demo + unit-test artefact.** `S03-SUMMARY.md` includes: (a) a 10 000-token
   (≈40 000 char) synthetic AUTO-MEMORY.md fed through
   `truncateAtSectionBoundary` with budget 2000 tokens — verify output ends
   at an H2 boundary and marker count matches dropped sections; (b) three
   real dispatch events tailing `.gsd/forge/events.jsonl` with valid JSON;
   (c) `/forge-status` output snapshot showing the Token usage block
   populated. Mandatory-section overflow test: feed an 800-char string
   through `truncateAtSectionBoundary(content, 500, {mandatory: true, label:
   "T01-PLAN"})` and capture the thrown error message.

Each criterion must be observable — either by running the CLI directly,
grepping `events.jsonl`, or reading the updated artefacts.

---

## Tasks (6)

- [ ] **T01 — Port token counter to `scripts/forge-tokens.js`**
  Create the Node CLI + module. `countTokens(text)` = `Math.ceil(text.length/4)`.
  `truncateAtSectionBoundary(content, budgetChars, opts)` with H2/H3/HR
  splitting + `[...truncated N sections]` marker + mandatory-mode throw.
  Dual-mode: `require()` import OR `node scripts/forge-tokens.js --file <path>`
  from Bash. Stdin fallback when `--file` absent. Exit 0 on success, 2 on CLI
  parse error. CommonJS, zero deps, shebang, `'use strict'`. Unit-style
  smoke assertions in inline `// ASSERT:` comments that `node -e` can
  re-exercise.

- [ ] **T02 — Add Token Telemetry section to `shared/forge-dispatch.md`**
  New `### Token Telemetry` section after `### Retry Handler`. Documents
  the `{event:"dispatch", unit, model, input_tokens, output_tokens, ts}`
  event shape. Describes computing `input_tokens` after substitution but
  before `Agent()`; falling back to `countTokens(resultText)` when the
  SDK does not return usage. Includes a **Budgeted Section Injection**
  subsection: helper pseudocode that wraps optional placeholders
  (`{TOP_MEMORIES}`, `{CS_STRUCTURE}`, `{CS_RULES}`, future `{LEDGER}`)
  with `truncateAtSectionBoundary`, plus a table listing mandatory
  placeholders that MUST error on overflow. Retry path integration: add
  `input_tokens` to `event:"retry"` entries.

- [ ] **T03 — Wire telemetry into forge-auto + forge-next skills**
  Patch `skills/forge-auto/SKILL.md` Step 4 (Dispatch) and
  `skills/forge-next/SKILL.md` dispatch block so both call the Token
  Telemetry flow around each `Agent()` dispatch. MEM015 preserved — patch
  each skill independently; do NOT merge templates. Confirm MEM018 budget:
  forge-auto.md stays < 4 500 tokens, forge-next.md stays < 4 700 tokens
  post-patch (both run `node scripts/forge-tokens.js --file` during smoke
  verification).

- [ ] **T04 — Render Token usage block in `/forge-status` skill**
  Patch `skills/forge-status/SKILL.md` to read
  `.gsd/forge/events.jsonl`, filter `event:"dispatch"` lines for the
  active milestone (parse `unit` format `"{unit_type}/{unit_id}"`; a
  dispatch is "in milestone M###" when the unit_id or its ancestor slice
  falls under that milestone per STATE.md), sum input/output tokens, and
  break down by phase. Output pt-BR per project convention. Handles
  "no dispatch lines yet" gracefully (prints `Sem dados de telemetria
  ainda.`). Use `node scripts/forge-tokens.js` for any aggregation
  helpers needed; no awk/sed pipelines (MEM042 — deterministic CLIs
  over shell one-liners when data has structure).

- [ ] **T05 — Add `token_budget:` prefs block + wire budgeted injections**
  Add `token_budget:` block to `forge-agent-prefs.md` with keys
  `auto_memory: 2000`, `ledger_snapshot: 1500`, `coding_standards: 3000`
  (documented as tokens, not chars). Prose note on mandatory sections
  (no cap — overflow is a blocker). Document the two-layer semantics
  (tokens in prefs → multiplied by 4 to pass to `truncateAtSectionBoundary`
  which is char-native). Light edits to `shared/forge-dispatch.md` if
  any placeholder names change; otherwise T02's pseudocode references
  this block for defaults. T05 does NOT modify dispatch templates
  beyond adding the Budgeted Section Injection helper call — that was
  T02's job.

- [ ] **T06 — Smoke tests + S03-SUMMARY.md (draft)**
  Run 4 smoke scenarios against `scripts/forge-tokens.js` + dispatch
  pipeline + `/forge-status`. Capture outputs. Write draft
  `S03-SUMMARY.md` (completer finalizes). Smoke list: (1) heuristic
  counts on known strings ("hello world" = 12 chars → 3 tokens; 10k-char
  AUTO-MEMORY → 2500 tokens); (2) 40 000-char (≈10 000-token)
  synthetic AUTO-MEMORY.md through `truncateAtSectionBoundary(content,
  8000)` (budget 2000 tokens × 4 chars/token) → verify output ends at
  H2 boundary + marker `[...truncated N sections]` present; (3)
  mandatory-section overflow throws with correct message; (4) dispatch
  a unit in forge-auto (or simulate via hand-crafted `events.jsonl`
  append), run `/forge-status`, verify Token usage block renders
  correctly.

---

## Task ordering / dependencies

```
T01 (forge-tokens.js script)
  └── T02 (dispatch Token Telemetry section)
        ├── T03 (wire forge-auto + forge-next)
        └── T04 (forge-status rendering)
              └── T05 (prefs block + Budgeted Section helper)
                    └── T06 (smokes + summary)
```

T01 is the hard gate — everything else depends on `scripts/forge-tokens.js`
existing and being importable. T02 writes prose that references T01's
exports; T03/T04 consume T02's section. T05 adds the prefs schema that
T02's Budgeted Section helper reads; T06 is the evidence pass.

---

## Out of scope (defer to later slices or milestones)

- Swap `Math.ceil(chars/4)` for tiktoken or provider-native counting
  (documented in M002-CONTEXT.md Deferred Ideas — revisit if heuristic
  error > 20% in any model).
- Per-milestone token budgets with pressure-based downgrade (requires
  baseline telemetry first — deferred to post-M003).
- Token usage dashboards across milestones (current scope is active
  milestone only).
- Cross-provider token weight correction (Claude-only routing — no
  adapter layer planned).
- Tier-aware cost computation (S04 extends the dispatch event with
  `tier` and `reason`; cost math is post-S04 if useful).

---

## Files produced

- `scripts/forge-tokens.js` (new)
- `shared/forge-dispatch.md` (modified — new `### Token Telemetry`
  section + `#### Budgeted Section Injection` subsection)
- `skills/forge-auto/SKILL.md` (modified — Dispatch step wraps
  `Agent()` with telemetry)
- `skills/forge-next/SKILL.md` (modified — equivalent dispatch step)
- `skills/forge-status/SKILL.md` (modified — Token usage block in
  status report template)
- `forge-agent-prefs.md` (modified — new `token_budget:` block)
- `.gsd/milestones/M002/slices/S03/S03-SUMMARY.md` (new — T06 drafts,
  completer finalizes)

## Files consumed

- `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/` — reference for the
  Math.ceil(chars/4) heuristic as shipped in GSD-2 (look for
  `estimate-tokens.js` / `token-counter.js` equivalent; if absent,
  the formula is simple enough to port directly from M002-CONTEXT).
- `scripts/forge-classify-error.js` (S01) — reference for CommonJS
  module + CLI dual-mode style.
- `scripts/forge-verify.js` (S02) — reference for events.jsonl append
  contract (telemetry throws, not silent-fail) and CLI flag parsing.
- `shared/forge-dispatch.md ### Retry Handler` (S01) — sibling
  control-flow section; Token Telemetry follows the same markdown
  layout (Purpose → When to apply → Algorithm → Event log format →
  Prefs contract → Worked example).
- `.gsd/forge/events.jsonl` — output target for `event:"dispatch"`
  lines (append-only; never rewrite).

---

## Context / decisions respected

- **M002-CONTEXT D1** — token counting uses `Math.ceil(chars/4)`
  heuristic only; zero new npm deps. If telemetry shows > 20% error
  for any model, revisit (OUT of S03 scope).
- **M002-CONTEXT D5** — mandatory sections error on overflow; optional
  sections truncate at H2 boundary with marker. This slice implements
  both behaviours in one helper with a `mandatory: true` flag.
- **M002-CONTEXT D6** — Hybrid C: Node scripts for determinism/execution
  (`scripts/forge-tokens.js`); Markdown for control flow (`### Token
  Telemetry` section).
- **MEM002** — lean orchestrator: workers read own artefacts. Token
  Telemetry does NOT inline event-log content into the worker prompt;
  it appends to `events.jsonl` after dispatch.
- **MEM011** — dispatch templates are data-flow descriptors; retry and
  telemetry are control-flow sections placed AFTER the template
  fences.
- **MEM018** — token budgets: forge-auto ~4.2K baseline; post-patch
  must stay < 4 500 tokens. forge-next similar.
- **MEM036** — "errors are data" for classification; telemetry I/O
  errors still throw (not silent-fail) per S02-RISK.md precedent.
- **MEM042** — Node CLIs produce deterministic JSON; never shell
  one-liners when structure matters.

---

## Boundary handoff to S04

S04's Tier Resolution block extends the same `event:"dispatch"` line
with `tier` and `reason` fields. S03 defines the base schema; S04
must be additive — no field renames, no type changes. Document the
schema in T02's Event log format table so S04 planners inherit it
without digging.
