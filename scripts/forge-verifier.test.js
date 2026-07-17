#!/usr/bin/env node
// forge-verifier.test.js — standalone test suite for forge-verifier.js (Level 4)
//
// Covers:
//   - Level 4: disabled-test, weak-assertion, no-assertion, circular-assertion
//   - Both pattern sets: jest/vitest AND standalone node (assert + exit code) — MEM003
//   - Negative: non-test artifact path → isTestFile false → no test-quality audit
//   - Regression 3-level: non-test JS artifact row has exists/substantive/wired but no test_quality
//   - Exports: auditTestQuality, TEST_QUALITY_REGEXES, isTestFile accessible on module.exports
//
// Run: node scripts/forge-verifier.test.js   (exit 0 = all pass)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  verifyArtifact,
  auditTestQuality,
  TEST_QUALITY_REGEXES,
  isTestFile,
  _private,
} = require('./forge-verifier.js');

const { detectPatternSets } = _private;

// ── Test runner boilerplate (mirrors forge-must-haves.test.js) ────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'mismatch'}\n     expected: ${e}\n     actual:   ${a}`);
}

// Temp dir for fixture files
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-verifier-test-'));

// Helper: write a temp file and return its absolute path
function writeTmp(filename, content) {
  const p = path.join(ROOT, filename);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

// Helper: fake artifact descriptor with a given path
function fakeArtifact(relPath, opts) {
  return Object.assign({ path: relPath, provides: 'test', min_lines: 1 }, opts || {});
}

// Minimal must_haves block for verifyArtifact regression tests
function mkMustHaves(artifacts) {
  return { artifacts, key_links: [] };
}

// ──────────────────────────────────────────────────────────────────────────────
console.log('\n=== forge-verifier.js Level 4 — Test-quality ===\n');

// ── Section 1: isTestFile ─────────────────────────────────────────────────────
console.log('Section 1: isTestFile\n');

test('isTestFile: *.test.js → true', () => {
  assert(isTestFile('scripts/forge-verifier.test.js'), 'should match .test.js');
});

test('isTestFile: *.spec.ts → true', () => {
  assert(isTestFile('src/auth.spec.ts'), 'should match .spec.ts');
});

test('isTestFile: *.test.mjs → true', () => {
  assert(isTestFile('scripts/helper.test.mjs'), 'should match .test.mjs');
});

test('isTestFile: __tests__/foo.js → true', () => {
  assert(isTestFile('src/__tests__/foo.js'), 'should match __tests__/');
});

test('isTestFile: src/foo.js → false', () => {
  assert(!isTestFile('src/foo.js'), 'should NOT match plain .js');
});

test('isTestFile: scripts/forge-verifier.js → false', () => {
  assert(!isTestFile('scripts/forge-verifier.js'), 'should NOT match plain .js');
});

test('isTestFile: forge-agent-prefs.md → false', () => {
  assert(!isTestFile('forge-agent-prefs.md'), 'should NOT match .md');
});

// ── Section 2: TEST_QUALITY_REGEXES structure ─────────────────────────────────
console.log('\nSection 2: TEST_QUALITY_REGEXES structure\n');

test('TEST_QUALITY_REGEXES is a non-empty array', () => {
  assert(Array.isArray(TEST_QUALITY_REGEXES), 'should be array');
  assert(TEST_QUALITY_REGEXES.length > 0, 'should be non-empty');
});

test('Each regex entry has name, regex, description, pattern_set', () => {
  for (const entry of TEST_QUALITY_REGEXES) {
    assert(typeof entry.name === 'string', `entry.name should be string: ${JSON.stringify(entry)}`);
    assert(entry.regex instanceof RegExp, `entry.regex should be RegExp: ${entry.name}`);
    assert(typeof entry.description === 'string', `entry.description should be string: ${entry.name}`);
    assert(['jest', 'node', 'both'].includes(entry.pattern_set),
      `entry.pattern_set should be jest/node/both: ${entry.name}`);
  }
});

test('disabled-test entries come before weak/circular in the registry', () => {
  const firstDisabled = TEST_QUALITY_REGEXES.findIndex(r => r.name.startsWith('disabled_test'));
  const firstWeak = TEST_QUALITY_REGEXES.findIndex(r => r.name.startsWith('weak_'));
  const firstCircular = TEST_QUALITY_REGEXES.findIndex(r => r.name.startsWith('circular_'));
  assert(firstDisabled >= 0, 'should have disabled_test entry');
  assert(firstWeak >= 0, 'should have weak_ entry');
  assert(firstCircular >= 0, 'should have circular_ entry');
  assert(firstDisabled < firstWeak, 'disabled_test should precede weak_ in registry');
  assert(firstWeak < firstCircular, 'weak_ should precede circular_ in registry');
});

// ── Section 3: auditTestQuality — jest/vitest pattern set ─────────────────────
console.log('\nSection 3: auditTestQuality — jest/vitest pattern set\n');

test('jest: it.skip detected as disabled-test', () => {
  const content = `
const { something } = require('./foo');
describe('Suite', () => {
  it.skip('skipped test', () => {
    expect(something()).toBe(true);
  });
  it('normal test', () => {
    expect(something()).toBe(42);
  });
});
`;
  const artifact = fakeArtifact('src/__tests__/foo.test.js');
  const result = auditTestQuality(content, artifact);
  assert(!result.pass, 'should fail — has disabled test');
  const flag = result.flags.find(f => f.reason === 'disabled-test');
  assert(flag, `expected disabled-test flag, got: ${JSON.stringify(result.flags)}`);
  assert(flag.level === 'test-quality', 'flag.level should be test-quality');
});

test('jest: test.skip detected as disabled-test', () => {
  const content = `
test.skip('should work', () => {
  expect(1).toBe(1);
});
test('real test', () => {
  const x = 42;
  expect(x).toBe(42);
});
`;
  const artifact = fakeArtifact('scripts/thing.test.js');
  const result = auditTestQuality(content, artifact);
  const flag = result.flags.find(f => f.reason === 'disabled-test');
  assert(flag, `expected disabled-test flag`);
});

test('jest: xit detected as disabled-test', () => {
  const content = `
xit('old skipped test', () => {
  const x = result();
  expect(x).toBe(true);
});
it('real test', () => {
  const x = 42;
  expect(x).toBe(42);
});
`;
  const artifact = fakeArtifact('src/foo.test.js');
  const result = auditTestQuality(content, artifact);
  const flag = result.flags.find(f => f.reason === 'disabled-test');
  assert(flag, 'expected disabled-test flag for xit');
});

test('jest: describe.skip detected as disabled-test', () => {
  const content = `
describe.skip('skipped suite', () => {
  it('test inside', () => {
    const x = 42;
    expect(x).toBe(42);
  });
});
describe('real suite', () => {
  it('another test', () => {
    const y = 99;
    expect(y).toBe(99);
  });
});
`;
  const artifact = fakeArtifact('src/foo.test.js');
  const result = auditTestQuality(content, artifact);
  const flag = result.flags.find(f => f.reason === 'disabled-test');
  assert(flag, 'expected disabled-test flag for describe.skip');
});

test('jest: expect(true).toBe(true) detected as weak-assertion', () => {
  const content = `
describe('Suite', () => {
  it('weak test', () => {
    expect(true).toBe(true);
  });
  it('normal test', () => {
    const x = computeValue();
    expect(x).toBe(42);
  });
});
`;
  const artifact = fakeArtifact('src/foo.test.js');
  const result = auditTestQuality(content, artifact);
  assert(!result.pass, 'should fail — has weak assertion');
  const flag = result.flags.find(f => f.reason === 'weak-assertion');
  assert(flag, `expected weak-assertion flag, got: ${JSON.stringify(result.flags)}`);
});

test('jest: expect(result).toBe(result) detected as circular-assertion', () => {
  const content = `
it('circular test', () => {
  const result = computeValue();
  expect(result).toBe(result);
});
`;
  const artifact = fakeArtifact('src/foo.test.js');
  const result = auditTestQuality(content, artifact);
  assert(!result.pass, 'should fail — has circular assertion');
  const flag = result.flags.find(f => f.reason === 'circular-assertion');
  assert(flag, `expected circular-assertion flag, got: ${JSON.stringify(result.flags)}`);
});

test('jest: expect(x).toEqual(x) detected as circular-assertion', () => {
  const content = `
it('circular toEqual', () => {
  const x = getObj();
  expect(x).toEqual(x);
});
`;
  const artifact = fakeArtifact('src/foo.test.js');
  const result = auditTestQuality(content, artifact);
  const flag = result.flags.find(f => f.reason === 'circular-assertion');
  assert(flag, 'expected circular-assertion flag for toEqual');
});

test('jest: clean test file returns pass:true', () => {
  const content = `
describe('Suite', () => {
  it('should compute correctly', () => {
    const actual = computeValue(1, 2);
    expect(actual).toBe(3);
  });
  it('should handle edge case', () => {
    const result = computeValue(0, 0);
    expect(result).toBe(0);
  });
});
`;
  const artifact = fakeArtifact('src/foo.test.js');
  const result = auditTestQuality(content, artifact);
  assertEq(result.pass, true, 'clean jest file should pass');
  assertEq(result.flags, [], 'clean jest file should have no flags');
});

// ── Section 4: auditTestQuality — standalone node pattern set ─────────────────
console.log('\nSection 4: auditTestQuality — standalone node pattern set\n');

test('node: assert(true) detected as weak-assertion', () => {
  const content = `
'use strict';
const assert = require('assert');
let passed = 0;
let failed = 0;
// Weak assertion
assert(true);
passed++;
process.exit(failed ? 1 : 0);
`;
  const artifact = fakeArtifact('scripts/mymodule.test.js');
  const result = auditTestQuality(content, artifact);
  assert(!result.pass, 'should fail — has weak assertion');
  const flag = result.flags.find(f => f.reason === 'weak-assertion');
  assert(flag, `expected weak-assertion flag, got: ${JSON.stringify(result.flags)}`);
  assert(flag.level === 'test-quality', 'flag.level should be test-quality');
});

test('node: assert.ok(true) detected as weak-assertion', () => {
  const content = `
const assert = require('assert');
// Trivially true assertion
assert.ok(true);
process.exit(0);
`;
  const artifact = fakeArtifact('scripts/foo.test.js');
  const result = auditTestQuality(content, artifact);
  const flag = result.flags.find(f => f.reason === 'weak-assertion');
  assert(flag, 'expected weak-assertion flag for assert.ok(true)');
});

test('node: assert.strictEqual(x, x) detected as circular-assertion', () => {
  const content = `
const assert = require('assert');
const value = computeValue();
assert.strictEqual(value, value);
process.exit(0);
`;
  const artifact = fakeArtifact('scripts/foo.test.js');
  const result = auditTestQuality(content, artifact);
  const flag = result.flags.find(f => f.reason === 'circular-assertion');
  assert(flag, 'expected circular-assertion flag for assert.strictEqual(x, x)');
});

test('node: assert(x, x) detected as circular-assertion', () => {
  const content = `
const assert = require('assert');
const x = getValue();
assert(x, x);
process.exit(0);
`;
  const artifact = fakeArtifact('scripts/foo.test.js');
  const result = auditTestQuality(content, artifact);
  const flag = result.flags.find(f => f.reason === 'circular-assertion');
  assert(flag, 'expected circular-assertion flag for assert(x, x)');
});

test('node: assert(x === x) detected as circular-assertion', () => {
  const content = `
const assert = require('assert');
const y = getValue();
assert(y === y);
process.exit(0);
`;
  const artifact = fakeArtifact('scripts/foo.test.js');
  const result = auditTestQuality(content, artifact);
  const flag = result.flags.find(f => f.reason === 'circular-assertion');
  assert(flag, 'expected circular-assertion flag for assert(y === y)');
});

test('node: clean standalone test returns pass:true', () => {
  const content = `
'use strict';
const assert = require('assert');
let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); passed++; } catch(e) { failed++; }
}

test('should add correctly', () => {
  const result = add(2, 3);
  assert.strictEqual(result, 5);
});

test('should handle zero', () => {
  const result = add(0, 0);
  assert.strictEqual(result, 0);
});

process.exit(failed ? 1 : 0);
`;
  const artifact = fakeArtifact('scripts/add.test.js');
  const result = auditTestQuality(content, artifact);
  assertEq(result.pass, true, 'clean standalone node test should pass');
  assertEq(result.flags, [], 'clean node test should have no flags');
});

// ── Section 5: no-assertion detection ────────────────────────────────────────
console.log('\nSection 5: no-assertion detection\n');

test('no-assertion: file with no assert/expect → no-assertion flag', () => {
  const content = `
// This file has no assertions at all
function helper() {
  return 42;
}
module.exports = { helper };
`;
  const artifact = fakeArtifact('src/helper.test.js');
  const result = auditTestQuality(content, artifact);
  assert(!result.pass, 'should fail — no assertions');
  const flag = result.flags.find(f => f.reason === 'no-assertion');
  assert(flag, `expected no-assertion flag, got: ${JSON.stringify(result.flags)}`);
  assertEq(flag.level, 'test-quality', 'flag.level should be test-quality');
});

test('no-assertion: node-style file with no assert at all → no-assertion', () => {
  const content = `
const assert = require('assert');
let passed = 0;
let failed = 0;
// Forgot to write actual assertions
process.exit(failed ? 1 : 0);
`;
  const artifact = fakeArtifact('scripts/empty.test.js');
  const result = auditTestQuality(content, artifact);
  // Note: content has 'assert' as identifier but no assert() calls — hasAnyAssertion uses \bassert[\.(]
  // require('assert') doesn't trigger the assertion check
  const flag = result.flags.find(f => f.reason === 'no-assertion');
  assert(flag, 'expected no-assertion flag for file with only require but no assert calls');
});

// ── Section 6: Negatives — non-test artifacts NOT audited ─────────────────────
console.log('\nSection 6: Non-test artifacts not audited\n');

test('non-test path: isTestFile returns false for src/foo.js', () => {
  assert(!isTestFile('src/foo.js'), 'src/foo.js should not be a test file');
});

test('non-test path: auditTestQuality still works but isTestFile gates it in verifyArtifact', () => {
  // auditTestQuality itself doesn't know about paths — the gating is in verifyArtifact.
  // This test verifies that a non-test path would NOT be audited via isTestFile check.
  const nonTestPath = 'src/foo.js';
  assert(!isTestFile(nonTestPath), 'src/foo.js should not be a test file');
});

test('verifyArtifact: non-test JS artifact row has no test_quality field', () => {
  // Write a real JS file to disk (non-test) with actual content
  const content = `
'use strict';
function add(a, b) { return a + b; }
module.exports = { add };
`.repeat(5);  // ensure min_lines

  const filename = 'src-add.js';
  writeTmp(filename, content);

  const mustHaves = mkMustHaves([
    { path: filename, provides: 'add function', min_lines: 5, stub_patterns: [] }
  ]);

  const result = verifyArtifact(mustHaves, [], { cwd: ROOT });
  assert(result.rows.length === 1, 'expected 1 row');
  const row = result.rows[0];
  assert(row.exists === true, 'file should exist');
  assert(row.substantive === true, 'file should be substantive');
  // test_quality field must NOT be present on non-test artifact
  assert(!('test_quality' in row), `non-test row should NOT have test_quality field, got: ${JSON.stringify(row)}`);
});

// ── Section 7: verifyArtifact integration — test file gets test_quality field ──
console.log('\nSection 7: verifyArtifact integration for test files\n');

test('verifyArtifact: test file with it.skip gets test_quality:false and disabled-test flag', () => {
  const testContent = `
'use strict';
describe('Suite', () => {
  it.skip('skipped test', () => {
    const x = 42;
    expect(x).toBe(42);
  });
  it('normal test', () => {
    const value = computeValue();
    expect(value).toBe(99);
  });
});
`.repeat(12);  // enough lines for min_lines

  const testFilename = 'suite.test.js';
  writeTmp(testFilename, testContent);

  const mustHaves = mkMustHaves([
    { path: testFilename, provides: 'test suite', min_lines: 10, stub_patterns: [] }
  ]);

  const result = verifyArtifact(mustHaves, [], { cwd: ROOT });
  assert(result.rows.length === 1, 'expected 1 row');
  const row = result.rows[0];
  assert(row.exists === true, 'file should exist');
  assert(row.substantive === true, 'file should be substantive');
  assert('test_quality' in row, 'test file row should have test_quality field');
  assert(row.test_quality === false, `test_quality should be false, got: ${row.test_quality}`);
  const flag = row.flags.find(f => f.reason === 'disabled-test');
  assert(flag, `expected disabled-test flag in row.flags, got: ${JSON.stringify(row.flags)}`);
});

test('verifyArtifact: clean test file gets test_quality:true', () => {
  const cleanTestContent = `
'use strict';
describe('CleanSuite', () => {
  it('should compute correctly', () => {
    const actual = computeValue(1, 2);
    expect(actual).toBe(3);
  });
  it('should handle zero', () => {
    const result = computeValue(0, 0);
    expect(result).toBe(0);
  });
  it('should handle negatives', () => {
    const result = computeValue(-1, 1);
    expect(result).toBe(0);
  });
  it('should handle large numbers', () => {
    const result = computeValue(100, 200);
    expect(result).toBe(300);
  });
});
`;
  const cleanFilename = 'clean.test.js';
  writeTmp(cleanFilename, cleanTestContent);

  const mustHaves = mkMustHaves([
    { path: cleanFilename, provides: 'clean tests', min_lines: 10, stub_patterns: [] }
  ]);

  const result = verifyArtifact(mustHaves, [], { cwd: ROOT });
  const row = result.rows[0];
  assert(row.exists === true, 'file should exist');
  assert(row.substantive === true, 'file should be substantive');
  assert('test_quality' in row, 'test file row should have test_quality field');
  assert(row.test_quality === true, `test_quality should be true, got: ${row.test_quality}`);
  // No test-quality flags in row.flags
  const tqFlag = row.flags.find(f => f.level === 'test-quality');
  assert(!tqFlag, `clean test file should have no test-quality flags, got: ${JSON.stringify(row.flags)}`);
});

// ── Section 8: Regression — 3-level behavior unchanged ───────────────────────
console.log('\nSection 8: Regression — 3-level behavior unchanged\n');

test('3-level regression: non-test JS artifact has exists/substantive/wired but no test_quality', () => {
  // Already covered by Section 6 test but doing an explicit 3-level shape check
  const jsContent = `
'use strict';
// Utility module
function multiply(a, b) { return a * b; }
function divide(a, b) {
  if (b === 0) throw new Error('division by zero');
  return a / b;
}
module.exports = { multiply, divide };
`.repeat(3);

  const filename = 'util-math.js';
  writeTmp(filename, jsContent);

  const mustHaves = mkMustHaves([
    { path: filename, provides: 'math utils', min_lines: 5, stub_patterns: [] }
  ]);

  const result = verifyArtifact(mustHaves, [], { cwd: ROOT });
  assert(!result.legacy, 'should not be legacy');
  assert(result.rows.length === 1, 'expected 1 row');
  const row = result.rows[0];

  // 3-level fields present
  assert('exists' in row, 'row should have exists field');
  assert('substantive' in row, 'row should have substantive field');
  assert('wired' in row, 'row should have wired field');

  // test_quality field NOT present for non-test
  assert(!('test_quality' in row), `non-test row should NOT have test_quality: ${JSON.stringify(row)}`);
});

test('3-level regression: file_not_found short-circuit unchanged', () => {
  const mustHaves = mkMustHaves([
    { path: 'does-not-exist-at-all.js', provides: 'nothing', min_lines: 1, stub_patterns: [] }
  ]);
  const result = verifyArtifact(mustHaves, [], { cwd: ROOT });
  assert(result.rows.length === 1, 'expected 1 row');
  const row = result.rows[0];
  assert(row.exists === false, 'should be not-found');
  assert(row.substantive === null, 'substantive should be null after short-circuit');
  assert(row.wired === null, 'wired should be null after short-circuit');
  assert(!('test_quality' in row), 'test_quality should not be present after short-circuit');
});

test('3-level regression: below_min_lines short-circuit unchanged', () => {
  const shortContent = 'const x = 1;\n';
  const filename = 'tiny.js';
  writeTmp(filename, shortContent);

  const mustHaves = mkMustHaves([
    { path: filename, provides: 'tiny', min_lines: 100, stub_patterns: [] }
  ]);
  const result = verifyArtifact(mustHaves, [], { cwd: ROOT });
  const row = result.rows[0];
  assert(row.exists === true, 'file should exist');
  assert(row.substantive === false, 'should fail substantive check');
  assert(row.wired === null, 'wired should be null after substantive short-circuit');
  assert(!('test_quality' in row), 'test_quality should not be present after substantive short-circuit');
});

// ── Section 9: detectPatternSets ─────────────────────────────────────────────
console.log('\nSection 9: detectPatternSets (private)\n');

test('detectPatternSets: jest content → [both, jest]', () => {
  const content = `describe('test', () => { it('x', () => { expect(1).toBe(1); }); });`;
  const sets = detectPatternSets(content);
  assert(sets.includes('both'), 'should include both');
  assert(sets.includes('jest'), 'should include jest');
  assert(!sets.includes('node'), 'should NOT include node');
});

test("detectPatternSets: node content → [both, node]", () => {
  const content = `const assert = require('assert'); assert.strictEqual(1, 1); process.exit(0);`;
  const sets = detectPatternSets(content);
  assert(sets.includes('both'), 'should include both');
  assert(sets.includes('node'), 'should include node');
  assert(!sets.includes('jest'), 'should NOT include jest');
});

test('detectPatternSets: mixed content → [both, jest, node]', () => {
  const content = `
const assert = require('assert');
describe('mix', () => {
  it('x', () => { expect(1).toBe(1); });
});
process.exit(0);
`;
  const sets = detectPatternSets(content);
  assert(sets.includes('both'), 'should include both');
  assert(sets.includes('jest'), 'should include jest');
  assert(sets.includes('node'), 'should include node');
});

test('detectPatternSets: empty content → runs all (ambiguous → both+jest+node)', () => {
  const sets = detectPatternSets('');
  assert(sets.includes('both'), 'should include both');
  // Ambiguous: all sets
  assert(sets.includes('jest') || sets.includes('node'), 'should include at least one set');
});

// ── Section 10: auditTestQuality error handling ───────────────────────────────
console.log('\nSection 10: auditTestQuality error handling\n');

test('auditTestQuality: null artifact → does not throw, returns result', () => {
  const content = `it('test', () => { expect(42).toBe(42); });`;
  // null artifact should not throw
  let result;
  try {
    result = auditTestQuality(content, null);
  } catch (e) {
    assert(false, `should not throw: ${e.message}`);
  }
  assert(result !== undefined, 'should return a result');
  assert(typeof result.pass === 'boolean', 'result.pass should be boolean');
  assert(Array.isArray(result.flags), 'result.flags should be array');
});

test('auditTestQuality: empty string content → no-assertion flag', () => {
  const result = auditTestQuality('', fakeArtifact('test.test.js'));
  assert(!result.pass, 'empty file should fail (no assertions)');
  const flag = result.flags.find(f => f.reason === 'no-assertion');
  assert(flag, 'expected no-assertion flag for empty content');
});

// ── Section 11: exports sanity ────────────────────────────────────────────────
console.log('\nSection 11: Module exports sanity\n');

test('auditTestQuality exported on module.exports', () => {
  const mod = require('./forge-verifier.js');
  assert(typeof mod.auditTestQuality === 'function', 'auditTestQuality should be exported');
});

test('TEST_QUALITY_REGEXES exported on module.exports', () => {
  const mod = require('./forge-verifier.js');
  assert(Array.isArray(mod.TEST_QUALITY_REGEXES), 'TEST_QUALITY_REGEXES should be exported');
});

test('isTestFile exported on module.exports', () => {
  const mod = require('./forge-verifier.js');
  assert(typeof mod.isTestFile === 'function', 'isTestFile should be exported');
});

test('_private.detectPatternSets accessible', () => {
  const mod = require('./forge-verifier.js');
  assert(mod._private && typeof mod._private.detectPatternSets === 'function',
    'detectPatternSets should be in _private');
});

test('existing exports still present (regression)', () => {
  const mod = require('./forge-verifier.js');
  assert(typeof mod.verifyArtifact === 'function', 'verifyArtifact should still be exported');
  assert(Array.isArray(mod.DEFAULT_STUB_REGEXES), 'DEFAULT_STUB_REGEXES should still be exported');
  assert(Array.isArray(mod.IMPORT_PATTERNS), 'IMPORT_PATTERNS should still be exported');
  assert(Array.isArray(mod.SUPPORTED_EXTENSIONS), 'SUPPORTED_EXTENSIONS should still be exported');
  assert(mod._private && typeof mod._private.checkExists === 'function', 'checkExists in _private');
  assert(mod._private && typeof mod._private.checkSubstantive === 'function', 'checkSubstantive in _private');
});

// ── Section 12: custom stub_patterns literal escape (Bug 1 fix) ────────────────
console.log('\nSection 12: custom stub_patterns literal escape\n');

test('checkSubstantive: literal-paren stub pattern does not throw (repro)', () => {
  const { checkSubstantive } = _private;
  const artifact = fakeArtifact('x.js', {
    min_lines: 1,
    stub_patterns: ['throw new Error("unimplemented'],
  });
  const result = checkSubstantive('some ok line', 1, artifact);
  assert(result && typeof result.pass === 'boolean', 'should return a verdict, not throw');
});

test('checkSubstantive: content containing the literal pattern is flagged', () => {
  const { checkSubstantive } = _private;
  const artifact = fakeArtifact('x.js', {
    min_lines: 1,
    stub_patterns: ['throw new Error("unimplemented'],
  });
  const content = 'function f() {\n  throw new Error("unimplemented\n}';
  const result = checkSubstantive(content, 3, artifact);
  assert(result.pass === false, 'should fail: literal pattern present');
  assert(result.flags.some(f => f.regex_name === 'custom_stub_0'),
    'flag should reference custom_stub_0');
});

test('checkSubstantive: content without the literal pattern passes', () => {
  const { checkSubstantive } = _private;
  const artifact = fakeArtifact('x.js', {
    min_lines: 1,
    stub_patterns: ['throw new Error("unimplemented'],
  });
  const result = checkSubstantive('function f() { return 42; }', 1, artifact);
  assert(result.pass === true, 'should pass: literal pattern absent');
});

test('checkSubstantive: literal semantics — regex metachars matched literally, not as regex', () => {
  const { checkSubstantive } = _private;
  const artifact = fakeArtifact('x.js', {
    min_lines: 1,
    stub_patterns: ['return null; // (x)'],
  });
  // Exact literal present → flagged
  const hit = checkSubstantive('return null; // (x)', 1, artifact);
  assert(hit.pass === false, 'exact literal text should match');
  // Text that would match if '(x)' were interpreted as a regex group but isn't the literal → passes
  const miss = checkSubstantive('return null; // (y)', 1, artifact);
  assert(miss.pass === true, 'non-literal text should not match');
});

test('checkSubstantive: DEFAULT_STUB_REGEXES untouched (still regex, not escaped)', () => {
  const { checkSubstantive } = _private;
  const artifact = fakeArtifact('x.js', { min_lines: 1 }); // no stub_patterns → defaults only
  const content = 'return null;';
  const result = checkSubstantive(content, 1, artifact);
  assert(result.pass === false, 'default stub regex (return_null_function) should still catch bare return null;');
  assert(result.flags.some(f => f.regex_name === 'return_null_function'),
    'flag should reference the default regex name, unchanged');
});

// A non-string entry reaching the library API directly whose stringification
// itself throws — the realistic trigger for an uncompilable extra after escaping
// (escapeRegExp neutralizes all regex metachars, so any successfully-stringified
// value always compiles; only a throwing toString can still fail loud).
function unstringifiable() {
  return { toString() { throw new Error('cannot stringify'); } };
}

test('checkSubstantive: uncompilable extra fails loud with invalid_stub_pattern flag, never throws', () => {
  const { checkSubstantive } = _private;
  const artifact = fakeArtifact('x.js', {
    min_lines: 1,
    stub_patterns: [unstringifiable()],
  });
  let result;
  result = checkSubstantive('some ok line here', 1, artifact);
  assert(result && typeof result.pass === 'boolean', 'should return a verdict, not throw');
  assert(result.pass === true, 'no default/valid stub match → pass true with flags');
  assert(Array.isArray(result.flags) && result.flags.length > 0,
    'should carry invalid_stub_pattern flags');
  assert(result.flags.every(f => f.reason === 'invalid_stub_pattern'),
    'all flags should be invalid_stub_pattern reason');
});

test('checkSubstantive: scanning proceeds with defaults + remaining valid extras after an invalid one', () => {
  const { checkSubstantive } = _private;
  const artifact = fakeArtifact('x.js', {
    min_lines: 1,
    stub_patterns: [unstringifiable(), 'MY_CUSTOM_STUB_MARKER'],
  });
  const content = 'this line has MY_CUSTOM_STUB_MARKER in it';
  const result = checkSubstantive(content, 1, artifact);
  assert(result.pass === false, 'valid extra should still match despite invalid sibling');
  assert(result.flags.some(f => f.reason === 'invalid_stub_pattern'),
    'invalid_stub_pattern flag present');
  assert(result.flags.some(f => f.regex_name === 'custom_stub_1'),
    'valid extra (index 1) should still be applied and flagged');
});

// ── Section 13: error_count wiring for invalid_stub_pattern (Bug 1 fix) ────────
console.log('\nSection 13: error_count wiring for invalid_stub_pattern\n');

test('verifyArtifact: invalid_stub_pattern flag surfaces on row even when substantive passes', () => {
  writeTmp('s13/ok.js', 'function f() { return 42; }\n'.repeat(5));
  const artifact = fakeArtifact('s13/ok.js', { min_lines: 1, stub_patterns: [unstringifiable()] });
  const mustHaves = mkMustHaves([artifact]);
  const result = verifyArtifact(mustHaves, [], { cwd: ROOT });
  const row = result.rows[0];
  assert(row.substantive === true, 'substantive should pass (no default/valid stub matched)');
  assert(Array.isArray(row.flags), 'row should carry flags array');
  assert(row.flags.some(f => f.reason === 'invalid_stub_pattern'),
    'row flags should include invalid_stub_pattern');
});

// ── Cleanup and summary ───────────────────────────────────────────────────────
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}

console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  ✗ ${f.name}`);
    console.log(`      ${f.error}`);
  }
  process.exit(1);
}
process.exit(0);
