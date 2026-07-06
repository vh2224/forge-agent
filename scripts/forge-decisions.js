#!/usr/bin/env node
// forge-decisions — Per-unit DECISIONS fragment store for Forge Agent
//
// Library exports:
//   DECISIONS_DIR                       → string  // relative path '.gsd/decisions'
//   decisionsDir(cwd)                   → string  // absolute path to decisions dir
//   fragmentPath(cwd, unitId)           → string  // absolute path to <unit-id>.md
//   parseFragment(text)                 → object  // parse markdown with YAML frontmatter
//   writeFragment(cwd, fragment, opts)  → { path, created }
//   readFragment(cwd, unitId)           → object | null
//   listFragments(cwd)                  → Array<{ unitId, path }>
//
// CLI:
//   node forge-decisions.js --list [--cwd <dir>]
//   node forge-decisions.js --read <unit-id> [--cwd <dir>]
//   node forge-decisions.js --write [--cwd <dir>]   (reads JSON fragment from stdin)
//   node forge-decisions.js --validate <unit-id> [--cwd <dir>]
//   node forge-decisions.js --smoke-regression
//   node forge-decisions.js --help
//
// Exit codes:
//   0 — success
//   1 — runtime error (invalid id, parse error, etc.)
//   2 — unknown/missing arguments

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isValid, entityKind } = require('./forge-ids');
const yamlSafe = require('./forge-yaml-safe');

// ── Constants ─────────────────────────────────────────────────────────────────

const DECISIONS_DIR = '.gsd/decisions';

// Pattern for forge-ask session IDs: ask-<session-id>
const ASK_ID_RE = /^ask-[A-Za-z0-9._-]+$/;

// ── decisionsDir ──────────────────────────────────────────────────────────────
// Returns the absolute path to the decisions directory for a given cwd.
function decisionsDir(cwd) {
  return path.join(cwd || process.cwd(), '.gsd', 'decisions');
}

// ── validateUnitId ────────────────────────────────────────────────────────────
// Returns true if id is a valid unit ID for a DECISIONS fragment.
// Accepts three shapes:
//   1. Milestone IDs (via forge-ids.isValid + entityKind === 'milestone')
//   2. Task IDs     (via forge-ids.isValid + entityKind === 'task')
//   3. ask-<session-id> literals (^ask-[A-Za-z0-9._-]+$)
function validateUnitId(id) {
  if (!id) return false;
  // Shape 3: forge-ask session
  if (ASK_ID_RE.test(id)) return true;
  // Shapes 1 & 2: delegate to forge-ids
  if (!isValid(id)) return false;
  const kind = entityKind(id);
  return kind === 'milestone' || kind === 'task';
}

// ── fragmentPath ──────────────────────────────────────────────────────────────
// Returns absolute path to the fragment file for a unit ID.
// Throws if the ID is not a valid decisions unit ID.
function fragmentPath(cwd, unitId) {
  if (!validateUnitId(unitId)) {
    throw new Error(
      `Invalid decisions unit ID: "${unitId}". ` +
      'Expected a milestone ID (M###, M-<ts>-<slug>), ' +
      'task ID (TASK-###, T-<ts>-<slug>), or ask-<session-id>.'
    );
  }
  return path.join(decisionsDir(cwd), `${unitId}.md`);
}

// ── parseFragment ─────────────────────────────────────────────────────────────
// Parses a DECISIONS fragment markdown file (YAML frontmatter + body).
// The `decisions:` key holds a block array of objects, each with keys:
//   { when, scope, decision, choice, rationale, revisable }
// No `#`/numbering column in storage — numbering is derived at projection time.
// Unknown frontmatter keys are passed through as-is.
// Accepts both inline ([...]) and block (- item) array forms.
// Scalar values in decision objects use yamlSafe.parseScalar for lossless
// round-trip of multi-line and colon-leading strings.
function parseFragment(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return {
      unit_id: null,
      decisions: [],
      body: text.trim(),
    };
  }

  const frontmatter = match[1];
  const body = match[2].trim();
  const result = {};

  const lines = frontmatter.split('\n');
  let currentKey = null;
  let currentArray = null;
  let inDecisionObject = false;
  let currentDecision = null;
  // Track current line index so parseScalar can consume block scalars.
  // We use a for-loop with manual `i` so we can advance past block-scalar lines.
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Detect start of a decision object item: "  - when: ..." or "- when: ..."
    const decisionItemStart = line.match(/^(\s*)-\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (decisionItemStart && currentKey === 'decisions' && Array.isArray(result['decisions'])) {
      // Save previous decision object
      if (currentDecision !== null) {
        result['decisions'].push(currentDecision);
      }
      currentDecision = {};
      const dKey = decisionItemStart[2];
      // The rest of the line after "key: " is the scalar value (or block indicator).
      // We feed a synthetic lines array starting from the remainder.
      const remainder = decisionItemStart[3];
      // Build a synthetic lines slice: first line is remainder, then continuation.
      // We need to use parseScalar on this remainder position.
      // Indent for decision object items is 4 (nested under "  - ")
      const syntheticLines = [remainder, ...lines.slice(i + 1)];
      const parsed = yamlSafe.parseScalar(syntheticLines, 0, 4);
      currentDecision[dKey] = parsed.value;
      // Advance i by the number of extra lines consumed (block scalar lines).
      // parsed.nextIndex - 1 = extra lines consumed beyond line 0 of syntheticLines.
      i += parsed.nextIndex; // i was at the "  - key: ..." line; advance past consumed lines.
      inDecisionObject = true;
      currentArray = null;
      continue;
    }

    // Continuation of a decision object: "    key: value"
    if (inDecisionObject && currentDecision !== null) {
      const objKv = line.match(/^\s{2,}([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
      if (objKv) {
        const dKey = objKv[1];
        const remainder = objKv[2];
        // Continuation keys are at indent 4. Build synthetic slice from remainder.
        const syntheticLines = [remainder, ...lines.slice(i + 1)];
        const parsed = yamlSafe.parseScalar(syntheticLines, 0, 4);
        currentDecision[dKey] = parsed.value;
        i += parsed.nextIndex;
        continue;
      }
      // Unindented or non-kv line ends the decision object
      if (currentDecision !== null) {
        result['decisions'].push(currentDecision);
        currentDecision = null;
        inDecisionObject = false;
      }
    }

    // Plain block array item: "  - value" or "- value" (non-decisions arrays)
    const arrayItem = line.match(/^\s*-\s+(.*)$/);
    if (arrayItem && currentArray !== null && currentKey !== 'decisions') {
      currentArray.push(arrayItem[1].trim());
      i++;
      continue;
    }

    // Key-value pair
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      const rawVal = kv[2].trim();

      if (key === 'decisions') {
        result['decisions'] = [];
        currentKey = 'decisions';
        currentArray = null;
        currentDecision = null;
        inDecisionObject = false;
        i++;
        continue;
      }

      // Inline array: [a, b, c] or []
      if (rawVal.startsWith('[')) {
        const inner = rawVal.replace(/^\[|\]$/g, '').trim();
        result[key] = inner === '' ? [] : inner.split(',').map(s => s.trim()).filter(Boolean);
        currentKey = key;
        currentArray = null;
        inDecisionObject = false;
      } else if (rawVal === '') {
        // Block array starts next
        result[key] = [];
        currentKey = key;
        currentArray = result[key];
        inDecisionObject = false;
      } else {
        result[key] = rawVal;
        currentKey = key;
        currentArray = null;
        inDecisionObject = false;
      }
      i++;
      continue;
    }

    // Unrecognized line — flush pending decision object and reset context
    if (currentDecision !== null) {
      result['decisions'].push(currentDecision);
      currentDecision = null;
    }
    inDecisionObject = false;
    currentArray = null;
    i++;
  }

  // Flush trailing decision object
  if (currentDecision !== null) {
    result['decisions'].push(currentDecision);
  }

  // Ensure decisions is always an array
  if (!Array.isArray(result['decisions'])) {
    result['decisions'] = [];
  }

  result.unit_id = result.unit_id || null;
  result.body = body;

  return result;
}

// ── decisionHash ──────────────────────────────────────────────────────────────
// Stable hash for a decision entry's (when, decision, choice) dedup tuple.
function decisionHash(d) {
  const raw = [d.when || '', d.decision || '', d.choice || ''].join('\x00');
  return crypto.createHash('sha1').update(raw).digest('hex');
}

// ── textHash ─────────────────────────────────────────────────────────────────
// Stable hash for the `decision` text field — used for stable sort ordering.
function textHash(d) {
  return crypto.createHash('sha1').update(String(d.decision || '')).digest('hex');
}

// ── mergeDecisions ────────────────────────────────────────────────────────────
// Merges two arrays of decision objects.
// New entries are added; entries whose (when, decision, choice) tuple already
// exists are skipped. Result is sorted by `when` ASC then by SHA1(decision).
function mergeDecisions(existing, incoming) {
  const seen = new Set(existing.map(decisionHash));
  const merged = [...existing];

  for (const d of incoming) {
    const h = decisionHash(d);
    if (!seen.has(h)) {
      seen.add(h);
      merged.push(d);
    }
  }

  // Sort: when ASC, then by SHA1(decision) for stability
  merged.sort((a, b) => {
    const wa = String(a.when || '');
    const wb = String(b.when || '');
    if (wa < wb) return -1;
    if (wa > wb) return 1;
    // Same when: sort by text hash for determinism
    return textHash(a).localeCompare(textHash(b));
  });

  return merged;
}

// ── serializeFrontmatter ──────────────────────────────────────────────────────
// Serializes a fragment object to YAML frontmatter string.
// Keys are emitted in alphabetical order for diff stability.
// `decisions` array uses block-of-objects form.
// Simple arrays use block form. Scalars use yamlSafe.serializeScalar for
// lossless round-trip (multi-line, colon-leading, etc.).
function serializeFrontmatter(fragment) {
  const skip = new Set(['body']);
  const keys = Object.keys(fragment).filter(k => !skip.has(k)).sort();

  const lines = [];
  for (const key of keys) {
    const val = fragment[key];

    if (key === 'decisions') {
      // Block array of objects
      if (!Array.isArray(val) || val.length === 0) {
        lines.push('decisions: []');
      } else {
        lines.push('decisions:');
        const DECISION_KEYS = ['when', 'scope', 'decision', 'choice', 'rationale', 'revisable'];
        for (const d of val) {
          // Emit canonical keys first, then any extras, all in stable order
          const allKeys = [
            ...DECISION_KEYS.filter(k => k in d),
            ...Object.keys(d).filter(k => !DECISION_KEYS.includes(k)).sort(),
          ];
          let first = true;
          for (const dk of allKeys) {
            const prefix = first ? '  - ' : '    ';
            // currentIndent for decision object items is 4 (under "  - ")
            const serialized = yamlSafe.serializeScalar(
              d[dk] !== undefined && d[dk] !== null ? d[dk] : '',
              4
            );
            lines.push(`${prefix}${dk}: ${serialized}`);
            first = false;
          }
        }
      }
      continue;
    }

    if (Array.isArray(val)) {
      if (val.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of val) {
          lines.push(`  - ${item}`);
        }
      }
    } else if (val === null || val === undefined) {
      lines.push(`${key}: `);
    } else {
      lines.push(`${key}: ${yamlSafe.serializeScalar(val, 0)}`);
    }
  }
  return lines.join('\n');
}

// ── writeFragment ─────────────────────────────────────────────────────────────
// Writes a DECISIONS fragment to disk.
// fragment shape: { unit_id, decisions: [{when, scope, decision, choice, rationale, revisable}, ...], ...rest }
// opts shape: { runId?: string, sessionId?: string }  (passed to writeAtomic for lock tracking)
// Merges with existing fragment if present (dedup on tuple (when, decision, choice)).
// Returns { path: string, created: boolean }
// created: false if content is identical after merge (idempotent).
function writeFragment(cwd, fragment, opts) {
  if (opts === undefined) opts = {};
  if (!fragment || !fragment.unit_id) {
    throw new Error('fragment.unit_id is required');
  }

  const fpath = fragmentPath(cwd, fragment.unit_id); // throws if invalid id

  // Merge with existing if present
  let base = fragment;
  if (fs.existsSync(fpath)) {
    const existing = parseFragment(fs.readFileSync(fpath, 'utf8'));
    const existingDecisions = Array.isArray(existing.decisions) ? existing.decisions : [];
    const incomingDecisions = Array.isArray(fragment.decisions) ? fragment.decisions : [];
    const mergedDecisions = mergeDecisions(existingDecisions, incomingDecisions);
    // Merge: incoming scalar fields override existing; decisions merged
    base = { ...existing, ...fragment, decisions: mergedDecisions };
  } else {
    // New fragment: sort decisions for stable ordering
    const decisions = Array.isArray(fragment.decisions) ? mergeDecisions([], fragment.decisions) : [];
    base = { ...fragment, decisions };
  }

  // Serialize
  const frontmatter = serializeFrontmatter(base);
  const body = base.body ? `\n${base.body}` : '';
  const content = `---\n${frontmatter}\n---\n${body}`;

  // Idempotent check
  if (fs.existsSync(fpath)) {
    const existingContent = fs.readFileSync(fpath, 'utf8');
    if (existingContent === content) {
      return { path: fpath, created: false };
    }
  }

  // Atomic write with optional lock tracking via runId/sessionId
  yamlSafe.writeAtomic(fpath, content, {
    cwd: cwd,
    runId: opts.runId || null,
    sessionId: opts.sessionId || null,
  });

  return { path: fpath, created: true };
}

// ── readFragment ──────────────────────────────────────────────────────────────
// Reads and parses a DECISIONS fragment. Returns null if the unit does not
// exist as a loose fragment OR as a unit inside a closed bucket (bucket-aware
// — S02). Always resolves via listFragments() so the same bucket-wins
// precedence applies to both listing and single-id lookup.
function readFragment(cwd, unitId) {
  fragmentPath(cwd, unitId); // throws if invalid id

  const entry = listFragments(cwd).find(f => f.unitId === unitId);
  if (!entry) return null;
  if (entry.content != null) return parseFragment(entry.content); // unit from a bucket
  const text = fs.readFileSync(entry.path, 'utf8');
  return parseFragment(text);
}

// ── listFragments ─────────────────────────────────────────────────────────────
// Lists all logical DECISIONS units: loose fragment files (S01, unchanged
// shape) PLUS units flattened from closed `_rollup-*.md` buckets (S02
// addition).
// Returns Array<{ unitId, path, content?, bucket? }> sorted by unitId ascending.
//   - Loose fragment: { unitId, path }                        (S01 shape — unchanged)
//   - Bucket unit:     { unitId, path: bucketPath, content, bucket: true }
// Dedup precedence: BUCKET WINS (same rationale as forge-ledger.listFragments
// — consistent with forge-maintenance.mergeBucket's write-path).
// Returns [] if the directory does not exist.
function listFragments(cwd) {
  const dir = decisionsDir(cwd);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir);
  const map = new Map(); // unitId → entry

  // 1. Loose fragments first (`_`-prefix reserved for buckets).
  for (const f of files) {
    if (!f.endsWith('.md') || f.startsWith('_')) continue;
    const unitId = f.slice(0, -3); // strip .md
    map.set(unitId, { unitId, path: path.join(dir, f) });
  }

  // 2. Bucket units overwrite — bucket wins. Lazy require avoids a load-order
  //    cycle (forge-maintenance requires forge-ledger, not forge-decisions, at
  //    module-eval time, but lazy-require here is consistent + load-order-proof
  //    regardless).
  const { listBucketUnits } = require('./forge-maintenance');
  const { units, warnings } = listBucketUnits(dir);
  for (const w of warnings) {
    process.stderr.write(`[forge-decisions] warn: ${w}\n`);
  }
  for (const u of units) {
    map.set(u.id, { unitId: u.id, path: u.bucketPath, content: u.content, bucket: true });
  }

  return Array.from(map.values()).sort((a, b) => a.unitId.localeCompare(b.unitId));
}

// ── Module exports ────────────────────────────────────────────────────────────
module.exports = {
  DECISIONS_DIR,
  decisionsDir,
  fragmentPath,
  parseFragment,
  writeFragment,
  readFragment,
  listFragments,
};

// ── cliMain ───────────────────────────────────────────────────────────────────
function printUsage() {
  console.log(`Usage: node forge-decisions.js <command> [options]

Commands:
  --list [--cwd <dir>]            List all decisions fragments (JSON array)
  --read <unit-id> [--cwd <dir>] Read and print a fragment (JSON), null if missing
  --write [--cwd <dir>]           Write/merge fragment from stdin (JSON fragment)
  --validate <unit-id> [--cwd <dir>] Validate ID and check if fragment exists
  --smoke-regression              Run inline regression smoke test (exit 0 = PASS)
  --help, -h                      Show this help

Unit ID forms accepted:
  M###, M-<ts>-<slug>            Milestone IDs
  TASK-###, T-<ts>-<slug>        Task IDs
  ask-<session-id>               forge-ask session IDs

Options:
  --cwd <dir>   Working directory (default: process.cwd())

Exit codes:
  0  Success
  1  Runtime error (invalid id, parse error, I/O failure)
  2  Unknown or missing arguments`);
}

// ── smokeRegression ───────────────────────────────────────────────────────────
// Inline regression smoke: verifies multi-line round-trip, colon-leading
// round-trip, and that forge-projection.js renderDecisions() still works
// against a fragment with block-scalar content.
function smokeRegression() {
  const os = require('os');
  const smokeDir = path.join(os.tmpdir(), '.gsd-smoke-t04');
  let allPassed = true;

  function assert(label, actual, expected) {
    if (actual === expected) {
      console.log('PASS: ' + label);
    } else {
      console.log('FAIL: ' + label + '\n  expected: ' + JSON.stringify(expected) + '\n  got:      ' + JSON.stringify(actual));
      allPassed = false;
    }
  }

  // Cleanup any previous run
  try { fs.rmSync(smokeDir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(smokeDir, { recursive: true });

  // We need a valid milestone ID to write a fragment
  // Use a legacy-style ID that forge-ids accepts
  const unitId = 'M001';
  const multilineRationale = 'line1\nline2\nline3';
  const colonLeadingChoice = ':option-a';

  // ── Test A: multi-line rationale round-trip ──
  const fragA = {
    unit_id: unitId,
    decisions: [
      {
        when: '2026-01-01',
        scope: 'S01',
        decision: 'Use postgres',
        choice: colonLeadingChoice,
        rationale: multilineRationale,
        revisable: 'yes',
      },
    ],
  };

  let resultA;
  try {
    resultA = writeFragment(smokeDir, fragA);
  } catch (e) {
    console.log('FAIL: writeFragment threw: ' + e.message);
    allPassed = false;
    fs.rmSync(smokeDir, { recursive: true, force: true });
    process.exit(1);
  }
  assert('A: writeFragment created', resultA.created, true);

  const readBack = readFragment(smokeDir, unitId);
  assert('A: readFragment returns non-null', readBack !== null, true);
  assert('A: decisions array length', readBack && readBack.decisions.length, 1);

  const d0 = readBack && readBack.decisions[0];
  assert('A: multi-line rationale round-trip', d0 && d0.rationale, multilineRationale);
  assert('A: colon-leading choice round-trip', d0 && d0.choice, colonLeadingChoice);

  // ── Test B: 3-arg writeFragment (opts with runId/sessionId) ──
  const fragB = {
    unit_id: unitId,
    decisions: [
      {
        when: '2026-01-02',
        scope: 'S02',
        decision: 'Use redis',
        choice: 'standalone',
        rationale: 'Performance',
        revisable: 'no',
      },
    ],
  };

  let resultB;
  try {
    resultB = writeFragment(smokeDir, fragB, { runId: 'smoke-run-1', sessionId: 'smoke-sess-1' });
  } catch (e) {
    console.log('FAIL: 3-arg writeFragment threw: ' + e.message);
    allPassed = false;
    fs.rmSync(smokeDir, { recursive: true, force: true });
    process.exit(1);
  }
  assert('B: 3-arg writeFragment created (merge appended)', resultB.created, true);
  const readBackB = readFragment(smokeDir, unitId);
  assert('B: merged fragment has 2 decisions', readBackB && readBackB.decisions.length, 2);

  // ── Test C: idempotent write ──
  const resultC = writeFragment(smokeDir, fragA);
  assert('C: idempotent re-write → created: false', resultC.created, false);

  // ── Test D: renderDecisions regression via forge-projection ──
  let projectionPassed = false;
  try {
    const projMod = require('./forge-projection');
    const rendered = projMod.renderDecisions(smokeDir);
    // Must return a non-empty string containing our multi-line rationale content
    assert('D: renderDecisions returns string', typeof rendered, 'string');
    assert('D: renderDecisions non-empty', rendered.length > 0, true);
    // The rendered output should contain at least part of the decision text
    assert('D: renderDecisions contains decision text', rendered.includes('Use postgres'), true);
    projectionPassed = true;
  } catch (e) {
    console.log('FAIL: renderDecisions threw: ' + e.message);
    allPassed = false;
  }

  // ── Cleanup ──
  try { fs.rmSync(smokeDir, { recursive: true, force: true }); } catch {}

  if (allPassed) {
    console.log('\nPASS — all smoke-regression assertions passed');
    process.exit(0);
  } else {
    console.log('\nFAIL — one or more smoke-regression assertions failed');
    process.exit(1);
  }
}

function cliMain(argv) {
  // Parse --cwd
  let cwd = process.cwd();
  const cwdIdx = argv.indexOf('--cwd');
  if (cwdIdx !== -1) {
    cwd = argv[cwdIdx + 1];
    if (!cwd) {
      process.stderr.write('--cwd requires a directory argument\n');
      process.exit(2);
    }
    argv = argv.filter((_, i) => i !== cwdIdx && i !== cwdIdx + 1);
  }

  const cmd = argv[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    printUsage();
    process.exit(0);
  }

  if (cmd === '--smoke-regression') {
    smokeRegression();
    return;
  }

  if (cmd === '--list') {
    const result = listFragments(cwd);
    console.log(JSON.stringify(result));
    process.exit(0);
  }

  if (cmd === '--read') {
    const id = argv[1];
    if (!id) {
      process.stderr.write('--read requires a unit ID\n');
      process.exit(2);
    }
    const fragment = readFragment(cwd, id);
    console.log(JSON.stringify(fragment));
    process.exit(0);
  }

  if (cmd === '--write') {
    // Read JSON fragment from stdin
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { raw += chunk; });
    process.stdin.on('end', () => {
      let fragment;
      try {
        fragment = JSON.parse(raw);
      } catch (e) {
        process.stderr.write(`Failed to parse JSON from stdin: ${e.message}\n`);
        process.exit(1);
      }
      let result;
      try {
        result = writeFragment(cwd, fragment);
      } catch (e) {
        process.stderr.write(`${e.message}\n`);
        process.exit(1);
      }
      console.log(JSON.stringify(result));
      process.exit(0);
    });
    return; // async — do not fall through
  }

  if (cmd === '--validate') {
    const id = argv[1];
    if (!id) {
      process.stderr.write('--validate requires a unit ID\n');
      process.exit(2);
    }
    let exists = false;
    let existsError = null;
    try {
      const fpath = fragmentPath(cwd, id);
      exists = fs.existsSync(fpath);
    } catch (e) {
      existsError = e.message;
    }
    const result = {
      id,
      valid: validateUnitId(id),
      exists: existsError ? false : exists,
    };
    if (existsError) result.error = existsError;
    console.log(JSON.stringify(result));
    process.exit(0);
  }

  // Unknown command
  process.stderr.write(`Unknown argument: ${cmd}\n\n`);
  printUsage();
  process.exit(2);
}

// ── Guarded CLI invocation ────────────────────────────────────────────────────
if (require.main === module) {
  try {
    cliMain(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}
