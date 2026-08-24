#!/usr/bin/env node
// forge-verifier.js — Goal-backward artifact verifier (3-level API)
//
// Exports:
//   verifyArtifact(mustHaves, sliceFiles, opts?) → { legacy, rows }
//     Each row: { path, exists, substantive, wired, flags[] }
//     flags item: { level, reason?, regex_name?, line_number?, matched_text? }
//
//   DEFAULT_STUB_REGEXES — ordered array of { name, regex, description }
//
//   _private: { checkExists, checkSubstantive, readFileCached }
//     Exposed for T02/T03/T05 smoke tests without formal re-export.
//
// ──────────────────────────────────────────────────────────────────────────────
// Stub regex precedence order (evaluated in this exact order; first match wins per line):
//   1. empty_function_body          — function foo() {}, () => {}, async () => {}
//   2. return_null_function         — bare `return null;` at function-body indentation
//   3. jsx_placeholder_onclick      — onClick={() => {}}
//   4. jsx_placeholder_return_div   — `return <div />;` or `return <div></div>;`
//
// Order matters: empty_function_body must run first because an empty body would also
// match return_null_function trivially in some edge arrow-function forms.
// ──────────────────────────────────────────────────────────────────────────────
//
// 3-level verification:
//   Level 1 — Exists:       file present + non-empty
//   Level 2 — Substantive:  meets min_lines + no stub patterns
//   Level 3 — Wired:        depth-2 import-chain scan (T03 implementation)
//
// Short-circuit rules:
//   Exists fails  → Substantive and Wired not evaluated (Wired stays null)
//   Substantive fails → Wired not evaluated (Wired stays null)
//
// Zero dependencies — only Node built-ins fs and path.
// Companion module: scripts/forge-must-haves.js (hasStructuredMustHaves, parseMustHaves)
//
// ──────────────────────────────────────────────────────────────────────────────
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
// ──────────────────────────────────────────────────────────────────────────────

'use strict';

const fs   = require('fs');
const path = require('path');

// Loaded for key-link resolution in T03 and for CLI in T02.
// No side effects on require — safe to load unconditionally.
const { hasStructuredMustHaves, parseMustHaves } = require('./forge-must-haves');

// ── Constants ─────────────────────────────────────────────────────────────────

/** File extensions treated as JS/TS for stub detection. */
const JS_TS_EXTENSIONS = new Set(['.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs']);

/**
 * Ordered list of supported extensions for import resolution.
 * Used by resolveSpec() to try bare names and directories.
 * Order: .js first (CJS-compat), then TS variants, then ESM-only.
 */
const SUPPORTED_EXTENSIONS = ['.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs'];

/**
 * Import pattern registry — all patterns whose capture group 1 is the import specifier.
 * Order is documented for consistency (does NOT affect union result — all patterns run).
 *   1. import_from    — ESM import ... from '...'
 *   2. require_call   — CJS require('...')
 *   3. export_from    — ESM re-export: export ... from '...'
 *   4. export_star    — ESM barrel: export * from '...'
 *
 * IMPORTANT: Each regex uses the /g flag. Callers MUST reset lastIndex = 0 before use.
 */
const IMPORT_PATTERNS = [
  {
    name: 'import_from',
    regex: /import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g,
    description: "ESM import ... from '<spec>'",
  },
  {
    name: 'require_call',
    regex: /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    description: "CJS require('<spec>')",
  },
  {
    name: 'export_from',
    regex: /export\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g,
    description: "ESM re-export: export ... from '<spec>'",
  },
  {
    name: 'export_star',
    regex: /export\s*\*\s*from\s+['"]([^'"]+)['"]/g,
    description: "ESM barrel: export * from '<spec>'",
  },
];

// ── Stub regex library ────────────────────────────────────────────────────────

/**
 * Default stub-pattern registry.
 * Evaluated in this exact precedence order; first match per line wins.
 * Names are LOCKED — external VERIFICATION.md references them by name.
 *
 * @type {Array<{name: string, regex: RegExp, description: string}>}
 */
const DEFAULT_STUB_REGEXES = [
  {
    name: 'empty_function_body',
    // Matches a line whose entire content is an empty-body function/arrow declaration.
    // Handles: function foo() {}, const foo = () => {}, async () => {}, var bar = function() {}
    regex: /^\s*(?:(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+\w*\s*\([^)]*\)|(?:(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\([^)]*\)\s*=>|(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?function\s*\w*\s*\([^)]*\)|(?:async\s+)?\([^)]*\)\s*=>))\s*\{\s*\}\s*;?\s*$/,
    description: 'Function or arrow with completely empty body {}',
  },
  {
    name: 'return_null_function',
    // Matches a line that is solely `return null;` — bare stub body.
    // Heuristic: flags every occurrence; human triages false positives (per RISK card).
    regex: /^\s*return\s+null\s*;?\s*$/,
    description: 'Bare `return null;` indicating unimplemented function body',
  },
  {
    name: 'jsx_placeholder_onclick',
    // Matches JSX onClick handler with empty arrow: onClick={() => {}}
    regex: /onClick\s*=\s*\{\s*\(\s*\)\s*=>\s*\{\s*\}\s*\}/,
    description: 'JSX onClick={() => {}} empty handler placeholder',
  },
  {
    name: 'jsx_placeholder_return_div',
    // Matches return <div /> or return <div></div> as a stub UI
    regex: /^\s*return\s+<div\s*\/?>(\s*<\/div>)?\s*;?\s*$/,
    description: 'JSX stub: return <div /> or return <div></div>',
  },
];

// ── File cache ────────────────────────────────────────────────────────────────

/** Module-level cache map; cleared at each verifyArtifact() entry. */
let _fileCache = new Map();

/**
 * Read a file, using the per-invocation cache.
 * Returns null if the file does not exist (ENOENT).
 * Other errors propagate (caller handles telemetry).
 *
 * @param {string} absPath  Absolute path to file
 * @returns {string|null}
 */
function readFileCached(absPath) {
  if (_fileCache.has(absPath)) {
    return _fileCache.get(absPath);
  }
  let content;
  try {
    content = fs.readFileSync(absPath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      _fileCache.set(absPath, null);
      return null;
    }
    throw err;
  }
  _fileCache.set(absPath, content);
  return content;
}

// ── Import-chain walker helpers ───────────────────────────────────────────────

/**
 * Extract all import/require/export specifiers from file content.
 * Runs all IMPORT_PATTERNS and returns a deduplicated list of matches.
 * Line numbers are 1-indexed.
 *
 * @param {string} content  File content
 * @returns {Array<{pattern_name: string, spec: string, line_number: number}>}
 */
function extractImports(content) {
  const results = [];
  for (const { name, regex } of IMPORT_PATTERNS) {
    regex.lastIndex = 0; // reset stateful global regex
    let match;
    while ((match = regex.exec(content)) !== null) {
      const spec = match[1];
      const lineNumber = content.substr(0, match.index).split('\n').length;
      results.push({ pattern_name: name, spec, line_number: lineNumber });
    }
  }
  return results;
}

/**
 * Resolve an import specifier relative to the importing file.
 * Returns the absolute normalised path if found on disk, or null for:
 *   - bare/package specs (no leading ./ or ../)
 *   - specs that cannot be resolved to any existing file
 *
 * Resolution order for `base`:
 *   1. base as-is (if it already has a recognised extension)
 *   2. base + each SUPPORTED_EXTENSION
 *   3. base/index + each SUPPORTED_EXTENSION
 *
 * @param {string} importerAbs  Absolute path of the file containing the import
 * @param {string} spec         Raw import specifier string
 * @param {string} _cwd         Working directory (unused; reserved for future alias resolution)
 * @returns {string|null}
 */
function resolveSpec(importerAbs, spec, _cwd) {
  if (!spec.startsWith('./') && !spec.startsWith('../')) {
    return null; // bare/package spec — skip
  }

  const base = path.resolve(path.dirname(importerAbs), spec);

  // Try base as-is first (may already have extension)
  if (SUPPORTED_EXTENSIONS.includes(path.extname(base).toLowerCase()) && fs.existsSync(base)) {
    return path.normalize(base);
  }

  // Try base + extension
  for (const ext of SUPPORTED_EXTENSIONS) {
    const candidate = base + ext;
    if (fs.existsSync(candidate)) {
      return path.normalize(candidate);
    }
  }

  // Try base/index + extension (directory import)
  for (const ext of SUPPORTED_EXTENSIONS) {
    const candidate = path.join(base, 'index' + ext);
    if (fs.existsSync(candidate)) {
      return path.normalize(candidate);
    }
  }

  return null;
}

/**
 * BFS import-chain walker. Searches candidateFiles (and files reachable from them
 * up to `depth` hops) for any reference to targetAbs.
 *
 * @param {string}   targetAbs       Absolute path of the artifact we are checking
 * @param {string[]} candidateFiles  Absolute paths of peer files to start BFS from
 * @param {object}   opts
 * @param {string}   opts.cwd        Working directory
 * @param {number}   [opts.depth=2]  Maximum hop depth
 * @param {Map}      [opts.cache]    Optional external file cache (readFileCached's _fileCache)
 * @returns {object}  BFS result object
 */
function walkImports(targetAbs, candidateFiles, opts) {
  const cwd = opts.cwd;
  const maxDepth = (opts.depth !== undefined) ? opts.depth : 2;
  // Use the shared cache if provided so we don't re-read files already read by verifyArtifact
  // (MEM073: pass cache by reference through opts)

  const visited = new Set();
  let anyHopAtMaxDepth = false;

  // Queue entries: { file: absPath, hop: 1..maxDepth }
  const queue = candidateFiles.map(f => ({ file: f, hop: 1 }));

  while (queue.length > 0) {
    const { file, hop } = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);

    if (hop === maxDepth) {
      anyHopAtMaxDepth = true;
    }

    // Read content — swallow per-file errors (ENOENT etc.)
    let content;
    try {
      content = readFileCached(file);
    } catch (_err) {
      continue; // file unreadable — skip, counts as visited
    }
    if (content === null) continue;

    const imports = extractImports(content);
    for (const imp of imports) {
      const resolved = resolveSpec(file, imp.spec, cwd);
      if (resolved === null) continue;

      if (path.normalize(resolved) === path.normalize(targetAbs)) {
        return {
          found: true,
          depth_reached: hop,
          candidates_scanned: visited.size,
          matching_file: file,
          pattern_name: imp.pattern_name,
          line_number: imp.line_number,
        };
      }

      // Enqueue for next hop if within depth budget
      if (hop < maxDepth && !visited.has(resolved)) {
        queue.push({ file: resolved, hop: hop + 1 });
      }
    }
  }

  // Not found — distinguish depth_limit from no_references_found
  if (anyHopAtMaxDepth) {
    return {
      found: false,
      approximate: true,
      reason: 'depth_limit',
      depth_reached: maxDepth,
      candidates_scanned: visited.size,
    };
  }

  return {
    found: false,
    approximate: false,
    reason: 'no_references_found',
    candidates_scanned: visited.size,
  };
}

// ── Level 1: Exists ───────────────────────────────────────────────────────────

/**
 * Level-1 check: does the artifact file exist and have content?
 *
 * @param {string} artifactPath  Relative path from plan (e.g. "scripts/foo.js")
 * @param {string} cwd           Working directory to resolve path against
 * @returns {{ pass: boolean, flag?: object, content?: string, lineCount?: number }}
 */
function checkExists(artifactPath, cwd) {
  const absPath = path.join(cwd, artifactPath);
  const content = readFileCached(absPath);

  if (content === null) {
    return {
      pass: false,
      flag: { level: 'exists', reason: 'file_not_found', path: artifactPath },
    };
  }

  const lines = content.split('\n');
  // Treat a file with only one empty line as empty
  if (lines.length === 0 || (lines.length === 1 && lines[0].trim() === '')) {
    return {
      pass: false,
      flag: { level: 'exists', reason: 'file_empty', path: artifactPath },
    };
  }

  return { pass: true, content, lineCount: lines.length };
}

// ── Level 2: Substantive ──────────────────────────────────────────────────────

/**
 * Level-2 check: is the artifact substantive (line count + no stub patterns)?
 *
 * stub_patterns behaviour:
 *   undefined        → use DEFAULT_STUB_REGEXES
 *   []               → detection disabled; only min_lines applies
 *   string[]         → compile extras, append to DEFAULT_STUB_REGEXES
 *
 * @param {string} content     File content
 * @param {number} lineCount   Number of lines
 * @param {object} artifact    Artifact descriptor from must_haves.artifacts[]
 * @returns {{ pass: boolean, flags?: object[] }}
 */
function checkSubstantive(content, lineCount, artifact) {
  const minLines = artifact.min_lines || 0;

  // ── min_lines gate ────────────────────────────────────────────────────────
  if (lineCount < minLines) {
    return {
      pass: false,
      flags: [{
        level: 'substantive',
        reason: 'below_min_lines',
        actual: lineCount,
        expected: minLines,
        path: artifact.path,
      }],
    };
  }

  // ── Determine effective regex list ────────────────────────────────────────
  const stubPatterns = artifact.stub_patterns;
  let effectiveRegexes;

  if (Array.isArray(stubPatterns)) {
    if (stubPatterns.length === 0) {
      // Explicitly disabled for this artifact
      effectiveRegexes = [];
    } else {
      // Caller-supplied extras + defaults
      const extras = [];
      for (let i = 0; i < stubPatterns.length; i++) {
        const src = stubPatterns[i];
        try {
          const regex = new RegExp(src);
          extras.push({
            name: `custom_stub_${i}`,
            regex,
            description: `Custom stub pattern: ${src}`,
          });
        } catch (err) {
          process.stderr.write(
            `[forge-verifier] Warning: skipping invalid stub_pattern[${i}] in ${artifact.path}: ${JSON.stringify(src)}: ${err.message}\n`,
          );
        }
      }
      effectiveRegexes = [...DEFAULT_STUB_REGEXES, ...extras];
    }
  } else {
    effectiveRegexes = DEFAULT_STUB_REGEXES;
  }

  if (effectiveRegexes.length === 0) {
    return { pass: true };
  }

  // ── Scan lines for stub patterns ──────────────────────────────────────────
  const lines = content.split('\n');
  const matchedFlags = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // First match per line wins (precedence order preserved in array)
    for (const { name, regex } of effectiveRegexes) {
      if (regex.test(line)) {
        matchedFlags.push({
          level: 'substantive',
          regex_name: name,
          line_number: i + 1,
          matched_text: line.trim(),
          path: artifact.path,
        });
        break; // first match wins for this line
      }
    }
  }

  if (matchedFlags.length > 0) {
    return { pass: false, flags: matchedFlags };
  }

  return { pass: true };
}

// ── Level 3: Wired ────────────────────────────────────────────────────────────

/**
 * Level-3 wired check — depth-2 import-chain scan (T03 implementation).
 *
 * Returns:
 *   { wired: true }                           — found a reference within depth
 *   { wired: false, flag: {...} }             — no references found
 *   { wired: 'approximate', flag: {...} }     — depth limit reached, may exist deeper
 *   { wired: 'skipped', flag: {...} }         — non-JS/TS artifact
 *
 * @param {object}   artifact      Artifact descriptor (must have .path)
 * @param {boolean}  nonJsTs       True when this is not a JS/TS artifact
 * @param {string[]} candidateFiles Absolute paths of candidate peer files
 * @param {string}   cwd           Working directory
 * @returns {{ wired: boolean|string, flag?: object, walker_info?: object }}
 */
function checkWired(artifact, nonJsTs, candidateFiles, cwd) {
  if (nonJsTs) {
    return {
      wired: 'skipped',
      flag: { level: 'wired', reason: 'non_js_ts_repo', path: artifact.path },
    };
  }

  const artifactAbs = path.resolve(cwd, artifact.path);
  const result = walkImports(artifactAbs, candidateFiles, { cwd, depth: 2 });

  const walkerInfo = {
    candidates_scanned: result.candidates_scanned,
    depth_reached: result.depth_reached,
    pattern_name: result.pattern_name,
    line_number: result.line_number,
  };

  if (result.found) {
    return {
      wired: true,
      walker_info: walkerInfo,
    };
  }

  if (result.approximate) {
    return {
      wired: 'approximate',
      flag: {
        level: 'wired',
        reason: result.reason,
        depth_reached: result.depth_reached,
        candidates_scanned: result.candidates_scanned,
        path: artifact.path,
      },
      walker_info: walkerInfo,
    };
  }

  return {
    wired: false,
    flag: {
      level: 'wired',
      reason: 'no_references_found',
      candidates_scanned: result.candidates_scanned,
      path: artifact.path,
    },
    walker_info: walkerInfo,
  };
}

// ── Level 4: Test-quality ─────────────────────────────────────────────────────
//
// Applies ONLY to test files declared in must_haves.artifacts/expected_output.
// Non-test artifacts are never audited (decision locked #4).
//
// isTestFile(artifactPath) — true if path matches *.test.* / *.spec.* or /__tests__/
//
// TEST_QUALITY_REGEXES — ordered registry { name, regex, description, pattern_set }
//   pattern_set: 'jest' | 'node' | 'both'
//   Precedence order: disabled-test → weak-assertion → circular-assertion
//
// auditTestQuality(content, artifact) — scans content for test-quality issues.
//   Detects dominant pattern set from require('assert')/process.exit (node) or
//   expect(/it/describe (jest); when ambiguous, runs both sets.
//   Returns { pass: boolean, flags: [] }
//   Flags: { level:'test-quality', reason, regex_name?, line_number?, matched_text?, path }
//
// verifyArtifact integration:
//   After Level 3 (Wired), calls auditTestQuality for test-file artifacts.
//   Appends test-quality flags to rowFlags; adds test_quality: boolean to the row.
//   Non-test artifact rows are NOT modified (regression zero on 3-level).
//
// ──────────────────────────────────────────────────────────────────────────────
// MEM004: [ \t] not \s in line-scoped regexes; \Z does not exist in JS.
// Regexes here are line-scoped (applied to individual lines via split('\n')).
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when the given artifact path is a test file.
 * Matches *.test.<ext>, *.spec.<ext>, or anything inside __tests__/.
 *
 * @param {string} artifactPath  Relative or absolute path
 * @returns {boolean}
 */
function isTestFile(artifactPath) {
  const normalised = artifactPath.replace(/\\/g, '/');
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalised) || normalised.includes('/__tests__/');
}

/**
 * Registry of test-quality patterns.
 * Evaluated in precedence order: disabled-test → weak-assertion → circular-assertion.
 * Each regex is applied line-by-line (line-scoped).
 *
 * @type {Array<{name: string, regex: RegExp, description: string, pattern_set: string}>}
 */
const TEST_QUALITY_REGEXES = [
  // ── disabled-test (both) ──────────────────────────────────────────────────
  {
    name: 'disabled_test_skip_todo',
    // Matches it.skip, test.skip, describe.skip, it.todo, test.todo, describe.todo
    regex: /\b(?:it|test|describe)\.(?:skip|todo)\s*\(/,
    description: 'Test skipped or marked todo via .skip/.todo',
    pattern_set: 'both',
  },
  {
    name: 'disabled_test_xit_xdescribe',
    // Matches xit( and xdescribe( (legacy mocha/jest xunit-style skips)
    regex: /\b(?:xit|xdescribe)\s*\(/,
    description: 'Test skipped via xit() or xdescribe()',
    pattern_set: 'both',
  },
  // ── weak-assertion (jest) ─────────────────────────────────────────────────
  {
    name: 'weak_assertion_jest_literal',
    // Matches expect(true|false|1|0).toBe(true|false|1|0) — literal tautologies
    // MEM004: line-scoped, no \s used, use [ \t]* where whitespace needed
    regex: /expect\([ \t]*(?:true|false|1|0)[ \t]*\)\.(?:toBe|toEqual)\([ \t]*(?:true|false|1|0)[ \t]*\)/,
    description: 'expect(literal).toBe(literal) — assertion always passes; no real coverage',
    pattern_set: 'jest',
  },
  // ── weak-assertion (node) ─────────────────────────────────────────────────
  {
    name: 'weak_assertion_node_assert_true',
    // Matches assert(true) or assert(1) — trivially true assertions
    regex: /\bassert\([ \t]*(?:true|1)[ \t]*\)/,
    description: 'assert(true) or assert(1) — assertion always passes; no real coverage',
    pattern_set: 'node',
  },
  {
    name: 'weak_assertion_node_assert_ok_true',
    // Matches assert.ok(true)
    regex: /\bassert\.ok\([ \t]*true[ \t]*\)/,
    description: 'assert.ok(true) — assertion always passes; no real coverage',
    pattern_set: 'node',
  },
  // ── circular-assertion (jest) ─────────────────────────────────────────────
  {
    name: 'circular_assertion_jest',
    // Matches expect(varName).toBe(varName) or .toEqual(varName) — same variable both sides
    // Uses back-reference \1 to ensure the same identifier appears in both positions
    regex: /expect\([ \t]*([A-Za-z_$][\w$]*)[ \t]*\)\.(?:toBe|toEqual)\([ \t]*\1[ \t]*\)/,
    description: 'expect(x).toBe(x) — circular assertion; variable compared against itself',
    pattern_set: 'jest',
  },
  // ── circular-assertion (node) ─────────────────────────────────────────────
  {
    name: 'circular_assertion_node_strictequal',
    // Matches assert.strictEqual(x, x) or assert(x === x) or assert(x, x)
    // Using back-reference \1 to ensure same identifier
    regex: /\bassert(?:\.strictEqual)?\([ \t]*([A-Za-z_$][\w$]*)[ \t]*,[ \t]*\1[ \t]*\)/,
    description: 'assert(x, x) or assert.strictEqual(x, x) — circular assertion',
    pattern_set: 'node',
  },
  {
    name: 'circular_assertion_node_identity',
    // Matches assert(x === x) — identity tautology in assert condition
    regex: /\bassert\([ \t]*([A-Za-z_$][\w$]*)[ \t]*===[ \t]*\1[ \t]*\)/,
    description: 'assert(x === x) — circular identity assertion',
    pattern_set: 'node',
  },
];

/**
 * Detect the dominant pattern set from file content.
 * Returns an array of pattern_set values to run: ['both'] always included.
 * If both signals present, run both jest and node sets.
 *
 * @param {string} content
 * @returns {string[]}  e.g. ['both', 'jest'] or ['both', 'node'] or ['both', 'jest', 'node']
 */
function detectPatternSets(content) {
  const hasNode = /require\s*\(\s*['"]assert['"]\s*\)/.test(content) ||
                  /process\.exit\s*\(/.test(content);
  const hasJest = /\bexpect\s*\(/.test(content) ||
                  /\b(?:it|test|describe)\s*\(/.test(content);

  if (hasNode && hasJest) return ['both', 'jest', 'node'];
  if (hasNode)  return ['both', 'node'];
  if (hasJest)  return ['both', 'jest'];
  // Ambiguous (no clear signal) — run all
  return ['both', 'jest', 'node'];
}

/**
 * Level-4 audit: test-quality analysis.
 *
 * Applies to test files only. Detects:
 *   - disabled-test:      it.skip / xit / it.todo / describe.skip
 *   - weak-assertion:     expect(true).toBe(true) / assert(true)
 *   - no-assertion:       file has zero expect() or assert() calls
 *   - circular-assertion: expect(x).toBe(x) / assert(x, x)
 *
 * Pattern sets: jest/vitest patterns AND standalone-node assert patterns (MEM003).
 * Short-circuit: first matching regex per line wins (same as checkSubstantive).
 *
 * @param {string} content   File content of the test artifact
 * @param {object} artifact  Artifact descriptor (used for .path in flag output)
 * @returns {{ pass: boolean, flags: Array<object> }}
 *   pass  — true when no test-quality flags were found
 *   flags — array of { level:'test-quality', reason, regex_name?, line_number?, matched_text?, path }
 */
function auditTestQuality(content, artifact) {
  try {
    const artifactPath = artifact && artifact.path ? artifact.path : '<unknown>';
    const flags = [];

    // ── No-assertion check (whole-file, runs before line scan) ───────────────
    const hasAnyAssertion = /\bexpect\s*\(/.test(content) ||
                            /\bassert\s*[\.(]/.test(content);
    if (!hasAnyAssertion) {
      return {
        pass: false,
        flags: [{ level: 'test-quality', reason: 'no-assertion', path: artifactPath }],
      };
    }

    // ── Detect active pattern sets ────────────────────────────────────────────
    const activeSets = detectPatternSets(content);
    const activeRegexes = TEST_QUALITY_REGEXES.filter(r =>
      activeSets.includes(r.pattern_set)
    );

    // ── Line-by-line scan — first match per line wins ─────────────────────────
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const { name, regex } of activeRegexes) {
        // Reset stateful regexes (none here use /g, but defensive)
        regex.lastIndex = 0;
        if (regex.test(line)) {
          // Map regex name to canonical reason
          let reason;
          if (name.startsWith('disabled_test')) {
            reason = 'disabled-test';
          } else if (name.startsWith('weak_assertion')) {
            reason = 'weak-assertion';
          } else if (name.startsWith('circular_assertion')) {
            reason = 'circular-assertion';
          } else {
            reason = name;
          }
          flags.push({
            level: 'test-quality',
            reason,
            regex_name: name,
            line_number: i + 1,
            matched_text: line.trim(),
            path: artifactPath,
          });
          break; // first match wins for this line
        }
      }
    }

    return { pass: flags.length === 0, flags };
  } catch (err) {
    // Advisory — never throws; returns a safe audit-error flag
    const artifactPath = artifact && artifact.path ? artifact.path : '<unknown>';
    return {
      pass: true,
      flags: [{
        level: 'test-quality',
        reason: 'audit-error',
        error: err.message,
        path: artifactPath,
      }],
    };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the 3-level verification for all artifacts declared in a mustHaves block.
 *
 * @param {object|null} mustHaves  Output of parseMustHaves() or null for legacy
 * @param {string[]}    sliceFiles List of relative file paths in the slice (for future Wired impl)
 * @param {object}      [opts]     Options
 * @param {string}      [opts.cwd] Working directory (default: process.cwd())
 * @returns {{ legacy: boolean, rows: object[] }}
 */
function verifyArtifact(mustHaves, sliceFiles, opts) {
  // Clear per-invocation file cache
  _fileCache = new Map();

  const cwd = (opts && opts.cwd) ? opts.cwd : process.cwd();

  // ── Legacy / null input ───────────────────────────────────────────────────
  if (!mustHaves || !mustHaves.artifacts) {
    return {
      legacy: true,
      rows: [{
        path: '<unknown>',
        exists: null,
        substantive: null,
        wired: null,
        flags: [{ level: 'schema', reason: 'legacy_schema' }],
      }],
    };
  }

  const artifacts = mustHaves.artifacts;

  // ── Detect non-JS/TS artifact (per-artifact, not per-repo) ──────────────
  // (nonJsTs is computed per artifact below)

  // ── Build all artifact absolute paths for cross-reference ─────────────────
  // Candidates = all artifacts in this must-haves + extra sliceFiles passed by CLI
  const artifactAbsPaths = artifacts.map(a => path.resolve(cwd, a.path));
  const extraAbsPaths = (Array.isArray(sliceFiles) ? sliceFiles : [])
    .map(f => path.isAbsolute(f) ? f : path.resolve(cwd, f));
  const allCandidateAbsPaths = Array.from(new Set([...artifactAbsPaths, ...extraAbsPaths]));

  // ── Evaluate each artifact ────────────────────────────────────────────────
  const rows = [];

  for (const artifact of artifacts) {
    const artifactPath = artifact.path;
    const artifactAbs = path.resolve(cwd, artifactPath);

    // ── Level 1: Exists ───────────────────────────────────────────────────
    const existsResult = checkExists(artifactPath, cwd);

    if (!existsResult.pass) {
      rows.push({
        path: artifactPath,
        exists: false,
        substantive: null,
        wired: null,
        flags: [existsResult.flag],
      });
      continue; // short-circuit
    }

    const { content, lineCount } = existsResult;

    // ── Level 2: Substantive ──────────────────────────────────────────────
    const subResult = checkSubstantive(content, lineCount, artifact);

    if (!subResult.pass) {
      rows.push({
        path: artifactPath,
        exists: true,
        substantive: false,
        wired: null,
        flags: subResult.flags || [],
      });
      continue; // short-circuit
    }

    // ── Level 3: Wired ────────────────────────────────────────────────────
    const isNonJsTs = !JS_TS_EXTENSIONS.has(path.extname(artifactPath).toLowerCase());
    // Candidate files: all artifacts and sliceFiles EXCEPT this artifact itself
    const candidateFiles = allCandidateAbsPaths.filter(
      p => path.normalize(p) !== path.normalize(artifactAbs)
    );
    const wiredResult = checkWired(artifact, isNonJsTs, candidateFiles, cwd);

    const rowFlags = [];
    if (wiredResult.flag) rowFlags.push(wiredResult.flag);

    // ── Level 4: Test-quality ─────────────────────────────────────────────
    // Only audits test files (isTestFile); non-test artifacts are never audited
    // (decision locked #4). Advisory — never changes the 3-level verdict.
    let testQualityResult = null;
    if (isTestFile(artifactPath)) {
      testQualityResult = auditTestQuality(content, artifact);
      if (!testQualityResult.pass) {
        rowFlags.push(...testQualityResult.flags);
      }
    }

    const row = {
      path: artifactPath,
      exists: true,
      substantive: true,
      wired: wiredResult.wired,
      walker_info: wiredResult.walker_info,
      flags: rowFlags,
    };
    // Add test_quality field only for test files (non-test rows stay unchanged)
    if (testQualityResult !== null) {
      row.test_quality = testQualityResult.pass;
    }
    rows.push(row);
  }

  return { legacy: false, rows };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  verifyArtifact,
  runTaskArtifactCheck,
  DEFAULT_STUB_REGEXES,
  IMPORT_PATTERNS,
  SUPPORTED_EXTENSIONS,
  // Level 4 exports
  auditTestQuality,
  TEST_QUALITY_REGEXES,
  isTestFile,
  _private: {
    checkExists,
    checkSubstantive,
    readFileCached,
    extractImports,
    resolveSpec,
    walkImports,
    checkWired,
    // Level 4 privates
    detectPatternSets,
    auditTestQuality,
    isTestFile,
    // Non-clobbering output guard (function declarations are hoisted, so these
    // resolve even though they are defined below this block).
    isOurOutput,
    writeVerificationMd,
  },
};

// ── CLI entrypoint ────────────────────────────────────────────────────────────

/**
 * Parse argv flags: --slice, --milestone, --cwd, --help/-h
 * @param {string[]} argv  process.argv.slice(2)
 * @returns {{ slice: string|null, milestone: string|null, cwd: string, codeDir: string, help: boolean }}
 */
function parseArgv(argv) {
  const opts = { slice: null, milestone: null, cwd: process.cwd(), codeDir: '', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--slice' && argv[i + 1] !== undefined) { opts.slice = argv[++i]; continue; }
    if (a === '--milestone' && argv[i + 1] !== undefined) { opts.milestone = argv[++i]; continue; }
    if (a === '--cwd' && argv[i + 1] !== undefined) { opts.cwd = argv[++i]; continue; }
    if (a === '--task-plan' && argv[i + 1] !== undefined) { opts.taskPlan = argv[++i]; continue; }
    if (a === '--code-dir' && argv[i + 1] !== undefined) { opts.codeDir = argv[++i]; continue; }
  }
  opts.codeDir = opts.codeDir || opts.cwd;
  return opts;
}

/**
 * Discover all T##-PLAN.md files under the slice's tasks/ directory.
 * @param {string} sliceDir  Absolute path to the slice directory
 * @returns {{ plans: Array<{taskId: string, absPath: string}>, noTasksDir: boolean }}
 */
function discoverTaskPlans(sliceDir) {
  const tasksDir = path.join(sliceDir, 'tasks');
  if (!fs.existsSync(tasksDir)) {
    return { plans: [], noTasksDir: true };
  }
  let entries;
  try {
    entries = fs.readdirSync(tasksDir);
  } catch (_err) {
    return { plans: [], noTasksDir: true };
  }
  const plans = [];
  for (const entry of entries.sort()) {
    if (!/^T\d{2}$/.test(entry)) continue;
    const planFile = path.join(tasksDir, entry, `${entry}-PLAN.md`);
    plans.push({ taskId: entry, absPath: planFile });
  }
  return { plans, noTasksDir: false };
}

/**
 * Aggregate must-haves from an array of discovered plan paths.
 * @param {Array<{taskId: string, absPath: string}>} plans
 * @returns {{ structured: Array, legacy: Array, malformed: Array, errors: Array }}
 */
function aggregateMustHaves(plans) {
  const structured = [];
  const legacy = [];
  const malformed = [];
  const errors = [];

  for (const { taskId, absPath } of plans) {
    let content;
    try {
      content = fs.readFileSync(absPath, 'utf-8');
    } catch (_err) {
      errors.push({ taskId, status: 'skipped', reason: 'file_not_found', absPath });
      continue;
    }

    if (!hasStructuredMustHaves(content)) {
      legacy.push({ taskId, absPath });
      continue;
    }

    try {
      const mustHaves = parseMustHaves(content);
      structured.push({ taskId, mustHaves, planPath: absPath });
    } catch (err) {
      malformed.push({ taskId, absPath, error: err.message });
    }
  }

  return { structured, legacy, malformed, errors };
}

/**
 * Run the full slice verification: discover plans, aggregate must-haves, run verifyArtifact.
 * @param {{ slice: string, milestone: string, cwd: string, codeDir?: string }} opts
 * @returns {object}  Result object for formatVerificationMd and JSON stdout
 */
function runSliceVerification(opts) {
  const start = process.hrtime.bigint();

  const sliceDir = path.join(opts.cwd, '.gsd', 'milestones', opts.milestone, 'slices', opts.slice);
  const { plans, noTasksDir } = discoverTaskPlans(sliceDir);
  const agg = aggregateMustHaves(plans);

  const rows = [];

  // Build combined artifacts array with sourceTask tag
  const combinedArtifacts = [];
  for (const { taskId, mustHaves } of agg.structured) {
    if (mustHaves.artifacts && mustHaves.artifacts.length > 0) {
      for (const artifact of mustHaves.artifacts) {
        combinedArtifacts.push(Object.assign({}, artifact, { _sourceTask: taskId }));
      }
    }
  }

  if (combinedArtifacts.length > 0) {
    const combinedMustHaves = { artifacts: combinedArtifacts, key_links: [] };
    // Pass all artifact paths as sliceFiles so the walker has full candidate set
    const codeDir = opts.codeDir || opts.cwd;
    const sliceFilesCandidates = combinedArtifacts.map(a => path.resolve(codeDir, a.path));
    const verifyResult = verifyArtifact(combinedMustHaves, sliceFilesCandidates, { cwd: codeDir });
    for (const row of verifyResult.rows) {
      // Find the sourceTask from the artifact we tagged
      const artifact = combinedArtifacts.find(a => a.path === row.path);
      rows.push(Object.assign({ sourceTask: artifact ? artifact._sourceTask : '?' }, row));
    }
  }

  // Legacy plan rows
  for (const { taskId, absPath } of agg.legacy) {
    rows.push({
      sourceTask: taskId,
      path: path.relative(opts.cwd, absPath).replace(/\\/g, '/'),
      exists: null,
      substantive: null,
      wired: null,
      flags: [{ level: 'schema', reason: 'legacy_schema', source_task: taskId }],
    });
  }

  // Malformed plan rows
  for (const { taskId, absPath, error } of agg.malformed) {
    rows.push({
      sourceTask: taskId,
      path: path.relative(opts.cwd, absPath).replace(/\\/g, '/'),
      exists: null,
      substantive: null,
      wired: null,
      flags: [{ level: 'schema', reason: 'malformed_schema', source_task: taskId, error }],
    });
  }

  // Error rows (file_not_found at plan level)
  for (const { taskId, absPath } of agg.errors) {
    rows.push({
      sourceTask: taskId,
      path: path.relative(opts.cwd, absPath).replace(/\\/g, '/'),
      exists: null,
      substantive: null,
      wired: null,
      flags: [{ level: 'schema', reason: 'file_not_found', source_task: taskId }],
    });
  }

  const duration_ms = Number(process.hrtime.bigint() - start) / 1e6;

  return {
    slice: opts.slice,
    milestone: opts.milestone,
    generated_at: new Date().toISOString(),
    duration_ms,
    rows,
    legacy_count: agg.legacy.length,
    malformed_count: agg.malformed.length,
    error_count: agg.errors.length,
    no_tasks_dir: noTasksDir,
  };
}

/**
 * Format a VERIFICATION.md string from a runSliceVerification result.
 * @param {object} result
 * @returns {string}
 */
function formatVerificationMd(result) {
  const { slice, milestone, generated_at, duration_ms, rows, legacy_count, malformed_count } = result;

  // ── Frontmatter ──────────────────────────────────────────────────────────────
  const fm = [
    '---',
    `id: ${slice}-VERIFICATION`,
    `slice: ${slice}`,
    `milestone: ${milestone}`,
    `generated_at: ${generated_at}`,
    `duration_ms: ${Math.round(duration_ms * 100) / 100}`,
    `verifier_version: "v1.1 (T01/T02 baseline; T03 adds Wired; T02/S02 adds Test-quality)"`,
    `legacy_count: ${legacy_count}`,
    `malformed_count: ${malformed_count}`,
    '---',
    '',
  ].join('\n');

  // ── Header + description ──────────────────────────────────────────────────────
  const header = [
    `# ${slice}: Goal-backward Verification`,
    '',
    'Advisory only — heuristic 4-level audit (Exists / Substantive / Wired / Test-quality).',
    'Stub detection is regex-based; Wired is depth-2 import-chain scan (JS/TS only).',
    'Test-quality applies only to declared test files (*.test.* / *.spec.* / __tests__/).',
    'This file is generated by `scripts/forge-verifier.js` and never blocks slice closure.',
    '',
  ].join('\n');

  // ── Artifact Audit table ──────────────────────────────────────────────────────
  const tableHeader = [
    '## Artifact Audit',
    '',
    '| Source | Artifact | Exists | Substantive | Wired | Flags |',
    '|--------|----------|--------|-------------|-------|-------|',
  ].join('\n');

  const tableRows = rows.map(row => {
    const existsCell = row.exists === true ? '✓' : row.exists === false ? '✗' : '—';
    const subCell = row.substantive === true ? '✓' : row.substantive === false ? '✗' : '—';
    // Wired: ✓ (found), ✗ (not found), ~ (approximate/depth_limit), — (skipped non-JS/TS or not evaluated)
    const wiredCell = row.wired === true ? '✓'
      : row.wired === false ? '✗'
      : row.wired === 'approximate' ? '~'
      : row.wired === 'skipped' ? '—'
      : '—';

    // Build compact flags cell
    let flagsCell = '—';
    if (row.flags && row.flags.length > 0) {
      const firstFlag = row.flags[0];
      if (firstFlag.reason === 'legacy_schema') {
        flagsCell = '`skipped: legacy_schema`';
      } else if (firstFlag.reason === 'malformed_schema') {
        flagsCell = '`skipped: malformed_schema`';
      } else if (firstFlag.reason === 'non_js_ts_repo') {
        flagsCell = '`wired: non_js_ts`';
      } else if (firstFlag.reason === 'no_references_found') {
        const scanned = firstFlag.candidates_scanned !== undefined ? ` (${firstFlag.candidates_scanned} scanned)` : '';
        flagsCell = `\`wired: no_references_found${scanned}\``;
      } else if (firstFlag.reason === 'depth_limit') {
        flagsCell = `\`wired: ~depth_limit (depth ${firstFlag.depth_reached})\``;
      } else if (firstFlag.reason === 'file_not_found' && firstFlag.level === 'exists') {
        flagsCell = '`file_not_found`';
      } else if (firstFlag.reason === 'below_min_lines') {
        flagsCell = `\`below_min_lines (${firstFlag.actual}/${firstFlag.expected})\``;
      } else if (firstFlag.regex_name) {
        flagsCell = `\`${firstFlag.regex_name}\` at :${firstFlag.line_number}`;
      } else if (firstFlag.reason) {
        flagsCell = `\`${firstFlag.reason}\``;
      }
    }

    const artifactCell = row.path.length > 50 ? '...' + row.path.slice(-47) : row.path;
    return `| ${row.sourceTask || '?'} | ${artifactCell} | ${existsCell} | ${subCell} | ${wiredCell} | ${flagsCell} |`;
  });

  const tableSection = tableHeader + '\n' + tableRows.join('\n') + '\n';

  // ── Flags narrative ───────────────────────────────────────────────────────────
  const failingRows = rows.filter(row =>
    row.exists === false ||
    row.substantive === false ||
    row.wired === false ||
    row.wired === 'approximate' ||
    row.test_quality === false ||
    (row.flags && row.flags.some(f =>
      f.reason && !['non_js_ts_repo', 'legacy_schema', 'no_references_found', 'depth_limit'].includes(f.reason)
    ))
  );

  let flagsSection = '';
  if (failingRows.length > 0) {
    const parts = ['## Flags', ''];
    for (const row of failingRows) {
      parts.push(`### ${row.path}`);
      parts.push('');
      // Separate test-quality flags for dedicated sub-section
      const tqFlags = (row.flags || []).filter(f => f.level === 'test-quality');
      const otherFlags = (row.flags || []).filter(f => f.level !== 'test-quality');

      for (const flag of otherFlags) {
        if (flag.regex_name) {
          parts.push(`- **${flag.regex_name}** at line ${flag.line_number}: \`${flag.matched_text}\``);
        } else if (flag.reason === 'depth_limit') {
          parts.push(`- **wired: ~** depth_limit reached at depth ${flag.depth_reached} (${flag.candidates_scanned} candidates scanned). Chain may exist beyond depth-2 cap — human triage advised.`);
        } else if (flag.reason === 'no_references_found') {
          parts.push(`- **wired: ✗** no import/require/export reference found in ${flag.candidates_scanned} candidates scanned.`);
        } else if (flag.reason) {
          const detail = flag.error ? ` — ${flag.error}` : '';
          const lines = flag.actual !== undefined ? ` (actual: ${flag.actual}, expected: ${flag.expected})` : '';
          parts.push(`- **${flag.reason}**${lines}${detail}`);
        }
      }

      if (tqFlags.length > 0) {
        parts.push('');
        parts.push('**Test-quality**');
        for (const flag of tqFlags) {
          if (flag.reason === 'no-assertion') {
            parts.push(`- **no-assertion** — file has no \`expect()\` or \`assert()\` calls`);
          } else if (flag.reason === 'disabled-test') {
            parts.push(`- **disabled-test** (${flag.regex_name}) at line ${flag.line_number}: \`${flag.matched_text}\``);
          } else if (flag.reason === 'weak-assertion') {
            parts.push(`- **weak-assertion** (${flag.regex_name}) at line ${flag.line_number}: \`${flag.matched_text}\``);
          } else if (flag.reason === 'circular-assertion') {
            parts.push(`- **circular-assertion** (${flag.regex_name}) at line ${flag.line_number}: \`${flag.matched_text}\``);
          } else if (flag.reason === 'audit-error') {
            parts.push(`- **audit-error** — ${flag.error || 'unknown error during test-quality scan'}`);
          } else if (flag.reason) {
            parts.push(`- **${flag.reason}** (${flag.regex_name || ''}) at line ${flag.line_number || '?'}`);
          }
        }
      }
      parts.push('');
    }
    flagsSection = parts.join('\n');
  }

  // ── Performance ───────────────────────────────────────────────────────────────
  const artifactCount = rows.filter(r => r.exists !== null || (r.flags && r.flags[0] && r.flags[0].level === 'exists')).length;
  const perfSection = [
    '## Performance',
    '',
    `- Wall-clock: ${Math.round(duration_ms * 100) / 100} ms`,
    `- Artifacts audited: ${artifactCount}`,
    '- Budget: ≤ 2000 ms per 10 artifacts (hot cache)',
    '',
  ].join('\n');

  return fm + header + tableSection + '\n' + (flagsSection ? flagsSection + '\n' : '') + perfSection;
}

/**
 * isOurOutput — does the file at `p` carry this tool's own signature?
 *
 * `duration_ms:` is emitted unconditionally by formatVerificationMd and is not
 * something a human writes into a deliverable, so it is the discriminator.
 * `id: {sliceId}-VERIFICATION` pins it to THIS slice.
 *
 * Returns a THREE-state result, never a boolean: `unreadable` must not collapse
 * into `not ours` OR into `ours`. A file we could not inspect is not evidence
 * in either direction — the same rule the schema guard applies to an unreadable
 * stamp — so the caller refuses to overwrite it.
 *
 * @param {string} p
 * @param {string} sliceId
 * @returns {{ours: boolean, unreadable: boolean, errno: string|null}}
 */
function isOurOutput(p, sliceId) {
  let text;
  try {
    text = fs.readFileSync(p, 'utf-8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ours: false, unreadable: false, errno: 'ENOENT' };
    return { ours: false, unreadable: true, errno: (e && e.code) || 'UNKNOWN' };
  }
  const fm = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return { ours: false, unreadable: false, errno: null };
  const block = fm[1];
  const ours = /^duration_ms:[ \t]*[\d.]+$/m.test(block)
    && new RegExp(`^id:[ \\t]*${sliceId}-VERIFICATION[ \\t]*$`, 'm').test(block);
  return { ours, unreadable: false, errno: null };
}

/**
 * Write the VERIFICATION.md to the slice directory.
 *
 * REFUSES to clobber a file at that path that is not this tool's own output.
 * The path is also a legal `writes:` target for a task — measured: a T04 that
 * declared `{S##}-VERIFICATION.md` had 307 lines of proof replaced by 68 lines
 * of generic heuristic, and `.gsd/` is not a git repo in a consumer workspace,
 * so there was no `git checkout` to undo it. Advisory output must never destroy
 * a deliverable; when the path is taken, the verification lands beside it under
 * `{sliceId}-VERIFICATION.generated.md` and the collision is named on stderr.
 *
 * @param {string} sliceDir  Absolute path to the slice directory
 * @param {string} sliceId   e.g. "S03"
 * @param {string} md        Formatted markdown content
 * @returns {string}  Absolute path of the written file
 */
function writeVerificationMd(sliceDir, sliceId, md) {
  const outPath = path.join(sliceDir, `${sliceId}-VERIFICATION.md`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const state = isOurOutput(outPath, sliceId);
  if (state.errno !== 'ENOENT' && (!state.ours || state.unreadable)) {
    const altPath = path.join(sliceDir, `${sliceId}-VERIFICATION.generated.md`);
    const why = state.unreadable
      ? `existing file could not be read (${state.errno}) — unreadable is not evidence of ownership`
      : 'existing file is not this tool\'s output (no duration_ms/id signature)';
    process.stderr.write(
      `[forge-verifier] refusing to overwrite ${outPath}: ${why}. Wrote ${altPath} instead.\n`,
    );
    fs.writeFileSync(altPath, md, 'utf-8');
    return altPath;
  }

  fs.writeFileSync(outPath, md, 'utf-8');
  return outPath;
}

// ── Task-boundary artifact check (2026-08-24) ────────────────────────────────
//
// The measured hole: nothing between the executor's self-report and the
// (advisory, end-of-slice) verifier ever checked that a task's DECLARED
// artifacts exist — a task could return `done` having created none of them,
// and the miss surfaced two units later in review (74% objection-concession
// rate). Existence of a declared artifact is mechanical, not heuristic, so at
// the task boundary it is ENFORCING: any missing artifact/expected_output is
// exit 1 and the executor returns `partial` naming it. substantive/wired stay
// advisory here exactly as they are at the slice boundary — heuristics never
// block.
//
// Legacy plans (no structured must_haves) pass through untouched — the same
// posture every other consumer of the schema takes.
function runTaskArtifactCheck(opts) {
  const cwd = opts.codeDir || opts.cwd || process.cwd();
  const raw = fs.readFileSync(opts.taskPlan, 'utf8');
  const { hasStructuredMustHaves, parseMustHaves } = require('./forge-must-haves.js');
  if (!hasStructuredMustHaves(raw)) {
    return { legacy: true, passed: true, missing: [], advisory_flags: [], checked: { artifacts: 0, expected: 0 } };
  }
  const parsed = parseMustHaves(raw);
  const missing = [];
  const advisory = [];
  const rowsResult = verifyArtifact({ artifacts: parsed.artifacts || [] }, [], { cwd });
  for (const row of rowsResult.rows || []) {
    if (row.exists === false) {
      missing.push({ path: row.path, reason: (row.flags.find((f) => f.level === 'exists') || {}).reason || 'file_not_found' });
    } else {
      for (const flag of row.flags || []) {
        // `wired` is structurally meaningless at the task boundary — the rest
        // of the slice does not exist yet, so "no references found" is the
        // EXPECTED state, not a signal. Emitting it would train readers to
        // ignore advisory flags. The slice-boundary run keeps it.
        if (flag.level !== 'exists' && flag.level !== 'wired') advisory.push(flag);
      }
    }
  }
  const expected = Array.isArray(parsed.expected_output) ? parsed.expected_output : [];
  for (const rel of expected) {
    const p = path.join(cwd, String(rel));
    if (!fs.existsSync(p)) missing.push({ path: String(rel), reason: 'expected_output_not_found' });
  }
  return {
    legacy: false,
    passed: missing.length === 0,
    missing,
    advisory_flags: advisory,
    checked: { artifacts: (parsed.artifacts || []).length, expected: expected.length },
  };
}

if (require.main === module) {
  const opts = parseArgv(process.argv.slice(2));

  if (opts.taskPlan) {
    try {
      const result = runTaskArtifactCheck(opts);
      process.stdout.write(JSON.stringify(result) + '\n');
      process.exit(result.passed ? 0 : 1);
    } catch (e) {
      process.stderr.write(JSON.stringify({ error: e.message }) + '\n');
      process.exit(2);
    }
  }

  if (opts.help || !opts.slice || !opts.milestone) {
    process.stderr.write(
      'Usage: node scripts/forge-verifier.js --slice <S##> --milestone <M###> [--cwd <dir>] [--code-dir <dir>]\n' +
      'Writes .gsd/milestones/<M###>/slices/<S##>/<S##>-VERIFICATION.md.\n'
    );
    process.exit(2);
  }

  try {
    const result = runSliceVerification(opts);
    const md = formatVerificationMd(result);
    const sliceDir = path.join(opts.cwd, '.gsd', 'milestones', opts.milestone, 'slices', opts.slice);
    const outPath = writeVerificationMd(sliceDir, opts.slice, md);
    process.stdout.write(JSON.stringify(result) + '\n');
    process.stderr.write(`Wrote ${outPath}\n`);
    process.exit(0);
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: e.message, stack: e.stack }) + '\n');
    process.exit(2);
  }
}
