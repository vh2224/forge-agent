---
id: T04
slice: S04
milestone: M002
status: DONE
---

# T04: Wire Tier Resolution into `skills/forge-next/SKILL.md`

**Slice:** S04  **Milestone:** M002

## Goal
Integrate the `### Tier Resolution` block (T02) into `skills/forge-next/SKILL.md` — the step-mode counterpart of forge-auto — so both dispatch skills consistently pick models via the tier system. This patch is structurally different from T03 because forge-next has its own memory-injection block and its own dispatch shape (MEM015).

## Must-Haves

### Truths
- `skills/forge-next/SKILL.md` contains a tier-resolution step added in its Dispatch Loop — positioned analogously to T03's insertion point in forge-auto but respecting forge-next's actual line layout (do not assume equivalent line numbers).
- The new step uses the SAME algorithm as T02's Tier Resolution block (5 numbered steps, same precedence rules, same `reason` literals) but re-expressed in forge-next's local shape (NOT a copy-paste of T03's diff block — every edit must be justified against forge-next's actual content).
- forge-next's `dispatch` event echo line (the S03 integration in this skill) is extended with `"tier":"${tier}","reason":"${reason}"` in the same position as T03.
- The existing selective-memory-injection block unique to forge-next (line range to be discovered in Step 1 below; ROADMAP references "MEM015 reminder: forge-next has its own memory injection block; patch carefully") is preserved unchanged — the tier-resolution patch goes BEFORE or AFTER the memory injection block, never inside it.
- `model = PREFS.tier_models[tier]` is used for dispatch (not the Phase→Agent table).

### Artifacts
- `skills/forge-next/SKILL.md` — modified (~+30–50 lines added, echo line extended).

### Key Links
- `skills/forge-next/SKILL.md` → `shared/forge-dispatch.md ### Tier Resolution` (T02) via pull-quote comment.
- `skills/forge-next/SKILL.md` → `shared/forge-tiers.md` (T01) via same pull-quote.

## Steps
1. Read `skills/forge-next/SKILL.md` in full (the file is ~300 lines). Identify:
   - The Dispatch Loop boundary (roughly mirrors forge-auto's `#### 1. Derive next unit` through `#### 5. Process result`).
   - The memory-injection block specific to forge-next (the MEM015 warning in ROADMAP references lines 123–129 — verify actual location on disk).
   - The existing `dispatch` event echo line from S03 (may differ in shape from forge-auto's line 259).
2. Read `shared/forge-dispatch.md ### Tier Resolution` (T02 output).
3. Read `skills/forge-auto/SKILL.md` (T03 output) ONLY as a semantic reference — understand WHAT it does, then re-derive WHERE to put the equivalent edit in forge-next. Do NOT copy the diff verbatim.
4. Insert the tier-resolution step at the correct position in forge-next's dispatch loop — after effort resolution, before any risk/security gate or memory injection.
5. Replace forge-next's model lookup with `model = PREFS.tier_models[tier]`.
6. Extend forge-next's `dispatch` event echo line with `"tier"` and `"reason"` fields in the ordering `ts, event, unit, model, tier, reason, input_tokens, output_tokens`.
7. Verify the existing memory-injection block is byte-identical post-edit: `git diff skills/forge-next/SKILL.md` should show no changes to those lines.
8. Manual validation: run `grep -n "tier_models\[" skills/forge-next/SKILL.md` — must return ≥1 line; `grep -n '"tier"' skills/forge-next/SKILL.md` — must return the extended event line.

## Standards
- **Target directory:** `skills/forge-next/` (existing file — modification only).
- **Reuse:**
  - Same YAML-frontmatter `node -e` idiom as T03 (Asset Map "YAML frontmatter key-extract (regex)" row from `scripts/forge-verify.js` lines 420–466).
  - Same `events.jsonl append` contract (no try/catch; I/O errors throw).
- **Naming:** Local variables match T03 exactly (`tier`, `model`, `reason`, `frontmatter_tier`, `frontmatter_tag`) for grep-ability across both skills.
- **Lint command:** Same JSON-parse smoke test on the final echo line as T03.
- **Pattern:** No direct catalog match — targeted patch to an existing skill. Use T03 as semantic peer (NOT structural clone).

## Context
- **MEM015 (the governing rule for this task):** "forge-next is structurally divergent from forge-auto; patch both independently." This is the single most important constraint. Do not copy T03's diff verbatim. The memory-injection block in forge-next (boundary map references lines ~123–129) is the canonical divergence from forge-auto; keep it untouched.
- **MEM011 (control-flow vs data-flow):** Tier resolution is CONTROL flow (MEM011). It wraps `Agent()` dispatch. It does NOT live inside a data-flow template block.
- **ROADMAP S04 boundary:** "commands/forge-next.md (modified) — same Tier Resolution consumption (MEM015 reminder: forge-next has its own memory injection block; patch carefully)." Note: The ROADMAP says `commands/forge-next.md` but the actual orchestrator skill is `skills/forge-next/SKILL.md` (per MEM005 gradual migration: the command is now a shim and the logic lives in the skill). This task edits the SKILL, not the shim.
- **S03 integration:** forge-next already emits the S03 `dispatch` event. Only the line emitting it is touched — the surrounding token-telemetry pseudocode is preserved.
- **Retry Handler (S01):** forge-next's retry wrapper is preserved; no changes. Retry events are not extended with tier/reason.
- **Shim check:** If `commands/forge-next.md` turns out to still contain inline dispatch logic (not a pure shim), flag this as a blocker and escalate — the shim-migration expectation is foundational to this plan.
