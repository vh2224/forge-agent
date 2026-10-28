'use strict';

const assert = require('assert/strict');
const { inspectPhaseContent, validatePhaseContent } = require('./forge-task-preparation');
const { inspectArtifacts } = require('./forge-unit-sidecar');
const { diagnostic } = require('./forge-sidecar-diagnostic');
const { parseExecuteCandidate } = require('./forge-claude-sidecar');

const id = 'T-20261028040008-vigiar-progresso';
const artifactPath = `.gsd/tasks/${id}/${id}-PLAN.md`;
const plan = `---
tier: standard
effort: medium
depends: []
writes: [scripts/example.js]
expected_output: [scripts/example.js]
must_haves:
  truths: [Observable output]
  artifacts: []
  key_links: []
---

## Steps
Implement the scoped change.

## Must-Haves
The command produces the expected output.

## Standards
Reuse existing helpers.

## Files to Change
scripts/example.js
`;

function envelope(content, detailedDeliveryDiagnostic) {
  return inspectArtifacts({ status: 'done', summary: 'fixture', questions: [],
    artifacts: [{ path: artifactPath, content }] }, [artifactPath], [artifactPath], Infinity,
  { [artifactPath]: { kind: 'standalone-preparation', phase: 'plan', taskId: id } },
  { detailedDeliveryDiagnostic });
}

assert.deepEqual(envelope(plan, true), { ok: true });
assert.deepEqual(inspectPhaseContent('plan', id, plan), { ok: true });
assert.equal(validatePhaseContent('plan', id, plan.replaceAll('\n', '\r\n')), true);

const cases = [
  ['frontmatter', '# private-sentinel'],
  ['tier', plan.replace('tier: standard', 'tier: private-sentinel')],
  ['effort', plan.replace('effort: medium', 'effort: private-sentinel')],
  ['duplicate-fields', plan.replace('tier: standard', 'tier: standard\ntier: heavy')],
  ['structured-fields', plan.replace('writes: [scripts/example.js]', 'writes: []')],
  ['structured-fields', plan.replace('truths: [Observable output]', 'truths: []')],
  ['sections', plan.replace('## Standards', '## private-sentinel')],
  ['sections', `${plan}\n## Extra\nprivate-sentinel\n`],
  ['sections', plan.replace('Reuse existing helpers.', '')],
  ['scope', `${plan}\n# Roadmap\nprivate-sentinel\n`],
  ['content', `${plan}\0private-sentinel`],
];
for (const [reason, content] of cases) {
  assert.equal(validatePhaseContent('plan', id, content), false);
  assert.deepEqual(inspectPhaseContent('plan', id, content), { ok: false, reason });
  const detailed = envelope(content, true);
  assert.deepEqual(detailed, { ok: false, reason: `typed-standalone-preparation-${reason}` });
  assert.equal(JSON.stringify(detailed).includes('private-sentinel'), false);
  assert.deepEqual(diagnostic(detailed.reason, { text: content }),
    { version: 1, stage: 'validation', reason: detailed.reason });
  const value = { status: 'done', summary: 'fixture', questions: [],
    artifacts: [{ path: artifactPath, content }] };
  const framed = `---GSD-WORKER-RESULT---\nstatus: done\nresult_json: ${JSON.stringify(value)}\n---END-RESULT---`;
  assert.throws(() => parseExecuteCandidate(framed, () => detailed), error => {
    assert.equal(error.code, 'claude-invalid-result');
    assert.equal(error.diagnostic.reason, detailed.reason);
    assert.equal(JSON.stringify(error.diagnostic).includes('private-sentinel'), false);
    return true;
  });
  assert.deepEqual(envelope(content, false), { ok: false, reason: 'delivery-artifact-invalid' });
}

for (const [phase, headings] of [
  ['brainstorm', ['Recommended Approach', 'Alternatives Considered', 'Top Risks', 'Out of Scope']],
  ['discuss', ['Decisions', 'Open Questions', 'Out of Scope']],
  ['research', ['Summary', "Don't Hand-Roll", 'Relevant Code']],
]) {
  const content = headings.map(heading => `## ${heading}\nA concrete finding.\n`).join('\n');
  assert.equal(validatePhaseContent(phase, id, content), true);
  assert.deepEqual(inspectPhaseContent(phase, id, content), { ok: true });
  assert.deepEqual(inspectPhaseContent(phase, id, content.replace(`## ${headings[0]}`, '## private-sentinel')),
    { ok: false, reason: 'sections' });
}
for (const content of [null, undefined, '', '   ', 42]) {
  assert.equal(validatePhaseContent('plan', id, content), false);
  assert.deepEqual(inspectPhaseContent('plan', id, content), { ok: false, reason: 'content' });
}
assert.deepEqual(inspectPhaseContent('unknown', id, plan), { ok: false, reason: 'phase' });
console.log('PASS preparation diagnostics: distinct closed reasons, unchanged acceptance and private content excluded');
