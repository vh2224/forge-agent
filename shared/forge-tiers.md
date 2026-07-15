# Forge Tiers — Canonical Tier-to-Model Reference

Canonical reference for tier-based model routing in the Forge Agent system.
Consumed by `### Tier Resolution` in `shared/forge-dispatch.md` and by `## Tier Settings` in `forge-agent-prefs.md`.

---

## Unit Type → Default Tier

Maps every dispatch unit type to a default tier. The tier determines which model runs the unit
unless overridden (see [Override Precedence](#override-precedence)).

| Unit Type | Default Tier | Rationale |
|---|---|---|
| `memory-extract` | light | Short extraction pass; no reasoning depth required |
| `complete-slice` | light | Aggregation and summary; follows already-executed work |
| `complete-milestone` | light | Same as complete-slice; writes LEDGER and closes artifacts |
| `research-milestone` | standard | Codebase exploration + web research; needs breadth, not depth |
| `research-slice` | standard | Scoped research within a slice; same reasoning tier as milestone research |
| `discuss-milestone` | standard | Ambiguity scoring and AskUserQuestion loops; standard reasoning sufficient |
| `discuss-slice` | standard | Scoped discussion within a slice |
| `execute-task` | standard | Code implementation; default standard, can be overridden via frontmatter |
| `plan-milestone` | max | Full decomposition into slices and tasks; 1 unit per milestone — frontier reasoning justifies the 2x premium |
| `plan-slice` | heavy | Task-level decomposition with dependency analysis and acceptance criteria. Escalates to `max` when the slice is tagged `risk:high` in ROADMAP (see [Override Precedence](#override-precedence)) |

---

## Tier → Default Model

The four tiers map to four model aliases. Operators can override the model for any tier via
`tier_models:` in `forge-agent-prefs.md` without changing unit-type assignments.

| Tier | Default Model ID | Alias | Intended Workloads | Operator Override Key |
|---|---|---|---|---|
| `light` | `claude-haiku-4-5-20251001` | `haiku` | Memory extraction, aggregation, fast summaries | `tier_models.light` |
| `standard` | `claude-sonnet-5` | `sonnet` | Code execution, research, discussion, scoped planning | `tier_models.standard` |
| `heavy` | `claude-opus-4-8[1m]` | `opus` | Deep architectural planning, slice decomposition | `tier_models.heavy` |
| `max` | `claude-fable-5` | `fable` | Milestone planning, `risk:high` slice planning, last rung of blocker escalation. 2x the cost of opus ($10/$50 vs $5/$25 per MTok) — never a default for high-volume unit types | `tier_models.max` |

> **Fable 5 thinking guard:** `claude-fable-5` returns HTTP 400 on an explicit `thinking: {type: "disabled"}`
> (Opus 4.7/4.8 accept it). Whenever the resolved model is `claude-fable-5`, the orchestrator must inject
> `thinking: adaptive` in the worker prompt header — or omit the `thinking:` line entirely — even if the
> phase prefs say `disabled`. Never forward `disabled` to a `max`-tier dispatch.

> **ID→alias map — the `Agent()` `model:` param only accepts aliases.** The `model` parameter of the
> `Agent` tool accepts only the four short aliases (`haiku|sonnet|opus|fable`) — it does **not** accept a
> full model ID string (e.g. `claude-opus-4-8[1m]`). The "Default Model ID" column above is the concrete
> ID an operator writes into `tier_models.<tier>` in `forge-agent-prefs.md`; before that ID reaches
> `Agent()`, the orchestrator must translate it to its alias. This translation is a single canonical
> map, implemented once in [`scripts/forge-model-alias.js`](../scripts/forge-model-alias.js)
> (`modelToAlias(id)` — plain lowercase substring match, checked in order `fable → haiku → sonnet →
> opus`; the `[1m]` context-window suffix needs no special-casing since substring search still finds
> the base name). **This file and `shared/forge-dispatch.md` only describe and reference that helper —
> neither reimplements the map as a second, driftable table.** Resolution rule: `Agent(model: <alias>)`
> is dispatched with the alias, never the raw ID. When an operator sets `tier_models.<tier>` to an ID
> the map does not recognize, `modelToAlias` returns `{ alias: null, mapped: false }`; the orchestrator
> **omits** the `model:` param entirely in that case (degrading to the invoked agent's own frontmatter
> `model:` default) and logs a warning — it never passes the unmapped ID straight through, since
> `Agent()` would reject it. This same map is reused by S04 (advocate override) — see
> [Cross-references](#cross-references).

---

## Tier Chains — Scalar vs. List

`tier_models.<tier>` in the raw prefs cascade (`~/.claude/forge-agent-prefs.md` >
`.gsd/claude-agent-prefs.md` > `.gsd/prefs.local.md`, last-wins) accepts two forms, both read via
[`scripts/forge-tier-chain.js`](../scripts/forge-tier-chain.js) — **never**
`.gsd/prefs-resolved.json` (that file is never written; MEM001 M005):

- **Scalar** — `tier_models.standard: claude-sonnet-5`. A single-member chain. Byte-identical
  compat with the pre-M005-S04 resolver: `$MODEL_ID` = that value, nothing else changes.
- **List** — `tier_models.standard: [claude-sonnet-5, claude-haiku-4-5-20251001]`. An ordered,
  primary-first fallback chain. `$MODEL_ID` = the first (primary) member; the remaining members are
  the **intra-tier fallback ladder**.

`readTierChain(tier, cwd)` returns `[{ id, alias, mapped }, ...]` — every member annotated with its
`Agent()`-alias via the shared [`forge-model-alias.js`](../scripts/forge-model-alias.js) map (never
reimplemented here or in `forge-dispatch.md`, matching the ID→alias pattern documented above).
`nextAfter(chain, id)` returns the next **mapped** member after `id`, or `''` when the chain is
exhausted — a member with no known alias (`mapped: false`) is skipped, not returned, and the
orchestrator logs a `model_applied: null` warning for it (same degrade rule as the ID→alias map
above: never pass an unmapped ID straight to `Agent()`).

### Two distinct ladders — do not conflate

The Failure Taxonomy's model-level recovery has **two separate axes**, triggered by different
failure classes and consuming different state:

| Ladder | Triggered by | Consumes | Direction |
|---|---|---|---|
| **Intra-tier chain** (this section) | `model_refusal`, HTTP 429, HTTP 400 | `$TIER_CHAIN` via `forge-tier-chain.js --next-after` | Walks fallback members **within the same tier** — never changes tier |
| **Cross-tier escalation** (existing, unchanged) | `context_overflow` | The tier itself | Escalates `standard → heavy → max`; does not touch the chain |

The intra-tier chain is consumed **before** any cross-tier escalation would apply — a `model_refusal`
never triggers a tier bump; it only walks `$TIER_CHAIN`. If the chain is exhausted (`nextAfter`
returns `''`) on a `model_refusal`/429/400, the Failure Taxonomy's existing escalation/surface rules
for that failure class apply unchanged (this file does not alter those rules — see the Failure
Taxonomy spec in the consuming skills for the terminal behavior).

---

## Frontmatter Overrides

Both fields are optional. When present in a `T##-PLAN.md` frontmatter block, they take effect
before the unit_type default is consulted. The `tier:` field takes precedence over `tag:`.

| Field | Type | Accepted Values | Effect |
|---|---|---|---|
| `tier:` | enum | `light \| standard \| heavy \| max` | Explicitly sets the tier for this unit, overriding both the unit_type default and any tag-based downgrade |
| `tag:` | string | `docs` (only value that triggers a tier change in M002) | When `tag: docs`, the unit is downgraded to `light` regardless of unit_type default |

**Note:** Additional `tag:` values may be introduced in future milestones. The `docs` downgrade
is the only tag-based rule active in M002.

> **Sibling axis — `effort:`.** `tier:` (this file) picks *which model* runs the unit; `effort:`
> picks *how hard it reasons* (token spend). The two are independent frontmatter fields resolved
> in separate passes. Effort is clamped to the resolved model's ceiling (`light`/`standard` cap at
> `medium`; `heavy`/`max` allow up to `max`), so a high effort only takes effect on a `heavy`/`max`
> tier. Canonical spec: [`shared/forge-dispatch.md § Effort Resolution`](forge-dispatch.md#effort-resolution).

---

## Override Precedence

Highest precedence first. The first matching rule wins.

1. **T##-PLAN frontmatter `tier:`** — explicit tier assignment; always wins. The orchestrator reads
   this field immediately after resolving the unit type and short-circuits all other rules.
2. **T##-PLAN frontmatter `tag: docs`** — tag-based downgrade to `light`. Applied when no explicit
   `tier:` is set. Intended for documentation-only tasks that do not require code generation.
3. **Risk escalation (`plan-slice` only)** — when `unit_type == plan-slice` and the slice is tagged
   `risk:high` in the milestone ROADMAP, the tier escalates `heavy → max`. Uses the same ROADMAP
   check that triggers the `forge-risk-radar` gate. Rationale: a better plan on a high-risk slice
   is the highest leverage-per-dollar spot for frontier reasoning — it prevents expensive executor
   rework downstream.
4. **Unit type default** — the table in [Unit Type → Default Tier](#unit-type--default-tier) above.
   Used when no frontmatter override is present.

---

## Cross-references

- [`forge-agent-prefs.md § Tier Settings`](../forge-agent-prefs.md) — `tier_models:` block maps each tier alias to a concrete model ID; edit there to swap models without touching dispatch logic (to be added in T05).
- [`shared/forge-dispatch.md § Tier Resolution`](forge-dispatch.md) — the `### Tier Resolution` block reads this file's tables at runtime to resolve the model for each dispatched unit (to be added in T02).
- [`skills/forge-auto/SKILL.md`](../skills/forge-auto/SKILL.md) — the main dispatch loop; reads resolved tier from `### Tier Resolution` before invoking `Agent()`.
- [`skills/forge-next/SKILL.md`](../skills/forge-next/SKILL.md) — step-mode execution; same tier resolution path as forge-auto.
- [`scripts/forge-tier-chain.js`](../scripts/forge-tier-chain.js) — reads `tier_models.<tier>` from the raw prefs cascade (scalar or list), exports `readTierChain(tier, cwd)` and `nextAfter(chain, id)`; sole implementation of the [Tier Chains — Scalar vs. List](#tier-chains--scalar-vs-list) parsing — never reimplemented in markdown.
- Failure Taxonomy (Failure recovery skills, e.g. `skills/forge-auto/SKILL.md`) — consumes `$TIER_CHAIN` via `--next-after` for `model_refusal`/429/400 recovery; keeps `context_overflow`'s cross-tier `standard→heavy→max` escalation unchanged and separate.
