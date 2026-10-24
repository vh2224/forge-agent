'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const transition = require('./forge-recovery-transition');
const recovery = require('./forge-attempt-recovery');
const resolver = require('./forge-dispatch-resolve');
const { digest } = require('./forge-code-roots');
const stateApi = require('./forge-xllm-state');
const { fixture: rootsFixture } = require('./forge-code-roots.test');
const capabilities = { available: true, tool: 'collaboration.spawn_agent', source: 'transition-fixture',
  models: ['gpt-6-astra', 'gpt-5.6-sol'], reasoning_efforts: ['max', 'high', 'medium'], fork_turns: ['none'] };
const reference = 'conversation:transition-fixture';
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); }
function authority(f, register = false) {
  const adapter = require('./forge-interaction').createRecoveryAuthorizationAdapter(observed => ({ ...observed,
    received: true, answer: 'authorize', resolved_at: f.now }), { resolveProfile: () => f.profile, clock: () => f.now });
  return { adapter, reference, ...(register ? { registration: { host: 'codex', section: 'user:forge-routing-continuity' } } : {}) };
}
function setup({ questions = [] } = {}) {
  const f = rootsFixture(), oldEnv = {};
  f.profile = path.join(f.dir, 'profile');
  for (const key of ['HOME', 'USERPROFILE', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'FORGE_HOME']) oldEnv[key] = process.env[key];
  process.env.HOME = process.env.USERPROFILE = f.profile;
  process.env.CODEX_HOME = path.join(f.profile, '.codex'); process.env.CLAUDE_CONFIG_DIR = path.join(f.profile, '.claude');
  process.env.FORGE_HOME = path.join(f.profile, 'forge');
  const source = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'shared/forge-procedures.json')));
  for (const file of ['shared/forge-procedures.json', ...manifest.modules.map(row => row.path)])
    write(path.join(process.env.FORGE_HOME, file), fs.readFileSync(path.join(source, file)));
  write(path.join(f.profile, '.codex/AGENTS.md'), '<!-- user:forge-routing-continuity:start -->\nFixture authorization.\n<!-- user:forge-routing-continuity:end -->');
  f.prefsFile = path.join(f.owner, '.gsd/forge-prefs.jsonc');
  write(f.prefsFile, JSON.stringify({ tier_models: { heavy: ['claude-sonnet-5', 'gpt-5.6-sol', 'claude-opus-5'],
    max: ['claude-sonnet-5', 'gpt-6-astra', 'claude-opus-5'], standard: ['claude-sonnet-5', 'gpt-5.6-sol', 'claude-opus-5'] }, effort: { 'plan-slice': 'high' } }));
  f.roadmap = path.join(f.owner, '.gsd/milestones/M901/M901-ROADMAP.md'); write(f.roadmap, '# M901\n- S01 risk: high\n');
  f.originalOptions = { cwd: f.owner, unitType: 'plan-slice', hostRuntime: 'codex' };
  f.request = { unitType: 'plan-slice', scope: 'milestone', phase: 'plan', milestoneId: 'M901', sliceId: 'S01',
    cwd: f.a, contextRoot: f.owner, roadmapFile: f.roadmap, execution_contract: f.contract,
    dispatchId: 'original-attempt', workflowId: 'fixture-workflow', resultFile: path.join(f.dir, 'result.json'),
    prompt: 'Plan the fixture only.', route: resolver.resolveDispatch(f.originalOptions) };
  f.stateFile = f.request.resultFile + '.recovery.json'; f.receiptFile = f.request.resultFile + '.receipt.json';
  f.now = 10; f.calls = 0;
  const session = recovery.createRecovery({ unit: 'plan-slice/S01', roots_sha256: digest(f.contract), request: f.request,
    clock: () => f.now, persist: value => stateApi.saveRecovery(f.stateFile, value) });
  session.record({ route: f.request.route, failure_class: 'timeout', reason_code: 'sidecar-timeout', layer: 'transport',
    request_sha256: 'observed-request', request_bytes: 10, context_sha256: 'observed-context', context_bytes: 10,
    caller_request_sha256: recovery.callerRequestHash(f.request), duration_ms: 300000, budgets: { timeout: 300000 }, provider_called: 'unknown' });
  if (questions.length) session.questions(questions);
  write(f.receiptFile, JSON.stringify({ phase: 'failed', dispatch_id: f.request.dispatchId,
    fingerprint: require('./forge-unit-sidecar').artifactFingerprint(f.request), route: f.request.route,
    recovery_identity_sha256: digest(recovery.requestIdentity(f.request)), failure: { reason_code: 'sidecar-timeout', provider_called: 'unknown' } }));
  f.initial = stateApi.loadRecovery(f.stateFile);
  f.history = transition.observeHistory({ request: f.request, state: f.initial, receiptFile: f.receiptFile,
    contract: f.contract, resolverOptions: f.originalOptions });
  f.now = f.initial.started_at + 60001; // past the former 60000 ms window; v2 has no deadline_at
  f.binding = authority(f, true); recovery.bindRecoveryAuthorization(f.binding); delete f.binding.registration;
  const cleanup = f.cleanup;
  f.cleanup = () => { for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } cleanup(); };
  return f;
}
function adapter(f, overrides = {}) {
  return transition.createTransitionAdapter({
    attestHistory: challenge => ({ binding_sha256: digest(challenge), history: f.history, history_sha256: digest(f.history),
      evidence_reference: 'fixture:independently-retained-history', provenance_reference: 'fixture:trusted-host-observation', original_provenance: 'absent',
      ...(f.questionEvidence ? { question_state_sha256: digest(f.questionEvidence), question_evidence_reference: 'fixture:live-explicit-answers' } : {}) }),
    attestRoot: challenge => ({ binding_sha256: digest(challenge), evidence_reference: `fixture:root:${challenge.current.root_id}`,
      classification: digest(challenge.before) === digest(challenge.current) ? 'unchanged' : 'attributed-host-only' }),
    ...overrides,
  });
}
function options(f, overrides = {}) {
  return { request: f.request, stateFile: f.stateFile, receiptFile: f.receiptFile, executionContract: f.contract,
    clock: () => f.now, processProbe: () => 'stopped', recoveryAuthorization: f.binding,
    transitions: [{ type: 'resolver-context-omission', reference: 'fixture:omitted-context' }], transitionAdapter: adapter(f),
    resolverOptions: { ...f.originalOptions, milestoneId: 'M901', unitId: 'S01', roadmapPath: f.roadmap, scope: 'milestone', phase: 'plan' },
    validateInvocation: route => require('./forge-native-invocation').buildNativeInvocation({ hostRuntime: 'codex', resolvedDispatch: route,
      activeCapabilities: capabilities, prompt: 'Fixture only.', forkTurns: 'none', taskName: 'transition_fixture', agentType: 'forge-planner' }),
    invoke: async (route, invocation, remaining, assertReady) => { assertReady(); f.calls++;
      assert.equal(remaining, 0); assert.equal(route.effort, 'max'); assert.equal(invocation.args.reasoning_effort, 'max'); return { fixture: true }; },
    ...overrides };
}
async function candidateFixture(standalone = true, signed = false) {
  const f = setup(), unit = require('./forge-unit-sidecar'), prep = require('./forge-task-preparation');
  f.standalone = standalone;
  if (standalone) {
    f.raw = { schema_version: 1, scope: 'standalone-task', phase: 'brainstorm', taskId: 'T-20261021000000-transition',
      cwd: f.a, contextRoot: f.owner, hostRuntime: 'codex', workflowId: 'candidate-workflow', dispatchId: 'candidate-attempt',
      resultFile: path.join(f.dir, 'candidate.json'), constraints: { auto_commit: false, deploy: false },
      inputs: { brief: 'Synthetic candidate; SECRET-SENTINEL must never enter telemetry.' }, execution_contract: f.contract, activeCapabilities: capabilities };
    const request = prep.validateRequest(f.raw);
    const route = resolver.resolveDispatch({ cwd: f.owner, unitType: 'plan-slice', unitId: f.raw.taskId,
      scope: 'standalone-task', phase: 'brainstorm', hostRuntime: 'codex' });
    f.request = prep.deliveryRequest(request, route, prep.buildPreparationPrompt(request));
  } else {
    f.request = { ...f.request, unitType: 'research-milestone', phase: 'research', sliceId: undefined, roadmapFile: undefined,
      dispatchId: 'candidate-attempt', resultFile: path.join(f.dir, 'candidate.json') };
    f.request.route = resolver.resolveDispatch({ cwd: f.owner, unitType: f.request.unitType,
      milestoneId: 'M901', unitId: 'M901', hostRuntime: 'codex' });
  }
  f.stateFile = f.request.resultFile + '.recovery.json'; f.receiptFile = f.request.resultFile + '.receipt.json';
  f.events = path.join(f.owner, '.gsd/forge/events.jsonl'); write(f.events, '{"event":"baseline"}\n');
  let broker;
  if (signed) broker = await require('./forge-artifact-reconciliation').startBroker({ owner: f.owner,
    execution_contract: f.contract, manifestFile: path.join(f.dir, 'manifest.json'),
    dispatchId: f.request.dispatchId, request_sha256: unit.artifactFingerprint(f.request) });
  try {
    unit.beginArtifactAttempt({ ...f.request, ...(broker ? { ownerBroker: broker } : {}) });
    if (broker) await broker.append('.gsd/forge/events.jsonl', '{"event":"trusted-owner"}\n');
    else fs.appendFileSync(f.events, '{"event":"trusted-owner"}\n');
    f.candidate = { status: 'done', summary: 'Synthetic saved candidate', questions: [], artifacts: [{ path: unit.locations(f.request).required[0],
      content: standalone ? '# Brainstorm\n## Recommended Approach\nUse canonical recovery.\n## Alternatives Considered\nRepeat.\n## Top Risks\nLost proof.\n## Out of Scope\nProviders.\n'
        : '# Research\nSynthetic independently observed findings.\n' }] };
    const responseAnchor = broker ? await broker.bindResponse(f.candidate) : undefined;
    await assert.rejects(unit.acceptArtifactResult(f.request, f.candidate, { providerCalled: true, enforceReadOnlySurface: true, responseAnchor }), /artifact-direct-write/);
    unit.failArtifactAttempt(f.request, 'artifact-direct-write-detected', 'owner append', 'unknown');
    if (broker) f.reconciliation = { manifest: broker.manifest, proofs: broker.proofs(),
      trust: { manifest_sha256: broker.manifest_sha256, request_sha256: unit.artifactFingerprint(f.request) } };
  } finally { if (broker) await broker.close(); }
  f.initial = stateApi.loadRecovery(f.stateFile);
  f.history = transition.observeHistory({ request: f.request, state: f.initial, receiptFile: f.receiptFile, contract: f.contract });
  f.now = f.initial.started_at + 60001; f.binding = authority(f); // past the former 60000 ms window
  f.transitions = [{ type: 'saved-candidate-unreplayable', reference: 'fixture:original-provenance-absent' }];
  f.originalReceipt = fs.readFileSync(f.receiptFile); f.originalEvents = fs.readFileSync(f.events);
  return f;
}
function recoverPublic(f, recoveryOptions = {}, runtime = {}) {
  const recover = f.standalone ? require('./forge-task-preparation').recoverStandaloneTask
    : require('./forge-unit-sidecar').recoverUnitSidecar;
  return recover(f.standalone ? f.raw : f.request, { stateFile: f.stateFile, receiptFile: f.receiptFile,
    clock: () => f.now, transitions: f.transitions || [{ type: 'resolver-context-omission', reference: 'fixture:omitted-context' }],
    reconciliation: f.reconciliation, ...recoveryOptions }, { transitionAdapter: adapter(f),
    recoveryAuthorization: f.binding, processProbe: () => 'stopped', activeCapabilities: capabilities, ...runtime });
}
function assertHistoryPreserved(f) {
  const state = stateApi.loadRecovery(f.stateFile);
  assert.deepEqual(state.attempts.slice(0, f.initial.attempts.length), f.initial.attempts);
  assert.equal(state.started_at, f.initial.started_at); assert.equal(state.deadline_at, f.initial.deadline_at);
  assert.deepEqual(fs.readFileSync(f.receiptFile), f.originalReceipt);
  if (f.originalEvents) assert.deepEqual(fs.readFileSync(f.events), f.originalEvents);
  assert.equal(state.attempts[0].provider_called, 'unknown');
  assert(!JSON.stringify(state).includes('SECRET-SENTINEL'));
  return state;
}
async function sidecarBoundary() {
  const xllm = require('./forge-xllm');
  for (const change of ['root', 'authority', 'process', 'valid']) {
    const f = await candidateFixture(false);
    const append = fs.appendFileSync, transport = xllm.invokeClaudeTransport;
    let scheduled = false, changed = false, calls = 0;
    try {
      f.now = f.initial.started_at + 1;
      fs.appendFileSync = function(file, bytes, ...rest) {
        const result = append.call(this, file, bytes, ...rest);
        if (!scheduled && String(bytes).includes('"status":"started"')) {
          scheduled = true;
          queueMicrotask(() => {
            changed = true;
            if (change === 'root') fs.writeFileSync(path.join(f.b, 'same.txt'), 'concurrent writer\n');
            if (change === 'authority') {
              const source = path.join(f.profile, '.codex/AGENTS.md');
              fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace('Fixture authorization.', 'Revoked source.'));
            }
          });
        }
        return result;
      };
      xllm.invokeClaudeTransport = async () => {
        calls++; assert.equal(scheduled, true, 'started append observed'); assert.equal(changed, true, 'microtask ran'); return { candidate: f.candidate };
      };
      const run = recoverPublic(f, {}, { activeCapabilities: { ...capabilities, available: false },
        processProbe: () => changed && change === 'process' ? 'alive' : 'stopped' });
      if (change === 'valid') {
        const result = await run;
        assert.equal(result.action, 'invoke'); assert.equal(calls, 1);
      } else {
        await assert.rejects(run, change === 'authority' ? /source-changed/ : /inspection-changed/);
        assert.equal(calls, 0);
      }
      assert.equal(scheduled, true); assert.equal(changed, true);
      assert.deepEqual(fs.readFileSync(f.receiptFile), f.originalReceipt);
      console.log(`PASS sidecar transition boundary: ${change}, synthetic provider calls=${calls}`);
    } finally { fs.appendFileSync = append; xllm.invokeClaudeTransport = transport; f.cleanup(); }
  }
}
async function main() {
  await sidecarBoundary();
  const f = setup();
  try {
    const originalReceipt = fs.readFileSync(f.receiptFile), initial = structuredClone(f.initial);
    assert.equal(f.request.route.tier, 'heavy'); assert.equal(f.request.route.effort, 'high');
    const inspect = () => recovery.inspectReceipt(f.receiptFile, { processProbe: () => 'stopped', request: f.request });
    for (const fake of [{ approved: true }, JSON.parse(JSON.stringify(adapter(f)))])
      await assert.rejects(transition.prepare(options(f, { transitionAdapter: fake }), initial, inspect()), /live-adapter/);
    await assert.rejects(transition.prepare(options(f, { transitions: [{ type: 'arbitrary', reference: 'fake' }] }), initial, inspect()), /type-invalid/);
    await assert.rejects(transition.prepare(options(f, { transitionAdapter: adapter(f, { attestHistory: () => ({ approved: true }) }) }), initial, inspect()), /history-unproved/);
    const noProof = f.history; f.history = { ...f.history, resolution: undefined };
    await assert.rejects(transition.prepare(options(f), initial, inspect()), /history-required/); f.history = noProof;
    for (const file of [f.prefsFile, f.roadmap, require('./forge-prefs').preferenceLayerDescriptors(f.owner)[0].jsoncPath]) {
      const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
      write(file, before ? Buffer.concat([before, Buffer.from('\n')]) : '{}');
      await assert.rejects(transition.prepare(options(f), initial, inspect()), /source-drift/);
      if (before) fs.writeFileSync(file, before); else fs.unlinkSync(file);
    }
    for (const change of [h => { h.resolution.sources[0].sha256 = 'changed-policy'; }, h => { h.resolution.options.effortMap = { 'plan-slice': 'max' }; },
      h => { h.request_identity_sha256 = 'foreign'; }, h => { h.roots_sha256 = 'foreign'; }, h => { h.roots.pop(); }]) {
      const saved = f.history; f.history = structuredClone(saved); change(f.history);
      await assert.rejects(transition.prepare(options(f), initial, inspect()), /drift|mismatch|binding|coverage/); f.history = saved;
    }
    await assert.rejects(transition.prepare(options(f, { processProbe: () => 'unknown' }), initial, inspect()), /changed/);
    await assert.rejects(transition.prepare(options(f, { transitionAdapter: adapter(f, { attestRoot: challenge => ({ binding_sha256: digest(challenge),
      classification: 'unknown', evidence_reference: 'mtime-only' }) }) }), initial, inspect()), /attribution/);
    const event = path.join(f.owner, '.gsd/forge/events.jsonl'); write(event, '{"host":"legitimate"}\n');
    const eventBytes = fs.readFileSync(event);
    const prepared = await transition.prepare(options(f), initial, inspect());
    assert.throws(() => transition.assertLive(JSON.parse(JSON.stringify(prepared.handle))), /live-handle/);
    const again = await transition.prepare(options(f), initial, inspect()); assert.deepEqual(again.reference, prepared.reference);
    fs.appendFileSync(event, '{"concurrent":true}\n'); assert.throws(() => transition.assertLive(prepared.handle), /changed/); fs.writeFileSync(event, eventBytes);
    const result = await recovery.recoverAttempt(options(f));
    assert.equal(result.route.model, 'gpt-6-astra'); assert.equal(result.route.tier, 'max'); assert.equal(result.sidecar_remaining_ms, 0); assert.equal(f.calls, 1);
    const final = stateApi.loadRecovery(f.stateFile);
    assert.deepEqual(final.attempts, initial.attempts); assert.equal(final.started_at, initial.started_at); assert.equal(final.deadline_at, initial.deadline_at);
    assert.deepEqual(fs.readFileSync(f.receiptFile), originalReceipt); assert.deepEqual(fs.readFileSync(event), eventBytes);
    assert.equal(final.transitions.length, 1); assert.equal(final.reservations[0].destination_key, transition.destinationKey(result.route));
    assert.equal(final.attempts[0].provider_called, 'unknown'); assert.equal(final.attempts[0].timeout_cause, 'indeterminate');
    // Restart authenticates the SAME history and personal source in a fresh OS process.
    const restartFile = path.join(f.dir, 'restart.json');
    write(restartFile, JSON.stringify({ request: f.request, stateFile: f.stateFile, receiptFile: f.receiptFile, contract: f.contract,
      profile: f.profile, history: f.history, now: f.now, originalOptions: f.originalOptions, roadmap: f.roadmap }));
    const child = spawnSync(process.execPath, [__filename, '--restart', restartFile], { encoding: 'utf8', timeout: 120000, windowsHide: true, env: process.env });
    assert.equal(child.status, 0, child.stdout + child.stderr); assert(child.stdout.includes('restart-authority-checked'));
    const source = path.join(f.profile, '.codex/AGENTS.md'); fs.appendFileSync(source, '\n');
    const content = fs.readFileSync(source, 'utf8'); fs.writeFileSync(source, content.replace('Fixture authorization.', 'Revoked source.'));
    await assert.rejects(recovery.recoverAttempt(options(f)), /source-changed/);
    console.log('PASS transitions: authenticated context, source drift, forged JSON, all roots, preserved host metadata, immutable clocks/history and real restart');
  } finally { f.cleanup(); }
}
async function restart(file) {
  const f = JSON.parse(fs.readFileSync(file)); f.binding = authority(f); f.calls = 0;
  const saved = stateApi.loadRecovery(f.stateFile);
  const result = await recovery.recoverAttempt(options(f));
  assert.equal(result.action, 'stop'); assert.equal(result.reason_code, 'recovery-candidates-exhausted'); assert.equal(f.calls, 0);
  assert.deepEqual(stateApi.loadRecovery(f.stateFile).attempts, saved.attempts);
  assert.equal(stateApi.loadRecovery(f.stateFile).transitions.length, 1);
  console.log('restart-authority-checked');
}
module.exports = { main, setup, options, adapter, authority, capabilities, write, candidateFixture, recoverPublic, assertHistoryPreserved };
if (require.main === module) (process.argv[2] === '--restart' ? restart(process.argv[3]) : main()).catch(error => { console.error(error); process.exitCode = 1; });
