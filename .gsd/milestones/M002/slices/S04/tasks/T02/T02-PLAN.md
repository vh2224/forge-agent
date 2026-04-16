---
id: T02
slice: S04
milestone: M002
status: DONE
---

# T02: Add `### Tier Resolution` control-flow block to `shared/forge-dispatch.md`

**Slice:** S04  **Milestone:** M002

## Goal
Insert a new `### Tier Resolution` section into `shared/forge-dispatch.md` — sibling to `### Retry Handler` and `### Token Telemetry` — that specifies how the orchestrator resolves `unit_type + frontmatter + prefs → {tier, model, reason}` before every dispatch, and how the S03 `dispatch` event schema extends (additively) with `tier` and `reason` fields.

## Must-Haves

### Truths
- `shared/forge-dispatch.md` contains a new `### Tier Resolution` heading placed AFTER `### Token Telemetry` (after line 566 — the `---` separator at the end of Token Telemetry) and BEFORE `## Verification Gate` (line 568).
- The new section follows the 8-subsection pattern defined in CODING-STANDARDS "Pattern Catalog → Dispatch control-flow section": Purpose → Cross-reference pull-quote → When to apply → Algorithm (numbered) → Prefs contract → (Frontmatter override table) → Event log extension → Worked examples (2–3) → Wiring snippet.
- The Algorithm lists exactly 5 numbered steps: (1) look up `unit_type` default in `shared/forge-tiers.md`, (2) if `unit_type == execute-task`, parse T##-PLAN frontmatter for `tier:` and `tag:`, (3) apply precedence rules (manual `tier:` > `tag:docs` downgrade > default), (4) resolve `model = PREFS.tier_models[tier]` with fallback to the default model for that tier from `shared/forge-tiers.md`, (5) build `reason` string (one of: `unit-type:<type>`, `frontmatter-override:<tier>`, `frontmatter-tag:docs`, `prefs-override:tier_models.<tier>`).
- The Event log extension subsection shows the updated `dispatch` event JSON with the new `tier` and `reason` fields appended to the S03 schema (additive — no rename, no removal). Includes a short "Compatibility" paragraph stating that existing S03 readers that ignore unknown fields continue to work.
- The Frontmatter override table lists exactly 2 rows: `tier:` (enum `light | standard | heavy`, takes precedence over everything) and `tag:` (string; only `docs` triggers a tier change — forces light, overridable by `tier:`).
- The Wiring snippet provides a 5–10 line `bash`/pseudocode block that skill implementations (T03/T04) can copy-paste-adapt, using `node -e` for frontmatter regex extraction — NO new Node script.
- At least 2 worked examples: (a) `memory-extract` unit → tier=light, model=haiku, reason="unit-type:memory-extract", (b) `execute-task` with `tier: heavy` and `tag: docs` in frontmatter → tier=heavy (manual wins), model=opus, reason="frontmatter-override:heavy".
- A third worked example showing `execute-task` with ONLY `tag: docs` → tier=light (downgrade applied).

### Artifacts
- `shared/forge-dispatch.md` — modified (+~180–230 lines, new `### Tier Resolution` section).

### Key Links
- `shared/forge-dispatch.md ### Tier Resolution` → `shared/forge-tiers.md` (T01) via inline Markdown link.
- `shared/forge-dispatch.md ### Tier Resolution` → `scripts/forge-classify-error.js` mentioned in cross-reference (retry path preserves same tier by default).
- `shared/forge-dispatch.md ### Token Telemetry` (lines 452–566) → linked as "Event log schema extended here (additive)".

## Steps
1. Read `shared/forge-dispatch.md` lines 289–446 (`### Retry Handler`) and lines 452–566 (`### Token Telemetry`) as structural templates.
2. Read `shared/forge-tiers.md` (produced by T01) for the canonical tables — cross-link, do NOT duplicate content.
3. Draft the new section in-place, inserted between line 566 and line 568. Sections:
   - **Heading:** `### Tier Resolution`
   - **Purpose paragraph** (~4 lines): explain that this is a control-flow section, not data-flow (MEM011); it runs before every `Agent()` call; it extends the S03 `dispatch` event schema additively; no new Node script — pure Markdown + a `node -e` one-liner for frontmatter extraction.
   - **Cross-reference pull-quote:** `> **Cross-reference:** Canonical tier tables — see \`shared/forge-tiers.md\`. Override precedence and `tag: docs` semantics locked in that file.`
   - **When to apply:** one-paragraph — "Before every `Agent()` dispatch, after Retry Handler setup but before Token Telemetry's `input_tokens` computation (so the dispatch event has tier + tokens in one line)."
   - **Algorithm:** 5 numbered steps as spec'd above. Include short fenced `bash` or pseudocode blocks inline for steps 2 (frontmatter parse) and 4 (prefs lookup).
   - **Prefs contract:** short table describing `tier_models.light | .standard | .heavy` with defaults and `missing-key` fallback (same `shared/forge-tiers.md` defaults).
   - **Frontmatter override table:** 2 rows as spec'd above.
   - **Event log extension:** fenced JSON showing the extended `dispatch` event with `tier` and `reason` fields appended. Short "Compatibility" paragraph.
   - **Worked examples:** 3 labeled cases (memory-extract, execute-task-with-tier-heavy-and-tag-docs, execute-task-with-only-tag-docs).
   - **Wiring snippet:** pseudocode / bash block (≤20 lines) showing: (a) read `T##-PLAN.md` frontmatter if `unit_type == execute-task`, (b) resolve tier via precedence, (c) `model=$(node -e "process.stdout.write(prefs.tier_models['$tier'] || default)")`, (d) extend the `echo ... >> events.jsonl` line (from forge-auto line 259) with `,"tier":"$tier","reason":"$reason"`.
4. Verify that the entire file still parses as Markdown (no broken table rows, no duplicate headings, no orphaned code fences).
5. Run `grep -n "### Tier Resolution" shared/forge-dispatch.md` — must return exactly one line.

## Standards
- **Target directory:** `shared/` (existing file — modification only).
- **Reuse:** Follow the Dispatch control-flow section pattern from CODING-STANDARDS Pattern Catalog exactly: use the 8-subsection skeleton, reference the `### Retry Handler` (lines 289–446) as the canonical template. Do NOT write a new classifier Node script — the M002-CONTEXT and ROADMAP both specify "inline Markdown instructions — no new script (per discuss D7: Hybrid C approach)".
- **Naming:** Section heading is exactly `### Tier Resolution` (H3, title case, two words).
- **Lint command:** Manually verify with `grep -n "^###\? " shared/forge-dispatch.md` that heading hierarchy is consistent (no H2 inside control-flow section).
- **Pattern:** `follows: Dispatch control-flow section` (CODING-STANDARDS Pattern Catalog row 4). Use `### Retry Handler` (lines 289–446) as the structural template.

## Context
- **M002-CONTEXT D3:** "Usuário só sobrescreve `tier → model` via `tier_models:` nas prefs (ex: `tier_models.light: claude-haiku-4-5-20251001`). Manual override por task via `tier: heavy` no frontmatter de T##-PLAN."
- **M002-CONTEXT D7 (Abordagem Hybrid C):** "Instruções inline em Markdown para lógica pura (classificação de complexidade, routing por tier)." — confirms no new Node script for tier classification.
- **S03 Token Telemetry § S04 extension note** (shared/forge-dispatch.md line 497): *"S04 will extend this schema with `tier` and `reason` fields — additive only, no field renames. Implementors should treat the schema as open for extension."* This task is the fulfillment of that note.
- **MEM011:** "Dispatch templates use placeholder substitution ... templates are thin data-flow descriptors; workers handle all read I/O." — This section is a CONTROL-FLOW section, sibling to Retry Handler and Token Telemetry. It does NOT go inside a data-flow template fenced block.
- **Asset Map row "events.jsonl append (canonical)":** Telemetry writes throw on I/O error (no silent-fail). This applies to the extended dispatch line too — NO try/catch around the `echo >> events.jsonl` path.
- **Reference style:** `forge-agent-prefs.md § Verification Settings` (lines 142–184) is a good prose model for mixing a config block with discovery-chain prose. Not a direct template, just inspiration.
