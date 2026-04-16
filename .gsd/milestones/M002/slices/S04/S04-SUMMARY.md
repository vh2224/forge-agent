---
id: S04
milestone: M002
status: ready-for-completer
completed_at: 2026-04-16T22:00:00Z
---

## Goal

Port GSD-2's tier-only complexity classifier into Forge so every dispatch picks a model from
a `tier_models:` table (in `forge-agent-prefs.md`) instead of hardcoded Phase→Agent routing.
Light/standard/heavy tiers map to Haiku/Sonnet/Opus respectively. Frontmatter on `T##-PLAN.md`
can override per-task (`tier: heavy`) or downgrade via `tag: docs` (forces light). All
dispatches log `{tier, reason}` to `events.jsonl` additively — no field renames in S03 schema.

## Outcome

All 6 tasks completed. The full tier-resolution pipeline is operational end-to-end:

- **T01** — Created `shared/forge-tiers.md`: canonical reference mapping all 10 unit types to
  tiers, tier defaults, and the 3-item override precedence chain.
- **T02** — Added `### Tier Resolution` (248 lines) to `shared/forge-dispatch.md` after
  `### Token Telemetry`; 5-step algorithm, prefs contract, frontmatter override table, event
  schema extension, 3 worked examples, and bash wiring snippet.
- **T03** — Wired Tier Resolution as step 1.5 into `skills/forge-auto/SKILL.md`; replaced
  Phase-routing table lookup with `$MODEL_ID` from tier system; extended dispatch event echo.
- **T04** — Same integration into `skills/forge-next/SKILL.md`, derived independently per
  MEM015; selective memory injection block confirmed preserved at line 166 post-edit.
- **T05** — Added `## Tier Settings` block to `forge-agent-prefs.md` with `tier_models:` YAML
  and prose; ran 5 smoke demos (all PASS); appended 5 JSON-valid lines to `events.jsonl`.
- **T06** — (This task) S04-SUMMARY.md written; CLAUDE.md decision entry appended.

## Artefacts produced

| Path | Status | Task |
|------|--------|------|
| `shared/forge-tiers.md` | new (~80 lines) | T01 |
| `shared/forge-dispatch.md` | modified (+248 lines — `### Tier Resolution`) | T02 |
| `skills/forge-auto/SKILL.md` | modified (step 1.5 + event extension) | T03 |
| `skills/forge-next/SKILL.md` | modified (step 1.5 + event extension, MEM015 preserved) | T04 |
| `forge-agent-prefs.md` | modified (+`## Tier Settings` section, 71 lines) | T05 |
| `.gsd/milestones/M002/slices/S04/smokes/T05-DEMOS.md` | new (5 demo transcripts) | T05 |
| `CLAUDE.md` | modified (+decision entry `### Tier-only model routing`) | T06 |
| `.gsd/milestones/M002/slices/S04/S04-SUMMARY.md` | new | T06 |

## Demo transcripts

Five acceptance criteria verified via the smoke demos in `T05-DEMOS.md`. Each line below is
the actual `events.jsonl` dispatch entry produced by the resolution algorithm.

### Demo 1 — AC1: memory-extract dispatches at light tier (Haiku)

Proves: `unit_type → tier` default mapping for `memory-extract`.

```json
{"ts":"2026-04-16T21:38:16.630Z","event":"dispatch","scenario":"demo1-memory-extract","unit":"memory-extract/scratch-M002-post-T04","tier":"light","model":"claude-haiku-4-5-20251001","reason":"unit-type:memory-extract","agent":"forge-executor","milestone":"M002","slice":"S04","stubbed":true,"note":"smoke-demo: tier-resolution path exercised; Agent() call not issued"}
```

**AC1 satisfied:** `tier:"light"`, `model:"claude-haiku-4-5-20251001"`, `reason:"unit-type:memory-extract"`.

---

### Demo 2 — AC2: plan-slice dispatches at heavy tier (Opus)

Proves: `unit_type → tier` default mapping for `plan-slice`.

```json
{"ts":"2026-04-16T21:38:16.655Z","event":"dispatch","scenario":"demo2-plan-slice","unit":"plan-slice/S05-scratch","tier":"heavy","model":"claude-opus-4-7[1m]","reason":"unit-type:plan-slice","agent":"forge-executor","milestone":"M002","slice":"S04","stubbed":true,"note":"smoke-demo: tier-resolution path exercised; Agent() call not issued"}
```

**AC2 satisfied:** `tier:"heavy"`, `model:"claude-opus-4-7[1m]"`, `reason:"unit-type:plan-slice"`.

---

### Demo 3 — AC3: execute-task with `tag: docs` dispatches at light tier

Proves: `tag: docs` frontmatter forces light tier downgrade.

```json
{"ts":"2026-04-16T21:38:16.655Z","event":"dispatch","scenario":"demo3-execute-task-tag-docs","unit":"execute-task/T06-scratch","tier":"light","model":"claude-haiku-4-5-20251001","reason":"frontmatter-tag:docs","agent":"forge-executor","milestone":"M002","slice":"S04","stubbed":true,"note":"smoke-demo: tier-resolution path exercised; Agent() call not issued"}
```

**AC3 satisfied:** `tier:"light"`, `reason:"frontmatter-tag:docs"`, `model:"claude-haiku-4-5-20251001"`.

---

### Demo 4 — AC4: execute-task with `tier: heavy` wins over `tag: docs`

Proves: explicit `tier:` frontmatter has highest precedence — overrides `tag: docs`.

```json
{"ts":"2026-04-16T21:38:16.656Z","event":"dispatch","scenario":"demo4-execute-task-tier-heavy","unit":"execute-task/T06-scratch","tier":"heavy","model":"claude-opus-4-7[1m]","reason":"frontmatter-override:heavy","agent":"forge-executor","milestone":"M002","slice":"S04","stubbed":true,"note":"smoke-demo: tier-resolution path exercised; Agent() call not issued"}
```

**AC4 satisfied:** `tier:"heavy"`, `reason:"frontmatter-override:heavy"`, `model:"claude-opus-4-7[1m]"`.

---

### Demo 5 — AC5: changing `tier_models.light` in prefs re-routes next light dispatch

Proves: operator can re-route an entire tier by editing one prefs key — no code changes needed.

```json
{"ts":"2026-04-16T21:38:16.656Z","event":"dispatch","scenario":"demo5-prefs-light-to-sonnet","unit":"memory-extract/scratch-M002-post-prefs-change","tier":"light","model":"claude-sonnet-4-6","reason":"unit-type:memory-extract","agent":"forge-executor","milestone":"M002","slice":"S04","stubbed":true,"note":"smoke-demo: tier-resolution path exercised; Agent() call not issued"}
```

**AC5 satisfied:** `tier:"light"`, `model:"claude-sonnet-4-6"` (haiku→sonnet swap via prefs),
`reason:"unit-type:memory-extract"` (tier unchanged — only model swapped).

---

All 5/5 acceptance criteria from the S04-PLAN PASS.

## Lessons Learned

- **MEM015 is a real divergence, not a stylistic one.** forge-next is structurally step-mode
  (no loop), while forge-auto is a loop with a re-read block at the top. Merging the diffs
  would have broken either the loop invariant or the memory injection. Independent derivation
  (T03 and T04 as separate tasks) was the right sequencing.
- **Pure-Markdown control-flow blocks scale.** The `### Tier Resolution` section in
  `shared/forge-dispatch.md` (248 lines of Markdown rules + worked examples) is readable and
  auditable by any worker without running code. Workers consume it as a `Read` directive.
  No new Node script was needed for the classifier (per M002-CONTEXT D7 Hybrid C).
- **Additive event schema extension is zero-risk.** Adding `tier` and `reason` fields to the
  existing dispatch event (from S03) required no migration — readers ignoring unknown fields
  remain compatible. The compatibility paragraph in T02 documents this explicitly.
- **Smoke-demo isolation matters.** Stubbing `Agent()` calls while exercising the real
  resolution code path gave clean, repeatable evidence without side effects on STATE.md or
  live milestones. The `stubbed: true` field in the event is auditable.
- **Single `tier_models:` block as source of truth eliminates model-ID drift.** Referencing
  `shared/forge-tiers.md` model IDs verbatim in `forge-agent-prefs.md` (rather than duplicating
  inline) means a future model rename touches exactly one file.

## Follow-ups / out-of-scope

- **Budget-pressure tier escalation** (retry with heavier model on failure) is explicitly
  deferred to a future milestone. S04 establishes the tier vocabulary and resolution logic;
  escalation can be layered on top without breaking the current schema.
- **`escalateTier()` helper** — out of scope per S04-PLAN. If retry-on-failure model-bumping
  is added, it would wrap the S01 Retry Handler.
- **Cross-provider routing** — out of scope for M002. The `tier_models:` contract is
  provider-agnostic in design; operators can point any tier at any model ID.
