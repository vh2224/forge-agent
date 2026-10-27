'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { inspectArtifacts } = require('./forge-unit-sidecar');
const { diagnostic } = require('./forge-sidecar-diagnostic');
const unit = { type: 'slice', id: 'S01', milestone: 'M001' };
const artifactPath = 'fixture/private-path.json';
const fixtures = {
  input: { schema_version: 2, unit, plan: 'fixture', plan_fingerprint: 'fixture', bindings: [], expected_children: [] },
  delivery: { schema_version: 1, unit, generated_by: 'forge-delivery', delivery_fingerprint: 'fixture', criteria: [], facts: [] },
  verification: { schema_version: 1, unit, kind: 'test', plan_fingerprint: 'fixture', code_dir: 'fixture', revision: 'fixture', environment: 'fixture', captured_at: 'fixture', result: {} },
};
function inspect(category, content, detailed = true) {
  return inspectArtifacts({ status: 'done', summary: 'fixture', questions: [], artifacts: [{ path: artifactPath, content }] },
    [artifactPath], [artifactPath], Infinity,
    { [artifactPath]: { kind: category === 'verification' ? 'test' : category, unit } },
    { detailedDeliveryDiagnostic: detailed });
}
for (const [category, good] of Object.entries(fixtures)) {
  test(`${category}: valid content remains accepted`, () => {
    assert.deepEqual(inspect(category, JSON.stringify(good)), { ok: true });
  });
  const cases = [ ['json', '{private-provider-text'], ['object', '[]'],
    ['schema', JSON.stringify({ ...good, schema_version: 999 })],
    ['unit', JSON.stringify({ ...good, unit: { ...unit, id: 'S02' } })] ];
  for (const field of Object.keys(good).filter(key => !['unit', 'schema_version'].includes(key))) {
    cases.push([field === 'generated_by' ? 'generated-by' : field.replaceAll('_', '-'), JSON.stringify({ ...good, [field]: null })]);
  }
  for (const [condition, content] of cases) test(`${category}: ${condition} survives sanitization without payload`, () => {
    assert.deepEqual(inspect(category, content, false), { ok: false, reason: 'delivery-artifact-invalid' });
    const checked = inspect(category, content);
    assert.deepEqual(checked, { ok: false, reason: `typed-${category}-${condition}` });
    assert.deepEqual(diagnostic(checked.reason), { version: 1, stage: 'validation', reason: checked.reason });
    assert(!JSON.stringify(diagnostic(checked.reason)).includes('private'));
  });
}
test('unknown diagnostic suffix cannot disclose provider text', () => {
  assert.equal(diagnostic('typed-delivery-private-provider-text').reason, 'adapter-failed');
});
test('Claude adapter preserves typed validation reason at its candidate boundary', () => {
  const { parseExecuteCandidate } = require('./forge-claude-sidecar');
  const value = { status: 'done', summary: 'fixture', questions: [],
    artifacts: [{ path: artifactPath, content: JSON.stringify({ ...fixtures.delivery, facts: 'private-provider-text' }) }] };
  const output = `---GSD-WORKER-RESULT---\nstatus: done\nresult_json: ${JSON.stringify(value)}\n---END-RESULT---`;
  assert.throws(() => parseExecuteCandidate(output, candidate => inspectArtifacts(candidate,
    [artifactPath], [artifactPath], Infinity, { [artifactPath]: { kind: 'delivery', unit } },
    { detailedDeliveryDiagnostic: true })), error => {
    assert.equal(error.diagnostic.reason, 'typed-delivery-facts');
    assert.equal(error.diagnostic.stage, 'validation');
    assert(!JSON.stringify(error.diagnostic).includes('private'));
    return true;
  });
});
