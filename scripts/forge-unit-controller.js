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
function transactionFile(cwd, key) { return path.join(transactionDir(cwd), `${encode(key)}.json`); }
function resultFile(cwd, key) { return path.join(resultDir(cwd), `${encode(key)}.json`); }
function boundaryFile(cwd, unit) { return path.join(boundaryDir(cwd), `${encode(forgeLease.normalizeUnitKey(unit))}.json`); }

function writeAtomic(file, value, raw) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const content = raw ? String(value) : `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(temporary, content, 'utf8');
  fs.renameSync(temporary, file);
}
function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new ControllerError('invalid-request', `registro JSON inválido: ${file}`, { cause: error.message }); }
}
function withMutex(cwd, name, fn) {
  const handle = forgeLock.acquireSync(cwd, name, { retries: 80, ttlMs: 10_000 });
  try { return fn(); } finally { handle.release(); }
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
  for (const slice of ordered) {
    if (!slice.plan_exists) return selected('plan-slice', slice.id, milestone, current, slice.id);
    if (!slice.research_exists && !skipSliceResearch) return selected('research-slice', slice.id, milestone, current, slice.id);
    const task = (slice.tasks || []).find(item => !item.checked);
    if (task) return selected('execute-task', task.id, milestone, current, slice.id);
    if (!slice.summary_exists) return selected('complete-slice', slice.id, milestone, current, slice.id);
  }
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
  return {
    roadmap_exists: !!roadmapFile,
    context_exists: !!firstExisting(milestoneDir, name => name.endsWith('-CONTEXT.md')),
    research_exists: !!firstExisting(milestoneDir, name => name.endsWith('-RESEARCH.md')),
    active_slice: current.active_slice && current.active_slice !== '—' ? current.active_slice : null,
    slices,
    milestone_complete: roadmapComplete && !!firstExisting(milestoneDir, name => name.endsWith('-SUMMARY.md')),
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
  const inventory = input.inventory || discoverInventory(cwd, milestone, current);
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
  const dir = transactionDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort().map(name => readJson(path.join(dir, name)))
    .filter(record => record && record.phase !== 'committed');
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

function saveTransaction(cwd, transaction, now) {
  transaction.updated_at = iso(now);
  writeAtomic(transactionFile(cwd, transaction.idempotency_key), transaction);
}
function setPhase(cwd, transaction, phase, options) {
  transaction.phase = phase;
  saveTransaction(cwd, transaction, nowOf(options));
  fail(options, `after-${phase}`);
}
function publishResult(cwd, record) {
  if (!record) return;
  const file = resultFile(cwd, record.idempotency_key);
  withMutex(cwd, `unit-controller-result-${sha(record.idempotency_key).slice(0, 32)}`, () => {
    const existing = readJson(file);
    if (existing && stableStringify(existing) !== stableStringify(record)) {
      throw new ControllerError('invalid-request', 'idempotency_key já aponta para resultado diferente');
    }
    if (!existing) writeAtomic(file, record);
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
  const file = boundaryFile(cwd, boundary.unit);
  withMutex(cwd, `unit-controller-boundary-${sha(boundary.unit).slice(0, 32)}`, () => {
    const current = readJson(file);
    if (current && current.idempotency_key !== boundary.idempotency_key && current.handoff_ready !== true) {
      throw new ControllerError('transaction-pending', `boundary anterior ainda não está pronta para ${boundary.unit}`);
    }
    writeAtomic(file, boundary);
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
  if (transaction.phase === 'committed') return { ok: true, reason: 'already-committed', transaction: publicTransaction(transaction) };
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
  return { ok: true, reason: 'transition-committed', transaction: publicTransaction(transaction) };
}
function publicTransaction(transaction) {
  return {
    protocol_version: transaction.protocol_version,
    idempotency_key: transaction.idempotency_key,
    action: transaction.action,
    unit: transaction.unit.key,
    milestone: transaction.milestone,
    host_runtime: transaction.host_runtime,
    phase: transaction.phase,
    result_ref: transaction.result ? path.basename(resultFile('', transaction.idempotency_key)) : null,
    boundary: transaction.boundary ? clone(transaction.boundary) : null,
  };
}

function begin(cwd, request, options) {
  const input = object(request, 'request');
  resolvePrefs(cwd, options); // loud-stop before selection, lease, or transaction files
  const selection = input.unit ? { ok: true, milestone: input.milestone, unit: unitFromRequest(input), slice: input.slice || null }
    : select(cwd, input, options);
  if (!selection.ok) return selection;
  const unit = selection.unit;
  const ownerToken = opaque(input.owner_token === undefined ? input.ownerToken : input.owner_token, 'owner_token', true);
  const hostRuntime = forgeRuntime.normalizeHostRuntime(input.host_runtime === undefined ? input.hostRuntime : input.host_runtime);
  const key = transactionKey(input, 'begin', unit);
  const existing = readJson(transactionFile(cwd, key));
  if (existing) return runTransaction(cwd, existing, ownerToken, input.generation, options);
  const otherPending = pendingTransactions(cwd);
  if (otherPending.length) throw new ControllerError('transaction-pending', 'recovery obrigatório antes de novo begin');
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
  const transaction = makeTransaction(cwd, input, 'begin', unit, key, ownerToken, acquired.generation, hostRuntime, nowOf(options));
  saveTransaction(cwd, transaction, nowOf(options));
  fail(options, 'after-intent');
  const output = runTransaction(cwd, transaction, ownerToken, acquired.generation, options);
  output.owner_token = ownerToken;
  output.generation = acquired.generation;
  return output;
}

function transition(cwd, request, options) {
  const input = object(request, 'request');
  resolvePrefs(cwd, options);
  const action = assertAction(input.action);
  if (action === 'begin') return begin(cwd, input, options);
  const unit = unitFromRequest(input);
  const ownerToken = opaque(input.owner_token === undefined ? input.ownerToken : input.owner_token, 'owner_token', true);
  const generation = opaque(input.generation, 'generation', true);
  const hostRuntime = forgeRuntime.normalizeHostRuntime(input.host_runtime === undefined ? input.hostRuntime : input.host_runtime);
  const key = transactionKey(input, action, unit);
  const existing = readJson(transactionFile(cwd, key));
  if (existing) return runTransaction(cwd, existing, ownerToken, generation, options);
  const otherPending = pendingTransactions(cwd);
  if (otherPending.length) throw new ControllerError('transaction-pending', 'recovery obrigatório antes de nova transição');
  assertLease(cwd, unit.key, ownerToken, generation);
  const transaction = makeTransaction(cwd, input, action, unit, key, ownerToken, generation, hostRuntime, nowOf(options));
  saveTransaction(cwd, transaction, nowOf(options));
  fail(options, 'after-intent');
  return runTransaction(cwd, transaction, ownerToken, generation, options);
}
function persistResult(cwd, request, options) { return transition(cwd, { ...request, action: 'persist-result' }, options); }
function complete(cwd, request, options) { return transition(cwd, { ...request, action: 'complete' }, options); }
function pause(cwd, request, options) { return transition(cwd, { ...request, action: 'pause' }, options); }
function failUnit(cwd, request, options) { return transition(cwd, { ...request, action: 'fail' }, options); }
function expireSafe(cwd, request, options) { return transition(cwd, { ...request, action: 'expired-safe' }, options); }

function resume(cwd, request, options) {
  const input = request || {};
  resolvePrefs(cwd, options);
  const records = input.idempotency_key
    ? [readJson(transactionFile(cwd, input.idempotency_key))].filter(Boolean)
    : pendingTransactions(cwd);
  const results = [];
  for (const record of records) {
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
  const boundary = readJson(boundaryFile(cwd, unit.key));
  if (!boundary) throw new ControllerError('boundary-missing', `boundary ausente para ${unit.key}`);
  if (!BOUNDARY_KINDS.includes(boundary.kind) || boundary.handoff_ready !== true || !boundary.committed_at) {
    throw new ControllerError('boundary-not-transferable', `boundary não transferível: ${boundary.kind || 'unknown'}`);
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
  const results = fs.existsSync(resultDir(cwd)) ? fs.readdirSync(resultDir(cwd)).filter(name => name.endsWith('.json')).sort()
    .map(name => readJson(path.join(resultDir(cwd), name))).filter(item => item.milestone === milestone)
    .map(item => { const copy = { ...item }; delete copy.committed_at; return copy; }) : [];
  return { state: logicalState(state), events, results };
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
  dependencies: { forgeState, forgeRuns, forgePrefs, forgeRuntime, forgeIds, forgeLease },
};
