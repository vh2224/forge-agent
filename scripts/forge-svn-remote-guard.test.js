#!/usr/bin/env node
'use strict';

const assert = require('assert');
const guard = require('./forge-svn-remote-guard.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; process.stdout.write(`  ok  ${name}\n`); }
  catch (error) { process.stderr.write(`  FAIL ${name}: ${error.stack || error}\n`); process.exitCode = 1; }
}
function refused(url) { assert.throws(() => guard.canonicalUrl(url), /remote-url-/); }

test('accepts only the exact decoded corporate leaf', () => assert.strictEqual(guard.canonicalUrl(guard.EXACT_URL), guard.EXACT_URL));
test('refuses parent, WDMA and sibling-prefix targets', () => {
  refused('https://cvs.cma.local/cma_series_2/CMA');
  refused('https://cvs.cma.local/cma_series_2/CMA/WDMA');
  refused(`${guard.EXACT_URL}_OTHER`);
});
test('refuses dot segments and encoded separators/dots', () => {
  refused(`${guard.EXACT_URL}/../WDMA`);
  refused('https://cvs.cma.local/cma_series_2/CMA/%46ORGE_SVN_PARITY_TEST_T20260824120158%2fchild');
  refused('https://cvs.cma.local/cma_series_2/CMA/%2e%2e/WDMA');
});
test('refuses scheme, host, port, userinfo, query and fragment changes', () => {
  refused(guard.EXACT_URL.replace('https:', 'http:'));
  refused(guard.EXACT_URL.replace('cvs.cma.local', 'evil.invalid'));
  refused(guard.EXACT_URL.replace('cvs.cma.local', 'cvs.cma.local:444'));
  refused(guard.EXACT_URL.replace('https://', 'https://user@'));
  refused(`${guard.EXACT_URL}?x=1`);
  refused(`${guard.EXACT_URL}#x`);
});
test('absence requires a specific SVN not-found code', () => {
  assert.deepStrictEqual(guard.classifyMissing({ status: 1, stderr: 'svn: E160013: path not found' }), { absent: true, exists: false, code: 'E160013' });
  assert.throws(() => guard.classifyMissing({ status: 1, stderr: 'svn: E170013: Unable to connect' }), /not-specific/);
  assert.throws(() => guard.classifyMissing({ status: 1, stderr: 'svn: E170000: authorization failed' }), /ambiguous-auth-network/);
});
test('parses complete info XML and refuses truncated XML', () => {
  const parsed = guard.parseInfoXml('<info><entry kind="dir" path="x" revision="42"><url>https://x/leaf</url><repository><root>https://x</root><uuid>u-1</uuid></repository></entry></info>');
  assert.strictEqual(parsed.revision, 42);
  assert.throws(() => guard.parseInfoXml('<info/>'), /incomplete/);
});
test('owner and manifest must bind URL UUID nonce revision HEAD and phase', () => {
  const base = guard.ownershipDocument({ nonce: 'a'.repeat(40), repositoryRoot: 'https://cvs.cma.local/cma_series_2', repositoryUuid: 'uuid-1', createdRevision: 10 });
  const observed = { url: guard.EXACT_URL, repository_root: base.repository_root, repository_uuid: base.repository_uuid, revision: 11 };
  assert.strictEqual(guard.validateOwnership(base, { ...base }, observed, { expectedRevision: 10, expectedHead: 11, externals: '' }), true);
  for (const field of ['nonce', 'repository_uuid', 'created_revision', 'phase']) {
    assert.throws(() => guard.validateOwnership(base, { ...base, [field]: 'wrong' }, observed, { expectedRevision: 10, expectedHead: 11 }), /mismatch/);
  }
  assert.throws(() => guard.validateOwnership(base, { ...base }, { ...observed, revision: 12 }, { expectedRevision: 10, expectedHead: 11 }), /head-diverged/);
  assert.throws(() => guard.validateOwnership(base, { ...base }, observed, { expectedRevision: 10, expectedHead: 11, externals: '^/other ext' }), /externals-refused/);
});

process.stdout.write(`\n${passed} passed\n`);
if (process.exitCode) process.exit(process.exitCode);
