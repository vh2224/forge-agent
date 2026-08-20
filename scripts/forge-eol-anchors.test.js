#!/usr/bin/env node
'use strict';

/*
 * Paired execution suite for forge-eol-anchors.js.
 *
 * The historical pair is read through git and passed directly to the pure
 * classifier.  No checkout or temporary copy is involved: a temporary copy
 * would make this test measure Git's EOL policy instead of the reader.
 * Runtime fixtures below follow the same rule and are removed on exit.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const anchors = require('./forge-eol-anchors');

const repoRoot = path.resolve(__dirname, '..');
const scanner = path.join(__dirname, 'forge-eol-anchors.js');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-eol-anchors-test-'));
const fixtureFiles = [];
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error: error.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${error.message}`);
  }
}

function sanitizedEnv(extra) {
  const env = { ...process.env, ...extra };
  // This suite may be launched as a child of the differential suite.
  delete env.NODE_OPTIONS;
  for (const key of Object.keys(env)) {
    if (key.startsWith('FORGE_EOL_')) delete env[key];
  }
  return env;
}

function writeFixture(name, content) {
  const filename = path.join(fixtureRoot, name);
  fs.writeFileSync(filename, content, 'utf8');
  fixtureFiles.push(filename);
  return filename;
}

function runGitShow(ref) {
  const result = spawnSync('git', ['show', `${ref}:scripts/forge-repair.js`], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false,
    env: sanitizedEnv(),
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0 || !result.stdout) {
    const detail = result.error ? result.error.message : `status=${result.status}`;
    throw new Error(`git-show-unavailable:${ref} (${detail})`);
  }
  return result.stdout;
}

function runScanner(args) {
  return spawnSync(process.execPath, [scanner, ...args], {
    cwd: repoRoot,
    env: sanitizedEnv(),
    encoding: 'utf8',
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function parseJsonResult(result, label) {
  assert.strictEqual(result.error, undefined, `${label}: ${result.error && result.error.message}`);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label}: invalid JSON (${error.message})\n${result.stdout}\n${result.stderr}`);
  }
}

console.log('\n=== forge-eol-anchors.js — paired anchor suite ===\n');

test('IN-3: the same path has opposite historical verdicts', () => {
  const oldContent = runGitShow('3d00aca');
  const headContent = runGitShow('HEAD');
  // forge-repair.js is the measured pair: the LF anchor was removed there in
  // HEAD. forge-must-haves.js is unsuitable because its anchor survives at
  // HEAD:103; #85 changed tolerance in another path instead.
  const oldResult = anchors.classifyFile({ path: 'scripts/forge-repair.js', content: oldContent });
  const headResult = anchors.classifyFile({ path: 'scripts/forge-repair.js', content: headContent });
  const oldExposed = oldResult.call_sites.filter((site) =>
    site.form === anchors.ANCHOR_FORMS.FRONTMATTER_OPEN_LF && site.exposed === true);
  const headExposed = headResult.call_sites.filter((site) =>
    site.form === anchors.ANCHOR_FORMS.FRONTMATTER_OPEN_LF && site.exposed === true);
  assert(oldExposed.length >= 1,
    '3d00aca must expose at least one frontmatter-open-lf call site');
  assert.strictEqual(headExposed.length, 0,
    'HEAD must expose zero frontmatter-open-lf call sites');
});

test('IN-3: git-show failure is named rather than silently skipped', () => {
  assert.throws(() => runGitShow('revision-that-does-not-exist-for-eol-test'),
    /git-show-unavailable:revision-that-does-not-exist-for-eol-test/);
});

test('IN-4: incrementRepairCount is anchored by symbol and classified as Form B', () => {
  const repairPath = path.join(__dirname, 'forge-repair.js');
  const content = fs.readFileSync(repairPath, 'utf8');
  const declarationIndex = content.indexOf('function incrementRepairCount');
  assert(declarationIndex >= 0, 'incrementRepairCount declaration was not found by symbol');
  const beforeDeclaration = content.slice(0, declarationIndex);
  const declarationLine = beforeDeclaration.split('\n').length;
  assert(declarationLine > 0, 'symbol declaration must have a positive source position');
  const result = anchors.classifyFile({ path: 'scripts/forge-repair.js', content });
  const specimen = result.call_sites.find((site) =>
    site.symbol === 'incrementRepairCount' &&
    site.mutates === true &&
    site.required_form === 'B' &&
    site.exposed === false);
  assert(specimen,
    'incrementRepairCount must contain a mutating, tolerated Form B call site');
  assert(specimen.line >= declarationLine,
    'the Form B specimen must be inside the symbol declaration, not a line anchor');
});

test('anti-silence floor: empty root fails through the real CLI', () => {
  const emptyRoot = path.join(fixtureRoot, 'empty');
  fs.mkdirSync(emptyRoot);
  const result = runScanner(['--check', '--json', '--root', emptyRoot]);
  assert.notStrictEqual(result.status, 0, 'empty root must produce a non-zero CLI exit');
  const json = parseJsonResult(result, 'empty-root');
  assert.strictEqual(json.outcome, 'scan-failed');
  assert.strictEqual(json.reason, 'no-call-sites-scanned');
});

test('reconciliation counts scanned files and named skips', () => {
  const root = path.join(fixtureRoot, 'reconcile');
  fs.mkdirSync(root);
  writeFixture('reconcile.js', "const value = source.includes('a\\nb');\n");
  fs.writeFileSync(path.join(root, 'reconcile.js'), "const value = source.includes('a\\nb');\n", 'utf8');
  fixtureFiles.push(path.join(root, 'reconcile.js'));
  fs.writeFileSync(path.join(root, 'ignored.txt'), 'not scanned\n', 'utf8');
  fixtureFiles.push(path.join(root, 'ignored.txt'));
  const result = anchors.scanEolAnchors([root]);
  assert.strictEqual(result.reconciles, true);
  assert.strictEqual(result.walked, result.scanned + result.skipped.length);
  assert(result.skipped.some((item) => item.reason === anchors.SKIP_REASONS.EXTENSION_NOT_SCANNED),
    'fixture must contain a named extension-not-scanned skip');
});

test('D-S02-2: CR tolerance on the matched construct excludes only that construct', () => {
  const tolerant = anchors.classifyFile({
    path: 'tolerant.js',
    content: "function read() { return /^---\\r?\\n/.test(value); }\n",
  });
  const tolerantSite = tolerant.call_sites.find((site) => site.form === anchors.ANCHOR_FORMS.FRONTMATTER_OPEN_LF);
  assert(tolerantSite, 'tolerant frontmatter construct was not discovered');
  assert.strictEqual(tolerantSite.exposed, false);

  const mixed = anchors.classifyFile({
    path: 'mixed.js',
    content: "function read() { return value.includes('a\\nb'); }\nconst stray = '\\r';\n",
  });
  const mixedSite = mixed.call_sites.find((site) => site.form === anchors.ANCHOR_FORMS.BOUNDARY_LF);
  assert(mixedSite, 'LF-only boundary construct was not discovered');
  assert.strictEqual(mixedSite.exposed, true,
    'a CR on another line must not exempt the LF-only call site');
});

test('D-S02-3: unresolved top-level scope is undetermined, never read-only', () => {
  const result = anchors.classifyFile({
    path: 'top-level.js',
    content: "const value = source.includes('a\\nb');\n",
  });
  const site = result.call_sites.find((entry) => entry.form === anchors.ANCHOR_FORMS.BOUNDARY_LF);
  assert(site, 'top-level boundary construct was not discovered');
  assert.strictEqual(site.mutates, 'undetermined');
  assert.strictEqual(site.scope_reason, anchors.SKIP_REASONS.SCOPE_UNDETERMINED);
  assert.strictEqual(site.required_form, 'B');
  assert.notStrictEqual(site.mutates, false);
});

// ---------------------------------------------------------------------------
// T03 -- recall calibration against the S01 behavioural ground truth.
//
// The fixtures below are synthetic on purpose.  Asserting the live 9/11 figure
// would make this suite fail whenever the tree is legitimately repaired in S03;
// what must not regress is the SHAPE of the measurement: a declared
// granularity, gaps that are present and named, and a zero denominator that
// refuses to report success.
// ---------------------------------------------------------------------------

// One suite whose own file carries an exposed anchor, one whose single anchor
// is CR-tolerant.  Recall over this pair must therefore be exactly 1/2.
const CALIBRATION_RECORDS = [
  { path: path.join(fixtureRoot, 'suite-flagged.test.js'), content: "const helper = require('./helper-flagged.js');\nfunction go() { return helper.read().split('\\n'); }\n" },
  { path: path.join(fixtureRoot, 'helper-flagged.js'), content: "function read() { return String(value).split('\\n'); }\nmodule.exports = { read };\n" },
  { path: path.join(fixtureRoot, 'suite-gap.test.js'), content: "function go() { return /^---\\r?\\n/.test(value); }\n" },
];

const CALIBRATION_GROUND_TRUTH = {
  mode: 'differential',
  suites_executed: 2,
  confirmed: [
    { suite: 'suite-flagged.test.js', asserts_flipped: ['alpha', 'beta'] },
    { suite: 'suite-gap.test.js', asserts_flipped: ['gamma'] },
  ],
  stable: [],
  unproven: [{ suite: 'suite-gap.test.js', reason: 'output-not-parseable' }],
};

function calibrationFixtureScan() {
  return anchors.scanEolAnchors(CALIBRATION_RECORDS, { inMemory: true });
}

function fixtureReadFile(target) {
  const wanted = path.resolve(target);
  const record = CALIBRATION_RECORDS.find((item) => path.resolve(item.path) === wanted);
  if (!record) throw new Error(`no fixture for ${target}`);
  return record.content;
}

test('T03: recall is reported against the ground truth, and reuses the --check predicate', () => {
  const scan = calibrationFixtureScan();
  const calibration = anchors.calibrateRecall(CALIBRATION_GROUND_TRUTH, scan, { readFile: fixtureReadFile });
  assert.strictEqual(calibration.outcome, 'calibrated');
  assert.strictEqual(calibration.recall_total, 2, 'the denominator is the confirmed[] length');
  assert.strictEqual(calibration.recall_flagged, 1, 'only the exposed suite counts as flagged');
  // The flagged suite is flagged through its first-level require, not only its
  // own file: attribution must actually traverse the dependency.
  const flagged = calibration.flagged.find((item) => item.suite === 'suite-flagged.test.js');
  assert(flagged, 'the exposed suite must appear in flagged[]');
  assert.strictEqual(flagged.attribution_files, 2, "require('./helper-flagged.js') must enter the attribution set");
  assert(flagged.exposed_sites >= 2, 'both the suite and its helper contribute exposed sites');
  // No second heuristic exists: every flagged site must be present verbatim in
  // the scan the --check mode publishes.
  for (const item of flagged.evidence) {
    assert(scan.call_sites.some((site) =>
      path.resolve(site.file) === path.resolve(item.file) && site.line === item.line && site.exposed === true),
    'calibration evidence must come from the published scan, never a re-match');
  }
});

test('T03: granularity is declared, and states that attribution is not per assert', () => {
  const calibration = anchors.calibrateRecall(CALIBRATION_GROUND_TRUTH, calibrationFixtureScan(), { readFile: fixtureReadFile });
  assert.strictEqual(typeof calibration.recall_granularity, 'string');
  assert(calibration.recall_granularity.includes('per-suite'),
    'the criterion must name its unit');
  assert(calibration.recall_granularity.includes('never per-assert'),
    'the criterion must state that it is not per assert');
  assert(/assert NAMES/.test(calibration.recall_granularity),
    'the criterion must give the reason: the ground truth carries assert names only');
  assert(/NOT per assert/.test(calibration.attribution_note),
    'the attribution note must be explicit rather than leaving granularity implicit');
});

test('T03: a confirmed suite with no exposed call site is a NAMED gap, never an absence', () => {
  const calibration = anchors.calibrateRecall(CALIBRATION_GROUND_TRUTH, calibrationFixtureScan(), { readFile: fixtureReadFile });
  const gap = calibration.gaps.find((item) => item.suite === 'suite-gap.test.js');
  assert(gap, 'the unflagged confirmed suite must be present in gaps[], not missing from the output');
  assert.strictEqual(gap.reason, anchors.CALIBRATION_REASONS.NO_EXPOSED_CALL_SITE_FLAGGED);
  assert.strictEqual(gap.asserts_flipped, 1, 'the gap must carry how many asserts flip in that suite');
  // Every confirmed suite is accounted for exactly once: a suite may not be
  // silently dropped from both lists.
  assert.strictEqual(calibration.flagged.length + calibration.gaps.length, CALIBRATION_GROUND_TRUTH.confirmed.length);
  // The gap distinguishes "no anchors" from "anchors, all CR-tolerant".
  assert.strictEqual(gap.call_sites_total, 1);
  assert.strictEqual(gap.exposed_sites, 0);
});

test('T03: unproven suites are reported with static exposure, never collapsed into clean', () => {
  const calibration = anchors.calibrateRecall(CALIBRATION_GROUND_TRUTH, calibrationFixtureScan(), { readFile: fixtureReadFile });
  assert.strictEqual(calibration.unproven_coverage.length, CALIBRATION_GROUND_TRUTH.unproven.length);
  const entry = calibration.unproven_coverage[0];
  assert.strictEqual(entry.suite, 'suite-gap.test.js');
  assert.strictEqual(entry.differential_reason, 'output-not-parseable',
    'the differential reason must survive into the coverage report');
  assert.strictEqual(entry.coverage, 'no-static-exposure');
  assert.notStrictEqual(entry.coverage, 'clean');
  assert(/NOT clean/.test(calibration.unproven_note),
    'the output must state that unproven is not clean');
});

test('T03: no form was added to close recall, and the shipped forms carry measured footprints', () => {
  const scan = calibrationFixtureScan();
  const calibration = anchors.calibrateRecall(CALIBRATION_GROUND_TRUTH, scan, { readFile: fixtureReadFile });
  assert.deepStrictEqual(calibration.forms_added, [],
    'closing recall by widening the predicate is forbidden; forms_added must stay empty');
  assert(calibration.forms_measured.length >= 1, 'the shipped forms must be measured, not asserted');
  const total = calibration.forms_measured.reduce((sum, item) => sum + item.sites, 0);
  assert.strictEqual(total, scan.call_sites.length,
    'the measured footprint must reconcile with the census it was taken from');
  for (const item of calibration.forms_measured) {
    assert(Object.values(anchors.ANCHOR_FORMS).includes(item.form),
      `${item.form} is not one of the predicate's declared forms`);
    assert(typeof item.sites === 'number' && typeof item.files === 'number',
      'a form without a measured site count is indistinguishable from a widening');
  }
});

test('T03 anti-silence floor: a zero denominator fails, and never reports 100%', () => {
  const scan = calibrationFixtureScan();
  for (const [label, groundTruth, reason] of [
    ['missing', null, anchors.CALIBRATION_REASONS.GROUND_TRUTH_MISSING],
    ['empty confirmed', { confirmed: [] }, anchors.CALIBRATION_REASONS.GROUND_TRUTH_EMPTY_CONFIRMED],
    ['confirmed absent', { stable: [] }, anchors.CALIBRATION_REASONS.GROUND_TRUTH_EMPTY_CONFIRMED],
  ]) {
    const calibration = anchors.calibrateRecall(groundTruth, scan, { readFile: fixtureReadFile });
    assert.strictEqual(calibration.outcome, 'calibration-failed', `${label}: must fail`);
    assert.strictEqual(calibration.reason, reason, `${label}: the reason must be named`);
    assert.strictEqual(calibration.recall_total, 0, `${label}: the denominator is zero`);
    assert.strictEqual(calibration.recall_flagged, 0,
      `${label}: a zero denominator must never be dressed up as full recall`);
    assert(calibration.recall_granularity,
      `${label}: the criterion is declared even on the failure path`);
  }
});

test('T03 anti-silence floor: the real CLI exits non-zero on missing and unparseable ground truth', () => {
  const missing = runScanner(['--check', '--json', '--calibrate', path.join(fixtureRoot, 'absent-ground-truth.json')]);
  assert.notStrictEqual(missing.status, 0, 'a missing ground truth must exit non-zero');
  const missingJson = parseJsonResult(missing, 'ground-truth-missing');
  assert.strictEqual(missingJson.calibration.outcome, 'calibration-failed');
  assert.strictEqual(missingJson.calibration.reason, anchors.CALIBRATION_REASONS.GROUND_TRUTH_MISSING);
  assert.strictEqual(missingJson.calibration.recall_total, 0);

  const badPath = writeFixture('unparseable-ground-truth.json', '{ this is not json\n');
  const unparseable = runScanner(['--check', '--json', '--calibrate', badPath]);
  assert.notStrictEqual(unparseable.status, 0, 'an unreadable ground truth must exit non-zero');
  const unparseableJson = parseJsonResult(unparseable, 'ground-truth-unparseable');
  assert.strictEqual(unparseableJson.calibration.reason, anchors.CALIBRATION_REASONS.GROUND_TRUTH_UNPARSEABLE);

  const emptyPath = writeFixture('empty-ground-truth.json', '{"confirmed":[]}\n');
  const empty = runScanner(['--check', '--json', '--calibrate', emptyPath]);
  assert.notStrictEqual(empty.status, 0, 'an empty confirmed[] must exit non-zero');
  const emptyJson = parseJsonResult(empty, 'ground-truth-empty-confirmed');
  assert.strictEqual(emptyJson.calibration.reason, anchors.CALIBRATION_REASONS.GROUND_TRUTH_EMPTY_CONFIRMED);
});

test('T03: the CLI ships the census and the calibration as one document', () => {
  const groundTruthPath = writeFixture('one-suite-ground-truth.json',
    `${JSON.stringify({ confirmed: [{ suite: 'forge-repair.js', asserts_flipped: ['only'] }], unproven: [] })}\n`);
  const result = runScanner(['--check', '--json', '--root', 'scripts', '--calibrate', groundTruthPath]);
  assert.strictEqual(result.status, 0, `calibration over the real tree must succeed: ${result.stderr}`);
  const json = parseJsonResult(result, 'census-document');
  assert(Array.isArray(json.call_sites) && json.call_sites.length > 0,
    'the document must carry the census, not only the recall figure');
  assert.strictEqual(json.reconciles, true, 'the census reconciliation must survive into the document');
  assert.strictEqual(json.calibration.recall_total, 1);
  assert.strictEqual(json.calibration.recall_flagged + json.calibration.gaps.length, 1,
    'every confirmed entry lands in exactly one of flagged[] or gaps[]');
});

test('T03: a scanned file with no anchors resolves, and is not reported as never scanned', () => {
  // The distinction the census exists to preserve: absence of a finding is not
  // absence of a measurement.  A suite that WAS read but holds no anchor must
  // be a gap for the honest reason, not "suite-file-not-scanned".
  const records = [{ path: path.join(fixtureRoot, 'quiet.test.js'), content: 'function go() { return 1; }\n' }];
  const scan = anchors.scanEolAnchors(records, { inMemory: true });
  assert(scan.scanned_files.some((file) => path.basename(file) === 'quiet.test.js'),
    'a file read with zero anchors must still appear in the scanned roster');
  const calibration = anchors.calibrateRecall(
    { confirmed: [{ suite: 'quiet.test.js', asserts_flipped: ['x'] }] },
    scan,
    { readFile: () => records[0].content },
  );
  const gap = calibration.gaps[0];
  assert.strictEqual(gap.reason, anchors.CALIBRATION_REASONS.NO_EXPOSED_CALL_SITE_FLAGGED);
  assert.notStrictEqual(gap.reason, anchors.CALIBRATION_REASONS.SUITE_FILE_NOT_SCANNED);

  // And the genuinely absent suite keeps the other reason, so the two are not
  // merged into one comfortable answer.
  const absent = anchors.calibrateRecall(
    { confirmed: [{ suite: 'never-existed.test.js', asserts_flipped: ['x'] }] },
    scan,
    { readFile: () => records[0].content },
  );
  assert.strictEqual(absent.gaps[0].reason, anchors.CALIBRATION_REASONS.SUITE_FILE_NOT_SCANNED);
});

// ---------------------------------------------------------------------------
// Review regressions (S02 conceded items R1/R2/R3).
// ---------------------------------------------------------------------------

test('R1: an ASYMMETRIC regex in a function body does not corrupt symbol/mutates attribution', () => {
  // The fixture must be asymmetric (`/\{/`), never a balanced `{n,m}`
  // quantifier: a balanced quantifier has no net effect on a brace counter, so
  // a regression built on one would pass with and without the fix and would be
  // a green inert guard. Here the lone `{` inside the literal leaves the
  // depth elevated, `braceEnd` runs past alpha's real closing brace, and the
  // scope collapses -- which is how the `mutates`/`symbol` axis leaks.
  const content = [
    'function alpha() {',
    '  const opener = /\\{/;',
    "  return String(opener).split('\\n');",
    '}',
    'function beta() {',
    "  fs.writeFileSync('out', 'data');",
    "  return String(value).split('\\n');",
    '}',
    '',
  ].join('\n');
  const result = anchors.classifyFile({ path: 'asymmetric.js', content });
  const inAlpha = result.call_sites.find((site) => site.line === 3);
  assert(inAlpha, 'the call site inside the regex-carrying function was not discovered');
  assert.strictEqual(inAlpha.symbol, 'alpha',
    'a brace inside a regex literal must not be counted as a block brace');
  assert.strictEqual(inAlpha.mutates, false);
  assert.strictEqual(inAlpha.required_form, 'A');
  assert.notStrictEqual(inAlpha.mutates, 'undetermined');

  const inBeta = result.call_sites.find((site) => site.line === 7);
  assert(inBeta, 'the call site in the following function was not discovered');
  assert.strictEqual(inBeta.symbol, 'beta',
    'the following declaration must own its own body, not inherit a leaked scope');
  assert.strictEqual(inBeta.mutates, true);

  // The same guard at tree scale: this specimen leaked compareFilename's scope
  // over an unrelated top-level test callback before the fix.
  const markerPath = path.join(__dirname, 'forge-app-workspace-marker.test.js');
  const marker = anchors.classifyFile({ path: markerPath, content: fs.readFileSync(markerPath, 'utf8') });
  const leaked = marker.call_sites.find((site) => site.line === 490);
  assert(leaked, 'the in-tree asymmetric-regex specimen was not discovered');
  assert.notStrictEqual(leaked.symbol, 'compareFilename',
    'a top-level test callback must not inherit a function declared 300 lines earlier');
});

test('R1: a nested template literal does not desynchronise the tokenizer', () => {
  // `` `'${String(p).replace(/'/g, `'\\''`)}'` `` -- the inner backtick closes
  // the outer literal unless `${}` is tracked, and every construct after it is
  // then misread. Measured in scripts/forge-appserver-probe.js: two real
  // `.replace(/\n/g, ' ')` call sites were being reported as comment prose.
  const probePath = path.join(__dirname, 'forge-appserver-probe.js');
  const content = fs.readFileSync(probePath, 'utf8');
  const probe = anchors.classifyFile({ path: probePath, content });

  // The specimens are LOCATED, not pinned. This assert used to name lines 954 and
  // 970 by integer, and an edit elsewhere in forge-appserver-probe.js — one that
  // inserted lines ABOVE them and touched nothing they depend on — turned it red.
  // A check that fails for a reason other than the property it guards is a defect
  // in the check: it costs a diagnosis and teaches the reader to distrust it.
  //
  // The property is stated generally instead: every executable occurrence of the
  // call must survive tokenization. That is exactly what the nested-template-literal
  // bug broke (occurrences after it were misread as comment prose), and it cannot be
  // moved by inserting unrelated lines.
  //
  // The comment filter is deliberately crude and lives on the TEST side, never
  // borrowed from the tokenizer under test — asking the subject to classify its own
  // specimens would make the assert circular. Measured 2026-08-19: 20 occurrences,
  // zero of them in comments, so the filter is a no-op today and exists only so a
  // future quoted mention does not turn this red for the wrong reason.
  const NEEDLE = ".replace(/\\n/g, ' ')";
  const expected = content.split('\n')
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => text.includes(NEEDLE))
    .filter(({ text }) => {
      const trimmed = text.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*');
    });

  // Anti-vacuity floor: a needle that stops matching would make this test pass by
  // asserting nothing at all — the failure mode this repo keeps paying for.
  assert(expected.length >= 2,
    `the in-tree specimen must still exist in forge-appserver-probe.js (found ${expected.length})`);

  for (const { line } of expected) {
    assert(probe.call_sites.some((site) => site.line === line),
      `the real call site at forge-appserver-probe.js:${line} must survive tokenization`);
  }
});

test('R2: a regex quoted inside a comment is prose, never a call site', () => {
  const synthetic = anchors.classifyFile({
    path: 'commented.js',
    content: [
      '// Regex: /forge-runs\\.js[^\\n]*--update/ -- quoted for a reader, not executed.',
      '/* also inert: /^---\\n/ */',
      "function go() { return value.split('\\n'); }",
      '',
    ].join('\n'),
  });
  assert.strictEqual(synthetic.call_sites.filter((site) => site.line <= 2).length, 0,
    'a slash pair inside a comment must not enter the census');
  assert.strictEqual(synthetic.call_sites.length, 1, 'only the executed construct is a call site');

  // The named in-tree specimens, both verbatim comment quotations.
  for (const [file, line] of [['forge-must-haves.test.js', 991], ['forge-smoke.js', 1399]]) {
    const target = path.join(__dirname, file);
    const scanned = anchors.classifyFile({ path: target, content: fs.readFileSync(target, 'utf8') });
    assert.strictEqual(scanned.call_sites.filter((site) => site.line === line).length, 0,
      `${file}:${line} is a comment quotation and must not inflate exposed/required_form counts`);
  }
});

test('R3: every emitted outcome is one a code path can produce', () => {
  const found = anchors.scanEolAnchors(
    [{ path: 'x.js', content: "function go() { return v.split('\\n'); }\n" }], { inMemory: true });
  assert.strictEqual(found.outcome, 'found');
  const empty = anchors.scanEolAnchors([], { inMemory: true });
  assert.strictEqual(empty.outcome, 'scan-failed');
  assert.strictEqual(empty.reason, 'no-call-sites-scanned',
    'the anti-silence floor stands: zero call sites is a failure, not clean');
  const quiet = anchors.scanEolAnchors(
    [{ path: 'quiet.js', content: 'function go() { return 1; }\n' }], { inMemory: true });
  assert.strictEqual(quiet.outcome, 'scan-failed');
  for (const result of [found, empty, quiet]) {
    assert(['found', 'scan-failed'].includes(result.outcome), `${result.outcome} is outside the emitted set`);
  }
  // And the dead initialiser is gone from the source: an outcome documented but
  // unreachable misleads a consumer branching on it.
  const source = fs.readFileSync(scanner, 'utf8');
  assert.strictEqual(/outcome\s*=\s*'clean'/.test(source), false,
    "no assignment may produce an outcome the module cannot emit");
});

try {
  for (const filename of fixtureFiles) {
    try { fs.unlinkSync(filename); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  try { fs.rmSync(fixtureRoot, { recursive: true, force: true }); } catch (_) { /* best effort */ }
} catch (error) {
  console.error(`fixture cleanup failed: ${error.message}`);
  failed += 1;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) console.error(JSON.stringify(failures));
process.exitCode = failed === 0 ? 0 : 1;
