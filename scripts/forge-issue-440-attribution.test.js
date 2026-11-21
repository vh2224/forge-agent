'use strict';
// Temporary-root contract suite for the live attribution seam (issue 440, S01/T02).
// Every owner, checkout, store and receipt lives under a fresh temporary laboratory
// removed in finally. Transport is synthetic (label mock): the controller begin,
// lease window, owner fence, protected snapshots and child processes are real;
// no provider, network, real owner metadata or operator account is touched.
const assert = require('assert/strict'), fs = require('fs'), path = require('path'), cp = require('child_process');
const crypto = require('crypto');
const lab = require('./forge-code-roots.test'), roots = require('./forge-code-roots');
const { activityRequest } = require('./forge-issues-429-432.test');
const surfaces = require('./forge-managed-surfaces');
const managed = require('./forge-managed-attribution');
const activity = require('./forge-protected-owner-activity');
const execution = require('./forge-task-execution');
const leaseApi = require('./forge-unit-lease');
const source = path.resolve(__dirname, '..');
const census = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'issue-440', 'surface-census.json'), 'utf8'));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const EVENTS = '.gsd/forge/events.jsonl', EVIDENCE = '.gsd/forge/evidence~M001~S01~T01.jsonl';
const EVENTS_WRITER = 'scripts/forge-unit-sidecar.js#appendProtectedOwnerEvents';
const LEASE_WRITER = 'scripts/forge-unit-lease.js#openProtectedWindow';
const SECRET = 'SECRET-440-VALUE', PERSONAL = 'C:\\Users\\someone-private\\notes';
const put = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };

async function fixture(fn) {
  const f = lab.fixture(), env = { ...process.env };
  try {
    const home = path.join(f.dir, 'home'); fs.mkdirSync(home);
    Object.assign(process.env, { HOME: home, USERPROFILE: home, FORGE_HOME: source });
    return await fn(f);
  } finally { process.env = env; f.cleanup(); }
}
// Synthetic attempt in a temporary owner: real begin, lease, claim and run.
function attempt(f, host = 'codex', overrides = {}) {
  const request = { ...activityRequest(f, host), ...overrides };
  const events = path.join(f.owner, EVENTS);
  if (!fs.existsSync(events)) put(events, '{"fixture":"seed"}\n');
  const leaseRelative = path.relative(f.owner, leaseApi.leaseFile(f.owner, 'execute-task/T01')).replace(/\\/g, '/');
  return { request, leaseRelative };
}
function store(request) { return `${request.resultFile}.managed-surfaces`; }
function journalRows(request) { return fs.existsSync(path.join(store(request), 'journal.jsonl')) ? surfaces.readJournal(store(request)).rows : []; }
function code(fn, expected, label) {
  assert.throws(fn, error => { assert.equal(error?.code, expected, `${label || expected}: got ${error?.code} ${error?.message}`); return true; });
}
async function rejectsCode(promise, expected) {
  await assert.rejects(promise, error => { assert.equal(error?.code, expected, `got ${error?.code} ${error?.stack}`); return true; });
}
function appendLine(object) { return bytes => Buffer.concat([bytes || Buffer.alloc(0), Buffer.from(`${JSON.stringify(object)}\n`)]); }
function bumpLease(extra = {}) {
  return bytes => {
    const record = JSON.parse(bytes);
    return Buffer.from(`${JSON.stringify({ ...record, heartbeat_at: record.heartbeat_at + 1, expires_at: record.expires_at + 1, ...extra }, null, 2)}\n`);
  };
}
function eventsWrite(line = { fixture: 'attributed' }) {
  return managed.writeManagedSurface({ surface: 'owner-events', path: EVENTS, writer: EVENTS_WRITER, produce: appendLine(line) });
}
function protectedError(fn) {
  let caught = null;
  try { fn(); } catch (error) { caught = error; }
  assert(caught, 'assertProtected must refuse');
  assert.equal(caught.code, 'execution-protected-metadata');
  assert.equal(caught.message, 'execution-protected-metadata');
  return caught;
}
function changeFor(error, key, value) { return error.managed_surfaces.changes.find(row => row[key] === value); }
function noPrivate(value, label) {
  const text = JSON.stringify(value);
  for (const needle of [SECRET, 'someone-private', 'arbitrary-owner-note', 'continue.md']) assert(!text.includes(needle), `${label}: leaked ${needle}`);
}
function receipt(f, request, marker = true, name = 'synthetic-receipt.json', declaration = surfaces.VERSION) {
  const file = path.join(f.dir, name);
  const body = { phase: 'ready', dispatch_id: request.dispatchId, fingerprint: require('./forge-unit-sidecar').artifactFingerprint(request),
    recovery_baseline: { schema_version: 1, ...(marker ? { managed_surfaces: { declaration, declaration_sha256: surfaces.declarationDigest() } } : {}) } };
  put(file, JSON.stringify(body));
  return file;
}

// ── Positive: host Claude → worker Codex and host Codex ─────────────────────
async function sidecarPositive(host) { return fixture(async f => {
  const { request, leaseRelative } = attempt(f, host);
  await activity.withExecutionActivity(request, {}, async () => {
    const scope = activity.currentScope(); assert(scope);
    const S0 = execution.protectedSnapshot(f.owner), frozen = structuredClone(S0);
    const live = managed.currentAttribution(f.owner);
    assert.equal(live.active, true); assert.equal(live.declaration, surfaces.VERSION);
    const recovery = require('./forge-attempt-recovery');
    assert.deepEqual({ ...live.attempt }, { dispatch_id: request.dispatchId, unit: 'execute-task/T01', run: 'M001', milestone: 'M001', slice: 'S01',
      fingerprint: require('./forge-unit-sidecar').artifactFingerprint(request),
      recovery_identity_sha256: roots.digest(recovery.requestIdentity(recovery.canonicalRequest(request))),
      claim_generation: request.claim.generation, lease_generation: scope.generation });
    const eventsBefore = fs.readFileSync(path.join(f.owner, EVENTS)), leaseBefore = fs.readFileSync(path.join(f.owner, leaseRelative));
    const first = eventsWrite();
    const second = managed.writeManagedSurface({ surface: 'unit-lease', path: leaseRelative, writer: LEASE_WRITER, produce: bumpLease() });
    assert.equal(first.before_sha256, sha(eventsBefore)); assert.equal(second.before_sha256, sha(leaseBefore));
    assert.equal(second.preimage_sha256, sha(leaseBefore));
    assert(surfaces.readPreimage(store(request), sha(leaseBefore)).equals(leaseBefore), 'field-update preimage retained');
    execution.assertProtected(f.owner, S0);
    const after = execution.protectedSnapshot(f.owner);
    assert.deepEqual(Object.keys(after).sort(), Object.keys(S0).sort(), 'no new entry under .gsd');
    assert.deepEqual(Object.keys(S0).filter(key => S0[key] !== after[key]).sort(), [EVENTS, leaseRelative].sort());
    const rows = journalRows(request);
    assert.equal(rows.length, 2);
    for (const [row, file, before] of [[rows[0], EVENTS, eventsBefore], [rows[1], leaseRelative, leaseBefore]]) {
      assert.equal(row.path, file); assert.equal(row.before_sha256, sha(before)); assert.equal(row.after_sha256, after[file]);
      assert.equal(row.attempt.dispatch_id, request.dispatchId); assert.equal(row.attempt.unit, 'execute-task/T01'); assert.equal(row.attempt.milestone, 'M001');
    }
    // The closed T01 row commits the full attempt binding through baseline_sha256.
    const anchor = JSON.parse(fs.readFileSync(path.join(store(request), 'attempt.json'), 'utf8'));
    assert.deepEqual(anchor.attempt, { ...live.attempt });
    assert.equal(rows[0].baseline_sha256, surfaces.snapshotDigest({ ...anchor.origin, '@attempt-anchor': roots.digest(anchor) }));
    for (const root of [f.owner, f.a]) assert(!roots.within(fs.realpathSync.native(root), fs.realpathSync.native(store(request))), 'store outside owner and code roots');
    assert(!fs.lstatSync(store(request)).isSymbolicLink());
    // Lease reopened by the verification window: attributed, projection kept.
    const child = scope.spawn(process.execPath, ['-e', 'process.exit(0)'], { cwd: f.a, windowsHide: true, stdio: 'ignore' });
    assert(child.pid); assert((await scope.joinWriter()).joined);
    const leaseHead = fs.readFileSync(path.join(f.owner, leaseRelative));
    scope.verificationWindow({ roots: [{ commands: ['fixture'] }], command_timeout_ms: 120000 });
    const reopened = journalRows(request).at(-1);
    assert.equal(reopened.surface_id, 'unit-lease'); assert.equal(reopened.before_sha256, sha(leaseHead));
    assert.equal(reopened.after_sha256, sha(fs.readFileSync(path.join(f.owner, leaseRelative))));
    assert(surfaces.readPreimage(store(request), sha(leaseHead)).equals(leaseHead));
    execution.assertProtected(f.owner, S0);
    execution.assertProtected(f.owner, after);
    assert.deepEqual(S0, frozen, 'S0 intact');
  });
  assert.equal(managed.currentAttribution(f.owner), null);
  code(() => eventsWrite(), 'managed-surface-capability-required', 'closed context');
}); }

function snapshotPin() {
  const text = execution.protectedSnapshot.toString();
  assert.equal(sha(text), census.protected_snapshot_pin.sha256);
  assert.equal(census.protected_snapshot_pin.sha256, 'eed8600f597bd5338219104b5149327dc320da604633007c9577b9430498375d');
  assert(text.includes('++entries > 20000'));
}

// ── A3 negatives at the seam ────────────────────────────────────────────────
async function manualSameSchema() { return fixture(async f => {
  const { request, leaseRelative } = attempt(f, 'claude');
  await activity.withExecutionActivity(request, {}, async () => {
    const S0 = execution.protectedSnapshot(f.owner), frozen = structuredClone(S0);
    eventsWrite();
    const head = sha(fs.readFileSync(path.join(f.owner, EVENTS))), rows = journalRows(request).length;
    fs.appendFileSync(path.join(f.owner, EVENTS), `${JSON.stringify({ event: 'sidecar-unit', secret: SECRET, path: PERSONAL })}\n`);
    let error = protectedError(() => execution.assertProtected(f.owner, S0));
    let change = changeFor(error, 'path', EVENTS);
    assert.equal(change.reason_code, 'managed-surface-unattributed');
    assert.equal(change.before_sha256, S0[EVENTS]); assert.equal(change.expected_sha256, head);
    assert.equal(change.after_sha256, sha(fs.readFileSync(path.join(f.owner, EVENTS))));
    assert.equal(change.diff.kind, 'append'); assert.equal(change.diff.lines_appended, 1);
    noPrivate(error.managed_surfaces, 'manual append diagnostic');
    assert.equal(journalRows(request).length, rows, 'no journal line for a manual change');
    // Manual lease clock move: same schema, same mutable fields, still refused.
    const file = path.join(f.owner, leaseRelative), record = JSON.parse(fs.readFileSync(file));
    fs.writeFileSync(file, `${JSON.stringify({ ...record, heartbeat_at: record.heartbeat_at + 5, expires_at: record.expires_at + 5 }, null, 2)}\n`);
    error = protectedError(() => execution.assertProtected(f.owner, S0));
    change = changeFor(error, 'path', leaseRelative);
    assert.equal(change.reason_code, 'managed-surface-unattributed'); assert.equal(change.surface_id, 'unit-lease');
    assert.deepEqual([...change.diff.fields_changed], ['expires_at', 'heartbeat_at']);
    assert(/^[a-f0-9]{64}$/.test(change.before_sha256) && /^[a-f0-9]{64}$/.test(change.after_sha256) && /^[a-f0-9]{64}$/.test(change.expected_sha256));
    assert.equal(journalRows(request).length, rows);
    assert.deepEqual(S0, frozen, 'S0 intact');
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  });
}); }

async function writerRefusals() { return fixture(async f => {
  const { request, leaseRelative } = attempt(f, 'codex');
  await activity.withExecutionActivity(request, {}, async () => {
    const S0 = execution.protectedSnapshot(f.owner);
    const eventsBytes = fs.readFileSync(path.join(f.owner, EVENTS)), leaseBytes = fs.readFileSync(path.join(f.owner, leaseRelative));
    code(() => managed.writeManagedSurface({ surface: 'unit-lease', path: leaseRelative, writer: LEASE_WRITER, produce: bumpLease({ authority: 'granted' }) }),
      'managed-surface-field-unknown');
    code(() => managed.writeManagedSurface({ surface: 'owner-events', path: EVENTS, writer: EVENTS_WRITER,
      produce: bytes => Buffer.concat([Buffer.from('{"rewritten":true}\n'), bytes.subarray(1)]) }), 'managed-surface-append-rewrite');
    code(() => managed.writeManagedSurface({ surface: 'owner-events', path: '.gsd/continue.md', writer: EVENTS_WRITER, produce: appendLine({}) }),
      'managed-surface-undeclared');
    code(() => managed.writeManagedSurface({ surface: 'owner-events', path: '.gsd/notes/arbitrary-owner-note.md', writer: EVENTS_WRITER, produce: appendLine({}) }),
      'managed-surface-undeclared');
    code(() => managed.writeManagedSurface({ surface: 'owner-events', path: EVENTS, writer: 'scripts/forge-hook.js#appendRewriteEvent', produce: appendLine({}) }),
      'managed-surface-attribution-forged');
    code(() => managed.writeManagedSurface({ surface: 'hook-evidence', path: EVIDENCE, writer: 'scripts/forge-owner-transport-window.js#appendHookEvidence', produce: appendLine({}) }),
      'managed-surface-attestation-required');
    code(() => managed.recordManagedWrite({ surface: 'owner-events', path: EVENTS, writer: EVENTS_WRITER, beforeBytes: eventsBytes, afterBytes: eventsBytes }),
      'managed-surface-capability-required', 'record outside the writer fence');
    assert(fs.readFileSync(path.join(f.owner, EVENTS)).equals(eventsBytes), 'no byte written');
    assert(fs.readFileSync(path.join(f.owner, leaseRelative)).equals(leaseBytes), 'no byte written');
    assert(!fs.existsSync(path.join(f.owner, '.gsd/continue.md')) && !fs.existsSync(path.join(f.owner, '.gsd/notes')));
    assert.equal(journalRows(request).length, 0, 'no journal line');
    execution.assertProtected(f.owner, S0);
    // Undeclared manual surfaces are named in the diagnostic without their path or bytes.
    put(path.join(f.owner, '.gsd/continue.md'), `resume ${SECRET}\n`);
    put(path.join(f.owner, '.gsd/arbitrary-owner-note.md'), `note ${PERSONAL}\n`);
    const error = protectedError(() => execution.assertProtected(f.owner, S0));
    const continued = changeFor(error, 'path_sha256', sha('.gsd/continue.md')), arbitrary = changeFor(error, 'path_sha256', sha('.gsd/arbitrary-owner-note.md'));
    assert.equal(continued.reason_code, 'managed-surface-undeclared'); assert.equal(continued.class, 'continue');
    assert.equal(arbitrary.reason_code, 'managed-surface-undeclared'); assert.equal(arbitrary.class, 'arbitrary');
    noPrivate(error.managed_surfaces, 'undeclared diagnostic');
    fs.unlinkSync(path.join(f.owner, '.gsd/continue.md')); fs.unlinkSync(path.join(f.owner, '.gsd/arbitrary-owner-note.md'));
    // A manual edit between two attributed writes unbinds the chain head.
    eventsWrite({ step: 1 });
    fs.appendFileSync(path.join(f.owner, EVENTS), '{"manual":true}\n');
    const manual = fs.readFileSync(path.join(f.owner, EVENTS));
    code(() => eventsWrite({ step: 2 }), 'managed-surface-baseline-unbound');
    assert(fs.readFileSync(path.join(f.owner, EVENTS)).equals(manual)); assert.equal(journalRows(request).length, 1);
    assert.equal(changeFor(protectedError(() => execution.assertProtected(f.owner, S0)), 'path', EVENTS).reason_code, 'managed-surface-unattributed');
  });
}); }

async function storeInsideOwner() { return fixture(async f => {
  const { request } = attempt(f, 'codex');
  const inside = { ...request, resultFile: path.join(f.owner, 'inside-result.json') };
  await activity.withExecutionActivity(inside, {}, async () => {
    const S0 = execution.protectedSnapshot(f.owner), bytes = fs.readFileSync(path.join(f.owner, EVENTS));
    code(() => eventsWrite(), 'managed-surface-store-invalid');
    assert(fs.readFileSync(path.join(f.owner, EVENTS)).equals(bytes));
    assert(!fs.existsSync(store(inside)));
    execution.assertProtected(f.owner, S0);
  });
}); }

// ── Forgery, reuse, clones ──────────────────────────────────────────────────
async function forgeryAndReuse() { return fixture(async f => {
  const { request } = attempt(f, 'codex');
  const receiptFile = receipt(f, request);
  await activity.withExecutionActivity(request, {}, async () => {
    const S0 = execution.protectedSnapshot(f.owner);
    eventsWrite({ step: 1 });
    const journalFile = path.join(store(request), 'journal.jsonl'), clean = fs.readFileSync(journalFile);
    const classify = () => managed.classifyOwnerDelta({ request, receiptFile, before: S0, current: execution.protectedSnapshot(f.owner) });
    assert.equal(classify().status, 'attributed');
    // Row copied from another attempt's journal.
    const [own] = surfaces.readJournal(store(request)).rows;
    // The live row carries the full contract, not only the hash-chain fields.
    assert.deepEqual(Object.keys(own).sort(), [...surfaces.ROW_FIELDS].sort());
    assert.deepEqual(Object.keys(own.attempt).sort(), [...surfaces.FULL_ATTEMPT_FIELDS].sort());
    assert(/^[a-f0-9]{64}$/.test(own.attempt.fingerprint) && /^[a-f0-9]{64}$/.test(own.attempt.recovery_identity_sha256));
    assert.equal(own.before_length + own.appended, own.after_length);
    assert(surfaces.getDeclaration().surfaces.find(s => s.id === own.surface_id).writers.includes(own.writer));
    assert.deepEqual(managed.REASON_CODES, surfaces.REASON_CODES);
    for (const key of ['fingerprint', 'recovery_identity_sha256']) {
      const tampered = { ...own, attempt: { ...own.attempt, [key]: key === 'fingerprint' ? '0'.repeat(64) : '1'.repeat(64) } };
      fs.writeFileSync(journalFile, Buffer.from(`${JSON.stringify(tampered)}\n`));
      const refused = classify();
      assert.equal(refused.status, 'unexplained', key);
      fs.writeFileSync(journalFile, clean);
    }
    const foreign = { ...own, attempt: { ...own.attempt, dispatch_id: 'other-attempt-440' }, sequence: 2, previous_row_sha256: surfaces.attributionRowDigest(own) };
    fs.appendFileSync(journalFile, `${JSON.stringify(foreign)}\n`);
    const ownerBytes = fs.readFileSync(path.join(f.owner, EVENTS));
    code(() => eventsWrite({ step: 2 }), 'managed-surface-audit-prefix-changed');
    assert(fs.readFileSync(path.join(f.owner, EVENTS)).equals(ownerBytes), 'refused before any owner byte');
    let verdict = classify();
    assert.equal(verdict.status, 'unexplained'); assert.equal(verdict.paths.find(row => row.path === EVENTS).reason_code, 'managed-surface-attribution-foreign');
    // Repeated row.
    fs.writeFileSync(journalFile, Buffer.concat([clean, Buffer.from(clean.toString('utf8').split('\n')[0] + '\n')]));
    verdict = classify();
    assert.equal(verdict.paths.find(row => row.path === EVENTS).reason_code, 'managed-surface-attribution-reused');
    fs.writeFileSync(journalFile, clean);
    // Hand-written valid row plus a manual edit, without capability: still refused.
    fs.appendFileSync(path.join(f.owner, EVENTS), '{"manual":"forged"}\n');
    const bytes = fs.readFileSync(path.join(f.owner, EVENTS)), prior = surfaces.readJournal(store(request));
    const forgedBefore = Buffer.from(bytes.subarray(0, bytes.length - '{"manual":"forged"}\n'.length));
    const forged = surfaces.createAttributionRow({ attempt: { ...own.attempt }, surface_id: 'owner-events', writer: own.writer, before: forgedBefore,
      after: bytes, sequence: 2, previous_row_sha256: surfaces.attributionRowDigest(own), baseline_sha256: own.baseline_sha256 });
    surfaces.retainPreimage(store(request), forgedBefore);
    surfaces.appendJournalRow(store(request), forged, prior.anchor);
    const error = protectedError(() => execution.assertProtected(f.owner, S0));
    assert.equal(changeFor(error, 'path', EVENTS).reason_code, 'managed-surface-unattributed');
    verdict = classify();
    assert.equal(verdict.paths.find(row => row.path === EVENTS).reason_code, 'managed-surface-audit-prefix-changed');
  });
  // Outside the live context, the same JSON journal grants nothing on its own.
  const offline = managed.classifyOwnerDelta({ request, receiptFile, before: {}, current: { [EVENTS]: 'x' } });
  assert.equal(offline.status, 'unexplained');
}); }

async function clonesAndLookalikes() { return fixture(async f => {
  const { request } = attempt(f, 'codex');
  const handle = managed.createActivityAttribution({ request, owner: fs.realpathSync.native(f.owner), revalidate: () => {},
    claimGeneration: request.claim.generation, leaseGeneration: 'g' });
  assert(managed.isAttributionLive(handle));
  for (const fake of [JSON.parse(JSON.stringify(handle)), {}, Object.freeze({}), structuredClone(handle), null]) {
    code(() => managed.runWithAttribution(fake, () => eventsWrite()), 'managed-surface-capability-required', 'cloned handle');
  }
  code(() => eventsWrite(), 'managed-surface-capability-required', 'no context');
  const serializedContext = managed.runWithAttribution(handle, () => JSON.parse(JSON.stringify(managed.currentAttribution(f.owner))));
  assert.equal(serializedContext.active, true);
  code(() => managed.runWithAttribution(serializedContext, () => eventsWrite()), 'managed-surface-capability-required', 'serialized context');
  code(() => managed.createManagedAppendAttestationAdapter(undefined), 'managed-surface-attestation-required');
  code(() => managed.createAttributionRevalidationAdapter({ revalidate() { return true; } }), 'managed-surface-capability-required');
  const adapter = managed.createManagedAppendAttestationAdapter(() => ({ observed: true, reference: 'synthetic' }));
  for (const fake of [JSON.parse(JSON.stringify(adapter)), { attest: () => ({ observed: true, reference: 'x' }) }]) {
    await rejectsCode(managed.withManagedAttribution(request, { managedAppendAttestation: fake }, async () => {}), 'managed-surface-attestation-required');
  }
  managed.releaseAttribution(handle);
  assert(!managed.isAttributionLive(handle));
  code(() => managed.runWithAttribution(handle, () => eventsWrite()), 'managed-surface-capability-required', 'released handle');
}); }

// ── Legacy byte-for-byte, unknown version ───────────────────────────────────
async function legacyIdentical() { return fixture(async f => {
  const { request } = attempt(f, 'codex');
  const S0 = execution.protectedSnapshot(f.owner);
  assert.equal(activity.expectedProtectedOwner(f.owner, S0), S0, 'same projection object without context');
  put(path.join(f.owner, '.gsd/worker-untrusted.md'), 'manual');
  const reference = protectedError(() => execution.assertProtected(f.owner, S0));
  assert.deepEqual(Object.keys(reference), ['code']); assert.equal(reference.managed_surfaces, undefined);
  const shape = error => ({ code: error.code, message: error.message, keys: Object.keys(error), name: error.name });
  for (const variant of [{ route: { ...request.route, worker_mode: 'native' } }, { ownerBroker: {} }, { memberHandle: null }]) {
    await activity.withExecutionActivity({ ...request, ...variant }, {}, async () => {
      assert.equal(activity.currentScope(), null); assert.equal(managed.currentAttribution(f.owner), null);
      assert.equal(activity.expectedProtectedOwner(f.owner, S0), S0);
      assert.deepEqual(shape(protectedError(() => execution.assertProtected(f.owner, S0))), shape(reference));
      code(() => eventsWrite(), 'managed-surface-capability-required');
    });
  }
  // Native without adapter: no context, current refusal unchanged.
  await managed.withManagedAttribution(request, {}, async () => {
    assert.equal(managed.currentAttribution(f.owner), null);
    assert.deepEqual(shape(protectedError(() => execution.assertProtected(f.owner, S0))), shape(reference));
    code(() => managed.attestManagedAppends(), 'managed-surface-capability-required');
  });
  // Legacy branch without a controller begin (no lease record).
  fs.unlinkSync(leaseApi.leaseFile(f.owner, 'execute-task/T01'));
  const noBegin = execution.protectedSnapshot(f.owner);
  await activity.withExecutionActivity(request, {}, async () => {
    assert.equal(activity.currentScope(), null); assert.equal(managed.currentAttribution(f.owner), null);
    put(path.join(f.owner, '.gsd/worker-untrusted-2.md'), 'manual');
    assert.deepEqual(shape(protectedError(() => execution.assertProtected(f.owner, noBegin))), shape(reference));
  });
}); }

async function versionUnknown() { return fixture(async f => {
  const { request, leaseRelative } = attempt(f, 'codex');
  await activity.withExecutionActivity(request, { managedSurfacesVersion: 'managed-surfaces-v2' }, async () => {
    assert(activity.currentScope());
    const live = managed.currentAttribution(f.owner);
    assert.equal(live.active, false); assert.equal(live.reason_code, 'managed-surface-version-unknown');
    const S0 = execution.protectedSnapshot(f.owner);
    code(() => eventsWrite(), 'managed-surface-capability-required');
    fs.appendFileSync(path.join(f.owner, EVENTS), '{"manual":true}\n');
    const error = protectedError(() => execution.assertProtected(f.owner, S0));
    assert.deepEqual(Object.keys(error), ['code'], 'current guard, no managed diagnostic');
    // The current lease guard stays exactly as it is today.
    const file = path.join(f.owner, leaseRelative), original = fs.readFileSync(file), record = JSON.parse(original);
    fs.writeFileSync(file, `${JSON.stringify({ ...record, heartbeat_at: record.heartbeat_at + 1 }, null, 2)}\n`);
    code(() => execution.assertProtected(f.owner, S0), 'protected-owner-lease-changed');
    fs.writeFileSync(file, original);
    assert.equal(journalRows(request).length, 0);
  });
  const S = execution.protectedSnapshot(f.owner), changed = { ...S, [EVENTS]: '0'.repeat(64) };
  const verdict = managed.classifyOwnerDelta({ request, receiptFile: receipt(f, request, true, 'v2-receipt.json', 'managed-surfaces-v2'), before: changed, current: S });
  assert.equal(verdict.status, 'legacy'); assert.equal(verdict.paths[0].reason_code, 'managed-surface-version-unknown');
}); }

// ── Cross-process append attested by a live host adapter ────────────────────
function childAppend(f, line) {
  const target = path.join(f.owner, ...EVIDENCE.split('/'));
  const result = cp.spawnSync(process.execPath, ['-e', "require('fs').appendFileSync(process.argv[1], process.argv[2])", target, line],
    { cwd: f.a, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  return Buffer.from(line);
}
async function attestedAppend() { return fixture(async f => {
  const { request } = attempt(f, 'claude');
  const session = async (name, attest, body) => {
    const scoped = { ...request, resultFile: path.join(f.dir, `${name}-result.json`) };
    const adapter = managed.createManagedAppendAttestationAdapter(attest);
    return managed.withManagedAttribution(scoped, { managedAppendAttestation: adapter }, async () => body(scoped));
  };
  const challenges = [];
  await session('accepted', challenge => { challenges.push(challenge); return { observed: true, reference: 'synthetic host observation of child append' }; }, async scoped => {
    const S0 = execution.protectedSnapshot(f.owner), live = managed.currentAttribution(f.owner);
    assert.equal(live.active, true); assert.equal(live.kind, 'attested-append');
    const suffix = childAppend(f, '{"hook":"post-tool-use"}\n');
    const [accepted] = managed.attestManagedAppends();
    assert.equal(accepted.path, EVIDENCE); assert.equal(accepted.before_sha256, null);
    assert.equal(challenges.length, 1); assert.equal(challenges[0].appended_sha256, sha(suffix)); assert.equal(challenges[0].dispatch_id, request.dispatchId);
    assert(Object.isFrozen(challenges[0]));
    execution.assertProtected(f.owner, S0);
    assert.equal(journalRows(scoped).at(-1).surface_id, 'hook-evidence');
    childAppend(f, '{"hook":"second"}\n'); managed.attestManagedAppends();
    assert.equal(journalRows(scoped).length, 2); execution.assertProtected(f.owner, S0);
  });
  const refusals = [
    ['observed-false', () => ({ observed: false, reference: 'x' }), '{"hook":1}\n', 'managed-surface-attestation-required'],
    ['reference-multiline', () => ({ observed: true, reference: 'a\nb' }), '{"hook":2}\n', 'managed-surface-attestation-required'],
    ['reference-long', () => ({ observed: true, reference: 'r'.repeat(513) }), '{"hook":3}\n', 'managed-surface-attestation-required'],
    ['suffix-invalid', () => ({ observed: true, reference: 'x' }), 'not json\n', 'managed-surface-append-invalid'],
    ['suffix-limit', () => ({ observed: true, reference: 'x' }), `${JSON.stringify({ hook: 'x'.repeat(2100) })}\n`, 'managed-surface-append-invalid'],
  ];
  for (const [name, attest, line, expected] of refusals) {
    await session(name, attest, async scoped => {
      const S0 = execution.protectedSnapshot(f.owner);
      childAppend(f, line);
      code(() => managed.attestManagedAppends(), expected, name);
      assert.equal(journalRows(scoped).length, 0, `${name}: no journal line`);
      assert.equal(changeFor(protectedError(() => execution.assertProtected(f.owner, S0)), 'path', EVIDENCE).reason_code, 'managed-surface-unattributed');
    });
  }
  // Without the live adapter the native route keeps today's refusal.
  await managed.withManagedAttribution(request, {}, async () => {
    const S0 = execution.protectedSnapshot(f.owner);
    childAppend(f, '{"hook":"no-adapter"}\n');
    assert.deepEqual(Object.keys(protectedError(() => execution.assertProtected(f.owner, S0))), ['code']);
  });
}); }

// The additive export proves nothing by itself and adopts nothing.
async function hookProofExport() { return fixture(async f => {
  const { request } = attempt(f, 'codex');
  assert.deepEqual(Object.keys(activity).sort(), ['assertOwnerReconciliationReady', 'assertPreflightAdmission', 'createOwnerReconciliation',
    'currentScope', 'expectedProtectedOwner', 'hookAppendProof', 'inspectAttemptResume', 'reconciliationDecision', 'resumeAttemptOwner',
    'withExecutionActivity', 'withOwnerReconciliation', 'withReconciliationHandoff']);
  const S0 = execution.protectedSnapshot(f.owner), suffix = childAppend(f, '{"hook":"direct"}\n');
  const change = { path: EVIDENCE, before: null, after: sha(suffix) };
  code(() => activity.hookAppendProof(f.owner, change, { originalBytes: { [EVIDENCE]: Buffer.alloc(0) } }, 'execute-task/T01', request.dispatchId),
    'owner-reconciliation-hook-proof-required');
  code(() => activity.hookAppendProof(f.owner, change, { originalBytes: { [EVIDENCE]: Buffer.alloc(0) }, attestAppend: () => ({ observed: false }) }, 'execute-task/T01', request.dispatchId),
    'owner-reconciliation-hook-proof-required');
  activity.hookAppendProof(f.owner, change, { originalBytes: { [EVIDENCE]: Buffer.alloc(0) }, attestAppend: () => ({ observed: true, reference: 'r' }) }, 'execute-task/T01', request.dispatchId);
  assert.deepEqual(Object.keys(protectedError(() => execution.assertProtected(f.owner, S0))), ['code'], 'a direct proof adopts nothing');
}); }

// ── Classification for S02 ──────────────────────────────────────────────────
async function classification() { return fixture(async f => {
  const { request, leaseRelative } = attempt(f, 'claude');
  const receiptFile = receipt(f, request), receiptBytes = fs.readFileSync(receiptFile);
  let S0, head;
  await activity.withExecutionActivity(request, {}, async () => {
    S0 = execution.protectedSnapshot(f.owner);
    eventsWrite();
    managed.writeManagedSurface({ surface: 'unit-lease', path: leaseRelative, writer: LEASE_WRITER, produce: bumpLease() });
    const live = managed.classifyOwnerDelta({ request, receiptFile, before: S0, current: execution.protectedSnapshot(f.owner) });
    assert.equal(live.status, 'attributed', JSON.stringify(live));
    assert.deepEqual(live.paths.map(row => row.path).sort(), [EVENTS, leaseRelative].sort());
    head = managed.currentAttribution(f.owner).journal_sha256;
  });
  const current = execution.protectedSnapshot(f.owner);
  const run = revalidation => managed.classifyOwnerDelta({ request, receiptFile, before: S0, current, revalidation });
  const host = managed.createAttributionRevalidationAdapter(challenge => ({ observed: true, journal_sha256: head, attempt_sha256: challenge.attempt_sha256,
    reference: 'synthetic live host revalidation of the exact journal head' }));
  assert.equal(run(host).status, 'attributed');
  const stale = managed.createAttributionRevalidationAdapter(challenge => ({ observed: true, journal_sha256: '0'.repeat(64), attempt_sha256: challenge.attempt_sha256, reference: 'stale' }));
  for (const revalidation of [undefined, stale, JSON.parse(JSON.stringify(host)), { revalidate: () => ({ observed: true }) }]) {
    const verdict = run(revalidation);
    assert.equal(verdict.status, 'unexplained');
    assert(verdict.paths.every(row => row.reason_code === 'managed-surface-capability-required'), JSON.stringify(verdict));
  }
  // Receipt without the v1 marker is legacy, whatever the journal says.
  const legacy = managed.classifyOwnerDelta({ request, receiptFile: receipt(f, request, false, 'legacy-receipt.json'), before: S0, current, revalidation: host });
  assert.equal(legacy.status, 'legacy'); assert(legacy.paths.every(row => row.status === 'legacy'));
  // An undeclared manual note is unexplained and named without its path.
  put(path.join(f.owner, '.gsd/arbitrary-owner-note.md'), 'manual\n');
  const mixed = managed.classifyOwnerDelta({ request, receiptFile, before: S0, current: execution.protectedSnapshot(f.owner), revalidation: host });
  assert.equal(mixed.status, 'unexplained');
  const note = mixed.paths.find(row => row.path_sha256 === sha('.gsd/arbitrary-owner-note.md'));
  assert.equal(note.reason_code, 'managed-surface-undeclared'); noPrivate(mixed, 'classification');
  assert(fs.readFileSync(receiptFile).equals(receiptBytes), 'receipt intact');
}); }

async function intermediateClassification(classifier = managed) { return fixture(async f => {
  const { request } = attempt(f, 'claude'), receiptFile = receipt(f, request), receiptBytes = fs.readFileSync(receiptFile);
  let S0, current, head;
  await activity.withExecutionActivity(request, {}, async () => {
    eventsWrite({ event: 'start-before-S0' });
    eventsWrite({ event: 'dispatch-before-S0' });
    S0 = execution.protectedSnapshot(f.owner);
    const frozen = structuredClone(S0);
    eventsWrite({ event: 'later-after-S0' });
    current = execution.protectedSnapshot(f.owner);
    const live = managed.classifyOwnerDelta({ request, receiptFile, before: S0, current });
    assert.equal(live.status, 'attributed', JSON.stringify(live));
    assert.deepEqual(S0, frozen, 'intermediate S0 is immutable');
    head = managed.currentAttribution(f.owner).journal_sha256;
  });
  const host = classifier.createAttributionRevalidationAdapter(challenge => ({ observed: true,
    journal_sha256: head, attempt_sha256: challenge.attempt_sha256, reference: 'mock exact live attempt and journal revalidation' }));
  const classify = (before = S0, now = current, revalidation = host) => classifier.classifyOwnerDelta({ request, receiptFile, before, current: now, revalidation });
  const result = classify();
  assert.equal(result.status, 'attributed', JSON.stringify(result));
  assert.deepEqual(result.paths.map(row => row.path), [EVENTS]);
  assert.equal(classify({ ...S0, [EVENTS]: sha('not-a-chain-link') }).paths[0].reason_code, 'managed-surface-baseline-unbound');
  assert.equal(classify(S0, { ...current, [EVENTS]: sha('manual-edit') }).paths[0].reason_code, 'managed-surface-unattributed');
  assert.equal(classify(S0, current, null).paths[0].reason_code, 'managed-surface-capability-required');
  assert(fs.readFileSync(receiptFile).equals(receiptBytes), 'original receipt immutable');
}); }

async function boundedReceiptRefusals() { return fixture(async f => {
  const { request } = attempt(f), file = receipt(f, request), sources = require('./forge-autonomy-sources');
  const original = sources.readBoundedStableFile, before = { [EVENTS]: sha('before') }, current = { [EVENTS]: sha('after') };
  try {
    for (const [low, expected] of [['source_too_large', 'managed-surface-read-limit'], ['source_unstable', 'managed-surface-unstable']]) {
      sources.readBoundedStableFile = (target, ...args) => path.resolve(target) === path.resolve(file) ? { error: low } : original(target, ...args);
      code(() => managed.classifyOwnerDelta({ request, receiptFile: file, before, current }), expected);
    }
  } finally { sources.readBoundedStableFile = original; }
}); }

const cases = [
  { name: 'bounded-receipt-read-refusals', fn: boundedReceiptRefusals },
  { name: 'intermediate-S0-classification', fn: intermediateClassification },
  { name: 'snapshot-pin', fn: snapshotPin },
  { name: 'sidecar-positive-claude-host-codex-worker', fn: () => sidecarPositive('claude') },
  { name: 'sidecar-positive-codex-host', fn: () => sidecarPositive('codex') },
  { name: 'manual-same-schema-refused', fn: manualSameSchema },
  { name: 'writer-refusals-and-undeclared', fn: writerRefusals },
  { name: 'store-inside-owner', fn: storeInsideOwner },
  { name: 'forgery-foreign-reused', fn: forgeryAndReuse },
  { name: 'clones-and-lookalikes', fn: clonesAndLookalikes },
  { name: 'legacy-byte-identical', fn: legacyIdentical },
  { name: 'version-unknown', fn: versionUnknown },
  { name: 'attested-cross-process-append', fn: attestedAppend },
  { name: 'hook-proof-export', fn: hookProofExport },
  { name: 'classification', fn: classification },
];
async function main() {
  let passed = 0;
  for (const row of require('./forge-ci-units').selectCases(cases)) { await row.fn(); passed++; console.log('PASS ' + row.name); }
  console.log(`${passed}/${cases.length} cases passed; synthetic (mock) owners only, no provider or real project`);
}
module.exports = { cases, main };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
