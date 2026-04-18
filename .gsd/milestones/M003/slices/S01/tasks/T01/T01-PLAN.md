---
id: T01
slice: S01
milestone: M003
status: DONE
must_haves:
  truths:
    - "scripts/forge-must-haves.js exists, passes `node --check`, and can be required as a CommonJS module"
    - "Calling hasStructuredMustHaves(content) returns true for a plan with a `must_haves:` block at YAML-root and false for free-text-only legacy plans"
    - "Calling parseMustHaves(content) returns {truths:[], artifacts:[{path,provides,min_lines,stub_patterns?}], key_links:[{from,to,via}], expected_output:[paths]} for a well-formed plan"
    - "parseMustHaves throws a structured error when a structured plan is malformed (e.g. missing artifacts[].path or artifacts[].min_lines)"
    - "CLI mode `node scripts/forge-must-haves.js --check <plan.md>` prints JSON to stdout and exits 0 for legacy, 0 for valid-structured, 2 for malformed-structured"
  artifacts:
    - path: "scripts/forge-must-haves.js"
      provides: "hasStructuredMustHaves(planContent) + parseMustHaves(planContent) exports, plus CLI dual-mode"
      min_lines: 120
      stub_patterns: ["return null", "function.*\\{\\s*\\}", "=> \\{\\s*\\}"]
  key_links:
    - from: "agents/forge-executor.md"
      to: "scripts/forge-must-haves.js"
      via: "shell-out `node scripts/forge-must-haves.js --check <plan>` in executor Step 1"
    - from: "scripts/forge-must-haves.js"
      to: "scripts/forge-verify.js"
      via: "reuses YAML frontmatter extract idiom (lines 420-466) — copy-adapt, not require"
expected_output:
  - scripts/forge-must-haves.js
---

# T01: Schema detection predicate + parser helper

**Slice:** S01  **Milestone:** M003

## Goal

Create a single CommonJS module `scripts/forge-must-haves.js` that centralizes the "is this plan legacy or structured?" decision AND parses the structured schema into a normalized object — so the executor (S01/T03), verifier (S03), and plan-checker (S04) all agree on what "well-formed" means.

## Must-Haves

### Truths
- `scripts/forge-must-haves.js` exists, passes `node --check`, and can be `require`d as a CommonJS module.
- `hasStructuredMustHaves(content)` returns `true` for a plan with a `must_haves:` key at YAML-root and `false` for free-text-only legacy plans.
- `parseMustHaves(content)` returns `{truths:[], artifacts:[{path,provides,min_lines,stub_patterns?}], key_links:[{from,to,via}], expected_output:[paths]}` for well-formed plans.
- `parseMustHaves` throws a structured `Error` with message `"malformed must_haves schema: <field> — <reason>"` when a structured plan is malformed.
- CLI: `node scripts/forge-must-haves.js --check <plan.md>` prints JSON `{legacy: bool, valid: bool, errors: []}` and exits `0` for legacy, `0` for valid-structured, `2` for malformed-structured.

### Artifacts
- `scripts/forge-must-haves.js` — CommonJS module (min 120 lines) exporting `hasStructuredMustHaves`, `parseMustHaves`, and with a CLI guard.

### Key Links
- `agents/forge-executor.md` → `scripts/forge-must-haves.js` via `node scripts/forge-must-haves.js --check <plan>` shell-out in executor Step 1 (added in T03).
- `scripts/forge-must-haves.js` adapts the YAML frontmatter extract regex from `scripts/forge-verify.js` lines 420-466 — same shape, scoped to different keys (`must_haves`, `expected_output`).

## Steps

1. Create `scripts/forge-must-haves.js` with shebang `#!/usr/bin/env node` and standard CommonJS header.
2. Implement **frontmatter extract** helper (private): copy the regex from `forge-verify.js` line 430 (`/^---\n([\s\S]*?)\n---/`) + the 1 MB size cap. Return the frontmatter block or `null`.
3. Implement `hasStructuredMustHaves(content)` — exported. Logic:
   - Extract frontmatter; return `false` if none.
   - Match `/^must_haves:\s*$/m` OR `/^must_haves:\s*\n/m` at column 0 of the frontmatter. Both forms count as structured.
   - Return `true` on match, `false` otherwise. Do NOT validate shape here — presence check only.
4. Implement `parseMustHaves(content)` — exported. Logic:
   - If `hasStructuredMustHaves` returns false, throw `Error("plan is legacy — use hasStructuredMustHaves to pre-check")`. Callers must branch.
   - Extract the `must_haves:` indented block (YAML sub-tree) and the sibling `expected_output:` array.
   - Parse minimally with hand-rolled YAML (NO external deps): strings, arrays of strings, arrays of objects with `key: value` children. Handle inline arrays `[a, b]` AND multi-line `- ` form. This mirrors the `verify:` parse in `forge-verify.js` lines 435-458.
   - Validate required keys: `truths` (array of strings), `artifacts` (array of objects with `path` + `provides` + `min_lines`), `key_links` (array of objects with `from` + `to` + `via`), top-level `expected_output` (array of strings).
   - On any missing/wrong-typed required key: `throw new Error("malformed must_haves schema: <field> — <reason>")`.
   - Return the parsed object on success.
5. Implement CLI mode guarded by `require.main === module`:
   - Parse `process.argv`: require `--check <path>` flag (argv parse pattern from `merge-settings.js` lines 15-17).
   - Read file with `readFileSync`; compute `hasStructuredMustHaves`.
   - If legacy → print `{"legacy": true, "valid": true, "errors": []}`, exit `0`.
   - If structured → try `parseMustHaves`; on success print `{"legacy": false, "valid": true, "errors": []}`, exit `0`; on throw print `{"legacy": false, "valid": false, "errors": [<msg>]}`, exit `2`.
   - Top-level try/catch — on I/O error (missing file, etc.) print `{"error": "<msg>"}` to stderr, exit `2`.
6. Verify with `node --check scripts/forge-must-haves.js` (syntax check).
7. Inline smoke: create a temp file with the seed content below and run `node scripts/forge-must-haves.js --check <tmp>` for each of: legacy, valid-structured, malformed. Assert exit codes `0/0/2`.

## Standards

- **Target directory:** `scripts/` (CommonJS executables).
- **Naming:** `forge-must-haves.js` (the `must-haves` name mirrors the schema key).
- **Pattern:** follows `Node CLI + module dual-mode` from the Pattern Catalog.
- **Reuse:** adapt the YAML frontmatter extract regex from `scripts/forge-verify.js` lines 420-466 (copy the shape — do NOT `require` from it; they're siblings, not a dependency chain). Argv parse pattern from `scripts/merge-settings.js` lines 15-17.
- **Lint:** `node --check scripts/forge-must-haves.js` (no other tooling configured — per CODING-STANDARDS § Lint & Format).
- **Error pattern:** exit `0` on logical outcomes (legacy + valid + malformed are all "successfully classified"), exit `2` on parse/IO errors. NO silent-fail try/catch wrapping the whole thing — follow the `forge-verify.js` precedent: propagate I/O errors, don't eat them.

## Context

- Prior decisions to respect: D3 (planner emits always; executor blocks on missing), CODING-STANDARDS "Node CLI + module dual-mode" pattern, MEM017 (no third-party deps), M002 zero-deps rule.
- Key files to read first: `scripts/forge-verify.js` lines 420-466 (regex shape), `scripts/forge-classify-error.js` (reference for CLI dual-mode template, lines 111-143 per Asset Map), `scripts/merge-settings.js` lines 15-17 (argv parsing).
- The executor will shell out to this CLI (not require the module) because the executor is an agent (Markdown, not JS). Keep the JSON contract stable — S03 and S04 may `require` the module directly when added later.
- No external YAML dep allowed. The schema is small and deterministic enough for hand-rolled parsing; `forge-verify.js` proves the pattern works for similar shapes.
