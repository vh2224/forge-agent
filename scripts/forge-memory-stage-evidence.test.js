'use strict';

const assert = require('assert/strict');
const { fingerprint, sha256 } = require('./forge-delivery');
const empirical = require('./forge-empirical-evaluation');
const diagnostic = require('./forge-memory-diagnostic');
const { STAGE_VERSION, STAGES, LIMITS, validateStageInput, buildStageEvidence } = require('./forge-memory-stage-evidence');

const H = sha256('fixture');
const PH = sha256('final context');
const fact = { fact_id: 'F1', milestone_id: 'M1', unit_id: 'T1', mem_id: 'MEM1' };
const clone = value => JSON.parse(JSON.stringify(value));
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function fixture() {
  const expectations = { version: 'v1', facts: [clone(fact)],
    planned: Object.fromEntries(STAGES.map(stage => [stage, 'observed'])) };
  expectations.sha256 = fingerprint(expectations);
  const row = { case_id: 'C1', delivery_id: 'D1', family_id: 'one-real-family',
    split: 'historical-diagnostic', evidence_kind: 'historical', controls_sha256: H, expectations,
    observations: {} };
  const data = {
    origin: { snapshot_sha256: sha256('authorized source') },
    extraction: { snapshot_sha256: sha256('extracted text') },
    publication: { sourceContext: { milestoneId: 'M1', unitId: 'T1' }, status: 'written', state: [{ mem_id: 'MEM1' }] },
    selection: { source: { provider: 'canonical' }, status: 'selected', reason: 'canonical-match', selected: [clone(fact)] },
    package: { context: { sha256: PH } }, answer: { available: true },
  };
  delete data.selection.selected[0].fact_id;
  for (const [stage, snapshot] of Object.entries(data)) {
    row.observations[stage] = { ref: `${stage}-snapshot`, sha256: fingerprint(snapshot), availability: 'observed',
      data: snapshot, adjudications: [{ fact_id: 'F1', expectations_version: 'v1', expectations_sha256: expectations.sha256,
        artifact_sha256: fingerprint(snapshot), state: 'present', ...(stage === 'package' ? { package_sha256: PH } : {}) }] };
  }
  return { version: 1, input_sha256: H, report_sha256: H, report_version: 'v1', cases: [row] };
}
function observation(input, stage) { return input.cases[0].observations[stage]; }
function reseal(input, stage) {
  const value = observation(input, stage);
  value.sha256 = fingerprint(value.data);
  value.adjudications.forEach(item => { item.artifact_sha256 = value.sha256; });
}
function state(input, stage, value) { observation(input, stage).adjudications[0].state = value; }
function build(input) { return buildStageEvidence(input).cases[0]; }
function evaluated(input, stage) { return build(input).facts[0].stages[stage]; }
function boundary(input, to) { return build(input).boundaries.find(row => row.to === to); }
function unavailable(input, stage) { observation(input, stage).availability = 'unavailable'; }
function selection(input, patch) { Object.assign(observation(input, 'selection').data, patch); reseal(input, 'selection'); }
function publication(input, patch) { Object.assign(observation(input, 'publication').data, patch); reseal(input, 'publication'); }
function checkError(input, code) { assert.throws(() => buildStageEvidence(input), error => error.code === code && error.message === code); }
let count = 0;
function check(name, fn) { fn(); count++; process.stdout.write(`ok ${count} - ${name}\n`); }

check('CHECK-STAGE-DENOMINATORS', () => {
  const input = fixture();
  assert.deepEqual(boundary(input, 'selection'), { from: 'publication', to: 'selection', reached: 1,
    retained: 1, lost: 0, unknown: 0, conflict: 0, denominator: 1, retention_rate: 1, loss_rate: 0 });
  state(input, 'origin', 'absent');
  assert.equal(boundary(input, 'extraction').denominator, 0);
  assert.equal(boundary(input, 'extraction').retention_rate, null);
  assert.equal(build(input).facts[0].first_loss, 'origin_absent');
  publication(input, { state: [] });
  assert.equal(evaluated(input, 'publication').state, 'absent');
  assert.equal(boundary(input, 'selection').denominator, 0);
  assert.equal(boundary(input, 'publication').lost, 1);
  assert.equal(boundary(input, 'selection').loss_rate, null);
  const empty = fixture(); selection(empty, { selected: [], status: 'empty', reason: 'no-match' });
  assert.equal(boundary(empty, 'selection').lost, 1);
  assert.equal(boundary(empty, 'selection').loss_rate, 1);
  unavailable(empty, 'selection');
  assert.equal(boundary(empty, 'selection').unknown, 1);
  assert.equal(boundary(empty, 'selection').lost, 0);
  assert.equal(boundary(empty, 'selection').retained, 0);
  assert.equal(boundary(empty, 'selection').denominator, 1);
  const absentSource = fixture(); unavailable(absentSource, 'origin');
  assert.equal(evaluated(absentSource, 'origin').state, 'unknown');
  assert.equal(build(absentSource).facts[0].first_loss, 'unknown');
});

check('CHECK-STAGE-FIRST-LOSS', () => {
  for (let index = 1; index < STAGES.length; index++) {
    const input = fixture(); const stage = STAGES[index]; state(input, stage, 'absent');
    if (stage === 'selection') selection(input, { selected: [] });
    assert.equal(build(input).facts[0].first_loss, `${STAGES[index - 1]}_to_${stage}`);
  }
  const joint = fixture(); unavailable(joint, 'extraction'); publication(joint, { state: [] });
  assert.equal(build(joint).facts[0].first_loss, 'extraction_publication');
  const gap = fixture(); unavailable(gap, 'extraction'); state(gap, 'package', 'absent');
  assert.equal(build(gap).facts[0].first_loss, 'unknown');
  assert.equal(boundary(gap, 'package').lost, 1);
  const unknown = fixture(); observation(unknown, 'extraction').adjudications = [];
  publication(unknown, { state: [] });
  assert.equal(build(unknown).facts[0].first_loss, 'unknown');
  assert.equal(build(fixture()).facts[0].first_loss, 'none');
});

check('CHECK-STAGE-SELECTION-AVAILABILITY', () => {
  for (const patch of [
    { source: { provider: 'direct' }, markdown: 'private nonempty text', emitted_bytes: 22 },
    { source: { provider: 'override' }, markdown: 'private nonempty text' },
    { status: 'disabled' }, { status: 'optional-error' },
    ...['no-query', 'insufficient-budget', 'store-missing'].map(reason => ({ status: 'empty', reason })),
  ]) {
    const input = fixture(); selection(input, patch);
    assert.equal(evaluated(input, 'selection').availability, 'unavailable');
    assert.equal(evaluated(input, 'selection').state, 'unknown');
    assert.equal(boundary(input, 'selection').retained, 0);
    assert.equal(boundary(input, 'selection').lost, 0);
    assert.equal(boundary(input, 'selection').unknown, 1);
    observation(input, 'selection').adjudications[0].artifact_sha256 = sha256('stale');
    assert.equal(evaluated(input, 'selection').availability, 'unavailable');
  }
  const empty = fixture(); selection(empty, { status: 'empty', reason: 'no-match', selected: [] });
  assert.equal(evaluated(empty, 'selection').state, 'absent');
  assert.equal(evaluated(empty, 'selection').availability, 'observed');
  selection(empty, { status: 'partial' });
  assert.equal(evaluated(empty, 'selection').state, 'unknown');
  selection(empty, { selected: [{ milestone_id: 'M1', unit_id: 'T1', mem_id: 'MEM1' }] });
  assert.equal(evaluated(empty, 'selection').state, 'present');
});

check('CHECK-STAGE-PUBLICATION', () => {
  for (const patch of [{ status: 'written' }, { status: 'noop', reason: 'replay' }]) {
    const input = fixture(); publication(input, patch);
    assert.equal(evaluated(input, 'publication').state, 'present');
    assert.equal(boundary(input, 'selection').denominator, 1);
    publication(input, { state: null });
    assert.equal(evaluated(input, 'publication').state, 'unknown');
    assert.equal(evaluated(input, 'publication').availability, 'unavailable');
    assert.equal(boundary(input, 'selection').denominator, 0);
  }
  for (const patch of [{ status: 'noop', reason: 'empty' }, { status: 'noop', reason: 'result-failed' },
    { status: 'noop', reason: 'result-blocked' }, { status: 'quarantined' }, { status: 'conflict' }]) {
    const input = fixture(); publication(input, patch);
    assert.equal(evaluated(input, 'publication').state, patch.status === 'conflict' ? 'conflict' : 'absent');
    assert.equal(boundary(input, 'selection').denominator, 0);
    assert.equal(evaluated(input, 'selection').state, 'unknown');
  }
  const fragment = fixture(); publication(fragment, { state: null,
    fragment: { milestone_id: 'M1', unit_id: 'T1', facts: [{ mem_id: 'MEM1' }] } });
  assert.equal(evaluated(fragment, 'publication').state, 'present');
  publication(fragment, { fragment: { milestone_id: 'M1', unit_id: 'T1', facts: [] } });
  assert.equal(evaluated(fragment, 'publication').state, 'absent');
  publication(fragment, { fragment: null });
  assert.equal(evaluated(fragment, 'publication').state, 'absent');
  assert.equal(evaluated(fragment, 'publication').availability, 'observed');
  assert(!/"(?:exposure|confirm|utility)"/.test(JSON.stringify(buildStageEvidence(fragment))));
});

check('CHECK-STAGE-REREAD-CONTENT-HASHES', () => {
  for (const stateHash of [H, undefined, sha256('replaced')]) {
    const input = fixture();
    publication(input, { state: [{ mem_id: 'MEM1', ...(stateHash ? { content_sha256: stateHash } : {}) }],
      fragment: { milestone_id: 'M1', unit_id: 'T1', facts: [{ mem_id: 'MEM1', content_sha256: H }] } });
    selection(input, { selected: [{ milestone_id: 'M1', unit_id: 'T1', mem_id: 'MEM1', content_sha256: H }] });
    const conflict = stateHash !== undefined && stateHash !== H;
    assert.equal(evaluated(input, 'publication').state, conflict ? 'conflict' : 'present');
    if (conflict) assert.equal(evaluated(input, 'publication').reason, 'content_hash_conflict');
    assert.equal(boundary(input, 'selection').denominator, conflict ? 0 : 1);
    assert.equal(boundary(input, 'selection').retained, conflict ? 0 : 1);
  }
  const input = fixture();
  publication(input, { state: [{ mem_id: 'MEM1', content_sha256: H }],
    fragment: { milestone_id: 'M1', unit_id: 'T1', facts: [{ mem_id: 'MEM1' }] } });
  selection(input, { selected: [{ milestone_id: 'M1', unit_id: 'T1', mem_id: 'MEM1', content_sha256: sha256('replaced') }] });
  assert.equal(evaluated(input, 'selection').state, 'conflict');
  assert.equal(evaluated(input, 'selection').reason, 'content_hash_conflict');
  assert.equal(boundary(input, 'selection').retained, 0);
});

check('CHECK-STAGE-BINDINGS', () => {
  const namespace = fixture(); publication(namespace, { sourceContext: { milestoneId: 'OTHER', unitId: 'T1' } });
  assert.equal(evaluated(namespace, 'publication').state, 'conflict');
  const version = fixture(); observation(version, 'extraction').adjudications[0].expectations_version = 'v2';
  assert.equal(evaluated(version, 'extraction').state, 'conflict');
  const stale = fixture(); observation(stale, 'publication').data.state.push({ mem_id: 'MEM2' });
  assert.equal(evaluated(stale, 'publication').state, 'conflict');
  assert.equal(boundary(stale, 'selection').denominator, 0);
  const old = fixture(); observation(old, 'extraction').adjudications[0].artifact_sha256 = sha256('old');
  assert.equal(evaluated(old, 'extraction').state, 'conflict');
  const duplicates = fixture(); observation(duplicates, 'origin').adjudications.push({
    ...observation(duplicates, 'origin').adjudications[0], state: 'absent' });
  assert.equal(evaluated(duplicates, 'origin').state, 'conflict');
  const expectations = fixture(); expectations.cases[0].expectations.version = 'v2';
  assert.equal(evaluated(expectations, 'origin').state, 'conflict');
  const content = fixture(); publication(content, { state: [{ mem_id: 'MEM1', content_sha256: sha256('original') }] });
  selection(content, { selected: [{ milestone_id: 'M1', unit_id: 'T1', mem_id: 'MEM1', content_sha256: sha256('replacement') }] });
  assert.equal(evaluated(content, 'selection').state, 'conflict');
  assert.equal(boundary(content, 'selection').retained, 0);
  const rereadConflict = fixture(); publication(rereadConflict, { state: [
    { mem_id: 'MEM1', content_sha256: H }, { mem_id: 'MEM1', content_sha256: PH }] });
  assert.equal(evaluated(rereadConflict, 'publication').state, 'conflict');
  const collision = fixture(); const other = clone(collision.cases[0]);
  other.case_id = 'C2'; other.expectations.facts[0].milestone_id = 'M2'; collision.cases.push(other);
  selection(collision, { diagnostic: { candidates: [{ identity: 'T1/MEM1', reasons: ['included'] }] } });
  assert.equal(evaluated(collision, 'selection').state, 'conflict');
  assert.equal(build(collision).facts[0].diagnostic.reason, 'ambiguous_identity');
  const selectedOther = fixture(); selection(selectedOther, { selected: [{ milestone_id: 'M2', unit_id: 'T1', mem_id: 'MEM1' }] });
  assert.equal(evaluated(selectedOther, 'selection').state, 'conflict');
  const reference = fixture(); observation(reference, 'origin').adjudications[0].fact_id = 'missing';
  checkError(reference, 'fact_reference_invalid');
});

check('CHECK-STAGE-PACKAGE', () => {
  const input = fixture(); assert.equal(evaluated(input, 'package').state, 'present');
  state(input, 'package', 'absent'); assert.equal(evaluated(input, 'package').state, 'absent');
  observation(input, 'package').adjudications[0].package_sha256 = H;
  assert.equal(evaluated(input, 'package').state, 'conflict');
  const truncated = fixture(); observation(truncated, 'package').adjudications = [];
  observation(truncated, 'package').data.truncated = true; reseal(truncated, 'package');
  assert.equal(evaluated(truncated, 'selection').state, 'present');
  assert.equal(evaluated(truncated, 'package').state, 'unknown');
  const telemetry = fixture(); observation(telemetry, 'package').data = { telemetry_sha256: PH };
  reseal(telemetry, 'package'); assert.equal(evaluated(telemetry, 'package').state, 'unknown');
  assert.equal(evaluated(telemetry, 'package').availability, 'unavailable');
});

check('CHECK-STAGE-SEMANTIC-EVIDENCE', () => {
  // Reviewed paraphrase and contradiction are supplied annotations, never NLP.
  const paraphrase = fixture(); observation(paraphrase, 'extraction').data.snapshot_sha256 = sha256('Prazo encerrado na sexta-feira');
  reseal(paraphrase, 'extraction'); assert.equal(evaluated(paraphrase, 'extraction').state, 'present');
  state(paraphrase, 'extraction', 'absent');
  assert.equal(evaluated(paraphrase, 'extraction').state, 'absent');
  assert.equal(build(paraphrase).facts[0].first_loss, 'origin_to_extraction');
  observation(paraphrase, 'extraction').adjudications = [];
  assert.equal(evaluated(paraphrase, 'extraction').state, 'unknown');
  const membershipOnly = fixture(); observation(membershipOnly, 'selection').adjudications = [];
  assert.equal(evaluated(membershipOnly, 'selection').state, 'unknown');
  assert.equal(boundary(membershipOnly, 'selection').retained, 0);
  const sameId = fixture(); state(sameId, 'publication', 'absent');
  assert.equal(evaluated(sameId, 'publication').state, 'absent');
  assert.equal(evaluated(sameId, 'selection').state, 'unknown');
});

check('CHECK-STAGE-ANSWER', () => {
  const input = fixture();
  for (const [given, expected] of [['present', 'used_correctly'], ['absent', 'omitted'], ['conflict', 'contradictory']]) {
    state(input, 'answer', given); const output = build(input);
    assert.equal(output.facts[0].stages.package.state, 'present');
    assert.equal(output.facts[0].answer.usage, expected);
    assert.equal(Object.hasOwn(output, 'functional'), false);
  }
  observation(input, 'answer').data.available = false; reseal(input, 'answer');
  assert.equal(build(input).facts[0].answer.usage, 'unavailable');
  assert.equal(build(input).facts[0].answer.state, 'unknown');
  assert.equal(buildStageEvidence(input).functional_gain, null);
  const stale = fixture(); observation(stale, 'answer').adjudications[0].artifact_sha256 = sha256('old answer');
  assert.equal(build(stale).facts[0].answer.state, 'conflict');
  assert.equal(build(stale).facts[0].answer.usage, 'unknown');
});

check('CHECK-STAGE-BOUNDS-PRIVACY', () => {
  assert.equal(STAGE_VERSION, 1);
  assert.deepEqual(STAGES, ['origin', 'extraction', 'publication', 'selection', 'package']);
  for (const key of ['file_bytes', 'total_bytes', 'cases']) assert.equal(LIMITS[key], empirical.LIMITS[key]);
  assert.equal(LIMITS.max_facts_per_case, 64); assert.equal(LIMITS.max_output_bytes, 1048576);
  const input = fixture(); selection(input, { source: { provider: 'direct' }, markdown: 'PRIVATE_QUERY_ANSWER_C:\\Users\\secret' });
  const before = fingerprint(input); freeze(input);
  assert.equal(validateStageInput(input), true);
  const output = buildStageEvidence(input);
  assert.equal(fingerprint(input), before);
  assert.deepEqual(output.dimensions, empirical.DIMENSIONS); assert.equal(output.dimensions.length, 14);
  assert.equal(output.apply_policy, false); assert.equal(output.comparative_ready, false);
  assert.equal(output.functional_gain, null);
  assert(!JSON.stringify(output).includes('PRIVATE_QUERY_ANSWER'));
  assert(!JSON.stringify(output).includes('C:\\Users'));
  assert.equal(Object.hasOwn(output, 'captured_at'), false);
  const { digest, ...body } = output; assert.equal(digest, sha256(Buffer.from(JSON.stringify(body))));
  for (const extra of ['query', 'answer', 'root', 'commands', 'apply_policy']) {
    const bad = fixture(); bad[extra] = 'PRIVATE'; checkError(bad, 'metadata_invalid');
  }
  const nested = fixture(); observation(nested, 'package').data.private_response = 'PRIVATE';
  checkError(nested, 'metadata_invalid');
  const badCount = fixture(); observation(badCount, 'selection').data.emitted_bytes = -1;
  checkError(badCount, 'count_invalid');
  const oversize = fixture(); observation(oversize, 'selection').data.markdown = 'x'.repeat(LIMITS.file_bytes + 1);
  checkError(oversize, 'file_bytes_exceeded');
  const total = fixture(); total.cases = Array.from({ length: 10 }, (_, index) => {
    const row = clone(fixture().cases[0]); row.case_id = `C${index}`;
    row.observations.selection.data.markdown = 'x'.repeat(900000); return row;
  });
  checkError(total, 'total_bytes_exceeded');
  for (const id of ['../secret', 'C:\\secret', '', 'x'.repeat(161)]) {
    const bad = fixture(); bad.cases[0].case_id = id; checkError(bad, 'identity_invalid');
  }
  const facts = fixture(); facts.cases[0].expectations.facts = Array.from({ length: 64 }, (_, index) => ({ ...fact, fact_id: `F${index}` }));
  // Update bindings after expectations changed; observations are intentionally unavailable.
  facts.cases[0].observations = {};
  const expected = facts.cases[0].expectations;
  expected.sha256 = fingerprint({ version: expected.version, facts: expected.facts, planned: expected.planned });
  assert.equal(build(facts).facts.length, 64);
  facts.cases[0].expectations.facts.push({ ...fact, fact_id: 'F64' }); checkError(facts, 'population_exceeded');
  const hugeOutput = fixture(); hugeOutput.cases = Array.from({ length: 100 }, (_, index) => {
    const row = clone(fixture().cases[0]); row.case_id = `C${index}`;
    row.expectations.facts = Array.from({ length: 64 }, (_, i) => ({ ...fact, fact_id: `F${i}` }));
    row.observations = {}; return row;
  });
  checkError(hugeOutput, 'output_bytes_exceeded');
  hugeOutput.cases.push(clone(hugeOutput.cases[0])); checkError(hugeOutput, 'population_exceeded');
  const strata = fixture(); strata.cases[0].evidence_kind = 'real';
  const version = clone(strata.cases[0]); version.case_id = 'C2'; version.delivery_id = 'D2'; strata.cases.push(version);
  assert.deepEqual(buildStageEvidence(strata).real_families, ['one-real-family']);
  assert.deepEqual(buildStageEvidence(strata).strata, { synthetic: 0, historical: 0, real: 2 });
  assert.deepEqual(buildStageEvidence(input), buildStageEvidence(input));
});

check('CHECK-STAGE-DIAGNOSTIC-GAPS', () => {
  assert.equal(diagnostic.LIMITS.max_candidates, 64);
  for (const trace of [
    { candidates: [], omitted_candidates: 10 },
    { candidates: [{ identity: null, reasons: ['reason-unknown'] }], unattributed_positions: 3 },
    { candidates: [], minimum_overlap: 2, unattributed_positions: 4 },
  ]) {
    const input = fixture(); selection(input, { diagnostic: trace, status: 'partial', selected: [] });
    assert.deepEqual(build(input).facts[0].diagnostic, { state: 'unknown', reason: 'reason_unknown' });
    assert.equal(evaluated(input, 'selection').state, 'unknown');
    assert.equal(boundary(input, 'selection').retained, 0);
  }
  const known = fixture(); selection(known, { diagnostic: {
    candidates: [{ identity: 'T1/MEM1', reasons: ['included'], overlap_count: 2 }], minimum_overlap: 2 } });
  assert.deepEqual(build(known).facts[0].diagnostic, { state: 'observed', reason: 'included' });
  selection(known, { source: { provider: 'direct' } });
  assert.deepEqual(build(known).facts[0].diagnostic, { state: 'unknown', reason: 'reason_unknown' });
  const nullMember = fixture(); selection(nullMember, { selected: [{ milestone_id: null, unit_id: 'T1', mem_id: 'MEM1' }] });
  assert.equal(evaluated(nullMember, 'selection').state, 'unknown');
  assert.equal(boundary(nullMember, 'selection').lost, 0);
  const duplicate = fixture(); selection(duplicate, { diagnostic: { candidates: [
    { identity: 'T1/MEM1', reasons: ['included'] }, { identity: 'T1/MEM1', reasons: ['context-budget'] }] } });
  assert.equal(evaluated(duplicate, 'selection').state, 'conflict');
});
