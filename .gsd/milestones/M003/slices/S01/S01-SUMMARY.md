---
id: S01
milestone: M003
provides:
  - "scripts/forge-must-haves.js — CommonJS parser/validator with hasStructuredMustHaves() + parseMustHaves() + CLI --check"
  - "CLI exit codes: 0 legacy, 0 valid structured, 2 malformed structured"
  - "agents/forge-planner.md — ## Must-Haves Schema section; unconditional emit contract"
  - "agents/forge-executor.md — step 1a schema validation; blocks malformed, warns legacy"
  - "forge-agent-prefs.md — evidence: {mode: lenient} section (inert until S02)"
  - "Smoke fixtures: legacy-plan.md / structured-valid-plan.md / structured-malformed-plan.md"
  - "Schema shape locked: truths[], artifacts[{path,provides,min_lines,stub_patterns?}], key_links[{from,to,via}], expected_output[]"
  - "Backward-compat skip: legacy plans pass executor validation with warn note"
key_files:
  - scripts/forge-must-haves.js
  - agents/forge-planner.md
  - agents/forge-executor.md
  - forge-agent-prefs.md
  - .gsd/milestones/M003/slices/S01/smoke/legacy-plan.md
  - .gsd/milestones/M003/slices/S01/smoke/structured-valid-plan.md
  - .gsd/milestones/M003/slices/S01/smoke/structured-malformed-plan.md
  - .gsd/milestones/M003/slices/S01/smoke/RESULTS.md
key_decisions:
  - "[ \\t]* not \\s* in extractTopLevelValue regex — \\s matches newlines, causing greedy cross-line capture"
  - "extractSubBlock + dedent pattern for nested YAML maps (not recursive parseYamlValue)"
  - "Step 1a inserted between step 1 and step 2 in executor — BEFORE-RUNNING invariant preserved; no cascading renumbers"
  - "evidence.mode default is lenient — scaffolded inert, S02 wires consumption"
  - "Malformed fixture: omits artifacts[0].min_lines only — minimal defect hitting specific validator path"
patterns_established:
  - "extractSubBlock(yaml, key) + dedent-2-spaces for parsing YAML nested maps in forge-must-haves.js"
  - "Smoke fixture convention: one file per scenario under smoke/; RESULTS.md records actual vs expected"
  - "CLI dual-mode pattern: exports + require.main === module guard (reused by S03 forge-verifier.js)"
---

S01 establishes the machine-parseable `must_haves:` + `expected_output:` YAML schema as the single source of truth between planner and executor, enforced at task start, with backward-compatible pass-through for legacy plans.

## What Was Built

Five tasks delivered the full schema stack in dependency order:

**T01 — forge-must-haves.js** (`scripts/forge-must-haves.js`, new, 45min): Hand-rolled YAML parser using only Node built-ins. Exports `hasStructuredMustHaves(content)` (presence check) and `parseMustHaves(content)` (full validation returning `{legacy, valid, errors}`). CLI `--check <plan.md>` exits 0 for legacy, 0 for valid structured, 2 for malformed. Key fix: `[ \t]*` not `\s*` after colon — `\s` matches newlines, causing greedy capture of the next indented line into the regex group. Nested YAML maps parsed via `extractSubBlock + dedent` pattern instead of recursive descent.

**T02 — forge-planner.md** (`agents/forge-planner.md`, edit, 5min): Added `## Must-Haves Schema (required on every T##-PLAN)` section with the locked YAML shape and unconditional emit contract. Annotated the per-task template block. Schema embedded verbatim so every future T##-PLAN matches the `parseMustHaves` contract.

**T03 — forge-executor.md** (`agents/forge-executor.md`, edit, 5min): Inserted step 1a between step 1 (Read plan) and step 2 (Read Standards). Malformed structured plans block via `status: blocked / blocker_class: scope_exceeded / missing_must_haves_schema`. Legacy plans (no `must_haves:` key) pass through with `legacy_schema: true` warn note. Added `legacy_schema` optional field to Summary Format. BEFORE-RUNNING invariant preserved.

**T04 — forge-agent-prefs.md** (edit, 5min): Added `## Evidence Settings` section with `evidence: {mode: lenient}` default. Documents lenient/strict/disabled semantics in pt-BR for S02. Section placed between Verification Settings and Token Budget Settings.

**T05 — smoke fixtures** (new, 5min): Three plan fixtures under `.gsd/milestones/M003/slices/S01/smoke/` — legacy (exit 0 / legacy:true), structured-valid (exit 0 / valid:true), structured-malformed (exit 2 / valid:false, missing `min_lines`). RESULTS.md records actual output strings for regression reference.

## Smoke Demo Outcomes

| Fixture | exit | valid | legacy | Error |
|---------|------|-------|--------|-------|
| legacy-plan.md | 0 | true | true | — |
| structured-valid-plan.md | 0 | true | false | — |
| structured-malformed-plan.md | 2 | false | false | `malformed must_haves schema: artifacts[0].min_lines — required number field missing` |

## Verification Gate

```
node scripts/forge-verify.js --cwd "C:/DEV/forge-agent" --unit complete-slice/S01
```

**Result:** skipped (no-stack)
**Discovery source:** none
**Raw output:** `{"passed":true,"checks":[],"discoverySource":"none","skipped":"no-stack","timestamp":1776393684407}`
**Explanation:** No test stack configured for this project (CODING-STANDARDS confirms: syntax checks via `node --check` only, no test runner). Gate passes by convention — verification is via UAT script and smoke demo outcomes documented above.

## Forward Intelligence (for S02)

**What S02 needs from this slice:**

- `expected_output:` is a **top-level YAML key** (sibling to `must_haves:`), not nested inside it. Parsed by `parseMustHaves().expected_output` — an array of path strings. S02's file-audit reads this field to build the expected-change set.
- `hasStructuredMustHaves(content)` returns `true` only if `must_haves:` key is present at YAML root. S02 should call this before attempting `parseMustHaves` to avoid throwing on legacy summaries.
- `parseMustHaves` throws `Error("malformed must_haves schema: <field> — <reason>")` on invalid shape — S02 must wrap in try/catch and treat the thrown error as `legacy:true` for file-audit purposes (safe-fail).
- `evidence.mode` key is in `forge-agent-prefs.md` under `evidence:` block. S02 must read this from prefs and wire: `lenient` = flag in SUMMARY, `strict` = block, `disabled` = skip hook writes. The key exists but has zero consumers today.

**What's fragile:**

- The YAML parser is hand-rolled and makes assumptions about two-space indentation. Plans that mix tabs/spaces in the `must_haves:` block will silently mis-parse (fields return undefined instead of throwing). S02's evidence schema should not rely on `parseMustHaves` being infallible — always check `result.valid` before trusting fields.
- `extractTopLevelValue` is regex-based and only matches single-line values. Any field value that spans multiple lines (e.g., a `provides:` string with a newline) will return `null` (treated as "not on this line → sub-block"). This is intentional — top-level arrays/maps become null and are parsed by `extractSubBlock`. S02 should be aware that `expected_output` values may include a mix of paths from multiple tasks; dedup before diffing against `git diff`.

**Assumptions that changed during implementation:**

- T01 initially planned to use `\\s*` in the extractTopLevelValue regex (matching forge-verify.js idiom). Changed to `[ \\t]*` after discovering `\\s` crossed line boundaries. Any S02/S03 code that copies the regex pattern should use `[ \\t]*` not `\\s*`.
- The `expected_output:` field is at the top level of frontmatter, not inside `must_haves:`. This was in the spec but easy to misread. S02 should grep the test fixture (`structured-valid-plan.md`) to confirm position before implementing file-audit.

**Diagnostics:**

- Run `node scripts/forge-must-haves.js --check <plan.md>` for any plan to get JSON stdout + exit code.
- All three smoke fixtures in `.gsd/milestones/M003/slices/S01/smoke/` serve as regression inputs for S03 (stub-detection bypass for known-good/known-bad shapes).

## drill_down_paths

- T01: `.gsd/milestones/M003/slices/S01/tasks/T01/T01-SUMMARY.md`
- T02: `.gsd/milestones/M003/slices/S01/tasks/T02/T02-SUMMARY.md`
- T03: `.gsd/milestones/M003/slices/S01/tasks/T03/T03-SUMMARY.md`
- T04: `.gsd/milestones/M003/slices/S01/tasks/T04/T04-SUMMARY.md`
- T05: `.gsd/milestones/M003/slices/S01/tasks/T05/T05-SUMMARY.md`
