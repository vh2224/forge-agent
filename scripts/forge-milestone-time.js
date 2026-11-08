#!/usr/bin/env node
'use strict';

// Owner API: writers may run only at safe controller boundaries, never during
// a protected worker window. Import is inert; readers never load the owner lock.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SCHEMA_VERSION = 1;
const ENDPOINT_ITEMS = Object.freeze(['publication', 'installation', 'manual-uat', 'external-waits']);
const ITEM_STATES = Object.freeze(['included', 'pending', 'completed', 'deferred', 'not-applicable']);
const AMENDMENT_KINDS = Object.freeze(['extension', 'allocation', 'scope-reduction', 'continue-to-cap']);
const DECISION_KINDS = Object.freeze(['activation', ...AMENDMENT_KINDS, 'linked-task']);
// Pre-activation records live beside the contract; alone they keep it absent.
const PRE_ACTIVATION_ENTRIES = Object.freeze(['enrollment.json', 'options', 'selection.json']);
const LINKED_TASK_AUTHORIZATIONS = Object.freeze(['create-and-start-after-proven-completion', 'create-without-auto-start', 'none']);
const ENROLLMENT_SOURCES = ['forge-new-milestone', 'forge-auto', 'forge-next', 'owner'];
const SELECTION_KEYS = ['schema_version', 'milestone', 'choice', 'options_sha256', 'option_id', 'position_id', 'linked_task_authorization', 'contract_request', 'rounds', 'decisions', 'selected_at'];
const DELEGATION_KEYS = ['basis', 'contract_sha256', 'decision', 'options_sha256', 'selection_sha256', 'conformance_sha256', 'previous_allocation'];
const JOURNAL_TYPES = Object.freeze(['presence', 'wait-start', 'wait-end']);
const WAIT_CLASSES = Object.freeze(['human', 'pause', 'ci', 'external']);
const MAX_CONTRACT = 256 * 1024, MAX_AMENDMENT = 64 * 1024, MAX_RECORDS = 256, MAX_OPTIONS = 256 * 1024, MAX_ROUNDS = 64;
const MAX_JOURNAL = 2 * 1024 * 1024, MAX_LINES = 50000, MAX_LINE = 32768;
const authorities = new WeakMap();
const HASH = /^[a-f0-9]{64}$/, ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/;
const CONTRACT_KEYS = ['schema_version', 'milestone', 'clock_policy', 'option', 'activated_at', 'preselection_started_at', 'ceiling_ms', 'endpoint', 'allocation', 'linked_task', 'chain_forecast', 'decision'];
const ALLOCATION_KINDS = ['preparation', 'slice', 'integration', 'review', 'corrections'];
function fail(code) { throw Object.assign(new Error(code), { code }); }
function object(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function exact(v, required, optional = []) { return object(v) && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k)); }
function hash(v) { return typeof v === 'string' && HASH.test(v); }
function id(v) { return typeof v === 'string' && ID.test(v); }
function ms(v) { return Number.isSafeInteger(v) && v > 0; }
function text(v) { return typeof v === 'string' && v.trim().length > 0 && v.length <= 1000 && !/[\x00-\x1f]/.test(v); }
function instant(v) { return typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v; }
// No raw sessions/credentials or absolute filesystem references enter public data.
function publicData(v, depth = 0) {
  if (depth > 16) return false;
  if (typeof v === 'string') return v.length <= 4000 && !/[\x00-\x1f]|(?:^|[\s"'(=])[a-zA-Z]:[\\/]|\\\\|(?:^|[\s"'(=])\/|(?:bearer\s+|(?:password|secret|token|api[_-]?key)\s*[:=])/i.test(v);
  if (Array.isArray(v)) return v.length <= 256 && v.every(x => publicData(x, depth + 1));
  if (object(v)) return Object.keys(v).length <= 64 && Object.entries(v).every(([k, x]) => !['__proto__', 'constructor', 'prototype', 'session', 'session_id', 'raw_session'].includes(k) && publicData(k, depth + 1) && publicData(x, depth + 1));
  return v === null || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v);
}
function same(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a).sort(); return sameKeys(keys, Object.keys(b).sort()) && keys.every(k => same(a[k], b[k]));
}
function sameKeys(a, b) { return a.length === b.length && a.every((k, i) => k === b[i]); }
function noLinks(file, missing = false) {
  let cursor = path.resolve(file);
  for (;;) {
    try { if (fs.lstatSync(cursor).isSymbolicLink()) fail('time-path-link'); }
    catch (e) { if (!(missing && e.code === 'ENOENT')) throw e; }
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}
function timePaths(options) {
  const ids = require('./forge-ids'), milestone = options.milestone;
  if (!ids.isValid(milestone) || typeof milestone !== 'string' || /[\\/\0]/.test(milestone) || !['milestone', 'task'].includes(ids.entityKind(milestone))) fail('time-work-id-invalid');
  if (ids.entityKind(milestone) !== 'milestone') fail('time-work-kind-unsupported');
  const owner = path.resolve(options.cwd || '.'), forge = path.join(owner, '.gsd/forge'), directory = path.join(forge, 'time', milestone);
  return { owner, forge, directory, staging: path.join(forge, 'time-staging', milestone), contract: path.join(directory, 'contract.json'), amendments: path.join(directory, 'amendments'),
    enrollment: path.join(directory, 'enrollment.json'), options: path.join(directory, 'options'), selection: path.join(directory, 'selection.json'), journal: path.join(directory, 'journal.jsonl'), warnings: path.join(directory, 'warnings'), checkpoints: path.join(directory, 'checkpoints'), observations: path.join(directory, 'observations'), coverage: path.join(directory, 'coverage'), roadmap: path.join(owner, '.gsd/milestones', milestone, milestone + '-ROADMAP.md') };
}
function bounded(file, max, json = true) {
  noLinks(file); const real = fs.realpathSync.native(file);
  const read = require('./forge-autonomy-sources').readBoundedStableFile(file, max, { expectedReal: real });
  if (read.error) fail(read.error === 'source_too_large' ? 'time-source-too-large' : 'time-source-unstable');
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(read.buffer); }
  catch { fail('time-source-encoding-invalid'); }
  if (!json) return { content, buffer: read.buffer };
  try { return JSON.parse(content); } catch { fail(file.endsWith('contract.json') ? 'time-contract-json-invalid' : 'time-source-json-invalid'); }
}
function directoryNames(dir) {
  noLinks(dir, true);
  try { if (!fs.lstatSync(dir).isDirectory()) fail('time-path-invalid'); return fs.readdirSync(dir).sort(); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function decisionValid(v) {
  return exact(v, ['reference', 'question', 'answer', 'source', 'resolved_at', 'request_sha256']) && id(v.reference)
    && exact(v.question, ['identity_sha256', 'id']) && hash(v.question.identity_sha256) && id(v.question.id)
    && text(v.answer) && ['user-text', 'tool-answer'].includes(v.source) && instant(v.resolved_at) && hash(v.request_sha256);
}
function idList(v, min = 0) { return Array.isArray(v) && v.length >= min && v.length <= MAX_RECORDS && v.every(id) && new Set(v).size === v.length; }
function textList(v) { return Array.isArray(v) && v.length > 0 && v.length <= 64 && v.every(text); }
// structure_sha256 and item nodes are optional, so S01 allocations keep their bytes and hashes.
function allocationValid(v) {
  return v === null || exact(v, ['roadmap_sha256', 'items'], ['structure_sha256']) && hash(v.roadmap_sha256) && (v.structure_sha256 === undefined || hash(v.structure_sha256))
    && Array.isArray(v.items) && v.items.length > 0 && v.items.length <= MAX_RECORDS && new Set(v.items.map(r => r?.id)).size === v.items.length
    && v.items.every(r => exact(r, ['id', 'kind', 'ms'], ['slice', 'nodes']) && id(r.id) && ALLOCATION_KINDS.includes(r.kind) && ms(r.ms)
      && (r.slice === undefined || typeof r.slice === 'string' && /^S\d{2,}$/.test(r.slice)) && (r.nodes === undefined || idList(r.nodes)));
}
function horizonValid(h) { return exact(h, ['low_ms', 'high_ms', 'ceiling_ms']) && ms(h.low_ms) && ms(h.high_ms) && ms(h.ceiling_ms) && h.low_ms <= h.high_ms && h.high_ms <= h.ceiling_ms; }
function linkedTaskValid(v, option) {
  return v === null || exact(v, ['position_id', 'authorization', 'moved_scope', 'criteria', 'horizon', 'options_sha256']) && id(v.position_id)
    && LINKED_TASK_AUTHORIZATIONS.includes(v.authorization) && idList(v.moved_scope, 1) && exact(v.criteria, ['milestone', 'task'])
    && textList(v.criteria.milestone) && textList(v.criteria.task) && horizonValid(v.horizon) && v.options_sha256 === option.options_sha256;
}
function chainForecastValid(v, linked) {
  return v === null || linked !== null && exact(v, ['low_ms', 'high_ms', 'basis']) && ms(v.low_ms) && ms(v.high_ms) && v.low_ms <= v.high_ms && v.basis === 'milestone-plus-linked-task';
}
function validateContract(c) {
  let valid = exact(c, CONTRACT_KEYS) && c.schema_version === SCHEMA_VERSION && publicData(c);
  if (valid) {
    const ids = require('./forge-ids');
    valid = ids.isValid(c.milestone) && ids.entityKind(c.milestone) === 'milestone'
      && exact(c.clock_policy, ['id', 'version']) && c.clock_policy.id === 'forge-milestone-time-clock' && c.clock_policy.version === 1
      && exact(c.option, ['id', 'options_sha256', 'label'], ['position_id']) && (c.option.position_id === undefined || id(c.option.position_id)) && id(c.option.id) && hash(c.option.options_sha256) && text(c.option.label)
      && instant(c.activated_at) && instant(c.preselection_started_at) && Date.parse(c.preselection_started_at) <= Date.parse(c.activated_at) && ms(c.ceiling_ms)
      && exact(c.endpoint, ['kind', 'items']) && c.endpoint.kind === 'verified-integrated-delivery' && exact(c.endpoint.items, ENDPOINT_ITEMS)
      && ENDPOINT_ITEMS.every(k => ITEM_STATES.includes(c.endpoint.items[k])) && allocationValid(c.allocation)
      && linkedTaskValid(c.linked_task, c.option) && chainForecastValid(c.chain_forecast, c.linked_task) && decisionValid(c.decision);
  }
  return { valid: !!valid, ...(valid ? {} : { reason: 'time-contract-schema-invalid' }) };
}
// The conformance digest is recomputed from the row itself; a copied value proves nothing.
function conformanceDigest(delegation, allocation) {
  return require('./forge-code-roots').digest({ policy: 'forge-roadmap-time-conformance-v1', contract_sha256: delegation.contract_sha256,
    options_sha256: delegation.options_sha256, selection_sha256: delegation.selection_sha256, structure_sha256: allocation?.structure_sha256, items: allocation?.items });
}
// A delegated allocation carries no new decision: it references the activation
// decision of the immutable BASE contract that delegated technical allocation.
function delegationValid(row, base) {
  const d = row.delegation, allocation = row.patch?.allocation;
  return !!base && row.kind === 'allocation' && exact(d, DELEGATION_KEYS) && d.basis === 'activation-delegation' && d.contract_sha256 === base.sha256
    && exact(d.decision, ['reference', 'question']) && d.decision.reference === base.contract.decision.reference && same(d.decision.question, base.contract.decision.question)
    && d.options_sha256 === base.contract.option.options_sha256 && hash(d.selection_sha256) && hash(d.conformance_sha256)
    && (d.previous_allocation === null || exact(d.previous_allocation, ['version', 'sha256']) && Number.isSafeInteger(d.previous_allocation.version) && hash(d.previous_allocation.sha256))
    && object(allocation) && hash(allocation.structure_sha256) && d.conformance_sha256 === conformanceDigest(d, allocation);
}
function applyAmendment(contract, row, base) {
  const delegated = object(row) && Object.hasOwn(row, 'delegation');
  if (!exact(row, ['schema_version', 'milestone', 'version', 'previous_sha256', 'kind', 'reason', 'patch', delegated ? 'delegation' : 'decision']) || row.schema_version !== 1
      || row.milestone !== contract.milestone || !Number.isSafeInteger(row.version) || row.version < 2 || !hash(row.previous_sha256)
      || !AMENDMENT_KINDS.includes(row.kind) || !text(row.reason) || !publicData(row) || !(delegated ? delegationValid(row, base) : decisionValid(row.decision))) fail('time-amendment-invalid');
  const next = structuredClone(contract), patch = row.patch;
  if (row.kind === 'extension') {
    if (!exact(patch, ['ceiling_ms']) || !ms(patch.ceiling_ms) || patch.ceiling_ms <= contract.ceiling_ms) fail('time-amendment-invalid');
    next.ceiling_ms = patch.ceiling_ms;
  } else if (row.kind === 'allocation') {
    if (!exact(patch, ['allocation']) || patch.allocation === null || !allocationValid(patch.allocation)) fail('time-amendment-invalid');
    next.allocation = structuredClone(patch.allocation);
  } else if (row.kind === 'scope-reduction') {
    if (!exact(patch, ['deferred_items']) || !Array.isArray(patch.deferred_items) || !patch.deferred_items.length || patch.deferred_items.length > MAX_RECORDS || new Set(patch.deferred_items).size !== patch.deferred_items.length || patch.deferred_items.some(k => !id(k))) fail('time-amendment-invalid');
    // Scope identifiers remain visible in the immutable chain. Endpoint items
    // additionally project their own state into the materialized contract.
    for (const k of patch.deferred_items) if (ENDPOINT_ITEMS.includes(k)) next.endpoint.items[k] = 'deferred';
  } else if (!exact(patch, [])) fail('time-amendment-invalid');
  if (!validateContract(next).valid) fail('time-amendment-invalid');
  return next;
}
function readContract(options) {
  try {
    const p = timePaths(options); noLinks(p.directory, true);
    const names = directoryNames(p.directory);
    // Only pre-activation records: still no contract. Anything else without the base is invalid.
    if (names.every(name => PRE_ACTIVATION_ENTRIES.includes(name))) return { status: 'absent' };
    if (!names.includes('contract.json')) fail('time-contract-base-missing');
    let contract = bounded(p.contract, MAX_CONTRACT);
    if (contract?.milestone !== options.milestone) fail('time-contract-milestone-mismatch');
    if (!validateContract(contract).valid) fail('time-contract-schema-invalid');
    const { digest } = require('./forge-code-roots');
    let sha256 = digest(contract), version = 1, lastAllocation = null;
    const base = { contract, sha256 };
    const chain = [{ version, sha256, decision: contract.decision }], files = directoryNames(p.amendments);
    if (files.length > MAX_RECORDS) fail('time-amendment-limit');
    const seen = new Set([contract.decision.question.identity_sha256 + ':' + contract.decision.question.id]);
    for (const file of files) {
      if (file !== String(version + 1).padStart(4, '0') + '.json') fail('time-amendment-sequence-invalid');
      const row = bounded(path.join(p.amendments, file), MAX_AMENDMENT);
      if (row.version !== version + 1) fail('time-amendment-sequence-invalid');
      if (row.previous_sha256 !== sha256) fail('time-amendment-chain-invalid');
      // Question uniqueness applies to rows that carry their own decision only.
      if (object(row) && Object.hasOwn(row, 'decision')) {
        const identity = row.decision?.question?.identity_sha256 + ':' + row.decision?.question?.id;
        if (seen.has(identity)) fail('time-decision-conflict'); seen.add(identity);
      }
      contract = applyAmendment(contract, row, base); version = row.version; sha256 = digest(contract);
      if (row.delegation && !same(row.delegation.previous_allocation, lastAllocation)) fail('time-delegation-chain-invalid');
      if (row.kind === 'allocation') lastAllocation = { version, sha256 };
      chain.push({ ...row, sha256 });
    }
    return { status: 'valid', contract, version, sha256, chain };
  } catch (e) { return { status: 'invalid', reason: e.code?.startsWith('time-') ? e.code : 'time-source-unreadable' }; }
}
function liveAnswer(resolver, reference, scope, now) {
  let a; try { a = resolver(reference); } catch { fail('time-decision-attestation-required'); }
  if (!Number.isSafeInteger(now) || !a || a.reference !== reference || a.status !== 'resolved' || !text(a.answer) || !instant(a.resolved_at) || Date.parse(a.resolved_at) > now
      || !['user-text', 'tool-answer'].includes(a.source) || !exact(a.question, ['identity_sha256', 'id']) || !hash(a.question.identity_sha256) || !id(a.question.id)
      || !id(reference) || !object(scope) || !DECISION_KINDS.includes(scope.kind) || !hash(scope.request_sha256)
      || !Number.isFinite(scope.expires_at) || scope.expires_at <= now || scope.expires_at > now + 3600000) fail('time-decision-attestation-required');
  const ids = require('./forge-ids'); if (!ids.isValid(scope.milestone) || ids.entityKind(scope.milestone) !== 'milestone') fail('time-decision-attestation-required');
  return { reference, question: structuredClone(a.question), answer: a.answer, source: a.source, resolved_at: a.resolved_at, request_sha256: scope.request_sha256 };
}
function createDecisionAuthority(resolveLiveAnswer) {
  if (typeof resolveLiveAnswer !== 'function') fail('time-decision-attestation-required');
  return Object.freeze({ issue(reference, scope, clock = Date.now) {
    const frozenScope = structuredClone(scope), decision = liveAnswer(resolveLiveAnswer, reference, frozenScope, clock());
    const handle = Object.freeze({}); authorities.set(handle, { resolver: resolveLiveAnswer, reference, scope: frozenScope, decision }); return handle;
  } });
}
function attest(options, kind, request) {
  const entry = object(options.handle) && authorities.get(options.handle), now = options.now ?? Date.now();
  if (!entry || entry.scope.expires_at <= now) fail('time-decision-attestation-required');
  const { digest } = require('./forge-code-roots');
  if (request === undefined || entry.scope.milestone !== options.milestone || entry.scope.kind !== kind || entry.scope.request_sha256 !== digest(request)) fail('time-decision-scope-mismatch');
  const decision = liveAnswer(entry.resolver, entry.reference, entry.scope, now);
  if (!same(decision, entry.decision)) fail('time-decision-answer-mismatch');
  return decision;
}
function persistedDecision(options, kind, decision, expected) {
  const questions = require('./forge-pending-questions'); let continuation, listed;
  try {
    continuation = questions.continuation({ cwd: options.cwd, identity: decision.question.identity_sha256 });
    listed = questions.listPendingQuestions({ cwd: options.cwd, filter: { type: 'milestone', id: options.milestone } });
  } catch { fail('time-decision-scope-mismatch'); }
  const identity = continuation.identity;
  const row = continuation.questions?.find(q => q.id === decision.question.id);
  const publicRow = listed.questions.find(q => q.id === decision.question.id && same(q.origin, identity));
  if (!continuation.ok || identity?.origin !== 'owner' || identity.milestone !== options.milestone || identity.decision_set !== 'milestone-time-' + kind
      || !row || row.status !== 'resolved' || !publicRow || publicRow.last_round?.outcome !== 'answered') fail('time-decision-scope-mismatch');
  if (row.answer !== decision.answer || !expected.includes(decision.answer)) fail('time-decision-answer-mismatch');
}
// Read-only check of one attested decision: the live opaque handle (scope,
// request digest, expiry) and the persisted owner question answered in expected.
// The same path guards activateContract and amendContract.
function verifyDecision(options) {
  timePaths(options);
  const { kind, expected } = options;
  if (!DECISION_KINDS.includes(kind) || !Array.isArray(expected) || !expected.length || expected.length > MAX_RECORDS || !expected.every(text)) fail('time-decision-scope-mismatch');
  const decision = attest(options, kind, options.request);
  persistedDecision(options, kind, decision, expected);
  return decision;
}
function withWriter(options, callback) {
  const p = timePaths(options);
  noLinks(p.forge, true);
  try { if (!fs.lstatSync(p.forge).isDirectory()) fail('time-owner-missing'); }
  catch (e) { if (e.code?.startsWith('time-')) throw e; fail('time-owner-missing'); }
  return require('./forge-artifact-reconciliation').withOwnerLock(p.owner, () => {
    noLinks(p.forge); noLinks(p.directory, true);
    if (!fs.lstatSync(p.forge).isDirectory()) fail('time-owner-missing');
    return callback(p);
  });
}
function ensureDirectory(dir) {
  noLinks(dir, true);
  // Only descendants of the previously validated .gsd/forge are created.
  if (!fs.existsSync(dir)) { ensureDirectory(path.dirname(dir)); fs.mkdirSync(dir); }
  if (!fs.lstatSync(dir).isDirectory()) fail('time-path-invalid');
}
// Immutable records use atomic hard-link publication (the same installation
// primitive as forge-empirical-sources), since rename may overwrite history.
// Staging lives outside every directory whose readers enumerate committed names,
// so a process that dies mid-publication cannot invalidate intact history. Callers
// hold the owner lock, so any leftover staging file is an interrupted publication
// and is reconciled (removed) before the next one starts.
const STAGING_NAME = /^[a-zA-Z0-9_-]+\.json\.\d+\.[0-9a-f-]{36}\.tmp$/;
function reconcileStaging(staging) {
  noLinks(staging, true);
  let names; try { names = fs.readdirSync(staging); } catch (e) { if (['ENOENT', 'ENOTDIR'].includes(e.code)) return; throw e; }
  for (const name of names.filter(n => STAGING_NAME.test(n))) {
    const file = path.join(staging, name);
    if (fs.lstatSync(file).isFile()) fs.unlinkSync(file);
  }
}
function publishExclusive(file, value, limit, staging) {
  const buffer = Buffer.from(JSON.stringify(value) + '\n'); if (buffer.length > limit) fail('time-source-too-large');
  noLinks(file, true);
  const missingDirs = []; let dir = path.dirname(file);
  while (!fs.existsSync(dir)) { missingDirs.push(dir); dir = path.dirname(dir); }
  for (dir = staging; !fs.existsSync(dir); dir = path.dirname(dir)) missingDirs.push(dir);
  const temporary = path.join(staging, path.basename(file) + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp'); let created = false;
  try {
    reconcileStaging(staging);
    ensureDirectory(path.dirname(file)); ensureDirectory(staging); noLinks(temporary, true);
    const fd = fs.openSync(temporary, 'wx', 0o600); created = true;
    try { fs.writeFileSync(fd, buffer); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    noLinks(file, true); fs.linkSync(temporary, file);
  } finally {
    if (created) fs.unlinkSync(temporary);
    for (const d of missingDirs) { try { fs.rmdirSync(d); } catch (e) { if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(e.code)) throw e; } }
  }
}
function validStored(options) { const read = readContract(options); if (read.status !== 'valid') fail(read.reason || 'time-contract-required'); return read; }
function activateContract(options) {
  const request = structuredClone(options.contract), decision = attest(options, 'activation', request);
  const contract = { ...request, endpoint: { ...request?.endpoint, kind: request?.endpoint?.kind ?? 'verified-integrated-delivery' }, decision };
  if (!validateContract(contract).valid || contract.milestone !== options.milestone) fail('time-contract-schema-invalid');
  return withWriter(options, p => {
    attest(options, 'activation', request);
    persistedDecision(options, 'activation', decision, ['option:' + contract.option.id, 'operator-ceiling:' + contract.ceiling_ms]);
    const current = readContract(options);
    if (current.status === 'valid') {
      if (!same(bounded(p.contract, MAX_CONTRACT), contract)) fail('time-contract-conflict'); return current;
    }
    if (current.status === 'invalid') fail(current.reason);
    selectedRequest(options, request);
    noLinks(p.roadmap, true); if (fs.existsSync(p.roadmap)) fail('time-contract-roadmap-exists');
    publishExclusive(p.contract, contract, MAX_CONTRACT, p.staging); return validStored(options);
  });
}
// Enrolled milestones activate only the contract request of their recorded
// option selection; a no-contract selection never activates. S01 is unchanged.
function selectedRequest(options, request) {
  const enrollment = readEnrollment(options), selection = readSelection(options);
  for (const read of [enrollment, selection]) if (read.status === 'invalid') fail(read.reason);
  if (selection.status === 'valid') {
    if (selection.selection.choice !== 'option') fail('time-selection-no-contract');
    if (!same(selection.selection.contract_request, request)) fail('time-selection-mismatch');
  } else if (enrollment.status === 'valid') fail('time-selection-required');
}
function amendmentAnswer(kind, patch) {
  if (kind === 'extension') return 'extend:' + patch?.ceiling_ms;
  if (kind === 'allocation') return 'allocation:' + patch?.allocation?.roadmap_sha256;
  if (kind === 'scope-reduction') return 'reduce-scope:' + (patch?.deferred_items || []).join(',');
  return 'continue-to-cap';
}
function amendContract(options) {
  const { kind, reason, patch } = options, request = { kind, reason, patch }, decision = attest(options, kind, request);
  return withWriter(options, p => {
    attest(options, kind, request); persistedDecision(options, kind, decision, [amendmentAnswer(kind, patch)]);
    const current = validStored(options);
    const previous = current.chain.find(r => r.decision && same(r.decision.question, decision.question));
    if (previous) { if (!same(previous.decision, decision) || previous.kind !== kind || previous.reason !== reason || !same(previous.patch, patch)) fail('time-decision-conflict'); return current; }
    if (current.version > MAX_RECORDS) fail('time-amendment-limit');
    const row = { schema_version: 1, milestone: options.milestone, version: current.version + 1, previous_sha256: current.sha256, kind, reason, patch, decision };
    applyAmendment(current.contract, row);
    if (kind === 'allocation') {
      const roadmap = bounded(p.roadmap, MAX_CONTRACT, false).buffer;
      if (require('./forge-code-roots').digest(roadmap) !== patch.allocation.roadmap_sha256) fail('time-allocation-roadmap-mismatch');
      if (patch.allocation.structure_sha256 !== undefined && roadmapIdentity(roadmap).structure_sha256 !== patch.allocation.structure_sha256) fail('time-allocation-roadmap-mismatch');
    }
    publishExclusive(path.join(p.amendments, String(row.version).padStart(4, '0') + '.json'), row, MAX_AMENDMENT, p.staging); return validStored(options);
  });
}
function journalValid(r) {
  if (!object(r) || !JOURNAL_TYPES.includes(r.type) || !instant(r.at) || !publicData(r)) return false;
  if (r.type === 'presence') return exact(r, ['type', 'session_sha256', 'boundary', 'at']) && (r.session_sha256 === null || hash(r.session_sha256)) && ['session-start', 'next', 'complete', 'status', 'session-end'].includes(r.boundary);
  return exact(r, ['type', 'wait_id', 'class', 'source', 'at']) && id(r.wait_id) && WAIT_CLASSES.includes(r.class) && exact(r.source, ['kind', 'ref']) && id(r.source.kind) && text(r.source.ref);
}
function journalRecords(content) {
  const lines = content ? content.split('\n') : []; if (lines.at(-1) === '') lines.pop();
  if (lines.length > MAX_LINES) fail('time-journal-record-limit');
  const records = [], waits = new Map();
  for (const line of lines) {
    if (Buffer.byteLength(line) > MAX_LINE) fail('time-journal-line-limit');
    let r; try { r = JSON.parse(line); } catch { fail('time-journal-json-invalid'); }
    if (!journalValid(r)) fail('time-journal-record-invalid');
    if (r.type !== 'presence') {
      const previous = waits.get(r.wait_id);
      if (previous && (!same(previous.source, r.source) || previous.class !== r.class || previous.ended || r.type === 'wait-start') || r.type === 'wait-end' && (!previous || Date.parse(r.at) < Date.parse(previous.at))) fail('time-journal-wait-conflict');
      waits.set(r.wait_id, { ...r, ended: r.type === 'wait-end' });
    }
    records.push(r);
  }
  return records;
}
function readJournal(options) {
  try {
    const p = timePaths(options); noLinks(p.journal, true);
    const contract = readContract(options); if (contract.status === 'invalid') fail(contract.reason);
    if (contract.status === 'absent') return { status: 'no-contract', records: [] };
    let read; try { read = bounded(p.journal, MAX_JOURNAL, false); } catch (e) { if (e.code === 'ENOENT') return { status: 'valid', records: [] }; throw e; }
    return { status: 'valid', records: journalRecords(read.content) };
  } catch (e) { return { status: 'invalid', reason: e.code?.startsWith('time-') ? e.code : 'time-source-unreadable' }; }
}
function appendJournal(options) {
  const current = readContract(options); if (current.status === 'absent') return { status: 'no-contract' };
  if (current.status === 'invalid') fail(current.reason);
  return withWriter(options, p => {
    validStored(options); noLinks(p.journal, true);
    let content = ''; try { content = bounded(p.journal, MAX_JOURNAL, false).content; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!journalValid(options.record)) fail('time-journal-record-invalid');
    const line = JSON.stringify(options.record) + '\n';
    if (Buffer.byteLength(line) - 1 > MAX_LINE) fail('time-journal-line-limit');
    if (Buffer.byteLength(content + line) > MAX_JOURNAL) fail('time-source-too-large');
    // Revalidate the complete old prefix and proposed record while holding lock.
    if (content && !content.endsWith('\n')) fail('time-journal-json-invalid');
    const records = journalRecords(content + line);
    fs.appendFileSync(p.journal, line, { mode: 0o600 }); return { status: 'valid', count: records.length };
  });
}
function recordIdentity(record, type) { return type !== 'checkpoints' ? id(record?.id) ? record.id : null : ms(record?.version) ? String(record.version) : null; }
function readRecords(options, type) {
  try {
    const p = timePaths(options), contract = readContract(options); if (contract.status === 'invalid') fail(contract.reason);
    if (contract.status === 'absent') return { status: 'no-contract', records: [] };
    const names = directoryNames(p[type]); if (names.length > MAX_RECORDS) fail('time-record-limit');
    const records = names.map(name => {
      if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) fail('time-record-invalid');
      const r = bounded(path.join(p[type], name), MAX_AMENDMENT);
      if (recordIdentity(r, type) + '.json' !== name || !publicData(r)) fail('time-record-invalid'); return r;
    });
    if (type === 'checkpoints') records.sort((a, b) => a.version - b.version);
    return { status: 'valid', records };
  } catch (e) { return { status: 'invalid', reason: e.code?.startsWith('time-') ? e.code : 'time-source-unreadable' }; }
}
function record(options, type) {
  const value = options.record, identity = recordIdentity(value, type);
  if (!identity || !publicData(value)) fail('time-record-invalid');
  return withWriter(options, p => {
    const current = validStored(options);
    const listing = readRecords(options, type); if (listing.status !== 'valid') fail(listing.reason);
    const previous = listing.records.find(r => recordIdentity(r, type) === identity);
    if (previous) { if (!same(previous, value)) fail('time-record-conflict'); return { status: 'valid', record: previous }; }
    if (type === 'checkpoints' && value.version !== current.version) fail('time-record-invalid');
    if (listing.records.length >= MAX_RECORDS) fail('time-record-limit');
    publishExclusive(path.join(p[type], identity + '.json'), value, MAX_AMENDMENT, p.staging); return { status: 'valid', record: value };
  });
}
function recordWarning(options) { return record(options, 'warnings'); }
function listWarnings(options) { return readRecords(options, 'warnings'); }
function recordCheckpoint(options) { return record(options, 'checkpoints'); }
function readCheckpoints(options) { return readRecords(options, 'checkpoints'); }
function readObservations(options) { return readRecords(options, 'observations'); }
function readCoverage(options) { return readRecords(options, 'coverage'); }
// Worker evidence is published by the owner in one lock window: immutable
// observations first and the per-unit coverage marker last. Replay of identical
// bytes is idempotent; a different record with the same identity refuses.
function recordWorkerEvidence(options) {
  const rows = [...(options.observations || []).map(r => ['observations', r]), ['coverage', options.coverage]];
  if (rows.length > MAX_RECORDS || rows.some(([type, r]) => !recordIdentity(r, type) || !publicData(r))) fail('time-record-invalid');
  return withWriter(options, p => {
    validStored(options);
    const listings = { observations: readRecords(options, 'observations'), coverage: readRecords(options, 'coverage') };
    for (const listing of Object.values(listings)) if (listing.status !== 'valid') fail(listing.reason);
    const pending = [];
    for (const [type, value] of rows) {
      const identity = recordIdentity(value, type), previous = listings[type].records.find(r => r.id === identity);
      if (previous) { if (!same(previous, value)) fail('time-record-conflict'); continue; }
      if (!pending.some(([t, v]) => t === type && v.id === identity)) pending.push([type, value]);
    }
    for (const type of Object.keys(listings)) {
      if (listings[type].records.length + pending.filter(([t]) => t === type).length > MAX_RECORDS) fail('time-record-limit');
    }
    for (const [type, value] of pending) publishExclusive(path.join(p[type], value.id + '.json'), value, MAX_AMENDMENT, p.staging);
    return { status: 'valid', published: pending.length, unchanged: rows.length - pending.length };
  });
}
// Pre-activation records (S02): enrollment.json, options/<options_sha256>.json and
// selection.json beside the contract. Immutable, owner-only, published by
// publishExclusive under withOwnerLock; readers are bounded and refuse links.
function enrollmentValid(v, milestone) {
  return exact(v, ['schema_version', 'milestone', 'enrolled_at', 'source']) && v.schema_version === 1 && v.milestone === milestone
    && instant(v.enrolled_at) && ENROLLMENT_SOURCES.includes(v.source);
}
function optionsValid(v, milestone) { return object(v) && v.schema_version === 1 && v.milestone === milestone && publicData(v); }
function noContractRequest(milestone, sha) { return { milestone, options_sha256: sha, choice: 'no-contract' }; }
function linkedTaskRequest(s) { return { milestone: s.milestone, options_sha256: s.options_sha256, option_id: s.option_id, position_id: s.position_id, authorization: s.linked_task_authorization }; }
// Persisted decisions are history bound to the persisted requests; they never grant new authority.
function selectionValid(v, milestone) {
  if (!exact(v, SELECTION_KEYS) || v.schema_version !== 1 || v.milestone !== milestone || !hash(v.options_sha256) || !instant(v.selected_at) || !publicData(v)) return false;
  const option = v.choice === 'option' && id(v.option_id) && id(v.position_id) && object(v.contract_request)
    && (v.linked_task_authorization === null || LINKED_TASK_AUTHORIZATIONS.includes(v.linked_task_authorization));
  const none = v.choice === 'no-contract' && v.option_id === null && v.position_id === null && v.linked_task_authorization === null && v.contract_request === null;
  if (!(option || none) || !Array.isArray(v.rounds) || v.rounds.length > MAX_ROUNDS || !Array.isArray(v.decisions)
      || !v.decisions.every(r => exact(r, ['kind', 'decision']) && decisionValid(r.decision))) return false;
  const [activation, linked, ...rest] = v.decisions, { digest } = require('./forge-code-roots');
  if (activation?.kind !== 'activation' || rest.length || (linked === undefined) !== (v.linked_task_authorization === null)) return false;
  const answers = none ? ['no-contract'] : ['option:' + v.option_id, 'operator-ceiling:' + v.contract_request.ceiling_ms];
  return answers.includes(activation.decision.answer) && activation.decision.request_sha256 === digest(none ? noContractRequest(milestone, v.options_sha256) : v.contract_request)
    && (linked === undefined || linked.kind === 'linked-task' && linked.decision.answer === 'linked-task:' + v.linked_task_authorization
      && linked.decision.request_sha256 === digest(linkedTaskRequest(v)));
}
function readRecordFile(options, key, max, valid, reason) {
  try {
    const p = timePaths(options); noLinks(p[key], true);
    let read; try { read = bounded(p[key], max, false); } catch (e) { if (e.code === 'ENOENT') return { status: 'absent' }; throw e; }
    let value; try { value = JSON.parse(read.content); } catch { fail('time-source-json-invalid'); }
    if (!valid(value, options.milestone) || read.content !== JSON.stringify(value) + '\n') fail(reason);
    return { status: 'valid', value };
  } catch (e) { return { status: 'invalid', reason: e.code?.startsWith('time-') ? e.code : 'time-source-unreadable' }; }
}
function readEnrollment(options) {
  const read = readRecordFile(options, 'enrollment', MAX_AMENDMENT, enrollmentValid, 'time-enrollment-invalid');
  return read.status === 'valid' ? { status: 'valid', enrollment: read.value } : read;
}
function readSelection(options) {
  const read = readRecordFile(options, 'selection', MAX_OPTIONS, selectionValid, 'time-selection-invalid');
  return read.status === 'valid' ? { status: 'valid', selection: read.value, selection_sha256: require('./forge-code-roots').digest(read.value) } : read;
}
// The options identity and file name are the forge-code-roots digest of the record.
function readOptionsFile(p, name, milestone) {
  if (!/^[a-f0-9]{64}\.json$/.test(name)) fail('time-record-invalid');
  const read = bounded(path.join(p.options, name), MAX_OPTIONS, false);
  let value; try { value = JSON.parse(read.content); } catch { fail('time-source-json-invalid'); }
  if (!optionsValid(value, milestone) || read.content !== JSON.stringify(value) + '\n' || require('./forge-code-roots').digest(value) + '.json' !== name) fail('time-record-invalid');
  return { options_sha256: name.slice(0, 64), record: value };
}
function listOptions(options) {
  try {
    const p = timePaths(options); noLinks(p.options, true);
    const names = directoryNames(p.options); if (names.length > MAX_RECORDS) fail('time-record-limit');
    return { status: 'valid', records: names.map(name => readOptionsFile(p, name, options.milestone)) };
  } catch (e) { return { status: 'invalid', reason: e.code?.startsWith('time-') ? e.code : 'time-source-unreadable' }; }
}
function readOptions(options) {
  try {
    const p = timePaths(options); if (!hash(options.options_sha256)) fail('time-options-invalid');
    const file = path.join(p.options, options.options_sha256 + '.json'); noLinks(file, true);
    if (!fs.existsSync(file)) return { status: 'absent' };
    return { status: 'valid', ...readOptionsFile(p, options.options_sha256 + '.json', options.milestone) };
  } catch (e) { return { status: 'invalid', reason: e.code?.startsWith('time-') ? e.code : 'time-source-unreadable' }; }
}
function refuseActivated(options, p) {
  const contract = readContract(options);
  if (contract.status === 'invalid') fail(contract.reason);
  if (contract.status === 'valid') fail('time-options-contract-exists');
  noLinks(p.roadmap, true); if (fs.existsSync(p.roadmap)) fail('time-options-roadmap-exists');
}
function recordEnrollment(options) {
  timePaths(options);
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now)) fail('time-enrollment-invalid');
  const record = { schema_version: 1, milestone: options.milestone, enrolled_at: new Date(now).toISOString(), source: options.source };
  if (!enrollmentValid(record, options.milestone)) fail('time-enrollment-invalid');
  return withWriter(options, p => {
    const current = readEnrollment(options);
    if (current.status === 'valid') return current;
    if (current.status === 'invalid') fail(current.reason);
    refuseActivated(options, p);
    publishExclusive(p.enrollment, record, MAX_AMENDMENT, p.staging); return readEnrollment(options);
  });
}
function recordOptions(options) {
  const value = options.record;
  timePaths(options);
  if (!optionsValid(value, options.milestone)) fail('time-options-invalid');
  if (Buffer.byteLength(JSON.stringify(value) + '\n') > MAX_OPTIONS) fail('time-source-too-large');
  const sha256 = require('./forge-code-roots').digest(value);
  return withWriter(options, p => {
    const enrollment = readEnrollment(options);
    if (enrollment.status !== 'valid') fail(enrollment.status === 'absent' ? 'time-enrollment-required' : enrollment.reason);
    const listing = listOptions(options); if (listing.status !== 'valid') fail(listing.reason);
    if (listing.records.some(r => r.options_sha256 === sha256)) return readOptions({ ...options, options_sha256: sha256 });
    refuseActivated(options, p);
    if (listing.records.length >= MAX_RECORDS) fail('time-record-limit');
    publishExclusive(path.join(p.options, sha256 + '.json'), value, MAX_OPTIONS, p.staging); return readOptions({ ...options, options_sha256: sha256 });
  });
}
const SELECTION_INPUT = ['option_id', 'position_id', 'linked_task_authorization', 'contract_request', 'rounds', 'decisions', 'schema_version', 'milestone', 'selected_at'];
// Derives every request and expected answer from the persisted options and the
// selection data, then verifies each live handle. Serialized decisions, rounds
// or contract_request never grant authority: decisions are always re-derived.
function selectionPlan(options, input) {
  const milestone = options.milestone;
  if (!exact(input, ['choice', 'options_sha256'], SELECTION_INPUT) || !['option', 'no-contract'].includes(input.choice) || !hash(input.options_sha256)
      || input.schema_version !== undefined && input.schema_version !== 1 || input.milestone !== undefined && input.milestone !== milestone) fail('time-selection-invalid');
  const enrollment = readEnrollment(options);
  if (enrollment.status !== 'valid') fail(enrollment.status === 'absent' ? 'time-enrollment-required' : enrollment.reason);
  const offered = readOptions({ cwd: options.cwd, milestone, options_sha256: input.options_sha256 });
  if (offered.status !== 'valid') fail(offered.status === 'absent' ? 'time-options-required' : offered.reason);
  const handles = object(options.handles) ? options.handles : {}, now = options.now ?? Date.now();
  const check = (kind, request, expected) => ({ kind, decision: verifyDecision({ cwd: options.cwd, milestone, now, handle: handles[kind], kind, request, expected }) });
  const record = { schema_version: 1, milestone, choice: input.choice, options_sha256: input.options_sha256, option_id: null, position_id: null,
    linked_task_authorization: null, contract_request: null, rounds: input.rounds ?? [], decisions: [], selected_at: null };
  if (input.choice === 'no-contract') {
    if (['option_id', 'position_id', 'linked_task_authorization', 'contract_request'].some(k => input[k] !== undefined && input[k] !== null)) fail('time-selection-invalid');
    record.decisions.push(check('activation', noContractRequest(milestone, input.options_sha256), ['no-contract']));
  } else {
    const rt = require('./forge-milestone-roadmap-time'), view = rt.optionsView(offered.record);
    if (view.status !== 'valid') fail('time-options-invalid');
    const option = view.options.find(o => o?.id === input.option_id);
    const position = Array.isArray(option?.positions) ? option.positions.find(x => x?.id === input.position_id) : undefined;
    if (!object(position) || !id(option.id) || !id(position.id) || !text(option.label)) fail('time-selection-option-unknown');
    const request = input.contract_request, linked = position.linked_task ?? null, authorization = input.linked_task_authorization ?? null;
    const expectedLinked = linked === null ? null : { position_id: position.id, authorization, moved_scope: linked.moved_scope, criteria: linked.criteria, horizon: linked.horizon, options_sha256: input.options_sha256 };
    if (!object(request) || request.milestone !== milestone || !same(request.option, { id: option.id, options_sha256: input.options_sha256, label: option.label, ...(linked === null ? { position_id: position.id } : {}) })
        || (linked === null) !== (authorization === null) || !same(request.linked_task, expectedLinked)) fail('time-selection-invalid');
    // The offered cap, strategy and endpoint come from the persisted option, never from the caller's request.
    if (position.status === 'infeasible') fail('time-selection-infeasible');
    // Work moved to the linked task cannot be dropped: none needs a full-scope alternative or a re-estimate.
    if (linked !== null && authorization === 'none' && linked.moved_scope?.length) fail('time-selection-scope-incompatible');
    // The complete graph is validated for every supported representation (option.nodes or position.nodes) before publication.
    const graph = rt.sourceGraph(option, position);
    if (graph.status !== 'valid') fail('time-selection-graph-invalid');
    // The same horizon partition and cross-horizon prerequisite projection that conformance applies, before anything is published.
    if (rt.selectedPartition(graph).status !== 'valid') fail('time-selection-graph-invalid');
    if (object(option.endpoint) && !same(request.endpoint, option.endpoint)) fail('time-selection-invalid');
    // The chain forecast is derived from the offered milestone and linked-task ranges, never from a cap or a caller number:
    // it is the sum only when both ranges are known and must otherwise stay null (unknown).
    const known = r => object(r) && ms(r.low_ms) && ms(r.high_ms);
    const chain = linked !== null && known(position.estimate) && known(linked.horizon)
      ? { low_ms: position.estimate.low_ms + linked.horizon.low_ms, high_ms: position.estimate.high_ms + linked.horizon.high_ms, basis: 'milestone-plus-linked-task' } : null;
    if (!same(request.chain_forecast, chain)) fail('time-selection-chain-forecast-invalid');
    // An unknown forecast stays unknown: without an offered cap only an explicit operator ceiling can set one.
    const offeredCeiling = ms(option.ceiling_ms) ? option.ceiling_ms : null, custom = request.ceiling_ms !== offeredCeiling;
    if (object(position.estimate) && ms(position.estimate.high_ms) && request.ceiling_ms < position.estimate.high_ms) fail('time-selection-ceiling-incompatible');
    Object.assign(record, { option_id: option.id, position_id: position.id, linked_task_authorization: authorization, contract_request: request });
    record.decisions.push(check('activation', request, custom ? ['operator-ceiling:' + request.ceiling_ms] : ['option:' + option.id, 'operator-ceiling:' + request.ceiling_ms]));
    if (linked !== null) record.decisions.push(check('linked-task', linkedTaskRequest(record), ['linked-task:' + authorization]));
    const contract = { ...request, endpoint: { ...request.endpoint, kind: request.endpoint?.kind ?? 'verified-integrated-delivery' }, decision: record.decisions[0].decision };
    if (!validateContract(contract).valid) fail('time-selection-invalid');
  }
  if (input.decisions !== undefined && !same(input.decisions, record.decisions)) fail('time-decision-answer-mismatch');
  if (!Number.isSafeInteger(now)) fail('time-selection-invalid');
  record.selected_at = new Date(now).toISOString();
  if (!selectionValid(record, milestone)) fail('time-selection-invalid');
  return record;
}
function recordSelection(options) {
  timePaths(options);
  let input; try { input = structuredClone(options.selection); } catch { fail('time-selection-invalid'); }
  selectionPlan(options, input);
  return withWriter(options, p => {
    // Authority is verified again inside the write boundary, immediately before publication.
    const record = selectionPlan(options, input), current = readSelection(options);
    if (current.status === 'valid') {
      const { selected_at: storedAt, ...stored } = current.selection, { selected_at: nextAt, ...next } = record;
      if (!same(stored, next)) fail('time-selection-conflict'); return current;
    }
    if (current.status === 'invalid') fail(current.reason);
    refuseActivated(options, p);
    publishExclusive(p.selection, record, MAX_OPTIONS, p.staging); return readSelection(options);
  });
}
// Structural identity: slices from forge-status.parseRoadmap (loaded late) plus
// the time section parsed by forge-milestone-roadmap-time. Checkboxes, risk tags
// and prose outside the JSON do not change it; an invalid section never canonicalizes.
function inspectRoadmap(input) {
  const buffer = Buffer.isBuffer(input) ? input : typeof input === 'string' ? Buffer.from(input) : fail('time-roadmap-invalid');
  let content; try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { fail('time-source-encoding-invalid'); }
  const { parseRoadmap } = require('./forge-status');
  return { buffer, inspected: require('./forge-milestone-roadmap-time').inspectRoadmapContent(content, parseRoadmap(content)) };
}
function identityOf(read) {
  if (read.inspected.status !== 'valid') fail(String(read.inspected.reason).replace(/^roadmap-time-/, 'time-roadmap-'));
  const { digest } = require('./forge-code-roots');
  return { sha256: digest(read.buffer), structure_sha256: digest(read.inspected.structure) };
}
function roadmapIdentity(input) { return identityOf(inspectRoadmap(input)); }
// Technical allocation delegated by the activation decision. Under the owner lock
// it reads the BASE contract, the persisted selection/options and the current
// ROADMAP bytes and runs the single pure validator; a caller hash proves nothing.
// Expansion, scope reduction, strategy change or a higher ceiling stay refused
// here and require their own attested decision (amendContract).
function nonconformant(reason) { throw Object.assign(new Error('time-allocation-nonconformant'), { code: 'time-allocation-nonconformant', reason }); }
function recordDelegatedAllocation(options) {
  timePaths(options);
  if (!text(options.reason)) fail('time-amendment-invalid');
  return withWriter(options, p => {
    const current = validStored(options), { digest } = require('./forge-code-roots');
    const base = bounded(p.contract, MAX_CONTRACT), baseSha = digest(base);
    const selection = readSelection(options), enrollment = readEnrollment(options);
    for (const read of [selection, enrollment]) if (read.status === 'invalid') fail(read.reason);
    if (selection.status !== 'valid' || selection.selection.choice !== 'option') fail('time-selection-required');
    const offered = readOptions({ cwd: options.cwd, milestone: options.milestone, options_sha256: selection.selection.options_sha256 });
    if (offered.status !== 'valid') fail(offered.status === 'absent' ? 'time-options-required' : offered.reason);
    noLinks(p.roadmap, true);
    let bytes; try { bytes = bounded(p.roadmap, MAX_CONTRACT, false).buffer; } catch (e) { if (e.code === 'ENOENT') fail('time-allocation-roadmap-missing'); throw e; }
    const rt = require('./forge-milestone-roadmap-time'), read = inspectRoadmap(bytes);
    // Only identifiers deferred by attested scope-reduction decisions leave the scope.
    const deferred = current.chain.filter(r => r.kind === 'scope-reduction' && r.decision).flatMap(r => r.patch.deferred_items);
    const expected = rt.expectedFrom({ enrollment: enrollment.enrollment ?? null, options: offered.record, options_sha256: offered.options_sha256,
      selection: selection.selection, contract: base, contract_sha256: baseSha, ceiling_ms: current.contract.ceiling_ms, deferred: [...new Set(deferred)] });
    const result = rt.validateRoadmap(read.inspected, expected);
    if (!result.valid || result.status !== 'conformant') nonconformant(result.reason || 'roadmap-time-expected-invalid');
    const identity = identityOf(read);
    const allocation = { roadmap_sha256: identity.sha256, structure_sha256: identity.structure_sha256,
      items: read.inspected.section.allocation.map(r => ({ id: r.id, kind: r.kind, ...(r.slice ? { slice: r.slice } : {}), ms: r.ms, nodes: [...r.nodes] })) };
    const previous = current.chain.filter(r => r.kind === 'allocation').at(-1);
    const delegation = { basis: 'activation-delegation', contract_sha256: baseSha, decision: { reference: base.decision.reference, question: structuredClone(base.decision.question) },
      options_sha256: base.option.options_sha256, selection_sha256: selection.selection_sha256, conformance_sha256: null,
      previous_allocation: previous ? { version: previous.version, sha256: previous.sha256 } : null };
    delegation.conformance_sha256 = conformanceDigest(delegation, allocation);
    if (options.conformance_sha256 !== undefined && options.conformance_sha256 !== delegation.conformance_sha256) fail('time-allocation-conformance-mismatch');
    const active = current.contract.allocation;
    if (active?.structure_sha256 === allocation.structure_sha256 && same(active.items, allocation.items)) return current;
    if (current.version > MAX_RECORDS) fail('time-amendment-limit');
    const row = { schema_version: 1, milestone: options.milestone, version: current.version + 1, previous_sha256: current.sha256, kind: 'allocation', reason: options.reason, patch: { allocation }, delegation };
    applyAmendment(current.contract, row, { contract: base, sha256: baseSha });
    publishExclusive(path.join(p.amendments, String(row.version).padStart(4, '0') + '.json'), row, MAX_AMENDMENT, p.staging); return validStored(options);
  });
}
// ---------------------------------------------------------------------------
// Generic owner records (S03): one closed allowlist below .gsd/forge/time/<M>/
// plus the reverse task index .gsd/forge/time-links/<T>.json. The writers reuse
// withWriter (owner lock, no links, never creates .gsd or .gsd/forge) and
// publishExclusive (exclusive hard link, staging outside the read folders), need
// an active contract and public data, are idempotent for the same value and
// refuse a different one. Readers are bounded, refuse links, require canonical
// bytes and never throw. Every record is written after the contract activation,
// so readContract keeps ignoring them exactly as before.
// ---------------------------------------------------------------------------
const OWNER_RECORD_PATHS = Object.freeze(['endpoint.json', 'linked-task/<name>.json', 'linked-task/checkpoints/<id>.json', 'linked-task/extensions/<id>.json', 'linked-task/journal.jsonl']);
const MAX_OWNER_RECORD = 64 * 1024;
const RECORD_FILE = /^[a-zA-Z0-9_-]{1,120}\.json$/;
function codeOf(e) { return e?.code?.startsWith('time-') ? e.code : 'time-source-unreadable'; }
// Maps a relative record path onto its file; anything outside the allowlist is refused.
function ownerRecordFile(p, relative, kind = 'record') {
  if (typeof relative !== 'string' || !relative || relative.length > 200 || /[\\\0:]|^\/|\/\/|(?:^|\/)\.\.?(?:\/|$)/.test(relative)) fail('time-record-path-invalid');
  const parts = relative.split('/');
  const allowed = kind === 'journal' ? relative === 'linked-task/journal.jsonl'
    : kind === 'list' ? ['linked-task/checkpoints', 'linked-task/extensions'].includes(relative)
      : relative === 'endpoint.json' || parts.length === 2 && parts[0] === 'linked-task' && /^[a-z][a-z0-9-]{0,63}\.json$/.test(parts[1])
        || parts.length === 3 && parts[0] === 'linked-task' && ['checkpoints', 'extensions'].includes(parts[1]) && RECORD_FILE.test(parts[2]);
  if (!allowed) fail('time-record-path-invalid');
  return path.join(p.directory, ...parts);
}
// The reverse index accepts only a task ID; every other owner record only a milestone ID.
function linkIndexFile(options) {
  const ids = require('./forge-ids'), task = options.task;
  if (typeof task !== 'string' || /[\\/\0]/.test(task) || !ids.isValid(task) || !['milestone', 'task'].includes(ids.entityKind(task))) fail('time-work-id-invalid');
  if (ids.entityKind(task) !== 'task') fail('time-work-kind-unsupported');
  return path.join(path.resolve(options.cwd || '.'), '.gsd/forge/time-links', task + '.json');
}
function recordValue(value) {
  if (!object(value) || !publicData(value)) fail('time-record-invalid');
  if (Buffer.byteLength(JSON.stringify(value) + '\n') > MAX_OWNER_RECORD) fail('time-source-too-large');
  return value;
}
// null when absent; a present record must be canonical public JSON.
function storedRecord(file) {
  noLinks(file, true);
  let read; try { read = bounded(file, MAX_OWNER_RECORD, false); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  let value; try { value = JSON.parse(read.content); } catch { fail('time-record-invalid'); }
  if (!object(value) || !publicData(value) || read.content !== JSON.stringify(value) + '\n') fail('time-record-invalid');
  return value;
}
function activeContract(options) {
  const read = readContract(options);
  if (read.status === 'absent') fail('time-contract-required');
  if (read.status !== 'valid') fail(read.reason);
  return read;
}
function publishRecordFile(p, file, value) {
  const { digest } = require('./forge-code-roots'), previous = storedRecord(file);
  if (previous) { if (!same(previous, value)) fail('time-record-conflict'); return { status: 'unchanged', sha256: digest(previous) }; }
  publishExclusive(file, value, MAX_OWNER_RECORD, p.staging);
  return { status: 'published', sha256: digest(storedRecord(file)) };
}
function publishOwnerRecord(options) {
  const p = timePaths(options), file = ownerRecordFile(p, options.path), value = recordValue(options.record);
  return withWriter(options, () => { activeContract(options); return { ...publishRecordFile(p, file, value), path: options.path }; });
}
function readOwnerRecord(options) {
  try {
    const file = ownerRecordFile(timePaths(options), options.path), value = storedRecord(file);
    return value === null ? { status: 'absent' } : { status: 'valid', record: value, sha256: require('./forge-code-roots').digest(value) };
  } catch (e) { return { status: 'invalid', reason: codeOf(e) }; }
}
// This private path is deliberately outside ownerRecordFile's generic allowlist.
function handoffBindingFile(p) { return path.join(p.directory, 'linked-task-bindings', 'handoff.json'); }
function readHandoffBinding(options) {
  try {
    const binding = storedRecord(handoffBindingFile(timePaths(options)));
    return binding === null ? { status: 'absent' } : { status: 'valid', binding };
  } catch (e) { return { status: 'invalid', reason: codeOf(e) }; }
}
// Closure publication evidence is outside the generic owner-record allowlist.
// Its only issuer re-derives the verified task delivery and start under this
// writer lock; caller records/proofs and legacy unbound closures cannot mint it.
function closureWitnessFile(p) { return path.join(p.directory, 'linked-task-bindings', 'closure.json'); }
function readLinkedTaskClosureWitness(options) {
  try { const record = storedRecord(closureWitnessFile(timePaths(options)));
    return record === null ? { status: 'absent' } : { status: 'valid', record, sha256: require('./forge-code-roots').digest(record) };
  } catch (e) { return { status: 'invalid', reason: codeOf(e) }; }
}
function publishLinkedTaskClosureWitness(options) {
  if (['record', 'build', 'anchor', 'binding', 'proof', 'witness'].some(k => Object.hasOwn(options, k))) fail('time-record-invalid');
  return withWriter(options, p => {
    activeContract(options);
    const lifecycle = require('./forge-linked-task-start'), { digest } = require('./forge-code-roots');
    const privateFile = closureWitnessFile(p), prior = storedRecord(privateFile), previous = storedRecord(ownerRecordFile(p, 'linked-task/closure.json'));
    if (previous && !prior) fail('time-record-invalid'); // No retroactive authority from a legacy record's shape.
    if (prior) {
      if (!lifecycle.closureWitnessValid(prior) || prior.milestone !== options.milestone || prior.task_id !== options.taskId
          || previous && !same(previous, prior.closure)) fail('time-record-conflict');
      const basis = lifecycle.deriveClosureBasis({ cwd: p.owner, milestone: options.milestone, taskId: options.taskId });
      if (prior.closure.start_sha256 !== basis.start_sha256 || prior.link_sha256 !== basis.link_sha256
          || options.expected_closure_sha256 !== undefined && options.expected_closure_sha256 !== prior.closure_sha256) fail('time-record-conflict');
      return { status: 'unchanged', sha256: digest(prior) };
    }
    const record = lifecycle.deriveClosureSnapshot({ cwd: p.owner, milestone: options.milestone, taskId: options.taskId, codeDir: options.codeDir, now: options.now });
    if (options.expected_closure_sha256 !== undefined && options.expected_closure_sha256 !== digest(record)) fail('time-record-conflict');
    const witness = recordValue({ schema_version: 1, kind: 'forge-linked-task-closure-witness', milestone: record.milestone,
      task_id: record.task_id, link_sha256: record.link_sha256, closure_sha256: digest(record), closure: record });
    if (!lifecycle.closureWitnessValid(witness)) fail('time-record-invalid');
    return publishRecordFile(p, privateFile, witness);
  });
}
function publishLinkedTaskHandoff(options) {
  if (['record', 'build', 'anchor', 'binding', 'proof'].some(k => Object.hasOwn(options, k))) fail('time-record-invalid');
  return withWriter(options, p => {
    activeContract(options);
    const lifecycle = require('./forge-linked-task-start'), { digest } = require('./forge-code-roots');
    // No caller record, proof or builder can mint this binding: derive again here.
    const derived = lifecycle.deriveHandoffSnapshot({ ...options, cwd: p.owner });
    const file = ownerRecordFile(p, 'linked-task/handoff.json'), previous = storedRecord(file);
    const bindingFile = handoffBindingFile(p), priorBinding = storedRecord(bindingFile);
    if (options.expected_snapshot_sha256 !== undefined && options.expected_snapshot_sha256 !== digest(lifecycle.handoffSourceProjection(derived))) fail('time-record-conflict');
    let record = derived;
    if (priorBinding) {
      if (!exact(priorBinding, ['schema_version', 'kind', 'milestone', 'task_id', 'handoff_sha256', 'handoff']) || priorBinding.schema_version !== 1
          || priorBinding.kind !== 'forge-linked-task-handoff-binding' || priorBinding.milestone !== options.milestone
          || priorBinding.task_id !== derived.task_id || !lifecycle.handoffBindingMatches(priorBinding, priorBinding.handoff)
          || !same(lifecycle.handoffSourceProjection(priorBinding.handoff), lifecycle.handoffSourceProjection(derived))) fail('time-record-conflict');
      record = priorBinding.handoff;
      if (previous && !same(previous, record)) fail('time-record-conflict');
    } else if (previous) fail('time-record-invalid'); // Never retroactively bless an unbound public record.
    else publishRecordFile(p, bindingFile, recordValue({ schema_version: 1, kind: 'forge-linked-task-handoff-binding', milestone: options.milestone,
      task_id: record.task_id, handoff_sha256: digest(record), handoff: record }));
    try { return { ...publishRecordFile(p, file, record), path: 'linked-task/handoff.json' }; }
    catch (error) { error.published = true; throw error; }
  });
}
// Anchored endpoint publication (S03/T02): the one place that writes an immutable anchor
// below endpoint-anchors/<record sha>.json. The anchor path is outside the generic
// allowlist, so publishOwnerRecord can never mint it. options.build runs INSIDE the single
// owner lock (never nests it, never calls the host) after the contract check and returns
// {record}: public, bounded, and equal to the recomputed proof for its milestone. The anchor is issued internally from a proof recomputed
// from the canonical stores (build returns only {record}; a caller anchor refuses). The anchor is published first, then the record,
// so an interrupted publication leaves at most an unreferenced anchor and never an
// unanchored record; a replay of the same value completes it.
const ENDPOINT_ANCHOR_DIR = 'endpoint-anchors';
function endpointAnchorFile(p, sha256) {
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) fail('time-record-path-invalid');
  return path.join(p.directory, ENDPOINT_ANCHOR_DIR, sha256 + '.json');
}
function publishAnchoredEndpoint(options) {
  const p = timePaths(options), file = ownerRecordFile(p, 'endpoint.json');
  if (typeof options.build !== 'function') fail('time-record-invalid');
  return withWriter(options, () => {
    const contract = activeContract(options), { digest } = require('./forge-code-roots');
    const built = options.build({ contract_sha256: contract.sha256, contract_version: contract.version });
    if (!object(built)) fail('time-record-invalid');
    if (built.anchor !== undefined) fail('time-record-invalid');
    const value = recordValue(built.record), sha256 = digest(value), at = Date.parse(value.endpoint_at);
    if (value.milestone !== options.milestone || !Number.isSafeInteger(at)) fail('time-record-invalid');
    const previous = storedRecord(file);
    if (previous && !same(previous, value)) fail('time-record-conflict');
    // A record already stored mints nothing here: its anchor and snapshot witness must already exist.
    if (previous) {
      if (readEndpointAnchor({ ...options, sha256 }).status !== 'valid' || readEndpointSnapshot({ ...options, sha256 }).status !== 'valid') fail('time-record-invalid');
      return { status: 'unchanged', sha256, path: 'endpoint.json', anchor: 'unchanged' };
    }
    // The proof and the snapshot are recomputed here from the canonical stores at the record's own
    // instant: anchor and witness are issued internally and only for a record equal to them.
    const endpoint = require('./forge-milestone-endpoint');
    const anchor = recordValue(endpoint.issueAnchor(value,
      require('./forge-milestone-time-clock').readEndpointProof({ cwd: p.owner, milestone: options.milestone, now: at }),
      endpoint.deriveSnapshot(p.owner, options.milestone, at)));
    const anchored = publishRecordFile(p, endpointAnchorFile(p, sha256), anchor);
    publishRecordFile(p, endpointSnapshotFile(p, sha256), recordValue(endpoint.issueSnapshotWitness(value, anchor)));
    return { ...publishRecordFile(p, file, value), path: 'endpoint.json', anchor: anchored.status };
  });
}
function endpointSnapshotFile(p, sha256) {
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) fail('time-record-path-invalid');
  return path.join(p.directory, 'endpoint-snapshots', sha256 + '.json');
}
function readEndpointSnapshot(options) {
  try {
    const value = storedRecord(endpointSnapshotFile(timePaths(options), options.sha256));
    return value === null ? { status: 'absent' } : { status: 'valid', witness: value };
  } catch (e) { return { status: 'invalid', reason: codeOf(e) }; }
}
function readEndpointAnchor(options) {
  try {
    const value = storedRecord(endpointAnchorFile(timePaths(options), options.sha256));
    return value === null ? { status: 'absent' } : { status: 'valid', anchor: value };
  } catch (e) { return { status: 'invalid', reason: codeOf(e) }; }
}
function listOwnerRecords(options) {
  try {
    const dir = ownerRecordFile(timePaths(options), options.path, 'list'), names = directoryNames(dir), { digest } = require('./forge-code-roots');
    if (names.length > MAX_RECORDS) fail('time-record-limit');
    return { status: 'valid', records: names.map(name => {
      if (!RECORD_FILE.test(name)) fail('time-record-invalid');
      const value = storedRecord(path.join(dir, name)); if (value === null) fail('time-record-invalid');
      return { id: name.slice(0, -5), record: value, sha256: digest(value) };
    }) };
  } catch (e) { return { status: 'invalid', reason: codeOf(e) }; }
}
// The owner journal uses exactly journalValid and journalRecords.
function appendOwnerJournal(options) {
  const p = timePaths(options), file = ownerRecordFile(p, 'linked-task/journal.jsonl', 'journal');
  if (!journalValid(options.record)) fail('time-journal-record-invalid');
  return withWriter(options, () => {
    activeContract(options); noLinks(file, true);
    let content = ''; try { content = bounded(file, MAX_JOURNAL, false).content; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const line = JSON.stringify(options.record) + '\n';
    if (Buffer.byteLength(line) - 1 > MAX_LINE) fail('time-journal-line-limit');
    if (Buffer.byteLength(content + line) > MAX_JOURNAL) fail('time-source-too-large');
    if (content && !content.endsWith('\n')) fail('time-journal-json-invalid');
    const records = journalRecords(content + line);
    ensureDirectory(path.dirname(file)); noLinks(file, true);
    fs.appendFileSync(file, line, { mode: 0o600 }); return { status: 'valid', count: records.length };
  });
}
function readOwnerJournal(options) {
  try {
    const file = ownerRecordFile(timePaths(options), 'linked-task/journal.jsonl', 'journal');
    noLinks(file, true);
    let read; try { read = bounded(file, MAX_JOURNAL, false); } catch (e) { if (e.code === 'ENOENT') return { status: 'absent', records: [] }; throw e; }
    return { status: 'valid', records: journalRecords(read.content) };
  } catch (e) { return { status: 'invalid', reason: codeOf(e) }; }
}
function publishTaskLink(options) {
  const file = linkIndexFile(options), p = timePaths(options), value = recordValue(options.record);
  if (value.task_id !== options.task || value.milestone !== options.milestone) fail('time-record-invalid');
  return withWriter(options, () => { activeContract(options); return publishRecordFile(p, file, value); });
}
function readTaskLink(options) {
  try {
    const value = storedRecord(linkIndexFile(options));
    if (value === null) return { status: 'absent' };
    if (value.task_id !== options.task) fail('time-record-invalid');
    return { status: 'valid', record: value, sha256: require('./forge-code-roots').digest(value) };
  } catch (e) { return { status: 'invalid', reason: codeOf(e) }; }
}
function main(argv = process.argv.slice(2), io = process, liveAdapter) {
  const options = {}; let action, json = argv.includes('--json');
  try {
    const actions = ['--show', '--presence', '--wait-start', '--wait-end', '--extend', '--decide'];
    const values = ['--cwd', '--milestone', '--ceiling-ms', '--question-identity', '--question-id', '--session', '--class', '--source-kind', '--source-ref', '--items', '--reason'];
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i]; if (flag === '--json') continue;
      if (actions.includes(flag)) {
        if (action) fail('time-usage'); action = flag;
        if (!['--show', '--extend'].includes(flag)) { if (!argv[i + 1] || argv[i + 1].startsWith('--')) fail('time-usage'); options.value = argv[++i]; }
      } else if (values.includes(flag) && argv[i + 1] && !argv[i + 1].startsWith('--')) options[flag.slice(2).replace(/-/g, '_')] = argv[++i];
      else fail('time-usage');
    }
    if (!action || !options.cwd || !options.milestone) fail('time-usage');
    timePaths(options); let result;
    if (action === '--show') result = readContract(options);
    else if (['--extend', '--decide'].includes(action)) {
      if (action === '--decide' && !['continue-to-cap', 'reduce-scope'].includes(options.value) || action === '--extend' && !ms(Number(options.ceiling_ms))) fail('time-usage');
      // CLI arguments and persisted question files cannot supply live authority.
      if (typeof liveAdapter?.getDecisionHandle !== 'function') fail('time-decision-attestation-required');
      const kind = action === '--extend' ? 'extension' : options.value === 'reduce-scope' ? 'scope-reduction' : 'continue-to-cap';
      const patch = kind === 'extension' ? { ceiling_ms: Number(options.ceiling_ms) } : kind === 'scope-reduction' ? { deferred_items: (options.items || '').split(',') } : {};
      const request = { kind, reason: options.reason || 'Decisão explícita do operador', patch };
      const handle = liveAdapter.getDecisionHandle({ ...options, request }), live = object(handle) && authorities.get(handle);
      if (!live) fail('time-decision-attestation-required');
      if (live.decision.question.identity_sha256 !== options.question_identity || live.decision.question.id !== options.question_id) fail('time-decision-scope-mismatch');
      result = amendContract({ ...options, ...request, handle });
    } else {
      const at = new Date().toISOString(); let record;
      if (action === '--presence') record = { type: 'presence', boundary: options.value, session_sha256: options.session ? require('./forge-code-roots').digest(options.session) : null, at };
      else record = { type: action.slice(2), wait_id: options.value, class: options.class, source: { kind: options.source_kind, ref: options.source_ref }, at };
      if (!journalValid(record)) fail('time-usage');
      result = appendJournal({ ...options, record });
    }
    const refused = result.status === 'invalid';
    io.stdout.write(json ? JSON.stringify(result) + '\n' : refused ? 'Contrato de tempo inválido: ' + result.reason + '\n' : 'Contrato de tempo: ' + result.status + '\n'); return refused ? 3 : 0;
  } catch (e) {
    const reason = e.code?.startsWith('time-') ? e.code : 'time-operation-refused', status = reason === 'time-usage' ? 2 : 3;
    io.stdout.write(json ? JSON.stringify({ status: 'refused', reason }) + '\n' : status === 2 ? 'Uso inválido do comando de tempo.\n' : 'Operação de tempo recusada: ' + reason + '\n'); return status;
  }
}
module.exports = { SCHEMA_VERSION, ENDPOINT_ITEMS, ITEM_STATES, AMENDMENT_KINDS, JOURNAL_TYPES, WAIT_CLASSES,
  DECISION_KINDS, PRE_ACTIVATION_ENTRIES, LINKED_TASK_AUTHORIZATIONS, isPublicData: publicData,
  timePaths, readContract, validateContract, createDecisionAuthority, activateContract, amendContract, appendJournal, readJournal,
  recordWarning, listWarnings, recordCheckpoint, readCheckpoints, readObservations, readCoverage, recordWorkerEvidence,
  recordEnrollment, readEnrollment, recordOptions, readOptions, listOptions, recordSelection, readSelection, verifyDecision,
  recordDelegatedAllocation, roadmapIdentity, OWNER_RECORD_PATHS, publishOwnerRecord, readOwnerRecord, publishLinkedTaskHandoff, readHandoffBinding, publishLinkedTaskClosureWitness, readLinkedTaskClosureWitness, publishAnchoredEndpoint, readEndpointAnchor, readEndpointSnapshot, listOwnerRecords,
  appendOwnerJournal, readOwnerJournal, publishTaskLink, readTaskLink, main };
if (require.main === module) process.exitCode = main();
