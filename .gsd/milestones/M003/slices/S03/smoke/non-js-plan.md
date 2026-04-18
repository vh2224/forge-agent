---
id: TSMK-NONJS
slice: S03-SMOKE
milestone: M003
must_haves:
  truths:
    - "Non-JS fixture — verifier should skip Wired level."
  artifacts:
    - path: .gsd/milestones/M003/slices/S03/smoke/placeholder.py
      provides: "hypothetical Python helper"
      min_lines: 5
    - path: .gsd/milestones/M003/slices/S03/smoke/placeholder.go
      provides: "hypothetical Go helper"
      min_lines: 5
  key_links:
    - from: non-js-plan.md
      to: .gsd/milestones/M003/slices/S03/smoke/placeholder.py
      via: "must_haves.artifacts[].path — verifier skips non-JS artifacts at Wired level"
expected_output:
  - .gsd/milestones/M003/slices/S03/smoke/placeholder.py
---

# Non-JS fixture — drives wired=skipped non_js_ts_repo path.

This fixture tests detection of non-JavaScript/TypeScript artifacts.
The verifier should recognize the `.py` and `.go` extensions and skip
the Wired level with `wired: skipped, reason: non_js_ts_repo` per artifact,
without treating it as a failure. The files themselves do not need to exist.
