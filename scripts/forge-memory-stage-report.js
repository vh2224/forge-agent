#!/usr/bin/env node
'use strict';

// Projeção somente leitura. Somente o caller concede autoridade sobre roots.
const fs = require('fs');
const path = require('path');
const empirical = require('./forge-empirical-evaluation');
const { buildStageEvidence, STAGES } = require('./forge-memory-stage-evidence');
const { fingerprint } = require('./forge-delivery');
const { closed, checkedPath, relativePath, fail } = require('./forge-empirical-sources');
const { LIMITS, DIMENSIONS, readEvaluationSource, buildEmpiricalEvaluation } = empirical;
const HASH = /^[a-f0-9]{64}$/;
const LABEL = /^[A-Za-z0-9_.:-]{1,160}$/;
const REF_KEYS = ['id', 'path', 'sha256', 'bytes', 'revision', 'captured_at', 'timezone', 'synthetic', 'kind', 'reference',
  'format', 'origin', 'component'];
const LIMITATIONS = [
  'Projeção atual retrospectiva; hashes não autenticam cronologia, consentimento ou significado.',
  'Candidate e arm são slots de apresentação; não comprovam inscrição nem execução.',
  'Inventário histórico indisponível difere de inventário observado vazio; taxas sem denominador são null.',
  'Controles desconhecidos não se tornam completos por possuir hash de um descritor.',
  'Presença no pacote e uso correto na resposta são observações independentes.',
  'Uma família real não demonstra eficácia; nenhuma execução prospectiva é reconstruída.',
  'Issues abertas não demonstram ausência de reparo local; findings conservam seu estado literal.',
  'S09 deve atualizar comparações no candidato final reparado; S06 não foi ativado nem calibrado.',
  '#228/#229 e #220–#231 conservam os limites das fontes; causas históricas e modelos não observados são unknown.',
  'Staging local não comprova CI hospedado, merge, instalação, release ou UAT.',
];

function safeText(value) {
  if (typeof value !== 'string' || value.length > 1000 || /[\x00-\x1f\x7f<>`|\\]/.test(value)
      || /(?:[A-Za-z]:[/\\]|\/Users\/|\/home\/|https?:\/\/)/i.test(value)) fail('presentation_invalid');
  return value;
}
function referenceView(ref, available, code = null) {
  return { id: ref.id, sha256: ref.sha256, revision: ref.revision, synthetic: ref.synthetic,
    available, code };
}
function readRef(ref, roots, budget, provenance, diagnostics, required = false) {
  closed(ref, REF_KEYS);
  relativePath(ref.path);
  try {
    const read = readEvaluationSource(ref, roots, budget);
    if (ref.bytes !== undefined && ref.bytes !== read.buffer.length) fail('source_bytes_changed');
    provenance.push(referenceView(ref, true));
    return read.buffer;
  } catch (error) {
    // Não exportar paths nem mensagens de IO. Falha cumulativa nunca vira gap.
    const code = typeof error.code === 'string' && /^[a-z_]{1,80}$/.test(error.code) ? error.code : 'source_invalid';
    if (['total_bytes_exceeded', 'path_link_or_special', 'path_identity_changed', 'symlink_escape',
      'source_identity_invalid', 'path_invalid', 'source_outside_roots'].includes(code) || required) fail(code);
    provenance.push(referenceView(ref, false, code));
    diagnostics.push({ source_id: LABEL.test(ref.id || '') ? ref.id : null, code });
    return null;
  }
}
function parse(buffer) {
  try { return JSON.parse(buffer.toString('utf8')); } catch (_) { fail('source_json_invalid'); }
}
function optionalJSON(ref, roots, budget, provenance, diagnostics) {
  const buffer = readRef(ref, roots, budget, provenance, diagnostics);
  if (!buffer) return null;
  try { return parse(buffer); } catch (_) {
    diagnostics.push({ source_id: ref.id, code: 'source_json_invalid' }); return null;
  }
}
function checkDimensions(dimensions) {
  // Preservar os bytes canônicos: dados não publicáveis são recusados, não editados.
  const keys = ['value', 'unit', 'state', 'method', 'numerator', 'denominator', 'references', 'limitations',
    'confidence', 'conditions', 'coverage'];
  const typedObject = (value, allowed) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        || Object.keys(value).some(key => !allowed.includes(key))) fail('presentation_invalid');
  };
  typedObject(dimensions, DIMENSIONS);
  for (const name of DIMENSIONS) {
    const metric = dimensions[name]; typedObject(metric, keys);
    if (metric.value !== null && typeof metric.value !== 'boolean'
        && (typeof metric.value !== 'number' || !Number.isFinite(metric.value))) fail('presentation_invalid');
    for (const field of ['numerator', 'denominator']) {
      if (metric[field] !== null && (!Number.isSafeInteger(metric[field]) || metric[field] < 0)) fail('presentation_invalid');
    }
    if (Object.hasOwn(metric, 'coverage') && metric.coverage !== null
        && !['none', 'partial', 'provided_sources_only'].includes(metric.coverage)
        && (typeof metric.coverage !== 'number' || !Number.isFinite(metric.coverage)
          || metric.coverage < 0 || metric.coverage > 1)) fail('presentation_invalid');
    for (const field of ['unit', 'state', 'method', 'confidence']) if (metric[field] !== undefined) safeText(metric[field]);
    for (const field of ['references', 'limitations', 'conditions']) {
      if (Object.hasOwn(metric, field) && !Array.isArray(metric[field])) fail('presentation_invalid');
      for (const item of metric[field] || []) {
        if (typeof item === 'string') { safeText(item); }
        else {
          typedObject(item, ['id', 'source_id', 'path', 'sha256', 'pointer', 'revision', 'synthetic', 'origin',
            'source', 'source_kind', 'source_index', 'line']);
          for (const [key, value] of Object.entries(item)) {
            if (key === 'synthetic') {
              if (typeof value !== 'boolean') fail('presentation_invalid');
            } else if (['source_index', 'line'].includes(key)) {
              if (!Number.isSafeInteger(value) || value < 0) fail('presentation_invalid');
            } else {
              safeText(value);
              if (key === 'sha256' && !HASH.test(value)) fail('presentation_invalid');
              if (key === 'path') {
                try { relativePath(value); } catch (_) { fail('presentation_invalid'); }
              }
            }
          }
        }
      }
    }
  }
}
function findingsView(data) {
  if (!data) return [];
  closed(data, ['schema_version', 'kind', 'findings']);
  if (data.schema_version !== 1 || data.kind !== 'owner-literal-findings'
      || !Array.isArray(data.findings) || data.findings.length > 100) fail('findings_invalid');
  const seen = new Set();
  return data.findings.map(row => {
    closed(row, ['artifact', 'id', 'label', 'literal_state', 'current_continuity', 'state_source',
      'issue', 'errata_source', 'disagreement_preserved']);
    relativePath(row.artifact);
    if (!LABEL.test(row.id) || seen.has(`${row.artifact}::${row.id}`)) fail('finding_identity_invalid');
    seen.add(`${row.artifact}::${row.id}`);
    const result = { artifact: row.artifact, id: row.id, literal_state: safeText(row.literal_state) };
    for (const field of ['state_source', 'errata_source']) if (row[field] !== undefined) {
      safeText(row[field]); relativePath(row[field].replace(/:\d+$/, '')); result[field] = row[field];
    }
    if (row.issue !== undefined) {
      if (!Number.isSafeInteger(row.issue) || row.issue < 1) fail('finding_issue_invalid'); result.issue = row.issue;
    }
    if (row.disagreement_preserved !== undefined) {
      if (typeof row.disagreement_preserved !== 'boolean') fail('findings_invalid');
      result.disagreement_preserved = row.disagreement_preserved;
    }
    return result;
  });
}
function unavailableStage(input, report) {
  return { version: 1, input_sha256: fingerprint(input), report_sha256: fingerprint(report), report_version: '1',
    cases: report.cases.map(row => {
      const expectations = { version: 'unavailable-v1', facts: [],
        planned: Object.fromEntries(STAGES.map(stage => [stage, 'unavailable'])) };
      return { case_id: row.id, delivery_id: row.delivery_id, family_id: row.family_id, split: row.split,
        evidence_kind: row.synthetic ? 'synthetic' : row.evidence_type === 'historical' ? 'historical' : 'real',
        controls_sha256: fingerprint({ availability: 'unknown' }),
        expectations: { ...expectations, sha256: fingerprint(expectations) }, observations: {} };
    }) };
}

function buildReport(input, roots, budget, provenance, diagnostics) {
  closed(input, ['schema_version', 'kind', 'evaluation', 'supplement', 'findings', 'source_notes', 'documentary_sources']);
  if (input.schema_version !== 1 || input.kind !== 'memory-stage-report-input'
      || !Array.isArray(input.documentary_sources) || input.documentary_sources.length > LIMITS.sources) fail('report_input_invalid');
  const evaluationInput = parse(readRef(input.evaluation, roots, budget, provenance, diagnostics, true));
  if (!Array.isArray(evaluationInput.sources) || evaluationInput.sources.length > LIMITS.sources) fail('evaluation_input_invalid');
  // C10: antecipar todas as leituras do avaliador, inclusive baseline aninhado.
  for (const ref of evaluationInput.sources) {
    const data = optionalJSON(ref, roots, budget, provenance, diagnostics);
    if (ref.kind === 'baseline' && data && Array.isArray(data.cases)) {
      if (data.cases.length > LIMITS.cases) fail('baseline_cases_invalid');
      for (const row of data.cases) {
        if (row.input || row.autonomy || !Array.isArray(row.sources) || row.sources.length > LIMITS.sources) continue;
        for (const nested of row.sources) readRef({ ...nested, synthetic: ref.synthetic,
          timezone: nested.timezone || ref.timezone }, roots, budget, provenance, diagnostics);
      }
    }
  }
  const stageInput = optionalJSON(input.supplement, roots, budget, provenance, diagnostics);
  const findingInput = optionalJSON(input.findings, roots, budget, provenance, diagnostics);
  // Notas e fontes documentais são somente pins: não exportar prosa/contexto bruto.
  readRef(input.source_notes, roots, budget, provenance, diagnostics);
  for (const ref of input.documentary_sources) readRef(ref, roots, budget, provenance, diagnostics);
  // O budget interno do avaliador relê apenas o subconjunto acima; não concede
  // outra cota ao relatório. Todo excesso compartilhado já falhou antes daqui.
  const evaluation = buildEmpiricalEvaluation(evaluationInput, { roots });
  const rawStage = stageInput || unavailableStage(evaluationInput, evaluation);
  const supplement = buildStageEvidence(rawStage);
  const reportBound = rawStage.input_sha256 === fingerprint(evaluationInput)
    && rawStage.report_sha256 === fingerprint(evaluation) && rawStage.report_version === String(evaluation.schema_version);
  const joins = supplement.cases.map(row => {
    const canonical = evaluation.cases.find(item => item.id === row.case_id);
    const identity = canonical && canonical.delivery_id === row.delivery_id && canonical.family_id === row.family_id
      && canonical.split === row.split && (canonical.synthetic ? 'synthetic' : canonical.evidence_type === 'historical' ? 'historical' : 'real') === row.evidence_kind;
    const controls = canonical?.outcome?.controls;
    return { case_id: row.case_id, identity: identity && reportBound ? 'bound' : 'conflict',
      controls: controls ? fingerprint(controls) === row.controls_sha256 ? 'bound' : 'conflict' : 'unavailable',
      evidence_eligible: Boolean(identity && reportBound && canonical.eligible && controls
        && fingerprint(controls) === row.controls_sha256) };
  });
  for (const row of evaluation.cases) {
    checkDimensions(row.dimensions);
    if (!supplement.cases.some(item => item.case_id === row.id)) {
      joins.push({ case_id: row.id, identity: 'unavailable', controls: 'unavailable', evidence_eligible: false });
    }
  }
  const availability = rawStage.cases.map(row => ({ case_id: row.case_id,
    inventory: row.expectations.facts.length ? 'observed' : row.evidence_kind === 'historical'
      || row.expectations.version.includes('unavailable') ? 'unavailable' : 'observed-empty',
    selection: row.observations.selection && row.observations.selection.availability === 'observed'
      && row.observations.selection.data.source.provider === 'canonical'
      && ['selected', 'empty', 'partial'].includes(row.observations.selection.data.status)
      && ['canonical-match', 'no-match', 'budget-exhausted-or-no-match'].includes(row.observations.selection.data.reason) ? 'observed' : 'unavailable',
    answer: row.observations.answer?.availability === 'observed' && row.observations.answer.data.available ? 'observed' : 'unavailable' }));
  const result = { schema_version: 1, kind: 'memory-stage-report', report_version: '1',
    apply_policy: false, comparative_ready: false, functional_gain: null,
    prospective_cases: evaluation.prospective_cases,
    real_families: [...new Set(evaluation.cases.filter(row => !row.synthetic).map(row => row.family_id))].sort(),
    strata: { synthetic: evaluation.cases.filter(row => row.synthetic).length,
      historical: evaluation.cases.filter(row => !row.synthetic && row.evidence_type === 'historical').length,
      eligible_real: new Set(evaluation.cases.filter(row => !row.synthetic && row.eligible).map(row => row.delivery_id)).size },
    evaluation: { schema_version: evaluation.schema_version, input_sha256: fingerprint(evaluationInput),
      report_sha256: fingerprint(evaluation), dimensions: [...DIMENSIONS], cases: evaluation.cases.map(row => ({
        id: row.id, delivery_id: row.delivery_id, family_id: row.family_id, candidate_id: row.candidate_id,
        arm: row.arm, split: row.split, synthetic: row.synthetic, eligible: row.eligible,
        exclusions: row.exclusions, dimensions: row.dimensions })), diagnostics: evaluation.diagnostics },
    supplement, joins, availability, findings: findingsView(findingInput), sources: provenance, diagnostics,
    budget: { bytes: budget.bytes, limit: LIMITS.total_bytes, evaluator_guard: 'preaccounted-subset' },
    review: { source_review: 'pending', publication: 'owner-only' }, limitations: [...LIMITATIONS] };
  if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.file_bytes) fail('output_bytes_exceeded');
  return result;
}

function buildStageReport(input, options = {}) {
  if (!Array.isArray(options.roots) || !options.roots.length || options.roots.length > 16) fail('roots_required');
  const roots = options.roots.map(root => checkedPath(path.resolve(root)));
  if (roots.some(root => !fs.statSync(root).isDirectory())) fail('root_invalid');
  const budget = { bytes: 0 }; const provenance = []; const diagnostics = [];
  if (options.inputRef) {
    const actual = parse(readRef(options.inputRef, roots, budget, provenance, diagnostics, true));
    if (fingerprint(actual) !== fingerprint(input)) fail('input_identity_conflict');
  } else {
    budget.bytes = Buffer.byteLength(JSON.stringify(input));
    if (budget.bytes > LIMITS.file_bytes) fail('file_bytes_exceeded');
  }
  return buildReport(input, roots, budget, provenance, diagnostics);
}

function renderStageReport(report) {
  const rows = ['# Relatório por etapa da memória', '',
    'Projeção retrospectiva atual, sem prova de eficácia ou execução prospectiva.', '',
    `Famílias reais: ${report.real_families.join(', ') || 'nenhuma'}.`,
    `Estratos: sintético ${report.strata.synthetic}; histórico ${report.strata.historical}; real elegível ${report.strata.eligible_real}.`,
    `Casos prospectivos elegíveis: ${report.prospective_cases}.`,
    'apply_policy: false; comparative_ready: false; functional_gain: null.', '',
    '## Casos e disponibilidade', ''];
  for (const row of report.evaluation.cases) {
    const available = report.availability.find(item => item.case_id === row.id);
    const join = report.joins.find(item => item.case_id === row.id);
    rows.push(`### ${row.id}`, '', `Entrega: ${row.delivery_id}; família: ${row.family_id}.`,
      `Slot candidato: ${row.candidate_id}; braço: ${row.arm}; elegível: ${row.eligible}.`,
      `Vínculo: ${join.identity}; controles: ${join.controls}.`,
      `Inventário: ${available?.inventory || 'unavailable'}; seleção: ${available?.selection || 'unavailable'}; resposta: ${available?.answer || 'unavailable'}.`,
      'Pacote e resposta são independentes; unavailable não significa vazio observado.', '',
      '| Dimensão | Estado | Valor |', '| --- | --- | --- |');
    for (const dimension of DIMENSIONS) rows.push(`| ${dimension} | ${row.dimensions[dimension].state} | ${row.dimensions[dimension].value} |`);
    const stage = report.supplement.cases.find(item => item.case_id === row.id);
    if (stage) {
      rows.push('', '| Fronteira | Retidos | Perdidos | Unknown | Conflict | Denominador | Taxa retenção |', '| --- | --- | --- | --- | --- | --- | --- |');
      for (const boundary of stage.boundaries) rows.push(`| ${boundary.from} → ${boundary.to} | ${boundary.retained} | ${boundary.lost} | ${boundary.unknown} | ${boundary.conflict} | ${boundary.denominator} | ${boundary.retention_rate} |`);
      for (const fact of stage.facts) rows.push('', `Fato ${fact.fact_id}: primeira perda ${fact.first_loss}; resposta ${fact.answer.usage}.`,
        ...STAGES.map(name => `${name}: ${fact.stages[name].state} (${fact.stages[name].availability}); referência ${fact.stages[name].reference}; sha256 ${fact.stages[name].sha256}.`));
    }
    rows.push('');
  }
  rows.push('## Findings fornecidos pelo owner', '', 'Estado literal; reparos locais e triagem final são fatos distintos.', '');
  for (const finding of report.findings) rows.push(`- ${finding.artifact} ${finding.id}${finding.issue ? ` #${finding.issue}` : ''}: ${finding.literal_state}`);
  rows.push('', '## Fontes e integridade', '');
  for (const source of report.sources) rows.push(`- ${source.id}: ${source.sha256}; disponível ${source.available}; diagnóstico ${source.code}.`);
  rows.push('', `Budget cumulativo: ${report.budget.bytes}/${report.budget.limit} bytes; guarda do avaliador: subconjunto pré-contabilizado.`, '',
    '## Limitações e próximos passos', '', ...report.limitations.map(item => `- ${item}`), '',
    'Revisão documental independente: pendente. Publicação: exclusiva do owner.', '');
  return rows.join('\n');
}

module.exports = { buildStageReport, renderStageReport };

if (require.main === module) {
  try {
    const args = process.argv.slice(2); const options = { roots: [] }; const seen = new Set();
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (!['--input', '--sha256', '--root', '--markdown'].includes(arg)
          || arg !== '--root' && seen.has(arg)) fail('arguments_invalid');
      seen.add(arg);
      if (arg === '--markdown') options.markdown = true;
      else {
        const value = args[++i]; if (!value || value.startsWith('--')) fail('arguments_invalid');
        if (arg === '--root') options.roots.push(value); else options[arg.slice(2)] = value;
      }
    }
    if (!options.input || !HASH.test(options.sha256 || '') || !options.roots.length || options.roots.length > 16) fail('arguments_invalid');
    const roots = options.roots.map(root => checkedPath(path.resolve(root)));
    const ref = { id: 'report-input', path: path.relative(roots[0], path.resolve(options.input)).split(path.sep).join('/'),
      sha256: options.sha256, revision: 'caller-pin', captured_at: '2000-01-01T00:00:00Z', timezone: 'UTC', synthetic: false };
    const budget = { bytes: 0 }; const provenance = []; const diagnostics = [];
    const input = parse(readRef(ref, roots, budget, provenance, diagnostics, true));
    const report = buildReport(input, roots, budget, provenance, diagnostics);
    process.stdout.write(options.markdown ? renderStageReport(report) : `${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const code = /^[a-z_]{1,80}$/.test(error.code || '') ? error.code : 'report_invalid';
    process.stderr.write(`memory-stage-report: ${code}\n`); process.exitCode = 2;
  }
}
