#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { audit } = require('./forge-svn-audit.js');

const root = path.resolve(__dirname, '..');
const matrix = path.join(root, 'docs', 'svn-capability-matrix.md');

function fixture({ document, reference = 'results.json#claim=focused', verdict = 'verified', raw } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-svn-audit-'));
  fs.mkdirSync(path.join(dir, 'docs', 'svn-parity-evidence'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'forge-capabilities.json'), JSON.stringify({ capabilities: [{ capability_id: 'CAP-001' }] }));
  fs.writeFileSync(path.join(dir, 'docs', 'svn-parity-evidence', 'results.json'), raw === undefined ? JSON.stringify(document) : raw);
  fs.writeFileSync(path.join(dir, 'matrix.md'), [
    '| ID | Surface | Primitive | Applicability | Probe | E2E | Verdict | Action |',
    '|---|---|---|---|---|---|---|---|',
    `| CAP-001 | test | local | applicable | ${reference} | local | ${verdict} | covered |`,
  ].join('\n'));
  return dir;
}

function runFixture(options) {
  const dir = fixture(options);
  try { return audit(dir, path.join(dir, 'matrix.md')); }
  finally { fs.rmSync(dir, { recursive: true }); }
}

function evidence(claims) { return { schema: 'forge-svn-evidence/v1', claims }; }

const good = audit(root, matrix);
assert.strictEqual(good.expected_ids, 52);
assert.strictEqual(good.observed_ids, 52);
for (const key of ['missing', 'duplicates', 'incomplete', 'invalid_applicability', 'invalid_verdict', 'unresolved_evidence', 'semantic_evidence_errors']) assert.deepStrictEqual(good[key], []);
assert.strictEqual(good.additional_families, 7);
assert.strictEqual(good.ok, true);

const copy = path.join(os.tmpdir(), `forge-svn-matrix-${process.pid}.md`);
try {
  const text = fs.readFileSync(matrix, 'utf8');
  const first = text.match(/^\| skill-forge-accounts \|.*$/m)[0];
  fs.writeFileSync(copy, text + '\n' + first + '\n');
  assert.ok(audit(root, copy).duplicates.length > 0);
} finally { if (fs.existsSync(copy)) fs.rmSync(copy); }

try {
  const text = fs.readFileSync(matrix, 'utf8');
  fs.writeFileSync(copy, text.replace('| applicable |', '| sometimes |').replace(/forge-vcs\.test\.js/, 'missing-probe.test.js').replace('| verified |', '| green-ish |'));
  const broken = audit(root, copy);
  assert.ok(broken.invalid_applicability.length > 0);
  assert.ok(broken.invalid_verdict.length > 0);
  assert.ok(broken.unresolved_evidence.some((item) => item.reference === 'missing-probe.test.js'));
} finally { if (fs.existsSync(copy)) fs.rmSync(copy); }

assert.strictEqual(runFixture({ document: evidence({ focused: { result: 'passed' }, global: { result: 'non-green' } }) }).ok, true);

for (const [name, options, reason] of [
  ['failed claim', { document: evidence({ focused: { result: 'failed' } }) }, 'result-failed'],
  ['non-green claim', { document: evidence({ focused: { result: 'non-green' } }) }, 'result-non-green'],
  ['missing claim', { document: evidence({ other: { result: 'passed' } }) }, 'missing-claim'],
  ['missing selector', { document: evidence({ focused: { result: 'passed' } }), reference: 'results.json' }, 'missing-claim-selector'],
  ['ambiguous selector', { document: evidence({ focused: { result: 'passed' }, global: { result: 'non-green' } }), reference: 'results.json' }, 'ambiguous-claim'],
  ['unknown schema', { document: { schema: 'unknown/v9', claims: { focused: { result: 'passed' } } } }, 'invalid-schema'],
  ['invalid JSON', { raw: '{' }, 'invalid-json'],
  ['invalid result', { document: evidence({ focused: { result: 'mostly-green' } }) }, 'invalid-result'],
]) {
  const result = runFixture(options);
  assert.strictEqual(result.ok, false, `${name} must fail closed`);
  assert.ok(result.semantic_evidence_errors.some((item) => item.reason === reason), `${name} diagnostic`);
}

const limitation = runFixture({ document: evidence({ global: { result: 'non-green' } }), reference: 'results.json#claim=global', verdict: 'declared-limitation' });
assert.strictEqual(limitation.ok, true, 'declared limitations may cite an explicit non-green claim without becoming verified');

process.stdout.write('13 passed\n');
