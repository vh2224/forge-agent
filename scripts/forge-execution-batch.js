#!/usr/bin/env node
'use strict';

/*
 * forge-execution-batch — the canonical batch decision of forge-auto execute-task
 * (issue 343 U1, B1).
 *
 * Only orchestrate.next calls it, in the loop's auto mode, after the controller selected
 * an execute-task canonically (that unit is the PRIMARY). A sidecar primary may form one
 * cohort with the other independent ready sidecar tasks of the same slice; every other
 * case keeps the current single (or native) path with ONE closed reason (REASON_CODES).
 * Nothing here spawns a worker, edits STATE, completes a member or grants a write.
 *
 *   decide(scope, options)     read-only decision: the published manifest of this exact
 *                              request (replay), a fresh sealed manifest, or `single`
 *   dispatch(scope, options)   the decision made durable: the immutable manifest is
 *                              published exclusively BEFORE any lease, then every member
 *                              begins through the controller's internal begin under ONE
 *                              transaction mutex hold (forge-unit-controller begin with
 *                              `members`), then its per-member progress advances by CAS
 *   readManifest / readProgress / appendProgress / status   owner records and projection
 *   prepareIsolation(scope)    issue 343 U2a: before any child, serially, the measured dirty
 *                              base (forge-isolation captureBatchBase) and one exclusive
 *                              worktree and index per admitido member and root
 *                              (setupForBatchMember), through opaque in-process handles of
 *                              this module (resolveIsolationHandle) that nothing else mints
 *   openCohortBroker(scope, handles)  issue 343 U3a: the cohort broker lifecycle; one signing
 *                              broker child (forge-artifact-reconciliation startBatchBroker)
 *                              over the closed registry of bound, still admitido members, with
 *                              an opaque cohort handle for its barrier and close
 *   memberSidecar(handle, request)  issue 343 U3b: the sidecar operations of one live member
 *                              attempt (signed owner events, the cohort owner verification, the
 *                              retained executed record and its anchor); runtime views minted
 *                              here (isMemberView) are the only views physical consumers accept
 *   runCohort(scope, options)  issue 343 U4: the bounded pool of one admitted cohort and the engine
 *                              of the CLI `run --batch <ref> --request <file>`: every member
 *                              prepared before S0, one cohort broker, the real runUnitSidecar per
 *                              member under the resolved max_concurrent, one process scope per
 *                              member (currentMemberProcessScope), the barrier after the real join
 *                              of every writer and a typed JSON outcome per member
 *
 * Durable layout (owner .gsd only; regular files, no links, bounded, never rewritten):
 *   .gsd/forge/batches/<batch_id>/manifest.json                    the decision
 *   .gsd/forge/batches/<batch_id>/progress/m<index>/<NNNN>.json    one CAS chain per member
 *
 * The batch_id is an operational identity inside the real run, derived from the primary's
 * single request key: it creates no run, milestone, claim or lease by itself. A manifest is
 * a record, never authority. Imported JSON (a caller's manifest, dispatch_batch, approved
 * flag or snapshot) is never read here, and a member that has not begun is admitted again
 * against the live owner state (generation, declarations, route, lease, time) before its
 * begin. Members get the parent's canonical route/model/tier/effort for THEIR task, never
 * a sibling's, and never another model. Public projections carry no token or raw session.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { ChildProcess } = require('child_process');

// Local modules load lazily, inside the functions that use them: requiring this file loads
// no Forge module, so forge-unit-controller can check member bindings without a cycle.
function controller() { return require('./forge-unit-controller'); }
function planValidation() { return require('./forge-plan-validation'); }
function parallelism() { return require('./forge-parallelism'); }
function codeRoots() { return require('./forge-code-roots'); }
function leases() { return require('./forge-unit-lease'); }
function boundedReader() { return require('./forge-autonomy-sources'); }
function isolation() { return require('./forge-isolation'); }

const SCHEMA = 'forge-execution-batch-v1';
const PROGRESS_SCHEMA = 'forge-execution-batch-progress-v1';
const KIND = 'execute-task-cohort';
// forge-code-roots validateContract refuses more than 14 roots: the cohort is reduced, the
// limit never enlarged. Members: the prefs range of parallelism.max_concurrent is 1-8.
const ROOTS_LIMIT = 14;
const MAX_MEMBERS = 8;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_PROGRESS_BYTES = 8 * 1024;
const MAX_PROGRESS_ENTRIES = 32;
const MAX_RETAINED_BATCHES = 256;
const BATCH_ID = /^batch-[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const OWNER_DIGEST = /^sha256:[a-f0-9]{64}$/;
const TASK_ID = /^T\d+(?:\.\d+)?$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BATCH_SEGMENTS = Object.freeze(['.gsd', 'forge', 'batches']);
const STAGING = '.staging';

// One closed reason per decision that keeps the current single/native path.
const REASON_CODES = Object.freeze(['single-candidate', 'primary-native', 'mode-not-auto', 'unit-not-execute-task',
  'legacy-plan-sequential', 'plan-generation-invalid', 'dependency-unmet', 'writes-overlap', 'route-not-sidecar',
  'route-stale', 'svn-isolation-unavailable', 'vcs-isolation-unavailable', 'isolation-policy',
  'materialization-unsupported', 'roots-limit', 'max-concurrent', 'max-steps', 'time-admission',
  'lease-scope-collision', 'claim-gate-conflict', 'pending-question', 'member-begin-refused']);
// Refusals of a durable batch record or command: blocked boundaries, never a fallback.
const REFUSAL_CODES = Object.freeze(['batch-scope-invalid', 'batch-manifest-invalid', 'batch-manifest-foreign',
  'batch-member-begin-foreign', 'batch-progress-invalid', 'batch-progress-conflict', 'batch-active',
  'batch-not-active', 'batch-members-pending', 'batch-member-operation-deferred', 'batch-dispatch-invalid']);
// Per-member progress (the closed list of the approved plan, kept verbatim).
const MEMBER_STATES = Object.freeze(['preparado', 'admitido', 'executando', 'retido', 'verificacao-falhou',
  'publicacao-pendente', 'publicado', 'integrado', 'ack', 'falhou', 'bloqueado', 'needs-input']);
const TERMINAL_STATES = Object.freeze(['ack', 'falhou', 'bloqueado']);
// '' is the unrecorded state. A member blocked before preparation goes straight to bloqueado.
const TRANSITIONS = Object.freeze({
  '': Object.freeze(['preparado', 'bloqueado']),
  preparado: Object.freeze(['admitido', 'bloqueado', 'falhou']),
  admitido: Object.freeze(['executando', 'needs-input', 'bloqueado', 'falhou']),
  executando: Object.freeze(['retido', 'needs-input', 'bloqueado', 'falhou']),
  'needs-input': Object.freeze(['executando', 'bloqueado', 'falhou']),
  retido: Object.freeze(['verificacao-falhou', 'publicacao-pendente', 'bloqueado', 'falhou']),
  'verificacao-falhou': Object.freeze(['bloqueado', 'falhou']),
  'publicacao-pendente': Object.freeze(['publicado', 'bloqueado', 'falhou']),
  publicado: Object.freeze(['integrado', 'bloqueado', 'falhou']),
  integrado: Object.freeze(['ack', 'bloqueado', 'falhou']),
  ack: Object.freeze([]), falhou: Object.freeze([]), bloqueado: Object.freeze([]),
});

const BINDING_KEYS = Object.freeze(['schema', 'batch_id', 'manifest_sha256', 'member_index', 'task_id']);
const MANIFEST_KEYS = Object.freeze(['schema', 'kind', 'batch_id', 'owner', 'milestone', 'slice', 'request_key', 'host_runtime',
  'owner_digest', 'primary', 'generation', 'slice_plan', 'limits', 'members', 'excluded', 'decided_at', 'manifest_sha256']);
const MEMBER_KEYS = Object.freeze(['index', 'task_id', 'unit', 'begin_key', 'plan', 'declaration_sha256', 'depends', 'writes',
  'roots', 'route', 'time_admission', 'step_charge']);
const ROUTE_KEYS = Object.freeze(['worker_mode', 'dispatch_allowed', 'host_runtime', 'resolved_worker_engine', 'engine', 'model',
  'tier', 'effort', 'chain', 'sidecar_model', 'resolution_options', 'resolution_sources_sha256', 'route_sha256']);
const GENERATION_KEYS = Object.freeze(['status', 'generation_key', 'validation_key', 'semantic_sha256', 'graph_sha256']);
const LIMIT_KEYS = Object.freeze(['max_concurrent', 'max_concurrent_source', 'remaining_steps', 'roots_limit', 'roots_used', 'retained_roots']);
const PROGRESS_KEYS = Object.freeze(['schema', 'batch_id', 'member_index', 'task_id', 'sequence', 'state', 'previous_state',
  'previous_sha256', 'reason_code', 'at', 'entry_sha256']);

// ── Small pure helpers ────────────────────────────────────────────────────────

function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' ? value : ''; }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}
function digestOf(value) { return sha256(JSON.stringify(stable(value))); }
function copy(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
function sameKeys(value, keys) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...keys].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
function nowOf(options) {
  if (options && typeof options.now === 'function') return options.now();
  return options && Number.isFinite(options.now) ? options.now : Date.now();
}
function isoInstant(value) {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function pad(sequence) { return String(sequence).padStart(4, '0'); }

class BatchError extends Error {
  constructor(code, detail, extra) {
    super(`forge-execution-batch (${code}): ${detail}`);
    this.name = 'BatchError';
    this.code = code;
    this.detail = detail;
    if (extra) Object.assign(this, extra);
  }
}
function refuse(code, detail, extra) { throw new BatchError(code, detail, extra); }

// ── Identity and member binding ───────────────────────────────────────────────

function ownerDigest(token) { return `sha256:${sha256(String(token).normalize('NFC').trim())}`; }
// One batch per primary request: a crash or a repeated next of the same request finds it.
function batchIdOf(scope) {
  return `batch-${digestOf({ schema: SCHEMA, milestone: scope.milestone, slice: scope.slice, unit: scope.unit.key,
    request_key: scope.request_key }).slice(0, 32)}`;
}
function memberBeginKey(batchId, unitKey) { return `forge-execution-batch:${batchId}:${unitKey}`; }
function manifestRef(batchId) { return `.gsd/forge/batches/${batchId}/manifest.json`; }
// The binding each member begin transaction carries (forge-unit-controller validates it on
// every read): it names the manifest digest and the member, and its key is derived from it.
function memberBinding(manifest, member) {
  return { schema: SCHEMA, batch_id: manifest.batch_id, manifest_sha256: manifest.manifest_sha256,
    member_index: member.index, task_id: member.task_id };
}
function validBinding(binding, key, unit) {
  return sameKeys(binding, BINDING_KEYS) && binding.schema === SCHEMA
    && typeof binding.batch_id === 'string' && BATCH_ID.test(binding.batch_id)
    && typeof binding.manifest_sha256 === 'string' && HASH.test(binding.manifest_sha256)
    && Number.isSafeInteger(binding.member_index) && binding.member_index >= 0 && binding.member_index < MAX_MEMBERS
    && typeof binding.task_id === 'string' && TASK_ID.test(binding.task_id)
    && isObject(unit) && unit.type === 'execute-task' && unit.id === binding.task_id && unit.key === `execute-task/${binding.task_id}`
    && key === memberBeginKey(binding.batch_id, unit.key);
}
function sameBinding(left, right) { return isObject(left) && isObject(right) && digestOf(left) === digestOf(right); }

function scopeOf(scope) {
  if (!isObject(scope)) refuse('batch-scope-invalid', 'scope must be an object');
  const unit = scope.unit;
  if (!isObject(unit) || typeof unit.type !== 'string' || typeof unit.id !== 'string' || typeof unit.key !== 'string') {
    refuse('batch-scope-invalid', 'the selected unit is required');
  }
  for (const key of ['cwd', 'milestone', 'request_key', 'host_runtime', 'owner_token']) {
    if (typeof scope[key] !== 'string' || !scope[key] || scope[key].includes('\u0000')) refuse('batch-scope-invalid', `${key} is required`);
  }
  return scope;
}

// ── Owner records: real directories, bounded reads, exclusive publication ─────

function ownerOf(cwd) {
  let real;
  try {
    real = fs.realpathSync.native(cwd);
    if (!fs.statSync(real).isDirectory()) throw new Error('not a directory');
  } catch (_) { return refuse('batch-manifest-invalid', 'the owner root is not a readable directory'); }
  return { real, key: codeRoots().key(real) };
}
// Every component below `base` is a real directory (no link, no junction).
function directoryAt(base, segments) {
  let cursor = base;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    let stat;
    try { stat = fs.lstatSync(cursor); }
    catch (error) { return { status: error && error.code === 'ENOENT' ? 'missing' : 'unreadable', dir: cursor }; }
    if (stat.isSymbolicLink()) return { status: 'link', dir: cursor };
    if (!stat.isDirectory()) return { status: 'not-regular', dir: cursor };
  }
  return { status: 'ok', dir: cursor };
}
// `.gsd` must already exist: only its descendants are created, one real directory at a time.
function ensureDirectory(base, segments, code) {
  let cursor = base;
  segments.forEach((segment, index) => {
    cursor = path.join(cursor, segment);
    let stat = null;
    try { stat = fs.lstatSync(cursor); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
    if (!stat) {
      if (index === 0) refuse(code, 'the owner has no .gsd directory');
      try { fs.mkdirSync(cursor); } catch (error) { if (!error || error.code !== 'EEXIST') throw error; }
      stat = fs.lstatSync(cursor);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) refuse(code, `${segments.slice(0, index + 1).join('/')} is not a real directory`);
  });
  return cursor;
}
function readRecord(owner, segments, name, maxBytes, code) {
  const found = directoryAt(owner.real, segments);
  if (found.status === 'missing') return null;
  if (found.status !== 'ok') refuse(code, `${segments.join('/')} is not a real directory (${found.status})`);
  const file = path.join(found.dir, name);
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return refuse(code, `${name} is unreadable`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) refuse(code, `${name} is not a regular record`);
  if (stat.size > maxBytes) refuse(code, `${name} exceeds ${maxBytes} bytes`);
  const read = boundedReader().readBoundedStableFile(file, maxBytes, { expectedReal: file });
  if (read.error) refuse(code, `${name} is unstable or unreadable`);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.buffer)); }
  catch (_) { return refuse(code, `${name} is not a JSON record`); }
}
// The complete record is written and synced in staging, then hard linked to its name: a
// collision refuses (returns false), a rename could overwrite history. Staging debris is
// never read as a record.
function publishExclusive(owner, segments, name, value, maxBytes, code) {
  const buffer = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (buffer.length > maxBytes) refuse(code, `${name} exceeds ${maxBytes} bytes`);
  const dir = ensureDirectory(owner.real, segments, code);
  const staging = ensureDirectory(owner.real, [...BATCH_SEGMENTS, STAGING], code);
  const temporary = path.join(staging, `${name}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let created = false;
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    try { fs.writeFileSync(descriptor, buffer); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    try { fs.linkSync(temporary, path.join(dir, name)); return true; }
    catch (error) {
      if (error && error.code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    if (created) {
      try { fs.unlinkSync(temporary); } catch (_) { /* staging debris is never authority */ }
    }
  }
}

// ── Manifest ──────────────────────────────────────────────────────────────────

function sealManifest(content) { return { ...content, manifest_sha256: digestOf(content) }; }
function verifyManifest(record, batchId) {
  const bad = detail => refuse('batch-manifest-invalid', detail);
  if (!sameKeys(record, MANIFEST_KEYS)) bad('the manifest fields are not the closed manifest schema');
  const { manifest_sha256: sealed, ...content } = record;
  if (typeof sealed !== 'string' || !HASH.test(sealed) || sealed !== digestOf(content)) bad('manifest_sha256 does not bind the manifest');
  if (record.schema !== SCHEMA || record.kind !== KIND || record.batch_id !== batchId || !BATCH_ID.test(batchId)) bad('the manifest names another batch');
  for (const key of ['owner', 'milestone', 'slice', 'request_key', 'host_runtime']) if (typeof record[key] !== 'string' || !record[key]) bad(`${key} is required`);
  if (typeof record.owner_digest !== 'string' || !OWNER_DIGEST.test(record.owner_digest)) bad('owner_digest is required');
  if (!sameKeys(record.generation, GENERATION_KEYS) || record.generation.status !== 'current'
      || !HASH.test(text(record.generation.semantic_sha256))) bad('the admitted generation is required');
  if (!isObject(record.slice_plan) || !HASH.test(text(record.slice_plan.sha256))) bad('the slice plan digest is required');
  if (!sameKeys(record.limits, LIMIT_KEYS) || !Number.isSafeInteger(record.limits.max_concurrent)
      || record.limits.roots_limit !== ROOTS_LIMIT || !Number.isSafeInteger(record.limits.roots_used)
      || record.limits.roots_used > ROOTS_LIMIT) bad('the decision limits are invalid');
  if (!Array.isArray(record.members) || record.members.length < 2 || record.members.length > MAX_MEMBERS) bad('a batch has 2 to 8 members');
  if (record.members.length > record.limits.max_concurrent || record.members.length > record.limits.remaining_steps) bad('the members exceed the decision limits');
  const seen = new Set();
  record.members.forEach((member, index) => {
    const label = `members[${index}]`;
    if (!sameKeys(member, MEMBER_KEYS)) bad(`${label} fields are not the closed member schema`);
    if (member.index !== index || typeof member.task_id !== 'string' || !TASK_ID.test(member.task_id) || seen.has(member.task_id)) bad(`${label} identity is invalid`);
    seen.add(member.task_id);
    if (member.unit !== `execute-task/${member.task_id}` || member.begin_key !== memberBeginKey(batchId, member.unit)) bad(`${label} begin key is not derived from the batch`);
    if (!isObject(member.plan) || typeof member.plan.path !== 'string' || !HASH.test(text(member.plan.sha256))
        || !HASH.test(text(member.declaration_sha256))) bad(`${label} plan binding is invalid`);
    if (!Array.isArray(member.depends) || !Array.isArray(member.writes) || !Array.isArray(member.roots) || !member.roots.length) bad(`${label} declarations are invalid`);
    if (!sameKeys(member.route, ROUTE_KEYS) || member.route.worker_mode !== 'sidecar' || member.route.dispatch_allowed !== true
        || member.route.host_runtime !== record.host_runtime || !HASH.test(text(member.route.route_sha256))) bad(`${label} route is not an allowed sidecar route`);
    if (!isObject(member.time_admission) || typeof member.time_admission.decision !== 'string' || member.step_charge !== 1) bad(`${label} admission is invalid`);
  });
  if (!isObject(record.primary) || record.primary.task_id !== record.members[0].task_id || record.primary.unit !== record.members[0].unit) {
    bad('the primary is not the first member');
  }
  if (!Array.isArray(record.excluded) || record.excluded.some(row => !isObject(row) || !REASON_CODES.includes(row.reason_code))) bad('excluded is invalid');
  if (!isoInstant(record.decided_at)) bad('decided_at is not an instant');
  return deepFreeze(record);
}
function readManifestAt(owner, batchId) {
  if (typeof batchId !== 'string' || !BATCH_ID.test(batchId)) refuse('batch-manifest-invalid', 'batch_id is invalid');
  const record = readRecord(owner, [...BATCH_SEGMENTS, batchId], 'manifest.json', MAX_MANIFEST_BYTES, 'batch-manifest-invalid');
  return record === null ? null : verifyManifest(record, batchId);
}
function readManifest(cwd, batchId) { return readManifestAt(ownerOf(cwd), batchId); }
// A published manifest is used only by the same owner, request, primary, host and owner token.
function assertManifestScope(manifest, scope, owner) {
  if (manifest.owner !== owner.key || manifest.milestone !== scope.milestone || manifest.slice !== scope.slice
      || manifest.request_key !== scope.request_key || manifest.primary.unit !== scope.unit.key
      || manifest.host_runtime !== scope.host_runtime || manifest.owner_digest !== ownerDigest(scope.owner_token)) {
    refuse('batch-manifest-foreign', 'the published manifest belongs to another owner, request, primary, host or owner token');
  }
}

// ── Per-member progress: one CAS chain per member ─────────────────────────────

function progressSegments(batchId, index) { return [...BATCH_SEGMENTS, batchId, 'progress', `m${index}`]; }
function verifyEntry(entry, prior, manifest, member) {
  const bad = detail => refuse('batch-progress-invalid', `${member.task_id}: ${detail}`);
  if (!sameKeys(entry, PROGRESS_KEYS)) bad('progress fields are not the closed progress schema');
  const { entry_sha256: sealed, ...content } = entry;
  if (typeof sealed !== 'string' || sealed !== digestOf(content)) bad('entry_sha256 does not bind the entry');
  const last = prior.length ? prior[prior.length - 1] : null;
  if (entry.schema !== PROGRESS_SCHEMA || entry.batch_id !== manifest.batch_id || entry.member_index !== member.index
      || entry.task_id !== member.task_id || entry.sequence !== prior.length + 1
      || entry.previous_sha256 !== (last ? last.entry_sha256 : manifest.manifest_sha256)
      || entry.previous_state !== (last ? last.state : null)) bad('the entry is not linked to its predecessor');
  if (!MEMBER_STATES.includes(entry.state) || !(TRANSITIONS[entry.previous_state || ''] || []).includes(entry.state)) bad('the transition is not allowed');
  if (entry.reason_code !== null && !REASON_CODES.includes(entry.reason_code)) bad('reason_code is not a closed reason');
  if (!isoInstant(entry.at)) bad('at is not an instant');
}
function readChain(owner, manifest, member) {
  const segments = progressSegments(manifest.batch_id, member.index);
  const found = directoryAt(owner.real, segments);
  if (found.status === 'missing') return [];
  if (found.status !== 'ok') refuse('batch-progress-invalid', `${member.task_id} progress is not a real directory (${found.status})`);
  let names;
  try { names = fs.readdirSync(found.dir).sort(); }
  catch (_) { return refuse('batch-progress-invalid', `${member.task_id} progress is unreadable`); }
  if (names.length > MAX_PROGRESS_ENTRIES) refuse('batch-progress-invalid', `${member.task_id} progress exceeds ${MAX_PROGRESS_ENTRIES} entries`);
  names.forEach((name, index) => {
    if (name !== `${pad(index + 1)}.json`) refuse('batch-progress-invalid', `${member.task_id} progress has an unexpected entry`);
  });
  const entries = [];
  for (const name of names) {
    const entry = readRecord(owner, segments, name, MAX_PROGRESS_BYTES, 'batch-progress-invalid');
    if (entry === null) refuse('batch-progress-invalid', `${member.task_id} progress entry vanished`);
    verifyEntry(entry, entries, manifest, member);
    entries.push(entry);
  }
  return entries;
}
function progressOf(owner, manifest) {
  return manifest.members.map(member => {
    const entries = readChain(owner, manifest, member), last = entries.length ? entries[entries.length - 1] : null;
    return { index: member.index, task_id: member.task_id, state: last ? last.state : null,
      reason_code: last ? last.reason_code : null, sequence: entries.length };
  });
}
function readProgress(cwd, manifest) { return deepFreeze(progressOf(ownerOf(cwd), manifest)); }
// Compare-and-swap: the caller names the state it observed. Reaching the same target twice
// is a no-op (an interrupted or concurrent replay); any other divergence refuses.
function appendAt(owner, manifest, index, expected, next, reasonCode, options) {
  const member = manifest.members[index];
  if (!member) refuse('batch-progress-invalid', `member ${index} is not in the manifest`);
  if (!MEMBER_STATES.includes(next)) refuse('batch-progress-invalid', `${next} is not a member state`);
  if (reasonCode !== null && !REASON_CODES.includes(reasonCode)) refuse('batch-progress-invalid', 'reason_code is not a closed reason');
  for (let attempt = 0; attempt < 2; attempt++) {
    const entries = readChain(owner, manifest, member);
    const last = entries.length ? entries[entries.length - 1] : null, current = last ? last.state : null;
    if (current === next) return { appended: false, state: current, sequence: entries.length };
    if (current !== expected) refuse('batch-progress-conflict', `${member.task_id} is ${current || 'unrecorded'}, not ${expected || 'unrecorded'}`);
    if (!(TRANSITIONS[current || ''] || []).includes(next)) refuse('batch-progress-conflict', `${current || 'unrecorded'} cannot become ${next}`);
    if (entries.length >= MAX_PROGRESS_ENTRIES) refuse('batch-progress-invalid', `${member.task_id} progress is full`);
    const content = { schema: PROGRESS_SCHEMA, batch_id: manifest.batch_id, member_index: member.index, task_id: member.task_id,
      sequence: entries.length + 1, state: next, previous_state: current,
      previous_sha256: last ? last.entry_sha256 : manifest.manifest_sha256, reason_code: reasonCode,
      at: new Date(nowOf(options)).toISOString() };
    const published = publishExclusive(owner, progressSegments(manifest.batch_id, member.index), `${pad(content.sequence)}.json`,
      { ...content, entry_sha256: digestOf(content) }, MAX_PROGRESS_BYTES, 'batch-progress-invalid');
    if (published) return { appended: true, state: next, sequence: content.sequence };
    // Another writer took this sequence: read the chain once more and compare again.
  }
  return refuse('batch-progress-conflict', `${member.task_id} progress changed concurrently`);
}
function appendProgress(cwd, manifest, index, expected, next, reasonCode, options = {}) {
  return appendAt(ownerOf(cwd), manifest, index, expected, next, reasonCode === undefined ? null : reasonCode, options);
}

// ── Decision inputs ───────────────────────────────────────────────────────────

function recordAt(cwd, key) {
  try { return { record: controller().lookupRecord(cwd, 'transaction', key) }; }
  catch (_) { return { record: null, conflict: true }; }
}
function leaseHeld(cwd, unitKey) {
  try { const seen = leases().observe(cwd, unitKey); return !seen.ok || !!seen.lease; }
  catch (_) { return true; }
}
// The owner census the budget resume uses: an unreadable, excessive or pending census is a
// pending functional question, and a pending question never becomes a cohort.
function pendingQuestion(cwd, milestone) {
  try {
    const listed = require('./forge-pending-questions').listPendingQuestions({ cwd, filter: { type: 'milestone', id: milestone } });
    if (listed.census.invalid || listed.census.excess || !['no-questions', 'no-matching-questions', null].includes(listed.empty_reason)) return true;
    return listed.questions.some(row => row.status === 'pending');
  } catch (_) { return true; }
}
// The resolved parallelism limit: forge-resources' fail-open readParallelismPref (default 3,
// schema range untouched) through its exported clamp, over the controller's trusted prefs.
function maxConcurrentOf(scope, options) {
  try {
    const prefsResult = typeof options.prefsReader === 'function' ? options.prefsReader(scope.cwd) : require('./forge-prefs').readPrefs(scope.cwd);
    const budget = require('./forge-resources').resolveResourceBudget({ cwd: scope.cwd, prefsResult, noEvents: true,
      ...(typeof options.now === 'function' ? { now: options.now } : {}) });
    return Number.isSafeInteger(budget.maxConcurrentClamp) && budget.maxConcurrentClamp >= 1 ? budget.maxConcurrentClamp : 1;
  } catch (_) { return 1; }
}
// An explicit `forge_isolation.mode: shared` is the operator's opt-out of worktrees: no
// member worktree is created behind it. A derived default keeps its current behaviour.
function isolationRefused(cwd) {
  try {
    const prefs = require('./forge-isolation').readIsolationPrefs(cwd);
    return prefs.modeSource === 'pref' && prefs.mode === 'shared';
  } catch (_) { return true; }
}
// The member's canonical route from the current resolver, for ITS task plan only. The
// trusted in-process `routeResolver` seam (never JSON) defaults to resolveDispatch.
function routeOf(scope, task, options) {
  const resolver = typeof options.routeResolver === 'function' ? options.routeResolver : require('./forge-dispatch-resolve').resolveDispatch;
  const resolutionOptions = { unitType: 'execute-task', cwd: scope.cwd, planPath: path.join(scope.cwd, ...task.plan_path.split('/')),
    roadmapPath: path.join(scope.cwd, '.gsd', 'milestones', scope.milestone, `${scope.milestone}-ROADMAP.md`),
    milestoneId: scope.milestone, unitId: task.id, hostRuntime: scope.host_runtime };
  let route;
  try { route = resolver(copy(resolutionOptions)); } catch (_) { return { reason: 'route-not-sidecar' }; }
  if (!isObject(route) || route.dispatch_allowed !== true || route.prefs_ok === false || route.config_ok === false) return { reason: 'route-not-sidecar' };
  if (route.worker_mode !== 'sidecar') return { reason: 'route-not-sidecar', native: route.worker_mode === 'native' };
  if (route.host_runtime !== scope.host_runtime) return { reason: 'route-not-sidecar' };
  const policy = { worker_mode: 'sidecar', dispatch_allowed: true, host_runtime: route.host_runtime,
    resolved_worker_engine: text(route.resolved_worker_engine), engine: text(route.engine), model: text(route.model_resolved || route.model),
    tier: text(route.tier), effort: text(route.effort),
    chain: Array.isArray(route.chain) ? route.chain.map(entry => (isObject(entry) && typeof entry.id === 'string' ? entry.id : '')).filter(Boolean) : [],
    sidecar_model: text(route.sidecar_model) };
  const sources = digestOf(Array.isArray(route.resolution_sources) ? route.resolution_sources : []);
  return { route: { ...policy, resolution_options: resolutionOptions, resolution_sources_sha256: sources,
    route_sha256: digestOf({ policy, resolution_options: resolutionOptions, resolution_sources_sha256: sources }) } };
}
// Declared roots of a member: the plan's code_roots, or the one legacy root (CODE_DIR
// locator, else the owner) of a single-root plan.
function rootsOf(scope, task) {
  const declared = task.declaration.declared_roots;
  if (declared === null) return [{ id: task.declaration.primary_root_id || 'primary', path: scope.code_root || scope.cwd, vcs: null }];
  return declared.map(root => ({ id: root.id, path: root.path, vcs: root.vcs }));
}
// Physical measurement of every member root: Git with a checkout of its own (worktree and
// index per member are U2), SVN and unknown VCS stay serial, submodules cannot be
// materialized into a member worktree.
function measureRoots(roots) {
  const measured = [];
  if (!Array.isArray(roots) || !roots.length) return { reason: 'vcs-isolation-unavailable' };
  for (const root of roots) {
    if (typeof root.id !== 'string' || typeof root.path !== 'string' || !path.isAbsolute(root.path)) return { reason: 'vcs-isolation-unavailable' };
    if (root.vcs === 'svn') return { reason: 'svn-isolation-unavailable' };
    let real;
    try { real = fs.realpathSync.native(root.path); } catch (_) { return { reason: 'vcs-isolation-unavailable' }; }
    let vcs;
    try { vcs = require('./forge-ignore').detectVcs(real); } catch (_) { vcs = 'none'; }
    if (vcs === 'svn') return { reason: 'svn-isolation-unavailable' };
    if (vcs !== 'git' || (root.vcs !== null && root.vcs !== 'git')) return { reason: 'vcs-isolation-unavailable' };
    let entry;
    try { entry = codeRoots().measureRoot({ id: root.id, path: real, vcs: 'git' }); } catch (_) { return { reason: 'vcs-isolation-unavailable' }; }
    if (fs.existsSync(path.join(entry.path, '.gitmodules'))) return { reason: 'materialization-unsupported' };
    measured.push({ root_id: entry.id, vcs: 'git', identity_sha256: entry.identity_sha256 });
  }
  return { roots: measured };
}
// The owner time admission of one member begin, read-only; the begin itself decides again
// and records it once (forge-unit-controller beginInside).
function timeVerdict(scope, unit, key, options) {
  try {
    const decided = require('./forge-milestone-time-admission').decideAdmission(scope.cwd,
      { milestone: scope.milestone, unit, key, now: options.now, kind: 'begin' });
    return decided && decided.allowed === true ? { decision: typeof decided.decision === 'string' ? decided.decision : 'admitted' } : null;
  } catch (_) { return null; }
}
// Roots still protected by members of other batches that never reached ack or bloqueado.
// Anything unreadable exhausts the budget (fail closed).
function retainedRoots(owner, current, countedPaths = []) {
  const census = require('./forge-runs').boundedCensus(owner.real);
  if (census.unparseable.length) return ROOTS_LIMIT;
  const historical = new Set(), counted=new Set(countedPaths.map(value=>codeRoots().key(value)));
  try {
    for (const run of census.parsed) for (const retirement of run.batch_retirements || []) {
      require('./forge-runs').validateBatchRetirements(run.batch_retirements, run.id);
      if (retirement.locator.batch_id !== current) for (const root of retirement.retained_roots) if(!counted.has(codeRoots().key(root.path)))historical.add(codeRoots().key(root.path));
    }
  } catch { return ROOTS_LIMIT; }
  const found = directoryAt(owner.real, BATCH_SEGMENTS);
  if (found.status === 'missing') return historical.size ? ROOTS_LIMIT : 0;
  if (found.status !== 'ok') return ROOTS_LIMIT;
  let names;
  try { names = fs.readdirSync(found.dir).filter(name => BATCH_ID.test(name) && name !== current).sort(); }
  catch (_) { return ROOTS_LIMIT; }
  if (names.length > MAX_RETAINED_BATCHES) return ROOTS_LIMIT;
  let total = historical.size;
  for (const name of names) {
    try {
      const manifest = readManifestAt(owner, name);
      if (!manifest) continue;
      if (census.parsed.some(run => run.batch_retirements?.some(row => row.locator.batch_id === name))) continue;
      for (const row of progressOf(owner, manifest)) {
        if (row.state !== 'ack' && row.state !== 'bloqueado') total += manifest.members[row.index].roots.length;
      }
    } catch (_) { return ROOTS_LIMIT; }
  }
  return total;
}
function rootBudget(scope, tasks, retained) {
  const union = new Set();
  let total = retained;
  for (const task of tasks) for (const root of rootsOf(scope, task)) { total += 1; union.add(`${root.id}\u0000${root.path}`); }
  return total + union.size;
}

// Validate the complete physical namespace before treating different logical IDs
// as disjoint. Neither a second ID for one checkout nor an ID reused elsewhere
// can hide a collision from the logical write algebra.
function integrationNamespace(scope, tasks) {
  const unique = new Map();
  for (const task of tasks) for (const root of rootsOf(scope, task)) {
    const prior = unique.get(root.id);
    if (prior && codeRoots().key(realOrSelf(prior.path)) !== codeRoots().key(realOrSelf(root.path))) return 'materialization-unsupported';
    const vcs = root.vcs || require('./forge-ignore').detectVcs(root.path);
    if (vcs !== 'git') return vcs === 'svn' ? 'svn-isolation-unavailable' : 'vcs-isolation-unavailable';
    unique.set(root.id, root);
  }
  try {
    codeRoots().validateContract({ schema_version: 2, owner: scope.cwd, primary_root_id: [...unique.keys()][0], code_roots: [...unique.values()] });
    return null;
  } catch (_) { return 'materialization-unsupported'; }
}
function sortedExclusions(excluded, order) {
  const position = id => { const at = order.indexOf(id); return at < 0 ? order.length : at; };
  return [...excluded].sort((left, right) => position(left.task_id) - position(right.task_id));
}

// ── Decision ──────────────────────────────────────────────────────────────────

/**
 * The canonical decision for one execute-task selection of orchestrate.next.
 *
 * @param {{ cwd, milestone, slice, unit, request_key, host_runtime, owner_token, session?, code_root?, cohort? }} scope
 *   `cohort` is the controller's own enumeration (forge-unit-controller select with cohort)
 * @param {{ workflow?: { mode, remaining_steps }, prefsReader?, now?, routeResolver? }} options trusted, in-process
 * @returns {{ status: 'single', reason_code, excluded } | { status: 'batch', manifest } | { status: 'replay', manifest }}
 */
function decide(scope, options = {}) {
  const input = scopeOf(scope);
  const single = (reason, excluded) => deepFreeze({ status: 'single', reason_code: reason, excluded: copy(excluded || []) });
  const workflow = isObject(options.workflow) ? options.workflow : null;
  if (!workflow || workflow.mode !== 'auto') return single('mode-not-auto');
  if (input.unit.type !== 'execute-task') return single('unit-not-execute-task');
  const pv = planValidation();
  if (typeof input.slice !== 'string' || !pv.isScopeSegment(input.slice) || !pv.isScopeSegment(input.milestone)) return single('plan-generation-invalid');
  const owner = ownerOf(input.cwd), batchId = batchIdOf(input);
  // Replay: the manifest published for this exact request IS the decision.
  const published = readManifestAt(owner, batchId);
  if (published) {
    assertManifestScope(published, input, owner);
    return deepFreeze({ status: 'replay', manifest: published });
  }
  // The single path already holds the primary: its begin is never adopted by a cohort.
  const primaryRecord = recordAt(input.cwd, input.request_key);
  if (primaryRecord.record || primaryRecord.conflict || leaseHeld(input.cwd, input.unit.key)) return single('lease-scope-collision');
  const remaining = Number.isSafeInteger(workflow.remaining_steps) ? workflow.remaining_steps : 0;
  if (remaining < 2) return single('max-steps');
  // The admitted generation of the slice and its strict declarations (exact owner bytes).
  let generation, admission;
  try { generation = pv.assertSliceGeneration(input.cwd, { owner: owner.real, milestone: input.milestone, slice: input.slice }); }
  catch (_) { return single('plan-generation-invalid'); }
  if (generation.status === 'unenrolled') return single('legacy-plan-sequential');
  try {
    admission = pv.validateNewSlicePlan(pv.collectOwnerSlicePlan(input.cwd, { milestone: input.milestone, slice: input.slice }),
      { owner: owner.real, milestone: input.milestone, slice: input.slice });
  } catch (_) { return single('plan-generation-invalid'); }
  if (generation.status !== 'current' || admission.graph_status !== 'valid' || admission.semantic_sha256 !== generation.semantic_sha256) {
    return single('plan-generation-invalid');
  }
  // The controller's enumeration: pending tasks in canonical S-plan order, the admissible
  // ones (selectNextUnit picked the first) and the scoped completion proofs.
  const cohort = input.cohort;
  if (!isObject(cohort) || cohort.slice !== input.slice || cohort.status !== 'valid' || !Array.isArray(cohort.pending)
      || !Array.isArray(cohort.admissible) || !Array.isArray(cohort.proven) || cohort.admissible[0] !== input.unit.id) {
    return single('plan-generation-invalid');
  }
  const order = [...admission.task_ids];
  const tasks = new Map(order.map((id, index) => [id, { id, unit: `execute-task/${id}`, declaration: admission.declarations[index],
    plan: admission.source.task_plans[index], plan_path: admission.source.task_plans[index].path }]));
  const proven = new Set(cohort.proven), admissible = new Set(cohort.admissible), excluded = [];
  const exclude = (id, reason) => excluded.push({ task_id: id, reason_code: reason });
  const primary = tasks.get(input.unit.id);
  if (!primary) return single('plan-generation-invalid');
  if (!primary.declaration.depends.every(id => proven.has(id))) return single('dependency-unmet');
  const others = cohort.pending.filter(id => id !== input.unit.id);
  if (!others.length) return single('single-candidate');
  const candidates = [primary, ...others.map(id => tasks.get(id)).filter(Boolean)];
  if (rootBudget(input, candidates.slice(0, 2), 0) > ROOTS_LIMIT) return single('roots-limit');
  const namespaceReason = integrationNamespace(input, candidates);
  if (namespaceReason) return single(namespaceReason);
  // Cheap eligibility, canonical order: declared, depends proven, writes disjoint from every
  // accepted member (conservative intersection), no lease or begin in the member's scope.
  const members = [primary];
  for (const id of others) {
    const task = tasks.get(id);
    if (!task) { exclude(id, 'plan-generation-invalid'); continue; }
    if (!admissible.has(id) || !task.declaration.depends.every(dependency => proven.has(dependency))) { exclude(id, 'dependency-unmet'); continue; }
    if (members.some(member => parallelism().writesConflict(member.declaration.writes, task.declaration.writes))) { exclude(id, 'writes-overlap'); continue; }
    const existing = recordAt(input.cwd, memberBeginKey(batchId, task.unit));
    if (existing.record || existing.conflict || leaseHeld(input.cwd, task.unit)) { exclude(id, 'lease-scope-collision'); continue; }
    members.push(task);
  }
  const finish = reason => single(reason, sortedExclusions(excluded, order));
  if (members.length < 2) return finish(excluded[0].reason_code);
  // Limits reduce the cohort from its tail; no limit is ever enlarged. One step per member.
  const cut = (limit, reason) => { for (const task of members.splice(Math.max(limit, 1))) exclude(task.id, reason); };
  cut(remaining, 'max-steps');
  if (members.length < 2) return finish('max-steps');
  const maxConcurrent = maxConcurrentOf(input, options);
  cut(Math.min(maxConcurrent, MAX_MEMBERS), 'max-concurrent');
  if (members.length < 2) return finish('max-concurrent');
  const retained = retainedRoots(owner, batchId);
  while (members.length > 1 && rootBudget(input, members, retained) > ROOTS_LIMIT) exclude(members.pop().id, 'roots-limit');
  if (members.length < 2) return finish('roots-limit');
  // A pending functional question of the milestone never becomes a cohort (nor an approval).
  if (pendingQuestion(input.cwd, input.milestone)) return finish('pending-question');
  if (isolationRefused(input.cwd)) return finish('isolation-policy');
  // Physical and policy eligibility of each surviving member, primary first.
  const resolved = [], phase = excluded.length;
  for (const [position, task] of members.entries()) {
    const key = memberBeginKey(batchId, task.unit);
    const routed = routeOf(input, task, options);
    let reason = routed.reason || null, measured = null, time = null;
    if (!reason) { measured = measureRoots(rootsOf(input, task)); reason = measured.reason || null; }
    if (!reason) {
      time = timeVerdict(input, { type: 'execute-task', id: task.id, key: task.unit }, key, options);
      if (!time) reason = 'time-admission';
    }
    if (reason) {
      if (position === 0) return finish(reason === 'route-not-sidecar' && routed.native ? 'primary-native' : reason);
      exclude(task.id, reason);
      continue;
    }
    resolved.push({ task, key, route: routed.route, roots: measured.roots, time });
  }
  if (resolved.length < 2) return finish(excluded[phase].reason_code);
  const manifest = sealManifest({
    schema: SCHEMA, kind: KIND, batch_id: batchId, owner: owner.key, milestone: input.milestone, slice: input.slice,
    request_key: input.request_key, host_runtime: input.host_runtime, owner_digest: ownerDigest(input.owner_token),
    primary: { task_id: primary.id, unit: primary.unit },
    generation: { status: 'current', generation_key: text(generation.generation_key), validation_key: text(generation.validation_key),
      semantic_sha256: generation.semantic_sha256, graph_sha256: text(admission.graph_sha256) },
    slice_plan: { path: admission.source.slice_plan.path, sha256: admission.source.slice_plan.sha256 },
    limits: { max_concurrent: maxConcurrent, max_concurrent_source: 'forge-resources.maxConcurrentClamp', remaining_steps: remaining,
      roots_limit: ROOTS_LIMIT, roots_used: rootBudget(input, resolved.map(row => row.task), retained), retained_roots: retained },
    members: resolved.map((row, index) => ({ index, task_id: row.task.id, unit: row.task.unit, begin_key: row.key,
      plan: { path: row.task.plan.path, sha256: row.task.plan.sha256 }, declaration_sha256: row.task.declaration.declaration_sha256,
      depends: [...row.task.declaration.depends], writes: copy(row.task.declaration.writes), roots: row.roots, route: row.route,
      time_admission: row.time, step_charge: 1 })),
    excluded: sortedExclusions(excluded, order),
    decided_at: new Date(nowOf(options)).toISOString(),
  });
  return deepFreeze({ status: 'batch', manifest: verifyManifest(copy(manifest), batchId) });
}

// ── Durable dispatch ──────────────────────────────────────────────────────────

// A member that has not begun is admitted again against the live owner state before its
// begin: the same generation, declaration and plan bytes, no lease in its scope, the same
// route (re-resolved only to compare; the stored route is never replaced) and time admission.
function staleReason(scope, manifest, member, options, current) {
  const admission = current();
  if (!admission) return 'plan-generation-invalid';
  const index = admission.task_ids.indexOf(member.task_id);
  if (index < 0 || admission.declarations[index].declaration_sha256 !== member.declaration_sha256
      || admission.source.task_plans[index].sha256 !== member.plan.sha256) return 'plan-generation-invalid';
  if (leaseHeld(scope.cwd, member.unit)) return 'lease-scope-collision';
  const routed = routeOf(scope, { id: member.task_id, plan_path: member.plan.path }, options);
  if (!routed.route || routed.route.route_sha256 !== member.route.route_sha256) return 'route-stale';
  if (!timeVerdict(scope, { type: 'execute-task', id: member.task_id, key: member.unit }, member.begin_key, options)) return 'time-admission';
  return null;
}
// The closed reason of a member begin the controller refused.
function beginRefusalReason(error) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  if (['lease-active', 'lease-required', 'lease-owner-mismatch', 'transaction-pending', 'record-conflict'].includes(code)) return 'lease-scope-collision';
  if (/^plan-/.test(code)) return 'plan-generation-invalid';
  if (code === 'failure-deferred' || code === 'dependencies-blocked') return 'dependency-unmet';
  if (/^(?:time|milestone)-/.test(code)) return 'time-admission';
  return 'member-begin-refused';
}
// The admitted generation of the manifest's slice, read again from the exact owner bytes;
// null when it is not the generation the manifest was decided on.
function currentAdmission(cwd, owner, manifest) {
  try {
    const pv = planValidation(), slice = { milestone: manifest.milestone, slice: manifest.slice };
    pv.assertSliceGeneration(cwd, { owner: owner.real, ...slice });
    const admitted = pv.validateNewSlicePlan(pv.collectOwnerSlicePlan(cwd, slice), { owner: owner.real, ...slice });
    return admitted.semantic_sha256 === manifest.generation.semantic_sha256 ? admitted : null;
  } catch (_) { return null; }
}
function admitMembers(scope, owner, manifest, replay, options) {
  const ctl = controller(), progress = progressOf(owner, manifest);
  let generation;
  const current = () => {
    if (generation === undefined) generation = currentAdmission(scope.cwd, owner, manifest);
    return generation;
  };
  const planned = [], blocked = [];
  const block = (member, state, reason) => {
    appendAt(owner, manifest, member.index, state, 'bloqueado', reason, options);
    blocked.push({ task_id: member.task_id, reason_code: reason });
  };
  let primaryReason = null;
  for (const member of manifest.members) {
    const state = progress[member.index].state;
    const found = recordAt(scope.cwd, member.begin_key);
    if (found.conflict) refuse('batch-member-begin-foreign', `${member.task_id} has an unreadable or divergent begin record`);
    const record = found.record;
    if (record) {
      if (record.action !== 'begin' || !sameBinding(record.batch, memberBinding(manifest, member)) || record.unit.key !== member.unit
          || record.milestone !== manifest.milestone || record.owner_digest !== manifest.owner_digest || record.host_runtime !== manifest.host_runtime) {
        refuse('batch-member-begin-foreign', `${member.task_id} has a begin outside this manifest`);
      }
      // A begun member is history: it replays its own begin (never a second one) unless it ended.
      if (!TERMINAL_STATES.includes(state)) planned.push({ member, state, begun: true });
      else if (member.index === 0) primaryReason = progress[0].reason_code || 'member-begin-refused';
      continue;
    }
    if (state !== null && state !== 'preparado') {
      if (!TERMINAL_STATES.includes(state)) refuse('batch-progress-invalid', `${member.task_id} is ${state} without its begin`);
      if (member.index === 0) primaryReason = progress[0].reason_code || 'member-begin-refused';
      continue;
    }
    // Without its primary no sibling begins; a replayed member is admitted again first.
    const reason = member.index > 0 && primaryReason ? primaryReason : replay ? staleReason(scope, manifest, member, options, current) : null;
    if (reason) {
      if (member.index === 0) primaryReason = reason;
      block(member, state, reason);
      continue;
    }
    if (state === null) appendAt(owner, manifest, member.index, null, 'preparado', null, options);
    planned.push({ member, state: 'preparado', begun: false });
  }
  const excluded = [...manifest.excluded];
  // Nothing of this manifest can run: the current single path decides the primary again.
  const fallback = () => deepFreeze({ status: 'single', reason_code: primaryReason || (blocked.length ? blocked[0].reason_code : 'member-begin-refused'),
    excluded: copy([...excluded, ...blocked]), batch_id: manifest.batch_id });
  if (!planned.length) return fallback();
  // Before any member began, a cohort needs two admissible members: one survivor is blocked
  // too and the primary keeps the current single path.
  if (!planned.some(row => row.begun) && planned.length < 2) {
    for (const row of planned) block(row.member, row.state, blocked.length ? blocked[0].reason_code : 'single-candidate');
    return fallback();
  }
  const requests = planned.map(({ member }) => ({ milestone: manifest.milestone, unit: member.unit, slice: manifest.slice,
    state_patch: { active_slice: manifest.slice, active_task: manifest.primary.task_id }, host_runtime: manifest.host_runtime,
    owner_token: scope.owner_token, ...(typeof scope.session === 'string' && scope.session ? { session: scope.session } : {}),
    idempotency_key: member.begin_key, batch: memberBinding(manifest, member) }));
  // One controller call: every member begin under the same transaction mutex, manifest order.
  const outcome = ctl.begin(scope.cwd, { members: requests }, options);
  const results = outcome && Array.isArray(outcome.members) ? outcome.members : [];
  const firstError = results.length && !results[0].ok ? results[0].error : null;
  const admitted = [];
  planned.forEach((row, position) => {
    const result = results[position];
    if (result && result.ok) {
      if (row.state === null) appendAt(owner, manifest, row.member.index, null, 'preparado', null, options);
      if (row.state === null || row.state === 'preparado') appendAt(owner, manifest, row.member.index, 'preparado', 'admitido', null, options);
      admitted.push(row.member);
      return;
    }
    const reason = beginRefusalReason(result ? result.error : firstError);
    if (row.member.index === 0) primaryReason = reason;
    // A begun member keeps its history and its own progress; only an unbegun one is blocked.
    if (!row.begun) block(row.member, 'preparado', reason);
  });
  if (!admitted.length) return fallback();
  return deepFreeze({ status: 'batch', replay, manifest, members: admitted, excluded: copy([...excluded, ...blocked]) });
}

/**
 * The durable decision: publish (or replay) the manifest, begin its members, record their
 * progress. Returns { status: 'single', reason_code, excluded } when the current single path
 * keeps the primary, or { status: 'batch', manifest, members, excluded, replay } with the
 * members whose committed begins hold distinct live leases. A failpoint propagates.
 */
function dispatch(scope, options = {}) {
  const input = scopeOf(scope);
  const decided = decide(input, options);
  if (decided.status === 'single') return decided;
  const owner = ownerOf(input.cwd);
  let manifest = decided.manifest, replay = decided.status === 'replay';
  if (!replay && !publishExclusive(owner, [...BATCH_SEGMENTS, manifest.batch_id], 'manifest.json', manifest, MAX_MANIFEST_BYTES,
    'batch-manifest-invalid')) {
    // A concurrent decision of the same request published first: its manifest is the decision.
    manifest = readManifestAt(owner, manifest.batch_id);
    if (!manifest) refuse('batch-manifest-invalid', 'the published manifest is not readable');
    assertManifestScope(manifest, input, owner);
    replay = true;
  }
  return admitMembers(input, owner, manifest, replay, options);
}

// ── Isolation (issue 343 U2a, B2 part 1) ──────────────────────────────────────

// Opaque in-process capabilities of this module and of nothing else. A handle holds no own
// data: a spread copy, a clone, a JSON round trip, a derived object or another module's
// object is not in HANDLES, and serializing a real one throws. Every use revalidates the
// published manifest and, for a member, its committed begin, live lease and admitido state.
const HANDLES = new WeakMap();
// Issue 343 U3b: the runtime views memberPlanView minted through a live member handle. The
// physical consumers (forge-verify, forge-delivery, forge-claude-permissions) accept only these
// objects: a copy, a clone or a JSON view of one is never a validated view.
const VIEWS = new WeakSet();
const HANDLE_PROTOTYPE = Object.freeze(Object.create(null, {
  toJSON: { value() { return refuse('batch-isolation-handle-invalid', 'a batch isolation handle is never serialized'); } },
}));
function mintHandle(kind, data, revalidate) {
  const handle = Object.freeze(Object.create(HANDLE_PROTOTYPE));
  HANDLES.set(handle, { kind, data: deepFreeze(copy(data)), revalidate });
  return handle;
}
/** The bound data of a live handle of this module (forge-isolation's only authority source). */
function resolveIsolationHandle(handle, kind) {
  const entry = handle !== null && typeof handle === 'object' ? HANDLES.get(handle) : undefined;
  if (!entry || entry.kind !== kind) refuse('batch-isolation-handle-invalid', `not a live ${kind} handle of forge-execution-batch`);
  entry.revalidate();
  return entry.data;
}
// The member's committed begin of THIS manifest and the live lease it holds (its generation
// is returned); `code` names the refusal: a foreign begin while preparing, a stale handle later.
// Issue 343 U5: after the sealed barrier (a handle the serial consolidation restored) no writer
// exists any more; the lease file still holding exactly this begin's generation is the reservation,
// even past its TTL (a recovery by anyone else changes the generation and refuses here).
function memberLease(cwd, manifest, member, code, allowExpired = false) {
  const found = recordAt(cwd, member.begin_key), record = found.record;
  if (found.conflict || !record || record.action !== 'begin' || record.phase !== 'committed'
      || !sameBinding(record.batch, memberBinding(manifest, member)) || !isObject(record.unit) || record.unit.key !== member.unit
      || record.milestone !== manifest.milestone || record.owner_digest !== manifest.owner_digest
      || record.host_runtime !== manifest.host_runtime || typeof record.lease_generation !== 'string' || !record.lease_generation) {
    refuse(code, `${member.task_id} has no committed begin of this manifest`);
  }
  let seen = null;
  try { seen = leases().observe(cwd, member.unit); } catch (_) { seen = null; }
  if (!seen || !seen.ok || !seen.lease || (seen.lease.expired && allowExpired !== true) || seen.lease.generation !== record.lease_generation) {
    refuse(code, `${member.task_id} no longer holds the lease of its begin`);
  }
  return record.lease_generation;
}
function realOrSelf(value) { try { return fs.realpathSync.native(value); } catch (_) { return value; } }

/**
 * Issue 343 U2a: the isolation of an admitted cohort, before any child process. Serially, in
 * manifest order: forge-isolation captureBatchBase measures the dirty base of every
 * integration root and publishes it once, then setupForBatchMember gives each admitido member
 * its own worktree and index per root. Nothing here spawns a worker, writes a claim, edits
 * STATE, advances member progress or rewrites a preference.
 *
 * @param {{ cwd, milestone, host_runtime, owner_token, batch_id, manifest_sha256, run_id?, code_root? }} scope
 *   `run_id` names the run whose worktree anchor hosts the batch area (default: the
 *   milestone); `code_root` is the legacy single root the decision measured (default: owner)
 * @param {{ failpoint?, isolationLimits? }} options trusted, in-process: named failpoints,
 *   limits that can only be tightened
 * @returns {{ status: 'prepared', base, members, skipped } | { status: 'serial', reason_code, detail?, root_id? }}
 *   a refusal throws (REFUSAL_CODES of this module, BATCH_ISOLATION_REFUSALS of forge-isolation)
 */
// Exact product paths of the plans this decision admitted, never a glob expansion or an
// inventory inferred from the dirty checkout. Members already pin their WHOLE plan in the
// manifest. A transitive predecessor additionally needs the controller's genuine scoped
// completion plus historical delivery proof of its current plan; semantic graph equality
// alone does not authorize edits to artifacts/key_links. No schema or approval is invented.
function retiredPredecessorNamespace(owner, manifest, id, source, contract, runtime, runId, read) {
  const run=runId&&require('./forge-runs').get(owner.real,runId);
  if(!run?.active||!run.batch_retirements?.length)return null;
  require('./forge-runs').validateBatchRetirements(run.batch_retirements,run.id);
  const matches=[];
  for(const row of run.batch_retirements){
    const previous=readManifestAt(owner,row.locator.batch_id);
    if(!previous||previous.milestone!==manifest.milestone||previous.slice!==manifest.slice||previous.host_runtime!==manifest.host_runtime||previous.owner_digest!==manifest.owner_digest)continue;
    const member=previous.members.find(item=>item.task_id===id&&item.plan.path===source.path&&item.plan.sha256===source.sha256);
    if(!member)continue;
    const physical=readIsolation(owner,previous),placed=physical?.members.find(item=>item.member_index===member.index);
    if(!physical||physical.run_id!==runId||!placed||digestOf(physical.integration_contract)!==digestOf(contract))continue;
    if(runtime.code_roots.length!==placed.roots.length||runtime.code_roots.some(root=>!placed.roots.some(item=>item.root_id===root.id&&item.identity_sha256===root.identity_sha256
        &&contract.code_roots.some(target=>target.id===root.id&&target.identity_sha256===item.integration_identity_sha256))))continue;
    const directory=path.join(physical.base.batch_dir,BROKER_DIRECTORY),closed=reconciliation().readBatchClosedHistory({directory,manifest_sha256:row.broker_manifest_sha256});
    if(!closed||closed.evidence.run_id!==runId||closed.evidence.batch_manifest_sha256!==previous.manifest_sha256||digestOf(closed.retirement.producer.row)!==digestOf(row))continue;
    const report=closed.retirement.producer.witness.report.members.find(item=>item.index===member.index);
    if(report?.outcome!=='acknowledged'||report.recheck!=='verified'||!HASH.test(report.ready_sha256||''))continue;
    const witnessed=read(row.witness_ref);
    if(digestOf(witnessed)!==digestOf(closed.retirement.producer.witness))return null;
    const old=reconciliation().readBatchRetainedResult({directory,manifest_sha256:row.broker_manifest_sha256,member_index:member.index});
    if(old.outcome.outcome!=='retained'||old.member.begin_key!==member.begin_key||old.member.runtime_contract_sha256!==codeRoots().digest(runtime))return null;
    const stateFile=old.executed.recovery_baseline?.state_file;
    if(typeof stateFile!=='string'||!path.isAbsolute(stateFile)||!stateFile.endsWith('.reset-state.json'))return null;
    const file=stateFile.slice(0,-'.reset-state.json'.length)+'.receipt.json';
    for(const root of [owner.real,...runtime.code_roots.map(item=>item.path),...contract.code_roots.map(item=>item.path)])require('./forge-xllm').validateResultFileTarget(file,root);
    const raw=retainedRead(file,'batch-retained-invalid');if(!raw||sha256(raw)!==report.ready_sha256)return null;
    const ready=JSON.parse(raw);
    if(ready.phase!=='ready'||ready.delivery_capture?.passed!==true||ready.fingerprint!==old.executed.fingerprint||ready.dispatch_id!==old.member.dispatch_id)return null;
    matches.push({ready});
  }
  if(matches.length!==1)return null;
  return relative=>{
    const artifacts=matches[0].ready.artifacts.filter(item=>item.path===relative);
    const raw=retainedRead(path.join(owner.real,...relative.split('/')),'batch-retained-invalid');
    return artifacts.length===1&&typeof artifacts[0].content==='string'&&raw&&sha256(raw)===sha256(Buffer.from(artifacts[0].content));
  };
}
function predecessorNamespace(owner, manifest, id, source, contract, runId) {
  const records = [], read = relative => {
    if (typeof relative !== 'string' || /[:\\\0]/.test(relative) || relative.startsWith('/')
        || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('foreign proof reference');
    const parts = relative.split('/');
    const value = readRecord(owner, parts.slice(0, -1), parts.at(-1), MAX_MANIFEST_BYTES, 'batch-isolation-handle-stale');
    if (!value) throw new Error('missing proof source');
    records.push({ path: relative, sha256: digestOf(value) });
    return value;
  };
  try {
    const base = `.gsd/milestones/${manifest.milestone}/slices/${manifest.slice}/tasks/${id}`;
    const input = read(`${base}/${id}-DELIVERY-INPUT.json`);
    if (input.plan !== source.path || input.plan_fingerprint !== source.sha256 || !Array.isArray(input.bindings) || !input.bindings.length) return null;
    let namespace=contract,assertArtifact=null;
    if (input.schema_version === 2) {
      const measured = codeRoots().validateContract(input.execution_contract, { owner: owner.real, revalidate: true });
      if (digestOf(measured) !== digestOf(contract)) {
        assertArtifact=retiredPredecessorNamespace(owner,manifest,id,source,contract,measured,runId,read);
        if(!assertArtifact||!assertArtifact(`${base}/${id}-DELIVERY-INPUT.json`))return null;
        namespace=measured;
      }
    } else if (input.schema_version !== 1 || contract.code_roots.length !== 1) return null;
    for (const relative of new Set(input.bindings.map(binding => binding.source?.path))) {
      const envelope = read(relative), root = namespace.code_roots.find(row => row.id === (input.schema_version === 2 ? envelope.root_id : namespace.primary_root_id));
      if(assertArtifact&&!assertArtifact(relative))return null;
      if (!root || envelope.plan_fingerprint !== source.sha256 || typeof envelope.code_dir !== 'string'
          || codeRoots().key(fs.realpathSync.native(envelope.code_dir)) !== codeRoots().key(root.path)) return null;
      if (input.schema_version === 2 && (envelope.root_identity_sha256 !== root.identity_sha256
          || envelope.execution_contract_sha256 !== codeRoots().digest(namespace))) return null;
    }
    return records;
  } catch (_) { return null; }
}
function baseInputProvenance(scope, owner, manifest, admission, contract) {
  const declarations = new Map(admission.task_ids.map((id, index) => [id, admission.declarations[index]]));
  const selected = new Map(manifest.members.map(member => [member.task_id, member]));
  const relevant = new Set();
  const visit = id => {
    if (relevant.has(id)) return;
    relevant.add(id);
    for (const dependency of declarations.get(id)?.depends || []) visit(dependency);
  };
  manifest.members.forEach(member => visit(member.task_id));
  const predecessors = [...relevant].filter(id => !selected.has(id));
  const plans = [], entries = [];
  for (const id of admission.task_ids.filter(task => relevant.has(task))) {
    const member = selected.get(id), index = admission.task_ids.indexOf(id), declaration = declarations.get(id);
    const read = planValidation().readOwnerTaskPlan(scope.cwd, { milestone: manifest.milestone, slice: manifest.slice, task: id });
    const source = admission.source.task_plans[index];
    if (read.status !== 'ok') return null;
    const sha = read.sha256;
    if (sha !== source.sha256 || (member && sha !== member.plan.sha256)) return null;
    const roots = rootsOf(scope, { declaration });
    const planContract = codeRoots().validateContract({ schema_version: 2, owner: owner.real,
      primary_root_id: declaration.primary_root_id || roots[0].id, code_roots: roots });
    // This admits the full structured plan against its real roots; declarations alone do
    // not validate the paths in artifacts/key_links. It reads no product file content.
    const validated = codeRoots().validatePlan(read.content, planContract);
    const authority = member ? 'manifest-member-plan' : 'controller-proven-predecessor';
    // Metadata is only a namespace check, never its own proof. The real controller proof
    // below must then validate these same bytes, followed by a stable reread of every pin.
    const proofSources = member ? null : predecessorNamespace(owner, manifest, id, source, planContract, scope.run_id);
    if (!member && !proofSources) continue;
    plans.push({ task_id: id, path: source.path, sha256: sha, authority, ...(member ? {} : { proof_sources: proofSources }) });
    const refs = [
      ...validated.writes.map((value, n) => [`writes[${n}]`, value]),
      ...validated.artifacts.map((value, n) => [`artifacts[${n}].path`, value]),
      ...validated.must_haves.key_links.flatMap((value, n) => [[`key_links[${n}].from`, value.from], [`key_links[${n}].to`, value.to]]),
    ];
    for (const [field, value] of refs) {
      const ref = codeRoots().resolvePath(planContract, value, { legacy: planContract.code_roots.length === 1 });
      if (/[*?]/.test(ref.path)) continue; // A write glob never authorizes incidental input bytes.
      const measured = contract.code_roots.find(root => root.id === ref.root_id);
      if (!measured || measured.identity_sha256 !== ref.identity_sha256) continue;
      entries.push({ root_id: ref.root_id, root_identity_sha256: measured.identity_sha256, path: ref.path,
        task_id: id, plan_path: source.path, plan_sha256: sha, field, authority,
        generation_key: manifest.generation.generation_key, validation_key: manifest.generation.validation_key });
    }
  }
  let proven = new Set();
  if (predecessors.length) {
    // Read-only public selection: this independently proves scoped begin/completion/events,
    // exact plan fingerprint and historical captures. Metadata/JSON alone grant nothing.
    const current = controller().select(scope.cwd, { milestone: manifest.milestone, cohort: true }, {});
    if (current.cohort?.slice === manifest.slice && current.cohort.status === 'valid') proven = new Set(current.cohort.proven);
  }
  const allowed = new Set();
  for (const plan of plans) {
    const read = planValidation().readOwnerTaskPlan(scope.cwd, { milestone: manifest.milestone, slice: manifest.slice, task: plan.task_id });
    if (read.status !== 'ok' || read.sha256 !== plan.sha256) return null;
    if (selected.has(plan.task_id)) { allowed.add(plan.task_id); continue; }
    if (!proven.has(plan.task_id)) continue;
    const declaration = declarations.get(plan.task_id), roots = rootsOf(scope, { declaration });
    const planContract = codeRoots().validateContract({ schema_version: 2, owner: owner.real,
      primary_root_id: declaration.primary_root_id || roots[0].id, code_roots: roots });
    if (digestOf(predecessorNamespace(owner, manifest, plan.task_id, plan, planContract, scope.run_id)) === digestOf(plan.proof_sources)) allowed.add(plan.task_id);
  }
  return { generation: copy(manifest.generation), plans: plans.filter(plan => allowed.has(plan.task_id)), entries: entries.filter(entry => allowed.has(entry.task_id)) };
}

function prepareIsolation(scope, options = {}) {
  return autoGateContext(options, () => prepareIsolationWithGate(scope, options));
}
function prepareIsolationWithGate(scope, options) {
  // Lock order is shared with controller admission and run ownership transfer.
  return controller().withOwnerBoundary(scope.cwd, () => require('./forge-runs').withRegistryFence(scope.cwd,
    guard => prepareIsolationInside(scope, options, guard)), options);
}

// The host adapter is opaque, process-local and never written into a manifest,
// request or receipt. A callback is re-attested for every origin/runtime use.
const AUTO_GATE_CONTEXT = new (require('async_hooks').AsyncLocalStorage)();
function autoGateContext(options, action) {
  if (!options || options.autoPlanGateAdapter === undefined) return action();
  return AUTO_GATE_CONTEXT.run({ adapter: options.autoPlanGateAdapter, members: options.members }, action);
}
function originMemberContract(owner, manifest, member, contract) {
  const plan = planValidation().readOwnerTaskPlan(owner.real, { milestone: manifest.milestone, slice: manifest.slice, task: member.task_id });
  if (plan.status !== 'ok' || plan.sha256 !== member.plan.sha256) refuse('batch-member-plan-invalid', 'the canonical plan changed');
  const roots = codeRoots(), origin = roots.validateContract({ ...contract,
    primary_root_id: require('./forge-must-haves').parseExecutionFields(plan.content).primary_root_id || member.roots[0].root_id,
    code_roots: member.roots.map(ref => contract.code_roots.find(root => root.id === ref.root_id)) }, { owner: owner.real, revalidate: true });
  if (origin.code_roots.some(root => !member.roots.some(ref => ref.root_id === root.id && ref.identity_sha256 === root.identity_sha256))) {
    refuse('batch-root-foreign', 'auto gate origin differs from the manifest');
  }
  return origin;
}
function memberGate(owner, manifest, member, contract) {
  const execution = require('./forge-task-execution'), plan = execution.milestonePlanFile({ contextRoot: owner.real, milestoneId: manifest.milestone,
    sliceId: manifest.slice, taskId: member.task_id, planFile: path.join(owner.real, member.plan.path) });
  const live = AUTO_GATE_CONTEXT.getStore(), input = live?.members?.[member.task_id];
  if (input?.gates?.plan === 'skipped' && input.gates.planSkipReason === 'auto-defer') {
    const origin = originMemberContract(owner, manifest, member, contract), primary = origin.code_roots.find(root => root.id === origin.primary_root_id);
    const request = { scope: 'milestone', phase: 'execute', unitType: 'execute-task', contextRoot: owner.real, cwd: primary.path,
      milestoneId: manifest.milestone, sliceId: manifest.slice, taskId: member.task_id, planFile: plan, execution_contract: origin,
      workflowId: input.workflowId, dispatchId: input.dispatchId, route: { host_runtime: manifest.host_runtime }, gates: input.gates };
    return execution.withAutoPlanGateAdapterSync(live.adapter, request, () => {
      if (!execution.autoGateAllowed(request)) refuse('batch-member-plan-invalid', 'the live auto gate is not attested');
      const descriptor = { kind: 'auto-defer', owner: owner.key, milestone: manifest.milestone, slice: manifest.slice, task: member.task_id,
        plan_sha256: member.plan.sha256, origin_contract_sha256: codeRoots().digest(origin), workflow_id: input.workflowId,
        dispatch_id: input.dispatchId, host: manifest.host_runtime, reference: input.gates.authorizationReference };
      return { bytes: null, sha256: digestOf(descriptor) };
    });
  }
  const file = plan.replace(/-PLAN\.md$/, '-PLAN-GATE.md');
  let read;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('gate link');
    read = boundedReader().readBoundedStableFile(file, MAX_MANIFEST_BYTES, { expectedReal: file });
  } catch (_) { refuse('batch-member-plan-invalid', 'the canonical gate is unreadable'); }
  if (read.error || !/^status:\s*approved\s*$/m.test(read.buffer.toString('utf8'))
      || read.buffer.toString('utf8').match(/^plan_sha256:\s*([a-f0-9]{64})\s*$/m)?.[1] !== member.plan.sha256) {
    refuse('batch-member-plan-invalid', 'the canonical gate must approve the exact plan');
  }
  return { bytes: read.buffer, sha256: sha256(read.buffer) };
}
function withMemberAutoGate(request, action) {
  if (request.gates?.plan !== 'skipped' || request.gates.planSkipReason !== 'auto-defer') return action();
  return require('./forge-task-execution').withAutoPlanGateAdapter(AUTO_GATE_CONTEXT.getStore()?.adapter, request, action);
}

function boundRun(scope, owner, manifest) {
  const runs = require('./forge-runs'), roots = codeRoots();
  const census = runs.boundedCensus(owner.real);
  if (census.unparseable.length || new Set(census.parsed.map(row => row.id)).size !== census.parsed.length) refuse('batch-parent-run-invalid', 'the complete run registry is not readable or unique');
  const run = census.parsed.find(row => row.id === scope.run_id);
  if (!run || !require('./forge-ids').isValid(run.id) || run.active !== true || run.kind !== 'milestone'
      || run.host_runtime !== manifest.host_runtime || typeof run.session_id !== 'string' || !run.session_id
      || roots.key(realOrSelf(run.cwd || '')) !== owner.key || run.project && roots.key(realOrSelf(run.project)) !== owner.key
      || run.milestone_dir !== `.gsd/milestones/${manifest.milestone}/`) {
    refuse('batch-parent-run-invalid', 'a real active run of this owner, milestone and host is required');
  }
  // The RunRecord's optional owner metadata is not the controller's opaque
  // owner token. Bind the real registry session to the actual admitted leases.
  for (const member of manifest.members) {
    const observed = leases().observe(owner.real, member.unit);
    if (!observed.ok || observed.lease && (observed.lease.session !== run.session_id || observed.lease.host_runtime !== run.host_runtime)) {
      refuse('batch-parent-run-invalid', 'the run session/host does not own the actual member leases');
    }
  }
  return run;
}

function parentRun(scope, owner, manifest, contract) {
  const wc = require('./forge-write-claim'), roots = codeRoots(), run = boundRun(scope, owner, manifest);
  const claim = run.write_claim;
  if (!claim || claim.schema_version !== 2 || !wc.isHeld(claim)) refuse('batch-parent-claim-required', 'the parent has no live v2 reservation');
  try { wc.validateHeldClaim(claim); } catch (_) { refuse('batch-parent-claim-required', 'the parent reservation is invalid'); }
  if (roots.key(claim.execution_contract.owner) !== owner.key) refuse('batch-parent-run-invalid', 'foreign claim owner');
  const groups = roots.claimGroups(claim);
  for (const member of manifest.members) {
    const plan = planValidation().readOwnerTaskPlan(owner.real, { milestone: manifest.milestone, slice: manifest.slice, task: member.task_id });
    if (plan.status !== 'ok' || plan.sha256 !== member.plan.sha256) refuse('batch-isolation-handle-stale', 'canonical plan changed');
    const memberContract = roots.validateContract({ ...contract,
      primary_root_id: require('./forge-must-haves').parseExecutionFields(plan.content).primary_root_id || member.roots[0].root_id,
      code_roots: member.roots.map(ref => contract.code_roots.find(root => root.id === ref.root_id)) });
    memberGate(owner, manifest, member, memberContract);
    const derived = require('./forge-claim-gate').deriveClaimFromPlan(owner.real, member.plan.path, memberContract);
    for (const write of derived.paths) {
      const origin = memberContract.code_roots.find(root => root.id === write.root_id);
      const group = groups.find(row => row.identity_sha256 === origin.identity_sha256);
      if (!group || !group.paths.some(p => roots.covers({ root_id: group.id, path: p }, { root_id: group.id, path: write.path }))) {
        refuse('batch-parent-claim-required', 'the integration namespace is not reserved by the parent');
      }
    }
  }
  if (run.batch_locator && (run.batch_locator.batch_id !== manifest.batch_id || run.batch_locator.manifest_sha256 !== manifest.manifest_sha256
      || run.batch_locator.claim_generation !== claim.generation || run.batch_locator.claim_sha256 !== roots.digest(claim))) {
    refuse('batch-isolation-handle-stale', 'the batch locator no longer names the held parent claim');
  }
  const gate = require('./forge-claim-gate').previewGate({ cwd: owner.real, runId: run.id, claim, enforcement: 'enforcing' });
  if (gate.decision !== 'proceed') refuse('batch-claim-gate-conflict', 'the integration or retained namespace has another writer');
  return run;
}

// Shared with the pool's two pre-S0 heartbeats: replay through runCohort must not
// mutate leases before prepareIsolation gets a chance to refuse an existing S0.
function assertPreparationBeforeS0(owner, manifest, locator, batchDir) {
  const existing = readIsolation(owner, manifest);
  if (!existing && locator?.phase === 'prepared') {
    refuse('batch-isolation-record-invalid', 'a committed locator has no physical record');
  }
  for (const dir of [existing?.base?.batch_dir, batchDir].filter(Boolean)) {
    try { fs.lstatSync(path.join(dir, BROKER_DIRECTORY)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    refuse('batch-cohort-broker-exists', 'S0 already exists; preparation cannot renew its members');
  }
}

function prepareIsolationInside(scope, options, guard) {
  if (!isObject(scope) || typeof scope.batch_id !== 'string' || !BATCH_ID.test(scope.batch_id)
      || typeof scope.manifest_sha256 !== 'string' || !HASH.test(scope.manifest_sha256)) refuse('batch-not-active', 'no batch is named');
  for (const key of ['cwd', 'milestone', 'host_runtime', 'owner_token']) {
    if (typeof scope[key] !== 'string' || !scope[key] || scope[key].includes('\u0000')) refuse('batch-scope-invalid', `${key} is required`);
  }
  const runId = scope.run_id === undefined || scope.run_id === null ? null : scope.run_id;
  if (runId !== null && (typeof runId !== 'string' || !RUN_ID.test(runId))) refuse('batch-scope-invalid', 'run_id is invalid');
  const codeRoot = scope.code_root === undefined || scope.code_root === null ? null : scope.code_root;
  if (codeRoot !== null && (typeof codeRoot !== 'string' || !path.isAbsolute(codeRoot) || codeRoot.includes('\u0000'))) {
    refuse('batch-scope-invalid', 'code_root must be an absolute path');
  }
  const owner = ownerOf(scope.cwd), manifest = readManifestAt(owner, scope.batch_id);
  if (!manifest) refuse('batch-manifest-invalid', 'the named batch has no published manifest');
  if (manifest.manifest_sha256 !== scope.manifest_sha256 || manifest.owner !== owner.key || manifest.milestone !== scope.milestone
      || manifest.host_runtime !== scope.host_runtime || manifest.owner_digest !== ownerDigest(scope.owner_token)) {
    refuse('batch-manifest-foreign', 'the named manifest belongs to another owner, milestone, host or owner token');
  }
  const serial = (reason, extra) => deepFreeze({ status: 'serial', reason_code: reason, batch_id: manifest.batch_id,
    manifest_sha256: manifest.manifest_sha256, ...(extra || {}) });
  // Only admitido members: a committed begin of this manifest holding its live lease.
  const progress = progressOf(owner, manifest), live = [], skipped = [];
  for (const member of manifest.members) {
    const state = progress[member.index].state;
    if (state !== 'admitido') skipped.push({ task_id: member.task_id, state });
    else live.push({ member, generation: memberLease(scope.cwd, manifest, member, 'batch-member-begin-foreign') });
  }
  if (!live.length) refuse('batch-not-active', 'no admitido member is left to isolate');
  // The exact declarations and plan bytes the decision admitted, read again from the owner.
  const admission = currentAdmission(scope.cwd, owner, manifest);
  if (!admission) return serial('plan-generation-invalid');
  const rows = [];
  for (const { member, generation } of live) {
    const index = admission.task_ids.indexOf(member.task_id);
    if (index < 0 || admission.declarations[index].declaration_sha256 !== member.declaration_sha256
        || admission.source.task_plans[index].sha256 !== member.plan.sha256) return serial('plan-generation-invalid');
    const declaration = admission.declarations[index];
    rows.push({ member, generation, primary: declaration.primary_root_id,
      roots: rootsOf({ cwd: scope.cwd, code_root: codeRoot }, { declaration }) });
  }
  // One integration contract over every member root, measured again: the same root IDs the
  // decision measured, one physical root per ID, no alias or overlap (forge-code-roots).
  const union = new Map();
  for (const row of rows) {
    if (row.roots.length !== row.member.roots.length || row.roots.some(root => !row.member.roots.some(ref => ref.root_id === root.id))) {
      refuse('batch-root-foreign', `${row.member.task_id} declares other roots than the decision measured`);
    }
    for (const root of row.roots) {
      if (root.vcs === 'svn') return serial('svn-isolation-unavailable');
      const prior = union.get(root.id);
      if (!prior) union.set(root.id, root);
      else if (codeRoots().key(realOrSelf(prior.path)) !== codeRoots().key(realOrSelf(root.path))) refuse('batch-root-alias', `${root.id} names two physical roots`);
    }
  }
  const primaryId = union.has(rows[0].primary) ? rows[0].primary : rows[0].roots[0].id;
  let contract;
  try {
    contract = codeRoots().validateContract({ schema_version: 2, owner: owner.real, primary_root_id: primaryId,
      code_roots: [...union.values()].map(root => ({ id: root.id, path: root.path, ...(root.vcs ? { vcs: root.vcs } : {}) })) });
  } catch (error) {
    const code = error && error.code;
    refuse(code === 'roots-overlap-or-alias' || code === 'root-id-duplicate' ? 'batch-root-alias' : 'batch-root-foreign',
      `the integration roots are not measurable checkouts (${code || 'unknown'})`);
  }
  for (const root of contract.code_roots) if (root.vcs !== 'git') return serial(root.vcs === 'svn' ? 'svn-isolation-unavailable' : 'vcs-isolation-unavailable');
  for (const row of rows) {
    for (const ref of row.member.roots) {
      const measured = contract.code_roots.find(root => root.id === ref.root_id);
      if (!measured || measured.identity_sha256 !== ref.identity_sha256) refuse('batch-root-foreign', `${row.member.task_id}: ${ref.root_id} is not the root the decision measured`);
    }
  }
  // Bind the actual owner/run and every integration root BEFORE input bytes,
  // package/journal/ref publication or worktree effects. An unborn base has no
  // reservable Git baseline and stays the existing named serial case.
  for (const root of contract.code_roots) {
    if (!require('./forge-claim-release').measureBaseline(root.path, { vcs: root.vcs }).ok) {
      boundRun(scope, owner, manifest);
      return serial('materialization-unsupported', { detail: 'head-unborn', root_id: root.id });
    }
  }
  const parent = parentRun(scope, owner, manifest, contract);
  for (const row of rows) {
    if (readRecord(owner, [...BATCH_SEGMENTS, manifest.batch_id, 'attempts'], `member-${row.member.index}.json`, MAX_PROGRESS_BYTES, 'batch-member-attempt-invalid')) {
      refuse('batch-member-reconciliation-required', 'an execution attempt exists; restart must reconcile before reconstructing a handle');
    }
  }
  const parentRef = { claim: parent.write_claim };
  // The existing roots limit and isolation policy, never enlarged or rewritten.
  const extraRetained = parent.write_claim.execution_contract.code_roots.filter(root => !contract.code_roots.some(r => r.identity_sha256 === root.identity_sha256)
    && !parent.write_claim.batch_roots?.some(ref => ref.root_id === root.id));
  const used = contract.code_roots.length + extraRetained.length + rows.reduce((total, row) => total + row.member.roots.length, 0)
    + retainedRoots(owner, manifest.batch_id, extraRetained.map(root=>root.path));
  if (used > ROOTS_LIMIT) return serial('roots-limit');
  if (isolationRefused(scope.cwd)) return serial('isolation-policy');
  let baseInputs;
  try { baseInputs = baseInputProvenance({ cwd: scope.cwd, code_root: codeRoot, run_id:parent.id }, owner, manifest, admission, contract); }
  catch (_) { baseInputs = null; }
  if (!baseInputs) return serial('materialization-unsupported', { detail: 'untracked-base-unprovenance', root_id: null });
  const reservationData = { owner: owner.real, owner_key: owner.key, batch_id: manifest.batch_id, manifest_sha256: manifest.manifest_sha256,
    milestone: manifest.milestone, run_id: runId || manifest.milestone, contract, base_inputs: baseInputs,
    members: rows.map(row => ({ member_index: row.member.index, task_id: row.member.task_id, begin_key: row.member.begin_key,
      lease_generation: row.generation, roots: row.member.roots.map(ref => ({ root_id: ref.root_id, identity_sha256: ref.identity_sha256 })),
      writes: copy(row.member.writes) })) };
  const manifestLive = () => {
    const current = readManifestAt(owner, manifest.batch_id);
    if (!current || current.manifest_sha256 !== manifest.manifest_sha256) refuse('batch-isolation-handle-stale', 'the batch manifest is no longer the published one');
    const held = parentRun(scope, owner, manifest, contract);
    if (codeRoots().digest(held.write_claim) !== codeRoots().digest(parentRef.claim)) refuse('batch-isolation-handle-stale', 'the parent claim changed');
    let now;
    try {
      const admitted = currentAdmission(scope.cwd, owner, manifest);
      now = admitted && baseInputProvenance({ cwd: scope.cwd, code_root: codeRoot, run_id:parent.id }, owner, manifest, admitted, contract);
    } catch (_) { now = null; }
    if (!now || digestOf(now) !== digestOf(baseInputs)) refuse('batch-isolation-handle-stale', 'the exact admitted input provenance changed');
  };
  // Preparation can exceed one lease period while Git copies several roots. Renewal is
  // only legal before S0, under the existing owner boundary and registry fence. Never
  // renew in a member handle's read-only revalidation or after the union is committed.
  const beforeS0 = batchDir => {
    const held = parentRun(scope, owner, manifest, contract);
    assertPreparationBeforeS0(owner, manifest, held.batch_locator, batchDir);
  };
  const renewPreparation = batchDir => {
    beforeS0(batchDir);
    manifestLive();
    // Validate the WHOLE cohort before the first heartbeat: a foreign/missing last
    // member must not cause an earlier member's lease to be changed.
    const token = String(scope.owner_token).normalize('NFC').trim();
    for (const row of rows) {
      const generation = memberLease(scope.cwd, manifest, row.member, 'batch-isolation-handle-stale', true);
      const raw = leases().readLease(leases().leaseFile(owner.real, row.member.unit));
      if (generation !== row.generation || raw.corrupt || !leases().validRecord(raw.record, row.member.unit)
          || raw.record.generation !== row.generation || raw.record.owner_token !== token
          || progressOf(owner, manifest)[row.member.index].state !== 'admitido') {
        refuse('batch-isolation-handle-stale', row.member.task_id + ' no longer owns its admitted preparation lease');
      }
    }
    if (typeof options.leaseCheckpoint === 'function') options.leaseCheckpoint({ stage: 'preparation' });
    else renewLeases(owner, manifest, rows.map(row => row.member), token, parent.id);
  };
  beforeS0();
  const iso = isolation(), trusted = { failpoint: options.failpoint, limits: options.isolationLimits,
    ...(typeof options.dependencyRunner === 'function' ? { dependencyRunner: options.dependencyRunner } : {}),
    ...(typeof options.leaseCheckpoint === 'function' ? { leaseCheckpoint: options.leaseCheckpoint } : {}) };
  const captured = iso.captureBatchBase(mintHandle('reservation', reservationData, manifestLive), contract, trusted);
  if (captured.status !== 'captured') return serial(captured.reason_code, { detail: captured.detail, root_id: captured.root_id });
  renewPreparation(captured.base.batch_dir);
  // Retain an intent locator before the FIRST member/index effect. A crash
  // before the final union CAS must still block borrowing, cleanup and another
  // writer; no physical root has to be invented in a claim before it exists.
  require('./forge-runs').updateWith(owner.real, parent.id, current => {
    if (!current.active || codeRoots().digest(current.write_claim) !== codeRoots().digest(parentRef.claim)) refuse('batch-isolation-handle-stale', 'the parent reservation changed');
    if (current.batch_locator) return null;
    return { batch_locator: { schema: 'forge-batch-locator-v1', phase: 'preparing', run_id: parent.id, batch_id: manifest.batch_id,
      manifest_sha256: manifest.manifest_sha256, isolation_ref: `.gsd/forge/batches/${manifest.batch_id}/isolation.json`,
      isolation_sha256: null, claim_generation: parentRef.claim.generation, claim_sha256: codeRoots().digest(parentRef.claim) } };
  }, guard);
  const members = [], handles = [];
  for (const [position, row] of rows.entries()) {
    if (position > 0) renewPreparation(captured.base.batch_dir);
    const handle = mintHandle('member', { reservation: reservationData, ...reservationData.members[position] }, () => {
      manifestLive();
      if (memberLease(scope.cwd, manifest, row.member, 'batch-isolation-handle-stale') !== row.generation
          || progressOf(owner, manifest)[row.member.index].state !== 'admitido') {
        refuse('batch-isolation-handle-stale', `${row.member.task_id} is no longer the admitido member of this handle`);
      }
    });
    handles.push(handle);
    const prepared = iso.setupForBatchMember(handle, captured.base, trusted);
    if (prepared.status !== 'prepared') return serial(prepared.reason_code, { detail: prepared.detail, root_id: prepared.root_id, members: copy(members) });
    members.push(prepared.member);
  }
  renewPreparation(captured.base.batch_dir);
  const ready = commitIsolation(scope, owner, manifest, contract, reservationData, captured.base, members, parent, guard, options);
  parentRef.claim = ready.claim;
  handles.forEach((handle, index) => {
    HANDLES.get(handle).isolation = ready.record;
    HANDLES.get(handle).scope = { ...scope };
    HANDLES.get(handle).autoGateContext = AUTO_GATE_CONTEXT.getStore();
    if (typeof options.onMember === 'function') options.onMember(handle, copy(members[index]));
  });
  return deepFreeze({ status: 'prepared', batch_id: manifest.batch_id, manifest_sha256: manifest.manifest_sha256,
    base: copy(captured.base), members: copy(members), skipped });
}

function readIsolation(owner, manifest) {
  const record = readRecord(owner, [...BATCH_SEGMENTS, manifest.batch_id], 'isolation.json', MAX_MANIFEST_BYTES, 'batch-isolation-record-invalid');
  if (!record) return null;
  const { isolation_sha256, ...content } = record;
  if (record.schema !== 'forge-batch-isolation-v1' || digestOf(content) !== isolation_sha256
      || record.manifest_sha256 !== manifest.manifest_sha256 || record.owner !== owner.key) {
    refuse('batch-isolation-record-invalid', 'the physical isolation record is not bound to this manifest');
  }
  return record;
}

function commitIsolation(scope, owner, manifest, contract, reservation, base, members, parent, guard, options) {
  const roots = codeRoots(), claims = require('./forge-write-claim');
  const indexes = new Set(contract.code_roots.map(root => {
    const index = isolation().batchIndexIdentity(root.path);
    if (!index) refuse('batch-root-foreign', 'the integration index cannot be identified');
    return roots.key(index.path);
  }));
  const memberRows = members.map(member => {
    const planned = manifest.members[member.member_index];
    return { ...member, gate_sha256: memberGate(owner, manifest, planned, contract).sha256, roots: member.roots.map(({ replay, ...root }) => {
      const index = isolation().batchIndexIdentity(root.path);
      if (!index || index.links !== 1 || indexes.has(roots.key(index.path))) refuse('batch-root-foreign', 'a member index is not exclusive');
      indexes.add(roots.key(index.path));
      return { ...root, index_path: index.path };
    }) };
  });
  let record = readIsolation(owner, manifest);
  if (record) {
    if (record.run_id !== parent.id || digestOf(record.integration_contract) !== digestOf(contract)
        || digestOf(record.members) !== digestOf(memberRows) || record.base.package_sha256 !== base.package_sha256) {
      refuse('batch-isolation-record-invalid', 'physical roots differ from the immutable isolation record');
    }
  } else {
    if (parent.batch_locator?.phase === 'prepared') refuse('batch-isolation-record-invalid', 'a committed locator has no physical record');
    const unionRoots = copy(parent.write_claim.execution_contract.code_roots);
    const paths = copy(parent.write_claim.paths), batchRoots = [];
    for (const member of memberRows) for (const root of member.roots) {
      const id = `b${member.member_index}_${sha256(root.identity_sha256).slice(0, 20)}`;
      if (unionRoots.some(row => row.id === id)) refuse('batch-root-alias', 'a generated union root ID collided');
      unionRoots.push({ id, path: root.path, vcs: 'git' });
      batchRoots.push({ root_id: id, member_index: member.member_index });
      paths.push({ root_id: id, path: '**' });
    }
    const unionContract = roots.validateContract({ ...parent.write_claim.execution_contract, code_roots: unionRoots });
    const claim = claims.normalizeClaim({ schema_version: 2, execution_contract: unionContract, source: 'plan-writes',
      unit: `BATCH:${manifest.members.map(row => row.task_id).join(',')}`, paths });
    claim.batch_roots = batchRoots;
    // Keep the original measured protection/baselines for already-held roots.
    for (const root of parent.write_claim.execution_contract.code_roots) claim.root_baselines[root.id] = copy(parent.write_claim.root_baselines[root.id]);
    claim.vcs_baseline = claim.root_baselines[unionContract.primary_root_id];
    const content = { schema: 'forge-batch-isolation-v1', owner: owner.key, run_id: parent.id, batch_id: manifest.batch_id,
      manifest_sha256: manifest.manifest_sha256, integration_contract: contract, reservation, base: { ...base, replay: false },
      members: memberRows, claim, previous_claim: { generation: parent.write_claim.generation, sha256: roots.digest(parent.write_claim) } };
    record = { ...content, isolation_sha256: digestOf(content) };
    if (!publishExclusive(owner, [...BATCH_SEGMENTS, manifest.batch_id], 'isolation.json', record, MAX_MANIFEST_BYTES, 'batch-isolation-record-invalid')) {
      refuse('batch-isolation-record-invalid', 'another physical record appeared during preparation');
    }
    if (typeof options.failpoint === 'function') options.failpoint('batch-isolation-recorded');
  }
  const locator = { schema: 'forge-batch-locator-v1', phase: 'prepared', run_id: parent.id, batch_id: manifest.batch_id, manifest_sha256: manifest.manifest_sha256,
    isolation_ref: `.gsd/forge/batches/${manifest.batch_id}/isolation.json`, isolation_sha256: record.isolation_sha256,
    claim_generation: record.claim.generation, claim_sha256: roots.digest(record.claim) };
  const expected = parent.batch_locator ? { generation: parent.write_claim.generation, sha256: roots.digest(parent.write_claim) } : record.previous_claim;
  const result = claims.replaceBatchClaim(owner.real, parent.id, { expected, union: record.claim, batchLocator: locator }, guard);
  if (!result.ok) refuse(result.reason === 'stale-claim' ? 'batch-isolation-handle-stale' : 'batch-claim-gate-conflict', result.reason);
  if (typeof options.failpoint === 'function') options.failpoint('batch-claim-committed');
  return { record: deepFreeze(record), claim: result.claim };
}

// ── Live member execution (issue 343 U2b) ────────────────────────────────────

function memberState(handle) {
  const entry = handle && typeof handle === 'object' ? HANDLES.get(handle) : null;
  const context = AUTO_GATE_CONTEXT.getStore() || entry?.autoGateContext;
  return context ? AUTO_GATE_CONTEXT.run(context, () => memberStateWithGate(handle)) : memberStateWithGate(handle);
}
function memberStateWithGate(handle) {
  const entry = handle && typeof handle === 'object' ? HANDLES.get(handle) : null;
  if (!entry || entry.kind !== 'member' || !entry.isolation || !entry.scope) refuse('batch-member-handle-invalid', 'a live prepared member handle is required');
  const owner = ownerOf(entry.scope.cwd), manifest = readManifestAt(owner, entry.scope.batch_id);
  if (!manifest || manifest.manifest_sha256 !== entry.isolation.manifest_sha256) refuse('batch-member-handle-stale', 'the manifest changed');
  const record = readIsolation(owner, manifest);
  if (!record || record.isolation_sha256 !== entry.isolation.isolation_sha256) refuse('batch-member-handle-stale', 'the physical map changed');
  const run = parentRun(entry.scope, owner, manifest, record.integration_contract);
  if (!run.batch_locator || run.batch_locator.isolation_sha256 !== record.isolation_sha256
      || codeRoots().digest(run.write_claim) !== codeRoots().digest(record.claim)) refuse('batch-member-handle-stale', 'the aggregate claim or locator changed');
  const member = manifest.members[entry.data.member_index], placed = record.members.find(row => row.member_index === member?.index);
  if (!member || !placed || member.task_id !== entry.data.task_id || placed.lease_generation !== entry.data.lease_generation
      || memberLease(owner.real, manifest, member, 'batch-member-handle-stale', entry.postBarrier === true) !== placed.lease_generation
      || !['admitido', 'executando', 'retido', 'publicacao-pendente', 'publicado', 'integrado'].includes(progressOf(owner, manifest)[member.index].state)) {
    refuse('batch-member-handle-stale', 'the exact begin/lease/member is no longer live');
  }
  const roots = codeRoots(), union = roots.validateContract(run.write_claim.execution_contract, { revalidate: true, owner: owner.real });
  const origin = roots.validateContract({ ...record.integration_contract,
    primary_root_id: require('./forge-must-haves').parseExecutionFields(fs.readFileSync(path.join(owner.real, member.plan.path), 'utf8')).primary_root_id || placed.roots[0].root_id,
    code_roots: placed.roots.map(row => record.integration_contract.code_roots.find(root => root.id === row.root_id)) }, { revalidate: true });
  if (!origin.code_roots.some(root => root.id === origin.primary_root_id)) refuse('batch-root-foreign', 'the primary root is absent');
  const runtime = roots.validateContract({ ...origin, code_roots: placed.roots.map(row => ({ id: row.root_id, path: row.path, vcs: 'git', identity_sha256: row.identity_sha256 })) }, { revalidate: true });
  const mapping = runtime.code_roots.map(root => {
    const target = union.code_roots.find(row => row.identity_sha256 === root.identity_sha256);
    const source = origin.code_roots.find(row => row.id === root.id), placedRoot = placed.roots.find(row => row.root_id === root.id);
    const index = isolation().batchIndexIdentity(root.path);
    if (!target || !run.write_claim.batch_roots?.some(row => row.root_id === target.id && row.member_index === member.index)
        || !index || index.links !== 1 || roots.key(index.path) !== roots.key(placedRoot.index_path)
        || source.identity_sha256 !== placedRoot.integration_identity_sha256 || !isolation().validateWorktreeIdentity(source.path, root.path, placedRoot.branch).ok) {
      refuse('batch-root-foreign', 'L -> W(member) -> U is not total and exclusive');
    }
    return { root_id: root.id, union_root_id: target.id, origin_identity_sha256: source.identity_sha256, runtime_identity_sha256: root.identity_sha256 };
  });
  return { entry, owner, manifest, member, placed, record, run, origin, runtime, mapping };
}

function memberRequestDigest(request) {
  const { memberHandle, ...data } = request;
  return digestOf(data);
}

function checkMemberRequest(state, request) {
  const { owner, manifest, member, placed, run, runtime } = state, roots = codeRoots();
  if (!isObject(request) || request.scope !== 'milestone' || request.phase !== 'execute' || request.unitType !== 'execute-task'
      || request.milestoneId !== manifest.milestone || request.sliceId !== manifest.slice || request.taskId !== member.task_id
      || request.runId !== run.id || typeof request.dispatchId !== 'string' || !request.dispatchId || typeof request.workflowId !== 'string' || !request.workflowId
      || roots.key(realOrSelf(request.contextRoot || '')) !== owner.key || roots.key(realOrSelf(request.cwd || '')) !== roots.key(runtime.code_roots.find(row => row.id === runtime.primary_root_id).path)
      || roots.digest(request.execution_contract) !== roots.digest(runtime) || roots.digest(request.claim) !== roots.digest(run.write_claim)
      || request.begin_key !== placed.begin_key || request.lease_generation !== placed.lease_generation
      || !request.route || request.route.host_runtime !== manifest.host_runtime
      || ['engine', 'tier', 'effort'].some(key => request.route[key] !== member.route[key])
      || (request.route.model_resolved || request.route.model) !== member.route.model
      || request.route.worker_mode !== member.route.worker_mode) refuse('batch-member-request-mismatch', 'the request does not name this member/attempt/route and physical projection');
  const plan = require('./forge-task-execution').milestonePlanFile(request);
  if (roots.key(path.resolve(plan)) !== roots.key(path.join(owner.real, member.plan.path))) refuse('batch-member-request-mismatch', 'foreign canonical plan');
  if (request.writableRoots?.some(value => !runtime.code_roots.some(row => roots.key(row.path) === roots.key(realOrSelf(value))))) {
    refuse('batch-member-request-mismatch', 'a sibling or integration root was requested writable');
  }
}

// The caller receives the SAME handle minted by prepareIsolation's onMember
// callback. A request/attempt binding is immutable; imported records cannot mint it.
function bindMemberExecution(handle, request) {
  const state = memberState(handle);
  if (request.memberHandle && request.memberHandle !== handle) refuse('batch-member-handle-invalid', 'a sibling handle was supplied');
  checkMemberRequest(state, request);
  const requestSha = memberRequestDigest(request), filename = `member-${state.member.index}.json`;
  const binding = { schema: 'forge-batch-member-attempt-v1', batch_id: state.manifest.batch_id,
    isolation_sha256: state.record.isolation_sha256, member_index: state.member.index, task_id: state.member.task_id,
    begin_key: state.placed.begin_key, lease_generation: state.placed.lease_generation,
    claim_generation: state.run.write_claim.generation, dispatch_id: request.dispatchId, request_sha256: requestSha };
  const prior = readRecord(state.owner, [...BATCH_SEGMENTS, state.manifest.batch_id, 'attempts'], filename, MAX_PROGRESS_BYTES, 'batch-member-attempt-invalid');
  if (prior && digestOf(prior) !== digestOf(binding)) refuse('batch-member-request-mismatch', 'another attempt already owns this member');
  if (!prior && !publishExclusive(state.owner, [...BATCH_SEGMENTS, state.manifest.batch_id, 'attempts'], filename, binding, MAX_PROGRESS_BYTES, 'batch-member-attempt-invalid')) {
    refuse('batch-member-attempt-invalid', 'another member attempt appeared');
  }
  state.entry.execution = { requestSha, binding, request: { ...request, memberHandle: handle } };
  return handle;
}

function resolveMemberExecution(handle, request) {
  const state = memberState(handle), bound = state.entry.execution;
  if (!bound || !request) refuse('batch-member-attempt-required', 'a live request-bound member handle is required');
  checkMemberRequest(state, request);
  if (request.memberHandle && request.memberHandle !== handle || memberRequestDigest(request) !== bound.requestSha) refuse('batch-member-request-mismatch', 'the exact request/attempt changed');
  const saved = readRecord(state.owner, [...BATCH_SEGMENTS, state.manifest.batch_id, 'attempts'], `member-${state.member.index}.json`, MAX_PROGRESS_BYTES, 'batch-member-attempt-invalid');
  if (!saved || digestOf(saved) !== digestOf(bound.binding)) refuse('batch-member-handle-stale', 'the member attempt binding changed');
  const checked = memberPlanView(state, fs.readFileSync(path.join(state.owner.real, state.member.plan.path)));
  return deepFreeze({ batch_id: state.manifest.batch_id, member_index: state.member.index, begin_key: state.placed.begin_key,
    lease_generation: state.placed.lease_generation, claim_generation: state.run.write_claim.generation, claim_sha256: codeRoots().digest(state.run.write_claim),
    request_sha256: bound.requestSha, execution_contract: state.runtime, claims: checked.checked_runtime_plan.writes,
    writableRoots: state.runtime.code_roots.map(row => row.path), mapping: state.mapping, runtime_view: checked });
}

function validateMemberPlan(handle, canonicalBytes) {
  return memberPlanView(memberState(handle), canonicalBytes);
}

function memberPlanView(state, canonicalBytes) {
  const context = AUTO_GATE_CONTEXT.getStore() || state.entry.autoGateContext;
  return context ? AUTO_GATE_CONTEXT.run(context, () => memberPlanViewWithGate(state, canonicalBytes)) : memberPlanViewWithGate(state, canonicalBytes);
}
function memberPlanViewWithGate(state, canonicalBytes) {
  const roots = codeRoots();
  const planFile = path.join(state.owner.real, state.member.plan.path);
  const physical = require('./forge-task-execution').milestonePlanFile({ contextRoot: state.owner.real, milestoneId: state.manifest.milestone,
    sliceId: state.manifest.slice, taskId: state.member.task_id, planFile });
  const bytes = fs.readFileSync(physical), gate = memberGate(state.owner, state.manifest, state.member, state.origin);
  if (!Buffer.from(canonicalBytes).equals(bytes) || sha256(bytes) !== state.member.plan.sha256 || gate.sha256 !== state.placed.gate_sha256) {
    refuse('batch-member-plan-invalid', 'the canonical plan/gate is changed or unapproved');
  }
  const original = bytes.toString('utf8'), checked = roots.validatePlan(original, state.origin);
  let runtimeText = original;
  if (checked.schema_version === 2) {
    const eol = original.includes('\r\n') ? '\r\n' : '\n';
    const block = 'code_roots:' + eol + state.runtime.code_roots.map(root => `  - id: ${root.id}${eol}    path: ${JSON.stringify(root.path.replace(/\\/g, '/'))}${eol}    vcs: ${root.vcs}`).join(eol);
    const front = original.match(/^---\r?\n[\s\S]*?\r?\n---/);
    if (!front) refuse('batch-member-plan-invalid', 'no canonical frontmatter');
    const mapped = front[0].replace(/^code_roots:[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/m, block);
    runtimeText = mapped + original.slice(front[0].length);
  }
  const runtimeChecked = roots.validatePlan(runtimeText, state.runtime);
  if (digestOf(checked.must_haves) !== digestOf(runtimeChecked.must_haves) || digestOf(checked.writes) !== digestOf(runtimeChecked.writes)
      || digestOf(checked.outputs) !== digestOf(runtimeChecked.outputs)) refuse('batch-member-plan-invalid', 'runtime mapping changed the approved criteria');
  for (const write of runtimeChecked.writes) {
    const mapped = state.mapping.find(row => row.root_id === write.root_id);
    if (!mapped || !state.run.write_claim.paths.some(row => roots.covers(row, { root_id: mapped.union_root_id, path: write.path }))) refuse('batch-member-plan-invalid', 'uncovered projected write');
  }
  const view = { schema: 'forge-batch-runtime-view-v1', canonical_plan_sha256: sha256(bytes), canonical_gate_sha256: gate.sha256,
    origin_contract_sha256: roots.digest(state.origin), runtime_contract_sha256: roots.digest(state.runtime),
    runtime_plan_text: runtimeText, checked_runtime_plan: runtimeChecked };
  const minted = deepFreeze({ ...view, runtime_view_sha256: digestOf(view) });
  VIEWS.add(minted);
  return minted;
}
/** Issue 343 U3b: true only for a runtime view memberPlanView minted here through a live member handle. */
function isMemberView(view) { return view !== null && typeof view === 'object' && VIEWS.has(view); }

function assertMemberRootOwner(handle, root) {
  const state = memberState(handle), value = typeof root === 'string' ? root : root?.path;
  if (typeof value !== 'string' || !state.runtime.code_roots.some(row => codeRoots().key(row.path) === codeRoots().key(realOrSelf(value)))) {
    refuse('batch-member-root-foreign', 'this root is not owned by this member');
  }
  return true;
}

// Reconstruction is host-only and never runs provision/materialization again.
// Both callbacks must actually attest every root's stopped and reconciled scope.
function resumeMemberExecution(scope, memberIndex, request, trusted = {}) {
  return autoGateContext({ autoPlanGateAdapter: trusted.autoPlanGateAdapter, members: trusted.members || { [request?.taskId]: request } },
    () => resumeMemberExecutionWithGate(scope, memberIndex, request, trusted));
}
function resumeMemberExecutionWithGate(scope, memberIndex, request, trusted) {
  if (typeof trusted.processProbe !== 'function' || typeof trusted.reconcile !== 'function') refuse('batch-member-reconciliation-required', 'restart requires live process and root reconciliation');
  const owner = ownerOf(scope.cwd), manifest = readManifestAt(owner, scope.batch_id);
  if (!manifest || manifest.owner_digest !== ownerDigest(scope.owner_token) || manifest.manifest_sha256 !== scope.manifest_sha256) refuse('batch-manifest-foreign', 'foreign restart');
  const record = readIsolation(owner, manifest), placed = record?.members.find(row => row.member_index === memberIndex);
  if (!placed) refuse('batch-member-handle-invalid', 'no such prepared member');
  const check = { batch_id: manifest.batch_id, member_index: memberIndex, dispatch_id: request.dispatchId,
    roots: copy(placed.roots), claim_generation: record.claim.generation, isolation_sha256: record.isolation_sha256 };
  if (trusted.processProbe(deepFreeze(copy(check))) !== true || trusted.reconcile(deepFreeze(copy(check))) !== true) {
    refuse('batch-member-reconciliation-required', 'a possible writer/root is still pending');
  }
  const data = record.reservation.members.find(row => row.member_index === memberIndex);
  const handle = mintHandle('member', { reservation: record.reservation, ...data }, () => refuse('batch-member-reconciliation-required', 'a resumed execution handle cannot provision'));
  const entry = HANDLES.get(handle); entry.isolation = record; entry.scope = { ...scope };
  entry.autoGateContext = AUTO_GATE_CONTEXT.getStore();
  // A restart may only rebind the exact already-published attempt, never open one.
  const prior = readRecord(owner, [...BATCH_SEGMENTS, manifest.batch_id, 'attempts'], `member-${memberIndex}.json`, MAX_PROGRESS_BYTES, 'batch-member-attempt-invalid');
  if (!prior || prior.request_sha256 !== memberRequestDigest(request)) refuse('batch-member-request-mismatch', 'restart is not the saved attempt');
  return bindMemberExecution(handle, { ...request, memberHandle: handle });
}

// Read-only ownership predicate for single/borrow/cleanup boundaries. Malformed
// locators never disappear into the ordinary single-root path.
function memberRootReservation(cwd, target) {
  const owner = ownerOf(cwd), roots = codeRoots(), census = require('./forge-runs').boundedCensus(owner.real);
  if (census.unparseable.length) return { reserved: true, reason_code: 'batch-ownership-unknown' };
  for (const run of census.parsed) {
    try {
      for (const retirement of run.batch_retirements || []) {
        require('./forge-runs').validateBatchRetirements(run.batch_retirements, run.id);
        for (const root of retirement.retained_roots) {
          if (roots.within(root.path, realOrSelf(target)) || roots.within(realOrSelf(target), root.path)) {
            return { reserved: true, reason_code: 'batch-member-root-exclusive', run_id: run.id,
              retirement_id: retirement.retirement_id };
          }
        }
      }
      if (run.batch_locator == null) continue;
      const locator = require('./forge-runs').validateBatchLocator(run.batch_locator, run.id);
      if (locator.phase === 'preparing') return { reserved: true, reason_code: 'batch-member-provisioning-pending', run_id: run.id };
      const manifest = readManifestAt(owner, locator.batch_id), record = manifest && readIsolation(owner, manifest);
      if (!record || record.isolation_sha256 !== locator.isolation_sha256) throw new Error('missing isolation');
      for (const member of record.members) for (const root of member.roots) {
        if (roots.within(root.path, realOrSelf(target)) || roots.within(realOrSelf(target), root.path)) {
          return { reserved: true, reason_code: 'batch-member-root-exclusive', run_id: run.id, member_index: member.member_index };
        }
      }
    } catch (_) { return { reserved: true, reason_code: 'batch-ownership-unknown' }; }
  }
  return { reserved: false };
}

// ── Cohort broker (issue 343 U3a, B3 part 1) ─────────────────────────────────

function reconciliation() { return require('./forge-artifact-reconciliation'); }
// The cohort's single broker slot: a sibling of the member roots inside the batch area, outside
// the owner and every root of the aggregate union (the broker refuses any other place).
const BROKER_DIRECTORY = 'broker';
const ROUTE_EVIDENCE_KEYS = Object.freeze(['worker_mode', 'host_runtime', 'resolved_worker_engine', 'engine', 'model', 'tier', 'effort', 'route_sha256']);

// A prepared member handle already bound to its exact attempt (bindMemberExecution).
function attemptEntry(handle) {
  const entry = handle !== null && typeof handle === 'object' ? HANDLES.get(handle) : undefined;
  if (!entry || entry.kind !== 'member' || !entry.isolation || !entry.scope || !entry.execution) {
    refuse('batch-member-attempt-required', 'a live request-bound member handle is required');
  }
  return entry;
}
// The evidence identity of one member attempt in the broker records: a digest of the complete
// binding (batch, isolation, member, begin/lease, claim generation, dispatch and request), so a
// reused task ID, another attempt or a stale lease never collides. It identifies, never grants.
function brokerMemberRef(entry) {
  const binding = entry.execution.binding;
  return `m${binding.member_index}-${digestOf({ schema: SCHEMA, batch_id: binding.batch_id, manifest_sha256: entry.isolation.manifest_sha256,
    isolation_sha256: binding.isolation_sha256, member_index: binding.member_index, task_id: binding.task_id, begin_key: binding.begin_key,
    lease_generation: binding.lease_generation, claim_generation: binding.claim_generation, dispatch_id: binding.dispatch_id,
    request_sha256: binding.request_sha256 }).slice(0, 16)}`;
}
/**
 * The broker's binding of one live member handle (forge-artifact-reconciliation calls it on every
 * member operation). In memory by default; `revalidate: true` runs the complete B2 seam again
 * (resolveMemberExecution: manifest, isolation, aggregate claim and locator, begin/lease, bound
 * request and the validated plan view). Data only: the handle remains the authority.
 */
function brokerMemberBinding(handle, options = {}) {
  const entry = attemptEntry(handle), binding = entry.execution.binding;
  const view = isObject(options) && options.revalidate === true ? resolveMemberExecution(handle, entry.execution.request) : null;
  if (view && view.request_sha256 !== binding.request_sha256) refuse('batch-member-handle-stale', 'the bound request changed');
  // Issue 343 U3b: the complete revalidation the broker just ran is this member's latest validated
  // resolution; memberSidecar reuses it instead of resolving the same seam twice in one step.
  if (view) entry.brokerResolution = { sequence: (entry.brokerResolution ? entry.brokerResolution.sequence : 0) + 1, resolution: view };
  return deepFreeze({ member_ref: brokerMemberRef(entry), batch_id: binding.batch_id, isolation_sha256: binding.isolation_sha256,
    member_index: binding.member_index, task_id: binding.task_id, dispatch_id: binding.dispatch_id, request_sha256: binding.request_sha256,
    ...(view ? { claim_generation: view.claim_generation, claim_sha256: view.claim_sha256, runtime_view_sha256: view.runtime_view.runtime_view_sha256 } : {}) });
}
// The cohort handle stays live only while the published manifest, the physical isolation record
// and the run's aggregate claim and locator are exactly the ones the broker was started over.
function cohortLive(owner, manifest, record, retirement) {
  const current = readManifestAt(owner, manifest.batch_id);
  if (!current || current.manifest_sha256 !== manifest.manifest_sha256) refuse('batch-cohort-handle-stale', 'the batch manifest changed');
  const physical = readIsolation(owner, current);
  if (!physical || physical.isolation_sha256 !== record.isolation_sha256) refuse('batch-cohort-handle-stale', 'the physical map changed');
  const census = require('./forge-runs').boundedCensus(owner.real);
  const run = census.unparseable.length ? null : census.parsed.find(row => row.id === record.run_id);
  const atRetirement = retirement && run && codeRoots().digest(run) === codeRoots().digest(retirement.after_record);
  if (!run || run.active !== true || (!atRetirement && (!isObject(run.batch_locator) || run.batch_locator.isolation_sha256 !== record.isolation_sha256))
      || !run.write_claim || codeRoots().digest(run.write_claim) !== codeRoots().digest(record.claim)) {
    refuse('batch-cohort-handle-stale', 'the aggregate claim or locator changed');
  }
}
/** The registered data of a live cohort handle, revalidated: the broker's only cohort source. */
function resolveBrokerCohort(handle) {
  const entry = handle !== null && typeof handle === 'object' ? HANDLES.get(handle) : undefined;
  if (!entry || entry.kind !== 'cohort') refuse('batch-cohort-handle-invalid', 'not a live cohort handle of forge-execution-batch');
  entry.revalidate();
  return entry.data;
}

/**
 * Issue 343 U3a: the cohort broker lifecycle. After the member begins, isolation and attempt
 * bindings, and before the first provider spawn: every prepared member handle is revalidated
 * through the B2 seam and must still be admitido (no writer started), the registry is closed
 * over exactly those members, and ONE broker child is started for the cohort (it captures the
 * common snapshot S0). Nothing here spawns a provider, edits STATE, progress or a claim.
 *
 * @param {{ cwd, milestone, host_runtime, owner_token, batch_id, manifest_sha256 }} scope
 * @param {object[]} memberHandles the handles prepareIsolation minted (onMember), each bound
 * @param {{ appendPaths? }} options trusted, in-process
 * @returns {Promise<{ cohort, broker }>} the opaque cohort handle (barrier, close) and the client
 */
async function openCohortBroker(scope, memberHandles, options = {}) {
  if (!isObject(scope) || typeof scope.batch_id !== 'string' || !BATCH_ID.test(scope.batch_id)
      || typeof scope.manifest_sha256 !== 'string' || !HASH.test(scope.manifest_sha256)) refuse('batch-not-active', 'no batch is named');
  for (const key of ['cwd', 'milestone', 'host_runtime', 'owner_token']) {
    if (typeof scope[key] !== 'string' || !scope[key] || scope[key].includes('\u0000')) refuse('batch-scope-invalid', `${key} is required`);
  }
  const owner = ownerOf(scope.cwd), manifest = readManifestAt(owner, scope.batch_id);
  if (!manifest) refuse('batch-manifest-invalid', 'the named batch has no published manifest');
  if (manifest.manifest_sha256 !== scope.manifest_sha256 || manifest.owner !== owner.key || manifest.milestone !== scope.milestone
      || manifest.host_runtime !== scope.host_runtime || manifest.owner_digest !== ownerDigest(scope.owner_token)) {
    refuse('batch-manifest-foreign', 'the named manifest belongs to another owner, milestone, host or owner token');
  }
  const record = readIsolation(owner, manifest);
  if (!record) refuse('batch-isolation-record-invalid', 'the cohort has no physical isolation record');
  if (!Array.isArray(memberHandles) || memberHandles.length !== record.members.length || new Set(memberHandles).size !== memberHandles.length) {
    refuse('batch-cohort-incomplete', 'the broker registry needs exactly one live handle per prepared member');
  }
  // The single broker slot already exists: reconcile that broker, never adopt or replace it
  // (the broker's exclusive creation of the slot still decides a concurrent start).
  const slot = path.join(record.base.batch_dir, BROKER_DIRECTORY);
  if (fs.existsSync(slot)) refuse('batch-cohort-broker-exists', 'the cohort already has its single broker');
  const progress = progressOf(owner, manifest), registered = [];
  for (const handle of memberHandles) {
    const entry = attemptEntry(handle);
    if (entry.isolation.isolation_sha256 !== record.isolation_sha256 || entry.scope.batch_id !== manifest.batch_id
        || ownerOf(entry.scope.cwd).key !== owner.key) refuse('batch-member-handle-stale', 'the handle belongs to another cohort');
    const resolved = resolveMemberExecution(handle, entry.execution.request);
    const member = manifest.members[resolved.member_index], placed = record.members.find(row => row.member_index === resolved.member_index);
    if (!member || !placed) refuse('batch-member-handle-stale', 'the handle names no prepared member');
    if (progress[member.index].state !== 'admitido') {
      refuse('batch-cohort-writer-started', `${member.task_id} is ${progress[member.index].state || 'unrecorded'}, not admitido`);
    }
    registered.push({ handle, row: { member_ref: brokerMemberRef(entry), member_index: member.index, task_id: member.task_id, unit: member.unit,
      milestone: manifest.milestone, slice: manifest.slice, begin_key: placed.begin_key, lease_generation: placed.lease_generation,
      dispatch_id: entry.execution.binding.dispatch_id, workflow_id: entry.execution.request.workflowId, request_sha256: resolved.request_sha256,
      claim_generation: resolved.claim_generation, plan_sha256: member.plan.sha256, gate_sha256: placed.gate_sha256,
      runtime_contract_sha256: codeRoots().digest(resolved.execution_contract), runtime_view_sha256: resolved.runtime_view.runtime_view_sha256,
      route: Object.fromEntries(ROUTE_EVIDENCE_KEYS.map(key => [key, member.route[key]])),
      roots: resolved.execution_contract.code_roots.map(root => ({ root_id: root.id, path: root.path, identity_sha256: root.identity_sha256 })) } });
  }
  registered.sort((left, right) => left.row.member_index - right.row.member_index);
  if (registered.some((entry, index) => entry.row.member_index !== record.members[index].member_index)) {
    refuse('batch-cohort-incomplete', 'a prepared member has no handle');
  }
  const data = { owner: owner.real, batch_id: manifest.batch_id, manifest_sha256: manifest.manifest_sha256, isolation_sha256: record.isolation_sha256,
    run_id: record.run_id, claim: { generation: record.claim.generation, sha256: codeRoots().digest(record.claim) },
    batch_dir: record.base.batch_dir, union_roots: record.claim.execution_contract.code_roots.map(root => root.path),
    members: registered.map(entry => entry.row) };
  const cohort = mintHandle('cohort', data, () => cohortLive(owner, manifest, record));
  const broker = await reconciliation().startBatchBroker(cohort, registered.map(entry => entry.handle), {
    directory: slot, ...(isObject(options) && options.appendPaths !== undefined ? { appendPaths: options.appendPaths } : {}) });
  HANDLES.get(cohort).broker = broker;
  // Issue 343 U3b: each registered member reaches the cohort's broker only through its own handle.
  for (const entry of registered) HANDLES.get(entry.handle).broker = broker;
  return Object.freeze({ cohort, broker });
}
/** Closes the cohort's broker child; the durable evidence (manifest, journal, anchors, barrier) stays. */
async function closeCohortBroker(handle) {
  const entry = handle !== null && typeof handle === 'object' ? HANDLES.get(handle) : undefined;
  if (!entry || entry.kind !== 'cohort') refuse('batch-cohort-handle-invalid', 'not a live cohort handle of forge-execution-batch');
  if (entry.broker) await entry.broker.close();
}

// ── Retained member execution (issue 343 U3b, B3 part 2) ─────────────────────
//
// The sidecar side of one live cohort member attempt. forge-unit-sidecar resolves it from the
// member's opaque handle and its exact bound request: every owner event of the attempt is a signed
// line of the cohort stream, the owner surface is the broker's common verification (S0 plus every
// signed append, never a private snapshot), and a finished member stops at its retained executed
// record: an immutable copy of the executed bytes and a RetainedRef (paths and hashes only) in the
// cohort's batch area, bound by the broker's single signed anchor of the attempt. Nothing here
// publishes, completes, writes the owner or grants a write; the heavy verification of a retained
// member (forge-unit-sidecar verifyRetainedExecution) exists only after the barrier.

const RETAINED_DIRECTORY = 'retained';
const RETAINED_SCHEMA = 'forge-batch-retained-v1';
const RETAINED_KEYS = Object.freeze(['schema', 'batch_id', 'broker_manifest_sha256', 'member_index', 'task_id', 'member_ref',
  'dispatch_id', 'request_sha256', 'executed', 'response', 'seal_sha256', 'baseline_sha256', 'delta_sha256', 'anchor']);
const MAX_RETAINED_BYTES = 32 * 1024 * 1024;
const MEMBER_EVENTS = '.gsd/forge/events.jsonl';
const CHANNEL_SUFFIXES = Object.freeze(['', '.receipt.json', '.returned.json', '.reset-state.json', '.recovery.json']);
// The sidecar operation objects minted by memberSidecar (live handle and exact request only).
const SIDECARS = new WeakSet();

// A regular bounded record; null only when it does not exist.
function retainedRead(file, code) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return refuse(code, `${path.basename(file)} is unreadable`);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_RETAINED_BYTES) refuse(code, `${path.basename(file)} is not a regular bounded record`);
  return fs.readFileSync(file);
}
// Exclusive creation with fsync and readback: the exact same bytes replay, anything else refuses.
function retainedWrite(file, bytes, code) {
  let descriptor = null;
  try { descriptor = fs.openSync(file, 'wx', 0o600); }
  catch (error) { if (!error || error.code !== 'EEXIST') throw error; }
  if (descriptor !== null) {
    try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  }
  const stored = retainedRead(file, code);
  if (!stored || !stored.equals(bytes)) refuse(code, `${path.basename(file)} already holds another record`);
}
function parsedRecord(bytes, code, detail) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (_) { return refuse(code, detail); }
}

/**
 * Issue 343 U3b: the sidecar operations of one live, request-bound cohort member attempt. The
 * complete B2 seam is resolved now with the caller's exact request (resolveMemberExecution), and
 * the attempt must be registered in the cohort broker openCohortBroker started. The returned object
 * carries data and closed operations bound to this handle only; it grants no write beyond the
 * member's own projection and is accepted by forge-unit-sidecar only when minted here.
 *
 *   view() / contract()     the latest validated runtime view and physical contract (prepare,
 *                           launch or the last broker verification)
 *   resolve()               the complete seam again (the launch boundary)
 *   matches(request)        the exact bound request of this attempt (data only)
 *   assertChannels(file)    the attempt channel files lie outside the owner, every root of the
 *                           aggregate union and the cohort evidence directories
 *   appendEvent(line) / appendDispatch(args, route, now)   one signed member line of the stream
 *   verifyOwner(phase?)     the broker's whole-stream and owner-surface verification, which
 *                           also revalidates this member
 *   barrierSealed()         whether the cohort barrier record exists (a cheap refusal test only)
 *   retain(input)           the immutable executed copy, the single anchor and the RetainedRef
 *   retained()              the RetainedRef verified byte by byte against the broker's anchor,
 *                           or null when this attempt was never retained
 */
function memberSidecar(handle, request) {
  const entry = attemptEntry(handle);
  if (!isObject(request)) refuse('batch-member-attempt-required', 'the bound request is required');
  let current = resolveMemberExecution(handle, request);
  if (!entry.broker) refuse('batch-member-broker-required', 'the member attempt is not registered in an open cohort broker');
  const client = reconciliation().assertBatchBroker(entry.broker);
  const binding = entry.execution.binding, memberRef = brokerMemberRef(entry), identity = client.memberIdentity(handle);
  if (identity.member_ref !== memberRef || identity.batch_id !== binding.batch_id || identity.dispatch_id !== binding.dispatch_id) {
    refuse('batch-member-handle-stale', 'the cohort broker registered another member attempt');
  }
  const roots = codeRoots(), owner = ownerOf(entry.scope.cwd);
  const batchDir = entry.isolation.base.batch_dir, retainedDir = path.join(batchDir, RETAINED_DIRECTORY);
  const anchorFile = path.join(client.directory, 'anchors', `m${binding.member_index}.json`);
  const barrierFile = path.join(client.directory, 'barrier.json');
  const files = { ref: path.join(retainedDir, `${memberRef}.json`), executed: path.join(retainedDir, `${memberRef}.executed.json`) };
  const outer = [owner.real, ...entry.isolation.claim.execution_contract.code_roots.map(root => realOrSelf(root.path)), client.directory, retainedDir];
  const retainedDirectory = create => {
    let stat = null;
    try { stat = fs.lstatSync(retainedDir); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
    if (!stat) {
      if (!create) return false;
      try { fs.mkdirSync(retainedDir, { mode: 0o700 }); } catch (error) { if (!error || error.code !== 'EEXIST') throw error; }
      stat = fs.lstatSync(retainedDir);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()
        || roots.key(fs.realpathSync.native(retainedDir)) !== roots.key(path.join(fs.realpathSync.native(batchDir), RETAINED_DIRECTORY))) {
      refuse('batch-retained-invalid', 'the retained directory is not a real directory of the batch area');
    }
    return true;
  };
  // The broker verification revalidates this member inside its serial guard: that resolution
  // becomes the current one only when it was produced by this very call.
  const verify = async phase => {
    const before = entry.brokerResolution ? entry.brokerResolution.sequence : 0;
    const verified = await client.verifyMember(handle, phase === undefined ? {} : { phase });
    const seen = entry.brokerResolution;
    if (!seen || seen.sequence <= before || seen.resolution.request_sha256 !== binding.request_sha256
        || seen.resolution.runtime_view.runtime_view_sha256 !== verified.binding.runtime_view_sha256) {
      refuse('batch-member-handle-stale', 'the cohort verification did not revalidate this member attempt');
    }
    current = seen.resolution;
    return verified;
  };
  const api = Object.freeze({
    batch_id: binding.batch_id, member_index: binding.member_index, task_id: binding.task_id, member_ref: memberRef,
    dispatch_id: binding.dispatch_id, request_sha256: binding.request_sha256,
    view() { return current.runtime_view; },
    contract() { return current.execution_contract; },
    resolve() { current = resolveMemberExecution(handle, request); return current.runtime_view; },
    matches(value) {
      if (!isObject(value)) return false;
      const { memberHandle, ...data } = value;
      return (memberHandle === undefined || memberHandle === handle) && digestOf(data) === binding.request_sha256;
    },
    assertChannels(resultFile) {
      for (const file of CHANNEL_SUFFIXES.map(suffix => `${resultFile}${suffix}`)) {
        let canonical;
        try { canonical = path.join(fs.realpathSync.native(path.dirname(path.resolve(file))), path.basename(file)); }
        catch (_) { refuse('batch-member-channel-invalid', 'an attempt channel directory is not readable'); }
        if (outer.some(root => roots.within(root, canonical))) {
          refuse('batch-member-channel-invalid', 'an attempt channel lies inside the owner, a cohort root or the cohort evidence');
        }
      }
    },
    appendEvent(line) { return client.appendMember(handle, MEMBER_EVENTS, line); },
    appendDispatch(args, route, now) { return require('./forge-dispatch-event').appendMemberDispatchEvent(client, handle, args, route, now); },
    verifyOwner(phase) { return verify(phase); },
    barrierSealed() { return fs.existsSync(barrierFile); },
    // Issue 343 U5: after the barrier, only the cohort's successor broker (its signed operation journal)
    // explains an owner change. The sibling markers its committed member-artifacts operations already
    // published on one owner path (manifest order), the in-flight operation, and the synchronous owner
    // surface check a canonical publisher runs inside its own lock.
    markerChain(relative) { return typeof client.publishedEffects === 'function' ? client.publishedEffects(relative) : []; },
    pendingOperation() { return typeof client.pendingOperation === 'function' ? client.pendingOperation() : null; },
    assertOwnerSurface() {
      if (typeof client.assertOwnerSurface !== 'function') refuse('batch-member-broker-required', 'only the post-barrier cohort broker verifies a member publication');
      return client.assertOwnerSurface();
    },
    async retain(input) {
      if (!isObject(input) || !Buffer.isBuffer(input.executed) || !isObject(input.response) || typeof input.response.path !== 'string'
          || ![input.response.sha256, input.seal_sha256, input.baseline_sha256, input.delta_sha256].every(value => typeof value === 'string' && HASH.test(value))) {
        refuse('batch-retained-invalid', 'a retained execution needs its executed bytes and every hash');
      }
      const executed = parsedRecord(input.executed, 'batch-retained-invalid', 'the executed record is not JSON');
      const residual = executed && executed.phase === 'residual';
      if (!isObject(executed) || !['executed','residual'].includes(executed.phase) || executed.dispatch_id !== binding.dispatch_id || !isObject(executed.verification_seal)
          || residual && (!['partial','blocked'].includes(executed.result?.status)
            || executed.residual?.result_status !== executed.result.status || executed.residual.provider_called !== executed.provider_called)) {
        refuse('batch-retained-invalid', 'the executed record is not this sealed attempt');
      }
      // The custodial response stays custody: its bytes are hashed, never read as a result.
      const response = retainedRead(input.response.path, 'batch-retained-invalid');
      if (!response || sha256(response) !== input.response.sha256) refuse('batch-retained-invalid', 'the custodial response changed');
      retainedDirectory(true);
      const executedSha = sha256(input.executed);
      retainedWrite(files.executed, input.executed, 'batch-retained-conflict');
      // The one signed anchor of this attempt: the broker binds it only after the member's attached
      // writer really exited, and a second, different binding is refused (broker-response-already-bound).
      const anchor = await client.bindMemberResponse(handle, { response_sha256: input.response.sha256, executed_sha256: executedSha,
        seal_sha256: input.seal_sha256, baseline_sha256: input.baseline_sha256, delta_sha256: input.delta_sha256,
        ...(residual ? {residual:executed.residual} : {}) });
      const record = { schema: RETAINED_SCHEMA, batch_id: binding.batch_id, broker_manifest_sha256: client.manifest_sha256,
        member_index: binding.member_index, task_id: binding.task_id, member_ref: memberRef, dispatch_id: binding.dispatch_id,
        request_sha256: binding.request_sha256, executed: { path: files.executed, sha256: executedSha },
        response: { path: path.resolve(input.response.path), sha256: input.response.sha256 }, seal_sha256: input.seal_sha256,
        baseline_sha256: input.baseline_sha256, delta_sha256: input.delta_sha256, anchor: { path: anchorFile, sha256: roots.digest(anchor) } };
      const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
      retainedWrite(files.ref, bytes, 'batch-retained-conflict');
      return deepFreeze({ ...copy(record), ref_path: files.ref, ref_sha256: sha256(bytes) });
    },
    async retained() {
      if (!retainedDirectory(false)) return null;
      const bytes = retainedRead(files.ref, 'batch-retained-invalid');
      if (!bytes) return null;
      const record = parsedRecord(bytes, 'batch-retained-invalid', 'the retained reference is not JSON');
      const hashes = isObject(record) && isObject(record.executed) && isObject(record.response) && isObject(record.anchor)
        ? [record.executed.sha256, record.response.sha256, record.anchor.sha256, record.seal_sha256, record.baseline_sha256, record.delta_sha256] : [];
      if (!sameKeys(record, RETAINED_KEYS) || record.schema !== RETAINED_SCHEMA || record.batch_id !== binding.batch_id
          || record.broker_manifest_sha256 !== client.manifest_sha256 || record.member_index !== binding.member_index
          || record.task_id !== binding.task_id || record.member_ref !== memberRef || record.dispatch_id !== binding.dispatch_id
          || record.request_sha256 !== binding.request_sha256 || hashes.length !== 6 || !hashes.every(value => typeof value === 'string' && HASH.test(value))
          || typeof record.executed.path !== 'string' || roots.key(record.executed.path) !== roots.key(files.executed)
          || typeof record.anchor.path !== 'string' || roots.key(record.anchor.path) !== roots.key(anchorFile)
          || typeof record.response.path !== 'string' || !path.isAbsolute(record.response.path)) {
        refuse('batch-retained-invalid', 'the retained reference names another attempt');
      }
      const executed = retainedRead(record.executed.path, 'batch-retained-invalid');
      const response = retainedRead(record.response.path, 'batch-retained-invalid');
      const anchorBytes = retainedRead(record.anchor.path, 'batch-retained-invalid');
      if (!executed || sha256(executed) !== record.executed.sha256 || !response || sha256(response) !== record.response.sha256 || !anchorBytes) {
        refuse('batch-retained-invalid', 'a retained byte changed');
      }
      const anchor = parsedRecord(anchorBytes, 'batch-retained-invalid', 'the anchor is not JSON');
      const archived = parsedRecord(executed, 'batch-retained-invalid', 'the retained record is not JSON');
      if ((archived.phase === 'residual') !== !!anchor.residual || anchor.residual && digestOf(anchor.residual) !== digestOf(archived.residual)) refuse('batch-retained-invalid', 'residual metadata changed');
      if (!isObject(anchor) || roots.digest(anchor) !== record.anchor.sha256 || anchor.member_ref !== memberRef
          || anchor.executed_sha256 !== record.executed.sha256 || anchor.response_sha256 !== record.response.sha256
          || anchor.seal_sha256 !== record.seal_sha256 || anchor.baseline_sha256 !== record.baseline_sha256
          || anchor.delta_sha256 !== record.delta_sha256) refuse('batch-retained-invalid', 'the anchor does not bind this retained execution');
      // The broker walks the whole common stream, revalidates this member and holds the anchor it signed.
      const verified = await verify();
      if (verified.anchor_sha256 !== record.anchor.sha256) refuse('batch-retained-invalid', 'the cohort broker holds no such anchor');
      return deepFreeze({ ...copy(record), ref_path: files.ref, ref_sha256: sha256(bytes), phase: verified.phase,
        executed_record: archived });
    },
  });
  SIDECARS.add(api);
  return api;
}
/** Issue 343 U3b: true only for an operation object memberSidecar minted here. */
function isMemberSidecar(value) { return value !== null && typeof value === 'object' && SIDECARS.has(value); }

// ── Bounded cohort pool (issue 343 U4, B4) ───────────────────────────────────
//
// runCohort is the production caller of one admitted cohort; the CLI `run --batch <ref>` is its
// host entry. It never selects work: it reads the durable decision, keeps exactly the manifest's
// admitido members and revalidates them against the live owner (host inputs, canonical routes,
// committed begins and live leases), prepares EVERY member before the common snapshot S0
// (prepareIsolation, then each exact attempt binding), opens the ONE cohort broker (S0) and calls
// the real forge-unit-sidecar runUnitSidecar once per member under a bounded limiter. Each member
// has its own request, route, model, effort, cwd, channels, observers, announcer and AbortSignal:
// nothing about one member is a singleton of the pool. The transport that spawns a member's
// provider attaches that process through the member's own process scope (an AsyncLocalStorage
// scope of this run, currentMemberProcessScope), so the broker observes its exit itself, and
// cancelling one member aborts only that scope (its AbortSignal and its own process tree), never
// process.emit. A member's failure never cancels a healthy sibling. While transports live nothing
// here writes member progress, STATE, a claim, a lease or an owner artifact: the owner surface
// stays S0 plus the broker's signed appends. The barrier is sealed only after every member settled
// and every attached writer really exited (join), from the broker's own process observations; the
// heavy post-barrier verification, publication, integration and ACK belong to the serial
// consolidation. Time and step accounting stay each member's own (its sidecar's transport-entry
// admission, its manifest step charge): there is no formula by batch size here.

const RUN_SCHEMA = 'forge-execution-batch-run-v1';
const RUN_REQUEST_SCHEMA = 'forge-execution-batch-run-request-v1';
// The closed typed outcome of one member in a run report, and the closed status of the run.
const MEMBER_OUTCOMES = Object.freeze(['acknowledged', 'retained', 'failed', 'needs-input', 'blocked']);
const RUN_STATUSES = Object.freeze(['retained', 'partial', 'failed', 'blocked', 'serial']);
// Closed reasons the pool itself names; a member's sidecar or broker refusal keeps its own code.
const POOL_REASON_CODES = Object.freeze(['batch-member-aborted', 'batch-member-result-unexpected', 'batch-member-not-admitted',
  'batch-member-writer-live', 'batch-barrier-unsealed', 'batch-run-failed', 'sidecar-unit-failed']);
// Closed refusals of the pool and its CLI: thrown before any provider of the run could start.
const POOL_REFUSAL_CODES = Object.freeze(['batch-run-request-invalid', 'batch-run-aborted', 'batch-member-input-invalid',
  'batch-member-constraints-unsupported', 'batch-member-route-stale', 'batch-cohort-incomplete', 'batch-member-scope-closed',
  'batch-member-process-invalid', 'batch-member-writer-exists', 'batch-member-broker-required',
  'batch-member-no-start-unproven', 'batch-lease-coverage-insufficient']);
// A member stopped on a request only the owner can answer: never a failure and never an approval.
const NEEDS_INPUT_CODES = Object.freeze(['appserver-input-required', 'pending-human-decision']);
// The host's own fields of one member attempt (shared/forge-bidirectional-sidecar.md): the route,
// roots, claim, begin, lease, plan and identity of the request always come from the owner records.
const MEMBER_INPUT_KEYS = Object.freeze(['dispatchId', 'workflowId', 'resultFile', 'prompt', 'promptFile', 'securityFile',
  'contextFile', 'verification', 'gates', 'constraints', 'budgets', 'procedure_context']);
const RUN_REQUEST_KEYS = Object.freeze(['schema', 'cwd', 'milestone', 'host_runtime', 'owner_token', 'run_id', 'code_root',
  'manifest_sha256', 'members']);
const MAX_RUN_REQUEST_BYTES = 1024 * 1024;
const ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ERROR_CODE = /^[a-z][a-z0-9-]{0,79}$/;
// The bounded join of a settled member's attached writer: its own exit, then, after terminating
// only its own process tree, its exit again. A writer still alive keeps the barrier closed.
const JOIN_GRACE_MS = 15000;
const JOIN_KILL_MS = 10000;
const PROCESS_SCOPES = new AsyncLocalStorage();

function unitSidecar() { return require('./forge-unit-sidecar'); }
function errorCode(error, fallback) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  return ERROR_CODE.test(code) ? code : fallback;
}
function childExited(child) { return child.exitCode !== null || child.signalCode !== null; }
// The broker's own liveness predicate, inverted: the pid no longer exists.
function processGone(pid) {
  try { process.kill(pid, 0); return false; } catch (error) { return !error || error.code !== 'EPERM'; }
}
async function joinedWithin(child, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (childExited(child) && processGone(child.pid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/**
 * Issue 343 U4: the process scope of the cohort member whose sidecar runs in the current async
 * context, or null outside one. The transport adapter that spawns the member's provider calls
 * `attach(child)` once, right after the spawn; `signal` is the member's own AbortSignal.
 */
function currentMemberProcessScope() {
  const scope = PROCESS_SCOPES.getStore();
  return scope === undefined ? null : scope;
}

// The host inputs of every admitido member, exactly: closed fields, one dispatch and one channel
// per member, and the operator's real constraints. A member never commits or deploys;
// preserving auto_commit does not give the worker Git publication authority.
function memberInputs(admitted, supplied) {
  const bad = detail => refuse('batch-member-input-invalid', detail);
  if (!isObject(supplied)) bad('the host inputs of every admitido member are required');
  const wanted = admitted.map(member => member.task_id);
  if (Object.keys(supplied).length !== wanted.length || !wanted.every(id => own(supplied, id))) bad('the inputs must name exactly the admitido members');
  const dispatches = new Set(), channels = new Set(), inputs = new Map();
  for (const id of wanted) {
    const value = supplied[id];
    if (!isObject(value) || Object.keys(value).some(key => !MEMBER_INPUT_KEYS.includes(key))) bad(`${id}: only the host's own request fields are accepted`);
    for (const key of ['dispatchId', 'workflowId']) if (typeof value[key] !== 'string' || !ATTEMPT_ID.test(value[key])) bad(`${id}: ${key} is required`);
    for (const key of ['resultFile', 'promptFile', 'securityFile', 'contextFile']) {
      if ((key === 'resultFile' || value[key] !== undefined)
          && (typeof value[key] !== 'string' || !path.isAbsolute(value[key]) || value[key].includes('\u0000'))) bad(`${id}: ${key} must be an absolute path`);
    }
    if (value.prompt !== undefined && (typeof value.prompt !== 'string' || !value.prompt)) bad(`${id}: prompt must be text`);
    if (value.prompt === undefined && value.promptFile === undefined) bad(`${id}: a prompt or promptFile is required`);
    for (const key of ['verification', 'budgets', 'procedure_context']) if (value[key] !== undefined && !isObject(value[key])) bad(`${id}: ${key} must be an object`);
    if (!isObject(value.gates)) bad(`${id}: gates are required`);
    if (!isObject(value.constraints) || typeof value.constraints.auto_commit !== 'boolean' || value.constraints.deploy !== false) {
      refuse('batch-member-constraints-unsupported', `${id}: a cohort member requires a boolean auto_commit and deploy false`);
    }
    const channel = codeRoots().key(path.resolve(value.resultFile));
    if (dispatches.has(value.dispatchId) || channels.has(channel)) bad(`${id}: every member has its own dispatch and channels`);
    dispatches.add(value.dispatchId);
    channels.add(channel);
    inputs.set(id, copy(value));
  }
  return inputs;
}

// The member's canonical route resolved again now, by the decision's resolver over the exact
// resolution options its manifest pinned: the full resolver object reaches the sidecar only while
// its policy digest is still the manifest's (never a sibling's route, never another model).
function memberRoute(owner, manifest, member, options) {
  const stored = member.route.resolution_options;
  if (!isObject(stored) || typeof stored.cwd !== 'string' || codeRoots().key(realOrSelf(stored.cwd)) !== owner.key) return null;
  const resolver = typeof options.routeResolver === 'function' ? options.routeResolver : require('./forge-dispatch-resolve').resolveDispatch;
  let full = null;
  const routed = routeOf({ cwd: stored.cwd, milestone: manifest.milestone, host_runtime: manifest.host_runtime },
    { id: member.task_id, plan_path: member.plan.path }, { routeResolver: input => { full = resolver(input); return full; } });
  if (!routed.route || routed.route.route_sha256 !== member.route.route_sha256 || !isObject(full)) return null;
  return copy(full);
}

// The live owner renews the leases its members' committed begins hold (the canonical heartbeat,
// TTL unchanged), only BEFORE S0: a lease record is owner surface, and inside the execution
// window only the broker's signed appends may change the owner.
function renewLeases(owner, manifest, members, ownerToken, runId) {
  assertPreparationBeforeS0(owner, manifest, require('./forge-runs').get(owner.real, runId)?.batch_locator);
  const token = String(ownerToken).normalize('NFC').trim(), generations = [];
  // Check all members before touching any lease. A failed or foreign heartbeat
  // is a refusal, never a best-effort success followed by another writer.
  for (const member of members) {
    const generation = memberLease(owner.real, manifest, member, 'batch-isolation-handle-stale', true);
    const raw = leases().readLease(leases().leaseFile(owner.real, member.unit));
    if (raw.corrupt || !leases().validRecord(raw.record, member.unit) || raw.record.owner_token !== token
        || raw.record.generation !== generation) refuse('batch-isolation-handle-stale', member.task_id + ' preparation owner changed');
    generations.push(generation);
  }
  for (const [index, member] of members.entries()) {
    const renewed = leases().heartbeat(owner.real, member.unit, token, generations[index]);
    if (!renewed.ok || renewed.generation !== generations[index]) {
      refuse('batch-isolation-handle-stale', member.task_id + ' preparation heartbeat was refused');
    }
  }
  for (const [index, member] of members.entries()) if (memberLease(owner.real, manifest, member, 'batch-isolation-handle-stale') !== generations[index]) {
    refuse('batch-isolation-handle-stale', member.task_id + ' changed generation during preparation');
  }
}

function cohortCoverage(owner, manifest, members, routes, limit, scope) {
  const timeout = require('./forge-worker-timeout'), slots = Array(limit).fill(0);
  let longest = 0;
  for (const member of members) {
    const ceiling = timeout.ceilingFromRoute(routes.get(member.task_id)).ms;
    longest = Math.max(longest, ceiling);
    const earliest = slots.indexOf(Math.min(...slots)); slots[earliest] += ceiling;
  }
  // The canonical grace already pays for joins; charge only their excess,
  // rather than adding the same grace twice and rejecting every max-tier lane.
  const joinBound=members.length*(JOIN_GRACE_MS+JOIN_KILL_MS);
  const execution = timeout.protectedWindowMs(Math.max(...slots)+Math.max(0,joinBound-timeout.PROTECTED_WINDOW_GRACE_MS));
  // Installation is charged only where the current frozen input can install.
  // A checkpoint before the actual install checks the full remaining bound
  // again, so a changed package/lockfile cannot obtain a smaller reservation.
  const iso = isolation(), admission = currentAdmission(owner.real, owner, manifest);
  const installEnabled = iso.readIsolationPrefs(owner.real).worktreeInstallDeps !== false;
  let installs = 0;
  if (installEnabled) for (const member of members) {
    const declaration = admission.declarations[admission.task_ids.indexOf(member.task_id)];
    for (const root of rootsOf(scope, { declaration })) if (iso.resolvePackageManager(root.path)) installs++;
  }
  // Preparation has its own existing-tier bounded window, independent of
  // execution. It is revalidated at filesystem/install checkpoints and before
  // S0, never extended by a heartbeat inside a protected owner snapshot.
  const preparation = timeout.protectedWindowMs(longest + installs * iso.WORKTREE_INSTALL_TIMEOUT_MS);
  if (!execution.covers || !preparation.covers) refuse('batch-lease-coverage-insufficient', 'the existing protected-window bound cannot cover this preparation/queue');
  return { preparation, execution };
}
function openCohortLeases(owner, manifest, members, token, durationMs) {
  const checked = members.map(member => {
    const generation = memberLease(owner.real, manifest, member, 'batch-isolation-handle-stale');
    const raw = leases().readLease(leases().leaseFile(owner.real, member.unit));
    if (!raw.record || raw.record.owner_token !== String(token).normalize('NFC').trim()) refuse('batch-isolation-handle-stale', member.task_id);
    return { member, generation };
  });
  const opened = [];
  try {
    for (const {member,generation} of checked) {
      const window = leases().openProtectedWindow(owner.real, member.unit, token, generation, {durationMs});
      if (!window.ok) refuse('batch-lease-coverage-insufficient', member.task_id + ': ' + window.reason);
      opened.push(window);
    }
    return opened;
  } catch(error) { opened.forEach(window=>window.close()); throw error; }
}

// One member's own observers: a prefixed stream, its own announcer and the CLI observer factory
// of forge-unit-sidecar instantiated for this member only.
function memberRuntime(member, stream) {
  const prefix = `[forge-batch ${member.task_id}] `;
  const sink = {
    write(value) {
      try { stream.write(String(value).replace(/^(?=.)/gm, prefix)); } catch (_) { /* observer loss never affects a member */ }
      return true;
    },
  };
  const announcer = require('./forge-sidecar-identity').createAnnouncer({ write: line => sink.write(line) });
  return { announce: (stage, fields) => announcer(stage, fields), ...unitSidecar().cliObservers(sink) };
}

// One member of the run: its bound request, its own AbortController, its process scope (the one
// attached writer) and the control a host uses to cancel THIS member only.
function memberLane(manifest, member, handle, request, controller, stream, leaseCheckpoint = () => {}) {
  const state = { broker: null, child: null, attemptedChild: null, attached: null, started: false, settled: false, aborted: false,
    spawnAttempted: false, spawnClosed: false, neverStartedReason: null };
  const terminate = () => {
    const child=state.child || state.attemptedChild;
    if (child && !childExited(child)) {
      try { require('./forge-xllm').terminateOwnedProcessTree(child); } catch (_) { /* the join observes the real exit */ }
    }
  };
  const scope = Object.freeze({
    batch_id: manifest.batch_id, member_index: member.index, task_id: member.task_id, signal: controller.signal,
    // Production adapters delegate their actual spawn here. The scope, rather
    // than a best-effort PID observer, owns the one irreversible spawn boundary.
    spawn(command, args, options) {
      if (state.settled || state.spawnClosed) refuse('batch-member-scope-closed', member.task_id);
      if (state.spawnAttempted || state.child) refuse('batch-member-writer-exists', member.task_id);
      try { leaseCheckpoint({ stage: 'spawn', required_ms:require('./forge-worker-timeout').ceilingFromRoute(request.route).ms+JOIN_GRACE_MS+JOIN_KILL_MS }); }
      catch(error){error.provider_called=false;throw error;}
      state.spawnAttempted = true;
      let child;
      try { child = require('child_process').spawn(command, args, options); }
      catch (error) {
        state.spawnClosed = true;
        state.neverStartedReason = ['ENOENT','EACCES','ENOEXEC'].includes(error.code) ? error.code : null;
        throw error;
      }
      state.attemptedChild = child;
      if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
        // An ENOENT-style child is a real spawn attempt, never a fabricated
        // process. The broker subscribes to its actual error/close events.
        state.broker.observeMemberSpawnFailure(handle, child);
        child.once('error', error => {
          if (!child.pid && ['ENOENT','EACCES','ENOEXEC'].includes(error.code)) {
            state.spawnClosed = true; state.neverStartedReason = error.code;
          }
        });
        return child;
      }
      try { scope.attach(child); }
      catch (error) {
        // Retain the real child even when attachment is refused: the cohort
        // must terminate and join it before reporting the refusal.
        state.child = child; child.once('error', () => {}); terminate();
        error.provider_called = 'unknown'; throw error;
      }
      return child;
    },
    ownsSpawnAttempt(child) { return child === state.attemptedChild && state.spawnAttempted; },
    async joinWriter() {
      const child=state.child || state.attemptedChild;
      if (!child || !Number.isSafeInteger(child.pid) || child.pid<=0) refuse('batch-member-no-start-unproven', member.task_id);
      let joined=await joinedWithin(child,JOIN_GRACE_MS);
      if(!joined){terminate();joined=await joinedWithin(child,JOIN_KILL_MS);}
      if(!joined)refuse('batch-member-writer-live',member.task_id);
      return Object.freeze({joined:true,pid:child.pid});
    },
    closeWithoutSpawn(expectedHandle) {
      if (expectedHandle !== handle || !state.settled || !state.spawnClosed || state.child
          || !state.neverStartedReason) refuse('batch-member-no-start-unproven', member.task_id);
      return Object.freeze({ reason_code: state.neverStartedReason });
    },
    /** The member's ONE writer process, attached right after its spawn: the broker observes its exit. */
    attach(child) {
      if (state.settled || state.spawnClosed) refuse('batch-member-scope-closed', `${member.task_id} is no longer running`);
      if (!(child instanceof ChildProcess) || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
        refuse('batch-member-process-invalid', 'only a spawned child process is a member writer');
      }
      if (state.child === child) return state.attached;
      if (state.child) refuse('batch-member-writer-exists', `${member.task_id} already has its one writer`);
      if (!state.broker) refuse('batch-member-broker-required', `${member.task_id} has no open cohort broker`);
      state.attached = state.broker.attachMemberProcess(handle, child);
      state.child = child;
      if (state.aborted) terminate();
      return state.attached;
    },
  });
  const control = Object.freeze({
    batch_id: manifest.batch_id, member_index: member.index, task_id: member.task_id, dispatch_id: request.dispatchId,
    /** Cancels THIS member only: its AbortSignal and its own attached process tree. */
    abort(reason) {
      if (state.settled) return false;
      state.aborted = true;
      if (!controller.signal.aborted) controller.abort(typeof reason === 'string' && reason ? reason : 'batch-member-aborted');
      terminate();
      return true;
    },
    aborted() { return state.aborted; },
  });
  return { member, handle, request, state, scope, control, terminate, runtime: memberRuntime(member, stream), outcome: null, join: null };
}

// The closed row of one member in a run report.
function memberRow(member, fields) {
  return { index: member.index, task_id: member.task_id, unit: member.unit, dispatch_id: null, progress_state: null, outcome: 'blocked',
    reason_code: null, cause_code: null, provider_called: false, stage: null, member_ref: null, anchor_sha256: null, retained_ref: null,
    aborted: false, process: { pid: null, exit_code: null, signal: null, join: null }, ...fields };
}
function laneReport(lane) {
  const { member, state, outcome } = lane, child = state.child || state.attemptedChild;
  const base = { dispatch_id: lane.request.dispatchId, progress_state: 'admitido', aborted: state.aborted,
    process: { pid: child ? child.pid : null, exit_code: child ? child.exitCode : null, signal: child ? child.signalCode : null, join: lane.join } };
  if (!outcome || outcome.kind === 'skipped') return memberRow(member, { ...base, outcome: 'blocked', reason_code: 'batch-member-aborted' });
  if (outcome.kind === 'value') {
    const value = outcome.value;
    if (isObject(value) && ['partial','blocked'].includes(value.status) && value.stage === 'residual' && HASH.test(value.anchor_sha256 || '')) {
      return memberRow(member,{...base,outcome:value.pending_questions?.length?'needs-input':'blocked',result_status:value.status,
        reason_code:value.reason_code,reason:value.reason,pending_questions:value.pending_questions,provider_called:value.provider_called,
        stage:'residual',member_ref:value.member_ref,anchor_sha256:value.anchor_sha256,retained_ref:value.retained_ref});
    }
    if (isObject(value) && value.status === 'retained' && typeof value.anchor_sha256 === 'string' && HASH.test(value.anchor_sha256)) {
      return memberRow(member, { ...base, outcome: 'retained', provider_called: typeof value.provider_called === 'boolean' ? value.provider_called : 'unknown',
        stage: typeof value.stage === 'string' ? value.stage : null, member_ref: typeof value.member_ref === 'string' ? value.member_ref : null,
        anchor_sha256: value.anchor_sha256,
        retained_ref: isObject(value.retained_ref) ? { path: text(value.retained_ref.path), sha256: text(value.retained_ref.sha256) } : null });
    }
    // Before the barrier a member is retained or not delivered: never a done result.
    return memberRow(member, { ...base, outcome: 'failed', reason_code: 'batch-member-result-unexpected', provider_called: 'unknown' });
  }
  const code = errorCode(outcome.error, 'sidecar-unit-failed');
  const called = outcome.error && typeof outcome.error.provider_called === 'boolean' ? outcome.error.provider_called : 'unknown';
  if (state.aborted) return memberRow(member, { ...base, outcome: 'failed', reason_code: 'batch-member-aborted', cause_code: code, provider_called: called });
  if (NEEDS_INPUT_CODES.includes(code)) return memberRow(member, { ...base, outcome: 'needs-input', reason_code: code, provider_called: called });
  return memberRow(member, { ...base, outcome: called === false ? 'blocked' : 'failed', reason_code: code, provider_called: called });
}
// A member this run does not execute keeps its own progress as its typed outcome.
function heldReport(member, row) {
  const outcomes = { ack: 'acknowledged', falhou: 'failed', bloqueado: 'blocked', 'needs-input': 'needs-input' };
  const outcome = outcomes[row.state] || 'blocked';
  return memberRow(member, { progress_state: row.state, outcome,
    reason_code: outcome === 'acknowledged' ? null : outcomes[row.state] ? row.reason_code : 'batch-member-not-admitted' });
}
function runReport(manifest, fields) {
  return deepFreeze({ schema: RUN_SCHEMA, batch_id: manifest.batch_id, manifest_sha256: manifest.manifest_sha256, milestone: manifest.milestone,
    slice: manifest.slice, status: fields.status, reason_code: fields.reason_code, pool: fields.pool, broker: fields.broker,
    barrier: fields.barrier, members: [...fields.members].sort((left, right) => left.index - right.index) });
}

// The bounded limiter: never more than `limit` members in flight, started in manifest order as
// slots free. Every lane is awaited (allSettled); no lane can reject the pool or a sibling.
async function pooled(lanes, limit, run) {
  let next = 0;
  const worker = async () => {
    while (next < lanes.length) {
      const lane = lanes[next];
      next += 1;
      try { lane.outcome = await run(lane); } catch (error) { lane.outcome = { kind: 'error', error }; }
    }
  };
  await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(limit, lanes.length)) }, () => worker()));
}
// The real join of every attached writer, once every member settled: its observed exit and its
// pid gone. A writer still alive after its grace is terminated (its own tree only) and joined again.
async function joinWriters(lanes) {
  for (const lane of lanes) {
    const child = lane.state.child || lane.state.attemptedChild;
    if (!child || !Number.isSafeInteger(child.pid) || child.pid<=0) {
      lane.join = lane.state.spawnClosed || !lane.state.started ? 'not-started' : 'unknown'; continue;
    }
    let joined = await joinedWithin(child, JOIN_GRACE_MS);
    if (!joined) { lane.terminate(); joined = await joinedWithin(child, JOIN_KILL_MS); }
    lane.join = joined ? 'joined' : 'live';
  }
}
// The barrier from the broker's own process observations; a possible live writer keeps it closed
// and any broker refusal (a member without an observed writer, an outcome without its anchor) is
// reported with its own code, never forced.
async function sealBarrier(broker, cohort, lanes) {
  if (lanes.some(lane => ['live','unknown'].includes(lane.join))) return { sealed: false, sha256: null, reason_code: 'batch-member-writer-live' };
  try {
    const record = await broker.sealExecutionBarrier(cohort, lanes.map(lane => ({ handle: lane.handle,
      outcome: laneReport(lane).outcome === 'retained' ? 'retained' : laneReport(lane).stage === 'residual' ? 'residual' : lane.state.aborted ? 'interrupted' : 'failed' })));
    return { sealed: true, sha256: codeRoots().digest(record), reason_code: null };
  } catch (error) { return { sealed: false, sha256: null, reason_code: errorCode(error, 'batch-barrier-unsealed') }; }
}

/**
 * Issue 343 U4: runs one admitted cohort through the bounded pool (the engine of the CLI).
 *
 * @param {{ cwd, milestone, host_runtime, owner_token, batch_id, manifest_sha256, run_id, code_root? }} scope
 * @param {{ members, stream?, signal?, onMemberControl?, prefsReader?, routeResolver?, now?, failpoint?, isolationLimits? }} options
 *   trusted, in-process: `members` maps each admitido task ID to the host's own request fields
 *   (MEMBER_INPUT_KEYS); `onMemberControl` receives each member's control, whose abort cancels
 *   THAT member only; `signal` cancels every member (global shutdown); the other seams are the
 *   decision's own and can only tighten
 * @returns {Promise<object>} the typed run report: RUN_STATUSES and one MEMBER_OUTCOMES row per
 *   member. A refusal before the execution window throws, and then no provider was started.
 */
async function runCohort(scope, options = {}) {
  return autoGateContext(options, () => runCohortWithGate(scope, options));
}
async function runCohortWithGate(scope, options) {
  if (!isObject(scope) || typeof scope.batch_id !== 'string' || !BATCH_ID.test(scope.batch_id)
      || typeof scope.manifest_sha256 !== 'string' || !HASH.test(scope.manifest_sha256)) refuse('batch-not-active', 'no batch is named');
  for (const key of ['cwd', 'milestone', 'host_runtime', 'owner_token']) {
    if (typeof scope[key] !== 'string' || !scope[key] || scope[key].includes('\u0000')) refuse('batch-scope-invalid', `${key} is required`);
  }
  if (!isObject(options)) refuse('batch-scope-invalid', 'options must be an object');
  const external = options.signal !== undefined && options.signal !== null ? options.signal : null;
  const stopped = () => external !== null && external.aborted === true;
  if (stopped()) refuse('batch-run-aborted', 'the run was cancelled before any member started');
  const stream = isObject(options.stream) && typeof options.stream.write === 'function' ? options.stream : process.stderr;
  const owner = ownerOf(scope.cwd), manifest = readManifestAt(owner, scope.batch_id);
  if (!manifest) refuse('batch-manifest-invalid', 'the named batch has no published manifest');
  if (manifest.manifest_sha256 !== scope.manifest_sha256 || manifest.owner !== owner.key || manifest.milestone !== scope.milestone
      || manifest.host_runtime !== scope.host_runtime || manifest.owner_digest !== ownerDigest(scope.owner_token)) {
    refuse('batch-manifest-foreign', 'the named manifest belongs to another owner, milestone, host or owner token');
  }
  assertPreparationBeforeS0(owner, manifest, require('./forge-runs').get(owner.real, scope.run_id)?.batch_locator);
  // No new work: exactly the manifest's admitido members run, each once; the others keep their state.
  const progress = progressOf(owner, manifest);
  const admitted = manifest.members.filter(member => progress[member.index].state === 'admitido');
  const held = manifest.members.filter(member => progress[member.index].state !== 'admitido').map(member => heldReport(member, progress[member.index]));
  if (!admitted.length) refuse('batch-not-active', 'no admitido member is left to run');
  const inputs = memberInputs(admitted, options.members);
  const routes = new Map();
  for (const member of admitted) {
    const route = memberRoute(owner, manifest, member, options);
    if (!route) refuse('batch-member-route-stale', `${member.task_id} no longer resolves to the route its decision pinned`);
    routes.set(member.task_id, route);
  }
  // The resolved max_concurrent: the decision's limit, only ever tightened by the current canonical
  // clamp of forge-resources over the trusted prefs, and never above the members this run executes.
  const resolved = maxConcurrentOf({ cwd: owner.real }, options);
  const limit = Math.max(1, Math.min(manifest.limits.max_concurrent, resolved, admitted.length));
  const pool = { max_concurrent: limit, manifest_max_concurrent: manifest.limits.max_concurrent, resolved_max_concurrent: resolved, peak_in_flight: 0 };
  // Everything before S0: the members' leases, then their isolation (worktrees, indexes, base,
  // aggregate claim and locator), then each exact attempt binding.
  renewLeases(owner, manifest, admitted, scope.owner_token, scope.run_id);
  const coverage = cohortCoverage(owner, manifest, admitted, routes, limit, scope);
  let leaseWindows = openCohortLeases(owner, manifest, admitted, scope.owner_token, coverage.preparation.duration_ms);
  const leaseCheckpoint = (check = {}) => {
    for (const window of leaseWindows) if (!window.check().ok
        || (Number.isFinite(check.required_ms) && Date.now() + check.required_ms >= window.deadline_at)) {
      refuse('batch-lease-coverage-insufficient', 'the exact owner/generation or preparation window no longer covers ' + (check.stage || 'execution'));
    }
  };
  try {
  const placed = new Map();
  const prepared = prepareIsolation(scope, { failpoint: options.failpoint, isolationLimits: options.isolationLimits, leaseCheckpoint,
    ...(typeof options.dependencyRunner === 'function' ? { dependencyRunner: options.dependencyRunner } : {}),
    onMember: (handle, data) => placed.set(data.member_index, { handle, data }) });
  if (prepared.status !== 'prepared') {
    return runReport(manifest, { status: 'serial', reason_code: prepared.reason_code, pool, broker: null,
      barrier: { sealed: false, sha256: null, reason_code: null },
      members: [...admitted.map(member => memberRow(member, { dispatch_id: inputs.get(member.task_id).dispatchId, progress_state: 'admitido',
        reason_code: prepared.reason_code })), ...held] });
  }
  const runs = require('./forge-runs'), lanes = [];
  for (const member of admitted) {
    const entry = placed.get(member.index);
    if (!entry || entry.data.task_id !== member.task_id) refuse('batch-cohort-incomplete', `${member.task_id} was not prepared`);
    const planFile = path.join(owner.real, ...member.plan.path.split('/'));
    const contract = validateMemberPlan(entry.handle, fs.readFileSync(planFile)).checked_runtime_plan.contract;
    const primary = contract.code_roots.find(root => root.id === contract.primary_root_id);
    const parent = runs.get(owner.real, scope.run_id);
    if (!primary || !parent || !parent.write_claim) refuse('batch-member-handle-stale', `${member.task_id} has no live physical projection`);
    const controller = new AbortController();
    const request = { ...inputs.get(member.task_id), unitType: 'execute-task', scope: 'milestone', phase: 'execute',
      milestoneId: manifest.milestone, sliceId: manifest.slice, taskId: member.task_id, cwd: primary.path, contextRoot: owner.real, planFile,
      execution_contract: contract, runId: parent.id, claim: parent.write_claim, batch_id: manifest.batch_id, begin_key: entry.data.begin_key,
      lease_generation: entry.data.lease_generation, route: routes.get(member.task_id), signal: controller.signal };
    const lane = memberLane(manifest, member, entry.handle, request, controller, stream, leaseCheckpoint);
    lane.runtime.executionPlanGate = AUTO_GATE_CONTEXT.getStore()?.adapter;
    lanes.push(lane);
  }
  // Every exact attempt is checked whole before any is bound, so a refusal binds none.
  for (const lane of lanes) checkMemberRequest(memberState(lane.handle), lane.request);
  if (stopped()) refuse('batch-run-aborted', 'the run was cancelled before any member started');
  for (const lane of lanes) bindMemberExecution(lane.handle, lane.request);
  leaseCheckpoint();
  leaseWindows.forEach(window=>window.close());
  leaseWindows = openCohortLeases(owner, manifest, admitted, scope.owner_token, coverage.execution.duration_ms);
  leaseCheckpoint();
  // S0: the one cohort broker over the closed registry of exactly these bound attempts.
  const { cohort, broker } = await openCohortBroker(scope, lanes.map(lane => lane.handle));
  for (const lane of lanes) lane.state.broker = broker;
  const shutdown = () => { for (const lane of lanes) lane.control.abort('shutdown'); };
  if (external) {
    if (external.aborted) shutdown();
    else external.addEventListener('abort', shutdown, { once: true });
  }
  if (typeof options.onMemberControl === 'function') {
    for (const lane of lanes) {
      try { options.onMemberControl(lane.control); } catch (_) { /* a host observer never controls the pool */ }
    }
  }
  let inFlight = 0, failure = null, barrier = { sealed: false, sha256: null, reason_code: 'batch-barrier-unsealed' };
  const execute = async lane => {
    if (lane.state.aborted) {
      lane.state.spawnClosed = true; lane.state.neverStartedReason = 'queue-cancelled';
      lane.state.settled = true; return { kind: 'skipped' };
    }
    lane.state.started = true;
    inFlight += 1;
    pool.peak_in_flight = Math.max(pool.peak_in_flight, inFlight);
    try {
      const call = { ...lane.request, memberHandle: lane.handle };
      return { kind: 'value', value: await withMemberAutoGate(call, () => PROCESS_SCOPES.run(lane.scope, () => unitSidecar().runUnitSidecar(call, lane.runtime))) };
    } catch (error) {
      // The canonical sidecar observed no transport entry, and every real
      // production spawn is fenced by the scope above. Data claiming false
      // cannot overrule an attempted/attached process.
      if (error.provider_called === false && !lane.state.spawnAttempted && !lane.state.child) {
        lane.state.spawnClosed = true; lane.state.neverStartedReason = 'pre-spawn-refused';
      }
      return { kind: 'error', error };
    }
    finally { inFlight -= 1; lane.state.settled = true; }
  };
  try {
    await pooled(lanes, limit, execute);
    await joinWriters(lanes);
    leaseCheckpoint({ stage: 'joined-barrier' });
    for (const lane of lanes) if (!lane.state.child && lane.state.spawnClosed) {
      PROCESS_SCOPES.run(lane.scope, () => broker.closeMemberWithoutWriter(lane.handle));
    }
    barrier = await sealBarrier(broker, cohort, lanes);
  } catch (error) {
    failure = error;
    shutdown();
    try { await joinWriters(lanes); } catch (_) { /* the report keeps the barrier closed */ }
  } finally {
    if (external) external.removeEventListener('abort', shutdown);
    try { await closeCohortBroker(cohort); } catch (_) { /* the durable cohort evidence stays verifiable */ }
  }
  const rows = lanes.map(laneReport), retained = rows.filter(row => row.outcome === 'retained').length;
  const outcome = failure || !barrier.sealed ? 'blocked' : retained === rows.length ? 'retained' : retained ? 'partial' : 'failed';
  return runReport(manifest, { status: outcome, reason_code: failure ? errorCode(failure, 'batch-run-failed') : barrier.sealed ? null : barrier.reason_code,
    pool, broker: { directory: broker.directory, manifest_sha256: broker.manifest_sha256 }, barrier, members: [...rows, ...held] });
  } finally { leaseWindows.forEach(window=>window.close()); }
}

// ── Serial consolidation, publication, ACK and cleanup (issue 343 U5, B5) ─────
//
// consolidateCohort is the post-barrier coordinator of one cohort and the engine of the CLI
// `consolidate --batch <ref> --request <file>`, in the run's own process or in a fresh one. It never
// selects work and never calls a provider. From the sealed root evidence, trusted only through the
// broker manifest digest the run reported, it starts a successor signing generation of the cohort
// broker (forge-artifact-reconciliation resumeBatchBroker), restores each retained member's exact bound
// attempt (its lease still reserved by the same begin, its one writer joined by the barrier) and then,
// member by member in manifest order: verifies (forge-unit-sidecar verifyRetainedExecution, the real
// completion core), checks the integration target, publishes (one typed member-artifacts operation
// through the canonical publisher, task marker last), integrates the verified delta into the run's
// integration target (forge-isolation integrateBatchMember: original preconditions plus the deltas
// already consolidated; never the index, HEAD or a commit), rechecks the whole integrated delivery and
// acknowledges (one typed controller-terminal operation through forge-unit-controller's own transaction,
// then the ack progress). Every owner change is a typed operation signed before its first effect and
// committed after its readback, so a crash anywhere is resumed by running the consolidation again: zero
// inference, and no second publication, delta, commit or ACK. A failed, interrupted or needs-input member
// keeps its residual explicit (receipts, response, worktree, begin and lease untouched) and never blocks a
// healthy sibling; an integration conflict stops the consolidation with nothing integrated for that
// member. The cleanup plans and retains (forge-isolation planBatchCleanup / cleanupBatchMember).

const CONSOLIDATION_SCHEMA = 'forge-execution-batch-consolidation-v1';
const CONSOLIDATE_REQUEST_SCHEMA = 'forge-execution-batch-consolidate-request-v1';
const CONSOLIDATE_REQUEST_KEYS = Object.freeze([...RUN_REQUEST_KEYS, 'broker_manifest_sha256', 'memory_publications']);
// The closed status of a consolidation and the closed outcome of each of its members.
const CONSOLIDATION_STATUSES = Object.freeze(['consolidated', 'partial', 'failed', 'conflict']);
const CONSOLIDATION_OUTCOMES = Object.freeze(['acknowledged', 'failed', 'needs-input', 'pending']);
const CONSOLIDATION_REASON_CODES = Object.freeze(['member-failed', 'member-interrupted', 'member-needs-input',
  'member-verification-failed', 'integration-target-moved', 'integration-conflict', 'integration-recheck-failed',
  'consolidation-stopped']);
// Closed refusals of the consolidation itself (the broker, sidecar and isolation keep their own codes).
const CONSOLIDATION_REFUSAL_CODES = Object.freeze(['batch-consolidation-request-invalid', 'batch-barrier-required',
  'batch-member-restore-refused', 'batch-member-delta-invalid', 'batch-operation-unexpected',
  'batch-consolidation-busy', 'batch-consolidation-cleanup-unproven', 'batch-consolidation-lock-lost',
  'batch-retirement-pending', 'batch-retirement-stale', 'batch-retirement-owner-drift', 'batch-post-unit-invalid', 'batch-post-unit-stale', 'batch-post-unit-pending']);
// Named in-process failpoints (a trusted test seam: the callback may throw to simulate a crash).
const CONSOLIDATION_FAILPOINTS = Object.freeze(['consolidation-progress-intent', 'consolidation-progress-applied',
  'consolidation-member-verified', 'member-artifacts-intent', 'member-artifacts-applied', 'member-artifacts-committed',
  'member-integrated', 'controller-terminal-intent', 'controller-terminal-applied', 'member-acknowledged',
  'claim-mutation-intent', 'claim-mutation-applied', 'claim-mutation-before-commit',
  'post-unit-intent', 'post-unit-applied', 'post-unit-before-commit']);
const PROGRESS_PRODUCER = 'forge-execution-batch.progress';
const ARTIFACTS_PRODUCER = 'forge-unit-sidecar.publishRetainedMember';
const TERMINAL_PRODUCER = 'forge-unit-controller.batch-terminal';
// A restored member handle only still verifies or publishes; later steps need no member handle.
const RESTORABLE_STATES = Object.freeze(['admitido', 'executando', 'retido', 'publicacao-pendente']);

/**
 * The live consolidation cohort (forge-isolation's only authority for integration and cleanup):
 * revalidated now, with each prepared member's current progress and physical roots. Data only.
 */
function resolveConsolidationCohort(handle) {
  const entry = handle !== null && typeof handle === 'object' ? HANDLES.get(handle) : undefined;
  if (!entry || entry.kind !== 'cohort' || !entry.consolidation) refuse('batch-cohort-handle-invalid', 'not a live consolidation cohort handle of forge-execution-batch');
  entry.revalidate();
  const { owner, manifest, record } = entry.consolidation;
  const progress = progressOf(owner, manifest);
  return deepFreeze(copy({ owner: owner.real, owner_key: owner.key, batch_id: manifest.batch_id, manifest_sha256: manifest.manifest_sha256,
    run_id: record.run_id, reservation: record.reservation, base: { package_sha256: record.base.package_sha256, batch_dir: record.base.batch_dir },
    claim: record.claim, members: record.members.map(member => ({ member_index: member.member_index, task_id: member.task_id,
      state: progress[member.member_index].state, roots: member.roots.map(root => ({ root_id: root.root_id, path: root.path, branch: root.branch })) })) }));
}
// One consolidation cohort handle over the published manifest, isolation record and parent claim.
function consolidationCohort(owner, manifest, record) {
  const cohort = mintHandle('cohort', { owner: owner.real, batch_id: manifest.batch_id, manifest_sha256: manifest.manifest_sha256,
    isolation_sha256: record.isolation_sha256, run_id: record.run_id, claim: { generation: record.claim.generation, sha256: codeRoots().digest(record.claim) },
    batch_dir: record.base.batch_dir, union_roots: record.claim.execution_contract.code_roots.map(root => root.path), members: [] },
  () => cohortLive(owner, manifest, record, HANDLES.get(cohort)?.retirement));
  HANDLES.get(cohort).consolidation = { owner, manifest, record };
  return cohort;
}
// The named batch of a consolidation or cleanup scope: its manifest and isolation record.
function consolidationScope(scope) {
  if (!isObject(scope) || typeof scope.batch_id !== 'string' || !BATCH_ID.test(scope.batch_id)
      || typeof scope.manifest_sha256 !== 'string' || !HASH.test(scope.manifest_sha256)) refuse('batch-not-active', 'no batch is named');
  for (const key of ['cwd', 'milestone', 'host_runtime', 'owner_token']) {
    if (typeof scope[key] !== 'string' || !scope[key] || scope[key].includes('\u0000')) refuse('batch-scope-invalid', `${key} is required`);
  }
  if (typeof scope.run_id !== 'string' || !RUN_ID.test(scope.run_id)) refuse('batch-scope-invalid', 'run_id is required');
  const owner = ownerOf(scope.cwd), manifest = readManifestAt(owner, scope.batch_id);
  if (!manifest) refuse('batch-manifest-invalid', 'the named batch has no published manifest');
  if (manifest.manifest_sha256 !== scope.manifest_sha256 || manifest.owner !== owner.key || manifest.milestone !== scope.milestone
      || manifest.host_runtime !== scope.host_runtime || manifest.owner_digest !== ownerDigest(scope.owner_token)) {
    refuse('batch-manifest-foreign', 'the named manifest belongs to another owner, milestone, host or owner token');
  }
  const record = readIsolation(owner, manifest);
  if (!record || record.run_id !== scope.run_id) refuse('batch-isolation-record-invalid', 'the batch has no physical isolation record of this run');
  return { owner, manifest, record };
}

// The exact progress records of a set of transitions, chained on the current chains, at one instant.
function progressEntries(owner, manifest, transitions, at) {
  const chains = new Map(), entries = [];
  for (const transition of transitions) {
    const member = manifest.members[transition.member_index];
    if (!member) refuse('batch-progress-invalid', `member ${transition.member_index} is not in the manifest`);
    if (!chains.has(member.index)) chains.set(member.index, [...readChain(owner, manifest, member)]);
    const chain = chains.get(member.index), last = chain.length ? chain[chain.length - 1] : null, current = last ? last.state : null;
    if (current !== transition.from || !(TRANSITIONS[current || ''] || []).includes(transition.to)) {
      refuse('batch-progress-conflict', `${member.task_id} is ${current || 'unrecorded'}, not ${transition.from || 'unrecorded'}`);
    }
    if (transition.reason_code !== null && !REASON_CODES.includes(transition.reason_code)) refuse('batch-progress-invalid', 'reason_code is not a closed reason');
    if (chain.length >= MAX_PROGRESS_ENTRIES) refuse('batch-progress-invalid', `${member.task_id} progress is full`);
    const content = { schema: PROGRESS_SCHEMA, batch_id: manifest.batch_id, member_index: member.index, task_id: member.task_id,
      sequence: chain.length + 1, state: transition.to, previous_state: current,
      previous_sha256: last ? last.entry_sha256 : manifest.manifest_sha256, reason_code: transition.reason_code, at };
    const record = { ...content, entry_sha256: digestOf(content) };
    chain.push(record);
    entries.push({ path: [...progressSegments(manifest.batch_id, member.index), `${pad(record.sequence)}.json`].join('/'), record });
  }
  return entries;
}
function progressBytes(record) { return Buffer.from(`${JSON.stringify(record)}\n`, 'utf8'); }
// Publishes exactly these records; a replay finds the very same bytes already there.
function applyProgress(owner, manifest, entries) {
  if (!Array.isArray(entries) || !entries.length) refuse('batch-operation-unexpected', 'a progress operation names no record');
  for (const entry of entries) {
    const record = isObject(entry) ? entry.record : null;
    if (!isObject(record) || record.batch_id !== manifest.batch_id || !manifest.members[record.member_index]) refuse('batch-operation-unexpected', 'a progress record names another batch');
    const segments = progressSegments(manifest.batch_id, record.member_index), name = `${pad(record.sequence)}.json`;
    if ([...segments, name].join('/') !== entry.path) refuse('batch-operation-unexpected', 'a progress record names another path');
    if (publishExclusive(owner, segments, name, record, MAX_PROGRESS_BYTES, 'batch-progress-invalid')) continue;
    if (!fs.readFileSync(path.join(owner.real, ...segments, name)).equals(progressBytes(record))) {
      refuse('batch-progress-conflict', `${record.task_id} progress ${record.sequence} holds another entry`);
    }
  }
}
// One typed batch-progress operation: the exact records in the signed intent, then their effects.
async function progressOperation(ctx, transitions) {
  if (!transitions.length) return null;
  const at = new Date(nowOf(ctx.options)).toISOString();
  const entries = progressEntries(ctx.owner, ctx.manifest, transitions, at);
  const intent = await ctx.broker.beginOwnerOperation(ctx.cohort, { species: 'batch-progress', member_ref: null,
    producer: { name: PROGRESS_PRODUCER, entries }, prepared_at: at,
    effects: entries.map(entry => ({ path: entry.path, before: null, after: { sha256: sha256(progressBytes(entry.record)) } })) });
  ctx.failpoint('consolidation-progress-intent');
  applyProgress(ctx.owner, ctx.manifest, entries);
  ctx.failpoint('consolidation-progress-applied');
  return ctx.broker.commitOwnerOperation(ctx.cohort, intent);
}

// The verified delta of one retained member: the verified files of its executed record, read from the
// immutable retained copy whose digest the broker's signed anchor binds (never the custodial response).
function memberDelta(ctx, row) {
  if (ctx.deltas.has(row.member_index)) return ctx.deltas.get(row.member_index);
  const anchor = row.anchor;
  if (!isObject(anchor) || typeof anchor.executed_sha256 !== 'string' || !HASH.test(anchor.executed_sha256)) {
    refuse('batch-member-delta-invalid', `${row.task_id} has no anchored execution`);
  }
  const bytes = retainedRead(path.join(ctx.record.base.batch_dir, RETAINED_DIRECTORY, `${row.member_ref}.executed.json`), 'batch-member-delta-invalid');
  if (!bytes || sha256(bytes) !== anchor.executed_sha256) refuse('batch-member-delta-invalid', `${row.task_id}: the anchored executed record changed`);
  const executed = parsedRecord(bytes, 'batch-member-delta-invalid', 'the executed record is not JSON');
  const files = isObject(executed) && isObject(executed.milestone_delivery) ? executed.milestone_delivery.verified_files : null;
  const modes = isObject(executed) && isObject(executed.milestone_delivery) ? executed.milestone_delivery.verified_modes : null;
  const placed = ctx.record.members.find(member => member.member_index === row.member_index);
  if (!isObject(files) || !isObject(modes) || JSON.stringify(Object.keys(files).sort()) !== JSON.stringify(Object.keys(modes).sort()) || !placed) refuse('batch-member-delta-invalid', `${row.task_id} has no verified delta`);
  const delta = Object.entries(files).map(([qualified, value]) => {
    const at = qualified.indexOf('::'), rootId = at > 0 ? qualified.slice(0, at) : '', relative = at > 0 ? qualified.slice(at + 2) : '';
    if (!rootId || !relative || !placed.roots.some(root => root.root_id === rootId) || (value !== null && (typeof value !== 'string' || !HASH.test(value)))) {
      refuse('batch-member-delta-invalid', `${row.task_id}: a verified path is not one of its roots`);
    }
    const exec = modes[qualified];
    if ((value === null && exec !== null) || (value !== null && (process.platform === 'win32' ? exec !== null : typeof exec !== 'boolean'))) {
      refuse('batch-member-delta-invalid', `${row.task_id}: a verified executable mode is missing or invalid`);
    }
    return { root_id: rootId, path: relative, sha256: value, exec };
  }).sort((left, right) => `${left.root_id}::${left.path}`.localeCompare(`${right.root_id}::${right.path}`));
  ctx.deltas.set(row.member_index, delta);
  return delta;
}
// Every delta already integrated into the target (integrado or ack), optionally without one member.
function consolidatedDeltas(ctx, exceptIndex) {
  const progress = progressOf(ctx.owner, ctx.manifest), rows = [];
  for (const lane of ctx.lanes) {
    if (lane.member.index === exceptIndex || !['integrado', 'ack'].includes(progress[lane.member.index].state)) continue;
    rows.push(...memberDelta(ctx, lane.row));
  }
  return rows;
}
// An observation of the member's own attempt channel (never authority): its recorded failure code.
function failureCode(lane) {
  try {
    const bytes = retainedRead(`${lane.inputs.resultFile}.receipt.json`, 'batch-retained-invalid');
    const receipt = bytes ? parsedRecord(bytes, 'batch-retained-invalid', 'the receipt is not JSON') : null;
    const code = isObject(receipt) && receipt.phase === 'failed' && isObject(receipt.failure) ? receipt.failure.reason_code : null;
    return typeof code === 'string' && ERROR_CODE.test(code) ? code : null;
  } catch (_) { return null; }
}

// A host-only restoration of one retained member's exact bound attempt after the barrier: its one
// writer joined (the barrier's pid is gone), its roots still its registered worktrees, the request
// rebuilt from the owner records and the host's own fields must be the saved attempt byte for byte.
// The handle never provisions, and its lease is the reservation of its begin even past its TTL.
function restoreMember(ctx, lane, route) {
  const { owner, manifest, record, scope } = ctx, member = lane.member;
  const data = record.reservation.members.find(row => row.member_index === member.index);
  const placed = record.members.find(row => row.member_index === member.index);
  if (!data || !placed || data.task_id !== member.task_id) refuse('batch-member-restore-refused', `${member.task_id} has no prepared reservation`);
  const process = lane.row.process;
  // readBatchEvidence verified this barrier's signature, member/anchor and actual observed exit.
  // A numeric PID can be reused after that join; it is not the identity of the historical writer.
  if (!ctx.evidence.barrier.sealed || lane.row.outcome !== 'retained' || !lane.row.anchor
      || !Number.isSafeInteger(process?.pid) || process.pid <= 0
      || !(Number.isSafeInteger(process.exit_code) || (typeof process.signal === 'string' && process.signal.length))) {
    refuse('batch-member-writer-live', `${member.task_id} has no signed terminal writer observation`);
  }
  for (const root of placed.roots) {
    const integration = record.integration_contract.code_roots.find(row => row.id === root.root_id);
    if (!integration || !isolation().validateWorktreeIdentity(integration.path, root.path, root.branch).ok) {
      refuse('batch-member-restore-refused', `${member.task_id}: ${root.root_id} is no longer its registered worktree`);
    }
  }
  const handle = mintHandle('member', { reservation: record.reservation, ...data },
    () => refuse('batch-member-restore-refused', 'a restored member handle never provisions'));
  const entry = HANDLES.get(handle);
  entry.isolation = record; entry.scope = { ...scope }; entry.postBarrier = true;
  entry.autoGateContext = AUTO_GATE_CONTEXT.getStore();
  const planFile = path.join(owner.real, ...member.plan.path.split('/'));
  const runtime = validateMemberPlan(handle, fs.readFileSync(planFile)).checked_runtime_plan.contract;
  const primary = runtime.code_roots.find(root => root.id === runtime.primary_root_id);
  const parent = require('./forge-runs').get(owner.real, scope.run_id);
  if (!primary || !parent || !parent.write_claim) refuse('batch-member-handle-stale', `${member.task_id} has no live physical projection`);
  const request = { ...copy(lane.inputs), unitType: 'execute-task', scope: 'milestone', phase: 'execute', milestoneId: manifest.milestone,
    sliceId: manifest.slice, taskId: member.task_id, cwd: primary.path, contextRoot: owner.real, planFile, execution_contract: runtime,
    runId: parent.id, claim: parent.write_claim, batch_id: manifest.batch_id, begin_key: data.begin_key, lease_generation: data.lease_generation,
    route, signal: new AbortController().signal };
  const prior = readRecord(owner, [...BATCH_SEGMENTS, manifest.batch_id, 'attempts'], `member-${member.index}.json`, MAX_PROGRESS_BYTES, 'batch-member-attempt-invalid');
  if (!prior || prior.dispatch_id !== request.dispatchId || prior.request_sha256 !== memberRequestDigest(request)) {
    refuse('batch-member-request-mismatch', `${member.task_id}: the restored request is not the saved attempt`);
  }
  bindMemberExecution(handle, request);
  return { handle, request };
}

// The in-flight operation of an interrupted consolidation, finished exactly by its own producer
// (the signed intent carries what each needs), then committed after its readback.
async function finishPending(ctx) {
  const pending = ctx.broker.pendingOperation();
  if (!pending) return;
  const { payload, record } = pending, producer = isObject(payload.producer) ? payload.producer : {};
  if (payload.species === 'batch-progress' && producer.name === PROGRESS_PRODUCER) applyProgress(ctx.owner, ctx.manifest, producer.entries);
  else if (payload.species === 'member-artifacts' && producer.name === ARTIFACTS_PRODUCER) {
    const lane = ctx.lanes.find(row => row.row.member_ref === payload.member_ref);
    if (!lane || !lane.handle) refuse('batch-operation-unexpected', 'the in-flight publication names no restored member');
    await withMemberAutoGate(lane.request, () => unitSidecar().publishRetainedMember({ ...lane.request, memberHandle: lane.handle }, {}));
  } else if (payload.species === 'controller-terminal' && producer.name === TERMINAL_PRODUCER) {
    controller().commitBatchTerminal(ctx.owner.real, producer.request, ctx.scope.owner_token, ctx.controllerOptions);
  } else if (payload.species === 'claim-mutation' && producer.name === RETIRE_PRODUCER) {
    HANDLES.get(ctx.cohort).retirement = producer;
    applyRetirement(ctx, producer);
    ctx.failpoint('claim-mutation-before-commit');
  } else if (payload.species === 'post-unit' && producer.name === POST_UNIT_PRODUCER) applyPostUnit(ctx, producer);
  else refuse('batch-operation-unexpected', `no producer of this consolidation replays a ${payload.species} operation`);
  await ctx.broker.commitOwnerOperation(ctx.cohort, record);
}
// The barrier's real outcome of each member still admitido, in one batch-progress operation.
async function recordBarrier(ctx) {
  const progress = progressOf(ctx.owner, ctx.manifest), transitions = [];
  for (const lane of ctx.lanes) {
    const index = lane.member.index;
    if (progress[index].state !== 'admitido') continue;
    transitions.push({ member_index: index, from: 'admitido', to: 'executando', reason_code: null });
    if (lane.row.outcome === 'retained') transitions.push({ member_index: index, from: 'executando', to: 'retido', reason_code: null });
    else if (lane.row.outcome === 'residual') transitions.push({ member_index:index,from:'executando',to:lane.row.pending_questions.length?'needs-input':'bloqueado',reason_code:lane.row.pending_questions.length?'pending-question':null });
    else if (lane.row.outcome === 'failed' && NEEDS_INPUT_CODES.includes(failureCode(lane))) {
      transitions.push({ member_index: index, from: 'executando', to: 'needs-input', reason_code: 'pending-question' });
    } else transitions.push({ member_index: index, from: 'executando', to: 'falhou', reason_code: null });
  }
  await progressOperation(ctx, transitions);
}
// One member's typed member-artifacts operation through the canonical publisher (marker last).
async function publishMember(ctx, lane) {
  const request = { ...lane.request, memberHandle: lane.handle };
  const prepared = await unitSidecar().retainedPublication(request, {});
  const intent = await ctx.broker.beginOwnerOperation(ctx.cohort, { species: 'member-artifacts', member_ref: lane.row.member_ref,
    producer: { name: ARTIFACTS_PRODUCER, task_id: lane.member.task_id, ready_sha256: prepared.ready_sha256 }, effects: prepared.effects,
    prepared_at: new Date(nowOf(ctx.options)).toISOString() });
  ctx.failpoint('member-artifacts-intent');
  await unitSidecar().publishRetainedMember(request, {});
  ctx.failpoint('member-artifacts-applied');
  await ctx.broker.commitOwnerOperation(ctx.cohort, intent);
  lane.ready_sha256 = prepared.ready_sha256;
  ctx.failpoint('member-artifacts-committed');
}
// One member's typed controller-terminal operation: the controller's own complete transaction of
// exactly its begin and lease, at the instant the signed intent pinned.
async function terminalOperation(ctx, lane) {
  const ctl = controller(), member = lane.member;
  const input = { milestone: ctx.manifest.milestone, unit: member.unit, begin_key: member.begin_key, host_runtime: ctx.manifest.host_runtime,
    prepared_at: new Date(nowOf(ctx.options)).toISOString(),
    output: { batch_id: ctx.manifest.batch_id, member_ref: lane.row.member_ref, task_id: member.task_id } };
  const prepared = ctl.prepareBatchTerminal(ctx.owner.real, input, ctx.scope.owner_token, ctx.controllerOptions);
  const intent = await ctx.broker.beginOwnerOperation(ctx.cohort, { species: 'controller-terminal', member_ref: lane.row.member_ref,
    producer: { name: TERMINAL_PRODUCER, request: prepared.request }, effects: prepared.effects, prepared_at: prepared.prepared_at });
  ctx.failpoint('controller-terminal-intent');
  ctl.commitBatchTerminal(ctx.owner.real, prepared.request, ctx.scope.owner_token, ctx.controllerOptions);
  ctx.failpoint('controller-terminal-applied');
  await ctx.broker.commitOwnerOperation(ctx.cohort, intent);
}
function stopOf(lane, verdict, reason) {
  return { task_id: lane.member.task_id, reason_code: reason || (BATCH_CONFLICTS.includes(verdict.reason_code) ? verdict.reason_code : 'integration-conflict'),
    root_id: typeof verdict.root_id === 'string' ? verdict.root_id : null, path: typeof verdict.path === 'string' ? verdict.path : null };
}
const BATCH_CONFLICTS = Object.freeze(['integration-target-moved', 'integration-conflict', 'integration-mode-unsupported']);
// One member, from its current progress state on: every step is skipped once recorded, so a restart
// resumes exactly where the durable records stand. Returns a stop (conflict) or null.
async function consolidateMember(ctx, lane) {
  const index = lane.member.index, state = () => progressOf(ctx.owner, ctx.manifest)[index].state;
  if (lane.row.outcome !== 'retained') return null;
  if (state() === 'retido') {
    if (!lane.handle) refuse('batch-member-restore-refused', `${lane.member.task_id} was not restored`);
    try {
      lane.verified = await withMemberAutoGate(lane.request, () => unitSidecar().verifyRetainedExecution({ ...lane.request, memberHandle: lane.handle }, {}));
    } catch (error) {
      if (errorCode(error, '') !== 'execution-verification-failed') throw error;
      // A failing capture never becomes ready, nor a second inference: the residual stays explicit.
      await progressOperation(ctx, [{ member_index: index, from: 'retido', to: 'verificacao-falhou', reason_code: null },
        { member_index: index, from: 'verificacao-falhou', to: 'falhou', reason_code: null }]);
      lane.reason_code = 'member-verification-failed';
      return null;
    }
    ctx.failpoint('consolidation-member-verified');
    // Before anything is published: the target holds exactly the base plus the consolidated deltas.
    const check = isolation().checkBatchIntegration(ctx.cohort, { consolidated: consolidatedDeltas(ctx, index),
      member: { member_index: index, delta: memberDelta(ctx, lane.row) } });
    if (check.status !== 'ready') return stopOf(lane, check);
    await progressOperation(ctx, [{ member_index: index, from: 'retido', to: 'publicacao-pendente', reason_code: null }]);
  }
  if (state() === 'publicacao-pendente') {
    // A publication already committed in the signed journal is never repeated (crash after its commit).
    if (!committedOperation(ctx, 'member-artifacts', lane.row.member_ref)) {
      if (!lane.handle) refuse('batch-member-restore-refused', `${lane.member.task_id} was not restored`);
      await publishMember(ctx, lane);
    }
    await progressOperation(ctx, [{ member_index: index, from: 'publicacao-pendente', to: 'publicado', reason_code: null }]);
  }
  if (state() === 'publicado') {
    const integrated = isolation().integrateBatchMember(ctx.cohort, { consolidated: consolidatedDeltas(ctx, index),
      member: { member_index: index, delta: memberDelta(ctx, lane.row) } });
    if (integrated.status !== 'integrated') return stopOf(lane, integrated);
    lane.integration = { applied: [...integrated.applied], already: [...integrated.already] };
    ctx.failpoint('member-integrated');
    await progressOperation(ctx, [{ member_index: index, from: 'publicado', to: 'integrado', reason_code: null }]);
  }
  if (state() === 'integrado') {
    // A controller terminal already committed in the signed journal is never repeated either.
    if (!committedOperation(ctx, 'controller-terminal', lane.row.member_ref)) {
      // The whole integrated delivery (every consolidated delta) is rechecked before this ACK.
      const recheck = isolation().checkBatchIntegration(ctx.cohort, { consolidated: consolidatedDeltas(ctx, null) });
      if (recheck.status !== 'ready') return stopOf(lane, recheck, 'integration-recheck-failed');
      lane.recheck = 'verified';
      await terminalOperation(ctx, lane);
    }
    await progressOperation(ctx, [{ member_index: index, from: 'integrado', to: 'ack', reason_code: null }]);
    ctx.failpoint('member-acknowledged');
  }
  return null;
}
function committedOperation(ctx, species, memberRef) {
  return ctx.broker.operations().committed.some(entry => entry.species === species && entry.member_ref === memberRef);
}
function memberReason(lane, state, outcome, stop) {
  if (outcome === 'acknowledged') return null;
  if (outcome === 'needs-input') return 'member-needs-input';
  if (outcome === 'failed') {
    if (lane.reason_code) return lane.reason_code;
    if (lane.row.outcome === 'retained') return state === 'falhou' ? 'member-verification-failed' : 'member-failed';
    return lane.row.outcome === 'interrupted' ? 'member-interrupted' : 'member-failed';
  }
  if (stop && stop.task_id === lane.member.task_id) return stop.reason_code;
  return stop ? 'consolidation-stopped' : null;
}
// Replays can skip verification and publication entirely. Their READY pin still comes from the
// original signed publication intent, never from the current mutable external receipt channel.
function publishedReadySha(ctx, lane) {
  const publication = ctx.broker.memberPublication(lane.row.member_ref);
  if (!publication) return lane.verified?.ready_sha256 || null;
  const producer = publication.producer;
  if (producer?.name !== ARTIFACTS_PRODUCER || producer.task_id !== lane.member.task_id || !HASH.test(producer.ready_sha256 || '')
      || (lane.verified && lane.verified.ready_sha256 !== producer.ready_sha256)) {
    refuse('batch-operation-unexpected', 'the committed publication does not bind this member READY');
  }
  return producer.ready_sha256;
}
function consolidationReport(ctx, stop, cleanup) {
  const progress = progressOf(ctx.owner, ctx.manifest);
  const members = ctx.lanes.map(lane => {
    const state = progress[lane.member.index].state;
    const outcome = state === 'ack' ? 'acknowledged' : state === 'needs-input' ? 'needs-input' : ['falhou', 'bloqueado'].includes(state) ? 'failed' : 'pending';
    return { index: lane.member.index, task_id: lane.member.task_id, unit: lane.member.unit, member_ref: lane.row.member_ref,
      barrier_outcome: lane.row.outcome, progress_state: state, outcome, reason_code: memberReason(lane, state, outcome, stop),
      ready_sha256: publishedReadySha(ctx, lane), integration: lane.integration || null,
      recheck: lane.recheck || null };
  });
  const acknowledged = members.filter(member => member.outcome === 'acknowledged').length;
  const status = stop ? 'conflict' : acknowledged === members.length ? 'consolidated' : acknowledged ? 'partial' : 'failed';
  const operations = ctx.broker.operations();
  return deepFreeze({ schema: CONSOLIDATION_SCHEMA, batch_id: ctx.manifest.batch_id, manifest_sha256: ctx.manifest.manifest_sha256,
    milestone: ctx.manifest.milestone, slice: ctx.manifest.slice, status, reason_code: stop ? stop.reason_code : null,
    conflict: stop ? { task_id: stop.task_id, root_id: stop.root_id, path: stop.path } : null,
    broker: { directory: ctx.broker.directory, manifest_sha256: ctx.broker.manifest_sha256, generation: ctx.broker.generation,
      signer_sha256: ctx.broker.signer_sha256 },
    operations: { committed: operations.committed.length, pending: operations.pending, head_sha256: operations.head.sha256 },
    members: members.sort((left, right) => left.index - right.index), cleanup });
}
// The cleanup of a terminal (or interrupted) cohort: a plan per member root, removals only when admissible.
function cohortCleanup(cohort) {
  const plan = isolation().planBatchCleanup(cohort);
  return copy(plan.members.map(member => (member.roots.some(root => root.decision === 'removable')
    ? isolation().cleanupBatchMember(cohort, member.member_index) : member)));
}

/**
 * Issue 343 U5: the serial post-barrier consolidation of one cohort (the engine of the CLI
 * `consolidate`), in-process or in a fresh process; a rerun resumes from the durable records.
 *
 * @param {{ cwd, milestone, host_runtime, owner_token, batch_id, manifest_sha256, run_id }} scope
 * @param {{ members, broker_manifest_sha256, failpoint?, prefsReader?, routeResolver?, now? }} options trusted,
 *   in-process: `members` maps each barrier member's task ID to the host's own request fields of its run
 *   (the same ones), `broker_manifest_sha256` is the digest the run reported (the trust anchor)
 * @returns {Promise<object>} the typed consolidation report (CONSOLIDATION_STATUSES); a refusal throws
 */
// One canonical process mutex for the entire consolidation, not just its journal appends.
// It lives in the same external owner namespace as the broker, outside protected owner bytes.
function consolidationLock(owner, manifest) {
  const directory = path.join(require('os').tmpdir(), `forge-artifact-owner-${codeRoots().digest(codeRoots().key(owner.real))}`);
  fs.mkdirSync(path.join(directory, '.gsd'), { recursive: true });
  try { return require('./forge-lock').acquireProcessSync(directory, `batch-consolidation-${manifest.batch_id}`, { retries: 1 }); }
  catch (error) { if (error && error.code === 'LOCK_BUSY') refuse('batch-consolidation-busy', 'another live coordinator owns this cohort'); throw error; }
}
function brokerJoined(cleanup) {
  return isObject(cleanup) && cleanup.status === 'joined' && cleanup.active_processes === 0;
}
const POST_UNIT_PRODUCER = 'forge-execution-batch.post-unit';
const RETIRE_PRODUCER = 'forge-execution-batch.retire';
function postUnitRelative(ctx, index) { return '.gsd/forge/batches/' + ctx.manifest.batch_id + '/post-unit/m' + index + '.json'; }
function postUnitKey(ctx, retirement, member) {
  const row = retirement.row.post_unit.find(item => item.member_index === member.index && item.unit === member.unit);
  if (!row) refuse('batch-post-unit-invalid', 'the retirement does not queue this member');
  return row.key;
}
function readPostUnitSource(ctx, retirement, lane) {
  const expected = retirement.witness.report.members.find(item => item.index === lane.member.index);
  const file = lane.inputs.resultFile + '.receipt.json';
  for (const root of [ctx.owner.real, ...ctx.record.claim.execution_contract.code_roots.map(item => item.path)]) {
    require('./forge-xllm').validateResultFileTarget(lane.inputs.resultFile, root);
    if (codeRoots().within(root, path.resolve(file))) refuse('batch-post-unit-invalid', 'a result channel is inside a protected root');
  }
  const raw = retainedRead(file, 'batch-post-unit-invalid');
  if (!raw || !expected?.ready_sha256 || sha256(raw) !== expected.ready_sha256) refuse('batch-post-unit-invalid', 'the queued ready source changed');
  const ready = JSON.parse(raw);
  if (ready.phase !== 'ready' || ready.result?.status !== 'done' || ready.dispatch_id !== lane.row.dispatch_id
      || ready.delivery_capture?.passed !== true) refuse('batch-post-unit-invalid', 'a post-unit source is not the actual captured ready delivery');
  const summaryPath=lane.member.plan.path.replace(/-PLAN\.md$/,'-SUMMARY.md');
  const summaries=(ready.artifacts||[]).filter(item=>item.path===summaryPath);
  if(summaries.length!==1||typeof summaries[0].content!=='string')refuse('batch-post-unit-invalid','the canonical full summary is not retained');
  return { ready, summary:summaries[0].content, source: { file, sha256: expected.ready_sha256,
    fingerprint: codeRoots().digest({ retirement_id: retirement.row.retirement_id, member_ref: lane.row.member_ref, ready_sha256: expected.ready_sha256 }) } };
}
function postUnitTarget(ctx, relative) {
  if (!relative.startsWith('.gsd/') || relative.includes('\\') || relative.split('/').some(x => !x || x === '..' || x === '.')) refuse('batch-post-unit-invalid', 'invalid post-unit path');
  const target = path.join(ctx.owner.real, relative);
  let probe = target;
  while (probe !== ctx.owner.real) {
    if (fs.existsSync(probe) && fs.lstatSync(probe).isSymbolicLink()) refuse('batch-post-unit-invalid', 'a post-unit path is a link');
    probe = path.dirname(probe);
  }
  return target;
}
function preparedPostUnitEvent(ctx, key, index, event) {
  const relative = '.gsd/forge/events.jsonl', file = postUnitTarget(ctx, relative);
  const before = retainedRead(file, 'batch-post-unit-invalid');
  if (!before) refuse('batch-post-unit-invalid', 'the signed event stream is absent');
  const content = Buffer.from(JSON.stringify({ ...event, event_id: key + ':' + event.event,
    post_unit_key: key, batch_id: ctx.manifest.batch_id, member_index: index }) + '\n');
  const after = Buffer.concat([before, content]);
  return { content: content.toString('utf8'), descriptor: { path: relative, before_length: before.length,
    after_length: after.length, before_sha256: sha256(before), append_sha256: sha256(content), after_sha256: sha256(after) } };
}
function postUnitEffects(ctx, producer) {
  const effects = producer.decisions ? [{ path: path.relative(ctx.owner.real, producer.decisions.prepared.path).split(path.sep).join('/'),
    before: producer.decisions.prepared.before, after: { sha256: producer.decisions.prepared.after } }] : [];
  if (producer.memory?.prepared) effects.push({ path: path.relative(ctx.owner.real, producer.memory.prepared.path).split(path.sep).join('/'),
    before: producer.memory.prepared.before, after: { sha256: producer.memory.prepared.after } });
  for (const relative of producer.directories || []) {
    if (!['.gsd/forge/file-locks/','.gsd/memory/.locks/'].includes(relative)) refuse('batch-post-unit-invalid','unknown publisher lock directory');
    effects.push({path:relative,before:null,after:{directory:true}});
  }
  for (const a of producer.appends) effects.push({ path: a.path, before: a.before_sha256, after: { sha256: a.after_sha256 } });
  effects.push({ path: producer.relative, before: producer.before, after: { sha256: sha256(progressBytes(producer.ledger)) } });
  if (new Set(effects.map(effect => effect.path)).size !== effects.length) refuse('batch-post-unit-invalid', 'post-unit effects overlap');
  return effects;
}
function deferredMemoryTarget(ctx, lane) {
  const memory = require('./forge-memory'), storage_key = memory.qualifiedStorageKey(lane.member.task_id, ctx.manifest.milestone);
  const entries = memory.listFragments(ctx.owner.real, { milestoneId: ctx.manifest.milestone }).filter(item => item.storageKey === storage_key);
  if (entries.length !== 1 || entries[0].grouped !== true) refuse('batch-post-unit-invalid', 'the deferred memory target is not one canonical grouped member');
  const entry = entries[0], relative = path.relative(ctx.owner.real, entry.path).split(path.sep).join('/');
  const target = postUnitTarget(ctx, relative), before = retainedRead(target, 'batch-post-unit-invalid');
  if (!before) refuse('batch-post-unit-invalid', 'the deferred memory group is absent');
  const member_sha256 = sha256(Buffer.from(memory.readFragmentText(ctx.owner.real, entry)));
  const after = retainedRead(target, 'batch-post-unit-invalid');
  if (!after || sha256(after) !== sha256(before)) refuse('batch-post-unit-stale', 'the deferred memory group changed');
  return { path: relative, sha256: sha256(before), storage_key, member_sha256 };
}
function memoryPostUnitOutcome(memory) {
  return { receipt_file: memory.receipt_file, receipt_sha256: memory.receipt_sha256, publication: memory.publication,
    ...(memory.deferred_target ? { deferred_target: memory.deferred_target } : {}) };
}
function readMemoryPostUnit(ctx, lane, ledger, suppliedRef) {
  const ref = suppliedRef === undefined ? ctx.options.memory_publications?.[lane.member.task_id] : suppliedRef;
  if (!ref) return null;
  if (!isObject(ref) || Object.keys(ref).sort().join(',') !== 'file,sha256' || !path.isAbsolute(ref.file) || !HASH.test(ref.sha256)) refuse('batch-post-unit-invalid', 'a memory request needs an exact external file pin');
  const raw = retainedRead(ref.file, 'batch-post-unit-invalid');
  if (!raw || sha256(raw) !== ref.sha256) refuse('batch-post-unit-invalid', 'the memory request changed');
  const request = JSON.parse(raw);
  const source = readPostUnitSource(ctx, HANDLES.get(ctx.cohort).retirement, lane);
  if (codeRoots().key(fs.realpathSync(request.contextRoot || request.cwd)) !== ctx.owner.key
      || request.milestoneId !== ctx.manifest.milestone || request.sourceUnitType !== 'execute-task'
      || request.sourceUnitId !== lane.member.task_id || request.sourceFingerprint !== ledger.source.fingerprint
      || request.sourceResult !== JSON.stringify(source.ready.result) || request.summaryContent !== source.summary) refuse('batch-post-unit-invalid', 'the memory request is not bound to this queued ready source');
  const prepared = unitSidecar().prepareReadyMemoryPublication(request);
  let deferred_target;
  if (prepared.publication?.status === 'deferred') {
    if (prepared.publication.reason !== 'grouped-member' || prepared.prepared !== null || prepared.event !== null) refuse('batch-post-unit-invalid', 'unknown deferred memory publication');
    deferred_target = deferredMemoryTarget(ctx, lane);
  }
  const { request: ignored, ...record } = prepared;
  return { request_ref: copy(ref), ...record, ...(deferred_target ? { deferred_target } : {}) };
}
function applyPostUnit(ctx, producer) {
  return controller().withOwnerBoundary(ctx.owner.real, ({ noLeases }) => {
    if (!noLeases() || !retirementTerminal(ctx)) refuse('batch-post-unit-pending', 'all writers must remain stopped during post-unit publication');
    return applyPostUnitInside(ctx, producer);
  }, ctx.controllerOptions);
}
function applyPostUnitInside(ctx, producer) {
  const retirement = HANDLES.get(ctx.cohort).retirement;
  if (!retirement || producer.name !== POST_UNIT_PRODUCER || producer.batch_id !== ctx.manifest.batch_id
      || producer.retirement_id !== retirement.row.retirement_id || !Array.isArray(producer.appends)) refuse('batch-post-unit-invalid', 'foreign post-unit producer');
  // A settled attempt is not published memory. Revalidate its real READY and
  // canonical grouped target before any ledger, decision, directory or event effect.
  let deferredMemory = false;
  if (producer.kind === 'member' && producer.memory?.publication?.status === 'deferred') {
    const lane = ctx.lanes.find(item => item.member.index === producer.member_index);
    if (!lane) refuse('batch-post-unit-invalid', 'foreign deferred memory member');
    const current = readMemoryPostUnit(ctx, lane, producer.ledger, producer.memory.request_ref);
    if (!current || current.publication?.status !== 'deferred' || codeRoots().digest(current) !== codeRoots().digest(producer.memory)
        || producer.ledger.status !== 'complete' || codeRoots().digest(producer.ledger.memory) !== codeRoots().digest(memoryPostUnitOutcome(current))) refuse('batch-post-unit-stale', 'the deferred memory outcome changed');
    deferredMemory = true;
  }
  for (const relative of producer.directories || []) {
    if (!['.gsd/forge/file-locks/','.gsd/memory/.locks/'].includes(relative)) refuse('batch-post-unit-invalid','unknown publisher lock directory');
    const target=postUnitTarget(ctx,relative.slice(0,-1));
    if(fs.existsSync(target)){if(!fs.lstatSync(target).isDirectory())refuse('batch-post-unit-stale','publisher lock path changed');}
    else fs.mkdirSync(target,{recursive:true});
  }
  if (producer.kind === 'member') {
    const lane = ctx.lanes.find(item => item.member.index === producer.member_index);
    if (!lane || producer.key !== postUnitKey(ctx, retirement, lane.member) || producer.relative !== postUnitRelative(ctx, lane.member.index)
        || producer.ledger.key !== producer.key) refuse('batch-post-unit-invalid', 'foreign post-unit member');
    const source = readPostUnitSource(ctx, retirement, lane);
    if (codeRoots().digest(source.source) !== codeRoots().digest(producer.ledger.source)) refuse('batch-post-unit-invalid', 'queued source changed');
    if (producer.decisions) {
      if (codeRoots().digest(producer.decisions.fragment.decisions) !== codeRoots().digest(source.ready.result.key_decisions || [])) refuse('batch-post-unit-invalid', 'decisions are not from the result');
      require('./forge-decisions').applyPreparedFragment(ctx.owner.real, producer.decisions.fragment, producer.decisions.prepared);
    }
    if (producer.memory && !deferredMemory) {
      const raw = retainedRead(producer.memory.request_ref.file, 'batch-post-unit-invalid');
      if (!raw || sha256(raw) !== producer.memory.request_ref.sha256) refuse('batch-post-unit-invalid', 'memory request changed');
      unitSidecar().applyReadyMemoryPublication({ ...producer.memory, request: JSON.parse(raw) });
    }
  } else if (producer.kind === 'final') {
    if (producer.relative !== '.gsd/forge/batches/' + ctx.manifest.batch_id + '/post-unit-complete.json'
        || producer.key !== retirement.row.retirement_id + ':post-unit-complete' || producer.decisions || producer.memory || producer.appends.length) refuse('batch-post-unit-invalid', 'invalid post-unit final');
    for (const member of ctx.manifest.members) {
      const raw = retainedRead(postUnitTarget(ctx, postUnitRelative(ctx, member.index)), 'batch-post-unit-invalid');
      const ledger = raw && JSON.parse(raw);
      if (ledger?.status !== 'complete' || ledger.key !== postUnitKey(ctx, retirement, member)
          || producer.ledger.members[member.index]?.sha256 !== sha256(raw)) refuse('batch-post-unit-pending', 'a queued member has not completed housekeeping');
    }
  } else refuse('batch-post-unit-invalid', 'unknown post-unit producer kind');
  for (const append of producer.appends) {
    const file = postUnitTarget(ctx, append.path), raw = retainedRead(file, 'batch-post-unit-invalid');
    if (raw?.length === append.after_length && sha256(raw) === append.after_sha256) continue;
    if (!raw || raw.length !== append.before_length || sha256(raw) !== append.before_sha256
        || sha256(Buffer.from(producer.event_content)) !== append.append_sha256) refuse('batch-post-unit-stale', 'the event preimage changed');
    fs.appendFileSync(file, producer.event_content);
    if (sha256(retainedRead(file, 'batch-post-unit-invalid')) !== append.after_sha256) refuse('batch-post-unit-stale', 'the event readback changed');
  }
  const target = postUnitTarget(ctx, producer.relative), raw = retainedRead(target, 'batch-post-unit-invalid'), next = progressBytes(producer.ledger);
  if (raw && sha256(raw) === sha256(next)) return;
  if ((raw ? sha256(raw) : null) !== producer.before) refuse('batch-post-unit-stale', 'the queue changed');
  if (!raw) {
    if (!publishExclusive(ctx.owner, producer.relative.split('/').slice(0,-1), path.basename(producer.relative), producer.ledger, MAX_MANIFEST_BYTES, 'batch-post-unit-stale')) refuse('batch-post-unit-stale', 'the queue appeared');
  } else {
    require('./forge-yaml-safe').writeAtomic(target, next.toString('utf8'), { cwd:ctx.owner.real, runId:ctx.record.run_id });
    if (sha256(retainedRead(target, 'batch-post-unit-invalid')) !== sha256(next)) refuse('batch-post-unit-stale', 'the queue readback changed');
  }
}
async function postUnitOperation(ctx, producer) {
  const intent = await ctx.broker.beginOwnerOperation(ctx.cohort, { species: 'post-unit', member_ref: producer.member_ref || null,
    producer, effects: postUnitEffects(ctx, producer), prepared_at: producer.prepared_at });
  ctx.failpoint('post-unit-intent');
  applyPostUnit(ctx, producer);
  ctx.failpoint('post-unit-applied');
  ctx.failpoint('post-unit-before-commit');
  await ctx.broker.commitOwnerOperation(ctx.cohort, intent);
}
async function finishPostUnits(ctx, retirement) {
  HANDLES.get(ctx.cohort).retirement = retirement;
  for (const lane of ctx.lanes) {
    const relative = postUnitRelative(ctx, lane.member.index), raw = retainedRead(postUnitTarget(ctx, relative), 'batch-post-unit-invalid');
    let ledger = raw && JSON.parse(raw);
    if (ledger?.status === 'complete') continue;
    const key = postUnitKey(ctx, retirement, lane.member), source = readPostUnitSource(ctx, retirement, lane);
    if (ledger && (ledger.key !== key || codeRoots().digest(ledger.source) !== codeRoots().digest(source.source))) refuse('batch-post-unit-stale', 'the queued source changed');
    const at = ledger?.prepared_at || new Date(nowOf(ctx.options)).toISOString();
    const prefs = typeof ctx.options.prefsReader === 'function' ? ctx.options.prefsReader(ctx.owner.real) : require('./forge-prefs').readPrefs(ctx.owner.real);
    const policy = ledger?.memory_policy || require('./forge-cost-policy').decideMemory({ memory: (prefs.prefs || prefs).memory, unitType: 'execute-task', result: JSON.stringify(source.ready.result) });
    const decisions = !ledger && source.ready.result.key_decisions?.length ? (() => {
      const fragment = { unit_id: ctx.manifest.milestone, decisions: source.ready.result.key_decisions };
      return { fragment, prepared: require('./forge-decisions').prepareFragment(ctx.owner.real, fragment).prepared };
    })() : null;
    ledger ||= { schema: 'forge-batch-post-unit-v1', key, prepared_at: at, source: source.source,
      memory_policy: policy, status: policy.decision === 'extract' ? 'awaiting-memory' : 'complete', memory: null };
    const memory = policy.decision === 'extract' ? readMemoryPostUnit(ctx, lane, ledger) : null;
    if (memory) ledger = { ...ledger, status: 'complete', memory: memoryPostUnitOutcome(memory) };
    if (!raw || memory) {
      const event = !raw ? { ts: at, event: 'memory-policy', unit: lane.member.unit, decision: policy.decision, reason: policy.reason, mode: policy.mode }
        : memory.event;
      const preparedEvent = event ? preparedPostUnitEvent(ctx, key, lane.member.index, event) : null;
      await postUnitOperation(ctx, { name: POST_UNIT_PRODUCER, kind: 'member', batch_id: ctx.manifest.batch_id,
        retirement_id: retirement.row.retirement_id, key, member_index: lane.member.index, member_ref: lane.row.member_ref,
        relative, before: raw ? sha256(raw) : null, prepared_at: at, ledger, decisions, memory,
        directories:[...(decisions||memory?.prepared?['.gsd/forge/file-locks/']:[]),...(memory?.prepared?['.gsd/memory/.locks/']:[])].filter(relative=>!fs.existsSync(postUnitTarget(ctx,relative.slice(0,-1)))),
        appends: preparedEvent ? [preparedEvent.descriptor] : [], event_content: preparedEvent?.content || null });
    }
  }
  const members = ctx.manifest.members.map(member => {
    const file = postUnitRelative(ctx, member.index), raw = retainedRead(postUnitTarget(ctx, file), 'batch-post-unit-invalid');
    return { member_index: member.index, file, sha256: raw ? sha256(raw) : null, ledger: raw && JSON.parse(raw) };
  });
  if (members.some(row => row.ledger?.status !== 'complete')) return { status: 'pending', members: members.map(row => copy(row.ledger)) };
  const relative = '.gsd/forge/batches/' + ctx.manifest.batch_id + '/post-unit-complete.json';
  const ledger = { schema: 'forge-batch-post-unit-complete-v1', retirement_id: retirement.row.retirement_id,
    members: members.map(({ member_index, file, sha256 }) => ({ member_index, file, sha256 })) };
  const current = retainedRead(postUnitTarget(ctx, relative), 'batch-post-unit-invalid');
  if (!current) await postUnitOperation(ctx, { name: POST_UNIT_PRODUCER, kind: 'final', batch_id: ctx.manifest.batch_id,
    retirement_id: retirement.row.retirement_id, key: retirement.row.retirement_id + ':post-unit-complete', member_index: null,
    relative, before: null, prepared_at: new Date(nowOf(ctx.options)).toISOString(), ledger, appends: [], decisions: null, memory: null });
  else if (sha256(current) !== sha256(progressBytes(ledger))) refuse('batch-post-unit-stale', 'final queue witness changed');
  return { status: 'complete', members: members.map(row => copy(row.ledger)) };
}
function retirementTerminal(ctx) {
  const progress = progressOf(ctx.owner, ctx.manifest);
  return ctx.manifest.members.every(member => {
    if (progress[member.index].state !== 'ack') return false;
    const completed = controller().lookupRecord(ctx.owner.real, 'transaction', `${member.begin_key}:complete`);
    return completed?.phase === 'committed' && completed.action === 'complete'
      && completed.unit.key === member.unit && completed.result?.status === 'succeeded';
  });
}
function prepareRetirement(ctx, report) {
  const runApi = require('./forge-runs'), roots = codeRoots();
  return controller().withOwnerBoundary(ctx.owner.real, ({ noLeases }) => {
    if (!noLeases() || !retirementTerminal(ctx)) refuse('batch-retirement-pending', 'all member terminals and absent leases are required');
    return runApi.withRegistryFence(ctx.owner.real, guard => runApi.withRunLock(ctx.owner.real, ctx.record.run_id, () => {
      if (!noLeases()) refuse('batch-retirement-pending', 'a lease appeared');
      const run = runApi.get(ctx.owner.real, ctx.record.run_id);
      if (!run?.active || !run.batch_locator || run.batch_locator.batch_id !== ctx.manifest.batch_id
          || run.batch_locator.isolation_sha256 !== ctx.record.isolation_sha256
          || roots.digest(run.write_claim) !== roots.digest(ctx.record.claim)) refuse('batch-retirement-stale', 'the exact held union and locator are required');
      const retirement_id = roots.digest({ locator: run.batch_locator, broker: ctx.evidence.manifest_sha256 });
      const row = { retirement_id, locator: copy(run.batch_locator), broker_manifest_sha256: ctx.evidence.manifest_sha256,
        operation_sequence: ctx.broker.operations().head.sequence + 1,
        witness_ref: `.gsd/forge/batches/${ctx.manifest.batch_id}/retirement.json`,
        retained_roots: ctx.record.members.flatMap(member => member.roots.map(root => {
          const held = run.write_claim.execution_contract.code_roots.find(item => item.identity_sha256 === root.identity_sha256);
          if (!held) refuse('batch-retirement-stale', 'a member root lost custody');
          return { root_id: held.id, path: held.path, identity_sha256: held.identity_sha256 };
        })),
        post_unit: ctx.manifest.members.map(member => ({ member_index: member.index, unit: member.unit,
          key: `${retirement_id}:${member.index}:post-unit` })) };
      const history = [...(run.batch_retirements || []), row];
      runApi.validateBatchRetirements(history, run.id);
      const before = retainedRead(runApi.runFile(ctx.owner.real, run.id), 'batch-retirement-stale');
      const after_record = { ...run, batch_locator: null, batch_retirements: history };
      const witness = { schema: 'forge-batch-retirement-v1', retirement: row, report: copy(report) };
      return { name: RETIRE_PRODUCER, row, before_record_sha256: sha256(before), after_record,
        after_record_sha256: sha256(Buffer.from(JSON.stringify(after_record, null, 2))), witness };
    }));
  }, ctx.controllerOptions);
}
function applyRetirement(ctx, producer) {
  if (!isObject(producer) || producer.name !== RETIRE_PRODUCER || producer.row?.locator.batch_id !== ctx.manifest.batch_id
      || producer.row.locator.manifest_sha256 !== ctx.manifest.manifest_sha256
      || producer.row.locator.isolation_sha256 !== ctx.record.isolation_sha256) refuse('batch-retirement-stale', 'foreign retirement producer');
  const runApi = require('./forge-runs'), roots = codeRoots();
  runApi.validateBatchRetirements(producer.after_record.batch_retirements, ctx.record.run_id);
  if (sha256(Buffer.from(JSON.stringify(producer.after_record, null, 2))) !== producer.after_record_sha256) refuse('batch-retirement-stale', 'retirement postimage differs');
  controller().withOwnerBoundary(ctx.owner.real, ({ noLeases }) => {
    if (!noLeases() || !retirementTerminal(ctx)) refuse('batch-retirement-pending', 'member terminals or leases changed');
    runApi.withRegistryFence(ctx.owner.real, guard => runApi.updateWith(ctx.owner.real, ctx.record.run_id, current => {
      if (!noLeases()) refuse('batch-retirement-pending', 'a lease appeared');
      const now = sha256(retainedRead(runApi.runFile(ctx.owner.real, current.id), 'batch-retirement-stale'));
      if (now === producer.after_record_sha256 && roots.digest(current) === roots.digest(producer.after_record)) return null;
      if (now !== producer.before_record_sha256 || !current.active || !current.batch_locator
          || roots.digest(current.batch_locator) !== roots.digest(producer.row.locator)
          || roots.digest(current.write_claim) !== roots.digest(ctx.record.claim)) refuse('batch-retirement-stale', 'the RunRecord changed');
      const patch = { batch_locator: null, batch_retirements: producer.after_record.batch_retirements };
      if (roots.digest({ ...current, ...patch }) !== roots.digest(producer.after_record)) refuse('batch-retirement-stale', 'non-custody run fields changed');
      return patch;
    }, guard));
  }, ctx.controllerOptions);
  ctx.failpoint('claim-mutation-applied');
  const witnessPath = path.join(ctx.owner.real, producer.row.witness_ref);
  if (fs.existsSync(witnessPath)) {
    if (sha256(retainedRead(witnessPath, 'batch-retirement-stale')) !== sha256(progressBytes(producer.witness))) refuse('batch-retirement-stale', 'the terminal witness changed');
  } else if (!publishExclusive(ctx.owner, [...BATCH_SEGMENTS, ctx.manifest.batch_id], 'retirement.json', producer.witness,
      MAX_MANIFEST_BYTES, 'batch-retirement-stale')) refuse('batch-retirement-stale', 'the terminal witness appeared');
}
async function retirementOperation(ctx, report) {
  const producer = prepareRetirement(ctx, report);
  const effects = [
    { path: path.relative(ctx.owner.real, require('./forge-runs').runFile(ctx.owner.real, ctx.record.run_id)).split(path.sep).join('/'),
      before: producer.before_record_sha256, after: { sha256: producer.after_record_sha256 } },
    { path: producer.row.witness_ref, before: null, after: { sha256: sha256(progressBytes(producer.witness)) } },
  ];
  const intent = await ctx.broker.beginOwnerOperation(ctx.cohort, { species: 'claim-mutation', member_ref: null,
    producer, effects, prepared_at: new Date(nowOf(ctx.options)).toISOString() });
  HANDLES.get(ctx.cohort).retirement = producer;
  ctx.failpoint('claim-mutation-intent');
  applyRetirement(ctx, producer);
  ctx.failpoint('claim-mutation-before-commit');
  await ctx.broker.commitOwnerOperation(ctx.cohort, intent);
  return producer.row;
}
function retiredReport(ctx, proof) {
  if (!proof?.committed) return null;
  if (!ctx.historical && ctx.evidence.surface?.matches_operations !== true) refuse('batch-retirement-owner-drift', 'post-unit owner changes require their own proven producer');
  const producer = proof.producer, roots = codeRoots(), runApi = require('./forge-runs');
  runApi.validateBatchRetirements([producer.row], ctx.record.run_id);
  if (producer.name !== RETIRE_PRODUCER || producer.row?.locator.batch_id !== ctx.manifest.batch_id
      || producer.row.locator.isolation_sha256 !== ctx.record.isolation_sha256
      || producer.row.broker_manifest_sha256 !== ctx.evidence.manifest_sha256
      || producer.row.operation_sequence !== proof.sequence) refuse('batch-retirement-stale', 'foreign terminal witness');
  const run = runApi.get(ctx.owner.real, ctx.record.run_id);
  if (!run || !run.batch_retirements?.some(row => roots.digest(row) === roots.digest(producer.row))) refuse('batch-retirement-stale', 'custody history changed');
  const groups = roots.claimGroups(run.write_claim);
  if (producer.row.retained_roots.some(root => !groups.some(group => group.identity_sha256 === root.identity_sha256))) refuse('batch-retirement-stale', 'retained root protection changed');
  const effect = proof.effects.find(row => row.path === producer.row.witness_ref);
  const raw = retainedRead(path.join(ctx.owner.real, producer.row.witness_ref), 'batch-retirement-stale');
  if (!effect?.after || sha256(raw) !== effect.after.sha256 || sha256(raw) !== sha256(progressBytes(producer.witness))) refuse('batch-retirement-stale', 'terminal witness bytes changed');
  if (!retirementTerminal(ctx)) refuse('batch-retirement-stale', 'a completed member proof changed');
  const broker = ctx.broker ? { directory: ctx.broker.directory, manifest_sha256: ctx.broker.manifest_sha256,
    generation: ctx.broker.generation, signer_sha256: ctx.broker.signer_sha256 } : copy(producer.witness.report.broker);
  return deepFreeze({ ...copy(producer.witness.report), broker, operations: copy(proof.operations),
    retirement: { status: 'retired', ...copy(producer.row) }, historical_replay: !ctx.broker });
}
async function consolidateCohort(scope, options = {}) {
  return autoGateContext(options, () => consolidateCohortWithGate(scope, options));
}
async function consolidateCohortWithGate(scope, options) {
  if (!isObject(options) || typeof options.broker_manifest_sha256 !== 'string' || !HASH.test(options.broker_manifest_sha256)) {
    refuse('batch-consolidation-request-invalid', 'the broker manifest digest the run reported is required');
  }
  const { owner, manifest, record } = consolidationScope(scope);
  const coordinator = consolidationLock(owner, manifest);
  let broker = null, joined = true;
  try {
    const directory = path.join(record.base.batch_dir, BROKER_DIRECTORY);
    // The sealed root evidence, read-only: the stream, the anchors and the barrier of the run's real join.
    const closed = reconciliation().readBatchClosedHistory({ directory, manifest_sha256: options.broker_manifest_sha256 });
    if (closed) return deepFreeze({ ...retiredReport({ owner, manifest, record, evidence:closed.evidence, historical:true }, closed.retirement),
      post_unit:closed.post_unit, historical_replay:true });
    const evidence = reconciliation().readBatchEvidence({ directory, manifest_sha256: options.broker_manifest_sha256 });
    if (!evidence.barrier.sealed) refuse('batch-barrier-required', 'the cohort barrier is not sealed');
    if (evidence.batch_id !== manifest.batch_id || evidence.batch_manifest_sha256 !== manifest.manifest_sha256 || evidence.run_id !== record.run_id) {
      refuse('batch-manifest-foreign', 'the broker evidence belongs to another batch or run');
    }
    const retirement = reconciliation().readBatchRetirement({ directory, manifest_sha256: options.broker_manifest_sha256 });
    if (retirement?.committed && reconciliation().readBatchPostUnitComplete({ directory, manifest_sha256: options.broker_manifest_sha256 })) return retiredReport({ owner, manifest, record, evidence }, retirement);
    const barrierMembers = evidence.members.map(row => {
      const member = manifest.members[row.member_index];
      if (!member || member.task_id !== row.task_id || member.unit !== row.unit) refuse('batch-manifest-foreign', 'the broker registry names another member');
      return member;
    });
    const inputs = memberInputs(barrierMembers, options.members);
    const ctx = { scope: { ...scope }, options, owner, manifest, record, evidence, deltas: new Map(),
      failpoint: name => { if (typeof options.failpoint === 'function') options.failpoint(name); },
      controllerOptions: typeof options.prefsReader === 'function' ? { prefsReader: options.prefsReader } : {},
      lanes: evidence.members.map((row, position) => ({ row, member: barrierMembers[position], inputs: inputs.get(row.task_id), handle: null, request: null })) };
    // The exact bound attempts still to verify or publish, restored before the successor registers them.
    const progress = progressOf(owner, manifest);
    for (const lane of ctx.lanes) {
      if (lane.row.outcome !== 'retained' || !RESTORABLE_STATES.includes(progress[lane.member.index].state)) continue;
      const route = memberRoute(owner, manifest, lane.member, options);
      if (!route) refuse('batch-member-route-stale', `${lane.member.task_id} no longer resolves to the route its decision pinned`);
      Object.assign(lane, restoreMember(ctx, lane, route));
    }
    const cohort = consolidationCohort(owner, manifest, record);
    if (retirement) HANDLES.get(cohort).retirement = retirement.producer;
    const restored = ctx.lanes.filter(lane => lane.handle);
    // A failed resume may have spawned a broker. Only its actual joined cleanup releases our fence.
    joined = false;
    try {
      broker = await reconciliation().resumeBatchBroker(cohort, restored.map(lane => lane.handle),
        { directory, manifest_sha256: options.broker_manifest_sha256, barrier_sha256: evidence.barrier.sha256 });
    } catch (error) {
      const cleanup = error && error.cleanup;
      joined = brokerJoined(cleanup) || (isObject(cleanup) && cleanup.status === 'not-started' && cleanup.active_processes === 0 && cleanup.spawned === false);
      throw error;
    }
    HANDLES.get(cohort).broker = broker;
    for (const lane of restored) HANDLES.get(lane.handle).broker = broker;
    Object.assign(ctx, { cohort, broker });
    await finishPending(ctx);
    if (retirement) {
      const finished = reconciliation().readBatchRetirement({ directory, manifest_sha256: options.broker_manifest_sha256 });
      if (finished?.committed) {
        const post_unit = await finishPostUnits(ctx, finished.producer);
        return deepFreeze({ ...retiredReport({ ...ctx, evidence: reconciliation().readBatchEvidence({ directory, manifest_sha256: options.broker_manifest_sha256 }) }, finished), post_unit });
      }
    }
    await recordBarrier(ctx);
    let stop = null;
    for (const lane of ctx.lanes) {
      stop = await consolidateMember(ctx, lane);
      if (stop) break;
    }
    if (!stop) {
      // The whole integrated delivery once more, before anything (dependent or slice) relies on it.
      const recheck = isolation().checkBatchIntegration(cohort, { consolidated: consolidatedDeltas(ctx, null) });
      if (recheck.status !== 'ready') stop = { task_id: null, reason_code: 'integration-recheck-failed', root_id: recheck.root_id || null, path: recheck.path || null };
    }
    const report = consolidationReport(ctx, stop, cohortCleanup(cohort));
    if (!stop && retirementTerminal(ctx)) {
      const row = await retirementOperation(ctx, report);
      const post_unit = await finishPostUnits(ctx, HANDLES.get(ctx.cohort).retirement), state = ctx.broker.operations();
      return deepFreeze({ ...report, operations: { committed: state.committed.length, pending: state.pending, head_sha256: state.head.sha256 },
        retirement: { status: 'retired', ...row }, post_unit, historical_replay: false });
    }
    return deepFreeze({ ...report, retirement: { status: 'pending' } });
  } finally {
    try {
      if (broker) {
        let cleanup;
        try { cleanup = await broker.close(); }
        catch (error) { joined = brokerJoined(error && error.cleanup); throw error; }
        joined = brokerJoined(cleanup);
        if (!joined) refuse('batch-consolidation-cleanup-unproven', 'the successor broker has not been joined; the coordinator fence is retained');
      }
    } finally {
      if (joined) {
        const released = coordinator.release();
        if (!released || released.ok !== true) refuse('batch-consolidation-lock-lost', 'the coordinator no longer owns its process fence');
      }
    }
  }
}

/**
 * Issue 343 U5: the cleanup plan of a cohort outside a consolidation (read-only revalidation of the
 * manifest, isolation record and parent claim): removals only when admissible, else retention.
 */
function cleanupCohort(scope) {
  const { owner, manifest, record } = consolidationScope(scope);
  const cohort = consolidationCohort(owner, manifest, record);
  const run = require('./forge-runs').get(owner.real, record.run_id);
  const archived = run?.batch_retirements?.find(row => row.locator.batch_id === manifest.batch_id);
  if (archived) {
    const directory = path.join(record.base.batch_dir, BROKER_DIRECTORY);
    const closed = reconciliation().readBatchClosedHistory({ directory, manifest_sha256: archived.broker_manifest_sha256 });
    const proof = closed?.retirement || reconciliation().readBatchRetirement({ directory, manifest_sha256: archived.broker_manifest_sha256 });
    const evidence = closed?.evidence || reconciliation().readBatchEvidence({ directory, manifest_sha256: archived.broker_manifest_sha256 });
    if (!retiredReport({ owner, manifest, record, evidence, historical: !!closed }, proof)) {
      refuse('batch-retirement-stale', 'cleanup has no committed terminal custody proof');
    }
    HANDLES.get(cohort).retirement = proof.producer;
  }
  // The handle still enforces the exact current RunRecord post-image and held claim.
  return deepFreeze(cohortCleanup(cohort));
}

// ── CLI: run --batch <ref> --request <file> ──────────────────────────────────

function batchRefOf(value) {
  const match = /^(?:\.gsd\/forge\/batches\/)?(batch-[a-f0-9]{32})(?:\/manifest\.json)?$/.exec(String(value).replace(/\\/g, '/'));
  if (!match) refuse('batch-not-active', 'the batch reference is neither a batch id nor its manifest ref');
  return match[1];
}
function cliArguments(argv) {
  const usage = () => refuse('batch-run-request-invalid', 'usage: forge-execution-batch run|consolidate --batch <batch_id|manifest_ref> --request <file>');
  if (!Array.isArray(argv) || !['run', 'consolidate'].includes(argv[0])) usage();
  const args = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!['--batch', '--request'].includes(flag) || typeof value !== 'string' || !value || value.startsWith('--') || own(args, flag)) usage();
    args[flag] = value;
  }
  if (!own(args, '--batch') || !own(args, '--request')) usage();
  return { command: argv[0], batchId: batchRefOf(args['--batch']), requestFile: args['--request'] };
}
// The host's run request: a bounded regular UTF-8 JSON file outside every root with the closed
// fields only. Its owner token stays in memory: never an argument, an output or an environment.
// Issue 343 U5: the consolidate request is the same file plus the broker manifest digest the run reported.
function readRunRequest(file, command = 'run') {
  const bad = detail => refuse('batch-run-request-invalid', detail);
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\u0000')) bad('--request names an absolute JSON file');
  let stat, bytes, value;
  try { stat = fs.lstatSync(file); } catch (_) { bad('the run request is not readable'); }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_RUN_REQUEST_BYTES) bad('the run request is not a bounded regular file');
  try { bytes = fs.readFileSync(file); } catch (_) { bad('the run request is not readable'); }
  if (bytes.length > MAX_RUN_REQUEST_BYTES) bad('the run request is not a bounded regular file');
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch (_) { bad('the run request is not UTF-8 JSON'); }
  const schema = command === 'consolidate' ? CONSOLIDATE_REQUEST_SCHEMA : RUN_REQUEST_SCHEMA;
  const keys = command === 'consolidate' ? CONSOLIDATE_REQUEST_KEYS : RUN_REQUEST_KEYS;
  if (!isObject(value) || value.schema !== schema || Object.keys(value).some(key => !keys.includes(key))) {
    bad('the run request fields are not the closed run request schema');
  }
  return value;
}
/**
 * The CLI `run --batch <ref> --request <file>`: prints the typed run report as one JSON line on
 * stdout (exit 1 only for a blocked run); a refusal prints only its code on stderr (exit 1).
 * SIGINT/SIGTERM cancel every member through its own process scope (global shutdown).
 * Issue 343 U5: `consolidate --batch <ref> --request <file>` prints the typed consolidation report
 * (exit 1 only for a conflict); it never starts a provider, so a rerun after any crash resumes.
 */
async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout, stderr = io.stderr || process.stderr;
  const shutdown = new AbortController(), cancel = () => shutdown.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    const { command, batchId, requestFile } = cliArguments(argv);
    const input = readRunRequest(requestFile, command);
    const scope = { cwd: input.cwd, milestone: input.milestone, host_runtime: input.host_runtime,
      owner_token: input.owner_token, batch_id: batchId, manifest_sha256: input.manifest_sha256, run_id: input.run_id,
      ...(input.code_root !== undefined ? { code_root: input.code_root } : {}) };
    if (command === 'consolidate') {
      const report = await consolidateCohort(scope, { members: input.members, broker_manifest_sha256: input.broker_manifest_sha256, memory_publications: input.memory_publications });
      stdout.write(`${JSON.stringify(report)}\n`);
      return report.status === 'conflict' ? 1 : 0;
    }
    const report = await runCohort(scope, { members: input.members, stream: stderr, signal: shutdown.signal });
    stdout.write(`${JSON.stringify(report)}\n`);
    return report.status === 'blocked' ? 1 : 0;
  } catch (error) {
    stderr.write(`forge-execution-batch: ${errorCode(error, 'batch-run-failed')}\n`);
    return 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

// ── Projections ───────────────────────────────────────────────────────────────

// The sanitized public view of one member: no token, raw session, prompt or resolver input.
function publicMember(manifest, member) {
  return { index: member.index, task_id: member.task_id, unit: { type: 'execute-task', id: member.task_id, key: member.unit },
    slice: manifest.slice, begin_key: member.begin_key, plan: { path: member.plan.path, sha256: member.plan.sha256 },
    writes: copy(member.writes), roots: copy(member.roots),
    route: { worker_mode: member.route.worker_mode, resolved_worker_engine: member.route.resolved_worker_engine,
      host_runtime: member.route.host_runtime, engine: member.route.engine, model: member.route.model, tier: member.route.tier,
      effort: member.route.effort, route_sha256: member.route.route_sha256 } };
}
/**
 * Read-only owner view of a batch named by a loop snapshot: the manifest it names (exact
 * digest, same owner, milestone, host and owner token), each member's progress, begin phase
 * and lease. `terminal` holds only when every member reached ack, falhou or bloqueado.
 */
function status(scope, options = {}) {
  if (!isObject(scope) || typeof scope.batch_id !== 'string' || !BATCH_ID.test(scope.batch_id)
      || typeof scope.manifest_sha256 !== 'string' || !HASH.test(scope.manifest_sha256)) refuse('batch-not-active', 'no batch is named');
  for (const key of ['cwd', 'milestone', 'host_runtime', 'owner_token']) if (typeof scope[key] !== 'string' || !scope[key]) refuse('batch-scope-invalid', `${key} is required`);
  const owner = ownerOf(scope.cwd), manifest = readManifestAt(owner, scope.batch_id);
  if (!manifest) refuse('batch-manifest-invalid', 'the named batch has no published manifest');
  if (manifest.manifest_sha256 !== scope.manifest_sha256 || manifest.owner !== owner.key || manifest.milestone !== scope.milestone
      || manifest.host_runtime !== scope.host_runtime || manifest.owner_digest !== ownerDigest(scope.owner_token)) {
    refuse('batch-manifest-foreign', 'the named manifest belongs to another owner, milestone, host or owner token');
  }
  const progress = progressOf(owner, manifest);
  const members = manifest.members.map(member => {
    const found = recordAt(scope.cwd, member.begin_key);
    let lease = 'unknown';
    try {
      const seen = leases().observe(scope.cwd, member.unit, options);
      if (seen.ok) lease = !seen.lease ? 'absent' : found.record && seen.lease.generation === found.record.lease_generation ? 'held' : 'foreign';
    } catch (_) { lease = 'unknown'; }
    return { ...publicMember(manifest, member), state: progress[member.index].state, reason_code: progress[member.index].reason_code,
      begin: found.conflict ? 'conflict' : found.record ? found.record.phase : null, lease };
  });
  let retirement = { status: 'active' };
  const physical = readIsolation(owner, manifest);
  const run = physical && require('./forge-runs').get(owner.real, physical.run_id);
  const archived = run?.batch_retirements?.find(row => row.locator.batch_id === manifest.batch_id);
  if (archived) {
    const directory = path.join(physical.base.batch_dir, BROKER_DIRECTORY);
    const closed = reconciliation().readBatchClosedHistory({ directory, manifest_sha256: archived.broker_manifest_sha256 });
    const proof = closed?.retirement || reconciliation().readBatchRetirement({ directory, manifest_sha256: archived.broker_manifest_sha256 });
    const evidence = closed?.evidence || reconciliation().readBatchEvidence({ directory, manifest_sha256: archived.broker_manifest_sha256 });
    const historical = retiredReport({ owner, manifest, record: physical, evidence, historical:!!closed }, proof);
    retirement = historical ? { ...historical.retirement, post_unit:closed?.post_unit || {status:'pending'} } : { status: 'pending' };
  }
  return deepFreeze({ batch_id: manifest.batch_id, manifest_ref: manifestRef(manifest.batch_id), manifest_sha256: manifest.manifest_sha256,
    milestone: manifest.milestone, slice: manifest.slice, members, excluded: copy(manifest.excluded),
    terminal: members.every(member => TERMINAL_STATES.includes(member.state)), retirement });
}

// Every new owner begin shares the controller fence. A completed cohort's
// deferred metadata must have its own signed final boundary before a new
// protected writer can start. Historical records never create writer authority.
function assertPostUnitBoundary(cwd) {
  const runApi = require('./forge-runs'), census = runApi.boundedCensus(cwd);
  if (census.unparseable.length) refuse('batch-post-unit-invalid', 'the owner run census is unknown');
  const owner = ownerOf(cwd);
  for (const run of census.parsed) for (const row of run.batch_retirements || []) {
    runApi.validateBatchRetirements(run.batch_retirements, run.id);
    const manifest = readManifestAt(owner, row.locator.batch_id), record = manifest && readIsolation(owner, manifest);
    if (!record || record.run_id !== run.id) refuse('batch-post-unit-invalid', 'retained custody lost its manifest');
    const closed = reconciliation().readBatchClosedHistory({ directory:path.join(record.base.batch_dir,BROKER_DIRECTORY),
      manifest_sha256:row.broker_manifest_sha256 });
    if (!closed) refuse('batch-post-unit-pending', 'finish the cohort post-unit queue before a new begin');
  }
  return true;
}

module.exports = {
  SCHEMA, PROGRESS_SCHEMA, KIND, ROOTS_LIMIT, MAX_MEMBERS, REASON_CODES, REFUSAL_CODES, MEMBER_STATES, TERMINAL_STATES, TRANSITIONS,
  BatchError, batchIdOf, memberBeginKey, memberBinding, validBinding, manifestRef, decide, dispatch, readManifest, readProgress,
  appendProgress, status, assertPostUnitBoundary, publicMember, prepareIsolation, resolveIsolationHandle,
  bindMemberExecution, resolveMemberExecution, validateMemberPlan, assertMemberRootOwner, resumeMemberExecution, memberRootReservation,
  openCohortBroker, closeCohortBroker, resolveBrokerCohort, brokerMemberBinding,
  isMemberView, memberSidecar, isMemberSidecar,
  RUN_SCHEMA, RUN_REQUEST_SCHEMA, MEMBER_OUTCOMES, RUN_STATUSES, POOL_REASON_CODES, POOL_REFUSAL_CODES,
  runCohort, currentMemberProcessScope, main,
  // Issue 343 U5: the serial post-barrier consolidation, its cohort for isolation, and the cleanup.
  CONSOLIDATION_SCHEMA, CONSOLIDATE_REQUEST_SCHEMA, CONSOLIDATION_STATUSES, CONSOLIDATION_OUTCOMES, CONSOLIDATION_REASON_CODES,
  CONSOLIDATION_REFUSAL_CODES, CONSOLIDATION_FAILPOINTS, consolidateCohort, cleanupCohort, resolveConsolidationCohort,
};

if (require.main === module) {
  main().then(code => { process.exitCode = code; }, () => { process.exitCode = 1; });
}
