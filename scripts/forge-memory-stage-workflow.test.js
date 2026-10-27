#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const memory = require('./forge-memory');
const { validateExtractionResult, publishExtraction } = require('./forge-memory-extraction');
const { serializeGroup } = require('./forge-grouped-file');
const { validateInputGraph, buildAgentView, materializeViews, createSplit } = require('./forge-empirical-input');
const { caseIdentity } = require('./forge-empirical-corpus');
const { initCollection, collectCorpus } = require('./forge-empirical-collect');
const { freezeCorpus, verifyFreeze } = require('./forge-empirical-freeze');
const { buildEmpiricalBaseline } = require('./forge-empirical-baseline');
const { buildContextComparison } = require('./forge-context-comparison');
const { buildProcedureEvidence, createProcedureFixture } = require('./forge-procedure-evidence');
const empirical = require('./forge-empirical-evaluation');
const { renderPrompt } = require('./forge-prompt');
const { captureFinal, measure } = require('./forge-attempt-telemetry');
const { buildStageEvidence, STAGES } = require('./forge-memory-stage-evidence');
const { fingerprint, sha256 } = require('./forge-delivery');
const isolation = require('./fixtures/empirical-corpus/isolation/cases.json');

const fixtureFile = path.join(__dirname, 'fixtures/memory-stage-evidence/cases.json');
// Capture exact fixture bytes before running any case or computing any score.
const declaredHash = sha256(fs.readFileSync(fixtureFile));
const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
const tempParent = fs.realpathSync.native(os.tmpdir());
const root = fs.mkdtempSync(path.join(tempParent, 'forge-stage-workflow-'));
const codeDir = path.resolve(__dirname, '..');
const now = Date.parse('2026-10-20T00:00:00Z');
const sentinel = fixture.rubric.grader_sentinel;
const priorForgeHome = process.env.FORGE_HOME;
let count = 0;
function test(name, fn) { fn(); console.log(`ok ${++count} - ${name}`); }
function mkdir(name) { const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true }); return dir; }
function write(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
function withClock(fn) {
  const previous = Date.now;
  try { Date.now = () => now; return fn(); } finally { Date.now = previous; }
}
function snapshot(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? snapshot(file, base) : [{ path: path.relative(base, file), sha256: sha256(fs.readFileSync(file)) }];
  });
}
function rejects(fn, code) { assert.throws(fn, error => error.code === code, code); }

// No grader label is consulted to choose entries, graph nodes or the query.
function inputView(id, sourceText) {
  const area = mkdir(id), sourceRoot = mkdir(`${id}/source`), agentRoot = mkdir(`${id}/agent`);
  const graderRoot = mkdir(`${id}/grader`);
  const corpus = structuredClone(isolation.corpus);
  corpus.references = [
    { id: 'before', role: 'prework', region: 'prework', path: 'request.txt', text: sourceText },
    { id: 'criteria', role: 'grader/criteria', region: 'grader', path: 'criteria.txt', text: sentinel },
    { id: 'expected', role: 'grader/expected', region: 'grader', path: 'expected.txt', text: sentinel },
    { id: 'final', role: 'grader/final-code', region: 'grader', path: 'final.txt', text: sentinel },
  ].map(({ text, ...row }) => {
    fs.writeFileSync(path.join(sourceRoot, row.path), text);
    return { ...row, origin: 'synthetic-stage', lineage: ['public-synthetic'], state: 'observed',
      bytes: Buffer.byteLength(text), sha256: sha256(text), captured_at: corpus.captured_at,
      temporal_source: 'synthetic declaration' };
  });
  const original = structuredClone(corpus.candidates[0]);
  corpus.candidates = ['synthetic-adjustment', 'synthetic-reserved'].map(family => {
    const candidate = structuredClone(original);
    candidate.family_key = family; candidate.delivery_key = family;
    Object.assign(candidate, caseIdentity(candidate));
    return candidate;
  });
  corpus.references.push({ ...corpus.references[0], id: 'reserved-before', path: 'reserved-before.txt' });
  fs.writeFileSync(path.join(sourceRoot, 'reserved-before.txt'), 'Synthetic reserved source');
  Object.assign(corpus.references.at(-1), { bytes: Buffer.byteLength('Synthetic reserved source'),
    sha256: sha256('Synthetic reserved source') });
  corpus.candidates[1].refs = ['reserved-before'];
  corpus.exposure_registry = [{ family_id: corpus.candidates[0].family_id, refs: ['before'],
    purpose: 'public synthetic adjustment', captured_at: corpus.captured_at }];
  const split = createSplit(corpus, { freezeId: 'synthetic-stage-v1', reservedCount: 1 });
  const manifest = { schema_version: 1, case_id: corpus.candidates[0].case_id, version: 'v1',
    entries: ['entry'], nodes: [{ id: 'entry', ref_id: 'before', kind: 'prework', dependencies: [] }] };
  const trusted = { sourceRoot, agentRoot, graderRoot, before: corpus.captured_at, split,
    prework: [{ ref_id: 'before', sha256: corpus.references[0].sha256,
      available_at: corpus.captured_at, evidence: 'public synthetic prework' }], graderRefs: ['criteria', 'expected', 'final'] };
  const graph = validateInputGraph(corpus, manifest, trusted);
  const view = buildAgentView(corpus, manifest, trusted);
  const materialized = materializeViews(corpus, manifest, trusted);
  const { root: observedRoot, profile, ...materializedView } = materialized.agent;
  assert.equal(observedRoot, agentRoot);
  assert.ok(profile);
  assert.deepEqual(view, materializedView);
  assert(view.text.includes(sourceText));
  assert.equal(graph.nodes.length, 1);
  return { area, corpus, manifest, trusted, view };
}
function envelope(text, status = 'done') {
  return { schema_version: 1, status, summary: 'Synthetic supplied extraction, not model inference', questions: [],
    facts: text ? [{ local_id: 'fact', category: 'gotcha', text, confidence_base: 0.95 }] : [], events: [] };
}
function sourceContext(id, source) {
  return { milestoneId: 'M001', unitId: 'T01', extractionId: `synthetic-${id}`,
    extractedAt: '2026-10-20T00:00:00Z', source: { sourceUnit: 'execute-task/T01',
      sourceFingerprint: sha256(source), dispatchId: `synthetic-${id}`,
      model: 'synthetic-no-provider', effort: 'medium' } };
}
function publish(cwd, extraction, context) { return publishExtraction({ cwd, extraction, sourceContext: context }); }
function render(cwd, query, overrides = {}, diagnostic = true) {
  const callbacks = [];
  const rendered = withClock(() => renderPrompt({ cwd, codeDir, unitType: 'execute-task',
    isolationMode: 'worktree', branch: 'synthetic-stage', milestoneId: 'M001', sliceId: 'S01', taskId: 'T01',
    autoCommit: false, ledger: '(none)', standardsMaxTokens: 0, description: 'Public synthetic task.',
    memoryQuery: query, memoryLimit: 10, memoryMaxTokens: 2000, memoryDiagnostic: diagnostic,
    onMemorySelection: value => callbacks.push(value), ...overrides }));
  assert.equal(callbacks.length, 1);
  const final = captureFinal({ context: rendered.prompt, request: { input: rendered.prompt },
    identity: { unitType: 'execute-task', scope: 'milestone', phase: 'execute', dispatchId: 'synthetic' },
    model: 'synthetic-no-provider', effort: 'medium', budgets: { memory: overrides.memoryMaxTokens ?? 2000 } });
  assert.equal(measure(rendered.prompt).sha256, final.context.sha256);
  return { rendered, selection: callbacks[0], final };
}
function observe(row, stage, data, state, availability = 'observed') {
  const digest = fingerprint(data);
  row.observations[stage] = { ref: `${row.case_id}-${stage}`, sha256: digest, availability, data,
    adjudications: state === null ? [] : [{ fact_id: 'F1', expectations_version: row.expectations.version,
      expectations_sha256: row.expectations.sha256, artifact_sha256: digest, state,
      ...(stage === 'package' ? { package_sha256: data.context.sha256 } : {}) }] };
}
function evaluate(row) {
  return buildStageEvidence({ version: 1, input_sha256: declaredHash, report_sha256: sha256('synthetic-report'),
    report_version: 'synthetic-v1', cases: [row] }).cases[0];
}

function runCase(definition) {
  const mode = definition.mode, op = fixture.operational;
  const source = mode === 'origin-absent' ? op.unrelated : op.source;
  const s = inputView(definition.id, source);
  const cwd = s.trusted.agentRoot;
  // Grader-only data is materialized separately after entry selection is fixed.
  const rubricFile = path.join(s.trusted.graderRoot, 'stage-rubric.json');
  write(rubricFile, { rubric: fixture.rubric, expected: definition.expected });
  const extractedText = ['origin-absent', 'extraction-omits'].includes(mode) ? op.unrelated
    : mode === 'paraphrase' ? op.paraphrase : op.extracted;
  let extraction = envelope(['empty', 'partial', 'blocked'].includes(mode) ? null : extractedText,
    ['partial', 'blocked'].includes(mode) ? mode : 'done');
  extraction = validateExtractionResult(extraction);
  const context = sourceContext(definition.id, source);
  if (mode === 'quarantined') {
    memory.writeFragment(cwd, { unit_id: 'T01', facts: [{ mem_id: 'MEM000', category: 'gotcha', text: op.unrelated }], stats: [] }, { milestoneId: context.milestoneId });
    const loose = memory.fragmentPath(cwd, 'T01', { milestoneId: context.milestoneId });
    fs.writeFileSync(path.join(memory.memoryDir(cwd), 'sweep-stage.md'), serializeGroup({ epoch: 'sweep-stage',
      units: [{ id: memory.qualifiedStorageKey('T01', context.milestoneId), content: fs.readFileSync(loose) }] }).buffer);
    fs.unlinkSync(loose);
  }
  if (mode === 'conflict') publish(cwd, envelope(op.contradiction), context);
  let publication = publish(cwd, extraction, context);
  if (mode === 'replay') publication = publish(cwd, extraction, context);
  let fragment = memory.readFragment(cwd, 'T01', { milestoneId: context.milestoneId });
  const memId = publication.mappings.fact || 'MEM001';
  const beforeReplacement = fragment?.facts.find(f => f.mem_id === memId);
  const oldContentHash = beforeReplacement ? sha256(beforeReplacement.text) : null;
  if (mode === 'replacement') {
    // The public writer rejects immutable replacements. Inject contradictory
    // persisted fixture bytes to exercise detection of an external substitution.
    rejects(() => memory.writeFragment(cwd, { ...fragment, facts: fragment.facts.map(f => ({ ...f, text: op.contradiction })) },
      { milestoneId: context.milestoneId }), 'MEMORY_FACT_CONFLICT');
    const file = memory.fragmentPath(cwd, 'T01', { milestoneId: context.milestoneId });
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(op.extracted, op.contradiction));
    fragment = memory.readFragment(cwd, 'T01', { milestoneId: context.milestoneId });
  }
  if (mode === 'candidate-cap') {
    for (let i = 0; i < 70; i++) memory.writeFragment(cwd, { unit_id: `T02.${i}`,
      facts: [{ mem_id: 'MEM001', category: 'gotcha', text: op.source, confidence_base: 0.99,
        created_at: context.extractedAt, source_unit: 'execute-task/T01' }], stats: [] }, { milestoneId: context.milestoneId });
  }
  const query = mode === 'no-query' ? '' : mode === 'no-match' ? 'galaxia cometa' : op.query;
  // The extraction source is eligible prework; the downstream task requests
  // retrieval rather than copying the source verbatim into the final package.
  const options = { description: 'Execute a tarefa sintetica com as memorias recuperadas.' };
  if (mode === 'budget') options.memoryMaxTokens = 11;
  if (mode === 'direct') options.memories = [op.source];
  const captured = render(cwd, query, options);
  const grader = JSON.parse(fs.readFileSync(rubricFile, 'utf8'));
  const fact = { fact_id: 'F1', milestone_id: context.milestoneId, unit_id: context.unitId, mem_id: memId };
  const expectations = { version: fixture.version, facts: [fact],
    planned: Object.fromEntries(STAGES.map(stage => [stage, definition.planned_unavailable.includes(stage) ? 'unavailable' : 'observed'])) };
  expectations.sha256 = fingerprint(expectations);
  const row = { case_id: definition.id, delivery_id: `delivery-${definition.id}`, family_id: 'synthetic-stage-family',
    split: 'adjustment', evidence_kind: 'synthetic', controls_sha256: fingerprint({ query, options }), expectations, observations: {} };
  observe(row, 'origin', { snapshot_sha256: sha256(source) }, mode === 'origin-absent' ? 'absent' : 'present');
  const extractionState = ['origin-absent', 'extraction-omits', 'empty', 'partial', 'blocked'].includes(mode) ? 'absent' : 'present';
  observe(row, 'extraction', { snapshot_sha256: fingerprint(extraction) }, extractionState,
    mode === 'extraction-unobserved' ? 'unavailable' : 'observed');
  const rereadFacts = fragment?.facts.map(f => ({ mem_id: f.mem_id, content_sha256: sha256(f.text) }));
  const data = { sourceContext: { milestoneId: context.milestoneId, unitId: context.unitId },
    status: publication.status, state: publication.state ? publication.state.map(f => ({ mem_id: f.mem_id })) : null,
    fragment: fragment ? { milestone_id: fragment.milestone_id, unit_id: fragment.unit_id, facts: rereadFacts } : null };
  if (publication.reason) data.reason = publication.status === 'conflict' ? publication.reason_code : publication.reason;
  observe(row, 'publication', data, mode === 'replacement' ? 'conflict' : extractionState);
  const selection = captured.selection;
  const selectionData = { source: { provider: selection.source.provider }, status: selection.status,
    reason: selection.reason, selected: selection.selected.map(f => ({ milestone_id: f.milestone_id,
      unit_id: f.unit_id, mem_id: f.mem_id })) };
  if (selection.diagnostic) selectionData.diagnostic = { candidates: selection.diagnostic.candidates.map(f => ({
    identity: f.identity, reasons: f.reasons })), omitted_candidates: selection.diagnostic.omitted_candidates };
  observe(row, 'selection', selectionData, mode === 'replacement' ? 'conflict' : 'present');
  // The final-text predicate is deliberately restricted to these supplied synthetic forms.
  // This consumes the rubric; it is not a general semantic evaluator.
  const finalText = captured.rendered.prompt;
  const packageState = finalText.includes(grader.rubric.contradiction) ? 'conflict'
    : finalText.includes(grader.rubric.fact) || finalText.includes(grader.rubric.paraphrase) ? 'present' : 'absent';
  observe(row, 'package', { context: { sha256: captured.final.context.sha256, bytes: captured.final.context.bytes } }, packageState);
  observe(row, 'answer', { available: mode !== 'answer-unavailable' }, mode === 'answer-omits' ? 'absent' : 'present');
  return { definition, s, row, captured, publication, oldContentHash, fragment, query, result: evaluate(row) };
}

try {
  process.env.FORGE_HOME = mkdir('profile');
  fs.writeFileSync(path.join(process.env.FORGE_HOME, 'forge-agent-prefs.jsonc'), '{}');
  const cases = fixture.cases.map(runCase);
  const find = id => cases.find(c => c.definition.id === id);
  const fact = c => c.result.facts[0];

  test('CHECK-WORKFLOW-PREDECLARED', () => {
    assert.equal(sha256(fs.readFileSync(fixtureFile)), declaredHash);
    assert.equal(cases.length, fixture.cases.length);
    const gap = find('extraction-unobserved');
    assert.equal(gap.row.expectations.planned.extraction, 'unavailable');
    assert.equal(gap.row.observations.extraction.availability, 'unavailable');
    assert.equal(fact(gap).stages.publication.state, 'present');
    const unexpected = structuredClone(find('all-present').row);
    unexpected.observations.extraction.availability = 'unavailable';
    assert.equal(unexpected.expectations.planned.extraction, 'observed');
    assert.equal(evaluate(unexpected).facts[0].stages.extraction.state, 'unknown');
  });
  test('CHECK-WORKFLOW-STAGES', () => {
    for (const c of cases) {
      const expected = c.definition.expected;
      assert.equal(c.publication.status, expected.publication, c.definition.id);
      if (expected.reason) assert.equal(c.publication.reason, expected.reason);
      assert.equal(fact(c).first_loss, expected.loss, `${c.definition.id}: first loss`);
      assert.equal(fact(c).stages.package.state, expected.package, `${c.definition.id}: package`);
      for (const observation of Object.values(c.row.observations)) assert.equal(fingerprint(observation.data), observation.sha256);
      assert.deepEqual(c.row.expectations.facts[0], { fact_id: 'F1', milestone_id: 'M001', unit_id: 'T01', mem_id: 'MEM001' });
      const boundary = c.result.boundaries.find(b => b.to === 'selection');
      assert.equal(boundary.denominator, fact(c).stages.publication.state === 'present' ? 1 : 0);
    }
    assert(find('publication-replay').fragment.facts.some(f => f.mem_id === 'MEM001'));
    assert.equal(fact(find('publication-quarantined')).stages.publication.state, 'absent');
    assert.equal(fact(find('publication-conflict')).stages.publication.state, 'conflict');
    const cap = find('diagnostic-candidate-cap');
    assert(cap.captured.selection.diagnostic.omitted_candidates > 0);
    const targetIdentity = find('all-present').captured.selection.selected[0].identity;
    assert(!cap.captured.selection.diagnostic.candidates.some(c => c.identity === targetIdentity));
    assert(!cap.captured.selection.selected.some(c => c.unit_id === 'T01' && c.mem_id === 'MEM001'));
    assert.equal(fact(cap).diagnostic.reason, 'reason_unknown');
  });
  test('CHECK-WORKFLOW-SELECTION-UNAVAILABLE', () => {
    const direct = find('direct-nonempty');
    assert.equal(direct.captured.selection.source.provider, 'direct');
    assert.equal(direct.captured.selection.status, 'selected');
    assert(direct.captured.rendered.prompt.includes(fixture.operational.source));
    assert.deepEqual(direct.captured.selection.selected, []);
    assert.equal(fact(direct).stages.selection.availability, 'unavailable');
    const noQuery = find('canonical-no-query');
    assert.equal(noQuery.captured.selection.reason, 'no-query');
    assert.equal(fact(noQuery).stages.selection.availability, 'unavailable');
    assert.equal(fact(find('published-not-selected')).stages.selection.state, 'absent');
    const budget = find('canonical-budget-cut');
    assert.equal(budget.captured.selection.source.provider, 'canonical');
    assert.equal(budget.captured.selection.reason, 'budget-exhausted-or-no-match');
    assert(budget.captured.selection.diagnostic.candidates.some(c => c.reasons.includes('ranking-budget')));
  });
  test('CHECK-WORKFLOW-PACKAGE-BINDING', () => {
    for (const c of cases) assert.equal(measure(c.captured.rendered.prompt).sha256, c.captured.final.context.sha256);
    const wrong = structuredClone(find('all-present').row);
    wrong.observations.package.adjudications[0].package_sha256 = sha256('different-final-text');
    assert.equal(evaluate(wrong).facts[0].stages.package.state, 'conflict');
    const truncated = structuredClone(find('all-present').row);
    truncated.observations.package.data.truncated = true;
    truncated.observations.package.sha256 = fingerprint(truncated.observations.package.data);
    truncated.observations.package.adjudications = [];
    assert.equal(evaluate(truncated).facts[0].stages.package.state, 'unknown');
    // Defensive cut supplied explicitly; never presented as canonical selection evidence.
    truncated.observations.selection.data.source.provider = 'override';
    truncated.observations.selection.sha256 = fingerprint(truncated.observations.selection.data);
    truncated.observations.selection.adjudications = [];
    assert.equal(evaluate(truncated).facts[0].stages.selection.availability, 'unavailable');
  });
  test('CHECK-WORKFLOW-PORTUGUESE', () => {
    assert.equal(fixture.rubric.review_status, 'pending-independent-semantic-review');
    const paraphrase = find('portuguese-paraphrase');
    assert.equal(fact(paraphrase).stages.extraction.state, 'present');
    assert.equal(fact(paraphrase).stages.publication.state, 'present');
    assert.equal(fact(paraphrase).stages.selection.state, 'absent');
    assert.equal(paraphrase.captured.selection.reason, 'no-match');
    assert.equal(paraphrase.captured.selection.diagnostic.stages.ranking.below_minimum_overlap, 1);
    const replacement = find('same-id-contradiction');
    assert.notEqual(sha256(replacement.fragment.facts[0].text), replacement.oldContentHash);
    assert.equal(replacement.fragment.facts[0].mem_id, 'MEM001');
    assert.equal(fact(replacement).stages.publication.state, 'conflict');
    assert.equal(fact(replacement).stages.package.state, 'absent');
    assert.equal(replacement.captured.selection.selected.length, 0);
  });
  test('CHECK-WORKFLOW-HELDOUT', () => {
    for (const c of cases) for (const text of [JSON.stringify(c.s.view), c.query,
      c.captured.selection.markdown || '', c.captured.rendered.prompt]) assert(!text.includes(sentinel));
    const s = find('all-present').s;
    const direct = structuredClone(s.manifest); direct.nodes[0].ref_id = 'expected';
    rejects(() => buildAgentView(s.corpus, direct, s.trusted), 'reference_not_prework');
    const transitive = structuredClone(s.manifest);
    transitive.nodes[0].dependencies = ['hop'];
    transitive.nodes.push({ id: 'hop', ref_id: 'expected', kind: 'memory', dependencies: [] });
    rejects(() => buildAgentView(s.corpus, transitive, s.trusted), 'reference_not_prework');
    const reserved = structuredClone(s.manifest); reserved.case_id = s.corpus.candidates[1].case_id;
    rejects(() => buildAgentView(s.corpus, reserved, s.trusted), 'reserved_case');
    const privatePath = structuredClone(s.corpus); privatePath.references[0].path = 'grader/private.txt';
    rejects(() => buildAgentView(privatePath, s.manifest, s.trusted), 'private_path');
  });
  test('CHECK-WORKFLOW-FINAL-ANSWER', () => {
    const omitted = fact(find('answer-omits')), unavailable = fact(find('answer-unavailable'));
    assert.equal(omitted.stages.package.state, 'present'); assert.equal(omitted.answer.usage, 'omitted');
    assert.equal(unavailable.stages.package.state, 'present'); assert.equal(unavailable.answer.usage, 'unavailable');
  });
  test('CHECK-WORKFLOW-EMPIRICAL-REUSE', () => {
    const s = find('all-present').s, owner = mkdir('fictional-owner');
    const milestone = 'M-20260101120000-stage';
    fs.mkdirSync(path.join(owner, '.gsd/milestones', milestone, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(owner, '.gsd/PROJECT.md'), '# Synthetic stage project');
    const catalog = structuredClone(s.corpus);
    catalog.references = catalog.references.map(({ path: ignored, bytes, sha256: digest, ...ref }) => ({ ...ref, state: 'missing' }));
    const captures = s.corpus.references.map(ref => ({ id: ref.id, ref_id: ref.id, root: 'synthetic', path: ref.path, type: 'local', format: 'raw' }));
    const trusted = { owner, milestone, capability: 'offline', roots: [{ id: 'synthetic', path: s.trusted.sourceRoot }] };
    // References shared across families are inappropriate for a collection split;
    // this minimum collection contains only the exposed synthetic adjustment family.
    catalog.candidates = catalog.candidates.slice(0, 1);
    const manifest = initCollection({ catalog, captures, freeze_id: 'stage-collection', reserved_count: 0 }, trusted);
    const collection = collectCorpus(manifest, trusted);
    const protocol = path.join(owner, '.gsd/milestones', milestone, 'evidence/protocol.md');
    fs.writeFileSync(protocol, 'Synthetic diagnostic protocol, not prospective enrollment.');
    const options = { owner, milestone, codeDir, collection: path.join(collection.private_root, 'collection.json'),
      protocol, revision: 'stage-v1', mode: 'diagnostic', synthetic: true,
      inputs: [{ graph: s.manifest, provenance: { before: s.trusted.before, prework: s.trusted.prework } }] };
    const frozen = freezeCorpus(options);
    const freezeFile = path.join(owner, '.gsd/milestones', milestone, 'evidence/freeze-stage-v1/freeze.json');
    assert(frozen.passed); assert.equal(frozen.comparative_ready, false);
    assert(!frozen.gaps.includes('agent_input_unverified'));
    assert.equal(verifyFreeze({ ...options, freezeFile }).baseline_digest, frozen.baseline_digest);
    const baseline = buildEmpiricalBaseline({ schema_version: 1, cases: [{ id: 'stage', sources: [] }] }, { roots: [owner], synthetic: true });
    const dimensions = ['functional', 'tests', 'uat', 'canonical_autonomy', 'exception', 'interruptions', 'interventions',
      'human_effort', 'duration', 'package_bytes', 'package_tokens', 'provider_input_tokens', 'provider_output_tokens', 'cost'];
    assert.deepEqual(Object.keys(baseline.cases[0].dimensions).sort(), [...dimensions].sort());
    assert.deepEqual(empirical.DIMENSIONS, dimensions);
    const procedure = createProcedureFixture();
    assert.equal(buildProcedureEvidence(procedure.after, procedure.after, { synthetic: true }).comparable, true);
    const variant = { ...procedure.after, variant: 'baseline' };
    const comparisonInput = { schema_version: 1, cases: [{ case_id: 'stage', variants: [variant, { ...structuredClone(variant), variant: 'current' }] }] };
    assert.equal(buildContextComparison(comparisonInput).cases[0].comparable, true);
    for (const field of ['input_sha256', 'template_sha256']) {
      const changed = structuredClone(comparisonInput); changed.cases[0].variants[1].conditions[field] = sha256(field);
      assert.equal(buildContextComparison(changed).cases[0].comparable, false);
    }
    const budgetChanged = structuredClone(comparisonInput);
    budgetChanged.cases[0].variants[1].final_evidence.budgets = { changed: 1 };
    assert.equal(buildContextComparison(budgetChanged).cases[0].comparable, false);
    const report = empirical.buildEmpiricalEvaluation({ schema_version: 1, kind: 'empirical-evaluation-input', sources: [], candidates: [], cases: [] }, { roots: [owner] });
    assert.equal(report.decision.apply_policy, false); assert.equal(report.comparative_ready, false); assert.equal(report.functional_gain, null);
    const stage = buildStageEvidence({ version: 1, input_sha256: declaredHash, report_sha256: fingerprint(report),
      report_version: 'v1', cases: cases.map(c => c.row) });
    assert.deepEqual(stage.dimensions, dimensions);
    assert.deepEqual(stage.strata, { synthetic: cases.length, historical: 0, real: 0 });
    assert.deepEqual(stage.real_families, []); assert.equal(stage.apply_policy, false);
  });
  test('CHECK-WORKFLOW-DIVERGENT-SOURCES', () => {
    const sourceRoot = mkdir('bounded-sources');
    const file = path.join(sourceRoot, 'source.txt'); fs.writeFileSync(file, 'original');
    const ref = { id: 'bounded', path: 'source.txt', sha256: sha256('original'), revision: 'v1',
      captured_at: '2026-01-01T00:00:00Z', timezone: 'UTC', synthetic: true };
    fs.writeFileSync(file, 'modified');
    rejects(() => empirical.readEvaluationSource(ref, [sourceRoot], { bytes: 0 }), 'source_hash_changed');
    fs.unlinkSync(file);
    assert.throws(() => empirical.readEvaluationSource(ref, [sourceRoot], { bytes: 0 }), error => /missing|unreadable|not_found/.test(error.code));
    fs.writeFileSync(file, Buffer.alloc(empirical.LIMITS.file_bytes + 1, 65));
    assert.throws(() => empirical.readEvaluationSource(ref, [sourceRoot], { bytes: 0 }), error => /large|bytes|limit/.test(error.code));
    fs.writeFileSync(file, Buffer.alloc(empirical.LIMITS.file_bytes, 65)); ref.sha256 = sha256(fs.readFileSync(file));
    const budget = { bytes: 0 };
    for (let i = 0; i < 8; i++) empirical.readEvaluationSource(ref, [sourceRoot], budget);
    rejects(() => empirical.readEvaluationSource(ref, [sourceRoot], budget), 'total_bytes_exceeded');
    const unknown = structuredClone(find('all-present').row);
    unknown.observations.origin.availability = 'unavailable';
    assert.equal(evaluate(unknown).facts[0].stages.origin.state, 'unknown');
    assert.equal(evaluate(unknown).facts[0].first_loss, 'unknown');
  });
  test('CHECK-WORKFLOW-INVARIANCE', () => {
    const c = find('all-present'), cwd = c.s.trusted.agentRoot;
    const before = snapshot(cwd);
    const results = [false, true, false].map(on => render(cwd, c.query,
      { description: 'Execute a tarefa sintetica com as memorias recuperadas.' }, on));
    function stable(final) {
      const { captured_at, ...rest } = final;
      assert.equal(typeof captured_at, 'string');
      assert.deepEqual(Object.keys(final).filter(key => !Object.hasOwn(rest, key)), ['captured_at']);
      assert(!Object.hasOwn(final, 'duration_ms')); // captureFinal, not sanitizeFinal
      return rest;
    }
    assert.notEqual(Date.parse(results[0].final.captured_at), now, 'new Date is not fixed by Date.now');
    assert.deepEqual(stable(results[0].final), stable(results[1].final));
    assert.deepEqual(stable(results[0].final), stable(results[2].final));
    assert.deepEqual(results.map(r => r.rendered.prompt), Array(3).fill(results[0].rendered.prompt));
    assert.deepEqual(results[0].selection.selected, results[1].selection.selected);
    assert.deepEqual(results[0].selection.selected, results[2].selection.selected);
    const { diagnostic, ...onSelection } = results[1].selection;
    assert(diagnostic); assert.deepEqual(onSelection, results[0].selection);
    const beforeEvidence = fingerprint(c.row);
    evaluate(c.row); evaluate(c.row);
    assert.equal(fingerprint(c.row), beforeEvidence);
    assert.deepEqual(snapshot(cwd), before);
    assert(!memory.readFragment(cwd, 'T01', { milestoneId: 'M001' }).stats.some(s => ['hit', 'exposure', 'confirm', 'utility'].includes(s.kind)));
    for (const result of results) assert.equal(result.final.provider_called, 'unknown');
    assert.equal(sha256(fs.readFileSync(fixtureFile)), declaredHash);
  });
  console.log(`${count} workflow checks passed; public synthetic seams only; no provider, semantic review or human UAT claimed`);
} finally {
  if (priorForgeHome === undefined) delete process.env.FORGE_HOME; else process.env.FORGE_HOME = priorForgeHome;
  if (path.dirname(root) !== tempParent || !path.basename(root).startsWith('forge-stage-workflow-')) throw new Error('invalid cleanup root');
  fs.rmSync(root, { recursive: true, force: true });
}
