'use strict';
// End-to-end integration suite for issue 440 S01/T03 (managed-surfaces-v1).
// Every owner, checkout, receipt, store and HOME lives under a fresh temporary
// laboratory removed in finally. Only the transport entry is synthetic: each case
// prints its label with transport "mock" (a stub of forge-xllm.runExecute, or the
// portable native host fixture). The controller begin, lease window, owner fence,
// protected snapshots, runner, verification, publication and completion gates are
// the real production seams. No provider, network, real owner metadata or account.
const assert = require('assert/strict'), fs = require('fs'), path = require('path'), cp = require('child_process');
const crypto = require('crypto');
const lab = require('./forge-code-roots.test'), roots = require('./forge-code-roots');
const { activityRequest } = require('./forge-issues-429-432.test');
const surfaces = require('./forge-managed-surfaces');
const managed = require('./forge-managed-attribution');
const sidecar = require('./forge-unit-sidecar');
const activity = require('./forge-protected-owner-activity');
const execution = require('./forge-task-execution');
const leaseApi = require('./forge-unit-lease');
const windows = require('./forge-owner-transport-window');
const recovery = require('./forge-attempt-recovery');
const questions = require('./forge-pending-questions');
const xllm = require('./forge-xllm');
const source = path.resolve(__dirname, '..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const EVENTS = '.gsd/forge/events.jsonl', STATE = '.gsd/milestones/M001/M001-STATE.md';
const EVIDENCE_SLUG = 'evidence~M001~S01~T01.jsonl';
const SECRET = 'SECRET-440-SURFACE', PERSONAL = 'C:\\Users\\someone-private\\notes';
const put = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const label = (name, extra = {}) => console.log(JSON.stringify({ label: name, transport: 'mock', provider: 'none', ...extra }));

async function fixture(fn) {
  const f = lab.fixture(), env = { ...process.env };
  try {
    const home = path.join(f.dir, 'home'); fs.mkdirSync(home);
    Object.assign(process.env, { HOME: home, USERPROFILE: home, FORGE_HOME: source });
    return await fn(f);
  } finally { process.env = env; f.cleanup(); }
}
function store(request) { return `${request.resultFile}.managed-surfaces`; }
function journalRows(request) {
  return fs.existsSync(path.join(store(request), 'journal.jsonl')) ? surfaces.readJournal(store(request)).rows : [];
}
function listing(directory) {
  if (!fs.existsSync(directory)) return null;
  const rows = [];
  const walk = (dir, prefix) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) { rows.push(`${prefix}${name}/`); walk(file, `${prefix}${name}/`); }
      else rows.push(`${prefix}${name}:${sha(fs.readFileSync(file))}`);
    }
  };
  walk(directory, '');
  return rows;
}
function noPrivate(value, name) {
  const text = JSON.stringify(value);
  for (const needle of [SECRET, 'someone-private', 'arbitrary-owner-note', 'continue.md', 'M001-STATE.md']) assert(!text.includes(needle), `${name}: leaked ${needle}`);
}
function identities(request) {
  return { fingerprint: sidecar.artifactFingerprint(request),
    recovery_identity_sha256: roots.digest(recovery.requestIdentity(recovery.canonicalRequest(request))),
    route_identity: sidecar.routeIdentity(request.route, request.unitType) };
}
// Key paths of a record. Maps keyed by owner paths or files are leaves: only the
// contract shape is compared, never per-fixture paths or hashes.
const LEAF_MAPS = new Set(['protected_owner', 'snapshot', 'verified_files', 'code_state', 'inputs', 'repos', 'transport_telemetry', 'telemetry', 'observation']);
function keyPaths(value, prefix = '', rows = new Set()) {
  if (Array.isArray(value)) { value.forEach(item => keyPaths(item, `${prefix}[]`, rows)); return rows; }
  if (!value || typeof value !== 'object') return rows;
  for (const key of Object.keys(value)) {
    const at = prefix ? `${prefix}.${key}` : key;
    rows.add(at);
    if (!LEAF_MAPS.has(key)) keyPaths(value[key], at, rows);
  }
  return rows;
}
function sortedDifference(a, b) { return [...a].filter(key => !b.has(key)).sort(); }

// One real runUnitSidecar attempt whose transport is a synthetic (mock) stub.
// Inside the transport, as a real attempt does: the in-process heartbeat and a
// lease poll from another process only observe, the hook evidence goes to the
// external journal, the runner appends liveness and the single writer child runs.
async function attemptPipeline(f, host, options = {}) {
  const request = activityRequest(f, host);
  const events = path.join(f.owner, EVENTS);
  if (!fs.existsSync(events)) put(events, '{"fixture":"seed"}\n');
  const files = sidecar.artifactAttemptFiles(request);
  const stateFile = path.join(f.owner, ...STATE.split('/'));
  const observed = { questionsBefore: listing(path.join(f.owner, '.gsd/forge/questions')),
    stateAtBegin: fs.existsSync(stateFile) ? fs.readFileSync(stateFile) : null };
  const previous = xllm.runExecute;
  xllm.runExecute = async transport => {
    transport.onBeforeSpawn?.();
    const scope = activity.currentScope(); assert(scope, 'live activity scope');
    const receipt = JSON.parse(fs.readFileSync(files.receiptFile, 'utf8'));
    observed.receiptAtTransport = structuredClone(receipt);
    observed.live = managed.currentAttribution(f.owner);
    observed.insideIdentities = identities(request);
    const leaseFile = leaseApi.leaseFile(f.owner, scope.unit), leaseBytes = fs.readFileSync(leaseFile);
    assert(leaseApi.heartbeat(f.owner, scope.unit, 'fixture-loop', scope.generation).ok);
    const poll = "const l=require(process.argv[1]);const r=l.heartbeat(process.argv[2],'execute-task/T01','fixture-loop',process.argv[3]);process.exit(r.ok?0:1);";
    const polled = cp.spawnSync(process.execPath, ['-e', poll, path.join(__dirname, 'forge-unit-lease.js'), f.owner, scope.generation],
      { cwd: f.a, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(polled.status, 0, polled.stderr);
    assert(fs.readFileSync(leaseFile).equals(leaseBytes), 'lease poll from another process only observes');
    const hook = windows.appendHookEvidence(f.owner, EVIDENCE_SLUG, JSON.stringify({ fixture: 'post-tool-use' }));
    assert.equal(hook.deferred, true); observed.hookFile = hook.file;
    if (options.liveness !== false) {
      transport.onLiveness?.({ from: 'healthy', to: 'slow-suspect', reason: 'no-progress', progress: { repeats: 2, fingerprint_sha256: '0123456789abcdef' } });
      transport.onLiveness?.({ from: 'slow-suspect', to: 'healthy' });
    }
    const child = scope.spawn(process.execPath, ['-e', "require('fs').writeFileSync('same.txt','after\\n')"],
      { cwd: transport.cwd, env: xllm.buildSidecarEnv('minimal'), windowsHide: true, stdio: 'ignore' });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0);
    if (options.inside) await options.inside({ request, scope, receipt, files });
    return { status: 'done', summary: 'Synthetic single-unit delivery', files_changed: ['same.txt'], must_haves_status: [] };
  };
  try {
    let result = null, error = null;
    try { result = await sidecar.runUnitSidecar(request, options.runtime || {}); } catch (caught) { error = caught; }
    return { request, files, result, error, observed };
  } finally {
    xllm.runExecute = previous;
    assert.equal(windows.observed(f.owner), null, 'owner window closed');
  }
}
function complete(f, host) {
  const begin = require('./forge-unit-controller').lookupRecord(f.owner, 'transaction', 'fixture-begin');
  return require('./forge-orchestrate').run('complete', { cwd: f.owner, milestone: 'M001', unit: 'execute-task/T01',
    begin_key: 'fixture-begin', host_runtime: host, owner_token: 'fixture-loop', generation: begin.generation,
    result: { status: 'done', summary: 'Synthetic single-unit delivery' } });
}

// ── Demo: host Claude → worker Codex (and the host Codex regression) ─────────
async function demo(host) { return fixture(async f => {
  label(`demo-${host}-host`, { worker: host === 'claude' ? 'codex' : 'claude' });
  const run = await attemptPipeline(f, host);
  const stateAtBegin = run.observed.stateAtBegin;
  assert(stateAtBegin, 'STATE written by the controller begin');
  assert.equal(run.error, null, run.error && `${run.error.code} ${run.error.stack}`);
  const { request, files, result, observed } = run;
  assert.equal(result.status, 'done');
  const receipt = JSON.parse(fs.readFileSync(files.receiptFile, 'utf8'));
  assert.equal(receipt.phase, 'ready');
  // The live v1 context belongs to this exact attempt.
  assert.equal(observed.live.active, true); assert.equal(observed.live.kind, 'activity');
  const outside = identities(request);
  assert.deepEqual(observed.insideIdentities, outside, 'identities are independent of the live context');
  assert.deepEqual({ dispatch_id: observed.live.attempt.dispatch_id, fingerprint: observed.live.attempt.fingerprint,
    recovery_identity_sha256: observed.live.attempt.recovery_identity_sha256 },
  { dispatch_id: request.dispatchId, fingerprint: outside.fingerprint, recovery_identity_sha256: outside.recovery_identity_sha256 });
  // R5: receipt identities are exactly the canonical ones; the marker is additive.
  assert.equal(receipt.fingerprint, outside.fingerprint);
  assert.equal(receipt.recovery_identity_sha256, outside.recovery_identity_sha256);
  assert.deepEqual(receipt.route, request.route);
  assert.deepEqual(sidecar.routeIdentity(receipt.route, 'execute-task'), outside.route_identity);
  assert.deepEqual(receipt.recovery_baseline.managed_surfaces, { declaration: surfaces.VERSION, declaration_sha256: surfaces.declarationDigest() });
  assert.deepEqual(observed.receiptAtTransport.recovery_baseline.managed_surfaces, receipt.recovery_baseline.managed_surfaces);
  // No protected refusal and no owner-delta-approval question.
  assert.deepEqual(listing(path.join(f.owner, '.gsd/forge/questions')), observed.questionsBefore, 'questions unchanged');
  assert(!JSON.stringify(receipt).includes('owner-delta-approval'));
  // Hook evidence went to the external journal, never to the owner.
  assert(fs.existsSync(observed.hookFile));
  assert(!roots.within(fs.realpathSync.native(f.owner), fs.realpathSync.native(observed.hookFile)));
  assert(!fs.existsSync(path.join(f.owner, '.gsd/forge', EVIDENCE_SLUG)));
  // Journal rows of this attempt: every runner event and the lease reopening.
  const rows = journalRows(request);
  assert(rows.length >= 4, `journal rows ${rows.length}`);
  for (const [index, row] of rows.entries()) {
    assert.equal(row.sequence, index + 1);
    assert.equal(row.attempt.dispatch_id, request.dispatchId); assert.equal(row.attempt.fingerprint, outside.fingerprint);
    assert.equal(row.attempt.recovery_identity_sha256, outside.recovery_identity_sha256);
    assert.equal(row.attempt.claim_generation, request.claim.generation);
    assert.equal(row.attempt.lease_generation, observed.live.attempt.lease_generation);
    assert.equal(row.declaration_sha256, surfaces.declarationDigest());
  }
  const eventRows = rows.filter(row => row.surface_id === 'owner-events'), leaseRows = rows.filter(row => row.surface_id === 'unit-lease');
  assert(eventRows.every(row => row.writer === 'scripts/forge-unit-sidecar.js#appendProtectedOwnerEvents'));
  assert(leaseRows.length >= 1 && leaseRows.every(row => row.writer === 'scripts/forge-unit-lease.js#openProtectedWindow'));
  for (let i = 1; i < eventRows.length; i++) assert.equal(eventRows[i].before_sha256, eventRows[i - 1].after_sha256, 'contiguous events chain');
  for (const row of eventRows) assert.equal(row.before_length + row.appended, row.after_length);
  const eventsBytes = fs.readFileSync(path.join(f.owner, EVENTS));
  assert.equal(eventRows.at(-1).after_sha256, sha(eventsBytes), 'head of the chain is the exact owner events file');
  assert.equal(receipt.recovery_baseline.protected_owner[EVENTS], sha(eventsBytes), 'receipt protected_owner advanced by the exact bytes');
  const lines = eventsBytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  assert(lines.some(line => line.event === 'sidecar-no-progress' && line.dispatch_id === request.dispatchId), 'liveness event attributed');
  assert(lines.some(line => line.event === 'sidecar-unit' && line.status === 'done' && line.dispatch_id === request.dispatchId), 'final event attributed');
  const eventsAtS0 = observed.receiptAtTransport.recovery_baseline.protected_owner[EVENTS];
  assert(eventRows.some(row => row.after_sha256 === eventsAtS0), 'S0 events hash is an attributed chain value');
  // STATE is written by the controller transitions at begin and complete only.
  assert(fs.readFileSync(path.join(f.owner, STATE)).equals(stateAtBegin), 'no STATE write during the attempt');
  const completed = complete(f, host);
  assert.equal(completed.outcome, 'completed', JSON.stringify(completed));
  return { request, receipt, result: JSON.parse(fs.readFileSync(files.resultFile, 'utf8')) };
}); }

// Host Codex → worker Claude: same receipt/result contract as the legacy route,
// except the declared additive marker, and the same canonical identities.
async function codexHostContract() {
  label('codex-host-contract', { worker: 'claude' });
  const current = await demo('codex');
  const legacy = await fixture(async f => {
    const run = await attemptPipeline(f, 'codex', { runtime: { managedSurfacesVersion: 'managed-surfaces-v2' } });
    assert.equal(run.error, null, run.error && `${run.error.code} ${run.error.stack}`);
    assert.equal(run.observed.live.active, false); assert.equal(run.observed.live.reason_code, 'managed-surface-version-unknown');
    const receipt = JSON.parse(fs.readFileSync(run.files.receiptFile, 'utf8'));
    assert.equal(receipt.recovery_baseline.managed_surfaces, undefined, 'legacy S0 has no marker');
    assert.equal(journalRows(run.request).length, 0);
    const outside = identities(run.request);
    assert.equal(receipt.fingerprint, outside.fingerprint); assert.equal(receipt.recovery_identity_sha256, outside.recovery_identity_sha256);
    assert.equal(complete(f, 'codex').outcome, 'completed');
    return { receipt, result: JSON.parse(fs.readFileSync(run.files.resultFile, 'utf8')) };
  });
  const added = sortedDifference(keyPaths(current.receipt), keyPaths(legacy.receipt));
  assert.deepEqual(added, ['recovery_baseline.managed_surfaces', 'recovery_baseline.managed_surfaces.declaration',
    'recovery_baseline.managed_surfaces.declaration_sha256']);
  assert.deepEqual(sortedDifference(keyPaths(legacy.receipt), keyPaths(current.receipt)), []);
  assert.deepEqual([...keyPaths(current.result)].sort(), [...keyPaths(legacy.result)].sort(), 'same result keys');
  assert.deepEqual(Object.keys(current.receipt.recovery_baseline).filter(key => key !== 'managed_surfaces'), Object.keys(legacy.receipt.recovery_baseline));
}

// ── A3 negatives end to end ─────────────────────────────────────────────────
// Each manual change happens inside the real transport. The attempt is refused,
// the receipt is failed, S0 is intact and no journal line names the manual bytes.
async function negative(name, inside, check, options = {}) { return fixture(async f => {
  label(`negative-${name}`);
  const seen = { eventRows: null };
  const run = await attemptPipeline(f, 'claude', { liveness: false, inside: async context => {
    seen.eventRows = journalRows(context.request).filter(row => row.surface_id === 'owner-events').length;
    await inside(f, context);
  } });
  assert(run.error, `${name}: attempt must be refused`);
  // No journal line adopts the manual bytes: the owner-events chain did not grow.
  if (seen.eventRows !== null && fs.existsSync(path.join(store(run.request), 'journal.jsonl')) && name !== 'foreign-journal-row') {
    assert.equal(journalRows(run.request).filter(row => row.surface_id === 'owner-events').length, seen.eventRows, `${name}: no attributed manual line`);
  }
  const receipt = JSON.parse(fs.readFileSync(run.files.receiptFile, 'utf8'));
  assert.equal(receipt.phase, 'failed', `${name}: receipt failed`);
  assert.deepEqual(receipt.recovery_baseline, run.observed.receiptAtTransport.recovery_baseline, `${name}: S0 intact`);
  assert.equal(receipt.fingerprint, identities(run.request).fingerprint);
  assert.deepEqual(listing(path.join(f.owner, '.gsd/forge/questions')), run.observed.questionsBefore, `${name}: no question opened`);
  if (options.code !== false) {
    assert.equal(run.error.code, options.code || 'execution-protected-metadata', `${name}: ${run.error.code} ${run.error.stack}`);
  }
  check(run.error, run, f);
  if (run.error.managed_surfaces) {
    noPrivate(run.error.managed_surfaces, name);
    for (const change of run.error.managed_surfaces.changes) {
      assert(REASONS.has(change.reason_code), `${name}: closed reason ${change.reason_code}`);
      // Snapshot values only: a file hash, a directory entry or absence.
      for (const key of ['before_sha256', 'expected_sha256', 'after_sha256']) {
        const value = change[key];
        assert(value === null || value === undefined || value === 'directory' || /^[a-f0-9]{64}$/.test(value), `${name}: ${key}`);
      }
    }
  }
}); }
const REASONS = new Set(surfaces.REASON_CODES);
function changeAt(error, key, value) {
  assert(error.managed_surfaces, `named diagnostic expected on ${error.code}`);
  const change = error.managed_surfaces.changes.find(row => row[key] === value);
  assert(change, `change for ${value}: ${JSON.stringify(error.managed_surfaces)}`);
  return change;
}
function hashed(change) {
  assert(/^[a-f0-9]{64}$/.test(change.before_sha256), 'before hash');
  assert(/^[a-f0-9]{64}$/.test(change.after_sha256), 'after hash');
  assert.notEqual(change.before_sha256, change.after_sha256);
}
function ownerFile(f, relative) { return path.join(f.owner, ...relative.split('/')); }
function leaseRelative(f) { return path.relative(f.owner, leaseApi.leaseFile(f.owner, 'execute-task/T01')).replace(/\\/g, '/'); }

const negatives = [
  ['manual-sidecar-unit-line', (f) => {
    fs.appendFileSync(ownerFile(f, EVENTS), `${JSON.stringify({ ts: new Date().toISOString(), event: 'sidecar-unit', workflow_id: 'fixture-activity',
      dispatch_id: 'fixture-activity-claude', unit: 'execute-task/T01', status: 'done', provider_called: true, note: SECRET, path: PERSONAL })}\n`);
  }, (error) => {
    const change = changeAt(error, 'path', EVENTS);
    assert.equal(change.reason_code, 'managed-surface-unattributed'); hashed(change);
    assert.equal(change.diff.kind, 'append'); assert.equal(change.diff.lines_appended, 1);
  }],
  ['manual-state-heartbeat', (f) => {
    const forgeState = require('./forge-state'), state = forgeState.read(f.owner, 'M001');
    forgeState.write(f.owner, { ...state, milestone: 'M001', heartbeat: new Date(Date.now() + 5000).toISOString() });
  }, (error) => {
    const change = changeAt(error, 'path_sha256', sha(STATE));
    assert.equal(change.reason_code, 'managed-surface-undeclared'); assert.equal(change.class, 'arbitrary'); hashed(change);
    assert.deepEqual(change.diff, { kind: 'undeclared', entry: 'file' });
  }],
  ['manual-events-truncated', (f) => {
    const file = ownerFile(f, EVENTS), bytes = fs.readFileSync(file), text = bytes.toString('utf8');
    fs.writeFileSync(file, text.slice(0, text.trimEnd().lastIndexOf('\n') + 1));
  }, (error) => {
    const change = changeAt(error, 'path', EVENTS);
    assert.equal(change.reason_code, 'managed-surface-unattributed'); hashed(change);
    assert.equal(change.transition_reason_code, 'managed-surface-append-rewrite');
  }],
  ['continue-and-arbitrary-file', (f) => {
    put(ownerFile(f, '.gsd/continue.md'), `resume ${SECRET}\n`);
    put(ownerFile(f, '.gsd/notes/arbitrary-owner-note.md'), `note ${PERSONAL}\n`);
  }, (error) => {
    const continued = changeAt(error, 'path_sha256', sha('.gsd/continue.md'));
    assert.equal(continued.reason_code, 'managed-surface-undeclared'); assert.equal(continued.class, 'continue');
    assert.equal(continued.before_sha256, null); assert(/^[a-f0-9]{64}$/.test(continued.after_sha256));
    const arbitrary = changeAt(error, 'path_sha256', sha('.gsd/notes/arbitrary-owner-note.md'));
    assert.equal(arbitrary.reason_code, 'managed-surface-undeclared'); assert.equal(arbitrary.class, 'arbitrary');
    const directory = changeAt(error, 'path_sha256', sha('.gsd/notes/'));
    assert.equal(directory.diff.entry, 'directory');
  }],
];
// The lease guard of the live activity runs before the snapshot assert, so a hand
// edit of the lease is first refused by the current lease guard; the same edit,
// asserted against the real S0 inside the live attempt, is named unattributed.
function leaseNegative(name, mutate, fields) {
  return [name, (f, context) => {
    const file = ownerFile(f, leaseRelative(f)), record = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, `${JSON.stringify(mutate(record), null, 2)}\n`);
    let seam = null;
    try { execution.assertProtected(f.owner, context.receipt.recovery_baseline.protected_owner); } catch (error) { seam = error; }
    assert(seam, `${name}: the live seam refuses`);
    assert.equal(seam.code, 'execution-protected-metadata');
    const change = changeAt(seam, 'path', leaseRelative(f));
    assert.equal(change.surface_id, 'unit-lease'); assert.equal(change.reason_code, 'managed-surface-unattributed'); hashed(change);
    assert.deepEqual([...change.diff.fields_changed].sort(), fields.changed);
    // An unknown field is listed by a truncated hash of its name, never by its raw name or value.
    assert.deepEqual({ ...change.diff.unknown_fields, sha256_12: [...change.diff.unknown_fields.sha256_12] },
      { count: fields.unknown.length, sha256_12: fields.unknown.map(key => sha(key).slice(0, 12)).sort() });
    if (fields.unknown.length) assert.equal(change.transition_reason_code, 'managed-surface-field-unknown');
    else assert.equal(change.transition_reason_code, null);
    noPrivate(seam.managed_surfaces, name);
    assert(!JSON.stringify(seam.managed_surfaces).includes('granted'));
    context.seam = seam;
  }, (error, run, f) => {
    // The runner boundary names the manual lease edit (before any renewal/adoption):
    // the canonical metadata code plus the sanitized change; the receipt is failed
    // and S0 unchanged (asserted by negative()).
    assert.equal(error.code, 'execution-protected-metadata', `${name}: ${error.code}`);
    assert.equal(error.message, 'execution-protected-metadata');
    const change = changeAt(error, 'path', leaseRelative(f));
    assert.equal(change.surface_id, 'unit-lease'); assert.equal(change.reason_code, 'managed-surface-unattributed'); hashed(change);
    assert(/^[a-f0-9]{64}$/.test(change.expected_sha256), 'expected hash');
    assert.deepEqual([...change.diff.fields_changed].sort(), fields.changed);
    console.log(JSON.stringify({ label: `negative-${name}`, terminal_code: error.code }));
  }, { code: false }];
}
negatives.push(leaseNegative('manual-lease-clock', record => ({ ...record, heartbeat_at: record.heartbeat_at + 5, expires_at: record.expires_at + 5 }),
  { changed: ['expires_at', 'heartbeat_at'], unknown: [] }));
negatives.push(leaseNegative('manual-lease-unknown-field', record => ({ ...record, authority: 'granted' }), { changed: [], unknown: ['authority'] }));
negatives.push(['foreign-journal-row', (f, context) => {
  const journalFile = path.join(store(context.request), 'journal.jsonl');
  const [own] = surfaces.readJournal(store(context.request)).rows;
  assert(own, 'the live attempt already attributed its start events');
  const foreign = { ...own, attempt: { ...own.attempt, dispatch_id: 'other-attempt-440' }, sequence: own.sequence + 1,
    previous_row_sha256: surfaces.attributionRowDigest(own) };
  fs.appendFileSync(journalFile, `${JSON.stringify(foreign)}\n`);
}, (error, run) => {
  // The next attributed write of the attempt (the verification window's lease
  // reopening) finds a journal prefix it did not write and refuses by name.
  assert.equal(error.code, 'execution-protected-metadata', error.code);
  assert.equal(error.message, 'execution-protected-metadata');
  assert.equal(error.raw_reason_code, 'managed-surface-audit-prefix-changed', 'raw cause kept separately');
  const named = error.managed_surfaces.changes.find(row => row.reason_code === 'managed-surface-audit-prefix-changed');
  assert(named, 'named journal diagnosis');
  assert.equal(named.transition_reason_code, 'managed-surface-attribution-foreign');
  for (const key of ['before_sha256', 'expected_sha256', 'after_sha256']) assert(/^[a-f0-9]{64}$/.test(named[key]), key);
  assert.equal(named.before_sha256, named.expected_sha256); assert.notEqual(named.after_sha256, named.expected_sha256);
  assert.equal(named.diff.source, 'external-journal'); assert.equal(named.diff.foreign_rows, 1);
  assert(!JSON.stringify(error.managed_surfaces).includes(path.basename(store(run.request))), 'no store path');
  console.log(JSON.stringify({ label: 'negative-foreign-journal-row', terminal_code: error.code }));
  const rows = journalRows(run.request);
  assert(rows.some(row => row.attempt.dispatch_id === 'other-attempt-440'), 'foreign row retained as evidence, never adopted');
  assert(!rows.some(row => row.surface_id === 'unit-lease'), 'the lease reopening was not attributed after the foreign row');
  const verdict = managed.classifyOwnerDelta({ request: run.request, receiptFile: run.files.receiptFile,
    before: run.observed.receiptAtTransport.recovery_baseline.protected_owner, current: execution.protectedSnapshot(run.request.contextRoot) });
  assert.equal(verdict.status, 'unexplained');
}, { code: false }]);

// ── S0 marker scope: only the live context of the same attempt ──────────────
async function markerScope() { return fixture(async f => {
  label('s0-marker-scope');
  const request = activityRequest(f, 'codex');
  const capture = (r, options) => {
    try { return sidecar.captureMilestoneBaseline(r, { phase: 'started', dispatch_id: r.dispatchId, fingerprint: sidecar.artifactFingerprint(r) }, options); }
    finally { const state = `${r.resultFile}.reset-state.json`; if (fs.existsSync(state)) fs.unlinkSync(state); }
  };
  const marker = { declaration: surfaces.VERSION, declaration_sha256: surfaces.declarationDigest() };
  const outside = capture(request);
  assert.equal(Object.hasOwn(outside, 'managed_surfaces'), false, 'no context: previous S0 shape');
  let live, ownChannel, other;
  await activity.withExecutionActivity(request, {}, async () => {
    live = capture(request);
    ownChannel = capture(request, { ownOwnerChannel: true });
    other = capture({ ...request, dispatchId: 'fixture-other-attempt', resultFile: path.join(f.dir, 'other-result.json') });
  });
  assert.deepEqual(live.managed_surfaces, marker, 'live context of the same attempt: marker');
  assert.deepEqual(Object.keys(live).filter(key => key !== 'managed_surfaces'), Object.keys(outside), 'marker is the only added key');
  assert.equal(Object.hasOwn(ownChannel, 'managed_surfaces'), false, 'verification successor / recovery-ready keep their shape');
  assert.equal(Object.hasOwn(other, 'managed_surfaces'), false, 'another attempt never inherits the marker');
  let refused;
  await activity.withExecutionActivity(request, { managedSurfacesVersion: 'managed-surfaces-v2' }, async () => { refused = capture(request); });
  assert.equal(Object.hasOwn(refused, 'managed_surfaces'), false, 'unknown version: legacy shape');
  // Broker and member requests never open an attribution context.
  for (const variant of [{ ownerBroker: {} }, { memberHandle: null }]) {
    await activity.withExecutionActivity({ ...request, ...variant }, {}, async () => { assert.equal(managed.currentAttribution(f.owner), null); });
  }
  assert.deepEqual(identities(request), identities(structuredClone(request)), 'identities are pure functions of the request');
}); }

// ── Legacy: a receipt without the v1 marker behaves exactly as today ─────────
function reconciliationCallbacks(request, overrides = {}) {
  return { request, hostRuntime: request.route.host_runtime, assertAuthority: () => true,
    attestStoppedWriter: () => true, readPendingQuestions: () => [],
    attestChanges: challenge => ({ challenge_sha256: roots.digest(challenge), changes: challenge.changes.map(row => ({ ...row,
      kind: row.path.includes('/questions') ? 'decision-record' : 'operator-reviewed', reference: 'synthetic explicit bounded decision' })) }),
    ...overrides };
}
async function legacyTransition() { return fixture(async f => {
  label('legacy-receipt-without-marker');
  const request = activityRequest(f, 'codex');
  put(ownerFile(f, EVENTS), '{"fixture":"seed"}\n');
  const receipt = { phase: 'failed', dispatch_id: request.dispatchId, fingerprint: sidecar.artifactFingerprint(request),
    recovery_identity_sha256: identities(request).recovery_identity_sha256,
    failure: { reason_code: 'execution-protected-metadata', provider_called: false } };
  // An attempt started before the update: S0 captured with no live context, no marker.
  assert.equal(managed.currentAttribution(f.owner), null);
  receipt.recovery_baseline = sidecar.captureMilestoneBaseline(request, receipt);
  assert.equal(Object.hasOwn(receipt.recovery_baseline, 'managed_surfaces'), false);
  const receiptFile = sidecar.artifactAttemptFiles(request).receiptFile; put(receiptFile, JSON.stringify(receipt));
  const receiptBytes = fs.readFileSync(receiptFile), stateBytes = fs.readFileSync(receipt.recovery_baseline.state_file);
  const S0 = structuredClone(receipt.recovery_baseline.protected_owner);
  // Manual same-schema change: the STATE heartbeat rewritten through its own
  // schema (no fence, no live capability), plus an operator HANDOFF note.
  const forgeState = require('./forge-state');
  forgeState.write(f.owner, { ...forgeState.read(f.owner, 'M001'), milestone: 'M001', heartbeat: new Date(Date.now() + 5000).toISOString() });
  put(ownerFile(f, '.gsd/HANDOFF-fixture.md'), 'operator note preserved\n');
  let refused = null;
  try { sidecar.reconcileMilestoneAttempt(request, receipt, { verifyOwnership: () => false }); } catch (error) { refused = error; }
  assert(refused); assert.equal(refused.code, 'execution-protected-metadata'); assert.equal(refused.message, 'execution-protected-metadata');
  assert.deepEqual(Object.keys(refused), ['code'], 'legacy throw, no managed diagnostic');
  assert(fs.readFileSync(receiptFile).equals(receiptBytes), 'receipt bytes unchanged');
  assert(fs.readFileSync(receipt.recovery_baseline.state_file).equals(stateBytes), 'state bytes unchanged');
  assert.deepEqual(receipt.recovery_baseline.protected_owner, S0, 'no baseline created from a valid schema');
  // Still refused on a second pass: the manual bytes were not adopted.
  assert.throws(() => sidecar.reconcileMilestoneAttempt(request, receipt, { verifyOwnership: () => false }), /execution-protected-metadata/);
  // Classification for S02: legacy.
  const verdict = managed.classifyOwnerDelta({ request, receiptFile, before: S0, current: execution.protectedSnapshot(f.owner) });
  assert.equal(verdict.status, 'legacy'); assert(verdict.paths.every(row => row.status === 'legacy'));
  // The legacy decision formula is unchanged: owner-delta/<digest of the reviewed changes>.
  const description = activity.reconciliationDecision(request);
  const current = execution.protectedSnapshot(f.owner), owner = fs.realpathSync.native(f.owner);
  const changes = [...new Set([...Object.keys(S0), ...Object.keys(current)])].sort().filter(file => S0[file] !== current[file])
    .map(file => ({ path: file, before: S0[file] ?? null, after: current[file] ?? null }));
  const deltaSha = roots.digest({ owner, unit: 'execute-task/T01', dispatch_id: request.dispatchId, changes });
  assert.equal(description.decision_set, `owner-delta/${deltaSha}`);
  assert.deepEqual(description.changes, changes);
  assert.equal(description.questions[0].id, 'owner-delta-approval');
  // Proven reconciliation with live callbacks and the answered approval reconciles as today.
  const input = reconciliationCallbacks(request);
  assert.throws(() => activity.createOwnerReconciliation(input), /operator-decision-required/);
  const opened = questions.openQuestions(description);
  questions.answer({ cwd: f.owner, identity: opened.identity_sha256, answers: [{ id: 'owner-delta-approval', answer: 'aprovado', source: 'user-text' }] });
  const cap = activity.createOwnerReconciliation({ ...input, operatorDecision: opened.identity_sha256 });
  assert.throws(() => sidecar.reconcileMilestoneAttempt(request, receipt, { ownerReconciliation: JSON.parse(JSON.stringify(cap)), verifyOwnership: () => true }),
    /capability-required/);
  const result = sidecar.reconcileMilestoneAttempt(request, receipt, { ownerReconciliation: cap, verifyOwnership: () => true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert(fs.readFileSync(receiptFile).equals(receiptBytes), 'original receipt immutable after reconciliation');
  assert.equal(fs.readFileSync(ownerFile(f, '.gsd/HANDOFF-fixture.md'), 'utf8'), 'operator note preserved\n', 'manual note never rewritten');
  assert.equal(fs.existsSync(store(request)), false, 'no managed store for a legacy attempt');
}); }

// ── Native: portable host fixture (standalone task, no controller begin) ────
// The live attestation adapter is a host handle. The standalone native route has
// no milestone binding in managed-surfaces-v1, so no attribution context exists
// there: with or without the adapter the evidence keeps today's refusal, and the
// saved native result replays unchanged.
async function nativeRoute() {
  label('native-portable-host', { worker: 'codex-native' });
  const harness = require('./fixtures/issues-434-436/execution-fixtures.cjs').createFixtureHarness();
  let completed = false;
  try {
    const challenges = [];
    const adapter = () => managed.createManagedAppendAttestationAdapter(challenge => { challenges.push(challenge);
      return { observed: true, reference: 'synthetic live host observation of the child append' }; });
    const evidencePath = require('./forge-evidence-path');
    const evidenceOf = f => `.gsd/forge/${evidencePath.buildEvidenceFileName({ milestone: null, slice: null, unit: f.r.taskId })}`;
    // Evidence appended by a child process during invokeNative, on the canonical sentinel path.
    const evidenceRun = async withAdapter => {
      const f = harness.nativeFixture();
      const invoke = f.runtime.invokeNative;
      const target = path.join(f.owner, ...evidenceOf(f).split('/'));
      const rt = { ...f.runtime, ...(withAdapter ? { managedAppendAttestation: adapter() } : {}),
        invokeNative: async (...args) => {
          const out = await invoke(...args);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const child = cp.spawnSync(process.execPath, ['-e', "require('fs').appendFileSync(process.argv[1], process.argv[2])", target, '{"hook":"post-tool-use"}\n'],
            { cwd: f.cwd, encoding: 'utf8', windowsHide: true, timeout: 30000 });
          assert.equal(child.status, 0, child.stderr);
          return out;
        } };
      let error = null, result = null;
      try { result = await sidecar.runUnitSidecar(f.r, rt); } catch (caught) { error = caught; }
      return { error, result, f, rt };
    };
    const without = await evidenceRun(false);
    assert(without.error, 'the same canonical evidence append without the live adapter keeps the legacy refusal');
    assert.equal(without.error.code, 'execution-protected-metadata');
    assert.equal(without.error.managed_surfaces, undefined, 'current refusal, no managed diagnostic');
    assert.equal(challenges.length, 0, 'no attestation without the adapter');
    const positive = await evidenceRun(true);
    assert.equal(positive.error, null, `live adapter adopts the child append: ${positive.error && positive.error.code}`);
    assert.equal(positive.result.status, 'done'); assert.equal(positive.f.calls(), 1);
    assert.equal(challenges.length, 1, 'the actual joined child append was attested exactly once');
    assert.equal(challenges[0].dispatch_id, positive.f.r.dispatchId); assert(Object.isFrozen(challenges[0]));
    const store = `${positive.f.r.resultFile}.managed-surfaces`, journalFile = path.join(store, 'journal.jsonl');
    const rows = fs.readFileSync(journalFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert(rows.some(row => row.surface_id === 'hook-evidence' && row.path === evidenceOf(positive.f)), 'evidence row on the canonical sentinel path');
    assert(rows.some(row => row.surface_id === 'owner-events'), 'runner events attributed');
    for (const row of rows) {
      assert.equal(row.attempt.milestone, null); assert.equal(row.attempt.slice, null);
      assert.equal(row.attempt.unit, `execute-task/${positive.f.r.taskId}`);
    }
    const receiptFile = `${positive.f.r.resultFile}.receipt.json`, receiptBytes = fs.readFileSync(receiptFile), journalBytes = fs.readFileSync(journalFile);
    const replay = await sidecar.runUnitSidecar(positive.f.r, positive.rt);
    assert.equal(replay.status, 'done'); assert.equal(positive.f.calls(), 1, 'replay never invokes again');
    assert.deepEqual(replay, positive.result);
    assert(fs.readFileSync(receiptFile).equals(receiptBytes), 'saved native receipt unchanged by replay');
    assert(fs.readFileSync(journalFile).equals(journalBytes), 'journal unchanged by replay');
    assert.equal(challenges.length, 1, 'replay attests nothing');
    // A look-alike / serialized adapter is refused before any invocation.
    for (const fake of [{ attest: () => ({ observed: true }) }, JSON.parse(JSON.stringify(adapter()))]) {
      const forged = harness.nativeFixture();
      await assert.rejects(sidecar.runUnitSidecar(forged.r, { ...forged.runtime, managedAppendAttestation: fake }),
        error => error.code === 'managed-surface-attestation-required');
      assert.equal(forged.calls(), 0);
    }
    completed = true;
  } finally { harness.close(completed); }
}

async function intermediateRunnerClassification() { return fixture(async f => {
  const request = activityRequest(f, 'claude');
  put(ownerFile(f, EVENTS), '{"fixture":"seed"}\n');
  const file = path.join(f.dir, 'runner-receipt.json');
  const record = { phase: 'started', dispatch_id: request.dispatchId, fingerprint: sidecar.artifactFingerprint(request) };
  await activity.withExecutionActivity(request, {}, async () => {
    sidecar.appendProtectedOwnerEvents(f.owner, file, record, ['{"event":"start"}\n', '{"event":"dispatch"}\n']);
    record.recovery_baseline = sidecar.captureMilestoneBaseline(request, record);
    const original = structuredClone(record.recovery_baseline.protected_owner);
    put(file, JSON.stringify(record)); const receiptBytes = fs.readFileSync(file);
    sidecar.appendProtectedOwnerEvents(f.owner, file, record, ['{"event":"later"}\n']);
    const verdict = managed.classifyOwnerDelta({ request, receiptFile: file, before: original, current: execution.protectedSnapshot(f.owner) });
    assert.equal(verdict.status, 'attributed', JSON.stringify(verdict));
    assert.equal(journalRows(request).filter(row => row.path === EVENTS).length, 2);
    assert.notDeepEqual(record.recovery_baseline.protected_owner, original, 'runner advances its exact owned append');
    const originalFile = path.join(f.dir, 'original-receipt.json'); put(originalFile, receiptBytes);
    assert.equal(managed.classifyOwnerDelta({ request, receiptFile: originalFile, before: original,
      current: execution.protectedSnapshot(f.owner) }).status, 'attributed');
    assert(fs.readFileSync(originalFile).equals(receiptBytes), 'saved original receipt unchanged by classification');
  });
}); }

async function ownerEventIoFailure(postS0, stage) { return fixture(async f => {
  const request = activityRequest(f, 'claude'); put(ownerFile(f, EVENTS), '{"fixture":"seed"}\n');
  const file = path.join(f.dir, 'io-receipt.json');
  const record = { phase: 'started', dispatch_id: request.dispatchId, fingerprint: sidecar.artifactFingerprint(request) };
  await activity.withExecutionActivity(request, {}, async () => {
    if (postS0) record.recovery_baseline = sidecar.captureMilestoneBaseline(request, record);
    put(file, JSON.stringify(record));
    const receiptBytes = fs.readFileSync(file), recordBefore = structuredClone(record), before = execution.protectedSnapshot(f.owner);
    const eventBytes = fs.readFileSync(ownerFile(f, EVENTS)), prefix = managed.currentAttribution(f.owner).journal_sha256;
    const original = stage === 'preimage' ? surfaces.retainPreimage : surfaces.appendJournalRow;
    const io = Object.assign(new Error('mock external store EIO'), { code: 'EIO' });
    const method = stage === 'preimage' ? 'retainPreimage' : 'appendJournalRow';
    surfaces[method] = (...args) => {
      if (path.resolve(args[0]) !== path.resolve(store(request))) return original(...args);
      if (stage === 'journal-after-publish') original(...args);
      throw io;
    };
    try { assert.throws(() => sidecar.appendProtectedOwnerEvents(f.owner, file, record, ['{"event":"io-failure"}\n']), error => error === io); }
    finally { surfaces[method] = original; }
    assert(fs.readFileSync(ownerFile(f, EVENTS)).equals(eventBytes), 'failed attribution never leaves owner event bytes');
    assert.deepEqual(execution.protectedSnapshot(f.owner), before, 'full owner remains unchanged');
    assert.deepEqual(record, recordBefore, 'in-memory receipt is not advanced');
    assert(fs.readFileSync(file).equals(receiptBytes), 'saved receipt is not advanced');
    assert.equal(managed.currentAttribution(f.owner).journal_sha256, prefix, 'failed journal never adopted');
    if (stage === 'journal-after-publish') {
      assert.equal(journalRows(request).length, 1, 'partial audit publication retained as evidence');
      assert.throws(() => sidecar.appendProtectedOwnerEvents(f.owner, file, record, ['{"event":"must-refuse"}\n']),
        error => error.code === 'managed-surface-audit-prefix-changed');
      assert(fs.readFileSync(ownerFile(f, EVENTS)).equals(eventBytes), 'broken prefix refuses before another append');
    }
  });
}); }

async function foreignEventReceiptRefused() { return fixture(async f => {
  const request = activityRequest(f, 'claude'); put(ownerFile(f, EVENTS), '{"fixture":"seed"}\n');
  await activity.withExecutionActivity(request, {}, async () => {
    const own = { phase: 'started', dispatch_id: request.dispatchId, fingerprint: sidecar.artifactFingerprint(request) };
    own.recovery_baseline = sidecar.captureMilestoneBaseline(request, own);
    const before = execution.protectedSnapshot(f.owner);
    for (const delta of [{ dispatch_id: 'foreign-attempt' }, { fingerprint: 'f'.repeat(64) }]) {
      const record = { ...structuredClone(own), ...delta }, file = path.join(f.dir, 'foreign-receipt.json');
      put(file, JSON.stringify(record)); const bytes = fs.readFileSync(file);
      assert.throws(() => sidecar.appendProtectedOwnerEvents(f.owner, file, record, ['{"event":"must-not-write"}\n']),
        error => error.code === 'execution-protected-metadata');
      assert.deepEqual(execution.protectedSnapshot(f.owner), before, 'foreign binding refused before append');
      assert(fs.readFileSync(file).equals(bytes)); assert.equal(journalRows(request).length, 0);
    }
  });
}); }

const cases = [
  { name: 'foreign-event-receipt-refused-before-append', fn: foreignEventReceiptRefused },
  { name: 'runner-intermediate-S0-classification', fn: intermediateRunnerClassification },
  ...[false, true].flatMap(post => ['preimage', 'journal-before-publish', 'journal-after-publish'].map(stage => ({
    name: `owner-event-${post ? 'post' : 'pre'}-S0-${stage}`, fn: () => ownerEventIoFailure(post, stage) }))),
  { name: 'demo-claude-host-codex-worker', fn: () => demo('claude') },
  { name: 'codex-host-contract', fn: codexHostContract },
  { name: 's0-marker-scope', fn: markerScope },
  ...negatives.map(([name, inside, check, options]) => ({ name: `negative-${name}`, fn: () => negative(name, inside, check, options) })),
  { name: 'legacy-receipt-without-marker', fn: legacyTransition },
  { name: 'native-portable-host', fn: nativeRoute },
];
async function main() {
  let passed = 0;
  for (const row of require('./forge-ci-units').selectCases(cases)) { await row.fn(); passed++; console.log('PASS ' + row.name); }
  console.log(`${passed}/${cases.length} cases passed; synthetic (mock) transport and temporary owners only, no provider or real project`);
}
module.exports = { cases, main };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
