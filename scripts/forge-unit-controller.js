#!/usr/bin/env node
'use strict';

/*
 * forge-unit-controller
 * ---------------------
 * Provider-neutral workflow coordinator for Forge units.  Provider adapters
 * may call this module, but no provider command, home, credential store, or
 * conversational context participates in a workflow decision.
 *
 * Durability model:
 *   intent -> result -> event -> pending boundary -> STATE -> release lease
 *          -> ready boundary -> commit
 *
 * Each publication is a complete temp+rename replacement.  The transaction
 * record advances only after a publication is durable.  Repeating any phase
 * is safe because every artifact is keyed by the same idempotency key.  A
 * crash can therefore leave an older transaction phase than the artifact it
 * describes; resume replays that phase and observes the identical artifact.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const forgeLock = require('./forge-lock.js');
const forgeState = require('./forge-state.js');
const forgeRuns = require('./forge-runs.js'); // Canonical run registry is intentionally re-exported as a dependency.
const forgePrefs = require('./forge-prefs.js');
const forgeRuntime = require('./forge-runtime.js');
const forgeIds = require('./forge-ids.js');
const forgeLease = require('./forge-unit-lease.js');
const forgeStatus = require('./forge-status.js');
// Inert import: the selection module loads only core modules until it is called.
const timeSelection = require('./forge-milestone-time-selection.js');

const PROTOCOL_VERSION = '1.0.0';
const BOUNDARY_KINDS = Object.freeze(['completed', 'paused', 'failed-persisted', 'expired-safe']);
const ACTIONS = Object.freeze(['begin', 'running', 'persist-result', 'complete', 'pause', 'fail', 'expired-safe']);
const PHASES = Object.freeze([
  'intent', 'result-published', 'event-published', 'boundary-pending',
  'state-published', 'lease-release-pending', 'lease-released', 'boundary-ready', 'committed',
]);
// Admission refusals of enrolled milestones (S02): a unit outside the selection
// state, the scoped task DAG of a milestone with an active contract, and an active
// contract whose required slice review gate is disabled.
const TIME_ADMISSION_CODES = Object.freeze(['time-unit-not-admitted', 'time-task-dependency-pending',
  'time-task-dependency-unknown', 'time-task-dependency-cycle', 'time-task-identity-ambiguous', 'time-roadmap-selection-missing',
  'time-review-disabled-incompatible', 'time-review-mode-unknown']);
const REASON_CODES = Object.freeze([
  'selected', 'no-next-unit', 'prefs-invalid', 'transaction-pending',
  'lease-required', 'lease-owner-mismatch', 'transition-committed',
  'already-committed', 'handoff-ready', 'boundary-missing', 'unit-incomplete', 'decomposition-verification-required',
  'boundary-not-transferable', 'lease-active', 'invalid-request',
  ...require('./forge-milestone-time-admission').TIME_REASON_CODES,
  ...timeSelection.TIME_OPTION_REASON_CODES, ...timeSelection.TIME_OPTION_RESUME_CODES, ...TIME_ADMISSION_CODES,
]);
const ROADMAP_TIME_BLOCKS = Object.freeze({ nonconformant: 'time-roadmap-nonconformant',
  'allocation-pending': 'time-allocation-pending', 'scope-unallocated': 'time-scope-unallocated' });
const TASK_DAG_BLOCKS = Object.freeze({ unknown: 'time-task-dependency-unknown', cycle: 'time-task-dependency-cycle',
  ambiguous: 'time-task-identity-ambiguous', unallocated: 'time-scope-unallocated' });

function own(value, key) { return Object.prototype.hasOwnProperty.call(value || {}, key); }
function nowOf(options) { return options && typeof options.now === 'function' ? options.now() : Date.now(); }
function iso(value) { return new Date(value).toISOString(); }
function sha(value) {
  const input = typeof value === 'string' ? value : stableStringify(value);
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}
function encode(value) {
  return Buffer.from(String(value), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = stable(value[key]);
  return output;
}
function stableStringify(value) { return JSON.stringify(stable(value)); }
function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }

class ControllerError extends Error {
  constructor(code, message, details) {
    super(`forge-unit-controller (${code}): ${message}`);
    this.name = 'ControllerError';
    this.code = code;
    if (details) this.details = details;
  }
}

function opaque(value, label, required) {
  if ((value === undefined || value === null || value === '') && !required) return null;
  if (typeof value !== 'string' || value.trim() === '' || value.length > 2048 || value.includes('\u0000')) {
    throw new ControllerError('invalid-request', `${label} inválido`);
  }
  return value.normalize('NFC').trim();
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ControllerError('invalid-request', `${label} deve ser objeto`);
  }
  return value;
}
function assertAction(value) {
  const action = opaque(value, 'action', true);
  if (!ACTIONS.includes(action)) throw new ControllerError('invalid-request', `action desconhecida: ${action}`);
  return action;
}
function assertJsonSafe(value, label, seen) {
  const visited = seen || new Set();
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new ControllerError('invalid-request', `${label} não é JSON seguro`);
  }
  if (!value || typeof value !== 'object') return;
  if (visited.has(value)) throw new ControllerError('invalid-request', `${label} contém ciclo`);
  visited.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (/owner_token|credential|password|access_token|refresh_token|conversation|transcript/i.test(key)) {
      throw new ControllerError('invalid-request', `${label} contém campo proibido: ${key}`);
    }
    assertJsonSafe(child, `${label}.${key}`, visited);
  }
  visited.delete(value);
}
function fail(options, name) {
  if (options && typeof options.failpoint === 'function' && options.failpoint(name)) {
    const error = new Error(`forge-unit-controller: failpoint ${name}`);
    error.code = 'CONTROLLER_FAILPOINT';
    throw error;
  }
}

function rootDir(cwd) { return path.join(cwd, '.gsd', 'forge'); }
function transactionDir(cwd) { return path.join(rootDir(cwd), 'transactions'); }
function resultDir(cwd) { return path.join(rootDir(cwd), 'results'); }
function boundaryDir(cwd) { return path.join(rootDir(cwd), 'boundaries'); }
function eventsFile(cwd, milestone) {
  return milestone
    ? path.join(cwd, '.gsd', 'milestones', milestone, `${milestone}-events.jsonl`)
    : path.join(rootDir(cwd), 'events.jsonl');
}
function transactionFile(cwd, key) { return preferredRecordFile(cwd, 'transaction', key); }
function resultFile(cwd, key) { return preferredRecordFile(cwd, 'result', key); }
function boundaryFile(cwd, unit) { return preferredRecordFile(cwd, 'boundary', forgeLease.normalizeUnitKey(unit)); }

function recordPaths(cwd, kind, key) {
  const dir = kind === 'transaction' ? transactionDir(cwd) : kind === 'result' ? resultDir(cwd) : boundaryDir(cwd);
  const file = path.join(dir, `${kind}-v1-${sha(key)}.json`);
  const legacy = `${encode(key)}.json`;
  return [file, ...(legacy.length <= 255 ? [path.join(path.dirname(file), legacy)] : [])];
}
function preferredRecordFile(cwd, kind, key) {
  const paths = recordPaths(cwd, kind, key);
  // Path selection must not read publications: diagnostic callers may locate
  // a path before deciding whether that publication is in their scope.
  return paths.find(file => fs.existsSync(file)) || paths[0];
}
function validateRecord(record, kind, key, options) {
  const identity = kind === 'boundary' ? record.unit : record.idempotency_key;
  if (identity !== key) throw new ControllerError('record-conflict', `identidade divergente em ${kind}`);
  if (kind === 'transaction' && !(options && options.identityOnly)) {
    let unitKey;
    try { unitKey = forgeLease.normalizeUnitKey(record.unit); } catch { /* reported as record-conflict below */ }
    if (!unitKey || record.unit.key !== unitKey ||
        !record.before || !record.after || sha(record.before.state) !== record.before.state_checksum ||
        sha(record.after.state) !== record.after.state_checksum ||
        !record.event || record.event.idempotency_key !== key || record.event.unit !== record.unit.key ||
        record.event.milestone !== record.milestone ||
        (record.result && (record.result.idempotency_key !== key || record.result.unit !== record.unit.key || record.result.milestone !== record.milestone)) ||
        (record.boundary && (sha(record.result) !== record.boundary.result_checksum || sha(record.event) !== record.boundary.event_checksum))) {
      throw new ControllerError('record-conflict', 'checksum/identidade da transação inválido');
    }
    // Issue 343 U0d: a stored plan_generation enrollment belongs to exactly the plan-slice
    // begin that carries it; its digest is recomposed from its own fields. The completion
    // evidence lives inside result, so the result checksum above already covers it.
    if (own(record, 'plan_generation') && (record.action !== 'begin' || record.unit.type !== 'plan-slice'
        || !planValidation().planGenerationIntegrity(record.plan_generation, { begin_key: key, lease_generation: record.lease_generation,
          owner_digest: record.owner_digest, milestone: record.milestone, slice: record.unit.id }))) {
      throw new ControllerError('record-conflict', 'enrollment plan_generation diverge da transação');
    }
    // Issue 343 U1: a stored batch binding belongs to exactly the execute-task member begin of
    // its manifest; the begin key is derived from that binding (forge-execution-batch).
    if (own(record, 'batch') && (record.action !== 'begin' || !executionBatch().validBinding(record.batch, key, record.unit))) {
      throw new ControllerError('record-conflict', 'vínculo de batch diverge da transação');
    }
  }
  return record;
}
function lookupRecord(cwd, kind, key, options) {
  let found = null;
  const paths = recordPaths(cwd, kind, key);
  let legacyAnchor = null;
  for (const file of paths) {
    const record = readRecordJson(file);
    if (!record) continue;
    validateRecord(record, kind, key, options);
    if (found && stableStringify(found) !== stableStringify(record)) {
      if (!legacyAnchor || legacyAnchor !== sha(record)) throw new ControllerError('record-conflict', `registros novo/legado divergem em ${kind}`);
    } else if (!found) found = record;
    if (file === paths[0]) legacyAnchor = JSON.parse(fs.readFileSync(file, 'utf8')).storage_legacy_checksum || null;
  }
  return found;
}
function saveRecord(cwd, kind, key, record, options) {
  lookupRecord(cwd, kind, key); // refuse collisions before replacing any record
  const paths = recordPaths(cwd, kind, key);
  const existing = paths.filter(file => fs.existsSync(file));
  // With two accepted copies publish only the modern one atomically. Bind the
  // untouched legacy bytes so interruption never creates ambiguous authority,
  // while unrelated legacy changes still fail closed on the next read.
  if (existing.length === 2) {
    writeAtomic(paths[0], record, false, { ...options, legacyRecordChecksum: sha(readRecordJson(paths[1])) });
  } else writeAtomic(existing[0] || paths[0], record, false, options);
}
function discoverRecords(cwd, kind) {
  const dir = kind === 'transaction' ? transactionDir(cwd) : resultDir(cwd);
  if (!fs.existsSync(dir)) return [];
  const records = new Map();
  for (const name of fs.readdirSync(dir).filter(item => item.endsWith('.json')).sort()) {
    const record = readJson(path.join(dir, name));
    if (!record || typeof record.idempotency_key !== 'string' ||
        !recordPaths(cwd, kind, record.idempotency_key).includes(path.join(dir, name))) throw new ControllerError('record-conflict', `endereço/identidade inválido: ${name}`);
    records.set(record.idempotency_key, lookupRecord(cwd, kind, record.idempotency_key));
  }
  return [...records.values()];
}

// Exercise the actual filesystem, rather than assuming MAX_PATH applies to all
// Windows runtimes. Probes are exclusive, empty and removed before acquisition.
function preflightPaths(cwd, key, unit, milestone) {
  const leaseFile = forgeLease.leaseFile(cwd, unit);
  const lockDir = path.join(cwd, '.gsd', '.locks');
  // Probe an equally deep private directory, never a reserved mutex name.
  const mutexProbeDir = path.join(lockDir, `.probe-${crypto.randomUUID()}${'x'.repeat(16)}`);
  const files = [transactionFile(cwd, key), resultFile(cwd, key), boundaryFile(cwd, unit),
    leaseFile, path.join(path.dirname(leaseFile), `.${path.basename(leaseFile)}.${process.pid}.${crypto.randomUUID()}.tmp`),
    eventsFile(cwd, milestone), path.join(mutexProbeDir, `metadata.json.${process.pid}.${crypto.randomUUID()}.tmp`)];
  for (const file of files) {
    if (path.resolve(file).split(/[\\/]/).some(component => (process.platform === 'win32' ? component.length : Buffer.byteLength(component)) > 255)) {
      throw new ControllerError('path-component-limit', 'componente do caminho excede o limite suportado');
    }
    const probe = path.join(path.dirname(file), `.probe-${crypto.randomUUID()}${'x'.repeat(Math.max(0, path.basename(file).length - 43))}`);
    let created = false; let directoryCreated = false; let failure;
    try {
      if (path.dirname(file) === mutexProbeDir) {
        fs.mkdirSync(lockDir, { recursive: true });
        fs.mkdirSync(mutexProbeDir); directoryCreated = true;
      } else fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(probe, '', { flag: 'wx' });
      created = true;
    } catch (error) {
      failure = new ControllerError(error.code === 'ENAMETOOLONG' || error.code === 'ENOENT' ? 'path-total-unsupported' : 'path-capability-unknown',
        'viabilidade do caminho não estabelecida antes da lease', { cause: error.code, path: file });
      throw failure;
    } finally {
      try {
        if (created) fs.unlinkSync(probe);
        if (directoryCreated) fs.rmdirSync(mutexProbeDir);
      } catch (error) {
        const diagnostic = { code: error.code, path: probe };
        if (failure) failure.cleanup = diagnostic;
        else throw new ControllerError('temporary-cleanup-failed', 'cleanup do probe próprio falhou', diagnostic);
      }
    }
  }
}

function writeAtomic(file, value, raw, options) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.atomic-${crypto.randomUUID()}.tmp`);
  const stored = { ...value, ...(options?.legacyRecordChecksum ? { storage_legacy_checksum: options.legacyRecordChecksum } : {}) };
  const content = raw ? String(value) : `${JSON.stringify({ ...stored, storage_checksum: sha(stored) }, null, 2)}\n`;
  let created = false; let failure;
  try {
    fail(options, 'before-write');
    const descriptor = fs.openSync(temporary, 'wx'); created = true;
    try { fs.writeFileSync(descriptor, content, 'utf8'); } finally { fs.closeSync(descriptor); }
    fail(options, 'after-write-before-rename');
    fs.renameSync(temporary, file); created = false;
    fail(options, 'after-rename');
  } catch (error) { failure = error; throw error; }
  finally {
    if (created) {
      try { fs.unlinkSync(temporary); }
      catch (error) {
        const diagnostic = { code: error.code, path: temporary };
        if (failure) failure.cleanup = diagnostic;
        else throw new ControllerError('temporary-cleanup-failed', 'cleanup do temporário próprio falhou', diagnostic);
      }
    }
  }
}
function readJson(file) {
  const record = readRecordJson(file);
  if (!record) return null;
  const dir = path.dirname(path.resolve(file));
  const kind = { transactions: 'transaction', results: 'result', boundaries: 'boundary' }[path.basename(dir)];
  if (kind && path.basename(path.dirname(dir)) === 'forge' && path.basename(path.dirname(path.dirname(dir))) === '.gsd') {
    const cwd = path.resolve(dir, '../../..');
    const key = kind === 'boundary' ? record.unit : record.idempotency_key;
    if (typeof key !== 'string' || !recordPaths(cwd, kind, key).includes(path.resolve(file))) {
      throw new ControllerError('record-conflict', 'endereço/identidade do registro inválido');
    }
    // Observers can inspect incomplete records, but never divergent copies.
    return lookupRecord(cwd, kind, key, { identityOnly: true });
  }
  return record;
}
function readRecordJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('registro deve ser objeto');
    if (own(record, 'storage_checksum')) {
      const checksum = record.storage_checksum; delete record.storage_checksum;
      if (checksum !== sha(record)) throw new ControllerError('record-conflict', `checksum divergente: ${file}`);
    }
    delete record.storage_legacy_checksum;
    return record;
  }
  catch (error) {
    if (error instanceof ControllerError) throw error;
    throw new ControllerError('invalid-request', `registro JSON inválido: ${file}`, { cause: error.message });
  }
}
const ownerActivityLocks = new Map();
function withMutex(...args) {
  // One existing acquisition budget covers fence first, then controller mutex.
  // 80 attempts and 79*300ms is the previous controller's backoff upper bound.
  const budget = { remaining_attempts: 80, deadline_ms: Date.now() + 79 * 300 };
  return require('./forge-owner-transport-window').withMutation(args[0], (_guard, sharedBudget) => withMutexInsideOwnerWindow(...args, sharedBudget), budget);
}
function withMutexInsideOwnerWindow(cwd, name, fn, acquisitionBudget) {
  const handle = forgeLock.acquireProcessSync(cwd, name, { retries: 80, ttlMs: 10_000, ...(acquisitionBudget ? { acquisitionBudget } : {}) });
  const ownerBoundary = name === 'unit-controller-transactions', key = path.resolve(cwd);
  if (ownerBoundary) ownerActivityLocks.set(key, handle);
  try { return fn(handle); }
  finally { if (ownerBoundary) ownerActivityLocks.delete(key); handle.release(); }
}

function noOwnerLeases(cwd) {
    const directory = path.join(cwd, '.gsd', 'forge', 'leases'); let handle;
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      handle = fs.opendirSync(directory); return handle.readSync() === null;
    } catch (error) { return error.code === 'ENOENT' && !handle; }
    finally { if (handle) handle.closeSync(); }
}

// The owner resume caller shares the controller's real publication fence and
// exact fail-closed lease census. No raw mutex capability escapes this seam.
function withOwnerBoundary(cwd, callback, options) {
  resolvePrefs(cwd, options);
  if (typeof callback !== 'function') throw new ControllerError('invalid-request', 'owner boundary callback required');
  return withMutex(cwd, 'unit-controller-transactions', () => callback({ noLeases: () => noOwnerLeases(cwd) }));
}

function recordOwnerBoundaryActivity(cwd, runId, hostRuntime) {
  // The calling controller holds the real transaction mutex. Canonical new
  // begins cannot race this census, and registry writers share their own fence.
  const held = ownerActivityLocks.get(path.resolve(cwd));
  if (!held || !forgeLock.assertOwned(held) || hostRuntime !== 'codex') return false;
  const observed = forgeRuns.observeHostSession(hostRuntime);
  if (!observed) return false;
  const noLeases = () => noOwnerLeases(cwd);
  // Any lease/debris/unknown state suppresses activity recording; age never
  // authorizes a write. In particular, no native protected window is changed.
  if (!noLeases()) return false;
  return forgeRuns.withRegistryFence(cwd, guard => {
    if (!noLeases()) return false;
    const selected = forgeRuns.resolveBySessionOwner(cwd, observed);
    if (!selected || selected.id !== runId) return false;
    return forgeRuns.bumpOwnedHeartbeat(cwd, runId, observed, undefined, guard).updated;
  });
}

function resolvePrefs(cwd, options) {
  const resolver = options && typeof options.prefsReader === 'function' ? options.prefsReader : forgePrefs.readPrefs;
  const resolved = resolver(cwd);
  if (!resolved || resolved.ok !== true) {
    const errors = resolved && Array.isArray(resolved.errors) ? resolved.errors : [];
    throw new ControllerError('prefs-invalid', 'preferências inválidas; nenhuma mutação foi iniciada', { errors });
  }
  return resolved;
}
function getPath(value, parts) {
  let current = value;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !own(current, part)) return undefined;
    current = current[part];
  }
  return current;
}
function preferenceBoolean(prefs, candidates, fallback) {
  for (const candidate of candidates) {
    const value = getPath(prefs, candidate.split('.'));
    if (typeof value === 'boolean') return value;
  }
  return fallback;
}

// Selection is pure once the state and artifact inventory are supplied.  The
// ordered cases mirror the documented lifecycle, while roadmap/task parsing is
// delegated to forge-status instead of copied into this controller.
function selectNextUnit(input) {
  const data = object(input, 'selection input');
  const current = data.state || null;
  const inventory = data.inventory || {};
  const prefs = data.prefs || {};
  if (!current || !current.milestone) return { ok: false, reason: 'no-next-unit', done: true };
  const milestone = current.milestone;
  // time_options exists only for an enrolled/selected milestone (S02). Without it
  // every branch below is the unchanged legacy order.
  const timeOptions = own(inventory, 'time_options') ? inventory.time_options : null;
  const timeBlock = reason => ({ ok: false, reason, done: false, milestone, time_options: timeOptions });
  // Enrollment refuses an existing ROADMAP, so one without an attested choice was written afterwards: never legacy.
  if (timeOptions?.status === 'roadmap-preexisting') return timeBlock('time-roadmap-selection-missing');
  if (!inventory.roadmap_exists) {
    if (timeOptions?.status === 'estimate-required') {
      return selected('estimate-milestone', milestone, milestone, current, null, { key_suffix: timeOptions.key_suffix });
    }
    if (timeOptions?.status === 'options-invalid') return timeBlock('time-options-invalid');
    if (timeOptions && timeOptions.status !== 'decided') return timeBlock('time-option-pending');
    return selected('plan-milestone', milestone, milestone, current);
  }
  if (timeOptions?.status === 'options-invalid') return timeBlock('time-options-invalid');
  if (timeOptions && ROADMAP_TIME_BLOCKS[timeOptions.roadmap?.status]) return timeBlock(ROADMAP_TIME_BLOCKS[timeOptions.roadmap.status]);
  const skipDiscuss = preferenceBoolean(prefs, ['skip_discuss', 'workflow.skip_discuss', 'planning.skip_discuss', 'skip.discuss'], false);
  const skipResearch = preferenceBoolean(prefs, ['skip_research', 'workflow.skip_research', 'planning.skip_research', 'skip.research'], false);
  const skipSliceResearch = preferenceBoolean(prefs, ['skip_slice_research', 'workflow.skip_research', 'planning.skip_research', 'skip.research'], false);
  if (!inventory.context_exists && !skipDiscuss) return selected('discuss-milestone', milestone, milestone, current);
  if (!inventory.research_exists && !skipResearch) return selected('research-milestone', milestone, milestone, current);
  const slices = Array.isArray(inventory.slices) ? inventory.slices : [];
  const activeSlice = inventory.active_slice || current.active_slice;
  const pending = slices.filter(item => !item.checked);
  const ordered = [...pending.filter(item => item.id === activeSlice), ...pending.filter(item => item.id !== activeSlice)];
  const blocked = [];
  for (const slice of ordered) {
    const reasons = [];
    if (inventory.dependency_validation === true) {
      if (slice.dependency_status !== 'valid') reasons.push(`dependencies-${slice.dependency_status || 'missing'}`, ...(slice.dependency_errors || []));
      for (const id of slice.dependencies || []) if (!slices.find(other => other.id === id && other.checked)) reasons.push(`dependency-pending:${id}`);
    }
    if ((inventory.deferred_slices || []).includes(slice.id)) reasons.push('failure-deferred');
    if (reasons.length) { blocked.push({ slice: slice.id, reasons }); continue; }
    if (!slice.plan_exists) return selected('plan-slice', slice.id, milestone, current, slice.id);
    if (!slice.research_exists && !skipSliceResearch) return selected('research-slice', slice.id, milestone, current, slice.id);
    const tasks = admissibleTasks(slice, inventory);
    if (tasks.status === 'decomposition') return { ok: false, reason: 'decomposition-verification-required', done: false, milestone,
      slice: slice.id, decomposition: { parent_tasks: tasks.parents, required: 'all-child-completions-and-original-parent-contract-verification' } };
    if (tasks.status === 'blocked') {
      return { ...timeBlock(TASK_DAG_BLOCKS[tasks.dag.status] || 'time-task-dependency-unknown'), slice: slice.id, task_dag: tasks.dag };
    }
    if (tasks.ready.length) {
      const task = tasks.ready[0], verification = task.decomposition_verification;
      return selected('execute-task', task.id, milestone, current, slice.id, verification
        ? { decomposition_verification: verification, key_suffix: 'decompose-verify-' + verification.admission_sha256 } : undefined);
    }
    if (tasks.status === 'dag' && tasks.pending.length) return { ...timeBlock('time-task-dependency-pending'), slice: slice.id, task_dag: tasks.dag };
    if (!slice.summary_exists) return selected('complete-slice', slice.id, milestone, current, slice.id);
  }
  if (pending.length) return { ok: false, reason: 'units-blocked', done: false, milestone, blocked };
  if (!inventory.milestone_complete) return selected('complete-milestone', milestone, milestone, current);
  return { ok: false, reason: 'no-next-unit', done: true, milestone };
}
// The admissible pending tasks of one slice, in canonical S-plan order: selectNextUnit picks
// the first, the batch decision (issue 343 U1) enumerates the rest through this same function.
// Opt-in milestone with an active contract: the scoped task DAG, not the checklist order,
// decides which unchecked task is admissible; otherwise every unchecked task keeps its order.
function admissibleTasks(slice, inventory) {
  const pending = (slice.tasks || []).filter(item => !item.checked && item.decomposed !== true);
  const containers = (slice.tasks || []).filter(item => item.decomposed === true && item.decomposition_verified !== true), eligible = pending.filter(item => !item.decomposition_blocked);
  const verification = containers.find(item => item.decomposition_verification);
  if (verification) return { status: 'checklist', pending, ready: [verification], dag: null };
  // A container is never a completed task. Children can run; independent work
  // can continue; dependent work and slice close require real aggregate proof.
  if (containers.length && !eligible.length) return { status: 'decomposition', pending, ready: [], dag: null, parents: containers.map(item => item.id) };
  if (inventory.task_dag !== true) return { status: 'checklist', pending, ready: eligible, dag: null };
  const dag = slice.task_dag || { status: 'unknown', reasons: ['task-dag-missing'], tasks: [] };
  if (pending.length && dag.status !== 'valid') return { status: 'blocked', pending, ready: [], dag };
  const proven = new Set(dag.tasks.filter(item => item.completion === 'proven').map(item => item.id));
  const ready = eligible.filter(item => {
    const row = dag.tasks.find(candidate => candidate.id === item.id);
    return (row?.depends || []).every(id => proven.has(id)) && (row?.barrier || []).length === 0;
  });
  return { status: 'dag', pending, ready, dag };
}
function selected(type, id, milestone, state, slice, extra) {
  const unit = forgeRuntime.normalizeUnit({ type, id, state: 'queued' });
  return {
    ok: true,
    reason: 'selected',
    milestone,
    slice: slice || null,
    unit: { type: unit.type, id: unit.id, key: forgeLease.normalizeUnitKey(unit) },
    state_checksum: sha(logicalState(state)),
    ...(extra || {}),
  };
}

function firstExisting(dir, predicate) {
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).sort().find(predicate) || null;
}
function discoverInventory(cwd, milestone, current, options) {
  const milestoneDir = path.join(cwd, '.gsd', 'milestones', milestone);
  const roadmapName = firstExisting(milestoneDir, name => name.endsWith('-ROADMAP.md'));
  const roadmapFile = roadmapName ? path.join(milestoneDir, roadmapName) : null;
  const roadmap = roadmapFile ? forgeStatus.parseRoadmap(fs.readFileSync(roadmapFile, 'utf8')) : { slices: [] };
  const slices = roadmap.slices.map(entry => {
    const dir = path.join(milestoneDir, 'slices', entry.id);
    const plan = path.join(dir, `${entry.id}-PLAN.md`);
    const research = path.join(dir, `${entry.id}-RESEARCH.md`);
    const summary = path.join(dir, `${entry.id}-SUMMARY.md`);
    return {
      ...entry,
      plan_exists: fs.existsSync(plan),
      research_exists: fs.existsSync(research),
      summary_exists: fs.existsSync(summary),
      tasks: fs.existsSync(plan) ? (() => {
        const decompositions = require('./forge-plan-validation').admittedDecompositions(cwd, { milestone, slice: entry.id });
        const records = decompositions.length ? discoverRecords(cwd, 'transaction') : [];
        const states = new Map(decompositions.map(mutation => [mutation.parent_task_id, decompositionProgress(cwd, mutation, records)]));
        const parents = new Set(states.keys());
        return forgeStatus.parsePlanTasks(fs.readFileSync(plan, 'utf8')).map(task => {
          if (parents.has(task.id)) {
            const progress = states.get(task.id);
            return { ...task, decomposed: true, decomposition_verified: progress.verified,
              ...(progress.verification ? { decomposition_verification: progress.verification } : {}) };
          }
          if (!parents.size) return task;
          const read = readTaskPlan(cwd, milestone, entry.id, task.id), declared = read.status === 'valid' && dependsOf(read.frontmatter);
          return declared?.depends.some(id => parents.has(id) && !states.get(id).verified) ? { ...task, decomposition_blocked: true } : task;
        });
      })() : [],
    };
  });
  const roadmapComplete = slices.length > 0 && slices.every(item => item.checked);
  // M###-SUMMARY.md is cumulative (each complete-slice appends to it), so it
  // proves nothing about the milestone close. Proof is the controller's own
  // committed complete-milestone transition, the ledger fragment written by
  // complete-milestone, or a global LEDGER.md heading (`## <id>` or the
  // pre-fragment `## <id> — <title>` form). The ledger write is non-critical
  // in the completer, so the transition keeps a failed write from re-selecting
  // complete-milestone forever.
  const ledgerFragment = path.join(cwd, '.gsd', 'ledger', `${milestone}.md`);
  const ledgerGlobal = path.join(cwd, '.gsd', 'LEDGER.md');
  const ledgerHeading = new RegExp(`^## ${milestone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s+—.*)?\\s*$`, 'm');
  const closeUnit = `complete-milestone/${milestone}`;
  const closeCommitted = () => {
    const file = eventsFile(cwd, milestone);
    if (!fs.existsSync(file)) return false;
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).some(line => {
      if (!line.includes(closeUnit)) return false;
      try {
        const event = JSON.parse(line);
        return event.event === 'unit-transition' && event.action === 'complete'
          && event.unit === closeUnit && event.outcome === 'succeeded';
      } catch { return false; }
    });
  };
  const milestoneClosed = fs.existsSync(ledgerFragment)
    || (fs.existsSync(ledgerGlobal) && ledgerHeading.test(fs.readFileSync(ledgerGlobal, 'utf8')))
    || closeCommitted();
  const inventory = {
    roadmap_exists: !!roadmapFile,
    context_exists: !!firstExisting(milestoneDir, name => name.endsWith('-CONTEXT.md')),
    research_exists: !!firstExisting(milestoneDir, name => name.endsWith('-RESEARCH.md')),
    active_slice: current.active_slice && current.active_slice !== '—' ? current.active_slice : null,
    slices,
    dependency_validation: true,
    milestone_complete: roadmapComplete && milestoneClosed,
  };
  // Without enrollment or selection readSelectionState is null and the inventory
  // keeps exactly its legacy keys.
  const timeOptions = readTimeOptions(cwd, milestone, options);
  if (timeOptions !== null) {
    inventory.time_options = timeOptions;
    if (taskDagApplies(timeOptions)) {
      inventory.task_dag = true;
      const records = discoverRecords(cwd, 'transaction');
      for (const slice of slices) if (slice.plan_exists) slice.task_dag = taskDag(cwd, milestone, slice.id, slice.tasks, records, nowOf(options));
    }
  }
  return inventory;
}

// --- S02: owner selection state and the scoped task DAG -------------------------
// The real owner state is read here and in the mutating guard; caller JSON,
// an injected inventory or a loop snapshot never supplies it.
function readTimeOptions(cwd, milestone, options) {
  const code = options && options.timeOptionsCode;
  return timeSelection.readSelectionState(cwd, milestone, code ? { code } : {});
}
function taskDagApplies(state) { return state?.status === 'decided' && !!state.contract; }
function taskPlanFile(cwd, milestone, slice, task) {
  return path.join(cwd, '.gsd', 'milestones', milestone, 'slices', slice, 'tasks', task, `${task}-PLAN.md`);
}
// A predecessor is complete only with the controller's own committed completion
// of that exact milestone/slice/task scope plus a verified historical delivery.
// A checked box or a SUMMARY file alone proves nothing.
function scopedCompletion(cwd, milestone, slice, task, records) {
  const unitKey = `execute-task/${task}`;
  let events = null, completedAt = null;
  // Unreadable or divergent records never prove a predecessor (fail closed).
  try { if (!records.some(isCompletion)) return false; } catch { return false; }
  return deliveryProven(cwd, milestone, slice, task, completedAt);
  // The completion is bound to its begin by durable lineage (milestone, unit, owner
  // digest, host and lease generation), never by the caller's key spelling.
  function sameLineage(left, right) {
    return left.milestone === milestone && right.milestone === milestone && left.unit?.key === unitKey && right.unit?.key === unitKey
      && typeof left.owner_digest === 'string' && left.owner_digest === right.owner_digest
      && left.host_runtime === right.host_runtime && typeof left.lease_generation === 'string' && left.lease_generation === right.lease_generation;
  }
  // The published event without its stream sequence must be exactly the committed transaction's event.
  function published(transaction) {
    const event = events.find(item => item.idempotency_key === transaction.idempotency_key);
    if (!event || !Number.isSafeInteger(event.sequence) || event.sequence < 1) return null;
    const content = { ...event }; delete content.sequence;
    return sha(content) === sha(transaction.event) ? event : null;
  }
  function isCompletion(tx) {
    if (tx.action !== 'complete' || tx.phase !== 'committed' || tx.milestone !== milestone || tx.unit?.key !== unitKey
      || tx.result?.status !== 'succeeded' || tx.boundary?.kind !== 'completed' || tx.boundary.handoff_ready !== true
      || typeof tx.idempotency_key !== 'string') return false;
    // Foreign, absent or ambiguous lineage never proves anything.
    const begins = records.filter(item => item.action === 'begin' && item.phase === 'committed' && sameLineage(item, tx)
      && item.after?.state?.active_slice === slice);
    const completions = records.filter(item => item.action === 'complete' && item.phase === 'committed' && item.result?.status === 'succeeded' && sameLineage(item, tx));
    if (begins.length !== 1 || completions.length !== 1) return false;
    events = events || readEvents(eventsFile(cwd, milestone));
    // Both ends symmetrically: the begin and the completion events are the committed ones, in order.
    const event = published(tx), beginEvent = published(begins[0]);
    if (!event || !beginEvent || !(beginEvent.sequence < event.sequence)) return false;
    if (beginEvent.event !== 'unit-began' || beginEvent.action !== 'begin' || event.outcome !== 'succeeded') return false;
    completedAt = event.ts;
    return true;
  }
}
// Historical proof through the clock's canonical capture validator: the input, the exact plan,
// the captured envelopes and their recorded workspace/roots, bounded by the committed completion.
// Today's source is never rerun or compared, so a completed task stays proven across later changes.
function deliveryProven(cwd, milestone, slice, task, completedAt) {
  try {
    return require('./forge-milestone-time-clock').readHistoricalTaskDelivery({ cwd, milestone, slice, task, completedAt }).status === 'proven';
  } catch { return false; }
}
// One bounded stable TaskPlan body per task. Every component from the physical owner .gsd down to
// the plan must be a real directory/file (no symlink or junction), so a foreign linked plan never
// supplies dependencies or bindings. The expected real path is rebuilt from the owner, never taken
// from the file's own resolution. The read itself is the shared owner collector's single-plan read
// (forge-plan-validation readOwnerTaskPlan, issue 343 U0d): the same walk, bound and fatal UTF-8
// decode the plan admission uses, with this guard's status/reason vocabulary unchanged.
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/, LOCAL_TASK_ID = /^T\d+(?:\.\d+)?$/;
function readTaskPlan(cwd, milestone, slice, task) {
  if (typeof task !== 'string' || !LOCAL_TASK_ID.test(task) || ![milestone, slice].every(item => typeof item === 'string' && SAFE_SEGMENT.test(item))) return { status: 'invalid', reason: 'path-invalid' };
  const read = planValidation().readOwnerTaskPlan(cwd, { milestone, slice, task });
  if (read.status !== 'ok') return read;
  // The collector keeps a leading BOM in the text; this guard's frontmatter never began with one.
  const text = read.content.replace(/^﻿/, '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return { status: 'valid', frontmatter: match ? match[1].replace(/\r\n/g, '\n') : null };
}
// The complete present `depends` declaration is read by the one structural decoder
// (forge-must-haves decodeDeclarationList, issue 343 U0a) through this guard's own fixed
// temporal projection (U0a-r1), never an option: a missing declaration and a YAML-null value
// (`depends:` followed by no list) are a root; whole-line and quote-aware inline comments are
// transparent, so every declared dependency is kept; a leading or interior blank gap, a scalar,
// multiline scalar, broken/mixed/unindented block, stray indented continuation, empty item,
// non-string item or repeated key is malformed (null).
function dependsOf(frontmatter) {
  const decoded = require('./forge-must-haves').decodeDeclarationList(frontmatter, 'depends');
  if (decoded.status === 'absent' || decoded.status === 'empty') return { depends: [] };
  if (decoded.status !== 'valid' || decoded.diagnostics.length || decoded.items.some(item => typeof item !== 'string')) return null;
  return { depends: [...decoded.items] };
}
// Dependencies come from the real task plans of one slice; IDs are scoped to
// that milestone/slice, so the same task ID elsewhere never satisfies them.
function taskDag(cwd, milestone, slice, tasks, records, now) {
  const ids = (tasks || []).map(item => item.id);
  if (new Set(ids).size !== ids.length) return { status: 'ambiguous', reasons: ['task-id-duplicate'], tasks: [] };
  const rows = [], plans = new Map();
  for (const id of ids) {
    const plan = readTaskPlan(cwd, milestone, slice, id);
    if (plan.status === 'invalid') return { status: 'unknown', reasons: [`task-plan-${plan.reason}:${id}`], tasks: [] };
    if (plan.status !== 'valid' || plan.frontmatter === null) return { status: 'unknown', reasons: [`task-plan-missing:${id}`], tasks: [] };
    plans.set(id, plan);
    const declared = dependsOf(plan.frontmatter);
    if (!declared) return { status: 'unknown', reasons: [`dependency-malformed:${id}`], tasks: [] };
    const depends = [...new Set(declared.depends)];
    const unknown = depends.find(dependency => !ids.includes(dependency));
    if (unknown) return { status: 'unknown', reasons: [`dependency-unknown:${id}:${unknown}`], tasks: [] };
    rows.push({ id, depends });
  }
  const visiting = new Set(), done = new Set();
  const cyclic = id => {
    if (done.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    const found = rows.find(row => row.id === id).depends.some(cyclic);
    visiting.delete(id); done.add(id);
    return found;
  };
  const cycle = rows.find(row => cyclic(row.id));
  if (cycle) return { status: 'cycle', reasons: [`dependency-cycle:${cycle.id}`], tasks: [] };
  const bound = bindTasks(cwd, milestone, slice, rows, records, now, plans);
  if (bound.status !== 'valid') return { status: bound.status, reasons: bound.reasons, tasks: [] };
  return { status: 'valid', reasons: [], tasks: rows.map(row => ({ ...row, barrier: bound.barrier,
    completion: scopedCompletion(cwd, milestone, slice, row.id, records) ? 'proven' : 'unproven' })) };
}
// --- Task-to-selected-node binding (opt-in contract milestones only) --------------
// Each owner-published TaskPlan of a planned slice declares three root scalars naming the
// exact selected options digest, position and ONE currently allocated node or authorized
// refinement part. The allocation, selected edges and slice DAG are re-read from the owner
// through selection.taskBindingContext; local `depends` keeps its local TaskID meaning.
const BINDING_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/, BINDING_HASH = /^[a-f0-9]{64}$/;
function taskBindingOf(plan) {
  try {
    if (plan.status === 'invalid') return { status: 'invalid', reason: plan.reason === 'link' ? 'binding-link' : `binding-plan-${plan.reason}` };
    if (plan.status !== 'valid') return { status: 'invalid', reason: 'binding-unreadable' };
    if (plan.frontmatter === null) return { status: 'absent', reason: 'binding-missing' };
    const lines = plan.frontmatter.split(/\r?\n/), values = {};
    let present = 0;
    for (const [key, pattern] of [['time_options_sha256', BINDING_HASH], ['time_position_id', BINDING_ID], ['time_node', BINDING_ID]]) {
      const declared = lines.filter(line => line.startsWith(key) && /^[ \t]*:/.test(line.slice(key.length)));
      if (!declared.length) continue;
      present++;
      const raw = declared[0].slice(declared[0].indexOf(':') + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
      if (declared.length > 1 || !pattern.test(raw)) return { status: 'invalid', reason: `binding-malformed:${key}` };
      values[key] = raw;
    }
    if (!present) return { status: 'absent', reason: 'binding-missing' };
    if (present !== 3) return { status: 'invalid', reason: 'binding-incomplete' };
    return { status: 'valid', options_sha256: values.time_options_sha256, position_id: values.time_position_id, node: values.time_node };
  } catch { return { status: 'invalid', reason: 'binding-unreadable' }; }
}
function bindTasks(cwd, milestone, slice, rows, records, now, plans) {
  const context = timeSelection.taskBindingContext(cwd, milestone, { sliceId: slice });
  if (context.status === 'absent') return { status: 'valid', barrier: [] };
  if (context.status !== 'ready') return { status: 'unknown', reasons: [`binding-context-${context.status}:${context.reason}`] };
  const unallocated = reason => ({ status: 'unallocated', reasons: [reason] });
  const unknown = reason => ({ status: 'unknown', reasons: [reason] });
  const matches = read => read.status === 'valid' && read.options_sha256 === context.options_sha256 && read.position_id === context.position_id;
  const own = new Set(context.allocated.map(item => item.id)), nodeOf = new Map();
  for (const row of rows) {
    const read = taskBindingOf(plans.get(row.id));
    if (read.status !== 'valid') return unallocated(`${read.reason}:${row.id}`);
    if (!matches(read)) return unallocated(`binding-foreign:${row.id}`);
    if (!own.has(read.node)) return unallocated(`binding-node-unallocated:${row.id}:${read.node}`);
    nodeOf.set(row.id, read.node);
  }
  const covered = new Set(nodeOf.values()), uncovered = [...own].sort().find(id => !covered.has(id));
  if (uncovered) return unallocated(`allocation-uncovered:${uncovered}`);
  const dependsOf = new Map(rows.map(row => [row.id, row.depends]));
  const reaches = (from, to, seen = new Set()) => dependsOf.get(from).some(next => next === to || (!seen.has(next) && seen.add(next) && reaches(next, to, seen)));
  const tasksOf = id => rows.filter(row => nodeOf.get(row.id) === id).map(row => row.id);
  const cross = [];
  for (const edge of context.edges) for (const from of edge.dependent.filter(item => item.slice === slice)) for (const to of edge.prerequisite) {
    if (to.slice === null) continue; // lifecycle rows (preparation/integration/review) keep their owner gates
    if (to.slice !== slice) {
      if (!context.prerequisite_slices.includes(to.slice)) return unknown(`edge-slice-unreachable:${edge.from}>${edge.to}:${to.slice}`);
      cross.push({ edge, to });
      continue;
    }
    for (const dependent of tasksOf(from.id)) for (const prerequisite of tasksOf(to.id)) {
      if (!reaches(dependent, prerequisite)) return unknown(`edge-unrealized:${edge.from}>${edge.to}:${dependent}:${prerequisite}`);
    }
  }
  // Barriers: every task of the validated prerequisite slice closure needs scoped completion plus
  // historical delivery and the slice its own canonical closure; unrelated future slices are never blocked.
  const milestoneDir = path.join(cwd, '.gsd', 'milestones', milestone);
  const barrier = [];
  for (const prerequisite of context.prerequisite_slices) {
    const dir = path.join(milestoneDir, 'slices', prerequisite), plan = path.join(dir, `${prerequisite}-PLAN.md`);
    const tasks = fs.existsSync(plan) ? forgeStatus.parsePlanTasks(fs.readFileSync(plan, 'utf8')) : [];
    if (!tasks.length) { barrier.push({ slice: prerequisite, task: null, reason: 'slice-unplanned' }); continue; }
    if (new Set(tasks.map(item => item.id)).size !== tasks.length) return unknown(`task-id-duplicate:${prerequisite}`);
    const closure = sliceClosure(cwd, milestone, prerequisite, now);
    if (closure) barrier.push({ slice: prerequisite, task: null, reason: closure.reason, proof: closure.proof });
    for (const task of tasks) if (!scopedCompletion(cwd, milestone, prerequisite, task.id, records)) barrier.push({ slice: prerequisite, task: task.id, reason: 'task-unproven' });
    for (const { edge, to } of cross.filter(item => item.to.slice === prerequisite)) {
      const realized = tasks.some(task => { const read = taskBindingOf(readTaskPlan(cwd, milestone, prerequisite, task.id)); return matches(read) && read.node === to.id; });
      if (!realized) return unknown(`edge-prerequisite-unrealized:${edge.from}>${edge.to}:${prerequisite}:${to.id}`);
    }
  }
  return { status: 'valid', barrier };
}
// A prerequisite slice is closed only by its canonical committed complete-slice record set
// (transaction, result, boundary and event) plus its verified historical SliceDELIVERY rebuilt
// from the input, the exact slice plan, the expected-child inventory and the captured envelopes
// (forge-milestone-time-clock.readHistoricalDeliveries), and by the review gate's own record
// bound into that fingerprinted delivery. A checkbox, a SUMMARY or task proofs alone never close it.
// Returns null when closed, else the typed barrier reason.
function sliceClosure(cwd, milestone, slice, now) {
  const incomplete = proof => ({ reason: 'slice-incomplete', proof });
  const base = `.gsd/milestones/${milestone}/slices/${slice}`;
  let read;
  try { read = require('./forge-milestone-time-clock').readHistoricalDeliveries({ cwd, milestone, slices: [slice], now }); }
  catch { return incomplete('slice-closure-unreadable'); }
  if (read.status !== 'observed') return incomplete(read.reason || 'slice-closure-unknown');
  const proven = read.proven.find(row => row.slice === slice);
  if (!proven) return incomplete(read.unproven.find(row => row.slice === slice)?.reason || 'delivery-completion-missing');
  // Read the projection the proof just rebuilt; it must name this slice's own plan.
  let stored;
  try {
    const file = path.join(cwd, ...proven.reference.split('/'));
    if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > require('./forge-delivery').MAX_FILE_BYTES) return incomplete('slice-delivery-unreadable');
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return incomplete('slice-delivery-unreadable'); }
  if (stored?.delivery_fingerprint !== proven.fingerprint) return incomplete('slice-delivery-unstable');
  if (String(stored.plan?.reference || '').replace(/\\/g, '/') !== `${base}/${slice}-PLAN.md`) return incomplete('slice-delivery-plan-foreign');
  // Review: the gate runs before complete-slice and records <S>-REVIEW.md; the completer binds it
  // as the review fact of the delivery input, so the fingerprinted history names the record.
  const unreviewed = proof => ({ reason: 'slice-unreviewed', proof });
  const fact = (stored.facts || []).find(item => item?.name === 'review');
  const reference = typeof fact?.reference === 'string' ? fact.reference.trim().replace(/\\/g, '/') : '';
  if (!fact || fact.status === 'não informado/pendente' || !reference) return unreviewed('slice-review-fact-missing');
  if (![`${slice}-REVIEW.md`, `./${slice}-REVIEW.md`, `${base}/${slice}-REVIEW.md`].includes(reference)) return unreviewed('slice-review-fact-foreign');
  try {
    const file = path.join(cwd, ...`${base}/${slice}-REVIEW.md`.split('/'));
    for (let cursor = file; path.resolve(cursor) !== path.resolve(cwd) && cursor !== path.dirname(cursor); cursor = path.dirname(cursor)) {
      if (fs.lstatSync(cursor).isSymbolicLink()) return unreviewed('slice-review-link');
    }
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0 || stat.size > 1024 * 1024) return unreviewed('slice-review-invalid');
  } catch { return unreviewed('slice-review-missing'); }
  return null;
}
// The shared begin/reenter guard: called under the controller mutex after a
// committed begin was replayed and beside budget admission, before any lease
// or transaction. Budget refusals keep their priority (checked first).
function assertTimeOptionAdmission(cwd, milestone, unit, key, slice, options, linked = {}) {
  const state = readTimeOptions(cwd, milestone, options);
  if (state === null) return null;
  const refuse = (code, extra) => {
    throw new ControllerError(code, 'entrada recusada pela seleção de prazo da milestone', { time_options: clone(state), ...(extra || {}) });
  };
  if (state.status === 'options-invalid') refuse('time-options-invalid');
  if (state.status === 'roadmap-preexisting') refuse('time-roadmap-selection-missing');
  if (state.status === 'estimate-required') {
    let expected = null;
    try { expected = timeSelection.estimateBeginKey(milestone, state.key_suffix); } catch { refuse('time-options-invalid'); }
    // Only the estimate of the current owner basis; a reentry continues that same begin.
    if (unit.type === 'estimate-milestone' && unit.id === milestone && (key === expected || linked.beginKey === expected)) return { status: state.status };
    refuse('time-option-pending');
  }
  if (state.status !== 'decided') refuse('time-option-pending');
  // An active contract needs the slice review gate for every new admission; a review mode
  // disabled after activation is named here instead of becoming a latent cross-slice block.
  if (state.contract) {
    const review = timeSelection.contractCompatibility(cwd, milestone, { prefsReader: options && options.prefsReader });
    if (review.status !== 'compatible') refuse(review.status === 'incompatible' ? 'time-review-disabled-incompatible' : 'time-review-mode-unknown', { review });
  }
  if (unit.type === 'estimate-milestone') refuse('time-unit-not-admitted');
  const milestoneDir = path.join(cwd, '.gsd', 'milestones', milestone);
  if (!firstExisting(milestoneDir, name => name.endsWith('-ROADMAP.md'))) {
    if (unit.type === 'plan-milestone' && unit.id === milestone) return { status: state.status };
    refuse('time-unit-not-admitted');
  }
  if (ROADMAP_TIME_BLOCKS[state.roadmap?.status]) refuse(ROADMAP_TIME_BLOCKS[state.roadmap.status]);
  if (taskDagApplies(state) && unit.type === 'execute-task') {
    if (!slice) refuse('time-task-identity-ambiguous', { task_dag: { slice: null, task: unit.id } });
    const plan = path.join(milestoneDir, 'slices', slice, `${slice}-PLAN.md`);
    const tasks = fs.existsSync(plan) ? forgeStatus.parsePlanTasks(fs.readFileSync(plan, 'utf8')) : [];
    const dag = taskDag(cwd, milestone, slice, tasks, discoverRecords(cwd, 'transaction'), nowOf(options));
    if (dag.status !== 'valid') refuse(TASK_DAG_BLOCKS[dag.status] || 'time-task-dependency-unknown', { task_dag: { slice, task: unit.id, ...dag } });
    const row = dag.tasks.find(item => item.id === unit.id);
    if (!row) refuse('time-task-dependency-unknown', { task_dag: { slice, task: unit.id, status: 'unknown', reasons: ['task-not-planned'] } });
    const pending = row.depends.filter(id => dag.tasks.find(item => item.id === id)?.completion !== 'proven');
    const barrier = row.barrier || [];
    if (pending.length || barrier.length) refuse('time-task-dependency-pending', { task_dag: { slice, task: unit.id, status: 'valid', pending, ...(barrier.length ? { barrier } : {}) } });
  }
  return { status: state.status };
}
function select(cwd, request, options) {
  const input = object(request, 'request');
  const prefsResult = resolvePrefs(cwd, options);
  const milestone = opaque(input.milestone, 'milestone', true);
  // forge-ids owns ID classification.  Unknown future IDs remain readable, so
  // classification is audit data rather than a migration/rejection trigger.
  const id_kind = forgeIds.entityKind(milestone) || 'milestone';
  const current = forgeState.read(cwd, milestone);
  if (!current) throw new ControllerError('invalid-request', `STATE ausente para ${milestone}`);
  const inventory = options && typeof options.inventoryReader === 'function' ? options.inventoryReader(cwd, milestone, current) : discoverInventory(cwd, milestone, current, options);
  inventory.deferred_slices = failureProjection(cwd, milestone).filter(item => !item.entry).map(item => item.slice).filter(Boolean);
  const selection = selectNextUnit({ state: current, inventory, prefs: prefsResult.prefs });
  // Issue 343 U1: an opted-in caller (orchestrate next in auto mode) also receives the same
  // enumeration the execute-task was picked from; nothing here selects, admits or begins more.
  const cohort = input.cohort === true && selection.ok && !selection.decomposition_verification && selection.unit.type === 'execute-task'
    ? cohortOf(cwd, milestone, inventory, selection.slice, options) : null;
  return { ...selection, id_kind, ...(cohort ? { cohort } : {}) };
}
// The pending tasks of the selected slice (canonical S-plan order), the admissible ones and
// the tasks whose scoped committed completion plus historical delivery prove them; a
// checkbox or a SUMMARY never proves a dependency. Read-only.
function cohortOf(cwd, milestone, inventory, sliceId, options) {
  const slice = (inventory.slices || []).find(item => item.id === sliceId);
  if (!slice) return { slice: sliceId, status: 'unknown', pending: [], admissible: [], proven: [] };
  const tasks = admissibleTasks(slice, inventory);
  let dag = tasks.dag;
  if (!dag) {
    try { dag = taskDag(cwd, milestone, sliceId, slice.tasks, discoverRecords(cwd, 'transaction'), nowOf(options)); }
    catch { dag = { status: 'unknown', reasons: ['task-dag-unreadable'], tasks: [] }; }
  }
  return { slice: sliceId, status: dag.status, pending: tasks.pending.map(item => item.id), admissible: tasks.ready.map(item => item.id),
    proven: (dag.tasks || []).filter(row => row.completion === 'proven').map(row => row.id) };
}

function logicalState(value) {
  if (!value) return null;
  const ignored = new Set(['file', '_raw', '_frontmatter', 'last_updated', 'owner', 'host_runtime', 'worker_engine', 'session', 'heartbeat', 'expires_at']);
  const output = {};
  for (const [key, item] of Object.entries(value)) if (!ignored.has(key)) output[key] = item;
  return stable(output);
}
function ownerDigest(ownerToken) { return `sha256:${sha(ownerToken)}`; }
function unitFromRequest(input) {
  if (input.unit && typeof input.unit === 'object') {
    const normalized = forgeRuntime.normalizeUnit({ ...input.unit, state: input.unit.state || 'queued' });
    return { type: normalized.type, id: normalized.id, key: forgeLease.normalizeUnitKey(normalized) };
  }
  const key = forgeLease.normalizeUnitKey(opaque(input.unit, 'unit', true));
  const separator = key.indexOf('/');
  return { type: separator < 0 ? key : key.slice(0, separator), id: separator < 0 ? '' : key.slice(separator + 1), key };
}
function transactionKey(input, action, unit) {
  const explicit = input.idempotency_key === undefined ? input.idempotencyKey : input.idempotency_key;
  return opaque(explicit, 'idempotency_key', false) || sha(`${action}\u0000${unit.key}\u0000${input.milestone || ''}\u0000${input.request_id || ''}`);
}
// A committed begin is still open until its own generation has a committed
// terminal transaction. ROADMAP/STATE, TTL and another unit's terminal do not
// close it. A partial pause stays resumable until a canonically linked begin.
function incompleteUnits(cwd, milestone) {
  const records = discoverRecords(cwd, 'transaction').filter(row => row.milestone === milestone);
  const closed = begin => records.some(row => row.phase === 'committed' && row.boundary?.handoff_ready === true
    && ['complete', 'pause', 'fail', 'expired-safe'].includes(row.action) && row.unit.key === begin.unit.key
    && row.lease_generation === begin.lease_generation && row.owner_digest === begin.owner_digest
    && (!row.owner_interruption || witnessedOwnerInterruption(cwd, row)));
  return records.filter(row => row.phase === 'committed' && (row.action === 'begin' && !closed(row)
    || row.action === 'pause' && row.result?.output?.partial_attempt
      && !records.some(next => next.action === 'begin' && next.resumed_pause?.key === row.idempotency_key
        && next.resumed_pause.checksum === sha(row))
    || row.action === 'pause' && row.result?.output?.decomposition_attempt
      && !records.some(next => next.action === 'begin' && next.phase === 'committed'
        && next.decomposition_entry?.pause_key === row.idempotency_key && validDecompositionEntry(cwd, next))
    || row.owner_interruption?.role === 'original' && witnessedOwnerInterruption(cwd, row)
      && !records.some(next => next.action === 'begin' && next.phase === 'committed'
        && next.linked_entry?.failure_key === row.idempotency_key && next.linked_entry.failure_checksum === sha(row))));
}
function partialQuestions(cwd, paused, options) {
  const original = paused.result.output.partial_attempt.pending_questions;
  const interaction = require('./forge-interaction');
  if (!original.some(row => row.status === 'pending')) return clone(original);
  if (typeof options?.questionStateAdapter !== 'function') throw new ControllerError('pending-questions', 'partial pause retains unanswered decisions');
  const observed = options.questionStateAdapter({ cwd, previous: { questions: clone(original) }, boundary: clone(paused.boundary) });
  const questions = interaction.resolvePendingQuestions(interaction.mergePendingQuestions(original, observed?.questions || []), observed?.answers || []);
  if (questions.some(row => row.status === 'pending')) throw new ControllerError('pending-questions', 'partial pause retains unanswered decisions');
  return questions;
}
function resumedPause(cwd, input, unit, options) {
  if (input.resume_from === undefined) return null;
  const paused = lookupRecord(cwd, 'transaction', input.resume_from);
  if (!paused || paused.phase !== 'committed' || paused.action !== 'pause' || !paused.boundary?.handoff_ready
    || paused.unit.key !== unit.key || paused.milestone !== input.milestone
    || input.slice && input.slice !== paused.after.state.active_slice) throw new ControllerError('unit-identity-mismatch', 'resume requires the exact durable paused unit');
  if (paused.result?.output?.partial_attempt) {
    const begin = lookupRecord(cwd, 'transaction', paused.result.output.partial_attempt.begin_key);
    const live = begin && inspectSettledAttempt(cwd, begin, options, ['partial', 'blocked'], false);
    if (!live || sha(live) !== sha(paused.result.output.partial_attempt)) throw new ControllerError('attempt-evidence-changed', 'paused attempt changed before resume');
  }
  return { key: paused.idempotency_key, checksum: sha(paused),
    pending_questions: paused.result?.output?.partial_attempt ? partialQuestions(cwd, paused, options) : [] };
}
function validatePausedEntry(cwd, begin, options) {
  const paused = lookupRecord(cwd, 'transaction', begin.resumed_pause?.key);
  if (!paused || sha(paused) !== begin.resumed_pause.checksum) throw new ControllerError('attempt-evidence-changed', 'paused entry changed');
  const questions = paused.result?.output?.partial_attempt ? partialQuestions(cwd, paused, options) : [];
  if (sha(questions) !== sha(begin.resumed_pause.pending_questions)) throw new ControllerError('pending-questions', 'actual answers changed');
  return questions;
}
function pendingTransactions(cwd) {
  return discoverRecords(cwd, 'transaction').filter(record => record.phase !== 'committed');
}
function assertLease(cwd, unit, ownerToken, generation) {
  const token = opaque(ownerToken, 'owner_token', true);
  const gen = opaque(generation, 'generation', true);
  const read = forgeLease.readLease(forgeLease.leaseFile(cwd, unit));
  if (!read.record) throw new ControllerError('lease-required', `lease ausente para ${unit}`);
  if (!forgeLease.validRecord(read.record, forgeLease.normalizeUnitKey(unit)) ||
      read.record.owner_token !== token || read.record.generation !== gen) {
    throw new ControllerError('lease-owner-mismatch', `lease não pertence ao token/generation informado`);
  }
  return read.record;
}

// ── Issue 343 U0d: strict new-plan generation at the native controller ──────────
// A NEW plan-slice begin is enrolled (plan_generation, bound to that begin by
// validateRecord); a NEW successful completion of an enrolled lineage admits the owner's
// current S-plan/T-plans strictly before any intent and carries plan_validation inside
// its normalized result, under result_checksum; an uncommitted intent publishes only the
// evidence it was admitted with; every new execute-task begin rechecks its slice's
// enrolled generation read-only. Committed history replays first and is never
// revalidated, backfilled or rewritten. None of this reads plan_gate.interactive,
// ask_in_auto, a plan-checker verdict or an approval marker.
// Lazy: forge-plan-validation reaches this controller lazily too, inside its read-only
// checks, so neither module loads the other at require time.
function planValidation() { return require('./forge-plan-validation.js'); }
// Issue 343 U1: batch member bindings and manifests; that module loads no Forge module at
// require time, so this lazy seam adds no cycle.
function executionBatch() { return require('./forge-execution-batch.js'); }
function planFail(code, detail) { throw Object.assign(new Error(`${code}: ${detail}`), { code, detail }); }
// A named refusal of the gate: the plan code itself, plus a closed diagnostic (stage,
// code, bounded detail, task, cause). Controller errors (record-conflict, lease) pass through.
function planRefusal(error, stage) {
  if (error instanceof ControllerError) return error;
  if (!error || typeof error.code !== 'string' || !/^plan-/.test(error.code)) return error;
  const detail = typeof error.detail === 'string' ? error.detail.slice(0, 500) : null;
  return new ControllerError(error.code, `geração do plano recusada (${stage})${detail ? `: ${detail}` : ''}`, { plan_generation: {
    stage, code: error.code, detail, task_id: typeof error.task_id === 'string' ? error.task_id : null,
    cause_code: typeof error.cause_code === 'string' ? error.cause_code : null } });
}
function physicalOwner(cwd) {
  try { return fs.realpathSync.native(cwd); }
  catch (error) { return planFail('plan-source-owner-unreadable', `owner físico ilegível (${error.code || 'error'})`); }
}
// The canonical predecessor begin of a continuation: the one committed begin of the same
// unit, milestone and lease generation as the transaction that ended its lineage. An
// unknown predecessor keeps the obligation (fail closed).
function predecessorEnrolled(cwd, milestone, unit, ended) {
  if (!ended || ended.unit?.key !== unit.key || ended.milestone !== milestone) return true;
  const begins = discoverRecords(cwd, 'transaction').filter(item => item.action === 'begin' && item.phase === 'committed'
    && item.unit.key === unit.key && item.milestone === milestone && item.lease_generation === ended.lease_generation);
  return begins.length !== 1 || own(begins[0], 'plan_generation');
}
// Whether a NEW plan-slice begin is enrolled: a fresh begin is; a continuation of the unit's
// current paused lineage inherits its predecessor's classification, so an enrolled lineage
// never loses its obligation and a genuine pre-requirement lineage stays unclassified.
function planBeginEnrolled(cwd, milestone, unit) {
  if (unit.type !== 'plan-slice') return false;
  const boundary = lookupRecord(cwd, 'boundary', unit.key);
  if (!boundary || boundary.kind !== 'paused' || boundary.milestone !== milestone) return true;
  return predecessorEnrolled(cwd, milestone, unit, lookupRecord(cwd, 'transaction', boundary.idempotency_key));
}
function planGenerationOf(cwd, milestone, unit, key, generation, ownerToken) {
  try {
    return planValidation().buildPlanGeneration({ owner: physicalOwner(cwd), milestone, slice: unit.id, begin_key: key,
      lease_generation: generation, owner_digest: ownerDigest(ownerToken) });
  } catch (error) { throw planRefusal(error, 'plan-slice-begin'); }
}
// The begin of one lineage: the single begin of the same unit, milestone and lease generation.
function lineageBegin(cwd, milestone, unit, generation, stage) {
  const begins = discoverRecords(cwd, 'transaction').filter(item => item.action === 'begin' && item.unit.key === unit.key
    && item.milestone === milestone && item.lease_generation === generation);
  if (begins.length > 1) throw planRefusal({ code: 'plan-generation-ambiguous', detail: `${unit.key} has ${begins.length} begins of one lease generation` }, stage);
  return begins[0] || null;
}
// A NEW successful completion of an enrolled plan-slice lineage: the enrollment of the real
// begin of this lease, its owner and host, then the strict admission of the owner's current
// plan bytes. A refusal happens before makeTransaction, so no intent, event, STATE or lease
// release exists and the lease stays held for a corrected plan. null: a genuine
// pre-requirement lineage (its begin carries no enrollment), completed as before.
function admitPlanCompletion(cwd, milestone, unit, generation, ownerToken, hostRuntime, options) {
  const stage = 'plan-slice-completion';
  const begin = lineageBegin(cwd, milestone, unit, generation, stage);
  if (!begin || !own(begin, 'plan_generation')) return null;
  try {
    const pv = planValidation();
    if (begin.phase !== 'committed') planFail('plan-generation-pending', `the enrolled ${unit.key} begin is not committed`);
    if (begin.owner_digest !== ownerDigest(ownerToken) || begin.host_runtime !== hostRuntime) {
      planFail('plan-generation-lineage-mismatch', `the completion is not the owner and host of the enrolled ${unit.key} begin`);
    }
    const owner = physicalOwner(cwd);
    const enrolled = pv.verifyPlanGeneration(begin.plan_generation, { begin_key: begin.idempotency_key, lease_generation: begin.lease_generation,
      owner_digest: begin.owner_digest, milestone, slice: unit.id });
    if (enrolled.owner !== require('./forge-code-roots').key(owner)) planFail('plan-generation-owner-mismatch', 'the enrollment belongs to another owner');
    const admission = pv.validateNewSlicePlan(pv.collectOwnerSlicePlan(cwd, { milestone, slice: unit.id }), { owner, milestone, slice: unit.id });
    return pv.buildPlanValidation(enrolled, admission, { validatedAt: iso(nowOf(options)) });
  } catch (error) { throw planRefusal(error, stage); }
}
// An uncommitted plan-slice intent publishes only the evidence it was admitted with: a
// successful completion of an enrolled lineage carries its nested plan_validation bound to
// that begin's enrollment; an unenrolled lineage carries none; a top-level alias never counts.
function assertPlanIntent(cwd, transaction) {
  if (transaction.unit?.type !== 'plan-slice') return;
  const stage = 'transaction-recovery';
  if (own(transaction, 'plan_validation')) throw planRefusal({ code: 'plan-generation-evidence-invalid', detail: 'a top-level plan_validation alias is never evidence' }, stage);
  if (transaction.action !== 'complete' || transaction.result?.status !== 'succeeded') return;
  const begin = lineageBegin(cwd, transaction.milestone, transaction.unit, transaction.lease_generation, stage);
  const carried = own(transaction.result, 'plan_validation');
  if (!begin || !own(begin, 'plan_generation')) {
    if (carried) throw planRefusal({ code: 'plan-generation-evidence-invalid', detail: 'plan_validation without an enrolled begin' }, stage);
    return;
  }
  if (!carried) throw planRefusal({ code: 'plan-generation-evidence-missing', detail: 'the enrolled completion intent carries no plan_validation' }, stage);
  try { planValidation().verifyPlanValidation(transaction.result.plan_validation, begin.plan_generation); }
  catch (error) { throw planRefusal(error, stage); }
}
// Every new execute-task begin (first entry and linked reentry): the slice's enrolled
// generation is current, read-only, through the classification shared with the sidecar.
// A milestone ID outside the enrollment grammar can carry no enrollment (buildPlanGeneration
// refuses it); an unknown or unsafe slice passes only while no slice of the milestone is enrolled.
function assertExecuteGeneration(cwd, milestone, slice) {
  const pv = planValidation();
  if (!pv.isScopeSegment(milestone)) return null;
  const known = pv.isScopeSegment(slice) ? slice : null;
  try { return pv.assertSliceGeneration(cwd, { owner: physicalOwner(cwd), milestone, slice: known }); }
  catch (error) { throw planRefusal(error, 'execute-begin'); }
}

// The status normalizedResult will record for a complete request (same checks, same order).
function completionSucceeds(input) {
  const source = input.result || {};
  assertJsonSafe(source, 'result');
  return forgeRuntime.normalizeResult({ ...source, status: source.status || 'succeeded' }).status === 'succeeded';
}
function normalizedResult(input, action, unit, key, milestone, now) {
  if (action === 'begin' || action === 'running') return null;
  const source = input.result || {};
  assertJsonSafe(source, 'result');
  const defaults = action === 'complete' ? 'succeeded' : action === 'pause' ? 'cancelled' : action === 'persist-result' ? 'succeeded' : 'failed';
  const normalized = forgeRuntime.normalizeResult({ ...source, status: source.status || defaults });
  const summary = opaque(input.summary === undefined ? source.summary : input.summary, 'summary', false) || '';
  return {
    protocol_version: PROTOCOL_VERSION,
    idempotency_key: key,
    unit: unit.key,
    milestone,
    status: normalized.status,
    reason_code: normalized.reason_code || action,
    summary,
    output: normalized.output,
    committed_at: iso(now),
  };
}
function boundaryKind(action) {
  if (action === 'complete') return 'completed';
  if (action === 'pause') return 'paused';
  if (action === 'fail') return 'failed-persisted';
  if (action === 'expired-safe') return 'expired-safe';
  return null;
}
function defaultStatePatch(action, unit, hostRuntime, ownerToken, now) {
  const patch = {
    phase: action === 'fail' ? 'blocked' : unit.type,
    active_task: unit.type === 'execute-task' ? unit.id : '—',
    host_runtime: hostRuntime,
    owner: ownerDigest(ownerToken),
    heartbeat: iso(now),
  };
  if (action === 'pause') patch.auto_mode = 'off';
  if (action === 'complete' || action === 'expired-safe') patch.owner = null;
  return patch;
}
function makeTransaction(cwd, input, action, unit, key, ownerToken, generation, hostRuntime, now, extra) {
  const milestone = opaque(input.milestone, 'milestone', true);
  const before = forgeState.read(cwd, milestone);
  if (!before) throw new ControllerError('invalid-request', `STATE ausente para ${milestone}`);
  const suppliedPatch = input.state_patch || input.statePatch || {};
  assertJsonSafe(suppliedPatch, 'state_patch');
  const patch = { ...defaultStatePatch(action, unit, hostRuntime, ownerToken, now), ...suppliedPatch };
  // Authorization material is never a STATE/status field.
  delete patch.owner_token;
  const after = { ...before, ...patch };
  const result = normalizedResult(input, action, unit, key, milestone, now);
  // Issue 343 U0d: owner-built plan evidence joins the normalized result (never caller input)
  // before the event and boundary checksums are composed, so result_checksum covers it.
  if (result && extra && extra.planValidation) result.plan_validation = clone(extra.planValidation);
  const kind = boundaryKind(action);
  const event = {
    protocol_version: PROTOCOL_VERSION,
    idempotency_key: key,
    ts: iso(now),
    event: action === 'begin' ? 'unit-began' : action === 'persist-result' ? 'result-persisted' : 'unit-transition',
    action,
    unit: unit.key,
    milestone,
    host_runtime: hostRuntime,
    outcome: result ? result.status : 'running',
    reason_code: result ? result.reason_code : action,
  };
  const boundary = kind ? {
    protocol_version: PROTOCOL_VERSION,
    idempotency_key: key,
    unit: unit.key,
    milestone,
    kind,
    outcome: result.status,
    reason_code: result.reason_code,
    result_ref: path.relative(cwd, resultFile(cwd, key)).split(path.sep).join('/'),
    result_checksum: sha(result),
    event_checksum: sha(event),
    state_checksum: sha(logicalState(after)),
    previous_host_runtime: hostRuntime,
    handoff_ready: false,
    committed_at: null,
  } : null;
  return {
    protocol_version: PROTOCOL_VERSION,
    idempotency_key: key,
    action,
    unit,
    milestone,
    host_runtime: hostRuntime,
    owner_digest: ownerDigest(ownerToken),
    lease_generation: generation,
    phase: 'intent',
    created_at: iso(now),
    updated_at: iso(now),
    before: { state_checksum: sha(logicalState(before)), state: logicalState(before) },
    after: { state_checksum: sha(logicalState(after)), state: logicalState(after), state_patch: patch },
    result,
    event,
    boundary,
  };
}

function saveTransaction(cwd, transaction, now, options) {
  transaction.updated_at = iso(now);
  saveRecord(cwd, 'transaction', transaction.idempotency_key, transaction, options);
}
function setPhase(cwd, transaction, phase, options) {
  transaction.phase = phase;
  saveTransaction(cwd, transaction, nowOf(options), options);
  fail(options, `after-${phase}`);
}
function publishResult(cwd, record) {
  if (!record) return;
  withMutex(cwd, `unit-controller-result-${sha(record.idempotency_key).slice(0, 32)}`, () => {
    const existing = lookupRecord(cwd, 'result', record.idempotency_key);
    if (existing && stableStringify(existing) !== stableStringify(record)) {
      throw new ControllerError('invalid-request', 'idempotency_key já aponta para resultado diferente');
    }
    if (!existing) saveRecord(cwd, 'result', record.idempotency_key, record);
  });
}
function readEvents(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return [];
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new ControllerError('invalid-request', `evento inválido em ${file}:${index + 1}`); }
  });
}
function publishEvent(cwd, milestone, event) {
  const file = eventsFile(cwd, milestone);
  withMutex(cwd, `unit-controller-events-${sha(file).slice(0, 32)}`, () => {
    const events = readEvents(file);
    const existing = events.find(item => item.idempotency_key === event.idempotency_key);
    if (existing) {
      const withoutSequence = { ...existing }; delete withoutSequence.sequence;
      if (stableStringify(withoutSequence) !== stableStringify(event)) {
        throw new ControllerError('invalid-request', 'idempotency_key já aponta para evento diferente');
      }
      return;
    }
    const record = { ...event, sequence: events.length + 1 };
    // Preserve historical UTF-8 line bytes (CRLF and formatting included).
    // Re-serializing old records invalidates pinned route evidence mid-settle.
    const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const content = previous + (previous && !previous.endsWith('\n') ? '\n' : '') + JSON.stringify(record) + '\n';
    writeAtomic(file, content, true);
  });
}
function publishBoundary(cwd, boundary) {
  if (!boundary) return;
  withMutex(cwd, `unit-controller-boundary-${sha(boundary.unit).slice(0, 32)}`, () => {
    const current = lookupRecord(cwd, 'boundary', boundary.unit);
    if (current && current.idempotency_key !== boundary.idempotency_key && current.handoff_ready !== true) {
      throw new ControllerError('transaction-pending', `boundary anterior ainda não está pronta para ${boundary.unit}`);
    }
    saveRecord(cwd, 'boundary', boundary.unit, boundary);
  });
}
function publishState(cwd, transaction) {
  const current = forgeState.read(cwd, transaction.milestone);
  if (!current) throw new ControllerError('invalid-request', `STATE ausente para ${transaction.milestone}`);
  // Reapply only the owned patch.  This makes recovery preserve unrelated
  // fields written after intent while retaining the recorded logical target.
  if (transaction.after.prepared_state) {
    forgeState.commitPreparedUpdate(cwd, transaction.milestone, transaction.after.state_patch,
      transaction.after.prepared_state, { at: transaction.created_at });
  } else forgeState.updateFields(cwd, transaction.milestone, transaction.after.state_patch);
}

function runTransaction(cwd, transaction, ownerToken, generation, options) {
  const phases = new Set(PHASES);
  if (!phases.has(transaction.phase)) throw new ControllerError('invalid-request', `fase de transação desconhecida: ${transaction.phase}`);
  if (transaction.phase === 'committed') return { ok: true, reason: 'already-committed', transaction: publicTransaction(transaction, cwd) };
  // Issue 343 U0d: an uncommitted plan-slice intent (new or recovered by resume) proves its
  // saved evidence before anything is published or republished; committed history above never is.
  assertPlanIntent(cwd, transaction);
  // Every phase that can still publish result/event/boundary/STATE is guarded
  // by the exact lease generation.  A recovered or missing lease must never
  // be treated as implicit authorization to finish an old transaction.
  const leaseRequiredPhases = new Set(['intent', 'result-published', 'event-published', 'boundary-pending', 'state-published']);
  if (leaseRequiredPhases.has(transaction.phase)) {
    assertLease(cwd, transaction.unit.key, ownerToken, generation);
  }
  if (transaction.phase === 'intent') {
    publishResult(cwd, transaction.result);
    setPhase(cwd, transaction, 'result-published', options);
  }
  if (transaction.phase === 'result-published') {
    publishEvent(cwd, transaction.milestone, transaction.event);
    setPhase(cwd, transaction, 'event-published', options);
  }
  if (transaction.phase === 'event-published') {
    publishBoundary(cwd, transaction.boundary);
    setPhase(cwd, transaction, 'boundary-pending', options);
  }
  if (transaction.phase === 'boundary-pending') {
    publishState(cwd, transaction);
    setPhase(cwd, transaction, 'state-published', options);
  }
  if (transaction.phase === 'state-published') {
    if (transaction.boundary) {
      // Record the release intent before touching the lease.  If the process
      // dies after the owner-scoped release but before the next transaction
      // checkpoint, recovery can safely observe the durable marker and finish
      // the boundary without guessing whether a lease was already removed.
      setPhase(cwd, transaction, 'lease-release-pending', options);
    } else {
      setPhase(cwd, transaction, 'lease-released', options);
    }
  }
  if (transaction.phase === 'lease-release-pending') {
    const observed = forgeLease.observe(cwd, transaction.unit.key, options || {});
    if (observed.lease) {
      assertLease(cwd, transaction.unit.key, ownerToken, generation);
      const released = forgeLease.release(cwd, transaction.unit.key, ownerToken, generation);
      if (!released.ok) throw new ControllerError('lease-owner-mismatch', `release negado: ${released.reason}`);
    }
    setPhase(cwd, transaction, 'lease-released', options);
  }
  if (transaction.phase === 'lease-released') {
    if (transaction.boundary) {
      transaction.boundary.handoff_ready = true;
      transaction.boundary.committed_at = iso(nowOf(options));
      publishBoundary(cwd, transaction.boundary);
    }
    setPhase(cwd, transaction, 'boundary-ready', options);
  }
  if (transaction.phase === 'boundary-ready') setPhase(cwd, transaction, 'committed', options);
  // Issue 343 U5: a batch member's terminal is one typed owner operation with exact effects; the
  // cohort coordinator's activity is not an owner-activity measurement of this transaction.
  if (transaction.action === 'complete' && !(options && options.batchTerminal === true)) {
    try { recordOwnerBoundaryActivity(cwd, transaction.milestone, transaction.host_runtime); } catch { /* unknown owner activity never becomes workflow authority */ }
  }
  return { ok: true, reason: 'transition-committed', transaction: publicTransaction(transaction, cwd) };
}
function publicTransaction(transaction, cwd) {
  return {
    protocol_version: transaction.protocol_version,
    idempotency_key: transaction.idempotency_key,
    action: transaction.action,
    unit: transaction.unit.key,
    milestone: transaction.milestone,
    host_runtime: transaction.host_runtime,
    phase: transaction.phase,
    result_ref: transaction.result ? path.basename(resultFile(cwd, transaction.idempotency_key)) : null,
    boundary: transaction.boundary ? clone(transaction.boundary) : null,
  };
}

function begin(cwd, request, options) {
  resolvePrefs(cwd, options); // reject preferences before even creating a mutex
  if (request && typeof request === 'object' && !Array.isArray(request) && own(request, 'members')) {
    return withMutex(cwd, 'unit-controller-transactions', () => beginMembersInside(cwd, request, options));
  }
  return withMutex(cwd, 'unit-controller-transactions', () => beginInside(cwd, request, options));
}
// Serial workflow entry only. Independent/batched low-level begin remains
// available; no request/options flag can disable this named boundary.
const SERIAL_BEGIN_CONTEXT = Symbol('serial-begin-context');
function beginSerial(cwd, request, options) {
  resolvePrefs(cwd, options);
  return withMutex(cwd, 'unit-controller-transactions', () => beginInside(cwd, request, options, { serialBoundary: SERIAL_BEGIN_CONTEXT }));
}
function decideTimeAdmission(cwd, options) {
  return require('./forge-milestone-time-admission').decideAdmission(cwd, options);
}
// Issue 343 U1: the member begins of one published batch manifest (forge-execution-batch),
// in manifest order, under the ONE transaction mutex hold of begin() and without reentrance.
// Each member is the ordinary beginInside — its own time admission, gates, explicit slice,
// owner, runtime, idempotency key and lease generation — plus the member binding recorded on
// its begin. A refused member is reported, never retried; when the first member is refused
// no later member begins. A failpoint or an uncoded error propagates unchanged.
function beginMembersInside(cwd, request, options) {
  const input = object(request, 'request'), batchApi = executionBatch();
  if (!Array.isArray(input.members) || !input.members.length || input.members.length > batchApi.MAX_MEMBERS) {
    throw new ControllerError('invalid-request', 'members do batch inválidos');
  }
  // Provenance before any lease: every member is exactly a member of its published manifest
  // (same digest, key, unit, milestone, slice, host and owner); a JSON binding alone is nothing.
  const manifests = new Map();
  const manifestOf = batchId => {
    if (!manifests.has(batchId)) {
      let manifest = null;
      try { manifest = batchApi.readManifest(cwd, batchId); } catch { manifest = null; }
      manifests.set(batchId, manifest);
    }
    return manifests.get(batchId);
  };
  const members = input.members.map(entry => {
    const member = object(entry, 'member');
    const key = opaque(member.idempotency_key, 'idempotency_key', true), unit = unitFromRequest(member);
    if (!batchApi.validBinding(member.batch, key, unit)) throw new ControllerError('invalid-request', 'vínculo do membro do batch inválido');
    const manifest = manifestOf(member.batch.batch_id), listed = manifest && manifest.members[member.batch.member_index];
    const token = opaque(member.owner_token === undefined ? member.ownerToken : member.owner_token, 'owner_token', true);
    if (!listed || manifest.manifest_sha256 !== member.batch.manifest_sha256 || listed.begin_key !== key || listed.unit !== unit.key
        || manifest.milestone !== member.milestone || manifest.slice !== member.slice || manifest.owner_digest !== ownerDigest(token)
        || manifest.host_runtime !== forgeRuntime.normalizeHostRuntime(member.host_runtime === undefined ? member.hostRuntime : member.host_runtime)) {
      throw new ControllerError('record-conflict', 'membro fora do manifesto de batch publicado');
    }
    return { member, key };
  });
  // Batch workflow admission composes the serial lineage guard with the canonical
  // full manifest. A caller may request its ordered subset after real placement refusals;
  // omitted/foreign/unknown incomplete begins are never exempted by JSON membership.
  const manifest = manifests.size === 1 ? [...manifests.values()][0] : null;
  if (!manifest || members.some(({ member }, index) => index > 0 && member.batch.member_index <= members[index - 1].member.batch.member_index)) {
    throw new ControllerError('record-conflict', 'batch requests must be an ordered subset of one canonical manifest');
  }
  const requested = new Map(members.map(({ member, key }) => [key, member]));
  const incomplete = incompleteUnits(cwd, manifest.milestone).filter(row => {
    const member = requested.get(row.idempotency_key), listed = member && manifest.members[member.batch.member_index];
    const foreign = !listed || row.action !== 'begin' || row.unit.key !== listed.unit || row.milestone !== manifest.milestone
      || row.host_runtime !== manifest.host_runtime || row.owner_digest !== manifest.owner_digest
      || !executionBatch().validBinding(row.batch, row.idempotency_key, row.unit)
      || stableStringify(row.batch) !== stableStringify(executionBatch().memberBinding(manifest, listed));
    if (foreign) return true;
    // A committed begin is not completion, and its historical no-op replay does
    // not assert a live lease. Validate every exempt sibling BEFORE any new begin.
    // lookupRecord revalidates canonical storage checksums; use the recorded
    // generation and the same ownership-only lease primitive as canonical replay.
    // An expired but identically owned lease remains valid here; never infer death.
    const current = lookupRecord(cwd, 'transaction', row.idempotency_key);
    if (!current || sha(current) !== sha(row)) throw new ControllerError('record-conflict', 'batch begin changed during lineage admission');
    if (member.generation !== undefined && member.generation !== row.lease_generation) {
      throw new ControllerError('lease-owner-mismatch', 'batch replay generation differs from its begin');
    }
    assertLease(cwd, row.unit.key, member.owner_token === undefined ? member.ownerToken : member.owner_token, row.lease_generation);
    return false;
  });
  if (incomplete.length) {
    if (incomplete.some(row => members.some(({ member }) => row.unit.key === unitFromRequest(member).key)
      && forgeLease.observe(cwd, row.unit.key, options || {}).reason === 'lease-active')) {
      throw new ControllerError('lease-active', 'selected batch unit already has an active foreign lease');
    }
    throw new ControllerError('unit-incomplete', 'settle or resume the existing unit before batch advance', {
      units: incomplete.map(row => ({ idempotency_key: row.idempotency_key, unit: row.unit, begin_checksum: sha(row),
        generation: row.lease_generation, milestone: row.milestone, host_runtime: row.host_runtime, owner_digest: row.owner_digest })) });
  }
  const outcomes = [];
  for (const [index, { member, key }] of members.entries()) {
    try {
      outcomes.push({ ok: true, idempotency_key: key, result: beginInside(cwd, member, options, { batch: member.batch }) });
    } catch (error) {
      if (!error || typeof error.code !== 'string' || error.code === 'CONTROLLER_FAILPOINT') throw error;
      outcomes.push({ ok: false, idempotency_key: key, error });
      if (index === 0) break;
    }
  }
  return { ok: outcomes[0].ok === true, reason: 'batch-members', members: outcomes };
}
function beginInside(cwd, request, options, extra = {}) {
  const serialBoundary = extra.serialBoundary === SERIAL_BEGIN_CONTEXT;
  const input = object(request, 'request');
  const selection = input.unit ? { ok: true, milestone: input.milestone, unit: unitFromRequest(input), slice: input.slice || null }
    : select(cwd, input, options);
  if (!selection.ok) return selection;
  const unit = selection.unit;
  const ownerToken = opaque(input.owner_token === undefined ? input.ownerToken : input.owner_token, 'owner_token', true);
  const hostRuntime = forgeRuntime.normalizeHostRuntime(input.host_runtime === undefined ? input.hostRuntime : input.host_runtime);
  const key = transactionKey(input, 'begin', unit);
  const existing = lookupRecord(cwd, 'transaction', key);
  const suppliedPatch = input.state_patch || input.statePatch || {};
  const hasPatchedSlice = own(suppliedPatch, 'active_slice');
  if (unit.type === 'execute-task' && hasPatchedSlice
    && (typeof suppliedPatch.active_slice !== 'string' || !suppliedPatch.active_slice.trim() || suppliedPatch.active_slice === '—')) {
    throw new ControllerError('unit-identity-mismatch', 'slice da task ausente no patch');
  }
  const declaredSlice = input.slice || (hasPatchedSlice ? suppliedPatch.active_slice : null);
  const effectiveSlice = existing ? existing.after.state.active_slice : hasPatchedSlice ? suppliedPatch.active_slice
    : forgeState.read(cwd, input.milestone)?.active_slice;
  if (existing && (existing.unit.key !== unit.key || existing.milestone !== input.milestone || existing.action !== 'begin'
    || declaredSlice && declaredSlice !== existing.after.state.active_slice)) {
    throw new ControllerError('record-conflict', 'idempotency_key pertence a outra operação');
  }
  // Issue 343 U1: a batch member begin replays only under its own manifest member binding, and
  // no other begin request (single path, CLI or JSON) adopts or strips that binding.
  const boundBatch = extra && extra.batch ? extra.batch : null;
  if (existing && (own(existing, 'batch') || boundBatch)
      && stableStringify(own(existing, 'batch') ? existing.batch : null) !== stableStringify(boundBatch)) {
    throw new ControllerError('record-conflict', 'begin pertence a outro membro de batch');
  }
  if (input.slice && input.slice !== effectiveSlice
    || input.slice && suppliedPatch.active_slice && input.slice !== suppliedPatch.active_slice) {
    throw new ControllerError('unit-identity-mismatch', 'slice declarada diverge do estado da unidade');
  }
  if (!existing) executionBatch().assertPostUnitBoundary(cwd);
  const availabilitySlice = unit.type === 'execute-task' ? (effectiveSlice === '—' ? null : effectiveSlice) : input.slice;
  assertUnitAvailable(cwd, input.milestone, unit, availabilitySlice, options);
  let serialResumed = null, decomposed = null, parentVerification = null;
  if (existing?.decomposition_verification && input.decomposition_verification_from === undefined) throw new ControllerError('record-conflict', 'parent verification binding cannot be stripped');
  if (input.decomposition_verification_from !== undefined) {
    if (!serialBoundary) throw new ControllerError('unit-identity-mismatch', 'parent verification uses canonical serial entry');
    parentVerification = decompositionVerification(cwd, { ...input, slice: availabilitySlice }, unit, ownerToken, hostRuntime);
    if (existing && sha(existing.decomposition_verification) !== sha(parentVerification)) throw new ControllerError('record-conflict', 'parent verification changed');
  }
  if (existing?.decomposition_entry && input.decomposition_from === undefined) throw new ControllerError('record-conflict', 'the decompose continuation binding cannot be stripped');
  if (input.decomposition_from !== undefined) {
    if (!serialBoundary) throw new ControllerError('unit-identity-mismatch', 'decompose requires canonical serial entry');
    decomposed = decompositionEntry(cwd, { ...input, slice: availabilitySlice }, unit, ownerToken, hostRuntime, options);
    if (existing && sha(existing.decomposition_entry) !== sha(decomposed)) throw new ControllerError('record-conflict', 'decompose entry changed');
  }
  if (serialBoundary) {
    if (existing?.resumed_pause) { validatePausedEntry(cwd, existing, options); serialResumed = existing.resumed_pause; }
    else serialResumed = resumedPause(cwd, input, unit, options);
    const incomplete = incompleteUnits(cwd, input.milestone).filter(row => row.idempotency_key !== key
      && row.idempotency_key !== serialResumed?.key && row.idempotency_key !== decomposed?.pause_key);
    if (incomplete.length) {
      // Preserve the real unit lease refusal when another owner contests that
      // same unit. A different unfinished unit still blocks historical S02 replay.
      if (incomplete.some(row => row.unit.key === unit.key) && forgeLease.observe(cwd, unit.key, options || {}).reason === 'lease-active') {
        throw new ControllerError('lease-active', 'selected unit already has an active lease');
      }
      throw new ControllerError('unit-incomplete', 'settle or resume the existing unit before serial advance', {
        existing_begin: existing ? { idempotency_key: key, phase: existing.phase, begin_checksum: sha(existing),
          generation: existing.lease_generation, owner_digest: existing.owner_digest, host_runtime: existing.host_runtime,
          milestone: existing.milestone, unit: existing.unit.key } : null,
        units: incomplete.map(row => ({ idempotency_key: row.idempotency_key, unit: row.unit, action: row.action,
          begin_checksum: sha(row), generation: row.lease_generation, milestone: row.milestone, host_runtime: row.host_runtime, owner_digest: row.owner_digest })) });
    }
    fail(options, 'serial-lineage-checked');
  }
  if (existing) return runTransaction(cwd, existing, ownerToken,
    input.generation || (serialBoundary || boundBatch ? existing.lease_generation : undefined), options);
  const otherPending = pendingTransactions(cwd);
  if (otherPending.length) throw new ControllerError('transaction-pending', 'recovery obrigatório antes de novo begin');
  const resumed = serialBoundary ? serialResumed : resumedPause(cwd, input, unit, options);
  const admission = decideTimeAdmission(cwd,
    { milestone: input.milestone, unit, key, now: options && options.now, kind: 'begin' });
  if (!admission.allowed) throw new ControllerError(admission.reason_code, 'Entrada recusada pelo contrato de tempo da milestone', admission.details);
  // After replay and beside budget admission: an explicit unit, an injected
  // inventory or a stale snapshot cannot bypass the owner's S02 state.
  assertTimeOptionAdmission(cwd, input.milestone, unit, key, availabilitySlice, options);
  // Issue 343 U0d, read-only and independent of the time contract: a new execute-task begin
  // needs its slice's enrolled generation current; a new plan-slice begin is classified for
  // enrollment. Both decide before any path probe, lease or record.
  const recordMilestone = opaque(input.milestone, 'milestone', true); // the form makeTransaction records
  if (unit.type === 'execute-task') assertExecuteGeneration(cwd, recordMilestone, availabilitySlice);
  const enrolled = planBeginEnrolled(cwd, recordMilestone, unit);
  preflightPaths(cwd, key, unit.key, input.milestone);
  try { recordOwnerBoundaryActivity(cwd, input.milestone, hostRuntime); } catch { /* measurement remains unknown; no workflow decision changes */ }
  const acquired = forgeLease.acquire(cwd, unit.key, {
    ownerToken,
    requestId: key,
    hostRuntime,
    session: input.session,
    ttlMs: input.ttl_ms || input.ttlMs,
    graceMs: input.grace_ms || input.graceMs,
    now: options && options.now,
  });
  if (!acquired.ok) throw new ControllerError(acquired.reason === 'lease-active' ? 'lease-active' : 'lease-required', `acquire negado: ${acquired.reason}`);
  let transaction;
  try {
    fail(options, 'before-make-transaction');
    transaction = makeTransaction(cwd, input, 'begin', unit, key, ownerToken, acquired.generation, hostRuntime, nowOf(options));
    if (resumed) transaction.resumed_pause = resumed;
    if (decomposed) transaction.decomposition_entry = decomposed;
    if (parentVerification) transaction.decomposition_verification = parentVerification;
    if (admission.record || admission.decision === 'boundary-continuation' && admission.details.contract !== 'absent') {
      transaction.time_admission = admission.record || { decision: admission.decision, ...admission.details };
    }
    // The enrollment of this real begin: its key, lease generation, owner digest and owner.
    if (enrolled) transaction.plan_generation = clone(planGenerationOf(cwd, transaction.milestone, unit, key, acquired.generation, ownerToken));
    // Issue 343 U1: the member binding of a batch begin (validated again on every read).
    if (boundBatch) transaction.batch = clone(boundBatch);
    saveTransaction(cwd, transaction, nowOf(options), options);
  } catch (error) {
    let durable;
    try {
      durable = lookupRecord(cwd, 'transaction', key) || lookupRecord(cwd, 'result', key);
    } catch (inspectionError) {
      error.reconciliation = { required: true, reason: 'durability-ambiguous', cause: inspectionError.message };
      throw error;
    }
    if (durable || acquired.reason !== 'acquired') {
      error.reconciliation = { required: true, reason: durable ? 'durable-record' : 'reused-lease' };
    } else {
      try {
        fail(options, 'before-rollback-release');
        const released = forgeLease.release(cwd, unit.key, ownerToken, acquired.generation, { requestId: key });
        error.rollback = released;
        if (!released.ok) error.reconciliation = { required: true, reason: released.reason };
      } catch (releaseError) {
        error.reconciliation = { required: true, reason: 'rollback-failed', cause: releaseError.message };
      }
    }
    throw error;
  }
  fail(options, 'after-intent');
  const output = runTransaction(cwd, transaction, ownerToken, acquired.generation, options);
  output.owner_token = ownerToken;
  output.generation = acquired.generation;
  return output;
}

function transition(cwd, request, options) {
  resolvePrefs(cwd, options);
  const input = object(request, 'request');
  if (assertAction(input.action) === 'begin') return begin(cwd, input, options);
  return withMutex(cwd, 'unit-controller-transactions', () => transitionInside(cwd, request, options));
}
function transitionInside(cwd, request, options) {
  const input = object(request, 'request');
  const action = assertAction(input.action);
  const unit = unitFromRequest(input);
  const ownerToken = opaque(input.owner_token === undefined ? input.ownerToken : input.owner_token, 'owner_token', true);
  const generation = opaque(input.generation, 'generation', true);
  const hostRuntime = forgeRuntime.normalizeHostRuntime(input.host_runtime === undefined ? input.hostRuntime : input.host_runtime);
  const key = transactionKey(input, action, unit);
  const existing = lookupRecord(cwd, 'transaction', key);
  if (existing && (existing.unit.key !== unit.key || existing.milestone !== input.milestone || existing.action !== action)) {
    throw new ControllerError('record-conflict', 'idempotency_key pertence a outra operação');
  }
  if (existing) return runTransaction(cwd, existing, ownerToken, generation, options);
  const otherPending = pendingTransactions(cwd);
  if (otherPending.length) throw new ControllerError('transaction-pending', 'recovery obrigatório antes de nova transição');
  assertLease(cwd, unit.key, ownerToken, generation);
  // Issue 343 U0d: a new successful plan-slice completion of an enrolled lineage admits the
  // owner plan first; a refusal leaves no intent and the lease held for a corrected plan.
  const planValidationRecord = action === 'complete' && unit.type === 'plan-slice' && completionSucceeds(input)
    ? admitPlanCompletion(cwd, opaque(input.milestone, 'milestone', true), unit, generation, ownerToken, hostRuntime, options) : null;
  if (planValidationRecord) fail(options, 'after-plan-validation');
  const transaction = makeTransaction(cwd, input, action, unit, key, ownerToken, generation, hostRuntime, nowOf(options),
    planValidationRecord ? { planValidation: planValidationRecord } : undefined);
  if (options && options.batchTerminalState) transaction.after.prepared_state = clone(options.batchTerminalState);
  saveTransaction(cwd, transaction, nowOf(options), options);
  fail(options, 'after-intent');
  return runTransaction(cwd, transaction, ownerToken, generation, options);
}
// ── Issue 343 U5: the controller-terminal seam of a batch member (B5) ─────────
//
// The serial consolidation of forge-execution-batch acknowledges a member through THIS controller's
// own complete transaction, never a copy of it. prepareBatchTerminal (under the transaction mutex,
// writing nothing) builds that transaction at one fixed instant and returns the exact final effects
// the unchanged runTransaction leaves at that instant: the transaction, result and boundary records,
// the milestone event stream, the released lease (absent) and canonical STATE bytes at prepared_at.
// commitBatchTerminal runs transitionInside at the same instant with that exact STATE pre/postimage, so its
// readback is exactly those effects, and a replay resumes the same transaction. The begin must be the
// committed batch member begin of this owner and host; the prepared request carries no owner token
// (the caller supplies it again to commit) and nothing here is read from caller JSON as authority.
const BATCH_TERMINAL_KEYS = Object.freeze(['milestone', 'unit', 'begin_key', 'host_runtime', 'prepared_at', 'output']);
const BATCH_TERMINAL_PREPARED_KEY = 'prepared_state';
function batchTerminalInput(cwd, input, ownerToken) {
  const value = object(input, 'request');
  if (Object.keys(value).some(key => !BATCH_TERMINAL_KEYS.includes(key) && key !== BATCH_TERMINAL_PREPARED_KEY) || BATCH_TERMINAL_KEYS.some(key => !own(value, key))) {
    throw new ControllerError('invalid-request', 'pedido terminal do membro do batch inválido');
  }
  const token = opaque(ownerToken, 'owner_token', true);
  const milestone = opaque(value.milestone, 'milestone', true);
  const unit = unitFromRequest({ unit: value.unit });
  const hostRuntime = forgeRuntime.normalizeHostRuntime(value.host_runtime);
  const beginKey = opaque(value.begin_key, 'begin_key', true);
  const at = typeof value.prepared_at === 'string' ? Date.parse(value.prepared_at) : NaN;
  if (!Number.isFinite(at) || iso(at) !== value.prepared_at) throw new ControllerError('invalid-request', 'prepared_at inválido');
  const begin = lookupRecord(cwd, 'transaction', beginKey);
  if (!begin || begin.action !== 'begin' || begin.phase !== 'committed' || !own(begin, 'batch')
      || !executionBatch().validBinding(begin.batch, beginKey, begin.unit) || begin.unit.key !== unit.key || begin.milestone !== milestone
      || begin.host_runtime !== hostRuntime || begin.owner_digest !== ownerDigest(token)) {
    throw new ControllerError('unit-identity-mismatch', 'o begin do membro do batch diverge do pedido terminal');
  }
  return { at, unit, request: { action: 'complete', milestone, unit: unit.key, host_runtime: hostRuntime, owner_token: token,
    generation: begin.lease_generation, idempotency_key: `${beginKey}:complete`, result: { status: 'succeeded', output: value.output } } };
}
// The exact bytes writeAtomic publishes for a record that has no legacy copy.
function recordBytes(record) { return `${JSON.stringify({ ...record, storage_checksum: sha(record) }, null, 2)}\n`; }
function fileDigest(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
  catch (error) { if (error && error.code === 'ENOENT') return null; throw error; }
}
function ownerPath(cwd, file) { return path.relative(cwd, file).split(path.sep).join('/'); }
function prepareBatchTerminal(cwd, input, ownerToken, options) {
  resolvePrefs(cwd, options);
  return withMutex(cwd, 'unit-controller-transactions', () => {
    const { at, unit, request } = batchTerminalInput(cwd, input, ownerToken);
    const key = request.idempotency_key;
    if (lookupRecord(cwd, 'transaction', key)) throw new ControllerError('transaction-pending', 'o terminal deste membro já começou');
    if (pendingTransactions(cwd).length) throw new ControllerError('transaction-pending', 'recovery obrigatório antes do terminal do batch');
    assertLease(cwd, unit.key, request.owner_token, request.generation);
    const transaction = makeTransaction(cwd, request, 'complete', unit, key, request.owner_token, request.generation, request.host_runtime, at);
    if (own(input, BATCH_TERMINAL_PREPARED_KEY)) throw new ControllerError('invalid-request', 'terminal request is already prepared');
    const preparedState = forgeState.prepareUpdateFields(cwd, transaction.milestone, transaction.after.state_patch, { at: iso(at) });
    transaction.after.prepared_state = clone(preparedState);
    // The final record runTransaction leaves: committed, its boundary handed off at the same instant.
    const final = clone(transaction);
    final.phase = 'committed'; final.updated_at = iso(at);
    if (final.boundary) { final.boundary.handoff_ready = true; final.boundary.committed_at = iso(at); }
    const events = eventsFile(cwd, transaction.milestone), stream = readEvents(events);
    const content = `${stream.concat({ ...transaction.event, sequence: stream.length + 1 }).map(item => JSON.stringify(item)).join('\n')}\n`;
    const transactionPath = transactionFile(cwd, key), result = resultFile(cwd, key), boundary = boundaryFile(cwd, unit.key);
    const state = forgeState.statePath(cwd, transaction.milestone), lease = forgeLease.leaseFile(cwd, unit.key);
    const effects = [
      { path: ownerPath(cwd, transactionPath), before: fileDigest(transactionPath), after: { sha256: sha(recordBytes(final)) } },
      { path: ownerPath(cwd, result), before: fileDigest(result), after: { sha256: sha(recordBytes(transaction.result)) } },
      { path: ownerPath(cwd, events), before: fileDigest(events), after: { sha256: sha(content) } },
      { path: ownerPath(cwd, boundary), before: fileDigest(boundary), after: { sha256: sha(recordBytes(final.boundary)) } },
      { path: ownerPath(cwd, state), before: preparedState.before_sha256, after: { sha256: preparedState.after_sha256 } },
      { path: ownerPath(cwd, lease), before: fileDigest(lease), after: null },
    ];
    return { prepared_at: iso(at), effects, request: { ...clone(input), prepared_state: clone(preparedState) } };
  });
}
function commitBatchTerminal(cwd, input, ownerToken, options) {
  resolvePrefs(cwd, options);
  return withMutex(cwd, 'unit-controller-transactions', () => {
    const { at, request } = batchTerminalInput(cwd, input, ownerToken);
    if (!own(input, BATCH_TERMINAL_PREPARED_KEY)) throw new ControllerError('invalid-request', 'exact prepared STATE required');
    const existing = lookupRecord(cwd, 'transaction', request.idempotency_key);
    if (existing) {
      if (!existing.after.prepared_state || sha(existing.after.prepared_state) !== sha(input.prepared_state)) {
        throw new ControllerError('record-conflict', 'prepared STATE differs from terminal transaction');
      }
    } else {
      const candidate = makeTransaction(cwd, request, 'complete', unitFromRequest(request), request.idempotency_key,
        request.owner_token, request.generation, request.host_runtime, at);
      forgeState.assertPreparedUpdate(cwd, request.milestone, candidate.after.state_patch, input.prepared_state, { at: iso(at) });
    }
    return transitionInside(cwd, request, { ...(options || {}), now: () => at, batchTerminal: true, batchTerminalState: clone(input.prepared_state) });
  });
}

function persistResult(cwd, request, options) { return transition(cwd, { ...request, action: 'persist-result' }, options); }
function complete(cwd, request, options) { return transition(cwd, { ...request, action: 'complete' }, options); }
function pause(cwd, request, options) { return transition(cwd, { ...request, action: 'pause' }, options); }
function failUnit(cwd, request, options) { return transition(cwd, { ...request, action: 'fail' }, options); }
function expireSafe(cwd, request, options) { return transition(cwd, { ...request, action: 'expired-safe' }, options); }

function resume(cwd, request, options) {
  resolvePrefs(cwd, options);
  return withMutex(cwd, 'unit-controller-transactions', () => resumeInside(cwd, request, options));
}
function resumeInside(cwd, request, options) {
  const input = request || {};
  const records = input.idempotency_key
    ? [lookupRecord(cwd, 'transaction', input.idempotency_key)].filter(Boolean)
    : pendingTransactions(cwd);
  const results = [];
  for (const record of records) {
    if (record.terminal_failure || record.linked_entry) throw new ControllerError('linked-operation-required', 'replay exige operação vinculada e adapters vivos');
    const ownerToken = input.owner_token === undefined ? input.ownerToken : input.owner_token;
    const generation = input.generation || record.lease_generation;
    results.push(runTransaction(cwd, record, ownerToken, generation, options));
  }
  return { ok: true, reason: records.length ? 'transition-committed' : 'already-committed', recovered: results.length, results };
}

function handoff(cwd, request, options) {
  const input = object(request, 'request');
  resolvePrefs(cwd, options);
  const unit = unitFromRequest(input);
  const nextHost = forgeRuntime.normalizeHostRuntime(input.next_host_runtime === undefined ? input.nextHostRuntime : input.next_host_runtime);
  const pending = pendingTransactions(cwd);
  if (pending.length) throw new ControllerError('transaction-pending', 'handoff negado enquanto há transação incompleta');
  const boundary = lookupRecord(cwd, 'boundary', unit.key);
  if (!boundary) throw new ControllerError('boundary-missing', `boundary ausente para ${unit.key}`);
  if (!BOUNDARY_KINDS.includes(boundary.kind) || boundary.handoff_ready !== true || !boundary.committed_at) {
    throw new ControllerError('boundary-not-transferable', `boundary não transferível: ${boundary.kind || 'unknown'}`);
  }
  const result = lookupRecord(cwd, 'result', boundary.idempotency_key);
  const event = readEvents(eventsFile(cwd, boundary.milestone)).find(item => item.idempotency_key === boundary.idempotency_key);
  const eventContent = event && { ...event }; if (eventContent) delete eventContent.sequence;
  if (!result || sha(result) !== boundary.result_checksum || !eventContent || sha(eventContent) !== boundary.event_checksum) {
    throw new ControllerError('record-conflict', 'checksum de resultado/evento da boundary divergente');
  }
  const observation = forgeLease.observe(cwd, unit.key, options || {});
  if (observation.lease) throw new ControllerError('lease-active', 'handoff exige zero lease, inclusive expirado não recuperado');
  // A handoff is a capability-free validation result.  It never contains the
  // old provider session, owner token, credentials, or conversation content.
  return {
    ok: true,
    reason: 'handoff-ready',
    unit: unit.key,
    milestone: boundary.milestone,
    boundary_kind: boundary.kind,
    previous_host_runtime: boundary.previous_host_runtime,
    next_host_runtime: nextHost,
    outcome: boundary.outcome,
    result_ref: boundary.result_ref,
    result_checksum: boundary.result_checksum,
    state_checksum: boundary.state_checksum,
    committed_at: boundary.committed_at,
  };
}

function projectLogicalHistory(cwd, milestone) {
  const state = forgeState.read(cwd, milestone);
  const events = readEvents(eventsFile(cwd, milestone)).map(event => {
    const copy = { ...event };
    delete copy.host_runtime;
    delete copy.ts;
    return copy;
  });
  const results = discoverRecords(cwd, 'result').filter(item => item.milestone === milestone)
    .map(item => { const copy = { ...item }; delete copy.committed_at; return copy; });
  return { state: logicalState(state), events, results };
}

// Failure consumption is a new terminal transaction. The old begin, receipt,
// candidate and recovery clock are immutable inputs, never patched history.
function interruptionFile(cwd, id, archive = false) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new ControllerError('owner-interruption-scope-mismatch', 'invalid operation id');
  const file = path.join(rootDir(cwd), archive ? 'owner-interruption-witnesses' : 'owner-interruptions', id + '.json');
  for (let cursor = file; cursor !== path.resolve(cwd); cursor = path.dirname(cursor)) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new ControllerError('owner-interruption-path-invalid', 'linked interruption path');
    if (cursor === path.dirname(cursor)) throw new ControllerError('owner-interruption-path-invalid', 'foreign interruption path');
  }
  return file;
}
function ownerInterruptionQuestions(basis) {
  if (!Array.isArray(basis?.safety) || basis.safety.length !== basis.targets.length) throw new ControllerError('questions-invalid', 'complete interruption question inventory required');
  return basis.safety.reduce((all, safety) => require('./forge-interaction').mergePendingQuestions(all, safety.pending_questions), []);
}
// A cleanup archive preserves existing completion authority; it never mints an
// interruption, changes ownership, grants reentry or accepts worker artifacts.
function storedOwnerInterruptionWitness(cwd, basis) {
  const record = forgeRuns.get(cwd, basis.milestone);
  const live = Array.isArray(record?.owner_resume_history) && record.owner_resume_history.find(row =>
    row.kind === 'interrupted-owner-transfer' && row.operation_id === basis.operation_id);
  const archived = readRecordJson(interruptionFile(cwd, basis.operation_id, true));
  if (archived && (archived.schema_version !== 1 || archived.operation_id !== basis.operation_id
    || archived.milestone !== basis.milestone || !archived.witness)) throw new ControllerError('owner-interruption-witness-invalid', 'invalid completion archive');
  if (live && archived && sha(live) !== sha(archived.witness)) throw new ControllerError('owner-interruption-witness-invalid', 'live and archived witnesses differ');
  const witness = live || archived?.witness;
  if (witness) verifyOwnerInterruption(cwd, witness);
  return witness || null;
}
function archiveOwnerInterruptionWitnesses(cwd, milestone) {
  // The canonical remove caller holds its existing registry and run fences.
  // Read the REAL registry; no caller-supplied witness is accepted here.
  const record = forgeRuns.get(cwd, milestone);
  const history = record?.owner_resume_history;
  if (history !== undefined && !Array.isArray(history)) throw new ControllerError('owner-interruption-witness-invalid', 'unknown owner history');
  const witnesses = (history || []).filter(row => row.kind === 'interrupted-owner-transfer');
  if (pendingOwnerInterruptions(cwd).some(basis => basis.milestone === milestone)) throw new ControllerError('owner-interruption-pending', 'cannot remove an unfinished interruption anchor');
  // Validate all before writing the first archive. A failure leaves the run.
  const entries = witnesses.map(witness => {
    const basis = verifyOwnerInterruption(cwd, witness);
    return { file: interruptionFile(cwd, basis.operation_id, true), content: {
      schema_version: 1, operation_id: basis.operation_id, milestone, witness: clone(witness) } };
  });
  for (const entry of entries) {
    const previous = readRecordJson(entry.file);
    if (previous && sha(previous) !== sha(entry.content)) throw new ControllerError('owner-interruption-witness-invalid', 'archive conflict');
  }
  for (const entry of entries) if (!fs.existsSync(entry.file)) writeAtomic(entry.file, entry.content);
}

function verifyOwnerInterruption(cwd, witness) {
  const basis = readRecordJson(interruptionFile(cwd, witness.operation_id));
  if (!basis || sha(basis) !== witness.manifest_sha256 || basis.run_before_sha256 !== witness.previous_record_sha256
    || basis.milestone !== witness.milestone || !Array.isArray(witness.terminals)
    || witness.terminals.length !== basis.targets.length) throw new ControllerError('owner-interruption-witness-invalid', 'interruption manifest differs');
  for (let i = 0; i < basis.targets.length; i++) {
    const target = basis.targets[i], pin = witness.terminals[i], begin = lookupRecord(cwd, 'transaction', target.begin_key);
    const terminal = lookupRecord(cwd, 'transaction', target.terminal_key);
    const result = terminal && lookupRecord(cwd, 'result', target.terminal_key);
    const event = terminal && readEvents(eventsFile(cwd, basis.milestone)).find(row => row.idempotency_key === target.terminal_key);
    const content = event && { ...event }; if (content) delete content.sequence;
    if (!begin || sha(begin) !== target.begin_checksum || !terminal || pin.key !== target.terminal_key
      || pin.sha256 !== sha(terminal) || terminal.phase !== 'committed' || terminal.action !== 'fail'
      || terminal.owner_interruption?.operation_id !== witness.operation_id || terminal.owner_interruption.target_begin !== target.begin_key
      || terminal.owner_interruption.manifest_sha256 !== sha(basis)
      || terminal.owner_interruption.role !== (i === 0 ? 'original' : 'successor')
      || i === 0 && sha(terminal.terminal_failure?.safety.pending_questions) !== sha(ownerInterruptionQuestions(basis))
      || terminal.owner_digest !== begin.owner_digest || terminal.lease_generation !== begin.lease_generation
      || terminal.unit.key !== begin.unit.key || terminal.milestone !== begin.milestone
      || !terminal.boundary?.handoff_ready || terminal.result?.status !== 'failed'
      || terminal.result?.output?.artifacts_accepted !== false || !result || sha(result) !== sha(terminal.result)
      || !content || sha(content) !== sha(terminal.event)) throw new ControllerError('owner-interruption-witness-invalid', 'administrative terminal differs');
  }
  return basis;
}
function pendingOwnerInterruptions(cwd) {
  const directory = path.join(rootDir(cwd), 'owner-interruptions');
  if (!fs.existsSync(directory)) return [];
  if (fs.lstatSync(directory).isSymbolicLink()) throw new ControllerError('owner-interruption-path-invalid', 'linked interruption directory');
  return fs.readdirSync(directory).map(name => {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new ControllerError('owner-interruption-path-invalid', 'unknown interruption entry');
    const basis = readRecordJson(interruptionFile(cwd, name.slice(0, -5)));
    const witness = basis && storedOwnerInterruptionWitness(cwd, basis);
    if (witness) return null;
    return basis;
  }).filter(Boolean);
}
function witnessedOwnerInterruption(cwd, transaction) {
  if (!transaction?.owner_interruption) return false;
  const basis = readRecordJson(interruptionFile(cwd, transaction.owner_interruption.operation_id));
  if (!basis) return false;
  const witness = storedOwnerInterruptionWitness(cwd, basis);
  if (!witness) return false;
  return witness.terminals.some(pin => pin.key === transaction.idempotency_key && pin.sha256 === sha(transaction));
}
// Historical route-chain records have no universal dispatch-authority schema.
// Read the referenced real lines, then require a LIVE host adapter to attest
// their relationship to the original request and the final native attempt.
function interruptionRouteEvidence(cwd, milestone, references) {
  if (!Array.isArray(references) || !references.length || references.length > 64) {
    throw new ControllerError('owner-interruption-supersession-invalid', 'recorded route evidence required');
  }
  const pathKey = file => require('./forge-code-roots').key(path.resolve(file));
  const owner = fs.realpathSync.native(cwd);
  // The owner may be reached through a platform alias (/var on macOS, an
  // observed Windows junction). Only its exact protected descendants are
  // traversed; links within .gsd remain forbidden.
  const allowed = [undefined, milestone].map(id => ({ input: eventsFile(cwd, id), file: eventsFile(owner, id) }));
  const seen = new Set();
  return references.map(reference => {
    if (!reference || typeof reference.path !== 'string' || !path.isAbsolute(reference.path)
      || !Number.isSafeInteger(reference.line) || reference.line < 1
      || !/^[a-f0-9]{64}$/.test(reference.sha256 || '')) {
      throw new ControllerError('owner-interruption-supersession-invalid', 'exact owner event line required');
    }
    const matched = allowed.find(row => pathKey(reference.path) === pathKey(row.input) || pathKey(reference.path) === pathKey(row.file));
    if (!matched) throw new ControllerError('owner-interruption-supersession-invalid', 'exact owner event line required');
    const file = matched.file;
    for (let cursor = file; pathKey(cursor) !== pathKey(owner); cursor = path.dirname(cursor)) {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new ControllerError('owner-interruption-path-invalid', 'linked evidence path');
    }
    if (!fs.statSync(file).isFile()) throw new ControllerError('owner-interruption-supersession-invalid', 'event evidence is not a file');
    const line = fs.readFileSync(file, 'utf8').split('\n')[reference.line - 1];
    if (line === undefined || crypto.createHash('sha256').update(line).digest('hex') !== reference.sha256) {
      throw new ControllerError('owner-interruption-evidence-changed', 'recorded event line differs');
    }
    let event; try { event = JSON.parse(line); } catch { throw new ControllerError('owner-interruption-supersession-invalid', 'invalid event evidence'); }
    if (event.event !== 'route-chain-advance') throw new ControllerError('owner-interruption-supersession-invalid', 'a recorded route advance is required');
    const key = file + ':' + reference.line;
    if (seen.has(key)) throw new ControllerError('owner-interruption-supersession-invalid', 'duplicate event evidence');
    seen.add(key);
    return { path: fs.realpathSync.native(file), line: reference.line, sha256: reference.sha256 };
  });
}
function inspectSupersededInterruption(cwd, begin, context, basis, held, options) {
  context = originalAttemptContext(cwd, begin, context, options);
  const reject = () => { throw new ControllerError('saved-response-replay-required', 'canonical evidence must use its original replay path unless a live host proves supersession'); };
  const supersession = context.supersession;
  if (typeof options.attestSupersededAttempt !== 'function' || !supersession || !context.request
    || context.saved_response !== 'ready/blocked' || typeof context.receipt_path !== 'string') reject();
  const recovery = require('./forge-attempt-recovery'), sidecar = require('./forge-unit-sidecar');
  // #382: a revalidated archived proof replaces only identity/fingerprint
  // derivation; every R1, process, root and attestation check below remains.
  const archived = archivedProof(cwd, begin, context);
  const identity = archived ? archived.identity : recovery.requestIdentity(recovery.canonicalRequest(context.request));
  if (`${identity.unit_type}/${identity.task_id || identity.slice_id || identity.milestone_id}` !== begin.unit.key
    || identity.milestone_id !== begin.milestone || identity.host !== begin.host_runtime
    || identity.owner !== (process.platform === 'win32' ? fs.realpathSync(cwd).toLowerCase() : fs.realpathSync(cwd))
    || identity.slice_id && identity.slice_id !== begin.after.state.active_slice
    || path.resolve(sidecar.artifactAttemptFiles(context.request).receiptFile) !== path.resolve(context.receipt_path)) {
    throw new ControllerError('attempt-identity-mismatch', 'superseded request does not match the original begin');
  }
  const file = path.resolve(context.receipt_path);
  for (let cursor = file; ; cursor = path.dirname(cursor)) {
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new ControllerError('owner-interruption-path-invalid', 'linked receipt path');
    if (cursor === path.dirname(cursor)) break;
  }
  if (!fs.statSync(file).isFile()) reject();
  // Without a live binding the historical receipt keeps writer_possible unknown.
  const inspection = recovery.inspectReceipt(file, { request: archived?.linked ? undefined : context.request, processProbe: options.processProbe });
  const receipt = inspection.receipt, fingerprint = archived ? archived.fingerprint : sidecar.artifactFingerprint(context.request);
  if (archived && archived.receipt_sha256 !== inspection.receipt_sha256) throw new ControllerError('owner-interruption-evidence-changed', 'archived receipt changed');
  if (receipt.fingerprint !== fingerprint || receipt.dispatch_id !== context.request.dispatchId
    || receipt.recovery_identity_sha256 && receipt.recovery_identity_sha256 !== require('./forge-code-roots').digest(identity)) {
    throw new ControllerError('attempt-identity-mismatch', 'superseded receipt differs from its exact request');
  }
  if (receipt.phase !== 'ready' || receipt.result?.status !== 'blocked' || receipt.saved_candidate) reject();
  if (inspection.process_stopped !== true) throw new ControllerError('process-not-stopped', 'earlier sidecar process is active or unknown');
  const native = supersession.final_native_attempt;
  if (!native || typeof native.id !== 'string' || !native.id.trim() || native.id === receipt.dispatch_id
    || native.host_runtime !== begin.host_runtime || native.worker_mode !== 'native' || native.status !== 'partial'
    || native.receipt_path !== null || typeof native.observation_reference !== 'string' || !native.observation_reference.trim()) reject();
  const requestRoots = [...new Set([cwd, context.request.cwd, context.request.contextRoot,
    ...(context.request.execution_contract?.code_roots || []).map(root => root.path)].filter(Boolean).map(root => fs.realpathSync.native(root)))].sort();
  const evidence = { request_identity: identity, request_fingerprint: fingerprint, request_roots: requestRoots,
    receipt: { path: fs.realpathSync.native(file), sha256: inspection.receipt_sha256, dispatch_id: receipt.dispatch_id, phase: 'ready', status: 'blocked' },
    route_evidence: interruptionRouteEvidence(cwd, begin.milestone, supersession.route_evidence),
    final_native_attempt: { id: native.id, host_runtime: native.host_runtime, worker_mode: 'native', status: 'partial',
      receipt_path: null, observation_reference: native.observation_reference } };
  const challenge = { operation_id: basis.operation_id, run_record_sha256: held.expectedRecordSha256,
    begin_key: begin.idempotency_key, begin_checksum: sha(begin), unit: begin.unit.key, milestone: begin.milestone,
    host_runtime: begin.host_runtime, owner_digest: begin.owner_digest, lease_generation: begin.lease_generation, evidence };
  const attestation = options.attestSupersededAttempt(clone(challenge));
  if (!attestation || attestation.challenge_sha256 !== sha(challenge) || attestation.superseded !== true
    || attestation.final_native_receiptless !== true || attestation.final_native_status !== 'partial'
    || typeof attestation.reference !== 'string' || !attestation.reference.trim()) {
    throw new ControllerError('owner-interruption-supersession-attestation-required', 'live host must verify actual chain advance and final native observation');
  }
  // The callback may inspect tools/files; recheck the very same immutable data.
  if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== evidence.receipt.sha256
    || sha(interruptionRouteEvidence(cwd, begin.milestone, evidence.route_evidence)) !== sha(evidence.route_evidence)) {
    throw new ControllerError('owner-interruption-evidence-changed', 'superseded evidence changed during attestation');
  }
  if (archived) {
    let again;
    try { again = archivedProof(cwd, begin, context); } catch { again = null; }
    if (!again || again.archive_sha256 !== archived.archive_sha256 || again.receipt_sha256 !== evidence.receipt.sha256) {
      throw new ControllerError('owner-interruption-evidence-changed', 'archived request changed during attestation');
    }
  }
  const merge = require('./forge-interaction').mergePendingQuestions;
  return { evidence: { ...evidence, attestation_reference: attestation.reference },
    questions: merge(merge(receipt.input_pending_questions || [], receipt.pending_questions || []), receipt.result.questions || []) };
}
function inspectInterruptionTargets(cwd, handle, basis, options) {
  const mutex = ownerActivityLocks.get(path.resolve(cwd));
  if (!mutex || !forgeLock.assertOwned(mutex)) throw new ControllerError('owner-interruption-fence-lost', 'controller fence lost');
  const held = forgeRuns.assertOwnerInterruptionAuthority(handle, cwd);
  const required = [cwd];
  if (held.record.write_claim && require('./forge-write-claim').isHeld(held.record.write_claim)) require('./forge-write-claim').validateHeldClaim(held.record.write_claim);
  if (held.record.write_claim) required.push(...require('./forge-code-roots').claimGroups(held.record.write_claim).map(row => row.path));
  const proofs = [];
  for (let i = 0; i < basis.targets.length; i++) {
    const target = basis.targets[i], begin = lookupRecord(cwd, 'transaction', target.begin_key);
    if (!begin || sha(begin) !== target.begin_checksum) throw new ControllerError('owner-interruption-lineage-changed', 'begin changed');
    const context = options.inspectInterruption({ cwd, run: clone(held.record), begin: clone(begin),
      role: i === 0 ? 'original' : 'successor', operation_id: basis.operation_id });
    if (!context || context.begin_key !== target.begin_key || context.begin_checksum !== target.begin_checksum
      || typeof context.observation_reference !== 'string' || !context.observation_reference.trim()) throw new ControllerError('owner-interruption-evidence-missing', 'positive begin-bound host observation required');
    if (context.invocation_status !== (i === 0 ? 'invoked-unverified' : 'not-invoked')) throw new ControllerError('owner-interruption-invocation-unknown', 'original unverified / successor not-invoked required');
    let superseded = null;
    if (context.receipt_path !== null || context.saved_response !== 'none-observed') {
      if (i !== 0) throw new ControllerError('saved-response-replay-required', 'successors must remain positively uninvoked and receiptless');
      superseded = inspectSupersededInterruption(cwd, begin, context, basis, held, options);
    }
    if (!Array.isArray(context.pending_questions)) throw new ControllerError('questions-invalid', 'explicit question inventory required');
    const merge = require('./forge-interaction').mergePendingQuestions;
    const pending = merge(merge(held.record.pending_questions || [], context.pending_questions), superseded?.questions || []);
    const roots = physicalRoots(context.roots);
    if (required.some(file => !roots.some(root => root.path === fs.realpathSync.native(file)))) throw new ControllerError('roots-unverified', 'interruption omitted a physical root');
    if (superseded && superseded.evidence.request_roots.some(file => !roots.some(root => root.path === file))) {
      throw new ControllerError('roots-unverified', 'interruption omitted a superseded attempt root');
    }
    if (options.processProbe({ cwd, begin: clone(begin), context, purpose: 'owner-interruption' }) !== 'stopped') throw new ControllerError('process-not-stopped', 'old native/process identity is active or unknown');
    for (const root of roots) {
      const proof = options.reconcileRoots({ cwd, root, context, begin: clone(begin) });
      if (!proof || proof.root_id !== root.root_id || proof.process_stopped !== true || proof.reconciled !== true) throw new ControllerError('roots-unreconciled', 'interruption root not reconciled');
    }
    proofs.push({ roots, pending_questions: pending, invocation_status: context.invocation_status,
      observation_reference: context.observation_reference, receipt_sha256: superseded?.evidence.receipt.sha256 || null,
      ...(superseded ? { superseded_attempt: superseded.evidence } : {}),
      historical_reason: 'owner-stopped-unverified-lineage', provenance_gaps: ['receiptless-legacy-native'],
      process_stopped: true, roots_reconciled: true });
  }
  const challenge = { operation_id: basis.operation_id, record_sha256: held.expectedRecordSha256,
    milestone: basis.milestone, actor: held.actor, targets: basis.targets.map(row => ({ begin_key: row.begin_key, begin_checksum: row.begin_checksum })),
    roots: proofs.map(row => row.roots),
    ...(proofs.some(row => row.superseded_attempt) ? { superseded_attempts: proofs.map(row => row.superseded_attempt || null) } : {}) };
  const attestation = options.attestOwnerInterruption(clone(challenge));
  if (!attestation || attestation.challenge_sha256 !== sha(challenge) || attestation.previous_owner_stopped !== true
    || attestation.workspace_quiescent !== true || typeof attestation.reference !== 'string' || !attestation.reference.trim()) throw new ControllerError('owner-interruption-attestation-required', 'live host must attest stopped owner and reconciled workspace');
  const safetyIdentity = rows => rows.map(row => ({ roots: row.roots, pending_questions: row.pending_questions,
    ...(row.superseded_attempt ? { receipt_sha256: row.receipt_sha256, superseded_attempt: row.superseded_attempt } : {}) }));
  if (basis.safety && sha(safetyIdentity(basis.safety)) !== sha(safetyIdentity(proofs))) {
    throw new ControllerError('owner-interruption-evidence-changed', 'interruption roots/questions/attempt evidence changed');
  }
  return proofs;
}
function ownerInterruptionIdentity(milestone, recordSha256, lineage) { return sha({ milestone, record_sha256: recordSha256, lineage }); }
function settleInterruptedLineage(cwd, handle, options) {
  const held = forgeRuns.assertOwnerInterruptionAuthority(handle, cwd), input = object(options.lineage, 'lineage');
  const operationId = ownerInterruptionIdentity(held.record.id, held.expectedRecordSha256, input);
  const file = interruptionFile(cwd, operationId);
  let basis = readRecordJson(file);
  if (basis && (basis.schema_version !== 1 || !Array.isArray(basis.targets) || !Array.isArray(basis.safety))) throw new ControllerError('owner-interruption-lineage-changed', 'malformed durable interruption basis');
  const first = lookupRecord(cwd, 'transaction', input.begin_key);
  if (!first || first.action !== 'begin' || first.phase !== 'committed' || first.milestone !== held.record.id
    || first.host_runtime !== held.record.host_runtime || input.begin_checksum !== sha(first)
    || !Array.isArray(input.successors)) throw new ControllerError('owner-interruption-lineage-invalid', 'exact original begin and all successors required');
  const roster = [first, ...laterBegins(cwd, first)];
  if (roster.some(row => row.owner_digest !== first.owner_digest || row.host_runtime !== held.record.host_runtime)) throw new ControllerError('owner-interruption-foreign-lineage', 'foreign owner/host begin cannot be administratively retired');
  const transactions = transactionDir(cwd);
  if (fs.existsSync(transactions)) {
    if (fs.lstatSync(transactions).isSymbolicLink()) throw new ControllerError('owner-resume-transactions-unknown', 'linked transaction directory');
    for (const name of fs.readdirSync(transactions)) {
      const entry = fs.lstatSync(path.join(transactions, name));
      if (!name.endsWith('.json') || !entry.isFile() || entry.isSymbolicLink()) throw new ControllerError('owner-resume-transactions-unknown', 'unknown transaction debris');
    }
  }
  if (roster.length < 2 || sha(input.successors) !== sha(roster.slice(1).map(row => ({ key: row.idempotency_key, checksum: sha(row) })))) throw new ControllerError('owner-interruption-lineage-invalid', 'ordered successor roster differs');
  if (new Set(roster.map(row => row.unit.key)).size !== roster.length) throw new ControllerError('owner-interruption-lineage-invalid', 'repeated unit targets unsupported');
  const terminalKeys = roster.map(row => 'owner-interruption:' + sha({ operation_id: operationId, begin_key: row.idempotency_key }));
  const unrelated = pendingTransactions(cwd).filter(row => !terminalKeys.includes(row.idempotency_key));
  if (unrelated.length) throw new ControllerError('transaction-pending', 'unrelated pending transaction blocks interruption');
  if (pendingOwnerInterruptions(cwd).some(row => row.operation_id !== operationId)) throw new ControllerError('owner-interruption-pending', 'another administrative interruption remains pending');
  const records = discoverRecords(cwd, 'transaction');
  if (incompleteUnits(cwd, held.record.id).some(row => !roster.some(begin => begin.idempotency_key === row.idempotency_key))
    || records.some(row => row.milestone === held.record.id && !terminalKeys.includes(row.idempotency_key)
      && roster.some(begin => row.action !== 'begin' && row.unit.key === begin.unit.key && row.lease_generation === begin.lease_generation))) throw new ControllerError('owner-interruption-lineage-invalid', 'foreign terminal or unfinished unit exists');
  const locks = path.join(rootDir(cwd), 'file-locks');
  if (fs.existsSync(locks) && (fs.lstatSync(locks).isSymbolicLink() || fs.readdirSync(locks).length)) throw new ControllerError('owner-resume-file-lock-present', 'unreconciled legacy file lock');
  const leaseFiles = roster.map(row => path.basename(forgeLease.leaseFile(cwd, row.unit.key)));
  const leaseDir = forgeLease.leasesDir(cwd);
  if (fs.existsSync(leaseDir) && (fs.lstatSync(leaseDir).isSymbolicLink() || fs.readdirSync(leaseDir).some(name => !leaseFiles.includes(name)))) throw new ControllerError('owner-resume-lease-present', 'foreign/unknown lease blocks interruption');
  if (!basis) {
    basis = { schema_version: 1, operation_id: operationId, milestone: held.record.id,
      run_before_sha256: held.expectedRecordSha256, claim_sha256: sha(held.record.write_claim || null),
      previous_host_runtime: held.record.host_runtime, previous_session_sha256: sha(held.record.session_id),
      actor: { host_runtime: held.actor.hostRuntime, session_sha256: sha(held.actor.sessionId) },
      targets: roster.map((row, i) => {
        const leaseFile = forgeLease.leaseFile(cwd, row.unit.key), observed = forgeLease.readLease(leaseFile);
        if (observed.corrupt || observed.record && (!forgeLease.validRecord(observed.record, row.unit.key)
          || observed.record.generation !== row.lease_generation || ownerDigest(observed.record.owner_token) !== row.owner_digest)) throw new ControllerError('lease-owner-mismatch', 'old generation/owner differs');
        return { operation_id: operationId, begin_key: row.idempotency_key, begin_checksum: sha(row), unit: row.unit.key,
          generation: row.lease_generation, terminal_key: terminalKeys[i], lease_sha256: observed.record ? sha(fs.readFileSync(leaseFile).toString('utf8')) : null };
      }) };
  } else if (basis.operation_id !== operationId || basis.run_before_sha256 !== held.expectedRecordSha256
    || basis.claim_sha256 !== sha(held.record.write_claim || null)
    || sha(basis.targets.map(row => row.begin_checksum)) !== sha(roster.map(sha))) throw new ControllerError('owner-interruption-lineage-changed', 'durable interruption basis differs');
  for (let i = 0; i < roster.length; i++) {
    const begin = roster[i], target = basis.targets[i];
    if (!target || target.operation_id !== operationId || target.begin_key !== begin.idempotency_key
      || target.unit !== begin.unit.key || target.generation !== begin.lease_generation || target.terminal_key !== terminalKeys[i]
      || target.lease_sha256 !== null && !/^[a-f0-9]{64}$/.test(target.lease_sha256)) throw new ControllerError('owner-interruption-lineage-changed', 'durable target differs');
    const observed = forgeLease.readLease(forgeLease.leaseFile(cwd, begin.unit.key));
    if (observed.corrupt || observed.record && (!forgeLease.validRecord(observed.record, begin.unit.key)
      || observed.record.generation !== begin.lease_generation || ownerDigest(observed.record.owner_token) !== begin.owner_digest)) throw new ControllerError('lease-owner-mismatch', 'target owner/generation changed');
  }
  const proofs = inspectInterruptionTargets(cwd, handle, basis, options);
  forgeRuns.bindOwnerInterruptionAuthority(handle, cwd, basis);
  // Validate EVERY target before writing any intent or releasing the first lease.
  for (const target of basis.targets) {
    const checked = forgeLease.withTerminalGuard(cwd, target.unit, guard => forgeLease.inspectInterrupted(guard, handle, cwd, target.unit));
    if (!checked.ok) throw new ControllerError('lease-owner-mismatch', checked.reason);
  }
  if (!basis.safety) basis.safety = proofs;
  forgeRuns.assertOwnerInterruptionCapacity(handle, cwd, basis);
  if (!fs.existsSync(file)) { writeAtomic(file, basis); fail(options, 'owner-interruption-after-manifest'); }
  for (let i = basis.targets.length - 1; i >= 0; i--) {
    const target = basis.targets[i], begin = roster[i];
    const output = forgeLease.withTerminalGuard(cwd, target.unit, guard => {
      let tx = lookupRecord(cwd, 'transaction', target.terminal_key);
      const check = () => {
        forgeRuns.assertOwnerInterruptionAuthority(handle, cwd, target.unit);
        inspectInterruptionTargets(cwd, handle, basis, options);
        const checked = forgeLease.inspectInterrupted(guard, handle, cwd, target.unit);
        if (!checked.ok) throw new ControllerError('lease-owner-mismatch', checked.reason);
      };
      check();
      if (!tx) {
        tx = makeTransaction(cwd, { milestone: basis.milestone,
          result: { status: 'failed', reason_code: 'owner-stopped-unverified-lineage', output: {
            administrative_interruption: true, worker_result: 'unverified', artifacts_accepted: false, provider_called: 'unknown' } },
          state_patch: { phase: 'blocked', active_slice: first.after.state.active_slice, active_task: '\u2014', owner: null } },
        'fail', begin.unit, target.terminal_key, 'administrative-interruption-not-an-old-owner-token',
        begin.lease_generation, begin.host_runtime, nowOf(options));
        // These are TARGET namespace fields for closing the old begin, not an
        // adopted credential. The actual actor and trust mechanism are separate.
        tx.owner_digest = begin.owner_digest;
        tx.owner_interruption = { operation_id: operationId, target_begin: begin.idempotency_key,
          manifest_sha256: sha(basis), role: i === 0 ? 'original' : 'successor', actor: clone(basis.actor) };
        if (i === 0) tx.terminal_failure = { kind: 'owner-interruption', begin_key: begin.idempotency_key,
          begin_checksum: sha(begin), slice: begin.after.state.active_slice,
          safety: { ...basis.safety[i], pending_questions: ownerInterruptionQuestions(basis) } };
        saveTransaction(cwd, tx, nowOf(options), options); fail(options, 'owner-interruption-after-intent');
      }
      if (tx.owner_interruption?.operation_id !== operationId || tx.owner_interruption.manifest_sha256 !== sha(basis)) throw new ControllerError('record-conflict', 'interruption terminal differs');
      if (tx.phase === 'intent') { check(); publishResult(cwd, tx.result); setPhase(cwd, tx, 'result-published', options); }
      if (tx.phase === 'result-published') { check(); publishEvent(cwd, tx.milestone, tx.event); setPhase(cwd, tx, 'event-published', options); }
      if (tx.phase === 'event-published') { check(); publishBoundary(cwd, tx.boundary); setPhase(cwd, tx, 'boundary-pending', options); }
      if (tx.phase === 'boundary-pending') {
        check(); const current = logicalState(forgeState.read(cwd, begin.milestone));
        for (const key of Object.keys(tx.after.state_patch)) {
          if (Object.prototype.hasOwnProperty.call(tx.after.state, key)
            && stableStringify(current[key]) !== stableStringify(tx.before.state[key])
            && stableStringify(current[key]) !== stableStringify(tx.after.state[key])) throw new ControllerError('state-successor-conflict', 'administrative STATE patch conflicts with current state');
        }
        publishState(cwd, tx); setPhase(cwd, tx, 'state-published', options);
      }
      if (tx.phase === 'state-published') { check(); setPhase(cwd, tx, 'lease-release-pending', options); }
      if (tx.phase === 'lease-release-pending') { check(); const released = forgeLease.releaseInterrupted(guard, handle, cwd, target.unit);
        if (!released.ok) throw new ControllerError('lease-owner-mismatch', released.reason); setPhase(cwd, tx, 'lease-released', options); }
      if (tx.phase === 'lease-released') { check(); tx.boundary.handoff_ready = true; tx.boundary.committed_at = iso(nowOf(options));
        publishBoundary(cwd, tx.boundary); setPhase(cwd, tx, 'boundary-ready', options); }
      if (tx.phase === 'boundary-ready') { check(); setPhase(cwd, tx, 'committed', options); }
      return { ok: true };
    });
    if (!output.ok) throw new ControllerError('lease-owner-mismatch', output.reason);
  }
  fail(options, 'owner-interruption-before-owner-transfer');
  return { operation_id: operationId, milestone: basis.milestone, manifest_sha256: sha(basis),
    terminals: basis.targets.map(target => ({ key: target.terminal_key, sha256: sha(lookupRecord(cwd, 'transaction', target.terminal_key)) })) };
}
function assertInterruptedEntryActor(cwd, failure, input, options) {
  if (!witnessedOwnerInterruption(cwd, failure)) throw new ControllerError('owner-interruption-witness-invalid', 'unwitnessed administrative failure');
  const record = forgeRuns.get(cwd, failure.milestone);
  if (Array.isArray(record?.pending_decisions) && record.pending_decisions.length) throw new ControllerError('pending-questions', 'run decisions remain unresolved');
  const observed = forgeRuns.observeHostSession(input.host_runtime, options.expectedSession);
  if (!record || record.active !== true || !forgeRuns.knownResumeBinding(record) || !observed
    || record.host_runtime !== observed.hostRuntime || record.session_id !== observed.sessionId
    || ownerDigest(input.owner_token) === failure.owner_digest) throw new ControllerError('owner-interruption-actor-mismatch', 'current observed owner and a new token are required');
}

function verifiedFailure(cwd, transaction) {
  if (!transaction?.terminal_failure || transaction.phase !== 'committed') return null;
  if (transaction.owner_interruption && !witnessedOwnerInterruption(cwd, transaction)) return null;
  const begin = lookupRecord(cwd, 'transaction', transaction.terminal_failure.begin_key);
  const result = lookupRecord(cwd, 'result', transaction.idempotency_key);
  const event = readEvents(eventsFile(cwd, transaction.milestone)).find(item => item.idempotency_key === transaction.idempotency_key);
  const content = event && { ...event }; if (content) delete content.sequence;
  if (!begin || sha(begin) !== transaction.terminal_failure.begin_checksum || !result || sha(result) !== sha(transaction.result)
    || !content || sha(content) !== sha(transaction.event) || result.status !== 'failed') {
    throw new ControllerError('record-conflict', 'vínculo de falha consumida divergente');
  }
  return { transaction, begin, result, slice: transaction.terminal_failure.slice };
}
function failureProjection(cwd, milestone) {
  const records = discoverRecords(cwd, 'transaction');
  const failures = records.filter(item => item.milestone === milestone && item.terminal_failure && item.phase === 'committed')
    .map(item => verifiedFailure(cwd, item)).filter(Boolean);
  for (const failure of failures) {
    const entries = records.filter(item => item.action === 'begin' && item.phase === 'committed'
      && item.linked_entry && item.linked_entry.failure_key === failure.transaction.idempotency_key);
    for (const entry of entries) {
      if (entry.linked_entry.failure_checksum !== sha(failure.transaction)) throw new ControllerError('record-conflict', 'entrada aponta para falha divergente');
    }
    failure.entry = entries.length ? entries[entries.length - 1] : null;
  }
  return failures;
}
// Exempt only ancestors whose immutable links and scope are fully verified.
function failureAncestors(cwd, key) {
  const keys = new Set();
  let failure = lookupRecord(cwd, 'transaction', key), expected = null;
  while (failure) {
    if (keys.has(failure.idempotency_key)) throw new ControllerError('entry-ancestry-invalid', 'failure cycle');
    const checked = verifiedFailure(cwd, failure), begin = checked?.begin;
    if (!checked || begin.action !== 'begin' || begin.phase !== 'committed'
      || begin.unit.key !== failure.unit.key || begin.milestone !== failure.milestone
      || begin.owner_digest !== failure.owner_digest || begin.host_runtime !== failure.host_runtime
      || begin.after.state.active_slice !== failure.terminal_failure.slice
      || expected && (expected.failure_checksum !== sha(failure) || expected.unit !== failure.unit.key
        || expected.milestone !== failure.milestone || expected.slice !== failure.terminal_failure.slice
        || expected.owner_digest !== failure.owner_digest && !failure.owner_interruption || expected.host_runtime !== failure.host_runtime
        || sha(expected.roots) !== sha(failure.terminal_failure.safety.roots)
        || expected.begin_checksum !== failure.terminal_failure.begin_checksum)) {
      throw new ControllerError('entry-ancestry-invalid', 'failure ancestry identity mismatch');
    }
    keys.add(failure.idempotency_key);
    if (!begin.linked_entry) break;
    const link = begin.linked_entry;
    if (link.owner_digest !== failure.owner_digest || link.host_runtime !== failure.host_runtime
      || sha(link.roots) !== sha(failure.terminal_failure.safety.roots)) throw new ControllerError('entry-ancestry-invalid', 'entry roots/owner mismatch');
    expected = { ...link, unit: failure.unit.key, milestone: failure.milestone, slice: failure.terminal_failure.slice };
    failure = lookupRecord(cwd, 'transaction', link.failure_key);
    if (!failure) throw new ControllerError('entry-ancestry-invalid', 'missing ancestor');
  }
  if (!keys.size) throw new ControllerError('entry-ancestry-invalid', 'missing failure');
  return keys;
}
function assertUnitAvailable(cwd, milestone, unit, slice, options, linked = {}) {
  if (pendingOwnerInterruptions(cwd).length) throw new ControllerError('owner-interruption-pending', 'administrative interruption has not been committed by its owner');
  if (pendingTransactions(cwd).some(item => item.idempotency_key !== linked.transactionKey && (item.terminal_failure || item.linked_entry))) throw new ControllerError('transaction-pending', 'transação vinculada incompleta impede begin');
  const ancestors = linked.failureKey ? failureAncestors(cwd, linked.failureKey) : new Set();
  const failures = failureProjection(cwd, milestone).filter(item => !ancestors.has(item.transaction.idempotency_key));
  const current = forgeState.read(cwd, milestone);
  const inventory = !current ? {} : options && typeof options.inventoryReader === 'function'
    ? options.inventoryReader(cwd, milestone, current) : discoverInventory(cwd, milestone, current);
  const candidates = inventory.slices?.filter(item => item.id === (slice || (/slice$/.test(unit.type) ? unit.id : null))
    || !slice && unit.type === 'execute-task' && item.tasks?.some(task => task.id === unit.id)) || [];
  const candidate = candidates.length === 1 ? candidates[0] : null;
  const targetSlice = slice || (/slice$/.test(unit.type) ? unit.id : null);
  const knownTaskScope = candidate && candidate.id === targetSlice && candidate.tasks?.some(task => task.id === unit.id);
  // Task IDs repeat in each slice. Unknown scope remains fail-closed; a known
  // independent slice must not inherit another slice's same-named task failure.
  const sameUnit = item => item.begin.unit.key === unit.key && (unit.type !== 'execute-task'
    || !targetSlice || !knownTaskScope || !item.slice || item.slice === targetSlice);
  if (failures.some(item => sameUnit(item) || !item.entry && item.slice && item.slice === targetSlice)) {
    throw new ControllerError('failure-deferred', 'unidade exige reentrada vinculada autorizada');
  }
  if (inventory.dependency_validation && candidate && (candidate.dependency_status !== 'valid'
    || candidate.dependencies.some(id => !inventory.slices.some(other => other.id === id && other.checked)))) {
    throw new ControllerError('dependencies-blocked', 'dependências da unidade não verificadas');
  }
}
function terminalIdentity(cwd, input) {
  const begin = lookupRecord(cwd, 'transaction', opaque(input.begin_key, 'begin_key', true));
  const unit = unitFromRequest(input);
  const host = forgeRuntime.normalizeHostRuntime(input.host_runtime);
  if (!begin || begin.action !== 'begin' || begin.phase !== 'committed' || begin.unit.key !== unit.key
    || begin.milestone !== input.milestone || begin.host_runtime !== host || begin.owner_digest !== ownerDigest(input.owner_token)
    || input.slice && input.slice !== begin.after.state.active_slice
    || input.generation && input.generation !== begin.lease_generation
    || own(input, 'begin_checksum') && input.begin_checksum !== undefined && input.begin_checksum !== sha(begin)) {
    throw new ControllerError('unit-identity-mismatch', 'snapshot e begin durável divergentes');
  }
  return begin;
}
function physicalRoots(roots) {
  if (!Array.isArray(roots) || !roots.length) throw new ControllerError('roots-unverified', 'raízes da tentativa ausentes');
  const ids = new Set();
  return roots.map(root => {
    if (!root || typeof root.root_id !== 'string' || ids.has(root.root_id)) throw new ControllerError('roots-unverified', 'root_id inválido');
    ids.add(root.root_id);
    const real = fs.realpathSync.native(root.path), stat = fs.statSync(real, { bigint: true });
    if (!stat.isDirectory()) throw new ControllerError('roots-unverified', 'raiz não é diretório');
    return { root_id: root.root_id, path: real, dev: String(stat.dev), ino: String(stat.ino) };
  }).sort((a, b) => a.root_id.localeCompare(b.root_id));
}
function inspectFailure(cwd, begin, failure, options, terminal) {
  if (!options || typeof options.inspectAttempt !== 'function' || typeof options.processProbe !== 'function') {
    throw new ControllerError('failure-inspector-required', 'inspeção viva do host obrigatória');
  }
  const context = originalAttemptContext(cwd, begin, options.inspectAttempt({ cwd, begin: clone(begin), references: clone(failure || {}) }), options);
  if (!context || typeof context.receipt_path !== 'string' || !context.request) throw new ControllerError('attempt-evidence-missing', 'receipt/pedido original ausente');
  const recovery = require('./forge-attempt-recovery.js');
  // The live terminal guard keeps priority; an archived proof (#382) is only a
  // historical identity source and never relaxes saved-response replay below.
  const terminalInspection = terminal && context.request.linked_begin_key
    ? recovery.inspectTerminalRequest(context.request, { ...options, ...terminal }) : null;
  const archived = terminalInspection ? null : archivedProof(cwd, begin, context);
  const historical = terminalInspection || archived;
  const identity = historical?.identity || recovery.requestIdentity(recovery.canonicalRequest(context.request));
  if (`${identity.unit_type}/${identity.task_id || identity.slice_id || identity.milestone_id}` !== begin.unit.key
    || identity.milestone_id !== begin.milestone || identity.host !== begin.host_runtime
    || identity.slice_id && begin.after.state.active_slice !== identity.slice_id) {
    throw new ControllerError('attempt-identity-mismatch', 'pedido original não corresponde ao begin');
  }
  // Terminal data is not a dispatch binding. Without one the inspector keeps
  // writer_possible unknown, conservatively requiring every root reconciled.
  const inspection = recovery.inspectReceipt(context.receipt_path, { request: terminalInspection || archived?.linked ? undefined : context.request, processProbe: options.processProbe });
  if (inspection.receipt.recovery_identity_sha256 && inspection.receipt.recovery_identity_sha256 !== require('./forge-code-roots').digest(identity)
    || archived && archived.receipt_sha256 !== inspection.receipt_sha256
    || inspection.receipt.fingerprint && inspection.receipt.fingerprint !== (historical?.fingerprint || require('./forge-unit-sidecar').artifactFingerprint(context.request))) {
    throw new ControllerError('attempt-identity-mismatch', 'receipt não corresponde ao pedido original');
  }
  if (!inspection.receipt_checked || inspection.process_stopped !== true) throw new ControllerError('process-not-stopped', 'processo ativo ou desconhecido');
  if (inspection.valid_saved_response || inspection.receipt?.saved_candidate) {
    if (typeof options.replaySavedResponse === 'function') options.replaySavedResponse({ context, inspection });
    throw new ControllerError('saved-response-replay-required', 'resposta salva exige validação/publicação pelo contrato original');
  }
  if (!['failed', 'abandoned'].includes(inspection.phase) || typeof inspection.receipt.failure?.reason_code !== 'string'
    || !inspection.receipt.failure.reason_code.trim()) {
    throw new ControllerError('terminal-failure-required', 'receipt sem evidência de falha terminal');
  }
  const roots = physicalRoots(context.roots);
  const requiredPaths = [cwd, context.request.cwd, context.request.contextRoot, context.request.execution_contract?.owner,
    ...(context.request.execution_contract?.code_roots || []).map(root => root.path)].filter(Boolean);
  if (requiredPaths.some(rootPath => !roots.some(root => root.path === fs.realpathSync.native(rootPath)))) {
    throw new ControllerError('roots-unverified', 'manifesto omite raiz física da tentativa');
  }
  if (inspection.writer_possible !== false) {
    if (typeof options.reconcileRoots !== 'function') throw new ControllerError('roots-unreconciled', 'writer possível exige reconciliação de todas as raízes');
    for (const root of roots) {
      const proof = options.reconcileRoots({ cwd, root, context, inspection, begin: clone(begin) });
      if (!proof || proof.process_stopped !== true || proof.reconciled !== true || proof.root_id !== root.root_id) {
        throw new ControllerError('roots-unreconciled', `raiz pendente: ${root.root_id}`);
      }
    }
  }
  const questions = context.pending_questions || [];
  if (!Array.isArray(questions) || questions.some(item => !item.id || !['pending', 'resolved'].includes(item.status))) throw new ControllerError('questions-invalid', 'pendências sem identidade');
  return { receipt_sha256: inspection.receipt_sha256, roots, pending_questions: clone(questions),
    historical_reason: inspection.receipt.failure.reason_code,
    provenance_gaps: context.provenance_gaps || [], process_stopped: true, roots_reconciled: true };
}
function assertNoSuccessor(cwd, begin, terminalKey) {
  const events = readEvents(eventsFile(cwd, begin.milestone));
  const index = events.findIndex(item => item.idempotency_key === begin.idempotency_key);
  if (index < 0) throw new ControllerError('begin-event-missing', 'begin sem evento durável');
  if (events.slice(index + 1).some(item => item.action === 'begin' && item.idempotency_key !== begin.idempotency_key)) {
    throw new ControllerError('successor-conflict', 'unidade já possui begin sucessor');
  }
  assertNoTerminal(cwd, begin, terminalKey, events.slice(index + 1));
}
function assertNoTerminal(cwd, begin, terminalKey, later) {
  if (later.some(item => item.unit === begin.unit.key && item.idempotency_key !== terminalKey
    && ['complete', 'fail', 'pause', 'expired-safe', 'persist-result'].includes(item.action))
    || discoverRecords(cwd, 'transaction').some(item => item.unit.key === begin.unit.key && item.milestone === begin.milestone
      && item.lease_generation === begin.lease_generation && item.idempotency_key !== terminalKey
      && ['complete', 'fail', 'pause', 'expired-safe', 'persist-result'].includes(item.action))) {
    throw new ControllerError('terminal-conflict', 'unidade já possui transição terminal');
  }
  if (pendingTransactions(cwd).some(item => item.idempotency_key !== terminalKey)) throw new ControllerError('transaction-pending', 'transação pendente impede consumo');
}
function laterBegins(cwd, begin) {
  const events = readEvents(eventsFile(cwd, begin.milestone));
  const index = events.findIndex(row => row.idempotency_key === begin.idempotency_key && row.action === 'begin');
  if (index < 0) throw new ControllerError('begin-event-missing', 'begin has no published event');
  const seen = new Set();
  return events.slice(index + 1).filter(row => row.action === 'begin').map(event => {
    const row = lookupRecord(cwd, 'transaction', event.idempotency_key);
    if (!row || row.phase !== 'committed' || row.action !== 'begin' || row.milestone !== begin.milestone
      || row.unit.key !== event.unit || seen.has(row.idempotency_key)) throw new ControllerError('record-conflict', 'successor history ambiguous');
    seen.add(row.idempotency_key); return row;
  });
}
function uninvokedEvidence(cwd, begin, successor, original, options) {
  if (successor.owner_digest !== begin.owner_digest || successor.host_runtime !== begin.host_runtime) throw new ControllerError('successor-owner-mismatch', 'successor owner differs');
  const context = options.inspectAttempt({ cwd, begin: clone(successor), references: { purpose: 'abandon-before-dispatch', original_begin_key: begin.idempotency_key } });
  // This is the live host's positive observation of no invocation. A missing
  // receipt, PID, elapsed TTL or a serialized flag never makes this assertion.
  if (context?.begin_key !== successor.idempotency_key || context.begin_checksum !== sha(successor)
    || context.invocation_status !== 'not-invoked' || typeof context.observation_reference !== 'string' || !context.observation_reference.trim()
    || !context.request || context.receipt_path != null) throw new ControllerError('successor-not-proved-uninvoked', 'positive host observation required');
  const recovery = require('./forge-attempt-recovery'), api = require('./forge-code-roots');
  const identity = recovery.requestIdentity(recovery.canonicalRequest(context.request));
  if (`${identity.unit_type}/${identity.task_id || identity.slice_id || identity.milestone_id}` !== successor.unit.key
    || identity.milestone_id !== begin.milestone || identity.host !== successor.host_runtime
    || identity.slice_id && identity.slice_id !== successor.after.state.active_slice
    || api.digest(context.request.claim || null) !== original.claim_sha256) throw new ControllerError('successor-scope-mismatch', 'successor request/claim differs');
  const roots = physicalRoots(context.roots);
  if (sha(roots) !== sha(original.roots) || [context.request.cwd, context.request.contextRoot,
    context.request.execution_contract?.owner, ...(context.request.execution_contract?.code_roots || []).map(root => root.path)]
    .filter(Boolean).some(file => !roots.some(root => root.path === fs.realpathSync.native(file)))) throw new ControllerError('roots-unverified', 'successor physical roots differ');
  if (options.processProbe({ begin_key: successor.idempotency_key, invocation_status: 'not-invoked', observation_reference: context.observation_reference }) !== 'stopped') throw new ControllerError('process-not-stopped', 'successor writer unknown');
  for (const root of roots) {
    const result = options.reconcileRoots({ cwd, root, context, begin: clone(successor), inspection: { invocation_status: 'not-invoked' } });
    if (result?.root_id !== root.root_id || result.process_stopped !== true || result.reconciled !== true) throw new ControllerError('roots-unreconciled', 'successor root unreconciled');
  }
  return { original_begin_key: begin.idempotency_key, original_begin_checksum: sha(begin),
    begin_key: successor.idempotency_key, begin_checksum: sha(successor), request_sha256: recovery.callerRequestHash(context.request),
    claim_sha256: original.claim_sha256, roots, observation_sha256: sha(context.observation_reference) };
}
function compensationKey(begin, successor) { return 'abandon-before-dispatch:' + sha({ original: sha(begin), successor: sha(successor) }); }
function reconcilePartialSuccessors(cwd, input, options = {}) {
  resolvePrefs(cwd, options);
  return withMutex(cwd, 'unit-controller-transactions', () => {
    const begin = terminalIdentity(cwd, input), original = inspectSettledAttempt(cwd, begin, options, ['partial', 'blocked']);
    const observed = forgeRuns.inspectOwnerResume(cwd, begin.milestone, { hostRuntime: begin.host_runtime, expectedSession: options.expectedSession });
    const held = forgeRuns.get(cwd, begin.milestone);
    if (!['same-owner-active', 'same-owner-inactive'].includes(observed.status)
      || require('./forge-code-roots').digest(held?.write_claim || null) !== original.claim_sha256) throw new ControllerError('successor-owner-mismatch', 'observed existing owner and exact claim required');
    const successors = laterBegins(cwd, begin);
    const locators = successors.map(row => ({ key: row.idempotency_key, checksum: sha(row) }));
    if (!successors.length || !Array.isArray(input.successors) || sha(input.successors) !== sha(locators)) throw new ControllerError('successor-inventory-mismatch', 'exact ordered successor inventory required');
    const prepared = successors.map(row => {
      const proof = uninvokedEvidence(cwd, begin, row, original, options), key = compensationKey(begin, row);
      const existing = lookupRecord(cwd, 'transaction', key);
      if (existing && (existing.action !== 'pause' || existing.unit.key !== row.unit.key || existing.milestone !== row.milestone
        || existing.owner_digest !== row.owner_digest || existing.host_runtime !== row.host_runtime || existing.lease_generation !== row.lease_generation
        || sha(existing.result?.output?.abandoned_before_dispatch) !== sha(proof))) throw new ControllerError('successor-terminal-conflict', 'compensation identity differs');
      const records = discoverRecords(cwd, 'transaction').filter(tx => tx.milestone === begin.milestone && tx.unit.key === row.unit.key
        && tx.lease_generation === row.lease_generation && ['complete', 'pause', 'fail', 'expired-safe'].includes(tx.action));
      if (records.some(tx => tx.idempotency_key !== key || sha(tx.result?.output?.abandoned_before_dispatch) !== sha(proof))) throw new ControllerError('successor-terminal-conflict', 'successor has a different terminal');
      return { row, proof, key };
    });
    // Validate ALL successors before the first effect. Every partial phase is
    // replayed by the original transaction runtime; old begins/events survive.
    const transactions = [];
    for (const { row, proof, key } of prepared.reverse()) {
      if (sha(uninvokedEvidence(cwd, begin, row, original, options)) !== sha(proof)) throw new ControllerError('attempt-evidence-changed', 'successor observation changed');
      transactions.push(transitionInside(cwd, { milestone: begin.milestone, unit: row.unit, host_runtime: row.host_runtime,
        owner_token: input.owner_token, generation: row.lease_generation, idempotency_key: key, action: 'pause',
        result: { status: 'cancelled', output: { abandoned_before_dispatch: proof } } }, options).transaction);
    }
    return { ok: true, reason: 'successors-abandoned-before-dispatch', transactions };
  });
}
function assertPartialLineage(cwd, begin, key, proof, options) {
  const successors = laterBegins(cwd, begin);
  if (!successors.length) return assertNoSuccessor(cwd, begin, key);
  const compensatedKeys = new Set();
  for (const row of successors) {
    const compensation = lookupRecord(cwd, 'transaction', compensationKey(begin, row));
    const live = uninvokedEvidence(cwd, begin, row, proof, options);
    if (!compensation || compensation.phase !== 'committed' || compensation.action !== 'pause' || !compensation.boundary?.handoff_ready
      || compensation.unit.key !== row.unit.key || compensation.milestone !== row.milestone || compensation.owner_digest !== row.owner_digest
      || compensation.host_runtime !== row.host_runtime || compensation.lease_generation !== row.lease_generation
      || sha(compensation.result?.output?.abandoned_before_dispatch) !== sha(live)) throw new ControllerError('successor-conflict', 'successor needs exact canonical uninvoked compensation');
    compensatedKeys.add(compensation.idempotency_key);
  }
  const events = readEvents(eventsFile(cwd, begin.milestone)), index = events.findIndex(row => row.idempotency_key === begin.idempotency_key);
  assertNoTerminal(cwd, begin, key, events.slice(index + 1).filter(row => !compensatedKeys.has(row.idempotency_key)));
}
function terminalReplay(cwd, transaction) {
  verifiedFailure(cwd, transaction);
  return { ok: true, reason: 'failure-consumed', transaction: publicTransaction(transaction, cwd),
    failure_key: transaction.idempotency_key, failure_checksum: sha(transaction),
    pending_questions: clone(transaction.terminal_failure.safety.pending_questions) };
}
function runTerminal(cwd, transaction, begin, input, options, guard) {
  if (transaction.phase === 'committed') return terminalReplay(cwd, transaction);
  const check = () => {
    forgeLease.assertTerminalGuard(guard, cwd, begin.unit.key);
    assertNoSuccessor(cwd, begin, transaction.idempotency_key);
    const lease = forgeLease.inspectTerminal(guard, cwd, begin.unit.key, input.owner_token, begin.lease_generation);
    if (!lease.ok) throw new ControllerError('lease-owner-mismatch', lease.reason);
    const live = inspectFailure(cwd, begin, input.failure, options, { guard, ownerToken: input.owner_token,
      transactionKey: transaction.idempotency_key, transactionChecksum: sha(transaction) });
    if (live.receipt_sha256 !== transaction.terminal_failure.safety.receipt_sha256 || sha(live.roots) !== sha(transaction.terminal_failure.safety.roots)
      || sha(live.pending_questions) !== sha(transaction.terminal_failure.safety.pending_questions)) throw new ControllerError('attempt-evidence-changed', 'evidência mudou durante o consumo');
    return lease;
  };
  check();
  if (transaction.phase === 'intent') { check(); publishResult(cwd, transaction.result); setPhase(cwd, transaction, 'result-published', options); }
  if (transaction.phase === 'result-published') { check(); publishEvent(cwd, transaction.milestone, transaction.event); setPhase(cwd, transaction, 'event-published', options); }
  if (transaction.phase === 'event-published') { check(); publishBoundary(cwd, transaction.boundary); setPhase(cwd, transaction, 'boundary-pending', options); }
  if (transaction.phase === 'boundary-pending') {
    check();
    const current = logicalState(forgeState.read(cwd, begin.milestone));
    for (const key of Object.keys(transaction.after.state_patch)) {
      if (!Object.prototype.hasOwnProperty.call(transaction.after.state, key)) continue;
      if (stableStringify(current[key]) !== stableStringify(transaction.before.state[key])
        && stableStringify(current[key]) !== stableStringify(transaction.after.state[key])) throw new ControllerError('state-successor-conflict', 'STATE mudou nos campos da transação');
    }
    publishState(cwd, transaction); setPhase(cwd, transaction, 'state-published', options);
  }
  if (transaction.phase === 'state-published') { check(); setPhase(cwd, transaction, 'lease-release-pending', options); }
  if (transaction.phase === 'lease-release-pending') {
    check();
    const released = forgeLease.releaseTerminal(guard, cwd, begin.unit.key, input.owner_token, begin.lease_generation);
    if (!released.ok) throw new ControllerError('lease-owner-mismatch', released.reason);
    setPhase(cwd, transaction, 'lease-released', options);
  }
  if (transaction.phase === 'lease-released') {
    check(); transaction.boundary.handoff_ready = true; transaction.boundary.committed_at = iso(nowOf(options));
    publishBoundary(cwd, transaction.boundary); setPhase(cwd, transaction, 'boundary-ready', options);
  }
  if (transaction.phase === 'boundary-ready') { check(); setPhase(cwd, transaction, 'committed', options); }
  return terminalReplay(cwd, transaction);
}
// The locator is data. The live inspector must bind its actual request/receipt
// and stopped writer to THIS begin, including all physical roots. JSON flags,
// inactivity, an expired lease and a partial string are insufficient.
function inspectSettledAttempt(cwd, begin, options, statuses, replaySource = true) {
  if (typeof options?.inspectAttempt !== 'function' || typeof options?.processProbe !== 'function'
    || typeof options?.reconcileRoots !== 'function') throw new ControllerError('attempt-inspector-required', 'live attempt and root reconciliation required');
  const context = originalAttemptContext(cwd, begin, options.inspectAttempt({ cwd, begin: clone(begin), references: {} }), options);
  if (!context?.request || typeof context.receipt_path !== 'string' || context.begin_key !== begin.idempotency_key
    || context.begin_checksum !== sha(begin)) throw new ControllerError('attempt-evidence-missing', 'actual begin-bound request and receipt required');
  const recovery = require('./forge-attempt-recovery'), rootsApi = require('./forge-code-roots');
  const archived = archivedProof(cwd, begin, context);
  const identity = archived ? archived.identity : recovery.requestIdentity(recovery.canonicalRequest(context.request));
  if (`${identity.unit_type}/${identity.task_id || identity.slice_id || identity.milestone_id}` !== begin.unit.key || identity.milestone_id !== begin.milestone || identity.host !== begin.host_runtime || identity.slice_id && identity.slice_id !== begin.after.state.active_slice) throw new ControllerError('attempt-identity-mismatch', 'request scope differs from begin');
  // The settled proof records the caller hash. From an archive it exists only
  // when the retained wire bytes reproduce it; a stored hash never substitutes.
  if (archived && archived.caller_request_sha256 === null) throw new ControllerError('request-retention-caller-hash-unavailable', 'archived request cannot reproduce the original caller hash');
  const inspection = recovery.inspectReceipt(context.receipt_path, { request: archived?.linked ? undefined : context.request, processProbe: options.processProbe });
  const receipt = inspection.receipt;
  if (receipt.fingerprint !== (archived ? archived.fingerprint : require('./forge-unit-sidecar').artifactFingerprint(context.request))
    || archived && archived.receipt_sha256 !== inspection.receipt_sha256
    || receipt.recovery_identity_sha256 && receipt.recovery_identity_sha256 !== rootsApi.digest(identity)) throw new ControllerError('attempt-identity-mismatch', 'receipt differs from actual request');
  if (inspection.process_stopped !== true) throw new ControllerError('process-not-stopped', 'writer has not been proved stopped');
  if (receipt.phase !== 'ready' || !statuses.includes(receipt.result?.status)) throw new ControllerError('settled-result-required', 'canonical ready result with the declared status required');
  if (replaySource && receipt.execution) require('./forge-task-execution').assertReplay(context.request, receipt);
  const roots = physicalRoots(context.roots);
  const required = [cwd, context.request.cwd, context.request.contextRoot, context.request.execution_contract?.owner,
    ...(context.request.execution_contract?.code_roots || []).map(root => root.path)].filter(Boolean);
  if (required.some(file => !roots.some(root => root.path === fs.realpathSync.native(file)))) throw new ControllerError('roots-unverified', 'attempt root omitted');
  for (const root of roots) {
    const observed = options.reconcileRoots({ cwd, root, context, inspection, begin: clone(begin) });
    if (!observed || observed.root_id !== root.root_id || observed.process_stopped !== true || observed.reconciled !== true) throw new ControllerError('roots-unreconciled', 'actual root reconciliation required');
  }
  const pending = require('./forge-interaction').mergePendingQuestions(receipt.pending_questions || [], receipt.result.questions || []);
  return { begin_key: begin.idempotency_key, begin_checksum: sha(begin), receipt_sha256: inspection.receipt_sha256,
    request_sha256: archived ? archived.caller_request_sha256 : recovery.callerRequestHash(context.request), claim_sha256: rootsApi.digest(context.request.claim || null),
    status: receipt.result.status, roots, pending_questions: require('./forge-interaction').mergePendingQuestions(pending, context.pending_questions || []) };
}
// A verified ready/done attempt can be administratively paused for repair.
// This records no accepted parent delivery and cannot be supplied as JSON proof.
function decompositionPlanBinding(cwd, begin, options, proof, plan) {
  const context = originalAttemptContext(cwd, begin, options.inspectAttempt({ cwd, begin: clone(begin), references: { purpose: 'decompose-plan-binding' } }), options);
  if (!context?.request?.planFile || context.begin_key !== begin.idempotency_key || context.begin_checksum !== sha(begin)) throw new ControllerError('attempt-evidence-missing', 'original plan input binding required');
  const receipt = require('./forge-attempt-recovery').inspectReceipt(context.receipt_path);
  if (receipt.receipt_sha256 !== proof.receipt_sha256) throw new ControllerError('attempt-evidence-changed', 'original receipt changed');
  const original = receipt.receipt.execution?.inputs?.[context.request.planFile];
  if (typeof original !== 'string' || !/^[a-f0-9]{64}$/.test(original)) throw new ControllerError('attempt-evidence-missing', 'original plan hash is unknown; never infer an anchor');
  const digest = text => crypto.createHash('sha256').update(text).digest('hex'), candidates = new Set([plan.content]);
  const count = require('./forge-repair').readRepairCount(plan.content);
  if (Number.isSafeInteger(count) && count > 0) {
    candidates.add(plan.content.replace(/^(repair_count:[ \t]*)\d+/m, (_line, prefix) => prefix + (count - 1)));
    if (count === 1) candidates.add(plan.content.replace(/^(\uFEFF?---\r?\n)repair_count: 1\r?\n/, '$1'));
  }
  const prior = [...candidates].find(text => digest(text) === original);
  if (prior === undefined) throw new ControllerError('attempt-evidence-changed', 'only the exact original plan or canonical repair counter increment is accepted');
  return { original_plan_sha256: original, plan_transition: prior === plan.content ? 'unchanged' : 'repair-counter-only' };
}
function pauseDecomposition(cwd, input, options = {}) {
  resolvePrefs(cwd, options);
  return withMutex(cwd, 'unit-controller-transactions', () => {
    const begin = terminalIdentity(cwd, input);
    if (begin.unit.type !== 'execute-task' || begin.batch) throw new ControllerError('unit-identity-mismatch', 'only the current single task can decompose');
    const existing = lookupRecord(cwd, 'transaction', input.idempotency_key);
    if (existing && (existing.action !== 'pause' || existing.result?.output?.decomposition_attempt?.begin_key !== begin.idempotency_key)) throw new ControllerError('record-conflict', 'decompose pause key differs');
    // Administrative repair does not publish/accept the old result. The owner
    // may have incremented repair_count, but its executable contract must still
    // be the admitted generation; receipt/request and stopped/root proof stay exact.
    require('./forge-plan-validation').assertSliceGeneration(cwd, { milestone: begin.milestone, slice: begin.after.state.active_slice });
    const live = inspectSettledAttempt(cwd, begin, options, ['done'], false);
    if (live.pending_questions.some(row => row.status === 'pending')) throw new ControllerError('pending-questions', 'decompose retains unanswered decisions');
    const plan = require('./forge-plan-validation').readOwnerTaskPlan(cwd, { milestone: begin.milestone, slice: begin.after.state.active_slice, task: begin.unit.id });
    if (plan.status !== 'ok') throw new ControllerError('attempt-evidence-missing', 'the current canonical parent plan is unavailable');
    const workflow = options.workflow?.workflow_id;
    if (typeof workflow !== 'string' || !workflow.trim()) throw new ControllerError('unit-identity-mismatch', 'the actual loop workflow is required');
    const count = options.workflow.step_count, maximum = options.workflow.max_steps;
    if (!Number.isInteger(count) || count < 1 || !Number.isInteger(maximum) || count > maximum) throw new ControllerError('unit-identity-mismatch', 'the real reserved parent step is required');
    const planBinding = decompositionPlanBinding(cwd, begin, options, live, plan);
    const proof = { ...live, ...planBinding, workflow_id: workflow, parent_step: count, max_steps: maximum,
      plan_sha256: existing?.result.output.decomposition_attempt.plan_sha256 || plan.sha256 };
    if (existing && sha(existing.result.output.decomposition_attempt) !== sha(proof)) throw new ControllerError('attempt-evidence-changed', 'decompose attempt changed');
    if (!existing) assertNoSuccessor(cwd, begin, input.idempotency_key);
    const currentAutoMode = forgeState.read(cwd, begin.milestone)?.auto_mode;
    return transitionInside(cwd, { ...input, action: 'pause', unit: begin.unit, generation: begin.lease_generation,
      state_patch: { active_slice: begin.after.state.active_slice, active_task: begin.after.state.active_task,
        ...(currentAutoMode !== undefined ? { auto_mode: currentAutoMode } : {}) },
      result: { status: 'cancelled', output: { decomposition_attempt: proof } } }, options);
  });
}
// The canonical historical completion of every child, then a new REAL parent
// execution/verification. A checkbox, callback or imported aggregate cannot
// replace any child delivery, begin, completion, or the new parent's own proof.
function decompositionProgress(cwd, mutation, records) {
  const children = [];
  for (const id of mutation.added_task_ids) {
    if (!scopedCompletion(cwd, mutation.milestone, mutation.slice, id, records)) return { verified: false, verification: null };
    const lineage = records.filter(row => row.phase === 'committed' && row.milestone === mutation.milestone
      && row.unit.key === 'execute-task/' + id && row.after.state.active_slice === mutation.slice
      && ['begin', 'complete'].includes(row.action)).map(row => ({ key: row.idempotency_key, checksum: sha(row) })).sort((x,y) => x.key.localeCompare(y.key));
    const delivery = fs.readFileSync(path.join(cwd, '.gsd/milestones', mutation.milestone, 'slices', mutation.slice, 'tasks', id, id + '-DELIVERY.json'));
    children.push({ task_id: id, lineage, delivery_sha256: crypto.createHash('sha256').update(delivery).digest('hex') });
  }
  const entries = records.filter(row => row.phase === 'committed' && row.action === 'begin' && row.decomposition_entry?.mutation_ref === mutation.mutation_ref
    && mutation.added_task_ids.includes(row.unit.id) && validDecompositionEntry(cwd, row));
  const pauses = [...new Set(entries.map(row => row.decomposition_entry.pause_key))];
  if (pauses.length !== 1) return { verified: false, verification: null };
  const paused = lookupRecord(cwd, 'transaction', pauses[0]);
  const binding = { mutation_ref: mutation.mutation_ref, admission_sha256: mutation.admission_sha256,
    pause_key: paused.idempotency_key, pause_checksum: sha(paused), children_sha256: sha(children), children };
  const own = records.filter(row => row.unit.key === 'execute-task/' + mutation.parent_task_id
    && row.milestone === mutation.milestone && row.after.state.active_slice === mutation.slice);
  const begins = own.filter(row => row.action === 'begin' && row.phase === 'committed' && sha(row.decomposition_verification || null) === sha(binding));
  const verified = begins.some(begin => scopedCompletion(cwd, mutation.milestone, mutation.slice, mutation.parent_task_id,
    own.filter(row => row.owner_digest === begin.owner_digest && row.lease_generation === begin.lease_generation)));
  return { verified, verification: verified ? null : binding };
}
function decompositionVerification(cwd, input, unit, ownerToken, hostRuntime) {
  const provided = input.decomposition_verification_from;
  const mutation = require('./forge-plan-validation').readDecompositionAdmission(cwd, provided?.mutation_ref);
  if (unit.type !== 'execute-task' || unit.id !== mutation.parent_task_id || input.milestone !== mutation.milestone || input.slice !== mutation.slice) throw new ControllerError('unit-identity-mismatch', 'verification is of the exact original parent');
  const progress = decompositionProgress(cwd, mutation, discoverRecords(cwd, 'transaction'));
  if (!progress.verification || sha(progress.verification) !== sha(provided)) throw new ControllerError('decomposition-verification-required', 'actual child completion and delivery proofs required');
  const paused = lookupRecord(cwd, 'transaction', progress.verification.pause_key);
  if (paused.owner_digest !== ownerDigest(ownerToken) || paused.host_runtime !== hostRuntime) throw new ControllerError('unit-identity-mismatch', 'verification belongs to another owner/host');
  return progress.verification;
}
function decompositionEntry(cwd, input, unit, ownerToken, hostRuntime, options) {
  const ref = input.decomposition_from;
  if (!ref || typeof ref.pause_key !== 'string' || typeof ref.pause_checksum !== 'string' || typeof ref.mutation_ref !== 'string') throw new ControllerError('unit-identity-mismatch', 'decompose continuation binding is required');
  const paused = lookupRecord(cwd, 'transaction', ref.pause_key), stored = paused?.result?.output?.decomposition_attempt;
  if (!paused || paused.action !== 'pause' || paused.phase !== 'committed' || !paused.boundary?.handoff_ready || !stored
      || sha(paused) !== ref.pause_checksum || paused.owner_digest !== ownerDigest(ownerToken) || paused.host_runtime !== hostRuntime
      || paused.milestone !== input.milestone || paused.unit.type !== 'execute-task'
      || options.workflow?.workflow_id !== stored.workflow_id || options.workflow?.step_count !== stored.parent_step
      || options.workflow?.max_steps !== stored.max_steps) throw new ControllerError('unit-identity-mismatch', 'foreign decompose pause or step reservation');
  const mutation = require('./forge-plan-validation').readDecompositionAdmission(cwd, ref.mutation_ref);
  if (mutation.milestone !== input.milestone || mutation.slice !== input.slice || mutation.slice !== paused.after.state.active_slice
      || mutation.parent_task_id !== paused.unit.id || mutation.parent_plan_sha256 !== stored.plan_sha256
      || unit.type !== 'execute-task' || !mutation.added_task_ids.includes(unit.id)) throw new ControllerError('unit-identity-mismatch', 'child is not of this exact admitted mutation');
  const spent = discoverRecords(cwd, 'transaction').filter(row => row.action === 'begin'
    && row.decomposition_entry?.pause_key === paused.idempotency_key);
  if (spent.length > 1 || spent.length === 1 && (spent[0].idempotency_key !== input.idempotency_key
      || spent[0].unit.key !== unit.key || !validDecompositionEntry(cwd, spent[0]))) throw new ControllerError('record-conflict', 'the parent step reservation is already consumed');
  if (!spent.length) {
    const ready = select(cwd, { milestone: input.milestone }, options);
    if (!ready.ok || ready.slice !== input.slice || ready.unit?.key !== unit.key) throw new ControllerError('unit-identity-mismatch', 'only the canonical first ready child replaces the parent step');
  }
  {
    const begin = lookupRecord(cwd, 'transaction', stored.begin_key);
    if (!begin || sha(begin) !== stored.begin_checksum) throw new ControllerError('attempt-evidence-changed', 'parent begin changed');
    const { plan_sha256, original_plan_sha256, plan_transition, workflow_id, parent_step, max_steps, ...original } = stored, live = inspectSettledAttempt(cwd, begin, options, ['done'], false);
    if (sha(original) !== sha(live) || live.pending_questions.some(row => row.status === 'pending')) throw new ControllerError('attempt-evidence-changed', 'paused evidence or questions changed');
    const oldLease = forgeLease.readLease(forgeLease.leaseFile(cwd, paused.unit.key));
    if (oldLease.record || oldLease.corrupt) throw new ControllerError('lease-active', 'the parent is not released');
  }
  return { pause_key: paused.idempotency_key, pause_checksum: sha(paused), mutation_ref: ref.mutation_ref,
    admission_sha256: mutation.admission_sha256, parent_begin_key: stored.begin_key, parent_begin_checksum: stored.begin_checksum,
    workflow_id: stored.workflow_id, replaces_parent_step: stored.parent_step, max_steps: stored.max_steps };
}
function validDecompositionEntry(cwd, next) {
  try {
    const link = next.decomposition_entry;
    const input = { milestone: next.milestone, slice: next.after.state.active_slice,
      decomposition_from: { pause_key: link.pause_key, pause_checksum: link.pause_checksum, mutation_ref: link.mutation_ref } };
    // Historical validation has no callback or runtime grant: only exact
    // canonical pause/mutation/begin checksums can close this lineage edge.
    const paused = lookupRecord(cwd, 'transaction', link.pause_key);
    if (!paused || next.owner_digest !== paused.owner_digest || next.host_runtime !== paused.host_runtime) return false;
    const mutation = require('./forge-plan-validation').readDecompositionAdmission(cwd, link.mutation_ref);
    return sha(paused) === link.pause_checksum && mutation.admission_sha256 === link.admission_sha256
      && paused.result.output.decomposition_attempt.begin_key === link.parent_begin_key
      && paused.result.output.decomposition_attempt.begin_checksum === link.parent_begin_checksum
      && paused.result.output.decomposition_attempt.workflow_id === link.workflow_id
      && paused.result.output.decomposition_attempt.parent_step === link.replaces_parent_step
      && paused.result.output.decomposition_attempt.max_steps === link.max_steps
      && mutation.parent_plan_sha256 === paused.result.output.decomposition_attempt.plan_sha256
      && mutation.parent_task_id === paused.unit.id && mutation.milestone === input.milestone && mutation.slice === input.slice
      && next.unit.type === 'execute-task' && mutation.added_task_ids.includes(next.unit.id);
  } catch { return false; }
}
function pausePartial(cwd, input, options = {}) {
  resolvePrefs(cwd, options);
  return withMutex(cwd, 'unit-controller-transactions', () => {
    const begin = terminalIdentity(cwd, input), key = input.idempotency_key;
    const existing = lookupRecord(cwd, 'transaction', key);
    if (existing && (existing.action !== 'pause' || existing.result?.output?.partial_attempt?.begin_key !== begin.idempotency_key)) throw new ControllerError('record-conflict', 'partial pause key differs');
    const proof = inspectSettledAttempt(cwd, begin, options, ['partial', 'blocked']);
    if (!existing) assertPartialLineage(cwd, begin, key, proof, options);
    if (input.result?.status !== proof.status || existing && sha(existing.result.output.partial_attempt) !== sha(proof)) throw new ControllerError('attempt-evidence-changed', 'partial evidence changed');
    return transitionInside(cwd, { ...input, action: 'pause', unit: begin.unit, generation: begin.lease_generation,
      state_patch: { active_slice: begin.after.state.active_slice, active_task: begin.after.state.active_task },
      result: { status: 'cancelled', output: { partial_attempt: proof } } }, options);
  });
}
function verifyCompletedAttempt(cwd, begin, options) {
  return inspectSettledAttempt(cwd, begin, options, ['done']);
}
// Read-only proof used inside resumeOwner's existing controller→registry fence.
// It grants no owner transfer, claim release or writer authority of its own.
function inspectPausedAttempt(cwd, record, options) {
  const pending = incompleteUnits(cwd, record.id).filter(row => row.action === 'pause' && row.result?.output?.partial_attempt);
  if (pending.length !== 1) throw new ControllerError('owner-resume-partial-boundary-required', 'one exact paused attempt required');
  const paused = pending[0], stored = paused.result.output.partial_attempt;
  handoff(cwd, { unit: paused.unit.key, next_host_runtime: record.host_runtime }, options);
  const begin = lookupRecord(cwd, 'transaction', stored.begin_key);
  if (!begin || sha(begin) !== stored.begin_checksum) throw new ControllerError('attempt-evidence-changed', 'partial begin changed');
  const live = inspectSettledAttempt(cwd, begin, options, ['partial', 'blocked'], false);
  if (sha(live) !== sha(stored) || live.claim_sha256 !== require('./forge-code-roots').digest(record.write_claim)) throw new ControllerError('attempt-evidence-changed', 'partial claim or attempt changed');
  require('./forge-code-roots').claimGroups(record.write_claim);
  return { unit: paused.unit.key, receipt_sha256: live.receipt_sha256, request_sha256: live.request_sha256 };
}
function consumeFailure(cwd, request, options = {}) {
  resolvePrefs(cwd, options);
  return withMutex(cwd, 'unit-controller-transactions', () => {
    const input = object(request, 'request'), begin = terminalIdentity(cwd, input);
    const key = `consume-failure:${sha({ begin: begin.idempotency_key, checksum: sha(begin) })}`;
    let transaction = lookupRecord(cwd, 'transaction', key);
    if (transaction && transaction.phase === 'committed') return terminalReplay(cwd, transaction);
    const output = forgeLease.withTerminalGuard(cwd, begin.unit.key, guard => {
      assertNoSuccessor(cwd, begin, key);
      const lease = forgeLease.inspectTerminal(guard, cwd, begin.unit.key, input.owner_token, begin.lease_generation);
      if (!lease.ok) throw new ControllerError('lease-owner-mismatch', lease.reason);
      if (!transaction) {
        const safety = inspectFailure(cwd, begin, input.failure, options);
        transaction = makeTransaction(cwd, { milestone: begin.milestone, result: { status: 'failed', reason_code: safety.historical_reason,
          output: { historical_reason: safety.historical_reason, provenance_gaps: safety.provenance_gaps, pending_questions: safety.pending_questions } },
          state_patch: { phase: 'blocked', active_task: '—', owner: null } }, 'fail', begin.unit, key, input.owner_token, begin.lease_generation, begin.host_runtime, nowOf(options));
        transaction.terminal_failure = { begin_key: begin.idempotency_key, begin_checksum: sha(begin), slice: begin.after.state.active_slice === '—' ? null : begin.after.state.active_slice,
          lease_at_intent: lease.present ? 'matching-present' : 'proven-absent', safety };
        saveTransaction(cwd, transaction, nowOf(options), options); fail(options, 'after-intent');
      }
      return runTerminal(cwd, transaction, begin, input, options, guard);
    });
    if (!output.ok) throw new ControllerError(output.reason, 'guard terminal indisponível');
    return output;
  });
}

// The live host reattests explicit answers from its evidence, including after
// restart. Serialized resolved flags alone are never authority.
function currentEntryQuestions(cwd, failure, options) {
  return withMutex(cwd, 'unit-controller-questions', () => updateEntryQuestions(cwd, failure, options));
}
function updateEntryQuestions(cwd, failure, options) {
  const interaction = require('./forge-interaction');
  const identity = { failure_key: failure.idempotency_key, failure_checksum: sha(failure),
    unit: failure.unit.key, milestone: failure.milestone, slice: failure.terminal_failure.slice,
    owner_digest: failure.owner_digest, host_runtime: failure.host_runtime, roots: failure.terminal_failure.safety.roots };
  if (sha(physicalRoots(identity.roots)) !== sha(identity.roots)) throw new ControllerError('entry-roots-mismatch', 'physical roots changed');
  const file = path.join(rootDir(cwd), 'entry-questions', sha(identity) + '.json');
  const inventoryFile = path.join(rootDir(cwd), 'entry-question-inventories', sha(identity) + '.json');
  for (const target of [file, inventoryFile]) for (let cursor = target; cursor !== path.dirname(cursor); cursor = path.dirname(cursor)) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new ControllerError('question-state-path-invalid', 'linked question state path');
    if (path.resolve(cursor) === path.resolve(cwd)) break;
  }
  const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  if (previous && (previous.schema_version !== 1 || previous.identity_sha256 !== require('./forge-code-roots').digest(identity))) {
    throw new ControllerError('question-state-scope-mismatch', 'foreign question state');
  }
  const historical = failure.terminal_failure.safety.pending_questions;
  const inventory = readRecordJson(inventoryFile);
  const required = discoverRecords(cwd, 'transaction').some(record => record.linked_entry?.failure_key === failure.idempotency_key
    && record.linked_entry.question_inventory_version === 1);
  if (!inventory && (required || previous)) throw new ControllerError('question-inventory-missing', 'durable question inventory missing');
  if (inventory && inventory.identity_sha256 !== require('./forge-code-roots').digest(identity)) throw new ControllerError('question-state-scope-mismatch', 'foreign question inventory');
  // Inventory is independent of the replaceable answer projection. Publish it
  // first: interruption may conservatively retain a pending question, never lose it.
  const saveInventory = questions => writeAtomic(inventoryFile, { schema_version: 1,
    identity_sha256: require('./forge-code-roots').digest(identity),
    questions: clone(questions) });
  if (typeof options.questionStateAdapter !== 'function') {
    if (previous || inventory?.questions.length || historical.some(q => q.status === 'pending')) throw new ControllerError('pending-questions', 'live question attestation required');
    if (!inventory) saveInventory(historical);
    return clone(historical);
  }
  let questions = interaction.mergePendingQuestions(historical, previous?.questions || []);
  questions = interaction.mergePendingQuestions(questions, inventory?.questions || []);
  questions = interaction.mergePendingQuestions(questions, options.observedPendingQuestions || []);
  const live = options.questionStateAdapter({ identity: clone(identity), previous: clone(previous), inventory: clone(inventory), historical: clone(historical), questions: clone(questions) });
  if (!live || !Array.isArray(live.answers)) throw new ControllerError('question-state-attestation-required', 'explicit attested answers required');
  questions = interaction.mergePendingQuestions(questions, live.questions || []);
  if (live.answers.length) questions = interaction.resolvePendingQuestions(questions, live.answers);
  for (const old of [...inventory?.questions || [], ...previous?.questions || []]) {
    const current = questions.find(q => q.id === old.id);
    if (old.status === 'resolved' && (current.status !== 'resolved' || current.answer !== old.answer)) throw new ControllerError('question-state-attestation-required', 'persisted answer not reattested');
  }
  saveInventory(questions);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return interaction.persistQuestionState(file, identity, questions, live.answers);
}
function assertQuestionsResolved(questions) {
  if (questions.some(q => q.status === 'pending')) {
    const error = new ControllerError('pending-questions', 'decisão funcional pendente');
    error.pending_questions = clone(questions); throw error;
  }
}
function entryScope(cwd, input, failure, options) {
  if (typeof options.captureEntryBaseline !== 'function' || !options.entryAuthority || typeof options.entryAuthority.issue !== 'function') {
    throw new ControllerError('entry-authority-required', 'baseline e autorização viva da nova unidade obrigatórias');
  }
  const baseline = options.captureEntryBaseline({ cwd, failure: clone(failure), entry: clone(input.entry) });
  if (!baseline || !/^[a-f0-9]{64}$/.test(baseline.sha256 || '')) throw new ControllerError('entry-baseline-invalid', 'baseline atual inválida');
  const roots = physicalRoots(baseline.roots);
  if (sha(roots) !== sha(failure.terminal_failure.safety.roots)) throw new ControllerError('entry-roots-mismatch', 'raízes físicas da entrada divergentes');
  const entryId = opaque(input.entry?.entry_id, 'entry_id', true);
  const previousEntry = lookupRecord(cwd, 'transaction', `linked-entry:${sha(entryId)}`);
  const identity = { entry_id: entryId, failure_key: failure.idempotency_key,
    failure_checksum: sha(failure), begin_checksum: failure.terminal_failure.begin_checksum, baseline_sha256: baseline.sha256,
    roots, owner_digest: ownerDigest(input.owner_token), host_runtime: forgeRuntime.normalizeHostRuntime(input.host_runtime), classification: 'new-unit',
    ...(!previousEntry || previousEntry.linked_entry?.question_inventory_version === 1 ? { question_inventory_version: 1 } : {}) };
  const digest = sha(identity), rootsDigest = sha(roots), now = nowOf(options);
  const scope = { unit: failure.unit.key, roots_sha256: rootsDigest, routes: [identity.host_runtime], purpose: 'linked-unit-entry',
    request_identity_sha256: digest, owner_digest: identity.owner_digest, gates_preserved: true, expires_at: now + 60000 };
  const capability = options.entryAuthority.issue(input.entry.authorization_ref, scope, () => now);
  const valid = require('./forge-attempt-recovery.js').exceptionFor(capability,
    { unit: failure.unit.key, roots_sha256: rootsDigest, request_identity_sha256: digest, purpose: 'linked-unit-entry' }, now);
  if (!valid || valid.purpose !== 'linked-unit-entry' || valid.owner_digest !== identity.owner_digest || !valid.routes.includes(identity.host_runtime)) {
    throw new ControllerError('entry-authorization-invalid', 'autorização da nova unidade recusada');
  }
  return { ...identity, authorization_ref: input.entry.authorization_ref, entry_digest: digest };
}
function reenter(cwd, request, options = {}) {
  resolvePrefs(cwd, options);
  return withMutex(cwd, 'unit-controller-transactions', () => {
    const input = object(request, 'request'), failure = lookupRecord(cwd, 'transaction', input.entry?.failure_key);
    const verified = failure && verifiedFailure(cwd, failure);
    if (!verified || input.entry.failure_checksum !== sha(failure) || failure.unit.key !== unitFromRequest(input).key || failure.milestone !== input.milestone
      || !failure.owner_interruption && failure.owner_digest !== ownerDigest(input.owner_token)
      || failure.host_runtime !== forgeRuntime.normalizeHostRuntime(input.host_runtime)) throw new ControllerError('entry-failure-mismatch', 'falha consumida não corresponde à entrada');
    failureAncestors(cwd, failure.idempotency_key);
    if (failure.owner_interruption) assertInterruptedEntryActor(cwd, failure, input, options);
    const linked = entryScope(cwd, input, failure, options), key = `linked-entry:${sha(linked.entry_id)}`;
    const questions = currentEntryQuestions(cwd, failure, options);
    assertQuestionsResolved(questions);
    let existing = lookupRecord(cwd, 'transaction', key);
    if (existing && sha(existing.linked_entry) !== sha(linked)) throw new ControllerError('entry-conflict', 'entry_id reutilizado com conteúdo divergente');
    if (pendingTransactions(cwd).some(item => item.idempotency_key !== key)) throw new ControllerError('transaction-pending', 'transação pendente impede reentrada');
    assertUnitAvailable(cwd, input.milestone, failure.unit, failure.terminal_failure.slice, options,
      { failureKey: failure.idempotency_key, transactionKey: key });
    if (existing?.phase === 'committed') {
      assertLease(cwd, existing.unit.key, input.owner_token, existing.lease_generation);
      return { ok: true, reason: 'entry-ready', transaction: publicTransaction(existing, cwd), linked_entry: clone(linked), pending_questions: questions };
    }
    if (!existing) {
      const admission = decideTimeAdmission(cwd,
        { milestone: input.milestone, unit: failure.unit, key, now: options.now, kind: 'reenter' });
      if (!admission.allowed) throw new ControllerError(admission.reason_code, 'Reentrada recusada pelo contrato de tempo da milestone', admission.details);
      // Only a new entry is readmitted against the real owner state; a committed one replays above.
      assertTimeOptionAdmission(cwd, input.milestone, failure.unit, key, failure.terminal_failure.slice, options,
        { beginKey: failure.terminal_failure.begin_key });
      if (failureProjection(cwd, input.milestone).some(item => item.transaction.idempotency_key === failure.idempotency_key && item.entry)) throw new ControllerError('entry-conflict', 'falha já possui entrada');
      const concurrent = discoverRecords(cwd, 'transaction').some(item => item.milestone === input.milestone && item.action === 'begin'
        && item.idempotency_key !== failure.terminal_failure.begin_key && forgeLease.observe(cwd, item.unit.key).lease);
      if (concurrent) throw new ControllerError('lease-active', 'outra unidade operacional permanece ativa');
      const observation = forgeLease.observe(cwd, failure.unit.key);
      if (!observation.ok || observation.lease) throw new ControllerError('lease-active', 'reentrada exige lease ausente e íntegra');
      // Issue 343 U0d: a linked reentry is a new begin too. An execute-task rechecks its
      // slice's enrolled generation; a plan-slice inherits the enrollment of its failed
      // predecessor begin (never lost, never invented for a pre-requirement lineage).
      if (failure.unit.type === 'execute-task') assertExecuteGeneration(cwd, failure.milestone, failure.terminal_failure.slice);
      const enrolled = failure.unit.type === 'plan-slice' && predecessorEnrolled(cwd, failure.milestone, failure.unit, failure);
      const acquired = forgeLease.acquire(cwd, failure.unit.key, { ownerToken: input.owner_token, hostRuntime: linked.host_runtime, requestId: key, now: options.now });
      if (!acquired.ok) throw new ControllerError('lease-active', 'lease concorrente');
      try {
        existing = makeTransaction(cwd, { milestone: failure.milestone, state_patch: { active_slice: failure.terminal_failure.slice || '—' } },
          'begin', failure.unit, key, input.owner_token, acquired.generation, linked.host_runtime, nowOf(options));
        existing.linked_entry = linked;
        if (admission.record) existing.time_admission = admission.record;
        if (enrolled) existing.plan_generation = clone(planGenerationOf(cwd, failure.milestone, failure.unit, key, acquired.generation, input.owner_token));
        saveTransaction(cwd, existing, nowOf(options), options);
      } catch (error) {
        let durable;
        try { durable = lookupRecord(cwd, 'transaction', key); }
        catch (inspectionError) {
          error.reconciliation = { required: true, reason: 'durability-ambiguous', cause: inspectionError.message };
          throw error;
        }
        if (durable || acquired.reason !== 'acquired') {
          error.reconciliation = { required: true, reason: durable ? 'durable-record' : 'reused-lease' };
        } else {
          try {
            error.rollback = forgeLease.release(cwd, failure.unit.key, input.owner_token, acquired.generation, { requestId: key });
            if (!error.rollback.ok) error.reconciliation = { required: true, reason: error.rollback.reason };
          } catch (releaseError) {
            error.reconciliation = { required: true, reason: 'rollback-failed', cause: releaseError.message };
          }
        }
        throw error;
      }
      fail(options, 'after-intent');
    }
    const result = runTransaction(cwd, existing, input.owner_token, existing.lease_generation, options);
    return { ...result, reason: 'entry-ready', linked_entry: clone(linked), pending_questions: questions };
  });
}

// Revalidation at the real sidecar boundary, including restart, uses live host
// adapters again. A linked JSON record is a locator, never a capability.
function validateLinkedEntry(cwd, key, options = {}) {
  const entry = validateLinkedScope(cwd, key, options);
  const begin = lookupRecord(cwd, 'transaction', key);
  assertLease(cwd, begin.unit.key, options.ownerToken, begin.lease_generation);
  return entry;
}
function validateLinkedScope(cwd, key, options) {
  const begin = lookupRecord(cwd, 'transaction', key);
  if (!begin?.linked_entry || begin.action !== 'begin' || begin.phase !== 'committed') throw new ControllerError('entry-invalid', 'begin vinculado ausente');
  const linked = begin.linked_entry;
  const failure = lookupRecord(cwd, 'transaction', linked.failure_key);
  failureAncestors(cwd, linked.failure_key);
  if (!failure || linked.failure_checksum !== sha(failure)) throw new ControllerError('entry-conflict', 'linked failure changed');
  const ownerToken = options.ownerToken;
  if (failure.owner_interruption) assertInterruptedEntryActor(cwd, failure, { owner_token: ownerToken, host_runtime: linked.host_runtime }, options);
  const live = entryScope(cwd, { owner_token: ownerToken, host_runtime: linked.host_runtime,
    entry: { entry_id: linked.entry_id, authorization_ref: linked.authorization_ref } }, failure, options);
  if (sha(live) !== sha(linked)) throw new ControllerError('entry-conflict', 'entrada mudou desde autorização');
  const questions = currentEntryQuestions(cwd, failure, options);
  assertQuestionsResolved(questions);
  return { entry_digest: linked.entry_digest, entry_id: linked.entry_id, begin_key: key, unit: begin.unit.key, roots: linked.roots, classification: 'new-unit', pending_questions: questions };
}

// #382 read-only historical data: the identity a committed linked begin had,
// proven by its own checksummed failure chain. No owner token, lease, question
// or authorization is validated or implied; this is never a linked binding.
function inspectHistoricalLinkedEntry(cwd, key) {
  const begin = lookupRecord(cwd, 'transaction', key);
  if (!begin?.linked_entry || begin.action !== 'begin' || begin.phase !== 'committed') throw new ControllerError('entry-invalid', 'begin vinculado ausente');
  const linked = begin.linked_entry;
  const failure = lookupRecord(cwd, 'transaction', linked.failure_key);
  failureAncestors(cwd, linked.failure_key);
  if (!failure || linked.failure_checksum !== sha(failure)) throw new ControllerError('entry-conflict', 'linked failure changed');
  return clone({ entry_id: linked.entry_id, entry_digest: linked.entry_digest, begin_key: key, begin_checksum: sha(begin),
    unit: begin.unit.key, roots: linked.roots, host_runtime: begin.host_runtime, milestone: begin.milestone,
    failure_key: linked.failure_key, failure_checksum: linked.failure_checksum, classification: 'new-unit' });
}
function recordChecksum(record) { return sha(record); }
// Consumer side of the archived proof: revalidated synchronously each use; absent
// proof keeps the existing external-request + live-binding path unchanged.
// Existing live administrative callbacks may return only a receipt locator.
// Independent expected identity still comes from the host's executable observer;
// the controller owns creation of the process-local historical proof.
function originalAttemptContext(cwd, begin, context, options) {
  if (!context || context.request !== undefined
      || options.observeOriginalAttempt === undefined) return context;
  if (context.archived_inspection !== undefined) throw new ControllerError('attempt-identity-mismatch',
    'requestless context cannot import an inspection proof', { archived_reason: 'archived-inspection-invalid' });
  if (typeof options.observeOriginalAttempt !== 'function') throw Object.assign(new Error('archived-inspection-host-required'), { code: 'archived-inspection-host-required' });
  if (typeof context.receipt_path !== 'string') return context;
  if (context.begin_key !== undefined && context.begin_key !== begin.idempotency_key
      || context.begin_checksum !== undefined && context.begin_checksum !== sha(begin)) throw new ControllerError('attempt-identity-mismatch', 'host observation belongs to another begin');
  const inspector = require('./forge-attempt-recovery').createArchivedRequestInspector({
    observeOriginalAttempt: observation => options.observeOriginalAttempt(observation) });
  const original = inspector.inspect({ cwd, begin: clone(begin), receiptPath: context.receipt_path });
  return { ...context, ...original };
}

function archivedProof(cwd, begin, context) {
  if (context.archived_inspection === undefined) return null;
  try {
    return require('./forge-attempt-recovery').revalidateArchivedInspection(context.archived_inspection,
      { cwd, begin, receiptPath: context.receipt_path, request: context.request });
  } catch (error) {
    throw new ControllerError('attempt-identity-mismatch', `archived inspection refused: ${error.code || 'invalid'}`, { archived_reason: error.code || 'invalid' });
  }
}

function validateTerminalLinkedEntry(cwd, key, options = {}) {
  const begin = lookupRecord(cwd, 'transaction', key);
  if (!begin?.linked_entry) throw new ControllerError('entry-invalid', 'begin vinculado ausente');
  forgeLease.assertTerminalGuard(options.guard, cwd, begin.unit.key);
  const transaction = lookupRecord(cwd, 'transaction', options.transactionKey);
  const expectedKey = `consume-failure:${sha({ begin: begin.idempotency_key, checksum: sha(begin) })}`;
  if (!transaction || !PHASES.includes(transaction.phase) || transaction.phase === 'committed' || transaction.action !== 'fail'
    || transaction.idempotency_key !== expectedKey || sha(transaction) !== options.transactionChecksum
    || transaction.terminal_failure?.begin_key !== key || transaction.terminal_failure.begin_checksum !== sha(begin)
    || transaction.terminal_failure.slice !== (begin.after.state.active_slice === '—' ? null : begin.after.state.active_slice)
    || transaction.unit.key !== begin.unit.key || transaction.milestone !== begin.milestone
    || transaction.host_runtime !== begin.host_runtime || transaction.owner_digest !== begin.owner_digest
    || transaction.lease_generation !== begin.lease_generation || ownerDigest(options.ownerToken) !== begin.owner_digest) {
    throw new ControllerError('terminal-inspection-invalid', 'transacao terminal divergente');
  }
  assertNoSuccessor(cwd, begin, expectedKey);
  const lease = forgeLease.inspectTerminal(options.guard, cwd, begin.unit.key, options.ownerToken, begin.lease_generation);
  if (!lease.ok) throw new ControllerError('lease-owner-mismatch', lease.reason);
  if (!lease.present && !['lease-release-pending', 'lease-released', 'boundary-ready'].includes(transaction.phase)) {
    throw new ControllerError('lease-required', 'lease ausente antes da fronteira de liberacao');
  }
  return validateLinkedScope(cwd, key, options);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    if (!argv[index].startsWith('--')) continue;
    const key = argv[index].slice(2);
    const next = argv[index + 1];
    args[key] = next && !next.startsWith('--') ? (index++, next) : true;
  }
  return args;
}
function cliMain() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = args.cwd || process.cwd();
  try {
    const request = args.json ? JSON.parse(args.json) : {};
    let output;
    if (args.select) output = select(cwd, { ...request, milestone: args.select });
    else if (args.begin) output = begin(cwd, { ...request, milestone: request.milestone || args.milestone, unit: request.unit || args.begin });
    else if (args.transition) output = transition(cwd, { ...request, action: request.action || args.transition });
    else if (args['persist-result']) output = persistResult(cwd, request);
    else if (args.complete) output = complete(cwd, request);
    else if (args.pause) output = pause(cwd, request);
    else if (args.fail) output = failUnit(cwd, request);
    else if (args['expired-safe']) output = expireSafe(cwd, request);
    else if (args.resume) output = resume(cwd, request);
    else if (args.handoff) output = handoff(cwd, { ...request, unit: request.unit || args.handoff });
    else throw new ControllerError('invalid-request', 'comando ausente');
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || 'unit-controller-error'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  PROTOCOL_VERSION, BOUNDARY_KINDS, ACTIONS, PHASES, REASON_CODES, TIME_ADMISSION_CODES, ControllerError,
  selectNextUnit, discoverInventory, select, begin, beginSerial, transition, persistResult,
  complete, pause, fail: failUnit, expireSafe, resume, handoff,
  withOwnerBoundary, pendingTransactions, incompleteUnits, pausePartial, pauseDecomposition, reconcilePartialSuccessors, inspectPausedAttempt, verifyCompletedAttempt, validatePausedEntry, projectLogicalHistory, logicalState, resolvePrefs,
  transactionDir, resultDir, boundaryDir, eventsFile, transactionFile,
  resultFile, boundaryFile, readEvents, readJson, writeAtomic,
  lookupRecord, preflightPaths,
  consumeFailure, reenter, failureProjection, validateLinkedEntry, validateTerminalLinkedEntry, inspectHistoricalLinkedEntry, recordChecksum, sliceClosure,
  // Issue 343 U5: the controller-terminal seam of a batch member's serial consolidation.
  prepareBatchTerminal, commitBatchTerminal,
  settleInterruptedLineage, verifyOwnerInterruption, pendingOwnerInterruptions, ownerInterruptionIdentity,
  ownerInterruptionQuestions, archiveOwnerInterruptionWitnesses,
  dependencies: { forgeState, forgeRuns, forgePrefs, forgeRuntime, forgeIds, forgeLease },
};

// Time-selection producer proofs can require this module during CLI selection.
// Publish the same API as require() callers before entering that circular path.
if (require.main === module) cliMain();
