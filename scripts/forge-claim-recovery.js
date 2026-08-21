#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runs = require('./forge-runs.js');
const vcs = require('./forge-vcs.js');
const { findStuckClaims } = require('./forge-claim-stuck.js');
const { isHeld, recoverClaim, validateHeldClaim } = require('./forge-write-claim.js');
const { claimPathMatches } = require('./forge-parallelism.js');
const { IN_FLIGHT_KINDS } = require('./forge-claim-release.js');

function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function lstatOrAbsent(target) {
  try { return fs.lstatSync(target); }
  catch (error) { if (error && error.code === 'ENOENT') return null; throw error; }
}
function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
function assertSafePath(root, target, label) {
  const base = path.resolve(root); const resolved = path.resolve(target);
  if (!inside(base, resolved)) throw new Error(`${label}-path-escape`);
  let baseStat;
  try { baseStat = fs.lstatSync(base); } catch { throw new Error(`${label}-root-missing`); }
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new Error(`${label}-path-reparse`);
  const realBase = fs.realpathSync.native(base);
  const rel = path.relative(base, resolved);
  let cursor = base;
  for (const component of rel.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const stat = lstatOrAbsent(cursor);
    if (stat === null) break;
    if (stat.isSymbolicLink()) throw new Error(`${label}-path-reparse`);
    const real = fs.realpathSync.native(cursor);
    if (!inside(realBase, real)) throw new Error(`${label}-path-escape`);
  }
  return resolved;
}
function ancestryIdentity(root, target, label) {
  assertSafePath(root, target, label);
  const base = path.resolve(root); const parts = [''].concat(path.relative(base, path.resolve(target)).split(path.sep).filter(Boolean));
  let cursor = base; const identity = [];
  for (const part of parts) {
    if (part) cursor = path.join(cursor, part);
    const stat = lstatOrAbsent(cursor); if (stat === null) break;
    identity.push(`${stat.dev}:${stat.ino}`);
  }
  return identity.join('/');
}

function secureDirChain(cwd, relative, create, label, createdParents) {
  const base = path.resolve(cwd);
  const baseStat = lstatOrAbsent(base);
  if (!baseStat || !baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new Error(`${label}-cwd-unsafe`);
  const canonicalBase = fs.realpathSync.native(base);
  let cursor = base;
  for (const component of relative.split('/').filter(Boolean)) {
    cursor = path.join(cursor, component);
    let stat = lstatOrAbsent(cursor);
    if (stat === null) {
      if (!create) throw new Error(`${label}-root-missing`);
      try { fs.mkdirSync(cursor); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (Array.isArray(createdParents)) createdParents.push(path.dirname(cursor));
      stat = fs.lstatSync(cursor);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label}-root-reparse`);
    if (!inside(canonicalBase, fs.realpathSync.native(cursor))) throw new Error(`${label}-root-escape`);
  }
  return cursor;
}
function normalizeScope(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('claim-paths-invalid');
  return raw.map((item) => {
    if (typeof item !== 'string' || item === '' || path.isAbsolute(item) || item.includes('\0')) throw new Error('claim-path-invalid');
    const rel = item.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    if (rel === '' || rel === '..' || rel.startsWith('../')) throw new Error('claim-path-escape');
    return rel;
  });
}
function inScope(rel, scope) { return scope.some((p) => claimPathMatches(p, rel)); }
function recoveryRoot(cwd, id) { return path.join(cwd, '.gsd', 'forge', 'claim-recovery', encodeURIComponent(id)); }
function recoveryStore(cwd, id, create) {
  return secureDirChain(cwd, `.gsd/forge/claim-recovery/${encodeURIComponent(id)}`, create, 'recovery');
}

function inspect(cwd, runId, opts = {}) {
  const census = (opts.findStuckClaims || findStuckClaims)(cwd, opts.censusOptions || {});
  if (!census.stuck.some((entry) => entry.id === runId)) return { ok: false, eligible: false, reason: 'not-in-stuck-census' };
  const record = (opts.runs || runs).get(cwd, runId);
  if (!record || record.active !== true || !isHeld(record.write_claim)) return { ok: false, eligible: false, reason: 'claim-not-live' };
  const claim = record.write_claim;
  try { validateHeldClaim(claim); } catch (error) { return { ok: false, eligible: false, reason: error.message }; }
  let scope;
  try { scope = normalizeScope(claim.paths); } catch (error) { return { ok: false, eligible: false, reason: error.message }; }
  if (typeof claim.code_dir !== 'string' || !path.isAbsolute(claim.code_dir)) return { ok: false, eligible: false, reason: 'code-dir-invalid' };
  const codeDir = path.resolve(claim.code_dir);
  let stat;
  try { stat = fs.lstatSync(codeDir); } catch { return { ok: false, eligible: false, reason: 'code-dir-missing' }; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { ok: false, eligible: false, reason: 'code-dir-unsafe' };
  const statusReader = opts.workingStatus || vcs.workingStatus;
  const status = statusReader(codeDir, { vcs: claim.vcs_baseline && claim.vcs_baseline.vcs });
  if (!status.ok) return { ok: false, eligible: false, reason: `vcs-status-failed:${status.error}` };
  const dirty = status.entries.filter((entry) => IN_FLIGHT_KINDS.includes(entry.kind)
    && inScope(entry.path.replace(/\\/g, '/'), scope));
  return { ok: true, eligible: true, run_id: runId, record, claim, code_dir: codeDir, scope, dirty, status_reader: statusReader };
}

function fsyncDirectory(dir, io, required) {
  const o = io || {};
  const platform = typeof o.platform === 'string' ? o.platform : process.platform;
  if (typeof o.fsyncDir === 'function') {
    try { return o.fsyncDir(dir); }
    catch (error) { if (required) throw new Error(`directory-fsync-unavailable:${error.code || 'unknown'}`); return; }
  }
  // Node on Windows does not expose a portable directory flush primitive.
  // Durability there relies on file fsync plus same-volume atomic hard-link.
  if (platform === 'win32') return;
  let handle;
  try { handle = fs.openSync(dir, 'r'); fs.fsyncSync(handle); }
  catch (error) {
    if (!error || !['EPERM', 'EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP'].includes(error.code)) throw error;
    if (required) throw new Error(`directory-fsync-unavailable:${error.code}`);
  } finally { if (handle !== undefined) fs.closeSync(handle); }
}
function durabilityStrategy(io) {
  const platform = io && typeof io.platform === 'string' ? io.platform : process.platform;
  return platform === 'win32' ? 'file-fsync+ntfs-atomic-link' : 'file-fsync+posix-dir-fsync';
}

function durableWrite(file, bytes, io) {
  const o = io || {}; let handle;
  try {
    handle = fs.openSync(file, 'wx');
    writeAllSync(handle, bytes, o.writeSync);
    (o.fsyncSync || fs.fsyncSync)(handle);
  } finally { if (handle !== undefined) fs.closeSync(handle); }
}

function appendEvent(cwd, event, io) {
  const forgeRoot = secureDirChain(cwd, '.gsd/forge', true, 'event');
  const file = path.join(forgeRoot, 'events.jsonl');
  const bytes = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8'); let handle;
  try {
    handle = fs.openSync(file, 'a');
    writeAllSync(handle, bytes, io && io.writeSync);
    ((io && io.fsyncSync) || fs.fsyncSync)(handle);
  } finally { if (handle !== undefined) fs.closeSync(handle); }
  fsyncDirectory(forgeRoot, io, true);
}

function attemptName(now, nonce) {
  const suffix = nonce || crypto.randomBytes(12).toString('hex');
  if (!/^[a-f0-9]{24}$/.test(suffix)) throw new Error('recovery-nonce-invalid');
  return `${now}-${suffix}`;
}

function createBundle(cwd, preview, now, name, io) {
  const createdParents = [];
  const parent = secureDirChain(cwd, '.gsd/forge/claim-recovery', true, 'recovery', createdParents);
  const runRoot = secureDirChain(parent, `${encodeURIComponent(preview.run_id)}/attempts`, true, 'recovery', createdParents);
  const rootPath = path.join(runRoot, name || attemptName(now));
  if (lstatOrAbsent(rootPath) !== null) throw new Error('recovery-bundle-already-exists');
  fs.mkdirSync(rootPath);
  createdParents.push(runRoot);
  const root = secureDirChain(runRoot, path.basename(rootPath), false, 'recovery');
  const payloadRoot = secureDirChain(root, 'payload', true, 'recovery-payload', createdParents);
  const entries = [];
  try {
    for (let i = 0; i < preview.dirty.length; i++) {
      const dirty = preview.dirty[i];
      const rel = dirty.path.replace(/\\/g, '/');
      const abs = assertSafePath(preview.code_dir, path.resolve(preview.code_dir, rel), 'dirty');
      let present = false; let hash = null; let payload = null;
      const existing = lstatOrAbsent(abs);
      if (existing !== null) {
        const st = existing;
        if (!st.isFile() || st.isSymbolicLink()) throw new Error(`dirty-path-unsafe:${rel}`);
        const ancestry = ancestryIdentity(preview.code_dir, abs, 'dirty');
        const bytes = fs.readFileSync(abs);
        if (ancestryIdentity(preview.code_dir, abs, 'dirty') !== ancestry) throw new Error(`dirty-ancestry-drift:${rel}`);
        present = true; hash = sha256(bytes); payload = `payload/${i}.bin`;
        durableWrite(path.join(payloadRoot, `${i}.bin`), bytes, io);
        const check = fs.readFileSync(path.join(payloadRoot, `${i}.bin`));
        if (sha256(check) !== hash) throw new Error(`bundle-verify-failed:${rel}`);
      }
      entries.push({ path: rel, kind: dirty.kind, code: dirty.code, present, sha256: hash, payload });
    }
    const manifest = { version: 1, run_id: preview.run_id, created_at: now, durability_strategy: durabilityStrategy(io), code_dir: preview.code_dir, claim_identity_sha256: sha256(Buffer.from(JSON.stringify(preview.claim))), claim: preview.claim, entries };
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    durableWrite(path.join(root, 'manifest.json'), bytes, io);
    durableWrite(path.join(root, 'manifest.sha256'), Buffer.from(`${sha256(bytes)}\n`, 'ascii'), io);
    const reopened = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
    for (const entry of reopened.entries) if (entry.present) {
      const payload = fs.readFileSync(path.join(root, entry.payload));
      if (sha256(payload) !== entry.sha256) throw new Error(`bundle-verify-failed:${entry.path}`);
    }
    fsyncDirectory(payloadRoot, io, true); fsyncDirectory(root, io, true);
    for (const dir of Array.from(new Set(createdParents)).reverse()) fsyncDirectory(dir, io, true);
    return { root, manifest, manifest_sha256: sha256(bytes) };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function verifyDirtyUnchanged(preview, bundle) {
  const current = preview.status_reader(preview.code_dir, { vcs: preview.claim.vcs_baseline && preview.claim.vcs_baseline.vcs });
  if (!current.ok) throw new Error(`vcs-status-failed:${current.error}`);
  const dirty = current.entries.filter((entry) => IN_FLIGHT_KINDS.includes(entry.kind)
    && inScope(entry.path.replace(/\\/g, '/'), preview.scope));
  const expected = bundle ? bundle.manifest.entries : [];
  const key = (entry) => `${entry.path}\0${entry.kind}\0${entry.code}`;
  if (dirty.length !== expected.length || dirty.map(key).sort().join('\n') !== expected.map(key).sort().join('\n')) {
    throw new Error('dirty-scope-drift');
  }
  const byPath = new Map(expected.map((entry) => [entry.path, entry]));
  for (const entry of dirty) {
    const rel = entry.path.replace(/\\/g, '/'); const saved = byPath.get(rel);
    const abs = assertSafePath(preview.code_dir, path.resolve(preview.code_dir, rel), 'dirty');
    const currentStat = lstatOrAbsent(abs);
    const present = currentStat !== null;
    if (present !== saved.present) throw new Error('dirty-scope-drift');
    if (present) {
      const stat = currentStat;
      if (!stat.isFile() || stat.isSymbolicLink() || sha256(fs.readFileSync(abs)) !== saved.sha256) throw new Error('dirty-scope-drift');
    }
  }
}

function apply(cwd, runId, opts = {}) {
  if (opts.confirmOwnerStopped !== true) return { ok: false, applied: false, reason: 'owner-stop-attestation-required' };
  if (opts.confirmWorkspaceQuiescent !== true) return { ok: false, applied: false, reason: 'workspace-quiescent-attestation-required' };
  const preview = inspect(cwd, runId, opts);
  if (!preview.eligible) return { ...preview, applied: false };
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  let bundle = null;
  try {
    const attempt = preview.dirty.length ? attemptName(now) : null;
    const plannedBundle = preview.dirty.length
      ? path.relative(cwd, path.join(recoveryRoot(cwd, runId), 'attempts', attempt)).replace(/\\/g, '/') : null;
    // Journal first: even creation of the recovery bundle is a mutation.
    appendEvent(cwd, { ts: new Date(now).toISOString(), event: 'claim-recovery-intent', run_id: runId, evidence: { intent: 'operator-confirmed-owner-stopped', workspace_quiescent_attested: true, durability_strategy: durabilityStrategy(opts.io), dirty_paths: preview.dirty.map((e) => e.path), bundle: plannedBundle } }, opts.io);
    if (preview.dirty.length) bundle = createBundle(cwd, preview, now, attempt, opts.io);
    const evidence = { intent: 'operator-confirmed-owner-stopped', workspace_quiescent_attested: true, durability_strategy: durabilityStrategy(opts.io), dirty_paths: preview.dirty.map((e) => e.path), bundle: bundle ? path.relative(cwd, bundle.root).replace(/\\/g, '/') : null, manifest_sha256: bundle && bundle.manifest_sha256 };
    if (bundle) appendEvent(cwd, { ts: new Date(now).toISOString(), event: 'claim-recovery-bundle-verified', run_id: runId, evidence }, opts.io);
    const transition = (opts.recoverClaim || recoverClaim)(cwd, runId, preview.record,
      { at: now, mechanism: 'manual', evidence }, { precondition: () => verifyDirtyUnchanged(preview, bundle) });
    if (!transition.ok) return { ok: false, applied: false, reason: transition.reason, bundle: evidence.bundle };
    let event_warning = null;
    try { appendEvent(cwd, { ts: new Date(now).toISOString(), event: 'claim-recovery-applied', run_id: runId, bundle: evidence.bundle }); }
    catch (error) { event_warning = `outcome-event-failed:${error.message}`; }
    return { ok: true, applied: true, run_id: runId, dirty_paths: evidence.dirty_paths, bundle: evidence.bundle, event_warning };
  } catch (error) {
    return { ok: false, applied: false, reason: error.message,
      bundle: bundle ? path.relative(cwd, bundle.root).replace(/\\/g, '/') : null };
  }
}

function loadManifest(cwd, runId) {
  const record = runs.get(cwd, runId);
  const releaseEvidence = record && record.write_claim && record.write_claim.released
    && record.write_claim.released.evidence;
  const bundleRel = releaseEvidence && releaseEvidence.bundle;
  if (typeof bundleRel !== 'string' || bundleRel === '') throw new Error('applied-bundle-missing');
  const evidenceHash = releaseEvidence && releaseEvidence.manifest_sha256;
  if (typeof evidenceHash !== 'string' || !/^[a-f0-9]{64}$/.test(evidenceHash)) throw new Error('manifest-evidence-missing');
  const runRoot = recoveryStore(cwd, runId, false);
  const rootPath = path.resolve(cwd, bundleRel);
  if (!inside(runRoot, rootPath)) throw new Error('bundle-path-escape');
  const root = secureDirChain(runRoot, path.relative(runRoot, rootPath).replace(/\\/g, '/'), false, 'recovery');
  const file = path.join(root, 'manifest.json');
  const raw = fs.readFileSync(file);
  const expectedHash = fs.readFileSync(path.join(root, 'manifest.sha256'), 'ascii').trim();
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || sha256(raw) !== expectedHash) throw new Error('manifest-corrupt');
  if (sha256(raw) !== evidenceHash) throw new Error('manifest-evidence-mismatch');
  const manifest = JSON.parse(raw.toString('utf8'));
  if (manifest.version !== 1 || manifest.run_id !== runId || !Array.isArray(manifest.entries)) throw new Error('manifest-invalid');
  if (manifest.claim_identity_sha256 !== sha256(Buffer.from(JSON.stringify(manifest.claim)))) throw new Error('manifest-claim-identity-invalid');
  const persistedClaim = record.write_claim;
  const preReleaseClaim = Object.assign({}, persistedClaim, { released: null });
  if (manifest.claim_identity_sha256 !== sha256(Buffer.from(JSON.stringify(preReleaseClaim)))) throw new Error('manifest-claim-mismatch');
  return { root, manifest };
}

function writeAllSync(handle, bytes, writer) {
  const write = writer || fs.writeSync;
  let offset = 0;
  while (offset < bytes.length) {
    const written = write(handle, bytes, offset, bytes.length - offset, offset);
    if (!Number.isInteger(written) || written <= 0 || written > bytes.length - offset) throw new Error('write-invalid-count');
    offset += written;
  }
  return offset;
}

function writeExclusive(root, target, bytes, label, opts) {
  const o = opts || {};
  const parentRel = path.relative(root, path.dirname(target)).replace(/\\/g, '/');
  secureDirChain(root, parentRel, true, label);
  assertSafePath(root, path.dirname(target), label);
  const parent = path.dirname(target);
  const parentIdentity = ancestryIdentity(root, parent, label);
  const staging = path.join(parent, `.forge-recovery-${crypto.randomBytes(16).toString('hex')}.tmp`);
  let handle; let stagingIdentity = null; let originalError = null;
  try {
    handle = fs.openSync(staging, 'wx');
    stagingIdentity = fs.fstatSync(handle);
    writeAllSync(handle, bytes, o.writeSync);
    (o.fsyncSync || fs.fsyncSync)(handle);
    fs.closeSync(handle); handle = undefined;
    if (ancestryIdentity(root, parent, label) !== parentIdentity) throw new Error(`${label}-ancestry-drift`);
    try {
      (o.linkSync || fs.linkSync)(staging, target);
      return { written: true };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}-existing-divergent`);
      if (sha256(fs.readFileSync(target)) !== sha256(bytes)) throw new Error(`${label}-existing-divergent`);
      return { written: false };
    }
  } catch (error) {
    originalError = error;
    throw error;
  } finally {
    if (handle !== undefined) { try { fs.closeSync(handle); } catch { /* preserve original */ } }
    if (stagingIdentity) {
      try {
        const current = fs.lstatSync(staging);
        if (!current.isSymbolicLink() && current.dev === stagingIdentity.dev && current.ino === stagingIdentity.ino) fs.unlinkSync(staging);
      } catch (cleanupError) { if (!originalError && cleanupError.code !== 'ENOENT') throw cleanupError; }
    }
  }
}

function restore(cwd, runId, opts = {}) {
  if (opts.apply === true && opts.confirmWorkspaceQuiescent !== true) return { ok: false, restored: false, reason: 'workspace-quiescent-attestation-required' };
  let loaded;
  try { loaded = loadManifest(cwd, runId); } catch (error) { return { ok: false, restored: false, reason: error.message }; }
  const { root, manifest } = loaded;
  if (typeof manifest.code_dir !== 'string' || !path.isAbsolute(manifest.code_dir)) return { ok: false, restored: false, reason: 'code-dir-invalid' };
  const actions = []; const conflicts = [];
  try {
    for (const entry of manifest.entries) {
      if (typeof entry.path !== 'string' || path.isAbsolute(entry.path) || entry.path.startsWith('../')) throw new Error('manifest-path-escape');
      const target = assertSafePath(manifest.code_dir, path.resolve(manifest.code_dir, entry.path), 'manifest');
      if (!entry.present) {
        if (lstatOrAbsent(target) !== null) conflicts.push({ path: entry.path, presence: true });
        else actions.push({ path: entry.path, action: 'absence-confirmed' });
        continue;
      }
      const payloadPath = path.resolve(root, entry.payload || '');
      if (!inside(path.join(root, 'payload'), payloadPath)) throw new Error('payload-path-escape');
      const bytes = fs.readFileSync(payloadPath);
      if (sha256(bytes) !== entry.sha256) throw new Error(`payload-corrupt:${entry.path}`);
      if (lstatOrAbsent(target) === null) actions.push({ path: entry.path, action: 'restore', target, bytes });
      else {
        const st = fs.lstatSync(target);
        if (!st.isFile() || st.isSymbolicLink() || sha256(fs.readFileSync(target)) !== entry.sha256) conflicts.push({ path: entry.path, bytes });
        else actions.push({ path: entry.path, action: 'already-restored' });
      }
    }
    const result = { ok: conflicts.length === 0, restored: false, apply_required: opts.apply !== true, actions: actions.map(({ path: p, action }) => ({ path: p, action })), conflicts: conflicts.map((c) => c.path), presence_conflicts: conflicts.filter(c => c.presence).map(c => c.path) };
    if (opts.apply !== true) return result;
    for (const action of actions) if (action.action === 'restore') {
      assertSafePath(manifest.code_dir, path.dirname(action.target), 'restore');
      writeExclusive(manifest.code_dir, action.target, action.bytes, 'restore');
    }
    for (const conflict of conflicts.filter(c => !c.presence)) {
      const out = path.resolve(root, 'conflicts', conflict.path);
      const conflictRoot = path.join(root, 'conflicts');
      assertSafePath(root, out, 'conflict');
      const existingConflict = lstatOrAbsent(out);
      if (existingConflict !== null) {
        const stat = existingConflict;
        if (!stat.isFile() || stat.isSymbolicLink() || sha256(fs.readFileSync(out)) !== sha256(conflict.bytes)) throw new Error(`conflict-existing-divergent:${conflict.path}`);
        continue;
      }
      secureDirChain(root, 'conflicts', true, 'conflict');
      writeExclusive(conflictRoot, out, conflict.bytes, 'conflict');
    }
    result.restored = true; result.apply_required = false;
    try { appendEvent(cwd, { ts: new Date().toISOString(), event: 'claim-recovery-restore', run_id: runId, conflicts: result.conflicts }); }
    catch (error) { result.event_warning = `restore-event-failed:${error.message}`; }
    return result;
  } catch (error) { return { ok: false, restored: false, reason: error.message }; }
}

module.exports = { inspect, apply, restore, createBundle, verifyDirtyUnchanged, assertSafePath, ancestryIdentity, secureDirChain, writeAllSync, durableWrite, appendEvent, writeExclusive, durabilityStrategy, normalizeScope, inScope, sha256 };
