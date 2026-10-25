#!/usr/bin/env node
'use strict';

// Persistent authorization for one Forge unit.  A forge-lock mutex only
// serializes the short read/change/publish critical section; this file is the
// durable authority to execute the unit.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mutex = require('./forge-lock.js');
const { normalizeHostRuntime } = require('./forge-runtime.js');
const { MAX_PROTECTED_WINDOW_MS } = require('./forge-worker-timeout.js');

const PROTOCOL_VERSION = '1.0.0';
const DEFAULT_TTL_MS = 30_000;
const DEFAULT_GRACE_MS = 5_000;
const REASON_CODES = Object.freeze([
  'acquired', 'already-acquired', 'lease-active', 'owner-mismatch',
  'renewed', 'released', 'already-released', 'expired-awaiting-grace',
  'recovered', 'contended-recovery', 'invalid-request', 'guard-busy',
]);

function own(value, key) { return Object.prototype.hasOwnProperty.call(value || {}, key); }
function nowOf(options) { return options && typeof options.now === 'function' ? options.now() : Date.now(); }
function tokenOf(options) { return options && typeof options.tokenFactory === 'function' ? options.tokenFactory() : crypto.randomUUID().replace(/-/g, ''); }
function fail(options, point) {
  if (options && typeof options.failpoint === 'function' && options.failpoint(point)) {
    const error = new Error(`forge-unit-lease: failpoint ${point}`); error.code = 'LEASE_FAILPOINT'; throw error;
  }
}
function positive(value, fallback, label) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`forge-unit-lease: ${label} deve ser positivo`);
  return Math.floor(number);
}
function opaque(value, label, required) {
  if ((value === undefined || value === null || value === '') && !required) return null;
  if (typeof value !== 'string' || value.trim() === '' || value.length > (label === 'request_id' ? 2048 : 1024) || value.includes('\u0000')) {
    throw new Error(`forge-unit-lease: ${label} inválido`);
  }
  return value;
}
function encode(value) { return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function digest(value) { return crypto.createHash('sha256').update(value, 'utf8').digest('hex'); }

// Unit keys are logical identifiers, never filesystem paths. NFC keeps the
// serialized identity stable when a Windows, macOS or Linux host sees Unicode.
function normalizeUnitKey(unit) {
  let value;
  if (typeof unit === 'string') value = unit;
  else if (unit && typeof unit === 'object') {
    const type = opaque(unit.type, 'unit.type', true);
    const id = opaque(unit.id, 'unit.id', true);
    value = `${type}/${id}`;
  } else throw new Error('forge-unit-lease: unit inválida');
  value = value.normalize('NFC').trim();
  if (!value || value.length > 1024 || value.includes('\u0000')) throw new Error('forge-unit-lease: unit inválida');
  return value;
}
function leasesDir(cwd) { return path.join(cwd, '.gsd', 'forge', 'leases'); }
// A digest, rather than case-sensitive base64url, is the physical identity.
// Windows and default macOS filesystems may fold filename case, so two unit
// keys that differ only by an encoded character must never share a record.
function leaseFile(cwd, unit) { return path.join(leasesDir(cwd), `${digest(normalizeUnitKey(unit))}.json`); }
function mutexName(unit) { return `unit-lease-${digest(normalizeUnitKey(unit)).slice(0, 48)}`; }
function temporaryPrefix(file) { return `.${path.basename(file)}.`; }

function readLease(file) {
  if (!fs.existsSync(file)) return { record: null, corrupt: false };
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!record || typeof record !== 'object') throw new Error('not object');
    return { record, corrupt: false };
  } catch { return { record: null, corrupt: true }; }
}
function clearTemporaryFiles(file) {
  const dir = path.dirname(file); if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(temporaryPrefix(file)) && name.endsWith('.tmp')) {
      try { fs.unlinkSync(path.join(dir, name)); } catch { /* next recovery retries */ }
    }
  }
}
function quarantine(file, label) {
  const target = `${file}.${label}-${crypto.randomUUID()}`;
  try { fs.renameSync(file, target); return target; } catch { return null; }
}
function removeQuarantine(file) { try { fs.unlinkSync(file); } catch { /* diagnostic debris is harmless */ } }
function publish(file, record, options, guard) {
  const temporary = path.join(path.dirname(file), `${temporaryPrefix(file)}${process.pid}.${crypto.randomUUID()}.tmp`);
  if (guard && !mutex.assertOwned(guard)) throw Object.assign(new Error('forge-unit-lease: guard perdido'), { code: 'GUARD_LOST' });
  fail(options, 'before-write');
  fs.writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', 'utf8');
  fail(options, 'after-write-before-rename');
  if (guard && !mutex.assertOwned(guard)) {
    try { fs.unlinkSync(temporary); } catch { /* next recovery cleans it */ }
    throw Object.assign(new Error('forge-unit-lease: guard perdido'), { code: 'GUARD_LOST' });
  }
  fs.renameSync(temporary, file);
  fail(options, 'after-rename');
}
function sameOwner(record, ownerToken, generation) {
  return !!record && record.owner_token === ownerToken && record.generation === generation;
}
function expiration(record) { return Number(record && record.expires_at); }
function grace(record) { return Number(record && record.grace_ms); }
function isPastGrace(record, now) { return Number.isFinite(expiration(record)) && Number.isFinite(grace(record)) && now > expiration(record) + grace(record); }
// Expiry is inclusive for observation; recovery remains strictly past the
// expiry-plus-grace boundary so a lease at the exact grace edge is retained.
function isExpired(record, now) { return Number.isFinite(expiration(record)) && now >= expiration(record); }
function publicLease(record, now) {
  if (!record) return null;
  return {
    protocol_version: record.protocol_version,
    unit: record.unit,
    generation: record.generation,
    owner: 'redacted',
    host_runtime: record.host_runtime,
    session: record.session,
    acquired_at: record.acquired_at,
    heartbeat_at: record.heartbeat_at,
    expires_at: record.expires_at,
    grace_ms: record.grace_ms,
    expired: isExpired(record, now),
    recoverable: isPastGrace(record, now),
  };
}
function validRecord(record, unit) {
  return !!record && record.protocol_version === PROTOCOL_VERSION && record.unit === unit &&
    typeof record.owner_token === 'string' && typeof record.generation === 'string' &&
    Number.isFinite(record.acquired_at) && Number.isFinite(record.heartbeat_at) &&
    Number.isFinite(record.expires_at) && Number.isFinite(record.grace_ms);
}
function result(ok, reason, extra) { return Object.assign({ ok, reason }, extra || {}); }
function withGuard(cwd, unit, fn, guardOptions) {
  let handle;
  guardOptions = guardOptions || {};
  try { handle = mutex.acquireProcessSync(cwd, mutexName(unit), { ttlMs: 5_000, retries: 20, backoffMin: 10, backoffMax: 20 }); }
  catch (error) { if (error.code === 'LOCK_BUSY') return result(false, 'guard-busy'); throw error; }
  let output; let thrown;
  try { output = fn(handle); } catch (error) { thrown = error; }
  const released = handle.release();
  if (thrown) throw thrown;
  if (!released.ok) return result(false, 'guard-busy');
  return output;
}
function normalizedOptions(options) {
  const input = options || {};
  if (input.session === '') throw new Error('forge-unit-lease: session inválido');
  const host_runtime = normalizeHostRuntime(input.hostRuntime === undefined ? input.host_runtime : input.hostRuntime);
  return {
    ttlMs: positive(input.ttlMs === undefined ? input.ttl_ms : input.ttlMs, DEFAULT_TTL_MS, 'ttl'),
    graceMs: positive(input.graceMs === undefined ? input.grace_ms : input.graceMs, DEFAULT_GRACE_MS, 'grace'),
    host_runtime,
    session: opaque(input.session, 'session', false),
    requestId: opaque(input.requestId === undefined ? input.request_id : input.requestId, 'request_id', false),
    ownerToken: opaque(input.ownerToken === undefined ? input.owner_token : input.ownerToken, 'owner_token', false),
    now: nowOf(input),
    raw: input,
  };
}
function makeRecord(unit, values) {
  return {
    protocol_version: PROTOCOL_VERSION,
    unit,
    owner_token: values.ownerToken,
    host_runtime: values.host_runtime,
    session: values.session,
    request_id: values.requestId,
    generation: values.generation,
    acquired_at: values.now,
    heartbeat_at: values.now,
    expires_at: values.now + values.ttlMs,
    grace_ms: values.graceMs,
  };
}
function recoverInside(file, unit, now) {
  const read = readLease(file);
  if (read.corrupt) {
    const saved = quarantine(file, 'corrupt');
    return saved ? result(true, 'recovered', { previous: null, recovered_corrupt: true }) : result(false, 'contended-recovery');
  }
  if (!read.record) return result(true, 'already-released');
  if (!validRecord(read.record, unit)) {
    const saved = quarantine(file, 'invalid');
    return saved ? result(true, 'recovered', { previous: null, recovered_corrupt: true }) : result(false, 'contended-recovery');
  }
  if (!isPastGrace(read.record, now)) {
    return result(false, isExpired(read.record, now) ? 'expired-awaiting-grace' : 'lease-active', { lease: publicLease(read.record, now) });
  }
  const saved = quarantine(file, `expired-${read.record.generation}`);
  if (!saved) return result(false, 'contended-recovery', { lease: publicLease(read.record, now) });
  removeQuarantine(saved);
  return result(true, 'recovered', { previous: publicLease(read.record, now) });
}

function acquire(cwd, unitInput, options) {
  const unit = normalizeUnitKey(unitInput); const values = normalizedOptions(options); const file = leaseFile(cwd, unit);
  fs.mkdirSync(leasesDir(cwd), { recursive: true });
  return withGuard(cwd, unit, guard => {
    clearTemporaryFiles(file);
    let read = readLease(file);
    if (read.record && validRecord(read.record, unit) && sameOwner(read.record, values.ownerToken, read.record.generation)) {
      if (!values.requestId || !read.record.request_id || values.requestId === read.record.request_id) {
        return result(true, 'already-acquired', { owner_token: read.record.owner_token, generation: read.record.generation, lease: publicLease(read.record, values.now) });
      }
    }
    let recovered = null;
    if (read.record || read.corrupt) {
      if (read.record && validRecord(read.record, unit) && !isPastGrace(read.record, values.now)) {
        return result(false, isExpired(read.record, values.now) ? 'expired-awaiting-grace' : 'lease-active', { lease: publicLease(read.record, values.now) });
      }
      const recovery = recoverInside(file, unit, values.now);
      if (!recovery.ok && recovery.reason !== 'already-released') return recovery;
      recovered = recovery.reason === 'recovered' ? recovery.previous || null : null;
      read = readLease(file);
      if (read.record) return result(false, 'contended-recovery', { lease: publicLease(read.record, values.now) });
    }
    const ownerToken = values.ownerToken || tokenOf(values.raw);
    const generation = tokenOf(values.raw);
    if (!ownerToken || !generation || ownerToken === generation) throw new Error('forge-unit-lease: token inválido');
    const record = makeRecord(unit, { ...values, ownerToken, generation });
    publish(file, record, values.raw, guard);
    return result(true, 'acquired', { owner_token: ownerToken, generation, lease: publicLease(record, values.now), recovered });
  });
}

function observe(cwd, unitInput, options) {
  const unit = normalizeUnitKey(unitInput); const now = nowOf(options || {}); const file = leaseFile(cwd, unit); const read = readLease(file);
  if (read.corrupt) return result(false, 'contended-recovery', { unit, corrupt: true });
  if (!read.record) return result(true, 'already-released', { unit, lease: null });
  if (!validRecord(read.record, unit)) return result(false, 'contended-recovery', { unit, corrupt: true });
  return result(true, isPastGrace(read.record, now) ? 'recovered' : isExpired(read.record, now) ? 'expired-awaiting-grace' : 'lease-active', { unit, lease: publicLease(read.record, now) });
}

function heartbeat(cwd, unitInput, ownerToken, generation, options) {
  const unit = normalizeUnitKey(unitInput); const values = normalizedOptions(options); const token = opaque(ownerToken, 'owner_token', true); const gen = opaque(generation, 'generation', true); const file = leaseFile(cwd, unit);
  return withGuard(cwd, unit, guard => {
    clearTemporaryFiles(file); const read = readLease(file);
    if (!read.record) return result(false, 'already-released');
    if (!validRecord(read.record, unit) || !sameOwner(read.record, token, gen)) return result(false, 'owner-mismatch');
    const next = { ...read.record, heartbeat_at: values.now, expires_at: values.now + values.ttlMs, grace_ms: values.graceMs };
    publish(file, next, values.raw, guard);
    return result(true, 'renewed', { generation: gen, lease: publicLease(next, values.now) });
  });
}

function release(cwd, unitInput, ownerToken, generation, options) {
  const unit = normalizeUnitKey(unitInput); const token = opaque(ownerToken, 'owner_token', true); const gen = opaque(generation, 'generation', true); const file = leaseFile(cwd, unit);
  return withGuard(cwd, unit, () => {
    const read = readLease(file);
    if (!read.record) return result(true, 'already-released');
    if (!validRecord(read.record, unit) || !sameOwner(read.record, token, gen)) return result(false, 'owner-mismatch');
    if (options && own(options, 'requestId') && read.record.request_id !== options.requestId) return result(false, 'owner-mismatch');
    const saved = quarantine(file, `released-${gen}`);
    if (!saved) return result(false, 'contended-recovery');
    removeQuarantine(saved); clearTemporaryFiles(file);
    return result(true, 'released', { generation: gen });
  });
}

// A terminal reconciliation holds the same mutex as *every* lease mutator.
// Handles are process-local capabilities, scoped to a synchronous callback;
// serialization, expiry and PID observations cannot recreate one.
const terminalGuards = new WeakMap();
function assertTerminalGuard(handle, cwd, unitInput) {
  const held = terminalGuards.get(handle);
  if (!held || held.cwd !== fs.realpathSync.native(cwd) || held.unit !== normalizeUnitKey(unitInput) || !mutex.assertOwned(held.guard)) {
    throw Object.assign(new Error('forge-unit-lease: terminal-guard-invalid'), { code: 'GUARD_LOST' });
  }
  return held;
}
function inspectTerminal(handle, cwd, unitInput, ownerToken, generation) {
  const held = assertTerminalGuard(handle, cwd, unitInput), read = readLease(leaseFile(cwd, held.unit));
  if (read.corrupt || (read.record && !validRecord(read.record, held.unit))) return result(false, 'lease-corrupt');
  if (!read.record) return result(true, 'lease-absent', { present: false });
  if (!sameOwner(read.record, ownerToken, generation)) return result(false, 'owner-mismatch');
  return result(true, 'lease-matching', { present: true, generation });
}
function releaseTerminal(handle, cwd, unitInput, ownerToken, generation) {
  const held = assertTerminalGuard(handle, cwd, unitInput);
  const checked = inspectTerminal(handle, cwd, unitInput, ownerToken, generation);
  if (!checked.ok || !checked.present) return checked;
  const saved = quarantine(leaseFile(cwd, held.unit), `released-${generation}`);
  if (!saved) return result(false, 'contended-recovery');
  removeQuarantine(saved);
  return result(true, 'released', { generation });
}
function withTerminalGuard(cwd, unitInput, callback) {
  const unit = normalizeUnitKey(unitInput);
  return withGuard(cwd, unit, guard => {
    const handle = Object.freeze({});
    terminalGuards.set(handle, { cwd: fs.realpathSync.native(cwd), unit, guard });
    try { return callback(handle); } finally { terminalGuards.delete(handle); }
  });
}

// The parent must route its own scheduled heartbeat through this process-local
// handle while protected snapshots are in use. Other processes remain subject
// to ordinary ownership checks; this is coordination, not a global lock.
const protectedWindows = new WeakMap();
function assertProtectedWindow(handle, cwd, unit) {
  const held = protectedWindows.get(handle);
  if (!held || path.relative(held.cwd, fs.realpathSync.native(cwd)) !== '' || normalizeUnitKey(unit) !== held.unit || !held.check().ok) {
    throw new Error('forge-unit-lease: protected-window-invalid');
  }
  return { generation: held.generation, deadline_at: held.deadline_at };
}
function openProtectedWindow(cwd, unitInput, ownerToken, generation, options = {}) {
  const duration = options.durationMs;
  // The bound follows the largest tier safety ceiling plus grace (forge-worker-timeout.js),
  // so the owner window can cover the whole execute phase instead of a 5 min cap.
  // Cost: an owner that dies inside the window holds the lease until its deadline
  // (up to ~91 min on tier max); the exit stays explicit: forge-unit-lease --recover.
  if (!Number.isInteger(duration) || duration <= 0 || duration > MAX_PROTECTED_WINDOW_MS) throw new Error('forge-unit-lease: invalid protected duration');
  const unit = normalizeUnitKey(unitInput), file = leaseFile(cwd, unit);
  const token = opaque(ownerToken, 'owner_token', true), gen = opaque(generation, 'generation', true);
  const opened = withGuard(cwd, unit, guard => {
    const now = nowOf(options), deadline = now + duration;
    const read = readLease(file);
    if (!validRecord(read.record, unit) || !sameOwner(read.record, token, gen)) return result(false, 'owner-mismatch');
    if (isExpired(read.record, now)) return result(false, 'expired-awaiting-grace');
    const next = { ...read.record, heartbeat_at: now, expires_at: Math.max(read.record.expires_at, deadline) };
    publish(file, next, options, guard);
    return result(true, 'renewed', { generation: gen, deadline_at: deadline });
  });
  if (!opened.ok) return opened;
  let closed = false;
  const check = () => {
    const time = nowOf(options), read = readLease(file);
    if (closed || time >= opened.deadline_at || !validRecord(read.record, unit) || !sameOwner(read.record, token, gen)
        || isExpired(read.record, time)) return result(false, 'owner-mismatch');
    return result(true, 'lease-active', { generation: gen });
  };
  const handle = Object.freeze({ ...opened, check,
    heartbeat: check,
    close() { const checked = check(); closed = true; return checked; },
  });
  protectedWindows.set(handle, { cwd: fs.realpathSync.native(cwd), unit, generation: gen, deadline_at: opened.deadline_at, check });
  return handle;
}

function recover(cwd, unitInput, options) {
  const unit = normalizeUnitKey(unitInput); const now = nowOf(options || {}); const file = leaseFile(cwd, unit);
  fs.mkdirSync(leasesDir(cwd), { recursive: true });
  // Process death, never TTL, authorizes reclaiming this short mutex.
  return withGuard(cwd, unit, guard => { clearTemporaryFiles(file); return recoverInside(file, unit, now); }, { allowStaleRecovery: true });
}

function parseArgs(argv) { const args = {}; for (let index = 0; index < argv.length; index++) if (argv[index].startsWith('--')) { const key = argv[index].slice(2); const value = argv[index + 1]; args[key] = value && !value.startsWith('--') ? (index++, value) : true; } return args; }
function cliOptions(args) { return { ttlMs: args.ttl && Number(args.ttl), graceMs: args.grace && Number(args.grace), hostRuntime: args.host, session: args.session, requestId: args.request, ownerToken: args.token }; }
function cliMain() {
  const args = parseArgs(process.argv.slice(2)); const cwd = args.cwd || process.cwd(); const unit = args.unit;
  try {
    let output;
    if (args.acquire) output = acquire(cwd, args.acquire, cliOptions(args));
    else if (args.observe) output = observe(cwd, args.observe);
    else if (args.heartbeat) output = heartbeat(cwd, args.heartbeat, args.token, args.generation, cliOptions(args));
    else if (args.release) output = release(cwd, args.release, args.token, args.generation);
    else if (args.recover) output = recover(cwd, args.recover);
    else throw new Error('forge-unit-lease: comando inválido');
    process.stdout.write(JSON.stringify(output) + '\n'); if (!output.ok) process.exitCode = 1;
  } catch (error) { process.stderr.write(`forge-unit-lease error: ${error.message}\n`); process.exitCode = 2; }
}
if (require.main === module) cliMain();

/*
 * Public API contract
 * -------------------
 *
 * acquire(cwd, unit, options)
 *   Creates a durable generation or returns a stable denial. `unit` may be a
 *   normalized string or `{ type, id }`. The successful caller receives the
 *   owner token because it is the credential required for future lifecycle
 *   operations. A competing caller receives only a redacted public lease.
 *
 * observe(cwd, unit, options)
 *   Is intentionally read-only. It may report that a lease is recoverable,
 *   but it cannot make the recovery decision or publish a new owner. This is
 *   safe for dashboards, handoff preflight, and another host's diagnostics.
 *
 * heartbeat(cwd, unit, ownerToken, generation, options)
 *   Extends expiry only after an exact token-and-generation comparison under
 *   the per-unit mutex. The host option is normalized at the input boundary
 *   but never changes the host metadata captured by the acquiring owner.
 *
 * release(cwd, unit, ownerToken, generation)
 *   Removes only an exact active generation. Repeating a successful release
 *   is harmless; a token from an older generation can never remove a later
 *   successor because the complete record is compared while the mutex is held.
 *
 * recover(cwd, unit, options)
 *   Is the only operation that deletes a non-owner record. Its injected clock
 *   must be beyond expiry plus grace. The implementation intentionally never
 *   asks whether a PID exists or whether a run registry row looks current.
 *
 * Options use camelCase in JavaScript and accept their persisted snake_case
 * aliases at the boundary (`ttlMs`/`ttl_ms`, `graceMs`/`grace_ms`, and so on).
 * `now` is injectable for deterministic callers and tests. `failpoint` is a
 * test-only hook whose named boundaries prove that a durable write publishes
 * either the old complete record or the new complete record, never fragments.
 *
 * This module has no scheduler, workflow transition, event, outcome, model,
 * provider CLI, process-liveness, or arbitrary-file-lock responsibility. T04
 * consumes the lease result to make workflow decisions; this module remains a
 * small cross-platform persistence and authorization primitive.
 *
 * Consumers should retain the returned generation beside the owner token. A
 * token by itself is intentionally insufficient for heartbeat and release:
 * the generation makes an old callback fail after expiry recovery and guards
 * against an ABA-shaped lease replacement. Public metadata can help an
 * operator diagnose the state, but must never be copied into an authorization
 * request as a substitute for those two private credentials.
 */
module.exports = {
  PROTOCOL_VERSION, DEFAULT_TTL_MS, DEFAULT_GRACE_MS, REASON_CODES,
  normalizeUnitKey, leasesDir, leaseFile, mutexName, acquire, observe,
  heartbeat, release, recover, publicLease, validRecord, readLease, openProtectedWindow, assertProtectedWindow,
  withTerminalGuard, assertTerminalGuard, inspectTerminal, releaseTerminal,
};
