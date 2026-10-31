'use strict';

// Private evidence and same-owner-process continuation only. Persisted bytes,
// their embedded public key and imported JSON never recreate replay authority.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { resolveUserHome } = require('./forge-home');
const { readBoundedStableFile } = require('./forge-autonomy-sources');

const MAX_BYTES = 1048576;
const MAX_FILE = 2 * MAX_BYTES;
const failures = new WeakMap();
const unavailable = new WeakSet();
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
function fail(code) { throw Object.assign(new Error(code), { code }); }
function identity(file) {
  const s = fs.lstatSync(file, { bigint: true });
  if (s.isSymbolicLink()) fail('provisional-link-refused');
  return { dev: String(s.dev), ino: String(s.ino), birth: String(s.birthtimeNs) };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function physicalRoots(paths) {
  return [...new Set(paths.filter(Boolean).map(p => fs.realpathSync.native(p)))].sort().map((p, i) => {
    if (!fs.statSync(p).isDirectory()) fail('provisional-roots-invalid');
    return { root_id: `root${i}`, path: p, ...identity(p) };
  });
}
function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}
function noLinks(file) {
  for (let p = path.resolve(file); p !== path.dirname(p); p = path.dirname(p)) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) fail('provisional-link-refused');
  }
}
function privateMode(file) {
  if (process.platform !== 'win32' && (fs.statSync(file).mode & 0o077)) fail('provisional-permissions-refused');
}
function crypt(bytes, decrypt = false) {
  if (process.platform !== 'win32') return bytes;
  const op = decrypt ? 'Unprotect' : 'Protect';
  const source = "$ErrorActionPreference='Stop';try{Add-Type -AssemblyName System.Security;"
    + "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());"
    + "$e=[Text.Encoding]::UTF8.GetBytes('forge-provisional-terminal/v1');"
    + `$r=[Security.Cryptography.ProtectedData]::${op}($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser);`
    + "[Console]::Write([Convert]::ToBase64String($r))}catch{exit 1}";
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const r = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
    { input: bytes.toString('base64'), encoding: 'utf8', timeout: 5000, maxBuffer: 3 * MAX_BYTES, windowsHide: true });
  if (r.status !== 0 || r.error || !/^[A-Za-z0-9+/]+={0,2}$/.test(r.stdout || '')) fail('provisional-private-storage-unavailable');
  return Buffer.from(r.stdout, 'base64');
}
function signedBytes(value, keys) {
  const data = crypt(Buffer.from(JSON.stringify(value)));
  const body = { version: 1, protection: process.platform === 'win32' ? 'dpapi-current-user' : 'private-file-mode', data: data.toString('base64') };
  return Buffer.from(JSON.stringify({ ...body, public_key: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    signature: crypto.sign(null, Buffer.from(JSON.stringify(body)), keys.privateKey).toString('base64') }) + '\n');
}
function writeExclusive(file, bytes) {
  if (bytes.length > MAX_FILE) fail('provisional-output-limit');
  noLinks(path.dirname(file));
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  privateMode(file);
  return { file, sha256: digest(bytes), identity: identity(file) };
}
function readExact(reference) {
  if (!reference?.file) fail('provisional-evidence-unavailable');
  noLinks(reference.file); privateMode(reference.file);
  if (!same(identity(reference.file), reference.identity)) fail('provisional-evidence-changed');
  const read = readBoundedStableFile(reference.file, MAX_FILE, { expectedReal: fs.realpathSync.native(reference.file) });
  if (read.error) fail('provisional-evidence-changed');
  const bytes = read.buffer;
  if (!same(identity(reference.file), reference.identity) || digest(bytes) !== reference.sha256) fail('provisional-evidence-changed');
  return bytes;
}

function prepare({ binding, roots, storeRoot, validate }) {
  if (!/^[a-f0-9]{64}$/.test(binding?.request_sha256 || '') || !/^[a-f0-9]{64}$/.test(binding?.context_sha256 || '') || typeof validate !== 'function') fail('provisional-binding-required');
  const originalRoots = physicalRoots(roots);
  if (!originalRoots.length) fail('provisional-roots-invalid');
  const base = path.resolve(storeRoot || path.join(resolveUserHome(), '.forge-agent', 'private-attempts'));
  noLinks(base);
  // Resolve the nearest existing parent before making any private directories.
  let parent = base; while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const planned = path.resolve(fs.realpathSync.native(parent), path.relative(parent, base));
  if (originalRoots.some(root => inside(root.path, planned))) fail('provisional-storage-inside-protected-root');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 }); privateMode(base); noLinks(base);
  const id = crypto.randomUUID(), dir = path.join(base, id); fs.mkdirSync(dir, { mode: 0o700 }); privateMode(dir);
  const directoryIdentity = identity(dir), keys = crypto.generateKeyPairSync('ed25519');
  const state = { id, dir, directoryIdentity, binding: clone(binding), roots: originalRoots, keys, validate,
    child: null, payload: null, reference: null, audit: null, invalid: false, used: false, layers: [], layerValues: new Map(), preparation: null, error: null };
  const assertDirectory = () => { noLinks(dir); if (!same(identity(dir), directoryIdentity)) fail('provisional-evidence-changed'); };
  state.assertDirectory = assertDirectory;
  const control = {
    start(child) { if (state.child) fail('provisional-already-started'); state.child = child; },
    capture(terminal, error, metadata = {}) {
      if (state.payload || !state.child) return false;
      const bytes = Buffer.from(JSON.stringify(terminal)); if (bytes.length > MAX_BYTES) fail('provisional-output-limit');
      assertDirectory();
      state.payload = Buffer.from(bytes); state.error = error; state.metadata = clone(metadata); failures.set(error, state);
      state.reference = writeExclusive(path.join(dir, 'terminal.json'), signedBytes({ kind: 'provisional-terminal',
        status: 'unjoined-unvalidated', binding: state.binding, roots: originalRoots, pid: state.child.pid,
        original_reason: typeof error.code === 'string' && /^[a-z0-9-]{1,100}$/.test(error.code) ? error.code : 'unknown',
        terminal: JSON.parse(bytes), metadata: state.metadata, captured_at: new Date().toISOString() }, keys));
      assertDirectory(); return true;
    },
    invalidate() { state.invalid = true; },
    closeAudit({ code, signal, protocolValid }) {
      if (!state.reference || state.audit) return;
      state.audit = { code, signal: signal || null, protocol_valid: protocolValid === true && !state.invalid };
      assertDirectory();
      state.auditReference = writeExclusive(path.join(dir, 'close-audit.json'), signedBytes({ kind: 'provisional-close-audit',
        candidate_sha256: state.reference.sha256, audit: state.audit }, keys));
    },
    emptyCleanup() {
      if (!state.payload) { assertDirectory(); fs.rmdirSync(dir); }
    },
  };
  return Object.freeze(control);
}
function describe(error) {
  const s = failures.get(error);
  if (!s && !unavailable.has(error)) return null;
  if (!s) return { version: 1, kind: 'provisional-terminal', state: 'private-storage-unavailable', restart_promotion: 'unavailable' };
  if (!s.reference) return { version: 1, kind: 'provisional-terminal', state: 'private-storage-unavailable', restart_promotion: 'unavailable' };
  return { version: 1, kind: 'provisional-terminal', id: s.id, state: s.used ? 'promotion-consumed' : 'unvalidated',
    private_ref: s.reference.file, sha256: s.reference.sha256, request_sha256: s.binding.request_sha256,
    context_sha256: s.binding.context_sha256, restart_promotion: 'unavailable',
    audit: s.audit ? !s.invalid && s.audit.protocol_valid && s.audit.code === 0 && !s.audit.signal ? 'closed-success-unjoined' : 'ineligible' : 'pending' };
}
function addFinalizer(error, finalize, policy = {}) {
  const s = failures.get(error); if (!s || typeof finalize !== 'function' || s.used) fail('provisional-continuation-unavailable');
  s.layers.push({ finalize, cache: policy.cache === true, cacheOnReplay: policy.cacheOnReplay === true });
}
function setPreparation(error, prepare) {
  const s = failures.get(error);
  if (!s || s.used || s.preparation || typeof prepare !== 'function') fail('provisional-continuation-unavailable');
  s.preparation = prepare;
}
function transferFailure(source, target) {
  const state = failures.get(source); if (state && target && typeof target === 'object') failures.set(target, state);
  if (unavailable.has(source) && target && typeof target === 'object') unavailable.add(target);
}
async function resume(error, live) {
  const s = failures.get(error);
  if (!s || s.used || !s.reference) fail('provisional-continuation-unavailable');
  s.assertDirectory();
  if (!s.audit || s.invalid || !s.audit.protocol_valid || s.audit.code !== 0 || s.audit.signal) fail('provisional-transport-ineligible');
  if (!live || typeof live.assertCurrent !== 'function' || typeof live.proveStopped !== 'function' || typeof live.reconcileRoot !== 'function') fail('provisional-live-proof-required');
  if (s.inFlight) fail('provisional-continuation-unavailable');
  s.inFlight = true;
  try {
  if (await live.assertCurrent(clone(s.binding)) !== true) fail('provisional-owner-refused');
  const stopped = await live.proveStopped(s.child);
  if (stopped?.child !== s.child || stopped.process_stopped !== true || stopped.descendants_stopped !== true) fail('provisional-tree-unjoined');
  if (!same(physicalRoots(s.roots.map(r => r.path)), s.roots)) fail('provisional-roots-changed');
  for (const root of s.roots) {
    const proof = await live.reconcileRoot(clone(root), clone(s.binding));
    if (proof?.root_id !== root.root_id || proof.process_stopped !== true || proof.reconciled !== true || proof.original_snapshot_preserved !== true) fail('provisional-roots-unreconciled');
  }
  readExact(s.reference); readExact(s.auditReference);
  const value = await s.validate(JSON.parse(s.payload), clone(s.metadata || {}));
  if (await live.assertCurrent(clone(s.binding)) !== true) fail('provisional-owner-refused');
  if (s.invalid || s.used) fail('provisional-transport-ineligible');
  s.assertDirectory();
  // Reenter only original post-inference suffixes. Cache normalized values
  // only where the consumer revalidates a canonical replay receipt.
  // Consumption follows successful delivery; failures stay retryable.
  const consume = () => {
    if (s.used || s.invalid) fail('provisional-continuation-unavailable');
    s.assertDirectory();
    writeExclusive(path.join(s.dir, 'promotion-' + crypto.randomUUID() + '.json'), signedBytes({ kind: 'provisional-promotion',
      candidate_sha256: s.reference.sha256, request_sha256: s.binding.request_sha256, inference_performed: false }, s.keys));
    s.used = true;
  };
  const context = { id: s.id, source: describe(error), live };
  const prepared = s.preparation ? await s.preparation(context) : {};
  Object.assign(context, prepared);
  let result = value;
  for (let index = 0; index < s.layers.length; index++) {
    const layer = s.layers[index];
    if (s.layerValues.has(index) && (layer.cache || layer.cacheOnReplay && context.replayReady)) result = clone(s.layerValues.get(index));
    else {
      result = await layer.finalize(clone(result), context);
      s.layerValues.set(index, clone(result));
    }
  }
  if (!s.used) consume();
  return result;
  } finally { s.inFlight = false; }
}
function inspectPrivate(file, { includePrivatePayload = false } = {}) {
  noLinks(file); privateMode(file);
  const read = readBoundedStableFile(file, MAX_FILE, { expectedReal: fs.realpathSync.native(file) });
  if (read.error) fail('provisional-evidence-changed');
  const envelope = JSON.parse(read.buffer.toString('utf8'));
  const { public_key: publicKey, signature, ...body } = envelope;
  if (body.version !== 1 || !crypto.verify(null, Buffer.from(JSON.stringify(body)), publicKey, Buffer.from(signature, 'base64'))) fail('provisional-evidence-changed');
  const result = { version: 1, kind: 'provisional-terminal', provenance: 'inspection-only', promotion: 'unavailable-after-owner-restart', signature_valid: true };
  if (includePrivatePayload) {
    if (body.protection !== (process.platform === 'win32' ? 'dpapi-current-user' : 'private-file-mode')) fail('provisional-private-storage-unavailable');
    result.private_payload = JSON.parse(crypt(Buffer.from(body.data, 'base64'), true));
  }
  return result;
}

// Continuation authority exists only in this live owner. Private persisted
// evidence supports inspection after restart; it cannot recreate finalizers.
function revoke(error) { const state = failures.get(error); if (state) state.invalid = true; }
function markUnavailable(error) { if (error && typeof error === 'object') unavailable.add(error); }

module.exports = { MAX_BYTES, prepare, describe, addFinalizer, setPreparation, transferFailure, resume, inspectPrivate, revoke, markUnavailable };
