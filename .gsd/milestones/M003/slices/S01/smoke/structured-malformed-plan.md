---
id: T03
slice: S02
milestone: M003
must_haves:
  truths:
    - "scripts/forge-classifier.js exists and exports classify(planContent)"
    - "classify returns one of: light | standard | heavy"
  artifacts:
    - path: "scripts/forge-classifier.js"
      provides: "complexity classifier for dispatch tier routing"
  key_links:
    - from: "scripts/forge-classifier.js"
      to: "shared/forge-tiers.md"
      via: "classifier references tier definitions"
expected_output:
  - scripts/forge-classifier.js
---

# T03: Complexity classifier (malformed fixture)

**Slice:** S02  **Milestone:** M003

## Goal

This fixture intentionally omits `min_lines` from `artifacts[0]` to trigger a validation error
when parsed by `forge-must-haves.js --check`. The parser should classify this as
`{legacy: false, valid: false, errors: [...]}` and exit with code 2.

The missing field is: `artifacts[0].min_lines` — required number field.

## Steps

1. Note: this file is a regression fixture, not a real plan.
2. Run `node scripts/forge-must-haves.js --check` against this file to confirm exit 2.
3. Record result in smoke/RESULTS.md.
