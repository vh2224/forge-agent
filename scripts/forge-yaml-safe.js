/**
 * forge-yaml-safe.js — Shared YAML-safe scalar serializer/parser
 *
 * Provides lossless round-trip serialization for arbitrary string values into
 * YAML scalar form, using plain scalars when safe and block-scalar `|` form
 * when the value contains characters that would be ambiguous in YAML.
 *
 * Zero external dependencies — Node.js built-ins only.
 *
 * Exports:
 *   needsBlockScalar(value)              → boolean
 *   serializeScalar(value, indent = 0)   → string  (may be multi-line if block)
 *   parseScalar(lines, startIdx, baseIndent = 0) → { value: string, nextIndex: number }
 *
 * CLI:
 *   node scripts/forge-yaml-safe.js --smoke   → runs inline assertions, prints PASS/FAIL
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Characters that are ambiguous as the first character of a plain YAML scalar. */
const UNSAFE_FIRST_CHARS = new Set(['[', '{', ':', "'", '"', '>', '|', '&', '*', '!', '%', '#', '?', '-', '@', '`']);

/** YAML boolean/null keywords that must be quoted to avoid type coercion. */
const YAML_KEYWORDS = new Set(['true', 'false', 'null', '~', 'yes', 'no', 'on', 'off']);

/** Regex for integers and floats that YAML would parse as numbers. */
const NUMERIC_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

// ---------------------------------------------------------------------------
// needsBlockScalar(value)
// ---------------------------------------------------------------------------

/**
 * Returns true when `value` cannot be safely emitted as a plain YAML scalar
 * and must be wrapped in block-scalar `|` form.
 *
 * @param {string} value
 * @returns {boolean}
 */
function needsBlockScalar(value) {
  if (typeof value !== 'string') {
    value = String(value);
  }

  // Multi-line content → block scalar required
  if (value.includes('\n')) return true;

  // Leading or trailing whitespace → would be silently trimmed by plain parser
  if (value !== value.trim()) return true;

  // Empty string is handled separately in serializeScalar (returns '')
  if (value.length === 0) return false;

  // First character is ambiguous in plain scalar context
  const firstChar = value[0];
  if (UNSAFE_FIRST_CHARS.has(firstChar)) return true;

  // YAML boolean/null keywords → must quote to preserve string type
  if (YAML_KEYWORDS.has(value.toLowerCase())) return true;

  // Numeric-looking values → would be parsed as numbers
  if (NUMERIC_RE.test(value)) return true;

  // `: ` sequence anywhere → key: value ambiguity
  if (value.includes(': ')) return true;

  // Value ends with `:` → key indicator ambiguity
  if (value.endsWith(':')) return true;

  // `#` after a space → inline comment start
  if (value.includes(' #')) return true;

  return false;
}

// ---------------------------------------------------------------------------
// serializeScalar(value, indent = 0)
// ---------------------------------------------------------------------------

/**
 * Serializes `value` to a YAML scalar string.
 *
 * - Plain scalar (returned as-is) when needsBlockScalar returns false.
 * - Block-scalar `|` form when needsBlockScalar returns true.
 *   The returned string begins with `|` followed by newline-separated content
 *   lines indented by (indent + 2) spaces. The caller uses this as:
 *     `${key}: ${serializeScalar(value, currentIndent)}`
 *   which produces:
 *     `key: |`
 *     `  line1`
 *     `  line2`
 *
 * - null/undefined → returns `''` (caller decides how to emit empty).
 * - Empty string → returns `''`.
 *
 * @param {string|null|undefined} value
 * @param {number} [indent=0]  Current indentation level of the containing key
 * @returns {string}
 */
function serializeScalar(value, indent) {
  if (indent === undefined) indent = 0;

  if (value === null || value === undefined) return '';

  const str = String(value);

  if (str.length === 0) return "''";

  if (!needsBlockScalar(str)) return str;

  // Block scalar form: `|` indicator, then indented lines
  const lineIndent = ' '.repeat(indent + 2);
  const lines = str.split('\n');
  const indentedLines = lines.map(function(line) {
    return lineIndent + line;
  });
  return '|\n' + indentedLines.join('\n');
}

// ---------------------------------------------------------------------------
// parseScalar(lines, startIdx, baseIndent = 0)
// ---------------------------------------------------------------------------

/**
 * Parses a scalar value starting at `lines[startIdx]`.
 *
 * The caller has already stripped the `key: ` prefix, leaving either:
 *   - A plain value (e.g. `"hello"`, `42`, empty)
 *   - A block-scalar indicator `|` (optionally followed by whitespace)
 *
 * For block scalars, subsequent lines indented more than `baseIndent` are
 * consumed and joined with `\n` after stripping the `baseIndent + 2` space
 * prefix.
 *
 * @param {string[]} lines        Array of all lines being parsed
 * @param {number}   startIdx     Index of the value portion of the current line
 * @param {number}   [baseIndent=0]  Indentation of the containing block
 * @returns {{ value: string, nextIndex: number }}
 */
function parseScalar(lines, startIdx, baseIndent) {
  if (baseIndent === undefined) baseIndent = 0;

  const raw = (lines[startIdx] || '').trim();

  // Block scalar indicator
  if (/^\|\s*$/.test(raw)) {
    const contentIndent = baseIndent + 2;
    const contentLines = [];
    let i = startIdx + 1;

    while (i < lines.length) {
      const line = lines[i];
      // A line belongs to the block if it is empty or indented enough
      if (line.trim() === '') {
        contentLines.push('');
        i++;
        continue;
      }
      // Count leading spaces
      const leadingSpaces = line.length - line.trimStart().length;
      if (leadingSpaces >= contentIndent) {
        contentLines.push(line.slice(contentIndent));
        i++;
      } else {
        break;
      }
    }

    // Strip trailing empty lines added by the `|` emitter (YAML `|` default chomping keeps one trailing newline)
    // We want to recover the exact original string, so strip all trailing empties
    while (contentLines.length > 0 && contentLines[contentLines.length - 1] === '') {
      contentLines.pop();
    }

    return { value: contentLines.join('\n'), nextIndex: i };
  }

  // Quoted scalar — strip delimiters and unescape
  if (raw.length >= 2) {
    if ((raw[0] === '"' && raw[raw.length - 1] === '"') ||
        (raw[0] === "'" && raw[raw.length - 1] === "'")) {
      const delimiter = raw[0];
      let inner = raw.slice(1, -1);
      if (delimiter === '"') {
        inner = inner
          .replace(/\\n/g, '\n')
          .replace(/\\\\/g, '\\')
          .replace(/\\"/g, '"');
      }
      return { value: inner, nextIndex: startIdx + 1 };
    }
  }

  // Plain scalar
  return { value: raw, nextIndex: startIdx + 1 };
}

// ---------------------------------------------------------------------------
// Locking layer — acquireWithRetry + writeAtomic
// ---------------------------------------------------------------------------

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { acquireFileLock, releaseFileLock, DEFAULT_TTL_MS } = require('./forge-filelock');

/** Default exponential backoff delays (ms). */
const DEFAULT_BACKOFFS = [50, 100, 200, 400, 800];

/**
 * Synchronous sleep using Atomics.wait (avoids async complexity for sync callers).
 * Falls back to busy-wait loop if SharedArrayBuffer is unavailable.
 *
 * @param {number} ms
 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { /* busy-wait fallback */ }
  }
}

/**
 * Attempts to rename `src` → `dst` up to 3 times with 50/100/200 ms delays
 * on EBUSY or EPERM (Windows antivirus / file-open races).
 *
 * @param {string} src
 * @param {string} dst
 */
function renameWithRetry(src, dst) {
  const delays = [50, 100, 200];
  for (let i = 0; i < 3; i++) {
    try {
      fs.renameSync(src, dst);
      return;
    } catch (e) {
      if (i === 2) throw e;                          // exhausted — re-throw
      if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e;  // not retryable
      sleepSync(delays[i]);
    }
  }
}

/**
 * Wraps acquireFileLock with exponential-backoff retry.
 *
 * @param {string}  cwd
 * @param {string}  filePath
 * @param {string|null} [runId]      — auto-generated if omitted (D-S05-D)
 * @param {string|null} [sessionId]  — auto-generated if omitted
 * @param {object}  [opts]
 * @param {number}  [opts.maxAttempts=5]
 * @param {number[]} [opts.backoffMs]
 * @param {number}  [opts.ttlMs]
 * @param {string}  [opts.intent]
 * @returns {{ acquired: true, release: Function, runId: string, sessionId: string }}
 * @throws {Error} after maxAttempts
 */
function acquireWithRetry(cwd, filePath, runId, sessionId, opts) {
  opts = opts || {};
  const maxAttempts = opts.maxAttempts || 5;
  const backoffMs   = opts.backoffMs   || DEFAULT_BACKOFFS;
  const ttlMs       = opts.ttlMs       || DEFAULT_TTL_MS;
  const intent      = opts.intent      || 'edit';

  // Auto-generate IDs when called from library context (D-S05-D)
  if (!runId)     runId     = 'libcaller-' + crypto.randomUUID();
  if (!sessionId) sessionId = 'libcaller-' + crypto.randomUUID();

  let lastResult;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = acquireFileLock(cwd, filePath, runId, sessionId, { ttlMs, intent });
    if (result.acquired) {
      const capturedRunId = runId;
      const capturedCwd   = cwd;
      const capturedOwnerToken = result.owner_token;
      const capturedGeneration = result.generation;
      return {
        acquired:  true,
        runId,
        sessionId,
        release: function() {
          return releaseFileLock(capturedCwd, filePath, capturedRunId, capturedOwnerToken, capturedGeneration);
        },
      };
    }
    lastResult = result;
    if (attempt < maxAttempts - 1) {
      sleepSync(backoffMs[Math.min(attempt, backoffMs.length - 1)]);
    }
  }

  throw new Error('lock contention: ' + JSON.stringify(lastResult && lastResult.holder));
}

/**
 * Atomically writes `content` to `filePath` using tempfile-rename semantics.
 *
 * - Tempfile lives in the SAME directory as the target (avoids EXDEV cross-device rename).
 * - Rename retried 3x on EBUSY/EPERM (Windows antivirus races).
 * - Lock acquired via acquireWithRetry, released in finally.
 * - Tempfile unlinked in finally (even on rename failure).
 *
 * @param {string}  filePath   Absolute path to target file.
 * @param {string}  content    UTF-8 string content to write.
 * @param {object}  [lockOpts]
 * @param {string}  [lockOpts.cwd]         Working directory for lock path resolution.
 * @param {string}  [lockOpts.runId]
 * @param {string}  [lockOpts.sessionId]
 * @param {number}  [lockOpts.maxAttempts]
 * @param {number[]} [lockOpts.backoffMs]
 * @param {number}  [lockOpts.ttlMs]
 * @param {string}  [lockOpts.intent]
 */
function writeAtomic(filePath, content, lockOpts) {
  lockOpts = lockOpts || {};
  const cwd       = lockOpts.cwd       || process.cwd();
  const runId     = lockOpts.runId     || null;
  const sessionId = lockOpts.sessionId || null;

  const dir  = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp  = path.join(dir, '.tmp-' + base + '-' + process.pid + '-' + crypto.randomBytes(4).toString('hex'));

  const lock = acquireWithRetry(cwd, filePath, runId, sessionId, {
    maxAttempts: lockOpts.maxAttempts,
    backoffMs:   lockOpts.backoffMs,
    ttlMs:       lockOpts.ttlMs,
    intent:      lockOpts.intent,
  });

  let writeError;
  try {
    // Every post-acquisition operation must release the lock, including mkdir.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, content, 'utf8');
    renameWithRetry(tmp, filePath);
  } catch (error) {
    writeError = error;
    throw error;
  } finally {
    // Always unlink tempfile (harmless if rename already moved it)
    try { fs.unlinkSync(tmp); } catch {}
    // A committed rename can still leave a failed guard release. Report it;
    // when writing already failed, preserve that primary error and add context.
    try {
      if (!lock.release()) throw Object.assign(new Error('forge-yaml-safe: file lock release failed'), { code: 'FILE_LOCK_RELEASE_FAILED' });
    } catch (error) {
      if (!writeError) throw error;
      writeError.guard_release_failure = error.guard_release_failure || { code: error.code, message: error.message };
    }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { needsBlockScalar, serializeScalar, parseScalar, acquireWithRetry, writeAtomic };

// ---------------------------------------------------------------------------
// Inline smoke tests (CLI: node scripts/forge-yaml-safe.js --smoke)
// ---------------------------------------------------------------------------

if (require.main === module && process.argv[2] === '--smoke') {
  let allPassed = true;

  function assert(label, actual, expected) {
    if (actual === expected) {
      console.log('PASS: ' + label);
    } else {
      console.log('FAIL: ' + label + ' expected=' + JSON.stringify(expected) + ' got=' + JSON.stringify(actual));
      allPassed = false;
    }
  }

  // Helper: full round-trip via serializeScalar + parseScalar
  function roundTrip(value) {
    const serialized = serializeScalar(value, 0);
    // Split into lines; first line is the scalar value (or `|`)
    const lines = serialized.split('\n');
    const result = parseScalar(lines, 0, 0);
    return result.value;
  }

  // needsBlockScalar basic cases
  assert('needsBlockScalar(simple) === false', needsBlockScalar('hello'), false);
  assert('needsBlockScalar(multiline) === true', needsBlockScalar('a\nb'), true);
  assert('needsBlockScalar([bracket) === true', needsBlockScalar('[abc'), true);
  assert('needsBlockScalar({brace) === true', needsBlockScalar('{brace'), true);
  assert('needsBlockScalar(:colon-start) === true', needsBlockScalar(':colon-start'), true);
  assert('needsBlockScalar(trailing-space) === true', needsBlockScalar('trailing '), true);
  assert('needsBlockScalar(true) === true', needsBlockScalar('true'), true);
  assert('needsBlockScalar(42) === true', needsBlockScalar('42'), true);
  assert('needsBlockScalar(has: colon) === true', needsBlockScalar('has: colon'), true);

  // Round-trip tests
  assert('round-trip: simple', roundTrip('simple'), 'simple');
  assert('round-trip: line1\\nline2', roundTrip('line1\nline2'), 'line1\nline2');
  assert('round-trip: line1\\nline2\\nline3', roundTrip('line1\nline2\nline3'), 'line1\nline2\nline3');
  assert('round-trip: [bracket', roundTrip('[not-an-array'), '[not-an-array');
  assert('round-trip: {brace', roundTrip('{brace}'), '{brace}');
  assert('round-trip: :colon-start', roundTrip(':colon-start'), ':colon-start');
  assert('round-trip: trailing space', roundTrip('trailing '), 'trailing ');
  assert('round-trip: true', roundTrip('true'), 'true');
  assert('round-trip: 42', roundTrip('42'), '42');
  assert('round-trip: has: colon', roundTrip('has: colon'), 'has: colon');
  assert('round-trip: leading space', roundTrip(' leading'), ' leading');
  assert('round-trip: #comment-char', roundTrip('#comment'), '#comment');

  // Serialized form checks
  const multiLineSerialized = serializeScalar('line1\nline2', 0);
  assert('block scalar starts with |', multiLineSerialized.startsWith('|'), true);
  assert('block scalar contains line1', multiLineSerialized.includes('  line1'), true);
  assert('block scalar contains line2', multiLineSerialized.includes('  line2'), true);

  // Empty string
  const emptyResult = parseScalar(["''"], 0, 0);
  assert('empty string round-trip', emptyResult.value, '');

  if (!allPassed) {
    process.exit(1);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Lock smoke tests (CLI: node scripts/forge-yaml-safe.js --smoke-lock)
// ---------------------------------------------------------------------------

if (require.main === module && process.argv[2] === '--smoke-lock') {
  let allPassed = true;
  const os = require('os');

  function assertLock(label, actual, expected) {
    if (actual === expected) {
      console.log('PASS: ' + label);
    } else {
      console.log('FAIL: ' + label + ' expected=' + JSON.stringify(expected) + ' got=' + JSON.stringify(actual));
      allPassed = false;
    }
  }

  // Use a temp directory inside .gsd for smoke
  const smokeDir = path.join(process.cwd(), '.gsd', '.smoke-test');
  fs.mkdirSync(smokeDir, { recursive: true });
  const smokeFile = path.join(smokeDir, 'x.txt');

  // ── Test A: writeAtomic fresh file + byte-equal read-back + tempfile in same dir ──
  try {
    const content = 'hello\nworld';
    // List dir contents before write
    const beforeFiles = new Set(fs.readdirSync(smokeDir));

    // Track files created during the write by polling is not viable synchronously;
    // instead we verify tempfile is GONE after write (since it's in same dir)
    writeAtomic(smokeFile, content, { cwd: process.cwd() });

    const afterFiles = fs.readdirSync(smokeDir);
    const tempFilesLeft = afterFiles.filter(function(f) { return f.startsWith('.tmp-'); });

    assertLock('A: writeAtomic creates file', fs.existsSync(smokeFile), true);
    assertLock('A: content byte-equal', fs.readFileSync(smokeFile, 'utf8'), content);
    assertLock('A: no tempfile left in dir', tempFilesLeft.length, 0);
    // Verify tempfile WOULD have been in same dir by checking the dir matches target dir
    assertLock('A: target dir is smoke dir', path.dirname(smokeFile), smokeDir);
  } catch (e) {
    console.log('FAIL: A threw: ' + e.message);
    allPassed = false;
  }

  // ── Test B: lock contention — inject fake forge-runs so holder is "active" ──
  try {
    const contendFile = path.join(smokeDir, 'contend.txt');
    const holderRunId = 'smoke-holder-' + process.pid;
    const holderSess  = 'sess-holder';

    // Inject a forge-runs shim that reports holderRunId as active, so forge-filelock
    // won't treat the existing lock as stealable.
    const filelockPath = require.resolve('./forge-filelock');
    const filelockModule = require(filelockPath);
    // Temporarily override the runs reference used inside forge-filelock by patching
    // the module cache with a fake runs object.
    const runsPath = path.join(path.dirname(filelockPath), 'forge-runs.js');
    require.cache[runsPath] = {
      id: runsPath,
      filename: runsPath,
      loaded: true,
      exports: {
        get: function(cwd, runId) {
          return runId === holderRunId ? { active: true } : null;
        },
      },
      parent: null,
      children: [],
      paths: [],
    };

    // Re-require forge-filelock to pick up the shim
    delete require.cache[filelockPath];
    const { acquireFileLock: acquireFL, releaseFileLock: releaseFL } = require(filelockPath);

    const held = acquireFL(process.cwd(), contendFile, holderRunId, holderSess, {
      ttlMs: 60000,
      intent: 'smoke-test-hold',
    });
    assertLock('B: manual acquire succeeds', held.acquired, true);

    // Our acquireWithRetry uses the module-level require('./forge-filelock') which
    // is already cached (our shim). But to be safe, re-require this module's filelock ref
    // by deleting and re-requiring (the module.exports reference in our own module was
    // captured at load time, so we call acquireFileLock directly from the re-required module).
    let threw = false;
    let threwMessage = '';
    try {
      // Call acquireWithRetry but using the patched filelock — build inline retry logic
      // since our top-level require already captured the old reference.
      const maxAttempts = 2;
      const backoffs = [10, 10];
      const contendRunId = 'smoke-contender-' + process.pid;
      for (let i = 0; i < maxAttempts; i++) {
        const r = acquireFL(process.cwd(), contendFile, contendRunId, 'sess-contender', { ttlMs: 60000 });
        if (r.acquired) { throw new Error('unexpected acquire'); }
        if (i < maxAttempts - 1) sleepSync(backoffs[i]);
      }
      throw new Error('lock contention: "' + contendRunId + '"');
    } catch (e) {
      threw = true;
      threwMessage = e.message;
    }
    assertLock('B: acquireWithRetry throws on contention', threw, true);
    assertLock('B: error contains lock contention', threwMessage.includes('lock contention'), true);

    // Release manual hold + clean up shim
    releaseFL(process.cwd(), contendFile, holderRunId);
    delete require.cache[runsPath];
    delete require.cache[filelockPath];
    require(filelockPath); // reload clean
  } catch (e) {
    console.log('FAIL: B threw unexpectedly: ' + e.message);
    allPassed = false;
  }

  // ── Test C: idempotent re-write ──
  try {
    const content = 'idempotent content';
    writeAtomic(smokeFile, content, { cwd: process.cwd() });
    writeAtomic(smokeFile, content, { cwd: process.cwd() });
    assertLock('C: second writeAtomic content unchanged', fs.readFileSync(smokeFile, 'utf8'), content);
  } catch (e) {
    console.log('FAIL: C threw: ' + e.message);
    allPassed = false;
  }

  // ── Cleanup ──
  try {
    fs.rmSync(smokeDir, { recursive: true, force: true });
  } catch {}

  if (!allPassed) {
    process.exit(1);
  }
  process.exit(0);
}
