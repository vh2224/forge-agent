#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const spec = fs.readFileSync(path.join(__dirname, '..', 'agents', 'forge-completer.md'), 'utf8');
let passed = 0;
function test(name, fn) { fn(); passed++; process.stdout.write(`✓ ${name}\n`); }

test('complete-milestone invokes the durable adapter with milestone and workspace', () => {
  const command = 'forge-write-coverage-ledger.js" --milestone "{M###}" --cwd "{WORKING_DIR}"';
  assert(spec.includes(command), 'canonical invocation missing or flags drifted');
});
test('measurement runs before artifact cleanup and run deactivation', () => {
  const measure = spec.indexOf('forge-write-coverage-ledger.js" --milestone');
  const cleanup = spec.indexOf('6. **Cleanup milestone artifacts**');
  const deactivate = spec.indexOf('7. **Deactivate run in registry**');
  assert(measure >= 0 && cleanup > measure && deactivate > cleanup, 'lifecycle order drifted');
});
test('ledger is named as durable across every cleanup mode', () => {
  assert(spec.includes('`.gsd/forge/write-coverage.jsonl`') && spec.includes('durable across `milestone_cleanup`'), 'durability contract missing');
});
test('inconclusive remains measured and never blocks close-out', () => {
  const start = spec.indexOf('**5a. Measure write coverage');
  const end = spec.indexOf('**5b. Write LEDGER fragment**');
  const block = spec.slice(start, end);
  assert(block.includes('`inconclusive` is a durable measurement outcome'), 'inconclusive contract missing');
  assert(block.includes('not a success') && /not a\s+reason to block/.test(block), 'polarity is ambiguous');
  assert(block.includes('never fabricate a GO row'), 'anti-fabrication floor missing');
});
test('BITE: removing the invocation makes the wiring guard red', () => {
  const mutated = spec.replace(/node "\$FORGE_SCRIPTS_DIR\/forge-write-coverage-ledger\.js"[^\n]+/, 'echo removed');
  assert.notStrictEqual(mutated, spec, 'mutation did not bite');
  assert(!mutated.includes('forge-write-coverage-ledger.js" --milestone "{M###}" --cwd "{WORKING_DIR}"'), 'guard stayed green');
});
process.stdout.write(`\n${passed} passed, 0 failed\n`);
