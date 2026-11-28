#!/usr/bin/env node
'use strict';
// Issue 440 S02/T05 — canonical execute result at the transport boundaries.
//
// Every transport here is a MOCK, labelled as such: one local Node program
// plays the Codex app-server JSON-RPC stream (host Claude -> worker Codex, the
// primary route) and the Claude CLI stream-json result (host Codex -> worker
// Claude); the native host callback is a local function. Zero providers, no
// network, no real owner state. The production entry points, parsers,
// assembler, receipts, publication and replay are the real ones.
//
// The fixture harness is created FIRST: it isolates TEMP/FORGE_HOME and swaps
// the account lookup before any adapter module is loaded.
const harness = require('./fixtures/issues-434-436/execution-fixtures.cjs').createFixtureHarness();
const assert = require('assert/strict'), fs = require('fs'), path = require('path'), crypto = require('crypto'), cp = require('child_process');

const SCRIPTS = __dirname;
const MAP_FILE = path.join(SCRIPTS, '..', 'docs', 'issue-440', 'canonical-result-consumers.md');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fileSha = file => fs.existsSync(file) ? sha(fs.readFileSync(file)) : null;

// Measured before any T05 source edit (owner pin record 2026-11-22T01:09:17Z).
const PINS = Object.freeze({
  functions: Object.freeze({
    assembleExecuteResult: '397fe3c62742d00eac50ca41aa659d18a5ee6bfabf09a120f4b3d1a0bf4b02f8',
    validateAssembledExecuteResult: '51642f7f9330cd3f92cc79070899755a500d09a3f4f74e8f638ec4629e585ffb',
    validateExecuteResult: 'dea6127a07ac421dfddd993a0c25d05c129cccbfd2c48eabc71a082bddf36627',
  }),
  files: Object.freeze({
    'scripts/forge-xllm.js': '96f11f6a3eb94ad1a6fc69ab22cba49f1646e5017e40acaf09844cf7a982f8f4',
    'scripts/forge-sidecar-verification-repair.js': 'e7e4e1a0da21193c9e6898bae773b52a42254809d8f3a1207af2590b742b076e',
  }),
});
// Top-level keys of the execute result per transport (receipt and published),
// measured on this fixture through the real entry points and frozen here. The
// Codex publication adds only transport_telemetry (calibration commit of the
// accepted record); the receipt result never carries it.
const SIDECAR_KEYS = ['appserver', 'capability', 'dispatch_id', 'duration_secs', 'files_changed', 'files_changed_declared',
  'finished_at', 'head_sha', 'host_runtime', 'input_tokens', 'must_haves_status', 'output_tokens', 'parse_path', 'pre_dirty',
  'protocol_version', 'start_sha', 'started_at', 'status', 'summary', 'token_method', 'worker_engine', 'workflow_id'];
const KEYSETS = Object.freeze({
  'app-server': Object.freeze({ receipt: Object.freeze([...SIDECAR_KEYS, 'runtime_evidence'].sort()),
    published: Object.freeze([...SIDECAR_KEYS, 'runtime_evidence', 'transport_telemetry'].sort()), parse_path: 'output-schema' }),
  'claude-cli': Object.freeze({ receipt: Object.freeze([...SIDECAR_KEYS, 'transport_telemetry'].sort()),
    published: Object.freeze([...SIDECAR_KEYS, 'transport_telemetry'].sort()), parse_path: 'structured-output' }),
  native: Object.freeze({ receipt: Object.freeze(['dispatch_id', 'files_changed', 'host_runtime', 'must_haves_status', 'native', 'status',
    'summary', 'worker_engine', 'workflow_id']), published: Object.freeze(['dispatch_id', 'files_changed', 'host_runtime',
    'must_haves_status', 'native', 'status', 'summary', 'worker_engine', 'workflow_id']), parse_path: undefined }),
});
// One synthetic worker answer, identical for every transport.
const PAYLOAD = Object.freeze({ status: 'done', summary: 'Issue 440 mock transport differential',
  must_haves_status: [{ item: 'fixture stays observable', status: 'met', note: 'mock transport; no provider', scope: 'task', reason: '' }],
  files_changed: ['src.js'] });
const NEXT_ACTION = Object.freeze({ action: 'recover-attempt', order: ['inspect', 'replay', 'abandon', 'new-begin'],
  api: 'recoverUnitSidecar', refusal_set: 'replay-refusal-v1' });
const MESSAGES = Object.freeze({
  beginStarted: 'The attempt is started without a durable result; inspect it before a new dispatch.',
  runFailed: 'Recorded sidecar attempt failed; no provider was relaunched.',
  runStarted: 'Inspect the recorded heartbeat/process and recover this attempt before retrying with a new dispatch id. No worker was relaunched.',
});

const executed = new Set();
function pass(name, detail) { executed.add(name); console.log(`PASS ${name}: ${detail}`); }

const MOCK_SOURCE = String.raw`'use strict';
// MOCK transport for issue 440 S02/T05: a local program, never a provider.
const fs = require('fs'), path = require('path'), readline = require('readline');
const control = JSON.parse(fs.readFileSync(path.join(process.cwd(), '../control.json'), 'utf8'));
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
function act(transport) {
  fs.appendFileSync(control.calls, transport + '\n');
  for (const [file, content] of Object.entries(control.writes || {})) fs.writeFileSync(file, content);
  if (control.failure) { process.stderr.write('mock transport failure after writes'); process.exit(9); }
  return control.payload;
}
if (process.argv.includes('app-server')) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', line => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') send({ id: message.id, result: { serverInfo: { name: 'issue-440-mock' } } });
    else if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-mock' } } });
    else if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'turn-mock' } } });
      const value = act('app-server');
      send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(value) } } });
      send({ method: 'turn/completed', params: { turn: { id: 'turn-mock', status: 'completed' } } });
    }
  });
} else {
  const args = process.argv.slice(2), model = args[args.indexOf('--model') + 1], at = args.indexOf('--session-id');
  if (at >= 0) send({ type: 'system', subtype: 'init', session_id: args[at + 1] });
  const value = act('claude-cli');
  send({ type: 'result', subtype: 'success', is_error: false, structured_output: value,
    result: ['---GSD-WORKER-RESULT---', 'status: ' + value.status, 'result_json: ' + JSON.stringify(value), '---END-RESULT---'].join('\n'),
    ...(at >= 0 ? { session_id: args[at + 1] } : {}), modelUsage: { [model]: { inputTokens: 1, outputTokens: 1 } } });
}
`;
const DRIVER_SOURCE = String.raw`'use strict';
// Fresh Node process: replay only. A native callback that is reached fails the case.
const fs = require('fs'), path = require('path');
const [scripts, configFile] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const unit = require(path.join(scripts, 'forge-unit-sidecar.js'));
let invoked = 0;
const runtime = config.caps ? { activeCapabilities: config.caps, readback: async () => ({}),
  invokeNative: async () => { invoked++; throw new Error('replay must not infer'); } } : {};
(async () => {
  const run = await unit.runUnitSidecar(config.request, runtime);
  const replay = await unit.replayArtifactAttempt(config.request);
  fs.writeFileSync(config.out, JSON.stringify({ ok: true, invoked, run, replayed: replay.replayed, provider_called: replay.provider_called, result: replay.result }));
})().catch(error => { fs.writeFileSync(config.out, JSON.stringify({ ok: false, invoked, code: error.code || null })); process.exitCode = 1; });
`;

let xllm, unit, recovery, roots, workerContract, envPromote, reverify, mock, driver;
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

function pinsCase(stage) {
  for (const [name, expected] of Object.entries(PINS.functions)) {
    assert.equal(typeof xllm[name], 'function', name);
    assert.equal(sha(xllm[name].toString()), expected, `${stage}: ${name}.toString() pin changed`);
  }
  for (const [relative, expected] of Object.entries(PINS.files)) {
    assert.equal(fileSha(path.join(SCRIPTS, '..', relative)), expected, `${stage}: ${relative} bytes changed`);
  }
  pass('pins-immutable', `${stage}: three function pins and two whole-file pins (assembler, validators, #439 repair) unchanged`);
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function receiptFile(f) { return f.r.resultFile + '.receipt.json'; }
function calls(f) { return f.kind === 'native' ? f.calls() : fs.existsSync(f.control.calls) ? fs.readFileSync(f.control.calls, 'utf8').split('\n').filter(Boolean).length : 0; }
function ownerFiles(f) {
  const loc = unit.locations(f.r);
  return [...new Set([...loc.required, loc.delivery?.input, loc.delivery?.output].filter(Boolean))].map(rel => path.join(f.owner, rel));
}
// Every durable byte a replay could duplicate or rewrite.
function snapshot(f) {
  const files = { receipt: receiptFile(f), result: f.r.resultFile, events: path.join(f.owner, '.gsd/forge/events.jsonl') };
  for (const file of ownerFiles(f)) files[path.relative(f.owner, file)] = file;
  return Object.fromEntries(Object.entries(files).map(([key, file]) => [key, fileSha(file)]));
}
function withPayload(f, extra = {}) {
  Object.assign(f.control, { payload: PAYLOAD }, extra);
  harness.write(f.controlFile, f.control);
  return f;
}

function appServerFixture() {
  // Primary route: host Claude dispatches the Codex app-server sidecar.
  const f = withPayload(harness.setup());
  harness.write(path.join(f.owner, '.gsd/forge-prefs.jsonc'), { routing: { frontend: { executor: { heavy: ['gpt-6.1-sol'] } } },
    effort: { 'execute-task': 'high' }, token_budget: { coding_standards: 32 } });
  f.r.route = require('./forge-dispatch-resolve').resolveDispatch({ cwd: f.owner, unitType: 'execute-task', scope: 'standalone-task',
    phase: 'execute', planPath: f.r.planFile, hostRuntime: 'claude', unitId: harness.id });
  assert.equal(f.r.route.host_runtime, 'claude'); assert.equal(f.r.route.worker_mode, 'sidecar');
  assert.equal(f.r.route.resolved_worker_engine, 'codex');
  return Object.assign(f, { kind: 'app-server', runtime: {} });
}
function claudeFixture(extra) {
  const f = withPayload(harness.setup(), extra);
  assert.equal(f.r.route.host_runtime, 'codex'); assert.equal(f.r.route.resolved_worker_engine, 'claude');
  assert.equal(f.r.route.worker_mode, 'sidecar');
  return Object.assign(f, { kind: 'claude-cli', runtime: {} });
}
function nativeFixtureCase() {
  const f = harness.nativeFixture(), original = f.runtime.invokeNative;
  // The fixture callback keeps its own invocation asserts; the answer is the shared mock payload.
  f.runtime.invokeNative = async (...args) => { await original(...args); return structuredClone(PAYLOAD); };
  return Object.assign(f, { kind: 'native' });
}

async function transportCase(f) {
  const result = await unit.runUnitSidecar(f.r, f.runtime);
  assert.equal(calls(f), 1, `${f.kind}: exactly one mock transport call`);
  const receipt = readJson(receiptFile(f));
  assert.equal(receipt.phase, 'ready', `${f.kind}: ready receipt`);
  if (f.kind !== 'native') {
    const lines = fs.readFileSync(f.control.calls, 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(lines, [f.kind], `${f.kind}: the labelled mock transport answered`);
  }
  Object.assign(f, { result, receipt, summary: fs.readFileSync(path.join(f.owner, unit.locations(f.r).required[0]), 'utf8') });
  pass(`transport-${f.kind === 'app-server' ? 'app-server-from-claude' : f.kind === 'claude-cli' ? 'claude-cli-from-codex' : 'native-codex'}`,
    `${f.kind}: real entry point published ${result.status} from the mock stream; one transport call`);
  return f;
}

// The worker-returned part as every assembled consumer must read it.
function content(result) {
  const declared = Object.hasOwn(result, 'files_changed_declared') ? result.files_changed_declared : result.files_changed;
  return { status: result.status, summary: result.summary, must_haves_status: result.must_haves_status, declared };
}
function mustHavesSection(summary) {
  const match = /## Must haves\n\n([\s\S]*?)\n\n/.exec(summary);
  assert(match, 'SUMMARY carries the must-haves section');
  return JSON.parse(match[1]);
}

function differentialCases(cases) {
  // Wire: the worker payload is validated by the field gate and the Claude
  // worker contract; the assembled shape is never fed to validateExecuteResult.
  assert.equal(xllm.validateExecuteResult(PAYLOAD), true);
  assert.equal(workerContract.contract('execute').validate(structuredClone(PAYLOAD)).ok, true);
  for (const f of cases.filter(row => row.kind !== 'native')) {
    assert.equal(xllm.validateExecuteResult(f.result), false, `${f.kind}: VCS-derived files_changed is not the wire shape`);
    assert.equal(xllm.validateExecuteResult({ ...f.result, files_changed: f.result.files_changed_declared }), true);
  }
  const native = cases.find(row => row.kind === 'native');
  assert.equal(xllm.validateExecuteResult(native.result), true, 'native keeps the raw wire-shaped result plus trusted metadata');
  pass('wire-boundary', 'validateExecuteResult and the Claude execute contract accept the wire payload; assembled sidecar results only through validateAssembledExecuteResult');

  for (const f of cases) {
    assert.equal(xllm.validateAssembledExecuteResult(f.result), true, `${f.kind}: assembled result accepted`);
    assert.equal(xllm.validateAssembledExecuteResult(f.receipt.result), true, `${f.kind}: receipt result accepted`);
  }
  pass('assembled-validator-per-transport', 'validateAssembledExecuteResult accepts the published and the receipt result of app-server, Claude CLI and native');

  const expected = content(PAYLOAD);
  for (const f of cases) {
    assert.deepEqual(content(f.result), expected, `${f.kind}: published content`);
    assert.deepEqual(content(f.receipt.result), expected, `${f.kind}: receipt content`);
    if (f.kind !== 'native') assert.deepEqual(f.result.files_changed.map(row => row.path), ['src.js'], `${f.kind}: derived delta`);
  }
  pass('content-status-differential', 'status, summary, must_haves_status and declared files are identical across the three transports, published and in the receipt');

  // Evidence projection is a privacy transform, not execute-result admission.
  const project = require('./forge-e2e-evidence').projectFinalAnswer;
  const projections = cases.map(f => {
    const value = content(f.result);
    return project(JSON.stringify({ status: value.status, summary: value.summary, must_haves_status: value.must_haves_status, files_changed: value.declared }));
  });
  assert(projections[0], 'wire-shaped evidence projects');
  for (const projected of projections) assert.equal(projected, projections[0], 'same privacy projection across transport contents');
  const projected = JSON.parse(projections[0]);
  assert.equal(projected.status, PAYLOAD.status);
  assert.match(projected.summary, /^<TEXT-[a-f0-9]{16}-[0-9]+>$/);
  assert.match(projected.files_changed[0], /^<PATH-[a-f0-9]{16}-[0-9]+>$/);
  assert(!projections[0].includes(PAYLOAD.summary));
  assert.equal(project(projections[0]), projections[0], 'projection is idempotent');
  assert.equal(project(JSON.stringify({ ...PAYLOAD, unexpected: true })), null, 'unknown field refused');
  assert.equal(project(JSON.stringify({ ...PAYLOAD, status: 'invalid' })), null, 'unknown status refused');
  pass('evidence-privacy-projection', 'closed evidence projection agrees across transport content and rejects extra fields and invalid status');

  for (const f of cases) assert.deepEqual(mustHavesSection(f.summary), PAYLOAD.must_haves_status, `${f.kind}: SUMMARY must-haves`);
  assert.equal(new Set(cases.map(f => f.summary.split('## Must haves')[1].split('\n\n')[1])).size, 1);
  pass('delivery-summary-differential', 'executeDeliveryArtifacts renders the same must-haves bytes into SUMMARY for every transport');

  const plan = fs.readFileSync(cases[0].r.planFile, 'utf8');
  const promotions = cases.map(f => envPromote.checkEnvPromotion(f.result, plan));
  for (const value of promotions) assert.deepEqual(value, promotions[0]);
  assert.equal(promotions[0].reason, 'not-applicable');
  pass('env-promote-differential', 'checkEnvPromotion returns the same verdict for each transport result');

  const reverifications = cases.map(f => [reverify.needsReverification(f.result), reverify.hasDivergentCommandNotes(f.result.must_haves_status)]);
  for (const value of reverifications) assert.deepEqual(value, reverifications[0]);
  pass('reverify-differential', 'needsReverification and divergent-note detection agree for each transport result');

  // #439: the repair admits a retained result exactly by this predicate.
  for (const f of cases) assert.equal(xllm.validateAssembledExecuteResult(f.result) && f.result.status === 'done', true);
  pass('repair-439-predicate', 'the verification repair admission predicate holds identically for each transport result');

  for (const f of cases) {
    assert.deepEqual(Object.keys(f.receipt.result).sort(), [...KEYSETS[f.kind].receipt], `${f.kind}: frozen receipt result keyset`);
    assert.deepEqual(Object.keys(f.result).sort(), [...KEYSETS[f.kind].published], `${f.kind}: frozen published result keyset`);
    assert.equal(f.result.parse_path, KEYSETS[f.kind].parse_path, `${f.kind}: parse path`);
    assert(!Object.hasOwn(f.result, 'degradation'), `${f.kind}: no degraded parse`);
  }
  pass('keysets-frozen', 'receipt and published result keysets and parse path per transport equal the frozen sets');

  // The framed worker envelope (the same block the Claude mock prints in
  // `result`) through the real framed parsers gives the same content.
  const framed = ['---GSD-WORKER-RESULT---', 'status: ' + PAYLOAD.status, 'result_json: ' + JSON.stringify(PAYLOAD), '---END-RESULT---'].join('\n');
  const envelope = require('./forge-worker-result').parseJsonEnvelope(framed);
  assert.equal(envelope.ok, true); assert.equal(envelope.status, PAYLOAD.status); assert.deepEqual(envelope.payload, structuredClone(PAYLOAD));
  const parsed = require('./forge-claude-sidecar').parseExecuteCandidate(framed).candidate;
  assert.deepEqual(content(parsed), content(PAYLOAD));
  assert.throws(() => require('./forge-claude-sidecar').parseExecuteCandidate(framed.replace('status: done', 'status: partial')), error => error.code === 'claude-invalid-result');
  pass('framed-envelope-parser', 'parseJsonEnvelope and parseExecuteCandidate read the framed mock block with identical content; a status mismatch refuses');

  // Rows of a plain execute result carry no milestone-recovery criterion
  // identity (kind/index), so the native recovery delivery and artifact
  // advisory readers do not apply to them on any transport; nor do they
  // carry the repair plan's `dropped` list.
  for (const f of cases) assert(f.result.must_haves_status.every(row => !Object.hasOwn(row, 'kind') && !Object.hasOwn(row, 'index')));
  for (const f of cases) assert.equal(f.result.must_haves_status.dropped, undefined);
  assert.equal(workerContract.contract('execute').validate({ ...structuredClone(PAYLOAD),
    must_haves_status: [{ ...PAYLOAD.must_haves_status[0], kind: 'artifact', index: 0 }] }).ok, false);
  pass('not-applicable-profiles', 'execute rows never carry kind/index; the closed execute contract refuses them');
}

async function replayCases(cases) {
  for (const f of cases) {
    const before = snapshot(f), count = calls(f);
    const again = await unit.runUnitSidecar(f.r, f.runtime);
    assert.deepEqual(content(again), content(f.result)); assert.equal(again.status, f.result.status);
    assert.equal(calls(f), count, `${f.kind}: replay reached no transport`);
    assert.deepEqual(snapshot(f), before, `${f.kind}: replay duplicated or rewrote no artifact, event, receipt or result`);
    f.stable = before;
  }
  pass('replay-same-process', 'runUnitSidecar on a ready receipt: zero transport calls, artifact/event/receipt/result hashes stable');

  for (const f of cases) {
    const replay = await unit.replayArtifactAttempt(f.r);
    assert.equal(replay.replayed, true); assert.equal(replay.provider_called, false);
    assert.deepEqual(content(replay.result), content(f.result));
    assert.equal(calls(f), 1); assert.deepEqual(snapshot(f), f.stable, `${f.kind}: replayArtifactAttempt is byte-stable`);
  }
  pass('replay-artifact-attempt', 'replayArtifactAttempt republishes the ready receipt with provider_called false and stable hashes');

  for (const f of cases) {
    const config = path.join(f.dir, 'replay-config.json'), out = path.join(f.dir, 'replay-out.json');
    fs.writeFileSync(config, JSON.stringify({ request: f.r, caps: f.kind === 'native' ? f.caps : null, out }));
    const child = cp.spawnSync(process.execPath, [driver, SCRIPTS, config], { cwd: f.dir, env: process.env, encoding: 'utf8', windowsHide: true, timeout: 180000 });
    assert.equal(child.error, undefined, String(child.error));
    const outcome = readJson(out);
    assert.equal(outcome.ok, true, `${f.kind}: fresh replay ${outcome.code} ${child.stderr.slice(0, 400)}`); assert.equal(child.status, 0);
    assert.equal(outcome.invoked, 0); assert.equal(outcome.replayed, true); assert.equal(outcome.provider_called, false);
    assert.deepEqual(content(outcome.run), content(f.result)); assert.deepEqual(content(outcome.result), content(f.result));
    assert.equal(calls(f), 1, `${f.kind}: fresh process reached no transport`);
    assert.deepEqual(snapshot(f), f.stable, `${f.kind}: fresh-process replay is byte-stable`);
  }
  pass('replay-fresh-process', 'a new Node process replays each ready receipt twice with zero transport calls and identical hashes');
}

function identity(f, record) {
  assert.equal(record.fingerprint, unit.artifactFingerprint(f.r), `${f.kind}: fingerprint`);
  assert.equal(record.recovery_identity_sha256, roots.digest(recovery.requestIdentity(recovery.canonicalRequest(f.r))), `${f.kind}: recovery identity`);
  // Execution-path failed/started receipts never carried route_identity; they
  // keep the exact route it derives from, and nothing adds the field later.
  if (!Object.hasOwn(record, 'route_identity')) {
    assert.equal(record.phase === 'ready', false, `${f.kind}: a ready receipt carries route_identity`);
    assert.deepEqual(record.route, f.r.route, `${f.kind}: recorded route`);
    return;
  }
  const expected = unit.routeIdentity(f.r.route, 'execute-task');
  for (const key of ['unit_type', 'model_requested', 'model_resolved', 'resolved_worker_engine', 'worker_mode', 'effort', 'dispatch_allowed']) {
    assert.deepEqual(record.route_identity[key], expected[key], `${f.kind}: route_identity.${key}`);
  }
}

function assertNextAction(error, code, message) {
  assert.equal(error.code, code); assert.equal(error.message, message);
  assert.deepEqual(error.next_action, NEXT_ACTION);
  assert.deepEqual(Object.keys(error.next_action), ['action', 'order', 'api', 'refusal_set']);
  assert(Object.isFrozen(error.next_action) && Object.isFrozen(error.next_action.order), 'next_action and its order are frozen');
  assert.equal(error.next_action.refusal_set, require('./forge-replay-refusal').REFUSAL_SET_VERSION);
  const text = JSON.stringify(error.next_action);
  assert(!/[\\/]/.test(text) && !text.includes(harness.root), 'next_action carries no path or payload');
  return true;
}
function bytesOf(f) { return { receipt: fs.readFileSync(receiptFile(f)), result: fs.existsSync(f.r.resultFile) ? fs.readFileSync(f.r.resultFile) : null }; }
function sameBytes(f, before, label) {
  const now = bytesOf(f);
  assert(now.receipt.equals(before.receipt), `${label}: receipt bytes unchanged`);
  assert(before.result === null ? now.result === null : now.result.equals(before.result), `${label}: result bytes unchanged`);
  assert(!now.receipt.includes('next_action') && !(now.result || Buffer.alloc(0)).includes('next_action'), `${label}: next_action is never persisted`);
}

async function recordedAttemptCases(cases) {
  for (const f of cases) identity(f, f.receipt);
  // Failed receipts written by the real failure path of the Claude CLI mock
  // (writes, then exit 9). Two of them are then observed as `started` and as
  // a non-started phase, the established fixture mutation for an attempt
  // interrupted before any durable result.
  const failedAttempt = async () => {
    const f = claudeFixture({ failure: true });
    await assert.rejects(() => unit.runUnitSidecar(f.r, f.runtime));
    const record = readJson(receiptFile(f));
    assert.equal(record.phase, 'failed'); assert.equal(calls(f), 1); identity(f, record);
    return { f, record };
  };
  const { f: failed, record: failedRecord } = await failedAttempt(), code = failedRecord.failure.reason_code;
  const { f: started, record: startedRecord } = await failedAttempt();
  fs.writeFileSync(receiptFile(started), JSON.stringify({ ...startedRecord, phase: 'started' }, null, 2) + '\n');
  const { f: executedPhase, record: executedRecord } = await failedAttempt();
  fs.writeFileSync(receiptFile(executedPhase), JSON.stringify({ ...executedRecord, phase: 'executed' }, null, 2) + '\n');
  identity(started, readJson(receiptFile(started)));
  pass('legacy-identities', 'ready (three transports), failed and started receipts keep fingerprint, recovery_identity_sha256 and route_identity');

  let before = bytesOf(failed);
  assert.throws(() => unit.beginArtifactAttempt(failed.r), error => assertNextAction(error, code, code));
  sameBytes(failed, before, 'begin failed');
  before = bytesOf(started);
  assert.throws(() => unit.beginArtifactAttempt(started.r), error => assertNextAction(error, 'sidecar-attempt-interrupted', MESSAGES.beginStarted));
  sameBytes(started, before, 'begin started');
  pass('next-action-begin', 'beginArtifactAttemptInsideOwnerWindow: failed keeps its reason code, started keeps sidecar-attempt-interrupted and message; frozen next_action; bytes unchanged');

  before = bytesOf(failed);
  await assert.rejects(() => unit.acceptArtifactResult(failed.r, structuredClone(PAYLOAD), { providerCalled: true }), error => assertNextAction(error, code, code));
  sameBytes(failed, before, 'accept failed');
  before = bytesOf(executedPhase);
  await assert.rejects(() => unit.acceptArtifactResult(executedPhase.r, structuredClone(PAYLOAD), { providerCalled: true }),
    error => assertNextAction(error, 'sidecar-attempt-interrupted', 'sidecar-attempt-interrupted'));
  sameBytes(executedPhase, before, 'accept non-started');
  pass('next-action-accept', 'acceptArtifactResultCore: failed and non-started refusals keep code and message and gain the frozen next_action; bytes unchanged');

  before = bytesOf(failed);
  await assert.rejects(() => unit.runUnitSidecar(failed.r, failed.runtime), error => {
    assertNextAction(error, code, MESSAGES.runFailed); assert.equal(error.provider_called, false); return true;
  });
  sameBytes(failed, before, 'run failed');
  before = bytesOf(started);
  await assert.rejects(() => unit.runUnitSidecar(started.r, started.runtime), error => {
    assertNextAction(error, 'sidecar-attempt-interrupted', MESSAGES.runStarted); assert.equal(error.provider_called, false); return true;
  });
  sameBytes(started, before, 'run started');
  for (const f of [failed, started, executedPhase]) assert.equal(calls(f), 1, 'no failed or started refusal relaunched the transport');
  identity(failed, readJson(receiptFile(failed))); identity(started, readJson(receiptFile(started)));
  pass('next-action-run', 'runUnitSidecarCore: failed and started receipts refuse with the original code/message, frozen next_action, zero relaunch, identities and bytes unchanged');
}

// The consumer map names real call sites and only cases this suite executed.
function mapCase() {
  const text = fs.readFileSync(MAP_FILE, 'utf8');
  assert(/## Método do censo/.test(text), 'the map records its census method');
  for (const term of ['validateExecuteResult', 'validateAssembledExecuteResult', 'must_haves_status', 'files_changed_declared', 'result.status']) {
    assert(text.includes(term), `census method names ${term}`);
  }
  const rows = text.split(/\r?\n/).filter(line => /^\| C\d+ \|/.test(line)).map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));
  assert(rows.length >= 20, 'one row per execute-result read');
  const verdicts = new Set(['correct-wire', 'correct-assembled', 'gap-demonstrated', 'not-applicable']);
  const classes = new Set(['wire', 'montado', 'n/a']);
  const kinds = new Set(['accept', 'replay', 'recovery', 'reparo', 'entrega', 'diagnóstico', 'status']);
  const sites = new Set();
  for (const [id, site, klass, kind, validator, transports, verdict, testCase] of rows) {
    const match = /^`scripts\/([\w./-]+\.js)#([\w.]+)`$/.exec(site);
    assert(match, `${id}: call site format`);
    const file = path.join(SCRIPTS, match[1]);
    assert(fs.existsSync(file), `${id}: ${match[1]} exists`);
    const source = fs.readFileSync(file, 'utf8'), symbol = match[2].split('.').pop();
    assert(new RegExp(`(?:function\\s+${symbol}\\b|\\b${symbol}\\s*[:=(]|\\.${symbol}\\b)`).test(source), `${id}: ${match[2]} exists in ${match[1]}`);
    assert(classes.has(klass), `${id}: class ${klass}`); assert(kinds.has(kind), `${id}: consumer type ${kind}`);
    assert(validator && transports, `${id}: validator and transports named`);
    assert(verdicts.has(verdict), `${id}: verdict ${verdict}`);
    const named = /^`([a-z0-9-]+)`$/.exec(testCase);
    assert(named && executed.has(named[1]), `${id}: differential case ${testCase} was executed by this suite`);
    sites.add(match[1]);
  }
  assert(!rows.some(row => row[6] === 'gap-demonstrated'), 'no divergence was demonstrated; a gap row needs its own named failing case');
  // Completeness: every production script matched by the census terms has a row.
  const census = /validateExecuteResult|validateAssembledExecuteResult|must_haves_status|files_changed_declared/;
  const matched = fs.readdirSync(SCRIPTS).filter(name => name.endsWith('.js') && !name.endsWith('.test.js'))
    .filter(name => census.test(fs.readFileSync(path.join(SCRIPTS, name), 'utf8')));
  for (const name of matched) assert(sites.has(name), `census hit ${name} has a map row`);
  pass('map-call-sites', `${rows.length} map rows: every call site exists, every case ran, every census hit (${matched.length} scripts) is mapped`);
}

async function main() {
  let completed = false;
  try {
    const home = path.join(harness.root, 'isolated-user-home'); fs.mkdirSync(home, { recursive: true });
    Object.assign(process.env, { HOME: home, USERPROFILE: home });
    mock = path.join(harness.root, 'mock-transport.js'); fs.writeFileSync(mock, MOCK_SOURCE);
    driver = path.join(harness.root, 'replay-driver.js'); fs.writeFileSync(driver, DRIVER_SOURCE);
    process.env.FORGE_XLLM_CODEX_BIN = mock; process.env.FORGE_XLLM_CLAUDE_BIN = mock;
    xllm = require('./forge-xllm'); unit = require('./forge-unit-sidecar'); recovery = require('./forge-attempt-recovery');
    roots = require('./forge-code-roots'); workerContract = require('./forge-worker-result-contract');
    envPromote = require('./forge-env-promote'); reverify = require('./forge-reverify');
    pinsCase('before');
    const cases = [];
    cases.push(await transportCase(appServerFixture()));
    cases.push(await transportCase(claudeFixture()));
    cases.push(await transportCase(nativeFixtureCase()));
    differentialCases(cases);
    await replayCases(cases);
    await recordedAttemptCases(cases);
    pinsCase('after');
    mapCase();
    console.log(`forge-issue-440-result: ok (${executed.size} named cases; transports: mock app-server, mock Claude CLI, mock native callback; provider calls: 0)`);
    completed = true;
  } finally {
    for (const [key, value] of Object.entries(savedHome)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    harness.close(completed);
  }
}
main().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
