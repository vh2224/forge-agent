#!/usr/bin/env node
// run-tests-changed.test.js — pure-function coverage for the --changed
// selector in run-tests.js.
//
// Why it exists: --changed is what the verification gate runs in this repo
// (CODING-STANDARDS § Test), so a selection bug here silently narrows the
// gate. Cases are synthetic (no git spawns) against suitesForChangedFiles.
//
// Run: node scripts/run-tests-changed.test.js   (exit 0 = all pass)

'use strict';

const assert = require('assert');
const { suitesForChangedFiles } = require('./run-tests.js');

const SUITES = [
  'forge-installer.test.js',
  'forge-xllm.test.js',
  'forge-xllm-evidence.test.js',
  'forge-xllm-defend.test.js',
  'forge-verify.test.js',
  'run-tests-changed.test.js',
];

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

test('a production file selects its own suite plus satellite suites (stem- prefix)', () => {
  assert.deepStrictEqual(
    suitesForChangedFiles(['scripts/forge-xllm.js'], SUITES),
    ['forge-xllm-defend.test.js', 'forge-xllm-evidence.test.js', 'forge-xllm.test.js'],
  );
});

test('a changed test file selects itself, and only itself', () => {
  assert.deepStrictEqual(
    suitesForChangedFiles(['scripts/forge-verify.test.js'], SUITES),
    ['forge-verify.test.js'],
  );
});

test('changes outside scripts/*.js select nothing (smoke territory, not gate territory)', () => {
  assert.deepStrictEqual(
    suitesForChangedFiles(['skills/forge-auto/SKILL.md', 'agents/forge-executor.md', 'scripts/README.md', 'docs/DECISIONS-LOG.md'], SUITES),
    [],
  );
});

test('a stem never captures a LONGER stem\'s suite (forge-install vs forge-installer)', () => {
  // forge-install.js must not select forge-installer.test.js: the prefix rule
  // requires `stem-` or exact `stem.test.js`, never bare startsWith(stem).
  assert.deepStrictEqual(
    suitesForChangedFiles(['scripts/forge-install.js'], SUITES),
    [],
  );
});

test('windows-style separators normalize before matching', () => {
  assert.deepStrictEqual(
    suitesForChangedFiles(['scripts\\forge-installer.js'], SUITES),
    ['forge-installer.test.js'],
  );
});

test('duplicates collapse and output is sorted', () => {
  assert.deepStrictEqual(
    suitesForChangedFiles(['scripts/forge-xllm.js', 'scripts/forge-xllm.js', 'scripts/forge-xllm-evidence.test.js'], SUITES),
    ['forge-xllm-defend.test.js', 'forge-xllm-evidence.test.js', 'forge-xllm.test.js'],
  );
});

console.log('');
if (failures > 0) { console.log(`${failures} failed`); process.exit(1); }
console.log('all passed');
process.exit(0);
