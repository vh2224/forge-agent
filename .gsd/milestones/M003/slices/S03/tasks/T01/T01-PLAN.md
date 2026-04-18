---
id: T01
slice: S03
milestone: M003
title: "forge-verifier.js core module — 3-level verifyArtifact API + stub regex library"
status: RUNNING
planned: 2026-04-16
must_haves:
  truths:
    - "File scripts/forge-verifier.js exists, parses with `node --check`, and runs end-to-end when required from another CommonJS module."
    - "Module exports `verifyArtifact(mustHaves, sliceFiles)` returning `{exists: bool, substantive: bool, wired: null | bool | 'skipped' | 'approximate', flags: Array<{level, regex_name?, line_number?, matched_text?, reason?}>}`."
    - "When passed a legacy plan signal (parseMustHaves threw / hasStructuredMustHaves false), the module returns rows flagged `skipped: legacy_schema` per declared path, never throws."
    - "Short-circuit is observable: if Exists fails, Substantive and Wired are not evaluated (Wired stub left as `null`); if Substantive fails, Wired is not evaluated."
    - "Module header contains the canonical stub-regex precedence order comment (MEM038) listing every regex by name in evaluation order."
    - "`return null`, empty-function-body, `onClick={() => {}}`, and `return <div />` placeholder regex patterns are all present with canonical names and each emits `{regex_name, line_number, matched_text}` on match."
  artifacts:
    - path: scripts/forge-verifier.js
      provides: "verifyArtifact(mustHaves, sliceFiles) 3-level API + stub regex library + single-invocation file-read cache + short-circuit evaluation. CommonJS dual-mode (CLI in T02). Zero deps."
      min_lines: 220
      stub_patterns: []
  key_links:
    - from: scripts/forge-verifier.js
      to: scripts/forge-must-haves.js
      via: "require('./forge-must-haves') — hasStructuredMustHaves, parseMustHaves"
expected_output:
  - scripts/forge-verifier.js
---

# T01: forge-verifier.js core module

**Slice:** S03  **Milestone:** M003

## Goal

Create `scripts/forge-verifier.js` as a CommonJS module exporting `verifyArtifact(mustHaves, sliceFiles) → {exists, substantive, wired, flags[]}` with the Exists and Substantive levels fully implemented (Wired stubbed to `null` placeholder — T03 fills it in). Include the canonical stub-regex library for JS/TS with documented precedence order.

## Must-Haves

### Truths
- `scripts/forge-verifier.js` exists, `node --check` passes.
- `require('./forge-verifier')` from the repo root returns an object with `verifyArtifact` as a function.
- Calling `verifyArtifact({artifacts: [{path: 'nonexistent.js', min_lines: 5}]}, ['existing.js'])` returns `{exists: false, substantive: null, wired: null, flags: [{level: 'exists', reason: 'file_not_found'}]}` (short-circuit — Substantive/Wired skipped).
- Calling on a 3-line file containing `const x = () => null;` returns `substantive: false` with a flag `{level: 'substantive', regex_name: 'return_null_function', line_number: <n>, matched_text: <string>}`.
- Stub-regex precedence list is present in module header as a top-of-file comment.
- `stub_patterns: []` per-artifact override disables stub detection for that artifact — result `substantive: true` if `min_lines` satisfied.

### Artifacts
- `scripts/forge-verifier.js` — new file, CommonJS, `#!/usr/bin/env node` shebang, ≥ 220 lines. Exports `verifyArtifact`. Private helpers: `checkExists`, `checkSubstantive`, `readFileCached`, `DEFAULT_STUB_REGEXES`. Wired stub returns `null` with flag `{level: 'wired', reason: 'not_implemented_yet'}` — T03 replaces.

### Key Links
- `scripts/forge-verifier.js` → `scripts/forge-must-haves.js` via `require('./forge-must-haves')` — uses `hasStructuredMustHaves` to detect legacy input when caller passes raw plan content (CLI in T02 will do this; module accepts already-parsed `mustHaves` object).

## Steps

1. Create file with shebang, `'use strict'`, header comment block documenting:
   - Module purpose
   - Export signature with type shape
   - **Canonical stub-regex precedence order** (MEM038):
     ```
     // Stub regex precedence order (evaluated in this exact order; first match wins per line):
     //   1. empty_function_body          — function foo() {}, () => {}, async () => {}
     //   2. return_null_function         — function body whose only statement is `return null;`
     //   3. jsx_placeholder_onclick      — onClick={() => {}}
     //   4. jsx_placeholder_return_div   — `return <div />;` or `return <div></div>;`
     //
     // Order matters: empty_function_body must run first because an empty body would also
     // match return_null_function trivially in some edge arrow-function forms.
     ```
2. Require Node built-ins: `fs`, `path`. Require `forge-must-haves` for later CLI use (T02 will exercise; safe to require now — no side effects).
3. Define `DEFAULT_STUB_REGEXES` as an ordered array of `{name, regex, description}` tuples matching the precedence list. Regexes operate on single logical lines (module reads file → splits by `\n`).
   - `empty_function_body`: `/^(?:\s*(?:function|const|let|var|async)\s+\w*\s*[=:]?\s*(?:function\s*)?\w*\s*\([^)]*\)\s*=?>?\s*)\{\s*\}\s*;?\s*$/`
   - `return_null_function`: matches a line that is only `return null;` inside an otherwise empty-body context — do it by scanning the file for `/^\s*return\s+null\s*;?\s*$/m` AND verify the preceding `{` has no other statement before this line (keep heuristic simple — flag every bare `return null;` at function-body indentation; human triages false positives per RISK card).
   - `jsx_placeholder_onclick`: `/onClick\s*=\s*\{\s*\(\s*\)\s*=>\s*\{\s*\}\s*\}/`
   - `jsx_placeholder_return_div`: `/^\s*return\s+<div\s*\/?>\s*<\/div>?\s*;?\s*$/` (and `return <div />;`)

   Tune regexes during implementation; canonical names LOCKED for external reference in VERIFICATION.md.

4. Implement `readFileCached(absPath)` — module-level Map-backed cache for the duration of a single `verifyArtifact` invocation (cache cleared at function entry). Reads with `fs.readFileSync(absPath, 'utf-8')`. Returns `null` if file missing.

5. Implement `checkExists(artifactPath, cwd)`:
   - `absPath = path.join(cwd, artifactPath)`
   - Read file via `readFileCached`. If null → return `{pass: false, flag: {level: 'exists', reason: 'file_not_found', path: artifactPath}}`.
   - If content has zero lines (empty file) → return `{pass: false, flag: {level: 'exists', reason: 'file_empty'}}`.
   - Else → `{pass: true, content, lineCount}`.

6. Implement `checkSubstantive(content, lineCount, artifact)`:
   - If `lineCount < artifact.min_lines` → fail with `{level: 'substantive', reason: 'below_min_lines', actual: lineCount, expected: artifact.min_lines}`.
   - Determine effective regex list: if `artifact.stub_patterns` is `[]` → empty list (detection disabled). If `artifact.stub_patterns` is a non-empty array of regex source strings → compile those plus `DEFAULT_STUB_REGEXES`. If undefined → use `DEFAULT_STUB_REGEXES`.
   - For each line, in precedence order, try each regex; first match wins per line. Collect all matches across lines.
   - If matches exist → fail, emit flag per match with `{level: 'substantive', regex_name, line_number, matched_text}`.
   - Else → `{pass: true}`.

7. Implement `verifyArtifact(mustHaves, sliceFiles, opts={})`:
   - `opts.cwd` defaults to `process.cwd()`.
   - Accept `mustHaves` shape matching `parseMustHaves` output. If `mustHaves === null` or missing `artifacts`, treat as legacy: return `{legacy: true, rows: [{path: '<unknown>', flags: [{level: 'schema', reason: 'legacy_schema'}]}]}`.
   - Detect non-JS/TS: if every `artifact.path` has extension NOT in `{.js, .ts, .tsx, .jsx, .mjs, .cjs}` → set `nonJsTs = true`.
   - For each artifact:
     - Run `checkExists`. On fail → row is `{path, exists: false, substantive: null, wired: null, flags: [existsFlag]}`. Continue to next artifact.
     - Run `checkSubstantive`. On fail → row is `{path, exists: true, substantive: false, wired: null, flags: [...substantiveFlags]}`. Continue.
     - Wired stub: if `nonJsTs` → `wired: 'skipped', flag: {level: 'wired', reason: 'non_js_ts_repo'}`. Else → `wired: null, flag: {level: 'wired', reason: 'not_implemented_yet'}` (T03 replaces).
   - Return `{legacy: false, rows}`.

8. Add `module.exports = { verifyArtifact, DEFAULT_STUB_REGEXES, _private: { checkExists, checkSubstantive, readFileCached } }` — the `_private` key lets T02/T03/T05 smoke-test internals without re-exporting formally.

9. Add `if (require.main === module)` guard at the bottom with a one-line `console.error('CLI is implemented in T02 — import the module instead')` + `process.exit(2)`. T02 replaces.

10. Verify file is ≥ 220 lines (header comment + DEFAULT_STUB_REGEXES + helpers + verifyArtifact + exports). Expand doc comments if below budget.

11. Run `node --check scripts/forge-verifier.js` — must exit 0.

12. Quick smoke from CLI: `node -e "const v=require('./scripts/forge-verifier');console.log(v.verifyArtifact({artifacts:[{path:'scripts/forge-verifier.js',provides:'x',min_lines:10}],key_links:[]},[],{cwd:process.cwd()}))"` — expect `exists: true, substantive: true, wired: null`.

## Standards

- **Target directory:** `scripts/` (per Directory Conventions — executable Node helpers live here).
- **Reuse:** `scripts/forge-must-haves.js` — `hasStructuredMustHaves`, `parseMustHaves`. `scripts/forge-verify.js` lines 420–466 — YAML extract idiom if any new parsing needed (not likely in T01).
- **Naming:** `scripts/forge-<verb>.js` → `scripts/forge-verifier.js`. Functions camelCase (`verifyArtifact`, `checkExists`, `readFileCached`). Constants UPPER_SNAKE (`DEFAULT_STUB_REGEXES`).
- **Lint command:** `node --check scripts/forge-verifier.js` — syntax check only; no test runner in this repo.
- **Pattern:** `follows: Node CLI + module dual-mode` (CLI guard present but empty — T02 fills). CommonJS, `'use strict'`, shebang, `require.main === module` guard.
- **Path handling:** `path.join(cwd, artifactPath)` throughout — never string-concat with `/` or `\`.
- **Error handling:** `readFileSync` wrapped in try/catch returning null on ENOENT; other errors propagate (telemetry convention — this module is control-flow, not silent hook).
- **Zero deps.** Only `fs` and `path` built-ins. No `package.json` changes.
- **Regex precedence comment is MANDATORY** — must appear in header as described in Step 1. Evaluator must use this order (MEM038).

## Context

- **Read first:** `scripts/forge-must-haves.js` (full file) — the companion module this one pairs with. Mirror its style: strict mode, doc comments with `@param`, `// ── Section headers ─────────` dividers.
- **Read next:** `scripts/forge-verify.js` lines 420–466 — YAML extract pattern (future T02/T03 reference; not used in T01 directly).
- **Read next:** `.gsd/milestones/M003/slices/S03/S03-RISK.md` — warnings 1, 2, 4 apply to this task.
- **Prior decisions to respect:**
  - M003/D3 LOCKED: verifier consumes `parseMustHaves` output shape.
  - MEM038: regex precedence order — document explicitly at top.
  - MEM044/050: `artifacts[{path, min_lines, stub_patterns?}]` — do NOT look for other field names.
  - CODING-STANDARDS "Node CLI + module dual-mode" pattern.
  - M002 zero-deps rule — no new `require()` of third-party modules.
- **Non-goals for this task (T03/T04/T05/T06 scope):**
  - Wired implementation (T03 — stub returns null here).
  - CLI argument parsing and VERIFICATION.md writer (T02).
  - forge-completer integration (T04).
  - Smoke fixtures and perf harness (T05/T06).
