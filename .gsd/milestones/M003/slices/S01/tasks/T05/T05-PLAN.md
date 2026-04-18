---
id: T05
slice: S01
milestone: M003
tag: docs
status: DONE
must_haves:
  truths:
    - "Three smoke-demo plan fixtures live under .gsd/milestones/M003/slices/S01/smoke/ — one legacy, one structured-valid, one structured-malformed"
    - "Each fixture runs through `node scripts/forge-must-haves.js --check <fixture>` and produces the documented JSON + exit code"
    - "A shell script smoke-run.sh (or equivalent markdown transcript if shell scripting is out of scope) executes all three and records actual-vs-expected outcomes"
    - "Results are logged in .gsd/milestones/M003/slices/S01/smoke/RESULTS.md — one row per fixture with exit code and JSON output"
    - "The RESULTS.md table shows all three passing (matching expected outcomes)"
  artifacts:
    - path: ".gsd/milestones/M003/slices/S01/smoke/legacy-plan.md"
      provides: "fixture — legacy-style T##-PLAN with markdown ## Must-Haves, no YAML must_haves key"
      min_lines: 20
    - path: ".gsd/milestones/M003/slices/S01/smoke/structured-valid-plan.md"
      provides: "fixture — T##-PLAN with well-formed must_haves + expected_output frontmatter"
      min_lines: 25
    - path: ".gsd/milestones/M003/slices/S01/smoke/structured-malformed-plan.md"
      provides: "fixture — T##-PLAN with must_haves block missing required artifacts[].min_lines"
      min_lines: 20
    - path: ".gsd/milestones/M003/slices/S01/smoke/RESULTS.md"
      provides: "actual vs expected outcomes table for the three fixtures"
      min_lines: 20
  key_links:
    - from: ".gsd/milestones/M003/slices/S01/smoke/RESULTS.md"
      to: "scripts/forge-must-haves.js"
      via: "each fixture is input to `node scripts/forge-must-haves.js --check`; results recorded in RESULTS.md"
expected_output:
  - .gsd/milestones/M003/slices/S01/smoke/legacy-plan.md
  - .gsd/milestones/M003/slices/S01/smoke/structured-valid-plan.md
  - .gsd/milestones/M003/slices/S01/smoke/structured-malformed-plan.md
  - .gsd/milestones/M003/slices/S01/smoke/RESULTS.md
---

# T05: Smoke demos — three plan fixtures × expected outcomes

**Slice:** S01  **Milestone:** M003

## Goal

Produce three T##-PLAN fixtures (legacy / structured-valid / structured-malformed), run each through `scripts/forge-must-haves.js --check`, and record actual-vs-expected outcomes in a `RESULTS.md` table — proving end-to-end that T01's parser and T03's executor check correctly classify the three canonical cases.

## Must-Haves

### Truths
- Three fixture files exist under `.gsd/milestones/M003/slices/S01/smoke/`.
- Each fixture passes the expected classification when run through `node scripts/forge-must-haves.js --check`:
  - `legacy-plan.md` → `{"legacy": true, "valid": true, "errors": []}` + exit `0`.
  - `structured-valid-plan.md` → `{"legacy": false, "valid": true, "errors": []}` + exit `0`.
  - `structured-malformed-plan.md` → `{"legacy": false, "valid": false, "errors": [...]}` + exit `2`.
- `RESULTS.md` contains a table with columns: Fixture | Expected JSON | Expected Exit | Actual JSON | Actual Exit | Pass?.
- All three rows in RESULTS.md are `Pass`.

### Artifacts
- `.gsd/milestones/M003/slices/S01/smoke/legacy-plan.md` — legacy fixture (min 20 lines).
- `.gsd/milestones/M003/slices/S01/smoke/structured-valid-plan.md` — valid fixture (min 25 lines).
- `.gsd/milestones/M003/slices/S01/smoke/structured-malformed-plan.md` — malformed fixture (min 20 lines).
- `.gsd/milestones/M003/slices/S01/smoke/RESULTS.md` — outcome table (min 20 lines).

### Key Links
- `RESULTS.md` → `scripts/forge-must-haves.js` via the CLI invocations — each fixture is an input to `--check` and results are captured.

## Steps

1. Create directory `.gsd/milestones/M003/slices/S01/smoke/` (use `mkdir -p` via Bash or rely on `Write` creating parents).
2. **Write `legacy-plan.md`** — a stylized T##-PLAN that mimics M001/M002 shape: frontmatter with `id`, `slice`, `milestone` only (no `must_haves:` key); body has a free-text `## Must-Haves` markdown section with bullet points. Min 20 lines.
3. **Write `structured-valid-plan.md`** — frontmatter with `id`, `slice`, `milestone`, AND a well-formed `must_haves:` block + `expected_output:` array following the LOCKED schema:
   ```yaml
   must_haves:
     truths:
       - "Example outcome"
     artifacts:
       - path: "example.js"
         provides: "example handler"
         min_lines: 10
     key_links:
       - from: "example.js"
         to: "other.js"
         via: "import"
   expected_output:
     - example.js
   ```
   Body can be a terse `## Goal` + `## Steps`. Min 25 lines.
4. **Write `structured-malformed-plan.md`** — frontmatter with `must_haves:` block but with a defect: `artifacts[0]` is missing the required `min_lines` key. This should be classified as `{legacy: false, valid: false}` by the parser. Min 20 lines.
5. **Run all three fixtures** through the CLI:
   ```bash
   node scripts/forge-must-haves.js --check .gsd/milestones/M003/slices/S01/smoke/legacy-plan.md
   node scripts/forge-must-haves.js --check .gsd/milestones/M003/slices/S01/smoke/structured-valid-plan.md
   node scripts/forge-must-haves.js --check .gsd/milestones/M003/slices/S01/smoke/structured-malformed-plan.md
   ```
   Capture stdout JSON and `echo $?` for each.
6. **Write `RESULTS.md`** — a 3-row table with the captured output vs expected. Include a "Summary" line at the end: `All 3 smoke demos pass — must_haves schema round-trip verified.`
7. Verify:
   - `ls .gsd/milestones/M003/slices/S01/smoke/` lists all 4 files.
   - `grep -c "^| " .gsd/milestones/M003/slices/S01/smoke/RESULTS.md` returns ≥ 4 (header + separator + 3 rows).
   - `grep "Pass" .gsd/milestones/M003/slices/S01/smoke/RESULTS.md | wc -l` returns ≥ 3.

## Standards

- **Target directory:** `.gsd/milestones/M003/slices/S01/smoke/` (new subdir — standard fixture location for this slice).
- **Naming:** kebab-case plan fixtures (`legacy-plan.md`, `structured-valid-plan.md`, `structured-malformed-plan.md`).
- **Pattern:** no code; purely fixture files + results table. Follows no specific Pattern Catalog entry (smoke-demo pattern is ad-hoc but established by GSD-2 convention).
- **Lint:** no Markdown lint configured; verify via grep + filesystem checks in step 7.
- **Tag:** `tag: docs` in frontmatter (above) — this is a documentation/fixture task, not code generation. Tier router downgrades to `light`.

## Context

- Prior decisions to respect: LOCKED schema shape (see S01-PLAN § Schema Shape).
- Key files to read first: `.gsd/milestones/M003/slices/S01/tasks/T01/T01-PLAN.md` (parser contract), `.gsd/milestones/M003/slices/S01/S01-PLAN.md` (schema shape).
- **Dependency ordering:** this task CAN ONLY run after T01 is committed — it invokes the CLI. T02/T03 are NOT strictly required (fixtures test T01's CLI contract; T03's executor hook uses the same CLI). If T05 ran during planning (the executor runs it as part of this task), it will fail until T01 is done — expected ordering.
- The three fixtures serve as **living regression tests** — S03 and S04 can reuse them when validating their own consumers.
- Do NOT write a shell script that the orchestrator is supposed to run later; execute the checks inline during this task and capture results into RESULTS.md.
- AUTO-MEMORY relevance: this fixture set will likely become canonical for future regression — worth remembering as a pattern.
