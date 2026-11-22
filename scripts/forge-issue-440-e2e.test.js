#!/usr/bin/env node
'use strict';
// Issue 440 S03/T03 — deterministic E2E harness over the genuine RECORDED
// Windows run "host Claude Code -> worker Codex (app-server)".
//
// What is real here: runUnitSidecar / recoverUnitSidecar / abandonAttempt and
// the canonical successor, runExecute, invokeCodexAppServer, startAppServerTurn
// (the real JSON-RPC parser), the assembler, receipts, publication, controller
// begin/lease/claim gate, protected owner activity, process-tree custody, the
// managed-surfaces fence and the actual forge-hook.js PostToolUse path.
// What is NOT real: no provider, network, account or credential is contacted.
// The worker process is a local REPLAYER written at test time into owned Temp:
// it reads ONLY the worker channel of scripts/fixtures/issue-440/e2e/recording.jsonl
// (sanitized captured bytes, label `recorded`) and answers the client in the
// captured order. Three things are kept apart in every report line:
//   captured_bytes    - the seq ranges of the recording that were replayed;
//   synthetic_stimuli - stimuli this harness injects (cut stream, descendant
//                       helper, concurrent host hook, manual same-schema edit);
//   harness_effects   - effects the harness itself executes. JSON-RPC replay does
//                       not perform the historical tool write, so the replayer
//                       explicitly materializes ONLY the claimed same.txt
//                       (`after` + LF) and declares it here. It is never an
//                       executed captured command.
// A historical recording proves neither that the current APIs ran in the
// original capture nor that the current writer stopped: stopped-writer proof
// comes only from the live custody of THIS process.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const SCRIPTS = __dirname;
const SOURCE = path.resolve(SCRIPTS, '..');
const E2E_DIR = path.join(SCRIPTS, 'fixtures', 'issue-440', 'e2e');
const MOCK_DIR = path.join(SCRIPTS, 'fixtures', 'issue-440', 'e2e-mock');
const RECORDING = path.join(E2E_DIR, 'recording.jsonl');
const MANIFEST = path.join(E2E_DIR, 'manifest.json');
const HARNESS_DOC = path.join(SOURCE, 'docs', 'issue-440', 'e2e-harness.md');
const WINDOWS_DOC = path.join(SOURCE, 'docs', 'issue-440', 'windows-evidence.md');
const RECORDING_REL = 'scripts/fixtures/issue-440/e2e/recording.jsonl';
const PLATFORM = process.platform;
const WIN32 = PLATFORM === 'win32';
const HOST = 'claude';
// Two-candidate chain for host Claude (routing only; no model is contacted).
const CHAIN = ['gpt-6.1-sol', 'gpt-5.6-terra'];
const TIERS = ['light', 'standard', 'heavy', 'max'];
const REFERENCE = 'conversation:issue-440-e2e-recorded-harness';
const SECTION = 'user:forge-routing-continuity';
const MANUAL_MARKER = 'harness-manual-edit-440';
// Credential-like variables are removed for the whole suite and restored after.
const CREDENTIAL_KEYS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'FORGE_ACCOUNT'];
const ENV_KEYS = ['HOME', 'USERPROFILE', 'CODEX_HOME', 'FORGE_HOME', 'FORGE_XLLM_CODEX_BIN', 'FORGE_XLLM_CLAUDE_BIN',
  'FORGE_CLAUDE_OWNER_SESSION_ID', 'FORGE_CLAUDE_OWNER_SOURCE', 'CODEX_THREAD_ID', ...CREDENTIAL_KEYS];
const CASES = ['contract-v2-recorded-success', 'replay-first-zero-transport', 'injected-failure-abandon-successor',
  'hook-evidence-window', 'manual-edit-refused', 'labels-recorded-never-real', 'mock-relabel-refused',
  'recording-tamper-refused', 'docs-tables-match'];

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fileSha = file => (fs.existsSync(file) ? sha(fs.readFileSync(file)) : null);
const put = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const text = file => fs.readFileSync(file, 'utf8');
const lines = file => (fs.existsSync(file) ? text(file).split('\n').filter(Boolean).length : 0);
// A named finding for fix-s03 (e2e-recording-insufficient | e2e-transport-defect):
// the case failed for a product reason that this task must not patch.
class Finding extends Error {
  constructor(code, detail) { super(`${code} ${JSON.stringify(detail)}`); this.code = code; this.detail = detail; }
}
const snapshotEnv = () => ({ ...process.env });
function restoreEnv(snapshot) {
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(snapshot, key)) delete process.env[key];
  for (const [key, value] of Object.entries(snapshot)) process.env[key] = value;
}

// ── Replayer and Claude stub (sources written into owned Temp) ─────────────
const REPLAYER_SOURCE = String.raw`'use strict';
// Recorded-protocol replayer (issue 440 S03/T03). NEVER a provider. Reads ONLY the
// worker channel of the sanitized recording and answers the real app-server client
// in the captured order; hashed IDs become transparent placeholders. Writes only its
// own log in owned Temp and, as a DECLARED harness effect, the claimed same.txt.
const fs = require('fs'), path = require('path'), cp = require('child_process'), readline = require('readline');
const control = JSON.parse(fs.readFileSync(path.join(__dirname, 'replayer-control.json'), 'utf8'));
fs.appendFileSync(control.calls, 'call\n');
const index = fs.readFileSync(control.calls, 'utf8').split('\n').filter(Boolean).length;
const logFile = path.join(control.logDir, 'call-' + index + '.json');
const log = { index, mode: control.mode, args: process.argv.slice(2), client_methods: [], consumed_seqs: [],
  harness_effects: [], synthetic_stimuli: [], placeholder_substitutions: 0, outcome: 'started' };
const save = () => fs.writeFileSync(logFile, JSON.stringify(log));
const stop = (outcome, code) => { log.outcome = outcome; save(); process.exit(code); };
save();
if (!process.argv.includes('app-server')) stop('e2e-transport-defect:unsupported-arguments', 2);
const records = fs.readFileSync(control.recording, 'utf8').split('\n').filter(Boolean)
  .map(line => JSON.parse(line)).filter(record => record.channel === 'worker');
const placeholders = Object.entries(control.placeholders || {});
const fill = value => {
  let out = value;
  for (const [token, actual] of placeholders) {
    const parts = out.split(token);
    if (parts.length > 1) { log.placeholder_substitutions += parts.length - 1; out = parts.join(actual); }
  }
  return out;
};
const alias = (kind, hash) => (typeof hash === 'string' ? kind + '-' + hash.slice(0, 16) : undefined);
const requestMethods = new Map(records.filter(r => r.direction === 'client' && r.kind === 'request').map(r => [r.rpc_id, r.method]));
const idMap = new Map();
function build(record) {
  if (record.kind === 'response') {
    const method = requestMethods.get(record.rpc_id);
    let result = {};
    if (method === 'initialize') result = { userAgent: record.user_agent_product };
    else if (method === 'thread/start') result = { thread: { id: alias('thread', record.thread_id_sha256) } };
    else if (method === 'turn/start') result = { turn: { id: alias('turn', record.turn_id_sha256) } };
    return { id: idMap.get(record.rpc_id), result };
  }
  const params = {};
  const thread = alias('thread', record.thread_id_sha256), turn = alias('turn', record.turn_id_sha256);
  if (thread) params.threadId = thread;
  if (turn) params.turnId = turn;
  if (record.method === 'turn/started' || record.method === 'turn/completed') params.turn = { id: turn, status: record.status };
  if (record.item_id_sha256) {
    const item = { id: alias('item', record.item_id_sha256), type: record.item_type };
    if (record.phase) item.phase = record.phase;
    if (record.status) item.status = record.status;
    if (typeof record.text === 'string') item.text = fill(record.text);
    params.item = item;
  }
  return { method: record.method, params };
}
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const isFinal = r => r.method === 'item/completed' && r.item_type === 'agentMessage' && r.phase === 'final_answer';
const isCommandDone = r => r.method === 'item/completed' && r.item_type === 'commandExecution';
let cursor = 0, cutting = false;
function materialize() {
  for (const dir of control.claimed) {
    fs.writeFileSync(path.join(dir, 'same.txt'), 'after\n');
    log.harness_effects.push('materialize-claimed-same.txt-after-LF');
  }
}
function windowStimulus() {
  if (!control.window) return;
  fs.writeFileSync(control.window.signal, String(process.pid));
  log.synthetic_stimuli.push('window-request:' + control.window.kind);
  save();
  const deadline = Date.now() + 60000;
  while (!fs.existsSync(control.window.ack)) {
    if (Date.now() > deadline) stop('e2e-transport-defect:window-ack-timeout', 4);
    sleep(20);
  }
}
function cut() {
  cutting = true;
  log.synthetic_stimuli.push('cut-before-final-answer', 'controlled-descendant-helper', 'remain-silent-for-real-watchdog');
  save();
  const helper = cp.spawn(process.execPath, ['-e', control.helper, String(control.helperWaitMs), ...control.claimed], { stdio: 'ignore', windowsHide: true });
  helper.on('error', () => stop('e2e-transport-defect:helper-spawn', 5));
  helper.on('exit', code => { log.helper_exit = code; log.outcome = 'cut-before-final'; save(); });
}
function pump() {
  while (cursor < records.length && records[cursor].direction === 'server') {
    const record = records[cursor];
    if (control.mode === 'cut-before-final' && isFinal(record)) return cut();
    if (control.mode === 'success' && isCommandDone(record)) { materialize(); windowStimulus(); }
    log.consumed_seqs.push(record.seq);
    if (cursor === records.length - 1) log.outcome = 'completed';
    save();
    send(build(record));
    cursor++;
  }
  return undefined;
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  if (cutting) return;
  let message;
  try { message = JSON.parse(line); } catch { stop('e2e-transport-defect:client-unparseable', 3); return; }
  const expected = records[cursor], isRequest = Object.prototype.hasOwnProperty.call(message, 'id');
  if (!expected || expected.direction !== 'client' || expected.method !== message.method || (expected.kind === 'request') !== isRequest) {
    log.mismatch = { expected: expected ? expected.method || null : null, observed: typeof message.method === 'string' ? message.method : null };
    stop('e2e-transport-defect:client-sequence', 3);
    return;
  }
  log.client_methods.push(message.method);
  log.consumed_seqs.push(expected.seq);
  if (isRequest) idMap.set(expected.rpc_id, message.id);
  cursor++;
  pump();
});
process.stdin.on('end', () => { if (!cutting) { save(); process.exit(0); } });
`;
const CLAUDE_STUB_SOURCE = String.raw`'use strict';
// Claude stub (issue 440 S03/T03): counts and REFUSES. The recorded harness never contacts Claude.
require('fs').appendFileSync(require('path').join(__dirname, 'claude-stub-calls.txt'), 'call\n');
process.stderr.write('claude stub: refused, the recorded harness has no provider\n');
process.exit(1);
`;
const HELPER = "const fs=require('fs'),p=require('path'),cp=require('child_process');const wait=Number(process.argv[1]);"
  + "for(const d of process.argv.slice(2))fs.writeFileSync(p.join(d,'same.txt'),'after\\n');"
  + "const g=cp.spawn(process.execPath,['-e','setTimeout(()=>{},'+wait+')'],{stdio:'ignore',windowsHide:true});g.on('exit',()=>process.exit(0));";

// ── Suite state ─────────────────────────────────────────────────────────────
let harness = null, api = null;
const state = { executed: new Set(), reports: [], fixtures: [], custody: WIN32 ? 'pending' : 'unavailable', success: null, hook: null };
const paths = {};

function load() {
  api = {
    lab: require('./forge-code-roots.test'),
    roots: require('./forge-code-roots'),
    activityRequest: require('./forge-issues-429-432.test').activityRequest,
    sidecar: require('./forge-unit-sidecar'),
    xllm: require('./forge-xllm'),
    recovery: require('./forge-attempt-recovery'),
    abandon: require('./forge-attempt-abandon'),
    controller: require('./forge-unit-controller'),
    runs: require('./forge-runs'),
    lease: require('./forge-unit-lease'),
    execution: require('./forge-task-execution'),
    windows: require('./forge-owner-transport-window'),
    surfaces: require('./forge-managed-surfaces'),
    refusal: require('./forge-replay-refusal'),
    tree: require('./forge-process-tree'),
    evidence: require('./forge-e2e-evidence'),
    ceilingFromRoute: require('./forge-worker-timeout').ceilingFromRoute,
    recoveryDispatchId: require('./forge-recovery-dispatch-id').recoveryDispatchId,
    resolveDispatch: require('./forge-dispatch-resolve').resolveDispatch,
  };
}
const digest = value => api.roots.digest(value);

function recording() {
  const rows = text(RECORDING).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const worker = rows.filter(row => row.channel === 'worker');
  const final = worker.find(row => row.method === 'item/completed' && row.item_type === 'agentMessage' && row.phase === 'final_answer');
  if (!final || typeof final.text !== 'string') throw new Finding('e2e-recording-insufficient', { field: 'worker final_answer item/completed text' });
  const manifest = JSON.parse(text(MANIFEST));
  return { rows, worker, final, answer: JSON.parse(final.text), manifest,
    clientMethods: worker.filter(row => row.direction === 'client').map(row => row.method) };
}
function setControl(patch) {
  const control = { recording: RECORDING, calls: paths.replayerCalls, logDir: paths.logDir, helper: HELPER, helperWaitMs: 150,
    placeholders: {}, window: null, mode: 'success', claimed: [], ...patch };
  fs.writeFileSync(paths.control, JSON.stringify(control));
}
const replayerCalls = () => lines(paths.replayerCalls);
const claudeCalls = () => lines(paths.claudeCalls);
const replayerLog = index => JSON.parse(text(path.join(paths.logDir, `call-${index}.json`)));
function seqRanges(seqs) {
  const sorted = [...new Set(seqs)].sort((a, b) => a - b), ranges = [];
  for (const seq of sorted) { const last = ranges.at(-1); if (last && last[1] === seq - 1) last[1] = seq; else ranges.push([seq, seq]); }
  return ranges;
}
function content(result) {
  const declared = Object.hasOwn(result, 'files_changed_declared') ? result.files_changed_declared : result.files_changed;
  return { status: result.status, summary: result.summary, must_haves_status: result.must_haves_status, files_changed: declared };
}

// ── Fixture: milestone attempt v2 with live authority and adapters ─────────
function authority(f) {
  put(path.join(f.profile, '.codex/AGENTS.md'), `<!-- ${SECTION}:start -->\nFixture standing authorization.\n<!-- ${SECTION}:end -->\n`);
  const adapter = require('./forge-interaction').createRecoveryAuthorizationAdapter(observed => ({ ...observed,
    received: true, answer: 'authorize', resolved_at: Date.now() - 1000 }), { resolveProfile: () => f.profile });
  api.recovery.bindRecoveryAuthorization({ adapter, reference: REFERENCE, registration: { host: 'codex', section: SECTION } });
  return { adapter, reference: REFERENCE };
}
// The writer handle is the replayer ChildProcess THIS process spawned through the
// public custody seam (observed transparently, never replaced). It is not a PID.
const writer = f => (f.trees[0] ? f.trees[0].child : null);
const writerRunning = f => { const child = writer(f); return !!child && child.exitCode === null && child.signalCode === null; };
function liveAdapter(f) {
  return api.abandon.createAbandonmentAdapter({
    attestWriter: challenge => {
      if (!writer(f) || writerRunning(f)) return { status: 'running' };
      return { status: 'stopped', binding_sha256: digest(challenge), writer_identity: `recorded-replayer:${writer(f).pid}`,
        evidence_reference: 'harness:joined-replayer-child-handle', dispatch_id: challenge.dispatch_id, fingerprint: challenge.fingerprint,
        receipt_sha256: challenge.receipt_sha256, execution_identity_sha256: challenge.execution_identity_sha256,
        roots_sha256: challenge.roots_sha256, descendants_sha256: challenge.descendants_sha256 };
    },
    attestRoot: challenge => ({ binding_sha256: digest(challenge), status: 'stopped', root_id: challenge.root_id,
      evidence_reference: `harness:root:${challenge.root_id}` }),
    revalidateAttribution: challenge => ({ observed: true, journal_sha256: challenge.journal_sha256,
      attempt_sha256: challenge.attempt_sha256, reference: 'harness:live-attribution-revalidation' }),
  });
}
const leaseRecord = f => api.lease.readLease(api.lease.leaseFile(f.owner, 'execute-task/T01')).record;
function fixture() {
  const f = api.lab.fixture();
  f.env = snapshotEnv();
  state.fixtures.push(f);
  const home = path.join(f.dir, 'home'); fs.mkdirSync(home);
  f.profile = path.join(f.dir, 'profile'); fs.mkdirSync(f.profile);
  Object.assign(process.env, { HOME: home, USERPROFILE: home });
  const request = api.activityRequest(f, HOST);
  put(path.join(f.owner, '.gsd/forge-prefs.jsonc'), JSON.stringify({ tier_models: Object.fromEntries(TIERS.map(tier => [tier, CHAIN])) }));
  request.route = api.resolveDispatch({ cwd: f.owner, unitType: 'execute-task', milestoneId: 'M001', unitId: 'T01',
    planPath: request.planFile, hostRuntime: HOST });
  assert.equal(request.route.host_runtime, 'claude'); assert.equal(request.route.worker_mode, 'sidecar');
  assert.equal(request.route.resolved_worker_engine, 'codex'); assert.equal(request.route.chain.length, 2);
  assert.equal(request.execution_contract.schema_version, 2, 'execution_contract v2');
  // Operator state present before the attempt (untracked, outside the claims).
  put(path.join(f.a, 'operator.txt'), 'operator\r\n');
  Object.assign(f, { request, trees: [] });
  f.files = api.sidecar.artifactAttemptFiles(request);
  f.stateFile = `${f.files.resultFile}.recovery.json`; f.recordFile = `${f.files.resultFile}.abandon.jsonl`;
  f.authority = authority(f); f.adapter = liveAdapter(f); f.lease = leaseRecord(f);
  f.beginChecksum = api.controller.recordChecksum(api.controller.lookupRecord(f.owner, 'transaction', 'fixture-begin'));
  f.claimDigest = digest(api.runs.get(f.owner, 'M001').write_claim);
  return f;
}
function release(f) {
  const at = state.fixtures.indexOf(f);
  if (at >= 0) state.fixtures.splice(at, 1);
  restoreEnv(f.env); f.cleanup();
}
// Transparent observation of the public custody seam: same input, same return.
function observeTrees(f) {
  const tree = api.tree, original = tree.startAttemptTree;
  tree.startAttemptTree = function observed(input) { const value = original.call(this, input); f.trees.push(value); return value; };
  return () => { tree.startAttemptTree = original; };
}
function custodyOf(f) {
  const mode = f.trees[0] && f.trees[0].tree ? f.trees[0].tree.mode : null;
  return mode === 'custody' ? 'native' : 'unavailable';
}
function requireCustody(f, label) {
  const custody = custodyOf(f);
  if (WIN32) assert.equal(custody, 'native', `${label}: native custody is mandatory on win32 (unavailable is a failure, never a skip)`);
  return custody;
}
function runtime(f) {
  return { processProbe: () => (writerRunning(f) ? 'running' : 'stopped'),
    recoveryAuthorization: { adapter: f.authority.adapter, reference: f.authority.reference } };
}
function recover(f) {
  return api.sidecar.recoverUnitSidecar(f.request, { stateFile: f.stateFile, receiptFile: f.files.receiptFile, abandonment: f.adapter }, runtime(f));
}
const recoveryState = f => (fs.existsSync(f.stateFile) ? JSON.parse(text(f.stateFile)) : null);
const kinds = f => (fs.existsSync(f.recordFile) ? text(f.recordFile).trim().split('\n').map(line => JSON.parse(line).kind) : []);
const successors = f => fs.readdirSync(f.dir).filter(name => /^activity-result\.json\.recovery-.+\.json\.receipt\.json$/.test(name));
const eventsFile = f => path.join(f.owner, '.gsd/forge/events.jsonl');
function authorityFacts(f) {
  return { lease_generation: leaseRecord(f).generation, begin_request: leaseRecord(f).request_id,
    begin_checksum: api.controller.recordChecksum(api.controller.lookupRecord(f.owner, 'transaction', 'fixture-begin')),
    claim_sha256: digest(api.runs.get(f.owner, 'M001').write_claim), transactions: fs.readdirSync(api.controller.transactionDir(f.owner)).sort() };
}

// ── Window responder: acts while the replayed attempt's owner window is open ─
function hookEnv() {
  const env = { ...process.env };
  for (const key of CREDENTIAL_KEYS) delete env[key];
  return env;
}
function runHook(f) {
  // The actual host PostToolUse path: forge-hook.js -> appendHookEvidence.
  const payload = { session_id: process.env.FORGE_CLAUDE_OWNER_SESSION_ID, cwd: f.owner, hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_input: { command: 'harness synthetic stimulus: concurrent host Bash tool' }, tool_response: { success: true } };
  return new Promise((resolve, reject) => {
    const child = cp.spawn(process.execPath, [path.join(SCRIPTS, 'forge-hook.js'), 'post'], { cwd: f.owner, env: hookEnv(),
      stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    child.once('error', reject);
    child.once('close', code => resolve(code));
    child.stdin.end(JSON.stringify(payload));
  });
}
function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name), stat = fs.lstatSync(file);
    if (stat.isDirectory()) out.push(...listFiles(file)); else out.push(file);
  }
  return out.sort();
}
const ownerEvidence = f => (fs.existsSync(path.join(f.owner, '.gsd/forge')) ? fs.readdirSync(path.join(f.owner, '.gsd/forge')).filter(name => /^evidence/.test(name)) : []);
function windowResponder(f, kind, act) {
  const signal = path.join(paths.root, `window-${kind}-${crypto.randomUUID()}.signal`), ack = `${signal}.ack`;
  const observed = { kind, handled: false, error: null };
  let busy = false;
  const timer = setInterval(() => {
    if (busy || observed.handled || !fs.existsSync(signal)) return;
    busy = true;
    Promise.resolve().then(async () => {
      observed.window_open = api.windows.observed(f.owner) !== null;
      observed.receipt_phase = JSON.parse(text(f.files.receiptFile)).phase;
      Object.assign(observed, await act());
    }).catch(error => { observed.error = error; }).finally(() => { observed.handled = true; fs.writeFileSync(ack, 'ack'); });
  }, 20);
  return { control: { kind, signal, ack }, observed, stop: () => clearInterval(timer) };
}
async function hookAct(f) {
  const control = api.windows.controlRoot(f.owner), deferredRoot = path.join(control, 'hook-evidence');
  const before = listFiles(deferredRoot), ownerBefore = ownerEvidence(f), snapshotBefore = digest(api.execution.protectedSnapshot(f.owner));
  const code = await runHook(f);
  const added = listFiles(deferredRoot).filter(file => !before.includes(file));
  return { hook_exit: code, deferred_files: added.map(file => ({ name: path.basename(file), lines: lines(file), sha256: fileSha(file),
    record: JSON.parse(text(file).trim().split('\n').at(-1)) })), owner_evidence_added: ownerEvidence(f).filter(name => !ownerBefore.includes(name)),
    owner_snapshot_unchanged: digest(api.execution.protectedSnapshot(f.owner)) === snapshotBefore,
    deferred_outside_owner: added.every(file => !api.roots.within(fs.realpathSync.native(f.owner), fs.realpathSync.native(file))) };
}

// ── Report ──────────────────────────────────────────────────────────────────
function report(name, f, extra) {
  const rec = state.recording, versions = rec.manifest.provenance.versions;
  const request = f ? f.request : null;
  const line = { case: name, label: extra.label || 'recorded', platform: PLATFORM, custody: extra.custody || state.custody,
    route: { ...rec.manifest.route, replay_transport: 'recorded-replay' },
    versions: { host: versions.host, worker: versions.worker, node_captured: versions.node, node_current: process.version,
      appserver_schema_pin: versions.appserver_schema_pin.codex_version },
    attempt: request ? { dispatch_sha256: sha(request.dispatchId), lease_generation: f.lease.generation, claim_sha256: f.claimDigest,
      recorded_dispatch_sha256: rec.manifest.provenance.attempt.dispatch_sha256 } : null,
    hashes: { recording_sha256: fileSha(RECORDING), manifest_sha256: fileSha(MANIFEST), ...(extra.hashes || {}) },
    captured_bytes: extra.captured_bytes || null, synthetic_stimuli: extra.synthetic_stimuli || [], harness_effects: extra.harness_effects || [],
    provider_calls: claudeCalls(), transport_calls: replayerCalls(), outcome: extra.outcome,
    ...(extra.finding ? { finding: extra.finding } : {}) };
  assert.equal(line.provider_calls, 0, `${name}: no provider (Claude stub) contacted`);
  state.reports.push(line); state.executed.add(name);
  console.log(JSON.stringify(line));
}
const captured = log => ({ file: RECORDING_REL, channel: 'worker', seq_ranges: seqRanges(log.consumed_seqs), records: log.consumed_seqs.length,
  client_methods: log.client_methods, placeholder_substitutions: log.placeholder_substitutions });

// ── Cases ───────────────────────────────────────────────────────────────────
async function contractV2RecordedSuccess() {
  const rec = state.recording;
  const pre = api.evidence.verifyEvidence(E2E_DIR, { expect: 'recorded' });
  assert.equal(pre.ok, true, `manifest verifies recorded before the case: ${pre.reason_code}`);
  const f = fixture(); state.success = f;
  const undo = observeTrees(f);
  const responder = windowResponder(f, 'hook', () => hookAct(f));
  const calls = replayerCalls();
  let result;
  try {
    setControl({ mode: 'success', claimed: [f.a], window: responder.control });
    result = await api.sidecar.runUnitSidecar(f.request, {});
  } finally { responder.stop(); undo(); }
  state.hook = responder.observed;
  if (responder.observed.error) throw responder.observed.error;
  assert.equal(replayerCalls(), calls + 1, 'exactly one transport call (the replayer)');
  const log = replayerLog(calls + 1);
  assert.equal(log.outcome, 'completed', `replayer outcome ${log.outcome}`);
  assert.deepEqual(log.client_methods, rec.clientMethods, 'current client method sequence equals the recorded one');
  assert.deepEqual(log.args.at(-1), 'app-server');
  const custody = requireCustody(f, 'contract-v2-recorded-success');
  state.custody = custody;
  const receipt = JSON.parse(text(f.files.receiptFile));
  assert.equal(receipt.phase, 'ready', 'receipt ready');
  assert.deepEqual(content(result), content(rec.answer), 'assembled result = recorded final answer (status and content)');
  const published = JSON.parse(text(f.files.resultFile));
  assert.deepEqual(content(published), content(rec.answer), 'published result = recorded final answer');
  assert.deepEqual(content(receipt.result), content(rec.answer), 'receipt result = recorded final answer');
  assert.equal(result.worker_engine, 'codex'); assert.equal(result.host_runtime, 'claude');
  assert.equal(text(path.join(f.a, 'same.txt')), 'after\n', 'declared harness effect materialized');
  assert.equal(text(path.join(f.a, 'operator.txt')), 'operator\r\n');
  assert.deepEqual(log.harness_effects, ['materialize-claimed-same.txt-after-LF']);
  assert.equal(api.windows.observed(f.owner), null, 'owner window closed after the attempt');
  f.successLog = log;
  report('contract-v2-recorded-success', f, { custody, outcome: 'ready', captured_bytes: captured(log),
    synthetic_stimuli: log.synthetic_stimuli, harness_effects: log.harness_effects,
    hashes: { receipt_sha256: fileSha(f.files.receiptFile), result_sha256: fileSha(f.files.resultFile), events_sha256: fileSha(eventsFile(f)),
      final_answer_sha256: sha(rec.final.text) } });
}

async function replayFirstZeroTransport() {
  const f = state.success;
  assert(f, 'requires the recorded success attempt');
  const hashes = () => ({ receipt: fileSha(f.files.receiptFile), result: fileSha(f.files.resultFile), events: fileSha(eventsFile(f)),
    owner: digest(api.execution.protectedSnapshot(f.owner)) });
  const before = hashes(), calls = replayerCalls();
  for (const label of ['first', 'repeat']) {
    const value = await recover(f);
    assert.equal(value.action, 'replay', `${label}: ${JSON.stringify(value.reason_code || value.action)}`);
    assert.equal(value.provider_called, false); assert.equal(value.result.status, state.recording.answer.status);
    assert.deepEqual(content(value.result), content(state.recording.answer));
    assert.equal(replayerCalls(), calls, `${label}: zero transport calls`);
    assert.deepEqual(hashes(), before, `${label}: receipt, result, events and owner hashes stable`);
  }
  const child = childRecover(f);
  assert.equal(child.action, 'replay', JSON.stringify(child)); assert.equal(child.provider_called, false);
  assert.equal(child.transport_calls, 0, 'fresh process: zero transport calls'); assert.equal(child.provider_calls, 0);
  assert.deepEqual(child.content, content(state.recording.answer));
  assert.equal(replayerCalls(), calls); assert.deepEqual(hashes(), before, 'fresh process: stable hashes');
  assert.equal(fs.existsSync(f.stateFile), false, 'no recovery state for a ready replay'); assert.equal(fs.existsSync(f.recordFile), false);
  report('replay-first-zero-transport', f, { outcome: 'replayed-in-process-twice-and-fresh-process', captured_bytes: null,
    hashes: { receipt_sha256: before.receipt, result_sha256: before.result, events_sha256: before.events, owner_snapshot: before.owner } });
  release(f); state.success = null;
}
function childRecover(f) {
  const input = path.join(f.dir, `child-replay-${crypto.randomUUID()}.json`);
  fs.writeFileSync(input, JSON.stringify({ request: f.request, stateFile: f.stateFile, receiptFile: f.files.receiptFile, profile: f.profile,
    replayerCalls: paths.replayerCalls, claudeCalls: paths.claudeCalls }));
  const run = cp.spawnSync(process.execPath, [__filename, '--child', input], { encoding: 'utf8', timeout: 180000, windowsHide: true, env: process.env });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
}

async function injectedFailureAbandonSuccessor() {
  const f = fixture();
  const undo = observeTrees(f);
  const calls = replayerCalls();
  let failure = null;
  try {
    setControl({ mode: 'cut-before-final', claimed: [f.a] });
    // Existing test-only options tighten the real watchdog; keep the real
    // parser, reducer, process tree and error producer. Restore before recovery.
    const client = require('./forge-appserver-client'), originalStart = client.startAppServerTurn;
    client.startAppServerTurn = options => originalStart({ ...options,
      livenessPolicy: { suspectMs: 1000, deadMs: 2500 }, livenessIntervalMs: 50 });
    try { await api.sidecar.runUnitSidecar(f.request, {}); } catch (error) { failure = error; }
    finally { client.startAppServerTurn = originalStart; }
    assert(failure, 'the cut stream must fail the attempt');
    const cutLog = replayerLog(calls + 1);
    assert.equal(cutLog.outcome, 'cut-before-final'); assert.equal(cutLog.helper_exit, 0);
    assert.deepEqual(cutLog.client_methods, state.recording.clientMethods);
    const custody = requireCustody(f, 'injected-failure-abandon-successor');
    const receiptBytes = fs.readFileSync(f.files.receiptFile), receipt = JSON.parse(receiptBytes);
    assert.equal(receipt.phase, 'failed', 'receipt failed');
    assert.equal(failure.code, 'appserver-anomalous-silence', 'real watchdog typed failure');
    assert.equal(receipt.failure.reason_code, 'appserver-anomalous-silence');
    const inspected = api.recovery.inspectReceipt(f.files.receiptFile, { processProbe: () => 'stopped' });
    assert.equal(inspected.retained_output, null, 'no durable output retained');
    assert.equal(text(path.join(f.a, 'same.txt')), 'after\n', 'the controlled descendant wrote the claimed path');
    assert.equal(writerRunning(f), false, 'the replayer child handle is joined');
    // Current live authority and the unchanged begin/claim/generation, bound before any abandonment.
    const authorityBefore = authorityFacts(f);
    assert.equal(authorityBefore.lease_generation, f.lease.generation); assert.equal(authorityBefore.begin_request, 'fixture-begin');
    assert.equal(authorityBefore.begin_checksum, f.beginChecksum); assert.equal(authorityBefore.claim_sha256, f.claimDigest);
    const questions = recoveryState(f).pending_questions;
    setControl({ mode: 'success', claimed: [f.a] });
    const value = await recover(f);
    const stimuli = ['cut-before-final-answer', 'controlled-descendant-helper',
      'remain-silent-for-real-watchdog', 'tighten-test-only-watchdog:suspectMs=1000,deadMs=2500,intervalMs=50'];
    if (api.refusal.BLOCKING_CODES.includes(value.reason_code)) {
      // The real transport failure of the primary route was classified as a BLOCKING
      // replay refusal: abandonment and the successor are never reached. Prove that
      // nothing was mutated, then report the named finding (never a forged success).
      assert.equal(value.action, 'stop', JSON.stringify(value.action));
      assert.equal(replayerCalls(), calls + 1, 'no successor transport call'); assert.equal(successors(f).length, 0);
      assert(!kinds(f).includes('proofs') && !kinds(f).includes('reset-started'), 'no proof, backup or reset');
      assert.equal(text(path.join(f.a, 'same.txt')), 'after\n', 'claimed file left as the descendant wrote it');
      assert.equal(text(path.join(f.a, 'operator.txt')), 'operator\r\n');
      assert(fs.readFileSync(f.files.receiptFile).equals(receiptBytes), 'failed receipt immutable');
      assert.deepEqual(authorityFacts(f), authorityBefore, 'same begin, generation, claim and transactions');
      assert.deepEqual(recoveryState(f).replay_refusals.map(row => row.code), [value.reason_code], 'refusal recorded once');
      const again = await recover(f);
      assert.equal(again.reason_code, value.reason_code, 'idempotent refusal');
      assert.deepEqual(recoveryState(f).replay_refusals.map(row => row.code), [value.reason_code], 'no duplicate refusal');
      assert.equal(replayerCalls(), calls + 1);
      const detail = { observed_refusal: value.reason_code, expected_refusal: api.refusal.OPERATIONAL_CODES[1],
        source_reason_code: value.classification ? value.classification.source_reason_code : null,
        receipt_reason_code: receipt.failure ? receipt.failure.reason_code : null, failure_code: failure.code || null,
        receipt_error_class: receipt.failure ? receipt.failure.error_class || null : null, platform: PLATFORM };
      report('injected-failure-abandon-successor', f, { custody, outcome: 'finding:e2e-transport-defect', captured_bytes: captured(cutLog),
        synthetic_stimuli: stimuli, harness_effects: [], hashes: { failed_receipt_sha256: sha(receiptBytes) }, finding: detail });
      release(f);
      throw new Finding('e2e-transport-defect', detail);
    }
    if (!WIN32) {
      assert.equal(value.reason_code, 'abandon-descendants-unproved', JSON.stringify(value));
      assert(api.abandon.REASON_CODES.includes(value.reason_code));
      assert.equal(replayerCalls(), calls + 1, 'no successor transport call'); assert.equal(successors(f).length, 0);
      assert.equal(text(path.join(f.a, 'same.txt')), 'after\n', 'no reset without native custody');
      assert(!kinds(f).includes('reset-started'), 'no reset started');
      assert.deepEqual(authorityFacts(f), authorityBefore);
      report('injected-failure-abandon-successor', f, { custody, outcome: `refused:${value.reason_code}`, captured_bytes: captured(cutLog),
        synthetic_stimuli: stimuli, harness_effects: [], hashes: { failed_receipt_sha256: sha(receiptBytes) } });
      return release(f);
    }
    assert.equal(value.action, 'invoke', JSON.stringify(value));
    assert.equal(value.abandonment.status, 'abandoned');
    assert.equal(value.abandonment.classification_code, 'replay-refusal-transport-no-output');
    assert(api.refusal.OPERATIONAL_CODES.includes(value.abandonment.classification_code));
    assert.deepEqual(recoveryState(f).replay_refusals.map(row => row.code), ['replay-refusal-transport-no-output']);
    assert.equal(value.route.model, CHAIN[1], 'next untried candidate of the original chain');
    assert.deepEqual(value.sidecar_ceiling, api.ceilingFromRoute(value.route), 'full tier ceiling');
    assert.equal(value.authorization_reference, REFERENCE);
    assert.equal(value.result.status, state.recording.answer.status);
    assert.equal(replayerCalls(), calls + 2, 'one original and one successor transport call');
    const successLog = replayerLog(calls + 2);
    assert.equal(successLog.outcome, 'completed'); assert.deepEqual(successLog.client_methods, state.recording.clientMethods);
    // SAME controller begin, lease generation, claim and authority: no new controller.begin.
    assert.deepEqual(authorityFacts(f), authorityBefore, 'same begin, generation, claim and transactions');
    assert.equal(api.controller.pendingTransactions(f.owner).length, 0);
    assert.equal(f.trees.length, 2, 'two transport trees under the same activity binding');
    const current = recoveryState(f);
    assert.deepEqual(current.pending_questions, questions, 'questions preserved');
    assert.deepEqual(current.abandonments.map(row => row.record_sha256), [value.abandonment.record_sha256]);
    assert.equal(current.reservations.length, 1);
    const names = successors(f); assert.equal(names.length, 1);
    const successor = JSON.parse(text(path.join(f.dir, names[0])));
    const suffix = successor.dispatch_id.slice(`${f.request.dispatchId}-recovery-`.length);
    assert(successor.dispatch_id.startsWith(`${f.request.dispatchId}-recovery-`));
    assert.equal(successor.dispatch_id, api.recoveryDispatchId(f.request.dispatchId, suffix), 'recoveryDispatchId successor');
    assert.equal(successor.dispatch_id, api.abandon.readAbandonment({ request: f.request }).successor.dispatch_id, 'invoked = admitted successor');
    assert.equal(successor.phase, 'ready'); assert.equal(successor.authorization_reference, REFERENCE);
    assert.equal(successor.route.workers_timeout, api.ceilingFromRoute(value.route).seconds);
    assert.equal(digest(successor.recovery_baseline.execution_contract), digest(receipt.recovery_baseline.execution_contract), 'same execution_contract');
    assert.deepEqual(kinds(f), ['refusal', 'owner-event', 'proofs', 'backup', 'reset-started', 'reset-root', 'reset-verified',
      'abandoned', 'owner-event', 'successor-admitted', 'owner-event'], 'refusal, proofs, verified backup, claimed reset, abandoned, successor');
    assert(fs.readFileSync(f.files.receiptFile).equals(receiptBytes), 'original failed receipt immutable');
    assert.equal(text(path.join(f.a, 'same.txt')), 'after\n', 'successor materialized the claimed file again');
    assert.equal(text(path.join(f.a, 'operator.txt')), 'operator\r\n', 'reset touched only the claims');
    report('injected-failure-abandon-successor', f, { custody, outcome: 'abandoned-then-successor-ready',
      captured_bytes: { original: captured(cutLog), successor: captured(successLog) },
      synthetic_stimuli: stimuli, harness_effects: successLog.harness_effects,
      hashes: { failed_receipt_sha256: sha(receiptBytes), successor_receipt_sha256: fileSha(path.join(f.dir, names[0])),
        abandonment_record_sha256: value.abandonment.record_sha256 } });
    return release(f);
  } finally { undo(); }
}

async function hookEvidenceWindow() {
  const observed = state.hook;
  assert(observed && observed.handled, 'the hook ran inside the replayed attempt window');
  assert.equal(observed.window_open, true, 'owner window open when the hook ran');
  assert.equal(observed.receipt_phase, 'started', 'during the attempt (receipt started)');
  assert.equal(observed.hook_exit, 0, 'hook exits cleanly');
  assert.equal(observed.deferred_files.length, 1, 'exactly one deferred hook-evidence journal written');
  const [deferred] = observed.deferred_files;
  assert.equal(deferred.lines, 1); assert.equal(deferred.record.tool, 'Bash');
  assert.equal(observed.deferred_outside_owner, true, 'kept in the external control journal');
  assert.deepEqual(observed.owner_evidence_added, [], 'no owner evidence file during the window');
  assert.equal(observed.owner_snapshot_unchanged, true, 'owner protected snapshot unchanged by the hook');
  const surface = api.surfaces.getDeclaration().surfaces.find(row => row.id === 'hook-evidence');
  assert(surface.writers.includes('scripts/forge-owner-transport-window.js#appendHookEvidence'));
  assert.equal(surface.capability, 'host-attested-append'); assert.equal(surface.operation, 'append-only');
  assert(new RegExp(surface.pattern).test(`.gsd/forge/${deferred.name}`), `hook slug matches the declared surface: ${deferred.name}`);
  // The same attempt reached ready: no execution-protected-metadata was raised.
  report('hook-evidence-window', null, { outcome: 'deferred-append-no-protected-refusal', synthetic_stimuli: ['concurrent-host-posttooluse-hook'],
    harness_effects: [], captured_bytes: null, hashes: { deferred_journal_sha256: deferred.sha256 } });
}

async function manualEditRefused() {
  const f = fixture();
  put(eventsFile(f), fs.existsSync(eventsFile(f)) ? fs.readFileSync(eventsFile(f)) : '{"fixture":"seed"}\n');
  const undo = observeTrees(f);
  const responder = windowResponder(f, 'manual-edit', async () => {
    const hook = await hookAct(f);
    const file = eventsFile(f), before = fileSha(file);
    fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), event: 'sidecar-unit', workflow_id: 'fixture-activity',
      dispatch_id: f.request.dispatchId, unit: 'execute-task/T01', status: 'done', provider_called: true, note: MANUAL_MARKER })}\n`);
    return { hook, before_sha256: before, after_sha256: fileSha(file) };
  });
  const calls = replayerCalls();
  let failure = null;
  try {
    setControl({ mode: 'success', claimed: [f.a], window: responder.control });
    try { await api.sidecar.runUnitSidecar(f.request, {}); } catch (error) { failure = error; }
  } finally { responder.stop(); undo(); }
  if (responder.observed.error) throw responder.observed.error;
  assert(failure, 'a manual same-schema edit must refuse the attempt');
  assert.equal(failure.code, 'execution-protected-metadata', `${failure.code}`);
  assert.equal(responder.observed.window_open, true);
  assert.equal(replayerCalls(), calls + 1);
  const managed = failure.managed_surfaces;
  assert(managed && Array.isArray(managed.changes), 'named managed-surfaces diagnostic');
  const change = managed.changes.find(row => row.path === '.gsd/forge/events.jsonl');
  assert(change, JSON.stringify(managed.changes.map(row => row.reason_code)));
  assert(api.surfaces.REASON_CODES.includes(change.reason_code));
  assert.equal(change.reason_code, 'managed-surface-unattributed');
  assert.equal(change.surface_id, 'owner-events');
  assert.equal(change.diff.kind, 'append'); assert.equal(change.diff.lines_appended, 1);
  assert(/^[a-f0-9]{64}$/.test(change.before_sha256) && /^[a-f0-9]{64}$/.test(change.after_sha256));
  assert.notEqual(change.before_sha256, change.after_sha256);
  assert(!managed.changes.some(row => row.surface_id === 'hook-evidence'), 'the hook in the same window is not the refused change');
  assert(!JSON.stringify(managed).includes(MANUAL_MARKER), 'sanitized diff carries no manual content');
  assert.equal(responder.observed.hook.deferred_files.length, 1, 'the hook still deferred its append in the same window');
  assert.equal(JSON.parse(text(f.files.receiptFile)).phase, 'failed');
  report('manual-edit-refused', f, { custody: custodyOf(f), outcome: `refused:${failure.code}`, captured_bytes: captured(replayerLog(calls + 1)),
    synthetic_stimuli: ['manual-same-schema-owner-events-append', 'concurrent-host-posttooluse-hook'],
    harness_effects: replayerLog(calls + 1).harness_effects,
    hashes: { manual_before_sha256: responder.observed.before_sha256, manual_after_sha256: responder.observed.after_sha256,
      diagnostic_before_sha256: change.before_sha256, diagnostic_after_sha256: change.after_sha256 } });
  release(f);
}

function copyEvidence(source, name, mutate) {
  const target = path.join(paths.root, `copy-${name}`);
  fs.mkdirSync(target);
  const manifest = JSON.parse(text(path.join(source, 'manifest.json')));
  for (const row of manifest.files) fs.copyFileSync(path.join(source, row.path), path.join(target, row.path));
  const next = mutate(manifest, target) || manifest;
  fs.writeFileSync(path.join(target, 'manifest.json'), `${JSON.stringify(next, null, 2)}\n`);
  return target;
}
function cli(dir, expect) {
  const run = cp.spawnSync(process.execPath, [path.join(SCRIPTS, 'forge-e2e-evidence.js'), '--verify', dir, '--expect', expect],
    { encoding: 'utf8', windowsHide: true, timeout: 60000, env: process.env });
  return { status: run.status, json: JSON.parse(run.stdout.trim()), stderr: run.stderr };
}
async function labelsRecordedNeverReal() {
  const recorded = api.evidence.verifyEvidence(E2E_DIR);
  assert.equal(recorded.ok, true); assert.equal(recorded.label, 'recorded');
  assert.equal(recorded.origin, 'captured'); assert.equal(recorded.execution_mode, 'replay'); assert.equal(recorded.live_bound, false);
  const asReal = api.evidence.verifyEvidence(E2E_DIR, { expect: 'real' });
  assert.equal(asReal.ok, false); assert.equal(asReal.reason_code, 'e2e-expect-mismatch');
  const positive = cli(E2E_DIR, 'recorded');
  assert.equal(positive.status, 0, positive.stderr); assert.equal(positive.json.ok, true); assert.equal(positive.json.label, 'recorded');
  const negative = cli(E2E_DIR, 'real');
  assert.equal(negative.status, 1); assert.equal(negative.json.reason_code, 'e2e-expect-mismatch');
  const relabeled = copyEvidence(E2E_DIR, 'recorded-as-real', manifest => ({ ...manifest, label: 'real', execution_mode: 'live' }));
  const promoted = api.evidence.verifyEvidence(relabeled);
  assert.equal(promoted.reason_code, 'e2e-real-requires-live');
  const promotedCli = cli(relabeled, 'real');
  assert.equal(promotedCli.status, 1); assert.equal(promotedCli.json.reason_code, 'e2e-real-requires-live');
  for (const code of [asReal.reason_code, promoted.reason_code]) assert(api.evidence.REASON_CODES.includes(code));
  report('labels-recorded-never-real', null, { outcome: 'recorded-accepted-real-refused', captured_bytes: null,
    synthetic_stimuli: ['relabel-copy-to-real'], harness_effects: [], hashes: { cli_positive: positive.json.files.map(row => row.sha256) } });
}
async function mockRelabelRefused() {
  const mock = api.evidence.verifyEvidence(MOCK_DIR, { expect: 'mock' });
  assert.equal(mock.ok, true, mock.reason_code);
  const manifestOnly = copyEvidence(MOCK_DIR, 'mock-as-recorded', manifest => ({ ...manifest, label: 'recorded' }));
  assert.equal(api.evidence.verifyEvidence(manifestOnly).reason_code, 'e2e-label-origin-mismatch');
  const full = copyEvidence(MOCK_DIR, 'mock-promoted', manifest => ({ ...manifest, label: 'recorded', origin: 'captured', execution_mode: 'replay' }));
  assert.equal(api.evidence.verifyEvidence(full).reason_code, 'e2e-synthetic-promotion');
  const fullCli = cli(full, 'recorded');
  assert.equal(fullCli.status, 1); assert.equal(fullCli.json.reason_code, 'e2e-synthetic-promotion');
  const manifestCli = cli(manifestOnly, 'recorded');
  assert.equal(manifestCli.status, 1); assert.equal(manifestCli.json.reason_code, 'e2e-label-origin-mismatch');
  report('mock-relabel-refused', null, { label: 'mock', outcome: 'refused:e2e-label-origin-mismatch,e2e-synthetic-promotion', captured_bytes: null,
    synthetic_stimuli: ['relabel-mock-copy'], harness_effects: [], hashes: {} });
}
async function recordingTamperRefused() {
  const tampered = copyEvidence(E2E_DIR, 'recording-tampered', (manifest, target) => {
    const file = path.join(target, manifest.files[0].path), bytes = fs.readFileSync(file);
    const at = bytes.indexOf(Buffer.from('"offset_ms":15,'));
    assert(at >= 0, 'tamper anchor present');
    bytes[at + '"offset_ms":'.length] = '6'.charCodeAt(0);
    fs.writeFileSync(file, bytes);
  });
  const value = api.evidence.verifyEvidence(tampered);
  assert.equal(value.ok, false); assert.equal(value.reason_code, 'e2e-file-hash-mismatch');
  const tamperedCli = cli(tampered, 'recorded');
  assert.equal(tamperedCli.status, 1); assert.equal(tamperedCli.json.reason_code, 'e2e-file-hash-mismatch');
  assert.equal(api.evidence.verifyEvidence(E2E_DIR, { expect: 'recorded' }).ok, true, 'the original recording still verifies');
  report('recording-tamper-refused', null, { outcome: 'refused:e2e-file-hash-mismatch', captured_bytes: null,
    synthetic_stimuli: ['one-byte-change-in-copy'], harness_effects: [],
    hashes: { tampered_sha256: fileSha(path.join(tampered, 'recording.jsonl')), original_sha256: fileSha(RECORDING) } });
}
function section(file, heading) {
  const body = text(file).replace(/\r\n/g, '\n'), start = body.indexOf(`\n${heading}\n`);
  assert(start >= 0, `${path.basename(file)}: ${heading}`);
  const rest = body.slice(start + heading.length + 2), end = rest.search(/\n## /);
  return end >= 0 ? rest.slice(0, end) : rest;
}
const tableIds = block => block.split('\n').map(line => /^\| `([a-z0-9-]+)` \|/.exec(line)).filter(Boolean).map(match => match[1]);
async function docsTablesMatch() {
  const cases = section(HARNESS_DOC, '## Casos');
  assert(cases.includes('| Caso | Rótulo | Bytes capturados | Estímulos sintéticos | Efeitos do harness | Limite por plataforma |'), 'case table header');
  assert.deepEqual(tableIds(cases), CASES, 'e2e-harness.md case table = executed cases');
  for (const name of CASES.filter(name => name !== 'docs-tables-match')) assert(state.executed.has(name), `${name} executed`);
  const codes = section(WINDOWS_DOC, '## Códigos do verificador');
  assert.deepEqual(tableIds(codes), [...api.evidence.REASON_CODES], 'windows-evidence.md codes = REASON_CODES');
  report('docs-tables-match', null, { outcome: 'tables-equal', captured_bytes: null, synthetic_stimuli: [], harness_effects: [],
    hashes: { harness_doc_sha256: fileSha(HARNESS_DOC), windows_doc_sha256: fileSha(WINDOWS_DOC) } });
}

const RUNNERS = {
  'contract-v2-recorded-success': contractV2RecordedSuccess,
  'replay-first-zero-transport': replayFirstZeroTransport,
  'injected-failure-abandon-successor': injectedFailureAbandonSuccessor,
  'hook-evidence-window': hookEvidenceWindow,
  'manual-edit-refused': manualEditRefused,
  'labels-recorded-never-real': labelsRecordedNeverReal,
  'mock-relabel-refused': mockRelabelRefused,
  'recording-tamper-refused': recordingTamperRefused,
  'docs-tables-match': docsTablesMatch,
};

// Fixture bytes (captured and synthetic) must be identical before and after.
function fixtureBytes() {
  return Object.fromEntries([E2E_DIR, MOCK_DIR].flatMap(dir => fs.readdirSync(dir).sort()
    .map(name => [path.relative(SOURCE, path.join(dir, name)).replace(/\\/g, '/'), fileSha(path.join(dir, name))])));
}

async function childMain(file) {
  // Fresh Node process: replay only. No live custody origin and no writer
  // attestation exists here, so any abandonment would be refused; a transport or
  // provider call would be counted by the replayer and the Claude stub.
  const input = JSON.parse(text(file));
  load();
  const before = { transport: lines(input.replayerCalls), provider: lines(input.claudeCalls) };
  const adapter = api.abandon.createAbandonmentAdapter({ attestWriter: () => null, attestRoot: () => null, revalidateAttribution: () => null });
  const recoveryAuthorization = { reference: REFERENCE, adapter: require('./forge-interaction').createRecoveryAuthorizationAdapter(
    observed => ({ ...observed, received: true, answer: 'authorize', resolved_at: Date.now() - 1000 }), { resolveProfile: () => input.profile }) };
  const value = await api.sidecar.recoverUnitSidecar(input.request, { stateFile: input.stateFile, receiptFile: input.receiptFile,
    abandonment: adapter }, { processProbe: () => 'stopped', recoveryAuthorization });
  process.stdout.write(JSON.stringify({ action: value.action, reason_code: value.reason_code || null, provider_called: value.provider_called,
    content: value.result ? content(value.result) : null, transport_calls: lines(input.replayerCalls) - before.transport,
    provider_calls: lines(input.claudeCalls) - before.provider }) + '\n');
}

async function main() {
  if (process.argv[2] === '--child') return childMain(process.argv[3]);
  const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  const reportFile = process.env.FORGE_ISSUE_440_E2E_REPORT;
  const reportSource = fileSha(__filename), reportStarted = new Date().toISOString();
  if (reportFile) {
    assert(path.isAbsolute(reportFile)); assert.equal(path.basename(reportFile), 'cases.json');
    const tempRoot = fs.realpathSync.native(os.tmpdir()), parent = fs.realpathSync.native(path.dirname(reportFile));
    const relative = path.relative(tempRoot, parent);
    assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    assert(!fs.lstatSync(path.dirname(reportFile)).isSymbolicLink()); assert(!fs.existsSync(reportFile));
  }
  // HOME/USERPROFILE (and CODEX_HOME) isolated BEFORE the harness and any adapter.
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-440-e2e-home-'));
  for (const key of CREDENTIAL_KEYS) delete process.env[key];
  Object.assign(process.env, { HOME: isolatedHome, USERPROFILE: isolatedHome, CODEX_HOME: path.join(isolatedHome, '.codex') });
  let completed = false, passed = 0;
  const started = Date.now(), failures = [];
  try {
    // Existing isolation harness first: TEMP/TMP, FORGE_HOME and the account lookup.
    harness = require('./fixtures/issues-434-436/execution-fixtures.cjs').createFixtureHarness();
    paths.root = path.join(harness.root, 'recorded-harness'); fs.mkdirSync(paths.root);
    paths.logDir = path.join(paths.root, 'replayer-logs'); fs.mkdirSync(paths.logDir);
    paths.replayerCalls = path.join(paths.root, 'replayer-calls.txt');
    paths.claudeCalls = path.join(paths.root, 'claude-stub-calls.txt');
    paths.control = path.join(paths.root, 'replayer-control.json');
    paths.replayer = path.join(paths.root, 'recorded-replayer.js');
    paths.claude = path.join(paths.root, 'claude-stub.js');
    fs.writeFileSync(paths.replayer, REPLAYER_SOURCE); fs.writeFileSync(paths.claude, CLAUDE_STUB_SOURCE);
    process.env.FORGE_XLLM_CODEX_BIN = paths.replayer; process.env.FORGE_XLLM_CLAUDE_BIN = paths.claude;
    load();
    const bytesBefore = fixtureBytes();
    state.recording = recording();
    for (const name of CASES) {
      const at = Date.now();
      try {
        await RUNNERS[name]();
        passed++;
        console.log(`PASS ${name} (${Date.now() - at} ms)`);
      } catch (error) {
        // Every case runs; a failure (or named finding) never hides the others.
        failures.push({ case: name, code: error instanceof Finding ? error.code : 'assertion-failed', finding: error instanceof Finding });
        console.log(`FAIL ${name} (${Date.now() - at} ms): ${error instanceof Finding ? error.message : error && error.message}`);
        if (!(error instanceof Finding)) console.error(error && error.stack || error);
      }
    }
    assert.deepEqual(fixtureBytes(), bytesBefore, 'captured and synthetic fixture bytes unchanged');
    assert.equal(claudeCalls(), 0, 'provider_calls 0');
    console.log(`${passed}/${CASES.length} forge-issue-440-e2e cases passed (platform ${PLATFORM}, custody ${state.custody}, `
      + `transport recorded-replay, provider_calls ${claudeCalls()}, transport_calls ${replayerCalls()}, ${Date.now() - started} ms)`);
    if (failures.length) {
      console.log(JSON.stringify({ failures }));
      process.exitCode = 1;
    }
    if (reportFile) {
      assert.equal(fileSha(__filename), reportSource, 'report source stable during this execution');
      fs.writeFileSync(reportFile, JSON.stringify({ schema_version: 1, source_sha256: reportSource,
        rows: state.reports, passed: failures.length === 0 && passed === CASES.length,
        started_at: reportStarted, completed_at: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
    }
    // Owned Temp is removed when only named findings failed; any other failure is preserved for diagnosis.
    completed = failures.every(row => row.finding);
  } finally {
    for (const f of [...state.fixtures]) { try { release(f); } catch { /* preserved for diagnosis */ } }
    if (harness) harness.close(completed);
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
  return undefined;
}
module.exports = { CASES };
if (require.main === module) main().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
