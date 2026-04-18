---
id: T02
slice: S03
milestone: M003
title: "CLI dual-mode + S##-VERIFICATION.md writer"
status: DONE
planned: 2026-04-16
must_haves:
  truths:
    - "Running `node scripts/forge-verifier.js --slice S03 --milestone M003 --cwd <repo>` exits 0 and writes `.gsd/milestones/M003/slices/S03/S03-VERIFICATION.md`."
    - "CLI prints a single JSON line to stdout summarising `{slice, milestone, rows: [{path, exists, substantive, wired, flags}], duration_ms}`."
    - "CLI discovers all `T##-PLAN.md` under the slice dir, calls `hasStructuredMustHaves` + `parseMustHaves` on each, aggregates artifacts, runs `verifyArtifact` against the union."
    - "Legacy plans (no `must_haves:`) contribute one `skipped: legacy_schema` row in VERIFICATION.md per plan — never crash."
    - "Malformed structured plans (parseMustHaves throws) produce one `skipped: malformed_schema` row with the error message; other plans in the slice still process."
    - "VERIFICATION.md has: frontmatter (`id, slice, milestone, generated_at, duration_ms, verifier_version`), one-paragraph summary, `## Artifact Audit` table, `## Flags` narrative section (per-row failure details)."
    - "Missing args (`--slice` or `--milestone`) print usage to stderr and exit 2."
  artifacts:
    - path: scripts/forge-verifier.js
      provides: "CLI entry (replaces T01 stub): argv parser, slice discovery, plan aggregation, verifyArtifact dispatch, VERIFICATION.md writer. Expected file growth: +120 lines over T01 baseline."
      min_lines: 340
      stub_patterns: []
  key_links:
    - from: scripts/forge-verifier.js
      to: scripts/forge-must-haves.js
      via: "require('./forge-must-haves') — hasStructuredMustHaves, parseMustHaves (now exercised by CLI)"
expected_output:
  - scripts/forge-verifier.js
---

# T02: CLI dual-mode + VERIFICATION.md writer

**Slice:** S03  **Milestone:** M003

## Goal

Extend `scripts/forge-verifier.js` with a full CLI entry point that reads a slice directory, aggregates `must_haves.artifacts[]` from all `T##-PLAN.md` files, dispatches `verifyArtifact` from T01, and writes a formatted `S##-VERIFICATION.md` artifact into the slice directory.

## Must-Haves

### Truths
- `node scripts/forge-verifier.js --slice S03 --milestone M003 --cwd C:/DEV/forge-agent` exits 0 (success), writes the VERIFICATION.md, and prints JSON to stdout.
- `--help` or missing args → usage on stderr, exit 2.
- VERIFICATION.md contains the expected frontmatter keys + `## Artifact Audit` markdown table with per-row `artifact | exists | substantive | wired | flags` columns.
- Running against a slice with only the S01 structured-valid smoke fixture produces at least one row with `exists: ✓, substantive: ✓, wired: — (T03 placeholder or non_js_ts)`.
- Running against S01 legacy fixture produces `skipped: legacy_schema` rows.
- CLI completes in ≤ 2s wall-clock for 10 artifacts (measured via `process.hrtime.bigint()` and reported as `duration_ms` in JSON + frontmatter).

### Artifacts
- `scripts/forge-verifier.js` — edited (not replaced). Adds CLI block in `require.main === module` guard: argv parser, `discoverTaskPlans(sliceDir)`, `aggregateMustHaves(plans)`, `formatVerificationMd(result)`, `writeVerificationMd(sliceDir, md)`. Total file ≥ 340 lines.

### Key Links
- `scripts/forge-verifier.js` → `scripts/forge-must-haves.js` via `require('./forge-must-haves').hasStructuredMustHaves` and `.parseMustHaves` — CLI uses both: presence check before parse, try/catch around parse for malformed.

## Steps

1. Read current `scripts/forge-verifier.js` (T01 output). Confirm the CLI guard stub is present; replace its body with the new CLI.

2. Add argv parser in the guard:
   ```javascript
   function parseArgv(argv) {
     const opts = { slice: null, milestone: null, cwd: process.cwd(), help: false };
     for (let i = 0; i < argv.length; i++) {
       const a = argv[i];
       if (a === '--help' || a === '-h') { opts.help = true; continue; }
       if (a === '--slice' && argv[i+1]) { opts.slice = argv[++i]; continue; }
       if (a === '--milestone' && argv[i+1]) { opts.milestone = argv[++i]; continue; }
       if (a === '--cwd' && argv[i+1]) { opts.cwd = argv[++i]; continue; }
     }
     return opts;
   }
   ```

3. Usage string on stderr if `--help`, missing `--slice`, or missing `--milestone`:
   ```
   Usage: node scripts/forge-verifier.js --slice <S##> --milestone <M###> [--cwd <dir>]
   Writes .gsd/milestones/<M###>/slices/<S##>/<S##>-VERIFICATION.md.
   ```
   Exit 2.

4. Implement `discoverTaskPlans(sliceDir)`:
   - Base: `path.join(cwd, '.gsd', 'milestones', milestone, 'slices', slice, 'tasks')`.
   - Enumerate subdirs matching `/^T\d{2}$/`. For each, probe for `T##-PLAN.md`.
   - Return array of `{taskId: 'T##', absPath: '<...T##-PLAN.md>'}`.
   - If tasks dir is missing → return `[]` and flag at the slice level (`reason: no_tasks_dir`).

5. Implement `aggregateMustHaves(plans)`:
   - For each plan path:
     - Read content. If file missing → push `{taskId, status: 'skipped', reason: 'file_not_found'}` to errors.
     - Call `hasStructuredMustHaves(content)`. If false → push `{taskId, status: 'legacy'}` (not error).
     - If true → try/catch `parseMustHaves(content)`. On throw → push `{taskId, status: 'malformed', error: err.message}`. On success → push `{taskId, status: 'structured', mustHaves, planPath}`.
   - Return `{structured: [...], legacy: [...], malformed: [...], errors: [...]}`.

6. Implement `runSliceVerification(opts)`:
   - `start = process.hrtime.bigint()`.
   - `plans = discoverTaskPlans(...)`.
   - `agg = aggregateMustHaves(plans)`.
   - Concatenate all structured artifacts into one array (with `sourceTask: 'T##'` tagged on each so VERIFICATION.md can show provenance).
   - Build a combined `mustHaves` object `{artifacts: [...tagged], key_links: []}` and call `verifyArtifact(combined, /* sliceFiles for T03 */ [], {cwd: opts.cwd})`.
   - For each legacy plan → synthesise a row `{path: planPath, exists: null, substantive: null, wired: null, flags: [{level: 'schema', reason: 'legacy_schema', source_task: taskId}]}`.
   - For each malformed plan → row with `reason: 'malformed_schema', error: err.message`.
   - `duration_ms = Number(process.hrtime.bigint() - start) / 1e6`.
   - Return `{slice, milestone, generated_at: new Date().toISOString(), duration_ms, rows, legacy_count, malformed_count, error_count}`.

7. Implement `formatVerificationMd(result)` — string-returning function producing:
   ```markdown
   ---
   id: <slice>-VERIFICATION
   slice: <S##>
   milestone: <M###>
   generated_at: <ISO>
   duration_ms: <n>
   verifier_version: "v1.0 (T01/T02 baseline; T03 adds Wired)"
   legacy_count: <n>
   malformed_count: <n>
   ---

   # <S##>: Goal-backward Verification

   Advisory only — heuristic 3-level audit (Exists / Substantive / Wired).
   Stub detection is regex-based; Wired is depth-2 import-chain scan (JS/TS only).
   This file is generated by `scripts/forge-verifier.js` and never blocks slice closure.

   ## Artifact Audit

   | Source | Artifact | Exists | Substantive | Wired | Flags |
   |--------|----------|--------|-------------|-------|-------|
   | T01    | scripts/x.js | ✓ | ✓ | ✓ | — |
   | T02    | scripts/y.js | ✓ | ✗ | — | `return_null_function` at y.js:14 |
   | T03    | (legacy plan) | — | — | — | `skipped: legacy_schema` |

   ## Flags

   (Full flag narrative — one section per failing row, including regex name, line number, matched text. Omit if no flags.)

   ## Performance

   - Wall-clock: <n> ms
   - Artifacts audited: <n>
   - Budget: ≤ 2000 ms per 10 artifacts (hot cache)
   ```
   Use `✓` for pass, `✗` for fail, `—` for skipped/not-evaluated. Keep table cells short; detailed flags in `## Flags`.

8. Implement `writeVerificationMd(sliceDir, md)`:
   - `outPath = path.join(sliceDir, `${sliceId}-VERIFICATION.md`)`.
   - `fs.mkdirSync(path.dirname(outPath), {recursive: true})`.
   - `fs.writeFileSync(outPath, md, 'utf-8')`.
   - Returns `outPath`.

9. CLI wiring in the guard:
   ```javascript
   if (require.main === module) {
     const opts = parseArgv(process.argv.slice(2));
     if (opts.help || !opts.slice || !opts.milestone) { /* stderr + exit 2 */ }
     try {
       const result = runSliceVerification(opts);
       const md = formatVerificationMd(result);
       const sliceDir = path.join(opts.cwd, '.gsd', 'milestones', opts.milestone, 'slices', opts.slice);
       writeVerificationMd(sliceDir, md);
       process.stdout.write(JSON.stringify(result) + '\n');
       process.exit(0);
     } catch (e) {
       process.stderr.write(JSON.stringify({error: e.message, stack: e.stack}) + '\n');
       process.exit(2);
     }
   }
   ```

10. Run `node --check scripts/forge-verifier.js` — exit 0.

11. Smoke test: copy S01 structured-valid fixture into a fake slice dir under `.gsd/milestones/M003/slices/S99/tasks/T01/T01-PLAN.md` (local scratch — do NOT commit). Run CLI, verify VERIFICATION.md appears, delete scratch.

12. Integration with evidence log (OPTIONAL, DEFER): do NOT read evidence-*.jsonl in this task. Documented in T03 Non-Goals; Wired level keeps to static scan.

## Standards

- **Target directory:** `scripts/` (extending existing file).
- **Reuse:** `hasStructuredMustHaves` + `parseMustHaves` from `scripts/forge-must-haves.js`. `fs`/`path` built-ins. `process.hrtime.bigint` for timing.
- **Naming:** camelCase for helpers (`discoverTaskPlans`, `aggregateMustHaves`, `runSliceVerification`, `formatVerificationMd`, `writeVerificationMd`). No new UPPER_SNAKE constants required.
- **Lint command:** `node --check scripts/forge-verifier.js`.
- **Pattern:** `follows: Node CLI + module dual-mode` — CLI reads argv flags (Asset Map entry: `argv flag parser idiom`, `merge-settings.js` lines 15-17 pattern).
- **Path handling:** `path.join` throughout; never hardcode `/`. `cwd` from `--cwd` or `process.cwd()`.
- **Error handling:** CLI wrapper try/catch; on thrown error, print JSON to stderr and exit 2. Non-crashing errors (missing task dir, malformed plan) surface as rows in VERIFICATION.md — never throw.
- **Frontmatter:** Use `[ \t]*` if matching any frontmatter key (MEM047); T02 does not parse frontmatter directly (delegates to `forge-must-haves.js`), but any ad-hoc regex must follow MEM047.
- **Zero deps.**

## Context

- **Read first:** `scripts/forge-verifier.js` (T01 output) — extend, don't replace.
- **Read:** `scripts/forge-must-haves.js` CLI block (lines 325–370) — same dual-mode pattern, reuse the structure (argv scan, try/catch around parse, JSON stdout + specific exit codes).
- **Read:** `.gsd/milestones/M003/slices/S01/smoke/structured-valid-plan.md` — confirm fixture is usable for smoke.
- **Prior decisions to respect:**
  - MEM052 + RISK: evidence log NOT consulted in v1 Wired — T02 does not read `evidence-*.jsonl`.
  - MEM058: git diff tracked-only — not relevant for T02 (no git shell-outs).
  - CODING-STANDARDS "argv flag parser idiom" (`--flag` + `indexOf+1` for value).
  - D3: verifier consumes parseMustHaves output shape verbatim.
- **Fragile edges surfaced in S01-SUMMARY:** parseMustHaves throws on malformed; wrap in try/catch and treat as `malformed_schema` row (not a crash).
- **Path for VERIFICATION.md:** `<cwd>/.gsd/milestones/<M###>/slices/<S##>/<S##>-VERIFICATION.md`.
- **Non-goals for this task:** Wired implementation (T03), forge-completer wire (T04), smoke fixtures (T05), perf harness (T06).
