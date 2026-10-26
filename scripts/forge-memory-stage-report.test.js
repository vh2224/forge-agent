#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildStageReport, renderStageReport } = require('./forge-memory-stage-report');
const { buildEmpiricalEvaluation, DIMENSIONS, LIMITS } = require('./forge-empirical-evaluation');
const { createProcedureFixture } = require('./forge-procedure-evidence');
const { STAGES } = require('./forge-memory-stage-evidence');
const { sha256, fingerprint } = require('./forge-delivery');

const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'forge-stage-report-'));
const cli = path.join(__dirname, 'forge-memory-stage-report.js');
const clone = value => JSON.parse(JSON.stringify(value));
const H = sha256('fixture');
const PRIVATE = 'SENTINELA_PRIVADA_NAO_PUBLICAR';
let sequence = 0;
let count = 0;
function check(name, fn) { fn(); count++; process.stdout.write(`ok ${count} - ${name}\n`); }
function write(area, id, data, kind) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
  fs.writeFileSync(path.join(area, `${id}.json`), buffer);
  return { id, path: `${id}.json`, sha256: sha256(buffer), bytes: buffer.length, revision: 'fixture-v1',
    captured_at: '2026-01-02T00:00:00Z', timezone: 'UTC', synthetic: true, ...(kind ? { kind } : {}) };
}
function fixture() {
  const area = path.join(root, `fixture-${sequence++}`); fs.mkdirSync(area);
  const controls = { version: 'v1', component_sha256: H, input_sha256: H, template_sha256: H,
    model: 'fixture-model', effort: 'medium', host: 'codex', transport: 'native', preparation: 'full',
    review: 'required', budgets: { context: 3000 }, memory_sha256: H, procedure_sha256: H };
  const observation = write(area, 'observations', { schema_version: 1, case_id: 'C1',
    observations: [{ id: 'functional-one', kind: 'functional', value: true, check_id: 'check-one', private_text: PRIVATE }] });
  const nested = { ...observation, format: 'observations', origin: 'synthetic' };
  delete nested.timezone; // Exerce o fallback de timezone e synthetic do baseline.
  const technical = createProcedureFixture();
  const evaluation = { schema_version: 1, kind: 'empirical-evaluation-input',
    sources: [write(area, 'baseline', { schema_version: 1, cases: [{ id: 'C1', delivery_id: 'D1',
      conditions: ['fixture'], sources: [nested] }] }, 'baseline'),
    write(area, 'outcome', { schema_version: 1, case_id: 'C1', status: 'completed',
      occurred_at: '2026-01-03T00:00:00Z', controls, baseline_controls: controls }, 'outcome'),
    write(area, 'context', { schema_version: 1, cases: [{ case_id: 'C1',
      variants: [{ ...technical.before, variant: 'baseline' }, { ...technical.after, variant: 'current' }] }] }, 'context-comparison'),
    write(area, 'procedure', { schema_version: 1, before: technical.before, after: technical.after }, 'procedure-evidence')],
    candidates: [{ id: 'candidate', arm: 'baseline', protocol_source: 'unavailable-protocol' }],
    cases: [{ id: 'C1', delivery_id: 'D1', family_id: 'one-family', candidate_id: 'candidate',
      split: 'historical-diagnostic', evidence_type: 'synthetic', synthetic: true,
      baseline_source: 'baseline', baseline_case_id: 'C1', outcome_source: 'outcome',
      context_source: 'context', procedure_source: 'procedure' }] };
  const expectations = { version: 'v1', facts: [{ fact_id: 'F1', milestone_id: 'M1', unit_id: 'T1', mem_id: 'MEM1' }],
    planned: Object.fromEntries(STAGES.map(stage => [stage, 'observed'])) };
  expectations.sha256 = fingerprint(expectations);
  const snapshots = { origin: { snapshot_sha256: H }, extraction: { snapshot_sha256: H },
    publication: { sourceContext: { milestoneId: 'M1', unitId: 'T1' }, status: 'written', state: [{ mem_id: 'MEM1' }] },
    selection: { source: { provider: 'canonical' }, status: 'selected', reason: 'canonical-match',
      selected: [{ milestone_id: 'M1', unit_id: 'T1', mem_id: 'MEM1' }], markdown: PRIVATE },
    package: { context: { sha256: H } }, answer: { available: false } };
  const observations = Object.fromEntries(Object.entries(snapshots).map(([stage, data]) => [stage, {
    ref: `${stage}-snapshot`, sha256: fingerprint(data), availability: 'observed', data,
    adjudications: [{ fact_id: 'F1', expectations_version: 'v1', expectations_sha256: expectations.sha256,
      artifact_sha256: fingerprint(data), state: 'present', ...(stage === 'package' ? { package_sha256: H } : {}) }] }]));
  const supplement = { version: 1, input_sha256: H, report_sha256: H, report_version: '1', cases: [{
    case_id: 'C1', delivery_id: 'D1', family_id: 'one-family', split: 'historical-diagnostic', evidence_kind: 'synthetic',
    controls_sha256: fingerprint(controls), expectations, observations }] };
  const findings = { schema_version: 1, kind: 'owner-literal-findings', findings: [
    ...Array.from({ length: 5 }, (_, i) => ({ artifact: 'slices/S03/S03-REVIEW.md', id: `R${i + 1}`,
      literal_state: 'All five S03 findings remain pending.' })),
    ...[215, 216, 214, 217, 218, 219].map((issue, i) => ({ artifact: 'slices/S04/S04-REVIEW.md', id: `R${i + 1}`,
      issue, literal_state: i === 5 ? 'Abertas — triagem final' : 'Concedidas — correção pendente',
      errata_source: 'evidence/summary-errata.md' }))] };
  const input = { schema_version: 1, kind: 'memory-stage-report-input', evaluation: null, supplement: null,
    findings: write(area, 'findings', findings), source_notes: write(area, 'notes', { private_text: PRIVATE }), documentary_sources: [] };
  function refresh() {
    input.evaluation = write(area, 'evaluation', evaluation);
    supplement.input_sha256 = fingerprint(evaluation);
    supplement.report_sha256 = fingerprint(buildEmpiricalEvaluation(evaluation, { roots: [area] }));
    input.supplement = write(area, 'supplement', supplement);
  }
  refresh();
  return { area, input, evaluation, supplement, findings, controls, nested, refresh,
    report: () => buildStageReport(input, { roots: [area] }) };
}
function cliRun(s, extra = [], overrides = {}) {
  const ref = write(s.area, 'input', s.input);
  return spawnSync(process.execPath, [cli, '--input', path.join(s.area, ref.path), '--sha256', overrides.hash || ref.sha256,
    '--root', s.area, ...extra], { encoding: 'utf8', windowsHide: true, maxBuffer: 2 * LIMITS.file_bytes });
}
function reseal(s, stage) {
  const observation = s.supplement.cases[0].observations[stage];
  observation.sha256 = fingerprint(observation.data);
  for (const item of observation.adjudications) item.artifact_sha256 = observation.sha256;
  s.refresh();
}

try {
  check('CHECK-REPORT-CANONICAL-JOIN', () => {
    const s = fixture(); const canonical = buildEmpiricalEvaluation(s.evaluation, { roots: [s.area] });
    const report = s.report();
    assert.equal(JSON.stringify(report.evaluation.cases[0].dimensions), JSON.stringify(canonical.cases[0].dimensions));
    assert.deepEqual(Object.keys(report.evaluation.cases[0].dimensions), DIMENSIONS);
    assert.equal(DIMENSIONS.length, 14);
    assert.equal(report.evaluation.cases[0].dimensions.functional.value, true, JSON.stringify(report.evaluation.diagnostics));
    assert.equal(report.joins[0].identity, 'bound'); assert.equal(report.joins[0].controls, 'bound');
    for (const id of ['baseline', 'context', 'procedure', 'observations']) assert(report.sources.some(row => row.id === id && row.available));
    s.supplement.cases[0].controls_sha256 = sha256('divergent'); s.refresh();
    assert.equal(s.report().joins[0].controls, 'conflict');
    assert.equal(s.report().joins[0].evidence_eligible, false);
    s.supplement.cases[0].delivery_id = 'another-delivery'; s.refresh();
    assert.equal(s.report().joins[0].identity, 'conflict');
    s.supplement.report_version = 'different'; s.refresh();
    assert.equal(s.report().joins[0].identity, 'conflict');
  });

  check('CHECK-REPORT-BUDGET', () => {
    const s = fixture();
    let expected = Buffer.byteLength(JSON.stringify(s.input));
    for (const ref of [s.input.evaluation, ...s.evaluation.sources, s.nested, s.input.supplement, s.input.findings, s.input.source_notes]) {
      expected += fs.statSync(path.join(s.area, ref.path)).size;
    }
    assert.equal(s.report().budget.bytes, expected);
    // 8 MiB compartilhados: grande parte no suplemento, mantendo nested baseline.
    for (let i = 0; i < 8; i++) s.input.documentary_sources.push(write(s.area, `padding-${i}`, Buffer.alloc(i === 7 ? 1 : LIMITS.file_bytes, 32)));
    let report = s.report();
    const last = s.input.documentary_sources[7];
    let length = LIMITS.total_bytes - 64 - report.budget.bytes + last.bytes;
    Object.assign(last, write(s.area, 'padding-7', Buffer.alloc(length, 32)));
    report = s.report(); length += LIMITS.total_bytes - 64 - report.budget.bytes;
    Object.assign(last, write(s.area, 'padding-7', Buffer.alloc(length, 32)));
    report = s.report();
    assert.equal(report.budget.bytes, LIMITS.total_bytes - 64);
    assert.equal(report.evaluation.cases.length, 1); assert.equal(report.supplement.cases[0].facts.length, 1);
    Object.assign(last, write(s.area, 'padding-7', Buffer.alloc(length + 65, 32)));
    assert.throws(s.report, error => error.code === 'total_bytes_exceeded');
    // Avaliador deliberadamente inválido: excesso precisa vencer antes de chamá-lo.
    s.evaluation.candidates[0].arm = 'not-an-arm'; s.input.evaluation = write(s.area, 'evaluation', s.evaluation);
    assert.throws(s.report, error => error.code === 'total_bytes_exceeded');
    const child = cliRun(s); assert.equal(child.status, 2); assert.match(child.stderr, /total_bytes_exceeded/);
  });

  check('CHECK-REPORT-STRATA', () => {
    const s = fixture();
    s.evaluation.cases.push({ ...clone(s.evaluation.cases[0]), id: 'C2', synthetic: false, evidence_type: 'historical',
      baseline_source: 'unavailable-baseline', outcome_source: 'unavailable-outcome', context_source: undefined, procedure_source: undefined });
    s.supplement.cases.push({ ...clone(s.supplement.cases[0]), case_id: 'C2', evidence_kind: 'historical' }); s.refresh();
    const report = s.report();
    assert.deepEqual(report.strata, { synthetic: 1, historical: 1, eligible_real: 0 });
    assert.deepEqual(report.real_families, ['one-family']);
    assert.equal(report.prospective_cases, 0); assert.equal(report.apply_policy, false);
    assert.equal(report.comparative_ready, false); assert.equal(report.functional_gain, null);
    assert.equal(report.supplement.cases[0].facts[0].stages.package.state, 'present');
    assert.equal(report.supplement.cases[0].facts[0].answer.usage, 'unavailable');
    const version = clone(s.evaluation.cases[1]); version.id = 'C3'; s.evaluation.cases.push(version); s.refresh();
    assert.equal(s.report().real_families.length, 1); assert.equal(s.report().strata.eligible_real, 0);
  });

  check('CHECK-REPORT-UNKNOWN', () => {
    for (const fault of ['missing', 'hash', 'oversize']) {
      const s = fixture(); const ref = s.evaluation.sources[0];
      if (fault === 'missing') fs.unlinkSync(path.join(s.area, ref.path));
      if (fault === 'hash') fs.appendFileSync(path.join(s.area, ref.path), ' ');
      if (fault === 'oversize') fs.writeFileSync(path.join(s.area, ref.path), Buffer.alloc(LIMITS.file_bytes + 1));
      s.refresh(); const report = s.report();
      assert.equal(report.evaluation.cases.length, 1); assert.equal(report.evaluation.cases[0].dimensions.functional.state, 'unknown');
      assert(report.diagnostics.some(row => row.source_id === 'baseline'));
    }
    const s = fixture();
    s.supplement.cases[0].observations.selection.data.source.provider = 'direct'; reseal(s, 'selection');
    assert.equal(s.report().availability[0].selection, 'unavailable');
    assert.equal(s.report().supplement.cases[0].facts[0].stages.selection.state, 'unknown');
    s.supplement.cases[0].observations.selection.data = { source: { provider: 'canonical' }, status: 'empty', reason: 'no-match', selected: [] }; reseal(s, 'selection');
    assert.equal(s.report().availability[0].selection, 'observed');
    assert.equal(s.report().supplement.cases[0].facts[0].stages.selection.state, 'absent');
    s.supplement.cases[0].expectations.facts = []; s.supplement.cases[0].expectations.version = 'unavailable-v1';
    s.supplement.cases[0].observations = {}; s.refresh();
    assert.equal(s.report().availability[0].inventory, 'unavailable');
    assert.equal(s.report().availability[0].answer, 'unavailable');
    assert(s.report().supplement.cases[0].boundaries.every(row => row.retention_rate === null));
    fs.unlinkSync(path.join(s.area, s.input.supplement.path));
    assert.equal(s.report().availability[0].inventory, 'unavailable');
    assert.equal(s.report().evaluation.cases.length, 1);
    const missingControls = fixture(); const outcome = missingControls.evaluation.sources.find(row => row.id === 'outcome');
    Object.assign(outcome, write(missingControls.area, 'outcome', { schema_version: 1, case_id: 'C1' }, 'outcome'));
    missingControls.refresh(); assert.equal(missingControls.report().joins[0].controls, 'unavailable');
  });

  check('CHECK-REPORT-PRIVACY', () => {
    const s = fixture();
    const pins = fs.readdirSync(s.area).map(file => [file, sha256(fs.readFileSync(path.join(s.area, file)))]);
    const report = s.report(); const rendered = JSON.stringify(report) + renderStageReport(report);
    assert(!rendered.includes(PRIVATE)); assert(!rendered.includes(s.area));
    assert(!rendered.includes('markdown')); assert(!rendered.includes('private_text'));
    for (const [file, hash] of pins) assert.equal(sha256(fs.readFileSync(path.join(s.area, file))), hash);
    const child = cliRun(s, [], { hash: sha256('wrong') });
    assert.equal(child.status, 2); assert.equal(child.stdout, '');
    assert(!child.stderr.includes(PRIVATE)); assert(!child.stderr.includes(s.area));
    s.input.roots = [s.area]; assert.throws(s.report, error => error.code === 'unknown_fields');
  });

  check('CHECK-REPORT-REPLAY-METRIC-SCHEMA', () => {
    function replay(s, patch) {
      const canonical = buildEmpiricalEvaluation(s.evaluation, { roots: [s.area] });
      const dimensions = clone(canonical.cases[0].dimensions);
      Object.assign(dimensions.functional, patch);
      const body = { schema_version: 1, cases: [{ id: 'C1', delivery_id: 'D1', dimensions, diagnostics: [] }] };
      Object.assign(s.evaluation.sources[0], write(s.area, 'baseline', { ...body, digest: fingerprint(body) }, 'baseline-report'));
      s.refresh();
      return dimensions;
    }
    for (const patch of [
      { coverage: { raw: PRIVATE, path: 'C:/Users/private/response.txt' } },
      { coverage: PRIVATE + ' C:/Users/private/response.txt' },
      { references: [{ pointer: { raw: PRIVATE, path: 'C:/Users/private/response.txt' } }] },
      { references: [{ origin: [PRIVATE, 'C:/Users/private/response.txt'] }] },
      { references: [{ sha256: 'invalid' }] }, { references: [{ synthetic: {} }] },
      { limitations: [{ pointer: [PRIVATE, 'C:/Users/private/response.txt'] }] },
      { conditions: [{ origin: { raw: PRIVATE } }] }, { coverage: -1 }, { coverage: 1.1 },
      { references: [{ source_index: {} }] },
      { numerator: -1 }, { denominator: 0.5 }, { conditions: {} },
    ]) {
      const s = fixture(); replay(s, patch);
      assert.throws(s.report, error => error.code === 'presentation_invalid');
      const child = cliRun(s);
      assert.equal(child.status, 2); assert.equal(child.stdout, '');
      assert(!child.stderr.includes(PRIVATE)); assert(!child.stderr.includes('C:/Users/private'));
    }
    for (const coverage of [null, 0, 0.5, 1, 'none', 'partial', 'provided_sources_only']) {
      const s = fixture(); const dimensions = replay(s, { coverage, value: true, numerator: 1, denominator: 2,
        references: [{ id: 'safe', path: 'evidence/safe.json', sha256: H, pointer: '/observations/0',
          revision: 'v1', synthetic: true, origin: 'synthetic' },
        { source: 'owner:evidence/events.jsonl', sha256: H, source_kind: 'events', source_index: 0, line: 1 }] });
      assert.deepEqual(s.report().evaluation.cases[0].dimensions, dimensions);
    }
    for (const value of [null, false, 0, 0.5, 12]) {
      const s = fixture(); const dimensions = replay(s, { value });
      assert.deepEqual(s.report().evaluation.cases[0].dimensions, dimensions);
    }
  });

  check('CHECK-REPORT-CLI-BOUNDS', () => {
    const s = fixture();
    for (const extra of [['--input', 'duplicate'], ['--sha256', H], ['--markdown', '--markdown'], ['--invalid'], ['--root']]) {
      const child = cliRun(s, extra); assert.equal(child.status, 2); assert.equal(child.stdout, '');
    }
    assert.equal(cliRun(s, [], { hash: H }).status, 2);
    for (const invalid of ['../escape.json', 'source.json:ads', '/absolute.json']) {
      const saved = s.input.supplement.path; s.input.supplement.path = invalid;
      assert.equal(cliRun(s).status, 2); s.input.supplement.path = saved;
    }
    s.input.supplement.authorized = true; assert.equal(cliRun(s).status, 2); delete s.input.supplement.authorized;
    const link = path.join(s.area, 'link');
    try { fs.symlinkSync(s.area, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error;
      process.stdout.write('limitação de plataforma: criação de link indisponível; subcaso não verificado\n'); return;
    }
    const ref = write(s.area, 'input', s.input);
    const child = spawnSync(process.execPath, [cli, '--root', link, '--input', path.join(link, ref.path), '--sha256', ref.sha256], { encoding: 'utf8' });
    assert.equal(child.status, 2); assert.equal(child.stdout, '');
  });

  check('CHECK-REPORT-REPLAY', () => {
    const s = fixture();
    const first = cliRun(s); const second = cliRun(s); assert.equal(first.status, 0); assert.equal(second.status, 0);
    assert.equal(first.stdout, second.stdout);
    const md1 = cliRun(s, ['--markdown']); const md2 = cliRun(s, ['--markdown']);
    assert.equal(md1.status, 0); assert.equal(md1.stdout, md2.stdout);
    const report = JSON.parse(first.stdout);
    assert(!JSON.stringify(report).includes('captured_at')); assert(!JSON.stringify(report).includes('generated_at'));
    assert(!JSON.stringify(report).includes('2026-01-02T'));
    const originalHash = s.input.supplement.sha256; fs.appendFileSync(path.join(s.area, s.input.supplement.path), ' ');
    const changed = cliRun(s); assert.equal(changed.status, 0);
    assert(JSON.parse(changed.stdout).diagnostics.some(row => row.code === 'source_hash_changed'));
    assert.equal(s.input.supplement.sha256, originalHash);
  });

  // O staging é opcional em clones novos; neste replay validamos seus bytes reais.
  const staging = path.resolve(__dirname, '../do-not-commit/empirical-memory-ci/S07');
  if (fs.existsSync(path.join(staging, 'handoff.json'))) {
    check('CHECK-REPORT-HANDOFF', () => {
      const handoff = JSON.parse(fs.readFileSync(path.join(staging, 'handoff.json'), 'utf8'));
      function validateHandoff(value) {
        assert.equal(value.kind, 'memory-stage-report-handoff');
        assert.equal(value.root_id, 'primary');
        assert.equal(value.case_id, 'forge-442-memory-release-ci');
        assert.equal(value.family_id, 'forge-engineering-memory-release-ci');
        for (const filename of ['report.json', 'report.md']) {
          const expected = 'do-not-commit/empirical-memory-ci/S07/' + filename;
          const rows = value.outputs.filter(row => row.path === expected);
          assert.equal(rows.length, 1);
          const bytes = fs.readFileSync(path.join(staging, filename));
          assert.equal(rows[0].root_id, 'primary');
          assert.equal(rows[0].sha256, sha256(bytes));
          assert.equal(rows[0].bytes, bytes.length);
          assert.equal(rows[0].proposed_owner_destination, 'evidence/s07/report/' + filename);
          if (filename === 'report.json') {
            const report = JSON.parse(bytes);
            assert.equal(report.evaluation.cases[0].id, value.case_id);
            assert.deepEqual(report.real_families, [value.family_id]);
          }
        }
      }
      validateHandoff(handoff);
      const badHash = clone(handoff);
      badHash.outputs.find(row => row.path.endsWith('/report.json')).sha256 = H;
      assert.throws(() => validateHandoff(badHash));
      const badDestination = clone(handoff);
      badDestination.outputs.find(row => row.path.endsWith('/report.json')).proposed_owner_destination = 'outro/report.json';
      assert.throws(() => validateHandoff(badDestination));
      const badIdentity = clone(handoff); badIdentity.case_id = 'outro-caso';
      assert.throws(() => validateHandoff(badIdentity));
    });
  } else {
    process.stdout.write('limitação: handoff real ausente; CHECK-REPORT-HANDOFF não executado\n');
  }

  check('CHECK-REPORT-PENDING-FINDINGS', () => {
    const s = fixture(); const report = s.report(); assert.equal(report.findings.length, 11);
    for (const source of s.findings.findings) {
      const row = report.findings.find(item => item.artifact === source.artifact && item.id === source.id);
      assert.equal(row.literal_state, source.literal_state); assert.equal(row.issue, source.issue);
    }
    assert.equal(report.findings.filter(row => row.id === 'R1').length, 2);
    assert.deepEqual(report.findings.filter(row => row.artifact.includes('S04')).map(row => row.issue), [215, 216, 214, 217, 218, 219]);
    assert.equal(report.review.source_review, 'pending');
    assert(!renderStageReport(report).includes('CHECK-CASE-SOURCE-REVIEW aprovado'));
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
