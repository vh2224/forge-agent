---
id: T03
slice: S04
milestone: M002
status: DONE
---

# T03: Wire Tier Resolution into `skills/forge-auto/SKILL.md`

**Slice:** S04  **Milestone:** M002

## Goal
Integrate the `### Tier Resolution` control-flow block (T02) into `skills/forge-auto/SKILL.md` so every dispatch picks a model via the tier system (not the hardcoded Phase→Agent table) and emits a `dispatch` event with `tier` and `reason` fields appended to the existing S03 schema.

## Must-Haves

### Truths
- `skills/forge-auto/SKILL.md` contains a new **Tier resolution** step in the Dispatch Loop, inserted AFTER the "Resolve effort for this unit" block (around line 149–153) and BEFORE the "Risk radar gate" block (around line 155).
- The existing model-lookup (which currently reads from the PREFS "Phase → Agent Routing" table) is replaced with `model = PREFS.tier_models[tier]`, falling back to `shared/forge-tiers.md` defaults when a tier_models key is missing.
- The existing `<!-- token-telemetry-integration -->` block (line 239 onward) is modified so the `echo ... >> events.jsonl` line (line 259) includes two new JSON fields: `"tier":"${tier}"` and `"reason":"${reason}"`. Ordering: `ts, event, unit, model, tier, reason, input_tokens, output_tokens`.
- If `unit_type == execute-task`, the resolution step shells out via `node -e "..."` to extract the `tier:` and `tag:` keys from `T##-PLAN.md` frontmatter. The regex extraction uses the YAML frontmatter key-extract idiom from `scripts/forge-verify.js` lines 420–466 (Asset Map row).
- The `reason` variable is one of these 4 literals (NO interpolation of user data): `unit-type:<unit_type>`, `frontmatter-override:<tier>`, `frontmatter-tag:docs`, `prefs-override:tier_models.<tier>` (last one is reported only when PREFS supplies a non-default for that tier).
- The patch does NOT touch forge-next (T04 handles that independently — MEM015).
- The patch preserves the existing ISOLATION RULE, AUTONOMY RULE, COMPACTION RESILIENCE, and Compact recovery check blocks unchanged.

### Artifacts
- `skills/forge-auto/SKILL.md` — modified (~+30–50 lines added; line 259 echo line extended).

### Key Links
- `skills/forge-auto/SKILL.md` → reads instructions from `shared/forge-dispatch.md ### Tier Resolution` (T02) via a pull-quote comment at the new step.
- `skills/forge-auto/SKILL.md` → reads tables from `shared/forge-tiers.md` (T01) via the same pull-quote.
- `skills/forge-auto/SKILL.md` line 259 (echo of dispatch event) — extended with `tier` + `reason` fields.

## Steps
1. Read `skills/forge-auto/SKILL.md` lines 100–280 (the entire Dispatch Loop section).
2. Read `shared/forge-dispatch.md ### Tier Resolution` (T02 output) — the algorithm numbered steps are the spec for this patch.
3. Read `shared/forge-tiers.md` (T01 output) — the canonical defaults.
4. Insert a new sub-step `#### 1.5 Resolve tier and model` between the "Resolve effort for this unit" block (ends around line 153) and the "Risk radar gate (plan-slice only)" block (starts around line 155). The new block:
   - Opens with a pull-quote pointing to `shared/forge-dispatch.md § Tier Resolution` + `shared/forge-tiers.md`.
   - Has a short bash / pseudocode block that implements the 5-step algorithm from T02, adapted to the existing orchestrator-loop shape (bash + `node -e` one-liner for frontmatter extraction — NO new script invocation).
   - Ends by storing `tier`, `model`, `reason` as loop-local variables used by Step 4 (Dispatch).
5. Update the Dispatch step (section `#### 4. Dispatch`, starting around line 192) so that `modelId` is now `$model` from step 1.5 — delete or neutralize any prior reference to "Resolve the model ID for this unit from PREFS" that reads from the Phase-routing table.
6. Modify the `<!-- token-telemetry-integration -->` block (lines 239–260):
   - Keep all existing logic.
   - Replace the existing `echo "{...}" >> .gsd/forge/events.jsonl` (line 259) with the extended version containing `"tier":"${tier}","reason":"${reason}"` inserted between `"model"` and `"input_tokens"`.
7. Run `node --check` equivalent for bash (manual): ensure the heredoc/JSON constructed via `echo` is still valid JSON after the edit. Show the final line in the T03-SUMMARY.
8. Grep to confirm no orphaned references to the old Phase-routing model lookup remain in this file.

## Standards
- **Target directory:** `skills/forge-auto/` (existing file — modification only).
- **Reuse:**
  - YAML frontmatter parsing: use the `node -e` one-liner pattern + regex idiom from `scripts/forge-verify.js` lines 420–466 (Asset Map row "YAML frontmatter key-extract (regex)"). Inline the regex — do NOT require forge-verify.
  - `events.jsonl append`: preserve the existing `mkdir -p .gsd/forge/` + `echo ... >> file` idiom (MEM036 — telemetry throws, not silent-fail; no try/catch).
  - `Skill invocation`: no new Skill calls needed here — all logic is inline bash/`node -e`.
- **Naming:** New variables are lowercase, snake_case (`tier`, `model`, `reason`, `frontmatter_tier`, `frontmatter_tag`) — matching the existing bash variables (`INPUT_TOKENS`, `OUTPUT_TOKENS`). Shell conventions allow UPPER_SNAKE for exports; keep the convention local to this file.
- **Lint command:** Manually verify the final echo line is valid JSON by piping through `node -e "JSON.parse(require('fs').readFileSync(0,'utf8'))"`. Show this smoke-test in T03-SUMMARY.
- **Pattern:** No direct catalog match — this is a targeted patch to an existing skill. However the surrounding structure follows the "Dispatch template section" Pattern Catalog row (MEM009, MEM010): absolute paths `{WORKING_DIR}/...`, `Read if exists` for optional context.

## Context
- **MEM015 (critical):** "forge-next has its own memory injection block; patch carefully." The inverse also applies here — forge-auto and forge-next are structurally divergent. T04 will patch forge-next INDEPENDENTLY; do not assume a copy-paste of this patch will apply there.
- **Existing Token Telemetry integration (S03):** `skills/forge-auto/SKILL.md` lines 239–260 already emit a `dispatch` event. This task EXTENDS that event; it does NOT add a new event type.
- **Retry Handler integration (S01):** Lines 262–278 wrap `Agent()` in a try/catch. The retry PATH already extends retry events with `input_tokens` (S03). S04 does NOT extend the retry event — keep retry entries at their S01+S03 shape (no tier/reason fields on retry events; tier is constant across retries).
- **S03 schema compatibility note** (shared/forge-dispatch.md line 497): the extension is additive only — consumers of `/forge-status` built in S03 continue to work.
- **CS_RULES reminder:** "Workers (agents) NEVER access the `Agent` tool — only the orchestrator (commands/skills that run in main context) can dispatch subagents." This file IS an orchestrator skill — `Agent` access is allowed.
- **Model IDs (from forge-agent-prefs.md lines 8–18):** `light: claude-haiku-4-5-20251001`, `standard: claude-sonnet-4-6`, `heavy: claude-opus-4-7[1m]` (fallback `claude-opus-4-6`).
