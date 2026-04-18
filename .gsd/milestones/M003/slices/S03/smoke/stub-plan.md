---
id: TSMK-STUB
slice: S03-SMOKE
milestone: M003
must_haves:
  truths:
    - "Smoke fixture: stub-source.js should be flagged as stub."
  artifacts:
    - path: .gsd/milestones/M003/slices/S03/smoke/stub-source.js
      provides: "noop stub — should trigger regex match"
      min_lines: 3
  key_links:
    - from: stub-plan.md
      to: .gsd/milestones/M003/slices/S03/smoke/stub-source.js
      via: "must_haves.artifacts[].path — verifier resolves relative to cwd"
expected_output:
  - .gsd/milestones/M003/slices/S03/smoke/stub-source.js
---

# Stub fixture — drives Substantive fail with `return_null_function` regex.

This fixture exercises the stub-detection path: a legitimate plan pointing at a
source file that contains the pattern `() => null`, which should be flagged by
the `return_null_function` regex. The file meets min_lines but fails Substantive.
