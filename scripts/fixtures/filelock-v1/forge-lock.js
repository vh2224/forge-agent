#!/usr/bin/env node
'use strict';

// A short, cross-platform mutex.  It is deliberately not a unit lease.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_RETRIES = 10;
const DEFAULT_BACKOFF_MIN = 100;
const DEFAULT_BACKOFF_MAX = 300;

function locksDir(cwd) { return path.join(cwd, '.gsd', '.locks'); }
function ensureLocksDir(cwd) {
  const gsd = path.join(cwd, '.gsd');
  if (!fs.existsSync(gsd)) {
    const error = new Error(`forge-lock: ${cwd} has no .gsd/ — refusing to create one (run /forge-init first)`);
    error.code = 'ENOGSD';
    throw error;
  }
  fs.mkdirSync(locksDir(cwd), { recursive: true });
}
function lockPath(cwd, name) { return path.join(locksDir(cwd), validateName(name).replace(/[^\w.-]/g, '_')); }
function metaPath(lockDir) { return path.join(lockDir, 'metadata.json'); }
function markerPath(lockDir, token) { return path.join(lockDir, `owner-${token}`); }
function nowOf(opts) { return opts && typeof opts.now === 'function' ? opts.now() : Date.now(); }
function tokenOf(opts) { return opts && typeof opts.tokenFactory === 'function' ? opts.tokenFactory() : crypto.randomUUID().replace(/-/g, ''); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function jitter(min, max) { return min + Math.floor(Math.random() * Math.max(1, max - min)); }
function validateName(name) { if (!name || String(name).length > 160) throw new Error('forge-lock: nome inválido'); return String(name); }
function positive(value, fallback, label) { const n = value === undefined ? fallback : Number(value); if (!Number.isFinite(n) || n <= 0) throw new Error(`forge-lock: ${label} deve ser positivo`); return n; }
function readMetadata(lockDir) { try { return JSON.parse(fs.readFileSync(metaPath(lockDir), 'utf8')); } catch { return null; } }
function lockAge(lockDir, now) { try { return now - fs.statSync(lockDir).mtimeMs; } catch { return null; } }
function writeAtomic(file, value) { const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`; fs.writeFileSync(temp, JSON.stringify(value), 'utf8'); fs.renameSync(temp, file); }
function sameOwner(meta, handle) { return !!meta && meta.owner_token === handle.ownerToken && meta.generation === handle.generation; }
function quarantine(lockDir, suffix) { const target = `${lockDir}.quarantine-${suffix}-${crypto.randomUUID()}`; try { fs.renameSync(lockDir, target); return target; } catch { return null; } }
function removeTree(dir) { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 }); return true; } catch { return false; } }

// A stale contender first claims the observed owner marker.  That claim makes an
// old release callback fail before any directory is renamed, avoiding ABA.
function stealIfStale(lockDir, ttlMs, now) {
  const meta = readMetadata(lockDir);
  const persistedTtl = meta && Number.isFinite(Number(meta.ttl_ms)) ? Number(meta.ttl_ms) : ttlMs;
  const age = meta && Number.isFinite(meta.renewed_at) ? now - meta.renewed_at : lockAge(lockDir, now);
  if (age === null || age <= persistedTtl) return false;
  if (meta && meta.owner_token) {
    try { fs.renameSync(markerPath(lockDir, meta.owner_token), markerPath(lockDir, `${meta.owner_token}.stale`)); }
    catch { return false; }
  }
  const quarantined = quarantine(lockDir, 'stale');
  if (!quarantined) return false;
  removeTree(quarantined);
  return true;
}

function makeHandle(cwd, name, lockDir, metadata) {
  const handle = { lockDir, metadata, ownerToken: metadata.owner_token, generation: metadata.generation };
  handle.release = () => releaseHandle(handle);
  handle.renew = (opts) => renewHandle(handle, opts);
  return handle;
}
function create(cwd, name, opts) {
  const lockDir = lockPath(cwd, name);
  const now = nowOf(opts);
  const metadata = { name, generation: tokenOf(opts), owner_token: tokenOf(opts), acquired_at: now, renewed_at: now, ttl_ms: positive(opts && opts.ttlMs, DEFAULT_TTL_MS, 'ttl'), holder_pid: (opts && opts.holderPid) || process.pid, holder_run_id: (opts && opts.holderRunId) || null };
  fs.mkdirSync(lockDir);
  try { fs.mkdirSync(markerPath(lockDir, metadata.owner_token)); writeAtomic(metaPath(lockDir), metadata); }
  catch (error) { removeTree(lockDir); throw error; }
  return makeHandle(cwd, name, lockDir, metadata);
}

async function acquire(cwd, name, opts) {
  opts = opts || {}; validateName(name);
  const ttlMs = positive(opts.ttlMs, DEFAULT_TTL_MS, 'ttl');
  const retries = positive(opts.retries, DEFAULT_RETRIES, 'retries');
  const backoffMin = positive(opts.backoffMin, DEFAULT_BACKOFF_MIN, 'backoff');
  const backoffMax = positive(opts.backoffMax, DEFAULT_BACKOFF_MAX, 'backoff');
  ensureLocksDir(cwd); const dir = lockPath(cwd, name);
  for (let attempt = 0; attempt < retries; attempt++) {
    try { return create(cwd, name, { ...opts, ttlMs }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (opts.allowStaleRecovery !== false && stealIfStale(dir, ttlMs, nowOf(opts))) { attempt--; continue; }
      if (attempt + 1 < retries) await sleep(jitter(backoffMin, backoffMax));
    }
  }
  const metadata = readMetadata(dir); const age = lockAge(dir, nowOf(opts));
  const error = new Error(`forge-lock: mutex ocupado para "${name}"`); error.code = 'LOCK_BUSY'; error.metadata = metadata; error.age_ms = age; throw error;
}
function tryAcquireSync(cwd, name, opts) {
  opts = opts || {}; validateName(name); const ttlMs = positive(opts.ttlMs, DEFAULT_TTL_MS, 'ttl');
  try { ensureLocksDir(cwd); } catch (error) { if (error.code === 'ENOGSD') return null; throw error; }
  const dir = lockPath(cwd, name);
  try { return create(cwd, name, { ...opts, ttlMs }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; if (opts.allowStaleRecovery !== false && stealIfStale(dir, ttlMs, nowOf(opts))) { try { return create(cwd, name, { ...opts, ttlMs }); } catch { } } return null; }
}
// Synchronous consumers (the state/run registries predate promises) still need
// the same owner-scoped mutex. Atomics.wait is available in Node on every host
// we support and avoids shell-specific sleep helpers.
function acquireSync(cwd, name, opts) {
  opts = opts || {}; validateName(name);
  const retries = positive(opts.retries, DEFAULT_RETRIES, 'retries');
  const ttlMs = positive(opts.ttlMs, DEFAULT_TTL_MS, 'ttl');
  const backoffMin = positive(opts.backoffMin, DEFAULT_BACKOFF_MIN, 'backoff');
  const backoffMax = positive(opts.backoffMax, DEFAULT_BACKOFF_MAX, 'backoff');
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < retries; attempt++) {
    const handle = tryAcquireSync(cwd, name, { ...opts, ttlMs });
    if (handle) return handle;
    if (attempt + 1 < retries) Atomics.wait(sleeper, 0, 0, jitter(backoffMin, backoffMax));
  }
  const error = new Error(`forge-lock: mutex ocupado para "${name}"`);
  error.code = 'LOCK_BUSY';
  throw error;
}
function renewHandle(handle, opts) {
  opts = opts || {}; const meta = readMetadata(handle.lockDir);
  if (!sameOwner(meta, handle) || !fs.existsSync(markerPath(handle.lockDir, handle.ownerToken))) return { ok: false, reason: 'owner_mismatch' };
  const renewed = { ...meta, renewed_at: nowOf(opts), ttl_ms: positive(opts.ttlMs, meta.ttl_ms || DEFAULT_TTL_MS, 'ttl') };
  try { writeAtomic(metaPath(handle.lockDir), renewed); handle.metadata = renewed; return { ok: true, reason: 'renewed', metadata: renewed }; }
  catch { return { ok: false, reason: 'already_released' }; }
}
function assertOwned(handle) {
  return sameOwner(readMetadata(handle.lockDir), handle) && fs.existsSync(markerPath(handle.lockDir, handle.ownerToken));
}
function releaseHandle(handle) {
  const meta = readMetadata(handle.lockDir);
  if (!sameOwner(meta, handle)) return { ok: false, reason: 'owner_mismatch' };
  const marker = markerPath(handle.lockDir, handle.ownerToken);
  try { fs.renameSync(marker, `${marker}.released`); } catch { return { ok: false, reason: 'owner_mismatch' }; }
  // We only remove the directory after claiming our unique marker. A new owner
  // cannot be created until this directory is gone.
  try { fs.unlinkSync(metaPath(handle.lockDir)); fs.rmdirSync(`${marker}.released`); fs.rmdirSync(handle.lockDir); return { ok: true, reason: 'released' }; }
  catch { return { ok: false, reason: 'already_released' }; }
}
// Legacy release lacks proof of ownership. It is kept observable but safely denied.
function releaseSync(cwd, name, ownerToken, generation) {
  if (!ownerToken || !generation) return false;
  return releaseHandle({ lockDir: lockPath(cwd, name), ownerToken, generation }).ok;
}
function status(cwd, name, opts) { const dir = lockPath(cwd, name); if (!fs.existsSync(dir)) return { held: false }; return { held: true, metadata: readMetadata(dir), age_ms: lockAge(dir, nowOf(opts || {})) }; }

function parseArgs(argv) { const out = {}; for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2), n = argv[i + 1]; out[k] = n && !n.startsWith('--') ? (i++, n) : true; } return out; }
async function cliMain() { const args = parseArgs(process.argv.slice(2)), cwd = args.cwd || process.cwd(); try { if (args.acquire || args['try-acquire']) { const fn = args.acquire ? acquire : tryAcquireSync; const h = await fn(cwd, args.acquire || args['try-acquire'], { ttlMs: args.ttl && Number(args.ttl), holderRunId: args.holder, retries: args.retries && Number(args.retries) }); if (!h) { process.stderr.write('busy\n'); process.exitCode = 1; return; } process.stdout.write(JSON.stringify({ lockDir: h.lockDir, metadata: h.metadata }) + '\n'); } else if (args.release) { const ok = releaseSync(cwd, args.release, args.token, args.generation); process.stdout.write(ok ? 'released\n' : 'not held (token obrigatório)\n'); process.exitCode = ok ? 0 : 1; } else if (args.status) process.stdout.write(JSON.stringify(status(cwd, args.status), null, 2) + '\n'); else { process.stderr.write('forge-lock: comando inválido\n'); process.exitCode = 2; } } catch (e) { process.stderr.write(`forge-lock error: ${e.message}\n`); process.exitCode = 1; } }
if (require.main === module) cliMain();
module.exports = { acquire, acquireSync, tryAcquireSync, releaseSync, releaseHandle, renewHandle, assertOwned, status, locksDir, lockPath, metaPath, stealIfStale, DEFAULT_TTL_MS };
