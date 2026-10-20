#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sha256 } = require('./forge-delivery');
const source = path.resolve(__dirname, '..');
const historical = 'scripts/fixtures/empirical-corpus/historical/';
const snapshot = historical + 's03-context-comparison.test.js.snapshot';
const provenancePath = historical + 's03-context-comparison-provenance.json';
const expected = 'a753b3bd990370a071e400950c8941469b2ef221df48286f97227861cb334690';
const baseline = 'scripts/fixtures/empirical-corpus/baseline/cases.json';
const baselineHash = '12aedd45c5dcc0c00f1278aa9d4cba3b281d51bd0a167695974df733cf4fa2d7';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-procedure-history-'));
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
try {
  // Only public source trees are copied. No .gsd, private corpus or operator home.
  // The copy exercises the real fixture with its unchanged public API and paths.
  fs.cpSync(path.join(source, 'scripts'), path.join(root, 'scripts'), { recursive: true });
  fs.cpSync(path.join(source, 'shared'), path.join(root, 'shared'), { recursive: true });
  const evidence = require(path.join(root, 'scripts/forge-procedure-evidence.js'));
  const bytes = fs.readFileSync(path.join(root, snapshot));
  test('S03 snapshot preserves original byte identity and stays outside test discovery', () => {
    assert.equal(sha256(bytes), expected);
    assert(snapshot.endsWith('.js.snapshot'));
    assert(!snapshot.endsWith('.test.js'));
  });
  test('provenance retains historical revision, source observation and separate migration date', () => {
    const row = JSON.parse(fs.readFileSync(path.join(root, provenancePath), 'utf8'));
    assert.equal(row.original_path, 'scripts/forge-context-comparison.test.js');
    assert.equal(row.snapshot_path, snapshot);
    assert.equal(row.sha256, expected);
    assert.equal(row.source_revision, 'b0c2e5bd72bbc760e1ad3285160ac495fa607dc8');
    assert.equal(row.source_commit_date, '2026-10-20T02:25:35-03:00');
    assert.equal(row.source_observed_at, '2026-10-20T05:48:54.831Z');
    assert(Number.isFinite(Date.parse(row.migration_observed_at)));
    assert.notEqual(row.migration_observed_at, row.source_observed_at);
    assert.equal(row.origin.type, 'public-checkout');
    assert.equal(row.classification, 'historical-control-not-new-or-reserved');
    assert.equal(row.executable, false);
  });
  test('S04 fixture binds both original public controls and retains historical ineligibility', () => {
    const fixture = evidence.createProcedureFixture();
    const report = evidence.buildProcedureEvidence(fixture.before, fixture.after, { synthetic: true });
    assert.deepEqual(report.provenance.public_controls, [
      { path: baseline, sha256: baselineHash, slice: 'S02' },
      { path: snapshot, sha256: expected, slice: 'S03' },
    ]);
    assert.equal(fixture.before.conditions.template_sha256, expected);
    assert.equal(sha256(fs.readFileSync(path.join(root, baseline))), baselineHash);
    assert.equal(report.comparative_ready, false);
    assert.equal(report.comparable, false);
    assert.equal(report.prospective_cases, 0);
    assert.equal(report.functional_gain, null);
  });
  test('current comparator tests can evolve independently without historical repin or execution', () => {
    fs.writeFileSync(path.join(root, 'scripts/forge-context-comparison.test.js'), 'throw Error("live-test-must-not-run");\n');
    assert.doesNotThrow(() => evidence.createProcedureFixture());
    assert.equal(sha256(fs.readFileSync(path.join(root, snapshot))), expected);
  });
  test('tampered snapshot is rejected before any snapshot code can execute', () => {
    const sentinel = path.join(root, 'snapshot-executed');
    fs.writeFileSync(path.join(root, snapshot), `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'bad');\n`);
    assert.throws(() => evidence.createProcedureFixture(), /public-control-source-drift/);
    assert.equal(fs.existsSync(sentinel), false);
    fs.writeFileSync(path.join(root, snapshot), bytes);
  });
  test('S02 tampering remains rejected with intact S03 snapshot', () => {
    const file = path.join(root, baseline), original = fs.readFileSync(file);
    fs.appendFileSync(file, '\n');
    assert.throws(() => evidence.createProcedureFixture(), /public-control-source-drift/);
    fs.writeFileSync(file, original);
  });
  test('missing original snapshot fails closed instead of falling back to live tests', () => {
    fs.unlinkSync(path.join(root, snapshot));
    assert.throws(() => evidence.createProcedureFixture(), { code: 'ENOENT' });
  });
  console.log(`forge-procedure-history: ${passed} passed, 0 failed; public temporary controls only`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
