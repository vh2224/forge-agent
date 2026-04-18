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
      const extras = stubPatterns.map((src, i) => ({
        name: `custom_stub_${i}`,
        regex: new RegExp(src),
        description: `Custom stub pattern: ${src}`,
      }));
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

    rows.push({
      path: artifactPath,
      exists: true,
      substantive: true,
      wired: wiredResult.wired,
      walker_info: wiredResult.walker_info,
      flags: rowFlags,
    });
  }

  return { legacy: false, rows };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  verifyArtifact,
  DEFAULT_STUB_REGEXES,
  IMPORT_PATTERNS,
  SUPPORTED_EXTENSIONS,
  _private: {
    checkExists,
    checkSubstantive,
    readFileCached,
    extractImports,
    resolveSpec,
    walkImports,
    checkWired,
  },
};

// ── CLI entrypoint ────────────────────────────────────────────────────────────

/**
 * Parse argv flags: --slice, --milestone, --cwd, --help/-h
 * @param {string[]} argv  process.argv.slice(2)
 * @returns {{ slice: string|null, milestone: string|null, cwd: string, help: boolean }}
 */
function parseArgv(argv) {
  const opts = { slice: null, milestone: null, cwd: process.cwd(), help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--slice' && argv[i + 1] !== undefined) { opts.slice = argv[++i]; continue; }
    if (a === '--milestone' && argv[i + 1] !== undefined) { opts.milestone = argv[++i]; continue; }
    if (a === '--cwd' && argv[i + 1] !== undefined) { opts.cwd = argv[++i]; continue; }
  }
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
 * @param {{ slice: string, milestone: string, cwd: string }} opts
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
    const sliceFilesCandidates = combinedArtifacts.map(a => path.resolve(opts.cwd, a.path));
    const verifyResult = verifyArtifact(combinedMustHaves, sliceFilesCandidates, { cwd: opts.cwd });
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
    `verifier_version: "v1.0 (T01/T02 baseline; T03 adds Wired)"`,
    `legacy_count: ${legacy_count}`,
    `malformed_count: ${malformed_count}`,
    '---',
    '',
  ].join('\n');

  // ── Header + description ──────────────────────────────────────────────────────
  const header = [
    `# ${slice}: Goal-backward Verification`,
    '',
    'Advisory only — heuristic 3-level audit (Exists / Substantive / Wired).',
    'Stub detection is regex-based; Wired is depth-2 import-chain scan (JS/TS only).',
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
      for (const flag of (row.flags || [])) {
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
 * Write the VERIFICATION.md to the slice directory.
 * @param {string} sliceDir  Absolute path to the slice directory
 * @param {string} sliceId   e.g. "S03"
 * @param {string} md        Formatted markdown content
 * @returns {string}  Absolute path of the written file
 */
function writeVerificationMd(sliceDir, sliceId, md) {
  const outPath = path.join(sliceDir, `${sliceId}-VERIFICATION.md`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, md, 'utf-8');
  return outPath;
}

if (require.main === module) {
  const opts = parseArgv(process.argv.slice(2));

  if (opts.help || !opts.slice || !opts.milestone) {
    process.stderr.write(
      'Usage: node scripts/forge-verifier.js --slice <S##> --milestone <M###> [--cwd <dir>]\n' +
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
