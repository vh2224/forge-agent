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
| `standard` | `claude-sonnet-4-6` | `sonnet` | Code execution, research, discussion, scoped planning | `tier_models.standard` |
| `heavy` | `claude-opus-4-8[1m]` | `opus` | Deep architectural planning, slice decomposition | `tier_models.heavy` |
| `max` | `claude-fable-5` | `fable` | Milestone planning, `risk:high` slice planning, last rung of blocker escalation. 2x the cost of opus ($10/$50 vs $5/$25 per MTok) — never a default for high-volume unit types | `tier_models.max` |

> **Fable 5 thinking guard:** `claude-fable-5` returns HTTP 400 on an explicit `thinking: {type: "disabled"}`
> (Opus 4.7/4.8 accept it). Whenever the resolved model is `claude-fable-5`, the orchestrator must inject
> `thinking: adaptive` in the worker prompt header — or omit the `thinking:` line entirely — even if the
> phase prefs say `disabled`. Never forward `disabled` to a `max`-tier dispatch.

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
