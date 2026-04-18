---
id: T03
slice: S03
milestone: M003
title: "Import-chain walker — Wired level (depth-2 JS/TS static scan)"
status: RUNNING
planned: 2026-04-16
must_haves:
  truths:
    - "`verifyArtifact` in scripts/forge-verifier.js now returns a concrete `wired: true|false|'skipped'|'approximate'` for JS/TS artifacts (no more `null` placeholder from T01)."
    - "The Wired level succeeds when ≥ 1 import, require, or re-export reference to the artifact is found in another file within the same slice (scope: files under the slice dir OR files declared in other T##'s expected_output)."
    - "Walker is depth-capped at 2 hops — direct imports (depth 1) and one level of barrel/re-export indirection (depth 2). Deeper chains emit `wired: 'approximate', reason: 'depth_limit'`."
    - "Non-JS/TS paths (no .js/.ts/.tsx/.jsx/.mjs/.cjs extension) short-circuit to `wired: 'skipped', reason: 'non_js_ts_repo'` at the per-artifact level (already a passing condition from T01, preserved here)."
    - "Walker handles ESM `import ... from '<spec>'`, CJS `require('<spec>')`, re-export `export ... from '<spec>'`, barrel `export * from '<spec>'` — documented list in module comment."
    - "Walker gracefully handles relative specs (`./x`, `../y/z`) resolved via `path.resolve` against importer's dir; tries `.js`, `.ts`, `.tsx`, `.jsx`, `.mjs`, `.cjs` and `/index.{ext}` for bare dirs."
    - "Absolute/bare package specs (e.g. `lodash`, `react`) are skipped — not part of internal graph."
    - "Walker uses the single-invocation file-read cache from T01 to avoid redundant reads."
  artifacts:
    - path: scripts/forge-verifier.js
      provides: "Replaces Wired placeholder in verifyArtifact with a real depth-2 import-chain walker: walkImports(artifactPath, sliceFiles, {cwd, depth, cache}) + spec-resolution helpers. Expected file growth: +90 lines over T02 baseline."
      min_lines: 420
      stub_patterns: []
  key_links:
    - from: scripts/forge-verifier.js
      to: scripts/forge-verifier.js
      via: "internal — walkImports() consumed by verifyArtifact() within the same module"
expected_output:
  - scripts/forge-verifier.js
---

# T03: Import-chain walker (Wired level)

**Slice:** S03  **Milestone:** M003

## Goal

Replace the `wired: null` placeholder in `verifyArtifact` with a real depth-2 static import-chain walker scoped to the slice's files. Support the four common reference patterns (ESM import, CJS require, re-export, barrel) in JS/TS. Document known limitations (dynamic imports, `module.exports = require(...)` chains, deeper barrels).

## Must-Haves

### Truths
- For the verifier's own integration: calling `verifyArtifact` with an artifact that IS imported by another file in the slice returns `wired: true`.
- For an artifact NOT referenced anywhere → `wired: false, flag: {level: 'wired', reason: 'no_references_found'}`.
- For a barrel chain that needs 3+ hops → `wired: 'approximate', flag: {level: 'wired', reason: 'depth_limit'}`.
- For a non-JS/TS artifact → `wired: 'skipped'` (unchanged from T01).
- Walker reports `{reason, candidates_scanned, depth_reached}` on success/fail for debuggability in VERIFICATION.md.
- Walker never throws — I/O errors per imported file are swallowed (file skipped, logged in candidates_scanned count) to preserve the overall slice verdict.

### Artifacts
- `scripts/forge-verifier.js` — edited. Adds:
  - `SUPPORTED_EXTENSIONS = ['.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs']` constant.
  - `IMPORT_PATTERNS` array of named regexes: `import_from` (`/import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g`), `require_call` (`/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g`), `export_from` (`/export\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g`), `export_star` (`/export\s*\*\s*from\s+['"]([^'"]+)['"]/g`).
  - `resolveSpec(importerAbs, spec, cwd)` — resolves relative specs to absolute paths, tries extensions + `/index.{ext}`, returns null for bare/package specs.
  - `extractImports(content)` — runs all regexes, returns array of `{pattern_name, spec, line_number}`.
  - `walkImports(targetAbs, candidateFiles, {cwd, depth=2, cache})` — BFS across `candidateFiles`, returns `{found, depth_reached, candidates_scanned}`.
  - Integration: `verifyArtifact` now collects `sliceFiles` (passed from T02 CLI OR discovered internally when run programmatically) and invokes `walkImports` per artifact.
- Module comment block listing supported patterns + documented limitations.

### Key Links
- Internal: `verifyArtifact` calls `walkImports` which calls `resolveSpec` and `extractImports`. All within `scripts/forge-verifier.js`.

## Steps

1. Read current `scripts/forge-verifier.js` (T02 output). Locate the Wired placeholder branch inside `verifyArtifact` — this is the extension point.

2. Add `SUPPORTED_EXTENSIONS` constant near `DEFAULT_STUB_REGEXES`.

3. Add `IMPORT_PATTERNS` array. Use global flag (`/g`) to extract all matches per file. Document the order in a comment (same MEM038 convention — precedence doesn't matter for union but order is documented for consistency).

4. Implement `extractImports(content)`:
   - For each `{name, regex}` in IMPORT_PATTERNS:
     - `regex.lastIndex = 0` (reset — global regexes are stateful).
     - Loop `regex.exec(content)` collecting matches. Compute line number from offset (`content.substr(0, match.index).split('\n').length`).
     - Push `{pattern_name: name, spec: match[1], line_number}`.
   - Return array (may contain duplicates — deduped by walker).

5. Implement `resolveSpec(importerAbs, spec, cwd)`:
   - If `spec` doesn't start with `./` or `../` → return null (bare package).
   - Let `base = path.resolve(path.dirname(importerAbs), spec)`.
   - Try in order: `base` (if has extension), `base + ext` for each ext in SUPPORTED_EXTENSIONS, `path.join(base, 'index' + ext)` for each.
   - Return first path that `fs.existsSync` confirms; else null.
   - Normalise via `path.normalize` before returning to handle mixed separators on Windows.

6. Implement `walkImports(targetAbs, candidateFiles, {cwd, depth = 2, cache})`:
   - `visited = new Set()`. `queue = [{file: c, hop: 1} for c in candidateFiles]`.
   - While queue non-empty:
     - `{file, hop} = queue.shift()`. If visited → continue. Add to visited.
     - Read content via cache (`readFileCached(file)`). If null (missing) → continue.
     - `imports = extractImports(content)`.
     - For each imp:
       - `resolved = resolveSpec(file, imp.spec, cwd)`. If resolved === null → continue.
       - `path.normalize(resolved) === path.normalize(targetAbs)` → return `{found: true, depth_reached: hop, candidates_scanned: visited.size, matching_file: file, pattern_name: imp.pattern_name, line_number: imp.line_number}`.
       - Else if hop < depth → push `{file: resolved, hop: hop + 1}`.
   - Loop end: if `depth` was reached but not found → check if any `hop == depth` was visited. If yes → return `{found: false, approximate: true, reason: 'depth_limit', depth_reached: depth, candidates_scanned: visited.size}`. Else → `{found: false, approximate: false, reason: 'no_references_found', candidates_scanned: visited.size}`.

7. Integrate into `verifyArtifact`:
   - After Substantive passes, before the Wired placeholder branch:
     - Compute `artifactAbs = path.join(cwd, artifact.path)`.
     - If non-JS/TS (extension check) → `wired: 'skipped', reason: 'non_js_ts_repo'` (preserved from T01).
     - Else:
       - Build `candidateFiles`: all other `artifacts[].path` in the current `mustHaves` + any paths in `sliceFiles` arg (from T02 discovery). Exclude self. Absolute-path them.
       - Call `walkImports(artifactAbs, candidateFiles, {cwd, depth: 2, cache})`.
       - `found: true` → `wired: true`.
       - `approximate: true` → `wired: 'approximate', flag: {level: 'wired', reason, depth_reached, candidates_scanned}`.
       - `found: false && !approximate` → `wired: false, flag: {level: 'wired', reason: 'no_references_found', candidates_scanned}`.
       - Always include `walker_info: {candidates_scanned, depth_reached, pattern_name?, line_number?}` on the row for VERIFICATION.md to surface.

8. Update the T02 CLI path: `runSliceVerification` should now pass `candidateFiles` (union of all `artifacts[].path` + files discovered in the slice dir) to `verifyArtifact`. Use `path.resolve` to convert to absolute.

9. Update `formatVerificationMd` (T02) to render `wired` cell as: `✓` (true), `✗` (false), `~` (approximate, with reason in flag column), `—` (skipped non-JS/TS or not-evaluated). Add a sentence in the Flags section describing depth-limit approximations.

10. Add module-header comment block documenting:
    ```
    // Import-chain walker — supported patterns:
    //   - import ... from '<spec>'         (ESM)
    //   - require('<spec>')                (CJS)
    //   - export ... from '<spec>'         (ESM re-export)
    //   - export * from '<spec>'           (ESM barrel)
    //
    // Known limitations (heuristic, not semantic analysis):
    //   - Dynamic imports `import('<spec>')` — not detected.
    //   - Computed specs `require(VAR + '/thing')` — not detected.
    //   - `module.exports = require('./x')` CJS chains — detected as single-hop only; deeper chains emit `approximate`.
    //   - TypeScript path aliases from tsconfig `paths` — not resolved; alias'd imports treated as bare specs.
    //   - Re-exports through 3+ barrels — depth-2 cap emits `approximate`.
    //
    // This is a heuristic Wired check — human triages `approximate` / `false` rows.
    ```

11. Run `node --check scripts/forge-verifier.js` — exit 0.

12. Smoke: programmatic test within this task via quick node -e:
    ```bash
    node -e "
    const v = require('./scripts/forge-verifier');
    const mh = {artifacts: [
      {path: 'scripts/forge-verifier.js', provides: 'x', min_lines: 10},
      {path: 'scripts/forge-must-haves.js', provides: 'y', min_lines: 10}
    ], key_links: []};
    console.log(JSON.stringify(v.verifyArtifact(mh, [], {cwd: process.cwd()}), null, 2));
    "
    ```
    Expect `forge-verifier.js` row to show `wired: true` (it requires forge-must-haves.js). Expect `forge-must-haves.js` row to show `wired: false` or `approximate` depending on what else is in the candidate set.

## Standards

- **Target directory:** `scripts/` (editing existing file).
- **Reuse:** `readFileCached` from T01, `fs.existsSync`, `path.resolve`, `path.normalize`, `path.dirname`, `path.join`. Zero new built-ins beyond what T01/T02 already use.
- **Naming:** `walkImports`, `extractImports`, `resolveSpec`, `IMPORT_PATTERNS`, `SUPPORTED_EXTENSIONS` (camelCase functions, UPPER_SNAKE constants).
- **Lint command:** `node --check scripts/forge-verifier.js`.
- **Pattern:** extends the T01/T02 module — no new top-level pattern invoked. Walker BFS is standard.
- **Path handling:** `path.resolve`, `path.normalize` — critical for Windows (`\\` vs `/` comparisons would produce false-negatives without normalize).
- **Error handling:** Walker swallows per-file read errors (file counts as unvisited). Top-level `verifyArtifact` does NOT wrap the walker in try/catch — any programming error should propagate, not silently produce `wired: false`.
- **Regex precedence:** IMPORT_PATTERNS order is documented but does NOT affect union result. Still list in a header comment for consistency with T01 MEM038 precedent.
- **Zero deps.**

## Context

- **Read first:** `scripts/forge-verifier.js` (T02 output) — locate `verifyArtifact` Wired branch.
- **Read:** `.gsd/milestones/M003/slices/S03/S03-RISK.md` — warnings 2 (export detection non-trivial), 6 (barrel depth limit), 9 (export patterns not supported) all apply directly.
- **Read for baseline:** `scripts/forge-hook.js`, `scripts/forge-statusline.js`, `scripts/forge-verify.js` — to confirm our `require`/`module.exports` usage matches the shapes the walker needs to detect. If walker can find these files importing each other, it works.
- **Prior decisions to respect:**
  - MEM052 + RISK: evidence log corroboration DEFERRED — walker is static-only.
  - MEM058: git diff tracked-only — not relevant (walker uses `fs` directly).
  - M003/D4: deletions not tracked — walker does not attempt to verify deleted-file references.
  - CODING-STANDARDS cross-platform `path.*` usage.
- **Performance budget:** T01's single-invocation cache is the primary defence. Walker uses the same cache passed by reference. T06 measures end-to-end.
- **Non-goals:**
  - TypeScript path aliases (`tsconfig.paths`) resolution.
  - Dynamic imports.
  - `module.exports = require('./x')` CJS indirection beyond depth-1.
  - Cross-repo references.
  - Documented in the module-header comment block (step 10).
