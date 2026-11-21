'use strict';

// Live attribution for managed-surfaces-v1 (issue 440, S01/T02).
// Authority to accept an owner `.gsd` delta comes ONLY from a live, in-process
// capability: an opaque handle registered in this module's WeakMap and carried
// by AsyncLocalStorage. Serialized copies, look-alike objects, other processes,
// journal rows, receipts, schemas, hashes, mtimes, clocks and PIDs grant nothing.
// The external journal and preimages are evidence of what the live writer did;
// they never become authority by themselves. Not an operating-system sandbox.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const roots = require('./forge-code-roots');
const surfaces = require('./forge-managed-surfaces');

// The closed reason-code set is the canonical T01 set; this module adds none.
// ATTRIBUTION_CODES names the slice-contract subset this adapter emits itself.
const REASON_CODES = surfaces.REASON_CODES;
const ATTRIBUTION_CODES = Object.freeze(['managed-surface-undeclared', 'managed-surface-unattributed',
  'managed-surface-capability-required', 'managed-surface-attestation-required', 'managed-surface-attribution-forged']
  .filter(code => REASON_CODES.includes(code)));
const MAX_CHANGES = 64;
const ANCHOR_FILE = 'attempt.json';
const ANCHOR_KEY = '@attempt-anchor';
const ANCHOR_SCHEMA = 'managed-attribution-anchor-v1';
const contexts = new AsyncLocalStorage();
const entries = new WeakMap();
const refusals = new WeakMap();
const attestations = new WeakMap();
const revalidations = new WeakMap();
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function fail(code) {
  throw new surfaces.ManagedSurfaceError(code);
}
function managedError(error) { return error instanceof surfaces.ManagedSurfaceError || (error && REASON_CODES.includes(error.code)); }
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}
function sameRoot(root, owner) {
  try { return roots.key(fs.realpathSync.native(root)) === roots.key(owner); } catch { return false; }
}
function hashOf(bytes) { return bytes === null ? null : sha(bytes); }
function valueOf(snapshot, key) { return snapshot && own(snapshot, key) ? snapshot[key] : null; }

// ── Opaque contexts ─────────────────────────────────────────────────────────
function liveEntry() {
  const handle = contexts.getStore();
  const entry = handle ? entries.get(handle) : null;
  return entry && !entry.closed ? entry : null;
}
function requireEntry() {
  const entry = liveEntry();
  if (!entry) fail('managed-surface-capability-required');
  return entry;
}
function isAttributionLive(handle) { const entry = entries.get(handle); return !!entry && !entry.closed; }
function refusalHandle(code) {
  const handle = Object.freeze({});
  refusals.set(handle, new surfaces.ManagedSurfaceError(code).code);
  return handle;
}

// Attempt binding from the trusted request, its claim and its lease generation.
// Request identity helpers are the canonical ones; nothing is re-derived here.
function attemptBinding(request, claimGeneration, leaseGeneration) {
  const r = request;
  const recovery = require('./forge-attempt-recovery');
  // Standalone task: explicit null milestone/slice (never fabricated) and the actual
  // registered run; any milestone/slice input on that scope is a mixed scope.
  const standalone = r.scope === 'standalone-task';
  if (standalone && (r.milestoneId !== undefined || r.sliceId !== undefined || typeof r.runId !== 'string')) fail('managed-surface-binding-invalid');
  const binding = {
    dispatch_id: r.dispatchId, unit: `execute-task/${r.taskId}`, run: r.runId || r.milestoneId,
    milestone: standalone ? null : r.milestoneId, slice: standalone ? null : r.sliceId,
    fingerprint: require('./forge-unit-sidecar').artifactFingerprint(r),
    recovery_identity_sha256: roots.digest(recovery.requestIdentity(recovery.canonicalRequest(r))),
    claim_generation: claimGeneration === undefined ? null : claimGeneration,
    lease_generation: leaseGeneration === undefined ? null : leaseGeneration,
  };
  for (const key of ['claim_generation', 'lease_generation']) {
    if (!(binding[key] === null || (typeof binding[key] === 'string' && binding[key].length <= 256)
      || Number.isSafeInteger(binding[key]))) fail('managed-surface-binding-invalid');
  }
  // T01 owns the attempt schema; surfacePath validates this exact projection.
  const attempt = Object.freeze({ dispatch_id: binding.dispatch_id, unit: binding.unit, run: binding.run,
    milestone: binding.milestone, slice: binding.slice });
  return { binding: Object.freeze(binding), attempt };
}

// Creates the live context. The origin of every declared surface is read under
// the caller's owner fence; a manual change before the first attributed write
// therefore cannot become a baseline. Any declaration/binding/source refusal
// yields a refusal handle: no capability, and the current guards apply as-is.
function createActivityAttribution(options = {}) {
  const { request, owner, revalidate } = options;
  if (typeof revalidate !== 'function' || typeof owner !== 'string' || !request) fail('managed-surface-capability-required');
  // Live scope revalidation failures propagate unchanged: they are not refusals.
  revalidate();
  try {
    surfaces.getDeclaration(options.version === undefined ? surfaces.VERSION : options.version);
    const { binding, attempt } = attemptBinding(request, options.claimGeneration, options.leaseGeneration);
    const declaration = surfaces.getDeclaration();
    const chains = new Map(), bytes = new Map(), origin = {};
    for (const surface of declaration.surfaces) {
      const relative = surfaces.surfacePath(surface.id, attempt);
      const current = surfaces.readSurface(owner, surface.id, attempt);
      chains.set(relative, [hashOf(current)]);
      bytes.set(relative, current);
      if (current !== null) origin[relative] = sha(current);
    }
    const anchor = { schema: ANCHOR_SCHEMA, declaration: surfaces.VERSION, declaration_sha256: surfaces.declarationDigest(),
      attempt: { ...binding }, origin };
    const baseline = { ...origin, [ANCHOR_KEY]: roots.digest(anchor) };
    const attestation = options.attestation === undefined ? null : attestations.get(options.attestation);
    if (options.attestation !== undefined && !attestation) fail('managed-surface-attestation-required');
    const handle = Object.freeze({});
    entries.set(handle, {
      kind: options.kind || 'activity', owner: fs.realpathSync.native(owner), binding, attempt, revalidate,
      onAdopt: typeof options.onAdopt === 'function' ? options.onAdopt : null, attest: attestation,
      resultFile: request.resultFile, codeRoots: (request.execution_contract?.code_roots || []).map(row => row.path),
      chains, bytes, createdDirs: new Set(), anchor, baseline, baselineSha: surfaces.snapshotDigest(baseline),
      store: null, journal: null, sequence: 0, previousRow: null, closed: false,
    });
    return handle;
  } catch (error) {
    return refusalHandle(managedError(error) ? error.code : 'managed-surface-binding-invalid');
  }
}
function runWithAttribution(handle, action) {
  if (typeof action !== 'function' || (!entries.has(handle) && !refusals.has(handle))) fail('managed-surface-capability-required');
  return contexts.run(handle, action);
}
function releaseAttribution(handle) { const entry = entries.get(handle); if (entry) entry.closed = true; }
function currentAttribution(root) {
  const handle = contexts.getStore();
  if (!handle) return null;
  if (refusals.has(handle)) return deepFreeze({ active: false, reason_code: refusals.get(handle) });
  const entry = liveEntry();
  if (!entry || (root !== undefined && !sameRoot(root, entry.owner))) return null;
  return deepFreeze({ active: true, kind: entry.kind, declaration: surfaces.VERSION, declaration_sha256: surfaces.declarationDigest(),
    attempt: { ...entry.binding }, sequence: entry.sequence, journal_sha256: entry.journal ? entry.journal.sha256 : null });
}

// ── Owner fence and external store ──────────────────────────────────────────
function fence(owner, action) {
  const windows = require('./forge-owner-transport-window');
  if (windows.observed(owner) || windows.currentPublicationGuard(owner) !== undefined) return windows.withMutation(owner, action);
  return require('./forge-artifact-reconciliation').withOwnerLock(owner, action);
}
function resolveStore(entry) {
  if (entry.store) return entry.store;
  let store;
  try {
    const xllm = require('./forge-xllm');
    let target = xllm.validateResultFileTarget(entry.resultFile, entry.owner);
    for (const root of entry.codeRoots) target = xllm.validateResultFileTarget(target, root);
    store = `${target}.managed-surfaces`;
    for (const root of [entry.owner, ...entry.codeRoots]) if (roots.within(fs.realpathSync.native(root), store)) throw new Error('inside');
  } catch { fail('managed-surface-store-invalid'); }
  let directory = null;
  try { directory = fs.lstatSync(store); } catch (error) { if (error.code !== 'ENOENT') fail('managed-surface-store-invalid'); }
  if (!directory) {
    try { fs.mkdirSync(store, { mode: 0o700 }); directory = fs.lstatSync(store); } catch { fail('managed-surface-store-invalid'); }
  }
  if (directory.isSymbolicLink() || !directory.isDirectory()
      || roots.key(fs.realpathSync.native(store)) !== roots.key(path.join(fs.realpathSync.native(path.dirname(store)), path.basename(store)))) fail('managed-surface-store-invalid');
  // Exclusive anchor: an existing store must hold this exact attempt anchor.
  const bytes = Buffer.from(`${JSON.stringify(entry.anchor)}\n`, 'utf8');
  const file = path.join(store, ANCHOR_FILE);
  let stat = null;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') fail('managed-surface-store-invalid'); }
  if (!stat) {
    try { fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }); } catch { fail('managed-surface-store-invalid'); }
    stat = fs.lstatSync(file);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || !fs.readFileSync(file).equals(bytes)) fail('managed-surface-store-invalid');
  entry.store = store;
  return store;
}

// ── Resolution and physical writes ──────────────────────────────────────────
function declared(entry, surfaceId, relative) {
  let resolved;
  try { resolved = surfaces.resolveSurface(surfaces.normalizeRelative(relative), entry.attempt); }
  catch (error) { if (!managedError(error)) throw error; fail(error.code === 'managed-surface-path-invalid' ? 'managed-surface-undeclared' : error.code); }
  if (!resolved || resolved.surface_id !== surfaceId) fail('managed-surface-undeclared');
  return resolved;
}
function readCurrent(entry, surfaceId) { return surfaces.readSurface(entry.owner, surfaceId, entry.attempt); }
function head(entry, relative) { return entry.chains.get(relative).at(-1); }
// Directories below the owner that this write would have to create (none exist yet).
function missingDirs(entry, relative) {
  const parts = relative.split('/').slice(0, -1), missing = [];
  let directory = entry.owner;
  for (let i = 0; i < parts.length; i++) {
    directory = path.join(directory, parts[i]);
    let stat = null;
    try { stat = fs.lstatSync(directory); } catch (error) { if (error.code !== 'ENOENT') fail('managed-surface-path-invalid'); }
    if (!stat) missing.push(`${parts.slice(0, i + 1).join('/')}/`);
    else if (missing.length || stat.isSymbolicLink() || !stat.isDirectory()) fail('managed-surface-path-invalid');
  }
  return missing;
}
function writeBytes(entry, relative, surface, before, after) {
  const parts = relative.split('/');
  let directory = entry.owner;
  for (const part of parts.slice(0, -1)) {
    directory = path.join(directory, part);
    let stat = null;
    try { stat = fs.lstatSync(directory); } catch (error) { if (error.code !== 'ENOENT') fail('managed-surface-path-invalid'); }
    if (!stat) { fs.mkdirSync(directory); entry.createdDirs.add(`${path.relative(entry.owner, directory).split(path.sep).join('/')}/`); continue; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('managed-surface-path-invalid');
  }
  const target = surfaces.physicalTarget(entry.owner, relative);
  if (surface.operation === 'append-only' && before !== null) {
    const fd = fs.openSync(target.absolute, fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = fs.fstatSync(fd);
      if (stat.nlink !== 1 || stat.size !== before.length) fail('managed-surface-baseline-unbound');
      const suffix = after.subarray(before.length);
      let offset = 0;
      while (offset < suffix.length) offset += fs.writeSync(fd, suffix, offset, suffix.length - offset);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    return;
  }
  if (before === null) {
    try { fs.writeFileSync(target.absolute, after, { flag: 'wx', mode: 0o600 }); } catch { fail('managed-surface-create-conflict'); }
    return;
  }
  // field-update: exclusive temporary in the same directory, then rename.
  const temporary = path.join(path.dirname(target.absolute), `.${path.basename(target.absolute)}.managed-${process.pid}.${crypto.randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeSync(fd, after, 0, after.length, 0); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, target.absolute); } catch (error) { try { fs.unlinkSync(temporary); } catch { /* best effort */ } throw error; }
}
function restoreBytes(entry, relative, surface, before) {
  const absolute = path.join(entry.owner, ...relative.split('/'));
  try {
    if (before === null) fs.unlinkSync(absolute);
    else if (surface.operation === 'append-only') fs.truncateSync(absolute, before.length);
    else writeBytes(entry, relative, { operation: 'field-update' }, Buffer.alloc(0), before);
  } catch { /* the snapshot guard still refuses any residue */ }
}

// Shared tail of every attributed transition, inside the owner fence:
// validation, preimage, (optional) write, journal row and exact adoption.
function commit(entry, resolved, before, after, write, writer) {
  const surface = resolved.surface, relative = resolved.path;
  const verdict = surfaces.validateTransition(surface.id, before, after, { binding: entry.attempt });
  if (!verdict.ok) fail(verdict.reason_code);
  if (hashOf(before) === hashOf(after)) return Object.freeze({ path: relative, unchanged: true, sequence: entry.sequence });
  const store = resolveStore(entry);
  // The journal prefix must still be exactly what this context last wrote,
  // checked before any owner byte changes (appendJournalRow re-checks after).
  const seen = surfaces.readJournal(store).anchor;
  if ((seen ? seen.sha256 : null) !== (entry.journal ? entry.journal.sha256 : null)) fail('managed-surface-audit-prefix-changed');
  // T01 verifies a preimage for every transition with prior bytes; field-update
  // needs it for restore, append-only keeps it so the chain stays verifiable.
  if (before !== null) surfaces.retainPreimage(store, before);
  // The row carries the full attempt (fingerprint, recovery identity, claim and
  // lease generations) and only the directories this exact write creates.
  const row = surfaces.createAttributionRow({ attempt: entry.binding, surface_id: surface.id, before, after, writer,
    created_dirs: write ? missingDirs(entry, relative) : [],
    sequence: entry.sequence + 1, previous_row_sha256: entry.previousRow, baseline_sha256: entry.baselineSha });
  if (write) write();
  let journal;
  try { journal = surfaces.appendJournalRow(store, row, entry.journal); }
  catch (error) { if (write) restoreBytes(entry, relative, surface, before); throw error; }
  entry.journal = journal; entry.sequence += 1; entry.previousRow = surfaces.attributionRowDigest(row);
  // Post-write CAS: adopt only if the owner still holds exactly the after bytes.
  const final = readCurrent(entry, surface.id);
  if (hashOf(final) !== hashOf(after)) fail('managed-surface-source-unstable');
  entry.chains.get(relative).push(hashOf(after));
  entry.bytes.set(relative, after);
  if (entry.onAdopt) entry.onAdopt(relative, hashOf(after));
  return Object.freeze({ path: relative, surface_id: surface.id, sequence: row.sequence, before_sha256: row.before_sha256,
    after_sha256: row.after_sha256, preimage_sha256: row.preimage_sha256, journal_sha256: journal.sha256 });
}

// Canonical in-process writer: the bytes are produced and written here, under
// the owner fence, only after CAS against the in-memory chain head.
function writeManagedSurface({ surface, path: relative, writer, produce } = {}) {
  const entry = requireEntry();
  entry.revalidate();
  const resolved = declared(entry, surface, relative);
  if (resolved.surface.capability !== 'in-scope') fail('managed-surface-attestation-required');
  if (!resolved.surface.writers.includes(writer)) fail('managed-surface-attribution-forged');
  if (typeof produce !== 'function') fail('managed-surface-input-invalid');
  return fence(entry.owner, () => {
    entry.revalidate();
    const before = readCurrent(entry, resolved.surface_id);
    if (hashOf(before) !== head(entry, resolved.path)) fail('managed-surface-baseline-unbound');
    const after = produce(before === null ? null : Buffer.from(before));
    if (!Buffer.isBuffer(after)) fail('managed-surface-input-invalid');
    return commit(entry, resolved, before, after, () => {
      writeBytes(entry, resolved.path, resolved.surface, before, after);
      const written = readCurrent(entry, resolved.surface_id);
      if (written === null || !written.equals(after)) fail('managed-surface-source-unstable');
    }, writer);
  });
}
// A canonical writer that wrote by itself records the exact transition under
// the SAME owner fence it still holds: before must be the chain head and the
// current bytes must be exactly the after bytes.
function recordManagedWrite({ surface, path: relative, writer, beforeBytes, afterBytes } = {}) {
  const entry = requireEntry();
  if (require('./forge-owner-transport-window').currentPublicationGuard(entry.owner) === undefined) fail('managed-surface-capability-required');
  entry.revalidate();
  const resolved = declared(entry, surface, relative);
  if (resolved.surface.capability !== 'in-scope') fail('managed-surface-attestation-required');
  if (!resolved.surface.writers.includes(writer)) fail('managed-surface-attribution-forged');
  if (!(beforeBytes === null || Buffer.isBuffer(beforeBytes)) || !Buffer.isBuffer(afterBytes)) fail('managed-surface-input-invalid');
  return fence(entry.owner, () => {
    if (hashOf(beforeBytes) !== head(entry, resolved.path)) fail('managed-surface-baseline-unbound');
    const current = readCurrent(entry, resolved.surface_id);
    if (current === null || !current.equals(afterBytes)) fail('managed-surface-unattributed');
    return commit(entry, resolved, beforeBytes, afterBytes, null, writer);
  });
}

// ── Cross-process append attestation (host adapter) ─────────────────────────
function createManagedAppendAttestationAdapter(attest) {
  if (typeof attest !== 'function') fail('managed-surface-attestation-required');
  const handle = Object.freeze({});
  attestations.set(handle, attest);
  return handle;
}
function eligible(r) { return !!r && (r.scope === 'milestone' || r.scope === 'standalone-task') && r.unitType === 'execute-task' && !!r.execution_contract; }
async function withManagedAttribution(request, runtime, action) {
  const adapter = runtime ? runtime.managedAppendAttestation : undefined;
  if (adapter === undefined) return action(runtime);
  const attest = attestations.get(adapter);
  if (!attest) fail('managed-surface-attestation-required');
  const live = liveEntry();
  if (live && live.binding.dispatch_id === request?.dispatchId) {
    const previous = live.attest; live.attest = attest;
    try { return await action(runtime); } finally { live.attest = previous; }
  }
  if (!eligible(request)) return action(runtime);
  const r = request, owner = fs.realpathSync.native(r.contextRoot || r.cwd), unit = `execute-task/${r.taskId}`;
  const runs = require('./forge-runs'), runId = r.runId || r.milestoneId, lease = require('./forge-unit-lease');
  const held = runs.get(owner, runId), planHash = sha(fs.readFileSync(r.planFile)), claimHash = roots.digest(held?.write_claim);
  const leaseRecord = lease.readLease(lease.leaseFile(owner, unit)).record;
  const revalidate = () => {
    const current = runs.get(owner, runId);
    if (!current?.active || roots.digest(current.write_claim) !== claimHash || sha(fs.readFileSync(r.planFile)) !== planHash) fail('managed-surface-capability-required');
  };
  if (!held?.active) return action(runtime);
  const handle = fence(owner, () => createActivityAttribution({ request: r, owner, unit, kind: 'attested-append', revalidate,
    claimGeneration: held.write_claim?.generation, leaseGeneration: lease.validRecord(leaseRecord, unit) ? leaseRecord.generation : null,
    attestation: adapter }));
  try { return await runWithAttribution(handle, () => action(runtime)); }
  finally { releaseAttribution(handle); }
}
// Adopts appends made by another process on host-attested surfaces of this
// attempt, only when the live host adapter observes the exact challenge.
function attestManagedAppends() {
  const entry = requireEntry();
  if (!entry.attest) fail('managed-surface-attestation-required');
  entry.revalidate();
  const activity = require('./forge-protected-owner-activity');
  const accepted = [];
  for (const surface of surfaces.getDeclaration().surfaces.filter(row => row.capability === 'host-attested-append')) {
    const relative = surfaces.surfacePath(surface.id, entry.attempt), resolved = declared(entry, surface.id, relative);
    accepted.push(fence(entry.owner, () => {
      const before = entry.bytes.get(relative), current = readCurrent(entry, surface.id);
      if (hashOf(current) === head(entry, relative)) return Object.freeze({ path: relative, unchanged: true });
      if (before !== null && hashOf(before) !== head(entry, relative)) fail('managed-surface-baseline-unbound');
      if (current === null) fail('managed-surface-append-rewrite');
      const verdict = surfaces.validateTransition(surface.id, before, current, { binding: entry.attempt });
      if (!verdict.ok) fail(verdict.reason_code === 'managed-surface-append-rewrite' ? verdict.reason_code : 'managed-surface-append-invalid');
      const attest = entry.attest;
      try {
        activity.hookAppendProof(entry.owner, { path: relative, before: hashOf(before), after: sha(current) },
          { originalBytes: { [relative]: before === null ? Buffer.alloc(0) : before },
            attestAppend: challenge => attest(deepFreeze(structuredClone(challenge))) },
          entry.binding.unit, entry.binding.dispatch_id);
      } catch (error) {
        if (error && error.code === 'owner-reconciliation-hook-proof-required') fail('managed-surface-attestation-required');
        if (error && /^owner-reconciliation-(?:append-invalid|delta-limit)$/.test(error.code || '')) fail('managed-surface-append-invalid');
        throw error;
      }
      return commit(entry, resolved, before, current, null, surface.writers[0]);
    }));
  }
  return Object.freeze(accepted);
}

// ── Projection and sanitized diagnosis ──────────────────────────────────────
// Adopts exactly the written deltas: for each attributed path, the incoming
// value must be one of the chain hashes; the expectation becomes the head.
// No new snapshot is ever adopted; without a live context the input is returned.
function projectExpected(root, before) {
  const entry = liveEntry();
  if (!entry || !before || typeof before !== 'object' || !sameRoot(root, entry.owner)) return before;
  const written = [...entry.chains].filter(([, chain]) => chain.length > 1);
  if (!written.length && !entry.createdDirs.size) return before;
  entry.revalidate({ projection: true });
  const expected = { ...before };
  for (const [relative, chain] of written) {
    if (!chain.includes(valueOf(before, relative))) continue;
    const last = chain.at(-1);
    if (last === null) delete expected[relative]; else expected[relative] = last;
  }
  for (const directory of entry.createdDirs) if (!own(before, directory)) expected[directory] = 'directory';
  return expected;
}
function neverDeclaredId(relative) {
  const row = surfaces.NEVER_DECLARED.find(item => item.regex.test(relative));
  return row ? row.id : null;
}
function describePath(entry, relative, before, expected, current) {
  const facts = { before_sha256: before, expected_sha256: expected, after_sha256: current };
  let resolved = null, invalid = false;
  try { resolved = surfaces.resolveSurface(surfaces.normalizeRelative(relative), entry.attempt); } catch { invalid = true; }
  if (!resolved) {
    return { path_sha256: sha(relative), class: neverDeclaredId(relative) || (invalid ? 'path-invalid' : 'arbitrary'),
      reason_code: 'managed-surface-undeclared', ...facts, diff: { kind: 'undeclared', entry: relative.endsWith('/') ? 'directory' : 'file' } };
  }
  const chain = entry.chains.get(resolved.path) || [null];
  const reason = before !== undefined && !chain.includes(before) ? 'managed-surface-baseline-unbound' : 'managed-surface-unattributed';
  let currentBytes = null, transition = null, diff = null;
  try {
    currentBytes = readCurrent(entry, resolved.surface_id);
    const verdict = surfaces.validateTransition(resolved.surface_id, entry.bytes.get(resolved.path), currentBytes, { binding: entry.attempt });
    transition = verdict.reason_code; diff = verdict.diff;
  } catch (error) { transition = managedError(error) ? error.code : 'managed-surface-unstable'; }
  return { path: resolved.path, surface_id: resolved.surface_id, reason_code: reason, ...facts,
    transition_reason_code: transition, diff };
}
function describeMismatch(root, expected, current, before) {
  const entry = liveEntry();
  if (!entry || !sameRoot(root, entry.owner) || !expected || !current) return null;
  const paths = [...new Set([...Object.keys(expected), ...Object.keys(current)])].sort()
    .filter(key => valueOf(expected, key) !== valueOf(current, key));
  const changes = paths.slice(0, MAX_CHANGES).map(key => describePath(entry, key,
    before && own(before, key) ? before[key] : (before ? null : undefined), valueOf(expected, key), valueOf(current, key)));
  return deepFreeze({ declaration: surfaces.VERSION, declaration_sha256: surfaces.declarationDigest(),
    attempt: { dispatch_id: entry.binding.dispatch_id, unit: entry.binding.unit, milestone: entry.binding.milestone },
    total: paths.length, truncated: paths.length > MAX_CHANGES, changes });
}

// Sanitized diagnosis of an EXTERNAL journal prefix mismatch of the live attempt.
// It is not an owner byte change: the change names the journal by class only (no
// store path, no payload), with the genuine digests the live context holds/observes.
// Reads only; never adopts, resets or appends anything. Null without a live context.
function describeJournalMismatch(root) {
  const entry = liveEntry();
  if (!entry || (root !== undefined && !sameRoot(root, entry.owner))) return null;
  let observed;
  try { observed = surfaces.readJournal(resolveStore(entry)); } catch { return null; }
  const expected = entry.journal ? entry.journal.sha256 : null, after = observed.anchor ? observed.anchor.sha256 : null;
  if (after === expected) return null;
  const foreign = observed.rows.filter(row => row?.attempt?.dispatch_id !== entry.binding.dispatch_id).length;
  return deepFreeze({ declaration: surfaces.VERSION, declaration_sha256: surfaces.declarationDigest(),
    attempt: { dispatch_id: entry.binding.dispatch_id, unit: entry.binding.unit, milestone: entry.binding.milestone },
    total: 1, truncated: false,
    changes: [{ class: 'managed-surface-journal', reason_code: 'managed-surface-audit-prefix-changed',
      before_sha256: expected, expected_sha256: expected, after_sha256: after,
      transition_reason_code: foreign ? 'managed-surface-attribution-foreign' : null,
      diff: { kind: 'journal-prefix', source: 'external-journal', rows_expected: entry.sequence, rows_observed: observed.rows.length, foreign_rows: foreign } }] });
}

// ── Classification for S02 ──────────────────────────────────────────────────
function createAttributionRevalidationAdapter(revalidate) {
  if (typeof revalidate !== 'function') fail('managed-surface-capability-required');
  const handle = Object.freeze({});
  revalidations.set(handle, revalidate);
  return handle;
}
function readBounded(file, limit) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { return null; }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) fail('managed-surface-store-invalid');
  const read = require('./forge-autonomy-sources').readBoundedStableFile(file, limit, { expectedReal: fs.realpathSync.native(file) });
  if (read.error) fail(read.error === 'source_too_large' ? 'managed-surface-size-limit' : 'managed-surface-source-unstable');
  return read.buffer;
}
function changedPaths(before, current) {
  return [...new Set([...Object.keys(before), ...Object.keys(current)])].sort()
    .filter(key => valueOf(before, key) !== valueOf(current, key));
}
function verdictRow(relative, status, reason, attempt) {
  const error = reason === null ? null : new surfaces.ManagedSurfaceError(reason);
  reason = error ? error.code : null;
  let declaredPath = false;
  try { declaredPath = !!surfaces.resolveSurface(surfaces.normalizeRelative(relative), attempt); } catch { declaredPath = false; }
  return Object.freeze(declaredPath ? { path: relative, status, reason_code: reason }
    : { path_sha256: sha(relative), class: neverDeclaredId(relative) || 'arbitrary', status, reason_code: reason });
}
// Per path: attributed only with a live context of this attempt, or a live
// revalidation adapter attesting the exact journal head and attempt binding,
// plus a valid T01 chain. A receipt without the v1 marker is legacy.
function classifyOwnerDelta({ request, receiptFile, before, current, revalidation } = {}) {
  if (!before || !current || typeof before !== 'object' || typeof current !== 'object') fail('managed-surface-input-invalid');
  const paths = changedPaths(before, current);
  let receipt;
  try { receipt = JSON.parse(readBounded(receiptFile, 8 * 1024 * 1024)); } catch (error) { if (managedError(error)) throw error; receipt = null; }
  const marker = receipt?.recovery_baseline?.managed_surfaces;
  const r = request || {};
  const attempt = { dispatch_id: r.dispatchId, unit: `execute-task/${r.taskId}`, run: r.runId || r.milestoneId,
    milestone: r.scope === 'standalone-task' ? null : r.milestoneId, slice: r.scope === 'standalone-task' ? null : r.sliceId };
  const all = (status, reason) => deepFreeze({ status: paths.length ? status : 'attributed',
    paths: paths.map(key => verdictRow(key, status, reason, attempt)) });
  if (!marker) return all('legacy', null);
  try { surfaces.getDeclaration(marker.declaration); } catch { return all('legacy', 'managed-surface-version-unknown'); }
  if (marker.declaration_sha256 !== surfaces.declarationDigest()) return all('unexplained', 'managed-surface-attribution-forged', attempt);
  const entry = liveEntry();
  const live = entry && entry.binding.dispatch_id === r.dispatchId && receipt.dispatch_id === entry.binding.dispatch_id
    && receipt.fingerprint === entry.binding.fingerprint ? entry : null;
  let store, journal, anchor;
  try {
    if (live) store = resolveStore(live);
    else {
      const xllm = require('./forge-xllm');
      store = `${xllm.validateResultFileTarget(r.resultFile, fs.realpathSync.native(r.contextRoot || r.cwd))}.managed-surfaces`;
    }
    journal = surfaces.readJournal(store);
    anchor = JSON.parse(readBounded(path.join(store, ANCHOR_FILE), 64 * 1024) || 'null');
  } catch (error) { return all('unexplained', managedError(error) ? error.code : 'managed-surface-store-invalid', attempt); }
  if (!anchor || anchor.schema !== ANCHOR_SCHEMA || anchor.attempt?.dispatch_id !== r.dispatchId
      || anchor.attempt?.fingerprint !== receipt.fingerprint || receipt.dispatch_id !== r.dispatchId) return all('unexplained', 'managed-surface-attribution-foreign', attempt);
  // The full attempt (fingerprint, recovery identity, claim/lease generations) must
  // be exactly what this request projects; rows are then verified against it, so a
  // changed or omitted component of any row attempt stays unexplained.
  let fullAttempt;
  try {
    fullAttempt = attemptBinding(r, anchor.attempt?.claim_generation, anchor.attempt?.lease_generation).binding;
    if (roots.digest(fullAttempt) !== roots.digest(anchor.attempt)) return all('unexplained', 'managed-surface-attribution-foreign', attempt);
  } catch (error) { return all('unexplained', managedError(error) ? error.code : 'managed-surface-binding-invalid', attempt); }
  const baseline = { ...anchor.origin, [ANCHOR_KEY]: roots.digest(anchor) };
  let authorityCode = null;
  if (live) {
    if (roots.digest(live.anchor) !== roots.digest(anchor)) authorityCode = 'managed-surface-attribution-foreign';
    else if ((live.journal ? live.journal.sha256 : null) !== (journal.anchor ? journal.anchor.sha256 : null)) authorityCode = 'managed-surface-audit-prefix-changed';
  } else {
    const revalidate = revalidations.get(revalidation);
    if (!revalidate) authorityCode = 'managed-surface-capability-required';
    else {
      const challenge = deepFreeze({ owner: fs.realpathSync.native(r.contextRoot || r.cwd), dispatch_id: r.dispatchId,
        receipt_sha256: sha(readBounded(receiptFile, 8 * 1024 * 1024)), attempt_sha256: roots.digest(anchor.attempt),
        journal_sha256: journal.anchor ? journal.anchor.sha256 : null, rows: journal.rows.length });
      let proof = null;
      try { proof = revalidate(challenge); } catch { proof = null; }
      if (!proof || proof.then || proof.observed !== true || proof.journal_sha256 !== challenge.journal_sha256
          || proof.attempt_sha256 !== challenge.attempt_sha256 || typeof proof.reference !== 'string' || !proof.reference.trim()
          || proof.reference.length > 512 || /[\r\n]/.test(proof.reference)) authorityCode = 'managed-surface-capability-required';
    }
  }
  const chainCurrent = { [ANCHOR_KEY]: baseline[ANCHOR_KEY] };
  for (const surface of surfaces.getDeclaration().surfaces) {
    const relative = surfaces.surfacePath(surface.id, attempt);
    if (own(current, relative)) chainCurrent[relative] = current[relative];
  }
  let chain;
  try { chain = surfaces.verifyAttributionChain({ attempt: fullAttempt, baseline, current: chainCurrent, rows: [...journal.rows], store }); }
  catch (error) { return all('unexplained', managedError(error) ? error.code : 'managed-surface-attribution-invalid', attempt); }
  const byPath = new Map(chain.paths.map(row => [row.path, row]));
  const rows = paths.map(key => {
    const verdict = byPath.get(key);
    if (!verdict) return verdictRow(key, 'unexplained', 'managed-surface-undeclared', attempt);
    if (verdict.status !== 'attributed') return verdictRow(key, 'unexplained',
      verdict.reason_code === 'managed-surface-delta-unattributed' ? 'managed-surface-unattributed' : verdict.reason_code, attempt);
    if (authorityCode) return verdictRow(key, 'unexplained', authorityCode, attempt);
    // S0 may be the origin or any authenticated link of this path's verified chain
    // (attributed writes can precede the S0 capture); the whole chain, including the
    // suffix after S0, was verified above against the exact attempt.
    const links = new Set([valueOf(anchor.origin, key)]);
    for (const row of journal.rows) if (row && row.path === key) links.add(row.after_sha256);
    if (!links.has(valueOf(before, key))) return verdictRow(key, 'unexplained', 'managed-surface-baseline-unbound', attempt);
    return verdictRow(key, 'attributed', null, attempt);
  });
  const status = rows.every(row => row.status === 'attributed') ? 'attributed' : 'unexplained';
  return deepFreeze({ status, paths: rows });
}

module.exports = {
  REASON_CODES, ATTRIBUTION_CODES, MAX_CHANGES,
  createActivityAttribution, runWithAttribution, releaseAttribution, isAttributionLive, withManagedAttribution, currentAttribution,
  writeManagedSurface, recordManagedWrite, createManagedAppendAttestationAdapter, attestManagedAppends,
  projectExpected, describeMismatch, describeJournalMismatch, createAttributionRevalidationAdapter, classifyOwnerDelta,
};
