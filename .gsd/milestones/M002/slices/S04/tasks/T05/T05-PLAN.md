---
id: T05
slice: S04
milestone: M002
status: DONE
---

# T05: Prefs `tier_models:` block + 5 smoke demo scenarios

**Slice:** S04  **Milestone:** M002

## Goal
Add the `tier_models:` block to `forge-agent-prefs.md` (the template file shared across all installs) so operators can re-route any tier without code changes, then run five smoke demos against a scratch milestone and capture the `events.jsonl` `dispatch` lines as proof. This is the slice's acceptance gate — all 5 ROADMAP demo scenarios must pass before T06 writes the summary.

## Must-Haves

### Truths
- `forge-agent-prefs.md` contains a new `## Tier Settings` section placed AFTER `## Retry Settings` (ends around line 141) and BEFORE `## Verification Settings` (starts around line 142).
- The section contains a `tier_models:` fenced block with exactly 3 keys and the canonical defaults: `light: claude-haiku-4-5-20251001`, `standard: claude-sonnet-4-6`, `heavy: claude-opus-4-7[1m]`.
- The section includes prose documentation (≥12 lines, ≤40 lines) explaining: (a) what the block does, (b) fallback behavior when a key is missing (→ default from `shared/forge-tiers.md`), (c) cross-references to `shared/forge-tiers.md` and `shared/forge-dispatch.md § Tier Resolution`, (d) the override precedence chain (frontmatter `tier:` > frontmatter `tag: docs` > unit_type default), (e) a note that the Phase → Agent Routing table (lines 20–34) is now DEPRECATED-for-model-selection (model field is informational; the tier block drives dispatch).
- Five smoke demo transcripts are captured (each as a short code-fenced block in T05-SUMMARY.md, or in a scratch `.gsd/milestones/M002/slices/S04/smokes/` directory — executor's choice) proving each of the 5 ROADMAP acceptance criteria. Each transcript must include:
  - The command issued (e.g. `/forge-next`).
  - The target unit type + id (e.g. `memory-extract` after a small scratch slice; or `execute-task` with a specially-crafted T##-PLAN frontmatter).
  - The resulting line in `.gsd/forge/events.jsonl` showing `event:"dispatch"`, `unit`, `model`, `tier`, `reason`.
- All 5 demos produce the expected `tier` / `model` / `reason` combination as spec'd in S04-PLAN Acceptance Criteria.

### Artifacts
- `forge-agent-prefs.md` — modified (+~20–40 lines for the new `## Tier Settings` section).
- `.gsd/milestones/M002/slices/S04/T05-DEMOS.md` (or similar evidence file) — 5 captured transcripts, one per scenario. File path is executor's choice but must be referenced by T06.

### Key Links
- `forge-agent-prefs.md ## Tier Settings` → `shared/forge-tiers.md` (T01) via inline Markdown link.
- `forge-agent-prefs.md ## Tier Settings` → `shared/forge-dispatch.md ### Tier Resolution` (T02) via inline Markdown link.
- `T05-DEMOS.md` → `.gsd/forge/events.jsonl` raw excerpts for each demo.

## Steps
1. Read `forge-agent-prefs.md` lines 118–145 (Retry Settings + Verification Settings boundary) to identify exact insertion point for the new section.
2. Read `shared/forge-tiers.md` (T01 output) — copy defaults verbatim to avoid drift.
3. Draft the `## Tier Settings` section with the fenced `tier_models:` block and prose. Insert between Retry Settings and Verification Settings.
4. Run demo 1 — **memory-extract → light/haiku:** In a scratch slice (or the current M002 state), trigger a memory-extract unit (can be simulated: STATE.md next_action points to memory-extract, then `/forge-next`). Capture the `events.jsonl` dispatch line. Expected: `"tier":"light","model":"claude-haiku-4-5-20251001","reason":"unit-type:memory-extract"`.
5. Run demo 2 — **plan-slice → heavy/opus:** Simulate via a scratch roadmap with an unplanned slice. `/forge-next` dispatches plan-slice. Expected: `"tier":"heavy","model":"claude-opus-4-7[1m]","reason":"unit-type:plan-slice"`.
6. Run demo 3 — **execute-task with `tag: docs` → light/haiku:** Construct a scratch T##-PLAN.md with `tag: docs` in frontmatter and run `/forge-next`. Expected: `"tier":"light","model":"claude-haiku-4-5-20251001","reason":"frontmatter-tag:docs"`.
7. Run demo 4 — **execute-task with BOTH `tag: docs` AND `tier: heavy` → heavy/opus:** Same scratch T##-PLAN but add `tier: heavy`. Expected: `"tier":"heavy","model":"claude-opus-4-7[1m]","reason":"frontmatter-override:heavy"`.
8. Run demo 5 — **Prefs re-route:** Edit `.gsd/claude-agent-prefs.md` (or `.gsd/prefs.local.md`) to set `tier_models.light: claude-sonnet-4-6`. Trigger a new light-tier dispatch. Expected: `"tier":"light","model":"claude-sonnet-4-6","reason":"prefs-override:tier_models.light"`. Then REVERT the pref change (this is a demo, not a permanent config change).
9. Capture all 5 events.jsonl lines in `T05-DEMOS.md` (or equivalent).
10. If any demo fails, fix the underlying skill (T03/T04) first, then re-run. Do not declare T05 done with a failing demo.

## Standards
- **Target directory:** `forge-agent-prefs.md` is at project root (template file); the `.gsd/` evidence files live under `.gsd/milestones/M002/slices/S04/`.
- **Reuse:**
  - The Retry Settings block (lines 118–141) is the closest existing prose template — mirror its structure (fenced block + prose + Cross-references).
  - The Token Budget Settings block (lines 185–211) is also a good model for prose that links to a script + dispatch section.
- **Naming:** `tier_models:` (snake_case, plural — matches `preference_commands`, `token_budget` sibling keys).
- **Lint command:** Manual — YAML-like fenced blocks in `forge-agent-prefs.md` are not strict YAML, but indentation must be 2-space consistent. Verify with `grep -n "^  " forge-agent-prefs.md` at the new block.
- **Pattern:** No direct catalog entry — but the prefs prose-plus-fenced-block style is established. Follow it.

## Context
- **M002-CONTEXT D3:** Confirms `tier_models:` is the ONLY knob operators touch; the `unit_type → tier` map is locked in `shared/forge-tiers.md`.
- **Phase → Agent Routing table (lines 20–34) is NOT deleted by this task.** It remains for informational continuity and skip-rule logic. But the "Model ID" column of that table is no longer the source of truth for dispatch — the tier block is. Document this clearly in the new section prose.
- **MEM015 acceptance:** Demos must run end-to-end — both /forge-auto and /forge-next should be exercised (Demo 5 ideally tests the pref-reload via whichever skill is most convenient, documented in the transcript).
- **Model ID fallback:** If `claude-opus-4-7[1m]` is not available in the tester's account (see forge-agent-prefs.md line 18 "Fallback automático"), heavy dispatches may resolve to `claude-opus-4-6`. That's fine — document which model was used and why.
- **Events.jsonl write contract:** `scripts/forge-verify.js` lines 479–493 is the canonical append idiom. No try/catch (MEM036 telemetry-throws variant). The dispatch line must be valid JSON — run through `node -e "JSON.parse(require('fs').readFileSync(0,'utf8'))"` as a smoke check.
- **If demo environment cannot actually invoke Agent():** Demos may use STUBBED Agent() responses (documented as "stubbed for smoke — actual dispatch not performed"). What must be real is the tier-resolution code path + the event line written to events.jsonl. This is acceptable because the acceptance criteria all reduce to "what shape does the event line have?" — not "did the agent produce useful output?".
