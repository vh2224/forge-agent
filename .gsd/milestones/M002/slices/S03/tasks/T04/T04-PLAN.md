# T04: Render Token usage block in `/forge-status` skill

**Slice:** S03  **Milestone:** M002

## Goal

Extend `skills/forge-status/SKILL.md` so the `/forge-status` dashboard
includes a **Token usage** section that reads `.gsd/forge/events.jsonl`,
filters `event:"dispatch"` lines associated with the active milestone
(by matching the `unit` field's `unit_type/unit_id` against STATE.md's
current milestone/slice scope), sums `input_tokens` and `output_tokens`,
and breaks down dispatches by phase (unit_type). Output is pt-BR per
project convention. Graceful degradation: when no dispatch events exist
yet, the section prints `Sem dados de telemetria ainda.` instead of
erroring.

## Must-Haves

### Truths

- **Section placement:** New `### Token usage` subsection is inserted
  into the dashboard template in `skills/forge-status/SKILL.md` —
  immediately BEFORE the `### Blockers` section (so: Slices →
  Próxima ação → Token usage → Blockers → Tasks autônomas).
- **Data source:** `.gsd/forge/events.jsonl`. Filter lines where:
  - Line parses as valid JSON (skip malformed lines silently).
  - `event === "dispatch"`.
  - Unit's implied milestone matches the active milestone from STATE.md.
    - Matching strategy: parse `unit` as `"{unit_type}/{unit_id}"`. For
      unit_type in `{plan-milestone, complete-milestone, discuss-milestone, research-milestone}`, the `unit_id` is the milestone ID (e.g. `plan-milestone/M002`) — direct match.
    - For `{plan-slice, complete-slice, discuss-slice, research-slice}`, the `unit_id` is `S##` — match by reading the `M###-ROADMAP.md` of the active milestone and confirming the slice is listed.
    - For `execute-task`, the `unit_id` is `T##` — match by reading the active slice's `S##-PLAN.md` task list.
    - Simplification allowed: if `unit` does NOT include an M###, derive membership by "any event after the ISO8601 timestamp of the milestone's first dispatch" (best-effort). Document the chosen strategy in the skill prose.
  - `memory-extract` events (unit_type `memory-extract`) count as in-milestone when the timestamp falls between the milestone's first and last recorded dispatch times.
- **Aggregation:**
  - `total_input` = sum of `input_tokens` across matching lines.
  - `total_output` = sum of `output_tokens` across matching lines.
  - `dispatches` = count of matching lines.
  - `by_phase` = object mapping `unit_type → count`. Preserve the dispatch-table order from `skills/forge-auto/SKILL.md` for display: plan-milestone, discuss-milestone, research-milestone, plan-slice, discuss-slice, research-slice, execute-task, complete-slice, complete-milestone, memory-extract.
- **Output format (pt-BR):**
  ```
  ### Token usage (M###)
  - Total input:  12 345 tokens
  - Total output:  3 421 tokens
  - Dispatches:   18 (por fase: plan-slice 2 · execute-task 14 · complete-slice 2)
  ```
  - Numbers: thousands separator is the thin non-breaking space (U+202F or regular space — either acceptable; pick ONE and document).
  - Alignment: use consistent padding so "Total input" / "Total output" / "Dispatches" labels line up. Acceptable: Markdown list items with leading pad via `<code>` or plain spaces — simple plain-space alignment is preferred.
  - `por fase:` list: only include phases with count > 0. Separator is ` · ` (middle dot with spaces) per existing skill prose style.
- **Graceful-degradation branches:**
  - `.gsd/forge/events.jsonl` does not exist → print `Sem dados de telemetria ainda.` (pt-BR, period-terminated).
  - File exists but no matching dispatch lines for active milestone → same `Sem dados de telemetria ainda.` message.
  - File exists with malformed lines → skip the malformed line(s), continue aggregation on the rest. Do NOT crash on parse errors.
- **No active milestone:** If STATE.md has no active milestone, omit the entire Token usage section (do not print it empty). Matches existing `Slices` section behaviour when no milestone is active.
- **Implementation approach:** Use `node scripts/forge-tokens.js` for any re-aggregation help IF useful; primary implementation is a short `node -e` one-liner or a dedicated `node scripts/forge-tokens.js --aggregate events` flag. PICK ONE path:
  - **Path A (preferred):** Aggregation logic lives inline in the skill as a short `node -e "..."` block reading `.gsd/forge/events.jsonl` directly. Rationale: simpler, no new CLI surface, keeps `forge-tokens.js` single-purpose.
  - **Path B (alternative):** Extend `scripts/forge-tokens.js` with a `--aggregate <path>` flag that reads events.jsonl, filters, and prints a JSON summary. Skill shells out to this.
  - Choose Path A unless the `node -e` block exceeds ~25 lines (MEM042 — deterministic CLIs beat inline shell when data has structure). Document the choice in the summary.
- **pt-BR language consistency:** User-visible strings pt-BR (`Sem dados de telemetria ainda.`, `por fase:`, section heading `Token usage`). Code comments English per project convention.
- **MEM018 budget:** `skills/forge-status/SKILL.md` post-patch token count must stay <= 2500 tokens (current baseline ~1200; generous +1300 budget because the skill is small). Verify with `node scripts/forge-tokens.js --file skills/forge-status/SKILL.md`.
- **No edits to:**
  - Any other skill file.
  - `shared/forge-dispatch.md`.
  - `forge-agent-prefs.md`.
  - Any agent file.
  - `scripts/forge-tokens.js` (T01 is frozen; Path B is a fallback only if Path A fails the line-count check).

### Artifacts

- `skills/forge-status/SKILL.md` — modified. Net add ~20–40 lines depending on path chosen. At most 1 unchanged anchor line edited (to insert the new subsection).
- `.gsd/milestones/M002/slices/S03/tasks/T04/T04-SUMMARY.md` — new file with:
  - Diff summary (line count before/after).
  - Grep confirmation of `### Token usage` and `Sem dados de telemetria ainda.` in the file.
  - Smoke test evidence: capture of `/forge-status` output with a hand-crafted `events.jsonl` containing 3 sample dispatch events.
  - Path-chosen justification (A vs B).
  - Token count check for `skills/forge-status/SKILL.md`.

### Key Links

- `skills/forge-status/SKILL.md` — target for edit.
- `.gsd/forge/events.jsonl` — data source at runtime.
- `shared/forge-dispatch.md ### Token Telemetry` (T02) — event schema authority.
- `scripts/forge-tokens.js` (T01) — Path B fallback only.
- `.gsd/STATE.md` — active-milestone source of truth.

## Steps

1. Prereq check: confirm T01 and T02 are done (T03 is NOT a blocker — we can wire rendering before dispatch emission is live; the section renders "Sem dados" gracefully).
   - `test -f scripts/forge-tokens.js && echo T01-OK || echo T01-MISSING`
   - `grep "### Token Telemetry" shared/forge-dispatch.md && echo T02-OK || echo T02-MISSING`
2. Read `skills/forge-status/SKILL.md` in full (currently ~79 lines). Identify:
   - The dashboard template block (lines ~50–77 in the existing file).
   - The exact insertion point (immediately before `### Blockers`).
   - Any existing token-related text (there should be none — confirm via grep).
3. Read `.gsd/STATE.md` to understand the active-milestone detection pattern used by the existing skill.
4. Read `shared/forge-dispatch.md ### Token Telemetry` — confirm event schema is exactly `{ts, event:"dispatch", unit, model, input_tokens, output_tokens}` with optional future `tier, reason` extensions (S04). The aggregator must tolerate unknown extra fields (ignore them).
5. Decide aggregation path (A or B). Default to A.
6. Draft Path A:
   - Insert a new `### Token usage` subsection into the template block.
   - Add a paragraph-length bash/node snippet that:
     ```bash
     if [ -f .gsd/forge/events.jsonl ]; then
       node -e "
         const fs=require('fs');
         const lines=fs.readFileSync('.gsd/forge/events.jsonl','utf8').trim().split('\n');
         const state=fs.readFileSync('.gsd/STATE.md','utf8');
         const mm=state.match(/M\d{3}/);
         const activeM = mm ? mm[0] : null;
         if (!activeM) { console.log('(no active milestone)'); process.exit(0); }
         // ... aggregation logic ...
         // filter dispatch events, match by unit_id OR by unit naming M### directly
         // print pt-BR block
       " >> /tmp/forge-status-tokens.txt 2>/dev/null
     else
       echo 'Sem dados de telemetria ainda.'
     fi
     ```
     Keep the `node -e` body < 25 lines; if longer, switch to Path B.
   - Alternative simpler prose: delegate to `node scripts/forge-tokens.js --aggregate .gsd/forge/events.jsonl --milestone M###` (Path B) and parse its output. If Path B chosen, T04 also adds that flag to `scripts/forge-tokens.js`.
7. Insert the draft into `skills/forge-status/SKILL.md` immediately BEFORE the `### Blockers` section.
8. Add the pt-BR graceful-degradation prose: `Sem dados de telemetria ainda.` in both no-file and empty-file branches.
9. Inline verification:
   - `grep "### Token usage" skills/forge-status/SKILL.md` → 1 hit.
   - `grep "Sem dados de telemetria" skills/forge-status/SKILL.md` → 1 hit.
   - `grep "por fase:" skills/forge-status/SKILL.md` → 1 hit.
   - `node scripts/forge-tokens.js --file skills/forge-status/SKILL.md` → tokens < 2500.
   - `node -c scripts/forge-tokens.js` → still passes (ensures T01 script is intact).
10. **Smoke test with hand-crafted events:**
    - Back up existing events.jsonl if any: `cp .gsd/forge/events.jsonl /tmp/events.jsonl.bak 2>/dev/null`
    - Create 3 fabricated lines in a temp file:
      ```
      {"ts":"2026-04-16T10:00:00Z","event":"dispatch","unit":"plan-slice/S03","model":"claude-opus-4-7","input_tokens":1200,"output_tokens":400}
      {"ts":"2026-04-16T10:05:00Z","event":"dispatch","unit":"execute-task/T01","model":"claude-sonnet-4-6","input_tokens":3200,"output_tokens":800}
      {"ts":"2026-04-16T10:10:00Z","event":"dispatch","unit":"execute-task/T02","model":"claude-sonnet-4-6","input_tokens":2400,"output_tokens":600}
      ```
    - Append to (or create) `.gsd/forge/events.jsonl`.
    - Simulate the skill's aggregation block standalone (run just the `node -e` snippet) and capture output.
    - Expected output (approximate):
      ```
      ### Token usage (M002)
      - Total input:   6 800 tokens
      - Total output:  1 800 tokens
      - Dispatches:    3 (por fase: plan-slice 1 · execute-task 2)
      ```
    - Restore backup: `mv /tmp/events.jsonl.bak .gsd/forge/events.jsonl 2>/dev/null || rm .gsd/forge/events.jsonl`
    - Capture the full output in `T04-SUMMARY.md`.
11. Write `T04-SUMMARY.md` with diff summary, grep output, smoke test transcript, and path justification.

## Standards

- **Target directory:** `skills/forge-status/` — single-file `SKILL.md` per skill convention.
- **Reuse:**
  - `scripts/forge-tokens.js` (T01) — invoked ONLY if Path B is chosen; otherwise aggregation inlined.
  - Existing `skills/forge-status/SKILL.md` dashboard template (lines ~50–77) — insert into, don't replace.
  - `.gsd/forge/events.jsonl` append pattern from `events.jsonl append pattern` asset.
  - Existing skill conventions: bootstrap guard, `$ARGUMENTS` footer preservation, `Read these files in order` narrative style.
- **Naming:**
  - Section heading: `Token usage` — Title Case, no punctuation, matches surrounding `Slices`, `Próxima ação`, `Blockers`, `Tasks autônomas` style (MIX — existing headings use Title Case AND Sentence Case).
  - JSON field names already fixed by T02: `input_tokens`, `output_tokens`, `event`, `unit`, `ts`, `model`.
  - Temp file for smoke: `/tmp/forge-status-tokens.txt` or `C:/temp/...` on Windows.
- **Language:** pt-BR for all user-visible strings (matches existing skill prose). English for code comments, JSON field names, and shell variable names.
- **Markdown style:** match existing skill dashboard template — Markdown list items with `- ` prefix, inline backticks for code references, fenced ```bash blocks for shell logic.
- **Lint command:**
  - `node -c scripts/forge-tokens.js` (sanity).
  - `node scripts/forge-tokens.js --file skills/forge-status/SKILL.md` (budget check).
  - `grep "Token usage" skills/forge-status/SKILL.md` (section present).
- **Pattern:** `follows: Skill frontmatter + body` from `.gsd/CODING-STANDARDS.md § Pattern Catalog` — skill is auto-sufficient, reads its own files, produces a dashboard. The new Token usage subsection is additive.

## Context

- **T01/T02 dependencies:** script must exist; event schema must be documented. T03 is NOT a hard dependency — this skill can render "no data yet" even before dispatch emission is live (graceful degradation is a must-have).
- **MEM042 respected:** aggregation uses deterministic Node evaluation (either `node -e` inline or `node scripts/forge-tokens.js`); no awk/sed/jq pipelines when data has JSON structure.
- **MEM018 respected:** skill file stays under 2500 tokens post-patch (generous budget; current baseline ~1200).
- **S04 boundary awareness:** the aggregator must tolerate unknown extra fields in dispatch events (S04 adds `tier` and `reason`). Design: filter by known fields (`event === "dispatch"`), use `input_tokens`/`output_tokens` by name, ignore extras.
- **Active-milestone matching quirk:** some unit_ids are only `S##` or `T##` — not `M###`. Simplification allowed: assume any dispatch in the jsonl for the window from STATE.md's milestone-start timestamp onward belongs to the active milestone. Document the choice in the skill prose as a comment.
- **Key files to read first:**
  - `skills/forge-status/SKILL.md` (existing template — insertion point)
  - `.gsd/STATE.md` (active-milestone detection)
  - `shared/forge-dispatch.md ### Token Telemetry` (event schema authority)
  - `scripts/forge-tokens.js` (fallback for Path B)
  - `.gsd/CODING-STANDARDS.md § Pattern Catalog → Skill frontmatter + body`
