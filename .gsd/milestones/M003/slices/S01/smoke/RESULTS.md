# Smoke Demo Results — M003/S01/T05

Three `T##-PLAN` fixtures run through `node scripts/forge-must-haves.js --check` to verify the parser correctly classifies legacy, structured-valid, and structured-malformed plans.

## Run

```
node scripts/forge-must-haves.js --check .gsd/milestones/M003/slices/S01/smoke/legacy-plan.md
node scripts/forge-must-haves.js --check .gsd/milestones/M003/slices/S01/smoke/structured-valid-plan.md
node scripts/forge-must-haves.js --check .gsd/milestones/M003/slices/S01/smoke/structured-malformed-plan.md
```

## Results Table

| Fixture | Expected JSON | Expected Exit | Actual JSON | Actual Exit | Pass? |
|---------|---------------|---------------|-------------|-------------|-------|
| `legacy-plan.md` | `{"legacy":true,"valid":true,"errors":[]}` | `0` | `{"legacy":true,"valid":true,"errors":[]}` | `0` | Pass |
| `structured-valid-plan.md` | `{"legacy":false,"valid":true,"errors":[]}` | `0` | `{"legacy":false,"valid":true,"errors":[]}` | `0` | Pass |
| `structured-malformed-plan.md` | `{"legacy":false,"valid":false,"errors":[...]}` | `2` | `{"legacy":false,"valid":false,"errors":["malformed must_haves schema: artifacts[0].min_lines — required number field missing"]}` | `2` | Pass |

## Summary

All 3 smoke demos pass — must_haves schema round-trip verified.

### What each fixture tests

- **legacy-plan.md**: No `must_haves:` key in frontmatter; body has a `## Must-Haves` markdown section. Parser returns `legacy: true` — correct for pre-M003 plans that pre-date the structured schema.
- **structured-valid-plan.md**: Frontmatter has a fully-formed `must_haves:` block with `truths`, `artifacts` (including `min_lines`), `key_links`, and `expected_output`. Parser returns `valid: true`.
- **structured-malformed-plan.md**: Frontmatter has `must_haves:` but `artifacts[0]` is missing the required `min_lines` field. Parser returns `valid: false` with error message identifying the missing field, and exits with code `2`.
