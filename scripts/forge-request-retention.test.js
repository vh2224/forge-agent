#!/usr/bin/env node
'use strict';
// #382 exact request retention. Hermetic: synthetic results enter the REAL
// low-level artifact API (no resolver, provider, CLI or network). Every fresh
// process receives only paths/known identity plus an executable fixture host
// adapter, never the original request object. A fake CLI on PATH records any
// accidental provider spawn; private HOME and dummy tokens isolate accounts.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const prefsReader = () => ({ ok: true, prefs: { workflow: { skip_discuss: true, skip_research: true } } });
const DUMMY_TOKEN = 'fixture382-dummy-token-not-a-credential';

if (process.argv[2] === '--child') {
  childMain(JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))).then(value => {
    process.stdout.write(JSON.stringify(value) + '\n');
  }, error => { process.stderr.write(`${error.code || ''} ${error.stack || error}\n`); process.exitCode = 3; });
} else {
  main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
}

function modules() {
  return { controller: require('./forge-unit-controller'), sidecar: require('./forge-unit-sidecar'),
    recovery: require('./forge-attempt-recovery'), retention: require('./forge-request-retention'),
    runs: require('./forge-runs'), adapter: require('./forge-long-workflow-adapter'), state: require('./forge-state'),
    fingerprint: require('./forge-request-fingerprint') };
}
function codeOf(fn) { try { fn(); return 'no-error'; } catch (error) { return error.code || error.message; } }
async function codeOfAsync(fn) { try { await fn(); return 'no-error'; } catch (error) { return error.code || error.message; } }

// ---- fixture host adapter (shared by parent negatives and fresh children) ----
function r1Options(seed, inspector, overrides = {}) {
  const { controller } = modules();
  return { hostRuntime: 'codex', expectedSession: 'fixture375-new', prefsReader,
    expectedRecordSha256: seed.expectedRecordSha256, lineage: seed.lineage,
    inspectInterruption: ({ cwd, begin, role }) => {
      const base = { begin_key: begin.idempotency_key, begin_checksum: controller.recordChecksum(begin),
        invocation_status: role === 'original' ? 'invoked-unverified' : 'not-invoked', receipt_path: null,
        saved_response: 'none-observed', roots: [{ root_id: 'primary', path: cwd }], pending_questions: [],
        observation_reference: 'disposable fixture: positive synthetic host observation, zero actual native/provider calls' };
      if (role !== 'original') return base;
      // The archived inspector is the ONLY source of the original request here.
      const archived = inspector.inspect({ cwd, begin, receiptPath: seed.receiptPath });
      return { ...base, ...archived, saved_response: 'ready/blocked', ...(overrides.context || {}),
        supersession: { route_evidence: [seed.routeEvidence], final_native_attempt: seed.finalNative } };
    },
    processProbe: () => 'stopped',
    reconcileRoots: ({ root }) => ({ root_id: root.root_id, process_stopped: true, reconciled: true }),
    attestOwnerInterruption: challenge => ({ challenge_sha256: controller.recordChecksum(challenge), previous_owner_stopped: true,
      workspace_quiescent: true, reference: 'disposable fixture trusted-host attestation, not imported consent' }),
    attestSupersededAttempt: challenge => ({ challenge_sha256: controller.recordChecksum(challenge), superseded: true,
      final_native_receiptless: true, final_native_status: 'partial', reference: 'fixture-only live supersession attestation' }) };
}
function hostInspector(seed, observed = []) {
  return modules().recovery.createArchivedRequestInspector({ observeOriginalAttempt: ({ begin }) => {
    observed.push(begin.idempotency_key);
    if (begin.idempotency_key !== seed.beginKey) throw Object.assign(new Error('fixture host has no attempt for this begin'), { code: 'fixture-unknown-begin' });
    return seed.expected;
  } });
}
function settledOptions(seed, inspector) {
  return { prefsReader, inventoryReader: () => seed.input.inventory, processProbe: () => 'stopped',
    inspectAttempt: ({ cwd, begin }) => ({ ...inspector.inspect({ cwd, begin }),
      roots: [{ root_id: 'primary', path: cwd }], pending_questions: [] }),
    reconcileRoots: ({ root }) => ({ root_id: root.root_id, process_stopped: true, reconciled: true }) };
}

async function childMain(seed) {
  const m = modules();
  // Zero resolver use: any resolution attempt in a fresh process is a failure.
  const resolver = require('./forge-dispatch-resolve');
  resolver.resolveDispatch = () => { throw Object.assign(new Error('resolver must not run'), { code: 'fixture-resolver-called' }); };
  if (seed.scenario === 'settle-partial') {
    const observed = [], inspector = hostInspector(seed, observed);
    const options = settledOptions(seed, inspector);
    const paused = m.adapter.invoke('codex', 'auto', 'complete', { ...seed.input, result: seed.result }, seed.snapshot, options).result;
    const resumeRefusal = m.adapter.invoke('codex', 'auto', 'resume', { ...seed.input, resume_intent: 'execute' }, paused.snapshot, options).result;
    return { lifecycle: paused.lifecycle, pending: (paused.snapshot?.pending_questions || []).map(q => q.id),
      resume_reason: resumeRefusal.reason_code, observed };
  }
  if (seed.scenario === 'r1') {
    const observed = [], inspector = hostInspector(seed, observed);
    const result = m.runs.settleInterruptedOwner(seed.cwd, seed.milestone, r1Options(seed, inspector));
    const terminal = m.controller.lookupRecord(seed.cwd, 'transaction', result.interruption.terminals[0].key);
    return { status: result.status, artifacts_accepted: result.interruption.artifacts_accepted,
      pending: result.record.pending_questions.map(q => q.id).sort(), observed,
      superseded_dispatch: terminal.terminal_failure.safety.superseded_attempt.receipt.dispatch_id,
      superseded_fingerprint: terminal.terminal_failure.safety.superseded_attempt.request_fingerprint };
  }
  if (seed.scenario === 'replay') {
    const inspector = hostInspector(seed);
    const context = inspector.inspect({ cwd: seed.cwd, begin: seed.begin });
    const replay = await m.sidecar.replayArtifactAttempt(context.request);
    return { replayed: replay.replayed, provider_called: replay.provider_called, status: replay.result.status,
      request_keys: Object.keys(context.request), runtime_requirements: context.runtime_requirements };
  }
  if (seed.scenario === 'linked') {
    const inspector = hostInspector(seed);
    const context = inspector.inspect({ cwd: seed.cwd, begin: seed.begin });
    const proof = m.recovery.revalidateArchivedInspection(context.archived_inspection,
      { cwd: seed.cwd, begin: seed.begin, receiptPath: context.receipt_path, request: context.request });
    const handle = context.archived_inspection;
    return { linked: proof.linked, fingerprint: proof.fingerprint, linked_entry: proof.identity.linked_entry,
      caller_hash: proof.caller_request_sha256, runtime_requirements: context.runtime_requirements,
      // Current live APIs still refuse the historical data as a binding.
      current_identity: codeOf(() => m.recovery.requestIdentity(m.recovery.canonicalRequest(context.request))),
      current_fingerprint: codeOf(() => m.sidecar.artifactFingerprint(context.request)),
      proof_as_binding: codeOf(() => m.recovery.requestIdentity(m.recovery.canonicalRequest({ ...context.request, linkedEntryBinding: handle }))),
      proof_as_owner_token: codeOf(() => m.recovery.bindLinkedRequest(context.request, { ownerToken: handle })),
      replay: await codeOfAsync(() => m.sidecar.replayArtifactAttempt(context.request)),
      settle: codeOf(() => m.controller.verifyCompletedAttempt(seed.cwd, seed.begin, {
        inspectAttempt: ({ cwd, begin }) => ({ ...inspector.inspect({ cwd, begin }), roots: [{ root_id: 'primary', path: cwd }], pending_questions: [] }),
        processProbe: () => 'stopped', reconcileRoots: ({ root }) => ({ root_id: root.root_id, process_stopped: true, reconciled: true }) })) };
  }
  throw new Error(`unknown child scenario ${seed.scenario}`);
}

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-request-retention-')));
  const home = path.join(root, 'home'), fakeBin = path.join(root, 'fake-bin'), marker = path.join(root, 'provider-called.log');
  fs.mkdirSync(home); fs.mkdirSync(fakeBin);
  for (const name of ['claude', 'codex']) {
    fs.writeFileSync(path.join(fakeBin, name), `#!/bin/sh\necho ${name} >> "${marker}"\nexit 97\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBin, `${name}.cmd`), `@echo ${name}>> "${marker}"\r\n@exit /b 97\r\n`);
  }
  const hermetic = { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    OPENAI_API_KEY: DUMMY_TOKEN, ANTHROPIC_API_KEY: DUMMY_TOKEN, CLAUDE_CODE_DISABLE_KEYCHAIN: '1',
    PATH: fakeBin + path.delimiter + (process.env.PATH || process.env.Path || '') };
  Object.assign(process.env, hermetic);
  const m = modules();
  let sequence = 0, passed = 0;
  const mk = name => { const dir = path.join(root, `${name}-${++sequence}`); fs.mkdirSync(dir, { recursive: true }); return dir; };
  const child = (scenario, seed, env = {}) => {
    const file = path.join(root, `seed-${++sequence}.json`);
    fs.writeFileSync(file, JSON.stringify({ scenario, ...seed }));
    const run = spawnSync(process.execPath, [__filename, '--child', file], { encoding: 'utf8', windowsHide: true, timeout: 180000,
      env: { ...process.env, ...hermetic, ...env } });
    assert.equal(run.status, 0, `child ${scenario}: ${run.stderr}\n${run.stdout}`);
    return JSON.parse(run.stdout.trim().split('\n').pop());
  };
  const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };
  const archiveOf = request => `${request.resultFile}.request.json`;
  const receiptOf = request => `${request.resultFile}.receipt.json`;
  const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));

  function sliceFixture() {
    const cwd = mk('owner'), milestone = 'M-20261109000000-retention';
    fs.mkdirSync(path.join(cwd, '.gsd/milestones', milestone), { recursive: true });
    m.state.write(cwd, { milestone, phase: 'idle', active_slice: 'S01', active_task: '—', auto_mode: 'on' });
    const input = { cwd, milestone, workflow_id: 'request-retention', owner_token: 'fixture-owner', inventory: {
      roadmap_exists: true, context_exists: true, research_exists: true,
      slices: [{ id: 'S01', checked: false, plan_exists: true, research_exists: true, tasks: [] }, { id: 'S02', checked: false, plan_exists: false, tasks: [] }] } };
    const options = { prefsReader, inventoryReader: () => input.inventory };
    const current = m.adapter.invoke('codex', 'auto', 'next', input, undefined, options).result;
    assert.equal(current.unit.key, 'complete-slice/S01');
    const begin = m.controller.lookupRecord(cwd, 'transaction', current.controller_result.details.transaction.idempotency_key);
    const request = { cwd, contextRoot: cwd, milestoneId: milestone, sliceId: 'S01', scope: 'milestone',
      executionRouting: { workerEngine: 'codex', workerMode: 'sidecar', sidecarDeclared: true },
      phase: 'complete', unitType: 'complete-slice', dispatchId: `dispatch-382-${sequence}`, workflowId: 'synthetic-no-provider',
      route: { host_runtime: 'codex', resolved_worker_engine: 'codex' }, resultFile: path.join(mk('results'), 'complete-slice.json') };
    const expected = { resultFile: request.resultFile, cwd, contextRoot: cwd, unitType: 'complete-slice', milestoneId: milestone,
      sliceId: 'S01', workflowId: request.workflowId, dispatchId: request.dispatchId };
    return { cwd, milestone, input, options, current, begin, request, expected };
  }
  function legacyFixture() {
    const cwd = mk('legacy'), legacy = json(path.join(__dirname, 'fixtures/incomplete-resume/legacy-two-begins.json'));
    for (const [relative, row] of Object.entries(legacy.files)) {
      const file = path.join(cwd, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, row.content);
    }
    m.runs.add(cwd, { id: legacy.milestone, kind: 'milestone', session_id: 'fixture375-old',
      host_runtime: 'codex', owner_session_source: 'CODEX_THREAD_ID', pending_decisions: [] });
    const first = m.controller.lookupRecord(cwd, 'transaction', 'old-complete-slice');
    const later = m.controller.lookupRecord(cwd, 'transaction', 'new-successor');
    return { cwd, milestone: legacy.milestone, first,
      expectedRecordSha256: sha(fs.readFileSync(m.runs.runFile(cwd, legacy.milestone)).toString('utf8')),
      lineage: { begin_key: first.idempotency_key, begin_checksum: m.controller.recordChecksum(first),
        successors: [{ key: later.idempotency_key, checksum: m.controller.recordChecksum(later) }] } };
  }
  async function genuineBlocked(f, dispatchId, questions) {
    const request = { unitType: 'complete-slice', milestoneId: f.milestone, sliceId: 'S01', cwd: f.cwd, contextRoot: f.cwd,
      resultFile: path.join(mk('results'), 'prior-blocked.json'), dispatchId, workflowId: f.milestone,
      route: { host_runtime: 'codex', resolved_worker_engine: 'codex', worker_mode: 'sidecar' } };
    assert.equal(m.sidecar.beginArtifactAttempt(request).state, 'started');
    await m.sidecar.acceptArtifactResult(request, { status: 'blocked', summary: 'Synthetic returned blocked', questions, artifacts: [] }, { providerCalled: true });
    return request;
  }
  function supersession(f, request) {
    const eventFile = m.controller.eventsFile(f.cwd);
    const prior = fs.existsSync(eventFile) ? fs.readFileSync(eventFile, 'utf8') : '';
    const prefix = prior && !prior.endsWith('\n') ? prior + '\n' : prior;
    const eventLine = JSON.stringify({ event: 'route-chain-advance', fixture_only: true, unit: 'complete-slice/S01',
      milestone: f.milestone, from_dispatch: request.dispatchId, to_native: 'fixture382-native-final' });
    fs.mkdirSync(path.dirname(eventFile), { recursive: true });
    fs.writeFileSync(eventFile, prefix + eventLine + '\n');
    return { eventFile, routeEvidence: { path: eventFile, line: prefix.split('\n').length, sha256: sha(eventLine) },
      finalNative: { id: 'fixture382-native-final', host_runtime: 'codex', worker_mode: 'native', status: 'partial',
        receipt_path: null, observation_reference: 'fixture-only observed native final partial; no actual Agent call' } };
  }

  await test('projection and fingerprint stay byte-identical to the historical preimage, including linked property order', async () => {
    const legacy = (request, linked) => {
      const copy = { ...request };
      if (request.linked_begin_key) { copy.linked_entry_identity = linked; delete copy.linkedEntryBinding; }
      for (const key of ['rawResult', 'invocationTelemetry', 'providerCalled', 'resultFile', 'signal', 'publicationSafe',
        'publicationBoundary', 'waitForPublicationBoundary', 'ownerBroker']) delete copy[key];
      return sha(JSON.stringify(copy));
    };
    const linked = { entry_id: 'e', entry_digest: 'd', classification: 'new-unit' };
    for (const request of [{ b: 1, resultFile: 'x', a: 2 },
      { linked_begin_key: 'k', linked_entry_identity: { stale: true }, z: 1, linkedEntryBinding: {}, a: 0 },
      { a: 1, linked_begin_key: 'k', ownerBroker: { manifest: {} }, signal: {}, y: [1, 2] }]) {
      const l = request.linked_begin_key ? linked : undefined;
      assert.equal(m.fingerprint.projectFingerprint(request, l), legacy(request, l));
      assert.equal(sha(JSON.stringify(m.fingerprint.projectRequestData(request, l))), legacy(request, l));
    }
    assert.throws(() => m.fingerprint.projectRequestData({ linked_begin_key: 'k' }), /linked-entry-identity-required/);
  });

  await test('real complete-slice capture is exclusive, private and precedes started; ready keeps locator and hash', async () => {
    const f = sliceFixture(), original = JSON.parse(JSON.stringify(f.request));
    const started = m.sidecar.beginArtifactAttempt(f.request);
    assert.equal(started.state, 'started');
    const bytes = fs.readFileSync(archiveOf(f.request)), receipt = json(receiptOf(f.request)), data = JSON.parse(bytes);
    if (process.platform !== 'win32') assert.equal(fs.statSync(archiveOf(f.request)).mode & 0o777, 0o600);
    assert.equal(receipt.retained_request.sha256, sha(bytes));
    assert.equal(receipt.retained_request.file, path.basename(archiveOf(f.request)));
    assert.equal(receipt.retained_request.delivery_fingerprint, receipt.fingerprint);
    assert.equal(sha(data.delivery_json), m.sidecar.artifactFingerprint(f.request));
    assert.deepEqual(Object.keys(JSON.parse(data.delivery_input_json)), Object.keys(original), 'insertion order preserved');
    assert.equal(data.delivery_input_json, JSON.stringify(original));
    assert.equal(data.caller_request_sha256, m.recovery.callerRequestHash(original));
    assert.equal(data.caller_request_reproducible, true);
    assert.deepEqual(data.runtime_requirements, { linked_entry: false, owner_broker: false });
    assert.equal(data.preparation_input, 'not-applicable');
    assert(!bytes.toString('utf8').includes(DUMMY_TOKEN), 'no environment credential copied');
    await m.sidecar.acceptArtifactResult(f.request, { status: 'partial', summary: 'Synthetic returned partial',
      questions: [{ id: 'decision-382', question: 'Synthetic decision?' }], artifacts: [] }, { providerCalled: true });
    const ready = json(receiptOf(f.request));
    assert.equal(ready.phase, 'ready');
    assert.deepEqual(ready.retained_request, receipt.retained_request);
    assert(fs.readFileSync(archiveOf(f.request)).equals(bytes), 'archive immutable through ready');
    const read = m.retention.read(ready, f.expected, { receiptPath: receiptOf(f.request) });
    assert.equal(read.runtime_authority_restored, false);
    assert.deepEqual(read.restore(), original);
  });

  await test('fresh process settles a genuine partial through the archived inspector, keeping questions and caller hash', async () => {
    const f = sliceFixture(), original = JSON.parse(JSON.stringify(f.request));
    m.sidecar.beginArtifactAttempt(f.request);
    const result = { status: 'partial', summary: 'Synthetic returned partial', questions: [{ id: 'decision-382', question: 'Synthetic decision?' }], artifacts: [] };
    await m.sidecar.acceptArtifactResult(f.request, result, { providerCalled: true });
    const receiptBytes = fs.readFileSync(receiptOf(f.request)), archiveBytes = fs.readFileSync(archiveOf(f.request));
    const out = child('settle-partial', { input: f.input, snapshot: f.current.snapshot, result, beginKey: f.begin.idempotency_key, expected: f.expected });
    assert.equal(out.lifecycle, 'paused');
    assert.deepEqual(out.pending, ['decision-382']);
    assert.equal(out.resume_reason, 'pending-questions', 'unanswered question still blocks dependent work');
    assert(out.observed.includes(f.begin.idempotency_key));
    const pause = m.controller.incompleteUnits(f.cwd, f.milestone).find(row => row.action === 'pause');
    assert.equal(pause.result.output.partial_attempt.request_sha256, m.recovery.callerRequestHash(original), 'caller hash reproduced, not substituted');
    assert(fs.readFileSync(receiptOf(f.request)).equals(receiptBytes)); assert(fs.readFileSync(archiveOf(f.request)).equals(archiveBytes));
  });

  await test('fresh process R1 supersession inspection uses only archive+receipt, with independent live attestations', async () => {
    const f = legacyFixture();
    const request = await genuineBlocked(f, 'fixture382-codex-first', [{ id: 'result382-question', question: 'Result unresolved decision?' }]);
    const evidence = supersession(f, request);
    const seed = { cwd: f.cwd, milestone: f.milestone, expectedRecordSha256: f.expectedRecordSha256, lineage: f.lineage,
      beginKey: f.first.idempotency_key, receiptPath: receiptOf(request), routeEvidence: evidence.routeEvidence, finalNative: evidence.finalNative,
      expected: { resultFile: request.resultFile, cwd: f.cwd, contextRoot: f.cwd, unitType: 'complete-slice', milestoneId: f.milestone,
        sliceId: 'S01', workflowId: request.workflowId, dispatchId: request.dispatchId } };
    // Negatives first, in-process; each refuses before any terminal/lease/run effect.
    const monitored = () => fs.readFileSync(m.runs.runFile(f.cwd, f.milestone)).toString('utf8');
    const before = monitored();
    const inspector = hostInspector(seed);
    const cases = [
      ['serialized proof', { archived_inspection: {} }],
      ['foreign proof', { archived_inspection: Object.freeze(Object.create(null)) }],
      ['approved flag is not a proof', { archived_inspection: { approved: true } }],
    ];
    process.env.CODEX_THREAD_ID = 'fixture375-new';
    try {
      for (const [label, context] of cases) {
        assert.throws(() => m.runs.settleInterruptedOwner(f.cwd, f.milestone, r1Options(seed, inspector, { context })),
          error => error.code === 'attempt-identity-mismatch' && error.details?.archived_reason === 'archived-inspection-invalid', label);
        assert.equal(monitored(), before, `${label} has no run effect`);
      }
      const foreignHost = { ...seed, expected: { ...seed.expected, dispatchId: 'foreign-dispatch' } };
      assert.throws(() => m.runs.settleInterruptedOwner(f.cwd, f.milestone, r1Options(seed, hostInspector(foreignHost))),
        error => ['request-retention-binding-mismatch'].includes(error.code));
      const foreignRoot = { ...seed, expected: { ...seed.expected, cwd: mk('foreign-root'), contextRoot: mk('foreign-owner') } };
      assert.throws(() => m.runs.settleInterruptedOwner(f.cwd, f.milestone, r1Options(seed, hostInspector(foreignRoot))),
        error => /request-retention-(binding-mismatch|path-invalid)/.test(error.code));
      assert.equal(monitored(), before);
    } finally { delete process.env.CODEX_THREAD_ID; }
    const receiptBytes = fs.readFileSync(receiptOf(request));
    const out = child('r1', seed, { CODEX_THREAD_ID: 'fixture375-new' });
    assert.equal(out.status, 'interrupted-and-transferred');
    assert.equal(out.artifacts_accepted, false);
    assert.deepEqual(out.pending, ['result382-question']);
    assert.equal(out.superseded_dispatch, request.dispatchId);
    assert.equal(out.superseded_fingerprint, m.sidecar.artifactFingerprint(request));
    assert(out.observed.length > 0 && out.observed.every(key => key === f.first.idempotency_key), 'host observer bound only to the original begin');
    assert(fs.readFileSync(receiptOf(request)).equals(receiptBytes), 'receipt unchanged');
  });

  await test('fresh process ready replay reuses the retained response with zero resolver/provider calls', async () => {
    const f = sliceFixture();
    m.sidecar.beginArtifactAttempt(f.request);
    await m.sidecar.acceptArtifactResult(f.request, { status: 'blocked', summary: 'Synthetic blocked', questions: [{ id: 'keep-382', question: 'Kept?' }], artifacts: [] }, { providerCalled: true });
    const receiptBytes = fs.readFileSync(receiptOf(f.request)), resultBytes = fs.readFileSync(f.request.resultFile);
    const out = child('replay', { cwd: f.cwd, begin: f.begin, beginKey: f.begin.idempotency_key, expected: f.expected });
    assert.equal(out.replayed, true); assert.equal(out.provider_called, false); assert.equal(out.status, 'blocked');
    assert.deepEqual(out.request_keys, Object.keys(f.request));
    assert(fs.readFileSync(receiptOf(f.request)).equals(receiptBytes), 'receipt and questions unchanged');
    assert.deepEqual(json(f.request.resultFile), JSON.parse(resultBytes));
    assert.deepEqual(json(receiptOf(f.request)).pending_questions.map(q => q.id), ['keep-382']);
  });

  await test('linked: historical proof derives identity from the actual begin chain, never becomes a binding or caller hash', async () => {
    const f = legacyFixture();
    process.env.CODEX_THREAD_ID = 'fixture375-new';
    let begun, bound;
    try {
      const plain = { ...r1Options({ ...f }, null), inspectInterruption: ({ begin, role }) => ({ begin_key: begin.idempotency_key,
        begin_checksum: m.controller.recordChecksum(begin), invocation_status: role === 'original' ? 'invoked-unverified' : 'not-invoked',
        receipt_path: null, saved_response: 'none-observed', roots: [{ root_id: 'primary', path: f.cwd }], pending_questions: [],
        observation_reference: 'disposable fixture observation' }) };
      assert.equal(m.runs.settleInterruptedOwner(f.cwd, f.milestone, plain).status, 'interrupted-and-transferred');
      const failure = m.controller.failureProjection(f.cwd, f.milestone)[0];
      const baseline = m.controller.recordChecksum({ fixture: 'entry-baseline-382' });
      const live = { ...plain, captureEntryBaseline: () => ({ sha256: baseline, roots: [{ root_id: 'primary', path: f.cwd }] }),
        entryAuthority: m.recovery.createAuthority(reference => ({ reference, status: 'resolved', answer: 'authorize', resolved_at: new Date().toISOString() })) };
      const entered = m.controller.reenter(f.cwd, { milestone: f.milestone, unit: 'complete-slice/S01', host_runtime: 'codex', owner_token: 'new382-owner-token',
        entry: { entry_id: 'new382-S01', failure_key: failure.transaction.idempotency_key,
          failure_checksum: m.controller.recordChecksum(failure.transaction), authorization_ref: 'conversation:fixture382' } }, live);
      begun = m.controller.lookupRecord(f.cwd, 'transaction', entered.transaction.idempotency_key);
      bound = m.recovery.bindLinkedRequest({ unitType: 'complete-slice', milestoneId: f.milestone, sliceId: 'S01', cwd: f.cwd, contextRoot: f.cwd,
        resultFile: path.join(mk('results'), 'linked.json'), dispatchId: 'linked382-dispatch', workflowId: f.milestone,
        route: { host_runtime: 'codex', resolved_worker_engine: 'codex', worker_mode: 'sidecar' }, linked_begin_key: begun.idempotency_key },
      { ...live, ownerToken: 'new382-owner-token' });
    } finally { delete process.env.CODEX_THREAD_ID; }
    const liveIdentity = m.recovery.requestIdentity(m.recovery.canonicalRequest(bound));
    m.sidecar.beginArtifactAttempt(bound);
    await m.sidecar.acceptArtifactResult(bound, { status: 'blocked', summary: 'Synthetic linked blocked', questions: [], artifacts: [] }, { providerCalled: true });
    const receipt = json(receiptOf(bound)), archive = json(archiveOf(bound));
    assert.deepEqual(archive.runtime_requirements, { linked_entry: true, owner_broker: false });
    assert.equal(archive.caller_request_reproducible, false, 'live handle bytes are not reproducible from data');
    assert(!JSON.parse(archive.delivery_input_json).linkedEntryBinding);
    const out = child('linked', { cwd: f.cwd, begin: begun, beginKey: begun.idempotency_key,
      expected: { resultFile: bound.resultFile, cwd: f.cwd, contextRoot: f.cwd, unitType: 'complete-slice', milestoneId: f.milestone,
        sliceId: 'S01', workflowId: bound.workflowId, dispatchId: bound.dispatchId } });
    assert.equal(out.linked, true);
    assert.equal(out.fingerprint, receipt.fingerprint);
    assert.deepEqual(out.linked_entry, liveIdentity.linked_entry);
    assert.equal(out.caller_hash, null);
    assert.equal(out.current_identity, 'linked-entry-binding-required');
    assert.equal(out.current_fingerprint, 'linked-entry-binding-required');
    assert.equal(out.proof_as_binding, 'linked-entry-binding-required');
    assert.notEqual(out.proof_as_owner_token, 'no-error');
    assert.equal(out.replay, 'linked-entry-binding-required', 'replay needs the live binding');
    assert.equal(out.settle, 'request-retention-caller-hash-unavailable');
  });

  await test('broker requirement survives restoration: missing, fake or imported broker refuses replay publication', async () => {
    const f = sliceFixture();
    const fakeBroker = { manifest: { request_sha256: 'x', plan_sha256: null }, verify() {} };
    const withBroker = { ...f.request, ownerBroker: fakeBroker };
    const ref = m.retention.retain(withBroker);
    assert.deepEqual(ref.runtime_requirements, { linked_entry: false, owner_broker: true });
    const data = json(archiveOf(f.request));
    assert(!data.delivery_input_json.includes('manifest'), 'broker object never archived');
    fs.writeFileSync(receiptOf(f.request), JSON.stringify({ phase: 'ready', fingerprint: m.sidecar.artifactFingerprint(f.request),
      dispatch_id: f.request.dispatchId, retained_request: ref, pending_questions: [], provider_called: true,
      result: { status: 'blocked', summary: 'fixture', questions: [], artifacts: [] }, artifacts: [] }));
    const receiptBytes = fs.readFileSync(receiptOf(f.request));
    assert.equal(await codeOfAsync(() => m.sidecar.replayArtifactAttempt(f.request)), 'request-retention-broker-required');
    assert.notEqual(await codeOfAsync(() => m.sidecar.replayArtifactAttempt(withBroker)), 'no-error', 'fake handle fails assertBroker');
    assert.notEqual(await codeOfAsync(() => m.sidecar.replayArtifactAttempt({ ...f.request, ownerBroker: JSON.parse(JSON.stringify(fakeBroker)) })), 'no-error');
    assert(fs.readFileSync(receiptOf(f.request)).equals(receiptBytes));
    assert(!fs.existsSync(f.request.resultFile), 'nothing published');
    // Historical inspection remains distinct from publication.
    const read = m.retention.read(json(receiptOf(f.request)), f.expected, { receiptPath: receiptOf(f.request) });
    assert.equal(read.runtime_requirements.owner_broker, true);
  });

  await test('capture refusals, orphans, tamper, links and legacy receipts fail safely', async () => {
    { // conflicting and partial orphans are never overwritten; no receipt, no provider
      for (const orphan of ['not json', '{"schema_version":1,"kind":"forge-exact']) {
        const f = sliceFixture();
        fs.writeFileSync(archiveOf(f.request), orphan);
        assert.equal(codeOf(() => m.sidecar.beginArtifactAttempt(f.request)), 'request-retention-conflict');
        assert.equal(fs.readFileSync(archiveOf(f.request), 'utf8'), orphan);
        assert(!fs.existsSync(receiptOf(f.request)));
      }
    }
    { // identical orphan from a crash before started is reused byte for byte
      const f = sliceFixture();
      const first = m.retention.retain(f.request), bytes = fs.readFileSync(archiveOf(f.request));
      assert.equal(m.sidecar.beginArtifactAttempt(f.request).state, 'started');
      assert.deepEqual(json(receiptOf(f.request)).retained_request, first);
      assert(fs.readFileSync(archiveOf(f.request)).equals(bytes));
    }
    { // credential-shaped field: refused before archive and started
      const f = sliceFixture();
      assert.equal(codeOf(() => m.sidecar.beginArtifactAttempt({ ...f.request, env: { OPENAI_API_KEY: DUMMY_TOKEN } })), 'request-retention-secret-field');
      assert(!fs.existsSync(archiveOf(f.request))); assert(!fs.existsSync(receiptOf(f.request)));
    }
    const f = sliceFixture();
    m.sidecar.beginArtifactAttempt(f.request);
    await m.sidecar.acceptArtifactResult(f.request, { status: 'blocked', summary: 'Synthetic blocked', questions: [], artifacts: [] }, { providerCalled: true });
    const receipt = json(receiptOf(f.request)), archive = archiveOf(f.request), original = fs.readFileSync(archive);
    const read = (changes = {}, rec = receipt) => codeOf(() => m.retention.read(rec, { ...f.expected, ...changes }, { receiptPath: receiptOf(f.request) }));
    assert.equal(read(), 'no-error');
    assert.equal(read({ dispatchId: 'foreign' }), 'request-retention-binding-mismatch');
    assert.equal(read({ unitType: 'complete-milestone' }), 'request-retention-binding-mismatch');
    assert.equal(read({ sliceId: 'S02' }), 'request-retention-binding-mismatch');
    assert.equal(read({ resultFile: path.join(mk('results'), 'complete-slice.json') }), 'request-retention-binding-mismatch');
    assert.equal(read({}, { ...receipt, retained_request: { ...receipt.retained_request, file: 'other.request.json' } }), 'request-retention-binding-mismatch');
    assert.equal(read({}, { ...receipt, fingerprint: 'f'.repeat(64) }), 'request-retention-fingerprint-mismatch');
    assert.equal(codeOf(() => m.retention.read(receipt, f.expected, { receiptPath: path.join(mk('elsewhere'), 'x.receipt.json') })), 'request-retention-binding-mismatch');
    const tampered = Buffer.from(original); tampered[tampered.length - 3] ^= 1;
    fs.writeFileSync(archive, tampered);
    assert.equal(read(), 'request-retention-hash-mismatch');
    assert.equal(await codeOfAsync(() => m.sidecar.replayArtifactAttempt(f.request)), 'request-retention-hash-mismatch');
    // A consistent re-signed archive is still refused by the receipt locator hash.
    const forged = JSON.parse(original); forged.delivery_input_json = forged.delivery_input_json.replace('synthetic-no-provider', 'synthetic-no-provider');
    fs.writeFileSync(archive, JSON.stringify(forged) + ' \n');
    assert.equal(read(), 'request-retention-hash-mismatch');
    fs.writeFileSync(archive, original);
    // Hard-linked (multi-name) archive is not a stable private regular file.
    const alias = path.join(mk('alias'), 'linked.json');
    try { fs.linkSync(archive, alias); } catch { /* filesystem without hard links */ }
    const hardLinked = fs.existsSync(alias);
    if (hardLinked) { assert.equal(read(), 'request-retention-path-invalid'); fs.rmSync(alias); }
    assert.equal(read(), 'no-error');
    // Symlinked archive target (POSIX symlink or Windows file link where permitted).
    const real = path.join(mk('target'), 'real.json'); fs.writeFileSync(real, original); fs.rmSync(archive);
    let linked = true;
    try { fs.symlinkSync(real, archive, 'file'); } catch { linked = false; }
    if (linked) assert.match(read(), /request-retention-(path-invalid|unavailable)/);
    if (fs.existsSync(archive) || linked) fs.rmSync(archive, { force: true });
    fs.writeFileSync(archive, original);
    // Missing new copy: refused, never re-captured or inferred.
    fs.rmSync(archive);
    assert.equal(read(), 'request-retention-unavailable');
    assert.equal(await codeOfAsync(() => m.sidecar.replayArtifactAttempt(f.request)), 'request-retention-unavailable');
    assert(!fs.existsSync(archive), 'no backfill of a missing historical copy');
    fs.writeFileSync(archive, original);
    // Junction/symlink result directory into the workspace is refused before capture.
    const g = sliceFixture(), inside = path.join(g.cwd, 'inside'); fs.mkdirSync(inside);
    const junction = path.join(mk('junction-parent'), 'results-alias');
    let junctioned = true;
    try { fs.symlinkSync(inside, junction, process.platform === 'win32' ? 'junction' : 'dir'); } catch { junctioned = false; }
    if (junctioned) {
      const escaped = { ...g.request, resultFile: path.join(junction, 'escape.json') };
      assert.notEqual(codeOf(() => m.sidecar.beginArtifactAttempt(escaped)), 'no-error');
      assert(!fs.existsSync(path.join(inside, 'escape.json.request.json'))); assert(!fs.existsSync(path.join(inside, 'escape.json.receipt.json')));
      assert.match(codeOf(() => m.retention.retain(escaped)), /request-retention-path-invalid|result-file/);
      fs.rmSync(junction, { recursive: true, force: true });
    }
    // Platform-dependent cases are reported, never silently counted as proven.
    console.log(`  platform cases executed: hard-link=${hardLinked} file-symlink=${linked} dir-junction=${junctioned}`);
    // Legacy receipt (pre-#382): exact external request keeps working; no backfill.
    const h = sliceFixture();
    m.sidecar.beginArtifactAttempt(h.request);
    await m.sidecar.acceptArtifactResult(h.request, { status: 'blocked', summary: 'Legacy blocked', questions: [], artifacts: [] }, { providerCalled: true });
    const legacy = json(receiptOf(h.request)); delete legacy.retained_request;
    fs.writeFileSync(receiptOf(h.request), JSON.stringify(legacy)); fs.rmSync(archiveOf(h.request));
    const legacyBytes = fs.readFileSync(receiptOf(h.request));
    const replay = await m.sidecar.replayArtifactAttempt(h.request);
    assert.equal(replay.replayed, true); assert.equal(replay.provider_called, false);
    assert(fs.readFileSync(receiptOf(h.request)).equals(legacyBytes), 'legacy receipt unchanged');
    assert(!fs.existsSync(archiveOf(h.request)), 'legacy receipt is never backfilled');
    assert.equal(codeOf(() => hostInspector({ beginKey: h.begin.idempotency_key, expected: h.expected }).inspect({ cwd: h.cwd, begin: h.begin })), 'request-retention-unavailable');
    // JSON or approved-flag hosts are not observers; begin drift refuses.
    assert.equal(codeOf(() => m.recovery.createArchivedRequestInspector({ observeOriginalAttempt: { approved: true } })), 'archived-inspection-host-required');
    assert.equal(codeOf(() => m.recovery.createArchivedRequestInspector({ observeOriginalAttempt: () => ({ ...f.expected, approved: true }) })
      .inspect({ cwd: f.cwd, begin: f.begin })), 'archived-inspection-expected-invalid');
    assert.equal(codeOf(() => hostInspector({ beginKey: f.begin.idempotency_key, expected: f.expected })
      .inspect({ cwd: f.cwd, begin: { ...f.begin, lease_generation: 999 } })), 'archived-inspection-begin-changed');
    assert.equal(codeOf(() => m.recovery.revalidateArchivedInspection(JSON.parse(JSON.stringify(Object.freeze({}))), {})), 'archived-inspection-invalid');
  });

  assert(!fs.existsSync(marker), 'no provider CLI was spawned');
  console.log(`\n${passed} request-retention checks passed`);
  fs.rmSync(root, { recursive: true, force: true });
}
