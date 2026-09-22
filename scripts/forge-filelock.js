#!/usr/bin/env node
'use strict';

// File locks are defence-in-depth for shared worktrees, not unit leases.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mutex = require('./forge-lock.js');
const DEFAULT_TTL_MS = 60_000;
const PROTOCOL = 'forge-filelock-v2';
// 72-byte basename; temporary/recovery suffixes stay below 160 bytes.
const LOCK_BASENAME_MAX = 160;
let runs = null;
try { runs = require('./forge-runs.js'); } catch { /* optional diagnostic */ }

function locksDir(cwd) { return path.join(cwd, '.gsd', 'forge', 'file-locks'); }
function encodePath(value) { return Buffer.from(String(value), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function canonicalPath(cwd, filePath) {
  validatePath(filePath);
  // Forge plans and state use POSIX separators on every platform. Treat both
  // spellings as separators before resolving so `src/foo.js` and
  // `src\\foo.js` cannot acquire different locks on macOS/Linux.
  const portable = String(filePath).normalize('NFC').replace(/[\\/]/g, path.sep);
  const normalized = path.normalize(path.resolve(cwd, portable)).normalize('NFC');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
function lockPathFor(cwd, filePath) { const canonical = canonicalPath(cwd, filePath); return path.join(locksDir(cwd), `v2-${crypto.createHash('sha256').update(canonical).digest('hex')}.json`); }
function validatePath(filePath) { if (!filePath || String(filePath).length > 4096) throw new Error('forge-filelock: path inválido'); }
function positive(value, fallback) { const n = value === undefined ? fallback : Number(value); if (!Number.isFinite(n) || n <= 0) throw new Error('forge-filelock: ttl deve ser positivo'); return n; }
function nowOf(opts) { return opts && typeof opts.now === 'function' ? opts.now() : Date.now(); }
function newToken(opts) { return opts && typeof opts.tokenFactory === 'function' ? opts.tokenFactory() : crypto.randomUUID().replace(/-/g, ''); }
function readLock(file, canonical) {
  let content;
  try { content = fs.readFileSync(file, 'utf8'); }
  catch (error) { return error.code === 'ENOENT' ? { state: 'absent' } : { state: 'unreadable', reason: 'lock_read_failed', errno: error.code }; }
  let meta;
  try { meta = JSON.parse(content); }
  catch { return { state: 'unreadable', reason: 'lock_invalid_json' }; }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || meta.file_path !== canonical ||
      typeof meta.owner_token !== 'string' || !meta.owner_token || typeof meta.generation !== 'string' || !meta.generation ||
      !(meta.run_id === null || typeof meta.run_id === 'string') ||
      !(meta.session_id === null || typeof meta.session_id === 'string') ||
      !Number.isFinite(meta.acquired_at) || !Number.isFinite(meta.renewed_at) || !Number.isFinite(meta.ttl_ms) || meta.ttl_ms <= 0) {
    return { state: 'unreadable', reason: 'lock_invalid_metadata' };
  }
  return { state: 'present', metadata: meta };
}
function readLockState(cwd, canonical) {
  // Enumerate rather than stat an arbitrarily long legacy basename: on Windows
  // an invalid component can report ENOENT, which is not evidence of absence.
  const legacyName = `${encodePath(canonical)}.json`;
  try {
    if (fs.readdirSync(locksDir(cwd)).includes(legacyName)) return { state: 'unreadable', reason: 'legacy_lock_present', file: path.join(locksDir(cwd), legacyName) };
  } catch (error) {
    if (error.code !== 'ENOENT') return { state: 'unreadable', reason: 'lock_read_failed', errno: error.code };
  }
  const file = lockPathFor(cwd, canonical);
  return { ...readLock(file, canonical), file };
}
function assertGuard(guard) {
  if (!mutex.assertOwned(guard) || (guard.compatibility && !mutex.assertOwned(guard.compatibility))) {
    throw Object.assign(new Error('forge-filelock: guard ownership lost'), { code: 'GUARD_LOST' });
  }
}
function writeAtomic(file, meta, guard) { const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`; try { if (guard) assertGuard(guard); fs.writeFileSync(temporary, JSON.stringify(meta), 'utf8'); if (guard) assertGuard(guard); fs.renameSync(temporary, file); } catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; } }
function ageOf(meta, now) { return meta ? now - (meta.renewed_at || meta.acquired_at || 0) : null; }
// ── D8 (PR #110): the doctrine of this module, rewritten in the SAME commit that changed the
// behaviour. The losing comment used to read "A run/PID is never an authorization decision. It
// remains diagnostic only." It lost, and leaving the contradiction implicit was never a third
// option: `forge-claim-release.js` already refused to release a claim by age alone (its D2), so two
// modules carried two conscious, opposite assertions — which is exactly how this defect was born.
//
// THE DOCTRINE IS NOW SINGLE: **liveness beats the clock.** A LIVE holder never loses its lock, stale
// or not — a legitimate 40-minute worker is byte-for-byte indistinguishable from a dead one if only
// the clock is consulted. The clock is the NAMED LAST RESORT, and it applies only to holders measured
// `ended` or `unowned`. The crash recovery that the old age-steal provided is not deleted, it is
// MOVED and named: `scripts/forge-run-reaper.js` converts a crashed owner from live to ended, and
// only then does the clock reach it. See `shared/forge-claim-gate.md § Release lifecycle`.
//
// Tri-state, in the mould of `forge-claim-audit.classifyActivity` — the form is copied, not
// reinvented. `unmeasured` is never collapsed into "dead": a question that could not be asked keeps
// the lock (the repo's own credo, applied here).
//
// `unowned` exists by MEASUREMENT, not by symmetry: `forge-filelock.js` writes `runId || null`, so a
// legacy lock with `run_id: null` has no owner to ask about. Without this state it would be
// PERMANENTLY unbreakable — a fail-closed that freezes instead of protecting.
const HOLDER_ACTIVITY = ['live', 'ended', 'unowned', 'unmeasured'];
const HOLDER_REASONS = [
  'registry-active',     // live      — measured
  'registry-inactive',   // ended     — measured
  'run-not-registered',  // ended     — no record on disk: plausibly dead, the only honest case
  'run-id-absent',       // unowned   — nobody to ask about; age alone never governed this lock
  'registry-unavailable',// unmeasured — the runs module itself is missing
  'record-unreadable',   // unmeasured — truncated/illegible record (the SAME datum as listAllDetailed's `unparseable`)
  'active-field-absent', // unmeasured — record present, `active` never written
];
function classifyHolder(cwd, runId) {
  if (!runId) return { activity: 'unowned', reason: 'run-id-absent' };
  if (!runs) return { activity: 'unmeasured', reason: 'registry-unavailable' };
  let run;
  try {
    run = runs.get(cwd, runId);
  } catch (_) {
    return { activity: 'unmeasured', reason: 'record-unreadable' };
  }
  if (!run) {
    // `runs.get` swallows its own read/parse failure into `null`, so "absent" and "illegible" arrive
    // here identical. They are NOT the same fact and must not collapse: absent is plausibly dead,
    // illegible is unmeasured. The file's existence on disk is what separates them.
    let present = false;
    try { present = Boolean(runs.runFile) && fs.existsSync(runs.runFile(cwd, runId)); } catch (_) { present = false; }
    return present
      ? { activity: 'unmeasured', reason: 'record-unreadable' }
      : { activity: 'ended', reason: 'run-not-registered' };
  }
  if (run.active === true) return { activity: 'live', reason: 'registry-active' };
  if (run.active === false) return { activity: 'ended', reason: 'registry-inactive' };
  return { activity: 'unmeasured', reason: 'active-field-absent' };
}
// Kept exported and UNCHANGED in semantics — `forge-claim-release.js:232` and the diagnostic uses
// depend on it. `classifyHolder` is the ADDITIVE export.
function isHolderRunActive(cwd, runId) { return classifyHolder(cwd, runId).activity === 'live'; }
// Keep this name byte-identical to v1: it is the shared compatibility authority.
function guardName(filePath) { return `filelock-${crypto.createHash('sha256').update(String(filePath), 'utf8').digest('hex')}`; }
function withGuard(cwd, filePath, fn) {
  const name = guardName(filePath);
  const guard = mutex.tryAcquireSync(cwd, `${name}-v2`, { ttlMs: 5_000 });
  if (!guard) return { acquired: false, reason: 'guard_busy', holder: null };
  let compatibility;
  let outcome;
  let operationError;
  try {
    // Older writers know only this mutex and the base64 filename. Hold their
    // mutex for the ENTIRE hashed-lock lifetime, including crashes. Its finite
    // but effectively unbounded TTL prevents the old 5s stale-recovery path.
    const status = mutex.status(cwd, name);
    if (status.held && !status.metadata) return { acquired: false, reason: 'guard_incomplete', holder: null };
    if (status.held && status.metadata && status.metadata.holder_run_id === PROTOCOL && status.metadata.ttl_ms === Number.MAX_SAFE_INTEGER) {
      compatibility = { lockDir: mutex.lockPath(cwd, name), ownerToken: status.metadata.owner_token, generation: status.metadata.generation };
      if (!mutex.assertOwned(compatibility)) return { acquired: false, reason: 'guard_unreadable', holder: null };
    } else {
      compatibility = mutex.tryAcquireSync(cwd, name, { ttlMs: Number.MAX_SAFE_INTEGER, holderRunId: PROTOCOL, allowStaleRecovery: false });
      if (!compatibility) return { acquired: false, reason: 'guard_busy', holder: null };
    }
    guard.compatibility = compatibility;
    outcome = fn(guard);
    return outcome;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    // Only a proven absence permits the old protocol to run again. Corruption
    // and read failures retain the fence until explicit evidence-preserving recovery.
    let released;
    if (compatibility && readLock(lockPathFor(cwd, filePath), filePath).state === 'absent') released = mutex.releaseHandle(compatibility);
    const operationReleased = guard.release();
    if ((released && !released.ok) || !operationReleased.ok) {
      const failure = { compatibility: released || null, operation: operationReleased };
      if (operationError) operationError.guard_release_failure = failure;
      else if (outcome && (outcome.ok === false || outcome.acquired === false)) outcome.guard_release_failure = failure;
      else throw Object.assign(new Error('forge-filelock: file mutation may have completed but guard release failed; stop writers and use --recover --confirm-stopped'), { code: 'GUARD_RELEASE_FAILED', guard_release_failure: failure });
    }
  }
}
function publicHolder(existing, now) { return { run_id: existing.run_id, session_id: existing.session_id, file_path: existing.file_path, acquired_at: existing.acquired_at, age_ms: ageOf(existing, now) }; }

function acquireFileLock(cwd, filePath, runId, sessionId, opts) {
  opts = opts || {}; const canonical = canonicalPath(cwd, filePath); const ttlMs = positive(opts.ttlMs, DEFAULT_TTL_MS); const now = nowOf(opts); const file = lockPathFor(cwd, canonical);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withGuard(cwd, canonical, (guard) => {
    const state = readLockState(cwd, canonical);
    if (state.state === 'unreadable') return { acquired: false, reason: state.reason, errno: state.errno, holder: null };
    const existing = state.metadata;
    if (existing && existing.owner_token === opts.ownerToken && opts.ownerToken) {
      const renewed = { ...existing, renewed_at: now, ttl_ms: ttlMs, session_id: sessionId || existing.session_id, intent: opts.intent || existing.intent };
      writeAtomic(file, renewed, guard); return { acquired: true, renewed: true, holder: null, owner_token: renewed.owner_token, generation: renewed.generation, release: () => releaseFileLock(cwd, filePath, runId, renewed.owner_token, renewed.generation) };
    }
    if (existing) {
      const age = ageOf(existing, now); const ownerTtl = positive(existing.ttl_ms, ttlMs); const stale = age !== null && age > ownerTtl;
      // Liveness authorizes recovery: age is only the named final fallback for ended/unowned holders; the reaper converts crashed owners.
      const classified = classifyHolder(cwd, existing.run_id);
      const diagnostic = classified.activity === 'live' ? 'active-run' : classified.activity;
      if (classified.activity === 'live' || !stale) return { acquired: false, reason: 'busy', holder: { ...publicHolder(existing, now), run_diagnostic: diagnostic } };
      if (classified.activity === 'unmeasured') return { acquired: false, reason: 'holder_unmeasured', holder: { ...publicHolder(existing, now), run_diagnostic: 'unmeasured' } };
      const quarantine = `${file}.quarantine-${crypto.randomUUID()}`;
      try { assertGuard(guard); fs.renameSync(file, quarantine); } catch { return { acquired: false, reason: 'contended_recovery', holder: publicHolder(existing, now) }; }
      try { fs.unlinkSync(quarantine); } catch { /* quarantine is diagnostic debris only */ }
    }
    const meta = { run_id: runId || null, session_id: sessionId || null, file_path: canonical, intent: opts.intent || 'edit', generation: newToken(opts), owner_token: newToken(opts), acquired_at: now, renewed_at: now, ttl_ms: ttlMs };
    writeAtomic(file, meta, guard);
    return { acquired: true, holder: null, owner_token: meta.owner_token, generation: meta.generation, stolen: existing ? { from: existing.run_id, reason: 'expired', age_ms: ageOf(existing, now) } : null, release: () => releaseFileLock(cwd, filePath, runId, meta.owner_token, meta.generation) };
  });
}

function renewFileLock(cwd, filePath, ownerToken, generation, opts) {
  opts = opts || {}; const canonical = canonicalPath(cwd, filePath); const now = nowOf(opts); const file = lockPathFor(cwd, canonical);
  return withGuard(cwd, canonical, (guard) => { const state = readLockState(cwd, canonical); if (state.state === 'unreadable') return { ok: false, reason: state.reason, errno: state.errno }; const existing = state.metadata; if (!existing) return { ok: false, reason: 'already_released' }; if (existing.owner_token !== ownerToken || existing.generation !== generation) return { ok: false, reason: 'owner_mismatch' }; const renewed = { ...existing, renewed_at: now, ttl_ms: positive(opts.ttlMs, existing.ttl_ms || DEFAULT_TTL_MS) }; writeAtomic(file, renewed, guard); return { ok: true, reason: 'renewed', metadata: renewed }; });
}
function touchFileLock(cwd, filePath, opts) { opts = opts || {}; const canonical = canonicalPath(cwd, filePath), file = lockPathFor(cwd, canonical); return withGuard(cwd, canonical, (guard) => { const state = readLockState(cwd, canonical); if (state.state === 'unreadable') return { ok: false, reason: state.reason, errno: state.errno }; const existing = state.metadata; if (!existing || existing.run_id !== opts.runId || existing.session_id !== opts.sessionId) return { ok:false, reason:'owner_mismatch' }; const renewed = { ...existing, renewed_at: nowOf(opts) }; writeAtomic(file, renewed, guard); return { ok:true, reason:'renewed', metadata:renewed }; }); }
// Removal errors remain distinct from a proven absence; ownership is checked
// immediately before unlink, under both operation and compatibility guards.
function releaseFileLockDetailed(cwd, filePath, runId, ownerToken, generation) {
  // runId is retained for call-shape compatibility, but cannot prove ownership.
  if (!ownerToken || !generation) return { ok: false, reason: 'owner_token_required' };
  const canonical = canonicalPath(cwd, filePath); const file = lockPathFor(cwd, canonical);
  const result = withGuard(cwd, canonical, (guard) => {
    const state = readLockState(cwd, canonical);
    if (state.state === 'unreadable') return { ok: false, reason: state.reason, errno: state.errno };
    const existing = state.metadata;
    if (!existing) return { ok: false, reason: 'already_released' };
    if (existing.owner_token !== ownerToken || existing.generation !== generation) return { ok: false, reason: 'owner_mismatch' };
    try { assertGuard(guard); fs.unlinkSync(file); return { ok: true, reason: 'released' }; }
    catch (error) { return { ok: false, reason: 'release-failed', errno: (error && error.code) || null }; }
  });
  // `withGuard` answers `{ acquired: false, reason: 'guard_busy' }` when the mutex is taken —
  // an object with no `.ok` at all. Normalizing it here is what keeps the detailed outcome from
  // being born `undefined` (the boolean export read `result.ok` on that shape already).
  if (!result || typeof result !== 'object') return { ok: false, reason: 'guard_busy' };
  if (!('ok' in result)) return { ok: false, reason: result.reason || 'guard_busy' };
  return result;
}
// Kept BOOLEAN: six call sites in the tests and `cliMain` depend on that shape.
// `releaseFileLockDetailed` is the ADDITIVE export that makes the outcome observable.
function releaseFileLock(cwd, filePath, runId, ownerToken, generation) {
  return releaseFileLockDetailed(cwd, filePath, runId, ownerToken, generation).ok === true;
}
function checkFileLock(cwd, filePath, opts) {
  opts = opts || {}; const state = readLockState(cwd, canonicalPath(cwd, filePath));
  if (state.state === 'unreadable') return { held: true, state: state.state, reason: state.reason, errno: state.errno, holder: null };
  const existing = state.metadata; if (!existing) return { held: false };
  const holder = publicHolder(existing, nowOf(opts));
  if (opts.ownerToken && opts.generation && existing.owner_token === opts.ownerToken && existing.generation === opts.generation) {
    holder.owner_token = existing.owner_token; holder.generation = existing.generation;
  }
  return { held: true, holder, age_ms: holder.age_ms };
}

// Recovery is deliberately separate from acquire/release: the operator must
// stop writers first. Rename retains the exact previous bytes (including invalid
// JSON) and the returned evidence path is never silently cleaned up.
function recoverFileLock(cwd, filePath, opts) {
  if (!opts || opts.confirmStopped !== true) return { ok: false, reason: 'recovery_requires_stopped_writers' };
  const canonical = canonicalPath(cwd, filePath);
  fs.mkdirSync(locksDir(cwd), { recursive: true });
  const operationBootstrap = mutex.recoverIncompleteLock(cwd, `${guardName(canonical)}-v2`, { ...opts, allowDeadProcessOwner: true });
  if (!operationBootstrap.ok && !['guard_not_held', 'guard_metadata_present'].includes(operationBootstrap.reason)) return operationBootstrap;
  // The v1 bridge was a 5s process mutex; the v2 bridge is a durable fence.
  // Decide on the recovery helper's own metadata snapshot, never a prior status
  // probe that could accidentally authorize a replacement fence by its PID.
  const bootstrap = mutex.recoverIncompleteLock(cwd, guardName(canonical), {
    ...opts, allowDeadProcessOwner: meta => meta.ttl_ms === 5_000 && meta.holder_run_id === null,
  });
  if (!bootstrap.ok && !['guard_not_held', 'guard_metadata_present'].includes(bootstrap.reason)) return bootstrap;
  const result = withGuard(cwd, canonical, (guard) => {
    const state = readLockState(cwd, canonical);
    if (state.state === 'absent') return bootstrap.ok || operationBootstrap.ok
      ? { ok: true, reason: 'guard_recovered', evidence: bootstrap.evidence || operationBootstrap.evidence }
      : { ok: false, reason: 'already_released' };
    if (state.state === 'present') return { ok: false, reason: 'owner_token_required' };
    if (!state.file) return { ok: false, reason: state.reason, errno: state.errno };
    if (state.reason === 'legacy_lock_present') {
      const legacy = readLock(state.file, canonical);
      if (legacy.state === 'present') {
        const activity = classifyHolder(cwd, legacy.metadata.run_id).activity;
        if (activity === 'live' || activity === 'unmeasured') return { ok: false, reason: 'holder_unmeasured_or_live' };
      }
    }
    const evidence = `${lockPathFor(cwd, canonical)}.recovery-${crypto.randomUUID()}`;
    try { assertGuard(guard); fs.renameSync(state.file, evidence); }
    catch (error) { return { ok: false, reason: 'recovery_failed', errno: error.code }; }
    return { ok: true, reason: 'recovered', evidence, previous_reason: state.reason };
  });
  return { ...result, ...(bootstrap.ok ? { guard_evidence: bootstrap.evidence } : {}),
    ...(operationBootstrap.ok ? { operation_guard_evidence: operationBootstrap.evidence } : {}) };
}

function parseArgs(argv) { const args = {}; for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const key = argv[i].slice(2), next = argv[i + 1]; args[key] = next && !next.startsWith('--') ? (i++, next) : true; } return args; }
function cliMain() { const args = parseArgs(process.argv.slice(2)), cwd = args.cwd || process.cwd(); try { if (args.acquire) { const result = acquireFileLock(cwd, args.acquire, args.run || null, args.session || null, { ttlMs: args.ttl && Number(args.ttl), intent: args.intent, ownerToken: args.token }); process.stdout.write(JSON.stringify(result) + '\n'); if (!result.acquired) process.exitCode = 1; } else if (args.recover) { const result = recoverFileLock(cwd, args.recover, { confirmStopped: args['confirm-stopped'] === true }); process.stdout.write(JSON.stringify(result) + '\n'); if (!result.ok) process.exitCode = 1; } else if (args.release) { const ok = releaseFileLock(cwd, args.release, args.run, args.token, args.generation); process.stdout.write(ok ? 'released\n' : 'not held (token obrigatório)\n'); if (!ok) process.exitCode = 1; } else if (args.check) process.stdout.write(JSON.stringify(checkFileLock(cwd, args.check), null, 2) + '\n'); else { process.stderr.write('forge-filelock: comando inválido\n'); process.exitCode = 2; } } catch (error) { process.stderr.write(`forge-filelock error: ${error.message}\n`); process.exitCode = 1; } }
if (require.main === module) cliMain();
// `isHolderRunActive` é export ADITIVO (S05/T02): zero mudança de lógica ou de
// comportamento — só a visibilidade. Um helper privado conta como código
// existente, então a saída para o TTL-como-rede de `forge-claim-release.js` é
// exportar o dono, nunca uma terceira cópia do predicado de run inativa.
module.exports = { acquireFileLock, renewFileLock, touchFileLock, releaseFileLock, releaseFileLockDetailed, checkFileLock, recoverFileLock, lockPathFor, encodePath, isHolderRunActive, classifyHolder, HOLDER_ACTIVITY, HOLDER_REASONS, DEFAULT_TTL_MS, LOCK_BASENAME_MAX };
