#!/usr/bin/env node
'use strict';

/**
 * Paired suite for forge-evidence-materialize.js.
 *
 * The central assertion here is a COMPARISON, not an inspection: the three
 * outcomes (`collected`, `not-collected`, `collector-failed`) are checked
 * pairwise, byte against byte, on both artefacts they produce (the stdout JSON
 * and the census line). Reading one artefact and finding it plausible would
 * pass just as happily if two of the three rendered identically — which is the
 * exact defect this milestone exists to close.
 *
 * Fixtures live in os.tmpdir(); nothing under the repo is written, so a failing
 * run leaves no stray files to be unioned into S07's `forge-touch --record`.
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mat = require('./forge-evidence-materialize');
const { ADMISSIBLE_TYPES } = require('./forge-evidence-admit');

const SCRIPT = path.join(__dirname, 'forge-evidence-materialize.js');
// The file name is derived from the naming authority, never restated as a
// literal here: since the S01 review R3 fix a unit id carrying a disallowed
// char (every real `execute-task/T##`) also carries the per-axis fingerprint
// mark, and a literal would silently pin an outdated shape.
const FILE_T02 = require('./forge-evidence-path').buildEvidenceFileName({ unit: 'execute-task/T02' });
const REPO_ROOT = path.resolve(__dirname, '..');

let assertions = 0;
function check(condition, message) { assertions += 1; assert(condition, message); }
function equal(actual, expected, message) { assertions += 1; assert.deepStrictEqual(actual, expected, message); }

// A REAL project dir: since the S01 review R1 fix the materializer refuses to
// write when no `.gsd` owner resolves at or above `--cwd`, so a bare tmpdir is
// no longer a valid fixture for the write paths — it is the fixture for the
// REFUSAL path (testOwnerGuardRefusesOrphan below). `PROJECT.md` is a
// WORK_ENTRY (forge-workspace.js), which is what makes a dir a project;
// `.gsd/forge` alone is runtime-only and deliberately does not qualify.
function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `forge-evidence-mat-${label}-`));
  fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gsd', 'PROJECT.md'), '# fixture project\n', 'utf8');
  return dir;
}
function tempOrphanDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `forge-evidence-orphan-${label}-`));
}
function writeResult(dir, payload) {
  const file = path.join(dir, 'result.json');
  fs.writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  return file;
}
function runCli(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
}
function censusLines(file) {
  return readLines(file).map((l) => JSON.parse(l)).filter((o) => o.kind === 'census');
}

const COLLECTED_PAYLOAD = {
  status: 'done',
  runtime_evidence: {
    census: {
      outcome: 'collected', items_received: 3, types_seen: { commandExecution: 1, reasoning: 1, fileChange: 1 },
      admitted: 2, inadmissible: 1, rejected: [], turn_status: 'completed',
    },
    entries: [
      { ts: '2026-08-06T10:00:00.000Z', source: 'codex-runtime', kind: 'command', unit: null, cmd: 'node scripts/run-tests.js', cwd: '/tmp/x', exit_code: 0, duration_ms: 12, status: 'completed' },
      { ts: '2026-08-06T10:00:01.000Z', source: 'codex-runtime', kind: 'file', unit: null, file: 'scripts/a.js', change_kind: 'modify', status: 'completed' },
    ],
  },
};

// ── 1. CLI contract: file name, stdout shape, exit code ────────────────────

function testCliContract() {
  const dir = tempDir('cli');
  const result = writeResult(dir, COLLECTED_PAYLOAD);
  const run = runCli(['--result', result, '--unit', 'execute-task/T02', '--cwd', dir, '--json']);

  equal(run.status, 0, 'CLI exits 0 on a collected payload');
  const expectedFile = path.join(dir, '.gsd', 'forge', FILE_T02);
  check(fs.existsSync(expectedFile), `CLI writes the §7 file name: ${expectedFile}`);

  const out = JSON.parse(run.stdout);
  for (const key of ['outcome', 'written', 'items_received', 'types_seen']) {
    check(Object.prototype.hasOwnProperty.call(out, key), `stdout JSON carries '${key}'`);
  }
  equal(out.outcome, 'collected', 'collected payload reports outcome collected');
  equal(out.written, 3, 'written counts the census line plus both entries');
  equal(out.items_received, 3, 'items_received is carried from the census');
  equal(out.types_seen.commandExecution, 1, 'types_seen is carried from the census');

  // Non-JSON mode still exits 0 and says something a human can read.
  const human = runCli(['--result', result, '--unit', 'execute-task/T02', '--cwd', dir]);
  equal(human.status, 0, 'CLI exits 0 without --json');
  check(human.stdout.includes('collected'), 'human output names the outcome');

  // Arg guards fire before any read, with exit 2 kept distinct from advisory 0.
  equal(runCli(['--bogus']).status, 2, 'unknown flag exits 2');
  equal(runCli(['--unit', 'execute-task/T02']).status, 2, 'missing --result exits 2');
  equal(runCli(['--result', result, '--cwd', dir]).status, 2, 'missing --unit exits 2');
}

// ── 2. The three outcomes, compared PAIRWISE ───────────────────────────────

function scenario(label, payload) {
  const dir = tempDir(label);
  const result = writeResult(dir, payload);
  const run = runCli(['--result', result, '--unit', 'execute-task/T02', '--cwd', dir, '--json']);
  const file = path.join(dir, '.gsd', 'forge', FILE_T02);
  const lines = readLines(file);
  const census = JSON.parse(lines[0]);
  // The volatile `ts` is stripped before comparison so that a difference found
  // between two scenarios is a difference of MEANING, never of clock.
  const stable = { ...census };
  delete stable.ts;
  return { label, status: run.status, stdout: run.stdout, lines, census, stableCensus: JSON.stringify(stable) };
}

function testThreeOutcomesDistinct() {
  const collectedEmpty = scenario('collected-empty', {
    runtime_evidence: {
      census: { outcome: 'collected', items_received: 4, types_seen: { reasoning: 4 }, admitted: 0, inadmissible: 4, rejected: [], turn_status: 'completed' },
      entries: [],
    },
  });
  const notCollected = scenario('not-collected', { status: 'done', summary: 'no runtime_evidence field at all' });
  const collectorFailed = scenario('collector-failed', {
    runtime_evidence: {
      census: { outcome: 'collector-failed', items_received: 2, types_seen: { commandExecution: 2 }, admitted: 0, inadmissible: 0, rejected: [], turn_status: null, reason: 'census does not account for every received item' },
      entries: [],
    },
  });
  const malformed = scenario('malformed', { runtime_evidence: { census: { outcome: 'weird' }, entries: [] } });

  equal(collectedEmpty.census.outcome, 'collected', 'collected-and-empty stays collected');
  equal(collectedEmpty.census.admitted, 0, 'collected-and-empty admits zero');
  equal(notCollected.census.outcome, 'not-collected', 'absent field is not-collected');
  equal(notCollected.census.reason, 'field-absent', 'absent field names reason field-absent');
  equal(collectorFailed.census.outcome, 'collector-failed', 'collector-reported failure stays collector-failed');
  equal(malformed.census.outcome, 'collector-failed', 'malformed field is collector-failed');
  equal(malformed.census.reason, 'malformed-field', 'malformed field names reason malformed-field');

  // Pairwise, on BOTH artefacts. All three must differ from all others.
  const all = [collectedEmpty, notCollected, collectorFailed];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      check(all[i].stableCensus !== all[j].stableCensus,
        `census lines of '${all[i].label}' and '${all[j].label}' differ byte for byte`);
      const a = JSON.parse(all[i].stdout); const b = JSON.parse(all[j].stdout);
      check(JSON.stringify({ ...a, file: null }) !== JSON.stringify({ ...b, file: null }),
        `stdout JSON of '${all[i].label}' and '${all[j].label}' differ`);
    }
  }

  // The floor S07 established, restated at this layer: ABSENCE never renders
  // as an empty collection. Deleting the hasOwnProperty branch would make
  // these two identical, and this pair is what catches it.
  check(collectedEmpty.census.outcome !== notCollected.census.outcome,
    'collected-and-empty never collapses into not-collected');
  check(notCollected.census.items_received === 0 && collectedEmpty.census.items_received === 4,
    'the census still reports what it received in each case');
}

// ── 3. Exactly one census line, in every outcome, always ───────────────────

function testCensusAlwaysExactlyOne() {
  const cases = [
    ['collected', COLLECTED_PAYLOAD],
    ['collected-empty', { runtime_evidence: { census: { outcome: 'collected', items_received: 0, types_seen: {}, admitted: 0, inadmissible: 0, rejected: [] }, entries: [] } }],
    ['not-collected', { status: 'done' }],
    ['collector-failed', { runtime_evidence: { census: { outcome: 'collector-failed', items_received: 1, types_seen: {}, reason: 'x' }, entries: [] } }],
    ['unreadable-result', null],
  ];
  for (const [label, payload] of cases) {
    const dir = tempDir(`census-${label}`);
    const result = payload === null ? path.join(dir, 'missing.json') : writeResult(dir, payload);
    const run = runCli(['--result', result, '--unit', 'execute-task/T02', '--cwd', dir, '--json']);
    equal(run.status, 0, `${label}: exit 0 (advisory, never blocks)`);
    const file = path.join(dir, '.gsd', 'forge', FILE_T02);
    check(fs.existsSync(file), `${label}: the jsonl exists even when nothing else is written`);
    equal(censusLines(file).length, 1, `${label}: exactly one census line`);
  }

  // An unreadable result file degrades with a named reason instead of crashing.
  const dir = tempDir('unreadable');
  const out = JSON.parse(runCli(['--result', path.join(dir, 'nope.json'), '--unit', 'u', '--cwd', dir, '--json']).stdout);
  equal(out.outcome, 'collector-failed', 'missing result file is collector-failed');
  equal(out.reason, 'result-file-unreadable', 'missing result file names its reason');

  // Invoked twice → two census lines, one per invocation. Appending, not
  // rewriting: a materialiser that replaced the file would erase the hook's
  // and the legacy synthesized lines living in the same artefact.
  const twice = tempDir('twice');
  const resultFile = writeResult(twice, COLLECTED_PAYLOAD);
  runCli(['--result', resultFile, '--unit', 'execute-task/T02', '--cwd', twice, '--json']);
  runCli(['--result', resultFile, '--unit', 'execute-task/T02', '--cwd', twice, '--json']);
  equal(censusLines(path.join(twice, '.gsd', 'forge', FILE_T02)).length, 2,
    'each invocation contributes exactly one census line');
}

// ── 3b. `kind` is derived, never trusted (S04 review R9) ───────────────────
//
// Measured before the fix: a payload entry `{kind:'census'}` was written as a
// SECOND `kind:"census"` line stamped `source: codex-runtime`, breaking the
// exactly-one-census floor. `source` was already forced for that same disguise
// reason; `kind` was not. Asserted in BOTH directions — the disguise is denied
// AND the legitimate kinds still pass through unchanged.
function testKindIsDerivedNotTrusted() {
  const dir = tempDir('kind-disguise');
  const payload = {
    runtime_evidence: {
      census: {
        outcome: 'collected', items_received: 3, admitted: 3, inadmissible: 0,
        rejected: [], turn_status: 'completed', types_seen: { commandExecution: 3 },
      },
      entries: [
        // The disguise: a census-shaped entry with inflated counters.
        { ts: '2026-08-06T10:00:00.000Z', kind: 'census', outcome: 'collected', admitted: 999, items_received: 999 },
        { ts: '2026-08-06T10:00:01.000Z', kind: 'command', cmd: 'node scripts/run-tests.js', exit_code: 0 },
        { ts: '2026-08-06T10:00:02.000Z', kind: 'file', file: 'scripts/a.js', change_kind: 'modify' },
      ],
    },
  };
  const result = writeResult(dir, payload);
  runCli(['--result', result, '--unit', 'execute-task/T02', '--cwd', dir, '--json']);
  const file = path.join(dir, '.gsd', 'forge', FILE_T02);
  const objs = readLines(file).map((l) => JSON.parse(l));

  equal(censusLines(file).length, 1, 'a payload entry claiming kind:census does NOT become a second census line');
  equal(objs[0].admitted, 3, 'the one census line is the script\'s own, not the payload\'s inflated copy');

  // The disguised entry is neither dropped (silence) nor passed through
  // (disguise): it is named.
  const entries = objs.slice(1);
  equal(entries.length, 3, 'all three entries are still written — an unrecognised kind is never silently dropped');
  equal(entries[0].kind, 'unclassified', 'the census-claiming entry is renamed to a named, non-census kind');
  check(entries[0].admitted === 999, 'its other payload fields survive verbatim — only kind is overridden');

  // Reverse direction: legitimate kinds are untouched.
  equal(entries[1].kind, 'command', 'a legitimate kind:command survives unchanged');
  equal(entries[2].kind, 'file', 'a legitimate kind:file survives unchanged');
  const allowed = new Set([...Object.values(mat.KIND_BY_ADMISSIBLE_TYPE), 'unclassified']);
  check(entries.every((e) => allowed.has(e.kind)), 'no entry line carries a kind outside the derived closed set');
}

// ── 4. The two sources coexist and stay separable ──────────────────────────

function testSourcesCoexist() {
  const dir = tempDir('sources');
  const evidenceDir = path.join(dir, '.gsd', 'forge');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const file = path.join(evidenceDir, FILE_T02);

  // A pre-existing LEGACY synthesized line (D7: nothing is retired).
  const legacy = { ts: '2026-08-06T09:00:00.000Z', tool: 'codex-sidecar', action: 'M', file: 'scripts/a.js', source: 'codex-sidecar', unit: 'execute-task/T02' };
  fs.appendFileSync(file, `${JSON.stringify(legacy)}\n`, 'utf8');

  // A payload that LIES about its source: it must not be able to disguise a
  // runtime line as a legacy synthesized one.
  const liar = JSON.parse(JSON.stringify(COLLECTED_PAYLOAD));
  liar.runtime_evidence.entries[0].source = 'codex-sidecar';
  const result = writeResult(dir, liar);
  runCli(['--result', result, '--unit', 'execute-task/T02', '--cwd', dir, '--json']);

  const objs = readLines(file).map((l) => JSON.parse(l));
  const legacyLines = objs.filter((o) => o.source === 'codex-sidecar');
  const runtimeLines = objs.filter((o) => o.source === 'codex-runtime');
  equal(legacyLines.length, 1, 'the pre-existing synthesized line survives, separable by strict equality');
  equal(runtimeLines.length, 3, 'census + 2 entries are runtime-sourced');
  equal(legacyLines.length + runtimeLines.length, objs.length, 'no third source value appears');
  check(runtimeLines.every((o) => o.source === mat.SOURCE), 'every written line carries source codex-runtime');
  check(!runtimeLines.some((o) => o.source === mat.LEGACY_SOURCE), 'the script never writes source codex-sidecar');
  check(runtimeLines.every((o) => typeof o.ts === 'string'), 'runtime lines carry an ISO string ts, like the synthesized ones beside them');
}

// ── 5. 512-byte cap, stepped, still valid JSON ─────────────────────────────

function testLineCap() {
  const dir = tempDir('cap');
  const huge = 'x'.repeat(5000);
  const payload = {
    runtime_evidence: {
      census: {
        outcome: 'collected', items_received: 2, admitted: 2, inadmissible: 0, rejected: [], turn_status: 'completed',
        types_seen: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`variant${i}${huge.slice(0, 40)}`, i])),
      },
      entries: [
        { ts: '2026-08-06T10:00:00.000Z', source: 'codex-runtime', kind: 'command', cmd: huge, cwd: huge, exit_code: 1, duration_ms: 9, status: 'failed' },
        { ts: '2026-08-06T10:00:01.000Z', source: 'codex-runtime', kind: 'file', file: huge, change_kind: 'add', status: 'completed' },
      ],
    },
  };
  const result = writeResult(dir, payload);
  runCli(['--result', result, '--unit', 'execute-task/T02', '--cwd', dir, '--json']);

  const file = path.join(dir, '.gsd', 'forge', FILE_T02);
  const lines = readLines(file);
  equal(lines.length, 3, 'oversized input still yields census + both entries');
  for (const line of lines) {
    check(Buffer.byteLength(line, 'utf8') <= mat.MAX_LINE_BYTES, `line respects the ${mat.MAX_LINE_BYTES}B cap`);
    const parsed = JSON.parse(line); // must remain parseable at every degree
    equal(parsed.source, 'codex-runtime', 'a truncated line keeps its source');
    check(typeof parsed.kind === 'string' && parsed.kind.length > 0, 'a truncated line keeps its kind');
  }
  const census = JSON.parse(lines[0]);
  equal(census.items_received, 2, 'a truncated census keeps the counters that make it a census');

  // Bite proof: an unbounded serialiser would exceed the cap on this input.
  const unbounded = JSON.stringify({ ts: 'x', source: 'codex-runtime', kind: 'command', cmd: huge });
  check(Buffer.byteLength(unbounded, 'utf8') > mat.MAX_LINE_BYTES, 'the fixture is genuinely oversized');
}

// ── 5b. The cap holds in the LAST degree too (S04 review R10) ──────────────
//
// Measured before the fix: the final truncation fallback retained `ts`, `kind`
// and `unit` verbatim, so 2000-char values produced a 6071-byte line — the one
// degree whose job is to stop the growth was the one that did not. Every
// retained field is exercised INDIVIDUALLY, so a fix that bounds two of three
// cannot pass; and the byte length is re-checked with multi-byte values, since
// a character cap is not a byte cap.
function testLineCapFinalDegree() {
  const huge = 'x'.repeat(2000);
  const wide = '🙂'.repeat(2000); // 4 bytes/char: bounded by length, not by bytes

  // Bite proof, both alphabets: the fixture really is oversized in each field.
  for (const [label, value] of [['ascii', huge], ['multi-byte', wide]]) {
    for (const field of ['ts', 'kind', 'unit']) {
      const base = { ts: 'T', source: 'codex-runtime', kind: 'command', unit: 'u', cmd: huge, file: huge, cwd: huge };
      const line = mat.serializeEntryLine({ ...base, [field]: value });
      check(
        Buffer.byteLength(line, 'utf8') <= mat.MAX_LINE_BYTES,
        `entry line with oversized ${field} (${label}) respects the ${mat.MAX_LINE_BYTES}B cap`
      );
      JSON.parse(line); // parseable at the last degree, like every other one
      assertions += 1;

      const census = mat.serializeCensusLine({
        ts: 'T', source: 'codex-runtime', kind: 'census', unit: 'u', outcome: 'collected',
        reason: null, items_received: 1, admitted: 1, written: 1, types_seen: {}, rejected: [],
        [field]: value,
      });
      check(
        Buffer.byteLength(census, 'utf8') <= mat.MAX_LINE_BYTES,
        `census line with oversized ${field} (${label}) respects the cap`
      );
      JSON.parse(census);
      assertions += 1;
    }
  }

  // The census retains `outcome`/`reason` too — unbounded strings there defeat
  // the cap just as surely as `ts` did.
  for (const field of ['outcome', 'reason']) {
    const census = mat.serializeCensusLine({
      ts: 'T', source: 'codex-runtime', kind: 'census', unit: 'u', outcome: 'collected',
      reason: null, items_received: 1, admitted: 1, written: 1, types_seen: {}, rejected: [],
      [field]: huge,
    });
    check(Buffer.byteLength(census, 'utf8') <= mat.MAX_LINE_BYTES, `census line with oversized ${field} respects the cap`);
  }

  // And through the CLI, with an oversized --unit: `unit` reaches every line
  // this script writes, so it is the one field a caller controls end to end.
  const dir = tempDir('cap-unit');
  const result = writeResult(dir, {
    runtime_evidence: {
      census: { outcome: 'collected', items_received: 1, types_seen: { commandExecution: 1 }, admitted: 1, inadmissible: 0, rejected: [] },
      entries: [{ ts: '2026-08-06T10:00:00.000Z', kind: 'command', cmd: huge, cwd: huge, exit_code: 0 }],
    },
  });
  const cli = runCli(['--result', result, '--unit', huge, '--cwd', dir, '--json']);
  equal(cli.status, 0, 'an oversized --unit is still advisory exit 0');
  const written = JSON.parse(cli.stdout).file;
  const lines = readLines(written);
  equal(lines.length, 2, 'census + entry are still written under an oversized unit — never dropped');
  for (const line of lines) {
    check(Buffer.byteLength(line, 'utf8') <= mat.MAX_LINE_BYTES, 'every line written under an oversized --unit respects the cap');
    JSON.parse(line);
    assertions += 1;
  }
  check(path.basename(written).length <= 140, 'an oversized --unit cannot produce an unbounded file name either');
}

// ── 6. entries[].file is DATA — never resolved, stat'ed or opened ──────────

function testPathIsDataNotInstruction() {
  const dir = tempDir('path');
  const hostile = '../../../../etc/passwd';
  const payload = {
    runtime_evidence: {
      census: { outcome: 'collected', items_received: 1, types_seen: { fileChange: 1 }, admitted: 1, inadmissible: 0, rejected: [] },
      entries: [{ ts: '2026-08-06T10:00:00.000Z', source: 'codex-runtime', kind: 'file', file: hostile, change_kind: 'modify', status: 'completed' }],
    },
  };
  const result = writeResult(dir, payload);

  const touched = [];
  const spies = ['statSync', 'lstatSync', 'openSync', 'existsSync', 'realpathSync', 'readFileSync'];
  const originals = {};
  for (const name of spies) {
    originals[name] = fs[name];
    fs[name] = function spy(target, ...rest) {
      touched.push(String(target));
      return originals[name].call(fs, target, ...rest);
    };
  }
  try {
    mat.materialize({ result, unit: 'execute-task/T02', cwd: dir });
  } finally {
    for (const name of spies) fs[name] = originals[name];
  }

  check(touched.some((t) => t === result), 'the result file itself is read (control: the spy works)');
  check(!touched.some((t) => t.includes('etc/passwd')), 'no filesystem call ever receives entries[].file');
  check(!touched.some((t) => t.includes('..')), 'no traversal segment from the payload reaches the filesystem');

  // And the hostile value IS written, verbatim, as text — dropping it would be
  // the silence this script exists to prevent.
  const written = readLines(path.join(dir, '.gsd', 'forge', FILE_T02));
  const entry = JSON.parse(written[1]);
  equal(entry.file, hostile, 'the path is serialised as data, unchanged');

  // The file NAME is derived from the unit, never joined from it: a unit id
  // carrying traversal must not steer the write out of .gsd/forge/.
  const name = mat.evidenceFileName('../../escape/T02');
  check(!name.includes('/') && !name.includes('\\') && !name.includes('..'),
    `unit ids are flattened into a file name (got ${name})`);
  equal(mat.evidenceFileName('execute-task/T02'), FILE_T02,
    'the naming convention is now the composite key (S01/T03), delegated to forge-evidence-path.js');
}

// ── 7. Kind coverage is confronted with T01, not assumed ───────────────────

function testKindCoverage() {
  const coverage = mat.admissibleKindCoverage();
  check(coverage.ok, 'every admissible variant of T01 has an entry kind here');
  equal(Object.keys(mat.KIND_BY_ADMISSIBLE_TYPE).sort(), [...ADMISSIBLE_TYPES].sort(),
    'the kind map and T01 ADMISSIBLE_TYPES name the same variants');
  equal(mat.OUTCOME_VALUES, ['collected', 'not-collected', 'collector-failed'], 'the outcome enum is closed at three');
}

// ── 8. §7 of the canonical doc + the three mirrors ─────────────────────────
//
// In-process with `fs` and EXACT COUNTS, never `includes()` over a whole
// document and never a shell `grep` (this shell's grep honours .gitignore —
// the origin defect of forge-doc-claims.js).

function countOf(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function testDocSevenRewritten() {
  const doc = fs.readFileSync(path.join(REPO_ROOT, 'shared', 'forge-dispatch.md'), 'utf8');

  // Anti-silence floor: if the file we are policing were empty or unreadable
  // every count below would be trivially satisfied.
  check(doc.length > 1000, 'the canonical dispatch doc was actually read');

  equal(countOf(doc, '**7. Synthesized evidence (advisory).**'), 0,
    'the step is no longer described, whole, as synthesized advisory evidence');
  equal(countOf(doc, '**7a.'), 1, 'step 7a (legacy synthesized lines, preserved) exists exactly once');
  equal(countOf(doc, '**7b.'), 1, 'step 7b (runtime-observed lines) exists exactly once');
  check(countOf(doc, 'forge-evidence-materialize.js') >= 1, 'the canonical doc names the materializer');
  equal(countOf(doc, '--result "$RESULT_FILE" --unit'), 1,
    'the canonical doc carries exactly one invocation of it');
  check(countOf(doc, 'codex-runtime') >= 1, 'the canonical doc names the runtime source value');
  check(countOf(doc, 'codex-sidecar') >= 1, 'the legacy source value is still documented (D7: nothing retired)');
}

// 2026-08-23 sidecar extraction: Branch C/D moved verbatim from the two loop
// skills to shared/forge-sidecar-{auto,next}.md (loaded on demand). Mirror
// guards read the pair — the invocation must exist exactly once in the pair.
function mirrorSurface(rel) {
  const spec = {
    'skills/forge-auto/SKILL.md': 'shared/forge-sidecar-auto.md',
    'skills/forge-next/SKILL.md': 'shared/forge-sidecar-next.md',
  }[rel];
  const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  return spec ? text + '\n' + fs.readFileSync(path.join(REPO_ROOT, spec), 'utf8') : text;
}

function testMirrorsInvokeAtStepSeven() {
  const mirrors = [
    ['skills/forge-auto/SKILL.md', 'execute-task/{T##}'],
    ['skills/forge-next/SKILL.md', 'execute-task/{T##}'],
    ['skills/forge-task/SKILL.md', 'task/{TASK_ID}'],
  ];
  for (const [rel, unitToken] of mirrors) {
    const text = mirrorSurface(rel);
    check(text.length > 1000, `${rel} was actually read`);
    equal(countOf(text, 'forge-evidence-materialize.js'), 1,
      `${rel} invokes the materializer exactly once — one point, not many`);
    check(countOf(text, unitToken) >= 1, `${rel} still uses its own unit token ${unitToken}`);
    // The mirrors reference the canonical section; they never restate it.
    check(countOf(text, 'shared/forge-dispatch.md') >= 1, `${rel} references the canonical spec by name`);
  }
}

// ── 12. S01 review R1: no owner → no mkdirSync, ever ───────────────────────
//
// The pre-fix shape (`let ownerDir = cwd`, overwritten only on a truthy
// resolveOwner) manufactured `<cwd>/.gsd/forge` in ANY writable directory.
// The floor is not "usually resolves an owner" — it is that the refusal path
// creates NOTHING and still reports itself with a named reason.

function testOwnerGuardRefusesOrphan() {
  const orphan = tempOrphanDir('r1');
  const result = writeResult(orphan, COLLECTED_PAYLOAD);

  const run = runCli(['--result', result, '--unit', 'execute-task/T02', '--cwd', orphan, '--json']);
  equal(run.status, 0, 'the refusal is advisory — exit 0, never a blocked loop');

  const out = JSON.parse(run.stdout);
  equal(out.outcome, mat.SKIPPED_OUTCOME, 'the refusal carries the skipped outcome, not a fake collected');
  equal(out.reason, 'owner-unresolved', 'and a NAMED reason — silence here is the defect');
  equal(out.written, 0, 'nothing was written');

  check(!fs.existsSync(path.join(orphan, '.gsd')),
    'no .gsd was manufactured in a directory that is not a project');

  // Control: the SAME payload in a real project still writes — proving the
  // guard discriminates and is not just refusing everything.
  const project = tempDir('r1-control');
  const controlResult = writeResult(project, COLLECTED_PAYLOAD);
  const controlRun = runCli(['--result', controlResult, '--unit', 'execute-task/T02', '--cwd', project, '--json']);
  const controlOut = JSON.parse(controlRun.stdout);
  equal(controlOut.outcome, 'collected', 'control: a real project still materialises');
  check(controlOut.written > 0, 'control: lines were actually written');

  equal(mat.OUTCOME_VALUES.includes(mat.SKIPPED_OUTCOME), false,
    'the skipped outcome is NOT in the payload-accepted enum — a payload must never be able to claim it');
}

// ── 13. S01 review R2: the caller's invocation must be resolvable ──────────
//
// Invokes the CLI exactly the way the canonical site and the two milestone
// mirrors do, then resolves the resulting file the way the completer does.
// A file written under the sentinels can never match a real {M###,S##,T##},
// so "it was written" is not the property under test — "it is findable" is.

function testCallerInvocationIsResolvable() {
  const evidencePath = require('./forge-evidence-path');
  const project = tempDir('r2');
  const milestone = 'M-20260813133328-lease-escrita-cross-run';
  const slice = 'S01';
  const unit = 'execute-task/T02';
  fs.mkdirSync(path.join(project, '.gsd', 'milestones', milestone), { recursive: true });
  const result = writeResult(project, COLLECTED_PAYLOAD);

  const run = runCli([
    '--result', result, '--unit', unit,
    '--milestone', milestone, '--slice', slice,
    '--cwd', project, '--json',
  ]);
  equal(run.status, 0, 'CLI exits 0 with both axes passed');
  const out = JSON.parse(run.stdout);
  check(out.written > 0, 'lines were written');
  check(!out.file.includes('_no-milestone_') && !out.file.includes('_no-slice_'),
    `the written file carries the real axes, not the sentinels (got ${out.file})`);

  const resolved = evidencePath.resolveEvidenceFiles(project, { milestone, slice, unit });
  equal(resolved.files.length, 1, 'the completer resolving the REAL unit finds exactly the file the caller wrote');
  equal(resolved.files[0].form, 'composite');

  // Bite: the pre-fix invocation (unit only) writes a file the same resolution
  // can NEVER find. This is the defect R2 names, asserted rather than described.
  const orphanProject = tempDir('r2-prefix');
  fs.mkdirSync(path.join(orphanProject, '.gsd', 'milestones', milestone), { recursive: true });
  const r2 = writeResult(orphanProject, COLLECTED_PAYLOAD);
  runCli(['--result', r2, '--unit', unit, '--cwd', orphanProject, '--json']);
  const unresolvable = evidencePath.resolveEvidenceFiles(orphanProject, { milestone, slice, unit });
  equal(unresolvable.files.length, 0,
    'control: an axis-less invocation lands under the sentinels and is unfindable — exactly why the call sites changed');
}

// ── 14. S01 review R2: the call sites actually pass the axes ───────────────

function testCallSitesPassBothAxes() {
  const sites = [
    ['shared/forge-dispatch.md', true],
    ['skills/forge-auto/SKILL.md', true],
    ['skills/forge-next/SKILL.md', true],
    // A loose task has no milestone/slice: the sentinels are the TRUTH there,
    // and the resolution target carries the same absence. Asserted as an
    // explicit expectation, not left unstated.
    ['skills/forge-task/SKILL.md', false],
  ];
  for (const [rel, expectsAxes] of sites) {
    const text = mirrorSurface(rel);
    check(text.length > 1000, `${rel} was actually read`);
    const idx = text.indexOf('forge-evidence-materialize.js');
    check(idx > -1, `${rel} names the materializer`);
    const invocation = text.slice(idx, idx + 400);
    equal(/--milestone/.test(invocation), expectsAxes,
      `${rel}: --milestone presence must be ${expectsAxes}`);
    equal(/--slice/.test(invocation), expectsAxes,
      `${rel}: --slice presence must be ${expectsAxes}`);
  }
}

// ── Runner ─────────────────────────────────────────────────────────────────

const tests = [
  ['CLI contract', testCliContract],
  ['three outcomes distinct pairwise', testThreeOutcomesDistinct],
  ['exactly one census line, always', testCensusAlwaysExactlyOne],
  ['entry kind is derived, never trusted (R9)', testKindIsDerivedNotTrusted],
  ['both sources coexist, separable', testSourcesCoexist],
  ['512B cap, stepped', testLineCap],
  ['512B cap holds in the last degree (R10)', testLineCapFinalDegree],
  ['entries[].file is data, not instruction', testPathIsDataNotInstruction],
  ['kind coverage confronted with T01', testKindCoverage],
  ['§7 rewritten in 7a + 7b', testDocSevenRewritten],
  ['the three mirrors invoke at step 7', testMirrorsInvokeAtStepSeven],
  ['R1: no owner → no mkdirSync, named skipped outcome', testOwnerGuardRefusesOrphan],
  ['R2: the caller invocation is resolvable by the completer', testCallerInvocationIsResolvable],
  ['R2: the call sites pass both axes (loose task excepted)', testCallSitesPassBothAxes],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    process.stdout.write(`ok — ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`FAIL — ${name}: ${error.message}\n`);
    if (error.stack) process.stdout.write(`${error.stack}\n`);
  }
}
process.stdout.write(`${tests.length - failed}/${tests.length} groups, ${assertions} assertions\n`);
process.exit(failed === 0 ? 0 : 1);
