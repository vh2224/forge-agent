#!/usr/bin/env node
'use strict';

// Trusted caller IPC only. The signing key is born in the broker and never
// serialized. The worker gets neither a signing API nor the parent's IPC fd.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fork, ChildProcess } = require('child_process');
const roots = require('./forge-code-roots');
const digest = roots.digest;
const live = new WeakSet();
const heldLocks = new WeakMap();
function fail(code) { throw Object.assign(new Error(code), { code }); }
function bytes(file) { try { return fs.readFileSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function sha(file) { const b = bytes(file); return b === null ? null : digest(b); }
function exclusive(file, value) { fs.writeFileSync(file, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 }); }
function safeTarget(owner, relative) {
  if (typeof relative !== 'string' || !relative.startsWith('.gsd/') || relative.split(/[\\/]/).includes('..') || relative.includes('\0')) fail('reconciliation-path-invalid');
  const target = path.resolve(owner, relative);
  if (!roots.within(owner, target)) fail('reconciliation-path-escape');
  let cursor = owner;
  for (const part of path.relative(owner, target).split(path.sep)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) fail('reconciliation-path-link');
  }
  return target;
}
function logIdentity(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) fail('reconciliation-log-identity');
  return digest({ path: roots.key(fs.realpathSync.native(file)), dev: String(stat.dev), ino: String(stat.ino), birth: String(stat.birthtimeNs) });
}
function lockRoot(owner) {
  return path.join(require('os').tmpdir(), `forge-artifact-owner-${digest(roots.key(owner))}`);
}
function lock(manifest, acquisitionBudget) {
  // The canonical mutex lives in the trusted transport directory, outside the
  // protected owner. Both appends and publication take the same attempt lock.
  const directory = lockRoot(manifest.owner);
  if (manifest.lock_root && manifest.lock_root !== directory) fail('reconciliation-lock-identity');
  fs.mkdirSync(path.join(directory, '.gsd'), { recursive: true });
  // This synchronous critical section belongs to the actual owner/broker
  // process. Recover only its proven death, never an old clock or a live PID.
  const handle = require('./forge-lock').acquireProcessSync(directory, 'publication',
    { retries: 1, ...(acquisitionBudget ? { retries: acquisitionBudget.remaining_attempts || 1, acquisitionBudget } : {}) });
  const guard = Object.freeze({ release() { heldLocks.delete(guard); return handle.release(); } });
  heldLocks.set(guard, manifest.owner);
  return guard;
}
function withOwnerLock(owner, callback, guard) {
  owner = roots.realDirectory(owner);
  const windows = require('./forge-owner-transport-window');
  if (guard === undefined) guard = windows.currentPublicationGuard(owner, true);
  if (guard !== undefined) {
    if (heldLocks.get(guard) !== owner) fail('reconciliation-lock-handle-required');
    windows.assertMutationAllowed(owner);
    return callback();
  }
  const acquired = lock({ owner });
  try { return windows.withPublicationContext(owner, acquired, () => { windows.assertMutationAllowed(owner); return callback(); }); } finally { acquired.release(); }
}
// Validate the real held guard without entering another publication boundary.
// A forged withPublicationContext handle is still rejected by this WeakMap.
Object.defineProperty(lock, 'assertGuard', { value(owner, guard) {
  owner = roots.realDirectory(owner);
  if (heldLocks.get(guard) !== owner) fail('reconciliation-lock-handle-required');
  require('./forge-owner-transport-window').assertMutationAllowed(owner);
  return true;
} });
function verifyProof(manifest, proof) {
  if (manifest.schema_version !== 1 || proof?.manifest_sha256 !== digest(manifest) || proof.dispatch_id !== manifest.dispatch_id) fail('reconciliation-proof-identity');
  const { signature, ...payload } = proof;
  if (!signature || !crypto.verify(null, Buffer.from(JSON.stringify(payload)), manifest.public_key, Buffer.from(signature, 'base64'))) fail('reconciliation-signature-invalid');
  if (!manifest.append_paths.includes(payload.path) || payload.start < 0 || payload.end <= payload.start) fail('reconciliation-proof-scope');
  return payload;
}
function verifySurface(manifest, proofs, options = {}) {
  const expectedManifest = options.manifest_sha256;
  if (!expectedManifest || digest(manifest) !== expectedManifest) fail('reconciliation-trust-anchor-required');
  const owner = roots.realDirectory(manifest.owner);
  if (owner !== manifest.owner) fail('reconciliation-owner-changed');
  if (manifest.execution_contract) roots.validateContract(manifest.execution_contract, { revalidate: true });
  const snapshot = options.snapshot || require('./forge-task-execution').protectedSnapshot;
  const current = snapshot(owner), expected = { ...manifest.surface };
  for (const relative of manifest.append_paths) {
    const rows = proofs.filter(p => p.path === relative).map(p => verifyProof(manifest, p));
    const file = safeTarget(owner, relative), observed = bytes(file);
    let end = manifest.append_baselines[relative].length;
    let prefix = manifest.append_baselines[relative].sha256;
    if (observed === null || logIdentity(file) !== manifest.append_baselines[relative].identity_sha256) fail('reconciliation-log-identity');
    if (!rows.length) continue;
    if (observed === null || digest(observed.subarray(0, end)) !== prefix) fail('reconciliation-prefix-changed');
    for (const [index, row] of rows.entries()) {
      if (row.sequence !== index + 1 || row.log_identity_sha256 !== manifest.append_baselines[relative].identity_sha256) fail('reconciliation-proof-sequence');
      if (row.start !== end || row.prefix_sha256 !== prefix || row.end > observed.length) fail('reconciliation-span-invalid');
      if (digest(observed.subarray(row.start, row.end)) !== row.append_sha256
          || digest(observed.subarray(0, row.end)) !== row.result_sha256) fail('reconciliation-append-changed');
      end = row.end; prefix = row.result_sha256;
    }
    if (end !== observed.length) fail('reconciliation-unsigned-append');
    expected[relative] = prefix;
  }
  const provenSurface = digest(Object.entries(expected).sort());
  // A replay may observe any subset of the canonical publication after a crash.
  // Only exact saved response bytes are admissible; absent or old targets retain
  // their original CAS baseline. Other drift, including empty dirs, is refused.
  for (const artifact of options.canonicalArtifacts || []) {
    safeTarget(owner, artifact.path);
    if (current[artifact.path] !== digest(artifact.content)) continue;
    expected[artifact.path] = current[artifact.path];
    let dir = path.posix.dirname(artifact.path);
    while (dir !== '.') {
      if (current[dir + '/'] === 'directory') expected[dir + '/'] = 'directory';
      dir = path.posix.dirname(dir);
    }
  }
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    // Key order need not survive a serialized manifest; compare entries.
    if (digest(Object.entries(current).sort()) !== digest(Object.entries(expected).sort())) fail('reconciliation-unproved-drift');
  }
  return { passed: true, surface: current, surface_sha256: provenSurface, observed_surface_sha256: digest(Object.entries(current).sort()) };
}

function logBaselines(owner, appendPaths) {
  return Object.fromEntries(appendPaths.map(rel => { const file = safeTarget(owner, rel), b = bytes(file);
    return [rel, { length: b.length, sha256: digest(b), identity_sha256: logIdentity(file), sequence: 0 }]; }));
}
// The one signing child of a broker and its private IPC: requests are answered in order and
// a stopped child rejects every pending call. The key never crosses this channel.
function signer(spawnOptions) {
  const child = fork(__filename, ['--broker'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, ...spawnOptions });
  let sequence = 0; const pending = new Map();
  child.on('message', message => { const p = pending.get(message.id); if (!p) return; pending.delete(message.id); clearTimeout(p.timer);
    message.error ? p.reject(Object.assign(new Error(message.error), { code: message.error })) : p.resolve(message.result); });
  child.on('exit', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('broker-stopped')); } pending.clear(); });
  const call = (op, data) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('broker-ipc-timeout')); }, 15000);
    pending.set(id, { resolve, reject, timer }); child.send({ id, op, data });
  });
  const joined = new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({ status: 'joined', active_processes: 0,
      process: { pid: child.pid, exit_code: Number.isInteger(code) ? code : null, signal: signal || null } }));
    child.once('error', () => { if (!child.pid) resolve({ status: 'not-started', active_processes: 0, spawned: false }); });
  });
  return { child, call, joined };
}

async function startBroker(options) {
  const owner = roots.realDirectory(options.owner);
  const manifestFile = path.resolve(options.manifestFile);
  // Public material lives in the trusted result channel, outside every writable
  // surface. Trust is the hash retained in the caller, never a path from output.
  if (roots.within(owner, manifestFile) || options.execution_contract?.code_roots.some(r => roots.within(r.path, manifestFile))) fail('broker-manifest-in-worker-surface');
  const { appendPaths, surface, baselines, child, call } = require('./forge-owner-transport-window').withMutation(owner, () => {
    const appendPaths = options.appendPaths || ['.gsd/forge/events.jsonl'];
    for (const rel of appendPaths) {
      const file = safeTarget(owner, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!fs.existsSync(file)) fs.writeFileSync(file, '', { flag: 'wx' });
    }
    const surface = require('./forge-task-execution').protectedSnapshot(owner);
    const baselines = logBaselines(owner, appendPaths);
    const { child, call } = signer({ env: { ...process.env } });
    return { appendPaths, surface, baselines, child, call };
  });
  const manifest = await call('init', { owner, dispatch_id: options.dispatchId, request_sha256: options.request_sha256,
    nonce: crypto.randomUUID(), lock_root: lockRoot(owner),
    plan_sha256: options.plan_sha256 || null, execution_contract: options.execution_contract || null,
    append_paths: appendPaths, append_baselines: baselines, surface, created_at: new Date().toISOString() });
  try { exclusive(manifestFile, manifest); }
  catch (error) { child.disconnect(); throw error; }
  const proofs = [];
  const broker = Object.freeze({ manifest, manifest_sha256: digest(manifest), manifestFile,
    async bindResponse(result) {
      const anchor = await call('response', { response_sha256: digest(result) });
      const file = `${manifestFile}.response.json`;
      if (fs.existsSync(file)) {
        if (digest(JSON.parse(bytes(file))) !== digest(anchor)) fail('broker-response-anchor-conflict');
      } else exclusive(file, anchor);
      return anchor;
    },
    async append(relative, line) {
      if (typeof line !== 'string' || !line.endsWith('\n') || Buffer.byteLength(line) > 65536) fail('broker-append-invalid');
      const proof = await call('append', { path: relative, bytes: Buffer.from(line).toString('base64') });
      if (proof.status === 'already-recorded') return proof;
      const fd = fs.openSync(`${manifestFile}.proofs.jsonl`, 'a', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(proof) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      proofs.push(proof); return proof;
    },
    verify(options = {}) { return verifySurface(manifest, proofs, { ...options, manifest_sha256: digest(manifest) }); },
    proofs() { return JSON.parse(JSON.stringify(proofs)); },
    async close() { if (child.connected) { await call('close'); child.disconnect(); } },
  });
  live.add(broker); return broker;
}
function assertBroker(value) { if (!live.has(value)) fail('broker-caller-handle-required'); return value; }

// Append-only reconciliation receipt. Original failure and saved candidate are
// immutable; publication uses the canonical materializer with its target CAS.
function inspectCandidate(options) {
  const originalBytes = bytes(options.receiptFile);
  if (!originalBytes) fail('reconciliation-receipt-missing');
  const original = JSON.parse(originalBytes);
  const responseAnchorBytes = bytes(`${options.receiptFile}.response-anchor.json`);
  const observation = { present: !!original.saved_candidate, schema_valid: false, replay_eligible: false,
    receipt_sha256: digest(originalBytes), candidate_sha256: original.saved_candidate ? digest(original.saved_candidate) : null,
    anchor_sha256: responseAnchorBytes ? digest(responseAnchorBytes) : null,
    provenance: original.broker_manifest_sha256 || responseAnchorBytes ? 'present-or-damaged' : 'absence-unproved' };
  if (original.phase !== 'failed' || !original.saved_candidate) return { ...observation, reason_code: 'reconciliation-saved-response-required' };
  const responseHash = digest(original.saved_candidate.result);
  if (original.saved_candidate.sha256 !== responseHash) return { ...observation, reason_code: 'reconciliation-response-changed' };
  const request = options.request;
  if (request) {
    const unit = require('./forge-unit-sidecar'), loc = unit.locations(request);
    observation.schema_valid = unit.inspectArtifacts(original.saved_candidate.result, loc.allowed, loc.required, Infinity,
      loc.rules, { forbidArtifactsOnNonDone: loc.preparation === true }).ok;
  } else observation.schema_valid = !!original.saved_candidate.result && typeof original.saved_candidate.result === 'object';
  if (!observation.schema_valid) return { ...observation, reason_code: 'reconciliation-candidate-schema-invalid' };
  try { assertCandidateProvenance(options, original, responseHash, responseAnchorBytes); }
  catch (error) { return { ...observation, reason_code: error.code || 'reconciliation-response-anchor-invalid' }; }
  return { ...observation, replay_eligible: true, provenance: 'signed', reason_code: null };
}
function assertCandidateProvenance(options, original, responseHash, responseAnchorBytes) {
  const anchor = options.trust;
  if (!anchor || anchor.manifest_sha256 !== digest(options.manifest)
      || original.broker_manifest_sha256 !== anchor.manifest_sha256
      || anchor.request_sha256 !== original.fingerprint || options.manifest.request_sha256 !== original.fingerprint) fail('reconciliation-request-mismatch');
  // The receipt and its adjacent hash are untrusted together. Require the
  // broker's independently signed, single-response binding from before refusal.
  if (!responseAnchorBytes) fail('reconciliation-response-anchor-required');
  const { signature, ...responseAnchor } = JSON.parse(responseAnchorBytes);
  if (responseAnchor.kind !== 'saved-response' || responseAnchor.manifest_sha256 !== anchor.manifest_sha256
      || responseAnchor.dispatch_id !== options.manifest.dispatch_id
      || responseAnchor.request_sha256 !== original.fingerprint
      || responseAnchor.response_sha256 !== responseHash
      || !signature || !crypto.verify(null, Buffer.from(JSON.stringify(responseAnchor)), options.manifest.public_key,
        Buffer.from(signature, 'base64'))) fail('reconciliation-response-anchor-invalid');
  if (original.saved_candidate.plan_sha256 !== (options.manifest.plan_sha256 || null)) fail('reconciliation-plan-mismatch');
}
async function reconcile(options) {
  const inspected = inspectCandidate(options);
  if (!inspected.replay_eligible) fail(inspected.reason_code);
  const originalBytes = bytes(options.receiptFile), original = JSON.parse(originalBytes), anchor = options.trust;
  if (digest(originalBytes) !== inspected.receipt_sha256) fail('reconciliation-receipt-raced');
  const guard = lock(options.manifest);
  try {
  const publicationOptions = { ...anchor, canonicalArtifacts: original.saved_candidate.result.artifacts || [] };
  const verified = verifySurface(options.manifest, options.proofs, publicationOptions);
  const identity = { schema_version: 1, original_receipt_sha256: digest(originalBytes), request_sha256: original.fingerprint,
    response_sha256: original.saved_candidate.sha256, manifest_sha256: anchor.manifest_sha256,
    plan_sha256: options.manifest.plan_sha256, roots_sha256: digest(options.manifest.execution_contract),
    surface_sha256: verified.surface_sha256, proofs_sha256: digest(options.proofs) };
  const childFile = `${options.receiptFile}.reconciled-${digest(identity)}.json`;
  const child = { ...identity, phase: 'reconciled', original_receipt: options.receiptFile, provider_called: false,
    candidate: original.saved_candidate.result, before: original.before, before_state: original.before_state };
  if (fs.existsSync(childFile)) { if (digest(JSON.parse(bytes(childFile))) !== digest(child)) fail('reconciliation-child-conflict'); }
  else exclusive(childFile, child);
  options.beforePublish?.();
  if (sha(options.receiptFile) !== identity.original_receipt_sha256) fail('reconciliation-receipt-raced');
  verifySurface(options.manifest, options.proofs, publicationOptions);
  await options.publish(child, guard);
  verifySurface(options.manifest, options.proofs, publicationOptions);
  return { ...identity, child_receipt: childFile, replayed: true, provider_called: false };
  } finally { guard.release(); }
}

// ── Cohort member mode (issue 343 U3a, B3 part 1) ─────────────────────────────
//
// One signing child per execute-task cohort, started by forge-execution-batch after the
// member begins, the isolation, the attempt bindings and before the first provider spawn.
// The member registry is closed at start: the manifest (schema_version 2) names every member
// attempt (M/S/T, begin/lease, dispatch/request, plan/gate, physical projection, route) and
// no member joins later. Every member append is signed into ONE stream per authorized log in
// a global sequence, so verifying any member walks every sibling's proofs from the common
// snapshot S0 to the end of the log; the owner journal (proofs.jsonl) must be exactly that
// stream. One immutable response anchor per member attempt, and one barrier sealed only from
// process exits this broker observed itself. The single-dispatch broker above keeps its
// manifest, proofs, IPC and refusals; neither capability ever stands in for the other.

const BATCH_KIND = 'forge-batch-broker';
const MAX_LINE_BYTES = 65536;
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const HEX64 = /^[a-f0-9]{64}$/;
const MEMBER_REF = /^m[0-7]-[a-f0-9]{16}$/;
const RETAINED_KEYS = Object.freeze(['response_sha256', 'executed_sha256', 'seal_sha256', 'baseline_sha256', 'delta_sha256']);
const OUTCOMES = Object.freeze(['retained', 'residual', 'failed', 'interrupted']);
function residualMetadata(value) {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'pending_questions,provider_called,reason,reason_code,result_status'
      || !['partial','blocked'].includes(value.result_status) || typeof value.reason_code !== 'string' || value.reason_code.length > 256
      || !(value.reason === null || typeof value.reason === 'string' && value.reason.length <= 4096)
      || ![true,false,'unknown'].includes(value.provider_called) || !Array.isArray(value.pending_questions)
      || value.pending_questions.length > 128 || JSON.stringify(value.pending_questions).length > 65536) fail('broker-residual-invalid');
  return {result_status:value.result_status,reason_code:value.reason_code,reason:value.reason,
    pending_questions:copy(value.pending_questions),provider_called:value.provider_called};
}
// The key holder inherits only what Node and the shared temporary mutex need: no provider
// credential, NODE_OPTIONS or inspector flag ever reaches the signing child.
const SIGNER_ENV = Object.freeze(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LANG', 'LC_ALL', 'TZ']);
// Closed refusals of the member mode (with the reconciliation-* verification codes above).
const BATCH_BROKER_REFUSALS = Object.freeze(['broker-batch-handle-required', 'broker-cohort-handle-required',
  'broker-member-handle-required', 'broker-member-binding-changed', 'broker-member-registry-incomplete', 'broker-member-foreign',
  'broker-member-not-registered', 'broker-directory-invalid', 'broker-manifest-in-worker-surface', 'broker-batch-already-started',
  'broker-append-invalid', 'broker-append-noncanonical', 'broker-path-not-authorized', 'broker-member-identity-mismatch',
  'broker-proof-unexpected', 'broker-response-ref-invalid', 'broker-response-hash-invalid', 'broker-response-already-bound',
  'broker-response-anchor-conflict', 'broker-anchor-invalid', 'broker-anchor-member-mismatch', 'broker-anchor-untrusted',
  'broker-process-invalid', 'broker-member-writer-exists', 'broker-member-join-required', 'broker-member-writer-live',
  'broker-barrier-observation-invalid', 'broker-barrier-incomplete',
  'broker-barrier-join-required', 'broker-barrier-writer-live', 'broker-barrier-outcome-mismatch', 'broker-barrier-sealed',
  'broker-barrier-invalid', 'broker-barrier-head-mismatch', 'broker-barrier-untrusted', 'broker-journal-invalid',
  'broker-journal-mismatch', 'broker-phase-mismatch', 'broker-evidence-invalid', 'broker-stopped', 'broker-operation-refused',
  'reconciliation-proof-member',
  // Issue 343 U5: the post-barrier successor generation and its typed owner operations.
  'broker-barrier-required', 'broker-successor-invalid', 'broker-evidence-changed', 'broker-operations-mismatch',
  'broker-operation-invalid', 'broker-operation-pending', 'broker-operation-not-pending', 'broker-operation-preimage-mismatch',
  'broker-operation-readback-mismatch', 'reconciliation-operation-drift']);
const liveBatch = new WeakSet();
// A cohort handle starts at most one broker: a second signer for the same cohort is refused.
const startedCohorts = new WeakSet();
function batchApi() { return require('./forge-execution-batch'); }
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function isRecord(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function frozen(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const item of Object.values(value)) frozen(item); }
  return value;
}
function signerEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name, value]) => SIGNER_ENV.includes(name.toUpperCase()) && typeof value === 'string'));
}
function durableExclusive(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { if (value !== null) fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
// A regular file read whole under a byte ceiling; null only when it does not exist.
function boundedBytes(file, max, code) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error && error.code === 'ENOENT') return null; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > max) fail(code);
  const value = fs.readFileSync(file);
  if (value.length > max) fail(code);
  return value;
}
function parsed(raw, code) { try { return JSON.parse(raw); } catch { return fail(code); } }
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return !!error && error.code === 'EPERM'; }
}
// The canonical renderer of a member line: ONE JSON object rendered by JSON.stringify plus one
// trailing newline. Raw text, other whitespace, a second line or a bare value is never signed.
function canonicalEvent(append) {
  if (!Buffer.isBuffer(append) || !append.length || append.length > MAX_LINE_BYTES) fail('broker-append-invalid');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(append); } catch { fail('broker-append-noncanonical'); }
  if (!text.endsWith('\n')) fail('broker-append-invalid');
  const event = parsed(text.slice(0, -1), 'broker-append-noncanonical');
  if (!isRecord(event) || typeof event.event !== 'string' || !event.event || `${JSON.stringify(event)}\n` !== text) fail('broker-append-noncanonical');
  return event;
}
// A member line names no other attempt: each identity field it carries is this member's, and a
// dispatch line carries the cohort fields the canonical builder stamps (forge-dispatch-event).
function memberEvent(append, manifest, member) {
  const event = canonicalEvent(append);
  const identity = { batch_id: manifest.batch_id, member_ref: member.member_ref, batch_size: manifest.members.length,
    unit: member.unit, dispatch_id: member.dispatch_id, milestone: member.milestone, slice: member.slice };
  for (const [key, value] of Object.entries(identity)) if (own(event, key) && event[key] !== value) fail('broker-member-identity-mismatch');
  if (event.event === 'dispatch' && !['batch_id', 'member_ref', 'batch_size', 'unit', 'dispatch_id'].every(key => own(event, key))) {
    fail('broker-member-identity-mismatch');
  }
  return event;
}
// The append core shared by both broker modes, inside the owner append lock: exact prefix and
// log identity, O_APPEND write with fsync, exact readback; `seal` signs only after it.
function appendLocked(manifest, rel, append, tail, inspect, seal) {
  const file = safeTarget(manifest.owner, rel);
  const guard = lock(manifest);
  try {
    const before = bytes(file);
    if (!before || before.length !== tail.length || digest(before) !== tail.sha256) fail('broker-prefix-drift');
    // Validate again inside the append lock; sign only after exact readback.
    safeTarget(manifest.owner, rel);
    const identity = fs.lstatSync(file, { bigint: true });
    if (logIdentity(file) !== tail.identity_sha256) fail('broker-log-replaced');
    const repeated = inspect(before);
    if (repeated) return repeated;
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.ino !== identity.ino || opened.dev !== identity.dev || opened.size !== BigInt(before.length)) fail('broker-file-raced');
      if (fs.writeSync(fd, append) !== append.length) fail('broker-short-write'); fs.fsyncSync(fd);
      const final = fs.lstatSync(file, { bigint: true });
      if (final.isSymbolicLink() || final.ino !== opened.ino || final.dev !== opened.dev) fail('broker-file-raced');
    } finally { fs.closeSync(fd); }
    const after = bytes(file), expected = Buffer.concat([before, append]);
    if (!after.equals(expected)) fail('broker-append-raced');
    return seal(before, after, tail);
  } finally { guard.release(); }
}
// Canonical identity events use the broker's existing atomic boundary.
// The closed event is data, never an imported caller capability.
function identityRepeat(rel, append, before) {
  let event;
  try { event = JSON.parse(append.toString('utf8')); } catch { /* Generic append. */ }
  if (rel === '.gsd/forge/events.jsonl' && event?.event === 'agent-identity') {
    const identityApi = require('./forge-agent-identity');
    if (identityApi.renderAgentIdentityEvent(event) !== append.toString('utf8')) fail('agent-identity-event-invalid');
    if (identityApi.identityAlreadyRecorded(before, event)) return { status: 'already-recorded' };
  }
  return null;
}

function assertBatchManifest(manifest) {
  if (!isRecord(manifest) || manifest.schema_version !== 2 || manifest.kind !== BATCH_KIND || typeof manifest.public_key !== 'string'
      || typeof manifest.owner !== 'string' || typeof manifest.batch_id !== 'string' || !Array.isArray(manifest.members) || !manifest.members.length
      || !Array.isArray(manifest.append_paths) || !manifest.append_paths.length || !isRecord(manifest.append_baselines)
      || !isRecord(manifest.surface) || manifest.append_paths.some(rel => !isRecord(manifest.append_baselines[rel]))) fail('reconciliation-proof-identity');
  const registry = new Map();
  manifest.members.forEach((member, index) => {
    if (!isRecord(member) || typeof member.member_ref !== 'string' || !MEMBER_REF.test(member.member_ref) || registry.has(member.member_ref)
        || !Number.isSafeInteger(member.member_index) || (index && member.member_index <= manifest.members[index - 1].member_index)) fail('reconciliation-proof-identity');
    registry.set(member.member_ref, member);
  });
  return registry;
}
function signedPayload(manifest, record, code) {
  if (!isRecord(record) || typeof record.signature !== 'string') fail(code);
  const { signature, ...payload } = record;
  let valid = false;
  try { valid = crypto.verify(null, Buffer.from(JSON.stringify(payload)), manifest.public_key, Buffer.from(signature, 'base64')); } catch { valid = false; }
  if (!valid) fail(code);
  return payload;
}
function verifyBatchProof(manifest, registry, proof) {
  const payload = signedPayload(manifest, proof, 'reconciliation-signature-invalid');
  if (payload.kind !== 'member-append' || payload.manifest_sha256 !== digest(manifest) || payload.batch_id !== manifest.batch_id) fail('reconciliation-proof-identity');
  const member = registry.get(payload.member_ref);
  if (!member || payload.dispatch_id !== member.dispatch_id || payload.request_sha256 !== member.request_sha256) fail('reconciliation-proof-member');
  if (!manifest.append_paths.includes(payload.path) || !Number.isSafeInteger(payload.start) || !Number.isSafeInteger(payload.end)
      || payload.start < 0 || payload.end <= payload.start) fail('reconciliation-proof-scope');
  return payload;
}
// The complete common stream: every proof of every member, in journal order, contiguous from
// the S0 baseline of each log to its end, plus the whole protected owner surface. A filter of
// one member's proofs leaves a sibling's bytes unproved and refuses.
function verifyBatchSurface(manifest, proofs, options = {}) {
  if (!options.manifest_sha256 || digest(manifest) !== options.manifest_sha256) fail('reconciliation-trust-anchor-required');
  const registry = assertBatchManifest(manifest);
  const owner = roots.realDirectory(manifest.owner);
  if (owner !== manifest.owner) fail('reconciliation-owner-changed');
  if (!Array.isArray(proofs)) fail('broker-journal-invalid');
  const rows = proofs.map(proof => verifyBatchProof(manifest, registry, proof));
  const snapshot = options.snapshot || require('./forge-task-execution').protectedSnapshot;
  const current = snapshot(owner), expected = { ...manifest.surface }, heads = {};
  for (const relative of manifest.append_paths) {
    const baseline = manifest.append_baselines[relative], stream = rows.filter(row => row.path === relative);
    const file = safeTarget(owner, relative), observed = bytes(file);
    if (observed === null || logIdentity(file) !== baseline.identity_sha256) fail('reconciliation-log-identity');
    let end = baseline.length, prefix = baseline.sha256;
    if (observed.length < end || digest(observed.subarray(0, end)) !== prefix) fail('reconciliation-prefix-changed');
    for (const [index, row] of stream.entries()) {
      if (row.sequence !== index + 1 || row.log_identity_sha256 !== baseline.identity_sha256) fail('reconciliation-proof-sequence');
      if (row.start !== end || row.prefix_sha256 !== prefix || row.end > observed.length) fail('reconciliation-span-invalid');
      if (digest(observed.subarray(row.start, row.end)) !== row.append_sha256
          || digest(observed.subarray(0, row.end)) !== row.result_sha256) fail('reconciliation-append-changed');
      end = row.end; prefix = row.result_sha256;
    }
    // Barrier heads remain the member-only heads. Typed owner tails never alter them.
    heads[relative] = { sequence: stream.length, length: end, sha256: prefix };
    const tail = verifyPostUnitTail(observed, relative, end, prefix, options.operations);
    if (tail.end !== observed.length) fail('reconciliation-unsigned-append');
    expected[relative] = prefix;
  }
  const observedSurface = digest(Object.entries(current).sort());
  const surfaceMatches = observedSurface === digest(Object.entries(expected).sort());
  // Issue 343 U5: after the barrier the surface is S0, every signed member append and every committed
  // typed owner operation, plus, for the one in-flight intent only, each effect's preimage or exact
  // post-image. Nothing is recaptured, ignored or allowlisted.
  let operationsMatch = surfaceMatches;
  if (options.operations) {
    const withOperations = { ...expected };
    try {
      applyOperations(withOperations, options.operations, current, owner);
      operationsMatch = observedSurface === digest(Object.entries(withOperations).sort());
    } catch (error) {
      if (options.surface !== 'report') throw error;
      operationsMatch = false;
    }
  }
  if (!(options.operations ? operationsMatch : surfaceMatches) && options.surface !== 'report') fail('reconciliation-unproved-drift');
  const members = Object.fromEntries(manifest.members.map(member => [member.member_ref,
    rows.filter(row => row.member_ref === member.member_ref).map(row => ({ path: row.path, sequence: row.sequence }))]));
  return { rows, heads, members, surface_matches: surfaceMatches, operations_match: operationsMatch, surface_sha256: digest(Object.entries(expected).sort()),
    observed_surface_sha256: observedSurface, current };
}
function verifyAnchor(manifest, registry, anchor) {
  const payload = signedPayload(manifest, anchor, 'broker-anchor-invalid');
  const member = registry.get(payload.member_ref);
  if (payload.kind !== 'member-response' || payload.manifest_sha256 !== digest(manifest) || payload.batch_id !== manifest.batch_id || !member
      || payload.member_index !== member.member_index || payload.task_id !== member.task_id || payload.dispatch_id !== member.dispatch_id
      || payload.request_sha256 !== member.request_sha256 || payload.plan_sha256 !== member.plan_sha256
      || payload.runtime_contract_sha256 !== member.runtime_contract_sha256
      || RETAINED_KEYS.some(key => typeof payload[key] !== 'string' || !HEX64.test(payload[key]))) fail('broker-anchor-invalid');
  if (payload.residual !== undefined) residualMetadata(payload.residual);
  return payload;
}
function verifyBarrier(manifest, record, rows, anchors) {
  const payload = signedPayload(manifest, record, 'broker-barrier-invalid');
  if (payload.kind !== 'execution-barrier' || payload.manifest_sha256 !== digest(manifest) || payload.batch_id !== manifest.batch_id
      || !Array.isArray(payload.members) || payload.members.length !== manifest.members.length || !isRecord(payload.heads)) fail('broker-barrier-invalid');
  payload.members.forEach((row, index) => {
    const member = manifest.members[index], anchor = anchors.get(member.member_ref);
    const neverStarted = row && row.writer_state === 'never-started';
    if (!isRecord(row) || row.member_ref !== member.member_ref || !OUTCOMES.includes(row.outcome)
        || (neverStarted ? Object.keys(row).sort().join(',') !== 'anchor_sha256,exit_code,member_ref,outcome,pid,reason_code,signal,writer_state'
          || row.pid !== null || row.exit_code !== null || row.signal !== null || ['retained','residual'].includes(row.outcome)
          || !['queue-cancelled','pre-spawn-refused','ENOENT','EACCES','ENOEXEC'].includes(row.reason_code)
          : !Number.isSafeInteger(row.pid) || row.pid <= 0 || row.writer_state !== undefined)
        || (['retained','residual'].includes(row.outcome)) !== !!anchor || row.anchor_sha256 !== (anchor ? digest(anchor) : null)
        || (row.outcome === 'residual' ? !anchor.residual || digest(residualMetadata(Object.fromEntries(['pending_questions','provider_called','reason','reason_code','result_status'].map(key=>[key,row[key]])))) !== digest(anchor.residual)
          : anchor?.residual !== undefined)) fail('broker-barrier-invalid');
  });
  for (const relative of manifest.append_paths) {
    const head = payload.heads[relative], stream = rows.filter(row => row.path === relative), last = stream[stream.length - 1];
    const baseline = manifest.append_baselines[relative];
    // No member line is signed after the barrier: its head is the end of the stream.
    if (!isRecord(head) || head.sequence !== stream.length || head.length !== (last ? last.end : baseline.length)
        || head.sha256 !== (last ? last.result_sha256 : baseline.sha256)) fail('broker-barrier-head-mismatch');
  }
  return payload;
}
function readJournal(file) {
  const raw = boundedBytes(file, MAX_EVIDENCE_BYTES, 'broker-journal-invalid');
  if (raw === null) fail('broker-journal-invalid');
  const text = raw.toString('utf8');
  if (text && !text.endsWith('\n')) fail('broker-journal-invalid');
  return text ? text.slice(0, -1).split('\n').map(line => parsed(line, 'broker-journal-invalid')) : [];
}
function anchorFile(directory, member) { return path.join(directory, 'anchors', `m${member.member_index}.json`); }
// The external evidence directory of one cohort: a real directory reached without a link,
// outside the owner and every root of the aggregate union (integration, member and retained),
// directly inside the cohort's own batch area.
function brokerDirectory(value, owner, cohort) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) fail('broker-directory-invalid');
  const resolved = path.resolve(value);
  let parent, area;
  try { parent = roots.realDirectory(path.dirname(resolved)); area = roots.realDirectory(cohort.batch_dir); } catch { fail('broker-directory-invalid'); }
  if (roots.key(parent) !== roots.key(path.dirname(resolved)) || !path.basename(resolved)) fail('broker-directory-invalid');
  const directory = path.join(parent, path.basename(resolved));
  for (const outer of [owner, ...cohort.union_roots]) {
    if (roots.within(outer, directory) || roots.within(directory, outer)) fail('broker-manifest-in-worker-surface');
  }
  if (roots.key(parent) !== roots.key(area)) fail('broker-directory-invalid');
  return directory;
}

/**
 * Start the cohort broker (forge-execution-batch openCohortBroker is its caller).
 *
 * @param batchHandle the live opaque cohort handle of forge-execution-batch
 * @param members     the live B2 member handles, exactly one per registered member
 * @param paths       { directory, appendPaths? } the cohort's external evidence directory
 * @returns the live broker client: appendMember, bindMemberResponse, attachMemberProcess,
 *          sealExecutionBarrier, verifyMember, memberIdentity, proofs, close
 */
async function startBatchBroker(batchHandle, members, paths = {}) {
  const batch = batchApi(), cohort = batch.resolveBrokerCohort(batchHandle);
  const owner = roots.realDirectory(cohort.owner);
  if (owner !== cohort.owner) fail('reconciliation-owner-changed');
  if (!Array.isArray(members) || members.length !== cohort.members.length || new Set(members).size !== members.length) fail('broker-member-registry-incomplete');
  const registered = new WeakMap(), refs = new Set();
  for (const handle of members) {
    const binding = batch.brokerMemberBinding(handle);
    const row = cohort.members.find(entry => entry.member_ref === binding.member_ref);
    if (!row || refs.has(row.member_ref)) fail('broker-member-foreign');
    refs.add(row.member_ref); registered.set(handle, row.member_ref);
  }
  if (refs.size !== cohort.members.length) fail('broker-member-registry-incomplete');
  const directory = brokerDirectory(isRecord(paths) ? paths.directory : undefined, owner, cohort);
  const appendPaths = isRecord(paths) && paths.appendPaths !== undefined ? paths.appendPaths : ['.gsd/forge/events.jsonl'];
  if (!Array.isArray(appendPaths) || !appendPaths.length || new Set(appendPaths).size !== appendPaths.length) fail('reconciliation-path-invalid');
  for (const rel of appendPaths) safeTarget(owner, rel);
  if (startedCohorts.has(batchHandle)) fail('broker-batch-already-started');
  startedCohorts.add(batchHandle);
  // The exclusive directory is the cohort's single broker slot: a second broker, a concurrent
  // start or an unreconciled earlier start is refused, never adopted.
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error && error.code === 'EEXIST') fail('broker-batch-already-started'); throw error; }
  const created = fs.lstatSync(directory);
  if (created.isSymbolicLink() || !created.isDirectory()) fail('broker-directory-invalid');
  for (const rel of appendPaths) {
    const file = safeTarget(owner, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, '', { flag: 'wx' });
  }
  // S0: the common protected snapshot every member verification starts from.
  const surface = require('./forge-task-execution').protectedSnapshot(owner);
  const data = { owner, lock_root: lockRoot(owner), batch_id: cohort.batch_id, batch_manifest_sha256: cohort.manifest_sha256,
    isolation_sha256: cohort.isolation_sha256, run_id: cohort.run_id, claim: copy(cohort.claim), members: copy(cohort.members),
    append_paths: [...appendPaths], append_baselines: logBaselines(owner, appendPaths), surface, nonce: crypto.randomUUID(),
    created_at: new Date().toISOString() };
  // No inherited environment, NODE_OPTIONS or execArgv (an inspector would expose the key).
  const { child, call } = signer({ env: signerEnvironment(), execArgv: [] });
  let manifest;
  try {
    manifest = await call('init-batch', data);
    const { schema_version: schema, kind, public_key: publicKey, ...signedData } = manifest;
    if (schema !== 2 || kind !== BATCH_KIND || typeof publicKey !== 'string' || digest(signedData) !== digest(data)) fail('broker-operation-refused');
    assertBatchManifest(manifest);
    durableExclusive(path.join(directory, 'manifest.json'), manifest);
    durableExclusive(path.join(directory, 'proofs.jsonl'), null);
    fs.mkdirSync(path.join(directory, 'anchors'), { mode: 0o700 });
  } catch (error) { if (child.connected) child.disconnect(); throw error; }
  const manifestSha = digest(manifest), registry = assertBatchManifest(manifest), journalFile = path.join(directory, 'proofs.jsonl');
  const proofs = [], anchors = new Map(), processes = new Map();
  let closed = false, sealing = false, sealed = null, queue = Promise.resolve();
  // One owner-side guard: every IPC operation and verification runs to its real finally before
  // the next starts, so a verification never observes a sibling append in flight. Operations
  // never call each other through it (no reacquisition of a held guard).
  const serial = operation => { const run = queue.then(operation); queue = run.then(() => undefined, () => undefined); return run; };
  // The broker binding of a registered member handle, cheaply revalidated against the live B2
  // handle (forge-execution-batch brokerMemberBinding) on every operation.
  const memberOf = handle => {
    const ref = handle !== null && typeof handle === 'object' ? registered.get(handle) : undefined;
    if (!ref) fail('broker-member-handle-required');
    if (batch.brokerMemberBinding(handle).member_ref !== ref) fail('broker-member-binding-changed');
    return registry.get(ref);
  };
  const writable = () => { if (closed) fail('broker-stopped'); if (sealed || sealing) fail('broker-barrier-sealed'); };
  const client = Object.freeze({
    manifest, manifest_sha256: manifestSha, directory,
    /** One canonical member line appended, fsynced, read back, signed and journaled. */
    appendMember(handle, relative, line) {
      return serial(async () => {
        const member = memberOf(handle);
        writable();
        if (typeof line !== 'string') fail('broker-append-invalid');
        const append = Buffer.from(line, 'utf8');
        if (append.toString('utf8') !== line) fail('broker-append-noncanonical');
        canonicalEvent(append);
        if (!manifest.append_paths.includes(relative)) fail('broker-path-not-authorized');
        const proof = await call('member-append', { member_ref: member.member_ref, path: relative, bytes: append.toString('base64') });
        if (proof.status === 'already-recorded') return { status: 'already-recorded' };
        const payload = verifyBatchProof(manifest, registry, proof), previous = proofs.filter(row => row.path === relative).pop();
        if (payload.member_ref !== member.member_ref || payload.sequence !== (previous ? previous.sequence : 0) + 1
            || payload.start !== (previous ? previous.end : manifest.append_baselines[relative].length)) fail('broker-proof-unexpected');
        const fd = fs.openSync(journalFile, 'a', 0o600);
        try { fs.writeFileSync(fd, `${JSON.stringify(proof)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        proofs.push(proof);
        return copy(proof);
      });
    },
    /**
     * The single immutable anchor of this member attempt's retained result (hashes only), bound
     * once its attached writer has really exited: nothing can still change what it anchors.
     */
    bindMemberResponse(handle, retainedRef) {
      return serial(async () => {
        const member = memberOf(handle);
        writable();
        if (!isRecord(retainedRef) || Object.keys(retainedRef).length !== RETAINED_KEYS.length + (retainedRef.residual === undefined ? 0 : 1)
            || RETAINED_KEYS.some(key => typeof retainedRef[key] !== 'string' || !HEX64.test(retainedRef[key]))) fail('broker-response-ref-invalid');
        const residual = retainedRef.residual === undefined ? null : residualMetadata(retainedRef.residual);
        const writer = processes.get(member.member_ref);
        if (!writer) fail('broker-member-join-required');
        if (!writer.exit || processAlive(writer.pid)) fail('broker-member-writer-live');
        const anchor = await call('member-response', { member_ref: member.member_ref, ...Object.fromEntries(RETAINED_KEYS.map(key => [key, retainedRef[key]])), ...(residual ? {residual} : {}) });
        if (verifyAnchor(manifest, registry, anchor).member_ref !== member.member_ref) fail('broker-anchor-invalid');
        const file = anchorFile(directory, member), existing = boundedBytes(file, MAX_LINE_BYTES, 'broker-response-anchor-conflict');
        if (existing !== null) { if (digest(parsed(existing, 'broker-response-anchor-conflict')) !== digest(anchor)) fail('broker-response-anchor-conflict'); }
        else durableExclusive(file, anchor);
        anchors.set(member.member_ref, anchor);
        return copy(anchor);
      });
    },
    /** The member's one writer process, attached at spawn; this broker observes its exit itself. */
    attachMemberProcess(handle, processHandle) {
      const member = memberOf(handle);
      writable();
      if (!(processHandle instanceof ChildProcess) || !Number.isSafeInteger(processHandle.pid) || processHandle.pid <= 0
          || processHandle.exitCode !== null || processHandle.signalCode !== null) fail('broker-process-invalid');
      if (processes.has(member.member_ref)) fail('broker-member-writer-exists');
      const observed = { pid: processHandle.pid, exit: null };
      processHandle.once('exit', (code, signal) => { observed.exit = { code, signal }; });
      processes.set(member.member_ref, observed);
      return Object.freeze({ member_ref: member.member_ref, pid: processHandle.pid });
    },
    // Only the lexical production spawn in the live member scope can register
    // a no-PID ChildProcess. Neither a JSON flag nor a fabricated child proves it.
    observeMemberSpawnFailure(handle, child) {
      const member = memberOf(handle), scope = batch.currentMemberProcessScope();
      writable();
      if (!(child instanceof ChildProcess) || child.pid || !scope || !scope.ownsSpawnAttempt(child)
          || processes.has(member.member_ref)) fail('broker-process-invalid');
      const observed = { pid: null, exit: null, writer_state: 'pending-spawn' };
      processes.set(member.member_ref, observed);
      child.once('error', error => {
        if (!child.pid && ['ENOENT','EACCES','ENOEXEC'].includes(error.code)) {
          observed.writer_state = 'never-started'; observed.reason_code = error.code;
        }
      });
    },
    closeMemberWithoutWriter(handle) {
      const member = memberOf(handle), scope = batch.currentMemberProcessScope();
      writable();
      if (!scope) fail('broker-member-no-start-unproven');
      const proof = scope.closeWithoutSpawn(handle), observed = processes.get(member.member_ref);
      if (observed && (observed.writer_state !== 'never-started' || observed.reason_code !== proof.reason_code)) fail('broker-member-no-start-unproven');
      processes.set(member.member_ref, { writer_state: 'never-started', pid: null, exit: null, reason_code: proof.reason_code });
      return Object.freeze({ member_ref: member.member_ref, writer_state: 'never-started' });
    },
    /** The execution barrier: every member joined (its attached process exited and is gone). */
    sealExecutionBarrier(handle, observations) {
      return serial(async () => {
        if (handle !== batchHandle) fail('broker-cohort-handle-required');
        batch.resolveBrokerCohort(handle);
        writable();
        if (!Array.isArray(observations) || observations.length !== manifest.members.length) fail('broker-barrier-incomplete');
        const outcomes = new Map();
        for (const observation of observations) {
          if (!isRecord(observation) || Object.keys(observation).sort().join(',') !== 'handle,outcome' || !OUTCOMES.includes(observation.outcome)) {
            fail('broker-barrier-observation-invalid');
          }
          const member = memberOf(observation.handle);
          if (outcomes.has(member.member_ref)) fail('broker-barrier-incomplete');
          // Join is what this broker observed: the attached process emitted exit and its pid is
          // gone. A worker report, a boolean or a plain object never stands in for it.
          const observed = processes.get(member.member_ref);
          if (!observed) fail('broker-barrier-join-required');
          if (observed.writer_state === 'never-started') {
            if (['retained','residual'].includes(observation.outcome) || anchors.has(member.member_ref)) fail('broker-barrier-outcome-mismatch');
            outcomes.set(member.member_ref, { member_ref: member.member_ref, outcome: observation.outcome,
              writer_state: 'never-started', reason_code: observed.reason_code, pid: null, exit_code: null, signal: null });
            continue;
          }
          if (!observed.exit || processAlive(observed.pid)) fail('broker-barrier-writer-live');
          if ((['retained','residual'].includes(observation.outcome)) !== anchors.has(member.member_ref)) fail('broker-barrier-outcome-mismatch');
          const anchor = anchors.get(member.member_ref);
          if ((observation.outcome === 'residual') !== !!anchor?.residual) fail('broker-barrier-outcome-mismatch');
          outcomes.set(member.member_ref, { member_ref: member.member_ref, outcome: observation.outcome, pid: observed.pid,
            ...(anchor?.residual ? residualMetadata(anchor.residual) : {}),
            exit_code: Number.isSafeInteger(observed.exit.code) ? observed.exit.code : null,
            signal: typeof observed.exit.signal === 'string' ? observed.exit.signal : null });
        }
        sealing = true;
        try {
          const record = await call('barrier', { members: manifest.members.map(member => outcomes.get(member.member_ref)), sealed_at: new Date().toISOString() });
          verifyBarrier(manifest, record, proofs.map(proof => verifyBatchProof(manifest, registry, proof)), anchors);
          durableExclusive(path.join(directory, 'barrier.json'), record);
          sealed = record;
          return copy(record);
        } finally { sealing = false; }
      });
    },
    /**
     * The member's live B2 binding (complete seam, revalidated now) plus ALL common proofs, the
     * owner journal and the protected owner surface; never a filter of this member's proofs.
     */
    verifyMember(handle, options = {}) {
      return serial(async () => {
        const member = memberOf(handle), phase = sealed ? 'sealed' : 'execution';
        if (isRecord(options) && options.phase !== undefined && options.phase !== phase) fail('broker-phase-mismatch');
        const journal = readJournal(journalFile);
        if (digest(journal) !== digest(proofs)) fail('broker-journal-mismatch');
        const verified = verifyBatchSurface(manifest, journal, { manifest_sha256: manifestSha });
        const live = batch.brokerMemberBinding(handle, { revalidate: true });
        if (live.member_ref !== member.member_ref) fail('broker-member-binding-changed');
        const anchor = anchors.get(member.member_ref) || null;
        return frozen({ passed: true, phase, member_ref: member.member_ref, member_index: member.member_index, task_id: member.task_id,
          sequences: verified.members[member.member_ref], proofs: journal.length, heads: verified.heads, journal_sha256: digest(journal),
          surface_sha256: verified.surface_sha256, anchor_sha256: anchor ? digest(anchor) : null,
          binding: { request_sha256: live.request_sha256, claim_generation: live.claim_generation, claim_sha256: live.claim_sha256,
            runtime_view_sha256: live.runtime_view_sha256 } });
      });
    },
    /** Public identity of a registered member for the canonical event builder: data, not authority. */
    memberIdentity(handle) {
      const member = memberOf(handle);
      return frozen({ batch_id: manifest.batch_id, batch_size: manifest.members.length, member_ref: member.member_ref, unit: member.unit,
        task_id: member.task_id, milestone: member.milestone, slice: member.slice, dispatch_id: member.dispatch_id, route: copy(member.route) });
    },
    proofs() { return copy(proofs); },
    close() {
      return serial(async () => {
        if (closed) return;
        closed = true;
        if (child.connected) { await call('close'); child.disconnect(); }
      });
    },
  });
  liveBatch.add(client);
  return client;
}
function assertBatchBroker(value) { if (!liveBatch.has(value)) fail('broker-batch-handle-required'); return value; }

/**
 * Read-only cohort evidence for replay, status and route audit, without any live handle: the
 * manifest trusted only through its independently retained SHA-256, the complete signed stream
 * and owner journal, every signed anchor (independently retained hashes when supplied) and the
 * barrier. Integrity failures refuse; owner drift outside the logs is reported as a fact.
 *
 * @param {{ directory, manifest_sha256, anchors?: { [member_ref]: sha256 }, barrier_sha256?, snapshot? }} options
 */
function readBatchEvidence(options = {}) {
  if (!isRecord(options) || typeof options.directory !== 'string' || !path.isAbsolute(options.directory)) fail('broker-evidence-invalid');
  let directory;
  try { directory = roots.realDirectory(options.directory); } catch { fail('broker-evidence-invalid'); }
  if (roots.key(directory) !== roots.key(path.resolve(options.directory))) fail('broker-evidence-invalid');
  const evidence = loadCohortEvidence(directory, options.manifest_sha256, { snapshot: options.snapshot, barrier_sha256: options.barrier_sha256 });
  const { manifest, journal, anchors, streams: verified, barrier, barrier_sha256: barrierSha, operations } = evidence;
  if (options.anchors !== undefined) {
    if (!isRecord(options.anchors)) fail('broker-anchor-untrusted');
    const trusted = Object.entries(options.anchors);
    if (trusted.length !== anchors.size || trusted.some(([ref, sha]) => !anchors.has(ref) || digest(anchors.get(ref)) !== sha)) fail('broker-anchor-untrusted');
  }
  // Issue 343 U5: the typed owner operations after the barrier, reported as facts (S0 itself never moves).
  const withOperations = operations.entries.length ? verifyBatchSurface(manifest, journal, { manifest_sha256: options.manifest_sha256,
    surface: 'report', snapshot: options.snapshot, operations: operationView(operations) }).operations_match : verified.surface_matches;
  return frozen({ schema_version: 2, kind: BATCH_KIND, batch_id: manifest.batch_id, manifest_sha256: options.manifest_sha256,
    batch_manifest_sha256: manifest.batch_manifest_sha256, run_id: manifest.run_id, stream: 'verified', proofs: journal.length,
    journal_sha256: digest(journal), heads: verified.heads,
    surface: { matches_s0: verified.surface_matches, matches_operations: withOperations, observed_surface_sha256: verified.observed_surface_sha256 },
    members: manifest.members.map((member, index) => {
      const anchor = anchors.get(member.member_ref);
      return { member_ref: member.member_ref, member_index: member.member_index, task_id: member.task_id, unit: member.unit,
        ...(barrier?.members[index].outcome === 'residual' ? residualMetadata(Object.fromEntries(['pending_questions','provider_called','reason','reason_code','result_status'].map(key=>[key,barrier.members[index][key]]))) : {}),
        dispatch_id: member.dispatch_id, sequences: verified.members[member.member_ref],
        anchor: anchor ? { sha256: digest(anchor), response_sha256: anchor.response_sha256, executed_sha256: anchor.executed_sha256,
          seal_sha256: anchor.seal_sha256, trust: options.anchors === undefined ? 'signed' : 'anchored' } : null,
        outcome: barrier ? barrier.members[index].outcome : null,
        process: barrier ? { pid: barrier.members[index].pid, exit_code: barrier.members[index].exit_code, signal: barrier.members[index].signal,
          ...(barrier.members[index].writer_state === 'never-started' ? {writer_state:'never-started',reason_code:barrier.members[index].reason_code} : {}) } : null };
    }),
    generations: evidence.generations.map(row => ({ generation: row.generation, sha256: row.sha256 })),
    operations: { committed: operations.committed.length, pending: operations.pending ? operations.pending.sequence : null,
      head_sha256: operations.head.sha256, entries: operations.entries.map(entry => ({ sequence: entry.sequence, species: entry.payload.species,
        member_ref: entry.payload.member_ref, committed: entry.commit !== null })) },
    barrier: barrier ? { sealed: true, sha256: barrierSha, sealed_at: barrier.sealed_at } : { sealed: false } });
}

// ── Post-barrier owner operations (issue 343 U5, B5) ──────────────────────────
//
// After the barrier every legitimate owner change of a cohort is ONE typed owner operation of a
// closed species, signed by a successor generation of the cohort broker: a new signing child bound to
// the sealed root evidence (manifest digest the caller retained, the barrier and the operation head),
// since the root key died with its child and is never rebuilt from JSON. An intent names, before the
// first effect, the exact effects (owner path, preimage digest or absence, exact post-image digest,
// absence, or the controller's logical STATE checksum) and the producer data needed to replay them;
// the commit is signed only after the readback of every effect. At most one intent is in flight. The
// owner surface is S0 plus every signed member append plus every committed operation and, for the
// in-flight intent only, each effect path at its preimage or its exact post-image: an edited byte in
// .gsd, events, an empty directory or a controller file refuses. Nothing is recaptured or ignored.
//
// Evidence layout (the root broker directory, outside the owner and every root of the union):
//   successors/g<N>.json                  generation N's public manifest (the root is generation 1)
//   ops/<NNNN>.intent.json|.commit.json   the operation journal, one contiguous sequence
const OPERATION_SPECIES = Object.freeze(['member-artifacts', 'controller-terminal', 'batch-progress', 'claim-mutation', 'post-unit']);
const SUCCESSOR_KIND = 'forge-batch-broker-successor';
const MAX_OPERATIONS = 512;
const MAX_EFFECTS = 64;
const MAX_OPERATION_BYTES = 256 * 1024;
const MAX_GENERATIONS = 64;
const OPERATION_NAME = /^(\d{4})\.(intent|commit)\.json$/;
const SUCCESSOR_NAME = /^g(\d{1,3})\.json$/;
function pad4(value) { return String(value).padStart(4, '0'); }
function lstatOrNull(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error && error.code === 'ENOENT') return null; throw error; }
}
// Read the one typed retirement producer from the authenticated journal. This
// is historical evidence, never a capability to reopen a terminal cohort.
function readBatchRetirement(options = {}) {
  if (!isRecord(options) || typeof options.directory !== 'string' || !path.isAbsolute(options.directory)) fail('broker-evidence-invalid');
  const directory = roots.realDirectory(options.directory);
  if (roots.key(directory) !== roots.key(path.resolve(options.directory))) fail('broker-evidence-invalid');
  const evidence = loadCohortEvidence(directory, options.manifest_sha256, { barrier_sha256: options.barrier_sha256 });
  const entries = evidence.operations.entries.filter(entry => entry.payload.species === 'claim-mutation'
    && entry.payload.producer?.name === 'forge-execution-batch.retire');
  if (entries.length > 1) fail('broker-operation-invalid');
  if (!entries.length) return null;
  const entry = entries[0];
  return frozen(copy({ sequence: entry.sequence, committed: entry.commit !== null,
    producer: entry.payload.producer, effects: entry.payload.effects,
    operations: { committed: evidence.operations.committed.length, pending: evidence.operations.pending?.sequence || null,
      head_sha256: evidence.operations.head.sha256 } }));
}
// The lexical grammar safeTarget enforces, without touching the file system.
function ownerRelative(value) {
  if (typeof value !== 'string' || !value.startsWith('.gsd/') || value.includes('\\') || value.includes('\0')
      || value.split('/').some(part => !part || part === '.' || part === '..')) fail('broker-operation-invalid');
  return value;
}
// '.gsd/a/b.json' -> ['.gsd/', '.gsd/a/'] (the directory spelling of protectedSnapshot).
function ancestorsOf(relative) {
  const parts = relative.split('/'), dirs = [];
  for (let index = 1; index < parts.length; index++) dirs.push(`${parts.slice(0, index).join('/')}/`);
  return dirs;
}
function validHead(value) {
  return isRecord(value) && Object.keys(value).sort().join(',') === 'sequence,sha256' && Number.isSafeInteger(value.sequence)
    && value.sequence >= 0 && value.sequence <= MAX_OPERATIONS && typeof value.sha256 === 'string' && HEX64.test(value.sha256);
}
function validPending(value) {
  return value === null || (isRecord(value) && Object.keys(value).sort().join(',') === 'intent_sha256,sequence'
    && Number.isSafeInteger(value.sequence) && value.sequence >= 1 && typeof value.intent_sha256 === 'string' && HEX64.test(value.intent_sha256));
}
// The closed effect shape of an intent: unique owner paths outside the signed append logs.
// Only this typed post-unit producer may extend the global event stream. Its
// descriptor is signed before append and every byte remains part of the stream.
function postUnitAppends(operation) {
  if (operation?.species !== 'post-unit') return [];
  const p = operation.producer;
  if (!isRecord(p) || p.name !== 'forge-execution-batch.post-unit' || !Array.isArray(p.appends) || p.appends.length > 2) fail('broker-operation-invalid');
  const seen = new Set();
  for (const a of p.appends) {
    if (!isRecord(a) || Object.keys(a).sort().join(',') !== 'after_length,after_sha256,append_sha256,before_length,before_sha256,path'
        || a.path !== '.gsd/forge/events.jsonl' || seen.has(a.path)
        || !Number.isSafeInteger(a.before_length) || a.before_length < 0
        || !Number.isSafeInteger(a.after_length) || a.after_length <= a.before_length || a.after_length - a.before_length > 8192
        || ![a.before_sha256,a.append_sha256,a.after_sha256].every(value => typeof value === 'string' && HEX64.test(value))) fail('broker-operation-invalid');
    seen.add(a.path);
  }
  return p.appends;
}
function verifyPostUnitTail(observed, relative, end, prefix, operations) {
  for (const entry of operations?.committed || []) {
    for (const a of postUnitAppends(entry.intent)) if (a.path === relative) {
      if (a.before_length !== end || a.before_sha256 !== prefix || a.after_length > observed.length) fail('reconciliation-span-invalid');
      checkPostUnitBytes(observed, a, entry.intent.producer);
      end = a.after_length; prefix = a.after_sha256;
    }
  }
  const pending = operations?.pending;
  for (const a of postUnitAppends(pending)) if (a.path === relative) {
    if (a.before_length !== end || a.before_sha256 !== prefix) fail('reconciliation-span-invalid');
    if (observed.length === a.before_length && digest(observed) === a.before_sha256) continue;
    checkPostUnitBytes(observed, a, pending.producer);
    end = a.after_length; prefix = a.after_sha256;
  }
  return { end, prefix };
}
function checkPostUnitBytes(observed, a, producer) {
  if (a.after_length > observed.length || digest(observed.subarray(0,a.before_length)) !== a.before_sha256
      || digest(observed.subarray(a.before_length,a.after_length)) !== a.append_sha256
      || digest(observed.subarray(0,a.after_length)) !== a.after_sha256) fail('reconciliation-append-changed');
  const text = observed.subarray(a.before_length,a.after_length).toString('utf8');
  if (!text.endsWith('\n')) fail('broker-operation-invalid');
  const lines = text.slice(0,-1).split('\n');
  if (!lines.length || lines.length > 2) fail('broker-operation-invalid');
  for (const line of lines) {
    const event = parsed(Buffer.from(line), 'broker-operation-invalid');
    if (!['memory-policy','memory-publication'].includes(event.event) || event.post_unit_key !== producer.key
        || event.batch_id !== producer.batch_id || event.member_index !== producer.member_index
        || typeof event.event_id !== 'string' || !event.event_id.startsWith(producer.key + ':')) fail('broker-operation-invalid');
  }
}
function checkEffects(effects, appendPaths, operation) {
  if (!Array.isArray(effects) || !effects.length || effects.length > MAX_EFFECTS) fail('broker-operation-invalid');
  const seen = new Set();
  return effects.map(effect => {
    if (!isRecord(effect) || Object.keys(effect).sort().join(',') !== 'after,before,path') fail('broker-operation-invalid');
    const directory = operation?.species === 'post-unit' && operation.producer?.name === 'forge-execution-batch.post-unit'
      && ['.gsd/forge/file-locks/','.gsd/memory/.locks/'].includes(effect.path) && effect.after?.directory === true;
    const relative = directory ? ownerRelative(effect.path.slice(0,-1)) + '/' : ownerRelative(effect.path);
    const append = postUnitAppends(operation).find(row => row.path === relative);
    if (seen.has(relative) || (appendPaths.includes(relative) && !append)) fail('broker-operation-invalid');
    if (append && (effect.before !== append.before_sha256 || effect.after?.sha256 !== append.after_sha256)) fail('broker-operation-invalid');
    seen.add(relative);
    if (effect.before !== null && (typeof effect.before !== 'string' || !HEX64.test(effect.before))) fail('broker-operation-invalid');
    const after = effect.after;
    if (after !== null) {
      const keys = isRecord(after) ? Object.keys(after).join(',') : '';
      if (keys === 'sha256') {
        if (typeof after.sha256 !== 'string' || !HEX64.test(after.sha256)) fail('broker-operation-invalid');

      } else if (!(directory && keys === 'directory')) fail('broker-operation-invalid');
    }
    return { path: relative, before: effect.before, after: after === null ? null : copy(after) };
  });
}
// The readback of a commit: one row per effect, in order, each exactly the intent's byte post-image.
function checkReadback(effects, readback) {
  if (!Array.isArray(readback) || readback.length !== effects.length) fail('broker-operation-readback-mismatch');
  return readback.map((row, index) => {
    const effect = effects[index];
    const wanted = effect.after?.directory === true ? 'directory' : effect.after?.sha256 ?? null;
    if (!isRecord(row) || Object.keys(row).sort().join(',') !== 'path,sha256' || row.path !== effect.path
        || (row.sha256 !== null && row.sha256 !== wanted && (typeof row.sha256 !== 'string' || !HEX64.test(row.sha256)))) fail('broker-operation-readback-mismatch');
    if (row.sha256 !== wanted) {
      fail('broker-operation-readback-mismatch');
    }
    return { path: row.path, sha256: row.sha256 };
  });
}
function applyOperations(expected, operations, current, owner) {
  for (const entry of operations.committed) {
    for (const row of entry.commit.readback) {
      if (row.sha256 === null) delete expected[row.path];
      else {
        expected[row.path] = row.sha256;
        for (const dir of ancestorsOf(row.path)) expected[dir] = 'directory';
      }
    }
  }
  const pending = operations.pending;
  if (!pending) return;
  for (const effect of pending.effects) {
    const now = own(current, effect.path) ? current[effect.path] : null;
    const atAfter = effect.after === null ? now === null : now === (effect.after.directory === true ? 'directory' : effect.after.sha256);
    if (now === 'directory' && effect.after?.directory !== true || (now !== effect.before && !atAfter)) fail('reconciliation-operation-drift');
    if (now === null) delete expected[effect.path];
    else expected[effect.path] = now;
    if (effect.after !== null) for (const dir of ancestorsOf(effect.path)) if (current[dir] === 'directory') expected[dir] = 'directory';
  }
}
function operationView(operations) {
  return { committed: operations.committed, pending: operations.pending ? operations.pending.payload : null };
}
// Generation 1 is the root broker; successors/g2.. each name their predecessor, the root, the
// barrier and the operation head (and the in-flight intent) they were created over.
function readGenerations(directory, root, rootSha, barrierSha) {
  const generations = [{ generation: 1, manifest: root, sha256: rootSha, ops_head: null, pending: null }];
  const folder = path.join(directory, 'successors'), stat = lstatOrNull(folder);
  if (!stat) return generations;
  if (stat.isSymbolicLink() || !stat.isDirectory() || !barrierSha) fail('broker-successor-invalid');
  const names = fs.readdirSync(folder).map(name => {
    const match = SUCCESSOR_NAME.exec(name);
    if (!match) fail('broker-successor-invalid');
    return { name, generation: Number(match[1]) };
  }).sort((left, right) => left.generation - right.generation);
  if (names.length > MAX_GENERATIONS) fail('broker-successor-invalid');
  for (const [index, entry] of names.entries()) {
    const previous = generations[generations.length - 1];
    const record = parsed(boundedBytes(path.join(folder, entry.name), MAX_LINE_BYTES, 'broker-successor-invalid'), 'broker-successor-invalid');
    if (entry.generation !== index + 2 || !isRecord(record) || record.schema_version !== 2 || record.kind !== SUCCESSOR_KIND
        || record.root_manifest_sha256 !== rootSha || record.generation !== entry.generation || record.predecessor_sha256 !== previous.sha256
        || record.batch_id !== root.batch_id || record.barrier_sha256 !== barrierSha || typeof record.owner !== 'string'
        || roots.key(record.owner) !== roots.key(root.owner) || typeof record.public_key !== 'string' || !validHead(record.ops_head)
        || !validPending(record.pending) || (record.pending && record.pending.sequence !== record.ops_head.sequence + 1)
        || (previous.ops_head && record.ops_head.sequence < previous.ops_head.sequence)
        || JSON.stringify(record.append_paths) !== JSON.stringify(root.append_paths)
        || JSON.stringify(record.members) !== JSON.stringify(root.members.map(member => member.member_ref))) fail('broker-successor-invalid');
    generations.push({ generation: entry.generation, manifest: record, sha256: digest(record), ops_head: record.ops_head, pending: record.pending });
  }
  return generations;
}
// A record signed by successor generation `index`: that generation existed before this sequence and
// the next generation (if any) was created over it (an intent may still be in flight there).
function signerOf(generations, payload, sequence, kind) {
  const index = generations.findIndex(row => row.sha256 === payload.signer_sha256);
  if (index < 1) fail('broker-operations-mismatch');
  const signer = generations[index], next = generations[index + 1];
  if (signer.ops_head.sequence >= sequence || (kind === 'intent' && signer.pending && signer.pending.sequence === sequence)) fail('broker-operations-mismatch');
  if (next && next.ops_head.sequence < sequence && !(kind === 'intent' && next.pending && next.pending.sequence === sequence)) fail('broker-operations-mismatch');
  return signer;
}
function verifyIntentRecord(root, rootSha, registry, generations, record, sequence, head) {
  if (!isRecord(record) || typeof record.signer_sha256 !== 'string') fail('broker-operations-mismatch');
  const signer = signerOf(generations, record, sequence, 'intent');
  const payload = signedPayload(signer.manifest, record, 'broker-operations-mismatch');
  if (payload.kind !== 'owner-intent' || payload.root_manifest_sha256 !== rootSha || payload.batch_id !== root.batch_id
      || payload.sequence !== sequence || payload.previous_sha256 !== head.sha256 || !OPERATION_SPECIES.includes(payload.species)
      || (payload.member_ref !== null && !registry.has(payload.member_ref)) || !isRecord(payload.producer)
      || typeof payload.prepared_at !== 'string') fail('broker-operations-mismatch');
  return { ...payload, effects: checkEffects(payload.effects, root.append_paths, payload) };
}
function verifyCommitRecord(root, rootSha, generations, record, intentPayload, intentSha, sequence) {
  if (!isRecord(record) || typeof record.signer_sha256 !== 'string') fail('broker-operations-mismatch');
  const signer = signerOf(generations, record, sequence, 'commit');
  const payload = signedPayload(signer.manifest, record, 'broker-operations-mismatch');
  if (payload.kind !== 'owner-commit' || payload.root_manifest_sha256 !== rootSha || payload.batch_id !== root.batch_id
      || payload.sequence !== sequence || payload.intent_sha256 !== intentSha || typeof payload.committed_at !== 'string') fail('broker-operations-mismatch');
  return { ...payload, readback: checkReadback(intentPayload.effects, payload.readback) };
}
// The operation journal: one contiguous sequence from 1, every intent chained to the previous commit
// (the first to the barrier), at most one uncommitted intent (the last), no stray file.
function readOperations(directory, root, rootSha, registry, generations, barrierSha) {
  const folder = path.join(directory, 'ops'), stat = lstatOrNull(folder);
  const empty = { entries: [], committed: [], pending: null, head: { sequence: 0, sha256: barrierSha || '0'.repeat(64) } };
  if (!stat) return empty;
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('broker-operations-mismatch');
  if (!barrierSha) fail('broker-barrier-required');
  const names = new Set(fs.readdirSync(folder));
  for (const name of names) if (!OPERATION_NAME.test(name)) fail('broker-operations-mismatch');
  const entries = [], committed = [];
  let head = { sequence: 0, sha256: barrierSha }, pending = null;
  for (let sequence = 1; names.has(`${pad4(sequence)}.intent.json`); sequence++) {
    if (sequence > MAX_OPERATIONS || pending) fail('broker-operations-mismatch');
    const intent = parsed(boundedBytes(path.join(folder, `${pad4(sequence)}.intent.json`), MAX_OPERATION_BYTES, 'broker-operations-mismatch'),
      'broker-operations-mismatch');
    const payload = verifyIntentRecord(root, rootSha, registry, generations, intent, sequence, head);
    const intentSha = digest(intent), commitName = `${pad4(sequence)}.commit.json`;
    let commit = null, commitPayload = null;
    if (names.has(commitName)) {
      commit = parsed(boundedBytes(path.join(folder, commitName), MAX_OPERATION_BYTES, 'broker-operations-mismatch'), 'broker-operations-mismatch');
      commitPayload = verifyCommitRecord(root, rootSha, generations, commit, payload, intentSha, sequence);
      head = { sequence, sha256: digest(commit) };
      committed.push({ sequence, intent: payload, commit: commitPayload });
    } else pending = { sequence, record: intent, payload, intent_sha256: intentSha };
    entries.push({ sequence, intent, payload, commit, commitPayload });
  }
  if (names.size !== entries.length * 2 - (pending ? 1 : 0)) fail('broker-operations-mismatch');
  // Every successor was created over a real committed head of this journal (and its real in-flight intent).
  for (const generation of generations.slice(1)) {
    const at = generation.ops_head.sequence;
    if (at > head.sequence) fail('broker-operations-mismatch');
    if ((at === 0 ? barrierSha : digest(entries[at - 1].commit)) !== generation.ops_head.sha256) fail('broker-operations-mismatch');
    if (generation.pending && (!entries[generation.pending.sequence - 1]
        || digest(entries[generation.pending.sequence - 1].intent) !== generation.pending.intent_sha256)) fail('broker-operations-mismatch');
  }
  return { entries, committed, pending, head };
}
// Every sealed record of one cohort, verified: the root manifest through the digest the caller
// retained, the complete signed stream, the anchors, the barrier, the successor generations and the
// owner operation journal. The owner surface is compared by the callers.
function loadCohortRecords(directory, trustedSha, options = {}) {
  const manifestBytes = boundedBytes(path.join(directory, 'manifest.json'), MAX_EVIDENCE_BYTES, 'broker-evidence-invalid');
  if (manifestBytes === null) fail('broker-evidence-invalid');
  const manifest = parsed(manifestBytes, 'broker-evidence-invalid');
  if (typeof trustedSha !== 'string' || digest(manifest) !== trustedSha) fail('reconciliation-trust-anchor-required');
  const registry = assertBatchManifest(manifest);
  const journal = readJournal(path.join(directory, 'proofs.jsonl'));
  const memberRows = journal.map(proof => verifyBatchProof(manifest, registry, proof));
  const folder = path.join(directory, 'anchors'), folderStat = fs.existsSync(folder) ? fs.lstatSync(folder) : null;
  if (!folderStat || folderStat.isSymbolicLink() || !folderStat.isDirectory()) fail('broker-evidence-invalid');
  const byName = new Map(manifest.members.map(member => [`m${member.member_index}.json`, member])), anchors = new Map();
  for (const name of fs.readdirSync(folder).sort()) {
    const member = byName.get(name);
    if (!member) fail('broker-anchor-invalid');
    const anchor = parsed(boundedBytes(path.join(folder, name), MAX_LINE_BYTES, 'broker-anchor-invalid'), 'broker-anchor-invalid');
    if (verifyAnchor(manifest, registry, anchor).member_ref !== member.member_ref) fail('broker-anchor-member-mismatch');
    anchors.set(member.member_ref, anchor);
  }
  const barrierBytes = boundedBytes(path.join(directory, 'barrier.json'), MAX_LINE_BYTES, 'broker-barrier-invalid');
  let barrier = null, barrierSha = null;
  if (barrierBytes !== null) {
    const record = parsed(barrierBytes, 'broker-barrier-invalid');
    barrierSha = digest(record);
    if (options.barrier_sha256 !== undefined && barrierSha !== options.barrier_sha256) fail('broker-barrier-untrusted');
    barrier = verifyBarrier(manifest, record, memberRows, anchors);
  } else if (options.barrier_sha256 !== undefined) fail('broker-barrier-untrusted');
  const generations = readGenerations(directory, manifest, trustedSha, barrierSha);
  const operations = readOperations(directory, manifest, trustedSha, registry, generations, barrierSha);
  return { manifest, registry, journal, anchors, barrier, barrier_sha256: barrierSha, generations, operations };
}
function loadCohortEvidence(directory, trustedSha, options = {}) {
  const records = loadCohortRecords(directory, trustedSha, options);
  const streams = verifyBatchSurface(records.manifest, records.journal, { manifest_sha256: trustedSha, surface: 'report', snapshot: options.snapshot,
    operations: operationView(records.operations) });
  return { ...records, streams };
}
// A closed cohort has no writer authority. Historical reads verify its complete
// signed chain and immutable final producer; they never accept a new owner
// operation or claim that the current owner still equals the old S0 boundary.
function readBatchClosedHistory(options = {}) {
  if (!isRecord(options) || typeof options.directory !== 'string' || !path.isAbsolute(options.directory)) fail('broker-evidence-invalid');
  const directory = roots.realDirectory(options.directory);
  if (roots.key(directory) !== roots.key(path.resolve(options.directory))) fail('broker-evidence-invalid');
  const data = loadCohortRecords(directory, options.manifest_sha256);
  const finished = data.operations.entries.filter(entry => entry.payload.species === 'post-unit'
    && entry.payload.producer?.name === 'forge-execution-batch.post-unit' && entry.payload.producer.kind === 'final');
  if (!finished.length) return null;
  if (finished.length !== 1 || data.operations.pending || !finished[0].commit || finished[0] !== data.operations.entries.at(-1)) fail('broker-operation-invalid');
  const retired = data.operations.entries.filter(entry => entry.payload.species === 'claim-mutation'
    && entry.payload.producer?.name === 'forge-execution-batch.retire');
  if (retired.length !== 1 || !retired[0].commit || retired[0].sequence >= finished[0].sequence) fail('broker-operation-invalid');
  const p = finished[0].payload.producer, row = retired[0].payload.producer.row;
  if (!data.barrier || p.batch_id !== data.manifest.batch_id || p.retirement_id !== row.retirement_id
      || p.key !== row.retirement_id + ':post-unit-complete' || p.ledger?.retirement_id !== row.retirement_id
      || p.ledger.members?.length !== data.manifest.members.length) fail('broker-operation-invalid');
  const finalEffect = finished[0].payload.effects.find(effect => effect.path === p.relative);
  const finalBytes = boundedBytes(safeTarget(data.manifest.owner,p.relative), MAX_OPERATION_BYTES,'broker-operation-invalid');
  if (!finalBytes || digest(finalBytes) !== finalEffect?.after?.sha256 || digest(finalBytes) !== digest(Buffer.from(JSON.stringify(p.ledger)+'\n'))) fail('broker-operation-invalid');
  const ledgers = p.ledger.members.map((ref,index) => {
    if (ref.member_index !== index || ref.file !== '.gsd/forge/batches/' + p.batch_id + '/post-unit/m' + index + '.json') fail('broker-operation-invalid');
    const raw = boundedBytes(safeTarget(data.manifest.owner,ref.file),MAX_OPERATION_BYTES,'broker-operation-invalid');
    const ledger = parsed(raw,'broker-operation-invalid');
    if (!raw || digest(raw) !== ref.sha256 || ledger.status !== 'complete' || ledger.key !== row.post_unit[index]?.key) fail('broker-operation-invalid');
    const op = data.operations.entries.findLast(entry => entry.sequence < finished[0].sequence && entry.payload.species === 'post-unit'
      && entry.payload.producer?.kind === 'member' && entry.payload.producer.member_index === index);
    const effect = op?.payload.effects.find(item => item.path === ref.file);
    if (!op?.commit || effect?.after?.sha256 !== ref.sha256) fail('broker-operation-invalid');
    return ledger;
  });
  const retire = retired[0];
  return frozen(copy({ historical_only: true, retirement: { sequence: retire.sequence, committed:true,
    producer: retire.payload.producer, effects: retire.payload.effects,
    operations:{ committed:data.operations.committed.length,pending:null,head_sha256:data.operations.head.sha256 } },
    evidence:{ manifest_sha256:options.manifest_sha256, batch_id:data.manifest.batch_id,
      batch_manifest_sha256:data.manifest.batch_manifest_sha256,run_id:data.manifest.run_id },
    post_unit:{ status:'complete',members:ledgers } }));
}
function readBatchPostUnitComplete(options) { return readBatchClosedHistory(options)?.post_unit || null; }
// Signature-bound retained response data for historical lineage consumers.
// No owner-surface assertion, writer handle, lease or publication permission is
// minted by this read. Callers separately require the committed ACK/retirement.
function readBatchRetainedResult(options = {}) {
  if(!isRecord(options)||!path.isAbsolute(options.directory||''))fail('broker-evidence-invalid');
  const directory=roots.realDirectory(options.directory);
  if(roots.key(directory)!==roots.key(path.resolve(options.directory)))fail('broker-evidence-invalid');
  const data=loadCohortRecords(directory,options.manifest_sha256),member=data.manifest.members.find(row=>row.member_index===options.member_index);
  const anchor=member&&data.anchors.get(member.member_ref),outcome=member&&data.barrier?.members.find(row=>row.member_ref===member.member_ref);
  if(!member||!anchor||!outcome||!['retained','residual'].includes(outcome.outcome))fail('broker-anchor-invalid');
  const file=path.join(path.dirname(directory),'retained',member.member_ref+'.executed.json');
  const raw=boundedBytes(file,32*1024*1024,'broker-anchor-invalid');
  if(!raw||digest(raw)!==anchor.executed_sha256)fail('broker-anchor-invalid');
  return frozen(copy({historical_only:true,member,anchor,outcome,executed_file:file,executed:parsed(raw,'broker-anchor-invalid')}));
}
// A sha256 of every regular file of the evidence directory (one level of subdirectories): the
// successor compares it before every operation, so any edited, added or removed byte refuses.
function evidenceFiles(directory) {
  const files = {};
  const walk = (dir, prefix) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.lstatSync(file), relative = prefix ? `${prefix}/${name}` : name;
      if (stat.isSymbolicLink()) fail('broker-evidence-changed');
      if (stat.isDirectory()) {
        if (prefix) fail('broker-evidence-changed');
        walk(file, relative);
      } else if (stat.isFile() && stat.size <= MAX_EVIDENCE_BYTES) files[relative] = digest(fs.readFileSync(file));
      else fail('broker-evidence-changed');
    }
  };
  walk(directory, '');
  return files;
}
function ensureRealDirectory(directory) {
  let stat = lstatOrNull(directory);
  if (!stat) {
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (!error || error.code !== 'EEXIST') throw error; }
    stat = fs.lstatSync(directory);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('broker-directory-invalid');
  return directory;
}
// The cohort's existing single broker slot: a real directory directly in its batch area, outside the
// owner and every root of the aggregate union.
function existingBrokerDirectory(value, owner, cohort) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) fail('broker-directory-invalid');
  let directory, area;
  try { directory = roots.realDirectory(value); area = roots.realDirectory(cohort.batch_dir); } catch { fail('broker-directory-invalid'); }
  if (roots.key(directory) !== roots.key(path.resolve(value)) || roots.key(path.dirname(directory)) !== roots.key(area)) fail('broker-directory-invalid');
  if (fs.lstatSync(directory).isSymbolicLink()) fail('broker-directory-invalid');
  for (const outer of [owner, ...cohort.union_roots]) {
    if (roots.within(outer, directory) || roots.within(directory, outer)) fail('broker-manifest-in-worker-surface');
  }
  return directory;
}

/**
 * Issue 343 U5: a successor signing generation of a cohort broker whose barrier is sealed (the
 * serial consolidation of forge-execution-batch is its caller, in-process or in a fresh process). The
 * root evidence is verified through the root manifest digest the caller retained; the whole owner
 * surface must already be exactly that evidence's (the in-flight intent at its preimage or exact
 * post-image). A new key is born in a new child, its public manifest is published once
 * (successors/g<N>.json) and it signs only typed owner operations: no member line, anchor or barrier.
 *
 * @param batchHandle a live cohort handle of forge-execution-batch (the consolidation's)
 * @param members     live, request-bound member handles of registered members (a subset)
 * @param paths       { directory, manifest_sha256, barrier_sha256? } the root slot and its trust anchors
 */
async function resumeBatchBroker(batchHandle, members, paths = {}) {
  const observation = { spawned: false };
  try { return await resumeBatchBrokerInside(batchHandle, members, paths, observation); }
  catch (error) {
    if (!observation.spawned) error.cleanup = { status: 'not-started', active_processes: 0, spawned: false };
    throw error;
  }
}
async function resumeBatchBrokerInside(batchHandle, members, paths, observation) {
  const batch = batchApi(), cohort = batch.resolveBrokerCohort(batchHandle);
  const owner = roots.realDirectory(cohort.owner);
  if (owner !== cohort.owner) fail('reconciliation-owner-changed');
  if (!isRecord(paths) || typeof paths.manifest_sha256 !== 'string' || !HEX64.test(paths.manifest_sha256)) fail('reconciliation-trust-anchor-required');
  const directory = existingBrokerDirectory(paths.directory, owner, cohort);
  if (startedCohorts.has(batchHandle)) fail('broker-batch-already-started');
  const rootSha = paths.manifest_sha256;
  const evidence = loadCohortEvidence(directory, rootSha, paths.barrier_sha256 !== undefined ? { barrier_sha256: paths.barrier_sha256 } : {});
  const root = evidence.manifest;
  if (root.batch_id !== cohort.batch_id || root.batch_manifest_sha256 !== cohort.manifest_sha256 || root.isolation_sha256 !== cohort.isolation_sha256
      || root.run_id !== cohort.run_id || digest(root.claim) !== digest(cohort.claim) || roots.key(root.owner) !== roots.key(owner)) fail('broker-member-foreign');
  if (!evidence.barrier) fail('broker-barrier-required');
  if (!Array.isArray(members) || new Set(members).size !== members.length || members.length > evidence.registry.size) fail('broker-member-registry-incomplete');
  const registered = new WeakMap(), refs = new Set();
  for (const handle of members) {
    const binding = batch.brokerMemberBinding(handle);
    const row = evidence.registry.get(binding.member_ref);
    if (!row || refs.has(row.member_ref) || row.dispatch_id !== binding.dispatch_id || row.request_sha256 !== binding.request_sha256) fail('broker-member-foreign');
    refs.add(row.member_ref); registered.set(handle, row.member_ref);
  }
  // Nothing changed the owner beyond the sealed evidence: S0, the signed lines and the operations.
  verifyBatchSurface(root, evidence.journal, { manifest_sha256: rootSha, operations: operationView(evidence.operations) });
  startedCohorts.add(batchHandle);
  const previous = evidence.generations[evidence.generations.length - 1], generation = previous.generation + 1;
  if (generation > MAX_GENERATIONS + 1) fail('broker-successor-invalid');
  const successorsDir = ensureRealDirectory(path.join(directory, 'successors'));
  const opsDir = ensureRealDirectory(path.join(directory, 'ops'));
  const inflight = evidence.operations.pending;
  const data = { owner, lock_root: lockRoot(owner), batch_id: root.batch_id, root_manifest_sha256: rootSha, generation,
    predecessor_sha256: previous.sha256, barrier_sha256: evidence.barrier_sha256, append_paths: [...root.append_paths],
    members: root.members.map(member => member.member_ref), ops_head: copy(evidence.operations.head),
    pending: inflight ? { sequence: inflight.sequence, intent_sha256: inflight.intent_sha256 } : null,
    created_at: new Date().toISOString(), nonce: crypto.randomUUID() };
  // No inherited environment, NODE_OPTIONS or execArgv (an inspector would expose the key).
  const { child, call, joined } = signer({ env: signerEnvironment(), execArgv: [] });
  observation.spawned = true;
  let manifest;
  try {
    manifest = await call('init-successor', data);
    const { schema_version: schema, kind, public_key: publicKey, ...signedData } = manifest;
    if (schema !== 2 || kind !== SUCCESSOR_KIND || typeof publicKey !== 'string' || digest(signedData) !== digest(data)) fail('broker-operation-refused');
    durableExclusive(path.join(successorsDir, `g${generation}.json`), manifest);
  } catch (error) {
    if (child.connected) child.disconnect();
    error.cleanup = await joined;
    throw error;
  }
  const generations = [...evidence.generations, { generation, manifest, sha256: digest(manifest), ops_head: data.ops_head, pending: data.pending }];
  const state = { files: evidenceFiles(directory), committed: [...evidence.operations.committed], head: copy(evidence.operations.head),
    pending: inflight ? { sequence: inflight.sequence, record: inflight.record, payload: inflight.payload, intent_sha256: inflight.intent_sha256 } : null };
  let closed = false, queue = Promise.resolve();
  const serial = operation => { const run = queue.then(operation); queue = run.then(() => undefined, () => undefined); return run; };
  const memberOf = handle => {
    const ref = handle !== null && typeof handle === 'object' ? registered.get(handle) : undefined;
    if (!ref) fail('broker-member-handle-required');
    if (batch.brokerMemberBinding(handle).member_ref !== ref) fail('broker-member-binding-changed');
    return evidence.registry.get(ref);
  };
  const assertCohort = handle => {
    if (handle !== batchHandle) fail('broker-cohort-handle-required');
    batch.resolveBrokerCohort(handle);
  };
  // Every evidence byte is the one verified (plus this generation's own records), then the whole surface.
  const verifyNow = () => {
    if (closed) fail('broker-stopped');
    const files = evidenceFiles(directory);
    if (digest(Object.entries(files).sort()) !== digest(Object.entries(state.files).sort())) fail('broker-evidence-changed');
    return verifyBatchSurface(root, evidence.journal, { manifest_sha256: rootSha,
      operations: { committed: state.committed, pending: state.pending ? state.pending.payload : null } });
  };
  const writeRecord = (name, record) => {
    durableExclusive(path.join(opsDir, name), record);
    state.files[`ops/${name}`] = digest(fs.readFileSync(path.join(opsDir, name)));
  };
  const sealed = async () => fail('broker-barrier-sealed');
  const client = Object.freeze({
    manifest: root, manifest_sha256: rootSha, directory, generation, signer_sha256: digest(manifest),
    appendMember: sealed, bindMemberResponse: sealed, sealExecutionBarrier: sealed,
    attachMemberProcess() { return fail('broker-barrier-sealed'); },
    /** The member's live B2 binding plus ALL sealed evidence, the operation journal and the whole owner surface. */
    verifyMember(handle, options = {}) {
      return serial(async () => {
        const member = memberOf(handle);
        if (isRecord(options) && options.phase !== undefined && options.phase !== 'sealed') fail('broker-phase-mismatch');
        const verified = verifyNow();
        const live = batch.brokerMemberBinding(handle, { revalidate: true });
        if (live.member_ref !== member.member_ref) fail('broker-member-binding-changed');
        const anchor = evidence.anchors.get(member.member_ref) || null;
        return frozen({ passed: true, phase: 'sealed', member_ref: member.member_ref, member_index: member.member_index, task_id: member.task_id,
          sequences: verified.members[member.member_ref], proofs: evidence.journal.length, heads: verified.heads,
          journal_sha256: digest(evidence.journal), surface_sha256: verified.surface_sha256, anchor_sha256: anchor ? digest(anchor) : null,
          operations: { committed: state.committed.length, pending: state.pending ? state.pending.sequence : null, head_sha256: state.head.sha256 },
          binding: { request_sha256: live.request_sha256, claim_generation: live.claim_generation, claim_sha256: live.claim_sha256,
            runtime_view_sha256: live.runtime_view_sha256 } });
      });
    },
    memberIdentity(handle) {
      const member = memberOf(handle);
      return frozen({ batch_id: root.batch_id, batch_size: root.members.length, member_ref: member.member_ref, unit: member.unit,
        task_id: member.task_id, milestone: member.milestone, slice: member.slice, dispatch_id: member.dispatch_id, route: copy(member.route) });
    },
    proofs() { return copy(evidence.journal); },
    /** Synchronous: the same verification, for a canonical publisher already inside its owner lock. */
    assertOwnerSurface() { verifyNow(); return true; },
    /** The in-flight intent (signed record and payload), or null. */
    pendingOperation() {
      return state.pending ? frozen(copy({ sequence: state.pending.sequence, intent_sha256: state.pending.intent_sha256,
        record: state.pending.record, payload: state.pending.payload })) : null;
    },
    /** The committed member-artifacts effects on one owner path, in commit order: { before, after }. */
    publishedEffects(relative) {
      const chain = [];
      for (const entry of state.committed) {
        if (entry.intent.species !== 'member-artifacts') continue;
        const index = entry.intent.effects.findIndex(effect => effect.path === relative);
        if (index >= 0) chain.push({ before: entry.intent.effects[index].before, after: entry.commit.readback[index].sha256 });
      }
      return frozen(copy(chain));
    },
    operations() {
      return frozen(copy({ generation, committed: state.committed.map(entry => ({ sequence: entry.sequence, species: entry.intent.species,
        member_ref: entry.intent.member_ref })), pending: state.pending ? state.pending.sequence : null, head: state.head }));
    },
    /** The signed intent of one typed owner operation, before its first effect (exact preimages now). */
    beginOwnerOperation(handle, operation) {
      return serial(async () => {
        assertCohort(handle);
        if (state.pending) fail('broker-operation-pending');
        const verified = verifyNow();
        if (!isRecord(operation) || !OPERATION_SPECIES.includes(operation.species) || !isRecord(operation.producer)
            || (operation.member_ref !== null && !evidence.registry.has(operation.member_ref)) || typeof operation.prepared_at !== 'string'
            || Buffer.byteLength(JSON.stringify(operation.producer)) > MAX_OPERATION_BYTES / 2) fail('broker-operation-invalid');
        const effects = checkEffects(operation.effects, root.append_paths, operation);
        for (const effect of effects) {
          const now = own(verified.current, effect.path) ? verified.current[effect.path] : null;
          if (now === 'directory' || now !== effect.before) fail('broker-operation-preimage-mismatch');
        }
        const intent = await call('owner-intent', { species: operation.species, member_ref: operation.member_ref, producer: operation.producer,
          effects, prepared_at: operation.prepared_at });
        const payload = verifyIntentRecord(root, rootSha, evidence.registry, generations, intent, state.head.sequence + 1, state.head);
        writeRecord(`${pad4(payload.sequence)}.intent.json`, intent);
        state.pending = { sequence: payload.sequence, record: intent, payload, intent_sha256: digest(intent) };
        return copy(intent);
      });
    },
    /** The signed commit of the in-flight operation, after the readback of every one of its effects. */
    commitOwnerOperation(handle, intent) {
      return serial(async () => {
        assertCohort(handle);
        if (!state.pending || !isRecord(intent) || digest(intent) !== state.pending.intent_sha256) fail('broker-operation-not-pending');
        const verified = verifyNow();
        const readback = state.pending.payload.effects.map(effect => {
          const now = own(verified.current, effect.path) ? verified.current[effect.path] : null;
          const exact = effect.after === null ? now === null : now === (effect.after.directory === true ? 'directory' : effect.after.sha256);
          if (now === 'directory' && effect.after?.directory !== true || !exact) fail('broker-operation-readback-mismatch');
          return { path: effect.path, sha256: now };
        });
        const commit = await call('owner-commit', { intent: state.pending.record, readback, committed_at: new Date().toISOString() });
        const payload = verifyCommitRecord(root, rootSha, generations, commit, state.pending.payload, state.pending.intent_sha256, state.pending.sequence);
        writeRecord(`${pad4(payload.sequence)}.commit.json`, commit);
        state.committed.push({ sequence: payload.sequence, intent: state.pending.payload, commit: payload });
        state.head = { sequence: payload.sequence, sha256: digest(commit) };
        state.pending = null;
        return copy(commit);
      });
    },
    close() {
      return serial(async () => {
        if (closed) return joined;
        closed = true;
        let failure;
        try { if (child.connected) await call('close'); } catch (error) { failure = error; }
        finally { if (child.connected) child.disconnect(); }
        const cleanup = await joined;
        if (failure) { failure.cleanup = cleanup; throw failure; }
        return cleanup;
      });
    },
  });
  liveBatch.add(client);
  return client;
}

module.exports = { startBroker, assertBroker, verifyProof, verifySurface, inspectCandidate, reconcile, safeTarget, lock, withOwnerLock,
  BATCH_BROKER_REFUSALS, startBatchBroker, assertBatchBroker, readBatchEvidence, readBatchRetirement, readBatchClosedHistory, readBatchPostUnitComplete, readBatchRetainedResult,
  // Issue 343 U5: the post-barrier successor generation and its closed typed owner operations.
  OPERATION_SPECIES, resumeBatchBroker };
if (require.main === module && process.argv[2] === '--broker' && process.send) {
  let manifest, manifestSha, members, privateKey, responseAnchor, barrier = null, operationHead = null, operationPending = null;
  let successorLock; // Held by the actual signer until process death; canonical recovery proves death.
  const tails = {}, memberAnchors = new Map();
  const sign = payload => ({ ...payload, signature: crypto.sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64') });
  process.on('message', message => {
    try {
      let result;
      if (message.op === 'init' && !manifest) {
        const pair = crypto.generateKeyPairSync('ed25519'); privateKey = pair.privateKey;
        manifest = { schema_version: 1, ...message.data, public_key: pair.publicKey.export({ type: 'spki', format: 'pem' }) };
        for (const [rel, baseline] of Object.entries(manifest.append_baselines)) tails[rel] = { ...baseline };
        result = manifest;
      } else if (message.op === 'init-batch' && !manifest) {
        const pair = crypto.generateKeyPairSync('ed25519');
        const candidate = { schema_version: 2, kind: BATCH_KIND, ...message.data, public_key: pair.publicKey.export({ type: 'spki', format: 'pem' }) };
        const registry = assertBatchManifest(candidate);
        privateKey = pair.privateKey; manifest = candidate; manifestSha = digest(manifest); members = registry;
        for (const rel of manifest.append_paths) tails[rel] = { ...manifest.append_baselines[rel] };
        result = manifest;
      } else if (message.op === 'response' && manifest && manifest.schema_version === 1) {
        if (!/^[a-f0-9]{64}$/.test(message.data.response_sha256)) fail('broker-response-hash-invalid');
        if (responseAnchor && responseAnchor.response_sha256 !== message.data.response_sha256) fail('broker-response-already-bound');
        if (!responseAnchor) {
          const payload = { kind: 'saved-response', manifest_sha256: digest(manifest), dispatch_id: manifest.dispatch_id,
            request_sha256: manifest.request_sha256, response_sha256: message.data.response_sha256 };
          responseAnchor = sign(payload);
        }
        result = responseAnchor;
      } else if (message.op === 'append' && manifest && manifest.schema_version === 1) {
        const rel = message.data.path;
        if (!manifest.append_paths.includes(rel)) fail('broker-path-not-authorized');
        const append = Buffer.from(message.data.bytes, 'base64');
        result = appendLocked(manifest, rel, append, tails[rel], before => identityRepeat(rel, append, before), (before, after, tail) => {
          const payload = { manifest_sha256: digest(manifest), dispatch_id: manifest.dispatch_id, path: rel,
            sequence: tail.sequence + 1, log_identity_sha256: tail.identity_sha256,
            start: before.length, end: after.length, prefix_sha256: digest(before), append_sha256: digest(append), result_sha256: digest(after) };
          tails[rel] = { ...tail, length: after.length, sha256: payload.result_sha256, sequence: payload.sequence };
          return sign(payload);
        });
      } else if (message.op === 'member-append' && manifest && manifest.schema_version === 2) {
        if (barrier) fail('broker-barrier-sealed');
        const member = members.get(message.data.member_ref);
        if (!member) fail('broker-member-not-registered');
        const rel = message.data.path;
        if (!manifest.append_paths.includes(rel)) fail('broker-path-not-authorized');
        const append = Buffer.from(String(message.data.bytes), 'base64');
        memberEvent(append, manifest, member);
        result = appendLocked(manifest, rel, append, tails[rel], before => identityRepeat(rel, append, before), (before, after, tail) => {
          // One global sequence per log across every member of the cohort.
          const payload = { kind: 'member-append', manifest_sha256: manifestSha, batch_id: manifest.batch_id, member_ref: member.member_ref,
            dispatch_id: member.dispatch_id, request_sha256: member.request_sha256, path: rel, sequence: tail.sequence + 1,
            log_identity_sha256: tail.identity_sha256, start: before.length, end: after.length, prefix_sha256: digest(before),
            append_sha256: digest(append), result_sha256: digest(after) };
          tails[rel] = { ...tail, length: after.length, sha256: payload.result_sha256, sequence: payload.sequence };
          return sign(payload);
        });
      } else if (message.op === 'member-response' && manifest && manifest.schema_version === 2) {
        if (barrier) fail('broker-barrier-sealed');
        const member = members.get(message.data.member_ref);
        if (!member) fail('broker-member-not-registered');
        if (RETAINED_KEYS.some(key => typeof message.data[key] !== 'string' || !HEX64.test(message.data[key]))) fail('broker-response-hash-invalid');
        // One immutable anchor per member attempt: broker-response-already-bound still holds.
        const prior = memberAnchors.get(member.member_ref);
        if (prior && (RETAINED_KEYS.some(key => prior[key] !== message.data[key]) || digest(prior.residual || null) !== digest(message.data.residual || null))) fail('broker-response-already-bound');
        if (!prior) {
          memberAnchors.set(member.member_ref, sign({ kind: 'member-response', manifest_sha256: manifestSha, batch_id: manifest.batch_id,
            member_ref: member.member_ref, member_index: member.member_index, task_id: member.task_id, dispatch_id: member.dispatch_id,
            request_sha256: member.request_sha256, plan_sha256: member.plan_sha256, runtime_contract_sha256: member.runtime_contract_sha256,
            ...Object.fromEntries(RETAINED_KEYS.map(key => [key, message.data[key]])),
            ...(message.data.residual === undefined ? {} : {residual:residualMetadata(message.data.residual)}) }));
        }
        result = memberAnchors.get(member.member_ref);
      } else if (message.op === 'barrier' && manifest && manifest.schema_version === 2) {
        if (barrier) fail('broker-barrier-sealed');
        const rows = message.data.members;
        if (!Array.isArray(rows) || rows.length !== manifest.members.length
            || typeof message.data.sealed_at !== 'string' || !Number.isFinite(Date.parse(message.data.sealed_at))) fail('broker-barrier-incomplete');
        const outcomes = manifest.members.map((member, index) => {
          const row = rows[index], anchor = memberAnchors.get(member.member_ref);
          const neverStarted = row && row.writer_state === 'never-started';
          if (!isRecord(row) || row.member_ref !== member.member_ref || !OUTCOMES.includes(row.outcome)
              || (neverStarted ? Object.keys(row).sort().join(',') !== 'exit_code,member_ref,outcome,pid,reason_code,signal,writer_state'
                || row.pid !== null || row.exit_code !== null || row.signal !== null || ['retained','residual'].includes(row.outcome)
                || !['queue-cancelled','pre-spawn-refused','ENOENT','EACCES','ENOEXEC'].includes(row.reason_code)
                : !Number.isSafeInteger(row.pid) || row.pid <= 0 || row.writer_state !== undefined)) {
            fail('broker-barrier-incomplete');
          }
          if ((['retained','residual'].includes(row.outcome)) !== !!anchor || (row.outcome === 'residual') !== !!anchor?.residual) fail('broker-barrier-outcome-mismatch');
          if (anchor?.residual && digest(residualMetadata(Object.fromEntries(['pending_questions','provider_called','reason','reason_code','result_status'].map(key=>[key,row[key]])))) !== digest(anchor.residual)) fail('broker-barrier-outcome-mismatch');
          return { member_ref: member.member_ref, outcome: row.outcome, pid: row.pid,
            ...(neverStarted ? { writer_state: 'never-started', reason_code: row.reason_code } : {}),
            ...(anchor?.residual ? residualMetadata(anchor.residual) : {}),
            exit_code: Number.isSafeInteger(row.exit_code) ? row.exit_code : null, signal: typeof row.signal === 'string' ? row.signal : null,
            anchor_sha256: anchor ? digest(anchor) : null };
        });
        barrier = sign({ kind: 'execution-barrier', manifest_sha256: manifestSha, batch_id: manifest.batch_id, members: outcomes,
          heads: Object.fromEntries(manifest.append_paths.map(rel => [rel, { sequence: tails[rel].sequence, length: tails[rel].length, sha256: tails[rel].sha256 }])),
          sealed_at: message.data.sealed_at });
        result = barrier;
      } else if (message.op === 'init-successor' && !manifest) {
        // Issue 343 U5: a successor generation signs only typed owner operations after the sealed barrier.
        const data = message.data;
        if (!isRecord(data) || !validHead(data.ops_head) || !validPending(data.pending) || !HEX64.test(String(data.barrier_sha256))
            || !HEX64.test(String(data.root_manifest_sha256)) || !Array.isArray(data.append_paths) || !Array.isArray(data.members)
            || (data.pending && data.pending.sequence !== data.ops_head.sequence + 1)) fail('broker-successor-invalid');
        if (data.lock_root !== lockRoot(data.owner)) fail('reconciliation-lock-identity');
        fs.mkdirSync(path.join(data.lock_root, '.gsd'), { recursive: true });
        successorLock = require('./forge-lock').acquireProcessSync(data.lock_root,
          'batch-signer-' + digest(data.batch_id), { retries: 1 });
        const pair = crypto.generateKeyPairSync('ed25519');
        privateKey = pair.privateKey;
        manifest = { schema_version: 2, kind: SUCCESSOR_KIND, ...data, public_key: pair.publicKey.export({ type: 'spki', format: 'pem' }) };
        manifestSha = digest(manifest);
        // The member window is closed for good: no member line, anchor or barrier is ever signed here.
        barrier = { sealed: true };
        operationHead = { ...data.ops_head };
        operationPending = data.pending ? { ...data.pending } : null;
        result = manifest;
      } else if (message.op === 'owner-intent' && manifest && manifest.kind === SUCCESSOR_KIND) {
        // One typed owner operation at a time, chained to the previous commit (the first to the barrier).
        const data = message.data;
        if (operationPending) fail('broker-operation-pending');
        if (!isRecord(data) || !OPERATION_SPECIES.includes(data.species) || !isRecord(data.producer) || typeof data.prepared_at !== 'string'
            || (data.member_ref !== null && !manifest.members.includes(data.member_ref))) fail('broker-operation-invalid');
        const effects = checkEffects(data.effects, manifest.append_paths, data);
        const intent = sign({ kind: 'owner-intent', root_manifest_sha256: manifest.root_manifest_sha256, signer_sha256: manifestSha,
          batch_id: manifest.batch_id, sequence: operationHead.sequence + 1, previous_sha256: operationHead.sha256, species: data.species,
          member_ref: data.member_ref, producer: data.producer, effects, prepared_at: data.prepared_at });
        operationPending = { sequence: intent.sequence, intent_sha256: digest(intent) };
        result = intent;
      } else if (message.op === 'owner-commit' && manifest && manifest.kind === SUCCESSOR_KIND) {
        // Signed only over the in-flight intent and a readback that is exactly its post-images.
        const data = message.data;
        if (!operationPending || !isRecord(data) || !isRecord(data.intent) || digest(data.intent) !== operationPending.intent_sha256
            || data.intent.sequence !== operationPending.sequence || typeof data.committed_at !== 'string') fail('broker-operation-not-pending');
        const readback = checkReadback(checkEffects(data.intent.effects, manifest.append_paths, data.intent), data.readback);
        const commit = sign({ kind: 'owner-commit', root_manifest_sha256: manifest.root_manifest_sha256, signer_sha256: manifestSha,
          batch_id: manifest.batch_id, sequence: operationPending.sequence, intent_sha256: operationPending.intent_sha256, readback,
          committed_at: data.committed_at });
        operationHead = { sequence: commit.sequence, sha256: digest(commit) };
        operationPending = null;
        result = commit;
      } else if (message.op === 'close') { privateKey = undefined; result = { closed: true }; }
      else fail('broker-operation-refused');
      process.send({ id: message.id, result });
    } catch (e) { process.send({ id: message.id, error: e.code || e.message }); }
  });
  process.on('disconnect', () => process.exit(0));
}
