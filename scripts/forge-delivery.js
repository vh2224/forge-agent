#!/usr/bin/env node
'use strict';

// Deterministic acceptance-criterion delivery projection. This helper only
// reads declared files and renders data; it never runs evidence commands.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { hasStructuredMustHaves, parseMustHaves } = require('./forge-must-haves.js');
const { resolveEvidenceFiles } = require('./forge-evidence-path.js');

const SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_CRITERIA = 1000;
const MAX_BINDINGS = 5000;
const MAX_CHILDREN = 100;
const MAX_DEPTH = 4;
const MAX_OBSERVATIONS = 100;
const FACT_NAMES = Object.freeze(['implementation', 'ci', 'review', 'merge', 'installation', 'human_acceptance']);
const FACT_LABELS = Object.freeze({
  implementation: 'Implementação', ci: 'CI', review: 'Revisão', merge: 'Merge',
  installation: 'Instalação', human_acceptance: 'Aceite humano',
});

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}
function fingerprint(value) { return sha256(JSON.stringify(canonical(value))); }
function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function nonEmpty(value) { return typeof value === 'string' && value.trim().length > 0; }
function normalizeSlashes(value) { return String(value).replace(/\\/g, '/'); }
function unitKey(unit) {
  if (!isObject(unit) || !nonEmpty(unit.type) || !nonEmpty(unit.id)) return null;
  if (!['task', 'slice', 'milestone'].includes(unit.type)) return null;
  return [unit.milestone, unit.slice, unit.type, unit.id].filter(nonEmpty).join('/');
}
function sameUnit(left, right) { return unitKey(left) !== null && unitKey(left) === unitKey(right); }
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function rootRealpaths(roots) {
  return roots.filter(nonEmpty).map((root) => fs.realpathSync(path.resolve(root)));
}

function resolveSafeFile(reference, roots, options = {}) {
  if (!nonEmpty(reference)) return { error: 'reference_missing' };
  const absolute = path.isAbsolute(reference) ? path.resolve(reference) : path.resolve(options.base || roots[0], reference);
  let real;
  try { real = fs.realpathSync(absolute); } catch (error) { return { error: error.code === 'ENOENT' ? 'source_missing' : 'source_unreadable' }; }
  if (!roots.some((root) => inside(root, real))) return { error: 'source_outside_roots' };
  let stat;
  try { stat = fs.statSync(real); } catch (_) { return { error: 'source_unreadable' }; }
  if (!stat.isFile()) return { error: 'source_not_file' };
  if (stat.size > (options.maxBytes || MAX_FILE_BYTES)) return { error: 'source_too_large' };
  return { path: real, size: stat.size };
}

function readJsonReference(reference, roots, cache, options = {}) {
  const resolved = resolveSafeFile(reference, roots, options);
  if (resolved.error) return resolved;
  if (cache.has(resolved.path)) return cache.get(resolved.path);
  let result;
  try {
    result = { path: resolved.path, value: JSON.parse(fs.readFileSync(resolved.path, 'utf8')) };
  } catch (error) {
    result = { path: resolved.path, error: error instanceof SyntaxError ? 'source_malformed_json' : 'source_unreadable' };
  }
  cache.set(resolved.path, result);
  return result;
}

function criterionId(unit, kind, index) { return `${unitKey(unit)}:${kind}:${index}`; }
function normalizeAspects(value) {
  if (value === undefined) return ['default'];
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => !nonEmpty(item))) return null;
  return [...new Set(value.map((item) => item.trim()))];
}
function makeCriterion(unit, kind, index, text, reference, type, aspects, extra = {}) {
  return {
    id: criterionId(unit, kind, index), unit: canonical(unit), origin: kind, index,
    text: String(text), reference: String(reference), type, aspects, observations: [], ...extra,
  };
}

function inventoryPlan(raw, planReference, unit) {
  const diagnostics = [];
  if (!nonEmpty(raw)) return { criteria: [], diagnostics: ['plan_empty'], structured: false };
  if (!hasStructuredMustHaves(raw)) return { criteria: [], diagnostics: ['plan_legacy'], structured: false };
  let parsed;
  try { parsed = parseMustHaves(raw); } catch (_) { return { criteria: [], diagnostics: ['plan_malformed'], structured: false }; }
  const criteria = [];
  for (let index = 0; index < parsed.truths.length; index++) {
    criteria.push(makeCriterion(unit, 'truth', index, parsed.truths[index], `${planReference}#must_haves.truths[${index}]`, 'functional', ['default']));
  }
  for (let index = 0; index < parsed.artifacts.length; index++) {
    const item = parsed.artifacts[index];
    criteria.push(makeCriterion(unit, 'artifact', index, `${item.path}: ${item.provides}`, `${planReference}#must_haves.artifacts[${index}]`, 'structural', ['declared-property'], { artifact_path: item.path }));
  }
  for (let index = 0; index < parsed.key_links.length; index++) {
    const item = parsed.key_links[index];
    criteria.push(makeCriterion(unit, 'key_link', index, `${item.from} → ${item.to}: ${item.via}`, `${planReference}#must_haves.key_links[${index}]`, 'structural', ['declared-link']));
  }
  if (criteria.length === 0) diagnostics.push('plan_inventory_empty');
  return { criteria, diagnostics, structured: true };
}

function addAdditionalCriteria(criteria, entries, unit, diagnostics) {
  if (entries === undefined) return;
  if (!Array.isArray(entries)) { diagnostics.push('additional_criteria_invalid'); return; }
  const seen = new Set();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!isObject(entry) || !nonEmpty(entry.id) || !nonEmpty(entry.text) || !nonEmpty(entry.reference)
      || !['functional', 'structural'].includes(entry.type)) {
      diagnostics.push(`additional_criterion_invalid:${index}`); continue;
    }
    const aspects = normalizeAspects(entry.aspects);
    if (!aspects) { diagnostics.push(`additional_criterion_aspects_invalid:${index}`); continue; }
    if (seen.has(entry.id)) { diagnostics.push(`additional_criterion_duplicate:${entry.id}`); continue; }
    seen.add(entry.id);
    criteria.push(makeCriterion(unit, 'additional', entry.id, entry.text, entry.reference, entry.type, aspects));
  }
}

function resolveCriterionSelector(binding, criteria, unit) {
  if (nonEmpty(binding.criterion_id)) return criteria.some((item) => item.id === binding.criterion_id) ? binding.criterion_id : null;
  if (!isObject(binding.criterion) || !['truth', 'artifact', 'key_link', 'additional'].includes(binding.criterion.kind)) return null;
  const index = binding.criterion.index !== undefined ? binding.criterion.index : binding.criterion.id;
  const id = criterionId(unit, binding.criterion.kind, index);
  return criteria.some((item) => item.id === id) ? id : null;
}

function contextReasons(envelope, expected) {
  const reasons = [];
  if (!expected.inputPlanFingerprintValid) reasons.push('input_plan_fingerprint_invalid');
  if (!sameUnit(envelope.unit, expected.unit)) reasons.push('source_unit_mismatch');
  if (envelope.plan_fingerprint !== expected.planFingerprint) reasons.push('source_plan_fingerprint_mismatch');
  for (const field of ['code_dir', 'revision', 'environment', 'captured_at']) if (!nonEmpty(envelope[field])) reasons.push(`source_context_missing:${field}`);
  if (nonEmpty(envelope.code_dir)) {
    try {
      if (fs.realpathSync(path.resolve(envelope.code_dir)) !== expected.codeDirReal) reasons.push('source_code_dir_mismatch');
    } catch (_) { reasons.push('source_code_dir_unavailable'); }
  }
  return reasons;
}

function observationBase(binding, sourcePath, aspect) {
  return { aspect, source: normalizeSlashes(sourcePath), coverage: binding.coverage || null, positive: false, negative: false, limitations: [], reasons: [] };
}
function invalidObservation(binding, source, aspect, reason) {
  const observation = observationBase(binding, source || binding.source && binding.source.path || '<invalid>', aspect);
  observation.reasons.push(reason);
  observation.limitations.push(reason);
  return observation;
}
function checkExitCode(check) {
  if (Number.isInteger(check.exitCode)) return check.exitCode;
  if (Number.isInteger(check.exit_code)) return check.exit_code;
  return undefined;
}

function verificationObservation(binding, envelope, sourcePath, criterion, expected) {
  const aspect = nonEmpty(binding.aspect) ? binding.aspect : criterion.aspects[0];
  const observation = observationBase(binding, `${sourcePath}#checks[${binding.source.check_index}]`, aspect);
  observation.environment = nonEmpty(envelope.environment) ? envelope.environment : null;
  observation.revision = nonEmpty(envelope.revision) ? envelope.revision : null;
  const reasons = contextReasons(envelope, expected);
  if (envelope.schema_version !== SCHEMA_VERSION || envelope.kind !== 'verification' || !isObject(envelope.result)) reasons.push('verification_envelope_invalid');
  if (!['behavioral', 'structural'].includes(binding.coverage)) reasons.push('binding_coverage_invalid');
  if (criterion.type === 'functional' && binding.coverage !== 'behavioral') reasons.push('functional_requires_behavioral_evidence');
  const checks = envelope.result && envelope.result.checks;
  const index = binding.source.check_index;
  if (!Array.isArray(checks) || checks.length === 0) reasons.push(envelope.result && envelope.result.skipped ? `verification_skipped:${envelope.result.skipped}` : 'verification_checks_empty');
  if (!Number.isInteger(index) || !Array.isArray(checks) || !isObject(checks[index])) reasons.push('verification_check_missing');
  const check = Array.isArray(checks) && isObject(checks[index]) ? checks[index] : null;
  if (check) {
    const exitCode = checkExitCode(check);
    const skip = check.skipped || (envelope.result && envelope.result.skipped);
    if (skip) { observation.negative = true; reasons.push(`verification_skipped:${skip}`); }
    else if (exitCode === undefined) reasons.push('verification_exit_code_missing');
    else if (exitCode !== 0) { observation.negative = true; reasons.push(exitCode === 124 ? 'verification_timeout' : `verification_failed:${exitCode}`); }
    else if (reasons.length === 0) observation.positive = true;
  }
  observation.reasons.push(...reasons);
  observation.limitations.push(...reasons.filter((reason) => !reason.startsWith('verification_failed:') && reason !== 'verification_timeout'));
  return observation;
}

function artifactObservation(binding, envelope, sourcePath, criterion, expected) {
  const aspect = nonEmpty(binding.aspect) ? binding.aspect : criterion.aspects[0];
  const index = binding.source.row_index;
  const property = binding.source.property;
  const observation = observationBase(binding, `${sourcePath}#rows[${index}].${property}`, aspect);
  observation.environment = nonEmpty(envelope.environment) ? envelope.environment : null;
  observation.revision = nonEmpty(envelope.revision) ? envelope.revision : null;
  const reasons = contextReasons(envelope, expected);
  if (envelope.schema_version !== SCHEMA_VERSION || envelope.kind !== 'artifact' || !isObject(envelope.result)) reasons.push('artifact_envelope_invalid');
  if (criterion.type !== 'structural' || binding.coverage !== 'structural') reasons.push('artifact_evidence_structural_only');
  if (!['exists', 'substantive', 'wired'].includes(property)) reasons.push('artifact_property_invalid');
  if (envelope.result && envelope.result.legacy) reasons.push('artifact_result_legacy');
  const rows = envelope.result && envelope.result.rows;
  if (!Number.isInteger(index) || !Array.isArray(rows) || !isObject(rows[index])) reasons.push('artifact_row_missing');
  const row = Array.isArray(rows) && isObject(rows[index]) ? rows[index] : null;
  if (row && ['exists', 'substantive', 'wired'].includes(property)) {
    const approximate = row.approximate === true || (row.flags || []).some((flag) => flag && (flag.reason === 'approximate' || flag.level === 'approximate'));
    if (approximate) reasons.push('artifact_result_approximate');
    if (row[property] === false) { observation.negative = true; reasons.push(`artifact_${property}_failed`); }
    else if (row[property] !== true) reasons.push(`artifact_${property}_unknown`);
    else if (reasons.length === 0) observation.positive = true;
  }
  observation.reasons.push(...reasons);
  observation.limitations.push(...reasons.filter((reason) => !reason.endsWith('_failed')));
  return observation;
}

function advisoryObservation(binding, ownerRoot, criterion) {
  const aspect = nonEmpty(binding.aspect) ? binding.aspect : criterion.aspects[0];
  const observation = observationBase(binding, binding.source.path || 'verification_evidence', aspect);
  const axes = isObject(binding.source.axes) ? binding.source.axes : {};
  const resolved = resolveEvidenceFiles(ownerRoot, axes);
  observation.reasons.push('advisory_evidence_not_proof');
  observation.limitations.push('advisory_evidence_not_proof');
  observation.advisory_files = (resolved.files || []).map((entry) => entry.name);
  return observation;
}

function applyBindings(input, criteria, context, diagnostics) {
  const bindings = input.bindings === undefined ? [] : input.bindings;
  if (!Array.isArray(bindings)) { diagnostics.push('bindings_invalid'); return; }
  if (bindings.length > MAX_BINDINGS) { diagnostics.push('bindings_limit_exceeded'); return; }
  const byId = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  const cache = new Map();
  for (let index = 0; index < bindings.length; index++) {
    const binding = bindings[index];
    if (!isObject(binding) || !isObject(binding.source)) { diagnostics.push(`binding_invalid:${index}`); continue; }
    const criterionIdValue = resolveCriterionSelector(binding, criteria, context.unit);
    if (!criterionIdValue) { diagnostics.push(`binding_unknown_criterion:${index}`); continue; }
    const criterion = byId.get(criterionIdValue);
    const aspect = nonEmpty(binding.aspect) ? binding.aspect : criterion.aspects[0];
    if (!criterion.aspects.includes(aspect)) { diagnostics.push(`binding_unknown_aspect:${index}`); continue; }
    if (criterion.observations.length >= MAX_OBSERVATIONS) { diagnostics.push(`binding_observation_limit:${criterion.id}`); continue; }
    if (binding.source.kind === 'advisory') {
      criterion.observations.push(advisoryObservation(binding, context.ownerRoot, criterion));
      continue;
    }
    if (!['verification', 'artifact'].includes(binding.source.kind)) {
      criterion.observations.push(invalidObservation(binding, binding.source.path, aspect, 'binding_source_kind_invalid')); continue;
    }
    const loaded = readJsonReference(binding.source.path, context.roots, cache, { base: context.ownerRoot });
    if (loaded.error) { criterion.observations.push(invalidObservation(binding, binding.source.path, aspect, loaded.error)); continue; }
    if (!isObject(loaded.value)) { criterion.observations.push(invalidObservation(binding, loaded.path, aspect, 'source_schema_invalid')); continue; }
    const observation = binding.source.kind === 'verification'
      ? verificationObservation(binding, loaded.value, loaded.path, criterion, context)
      : artifactObservation(binding, loaded.value, loaded.path, criterion, context);
    criterion.observations.push(observation);
  }
}

function classifyCriterion(criterion) {
  const aspects = Array.isArray(criterion.aspects) && criterion.aspects.length ? criterion.aspects : ['default'];
  const observations = Array.isArray(criterion.observations) ? criterion.observations : [];
  let anyPositive = false;
  let fullyPositive = true;
  const pending = [];
  const evidence = [];
  for (const aspect of aspects) {
    const relevant = observations.filter((entry) => entry && entry.aspect === aspect);
    const positive = relevant.some((entry) => entry.positive === true);
    const negative = relevant.some((entry) => entry.negative === true);
    const limited = relevant.some((entry) => Array.isArray(entry.limitations) && entry.limitations.length > 0);
    anyPositive = anyPositive || positive;
    fullyPositive = fullyPositive && positive && !negative && !limited;
    if (!positive) pending.push(`aspect_unverified:${aspect}`);
    if (negative && positive) pending.push(`evidence_conflict:${aspect}`);
    else if (negative) pending.push(`negative_evidence:${aspect}`);
    if (limited) pending.push(...relevant.flatMap((entry) => entry.limitations || []).map((reason) => `${aspect}:${reason}`));
    evidence.push(...relevant.map((entry) => ({ ...entry })));
  }
  const status = fullyPositive ? 'verificado' : anyPositive ? 'parcialmente verificado' : 'não verificado';
  return { ...criterion, status, evidence, pending: [...new Set(pending)], observations: undefined };
}

function normalizeFacts(facts) {
  const source = isObject(facts) ? facts : {};
  return FACT_NAMES.map((name) => {
    const value = source[name];
    if (!isObject(value) || !nonEmpty(value.status) || !nonEmpty(value.reference)) return { name, status: 'não informado/pendente', reference: null };
    return { name, status: value.status.trim(), reference: value.reference.trim() };
  });
}

function outputCore(output) {
  const clone = { ...output };
  delete clone.delivery_fingerprint;
  return clone;
}
function finalizeOutput(output) { return { ...output, delivery_fingerprint: fingerprint(outputCore(output)) }; }
function validateChildDelivery(child, expectedUnit, parentUnit) {
  if (!isObject(child) || child.schema_version !== SCHEMA_VERSION || child.generated_by !== 'forge-delivery') return { error: 'child_schema_invalid' };
  if (!sameUnit(child.unit, expectedUnit)) return { error: 'child_unit_mismatch' };
  if (child.delivery_fingerprint !== fingerprint(outputCore(child))) return { error: 'child_fingerprint_invalid' };
  if (!Array.isArray(child.criteria) || child.criteria.length > MAX_CRITERIA) return { error: 'child_criteria_invalid' };
  if (!Number.isInteger(child.depth) || child.depth < 0 || child.depth >= MAX_DEPTH) return { error: 'child_depth_invalid' };
  if (!Array.isArray(child.lineage) || child.lineage.includes(unitKey(parentUnit))) return { error: 'child_cycle' };
  const childKey = unitKey(expectedUnit);
  const criteria = [];
  for (const item of child.criteria) {
    if (!isObject(item) || !nonEmpty(item.id) || !item.id.startsWith(`${childKey}:`) || !nonEmpty(item.text)
      || !nonEmpty(item.reference) || !['functional', 'structural'].includes(item.type)
      || !Array.isArray(item.aspects) || item.aspects.length === 0 || !Array.isArray(item.evidence)
      || item.evidence.some((entry) => !isObject(entry) || !nonEmpty(entry.aspect)
        || !item.aspects.includes(entry.aspect) || typeof entry.positive !== 'boolean'
        || typeof entry.negative !== 'boolean' || !Array.isArray(entry.limitations)
        || !Array.isArray(entry.reasons))) return { error: 'child_criterion_invalid' };
    const recomputed = classifyCriterion({ ...item, observations: item.evidence, status: undefined, evidence: undefined, pending: undefined });
    criteria.push({ ...recomputed, child: true });
  }
  const diagnostics = [];
  if (!isObject(child.plan) || child.plan.structured !== true) diagnostics.push('child_plan_legacy_or_unstructured');
  if (criteria.length === 0) diagnostics.push('child_inventory_empty');
  if (Array.isArray(child.diagnostics)) {
    for (const diagnostic of child.diagnostics) if (nonEmpty(diagnostic)) diagnostics.push(`child_reported:${diagnostic}`);
  }
  return { criteria, depth: child.depth, lineage: child.lineage, diagnostics };
}

function aggregateChildren(input, context, diagnostics) {
  const expected = input.expected_children === undefined ? [] : input.expected_children;
  if (!Array.isArray(expected)) { diagnostics.push('expected_children_invalid'); return { criteria: [], depth: 0, lineage: [] }; }
  if (expected.length > MAX_CHILDREN) { diagnostics.push('children_limit_exceeded'); return { criteria: [], depth: 0, lineage: [] }; }
  const cache = new Map();
  const seenPaths = new Set();
  const criteria = [];
  let depth = 0;
  const lineage = [];
  for (let index = 0; index < expected.length; index++) {
    const childRef = expected[index];
    if (!isObject(childRef) || !unitKey(childRef.unit) || !nonEmpty(childRef.delivery)) { diagnostics.push(`child_invalid:${index}`); continue; }
    const loaded = readJsonReference(childRef.delivery, [context.ownerRootReal], cache, { base: context.ownerRoot });
    if (loaded.error) { diagnostics.push(`child_${loaded.error}:${unitKey(childRef.unit)}`); continue; }
    if (seenPaths.has(loaded.path)) { diagnostics.push(`child_cycle_or_duplicate:${unitKey(childRef.unit)}`); continue; }
    seenPaths.add(loaded.path);
    const checked = validateChildDelivery(loaded.value, childRef.unit, context.unit);
    if (checked.error) { diagnostics.push(`${checked.error}:${unitKey(childRef.unit)}`); continue; }
    criteria.push(...checked.criteria);
    diagnostics.push(...checked.diagnostics.map((item) => `${item}:${unitKey(childRef.unit)}`));
    depth = Math.max(depth, checked.depth + 1);
    lineage.push(...checked.lineage);
  }
  return { criteria, depth, lineage };
}

function buildDelivery(input, options = {}) {
  if (!isObject(input) || input.schema_version !== SCHEMA_VERSION) throw new Error('input schema_version 1 is required');
  const unit = input.unit;
  if (!unitKey(unit)) throw new Error('input.unit must contain a valid type and id');
  if (!nonEmpty(options.ownerRoot) || !nonEmpty(options.codeDir)) throw new Error('ownerRoot and codeDir are required');
  const [ownerRootReal, codeDirReal] = rootRealpaths([options.ownerRoot, options.codeDir]);
  const roots = [...new Set([ownerRootReal, codeDirReal])];
  const planResolved = path.isAbsolute(String(input.plan || ''))
    ? { error: 'reference_not_relative' }
    : resolveSafeFile(input.plan, [ownerRootReal], { base: ownerRootReal });
  let planRaw = '';
  const diagnostics = [];
  if (planResolved.error) diagnostics.push(`plan_${planResolved.error}`);
  else planRaw = fs.readFileSync(planResolved.path, 'utf8');
  const actualPlanFingerprint = planRaw ? sha256(planRaw) : null;
  if (!nonEmpty(input.plan_fingerprint)) diagnostics.push('plan_fingerprint_missing');
  else if (actualPlanFingerprint !== input.plan_fingerprint) diagnostics.push('plan_fingerprint_mismatch');
  const planReference = nonEmpty(input.plan) ? normalizeSlashes(input.plan) : '<plan-missing>';
  const inventory = inventoryPlan(planRaw, planReference, unit);
  diagnostics.push(...inventory.diagnostics);
  const criteria = inventory.criteria;
  addAdditionalCriteria(criteria, input.additional_criteria, unit, diagnostics);
  if (criteria.length > MAX_CRITERIA) throw new Error(`criteria limit exceeded (${MAX_CRITERIA})`);
  const context = {
    unit, ownerRoot: ownerRootReal, ownerRootReal, codeDirReal, roots,
    planFingerprint: actualPlanFingerprint,
    inputPlanFingerprintValid: nonEmpty(input.plan_fingerprint) && input.plan_fingerprint === actualPlanFingerprint,
  };
  applyBindings(input, criteria, context, diagnostics);
  let classified = criteria.map(classifyCriterion);
  const children = aggregateChildren(input, context, diagnostics);
  classified = classified.concat(children.criteria);
  const ownKey = unitKey(unit);
  const output = {
    schema_version: SCHEMA_VERSION,
    generated_by: 'forge-delivery',
    unit: canonical(unit),
    plan: { reference: planReference, fingerprint: actualPlanFingerprint, structured: inventory.structured },
    criteria: classified,
    facts: normalizeFacts(input.facts),
    diagnostics: [...new Set(diagnostics)].sort(),
    depth: children.depth,
    lineage: [...new Set([ownKey, ...children.lineage])].sort(),
    source_limits: { max_file_bytes: MAX_FILE_BYTES, max_criteria: MAX_CRITERIA, max_bindings: MAX_BINDINGS, max_children: MAX_CHILDREN, max_depth: MAX_DEPTH },
  };
  return finalizeOutput(output);
}

function escapeMarkdownCell(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\\/g, '&#92;').replace(/`/g, '&#96;').replace(/\|/g, '&#124;')
    .replace(/\[/g, '&#91;').replace(/\]/g, '&#93;').replace(/!/g, '&#33;')
    .replace(/\*/g, '&#42;').replace(/_/g, '&#95;').replace(/~/g, '&#126;')
    .replace(/\r?\n/g, '<br>');
}
function evidenceText(criterion) {
  if (!criterion.evidence || criterion.evidence.length === 0) return 'nenhuma';
  return criterion.evidence.map((entry) => {
    const reasons = Array.isArray(entry.reasons) && entry.reasons.length ? ` [${entry.reasons.join(', ')}]` : '';
    return `${entry.positive ? 'ok' : entry.negative ? 'falha' : 'limite'}: ${entry.source}${reasons}`;
  }).join('; ');
}
function renderDeliveryMarkdown(delivery, options = {}) {
  const limit = Number.isInteger(options.tableLimit) && options.tableLimit > 0 ? options.tableLimit : 50;
  const detail = options.detailReference || `${delivery.unit.id}-DELIVERY.json`;
  const ranked = [...delivery.criteria].sort((a, b) => {
    const rank = { 'não verificado': 0, 'parcialmente verificado': 1, verificado: 2 };
    return (rank[a.status] - rank[b.status]) || a.id.localeCompare(b.id);
  });
  const visible = ranked.slice(0, limit);
  const omitted = ranked.slice(limit);
  const lines = ['## Entrega por critério', '', `Detalhe integral reconstruível: ${escapeMarkdownCell(detail)}`, '', '| Critério | Situação | Evidência | Ambiente exercitado | Pendência/limite |', '|---|---|---|---|---|'];
  for (const criterion of visible) {
    const environments = [...new Set((criterion.evidence || []).map((entry) => entry.environment).filter(nonEmpty))];
    lines.push(`| ${escapeMarkdownCell(`${criterion.id} — ${criterion.text} (${criterion.reference})`)} | ${escapeMarkdownCell(criterion.status)} | ${escapeMarkdownCell(evidenceText(criterion))} | ${escapeMarkdownCell(environments.join('; ') || 'não informado')} | ${escapeMarkdownCell((criterion.pending || []).join('; ') || 'nenhuma')} |`);
  }
  if (omitted.length) {
    const counts = omitted.reduce((acc, item) => { acc[item.status] = (acc[item.status] || 0) + 1; return acc; }, {});
    lines.push(`| … ${omitted.length} critério(s) no detalhe integral | tabela limitada | ${escapeMarkdownCell(JSON.stringify(counts))} | — | consultar ${escapeMarkdownCell(detail)} |`);
  }
  lines.push('', '### Fatos independentes', '', '| Fato | Situação | Referência |', '|---|---|---|');
  for (const fact of delivery.facts) lines.push(`| ${FACT_LABELS[fact.name]} | ${escapeMarkdownCell(fact.status)} | ${escapeMarkdownCell(fact.reference || 'não informado')} |`);
  if (delivery.diagnostics.length) lines.push('', `Diagnósticos: ${delivery.diagnostics.map(escapeMarkdownCell).join('; ')}.`);
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (['--input', '--owner-root', '--code-dir', '--detail-reference', '--table-limit'].includes(arg)) result[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++index];
    else if (arg === '--json') result.format = 'json';
    else if (arg === '--markdown') result.format = 'markdown';
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!result.input || !result.ownerRoot || !result.codeDir || !result.format) throw new Error('usage: forge-delivery.js --input <json> --owner-root <path> --code-dir <path> (--json|--markdown)');
  return result;
}

function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const roots = rootRealpaths([args.ownerRoot, args.codeDir]);
  const loaded = readJsonReference(args.input, roots, new Map(), { base: roots[0] });
  if (loaded.error) throw new Error(`input_${loaded.error}`);
  const delivery = buildDelivery(loaded.value, { ownerRoot: args.ownerRoot, codeDir: args.codeDir });
  if (args.format === 'json') process.stdout.write(`${JSON.stringify(delivery, null, 2)}\n`);
  else process.stdout.write(renderDeliveryMarkdown(delivery, { detailReference: args.detailReference, tableLimit: Number(args.tableLimit) || undefined }));
}

module.exports = {
  SCHEMA_VERSION, MAX_FILE_BYTES, MAX_CRITERIA, MAX_BINDINGS, MAX_CHILDREN, MAX_DEPTH,
  sha256, canonical, fingerprint, unitKey, resolveSafeFile, inventoryPlan, classifyCriterion,
  buildDelivery, renderDeliveryMarkdown, escapeMarkdownCell, finalizeOutput,
};

if (require.main === module) {
  try { runCli(); } catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 1; }
}
