#!/usr/bin/env node
'use strict';

// S03/T04: real phases at the canonical execute/verify/publish/terminal seams,
// per-command verification progress, CLI observer lines, durable native identity
// after publication and the issue 288 public recovery gate. Temporary roots,
// simulated transports and harness native callbacks only: no provider is called,
// and these fixtures prove neither host UI nor real provider behavior.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncResource } = require('async_hooks');
const sidecar = require('./forge-unit-sidecar');
const xllm = require('./forge-xllm');
const execution = require('./forge-task-execution');
const identityApi = require('./forge-agent-identity');
const delivery = require('./forge-native-recovery-delivery');
const { createAnnouncer } = require('./forge-sidecar-identity');
const { formatPhaseLine } = require('./forge-agent-view');
const rootsFixtures = require('./forge-code-roots.test');
const runs = require('./forge-runs');
const deliveryTests = require('./forge-native-recovery-delivery.test');
const transitionTests = require('./forge-recovery-transition.test');
const { freezeTime, fileMap, restoreDir } = deliveryTests;
// Deep enough to show the real transitive chain inside the host attestation callback.
Error.stackTraceLimit = 80;

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const PHASE_KEYS = ['schema_version', 'phase', 'dispatch_id', 'unit', 'worker_mode', 'at'];
const ROADMAP = '# M001: Fases — Roadmap\n\n## Slices\n- [ ] **S01: Slice de fases** `risk:high` `depends:[]`\n';
const SLICE_PLAN = '# S01: Slice de fases\n\n## Tasks\n- [ ] **T01: Primeira task** `est:1h`\n- [ ] **T02: Segunda task**\n';
const lines = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(row => JSON.parse(row)) : [];
const bytes = file => fs.existsSync(file) ? fs.readFileSync(file) : null;

// ── Milestone v2 sidecar (simulated xllm.runExecute) ─────────────────────────
let transport = null, transportCalls = 0;
const realRunExecute = xllm.runExecute;
function milestone(dispatchId) {
  const lab = rootsFixtures.fixture();
  const base = path.join(lab.owner, '.gsd/milestones/M001/slices/S01');
  fs.mkdirSync(path.join(base, 'tasks/T01'), { recursive: true });
  fs.writeFileSync(path.join(lab.owner, '.gsd/milestones/M001/M001-ROADMAP.md'), ROADMAP);
  fs.writeFileSync(path.join(base, 'S01-PLAN.md'), SLICE_PLAN);
  fs.writeFileSync(path.join(base, 'S01-RESEARCH.md'), '# S01 research\n');
  const request = { unitType: 'execute-task', scope: 'milestone', phase: 'execute', milestoneId: 'M001', sliceId: 'S01', taskId: 'T01',
    cwd: lab.a, contextRoot: lab.owner, execution_contract: lab.contract, workflowId: 'phase-fixture', dispatchId,
    resultFile: path.join(lab.dir, `${dispatchId}.json`), prompt: 'Fixture only.',
    planFile: path.join(base, 'tasks/T01/T01-PLAN.md'), verification: { preferenceCommands: ['node -e "process.exit(0)"'] } };
  // The frontmatter pins the Claude sidecar family so routing stays a sidecar.
  fs.writeFileSync(request.planFile, rootsFixtures.plan(lab.contract).replace('tier: standard\n', 'tier: standard\nworker: claude\n'));
  fs.writeFileSync(path.join(lab.owner, '.gsd/forge-prefs.jsonc'), JSON.stringify({ tier_models: Object.fromEntries(
    ['light', 'standard', 'heavy', 'max'].map(tier => [tier, ['claude-sonnet-5']])), effort: { 'plan-slice': 'medium' } }));
  request.route = require('./forge-dispatch-resolve').resolveDispatch({ cwd: request.contextRoot, unitType: request.unitType,
    milestoneId: request.milestoneId, unitId: request.taskId, planPath: request.planFile, hostRuntime: 'codex' });
  assert.equal(request.route.worker_mode, 'sidecar');
  request.runId = `phase-${dispatchId}`;
  request.claim = { schema_version: 2, generation: crypto.randomUUID(), execution_contract: lab.contract,
    paths: ['alpha', 'beta'].map(root_id => ({ root_id, path: 'same.txt' })) };
  request.gates = { plan: 'skipped', planSkipReason: 'interactive-off', claim: 'proceed', security: 'not-applicable' };
  runs.add(lab.owner, { id: request.runId, kind: 'milestone', session_id: 'fixture', write_claim: request.claim });
  return { lab, request, receiptFile: `${request.resultFile}.receipt.json`, eventsFile: path.join(lab.owner, '.gsd/forge/events.jsonl'),
    summaryFile: path.join(base, 'tasks/T01/T01-SUMMARY.md'), cleanup: () => lab.cleanup() };
}
function workerDone(f) {
  return options => {
    transportCalls++;
    options.announce?.('solicitado', { ...options.identity, engine: 'claude', transport: 'claude-cli', provider_called: false });
    fs.writeFileSync(path.join(f.lab.a, 'same.txt'), 'worker alpha\n');
    fs.writeFileSync(path.join(f.lab.b, 'same.txt'), 'worker beta\n');
    return { status: 'done', summary: 'Phase fixture', files_changed: ['alpha::same.txt', 'beta::same.txt'], must_haves_status: [] };
  };
}
function recorder(f, phases) {
  return record => phases.push({ record, receipt: fs.existsSync(f.receiptFile) ? JSON.parse(fs.readFileSync(f.receiptFile, 'utf8')).phase : null,
    events: lines(f.eventsFile).map(row => row.event === 'sidecar-unit' ? `sidecar-unit:${row.status}` : row.event),
    summary: fs.existsSync(f.summaryFile) });
}

async function milestonePhases() {
  const f = milestone('phases');
  try {
    transport = workerDone(f); transportCalls = 0;
    const phases = [], checks = [], writes = [];
    const runtime = { announce: createAnnouncer({ write: line => writes.push(line) }), onPhase: recorder(f, phases),
      onVerificationCheck: record => checks.push(record) };
    const result = await sidecar.runUnitSidecar(f.request, runtime);
    assert.equal(result.status, 'done'); assert.equal(transportCalls, 1);
    assert.deepEqual(phases.map(row => row.record.phase), ['executing', 'verifying', 'publishing', 'completed']);
    for (const { record } of phases) {
      assert(Object.isFrozen(record));
      assert.deepEqual(Object.keys(record), record.phase === 'completed' ? [...PHASE_KEYS, 'outcome'] : PHASE_KEYS);
      assert.equal(record.schema_version, 1); assert.equal(record.dispatch_id, 'phases');
      assert.equal(record.unit, 'execute-task/T01'); assert.equal(record.worker_mode, 'sidecar');
      assert(!Number.isNaN(Date.parse(record.at)));
    }
    const [executing, verifying, publishing, completed] = phases;
    assert.equal(executing.receipt, 'started'); assert(!executing.events.includes('sidecar-unit:done'));
    assert.equal(verifying.receipt, 'executed'); assert.equal(verifying.summary, false);
    assert.equal(publishing.receipt, 'ready'); assert.equal(publishing.summary, false, 'publishing precedes materialization');
    assert.equal(completed.summary, true); assert.equal(completed.events.at(-1), 'sidecar-unit:done', 'completed follows the final event');
    assert.equal(completed.record.outcome, 'done');
    console.log('PASS milestone sidecar phases: executing at transport entry, verifying before the capture, publishing before materialization, completed after the final event');
    assert.deepEqual(checks.map(row => [row.root_id, row.index, row.total, row.state, row.label]), [
      ['alpha', 1, 1, 'started', 'comando 1'], ['alpha', 1, 1, 'finished', 'comando 1'],
      ['beta', 1, 1, 'started', 'comando 1'], ['beta', 1, 1, 'finished', 'comando 1']]);
    assert(!JSON.stringify(checks).includes('process.exit'), 'a non-policy command is never exposed');
    console.log('PASS milestone sidecar onVerificationCheck: completeExecution forwards the per-command records of captureRootDelivery');
    // Only the pre-existing record kinds: dispatch, sidecar-unit and the resource sink lines.
    const durable = new Set(lines(f.eventsFile).map(row => row.event || row.kind));
    assert([...durable].every(name => ['dispatch', 'sidecar-unit', 'resource-clamp-skipped'].includes(name)), [...durable].join(','));
    assert(!lines(f.eventsFile).some(row => 'phase' in row || 'state' in row), 'no phase or progress record');
    assert.equal(writes.length, 1, 'one announcer write for the one accepted stage');
    console.log('PASS milestone sidecar durability: no phase or progress becomes a durable event; the announcer keeps one write per accepted stage');
    const replayPhases = [];
    const replayed = await sidecar.runUnitSidecar(f.request, { ...runtime, onPhase: recorder(f, replayPhases) });
    assert.equal(replayed.status, 'done'); assert.equal(transportCalls, 1, 'replay never calls the transport');
    assert.deepEqual(replayPhases.map(row => row.record.phase), ['publishing', 'completed']);
    console.log('PASS milestone ready replay: no executing phase and no transport call; publishing and completed only');
  } finally { transport = null; f.cleanup(); }
}

async function executedReplayAndFailure() {
  const f = milestone('executed-replay');
  const realRename = fs.renameSync;
  try {
    transport = workerDone(f); transportCalls = 0;
    let armed = true;
    fs.renameSync = (from, to) => {
      if (armed && path.resolve(to) === path.resolve(f.receiptFile) && /"phase": "ready"/.test(fs.readFileSync(from, 'utf8'))) {
        armed = false; throw Object.assign(new Error('simulated publication crash'), { code: 'EIO' });
      }
      return realRename(from, to);
    };
    await assert.rejects(sidecar.runUnitSidecar(f.request), /simulated publication crash/);
    fs.renameSync = realRename;
    assert.equal(JSON.parse(fs.readFileSync(f.receiptFile, 'utf8')).phase, 'executed');
    const phases = [];
    const replayed = await sidecar.runUnitSidecar(f.request, { onPhase: recorder(f, phases) });
    assert.equal(replayed.status, 'done'); assert.equal(transportCalls, 1);
    assert(!phases.some(row => row.record.phase === 'executing'), 'executed replay never emits executing');
    assert.deepEqual(phases.map(row => row.record.phase).slice(-2), ['publishing', 'completed']);
    console.log('PASS milestone executed replay: saved capture replays without executing or transport; publishing then completed');
  } finally { fs.renameSync = realRename; transport = null; f.cleanup(); }
  const g = milestone('failure');
  try {
    transportCalls = 0;
    transport = () => { transportCalls++; throw Object.assign(new Error('fixture failure'), { code: 'fixture-transport-failure', provider_called: true }); };
    const phases = [], writes = [];
    await assert.rejects(sidecar.runUnitSidecar(g.request, { onPhase: recorder(g, phases),
      announce: createAnnouncer({ write: line => writes.push(line) }) }), error => error.code === 'fixture-transport-failure');
    assert.deepEqual(phases.map(row => row.record.phase), ['executing', 'failed']);
    const failed = phases[1];
    assert.equal(failed.record.reason_code, 'fixture-transport-failure');
    assert.deepEqual(Object.keys(failed.record), [...PHASE_KEYS, 'reason_code']);
    assert.equal(failed.events.at(-1), 'sidecar-unit:failed', 'failed follows the recorded sidecar-unit failed event');
    assert.equal(writes.length, 1, 'one falhou write');
    const replayPhases = [];
    await assert.rejects(sidecar.runUnitSidecar(g.request, { onPhase: recorder(g, replayPhases) }), error => error.code === 'fixture-transport-failure');
    assert.equal(transportCalls, 1, 'failed replay relaunches nothing');
    assert.deepEqual(replayPhases.map(row => row.record.phase), ['failed']);
    console.log('PASS milestone failure: failed after the sidecar-unit failed event; the failed replay emits no executing and calls no transport');
  } finally { transport = null; g.cleanup(); }
}

async function observerParity() {
  const f = milestone('parity');
  const backup = `${f.lab.dir}-parity-backup`;
  try {
    fs.cpSync(f.lab.dir, backup, { recursive: true });
    const instant = Date.now();
    const run = async observers => {
      restoreDir(f.lab.dir, backup);
      const thaw = freezeTime(instant);
      try {
        const produce = workerDone(f);
        transport = options => {
          options.onProgress?.(require('./forge-sidecar-diagnostic').observation({ elapsed_ms: 10,
            remote_event_count: 1, remote_source: 'cli-reported-protocol', remote_silence_ms: 1,
            gap_suspended: false, liveness: { version: 1, state: 'working', since_ms: 0, reason: null } }));
          return produce(options);
        };
        const writes = [];
        const result = await sidecar.runUnitSidecar(f.request, { announce: createAnnouncer({ write: line => writes.push(line) }), ...observers });
        const replay = await sidecar.runUnitSidecar(f.request, { announce: createAnnouncer({ write: line => writes.push(line) }), ...observers });
        return { result: JSON.stringify([result, replay]), receipt: bytes(f.receiptFile).toString('utf8'), events: bytes(f.eventsFile).toString('utf8'),
          resultFile: bytes(f.request.resultFile).toString('utf8'), writes, files: fileMap(f.lab.dir) };
      } finally { thaw(); transport = null; }
    };
    const plain = await run({});
    let thrown = 0;
    const boom = () => { thrown++; throw new Error('observer failure'); };
    const throwing = await run({ onPhase: boom, onVerificationCheck: boom, onObservation: boom, onLiveness: boom });
    const stream = [];
    const cli = await run(sidecar.cliObservers({ write: chunk => stream.push(chunk) }));
    assert(thrown >= 6, 'throwing observers were called');
    for (const other of [throwing, cli]) {
      for (const key of ['result', 'receipt', 'events', 'resultFile']) assert.equal(other[key], plain[key], key);
      assert.deepEqual(other.writes, plain.writes);
      assert.deepEqual(other.files, plain.files);
    }
    assert.equal(new Set(plain.writes).size, plain.writes.length, 'each accepted stage is written once');
    console.log('PASS observer parity: result, receipt bytes, events.jsonl bytes, result-file and announcer writes identical with, without, throwing and CLI observers (frozen time)');
    const output = stream.join('').split('\n').filter(Boolean);
    const phaseLines = output.filter(line => line.startsWith('[forge-agente]') && !line.includes('atividade'));
    assert.deepEqual(phaseLines, ['executing', 'verifying', 'publishing', 'completed', 'publishing', 'completed'].map(phase => formatPhaseLine(phase)));
    const progress = output.filter(line => line.startsWith('[forge-verify-progress] '));
    assert.equal(progress.length, 4);
    for (const line of progress) {
      const record = JSON.parse(line.slice('[forge-verify-progress] '.length));
      assert.deepEqual(Object.keys(record).slice(0, 6), ['schema_version', 'root_id', 'index', 'total', 'label', 'state']);
      assert.equal(record.label, 'comando 1');
    }
    const activity = output.filter(line => line.startsWith('[forge-agente]') && line.includes('atividade'));
    assert.equal(activity.length, 1, 'only the fresh transport observation produces activity; phases never refresh a cached snapshot');
    assert(output.every(line => /^\[forge-(agente|verify-progress)\]/.test(line)), 'CLI observers never write [forge-sidecar] lines');
    console.log('PASS CLI observers: [forge-agente] phase lines by formatPhaseLine, [forge-verify-progress] closed JSON and activity lines on transitions');
    console.log('EXAMPLE S03/T04 stderr of a simulated unit:');
    for (const line of output) console.log(`EXAMPLE   ${line}`);
  } finally { fs.rmSync(backup, { recursive: true, force: true }); f.cleanup(); }
}

function cliLimits() {
  const out = [];
  const observers = sidecar.cliObservers({ write: chunk => out.push(chunk) });
  for (let i = 0; i < 30; i++) {
    const state = i % 2 ? 'slow-suspect' : 'working';
    observers.onPhase({ phase: i % 2 ? 'verifying' : 'executing' });
    observers.onLiveness({ from: i ? (i % 2 ? 'working' : 'slow-suspect') : null, to: state });
    observers.onObservation({ version: 1, elapsed_ms: i, remote_event_count: 1, remote_source: 'cli-reported-protocol',
      remote_silence_ms: state === 'working' ? 1 : 120001, gap_suspended: false,
      liveness: { version: 1, state, since_ms: 0, reason: state === 'working' ? null : 'silence' } });
  }
  observers.onLiveness({ from: 'working', to: 'working' });
  observers.onLiveness({ from: 'working', to: 'slow-suspect' });
  const activity = out.join('').split('\n').filter(line => line.includes('atividade'));
  assert.equal(activity.length, 20, 'at most 20 activity lines per unit');
  const fresh = [];
  const second = sidecar.cliObservers({ write: chunk => fresh.push(chunk) });
  second.onLiveness({ from: 'working', to: 'working' });
  assert.equal(fresh.length, 0, 'no line without a liveness state transition');
  second.onObservation({ elapsed_ms: 10, remote_event_count: 2, remote_silence_ms: 5, gap_suspended: false, liveness: { state: 'working', reason: null } });
  second.onLiveness({ from: 'working', to: 'slow-suspect' });
  assert.equal(fresh.length, 1); assert(fresh[0].startsWith('[forge-agente]'));
  assert.doesNotThrow(() => sidecar.cliObservers({ write() { throw new Error('closed stderr'); } }).onPhase({ phase: 'executing' }));
  const source = fs.readFileSync(path.join(__dirname, 'forge-unit-sidecar.js'), 'utf8');
  assert(source.includes('runUnitSidecar(request, { announce, ...cliObservers() })'), 'main wires the default observers');
  assert(source.includes("process.stderr.write(require('./forge-sidecar-calibration').progressLine(safe))"), '[forge-sidecar-progress] path unchanged');
  for (const literal of ['terminalResult', 'preflightExecutionVerification']) assert(source.includes(literal), literal);
  const deliverySource = fs.readFileSync(path.join(__dirname, 'forge-native-recovery-delivery.js'), 'utf8');
  for (const literal of ['reviewDocumentary', 'const nonEmpty=']) assert(deliverySource.includes(literal), literal);
  console.log('PASS CLI activity limit: at most 20 activity lines, only on phase or liveness-state transitions; stderr loss never affects the unit');
  console.log('PASS release literals: terminalResult, preflightExecutionVerification, reviewDocumentary and const nonEmpty= remain');
}

// ── Native recovery delivery: identity lifecycle with an external journal ────
function nativeOptions(request, journal, taskName) {
  return { hostRuntime: 'codex', resolvedDispatch: request.route, activeCapabilities: transitionTests.capabilities,
    prompt: 'Identity lifecycle fixture.', forkTurns: 'none', taskName, agentType: 'forge-executor',
    telemetryIdentity: request, terminalResult: value => delivery.resultContract.validate(value).ok,
    lifecycle: { journal: { root: journal.root, file: journal.file, authorize: () => true } } };
}
async function identityLifecycle() {
  const f = await deliveryTests.fixture();
  try {
    const handoff = await sidecar.recoverUnitSidecar(f.request, f.recovery, f.runtime), request = handoff.result.request;
    const eventsFile = path.join(f.owner, '.gsd/forge/events.jsonl');
    fs.mkdirSync(path.dirname(eventsFile), { recursive: true }); fs.writeFileSync(eventsFile, '');
    const journalRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(f.dir, 'external-journal-')));
    const journal = { root: journalRoot, file: path.join(journalRoot, 'lifecycle.json') };
    const taskName = require('./forge-native-invocation').humanTaskName({ unitId: 'S01/T01', title: 'Ciclo de identidade', attempt: request.dispatchId });
    const options = nativeOptions(request, journal, taskName);
    const nativeInvocation = require('./forge-native-invocation').buildNativeInvocation(options);
    const receipts = [], phases = [];
    const sessionOptions = { request, nativeInvocation, assertBoundary: f.assertBoundary, assertAuthority: f.assertBoundary,
      persistDeliveryReceipt: receipt => receipts.push(receipt), onPhase: record => phases.push(record.phase) };
    const session = delivery.prepare(sessionOptions);
    session.start();
    const manifest = session.manifest(), manifestFile = `${request.resultFile}.manifest.json`, manifestBytes = fs.readFileSync(manifestFile);
    let live = null, invoked = null;
    const outcome = await require('./forge-native-invocation').invokeNative(options, async (args, binding, observer) => {
      invoked = binding;
      assert.deepEqual(observer.hostIdentity(`/root/${args.task_name}`), { ok: true });
      live = JSON.parse(fs.readFileSync(journal.file, 'utf8')).host_identity;
      // The live identity is in the external journal while the owner snapshot is intact.
      execution.assertProtected(f.owner, manifest.prepared.protected_owner);
      for (const root of f.contract.code_roots) transitionTests.write(path.join(root.path, 'same.txt'), 'after\n');
      return f.result();
    });
    assert.equal(outcome.ok, true, JSON.stringify(outcome.reason_code));
    assert.deepEqual(live, { value: `/root/${taskName}`, source: 'host-tool-return', observed_ms: live.observed_ms, dispatch_id: request.dispatchId, conflict: false });
    assert(!fs.readFileSync(eventsFile, 'utf8'), 'nothing durable while the agent runs');
    console.log(`EXAMPLE S03/T04 live journal identity: ${JSON.stringify(live)}`);
    console.log('PASS identity lifecycle live: the host-returned /root/<task_name> is in the external journal while the protected owner snapshot is unchanged');
    session.returned(outcome.result);
    // Negative: a direct owner append between start and verify fails closed and publishes nothing.
    fs.appendFileSync(eventsFile, '{"event":"direct-append"}\n');
    const persisted = receipts.length;
    assert.throws(() => session.verify(outcome.result), { code: 'execution-protected-metadata' });
    assert.equal(receipts.length, persisted, 'no ready receipt after the refusal');
    assert(!fs.existsSync(path.join(f.owner, sidecar.locations(request).required[0])), 'nothing published');
    fs.writeFileSync(eventsFile, '');
    console.log('PASS identity negative: a direct events.jsonl append between start and verify fails with execution-protected-metadata and nothing is published');
    session.verify(outcome.result);
    const published = session.publish(outcome.result);
    assert.equal(published.phase, 'ready');
    const readyFile = receipts.at(-1).file, ready = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
    assert.deepEqual(phases, ['executing', 'verifying', 'publishing', 'completed']);
    // Replay of the saved ready record before the identity append works without transport.
    const verifier = require('./forge-verify'), capture = verifier.captureRootDelivery;
    let checks = 0;
    verifier.captureRootDelivery = (...args) => { checks++; return capture(...args); };
    try { assert.equal(delivery.prepare({ ...sessionOptions, savedManifest: manifest }).replayReady(ready).phase, 'ready'); }
    finally { verifier.captureRootDelivery = capture; }
    assert.equal(checks, 0);
    console.log('PASS identity lifecycle replay before append: replayReady of the saved ready record succeeds without transport or verification');
    const bound = identityApi.identityFromLifecycle({ lifecycle: outcome.lifecycle, request, invocation: invoked });
    assert.equal(bound.ok, true, JSON.stringify(bound));
    for (const [label, input] of [
      ['another dispatch', { lifecycle: outcome.lifecycle, request: { ...request, dispatchId: `${request.dispatchId}-other` }, invocation: invoked }],
      ['forged digest', { lifecycle: { ...outcome.lifecycle, identity: 'f'.repeat(64) }, request, invocation: invoked }],
      ['conflicting identity', { lifecycle: { ...outcome.lifecycle, host_identity: { ...outcome.lifecycle.host_identity, conflict: true } }, request, invocation: invoked }],
    ]) assert.equal(identityApi.identityFromLifecycle(input).ok, false, label);
    assert.equal(fs.readFileSync(eventsFile, 'utf8'), '', 'refused lifecycles append nothing');
    console.log('PASS identity negative: another dispatch, forged digest or conflicting identity are refused by identityFromLifecycle without append');
    const appended = await identityApi.appendAgentIdentityEvent({ owner: f.owner, closedReceiptFile: readyFile },
      { unit: 'execute-task/T01', ...bound.fields });
    assert.equal(appended.status, 'appended');
    const recorded = lines(eventsFile);
    assert.equal(recorded.length, 1); assert.equal(recorded[0].event, 'agent-identity');
    assert.equal(recorded[0].agent_id, `/root/${taskName}`); assert.equal(recorded[0].evidence, 'native-lifecycle');
    assert.equal(recorded[0].dispatch_id, request.dispatchId);
    console.log(`EXAMPLE S03/T04 identity event after publication: ${appended.line.trim()}`);
    console.log('PASS identity lifecycle durable: exactly one agent-identity line (native-lifecycle) appended after publication with the closed ready receipt');
    assert.throws(() => delivery.prepare({ ...sessionOptions, savedManifest: manifest }).replayReady(ready), { code: 'execution-protected-metadata' });
    assert.deepEqual(fs.readFileSync(manifestFile), manifestBytes, 'the manifest snapshot is never re-adopted');
    assert.deepEqual(JSON.parse(fs.readFileSync(readyFile, 'utf8')), ready);
    console.log('PASS identity lifecycle replay after append: without a broker the replay refuses with execution-protected-metadata instead of re-adopting the snapshot');
    const quietJournal = { root: journalRoot, file: path.join(journalRoot, 'quiet.json') };
    const quiet = await require('./forge-native-invocation').invokeNative(nativeOptions(request, quietJournal, taskName), async () => f.result());
    assert.equal(quiet.ok, true);
    assert(!('host_identity' in quiet.lifecycle) && !('host_identity' in JSON.parse(fs.readFileSync(quietJournal.file, 'utf8'))));
    assert.deepEqual(identityApi.identityFromLifecycle({ lifecycle: quiet.lifecycle, request, invocation: invoked }).reason_code, 'agent-identity-unobserved');
    console.log('PASS identity legacy callback: a callback that ignores the observer leaves the identity unknown and the lifecycle unchanged');
  } finally { f.cleanup(); }
}

// ── Issue 288: public recovery wrapper with the explicit live gate adapter ────
const AUTO = { plan: 'skipped', planSkipReason: 'auto-defer', authorizationReference: 'conversation:fixture-auto' };
function gateHost(f) {
  const original = f.request.dispatchId;
  const successor = require('./forge-recovery-dispatch-id').recoveryDispatchId(original, f.recovery.resumeReservation.sha256);
  // The host's own authorization source: exact unit, workflow, host, plan bytes and roots.
  const host = { allowed: new Set([original, successor]), revoked: false, reference: AUTO.authorizationReference,
    expected: { taskId: 'T01', workflowId: f.request.workflowId, host: 'codex',
      planSha256: sha(fs.readFileSync(f.request.planFile, 'utf8')), executionContractSha256: require('./forge-code-roots').digest(f.contract) },
    attested: [], original, successor };
  host.adapter = execution.createAutoPlanGateAdapter(scope => {
    host.attested.push({ dispatch: scope.dispatchId, stack: new Error().stack });
    const exact = Object.entries(host.expected).every(([key, value]) => scope[key] === value);
    return { authorized: !host.revoked && exact && host.allowed.has(scope.dispatchId), mode: 'auto',
      reference: host.reference === scope.reference ? scope.reference : host.reference };
  });
  return host;
}
async function publicDeferredGate() {
  const f = await deliveryTests.fixture({ gates: AUTO });
  try {
    const host = gateHost(f);
    const runtime = { ...f.runtime, executionPlanGate: host.adapter };
    const receiptBefore = fs.readFileSync(f.receiptFile);
    const stateApi = require('./forge-xllm-state');
    // A refusal may follow the canonical transition record, but it never reaches
    // the Tool: reservations, attempts and the unconsumed continuation are intact.
    const refuse = async (label, runtimeValue, expected) => {
      await assert.rejects(sidecar.recoverUnitSidecar(f.request, f.recovery, runtimeValue), expected, label);
      const state = stateApi.loadRecovery(f.stateFile);
      assert.deepEqual(state.reservations, f.initial.reservations, `${label}: reservations intact`);
      assert.deepEqual(state.attempts, f.initial.attempts, `${label}: attempts intact`);
      assert(!state.continuation || state.continuation.status === 'prepared', `${label}: continuation not consumed`);
      assert.deepEqual(fs.readFileSync(f.receiptFile), receiptBefore, `${label}: original receipt intact`);
    };
    await refuse('no adapter', f.runtime, { code: 'execution-plan-gate-required' });
    console.log('PASS issue288 without adapter: the auto-deferred original is refused by the unchanged gate before any Tool');
    const key = require.resolve('./forge-task-execution'), current = require.cache[key];
    delete require.cache[key];
    const foreignModule = require('./forge-task-execution').createAutoPlanGateAdapter(scope => ({ authorized: true, mode: 'auto', reference: scope.reference }));
    require.cache[key] = current;
    for (const forged of [JSON.parse(JSON.stringify(host.adapter)), {}, foreignModule]) {
      await refuse('forged handle', { ...f.runtime, executionPlanGate: forged }, { code: 'execution-auto-gate-adapter-required' });
    }
    console.log('PASS issue288 forged handles: serialized, look-alike and other-module-instance adapters refused before any Tool');
    host.allowed = new Set([host.original]);
    await refuse('original only', runtime, { code: 'execution-auto-gate-not-attested' });
    host.allowed = new Set([host.successor]);
    await refuse('successor only', runtime, { code: 'execution-auto-gate-not-attested' });
    host.allowed = new Set([host.original, host.successor]);
    console.log('PASS issue288 scope split: original-only and successor-only authorization each refuse; the original dispatch never authorizes the successor');
    for (const [field, value] of [['taskId', 'T02'], ['workflowId', 'foreign-workflow'], ['host', 'claude'],
      ['planSha256', '0'.repeat(64)], ['executionContractSha256', '0'.repeat(64)]]) {
      const saved = host.expected[field]; host.expected[field] = value;
      await refuse(field, runtime, { code: 'execution-auto-gate-not-attested' });
      host.expected[field] = saved;
    }
    host.reference = 'conversation:foreign';
    await refuse('foreign reference', runtime, { code: 'execution-auto-gate-not-attested' });
    host.reference = AUTO.authorizationReference;
    host.revoked = true;
    await refuse('revoked', runtime, { code: 'execution-auto-gate-not-attested' });
    host.revoked = false;
    const held = runs.get(f.owner, 'fixture-run');
    runs.update(f.owner, 'fixture-run', { write_claim: { ...held.write_claim, generation: crypto.randomUUID() } });
    await refuse('stale claim', runtime, /claim/);
    runs.update(f.owner, 'fixture-run', { write_claim: held.write_claim });
    assert.deepEqual(fs.readFileSync(f.receiptFile), receiptBefore);
    console.log('PASS issue288 foreign scopes: foreign unit, workflow, host, plan hash, roots, reference, revoked authorization and stale claim refuse before any Tool; reservation, attempts and original receipt intact');
    const handoff = await sidecar.recoverUnitSidecar(f.request, f.recovery, runtime), live = handoff.result;
    assert.equal(live.action, 'invoke-native'); assert.equal(live.request.dispatchId, host.successor);
    assert.notEqual(live.request.dispatchId, f.request.dispatchId);
    assert.throws(() => live.delivery.start(), { code: 'execution-plan-gate-required' }, 'a closed scope is not revived by the saved session');
    let calls = 0, captured = null;
    const callback = async (next, binding, session, observer) => {
      calls++;
      assert.equal(typeof observer?.hostIdentity, 'function', 'the identity observer rides after the existing arguments');
      assert.equal(typeof session.verify, 'function');
      captured = AsyncResource.bind(() => execution.autoGateAllowed(next));
      assert.equal(captured(), true);
      for (const root of f.contract.code_roots) transitionTests.write(path.join(root.path, 'same.txt'), 'after\n');
      return f.result();
    };
    host.revoked = true;
    await assert.rejects(live.invoke(callback), { code: 'execution-auto-gate-not-attested' });
    assert.equal(calls, 0, 'revoked live authorization refuses before the Tool');
    host.revoked = false;
    const plan = fs.readFileSync(f.request.planFile);
    fs.appendFileSync(f.request.planFile, '\nChanged after the handoff.\n');
    const changed = await live.invoke(callback).catch(error => ({ ok: false, reason_code: error.code }));
    assert.equal(changed.ok, false); assert.equal(calls, 0, 'changed plan hash refuses before the Tool');
    fs.writeFileSync(f.request.planFile, plan);
    const outcome = await live.invoke(callback);
    assert.equal(outcome.ok, true, JSON.stringify(outcome.reason_code)); assert.equal(calls, 1);
    assert.equal(captured(), false, 'a captured callback is inactive after its scope');
    console.log('PASS issue288 deferred invoke: each invoke opens a fresh successor scope through the adapter; revocation and plan drift refuse before the Tool; captured callbacks stay inactive');
    assert.throws(() => live.delivery.verify(outcome.result), { code: 'execution-plan-gate-required' }, 'raw delivery outside a fresh scope refuses');
    const wrap = action => execution.withAutoPlanGateAdapterSync(host.adapter, live.request, action);
    host.allowed = new Set([host.successor]);
    assert.throws(() => wrap(() => live.delivery.verify(outcome.result)), { code: 'execution-auto-gate-not-attested' }, 'original revoked independently');
    host.allowed = new Set([host.original, host.successor]);
    host.attested.length = 0;
    const verified = wrap(() => live.delivery.verify(outcome.result));
    assert(verified.capture.passed);
    const transitive = host.attested.filter(row => row.dispatch === host.original && row.stack.includes('forge-recovery-transition.js')
      && row.stack.includes('forge-native-recovery-delivery.js'));
    assert(transitive.length > 0, 'the real transitionGuard.assertAuthority -> validateExecutionAuthority hook ran the original inside the successor operation');
    assert(host.attested.some(row => row.dispatch === host.successor), 'the successor attested in its own scope');
    host.revoked = true;
    assert.throws(() => wrap(() => live.delivery.publish(outcome.result)), { code: 'execution-auto-gate-not-attested' });
    host.revoked = false;
    assert.throws(() => live.delivery.publish(outcome.result), { code: 'execution-plan-gate-required' });
    const published = wrap(() => live.delivery.publish(outcome.result));
    assert.equal(published.phase, 'ready');
    console.log('PASS issue288 deferred delivery: verify and publish stay synchronous and refuse raw or revoked; the host wrap succeeds and the real transitive original check runs in a fresh original scope inside the successor');
    const duplicate = await live.invoke(callback).catch(error => ({ ok: false, reason_code: error.code }));
    assert.equal(duplicate.ok, false); assert.equal(calls, 1, 'duplicate invoke never reaches the Tool');
    const state = require('./forge-xllm-state').loadRecovery(f.stateFile);
    assert.deepEqual(state.reservations, f.initial.reservations); assert.deepEqual(state.attempts, f.initial.attempts);
    assert.equal(state.continuation.status, 'returned');
    assert.deepEqual(fs.readFileSync(f.receiptFile), receiptBefore, 'original receipt preserved');
    console.log('PASS issue288 single consumption: duplicate invocation refused, reservation consumed once, original receipt and attempts preserved');
    const replayRuntime = { ...runtime, writerObservationAdapter: require('./forge-recovery-transition').createWriterObservationAdapter(challenge => ({ ...challenge,
      binding_sha256: require('./forge-code-roots').digest(challenge), status: 'stopped', writer_identity: 'fixture-native', evidence_reference: 'fixture:awaited-return' })) };
    await assert.rejects(sidecar.recoverUnitSidecar(f.request, f.recovery, { ...replayRuntime, executionPlanGate: undefined }), { code: 'execution-plan-gate-required' });
    const beforeReplayState = fs.readFileSync(f.stateFile);
    host.allowed = new Set([host.successor]);
    await assert.rejects(sidecar.recoverUnitSidecar(f.request, f.recovery, replayRuntime), { code: 'execution-auto-gate-not-attested' }, 'early replay reattests the original independently');
    assert.deepEqual(fs.readFileSync(f.stateFile), beforeReplayState);
    assert.deepEqual(fs.readFileSync(f.receiptFile), receiptBefore);
    assert.equal(calls, 1, 'original revocation does not reserve or invoke another worker');
    host.allowed = new Set([host.original, host.successor]);
    console.log('PASS issue288 early replay original authority: successor-only authorization refuses before publication, state change or another invocation');
    const replayed = await sidecar.recoverUnitSidecar(f.request, f.recovery, replayRuntime);
    assert.equal(replayed.action, 'replay'); assert.equal(replayed.provider_called, false); assert.equal(calls, 1);
    assert.equal(replayed.result.published.phase, 'ready');
    console.log('PASS issue288 public replay: native-recovery-delivery.replay uses the adapter for the reconstructed successor; without it the replay refuses; no second Tool');
  } finally { f.cleanup(); }
}
function regressionClock(initial = Date.now()) {
  let now = initial, id = 0;
  const timers = new Map();
  return { wall: () => now, monotonic: () => now,
    setTimeout(fn, ms) { timers.set(++id, { at: now + ms, fn }); return id; },
    clearTimeout(key) { timers.delete(key); },
    async advance(ms) {
      now += ms;
      for (let turn = 0; turn < 30; turn++) {
        await Promise.resolve();
        for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.fn(); }
      }
    } };
}

async function publicLateCapture() {
  for (const mode of ['allowed', 'original-revoked', 'successor-revoked', 'state-drift']) {
    const f = await deliveryTests.fixture({ gates: AUTO });
    const journalRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(require('os').tmpdir(), 'forge-phase-late-')));
    try {
      const host = gateHost(f), clock = regressionClock(), journal = path.join(journalRoot, 'native.json');
      const runtime = { ...f.runtime, executionPlanGate: host.adapter,
        nativeLifecycle: { ...f.runtime.nativeLifecycle, clock, journal: { root: journalRoot, file: journal, authorize: () => true } } };
      const originalReceipt = fs.readFileSync(f.receiptFile);
      const live = (await sidecar.recoverUnitSidecar(f.request, f.recovery, runtime)).result;
      let settle, calls = 0;
      const pending = live.invoke(async () => {
        calls++;
        for (const root of f.contract.code_roots) transitionTests.write(path.join(root.path, 'same.txt'), 'after\n');
        return new Promise(resolve => { settle = resolve; });
      });
      for (let turn = 0; turn < 100 && calls === 0; turn++) await clock.advance(0);
      assert.equal(calls, 1); assert.equal(typeof settle, 'function');
      const started = JSON.parse(fs.readFileSync(journal, 'utf8'));
      await clock.advance(started.deadline_wall_ms - clock.wall() + 1);
      const cut = await pending;
      assert.equal(cut.ok, false, 'the original invocation scope closes before the real terminal');
      const state = require('./forge-xllm-state').loadRecovery(f.stateFile);
      assert.equal(state.continuation.status, 'dispatch-possible');
      if (mode === 'original-revoked') host.allowed = new Set([host.successor]);
      if (mode === 'successor-revoked') host.allowed = new Set([host.original]);
      if (mode === 'state-drift') {
        state.continuation.reservation_sha256 = '0'.repeat(64);
        fs.writeFileSync(f.stateFile, JSON.stringify(state));
      }
      const stateBefore = fs.readFileSync(f.stateFile);
      const resultDir = path.dirname(live.request.resultFile), receiptPrefix = path.basename(live.request.resultFile) + '.receipt.json.';
      const receiptFilesBefore = fs.readdirSync(resultDir).filter(name => name.startsWith(receiptPrefix)).sort();
      host.attested.length = 0;
      settle(f.result()); await clock.advance(0);
      const observed = JSON.parse(fs.readFileSync(journal, 'utf8'));
      const after = require('./forge-xllm-state').loadRecovery(f.stateFile);
      assert.equal(calls, 1, 'late capture never invokes another worker');
      assert.equal(after.continuation.status, 'dispatch-possible', 'capture does not fabricate invocation return or publication');
      assert.deepEqual(after.attempts, f.initial.attempts);
      assert.deepEqual(fs.readFileSync(f.receiptFile), originalReceipt);
      if (mode === 'allowed') {
        assert.equal(observed.late_capture, 'saved');
        const bound = after.continuation.delivery.receipt;
        assert.equal(sha(fs.readFileSync(bound.file)), bound.sha256);
        assert.equal(JSON.parse(fs.readFileSync(bound.file, 'utf8')).phase, 'executed');
        assert(host.attested.some(row => row.dispatch === host.successor), 'late capture opens a fresh successor gate');
        assert(host.attested.some(row => row.dispatch === host.original && row.stack.includes('forge-recovery-transition.js')), 'the real transitive original check remains enforcing');
        const intact = fs.readFileSync(bound.file), stateAfterCapture = fs.readFileSync(f.stateFile);
        fs.appendFileSync(bound.file, '\n');
        assert.throws(() => execution.withAutoPlanGateAdapterSync(host.adapter, live.request, () => live.delivery.returned(f.result())), /receipt|binding|state|changed|provenance|hash/, 'a fresh gate cannot adopt a changed bound late receipt');
        assert.deepEqual(fs.readFileSync(f.stateFile), stateAfterCapture);
        assert.deepEqual(fs.readFileSync(bound.file), Buffer.concat([intact, Buffer.from('\n')]));
        fs.writeFileSync(bound.file, intact);
        console.log('PASS issue288 late capture receipt drift: fresh authority still refuses a modified bound receipt without state or publication changes');
      } else {
        assert.equal(observed.late_capture, 'failed');
        assert.deepEqual(fs.readFileSync(f.stateFile), stateBefore, 'refused late capture cannot adopt state drift');
        assert.deepEqual(fs.readdirSync(resultDir).filter(name => name.startsWith(receiptPrefix)).sort(), receiptFilesBefore, 'refused late capture creates no receipt');
      }
      console.log(`PASS issue288 late capture ${mode}: real post-cut callback, exact live authority and state/receipt CAS; one invocation and no publication`);
    } finally { f.cleanup(); fs.rmSync(journalRoot, { recursive: true, force: true }); }
  }
}

function cliFreshness() {
  const output = [], observer = sidecar.cliObservers({ write: line => output.push(line) });
  const realNow = Date.now; let now = 100000; Date.now = () => now;
  try {
    const recent = require('./forge-sidecar-diagnostic').observation({ elapsed_ms: 1, remote_event_count: 1,
      remote_source: 'cli-reported-protocol', remote_silence_ms: 1, gap_suspended: false,
      liveness: { version: 1, state: 'working', since_ms: 0, reason: null } });
    observer.onObservation(recent); observer.onPhase({ phase: 'executing' });
    assert(output.some(line => line.includes('atividade remota recente')));
    const before = output.length; now += 600000;
    observer.onPhase({ phase: 'publishing' });
    assert(!output.slice(before).some(line => line.includes('atividade remota recente') || line.includes('idade da observação 0 ms')), 'phase notifications cannot refresh a cached observation');
    const beforeTransition = output.length;
    observer.onLiveness({ from: 'working', to: 'slow-suspect' });
    assert.equal(output.length, beforeTransition, 'a transition without its new snapshot cannot print the preceding state');
    observer.onObservation(recent);
    assert.equal(output.length, beforeTransition, 'an out-of-order preceding state stays suppressed');
    observer.onObservation({ ...recent, remote_silence_ms: 120001, liveness: { version: 1, state: 'slow-suspect', since_ms: 0, reason: 'silence' } });
    assert(output.at(-1).includes('atividade remota atrasada'));
    console.log('PASS CLI activity freshness: phase and liveness notifications never refresh cached activity; only the matching new observation is live');
  } finally { Date.now = realNow; }
}

async function publicImmediateGate({ short = false, identity = 'observed', receipt = 'intact', publication = 'ready' } = {}) {
  // A 50-character original yields the real 124-character canonical successor (issue 297).
  const f = await deliveryTests.fixture({ gates: AUTO, dispatchId: short ? 'short' : 'M-20261028132636-fixture-S03-T04-native-'.padEnd(50, 'x') });
  const prepare = delivery.prepare;
  if (publication === 'failed') delivery.prepare = options => {
    const session = prepare(options);
    return { ...session, publish() { throw Object.assign(new Error('fixture-publication-refused'), { code: 'fixture-publication-refused' }); } };
  };
  try {
    const host = gateHost(f);
    const phases = [], checks = [];
    let calls = 0;
    let retainedReceipt = null, intactReceipt = null;
    const runtime = { ...f.runtime, executionPlanGate: host.adapter, onPhase: record => {
      phases.push(record.phase);
      if (record.phase === 'completed' && receipt !== 'intact') {
        const state = require('./forge-xllm-state').loadRecovery(f.stateFile);
        retainedReceipt = state.continuation.delivery.receipt.file;
        intactReceipt = fs.readFileSync(retainedReceipt);
        const altered = JSON.parse(intactReceipt);
        if (receipt === 'foreign') altered.dispatch_id = 'foreign';
        else if (receipt === 'open') altered.phase = 'executed';
        else altered.result.summary += ' altered';
        fs.writeFileSync(retainedReceipt, JSON.stringify(altered));
      }
    },
      onVerificationCheck: record => checks.push(record),
      invokeNative: async (next, binding, session, observer) => {
        calls++;
        assert.equal(execution.autoGateAllowed(next), true, 'the callback runs inside the live successor scope');
        if (identity !== 'unknown') {
          assert.deepEqual(observer.hostIdentity(`/root/${binding.args.task_name}`), { ok: true });
          if (identity === 'conflicting') assert.equal(observer.hostIdentity('/root/conflicting').ok, false);
        }
        for (const root of f.contract.code_roots) transitionTests.write(path.join(root.path, 'same.txt'), 'after\n');
        return f.result();
      } };
    const receiptBefore = fs.readFileSync(f.receiptFile);
    await assert.rejects(sidecar.recoverUnitSidecar(f.request, f.recovery, { ...runtime, executionPlanGate: undefined }), { code: 'execution-plan-gate-required' });
    assert.equal(calls, 0);
    if (publication === 'failed') {
      await assert.rejects(sidecar.recoverUnitSidecar(f.request, f.recovery, runtime), /fixture-publication-refused/);
      assert.equal(calls, 1);
      assert.equal(lines(path.join(f.owner, '.gsd/forge/events.jsonl')).filter(row => row.event === 'agent-identity').length, 0);
      console.log('PASS issue288 immediate identity: refused publication cannot append identity');
      return;
    }
    const result = await sidecar.recoverUnitSidecar(f.request, f.recovery, runtime);
    assert.equal(calls, 1);
    assert.equal(result.result.published.phase, 'ready'); assert(result.result.verified.capture.passed);
    assert.deepEqual(phases, ['executing', 'verifying', 'publishing', 'completed']);
    assert.equal(checks.filter(row => row.state === 'finished').length, f.contract.code_roots.length);
    console.log('PASS issue288 immediate: the public wrapper reaches the real callback, returned, verify and publish ready under the successor adapter scopes, with phases and per-check progress');
    const events = lines(path.join(f.owner, '.gsd/forge/events.jsonl')).filter(row => row.event === 'agent-identity');
    if (identity !== 'observed' || receipt !== 'intact') {
      assert.equal(events.length, 0);
      assert.equal(result.result.published.phase, 'ready', 'optional identity loss preserves ready publication');
      if (retainedReceipt) fs.writeFileSync(retainedReceipt, intactReceipt);
      assert.deepEqual(fs.readFileSync(f.receiptFile), receiptBefore);
      console.log(`PASS issue288 immediate identity ${identity}/${receipt}: no identity appended; ready publication preserved`);
      return;
    }
    assert.equal(events.length, 1);
    assert.equal(events[0].evidence, 'native-lifecycle'); assert.equal(events[0].dispatch_id, host.successor);
    assert.equal(events[0].dispatch_id, host.successor, 'the canonical recovery dispatch stays intact');
    if (!short) assert.equal(events[0].dispatch_id.length, 124);
    assert(events[0].agent_id.startsWith('/root/recovery_'));
    if (!short) assert.equal(events[0].task_name, null, 'an over-long recovery task_name is left unrecorded, never truncated');
    else assert.equal(events[0].task_name, result.result.args.task_name);
    const stateForReceipt = require('./forge-xllm-state').loadRecovery(f.stateFile);
    const channel = { owner: f.owner, closedReceiptFile: stateForReceipt.continuation.delivery.receipt.file };
    const bytesBeforeDuplicate = fs.readFileSync(path.join(f.owner, '.gsd/forge/events.jsonl'));
    assert.equal((await identityApi.appendAgentIdentityEvent(channel, events[0])).status, 'already-recorded');
    assert.deepEqual(fs.readFileSync(path.join(f.owner, '.gsd/forge/events.jsonl')), bytesBeforeDuplicate);
    const state = require('./forge-xllm-state').loadRecovery(f.stateFile);
    assert.deepEqual(state.reservations, f.initial.reservations); assert.equal(state.continuation.status, 'returned');
    assert.deepEqual(fs.readFileSync(f.receiptFile), receiptBefore);
    console.log(`EXAMPLE S03/T04 public identity event: ${JSON.stringify(events[0])}`);
    console.log('PASS issue288 immediate identity: one agent-identity line after session.publish through the owner lock and exact closed receipt; duplicate append writes nothing, reservation consumed once and original receipt preserved');
  } finally { delivery.prepare = prepare; f.cleanup(); }
}

async function publicIdentityChannels() {
  for (const options of [{ short: true }, { identity: 'unknown' }, { identity: 'conflicting' },
    { receipt: 'altered' }, { receipt: 'foreign' }, { receipt: 'open' }, { publication: 'failed' }]) {
    await publicImmediateGate(options);
  }
}

// ── Standalone native transport through runUnitSidecar (harness) ─────────────
async function standaloneNative() {
  const { createFixtureHarness } = require('./fixtures/forge-native-execution');
  const harness = createFixtureHarness();
  let completed = false;
  try {
    const f = harness.nativeFixture();
    const journalRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(f.dir, 'external-journal-')));
    const journalFile = path.join(journalRoot, 'native.json');
    const phases = [], baseInvoke = f.runtime.invokeNative;
    let live = null;
    const runtime = { ...f.runtime, onPhase: record => phases.push(record),
      nativeLifecycle: { journal: { root: journalRoot, file: journalFile, authorize: () => true } },
      invokeNative: async (args, binding, observer) => {
        assert.deepEqual(observer.hostIdentity(`/root/${args.task_name}`), { ok: true });
        live = JSON.parse(fs.readFileSync(journalFile, 'utf8')).host_identity;
        const receipt = JSON.parse(fs.readFileSync(`${f.r.resultFile}.receipt.json`, 'utf8'));
        execution.assertProtected(f.owner, receipt.recovery_baseline.protected_owner);
        return baseInvoke(args, binding);
      } };
    const result = await sidecar.runUnitSidecar(f.r, runtime);
    assert.equal(result.status, 'done'); assert.equal(f.calls(), 1);
    assert.deepEqual(phases.map(row => row.phase), ['executing', 'verifying', 'publishing', 'completed']);
    assert(phases.every(row => row.worker_mode === 'native' && row.dispatch_id === f.r.dispatchId));
    console.log('PASS native transport phases: executing, verifying, publishing and completed through runUnitSidecar with worker_mode native');
    const events = lines(path.join(f.owner, '.gsd/forge/events.jsonl'));
    const identities = events.filter(row => row.event === 'agent-identity');
    assert.equal(identities.length, 1);
    const finalIndex = events.findLastIndex(row => row.event === 'sidecar-unit' && row.status === 'done');
    assert.equal(events.indexOf(identities[0]), finalIndex + 1, 'the identity follows the final event');
    assert.equal(identities[0].agent_id, live.value); assert(live.value.startsWith('/root/'));
    assert.equal(identities[0].evidence, 'native-lifecycle'); assert.equal(identities[0].dispatch_id, f.r.dispatchId);
    console.log('PASS native transport identity: exactly one agent-identity (native-lifecycle) after the final event through the owner channel');
    const replayPhases = [];
    const replayed = await sidecar.runUnitSidecar(f.r, { ...runtime, onPhase: record => replayPhases.push(record.phase) });
    assert.equal(replayed.status, 'done'); assert.equal(f.calls(), 1);
    assert.deepEqual(replayPhases, ['publishing', 'completed']);
    assert.equal(lines(path.join(f.owner, '.gsd/forge/events.jsonl')).filter(row => row.event === 'agent-identity').length, 1);
    console.log('PASS native transport replay: no executing, no transport and no second identity after the owner-channel append');
    const legacy = harness.nativeFixture();
    const legacyResult = await sidecar.runUnitSidecar(legacy.r, { ...legacy.runtime, invokeNative: args => legacy.runtime.invokeNative(args) });
    assert.equal(legacyResult.status, 'done');
    assert.equal(lines(path.join(legacy.owner, '.gsd/forge/events.jsonl')).filter(row => row.event === 'agent-identity').length, 0);
    console.log('PASS native transport legacy callback: a callback without the observer keeps the identity unknown and the cycle unchanged');
    completed = true;
  } finally { harness.close(completed); }
}

async function terminalOutcomes() {
  const lab = rootsFixtures.laboratory('terminal-outcomes'), original = xllm.invokeClaudeTransport;
  try {
    const owner = path.join(lab.dir, 'owner'), code = path.join(lab.dir, 'code');
    fs.mkdirSync(path.join(owner, '.gsd/milestones/M001'), { recursive: true }); fs.mkdirSync(code);
    fs.writeFileSync(path.join(owner, '.gsd/forge-prefs.jsonc'), JSON.stringify({
      tier_models: Object.fromEntries(['light', 'standard', 'heavy', 'max'].map(tier => [tier, ['claude-sonnet-5']])) }));
    fs.writeFileSync(path.join(owner, '.gsd/milestones/M001/M001-ROADMAP.md'), ROADMAP);
    for (const [status, phase, text] of [['partial', 'waiting', 'aguardando decisão'], ['blocked', 'failed', 'falhou'], ['done', 'completed', 'concluído']]) {
      const request = { unitType: 'research-milestone', phase: 'research', scope: 'milestone', milestoneId: 'M001',
        cwd: code, contextRoot: owner, workflowId: 'terminal-fixture', dispatchId: `terminal-${status}`,
        resultFile: path.join(lab.dir, `${status}.json`), prompt: 'Synthetic terminal outcome only.' };
      request.route = require('./forge-dispatch-resolve').resolveDispatch({ cwd: owner, unitType: request.unitType,
        milestoneId: 'M001', unitId: 'M001', hostRuntime: 'codex' });
      const candidate = { status, summary: 'Synthetic terminal outcome', questions: status === 'partial'
        ? [{ id: 'decision', question: 'Choose source?' }] : [], artifacts: status === 'done'
        ? [{ path: sidecar.locations(request).required[0], content: '# Research\nMeasured fixture.\n' }] : [] };
      xllm.invokeClaudeTransport = async () => ({ candidate });
      const phases = [], output = [], observers = sidecar.cliObservers({ write: value => output.push(value) });
      const result = await sidecar.runUnitSidecar(request, { ...observers,
        onPhase: record => { phases.push(record); observers.onPhase(record); } });
      assert.equal(result.status, status); assert.equal(phases.at(-1).phase, phase);
      assert.equal(phases.at(-1).outcome, status); assert(output.join('').includes(text));
      assert.deepEqual(result.questions, candidate.questions);
      const before = fs.readFileSync(request.resultFile + '.receipt.json'), events = fs.readFileSync(path.join(owner, '.gsd/forge/events.jsonl'));
      const replay = await sidecar.runUnitSidecar(request);
      assert.equal(replay.status, status);
      assert.deepEqual(fs.readFileSync(request.resultFile + '.receipt.json'), before);
      assert.deepEqual(fs.readFileSync(path.join(owner, '.gsd/forge/events.jsonl')), events);
    }
    console.log('PASS review R3 actual artifact publication/replay: partial waits with question intact, blocked fails, done completes; receipts/events unchanged on replay');
  } finally { xllm.invokeClaudeTransport = original; lab.cleanup(); }
}

const cohorts = ['identity', 'recovery', 'native', 'sidecar'];
async function runCohort(name) {
  assert(cohorts.includes(name), 'unknown phase cohort');
  if (name === 'identity') return publicIdentityChannels();
  if (name === 'recovery') {
    await publicDeferredGate(); await publicLateCapture();
    await publicImmediateGate(); await terminalOutcomes();
    return;
  }
  if (name === 'native') { await identityLifecycle(); await standaloneNative(); return; }
  // These cases intentionally share the transport stub within this child only.
  xllm.runExecute = async options => transport(options);
  try {
    await milestonePhases(); await executedReplayAndFailure();
    await observerParity(); cliLimits(); cliFreshness();
  } finally { xllm.runExecute = realRunExecute; }
}
async function main() {
  const selected = process.argv.find(arg => arg.startsWith('--review-regression='));
  if (selected) {
    const cases = { replay: publicDeferredGate, late: publicLateCapture, cli: cliFreshness, immediate: publicImmediateGate,
      identity: publicIdentityChannels, terminal: terminalOutcomes };
    const run = cases[selected.slice('--review-regression='.length)];
    assert.equal(typeof run, 'function', 'unknown review regression');
    return run();
  }
  const cohort = process.argv.find(arg => arg.startsWith('--phase-cohort='));
  if (cohort) return runCohort(cohort.slice('--phase-cohort='.length));
  // Every old scenario runs once. Each child owns its global stubs and fixtures;
  // the shared runner caps concurrency at two and drains failures before return.
  const code = await require('./fixtures/forge-test-partitions').runPartitions(__filename,
    cohorts.map(name => `--phase-cohort=${name}`));
  assert.equal(code, 0, 'phase cohort failed');
}
main().then(() => console.log(process.argv.some(arg => arg.startsWith('--review-regression='))
  ? 'forge-agent-phase: selected regression passed; full suite not run'
  : process.argv.some(arg => arg.startsWith('--phase-cohort=')) ? 'forge-agent-phase: cohort passed; full suite not run'
    : 'forge-agent-phase: all scenarios passed')).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
