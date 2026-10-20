#!/usr/bin/env node
'use strict';

// Pure corpus contract validation. References are data: this module never opens them.
const fs = require('fs');
const { normalizeTarget, fingerprint } = require('./forge-autonomy-sources.js');
const schema = require('../shared/schemas/empirical-corpus.schema.json');
const MAX_INPUT_BYTES = 1024 * 1024;
const CLAIM_KINDS = Object.freeze(['declared_version', 'release_exists', 'component_match', 'installation_complete']);
const ZONED_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function caseIdentity(candidate) {
  const normalized = normalizeTarget(candidate.unit);
  if (normalized.error || !candidate.origin || !candidate.delivery_key || !candidate.family_key) {
    throw new Error(normalized.error || 'identity_fields_missing');
  }
  const scope = { origin: candidate.origin, unit: normalized.target };
  const delivery = fingerprint({ ...scope, delivery_key: candidate.delivery_key });
  return { delivery_id: `delivery:${delivery}`, case_id: `case:${delivery}`,
    family_id: `family:${fingerprint({ origin: candidate.origin, family_key: candidate.family_key })}` };
}

function classifyProvenance(claims = [], references = []) {
  const byId = new Map(references.map((ref) => [ref.id, ref]));
  return Object.fromEntries(CLAIM_KINDS.map((kind) => {
    const rows = claims.filter((claim) => claim.kind === kind);
    const observed = rows.filter((claim) => claim.state === 'observed' && claim.contemporaneous === true &&
      claim.refs.length > 0 && claim.refs.every((id) => {
        const ref = byId.get(id);
        return ref && ref.state === 'observed' && ref.sha256 && Number.isInteger(ref.bytes) &&
          ZONED_ISO.test(ref.captured_at || '') && Number.isFinite(Date.parse(ref.captured_at)) && ref.temporal_source;
      }));
    const conflict = rows.some((claim) => claim.state === 'conflict') ||
      new Set(observed.map((claim) => fingerprint(claim.value))).size > 1;
    return [kind, { state: conflict ? 'conflict' : observed.length ? 'observed' : 'unknown',
      value: conflict || !observed.length ? null : observed[0].value,
      refs: [...new Set(rows.flatMap((claim) => claim.refs))],
      limitations: rows.flatMap((claim) => claim.limitations) }];
  }));
}

// This is the closed subset used by this schema, not a general JSON Schema engine.
function validateShape(value, rule, field, diagnostics, depth = 0) {
  if (depth > 64) { diagnostics.push({ code: 'input_depth_exceeded', field }); return; }
  const error = (code) => diagnostics.push({ code, field });
  const object = value !== null && typeof value === 'object' && !Array.isArray(value);
  if (rule.type && !(rule.type === 'object' ? object : rule.type === 'array' ? Array.isArray(value) :
    rule.type === 'integer' ? Number.isSafeInteger(value) : typeof value === rule.type)) { error('field_type'); return; }
  if (rule.enum && !rule.enum.includes(value)) error('field_enum');
  if (rule.minLength && value.length < rule.minLength) error('field_empty');
  if (rule.minimum !== undefined && value < rule.minimum) error('field_minimum');
  if (rule.pattern && !new RegExp(rule.pattern).test(value)) error('field_pattern');
  if (rule.format === 'date-time' && (!ZONED_ISO.test(value) || !Number.isFinite(Date.parse(value)))) error('field_timestamp');
  if (rule.type === 'array') value.forEach((entry, index) => validateShape(entry, rule.items, `${field}[${index}]`, diagnostics, depth + 1));
  if (rule.type === 'object') {
    for (const key of rule.required || []) if (!Object.hasOwn(value, key)) diagnostics.push({ code: 'field_required', field: `${field}.${key}` });
    for (const key of Object.keys(value)) {
      if (rule.properties && Object.hasOwn(rule.properties, key)) validateShape(value[key], rule.properties[key], `${field}.${key}`, diagnostics, depth + 1);
      else if (rule.additionalProperties === false) diagnostics.push({ code: 'field_unknown', field: `${field}.${key}` });
    }
  }
}

function validateCorpus(input) {
  const diagnostics = [];
  if (typeof input === 'string' || Buffer.isBuffer(input)) {
    if (Buffer.byteLength(input) > MAX_INPUT_BYTES) return { valid: false, ready: false, diagnostics: [{ code: 'input_too_large' }] };
    try { input = JSON.parse(input.toString()); } catch (_) { return { valid: false, ready: false, diagnostics: [{ code: 'json_malformed' }] }; }
  }
  // Bound object input too; canonical callers may supply parsed data.
  try { if (Buffer.byteLength(JSON.stringify(input)) > MAX_INPUT_BYTES) throw new Error(); }
  catch (_) { return { valid: false, ready: false, diagnostics: [{ code: 'input_unserializable_or_large' }] }; }
  validateShape(input, schema, '$', diagnostics);
  if (diagnostics.length) return { valid: false, ready: false, diagnostics };
  const fail = (code, field) => diagnostics.push({ code, field });
  const refs = new Map();
  for (const ref of input.references) {
    if (refs.has(ref.id)) fail(fingerprint(refs.get(ref.id)) === fingerprint(ref) ? 'reference_duplicate' : 'reference_conflict', ref.id);
    refs.set(ref.id, ref);
    const region = ref.role === 'prework' ? 'prework' : ref.role.startsWith('grader/') ? 'grader' : ref.role;
    if (ref.region !== region) fail('reference_region_mismatch', ref.id);
    if (ref.state === 'observed' && (!ref.path || ref.bytes === undefined || !ref.sha256 || !ref.captured_at || !ref.temporal_source)) fail('reference_integrity_missing', ref.id);
    if (!ref.lineage.length) fail('reference_lineage_missing', ref.id);
    if (ref.captured_at && Date.parse(ref.captured_at) > Date.parse(input.captured_at)) fail('reference_capture_future', ref.id);
    for (const key of ['revision', 'peg']) if (ref[key] !== undefined && !/^\d+$/.test(ref[key])) fail('reference_revision_invalid', ref.id);
  }
  const checkRefs = (ids, field) => { for (const id of ids) if (!refs.has(id)) fail('reference_unknown', `${field}:${id}`); };
  const deliveries = new Map(); const versions = new Set(); const families = new Map();
  const provenance = []; let sufficient = input.candidates.some((candidate) => candidate.selection === 'included');
  for (const [index, candidate] of input.candidates.entries()) {
    const field = `candidates[${index}]`; let identity;
    try { identity = caseIdentity(candidate); } catch (error) { fail('identity_invalid', `${field}:${error.message}`); continue; }
    for (const key of Object.keys(identity)) if (candidate[key] !== identity[key]) fail('identity_mismatch', `${field}.${key}`);
    if (deliveries.has(candidate.delivery_id) && deliveries.get(candidate.delivery_id) !== candidate.family_id) fail('identity_conflict', field);
    deliveries.set(candidate.delivery_id, candidate.family_id);
    const versionKey = `${candidate.delivery_id}/${candidate.version}`;
    if (versions.has(versionKey)) fail('version_duplicate', field);
    versions.add(versionKey);
    checkRefs(candidate.refs, field);
    for (const tag of ['type', 'stratum']) {
      checkRefs(candidate[tag].refs, `${field}.${tag}`);
      if (candidate[tag].value !== 'unknown' && !candidate[tag].refs.length) fail('classification_source_missing', `${field}.${tag}`);
    }
    for (const claim of candidate.claims) {
      checkRefs(claim.refs, field);
      if (claim.state !== 'observed' && claim.value !== null) fail('unknown_value_not_null', field);
      if (claim.state === 'observed' && claim.value === null) fail('observed_value_missing', field);
    }
    for (const metric of Object.values(candidate.metrics)) {
      checkRefs(metric.refs, field);
      if (metric.state !== 'observed' && metric.value !== null) fail('unknown_value_not_null', field);
      if (metric.state === 'observed' && (metric.value === null || !metric.refs.length)) fail('metric_evidence_missing', field);
    }
    if (!candidate.result.checks.length || candidate.result.passed !== candidate.result.checks.every((check) => check.passed)) fail('result_inconsistent', field);
    if (!candidate.reasons.length) fail('selection_reason_missing', field);
    const exposed = input.exposure_registry.some((entry) => entry.family_id === candidate.family_id);
    families.set(candidate.family_id, exposed);
    if (exposed && input.split_policy.reserved_families.includes(candidate.family_id)) fail('reserved_family_exposed', field);
    const classified = classifyProvenance(candidate.claims, input.references);
    provenance.push({ case_id: candidate.case_id, version: candidate.version, claims: classified });
    sufficient = sufficient && candidate.selection !== 'insufficient' && (candidate.selection === 'excluded' ||
      (candidate.coverage.state === 'complete' && ['prework', 'grader/criteria', 'grader/expected', 'grader/final-code'].every((role) => candidate.refs.some((id) => refs.get(id)?.role === role && refs.get(id)?.state === 'observed')) && candidate.refs.every((id) => refs.get(id)?.state === 'observed' && refs.get(id)?.role !== 'unknown')));
  }
  for (const entry of input.exposure_registry) {
    checkRefs(entry.refs, 'exposure_registry');
    if (!families.has(entry.family_id)) fail('exposure_family_unknown', entry.family_id);
    if (Date.parse(entry.captured_at) > Date.parse(input.captured_at)) fail('exposure_capture_future', entry.family_id);
  }
  return { valid: diagnostics.length === 0, ready: diagnostics.length === 0 && sufficient,
    diagnostics, counts: { candidates: input.candidates.length, deliveries: deliveries.size, versions: versions.size,
      files: new Set(input.references.filter((ref) => ref.state === 'observed').map((ref) => `${ref.origin}/${ref.path}`)).size,
      revisions: new Set(input.references.filter((ref) => ref.revision).map((ref) => `${ref.origin}/${ref.revision}`)).size }, provenance,
    agent_input_refs: input.references.filter((ref) => ref.role === 'prework' && ref.region === 'prework' && ref.state === 'observed' && ref.lineage.length).map((ref) => ref.id),
    authority: { commands: false, network: false, additional_roots: false } };
}

module.exports = { validateCorpus, caseIdentity, classifyProvenance, validateShape, MAX_INPUT_BYTES };
if (require.main === module) {
  try {
    const result = validateCorpus(fs.readFileSync(process.argv[2]));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.valid ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ valid: false, ready: false, diagnostics: [{ code: 'input_unreadable', detail: error.code || error.message }] })}\n`);
    process.exitCode = 1;
  }
}
