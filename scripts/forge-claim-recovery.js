#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runs = require('./forge-runs.js');
const vcs = require('./forge-vcs.js');
const { findStuckClaims } = require('./forge-claim-stuck.js');
const { isHeld, recoverClaim, validateHeldClaim } = require('./forge-write-claim.js');

function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
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
function inScope(rel, scope) { return scope.some((p) => rel === p || rel.startsWith(`${p}/`)); }
function recoveryRoot(cwd, id) { return path.join(cwd, '.gsd', 'forge', 'claim-recovery', encodeURIComponent(id)); }

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
  const status = (opts.workingStatus || vcs.workingStatus)(codeDir, { vcs: claim.vcs_baseline && claim.vcs_baseline.vcs });
  if (!status.ok) return { ok: false, eligible: false, reason: `vcs-status-failed:${status.error}` };
  const dirty = status.entries.filter((entry) => inScope(entry.path.replace(/\\/g, '/'), scope));
  return { ok: true, eligible: true, run_id: runId, record, claim, code_dir: codeDir, scope, dirty };
}

function appendEvent(cwd, event) {
  const file = path.join(cwd, '.gsd', 'forge', 'events.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
}

function createBundle(cwd, preview, now) {
  const root = recoveryRoot(cwd, preview.run_id);
  if (fs.existsSync(root)) throw new Error('recovery-bundle-already-exists');
  fs.mkdirSync(path.join(root, 'payload'), { recursive: true });
  const entries = [];
  try {
    for (let i = 0; i < preview.dirty.length; i++) {
      const dirty = preview.dirty[i];
      const rel = dirty.path.replace(/\\/g, '/');
      const abs = path.resolve(preview.code_dir, rel);
      if (!inside(preview.code_dir, abs)) throw new Error('dirty-path-escape');
      let present = false; let hash = null; let payload = null;
      if (fs.existsSync(abs)) {
        const st = fs.lstatSync(abs);
        if (!st.isFile() || st.isSymbolicLink()) throw new Error(`dirty-path-unsafe:${rel}`);
        const bytes = fs.readFileSync(abs);
        present = true; hash = sha256(bytes); payload = `payload/${i}.bin`;
        fs.writeFileSync(path.join(root, payload), bytes);
        const check = fs.readFileSync(path.join(root, payload));
        if (sha256(check) !== hash) throw new Error(`bundle-verify-failed:${rel}`);
      }
      entries.push({ path: rel, kind: dirty.kind, code: dirty.code, present, sha256: hash, payload });
    }
    const manifest = { version: 1, run_id: preview.run_id, created_at: now, code_dir: preview.code_dir, claim: preview.claim, entries };
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(root, 'manifest.json'), bytes);
    fs.writeFileSync(path.join(root, 'manifest.sha256'), `${sha256(bytes)}\n`, 'ascii');
    const reopened = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
    for (const entry of reopened.entries) if (entry.present) {
      const payload = fs.readFileSync(path.join(root, entry.payload));
      if (sha256(payload) !== entry.sha256) throw new Error(`bundle-verify-failed:${entry.path}`);
    }
    return { root, manifest, manifest_sha256: sha256(bytes) };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function apply(cwd, runId, opts = {}) {
  if (opts.confirmOwnerStopped !== true) return { ok: false, applied: false, reason: 'owner-stop-attestation-required' };
  const preview = inspect(cwd, runId, opts);
  if (!preview.eligible) return { ...preview, applied: false };
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  let bundle = null;
  try {
    const plannedBundle = preview.dirty.length
      ? path.relative(cwd, recoveryRoot(cwd, runId)).replace(/\\/g, '/') : null;
    // Journal first: even creation of the recovery bundle is a mutation.
    appendEvent(cwd, { ts: new Date(now).toISOString(), event: 'claim-recovery-intent', run_id: runId, evidence: { intent: 'operator-confirmed-owner-stopped', dirty_paths: preview.dirty.map((e) => e.path), bundle: plannedBundle } });
    if (preview.dirty.length) bundle = createBundle(cwd, preview, now);
    const evidence = { intent: 'operator-confirmed-owner-stopped', dirty_paths: preview.dirty.map((e) => e.path), bundle: bundle ? path.relative(cwd, bundle.root).replace(/\\/g, '/') : null, manifest_sha256: bundle && bundle.manifest_sha256 };
    if (bundle) appendEvent(cwd, { ts: new Date(now).toISOString(), event: 'claim-recovery-bundle-verified', run_id: runId, evidence });
    const transition = (opts.recoverClaim || recoverClaim)(cwd, runId, preview.record, { at: now, mechanism: 'manual', evidence });
    if (!transition.ok) return { ok: false, applied: false, reason: transition.reason, bundle: evidence.bundle };
    let event_warning = null;
    try { appendEvent(cwd, { ts: new Date(now).toISOString(), event: 'claim-recovery-applied', run_id: runId, bundle: evidence.bundle }); }
    catch (error) { event_warning = `outcome-event-failed:${error.message}`; }
    return { ok: true, applied: true, run_id: runId, dirty_paths: evidence.dirty_paths, bundle: evidence.bundle, event_warning };
  } catch (error) {
    return { ok: false, applied: false, reason: error.message };
  }
}

function loadManifest(cwd, runId) {
  const root = recoveryRoot(cwd, runId);
  const file = path.join(root, 'manifest.json');
  const raw = fs.readFileSync(file);
  const expectedHash = fs.readFileSync(path.join(root, 'manifest.sha256'), 'ascii').trim();
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || sha256(raw) !== expectedHash) throw new Error('manifest-corrupt');
  const manifest = JSON.parse(raw.toString('utf8'));
  if (manifest.version !== 1 || manifest.run_id !== runId || !Array.isArray(manifest.entries)) throw new Error('manifest-invalid');
  return { root, manifest };
}

function restore(cwd, runId, opts = {}) {
  let loaded;
  try { loaded = loadManifest(cwd, runId); } catch (error) { return { ok: false, restored: false, reason: error.message }; }
  const { root, manifest } = loaded;
  if (typeof manifest.code_dir !== 'string' || !path.isAbsolute(manifest.code_dir)) return { ok: false, restored: false, reason: 'code-dir-invalid' };
  const actions = []; const conflicts = [];
  try {
    for (const entry of manifest.entries) {
      if (typeof entry.path !== 'string' || path.isAbsolute(entry.path) || entry.path.startsWith('../')) throw new Error('manifest-path-escape');
      const target = path.resolve(manifest.code_dir, entry.path);
      if (!inside(manifest.code_dir, target)) throw new Error('manifest-path-escape');
      if (!entry.present) { actions.push({ path: entry.path, action: 'absence-recorded' }); continue; }
      const payloadPath = path.resolve(root, entry.payload || '');
      if (!inside(path.join(root, 'payload'), payloadPath)) throw new Error('payload-path-escape');
      const bytes = fs.readFileSync(payloadPath);
      if (sha256(bytes) !== entry.sha256) throw new Error(`payload-corrupt:${entry.path}`);
      if (!fs.existsSync(target)) actions.push({ path: entry.path, action: 'restore', target, bytes });
      else {
        const st = fs.lstatSync(target);
        if (!st.isFile() || st.isSymbolicLink() || sha256(fs.readFileSync(target)) !== entry.sha256) conflicts.push({ path: entry.path, bytes });
        else actions.push({ path: entry.path, action: 'already-restored' });
      }
    }
    const result = { ok: conflicts.length === 0, restored: false, apply_required: opts.apply !== true, actions: actions.map(({ path: p, action }) => ({ path: p, action })), conflicts: conflicts.map((c) => c.path) };
    if (opts.apply !== true) return result;
    for (const action of actions) if (action.action === 'restore') {
      fs.mkdirSync(path.dirname(action.target), { recursive: true }); fs.writeFileSync(action.target, action.bytes);
    }
    for (const conflict of conflicts) {
      const out = path.resolve(root, 'conflicts', conflict.path);
      if (!inside(path.join(root, 'conflicts'), out)) throw new Error('conflict-path-escape');
      fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, conflict.bytes);
    }
    result.restored = true; result.apply_required = false;
    try { appendEvent(cwd, { ts: new Date().toISOString(), event: 'claim-recovery-restore', run_id: runId, conflicts: result.conflicts }); }
    catch (error) { result.event_warning = `restore-event-failed:${error.message}`; }
    return result;
  } catch (error) { return { ok: false, restored: false, reason: error.message }; }
}

module.exports = { inspect, apply, restore, createBundle, normalizeScope, inScope, sha256 };
