# T02: Add Token Telemetry section to `shared/forge-dispatch.md`

status: DONE

**Slice:** S03  **Milestone:** M002

## Goal

Document the control-flow algorithm that every Forge dispatch loop must
follow to emit `{event:"dispatch", ..., input_tokens, output_tokens}` lines
to `.gsd/forge/events.jsonl` AND to budget optional-section injections via
the `truncateAtSectionBoundary` helper from T01. New `### Token Telemetry`
section (sibling to `### Retry Handler`) gets added to
`shared/forge-dispatch.md` with a Purpose / When to apply / Algorithm /
Event log format / Prefs contract / Worked example layout — identical
shape to the retry handler section to keep the file pattern-consistent
(MEM011: templates are data-flow; control-flow lives in dedicated
sections after the template fences). Also adds a
`#### Budgeted Section Injection` subsection that wraps optional
placeholders (`{TOP_MEMORIES}`, `{CS_STRUCTURE}`, `{CS_RULES}`, future
`{LEDGER}`) with the truncator, plus a table listing mandatory
placeholders that MUST error on overflow.

## Must-Haves

### Truths

- **Section location:** `### Token Telemetry` is inserted immediately AFTER the `### Retry Handler` section (ending line around 444 in current file) and BEFORE the `## Verification Gate` section. Keep the `---` separator convention.
- **Section contents (in order):**
  1. **Purpose paragraph** — one paragraph citing MEM011 (control flow, not data flow), zero deps (Math.ceil/4 per M002-CONTEXT D1), and the two complementary responsibilities: (a) emit dispatch events, (b) budget optional sections.
  2. **Cross-reference block** — reference `node scripts/forge-tokens.js --file <path>` CLI and the two module exports (`countTokens`, `truncateAtSectionBoundary`). Document that workers NEVER call this script directly; only the orchestrator does.
  3. **When to apply** — one short paragraph: "Compute `input_tokens` after all placeholder substitution in the worker prompt, but BEFORE `Agent()` is invoked. Compute `output_tokens` from the worker result metadata if the SDK surfaces usage, otherwise `countTokens(result.text)`. Emit the event line on EVERY dispatch (success path AND retry re-dispatches — retry events get an additional `input_tokens` field)."
  4. **Algorithm** — numbered list, 7–10 steps:
     - (1) After substitution, before dispatch: `input_tokens = countTokens(finalPrompt)`.
     - (2) `Agent()` dispatch proceeds as documented elsewhere (success or retry).
     - (3) On return: if result includes usage/metadata, use that; else `output_tokens = countTokens(result.text ?? String(result))`.
     - (4) Build event object: `{ts: new Date().toISOString(), event: "dispatch", unit: \`${unitType}/${unitId}\`, model: modelId, input_tokens, output_tokens}`.
     - (5) Append to `.gsd/forge/events.jsonl` as a single newline-terminated JSON line. `mkdir -p .gsd/forge/` first.
     - (6) **I/O errors from the append MUST throw** — same contract as verify gate (S02 precedent). Telemetry is not silent-fail. Classifier-style "errors are data" (MEM036) does NOT apply here.
     - (7) On retry path: add `input_tokens: countTokens(retryPrompt)` field to the existing `event:"retry"` entry (the retry re-dispatch IS new input). Do not emit a separate dispatch event on retry — the retry entry already captures the event.
     - (8) If `input_tokens > 0.8 * model.context_window` (hardcoded: 200 000 for all Claude models as of 2026-04), emit a warning to the orchestrator log — but do NOT block dispatch. This is informational.
  5. **Event log format** — JSON schema table:
     | Field | Type | Source | Example |
     |-------|------|--------|---------|
     | `ts` | ISO8601 string | `new Date().toISOString()` | `"2026-04-16T10:00:00Z"` |
     | `event` | literal string | — | `"dispatch"` |
     | `unit` | string | `${unitType}/${unitId}` | `"execute-task/T03"` |
     | `model` | string | PREFS routing | `"claude-sonnet-4-6"` |
     | `input_tokens` | integer | `countTokens(prompt)` | `12345` |
     | `output_tokens` | integer | SDK usage or `countTokens(text)` | `3421` |
     - Include a note: **S04 will extend this schema with `tier` and `reason` — no field renames, additive only.**
  6. **Prefs contract** — handler reads `PREFS.token_budget.<key>` (integer tokens) for the Budgeted Section Injection subsection. Defaults: `auto_memory: 2000`, `ledger_snapshot: 1500`, `coding_standards: 3000`. Missing block → silent fallback to defaults. Defined in T05.
  7. **Worked example** — one concrete example with:
     - finalPrompt of ~8000 chars → `input_tokens = 2000`
     - worker returns ~1200 chars → `output_tokens = 300`
     - Event log line (single-line JSON, pretty-printed in a fenced ```json block): `{"ts":"2026-04-16T10:00:05Z","event":"dispatch","unit":"execute-task/T03","model":"claude-sonnet-4-6","input_tokens":2000,"output_tokens":300}`
- **Budgeted Section Injection subsection (`#### Budgeted Section Injection`)** — lives inside `### Token Telemetry`, AFTER the Worked Example.
  - Purpose one-liner: "Wrap OPTIONAL placeholders with the boundary-aware truncator so oversize injections never blow up a worker context. Mandatory placeholders throw instead."
  - **Pseudocode** (inside a fenced block, language-tagged `js` even though it's markdown-prose, for readability):
    ```js
    // Helper pseudocode — orchestrator-side only
    const budgetTokens = PREFS?.token_budget?.auto_memory ?? 2000;
    const budgetChars  = budgetTokens * 4;
    const MEMORIES_SAFE = truncateAtSectionBoundary(
      ALL_MEMORIES,
      budgetChars,
      { mandatory: false, label: "AUTO-MEMORY" }
    );
    // MEMORIES_SAFE is substituted for {TOP_MEMORIES} in the template.
    // For mandatory sections (T##-PLAN, S##-CONTEXT, M###-SCOPE):
    const planContent = readFileSync(planPath, 'utf8');
    truncateAtSectionBoundary(
      planContent,
      (PREFS?.token_budget?.plan_max ?? 8000) * 4,
      { mandatory: true, label: \`T\${taskId}-PLAN\` }
    ); // Throws on overflow → surfaces as blocker(scope_exceeded).
    ```
  - **Placeholder classification table:**
    | Placeholder | Category | Budget key | Default (tokens) |
    |-------------|----------|-----------|------------------|
    | `{TOP_MEMORIES}` | optional | `auto_memory` | 2000 |
    | `{CS_STRUCTURE}` | optional | `coding_standards` | 3000 |
    | `{CS_RULES}` | optional | `coding_standards` | (shares key with CS_STRUCTURE — count once per dispatch) |
    | `{LEDGER}` (future) | optional | `ledger_snapshot` | 1500 |
    | T##-PLAN content | mandatory | — | no cap (overflow throws) |
    | S##-CONTEXT content | mandatory | — | no cap (overflow throws) |
    | M###-SCOPE content | mandatory | — | no cap (overflow throws) |
    | `{CS_LINT}` | inlined (small) | — | not wrapped |
    | `{auto_commit}`, `{unit_effort}`, `{THINKING_OPUS}` | scalar | — | not wrapped |
  - Prose note: "When a mandatory-section throw reaches the orchestrator's catch path, surface it as a `scope_exceeded` blocker (existing failure taxonomy). The blocker message must include the label + actual/budget numbers for debugging."
- **Retry handler integration** — add a single sentence at the end of `### Retry Handler` (around line 441): "Retry re-dispatches MUST add an `input_tokens` field to the retry event per the Token Telemetry section — the re-dispatch is new input." This is a one-line edit to the retry section only.
- **Formatting rules:**
  - Use `###` for the section header (same level as Retry Handler and Verification Gate).
  - Use `####` for `Budgeted Section Injection` subsection.
  - Code blocks language-tagged (`js`, `json`, `bash`).
  - No emoji, no colons-in-headers stylistic deviations.
  - Keep total section length under ~160 lines (Retry Handler is 161 lines; Token Telemetry should be similar).
- **MEM015 preservation:** no edits to `skills/forge-next/SKILL.md` or `commands/forge-next.md` or `skills/forge-auto/SKILL.md` in THIS task. Those happen in T03.
- **File-shape sanity check after edit:** `grep -c "^### " shared/forge-dispatch.md` must equal `expected_count_before + 1`. Document in summary.

### Artifacts

- `shared/forge-dispatch.md` — modified. Net addition ~140–160 lines: `### Token Telemetry` section + `#### Budgeted Section Injection` subsection + 1-line edit to `### Retry Handler`. No deletions.
- `.gsd/milestones/M002/slices/S03/tasks/T02/T02-SUMMARY.md` — new file with diff-style summary: before/after line counts, new section heading check, link to worked example line numbers.

### Key Links

- `shared/forge-dispatch.md ### Token Telemetry` (new) → consumed by `skills/forge-auto/SKILL.md` Step 4 (T03) and `skills/forge-next/SKILL.md` dispatch step (T03).
- `shared/forge-dispatch.md ### Retry Handler` (existing, lines 283–441) → template for section layout.
- `scripts/forge-tokens.js` (T01 — MUST be complete before this task starts) — cited in cross-reference block and worked example.
- `scripts/forge-verify.js` (S02) — precedent for "telemetry I/O errors throw" contract.

## Steps

1. Read `shared/forge-dispatch.md` in full (currently ~520 lines). Locate the exact line numbers for: end of `### Retry Handler` (~line 444); start of `## Verification Gate` (~line 448). Insert between.
2. Read `.gsd/milestones/M002/slices/S03/tasks/T01/T01-SUMMARY.md` (if present) to confirm `scripts/forge-tokens.js` exports exactly `countTokens` and `truncateAtSectionBoundary` with the expected signatures. If T01 is not done, return `blocked` with `blocker_class: external_dependency`.
3. Read `.gsd/milestones/M002/M002-CONTEXT.md § Implementation Decisions D1, D5, D6` to cross-check the prose.
4. Read `shared/forge-dispatch.md ### Retry Handler` (lines ~283–441) to internalise the section layout. The new Token Telemetry section must mirror:
   - Purpose paragraph + MEM citation.
   - Cross-reference blockquote (`>`).
   - `#### When to apply` subsection.
   - `#### Algorithm` subsection (numbered list).
   - `#### Event log format` subsection (schema table + JSON example).
   - `#### Prefs contract` subsection (with table if useful).
   - `#### Worked example` subsection (one concrete case).
   - Final `#### Budgeted Section Injection` subsection with pseudocode + placeholder table + mandatory-section prose note.
5. Draft the section content. Cross-reference every must-have truth above in the prose. Use fenced code blocks for JSON and JS examples. Use tables for schema and placeholder classification.
6. Insert via `Edit` tool — a single multi-line insertion after the existing `### Retry Handler` block's closing `---` separator.
7. Add the one-line retry-section integration note: at the end of the Retry Handler's numbered algorithm (around step 9 or 10, after the events.jsonl append instruction), add: `> After appending the retry entry, follow the Token Telemetry section below: the retry entry MUST include an `input_tokens` field (the re-dispatch is new input).`
8. **Inline verification:**
   - `grep -c "^### " shared/forge-dispatch.md` — confirm count increased by exactly 1.
   - `grep "### Token Telemetry" shared/forge-dispatch.md` — one hit.
   - `grep "#### Budgeted Section Injection" shared/forge-dispatch.md` — one hit.
   - `grep -c "truncateAtSectionBoundary" shared/forge-dispatch.md` — at least 3 hits (pseudocode, mandatory example, placeholder table caption).
   - `node -e "process.stdout.write(require('fs').readFileSync('shared/forge-dispatch.md','utf8').match(/### Token Telemetry[\s\S]*?(?=\n### |\n## )/)[0].length.toString())"` — prints a reasonable length (target 4000–7000 chars).
9. Write `T02-SUMMARY.md` with: line-count delta, section headings check output, pointer to the new section's first line number in the current file.

## Standards

- **Target directory:** `shared/` — matches convention (`forge-dispatch.md`, `forge-mcps.md` sibling pattern). No new files in this directory (T02 is a pure edit).
- **Reuse:** Mirror the existing `### Retry Handler` section's structure verbatim for layout consistency. Do NOT invent new heading patterns. Reference `scripts/forge-tokens.js` signatures from T01 — do NOT redefine them here.
- **Naming:** Section heading `Token Telemetry` (Title Case, no punctuation, singular "Telemetry"). Subsection `Budgeted Section Injection` (Title Case). Event field names `input_tokens` / `output_tokens` (snake_case for JSON schema — matches existing `backoff_ms` in retry events; diverges intentionally from JS camelCase inside code examples).
- **Markdown style:**
  - Sentence case for prose; Title Case for headings.
  - Fenced code blocks always language-tagged.
  - Tables use left-aligned columns.
  - Blockquotes (`>`) used sparingly — one for cross-reference block only.
  - No emoji except structural indicators already in the file.
- **Language:** English (matches surrounding prose in `shared/forge-dispatch.md`).
- **Lint command:** `node -e "require('fs').readFileSync('shared/forge-dispatch.md', 'utf8').length > 5000 || process.exit(1)"` (sanity check — file not truncated) + `grep "### Token Telemetry" shared/forge-dispatch.md` (section present). No markdown linter in repo per CODING-STANDARDS.md.
- **Pattern:** `follows: Dispatch template (shared)` from `.gsd/CODING-STANDARDS.md § Pattern Catalog` — but this is not a data-flow template. It is a control-flow section using the SAME markdown layout as `### Retry Handler`. Document the deliberate mirror in the section's opening paragraph.

## Context

- **M002-CONTEXT decisions respected:** D1 (heuristic-only counting), D5 (mandatory throws, optional truncates), D6 (Hybrid C — Markdown for control-flow prose).
- **T01 dependency:** `scripts/forge-tokens.js` must exist and export `countTokens` + `truncateAtSectionBoundary`. If T01 is not complete, this task blocks.
- **S01 Retry Handler parallel:** The `### Retry Handler` section (lines 283–441) is the exact template for Token Telemetry's layout. Read it first and mirror its shape — don't reinvent structure.
- **S02 Verify Gate precedent:** telemetry I/O errors throw (no try/catch swallow). Cite this when writing the `throw on events.jsonl I/O error` prose.
- **S04 boundary awareness:** Add a one-sentence note in the Event log format table that S04 will extend the schema with `tier` and `reason` — additive, no renames. Helps S04 planners.
- **MEM011 respected:** Templates remain data-flow descriptors; Token Telemetry is control-flow (like Retry Handler). The new section lives AFTER the fenced template blocks.
- **MEM018 respected:** This edit does NOT touch `skills/forge-auto/SKILL.md` or `skills/forge-next/SKILL.md` — those token budgets are T03's concern. The `shared/forge-dispatch.md` file has no hard token budget (it's not injected whole; workers read it selectively per template).
- **Key files to read first:**
  - `shared/forge-dispatch.md` (entire file — locate insertion point)
  - `shared/forge-dispatch.md ### Retry Handler` (layout template)
  - `scripts/forge-tokens.js` (signatures to reference)
  - `.gsd/milestones/M002/M002-CONTEXT.md` (D1, D5)
  - `.gsd/CODING-STANDARDS.md § Pattern Catalog → Dispatch template (shared)`
