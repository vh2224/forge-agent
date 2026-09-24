#!/usr/bin/env node
'use strict';

// Deterministic, read-only autonomy projection over explicitly supplied files.

const { fingerprint, loadAutonomySources, readAutonomyManifest, ISO_WITH_ZONE_RE } = require('./forge-autonomy-sources.js');

const SCHEMA_VERSION = 1;
const FAMILY_NAMES = Object.freeze(['human_interventions', 'time', 'reviews', 'resumptions']);
const FAMILY_LABELS = Object.freeze({
  human_interventions: 'Intervenções humanas',
  time: 'Tempo',
  reviews: 'Revisões',
  resumptions: 'Retomadas',
});

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function sortReferences(references) {
  const unique = new Map();
  for (const reference of references || []) unique.set(fingerprint(reference), reference);
  return [...unique.values()].sort((left, right) => JSON.stringify(canonical(left)).localeCompare(JSON.stringify(canonical(right))));
}

function sortDiagnostics(diagnostics) {
  return diagnostics.slice().sort((left, right) => JSON.stringify(canonical(left)).localeCompare(JSON.stringify(canonical(right))));
}

function addDiagnostic(diagnostics, severity, code, fields = {}) {
  diagnostics.push({ severity, code, ...fields });
}

function identityToken(value) {
  return fingerprint(String(value)).slice(0, 12);
}

function deduplicate(items, key, entity, diagnostics, options = {}) {
  const groups = new Map();
  for (const item of items) {
    const identity = key(item.data);
    if (identity === null || identity === undefined || identity === '') {
      addDiagnostic(diagnostics, 'warning', `${entity}_identity_missing`);
      continue;
    }
    const variants = groups.get(identity) || new Map();
    const content = fingerprint(item.semantic || item.data);
    const prior = variants.get(content);
    if (prior) {
      prior.references.push(...item.references);
      prior.attributable = prior.attributable || item.attributable !== false;
    } else {
      variants.set(content, {
        data: item.data,
        semantic: item.semantic,
        attributable: item.attributable !== false,
        references: item.references.slice(),
      });
    }
    groups.set(identity, variants);
  }

  const values = [];
  const conflicts = [];
  for (const [identity, variants] of groups) {
    const relevant = [...variants.values()].some((item) => item.attributable);
    if (variants.size > 1) {
      if (!options.attributionAware || relevant) {
        conflicts.push(identity);
        addDiagnostic(diagnostics, 'conflict', `${entity}_identity_conflict`, { identity: identityToken(identity) });
      }
      continue;
    }
    const item = variants.values().next().value;
    if (options.attributionAware && !item.attributable) continue;
    item.references = sortReferences(item.references);
    values.push(item);
  }
  values.sort((left, right) => String(key(left.data)).localeCompare(String(key(right.data))));
  return { values, conflicts };
}

function deduplicateReviews(items, diagnostics) {
  const unique = new Map();
  for (const item of items) {
    const key = fingerprint(item.semantic || item.data);
    const prior = unique.get(key);
    if (prior) prior.references.push(...item.references);
    else unique.set(key, { data: item.data, semantic: item.semantic, references: item.references.slice() });
  }
  const values = [...unique.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, item]) => ({
    data: item.data,
    references: sortReferences(item.references),
  }));
  if (values.length > 0) addDiagnostic(diagnostics, 'warning', 'review_identity_not_universal');
  return values;
}

function interval(start, end) {
  return { start, end, duration: end - start };
}

function isRecordedReviewFix(unit, target) {
  if (target.type === 'task') return unit === `review-fix/${target.id}`;
  return /^review-fix\/T\d+$/.test(unit);
}

function unionDuration(intervals) {
  if (intervals.length === 0) return 0;
  const sorted = intervals.slice().sort((left, right) => left.start - right.start || left.end - right.end);
  let start = sorted[0].start;
  let end = sorted[0].end;
  let total = 0;
  for (let index = 1; index < sorted.length; index++) {
    const next = sorted[index];
    if (next.start <= end) end = Math.max(end, next.end);
    else {
      total += end - start;
      start = next.start;
      end = next.end;
    }
  }
  return total + (end - start);
}

function parseIso(value) {
  if (typeof value !== 'string' || !ISO_WITH_ZONE_RE.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function issueFlags(diagnostics, predicate) {
  const relevant = diagnostics.filter(predicate);
  return {
    conflict: relevant.some((entry) => entry.severity === 'conflict'),
    invalid: relevant.some((entry) => entry.severity === 'error'),
  };
}

function metric(definition, unit, value, state, coverage, references, limitations = []) {
  return {
    definition,
    unit,
    value,
    state,
    coverage,
    references: sortReferences(references),
    limitations: [...new Set(limitations)].sort(),
  };
}

function coverage(provided, references, limited) {
  if (references.length === 0) return 'none';
  return limited || !provided ? 'partial' : 'provided_sources_only';
}

function observedState(hasValue, flags) {
  if (flags.conflict) return 'conflict';
  if (flags.invalid) return 'invalid';
  return hasValue ? 'observed' : 'unknown';
}

function emptyFamilies(state, limitations) {
  const invalid = state === 'invalid';
  const base = (definition, unit) => metric(definition, unit, null, state, 'none', [], limitations);
  return {
    human_interventions: {
      definition: 'Respostas humanas registradas em gates atribuíveis nas fontes fornecidas.',
      measures: {
        registered_human_answers: base('Respostas status=answered com answer.source=human.', 'answers'),
        registered_response_latency_sum_ms: base('Soma das latências fechadas de respostas humanas.', 'ms'),
        registered_response_latency_wall_ms: base('União temporal das latências fechadas de respostas humanas.', 'ms'),
      },
    },
    time: {
      definition: 'Intervalos fechados de resultados ligados a dispatches exatos permitidos.',
      measures: {
        execution_sum_ms: base('Soma das durações observadas de invocações atribuídas.', 'ms'),
        execution_wall_ms: base('União dos intervalos observados de invocações atribuídas.', 'ms'),
        recorded_rework_sum_ms: base('Soma de invocações explicitamente rotuladas review-fix.', 'ms'),
        recorded_rework_wall_ms: base('União dos intervalos explicitamente rotulados review-fix.', 'ms'),
      },
    },
    reviews: {
      definition: 'Declarações de revisão atribuíveis e deduplicadas por conteúdo canônico.',
      measures: {
        declared_corrections: base('Soma de conceded_fixed nas declarações atribuíveis distintas.', 'corrections'),
        positive_declarations: base('Declarações distintas com conceded_fixed maior que zero.', 'declarations'),
        verified_corrections: metric('Correções com aplicação e verificação causal comprovadas.', 'corrections', null, 'unknown', 'none', [], ['no_causal_verification_link']),
        verified_impact: metric('Impacto causal verificado das correções declaradas.', 'impact', null, 'unknown', 'none', [], ['no_causal_impact_link']),
      },
    },
    resumptions: {
      definition: 'Retomadas ligadas a um resultado posterior verificado da mesma entrega.',
      measures: {
        resumptions: metric('Número de retomadas causalmente identificadas.', 'resumptions', null, 'unknown', 'none', [], ['no_universal_resume_event']),
        successful_resumptions: metric('Retomadas com resultado posterior verificado.', 'resumptions', null, 'unknown', 'none', [], ['no_verified_outcome_link']),
        success_rate: metric('Sucessos divididos por retomadas comprovadas.', 'ratio', null, 'unknown', 'none', [], ['denominator_unavailable']),
      },
    },
    ...(invalid ? {} : {}),
  };
}

function buildAutonomyReport(input, options = {}) {
  const loaded = loadAutonomySources(input, options);
  const diagnostics = loaded.diagnostics.slice();
  if (!loaded.target) {
    return {
      schema_version: SCHEMA_VERSION,
      valid: false,
      target: null,
      families: emptyFamilies('invalid', diagnostics.map((entry) => entry.code)),
      diagnostics: sortDiagnostics(diagnostics),
    };
  }

  const gates = deduplicate(loaded.gates, (gate) => gate.id, 'gate', diagnostics, { attributionAware: true });
  const dispatches = deduplicate(loaded.dispatches, (dispatch) => dispatch.dispatch_id, 'dispatch', diagnostics, { attributionAware: true });
  const allDispatchIds = new Set(loaded.dispatches.map((item) => item.data.dispatch_id).filter(Boolean));
  const targetDispatchIds = new Set(loaded.dispatches.filter((item) => item.attributable).map((item) => item.data.dispatch_id).filter(Boolean));
  const orphanResultIds = new Set(loaded.results.map((item) => item.data.dispatch_id).filter((id) => !allDispatchIds.has(id)));
  for (const _id of orphanResultIds) addDiagnostic(diagnostics, 'warning', 'result_orphan');
  const scopedResults = loaded.results.map((item) => ({ ...item, attributable: targetDispatchIds.has(item.data.dispatch_id) }));
  const results = deduplicate(scopedResults, (result) => result.dispatch_id, 'result', diagnostics, { attributionAware: true });
  const reviews = deduplicateReviews(loaded.reviews, diagnostics);

  const gateReferences = sortReferences(gates.values.flatMap((item) => item.references));
  const humanGates = gates.values.filter((item) => item.data.status === 'answered' && item.data.answer && item.data.answer.source === 'human');
  const humanReferences = sortReferences(humanGates.flatMap((item) => item.references));
  const waitIntervals = [];
  const validWaitReferences = [];
  for (const item of humanGates) {
    const answerAt = item.data.answer.at;
    if (typeof answerAt !== 'number' || !Number.isFinite(answerAt) || answerAt < item.data.created_at) {
      addDiagnostic(diagnostics, 'error', 'gate_human_interval_invalid', { identity: identityToken(item.data.id) });
      continue;
    }
    waitIntervals.push(interval(item.data.created_at, answerAt));
    validWaitReferences.push(...item.references);
  }

  const dispatchById = new Map(dispatches.values.map((item) => [item.data.dispatch_id, item]));
  const resultById = new Map(results.values.map((item) => [item.data.dispatch_id, item]));
  const executionIntervals = [];
  const executionReferences = [];
  const reworkIntervals = [];
  const reworkReferences = [];
  for (const [dispatchId, dispatchItem] of dispatchById) {
    const dispatch = dispatchItem.data;
    if (!dispatch.dispatch_allowed) {
      addDiagnostic(diagnostics, 'warning', 'dispatch_refused_no_duration', { identity: identityToken(dispatchId) });
      continue;
    }
    const resultItem = resultById.get(dispatchId);
    if (!resultItem) {
      addDiagnostic(diagnostics, 'warning', 'dispatch_result_missing', { identity: identityToken(dispatchId) });
      continue;
    }
    const result = resultItem.data;
    const started = parseIso(result.started_at);
    const finished = parseIso(result.finished_at);
    const declared = result.duration_secs;
    if (started === null || finished === null || finished < started
        || typeof declared !== 'number' || !Number.isFinite(declared) || declared < 0) {
      addDiagnostic(diagnostics, 'error', 'result_interval_invalid', { identity: identityToken(dispatchId) });
      continue;
    }
    const observed = finished - started;
    if (Math.abs((declared * 1000) - observed) > 1000) {
      addDiagnostic(diagnostics, 'conflict', 'result_duration_conflict', { identity: identityToken(dispatchId) });
      continue;
    }
    const current = interval(started, finished);
    executionIntervals.push(current);
    executionReferences.push(...dispatchItem.references, ...resultItem.references);
    if (isRecordedReviewFix(dispatch.unit, loaded.target)) {
      reworkIntervals.push(current);
      reworkReferences.push(...dispatchItem.references, ...resultItem.references);
    }
  }
  const gateFlags = issueFlags(diagnostics, (entry) => entry.code.startsWith('gate_') || (entry.source_kind === 'gates' && entry.severity === 'error'));
  const timeFlags = issueFlags(diagnostics, (entry) => entry.code.startsWith('dispatch_') || entry.code.startsWith('result_')
    || (['events', 'results'].includes(entry.source_kind) && entry.severity === 'error'));
  const reviewFlags = issueFlags(diagnostics, (entry) => entry.code.startsWith('review_')
    || (entry.source_kind === 'events' && entry.severity === 'error'));
  const gateLimited = gateFlags.invalid || gateFlags.conflict;
  const timeLimited = timeFlags.invalid || timeFlags.conflict;
  const reviewLimited = reviewFlags.invalid || reviewFlags.conflict || reviews.length > 0;
  const gatePopulationObserved = gates.values.length > 0;
  const executionObserved = executionIntervals.length > 0;
  const waitObserved = waitIntervals.length > 0;
  const reviewObserved = reviews.length > 0;

  const families = {
    human_interventions: {
      definition: 'Respostas humanas registradas em gates atribuíveis nas fontes fornecidas; não representa toda conversa.',
      measures: {
        registered_human_answers: metric(
          'Respostas status=answered com answer.source=human na população atribuída.', 'answers',
          gatePopulationObserved ? humanGates.length : null,
          observedState(gatePopulationObserved, gateFlags),
          coverage(loaded.provided.gates, gateReferences, gateLimited), gateReferences,
          ['provided_gates_are_not_a_complete_conversation_inventory']
        ),
        registered_response_latency_sum_ms: metric(
          'Soma de answer.at-created_at somente para respostas humanas com intervalo fechado válido.', 'ms',
          waitObserved ? waitIntervals.reduce((sum, item) => sum + item.duration, 0) : null,
          observedState(waitObserved, gateFlags),
          coverage(loaded.provided.gates, validWaitReferences, gateLimited), validWaitReferences,
          ['timeout_default_and_cancelled_gates_are_excluded']
        ),
        registered_response_latency_wall_ms: metric(
          'União dos intervalos created_at→answer.at de respostas humanas válidas.', 'ms',
          waitObserved ? unionDuration(waitIntervals) : null,
          observedState(waitObserved, gateFlags),
          coverage(loaded.provided.gates, validWaitReferences, gateLimited), validWaitReferences,
          ['not_total_wait_time']
        ),
      },
    },
    time: {
      definition: 'Resultados xllm com intervalo fechado ligados por dispatch_id a dispatches atribuídos e permitidos.',
      measures: {
        execution_sum_ms: metric(
          'Soma das durações das invocações observadas; intervalos sobrepostos contam em cada invocação.', 'ms',
          executionObserved ? executionIntervals.reduce((sum, item) => sum + item.duration, 0) : null,
          observedState(executionObserved, timeFlags),
          coverage(loaded.provided.events && loaded.provided.results, executionReferences, timeLimited), executionReferences,
          ['observed_invocation_time_not_useful_work_or_total_delivery_time']
        ),
        execution_wall_ms: metric(
          'União dos intervalos observados das invocações atribuídas.', 'ms',
          executionObserved ? unionDuration(executionIntervals) : null,
          observedState(executionObserved, timeFlags),
          coverage(loaded.provided.events && loaded.provided.results, executionReferences, timeLimited), executionReferences,
          ['does_not_fill_unobserved_gaps']
        ),
        recorded_rework_sum_ms: metric(
          'Soma das durações de dispatches explicitamente review-fix; retries comuns não entram.', 'ms',
          reworkIntervals.length > 0 ? reworkIntervals.reduce((sum, item) => sum + item.duration, 0) : null,
          observedState(reworkIntervals.length > 0, timeFlags),
          coverage(loaded.provided.events && loaded.provided.results, reworkReferences, timeLimited), reworkReferences,
          ['recorded_review_fix_only', 'already_included_in_execution_sum']
        ),
        recorded_rework_wall_ms: metric(
          'União dos intervalos de dispatches explicitamente review-fix.', 'ms',
          reworkIntervals.length > 0 ? unionDuration(reworkIntervals) : null,
          observedState(reworkIntervals.length > 0, timeFlags),
          coverage(loaded.provided.events && loaded.provided.results, reworkReferences, timeLimited), reworkReferences,
          ['not_universal_rework_time']
        ),
      },
    },
    reviews: {
      definition: 'Declarações de revisão atribuíveis, deduplicadas conservadoramente por fingerprint canônico.',
      measures: {
        declared_corrections: metric(
          'Soma de conceded_fixed nas declarações atribuíveis distintas.', 'corrections',
          reviewObserved ? reviews.reduce((sum, item) => sum + item.data.conceded_fixed, 0) : null,
          observedState(reviewObserved, reviewFlags),
          coverage(loaded.provided.events, reviews.flatMap((item) => item.references), reviewLimited),
          reviews.flatMap((item) => item.references), ['review_rows_have_no_universal_execution_identity']
        ),
        positive_declarations: metric(
          'Número de declarações distintas com conceded_fixed maior que zero; não é total exato de execuções de revisão.', 'declarations',
          reviewObserved ? reviews.filter((item) => item.data.conceded_fixed > 0).length : null,
          observedState(reviewObserved, reviewFlags),
          coverage(loaded.provided.events, reviews.flatMap((item) => item.references), reviewLimited),
          reviews.flatMap((item) => item.references), ['canonical_duplicates_may_be_repeated_observations']
        ),
        verified_corrections: metric(
          'Correções com aplicação e verificação causal comprovadas.', 'corrections', null, 'unknown', 'none', [],
          ['review_source_has_no_commit_or_check_link']
        ),
        verified_impact: metric(
          'Impacto causal verificado das correções declaradas.', 'impact', null, 'unknown', 'none', [],
          ['review_source_has_no_outcome_link']
        ),
      },
    },
    resumptions: emptyFamilies('unknown', []).resumptions,
  };

  const orderedDiagnostics = sortDiagnostics(diagnostics);
  return {
    schema_version: SCHEMA_VERSION,
    valid: !orderedDiagnostics.some((entry) => entry.severity === 'error' || entry.severity === 'conflict'),
    target: canonical(loaded.target),
    families,
    diagnostics: orderedDiagnostics,
  };
}

function renderValue(measure) {
  return measure.value === null ? 'desconhecido' : String(measure.value);
}

function renderAutonomyMarkdown(report) {
  const lines = ['# Relatório de autonomia', ''];
  lines.push(`- Schema: ${report.schema_version}`);
  lines.push(`- Alvo: ${report.target ? `${report.target.type}/${report.target.id}` : 'inválido'}`);
  lines.push(`- Entrada: ${report.valid ? 'válida' : 'inválida ou conflitante'}`, '');
  for (const familyName of FAMILY_NAMES) {
    const family = report.families[familyName];
    lines.push(`## ${FAMILY_LABELS[familyName]}`, '', family.definition, '');
    for (const [name, measure] of Object.entries(family.measures)) {
      lines.push(`- ${name}: ${renderValue(measure)} ${measure.unit} — estado=${measure.state}; cobertura=${measure.coverage}`);
      lines.push(`  Definição: ${measure.definition}`);
      if (measure.references.length > 0) {
        lines.push(`  Evidências: ${measure.references.map((reference) => `${reference.source}@${reference.sha256.slice(0, 12)}${reference.line ? `:L${reference.line}` : reference.pointer || ''}`).join(', ')}`);
      }
      if (measure.limitations.length > 0) lines.push(`  Limitações: ${measure.limitations.join(', ')}`);
    }
    lines.push('');
  }
  lines.push('## Diagnósticos', '');
  if (report.diagnostics.length === 0) lines.push('- nenhum');
  else for (const item of report.diagnostics) lines.push(`- ${item.severity}: ${item.code}`);
  return `${lines.join('\n')}\n`;
}

function usage() {
  return [
    'Uso: node scripts/forge-autonomy.js --input <manifest.json> [--json]',
    '',
    'Lê somente o manifesto e os arquivos explicitamente declarados.',
    'Exit 0: relatório válido (mesmo com lacunas); exit 2: input/fonte inválido ou conflito.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = { json: false, help: false, input: null };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--input' && argv[index + 1] !== undefined) args.input = argv[++index];
    else return { error: 'argument_invalid' };
  }
  if (!args.help && !args.input) return { error: 'input_required' };
  return args;
}

function cli(argv = process.argv.slice(2), io = process) {
  const args = parseArgs(argv);
  if (args.error) {
    io.stderr.write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, error: args.error })}\n`);
    return 2;
  }
  if (args.help) {
    io.stdout.write(`${usage()}\n`);
    return 0;
  }
  const manifest = readAutonomyManifest(args.input);
  let report;
  if (manifest.error) {
    report = {
      schema_version: SCHEMA_VERSION,
      valid: false,
      target: null,
      families: emptyFamilies('invalid', [manifest.error.code]),
      diagnostics: [manifest.error],
    };
  } else {
    report = buildAutonomyReport(manifest.input, { baseDir: manifest.baseDir });
  }
  io.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : renderAutonomyMarkdown(report));
  return report.valid ? 0 : 2;
}

module.exports = {
  SCHEMA_VERSION,
  FAMILY_NAMES,
  buildAutonomyReport,
  renderAutonomyMarkdown,
  unionDuration,
  parseArgs,
  cli,
};

if (require.main === module) process.exitCode = cli();
