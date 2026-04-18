---
id: T05
slice: S03
milestone: M003
tag: docs
title: "Smoke fixtures — legit / stub / legacy / non-JS + RESULTS.md"
status: DONE
planned: 2026-04-16
must_haves:
  truths:
    - "Four smoke fixtures exist under `.gsd/milestones/M003/slices/S03/smoke/` covering: (1) legit structured plan + legit source file, (2) stub source file (`() => null`), (3) legacy plan (no must_haves), (4) non-JS plan (.py artifacts)."
    - "Running `node scripts/forge-verifier.js --slice <fixture-slice-id> --milestone M003 --cwd .gsd/milestones/M003/slices/S03/smoke/` (or against a temporary scratch slice dir) produces expected verdicts captured in RESULTS.md."
    - "RESULTS.md records actual-vs-expected per fixture, with exact JSON stdout output quoted."
    - "Stub fixture produces a row with `substantive: ✗` and flag regex_name `return_null_function` (or `empty_function_body`, whichever matches; both acceptable — document which)."
    - "Legacy fixture produces `skipped: legacy_schema` without crash; exit 0."
    - "Non-JS fixture produces `wired: skipped, reason: non_js_ts_repo` per row."
  artifacts:
    - path: .gsd/milestones/M003/slices/S03/smoke/legit-plan.md
      provides: "T##-PLAN.md-shaped fixture with valid structured must_haves schema pointing at smoke/legit-source.js. Drives Exists+Substantive+Wired pass case."
      min_lines: 20
    - path: .gsd/milestones/M003/slices/S03/smoke/legit-source.js
      provides: "Legitimate CommonJS source file (≥ 15 lines) that exports a function. Referenced by legit-plan.md as the artifact to audit."
      min_lines: 15
    - path: .gsd/milestones/M003/slices/S03/smoke/stub-plan.md
      provides: "T##-PLAN.md fixture pointing at smoke/stub-source.js. Drives Substantive-fail case."
      min_lines: 20
    - path: .gsd/milestones/M003/slices/S03/smoke/stub-source.js
      provides: "3-line stub source: `const f = () => null;` or equivalent. Triggers stub regex detection."
      min_lines: 3
    - path: .gsd/milestones/M003/slices/S03/smoke/legacy-plan.md
      provides: "Legacy-shaped T##-PLAN.md without must_haves: block. Copy of S01 legacy fixture or freshly authored."
      min_lines: 15
    - path: .gsd/milestones/M003/slices/S03/smoke/non-js-plan.md
      provides: "T##-PLAN.md with must_haves pointing at .py / .go paths. Drives wired-skipped non_js_ts_repo case."
      min_lines: 20
    - path: .gsd/milestones/M003/slices/S03/smoke/RESULTS.md
      provides: "Regression record — per-fixture expected JSON stdout, actual JSON stdout, verdict (match / diverge with delta). Human-readable."
      min_lines: 40
  key_links:
    - from: .gsd/milestones/M003/slices/S03/smoke/legit-plan.md
      to: .gsd/milestones/M003/slices/S03/smoke/legit-source.js
      via: "must_haves.artifacts[].path — verifier resolves relative to cwd"
expected_output:
  - .gsd/milestones/M003/slices/S03/smoke/legit-plan.md
  - .gsd/milestones/M003/slices/S03/smoke/legit-source.js
  - .gsd/milestones/M003/slices/S03/smoke/stub-plan.md
  - .gsd/milestones/M003/slices/S03/smoke/stub-source.js
  - .gsd/milestones/M003/slices/S03/smoke/legacy-plan.md
  - .gsd/milestones/M003/slices/S03/smoke/non-js-plan.md
  - .gsd/milestones/M003/slices/S03/smoke/RESULTS.md
---

# T05: Smoke fixtures + RESULTS.md

**Slice:** S03  **Milestone:** M003  **Tag:** docs

## Goal

Create a smoke-fixture suite that exercises all four primary code paths of the verifier: legit pass, stub-detect fail, legacy-skip, non-JS-skip. Record expected-vs-actual JSON in RESULTS.md for regression auditing (analogous to S01's `smoke/RESULTS.md`).

## Must-Haves

### Truths
- All seven files listed in `artifacts` exist and have ≥ their min_lines.
- RESULTS.md has four sections (one per fixture) with `## Expected` + `## Actual` + `## Verdict` sub-sections per fixture.
- Running the verifier against each fixture (manually, by setting up a scratch slice dir) produces output consistent with RESULTS.md's "Actual" section.
- RESULTS.md's "Verdict" is `match` for all four on the fresh run.

### Artifacts
(See frontmatter `artifacts:` — 7 files. All relative to repo root.)

### Key Links
- `legit-plan.md` → `legit-source.js` via `must_haves.artifacts[].path`.

## Steps

1. Create `.gsd/milestones/M003/slices/S03/smoke/` directory.

2. **legit-source.js** — write a ≥ 15-line CommonJS module:
   ```javascript
   'use strict';

   // Legit source for S03 verifier smoke test.
   // Exercises: Exists pass (file present), Substantive pass
   // (> min_lines + no stub regex matches), Wired pass (referenced
   // by legit-plan's must_haves chain).

   function add(a, b) {
     if (typeof a !== 'number' || typeof b !== 'number') {
       throw new TypeError('add expects numeric arguments');
     }
     return a + b;
   }

   module.exports = { add };
   ```

3. **legit-plan.md** — structured plan pointing at `legit-source.js`:
   ```markdown
   ---
   id: TSMK-LEGIT
   slice: S03-SMOKE
   milestone: M003
   must_haves:
     truths:
       - "Smoke fixture: legit-source.js exists, has ≥ 10 lines, no stub patterns."
     artifacts:
       - path: .gsd/milestones/M003/slices/S03/smoke/legit-source.js
         provides: "add(a, b) — sample legitimate function"
         min_lines: 10
     key_links: []
   expected_output:
     - .gsd/milestones/M003/slices/S03/smoke/legit-source.js
   ---

   # Legit fixture — drives Exists+Substantive pass.
   ```

4. **stub-source.js** — the canonical stub:
   ```javascript
   'use strict';
   const noop = () => null;
   module.exports = { noop };
   ```
   (3 lines + `'use strict'` = 4 lines total, but min_lines in stub-plan is set to 3 so lineCount-check passes, forcing the failure into stub-regex rather than min_lines.)

5. **stub-plan.md** — structured plan pointing at stub-source.js:
   ```markdown
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
     key_links: []
   expected_output:
     - .gsd/milestones/M003/slices/S03/smoke/stub-source.js
   ---

   # Stub fixture — drives Substantive fail with `return_null_function` regex.
   ```

6. **legacy-plan.md** — copy or adapt S01 legacy fixture. Frontmatter has no `must_haves:` key:
   ```markdown
   ---
   id: TSMK-LEGACY
   slice: S03-SMOKE
   milestone: M003
   ---

   # Legacy fixture — no must_haves block.

   This plan represents the M001/M002 pre-schema format and must be
   gracefully skipped by the verifier.
   ```

7. **non-js-plan.md** — structured plan with .py/.go artifacts (paths intentionally non-existent — non-JS detection happens via extension before Exists):
   ```markdown
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
     key_links: []
   expected_output:
     - .gsd/milestones/M003/slices/S03/smoke/placeholder.py
   ---

   # Non-JS fixture — drives wired=skipped non_js_ts_repo path.
   ```
   Note: this fixture intentionally has `exists: false` on both (no actual .py/.go files). The non_js_ts_repo detection happens before Exists per T01's design — but re-read T01-PLAN step 7: detection occurs at `verifyArtifact` entry based on artifact extensions, so the Wired branch is skipped regardless of Exists. RESULTS.md records both `exists: false` and `wired: skipped` for each row.

8. **Run the verifier against each fixture** by staging a temporary scratch slice:
   - Create `.gsd/milestones/M003/slices/S03/smoke/scratch-slice/tasks/T01/T01-PLAN.md` → symlink or copy `legit-plan.md` content.
   - Run `node scripts/forge-verifier.js --slice scratch-slice --milestone M003 --cwd .gsd/milestones/M003/slices/S03/smoke/` OR adapt path structure so the tool finds the plan. (T04 completer invokes with the real `{S##}/{M###}` — T05 just needs to exercise each path.)
   - Easier alternative: invoke via `node -e` using the module directly:
     ```bash
     node -e "
     const fs = require('fs');
     const v = require('./scripts/forge-verifier');
     const mh = require('./scripts/forge-must-haves').parseMustHaves(
       fs.readFileSync('.gsd/milestones/M003/slices/S03/smoke/legit-plan.md','utf-8')
     );
     console.log(JSON.stringify(v.verifyArtifact(mh, [], {cwd: process.cwd()}), null, 2));
     "
     ```
   - Capture each output verbatim.

9. **Write RESULTS.md** — record expected JSON stdout per fixture with ## Expected / ## Actual / ## Verdict sub-sections:
   ```markdown
   # S03 Verifier Smoke — RESULTS

   **Ran:** YYYY-MM-DD
   **Verifier version:** v1.0 (T01+T02+T03 baseline)

   ---

   ## Fixture 1: legit-plan.md

   ### Expected
   ```json
   {
     "rows": [
       {
         "path": ".gsd/milestones/M003/slices/S03/smoke/legit-source.js",
         "exists": true,
         "substantive": true,
         "wired": false,
         "flags": [{"level": "wired", "reason": "no_references_found"}]
       }
     ]
   }
   ```
   (Wired is `false` because the smoke fixture is standalone — legit-source.js
   is not imported by any other file in the candidate set.)

   ### Actual
   <JSON quoted verbatim from node -e run>

   ### Verdict
   match (or diverge — note any differences)

   ---

   ## Fixture 2: stub-plan.md
   ...
   ```

10. Commit fixtures + RESULTS.md in one atomic commit. Do NOT run the verifier in CI; the fixtures are regression inputs for human triage.

## Standards

- **Target directory:** `.gsd/milestones/M003/slices/S03/smoke/` — matches S01 smoke convention (`.gsd/milestones/M003/slices/S01/smoke/`).
- **Reuse:** `parseMustHaves` + `verifyArtifact` from T01/T02 for the node -e smoke invocations. Consider copying S01 fixtures as starting templates (legacy-plan especially).
- **Naming:** `<scenario>-plan.md`, `<scenario>-source.js`, `RESULTS.md` — matches S01 convention.
- **Lint command:** `node -e "const v=require('./scripts/forge-verifier'); /* smoke each fixture */"` — document the exact commands used in RESULTS.md.
- **Pattern:** S01 smoke fixture pattern (`.gsd/milestones/M003/slices/S01/smoke/RESULTS.md` as reference).
- **Path handling:** fixtures use forward-slash paths in plan frontmatter (portable); runtime uses `path.join` in verifier.
- **Content:** code fixtures must parse — run `node --check legit-source.js` and `node --check stub-source.js`.

## Context

- **Read first:** `.gsd/milestones/M003/slices/S01/smoke/RESULTS.md` — template and style for this task's RESULTS.md.
- **Read:** `.gsd/milestones/M003/slices/S01/smoke/legacy-plan.md` — can be copied as the legacy fixture (update frontmatter id).
- **Read:** S03-PLAN Acceptance Criteria #3 — this task produces the fixtures that gate that criterion.
- **Prior decisions to respect:**
  - MEM044/050: fixtures use LOCKED schema (path/provides/min_lines/stub_patterns? + key_links from/to/via + expected_output top-level).
  - S01 smoke convention: one file per scenario; RESULTS.md records actual vs expected.
- **Non-goals:**
  - CI integration (skipped — this repo has no test runner).
  - Perf measurement (T06).
  - Automated regression comparison (T05 is manual audit trail only).
  - Integration with forge-completer (T04 handles wiring; smoke just validates CLI).
