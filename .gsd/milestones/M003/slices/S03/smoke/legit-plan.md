---
id: TSMK-LEGIT
slice: S03-SMOKE
milestone: M003
must_haves:
  truths:
    - "Smoke fixture: legit-source.js exists, has >= 10 lines, no stub patterns."
  artifacts:
    - path: .gsd/milestones/M003/slices/S03/smoke/legit-source.js
      provides: "add(a, b) — sample legitimate function"
      min_lines: 10
  key_links:
    - from: legit-plan.md
      to: .gsd/milestones/M003/slices/S03/smoke/legit-source.js
      via: "must_haves.artifacts[].path — verifier resolves relative to cwd"
expected_output:
  - .gsd/milestones/M003/slices/S03/smoke/legit-source.js
---

# Legit fixture — drives Exists+Substantive pass.

This fixture exercises the happy path of the verifier: a well-formed plan with
a legitimate, substantial source file that passes both Exists (file is present)
and Substantive (line count >= min_lines, no stub regex patterns).
