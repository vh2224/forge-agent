---
id: S04
milestone: M002
status: ready
planned_at: 2026-04-16
depends: [S01, S03]
risk: medium
---

# S04 — Complexity classifier + tier-only model router

**Approach:** Hybrid C — pure Markdown reference doc (`shared/forge-tiers.md`) + inline control-flow block in `shared/forge-dispatch.md` + consumption in both dispatch skills. No new Node script (per M002-CONTEXT decision: the tier classifier is heuristic/regex-level and belongs in the `### Tier Resolution` Markdown block, sibling to `### Retry Handler` and `### Token Telemetry`).

**Sequencing:** T01 → T02 → (T03 ‖ T04) → T05 → T06. T03 and T04 are independent and touch different files; they can run in either order. T05 is the smoke/demo gate; T06 is the summary.

---

## Goal

Port GSD-2's tier-only complexity classifier into Forge so every dispatch picks a model from a `tier_models:` table instead of the hardcoded Phase→Agent routing. Light tier (Haiku) for memory-extract / complete-slice / run-uat; standard (Sonnet) for execute-task / research / discuss; heavy (Opus) for plan-milestone / plan-slice / replan. Frontmatter on `T##-PLAN.md` can (a) downgrade to light via `tag: docs`, (b) force any tier via `tier: heavy|standard|light`. Every dispatch logs `{tier, model, reason}` to `events.jsonl` by extending the existing S03 `dispatch` event schema (additive — no field renames). Operator can re-route an entire tier by editing `tier_models.<tier>` in `claude-agent-prefs.md` without touching code.

---

## Tasks

- [ ] **T01: Create `shared/forge-tiers.md` reference** `risk:low`
  Canonical mapping `unit_type → tier`, `tier → default_model`, override precedence, and `tag: docs` downgrade rule. Pure reference doc — no script. Consumed as a `Read if exists` directive by the Tier Resolution block.

- [ ] **T02: Add `### Tier Resolution` control-flow block to `shared/forge-dispatch.md`** `risk:medium` `depends:[T01]`
  New section after `### Token Telemetry`, following the Dispatch control-flow pattern (MEM011): Purpose → Cross-reference → When to apply → Algorithm (5 numbered steps) → Prefs contract → Frontmatter override table → Event extension spec → Worked examples (3). Extends the S03 `dispatch` event with `tier` and `reason` fields (additive, per S03 S04-extension-note).

- [ ] **T03: Wire Tier Resolution into `skills/forge-auto/SKILL.md`** `risk:medium` `depends:[T02]`
  Insert a resolution step between "Resolve effort" and "Dispatch table model lookup". Replace the hardcoded PREFS Phase-routing model lookup with `model = PREFS.tier_models[tier]`. Extend the dispatch event line (already emitted in the `<!-- token-telemetry-integration -->` block) with `tier` and `reason` fields.

- [ ] **T04: Wire Tier Resolution into `skills/forge-next/SKILL.md`** `risk:medium` `depends:[T02]`
  Same integration as T03, respecting forge-next's structurally-divergent dispatch shape (MEM015: patch both skills independently — do NOT copy-paste T03's diff). Preserve the step-mode-only selective memory injection block unique to forge-next (MEM011).

- [ ] **T05: Prefs block + smoke demos** `risk:low` `depends:[T03, T04]`
  Add `tier_models:` block to `forge-agent-prefs.md` with defaults `light: claude-haiku-4-5-20251001`, `standard: claude-sonnet-4-6`, `heavy: claude-opus-4-7[1m]` + documentation cross-linking `shared/forge-tiers.md`. Run 5 demo scenarios against a scratch milestone (memory-extract → haiku, plan-slice → opus, execute-task with `tag: docs` → haiku, execute-task with `tier: heavy` → opus regardless of tags, change `tier_models.light` → Sonnet in prefs → next memory-extract dispatch uses Sonnet). Capture each transcript's `events.jsonl` dispatch line showing `tier`, `model`, `reason` in the SUMMARY.

- [ ] **T06: Write S04-SUMMARY.md** `risk:low` `depends:[T05]`
  Consolidate all 5 demo transcripts, artifact paths, and lessons learned. Close the slice.

---

## Acceptance Criteria (demo from ROADMAP)

1. `memory-extract` unit dispatches at `light` tier (Haiku). Verified via `events.jsonl` line `{..."event":"dispatch","tier":"light","model":"claude-haiku-4-5-20251001","reason":"unit-type:memory-extract"}`.
2. `plan-slice` unit dispatches at `heavy` tier (Opus). Verified via `events.jsonl` dispatch line with `tier:"heavy"`.
3. `execute-task` with `tag: docs` in T##-PLAN frontmatter dispatches at `light` tier. Verified via dispatch line with `reason:"frontmatter-tag:docs"` and `model:"claude-haiku-4-5-20251001"`.
4. `execute-task` with `tier: heavy` override in frontmatter dispatches at `heavy` regardless of tags. Verified via dispatch line with `reason:"frontmatter-override:heavy"` and `model:"claude-opus-4-7[1m]"`. Override precedence is documented in both `shared/forge-tiers.md` and the Algorithm block.
5. Changing `tier_models.light` from Haiku to Sonnet in `claude-agent-prefs.md` re-routes the NEXT light dispatch to Sonnet without code edits. Verified by editing the prefs file, running `/forge-next`, observing a new dispatch line with `tier:"light","model":"claude-sonnet-4-6"`.

---

## Boundary Map — S04 (recap from ROADMAP)

**Produces:**
- `shared/forge-tiers.md` (new)
- `shared/forge-dispatch.md` (modified — new `### Tier Resolution` section + extended `dispatch` event schema)
- `skills/forge-auto/SKILL.md` (modified — tier resolution + model lookup replacement + event extension)
- `skills/forge-next/SKILL.md` (modified — same integration)
- `forge-agent-prefs.md` (modified — new `tier_models:` block)
- `CLAUDE.md` (modified — new decision entry)
- `.gsd/milestones/M002/slices/S04/S04-SUMMARY.md` (new)

**Consumes:**
- `scripts/forge-classify-error.js` (S01) — already wrapped around every `Agent()`; no changes needed. Retry path keeps same tier by design (budget-pressure escalation is OUT of scope for M002).
- `scripts/forge-tokens.js` (S03) — no changes; extended `dispatch` event reuses existing append path.
- `shared/forge-dispatch.md ### Token Telemetry` (S03) — event extended in place, not replaced.

---

## Risks

- **R1 — MEM015 divergence:** forge-auto and forge-next have structurally different dispatch blocks. Pasting the same diff into both breaks something. Mitigation: T03 and T04 are separate tasks; each must re-read the surrounding block before inserting the resolution step.
- **R2 — Schema drift:** The `dispatch` event line is emitted from bash in the current T03 (S03) integration (`echo "..." >> events.jsonl`). Adding `tier` and `reason` requires careful JSON escaping. Mitigation: T03/T04 must show the exact updated echo line; T05 grep-verifies the line parses as JSON.
- **R3 — Override precedence ambiguity:** Three signals can conflict (unit_type default, `tag: docs`, `tier:` frontmatter). Mitigation: T01 locks precedence (manual `tier:` > `tag: docs` downgrade > unit_type default), codified as a numbered list in both `shared/forge-tiers.md` and the Algorithm block of `### Tier Resolution`.
- **R4 — Model ID drift:** Prefs may pin model IDs that no longer exist (e.g. `claude-opus-4-7[1m]` fallback to `claude-opus-4-6`). Mitigation: Tier Resolution does NOT validate model existence — it trusts PREFS. If dispatch fails due to unknown-model, existing error classifier (S01) surfaces it as `permanent`, which fails cleanly and is user-visible. Documented in T02 Algorithm step 5.

---

## Out of scope

- Adaptive learning from routing history (no baseline telemetry yet).
- Budget pressure downgrade (Forge has no per-milestone budget).
- `escalateTier()` helper for retry-on-failure model-bumping.
- Capability scoring / 7-dim classifier.
- Cross-provider routing.
