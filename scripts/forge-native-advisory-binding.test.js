'use strict';
// Issue 284 cohort: an executable artifact whose substantive heuristic flags two
// intentional empty callbacks is proved only by named lines of its own real
// execution plus existence. Every other evidence shape fails closed.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const codeRoots = require('./forge-code-roots.test');
const roots = require('./forge-code-roots');
const side = require('./forge-unit-sidecar');
const verify = require('./forge-verify');
const deliveryApi = require('./forge-delivery');
const native = require('./forge-native-recovery-delivery');

const COMMAND = 'node check-advisory.test.js';
const LINE_A = 'PASS advisory observers: start and stop callbacks are registered once';
const LINE_B = 'PASS advisory observers: stop emission reaches the intentional empty callback';
const NOTE = 'Worker note: approved by remote CI and UAT.';
const ADVISORY_SOURCE = [
  "'use strict';",
  "const assert = require('assert');",
  "const events = new (require('events').EventEmitter)();",
  'const onStart = () => {};',
  'const onStop = () => {};',
  "events.on('start', onStart);",
  "events.on('stop', onStop);",
  "assert.equal(events.listenerCount('start'), 1);",
  "assert.equal(events.listenerCount('stop'), 1);",
  `console.log(${JSON.stringify(LINE_A)});`,
  "assert.equal(events.emit('stop'), true);",
  `console.log(${JSON.stringify(LINE_B)});`,
  "console.log('   ');",
  "console.log('ℹ pass 2');",
  "console.log('All tests passed');",
  '',
].join('\n');
const SUBSTANTIVE_SOURCE = [
  "'use strict';",
  "const assert = require('assert');",
  'const seen = [];',
  'const record = name => seen.push(name);',
  "record('start');",
  "assert.deepEqual(seen, ['start']);",
  `console.log(${JSON.stringify(LINE_A)});`,
  '',
].join('\n');

function planText(contract) {
  const files = ['alpha::check-advisory.test.js', 'beta::check-advisory.test.js'];
  return '---\nid: T01\ntier: standard\neffort: medium\ndepends: []\nroots_schema: 2\n'
    + `primary_root_id: ${contract.primary_root_id}\ncode_roots:\n`
    + contract.code_roots.map(r => `  - id: ${r.id}\n    path: '${r.path.replace(/\\/g, '/')}'\n    vcs: ${r.vcs}\n`).join('')
    + `writes:\n${files.map(v => `  - '${v}'`).join('\n')}\nexpected_output:\n${files.map(v => `  - '${v}'`).join('\n')}\n`
    + `verify:\n  - ${JSON.stringify(COMMAND)}\n`
    + "must_haves:\n  truths:\n    - 'Both roots execute the observer check.'\n  artifacts:\n"
    + "    - path: 'alpha::check-advisory.test.js'\n      provides: 'Executable observer check with two intentional empty callbacks'\n      min_lines: 1\n"
    + "    - path: 'beta::check-advisory.test.js'\n      provides: 'Substantive observer check'\n      min_lines: 1\n"
    + '  key_links: []\n---\n## Description\nObserver checks.\n## Steps\n1. Run.\n## Must-Haves\nNamed lines.\n## Standards\nExisting format.\n## Files to Change\nBoth checks.\n';
}

function setup() {
  const f = codeRoots.fixture();
  fs.writeFileSync(path.join(f.a, 'check-advisory.test.js'), ADVISORY_SOURCE);
  fs.writeFileSync(path.join(f.b, 'check-advisory.test.js'), SUBSTANTIVE_SOURCE);
  const plan = planText(f.contract);
  const planFile = path.join(f.owner, '.gsd/milestones/M902/slices/S01/tasks/T01/T01-PLAN.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, plan);
  const request = { unitType: 'execute-task', scope: 'milestone', phase: 'execute', milestoneId: 'M902', sliceId: 'S01', taskId: 'T01',
    cwd: f.a, contextRoot: f.owner, planFile, execution_contract: f.contract };
  const loc = side.locations(request), unit = loc.rules[loc.delivery.input].unit;
  const inventory = deliveryApi.inventoryPlan(plan, planFile, unit);
  // Real local capture: actual commands in both roots and actual verifier rows.
  const capture = verify.captureRootDelivery(f.contract, plan, { unit });
  const artifactId = inventory.criteria.find(c => c.origin === 'artifact' && c.artifact_path.startsWith('alpha::')).id;
  const result = () => ({ status: 'done', summary: 'Observer checks executed.', files_changed: ['alpha::check-advisory.test.js', 'beta::check-advisory.test.js'],
    must_haves_status: inventory.criteria.map(c => ({ kind: c.origin, index: c.index, item: c.text, note: NOTE, status: 'met',
      root_id: c.origin === 'artifact' ? roots.resolvePath(f.contract, c.artifact_path).root_id : '',
      evidence: c.origin === 'truth' ? f.contract.code_roots.map(row => ({ root_id: row.id, check: COMMAND, stdout_line: LINE_A }))
        : c.id === artifactId ? [LINE_A, LINE_B].map(line => ({ root_id: 'alpha', check: COMMAND, stdout_line: line })) : [] })) });
  const key = deliveryApi.unitKey(unit);
  const bind = (value, captured = capture) => native.criterionBindings(value, captured, key, { inventory, contract: f.contract });
  const deliver = (bindings, captured = capture) => {
    const artifacts = side.executeDeliveryArtifacts({ ...request, verification: { bindings } }, loc, result(), f.owner, f.a, captured);
    const read = name => JSON.parse(artifacts.find(a => a.path === name).content);
    return { artifacts, read, output: read(loc.delivery.output), input: read(loc.delivery.input) };
  };
  const artifactItem = (value, id = artifactId) => value.must_haves_status.find(item => key + ':' + item.kind + ':' + item.index === id);
  const betaArtifactId = inventory.criteria.find(c => c.origin === 'artifact' && c.artifact_path.startsWith('beta::')).id;
  return { f, request, loc, inventory, capture, artifactId, betaArtifactId, result, bind, deliver, artifactItem };
}

const status = (output, id) => output.criteria.find(c => c.id === id).status;
const alphaRow = capture => {
  const envelope = capture.artifacts.find(row => row.root_id === 'alpha');
  return envelope.result.rows.find(row => row.path === 'alpha::check-advisory.test.js');
};
const refuses = (fn, code, label) => assert.throws(fn, error => {
  assert.equal(error.code, code, label + ': ' + error.code);
  return true;
}, label);

function main() {
  const s = setup();
  try {
    assert.equal(s.capture.passed, true, 'real capture passes in both roots');
    const row = alphaRow(s.capture);
    assert.equal(row.exists, true);
    assert.equal(row.substantive, false);
    assert.deepEqual(row.flags.map(flag => [flag.level, flag.regex_name, flag.line_number]),
      [['substantive', 'empty_function_body', 4], ['substantive', 'empty_function_body', 5]]);
    const alphaCheck = s.capture.gate.roots.find(r => r.root_id === 'alpha').result.checks[0];
    assert.equal(alphaCheck.command, COMMAND);
    assert.equal(alphaCheck.exitCode, 0);
    for (const line of [LINE_A, LINE_B, '   ', 'ℹ pass 2', 'All tests passed']) assert(alphaCheck.stdout.split(/\r?\n/).includes(line), line);
    console.log('PASS real capture: captureRootDelivery runs the artifact and the verifier flags two empty_function_body callbacks');

    // Without named evidence the artifact keeps the substantive binding and the
    // canonical builder leaves exactly that criterion unverified (issue 284).
    const missing = s.result();
    s.artifactItem(missing).evidence = [];
    const missingBindings = s.bind(missing);
    const missingArtifact = missingBindings.filter(b => b.criterion_id === s.artifactId);
    assert.deepEqual(missingArtifact.map(b => [b.coverage, b.source.kind, b.source.property]), [['structural', 'artifact', 'substantive']]);
    const without = s.deliver(missingBindings);
    assert.equal(status(without.output, s.artifactId), 'não verificado');
    for (const c of without.output.criteria.filter(c => c.id !== s.artifactId)) assert.equal(c.status, 'verificado', c.id);
    console.log('PASS missing named evidence: the flagged artifact criterion stays not verified and every other criterion stays verified');

    const bindings = s.bind(s.result());
    const own = bindings.filter(b => b.criterion_id === s.artifactId);
    assert.deepEqual(own.map(b => [b.coverage, b.source.kind, b.source.property || null]),
      [['behavioral', 'verification', null], ['behavioral', 'verification', null], ['structural', 'artifact', 'exists']]);
    assert.deepEqual(own.slice(0, 2).map(b => b.observed_test_lines), [[LINE_A], [LINE_B]]);
    assert(own.every(b => b.root_id === 'alpha' && !bindings.some(other => other !== b && other.criterion_id === s.artifactId && other.source.property === 'substantive')));
    const delivered = s.deliver(bindings);
    for (const c of delivered.output.criteria) assert.equal(c.status, 'verificado', c.id + ' ' + JSON.stringify(c.pending));
    assert.equal(delivered.output.generated_by, 'forge-delivery');
    assert(delivered.output.criteria.find(c => c.id === s.artifactId).evidence.some(e => e.coverage === 'behavioral' && e.positive));
    console.log('PASS advisory positive: named lines of the executed artifact plus exists verify only that criterion through the unchanged builder');

    const inputBindings = delivered.input.bindings.filter(b => b.criterion_id === s.artifactId);
    assert.equal(inputBindings.length, 3);
    for (const b of inputBindings) {
      assert.deepEqual(b.advisory_disposition, { state: 'advisory-retained', scope: 'named-lines-from-executed-artifact', command: COMMAND,
        flags: [{ level: 'substantive', regex_name: 'empty_function_body', line_number: 4 }, { level: 'substantive', regex_name: 'empty_function_body', line_number: 5 }],
        limit: b.advisory_disposition.limit });
      assert(/sem alegação de CI remoto ou UAT/.test(b.advisory_disposition.limit));
    }
    assert(!JSON.stringify(delivered.input).includes(NOTE), 'worker note never becomes disposition');
    const envelopeArtifact = delivered.artifacts.find(a => a.path === s.loc.delivery.rootSources.find(r => r.kind === 'artifact' && r.root_id === 'alpha').path);
    const envelopeRow = JSON.parse(envelopeArtifact.content).result.rows.find(r => r.path === 'alpha::check-advisory.test.js');
    assert.deepEqual(envelopeRow.flags.map(flag => flag.regex_name), ['empty_function_body', 'empty_function_body']);
    console.log('PASS advisory visibility: disposition lives in DELIVERY-INPUT, original flags stay in the artifact envelope, worker note ignored');

    const substantiveEvidence = s.result();
    s.artifactItem(substantiveEvidence, s.betaArtifactId).evidence = [{ root_id: 'beta', check: COMMAND, stdout_line: LINE_A }];
    const betaBindings = s.bind(substantiveEvidence).filter(b => b.criterion_id === s.betaArtifactId);
    assert.deepEqual(betaBindings.map(b => [b.coverage, b.source.property, b.advisory_disposition]), [['structural', 'substantive', undefined]]);
    console.log('PASS substantive artifact: evidence on a substantive row keeps the ordinary substantive binding');

    const mutateEvidence = change => { const value = s.result(); change(s.artifactItem(value).evidence[0], s.artifactItem(value)); return value; };
    refuses(() => s.bind(mutateEvidence(e => { e.root_id = 'beta'; })), 'artifact-evidence-root-mismatch', 'foreign root');
    refuses(() => s.bind(mutateEvidence(e => { e.check = 'node check-advisory.test.js --other'; })), 'artifact-evidence-not-executed', 'other command');
    refuses(() => s.bind(mutateEvidence(e => { e.check = 'node same.txt'; })), 'artifact-evidence-not-executed', 'not the artifact');
    const renamed = structuredClone(s.capture);
    renamed.gate.roots.find(r => r.root_id === 'alpha').result.checks[0].command = 'node other.test.js';
    const otherOnly = s.result();
    otherOnly.must_haves_status.find(item => item.kind === 'truth').evidence.find(e => e.root_id === 'alpha').check = 'node other.test.js';
    refuses(() => s.bind(otherOnly, renamed), 'artifact-evidence-not-executed', 'artifact never executed');
    refuses(() => s.bind(mutateEvidence(e => { e.stdout_line = 'PASS advisory observers: invented'; })), 'criterion-unobserved-evidence', 'absent line');
    for (const line of ['   ', '', '\t']) refuses(() => s.bind(mutateEvidence(e => { e.stdout_line = line; })), 'artifact-evidence-line-empty', 'empty line ' + JSON.stringify(line));
    for (const line of ['ℹ pass 2', 'All tests passed', 'ℹ pass 25', '# pass 25', 'ℹ tests 3', 'Todos os testes passaram', '25 passing', '3/3 passed',
      'PASS', 'ok', '✓ passed', 'pass: 25', 'Tests: 25 passed', 'forge-x: all scenarios passed', '1..25'])
      refuses(() => s.bind(mutateEvidence(e => { e.stdout_line = line; })), 'artifact-evidence-global-summary', 'global ' + line);
    const negative = structuredClone(s.capture);
    negative.gate.roots.find(r => r.root_id === 'alpha').result.checks[0].exitCode = 1;
    refuses(() => s.bind(s.result(), negative), 'artifact-evidence-negative', 'negative check');
    console.log('PASS advisory evidence refusals: foreign root, other or unexecuted command, absent, empty, global summary and negative lines fail closed');

    const flagged = (flags, extra = {}) => { const c = structuredClone(s.capture); Object.assign(alphaRow(c), { flags }, extra); return c; };
    const eligible = { level: 'substantive', regex_name: 'empty_function_body', line_number: 4, matched_text: 'const onStart = () => {};', path: 'check-advisory.test.js' };
    for (const [label, flags, extra] of [
      ['custom_stub_0', [{ ...eligible, regex_name: 'custom_stub_0' }]],
      ['return_null_function', [{ ...eligible, regex_name: 'return_null_function' }]],
      ['jsx_placeholder_onclick', [{ ...eligible, regex_name: 'jsx_placeholder_onclick' }]],
      ['jsx_placeholder_return_div', [{ ...eligible, regex_name: 'jsx_placeholder_return_div' }]],
      ['test-quality', [{ ...eligible, level: 'test-quality', regex_name: 'empty_function_body' }]],
      ['test-quality mixed', [eligible, { level: 'test-quality', reason: 'weak-assertion', regex_name: 'weak_assertion', line_number: 8 }]],
      ['below_min_lines', [{ level: 'substantive', reason: 'below_min_lines', actual: 1, expected: 10 }]],
      ['flag without regex_name', [{ level: 'substantive', line_number: 4 }]],
      ['mixed eligible and custom_stub', [eligible, { ...eligible, regex_name: 'custom_stub_1', line_number: 9 }]],
      ['empty flags', []],
      ['exists false', [{ level: 'exists', reason: 'file_not_found' }], { exists: false, substantive: null }],
    ]) refuses(() => s.bind(s.result(), flagged(flags, extra)), 'artifact-advisory-ineligible', label);
    console.log('PASS advisory eligibility: custom_stub, return_null, jsx, test-quality, below_min_lines, unnamed, mixed, empty and exists false are ineligible');

    const stale = structuredClone(s.capture);
    stale.artifacts.find(r => r.root_id === 'alpha').revision = '0'.repeat(40);
    refuses(() => s.bind(s.result(), stale), 'artifact-evidence-stale', 'artifact revision');
    const dirty = structuredClone(s.capture);
    dirty.artifacts.find(r => r.root_id === 'alpha').workspace = [{ path: 'check-advisory.test.js', hash: 'f'.repeat(40) }];
    refuses(() => s.bind(s.result(), dirty), 'artifact-evidence-stale', 'artifact workspace');
    // Builder independently refuses mixed revisions for the same criterion.
    const mixed = s.deliver(bindings, stale);
    const mixedArtifact = mixed.output.criteria.find(c => c.id === s.artifactId);
    assert.notEqual(mixedArtifact.status, 'verificado');
    assert(mixedArtifact.pending.some(p => p.startsWith('revision_mismatch:')), JSON.stringify(mixedArtifact.pending));
    console.log('PASS stale evidence: divergent revision or workspace fails closed in the binder and the builder reports revision_mismatch');
  } finally { s.f.cleanup(); }
  console.log('forge-native-advisory-binding: all scenarios passed');
}

module.exports = { setup, planText };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
