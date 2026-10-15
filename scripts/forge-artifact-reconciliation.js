#!/usr/bin/env node
'use strict';

// Trusted caller IPC only. The signing key is born in the broker and never
// serialized. The worker gets neither a signing API nor the parent's IPC fd.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fork } = require('child_process');
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
function lock(manifest) {
  // The canonical mutex lives in the trusted transport directory, outside the
  // protected owner. Both appends and publication take the same attempt lock.
  const directory = lockRoot(manifest.owner);
  if (manifest.lock_root && manifest.lock_root !== directory) fail('reconciliation-lock-identity');
  fs.mkdirSync(path.join(directory, '.gsd'), { recursive: true });
  const handle = require('./forge-lock').acquireSync(directory, 'publication',
    { retries: 1, allowStaleRecovery: false });
  const guard = Object.freeze({ release() { heldLocks.delete(guard); return handle.release(); } });
  heldLocks.set(guard, manifest.owner);
  return guard;
}
function withOwnerLock(owner, callback, guard) {
  owner = roots.realDirectory(owner);
  if (guard !== undefined) {
    if (heldLocks.get(guard) !== owner) fail('reconciliation-lock-handle-required');
    return callback();
  }
  const acquired = lock({ owner });
  try { return callback(); } finally { acquired.release(); }
}
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

async function startBroker(options) {
  const owner = roots.realDirectory(options.owner);
  const manifestFile = path.resolve(options.manifestFile);
  // Public material lives in the trusted result channel, outside every writable
  // surface. Trust is the hash retained in the caller, never a path from output.
  if (roots.within(owner, manifestFile) || options.execution_contract?.code_roots.some(r => roots.within(r.path, manifestFile))) fail('broker-manifest-in-worker-surface');
  const appendPaths = options.appendPaths || ['.gsd/forge/events.jsonl'];
  for (const rel of appendPaths) {
    const file = safeTarget(owner, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, '', { flag: 'wx' });
  }
  const surface = require('./forge-task-execution').protectedSnapshot(owner);
  const baselines = Object.fromEntries(appendPaths.map(rel => { const file = safeTarget(owner, rel), b = bytes(file);
    return [rel, { length: b.length, sha256: digest(b), identity_sha256: logIdentity(file), sequence: 0 }]; }));
  const child = fork(__filename, ['--broker'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, env: { ...process.env } });
  let sequence = 0; const pending = new Map();
  child.on('message', message => { const p = pending.get(message.id); if (!p) return; pending.delete(message.id); clearTimeout(p.timer);
    message.error ? p.reject(Object.assign(new Error(message.error), { code: message.error })) : p.resolve(message.result); });
  child.on('exit', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('broker-stopped')); } pending.clear(); });
  const call = (op, data) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('broker-ipc-timeout')); }, 15000);
    pending.set(id, { resolve, reject, timer }); child.send({ id, op, data });
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
async function reconcile(options) {
  const originalBytes = bytes(options.receiptFile);
  if (!originalBytes) fail('reconciliation-receipt-missing');
  const original = JSON.parse(originalBytes);
  if (original.phase !== 'failed' || !original.saved_candidate) fail('reconciliation-saved-response-required');
  const anchor = options.trust;
  if (!anchor || anchor.manifest_sha256 !== digest(options.manifest)
      || original.broker_manifest_sha256 !== anchor.manifest_sha256
      || anchor.request_sha256 !== original.fingerprint || options.manifest.request_sha256 !== original.fingerprint) fail('reconciliation-request-mismatch');
  const responseHash = digest(original.saved_candidate.result);
  if (original.saved_candidate.sha256 !== responseHash) fail('reconciliation-response-changed');
  // The receipt and its adjacent hash are untrusted together. Require the
  // broker's independently signed, single-response binding from before refusal.
  const responseAnchorBytes = bytes(`${options.receiptFile}.response-anchor.json`);
  if (!responseAnchorBytes) fail('reconciliation-response-anchor-required');
  const { signature, ...responseAnchor } = JSON.parse(responseAnchorBytes);
  if (responseAnchor.kind !== 'saved-response' || responseAnchor.manifest_sha256 !== anchor.manifest_sha256
      || responseAnchor.dispatch_id !== options.manifest.dispatch_id
      || responseAnchor.request_sha256 !== original.fingerprint
      || responseAnchor.response_sha256 !== responseHash
      || !signature || !crypto.verify(null, Buffer.from(JSON.stringify(responseAnchor)), options.manifest.public_key,
        Buffer.from(signature, 'base64'))) fail('reconciliation-response-anchor-invalid');
  if (original.saved_candidate.plan_sha256 !== (options.manifest.plan_sha256 || null)) fail('reconciliation-plan-mismatch');
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

module.exports = { startBroker, assertBroker, verifyProof, verifySurface, reconcile, safeTarget, lock, withOwnerLock };
if (require.main === module && process.argv[2] === '--broker' && process.send) {
  let manifest, privateKey, responseAnchor; const tails = {};
  process.on('message', message => {
    try {
      let result;
      if (message.op === 'init' && !manifest) {
        const pair = crypto.generateKeyPairSync('ed25519'); privateKey = pair.privateKey;
        manifest = { schema_version: 1, ...message.data, public_key: pair.publicKey.export({ type: 'spki', format: 'pem' }) };
        for (const [rel, baseline] of Object.entries(manifest.append_baselines)) tails[rel] = { ...baseline };
        result = manifest;
      } else if (message.op === 'response' && manifest) {
        if (!/^[a-f0-9]{64}$/.test(message.data.response_sha256)) fail('broker-response-hash-invalid');
        if (responseAnchor && responseAnchor.response_sha256 !== message.data.response_sha256) fail('broker-response-already-bound');
        if (!responseAnchor) {
          const payload = { kind: 'saved-response', manifest_sha256: digest(manifest), dispatch_id: manifest.dispatch_id,
            request_sha256: manifest.request_sha256, response_sha256: message.data.response_sha256 };
          responseAnchor = { ...payload, signature: crypto.sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64') };
        }
        result = responseAnchor;
      } else if (message.op === 'append' && manifest) {
        const rel = message.data.path;
        if (!manifest.append_paths.includes(rel)) fail('broker-path-not-authorized');
        const file = safeTarget(manifest.owner, rel), append = Buffer.from(message.data.bytes, 'base64');
        const guard = lock(manifest);
        try {
          const before = bytes(file), tail = tails[rel];
          if (!before || before.length !== tail.length || digest(before) !== tail.sha256) fail('broker-prefix-drift');
          // Validate again inside the append lock; sign only after exact readback.
          safeTarget(manifest.owner, rel);
          const identity = fs.lstatSync(file, { bigint: true });
          if (logIdentity(file) !== tail.identity_sha256) fail('broker-log-replaced');
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
          const payload = { manifest_sha256: digest(manifest), dispatch_id: manifest.dispatch_id, path: rel,
            sequence: tail.sequence + 1, log_identity_sha256: tail.identity_sha256,
            start: before.length, end: after.length, prefix_sha256: digest(before), append_sha256: digest(append), result_sha256: digest(after) };
          tails[rel] = { ...tail, length: after.length, sha256: payload.result_sha256, sequence: payload.sequence };
          result = { ...payload, signature: crypto.sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64') };
        } finally { guard.release(); }
      } else if (message.op === 'close') { privateKey = undefined; result = { closed: true }; }
      else fail('broker-operation-refused');
      process.send({ id: message.id, result });
    } catch (e) { process.send({ id: message.id, error: e.code || e.message }); }
  });
  process.on('disconnect', () => process.exit(0));
}
