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
const JOURNAL_TYPES = Object.freeze(['presence', 'wait-start', 'wait-end']);
const WAIT_CLASSES = Object.freeze(['human', 'pause', 'ci', 'external']);
const MAX_CONTRACT = 256 * 1024, MAX_AMENDMENT = 64 * 1024, MAX_RECORDS = 256;
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
  return { owner, forge, directory, staging: path.join(forge, 'time-staging', milestone), contract: path.join(directory, 'contract.json'), amendments: path.join(directory, 'amendments'), journal: path.join(directory, 'journal.jsonl'), warnings: path.join(directory, 'warnings'), checkpoints: path.join(directory, 'checkpoints'), observations: path.join(directory, 'observations'), coverage: path.join(directory, 'coverage'), roadmap: path.join(owner, '.gsd/milestones', milestone, milestone + '-ROADMAP.md') };
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
function allocationValid(v) {
  return v === null || exact(v, ['roadmap_sha256', 'items']) && hash(v.roadmap_sha256) && Array.isArray(v.items) && v.items.length > 0 && v.items.length <= MAX_RECORDS
    && new Set(v.items.map(r => r?.id)).size === v.items.length && v.items.every(r => exact(r, ['id', 'kind', 'ms'], ['slice']) && id(r.id) && ALLOCATION_KINDS.includes(r.kind) && ms(r.ms) && (r.slice === undefined || typeof r.slice === 'string' && /^S\d{2,}$/.test(r.slice)));
}
function validateContract(c) {
  let valid = exact(c, CONTRACT_KEYS) && c.schema_version === SCHEMA_VERSION && publicData(c);
  if (valid) {
    const ids = require('./forge-ids');
    valid = ids.isValid(c.milestone) && ids.entityKind(c.milestone) === 'milestone'
      && exact(c.clock_policy, ['id', 'version']) && c.clock_policy.id === 'forge-milestone-time-clock' && c.clock_policy.version === 1
      && exact(c.option, ['id', 'options_sha256', 'label']) && id(c.option.id) && hash(c.option.options_sha256) && text(c.option.label)
      && instant(c.activated_at) && instant(c.preselection_started_at) && Date.parse(c.preselection_started_at) <= Date.parse(c.activated_at) && ms(c.ceiling_ms)
      && exact(c.endpoint, ['kind', 'items']) && c.endpoint.kind === 'verified-integrated-delivery' && exact(c.endpoint.items, ENDPOINT_ITEMS)
      && ENDPOINT_ITEMS.every(k => ITEM_STATES.includes(c.endpoint.items[k])) && allocationValid(c.allocation)
      && c.linked_task === null && c.chain_forecast === null && decisionValid(c.decision);
  }
  return { valid: !!valid, ...(valid ? {} : { reason: 'time-contract-schema-invalid' }) };
}
function applyAmendment(contract, row) {
  if (!exact(row, ['schema_version', 'milestone', 'version', 'previous_sha256', 'kind', 'reason', 'patch', 'decision']) || row.schema_version !== 1
      || row.milestone !== contract.milestone || !Number.isSafeInteger(row.version) || row.version < 2 || !hash(row.previous_sha256)
      || !AMENDMENT_KINDS.includes(row.kind) || !text(row.reason) || !publicData(row) || !decisionValid(row.decision)) fail('time-amendment-invalid');
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
    if (!names.length) return { status: 'absent' };
    if (!names.includes('contract.json')) fail('time-contract-base-missing');
    let contract = bounded(p.contract, MAX_CONTRACT);
    if (contract?.milestone !== options.milestone) fail('time-contract-milestone-mismatch');
    if (!validateContract(contract).valid) fail('time-contract-schema-invalid');
    const { digest } = require('./forge-code-roots');
    let sha256 = digest(contract), version = 1;
    const chain = [{ version, sha256, decision: contract.decision }], files = directoryNames(p.amendments);
    if (files.length > MAX_RECORDS) fail('time-amendment-limit');
    const seen = new Set([contract.decision.question.identity_sha256 + ':' + contract.decision.question.id]);
    for (const file of files) {
      if (file !== String(version + 1).padStart(4, '0') + '.json') fail('time-amendment-sequence-invalid');
      const row = bounded(path.join(p.amendments, file), MAX_AMENDMENT);
      if (row.version !== version + 1) fail('time-amendment-sequence-invalid');
      if (row.previous_sha256 !== sha256) fail('time-amendment-chain-invalid');
      const identity = row.decision?.question?.identity_sha256 + ':' + row.decision?.question?.id;
      if (seen.has(identity)) fail('time-decision-conflict'); seen.add(identity);
      contract = applyAmendment(contract, row); version = row.version; sha256 = digest(contract);
      chain.push({ ...row, sha256 });
    }
    return { status: 'valid', contract, version, sha256, chain };
  } catch (e) { return { status: 'invalid', reason: e.code?.startsWith('time-') ? e.code : 'time-source-unreadable' }; }
}
function liveAnswer(resolver, reference, scope, now) {
  let a; try { a = resolver(reference); } catch { fail('time-decision-attestation-required'); }
  if (!Number.isSafeInteger(now) || !a || a.reference !== reference || a.status !== 'resolved' || !text(a.answer) || !instant(a.resolved_at) || Date.parse(a.resolved_at) > now
      || !['user-text', 'tool-answer'].includes(a.source) || !exact(a.question, ['identity_sha256', 'id']) || !hash(a.question.identity_sha256) || !id(a.question.id)
      || !id(reference) || !object(scope) || !['activation', ...AMENDMENT_KINDS].includes(scope.kind) || !hash(scope.request_sha256)
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
  if (entry.scope.milestone !== options.milestone || entry.scope.kind !== kind || entry.scope.request_sha256 !== digest(request)) fail('time-decision-scope-mismatch');
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
    noLinks(p.roadmap, true); if (fs.existsSync(p.roadmap)) fail('time-contract-roadmap-exists');
    publishExclusive(p.contract, contract, MAX_CONTRACT, p.staging); return validStored(options);
  });
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
    const previous = current.chain.find(r => same(r.decision.question, decision.question));
    if (previous) { if (!same(previous.decision, decision) || previous.kind !== kind || previous.reason !== reason || !same(previous.patch, patch)) fail('time-decision-conflict'); return current; }
    if (current.version > MAX_RECORDS) fail('time-amendment-limit');
    const row = { schema_version: 1, milestone: options.milestone, version: current.version + 1, previous_sha256: current.sha256, kind, reason, patch, decision };
    applyAmendment(current.contract, row);
    if (kind === 'allocation') {
      if (require('./forge-code-roots').digest(bounded(p.roadmap, MAX_CONTRACT, false).buffer) !== patch.allocation.roadmap_sha256) fail('time-allocation-roadmap-mismatch');
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
  timePaths, readContract, validateContract, createDecisionAuthority, activateContract, amendContract, appendJournal, readJournal,
  recordWarning, listWarnings, recordCheckpoint, readCheckpoints, readObservations, readCoverage, recordWorkerEvidence, main };
if (require.main === module) process.exitCode = main();
