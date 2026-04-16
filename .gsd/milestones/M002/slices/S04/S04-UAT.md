# S04: Complexity Classifier + Tier-Only Model Router — UAT Script

**Slice:** S04  **Milestone:** M002  **Written:** 2026-04-16

---

## Prerequisites

- `shared/forge-tiers.md` exists in the repo root's `shared/` directory.
- `shared/forge-dispatch.md` contains a `### Tier Resolution` section (after `### Token Telemetry`).
- `skills/forge-auto/SKILL.md` and `skills/forge-next/SKILL.md` each contain a step 1.5 tier resolution block.
- `forge-agent-prefs.md` contains a `## Tier Settings` section with a `tier_models:` YAML block.
- `.gsd/forge/events.jsonl` is writable.
- Node.js is available on `PATH` (`node --version` succeeds).

---

## Test Cases

| # | Action | Expected | Pass? |
|---|--------|----------|-------|
| TC-01 | Open `shared/forge-tiers.md`. Verify the **Unit Type → Default Tier** table has exactly 10 rows covering: `memory-extract`, `complete-slice`, `complete-milestone`, `research-milestone`, `research-slice`, `discuss-milestone`, `discuss-slice`, `execute-task`, `plan-milestone`, `plan-slice`. | All 10 unit types present; `memory-extract`, `complete-slice`, `complete-milestone` are `light`; `execute-task`, research-*, discuss-* are `standard`; plan-* are `heavy`. | |
| TC-02 | In `shared/forge-tiers.md`, find the **Override Precedence** section. Confirm it is a numbered list with 3 items, highest precedence first. | Item 1 = `tier:` frontmatter; Item 2 = `tag: docs` downgrade; Item 3 = unit-type default. | |
| TC-03 | Open `shared/forge-dispatch.md`. Search for `### Tier Resolution`. Confirm it appears after `### Token Telemetry` and before `## Verification Gate`. | Section exists in the correct position. Contains subsections: Purpose, Cross-reference, When to apply, Algorithm (5 numbered steps), Prefs contract, Frontmatter override table, Event log extension, Worked examples (3), Wiring snippet. | |
| TC-04 | In `shared/forge-dispatch.md § Tier Resolution`, read the dispatch event schema extension. Confirm `tier` and `reason` fields are listed as additions to the existing S03 `dispatch` event. Confirm a compatibility note states that S03 readers ignoring unknown fields remain valid. | `tier` and `reason` fields documented as additive; compatibility paragraph present. | |
| TC-05 | Open `skills/forge-auto/SKILL.md`. Search for `Tier resolution (step 1.5)`. Confirm the block: (a) appears between "Resolve effort for this unit" and the Risk radar gate, (b) declares a `TIER_DEFAULTS` map covering all 10 unit types, (c) contains two `node -e` one-liners for extracting `tier:` and `tag:` from T##-PLAN frontmatter. | Block exists in the correct position. All 10 unit types in TIER_DEFAULTS. Both node -e one-liners present. | |
| TC-06 | In `skills/forge-auto/SKILL.md`, find the dispatch event echo line (`echo "..."`) that appends to `events.jsonl`. Confirm it contains `"tier":"${TIER}"` and `"reason":"${REASON}"` between `model` and `input_tokens`. | Both fields present in the correct schema ordering: ts → event → unit → model → tier → reason → input_tokens → output_tokens. | |
| TC-07 | Open `skills/forge-next/SKILL.md`. Search for `Tier resolution (step 1.5)`. Confirm it exists in the same semantic position as forge-auto (after effort resolution, before risk/security gates). | Block found. Positioned after effort resolution and before risk/security gates. | |
| TC-08 | In `skills/forge-next/SKILL.md`, search for `Selective memory injection`. Confirm the block is present and intact (not relocated or deleted). Note its line number — it should appear after the tier resolution block. | Selective memory injection block exists. It is not byte-modified and appears after the tier resolution block. | |
| TC-09 | Open `forge-agent-prefs.md`. Find `## Tier Settings`. Confirm: (a) it appears between `## Retry Settings` and `## Verification Settings`, (b) a fenced `tier_models:` block is present with keys `light`, `standard`, `heavy`, (c) model IDs match `shared/forge-tiers.md` defaults: haiku / sonnet / opus. | Section found in correct position. All 3 tier keys present. Model IDs match `shared/forge-tiers.md`. | |
| TC-10 | In `forge-agent-prefs.md § Tier Settings`, confirm: (a) a deprecation note on the old Phase → Agent Routing table is present, (b) cross-references to `shared/forge-tiers.md` and `shared/forge-dispatch.md § Tier Resolution` are present. | Deprecation note present. Both cross-references present. | |
| TC-11 | Run the AC1 smoke: execute the Node.js tier-resolution algorithm from `shared/forge-dispatch.md § Tier Resolution` for `unit_type = memory-extract` with no frontmatter overrides and default prefs. Confirm output is `{tier:"light", model:"claude-haiku-4-5-20251001", reason:"unit-type:memory-extract"}`. | tier=light, model=haiku, reason=unit-type:memory-extract. | |
| TC-12 | Run the AC2 smoke: same algorithm for `unit_type = plan-slice`. Confirm `{tier:"heavy", model:"claude-opus-4-7[1m]", reason:"unit-type:plan-slice"}`. | tier=heavy, model=opus, reason=unit-type:plan-slice. | |
| TC-13 | Run the AC3 smoke: `unit_type = execute-task`, T##-PLAN frontmatter contains `tag: docs`, no `tier:` field. Confirm output is `{tier:"light", reason:"frontmatter-tag:docs", model:"claude-haiku-4-5-20251001"}`. | tier=light, reason=frontmatter-tag:docs, model=haiku. | |
| TC-14 | Run the AC4 smoke: `unit_type = execute-task`, frontmatter contains both `tier: heavy` and `tag: docs`. Confirm `tier:` wins: `{tier:"heavy", reason:"frontmatter-override:heavy", model:"claude-opus-4-7[1m]"}`. | tier=heavy, reason=frontmatter-override:heavy, model=opus. `tag: docs` is ignored. | |
| TC-15 | Run the AC5 smoke: temporarily change `tier_models.light` in `forge-agent-prefs.md` from `claude-haiku-4-5-20251001` to `claude-sonnet-4-6`. Re-run AC1 scenario (`memory-extract`). Confirm `{tier:"light", model:"claude-sonnet-4-6", reason:"unit-type:memory-extract"}`. Revert the prefs change after. | model=sonnet (not haiku) with no code changes. Prefs override takes effect immediately on next resolution. | |
| TC-16 | Open `.gsd/forge/events.jsonl`. Find any 5 dispatch events produced by the S04 smoke demos. Confirm each line: (a) is valid JSON (`JSON.parse` succeeds), (b) contains `"event":"dispatch"`, (c) contains `"tier"` and `"reason"` fields. | 5 lines found. All parse as JSON. All have `event`, `tier`, `reason`. | |

---

## Notes

- TC-11 through TC-15 can be validated by inspecting the S04-SUMMARY.md demo transcripts (`## Demo transcripts` section) rather than re-running the Node.js resolution script, if a live environment is unavailable.
- TC-16 accepts the stubbed `events.jsonl` lines appended by T05 — they are JSON-valid and structurally representative.
- All 5 acceptance criteria from `S04-PLAN.md` map 1:1 to TC-11 through TC-15.
- MEM015 preservation (TC-08) is critical — the selective memory injection block is unique to `forge-next` and must not be removed or relocated.
