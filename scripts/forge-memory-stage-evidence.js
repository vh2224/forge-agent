'use strict';

const { fingerprint, sha256 } = require('./forge-delivery');
const diagnostic = require('./forge-memory-diagnostic');
const empirical = require('./forge-empirical-evaluation');

const STAGE_VERSION = 1;
const STAGES = Object.freeze(['origin', 'extraction', 'publication', 'selection', 'package']);
const LIMITS = Object.freeze({ file_bytes: empirical.LIMITS.file_bytes,
  total_bytes: empirical.LIMITS.total_bytes, cases: empirical.LIMITS.cases,
  max_facts_per_case: 64, max_output_bytes: 1048576 });
const STATES = ['present', 'absent', 'unknown', 'conflict'];
const HASH = /^[a-f0-9]{64}$/;
const LABEL = /^[A-Za-z0-9_.:-]{1,160}$/;
const OBSERVATIONS = [...STAGES, 'answer'];

// Caller-owned snapshots, not readers or authority:
// {version:1,input_sha256,report_sha256,report_version,cases:[{
//   case_id,delivery_id,family_id,split,evidence_kind,controls_sha256,
//   expectations:{version,sha256,facts:[{fact_id,milestone_id,unit_id,mem_id}],
//     planned:{origin:'observed'|'unavailable', ...}},
//   observations:{[stage]:{ref,sha256,availability,data,adjudications:[{
//     fact_id,expectations_version,expectations_sha256,artifact_sha256,
//     state,package_sha256?}]}}}]}
// expectations.sha256 = fingerprint({version,facts,planned}); observation.sha256
// = fingerprint(data). Adjudications describe supplied reviewed semantics;
// validation cannot authenticate their author or pre-execution chronology.
// Native publication data: {sourceContext:{milestoneId,unitId},status,reason?,
// state:null|[{mem_id,...native reduced state}],fragment?:{milestone_id,unit_id,
// facts:[{mem_id,...native fact}]}}. Rereads must be supplied by the caller.
// Selection data: {source:{provider},status,reason,selected:[{milestone_id,
// unit_id,mem_id,identity?,source_unit?,source?,content_sha256?}],diagnostic?}.
// Package data: {context:{sha256,bytes?},telemetry_sha256?,truncated?}.
// Answer data: {available:boolean}; answer adjudication uses present (correct),
// absent (omitted), or conflict (contradictory). Raw text is never needed.

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}
function closed(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Object.keys(value).some(key => !keys.includes(key))) fail('metadata_invalid');
}
function label(value) { if (typeof value !== 'string' || !LABEL.test(value)) fail('identity_invalid'); }
function hash(value) { if (typeof value !== 'string' || !HASH.test(value)) fail('hash_invalid'); }
function enumeration(value, values) { if (!values.includes(value)) fail('enum_invalid'); }
function array(value, max) {
  if (!Array.isArray(value) || value.length > max) fail('population_exceeded');
}
function identity(value) {
  closed(value, ['fact_id', 'milestone_id', 'unit_id', 'mem_id']);
  for (const key of ['fact_id', 'milestone_id', 'unit_id', 'mem_id']) label(value[key]);
}
function tuple(value) { return JSON.stringify([value.milestone_id, value.unit_id, value.mem_id]); }
function validateData(stage, data) {
  if (stage === 'publication') {
    closed(data, ['sourceContext', 'status', 'reason', 'state', 'fragment']);
    closed(data.sourceContext, ['milestoneId', 'unitId']);
    label(data.sourceContext.milestoneId); label(data.sourceContext.unitId);
    enumeration(data.status, ['written', 'noop', 'quarantined', 'conflict']);
    if (data.reason !== undefined && (typeof data.reason !== 'string'
        || !/^[a-z0-9_-]{1,80}$/.test(data.reason))) fail('reason_invalid');
    if (data.state !== undefined && data.state !== null) {
      array(data.state, LIMITS.max_facts_per_case);
      for (const row of data.state) {
        closed(row, ['mem_id', 'content_sha256', 'pruned', 'superseded', 'hits', 'confidence',
          'promoted', 'independent_confirmation_count', 'v2_confidence', 'v2_promoted', 'counters']);
        label(row.mem_id);
        if (row.content_sha256 !== undefined) hash(row.content_sha256);
        // Native counters are input only; they never become evaluation evidence.
        if (row.counters !== undefined) {
          closed(row.counters, ['exposure', 'reobserve', 'independent_confirmation', 'utility']);
          for (const count of Object.values(row.counters)) if (diagnostic.safeCount(count) === null) fail('count_invalid');
        }
        for (const key of ['pruned', 'superseded', 'promoted', 'v2_promoted']) {
          if (row[key] !== undefined && typeof row[key] !== 'boolean') fail('metadata_invalid');
        }
        for (const key of ['hits', 'independent_confirmation_count']) {
          if (row[key] !== undefined && diagnostic.safeCount(row[key]) === null) fail('count_invalid');
        }
        for (const key of ['confidence', 'v2_confidence']) {
          if (row[key] !== undefined && row[key] !== null
              && (typeof row[key] !== 'number' || !Number.isFinite(row[key]))) fail('metadata_invalid');
        }
      }
    }
    if (data.fragment !== undefined && data.fragment !== null) {
      closed(data.fragment, ['milestone_id', 'unit_id', 'facts']);
      label(data.fragment.milestone_id); label(data.fragment.unit_id);
      array(data.fragment.facts, LIMITS.max_facts_per_case);
      for (const row of data.fragment.facts) {
        closed(row, ['mem_id', 'content_sha256']); label(row.mem_id);
        if (row.content_sha256 !== undefined) hash(row.content_sha256);
      }
    }
  } else if (stage === 'selection') {
    closed(data, ['source', 'status', 'reason', 'selected', 'diagnostic', 'markdown', 'emitted_bytes']);
    closed(data.source, ['provider']); enumeration(data.source.provider, ['canonical', 'direct', 'override']);
    enumeration(data.status, ['selected', 'empty', 'partial', 'disabled', 'optional-error']);
    if (data.reason !== undefined && (typeof data.reason !== 'string'
        || !/^[a-z0-9_-]{1,80}$/.test(data.reason))) fail('reason_invalid');
    if (data.markdown !== undefined) {
      if (typeof data.markdown !== 'string') fail('metadata_invalid');
      if (Buffer.byteLength(data.markdown) > LIMITS.file_bytes) fail('file_bytes_exceeded');
    }
    if (data.emitted_bytes !== undefined && diagnostic.safeCount(data.emitted_bytes) === null) fail('count_invalid');
    array(data.selected, LIMITS.max_facts_per_case);
    for (const row of data.selected) {
      closed(row, ['milestone_id', 'unit_id', 'mem_id', 'identity', 'source_unit', 'source', 'content_sha256']);
      for (const key of ['milestone_id', 'unit_id', 'mem_id']) if (row[key] !== null) label(row[key]);
      for (const key of ['identity', 'source_unit', 'source']) {
        if (row[key] !== undefined && row[key] !== null && diagnostic.safeIdentity(row[key]) === null) fail('identity_invalid');
      }
      if (row.content_sha256 !== undefined) hash(row.content_sha256);
    }
    if (data.diagnostic !== undefined) {
      closed(data.diagnostic, ['candidates', 'omitted_candidates', 'unattributed_positions', 'minimum_overlap']);
      array(data.diagnostic.candidates, diagnostic.LIMITS.max_candidates);
      for (const row of data.diagnostic.candidates) {
        closed(row, ['identity', 'reasons', 'overlap_count']);
        if (row.identity !== null && diagnostic.safeIdentity(row.identity) === null) fail('identity_invalid');
        array(row.reasons, diagnostic.LIMITS.max_reasons);
        for (const reason of row.reasons) enumeration(reason, diagnostic.REASONS);
        if (row.overlap_count !== undefined && diagnostic.safeCount(row.overlap_count) === null) fail('count_invalid');
      }
      for (const key of ['omitted_candidates', 'unattributed_positions', 'minimum_overlap']) {
        if (data.diagnostic[key] !== undefined && diagnostic.safeCount(data.diagnostic[key]) === null) fail('count_invalid');
      }
    }
  } else if (stage === 'package') {
    closed(data, ['context', 'telemetry_sha256', 'truncated']);
    if (data.context !== undefined) {
      closed(data.context, ['sha256', 'bytes']); hash(data.context.sha256);
      if (data.context.bytes !== undefined && diagnostic.safeCount(data.context.bytes) === null) fail('count_invalid');
    }
    if (data.telemetry_sha256 !== undefined) hash(data.telemetry_sha256);
    if (data.truncated !== undefined && typeof data.truncated !== 'boolean') fail('metadata_invalid');
  } else if (stage === 'answer') {
    closed(data, ['available']); if (typeof data.available !== 'boolean') fail('metadata_invalid');
  } else {
    closed(data, ['snapshot_sha256']); hash(data.snapshot_sha256);
  }
}

function validateStageInput(input) {
  closed(input, ['version', 'input_sha256', 'report_sha256', 'report_version', 'cases']);
  if (input.version !== STAGE_VERSION) fail('version_invalid');
  hash(input.input_sha256); hash(input.report_sha256); label(input.report_version);
  array(input.cases, LIMITS.cases);
  const caseIds = new Set();
  for (const row of input.cases) {
    closed(row, ['case_id', 'delivery_id', 'family_id', 'split', 'evidence_kind', 'controls_sha256', 'expectations', 'observations']);
    for (const key of ['case_id', 'delivery_id', 'family_id']) label(row[key]);
    if (caseIds.has(row.case_id)) fail('case_duplicate');
    caseIds.add(row.case_id); hash(row.controls_sha256);
    enumeration(row.split, ['historical-diagnostic', 'adjustment', 'reserved', 'prospective']);
    enumeration(row.evidence_kind, ['synthetic', 'historical', 'real']);
    const expected = row.expectations;
    closed(expected, ['version', 'sha256', 'facts', 'planned']); label(expected.version); hash(expected.sha256);
    array(expected.facts, LIMITS.max_facts_per_case);
    closed(expected.planned, STAGES);
    for (const stage of STAGES) enumeration(expected.planned[stage], ['observed', 'unavailable']);
    const facts = new Set();
    for (const fact of expected.facts) {
      identity(fact); if (facts.has(fact.fact_id)) fail('fact_duplicate'); facts.add(fact.fact_id);
    }
    closed(row.observations, OBSERVATIONS);
    for (const [stage, observation] of Object.entries(row.observations)) {
      closed(observation, ['ref', 'sha256', 'availability', 'data', 'adjudications']);
      label(observation.ref); hash(observation.sha256);
      enumeration(observation.availability, ['observed', 'unavailable']);
      validateData(stage, observation.data);
      array(observation.adjudications, LIMITS.max_facts_per_case * 2);
      for (const judgment of observation.adjudications) {
        closed(judgment, ['fact_id', 'expectations_version', 'expectations_sha256', 'artifact_sha256', 'state', 'package_sha256']);
        label(judgment.fact_id); if (!facts.has(judgment.fact_id)) fail('fact_reference_invalid');
        label(judgment.expectations_version); hash(judgment.expectations_sha256); hash(judgment.artifact_sha256);
        enumeration(judgment.state, STATES);
        if (judgment.package_sha256 !== undefined) hash(judgment.package_sha256);
      }
      if (Buffer.byteLength(JSON.stringify(observation.data)) > LIMITS.file_bytes) fail('file_bytes_exceeded');
    }
  }
  // Check populations first, before canonicalization and the aggregate byte bound.
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(input)); } catch (_) { fail('input_invalid'); }
  if (bytes > LIMITS.total_bytes) fail('total_bytes_exceeded');
  return true;
}

function result(state, availability, reason, observation) {
  return { state, availability, reason, reference: observation ? observation.ref : null,
    sha256: observation ? observation.sha256 : null };
}
function semantic(row, fact, stage) {
  const observation = row.observations[stage];
  if (!observation || observation.availability !== 'observed') return result('unknown', 'unavailable', 'not_observed', observation);
  const expected = row.expectations;
  if (fingerprint({ version: expected.version, facts: expected.facts, planned: expected.planned }) !== expected.sha256
      || fingerprint(observation.data) !== observation.sha256) return result('conflict', 'observed', 'hash_mismatch', observation);
  const judgments = observation.adjudications.filter(item => item.fact_id === fact.fact_id);
  if (judgments.some(item => item.expectations_version !== expected.version
      || item.expectations_sha256 !== expected.sha256 || item.artifact_sha256 !== observation.sha256)) {
    return result('conflict', 'observed', 'adjudication_binding_conflict', observation);
  }
  if (new Set(judgments.map(item => item.state)).size > 1) return result('conflict', 'observed', 'adjudication_conflict', observation);
  return result(judgments.length ? judgments[0].state : 'unknown', 'observed', judgments.length ? 'adjudicated' : 'semantic_evidence_missing', observation);
}
function publication(row, fact) {
  const state = semantic(row, fact, 'publication');
  const observation = row.observations.publication;
  if (!observation || state.availability === 'unavailable' || state.state === 'conflict') return state;
  const data = observation.data;
  if (data.sourceContext.milestoneId !== fact.milestone_id || data.sourceContext.unitId !== fact.unit_id) {
    return result('conflict', 'observed', 'namespace_conflict', observation);
  }
  if (data.status === 'conflict') return result('conflict', 'observed', 'publication_conflict', observation);
  if (data.status === 'quarantined' || data.status === 'noop' && data.reason !== 'replay') {
    return result('absent', 'observed', 'not_published', observation);
  }
  let entries = data.state;
  if (Object.hasOwn(data, 'fragment') && data.fragment === null) {
    if (Array.isArray(entries) && entries.length) return result('conflict', 'observed', 'reread_conflict', observation);
    return result('absent', 'observed', 'reread_absent', observation);
  }
  if (data.fragment !== undefined && data.fragment !== null) {
    if (data.fragment.milestone_id !== fact.milestone_id || data.fragment.unit_id !== fact.unit_id) {
      return result('conflict', 'observed', 'namespace_conflict', observation);
    }
    if (Array.isArray(entries) && fingerprint(entries.map(item => item.mem_id).sort())
        !== fingerprint(data.fragment.facts.map(item => item.mem_id).sort())) return result('conflict', 'observed', 'reread_conflict', observation);
    entries = [...(entries || []), ...data.fragment.facts];
  }
  if (!Array.isArray(entries)) return result('unknown', 'unavailable', 'reread_missing', observation);
  const members = entries.filter(item => item.mem_id === fact.mem_id);
  if (!members.length) return result('absent', 'observed', 'reread_absent', observation);
  if (new Set(members.map(item => item.content_sha256).filter(Boolean)).size > 1) {
    return result('conflict', 'observed', 'content_hash_conflict', observation);
  }
  return state;
}
function selection(row, fact, published) {
  const observation = row.observations.selection;
  if (!observation) return semantic(row, fact, 'selection');
  const data = observation.data;
  if (observation.availability !== 'observed' || data.source.provider !== 'canonical' || !['selected', 'empty', 'partial'].includes(data.status)
      || !['canonical-match', 'no-match', 'budget-exhausted-or-no-match'].includes(data.reason)) {
    return result('unknown', 'unavailable', 'selection_unavailable', observation);
  }
  const state = semantic(row, fact, 'selection');
  if (state.state === 'conflict') return state;
  if (published.state !== 'present') return result('unknown', 'observed', 'publication_unconfirmed', observation);
  const members = data.selected.filter(item => tuple(item) === tuple(fact));
  if (members.length) {
    const reread = row.observations.publication.data;
    const entries = [...(reread.state || []), ...(reread.fragment?.facts || [])];
    const hashes = new Set([...members, ...entries.filter(item => item.mem_id === fact.mem_id)]
      .map(item => item.content_sha256).filter(Boolean));
    if (hashes.size > 1) return result('conflict', 'observed', 'content_hash_conflict', observation);
    // Identity proves membership of an artifact, not equivalence of its facts.
    return state;
  }
  if (data.selected.some(item => [item.milestone_id, item.unit_id, item.mem_id].includes(null))) {
    return result('unknown', 'observed', 'identity_unavailable', observation);
  }
  if (data.selected.some(item => item.unit_id === fact.unit_id && item.mem_id === fact.mem_id
      && item.milestone_id !== fact.milestone_id)) return result('conflict', 'observed', 'namespace_conflict', observation);
  return result(data.status === 'partial' ? 'unknown' : 'absent', 'observed',
    data.status === 'partial' ? 'partial_membership' : 'not_selected', observation);
}
function packageState(row, fact) {
  const state = semantic(row, fact, 'package');
  const observation = row.observations.package;
  if (!observation || state.availability === 'unavailable' || state.state === 'conflict') return state;
  if (!observation.data.context) return result('unknown', 'unavailable', 'context_capture_missing', observation);
  const judgments = observation.adjudications.filter(item => item.fact_id === fact.fact_id);
  if (judgments.some(item => item.package_sha256 !== observation.data.context.sha256)) {
    return result('conflict', 'observed', 'package_hash_conflict', observation);
  }
  return state;
}
function diagnosticReason(row, fact, identities) {
  const observation = row.observations.selection;
  const data = observation && observation.data;
  const trace = data && data.diagnostic;
  const short = `${fact.unit_id}/${fact.mem_id}`;
  if (!observation || observation.availability !== 'observed' || fingerprint(data) !== observation.sha256
      || data.source.provider !== 'canonical' || !['selected', 'empty', 'partial'].includes(data.status)
      || !['canonical-match', 'no-match', 'budget-exhausted-or-no-match'].includes(data.reason)) {
    return { state: 'unknown', reason: 'reason_unknown' };
  }
  if (identities.get(short).size > 1) return { state: 'conflict', reason: 'ambiguous_identity' };
  if (!trace) return { state: 'unknown', reason: 'reason_unknown' };
  const candidates = trace.candidates.filter(item => item.identity === short);
  if (!candidates.length) return { state: 'unknown', reason: 'reason_unknown' };
  const reasons = new Set(candidates.map(item => fingerprint(item.reasons)));
  if (reasons.size > 1) return { state: 'conflict', reason: 'diagnostic_conflict' };
  return { state: 'observed', reason: (candidates[0].reasons[0] || 'reason_unknown').replace(/-/g, '_') };
}
function boundaries(facts) {
  return STAGES.slice(1).map((to, index) => {
    const from = STAGES[index];
    const counts = { from, to, reached: 0, retained: 0, lost: 0, unknown: 0, conflict: 0, denominator: 0, retention_rate: null, loss_rate: null };
    for (const fact of facts) {
      if (fact.stages[from].state !== 'present') continue;
      counts.reached++; counts.denominator++;
      const state = fact.stages[to].state;
      counts[state === 'present' ? 'retained' : state === 'absent' ? 'lost' : state]++;
    }
    if (counts.denominator) {
      counts.retention_rate = counts.retained / counts.denominator;
      counts.loss_rate = counts.lost / counts.denominator;
    }
    return counts;
  });
}
function firstLoss(stages) {
  if (stages.origin.state === 'absent') return 'origin_absent';
  if (stages.origin.state !== 'present') return 'unknown';
  for (let index = 1; index < STAGES.length; index++) {
    const current = stages[STAGES[index]];
    if (current.state === 'absent') return `${STAGES[index - 1]}_to_${STAGES[index]}`;
    if (current.state !== 'present') {
      if (index === 1 && current.state === 'unknown' && current.availability === 'unavailable'
          && stages.publication.state === 'absent') return 'extraction_publication';
      return 'unknown';
    }
  }
  return 'none';
}

function buildStageEvidence(input) {
  validateStageInput(input);
  const identities = new Map();
  for (const row of input.cases) for (const fact of row.expectations.facts) {
    const short = `${fact.unit_id}/${fact.mem_id}`;
    if (!identities.has(short)) identities.set(short, new Set());
    identities.get(short).add(tuple(fact));
  }
  const cases = input.cases.map(row => {
    const facts = row.expectations.facts.map(fact => {
      const stages = { origin: semantic(row, fact, 'origin'), extraction: semantic(row, fact, 'extraction') };
      stages.publication = publication(row, fact);
      stages.selection = selection(row, fact, stages.publication);
      stages.package = packageState(row, fact);
      const reason = diagnosticReason(row, fact, identities);
      // A bounded diagnostic cannot disambiguate colliding unit/MEM identities.
      if (reason.state === 'conflict' && row.observations.selection?.data.diagnostic) {
        stages.selection = result('conflict', stages.selection.availability, reason.reason, row.observations.selection);
      }
      let answer = semantic(row, fact, 'answer');
      if (row.observations.answer?.data.available === false) answer = result('unknown', 'unavailable', 'answer_unavailable', row.observations.answer);
      return { ...fact, stages, diagnostic: reason, answer: { ...answer,
        usage: answer.availability === 'unavailable' ? 'unavailable' :
          answer.reason !== 'adjudicated' ? 'unknown' :
            { present: 'used_correctly', absent: 'omitted', conflict: 'contradictory', unknown: 'unknown' }[answer.state] },
      first_loss: firstLoss(stages) };
    });
    return { case_id: row.case_id, delivery_id: row.delivery_id, family_id: row.family_id,
      split: row.split, evidence_kind: row.evidence_kind, controls_sha256: row.controls_sha256,
      expectations_version: row.expectations.version, expectations_sha256: row.expectations.sha256,
      planned: { ...row.expectations.planned }, facts, boundaries: boundaries(facts) };
  });
  const output = { version: STAGE_VERSION, kind: 'memory-stage-evidence',
    input_sha256: input.input_sha256, report_sha256: input.report_sha256, report_version: input.report_version,
    dimensions: [...empirical.DIMENSIONS], limits: { ...LIMITS }, apply_policy: false,
    comparative_ready: false, functional_gain: null,
    strata: Object.fromEntries(['synthetic', 'historical', 'real'].map(kind => [kind, cases.filter(row => row.evidence_kind === kind).length])),
    real_families: [...new Set(cases.filter(row => row.evidence_kind === 'real').map(row => row.family_id))].sort(), cases };
  const bytes = JSON.stringify(output);
  // Physical output hash uses the shared byte helper, not semantic fingerprint.
  const final = { ...output, digest: sha256(Buffer.from(bytes, 'utf8')) };
  if (Buffer.byteLength(JSON.stringify(final)) > LIMITS.max_output_bytes) fail('output_bytes_exceeded');
  return final;
}

module.exports = { STAGE_VERSION, STAGES, LIMITS, validateStageInput, buildStageEvidence };
