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
//   Level 3 — Wired:        key_links satisfied (stubbed in T01; T03 implements)
//
// Short-circuit rules:
//   Exists fails  → Substantive and Wired not evaluated (Wired stays null)
//   Substantive fails → Wired not evaluated (Wired stays null)
//
// Zero dependencies — only Node built-ins fs and path.
// Companion module: scripts/forge-must-haves.js (hasStructuredMustHaves, parseMustHaves)

'use strict';

const fs   = require('fs');
const path = require('path');

// Loaded for key-link resolution in T03 and for CLI in T02.
// No side effects on require — safe to load unconditionally.
const { hasStructuredMustHaves, parseMustHaves } = require('./forge-must-haves');

// ── Constants ─────────────────────────────────────────────────────────────────

/** File extensions treated as JS/TS for stub detection. */
const JS_TS_EXTENSIONS = new Set(['.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs']);

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

// ── Level 3: Wired (stub) ─────────────────────────────────────────────────────

/**
 * Level-3 wired check — not yet implemented (T03 fills this in).
 * Returns a sentinel flag indicating this level is pending.
 *
 * @param {object} artifact   Artifact descriptor
 * @param {boolean} nonJsTs   True when repo has no JS/TS files
 * @returns {{ wired: null|'skipped', flag: object }}
 */
function checkWiredStub(artifact, nonJsTs) {
  if (nonJsTs) {
    return {
      wired: 'skipped',
      flag: { level: 'wired', reason: 'non_js_ts_repo', path: artifact.path },
    };
  }
  return {
    wired: null,
    flag: { level: 'wired', reason: 'not_implemented_yet', path: artifact.path },
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

  // ── Detect non-JS/TS repo ─────────────────────────────────────────────────
  const nonJsTs = artifacts.every(a => {
    const ext = path.extname(a.path).toLowerCase();
    return !JS_TS_EXTENSIONS.has(ext);
  });

  // ── Evaluate each artifact ────────────────────────────────────────────────
  const rows = [];

  for (const artifact of artifacts) {
    const artifactPath = artifact.path;

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

    // ── Level 3: Wired (stub) ─────────────────────────────────────────────
    const wiredResult = checkWiredStub(artifact, nonJsTs);

    rows.push({
      path: artifactPath,
      exists: true,
      substantive: true,
      wired: wiredResult.wired,
      flags: [wiredResult.flag],
    });
  }

  return { legacy: false, rows };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  verifyArtifact,
  DEFAULT_STUB_REGEXES,
  _private: {
    checkExists,
    checkSubstantive,
    readFileCached,
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
    const verifyResult = verifyArtifact(combinedMustHaves, [], { cwd: opts.cwd });
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
    const wiredCell = row.wired === true ? '✓' : row.wired === false ? '✗' : row.wired === 'skipped' ? 'skip' : '—';

    // Build compact flags cell
    let flagsCell = '—';
    if (row.flags && row.flags.length > 0) {
      const firstFlag = row.flags[0];
      if (firstFlag.reason === 'legacy_schema') {
        flagsCell = '`skipped: legacy_schema`';
      } else if (firstFlag.reason === 'malformed_schema') {
        flagsCell = '`skipped: malformed_schema`';
      } else if (firstFlag.reason === 'not_implemented_yet') {
        flagsCell = '`wired: pending T03`';
      } else if (firstFlag.reason === 'non_js_ts_repo') {
        flagsCell = '`wired: non_js_ts`';
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
    (row.flags && row.flags.some(f =>
      f.reason && !['not_implemented_yet', 'non_js_ts_repo', 'legacy_schema'].includes(f.reason)
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
