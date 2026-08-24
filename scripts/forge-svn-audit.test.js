#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { audit } = require('./forge-svn-audit.js');

const root = path.resolve(__dirname, '..');
const matrix = path.join(root, 'docs', 'svn-capability-matrix.md');
const good = audit(root, matrix);
assert.strictEqual(good.expected_ids, 52);
assert.strictEqual(good.observed_ids, 52);
assert.deepStrictEqual(good.missing, []);
assert.deepStrictEqual(good.duplicates, []);
assert.deepStrictEqual(good.incomplete, []);
assert.deepStrictEqual(good.invalid_applicability, []);
assert.deepStrictEqual(good.invalid_verdict, []);
assert.deepStrictEqual(good.unresolved_evidence, []);
assert.strictEqual(good.additional_families, 7);

const copy = path.join(os.tmpdir(), `forge-svn-matrix-${process.pid}.md`);
try {
  const text = fs.readFileSync(matrix, 'utf8');
  const first = text.match(/^\| skill-forge-accounts \|.*$/m)[0];
  fs.writeFileSync(copy, text + '\n' + first + '\n');
  const broken = audit(root, copy);
  assert(broken.missing.length > 0 || broken.duplicates.length > 0);
} finally { if (fs.existsSync(copy)) fs.rmSync(copy); }

try {
  const text = fs.readFileSync(matrix, 'utf8');
  fs.writeFileSync(copy, text.replace('| applicable |', '| sometimes |').replace(/forge-vcs\.test\.js/, 'missing-probe.test.js').replace('| verified |', '| green-ish |'));
  const broken = audit(root, copy);
  assert.ok(broken.invalid_applicability.length > 0);
  assert.ok(broken.invalid_verdict.length > 0);
  assert.ok(broken.unresolved_evidence.some((item) => item.reference === 'missing-probe.test.js'));
} finally { if (fs.existsSync(copy)) fs.rmSync(copy); }
process.stdout.write('3 passed\n');
