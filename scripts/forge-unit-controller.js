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

const PROTOCOL_VERSION = '1.0.0';
const BOUNDARY_KINDS = Object.freeze(['completed', 'paused', 'failed-persisted', 'expired-safe']);
const ACTIONS = Object.freeze(['begin', 'running', 'persist-result', 'complete', 'pause', 'fail', 'expired-safe']);
const PHASES = Object.freeze([
  'intent', 'result-published', 'event-published', 'boundary-pending',
  'state-published', 'lease-release-pending', 'lease-released', 'boundary-ready', 'committed',
]);
const REASON_CODES = Object.freeze([
  'selected', 'no-next-unit', 'prefs-invalid', 'transaction-pending',
  'lease-required', 'lease-owner-mismatch', 'transition-committed',
  'already-committed', 'handoff-ready', 'boundary-missing',
  'boundary-not-transferable', 'lease-active', 'invalid-request',
]);

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
function withMutex(cwd, name, fn) {
  const handle = forgeLock.acquireProcessSync(cwd, name, { retries: 80, ttlMs: 10_000 });
  try { return fn(handle); } finally { handle.release(); }
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
  if (!inventory.roadmap_exists) return selected('plan-milestone', milestone, milestone, current);
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
    const task = (slice.tasks || []).find(item => !item.checked);
    if (task) return selected('execute-task', task.id, milestone, current, slice.id);
    if (!slice.summary_exists) return selected('complete-slice', slice.id, milestone, current, slice.id);
  }
  if (pending.length) return { ok: false, reason: 'units-blocked', done: false, milestone, blocked };
  if (!inventory.milestone_complete) return selected('complete-milestone', milestone, milestone, current);
  return { ok: false, reason: 'no-next-unit', done: true, milestone };
}
function selected(type, id, milestone, state, slice) {
  const unit = forgeRuntime.normalizeUnit({ type, id, state: 'queued' });
  return {
    ok: true,
    reason: 'selected',
    milestone,
    slice: slice || null,
    unit: { type: unit.type, id: unit.id, key: forgeLease.normalizeUnitKey(unit) },
    state_checksum: sha(logicalState(state)),
  };
}

function firstExisting(dir, predicate) {
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).sort().find(predicate) || null;
}
function discoverInventory(cwd, milestone, current) {
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
      tasks: fs.existsSync(plan) ? forgeStatus.parsePlanTasks(fs.readFileSync(plan, 'utf8')) : [],
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
  return {
    roadmap_exists: !!roadmapFile,
    context_exists: !!firstExisting(milestoneDir, name => name.endsWith('-CONTEXT.md')),
    research_exists: !!firstExisting(milestoneDir, name => name.endsWith('-RESEARCH.md')),
    active_slice: current.active_slice && current.active_slice !== '—' ? current.active_slice : null,
    slices,
    dependency_validation: true,
    milestone_complete: roadmapComplete && milestoneClosed,
  };
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
  const inventory = options && typeof options.inventoryReader === 'function' ? options.inventoryReader(cwd, milestone, current) : discoverInventory(cwd, milestone, current);
  inventory.deferred_slices = failureProjection(cwd, milestone).filter(item => !item.entry).map(item => item.slice).filter(Boolean);
  return { ...selectNextUnit({ state: current, inventory, prefs: prefsResult.prefs }), id_kind };
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
function makeTransaction(cwd, input, action, unit, key, ownerToken, generation, hostRuntime, now) {
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
    const content = events.concat(record).map(item => JSON.stringify(item)).join('\n') + '\n';
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
  forgeState.updateFields(cwd, transaction.milestone, transaction.after.state_patch);
}

function runTransaction(cwd, transaction, ownerToken, generation, options) {
  const phases = new Set(PHASES);
  if (!phases.has(transaction.phase)) throw new ControllerError('invalid-request', `fase de transação desconhecida: ${transaction.phase}`);
  if (transaction.phase === 'committed') return { ok: true, reason: 'already-committed', transaction: publicTransaction(transaction, cwd) };
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
  return withMutex(cwd, 'unit-controller-transactions', () => beginInside(cwd, request, options));
}
function beginInside(cwd, request, options) {
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
  if (input.slice && input.slice !== effectiveSlice
    || input.slice && suppliedPatch.active_slice && input.slice !== suppliedPatch.active_slice) {
    throw new ControllerError('unit-identity-mismatch', 'slice declarada diverge do estado da unidade');
  }
  const availabilitySlice = unit.type === 'execute-task' ? (effectiveSlice === '—' ? null : effectiveSlice) : input.slice;
  assertUnitAvailable(cwd, input.milestone, unit, availabilitySlice, options);
  if (existing) return runTransaction(cwd, existing, ownerToken, input.generation, options);
  const otherPending = pendingTransactions(cwd);
  if (otherPending.length) throw new ControllerError('transaction-pending', 'recovery obrigatório antes de novo begin');
  preflightPaths(cwd, key, unit.key, input.milestone);
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
  const transaction = makeTransaction(cwd, input, action, unit, key, ownerToken, generation, hostRuntime, nowOf(options));
  saveTransaction(cwd, transaction, nowOf(options), options);
  fail(options, 'after-intent');
  return runTransaction(cwd, transaction, ownerToken, generation, options);
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
function verifiedFailure(cwd, transaction) {
  if (!transaction?.terminal_failure || transaction.phase !== 'committed') return null;
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
    .map(item => verifiedFailure(cwd, item));
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
        || expected.owner_digest !== failure.owner_digest || expected.host_runtime !== failure.host_runtime
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
  const context = options.inspectAttempt({ cwd, begin: clone(begin), references: clone(failure || {}) });
  if (!context || typeof context.receipt_path !== 'string' || !context.request) throw new ControllerError('attempt-evidence-missing', 'receipt/pedido original ausente');
  const recovery = require('./forge-attempt-recovery.js');
  const terminalInspection = terminal && context.request.linked_begin_key
    ? recovery.inspectTerminalRequest(context.request, { ...options, ...terminal }) : null;
  const identity = terminalInspection?.identity || recovery.requestIdentity(recovery.canonicalRequest(context.request));
  if (`${identity.unit_type}/${identity.task_id || identity.slice_id || identity.milestone_id}` !== begin.unit.key
    || identity.milestone_id !== begin.milestone || identity.host !== begin.host_runtime
    || identity.slice_id && begin.after.state.active_slice !== identity.slice_id) {
    throw new ControllerError('attempt-identity-mismatch', 'pedido original não corresponde ao begin');
  }
  // Terminal data is not a dispatch binding. Without one the inspector keeps
  // writer_possible unknown, conservatively requiring every root reconciled.
  const inspection = recovery.inspectReceipt(context.receipt_path, { request: terminalInspection ? undefined : context.request, processProbe: options.processProbe });
  if (inspection.receipt.recovery_identity_sha256 && inspection.receipt.recovery_identity_sha256 !== require('./forge-code-roots').digest(identity)
    || inspection.receipt.fingerprint && inspection.receipt.fingerprint !== (terminalInspection?.fingerprint || require('./forge-unit-sidecar').artifactFingerprint(context.request))) {
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
  if (events.slice(index + 1).some(item => item.unit === begin.unit.key && item.idempotency_key !== terminalKey
    && ['complete', 'fail', 'pause', 'expired-safe', 'persist-result'].includes(item.action))
    || discoverRecords(cwd, 'transaction').some(item => item.unit.key === begin.unit.key && item.milestone === begin.milestone
      && item.lease_generation === begin.lease_generation && item.idempotency_key !== terminalKey
      && ['complete', 'fail', 'pause', 'expired-safe', 'persist-result'].includes(item.action))) {
    throw new ControllerError('terminal-conflict', 'unidade já possui transição terminal');
  }
  if (pendingTransactions(cwd).some(item => item.idempotency_key !== terminalKey)) throw new ControllerError('transaction-pending', 'transação pendente impede consumo');
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
      || failure.owner_digest !== ownerDigest(input.owner_token)
      || failure.host_runtime !== forgeRuntime.normalizeHostRuntime(input.host_runtime)) throw new ControllerError('entry-failure-mismatch', 'falha consumida não corresponde à entrada');
    failureAncestors(cwd, failure.idempotency_key);
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
      if (failureProjection(cwd, input.milestone).some(item => item.transaction.idempotency_key === failure.idempotency_key && item.entry)) throw new ControllerError('entry-conflict', 'falha já possui entrada');
      const concurrent = discoverRecords(cwd, 'transaction').some(item => item.milestone === input.milestone && item.action === 'begin'
        && item.idempotency_key !== failure.terminal_failure.begin_key && forgeLease.observe(cwd, item.unit.key).lease);
      if (concurrent) throw new ControllerError('lease-active', 'outra unidade operacional permanece ativa');
      const observation = forgeLease.observe(cwd, failure.unit.key);
      if (!observation.ok || observation.lease) throw new ControllerError('lease-active', 'reentrada exige lease ausente e íntegra');
      const acquired = forgeLease.acquire(cwd, failure.unit.key, { ownerToken: input.owner_token, hostRuntime: linked.host_runtime, requestId: key, now: options.now });
      if (!acquired.ok) throw new ControllerError('lease-active', 'lease concorrente');
      try {
        existing = makeTransaction(cwd, { milestone: failure.milestone, state_patch: { active_slice: failure.terminal_failure.slice || '—' } },
          'begin', failure.unit, key, input.owner_token, acquired.generation, linked.host_runtime, nowOf(options));
        existing.linked_entry = linked; saveTransaction(cwd, existing, nowOf(options), options);
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
  const live = entryScope(cwd, { owner_token: ownerToken, host_runtime: linked.host_runtime,
    entry: { entry_id: linked.entry_id, authorization_ref: linked.authorization_ref } }, failure, options);
  if (sha(live) !== sha(linked)) throw new ControllerError('entry-conflict', 'entrada mudou desde autorização');
  const questions = currentEntryQuestions(cwd, failure, options);
  assertQuestionsResolved(questions);
  return { entry_digest: linked.entry_digest, entry_id: linked.entry_id, begin_key: key, unit: begin.unit.key, roots: linked.roots, classification: 'new-unit', pending_questions: questions };
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

if (require.main === module) cliMain();

module.exports = {
  PROTOCOL_VERSION, BOUNDARY_KINDS, ACTIONS, PHASES, REASON_CODES, ControllerError,
  selectNextUnit, discoverInventory, select, begin, transition, persistResult,
  complete, pause, fail: failUnit, expireSafe, resume, handoff,
  pendingTransactions, projectLogicalHistory, logicalState, resolvePrefs,
  transactionDir, resultDir, boundaryDir, eventsFile, transactionFile,
  resultFile, boundaryFile, readEvents, readJson, writeAtomic,
  lookupRecord, preflightPaths,
  consumeFailure, reenter, failureProjection, validateLinkedEntry, validateTerminalLinkedEntry,
  dependencies: { forgeState, forgeRuns, forgePrefs, forgeRuntime, forgeIds, forgeLease },
};
