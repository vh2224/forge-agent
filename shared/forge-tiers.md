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
| `plan-milestone` | heavy | Full decomposition into slices and tasks; requires deep reasoning |
| `plan-slice` | heavy | Task-level decomposition with dependency analysis and acceptance criteria |

---

## Tier → Default Model

The three tiers map to three model aliases. Operators can override the model for any tier via
`tier_models:` in `forge-agent-prefs.md` without changing unit-type assignments.

| Tier | Default Model ID | Alias | Intended Workloads | Operator Override Key |
|---|---|---|---|---|
| `light` | `claude-haiku-4-5-20251001` | `haiku` | Memory extraction, aggregation, fast summaries | `tier_models.light` |
| `standard` | `claude-sonnet-4-6` | `sonnet` | Code execution, research, discussion, scoped planning | `tier_models.standard` |
| `heavy` | `claude-opus-4-7[1m]` | `opus` | Deep architectural planning, full milestone decomposition | `tier_models.heavy` |

---

## Frontmatter Overrides

Both fields are optional. When present in a `T##-PLAN.md` frontmatter block, they take effect
before the unit_type default is consulted. The `tier:` field takes precedence over `tag:`.

| Field | Type | Accepted Values | Effect |
|---|---|---|---|
| `tier:` | enum | `light \| standard \| heavy` | Explicitly sets the tier for this unit, overriding both the unit_type default and any tag-based downgrade |
| `tag:` | string | `docs` (only value that triggers a tier change in M002) | When `tag: docs`, the unit is downgraded to `light` regardless of unit_type default |

**Note:** Additional `tag:` values may be introduced in future milestones. The `docs` downgrade
is the only tag-based rule active in M002.

---

## Override Precedence

Highest precedence first. The first matching rule wins.

1. **T##-PLAN frontmatter `tier:`** — explicit tier assignment; always wins. The orchestrator reads
   this field immediately after resolving the unit type and short-circuits all other rules.
2. **T##-PLAN frontmatter `tag: docs`** — tag-based downgrade to `light`. Applied when no explicit
   `tier:` is set. Intended for documentation-only tasks that do not require code generation.
3. **Unit type default** — the table in [Unit Type → Default Tier](#unit-type--default-tier) above.
   Used when no frontmatter override is present.

---

## Cross-references

- [`forge-agent-prefs.md § Tier Settings`](../forge-agent-prefs.md) — `tier_models:` block maps each tier alias to a concrete model ID; edit there to swap models without touching dispatch logic (to be added in T05).
- [`shared/forge-dispatch.md § Tier Resolution`](forge-dispatch.md) — the `### Tier Resolution` block reads this file's tables at runtime to resolve the model for each dispatched unit (to be added in T02).
- [`skills/forge-auto/SKILL.md`](../skills/forge-auto/SKILL.md) — the main dispatch loop; reads resolved tier from `### Tier Resolution` before invoking `Agent()`.
- [`skills/forge-next/SKILL.md`](../skills/forge-next/SKILL.md) — step-mode execution; same tier resolution path as forge-auto.
