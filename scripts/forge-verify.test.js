#!/usr/bin/env node
// forge-verify.test.js — standalone test suite for forge-verify.js
//
// Focus: parsePlanVerify() — the plan-frontmatter `verify:` extractor.
//
// Regression (the bug this suite was born from): a multi-line YAML list
//   verify:
//     - npm test
//     - npm run lint
// was mis-parsed by /^verify:\s*(.+)$/m because \s matches \n — the single-line
// regex spanned the newline and captured "- npm test" as a plain string. The
// multi-line branch was never reached, producing a literal "- npm test" command
// and spurious passed:false. Fixed by anchoring the trailing whitespace to
// [ \t]* so the single-line pattern can't cross into the list.
//
// Run: node scripts/forge-verify.test.js   (exit 0 = all pass)

'use strict';

const { parsePlanVerify } = require('./forge-verify.js');

// ── Test runner boilerplate (mirrors forge-verifier.test.js) ──────────────────

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

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'not equal'} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function fm(body) {
  return `---\n${body}\n---\nbody text\n`;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('parsePlanVerify — multi-line YAML list (regression)');

test('multi-line list joins items with " && " (does not capture "- item")', () => {
  const content = fm('id: T01\nverify:\n  - npm test\n  - npm run lint');
  assertEqual(parsePlanVerify(content), 'npm test && npm run lint', 'multi-line list');
});

test('multi-line list with a single item', () => {
  const content = fm('verify:\n  - npm test');
  assertEqual(parsePlanVerify(content), 'npm test', 'single-item list');
});

test('multi-line list does not leak the leading dash', () => {
  const content = fm('verify:\n  - npm test');
  assert(!parsePlanVerify(content).includes('- '), 'result must not contain a literal "- "');
});

test('multi-line list with trailing spaces after "verify:"', () => {
  const content = fm('verify:  \n  - npm test\n  - tsc --noEmit');
  assertEqual(parsePlanVerify(content), 'npm test && tsc --noEmit', 'trailing-space verify:');
});

test('verify: list with another key following it', () => {
  const content = fm('verify:\n  - npm test\n  - npm run lint\ntag: docs');
  assertEqual(parsePlanVerify(content), 'npm test && npm run lint', 'list bounded by next key');
});

console.log('parsePlanVerify — plain string');

test('plain string value', () => {
  assertEqual(parsePlanVerify(fm('verify: npm test')), 'npm test', 'plain string');
});

test('quoted string value is unquoted', () => {
  assertEqual(parsePlanVerify(fm('verify: "npm test"')), 'npm test', 'double-quoted');
  assertEqual(parsePlanVerify(fm("verify: 'npm test'")), 'npm test', 'single-quoted');
});

console.log('parsePlanVerify — inline array');

test('inline array joins with " && "', () => {
  assertEqual(parsePlanVerify(fm('verify: [npm test, npm run lint]')), 'npm test && npm run lint', 'inline array');
});

test('inline array strips quotes from items', () => {
  assertEqual(parsePlanVerify(fm('verify: ["npm test", "npm run lint"]')), 'npm test && npm run lint', 'quoted inline array');
});

console.log('parsePlanVerify — absent / edge cases');

test('no frontmatter → null', () => {
  assertEqual(parsePlanVerify('just a body, no frontmatter\n'), null, 'no frontmatter');
});

test('frontmatter without verify: → null', () => {
  assertEqual(parsePlanVerify(fm('id: T01\ntag: docs')), null, 'no verify field');
});

test('block scalar (verify: |) is skipped → null', () => {
  assertEqual(parsePlanVerify(fm('verify: |\n  npm test')), null, 'block scalar skipped');
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
