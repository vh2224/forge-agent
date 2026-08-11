#!/usr/bin/env node
// forge-ledger — Per-milestone LEDGER fragment store for Forge Agent
//
// Library exports:
//   LEDGER_DIR                          → string  // relative path '.gsd/ledger'
//   ledgerDir(cwd)                      → string  // absolute path to ledger dir
//   fragmentPath(cwd, id)               → string  // absolute path to <id>.md (milestone or task)
//   parseFragment(text)                 → object  // parse markdown with YAML frontmatter
//   writeFragment(cwd, entry, opts)     → { path, created }
//   readFragment(cwd, id)               → object | null
//   listFragments(cwd)                  → Array<{ id, path }>
//
// CLI:
//   node forge-ledger.js --list [--cwd <dir>]
//   node forge-ledger.js --read <id> [--cwd <dir>]
//   node forge-ledger.js --write [--cwd <dir>]   (reads JSON entry from stdin)
//   node forge-ledger.js --validate <id> [--cwd <dir>]
//   node forge-ledger.js --smoke-regression
//   node forge-ledger.js --help
//
// Exit codes:
//   0 — success
//   1 — runtime error (invalid id, parse error, etc.)
//   2 — unknown/missing arguments

'use strict';

const fs = require('fs');
const path = require('path');
const { isValid, entityKind } = require('./forge-ids');
const { parseScalar, serializeScalar, writeAtomic } = require('./forge-yaml-safe');
const { isGroupedFile, readGroupedUnits, readSniffBuffer, publicEntry, unitTextOf } = require('./forge-grouped-file');

// ── Constants ─────────────────────────────────────────────────────────────────

const LEDGER_DIR = '.gsd/ledger';

// Grouped containers are a read format only. listFragments exposes one
// envelope per unit and preserves the physical container path for provenance.
// The grouped and epoch fields are additive metadata for existing consumers.
// A container parse error is reported on stderr with its source filename and
// member id, allowing callers to retain healthy units during partial reads.
// Loose files are discovered first so the loose representation is canonical.
// readFragment deliberately checks the canonical loose path first, then
// reuses listFragments for the grouped fallback rather than duplicating the
// directory scan. writeFragment never accepts a container path as a target.
// This keeps reads additive while preserving the established write contract.
//
// The helper module owns marker parsing, byte bounds, and epoch extraction.
// This store only maps those parsed units into ledger-shaped envelopes.

// ── Schema guard seam (M-S01 T04) ────────────────────────────────────────────
// Lazy require, deliberately: forge-schema-guard → forge-migrate →
// forge-projection → forge-ledger is a top-level cycle (see forge-migrate.js:33
// and forge-projection.js:32). Resolving inside the call defers it past module
// init, so no consumer ever captures a half-built exports object. The `catch`
// keeps this file loadable if the guard is not colocated (installed layouts).
//
// SINGLE INSERTION POINT PER SIDE:
//   read  → guardReadHere() at the top of listFragments/readFragment
//   write → assertWriteHere() at the top of writeFragment
// Reading `.gsd/SCHEMA-VERSION` or comparing versions anywhere else in this
// file is forbidden — the guard module is the only source of that logic.
// Only an ABSENT guard module is swallowed. A guard that exists but throws
// while initializing — or whose own transitive require fails (the guard pulls
// forge-migrate, which eagerly pulls projection/migrators/store-state/doctor)
// — is a real fault and must propagate rather than silently disabling both the
// read warning and the write refusal.
//
// SCOPE BOUNDARY (deliberate, do not 'complete' it): this narrows the CATCH
// only — it is about LOADING the guard, not about what the guard decides.
// The seam stays FAIL-OPEN on an unexpected runtime error raised inside the
// guard's own check (see the catch in assertWrite, forge-schema-guard.js).
// It is NOT fail-open on a stamp the guard could not READ: that case refuses
// the write, naming the errno. This note used to say the fail-open of
// assertWrite had been reviewed and kept as is — the PR #70 dogfood revised
// that decision: a directory at .gsd/SCHEMA-VERSION disabled the write guard
// silently, so "unreadable" now closes, while "absent" and "present but
// garbage" stay open.
function schemaGuard() {
  try {
    return require('./forge-schema-guard');
  } catch (err) {
    let absent;
    try {
      absent = require('./forge-optional-require').isAbsentModuleError(err, './forge-schema-guard');
    } catch (_) {
      // Classifier itself missing (partial install) → keep the historical
      // fail-open instead of crashing the store.
      absent = true;
    }
    if (absent) return null;
    throw err;
  }
}

// Fail-open read guard: returns { ok, partial, warning } and emits the warning
// to stderr at most once per process per cwd. Never throws, never blocks.
function guardReadHere(cwd) {
  const guard = schemaGuard();
  if (!guard) return { ok: true, partial: false, warning: null };
  return guard.guardReadAndWarn(cwd || process.cwd());
}

// Write refusal: throws when the on-disk schema major is AHEAD of this
// tooling's. The CLI catch blocks turn that into stderr + exit 1.
function assertWriteHere(cwd) {
  const guard = schemaGuard();
  if (!guard) return;
  guard.assertWriteOrThrow(cwd || process.cwd());
}

// ── ledgerDir ─────────────────────────────────────────────────────────────────
// Returns the absolute path to the ledger directory for a given cwd.
function ledgerDir(cwd) {
  return path.join(cwd || process.cwd(), '.gsd', 'ledger');
}

// ── fragmentPath ──────────────────────────────────────────────────────────────
// Returns absolute path to the fragment file for a milestone OR task ID.
// Both kinds live in the same store: .gsd/ledger/<id>.md (loose tasks from
// /forge-task write a ledger entry the same way milestones do — the projection
// already renders both, keyed off the directory listing, not the entity kind).
// Throws if the ID is invalid or is neither a milestone nor a task.
function fragmentPath(cwd, id) {
  if (!isValid(id)) {
    throw new Error(`Invalid ledger ID: ${id}`);
  }
  const kind = entityKind(id);
  if (kind !== 'milestone' && kind !== 'task') {
    throw new Error(`ID is not a milestone or task: ${id} (kind: ${kind})`);
  }
  return path.join(ledgerDir(cwd), `${id}.md`);
}

// ── parseFragment ─────────────────────────────────────────────────────────────
// Parses a LEDGER fragment markdown file (YAML frontmatter + body).
// Accepts both inline [a, b] and block "- a\n- b" array forms, including
// block-scalar values (multi-line strings via `|` indicator).
// Unknown frontmatter keys are passed through as-is.
// Returns { id, title, completed_at, slices, key_files, key_decisions, body, ...rest }
function parseFragment(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    // No frontmatter — return minimal object with raw body
    return { id: null, title: null, completed_at: null, slices: [], key_files: [], key_decisions: [], body: text.trim() };
  }

  const frontmatter = match[1];
  const body = match[2].trim();
  const result = {};

  // Parse frontmatter line by line
  const lines = frontmatter.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Block array item "  - value" or "- value" (continuation of array key)
    // Only handled as part of key-value fallthrough below when currentArray is set
    // We handle continuations inline after key detection.

    // Key-value pair
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      const rawVal = kv[2].trim();

      // Inline array: [a, b, c] or []
      if (rawVal.startsWith('[')) {
        const inner = rawVal.replace(/^\[|\]$/g, '').trim();
        result[key] = inner === '' ? [] : inner.split(',').map(s => s.trim()).filter(Boolean);
        i++;
        continue;
      }

      if (rawVal === '') {
        // Block array — collect items on subsequent lines
        result[key] = [];
        i++;
        while (i < lines.length) {
          const itemLine = lines[i];
          // Block array item: "  - value" or "- value"
          const arrayItem = itemLine.match(/^(\s*)-\s(.*)$/);
          if (arrayItem) {
            const itemIndent = arrayItem[1].length;
            // Use parseScalar on the value after "- " for block-scalar item support
            const valueAfterDash = arrayItem[2];
            if (valueAfterDash.trim() === '|') {
              // Block-scalar item value — parse continuation lines
              // Temporarily build a sub-lines array from `|` onward
              const subLines = ['|'].concat(lines.slice(i + 1));
              const parsed = parseScalar(subLines, 0, itemIndent);
              result[key].push(parsed.value);
              // Advance by how many sub-lines were consumed (parsed.nextIndex - 1 because we pre-added '|')
              i += parsed.nextIndex; // nextIndex accounts for `|` line + content lines
            } else {
              result[key].push(valueAfterDash.trim());
              i++;
            }
          } else {
            break; // end of array block
          }
        }
        continue;
      }

      // Scalar value (possibly block-scalar `|`)
      const scalarLines = [rawVal].concat(lines.slice(i + 1));
      const parsed = parseScalar(scalarLines, 0, 0);
      result[key] = parsed.value;
      // Advance past consumed continuation lines (parsed.nextIndex - 1 for extra lines after key)
      i += parsed.nextIndex; // nextIndex relative to scalarLines; line i is index 0 in scalarLines
      continue;
    }

    // Unrecognized line — skip
    i++;
  }

  // Normalize expected array fields
  const arrayFields = ['slices', 'key_files', 'key_decisions'];
  for (const f of arrayFields) {
    if (!Array.isArray(result[f])) {
      result[f] = result[f] != null ? [String(result[f])] : [];
    }
  }

  // Normalize scalar fields
  result.id = result.id || null;
  result.title = result.title || null;
  result.completed_at = result.completed_at || null;
  result.body = body;

  return result;
}

// ── serializeFrontmatter ──────────────────────────────────────────────────────
// Serializes an entry object to YAML frontmatter string.
// Keys are emitted in alphabetical order for diff stability.
// Arrays use block form for readability.
// Scalar values use forge-yaml-safe to handle multi-line / unsafe chars.
function serializeFrontmatter(entry) {
  const skip = new Set(['body']);
  const keys = Object.keys(entry).filter(k => !skip.has(k)).sort();

  const lines = [];
  for (const key of keys) {
    const val = entry[key];
    if (Array.isArray(val)) {
      if (val.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of val) {
          const serialized = serializeScalar(String(item), 2);
          lines.push(`  - ${serialized}`);
        }
      }
    } else if (val === null || val === undefined) {
      lines.push(`${key}: `);
    } else {
      const serialized = serializeScalar(String(val), 0);
      lines.push(`${key}: ${serialized}`);
    }
  }
  return lines.join('\n');
}

// ── writeFragment ─────────────────────────────────────────────────────────────
// Writes a LEDGER fragment to disk.
// Validates entry.id before writing.
// opts: optional { runId, sessionId } for lock identity.
// Returns { path: string, created: boolean }
// created: false if file existed and content is identical (idempotent).
function writeFragment(cwd, entry, opts) {
  // Refuse before any validation or serialization — nothing reaches disk.
  // Grouped containers are never edited; this always writes fragmentPath().
  assertWriteHere(cwd);
  opts = opts || {};
  if (!entry || !entry.id) {
    throw new Error('entry.id is required');
  }

  const fpath = fragmentPath(cwd, entry.id); // throws if invalid id

  // Serialize
  const frontmatter = serializeFrontmatter(entry);
  const body = entry.body ? `\n${entry.body}` : '';
  const content = `---\n${frontmatter}\n---\n${body}`;

  // Idempotent check — read before acquiring lock to avoid unnecessary contention
  if (fs.existsSync(fpath)) {
    try {
      const existing = fs.readFileSync(fpath, 'utf8');
      if (existing === content) {
        return { path: fpath, created: false };
      }
    } catch {
      // File unreadable — proceed to write
    }
  }

  writeAtomic(fpath, content, {
    cwd: cwd || process.cwd(),
    runId: opts.runId || null,
    sessionId: opts.sessionId || null,
  });

  return { path: fpath, created: true };
}

// ── D4 rendered-block cap ─────────────────────────────────────────────────────
// D4 caps a NEW ledger entry at 15 lines of its RENDERED block — the cap lives
// on what a reader (and a prompt budget) actually pays for, not on `body`:
// slices[] + key_files[] + key_decisions[] are what make an entry fat.
// Advisory only: measured AFTER a successful write, reported inside the exit-0
// JSON, never trimming and never refusing. Existing entries are never rewritten.
const LEDGER_LINE_CAP = 15;

// Counts the lines of one rendered ledger block, excluding the block-separation
// punctuation ('', '---', '') that renderLedgerBlock appends — the cap is about
// the entry's own content, not the separators between entries. Measured on a
// real store (this repo, 2026-08-11): 8 entries measure 14–22 content lines,
// with M-20260804003633-forge-sweep-project-pr2 at 22 — over the cap.
function measureRenderedBlock(content, id) {
  // Lazy require: forge-projection requires this module at the top level, so a
  // top-level require here would close the cycle and leave one of the two
  // module objects half-initialized. Same reason as forge-memory.js:718 and
  // forge-doctor.js:398 — do not "promote" it to the top because it seems to work.
  const projection = require('./forge-projection');
  const frag = parseFragment(content);
  const block = projection.renderLedgerBlock(frag, id);
  return Math.max(0, block.length - projection.LEDGER_BLOCK_SEPARATOR_LINES);
}

// ── readFragment ──────────────────────────────────────────────────────────────
// Reads and parses a LEDGER fragment (milestone or task). Returns null if the
// file does not exist.
function readFragment(cwd, id) {
  guardReadHere(cwd);
  let fpath;
  try {
    fpath = fragmentPath(cwd, id);
  } catch (e) {
    throw e; // propagate invalid id error
  }

  if (fs.existsSync(fpath)) return parseFragment(fs.readFileSync(fpath, 'utf8'));
  const entry = listFragments(cwd).find(item => item.id === id);
  return entry ? parseFragment(readFragmentText(cwd, entry)) : null;
}

function readFragmentText(cwd, entry) {
  if (!entry || !entry.path) throw new Error('fragment entry is required');
  if (!entry.grouped) return fs.readFileSync(entry.path, 'utf8');
  const parsed = readGroupedUnits(entry.path);
  const unit = parsed.units.find(item => item.id === entry.id);
  if (!unit) throw new Error(`Grouped ledger unit not found: ${entry.id}`);
  return unitTextOf(unit.content);
}

// ── listFragments ─────────────────────────────────────────────────────────────
// Lists all fragment files in the ledger directory.
// Returns Array<{ id, path }> sorted by id ascending.
// Returns [] if the directory does not exist.
function listFragments(cwd) {
  guardReadHere(cwd);
  const dir = ledgerDir(cwd);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  const looseIds = new Set();
  const fragments = [];
  for (const file of files) {
    const filePath = path.join(dir, file);
    // A failed sniff (null) means "not classified as a container": the entry is
    // still returned and the read error stays with the consumer, one unit at a
    // time, as it did before grouping existed. See readSniffBuffer.
    const buffer = readSniffBuffer(filePath);
    // Unreadable AND epoch-shaped: pushing it as a loose fragment named
    // `2026-Q1` would make every unit inside it vanish with nothing on stderr.
    if (buffer === null && isGroupedFile(file)) {
      process.stderr.write(`[forge-ledger] warn: container ${file}: container-unreadable — unidades não listadas\n`);
      continue;
    }
    if (buffer !== null && isGroupedFile(file, buffer)) continue;
    const id = file.slice(0, -3);
    looseIds.add(id);
    fragments.push({ id, path: filePath, grouped: false, epoch: null });
  }
  for (const file of files) {
    const filePath = path.join(dir, file);
    const buffer = readSniffBuffer(filePath);
    if (buffer === null || !isGroupedFile(file, buffer)) continue;
    const parsed = readGroupedUnits(filePath);
    for (const error of parsed.errors) {
      process.stderr.write(`[forge-ledger] warn: container ${file} id ${error.id || '<unknown>'}: ${error.reason}\n`);
    }
    for (const unit of parsed.units) {
      if (looseIds.has(unit.id)) {
        process.stderr.write(`[forge-ledger] warn: unidade ${unit.id} existe solta e em ${file} — usando a solta\n`);
        continue;
      }
      fragments.push({ id: unit.id, path: filePath, grouped: true, epoch: parsed.epoch });
    }
  }
  fragments.sort((a, b) => a.id.localeCompare(b.id));

  return fragments;
}

// ── cliMain ───────────────────────────────────────────────────────────────────
function printUsage() {
  console.log(`Usage: node forge-ledger.js <command> [options]

Commands:
  --list [--cwd <dir>]          List all ledger fragments (JSON array)
  --read <id> [--cwd <dir>]     Read and print a fragment (JSON), null if missing
  --write [--cwd <dir>]         Write fragment from stdin (JSON entry)
  --validate <id> [--cwd <dir>] Validate ID and check if fragment exists
  --smoke-regression            Run regression smoke tests (multi-line + renderLedger + task round-trip)
  --help, -h                    Show this help

Options:
  --cwd <dir>   Working directory (default: process.cwd())

Exit codes:
  0  Success
  1  Runtime error (invalid id, parse error, I/O failure)
  2  Unknown or missing arguments`);
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

  if (cmd === '--list') {
    // `--list` stdout is a bare JSON ARRAY of fragments — it is data, not an
    // envelope, so it carries no schema_partial/schema_warning key (a JSON
    // array cannot hold one without changing its shape, and consumers such as
    // skills/forge-sweep iterate it directly). The partial signal for this
    // command travels on stderr only, emitted by guardReadHere inside
    // listFragments. Object-shaped envelopes (--stale, --query) do get fields.
    //
    // Two shapes, on purpose: listFragments() is the LIBRARY API and carries
    // the grouping fields (grouped/epoch) for internal consumers; this stdout
    // is a FROZEN EXTERNAL contract parsed by key, so it must not gain keys
    // when the storage format evolves. publicEntry is the single shared
    // projection for all three stores — three local omissions would drift, and
    // that drift is exactly what leaked these fields in the first place.
    // Guarded by forge-schema-guard-wiring.test.js ("list row keys unchanged").
    const result = listFragments(cwd).map(publicEntry);
    console.log(JSON.stringify(result));
    process.exit(0);
  }

  if (cmd === '--read') {
    const id = argv[1];
    if (!id) {
      process.stderr.write('--read requires a milestone or task ID\n');
      process.exit(2);
    }
    const fragment = readFragment(cwd, id);
    console.log(JSON.stringify(fragment));
    process.exit(0);
  }

  if (cmd === '--write') {
    // Read JSON entry from stdin
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { raw += chunk; });
    process.stdin.on('end', () => {
      let entry;
      try {
        entry = JSON.parse(raw);
      } catch (e) {
        process.stderr.write(`Failed to parse JSON from stdin: ${e.message}\n`);
        process.exit(1);
      }
      // Explicit catch: this runs inside an async stdin handler, outside the
      // require.main try/catch below, so a schema-guard refusal (or any write
      // error) would otherwise surface as an uncaught stack trace. Message on
      // stderr, exit 1 — the store CLI contract.
      let result;
      try {
        result = writeFragment(cwd, entry);
      } catch (e) {
        process.stderr.write(`${e.message}\n`);
        process.exit(1);
      }
      // D4 advisory cap — measured on the block as rendered, after the write
      // succeeded. Additive fields only: {path, created} stays untouched, so
      // existing consumers are unaffected and new ones read `d.over_cap || false`.
      // A failure to MEASURE must never look like a failure to WRITE: warn on
      // stderr and emit the envelope without the new fields.
      let envelope = result;
      try {
        const written = fs.readFileSync(result.path, 'utf8');
        const renderedLines = measureRenderedBlock(written, entry.id);
        const overCap = renderedLines > LEDGER_LINE_CAP;
        envelope = { ...result, rendered_lines: renderedLines, cap: LEDGER_LINE_CAP, over_cap: overCap };
        if (overCap) {
          process.stderr.write(
            `[forge-ledger] warn: ledger entry ${entry.id} renders ${renderedLines} lines, over the D4 cap of ${LEDGER_LINE_CAP} — entry written unchanged; trim slices/key_files/key_decisions before it lands\n`
          );
        }
      } catch (e) {
        process.stderr.write(`[forge-ledger] warn: could not measure rendered block for ${entry.id}: ${e.message}\n`);
      }
      console.log(JSON.stringify(envelope));
      process.exit(0);
    });
    return; // async — do not fall through
  }

  if (cmd === '--validate') {
    const id = argv[1];
    if (!id) {
      process.stderr.write('--validate requires a milestone or task ID\n');
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
      valid: isValid(id),
      kind: entityKind(id),
      exists: existsError ? false : exists,
    };
    if (existsError) result.error = existsError;
    console.log(JSON.stringify(result));
    process.exit(0);
  }

  if (cmd === '--smoke-regression') {
    runSmokeRegression();
    return;
  }

  // Unknown command
  process.stderr.write(`Unknown argument: ${cmd}\n\n`);
  printUsage();
  process.exit(2);
}

// ── Smoke regression ─────────────────────────────────────────────────────────
function runSmokeRegression() {
  const os = require('os');
  let allPassed = true;

  function assert(label, actual, expected) {
    if (actual === expected) {
      console.log('PASS: ' + label);
    } else {
      console.log('FAIL: ' + label + '\n  expected: ' + JSON.stringify(expected) + '\n  got:      ' + JSON.stringify(actual));
      allPassed = false;
    }
  }

  // Use a temp dir that won't conflict with real ledger data
  const tmpBase = path.join(os.tmpdir(), '.gsd-smoke-t05-' + process.pid);
  const smokeCwd = tmpBase;

  try {
    fs.mkdirSync(path.join(tmpBase, '.gsd', 'ledger'), { recursive: true });

    // Need a valid milestone ID — use timestamp format
    const smokeId = 'M-20260101000000-smoke-t05';

    // ── Test 1: multi-line title round-trip ──────────────────────────────────
    const multiLineTitle = 'Line1\nLine2';
    const entry = {
      id: smokeId,
      title: multiLineTitle,
      completed_at: '2026-01-01T00:00:00Z',
      slices: ['S01', 'S02'],
      key_files: ['scripts/forge-ledger.js'],
      key_decisions: ['[bracket-start decision', 'normal decision'],
      body: 'Body content here.',
    };

    writeFragment(smokeCwd, entry);
    const readBack = readFragment(smokeCwd, smokeId);

    assert('round-trip: title multi-line', readBack.title, multiLineTitle);
    assert('round-trip: completed_at', readBack.completed_at, entry.completed_at);
    assert('round-trip: slices length', readBack.slices.length, 2);
    assert('round-trip: slices[0]', readBack.slices[0], 'S01');
    assert('round-trip: slices[1]', readBack.slices[1], 'S02');
    assert('round-trip: key_decisions[0] bracket-start', readBack.key_decisions[0], '[bracket-start decision');
    assert('round-trip: key_decisions[1] normal', readBack.key_decisions[1], 'normal decision');
    assert('round-trip: body', readBack.body, 'Body content here.');

    // ── Test 2: idempotent write ──────────────────────────────────────────────
    const result2 = writeFragment(smokeCwd, entry);
    assert('idempotent: created=false on second identical write', result2.created, false);

    // ── Test 3: 3-arg writeFragment (opts.runId/sessionId) ────────────────────
    const entry2 = Object.assign({}, entry, { id: 'M-20260101000001-smoke-t05b', title: 'Simple title' });
    const result3 = writeFragment(smokeCwd, entry2, { runId: 'smoke-run', sessionId: 'smoke-sess' });
    assert('3-arg writeFragment: created=true', result3.created, true);
    const readBack3 = readFragment(smokeCwd, entry2.id);
    assert('3-arg: round-trip title', readBack3.title, 'Simple title');

    // ── Test 4: renderLedger regression (forge-projection consumer) ───────────
    let renderLedgerPassed = false;
    try {
      const projection = require('./forge-projection');
      const rendered = projection.renderLedger(smokeCwd);
      // Should contain the milestone id and multi-line title content
      const containsId = rendered.includes(smokeId);
      // renderLedger wraps title in **...**; check for Line1 (first line of multi-line)
      const containsTitle = rendered.includes('Line1');
      renderLedgerPassed = containsId && containsTitle && rendered.length > 0;
      assert('renderLedger: non-empty output', rendered.length > 0, true);
      assert('renderLedger: contains milestone id', containsId, true);
      assert('renderLedger: contains title content', containsTitle, true);
    } catch (e) {
      console.log('FAIL: renderLedger threw: ' + e.message);
      allPassed = false;
    }

    // ── Test 5: task ledger fragment round-trip (regression — see fix) ─────────
    // Loose tasks from /forge-task write ledger entries the same way milestones
    // do. fragmentPath() used to throw for task IDs, breaking post-task
    // housekeeping and the /forge-sweep LEDGER guard. Cover both the timestamp
    // (T-<ts>-<slug>) and legacy (TASK-###) task ID forms.
    const taskIds = ['T-20260618020926-demo-fechar-modal', 'TASK-007'];
    for (const taskId of taskIds) {
      let threw = false;
      try {
        fragmentPath(smokeCwd, taskId);
      } catch (_) {
        threw = true;
      }
      assert(`task fragmentPath does not throw (${taskId})`, threw, false);

      const taskEntry = {
        id: taskId,
        title: 'Fechar modal ao apertar Esc',
        completed_at: '2026-06-18T00:00:00Z',
        slices: [],
        key_files: ['src/components/Modal.tsx'],
        key_decisions: ['Esc fecha o modal mais externo'],
        body: 'Modal agora fecha com Esc.',
      };
      const wrote = writeFragment(smokeCwd, taskEntry);
      assert(`task write: created=true (${taskId})`, wrote.created, true);

      const readBackTask = readFragment(smokeCwd, taskId);
      assert(`task round-trip: id (${taskId})`, readBackTask && readBackTask.id, taskId);
      assert(`task round-trip: title (${taskId})`, readBackTask && readBackTask.title, 'Fechar modal ao apertar Esc');
      assert(`task round-trip: key_files[0] (${taskId})`, readBackTask && readBackTask.key_files[0], 'src/components/Modal.tsx');
    }

    // Task entries must surface in the rendered LEDGER (the /forge-sweep guard
    // matches the directory name against a `## <task-id>` heading).
    try {
      const projection = require('./forge-projection');
      const renderedWithTasks = projection.renderLedger(smokeCwd);
      assert('renderLedger: contains timestamp task heading', renderedWithTasks.includes('## T-20260618020926-demo-fechar-modal'), true);
      assert('renderLedger: contains legacy task heading', renderedWithTasks.includes('## TASK-007'), true);
    } catch (e) {
      console.log('FAIL: renderLedger (tasks) threw: ' + e.message);
      allPassed = false;
    }

  } finally {
    // Cleanup
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  }

  if (allPassed) {
    console.log('\nPASS: all smoke-regression checks passed');
    process.exit(0);
  } else {
    console.log('\nFAIL: one or more smoke-regression checks failed');
    process.exit(1);
  }
}

// ── Module exports ────────────────────────────────────────────────────────────
// Must be set before CLI guard so that circular requires (e.g. from
// --smoke-regression → forge-projection → forge-ledger) get a complete exports object.
module.exports = {
  LEDGER_DIR,
  LEDGER_LINE_CAP,
  measureRenderedBlock,
  ledgerDir,
  fragmentPath,
  writeFragment,
  readFragment,
  readFragmentText,
  listFragments,
  parseFragment,
};

// ── Guarded CLI invocation ────────────────────────────────────────────────────
if (require.main === module) {
  try {
    cliMain(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}
