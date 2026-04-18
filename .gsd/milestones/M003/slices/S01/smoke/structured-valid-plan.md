---
id: T02
slice: S04
milestone: M002
must_haves:
  truths:
    - "scripts/forge-router.js exists and exports routeByTier(unitType)"
    - "routeByTier returns a model string for each of the three tiers: light, standard, heavy"
    - "Unit tests cover all three tier mappings and the unknown-tier fallback"
  artifacts:
    - path: "scripts/forge-router.js"
      provides: "tier-based model router"
      min_lines: 40
    - path: "tests/forge-router.test.js"
      provides: "unit tests for routeByTier"
      min_lines: 30
  key_links:
    - from: "scripts/forge-router.js"
      to: "shared/forge-tiers.md"
      via: "router reads tier→model table at runtime from forge-tiers.md"
    - from: "tests/forge-router.test.js"
      to: "scripts/forge-router.js"
      via: "require('../scripts/forge-router') in test setup"
expected_output:
  - scripts/forge-router.js
  - tests/forge-router.test.js
---

# T02: Tier-based model router

**Slice:** S04  **Milestone:** M002

## Goal

Implement `routeByTier(unitType)` in `scripts/forge-router.js` that maps a dispatch unit type to a model string using the tier table defined in `shared/forge-tiers.md`. The router supports operator override via `PREFS.tier_models`.

## Steps

1. Read `shared/forge-tiers.md` to internalize the canonical `unit_type → tier → default_model` table.
2. Create `scripts/forge-router.js` exporting `routeByTier(unitType, prefs)`.
3. Implement three-tier fallback: explicit `tier:` frontmatter > tag-based override > unit_type default.
4. Write `tests/forge-router.test.js` covering all tier paths.
5. Run `npm test -- --testPathPattern forge-router` to verify.
