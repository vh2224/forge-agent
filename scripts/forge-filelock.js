#!/usr/bin/env node
'use strict';

// File locks are defence-in-depth for shared worktrees, not unit leases.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mutex = require('./forge-lock.js');
const DEFAULT_TTL_MS = 60_000;
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
function lockPathFor(cwd, filePath) { const canonical = canonicalPath(cwd, filePath); return path.join(locksDir(cwd), `${encodePath(canonical)}.json`); }
function validatePath(filePath) { if (!filePath || String(filePath).length > 4096) throw new Error('forge-filelock: path inválido'); }
function positive(value, fallback) { const n = value === undefined ? fallback : Number(value); if (!Number.isFinite(n) || n <= 0) throw new Error('forge-filelock: ttl deve ser positivo'); return n; }
function nowOf(opts) { return opts && typeof opts.now === 'function' ? opts.now() : Date.now(); }
function newToken(opts) { return opts && typeof opts.tokenFactory === 'function' ? opts.tokenFactory() : crypto.randomUUID().replace(/-/g, ''); }
function readLock(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeAtomic(file, meta, guard) { const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`; try { if (guard) mutex.assertOwned(guard); fs.writeFileSync(temporary, JSON.stringify(meta), 'utf8'); if (guard) mutex.assertOwned(guard); fs.renameSync(temporary, file); } catch (error) { try { fs.unlinkSync(temporary); } catch {} if (error && /assert|owned|lost/i.test(error.message || '')) error.code = 'GUARD_LOST'; throw error; } }
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
// Mutex names are capped at 160 characters. Absolute paths routinely exceed
// that once base64url-encoded (especially under Windows temp directories), so
// use a stable digest for the internal guard while retaining the readable
// canonical path in the file-lock metadata itself.
function guardName(filePath) { return `filelock-${crypto.createHash('sha256').update(String(filePath), 'utf8').digest('hex')}`; }
function withGuard(cwd, filePath, fn) {
  const guard = mutex.tryAcquireSync(cwd, guardName(filePath), { ttlMs: 5_000 });
  if (!guard) return { acquired: false, reason: 'guard_busy', holder: null };
  let result; try { result = fn(guard); } finally { const released = guard.release(); if (released === false && result && typeof result === 'object') result.reason = 'guard_release_failed'; }
  return result;
}
function publicHolder(existing, now) { return { run_id: existing.run_id, session_id: existing.session_id, file_path: existing.file_path, acquired_at: existing.acquired_at, age_ms: ageOf(existing, now) }; }

function acquireFileLock(cwd, filePath, runId, sessionId, opts) {
  opts = opts || {}; const canonical = canonicalPath(cwd, filePath); const ttlMs = positive(opts.ttlMs, DEFAULT_TTL_MS); const now = nowOf(opts); const file = lockPathFor(cwd, canonical);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withGuard(cwd, canonical, (guard) => {
    const existing = readLock(file);
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
      const quarantine = `${file}.quarantine-${existing.generation || 'legacy'}-${crypto.randomUUID()}`;
      try { mutex.assertOwned(guard); fs.renameSync(file, quarantine); } catch { return { acquired: false, reason: 'contended_recovery', holder: publicHolder(existing, now) }; }
      try { fs.unlinkSync(quarantine); } catch { /* quarantine is diagnostic debris only */ }
    }
    const meta = { run_id: runId || null, session_id: sessionId || null, file_path: canonical, intent: opts.intent || 'edit', generation: newToken(opts), owner_token: newToken(opts), acquired_at: now, renewed_at: now, ttl_ms: ttlMs };
    writeAtomic(file, meta, guard);
    return { acquired: true, holder: null, owner_token: meta.owner_token, generation: meta.generation, stolen: existing ? { from: existing.run_id, reason: 'expired', age_ms: ageOf(existing, now) } : null, release: () => releaseFileLock(cwd, filePath, runId, meta.owner_token, meta.generation) };
  });
}

function renewFileLock(cwd, filePath, ownerToken, generation, opts) {
  opts = opts || {}; const canonical = canonicalPath(cwd, filePath); const now = nowOf(opts); const file = lockPathFor(cwd, canonical);
  return withGuard(cwd, canonical, (guard) => { const existing = readLock(file); if (!existing) return { ok: false, reason: 'already_released' }; if (existing.owner_token !== ownerToken || existing.generation !== generation) return { ok: false, reason: 'owner_mismatch' }; const renewed = { ...existing, renewed_at: now, ttl_ms: positive(opts.ttlMs, existing.ttl_ms || DEFAULT_TTL_MS) }; writeAtomic(file, renewed, guard); return { ok: true, reason: 'renewed', metadata: renewed }; });
}
function touchFileLock(cwd, filePath, opts) { opts = opts || {}; const canonical = canonicalPath(cwd, filePath), file = lockPathFor(cwd, canonical); return withGuard(cwd, canonical, (guard) => { const existing = readLock(file); if (!existing || existing.run_id !== opts.runId || existing.session_id !== opts.sessionId) return { ok:false, reason:'owner_mismatch' }; const renewed = { ...existing, renewed_at: nowOf(opts) }; writeAtomic(file, renewed, guard); return { ok:true, reason:'renewed', metadata:renewed }; }); }
// The release used to rename the lock to `${file}.release-${generation}-${uuid}` before
// unlinking it — **+78 characters** onto a name that already has no ceiling (`lockPathFor`
// base64-encodes the whole absolute path). Once that crossed the OS limit (NAME_MAX 255 per
// component on POSIX, MAX_PATH on win32) the bare `catch` answered
// `{ ok: false, reason: 'already_released' }` — a NAME for an outcome that did not happen —
// and `writeAtomic`'s callers swallow the `false`. The orphaned lock then killed the SECOND
// write to the same fragment inside the TTL. Measured: 205 orphaned locks alive in this
// workspace, and the active worktree's lock path at 316 chars (361 after the rename).
//
// The fix is to stop lengthening: unlink the lock itself. `mutex.assertOwned(guard)` now runs
// immediately before the removal — strictly stronger than before (the release asserted no
// ownership at all; the acquire already asserts), and it is what the rename used to stand in
// for. `already_released` is RESERVED to the one case where it is true: `!existing`.
// A removal that fails is named by its errno, never by a guess.
//
// The name without a ceiling is the ORIGIN cause and is deliberately NOT fixed here — see
// `.gsd/items/` (Q1(d)): capping it changes the name of EVERY lock.
function releaseFileLockDetailed(cwd, filePath, runId, ownerToken, generation) {
  // runId is retained for call-shape compatibility, but cannot prove ownership.
  if (!ownerToken || !generation) return { ok: false, reason: 'owner_token_required' };
  const canonical = canonicalPath(cwd, filePath); const file = lockPathFor(cwd, canonical);
  const result = withGuard(cwd, canonical, (guard) => {
    const existing = readLock(file);
    if (!existing) return { ok: false, reason: 'already_released' };
    if (existing.owner_token !== ownerToken || existing.generation !== generation) return { ok: false, reason: 'owner_mismatch' };
    try { mutex.assertOwned(guard); fs.unlinkSync(file); return { ok: true, reason: 'released' }; }
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
  opts = opts || {}; const existing = readLock(lockPathFor(cwd, filePath)); if (!existing) return { held: false };
  const holder = publicHolder(existing, nowOf(opts));
  if (opts.ownerToken && opts.generation && existing.owner_token === opts.ownerToken && existing.generation === opts.generation) {
    holder.owner_token = existing.owner_token; holder.generation = existing.generation;
  }
  return { held: true, holder, age_ms: holder.age_ms };
}

function parseArgs(argv) { const args = {}; for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const key = argv[i].slice(2), next = argv[i + 1]; args[key] = next && !next.startsWith('--') ? (i++, next) : true; } return args; }
function cliMain() { const args = parseArgs(process.argv.slice(2)), cwd = args.cwd || process.cwd(); try { if (args.acquire) { const result = acquireFileLock(cwd, args.acquire, args.run || null, args.session || null, { ttlMs: args.ttl && Number(args.ttl), intent: args.intent, ownerToken: args.token }); process.stdout.write(JSON.stringify(result) + '\n'); if (!result.acquired) process.exitCode = 1; } else if (args.release) { const ok = releaseFileLock(cwd, args.release, args.run, args.token, args.generation); process.stdout.write(ok ? 'released\n' : 'not held (token obrigatório)\n'); if (!ok) process.exitCode = 1; } else if (args.check) process.stdout.write(JSON.stringify(checkFileLock(cwd, args.check), null, 2) + '\n'); else { process.stderr.write('forge-filelock: comando inválido\n'); process.exitCode = 2; } } catch (error) { process.stderr.write(`forge-filelock error: ${error.message}\n`); process.exitCode = 1; } }
if (require.main === module) cliMain();
// `isHolderRunActive` é export ADITIVO (S05/T02): zero mudança de lógica ou de
// comportamento — só a visibilidade. Um helper privado conta como código
// existente, então a saída para o TTL-como-rede de `forge-claim-release.js` é
// exportar o dono, nunca uma terceira cópia do predicado de run inativa.
module.exports = { acquireFileLock, renewFileLock, touchFileLock, releaseFileLock, releaseFileLockDetailed, checkFileLock, lockPathFor, encodePath, isHolderRunActive, classifyHolder, HOLDER_ACTIVITY, HOLDER_REASONS, DEFAULT_TTL_MS };
