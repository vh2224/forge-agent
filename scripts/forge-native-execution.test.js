#!/usr/bin/env node
'use strict';
// Production entrypoints and filesystem/VCS. Only host inference and live host
// observation are synthetic. Local child-process tests do not prove provider/UAT.
const assert = require('assert'), fs = require('fs'), path = require('path'), cp = require('child_process');
const { once } = require('events');
const harness = require('./fixtures/forge-native-execution').createFixtureHarness();
const { nativeFixture, write } = harness;
const unit = require('./forge-unit-sidecar'), native = require('./forge-native-invocation');
const transition = require('./forge-recovery-transition'), recovery = require('./forge-attempt-recovery');
const roots = require('./forge-code-roots'), verify = require('./forge-verify');
const receipt = f => JSON.parse(fs.readFileSync(f.r.resultFile + '.receipt.json'));
let lastEvidence;
const label = (value, extra = {}) => {
  const f = harness.latestNative();
  console.log(JSON.stringify({ label: value, ...(f ? { tool_calls: f.calls(), ...f.metrics, ...historical(f) } : {}), ...lastEvidence, ...extra }));
  lastEvidence = undefined;
};
const historical = f => {
  const file = f.r.resultFile + '.receipt.json';
  if (!fs.existsSync(file)) return { phase: 'absent' };
  const row = receipt(f);
  return { phase: row.phase, fingerprint: row.fingerprint, baseline: roots.digest(row.recovery_baseline || null), final_evidence: roots.digest(row.final_evidence || null) };
};
async function refuse(f, runtime, code, calls = 0) {
  await assert.rejects(() => unit.runUnitSidecar(f.r, runtime), error => {
    lastEvidence = { reason_code: error.code || String(error.message).slice(0, 180), tool_calls: f.calls(), ...historical(f) };
    if (code) assert.match(error.code || '', code, error.stack);
    if (!calls) assert.strictEqual(error.provider_called, false, error.stack);
    return true;
  });
  assert.strictEqual(f.calls(), calls);
  assert(!fs.existsSync(path.join(f.task, `${f.r.taskId}-SUMMARY.md`)));
}
function liveAdapter(observe = () => {}) {
  return transition.createWriterObservationAdapter(async challenge => {
    await observe(challenge);
    return { ...challenge, status: 'stopped', writer_identity: `local:${challenge.dispatch_id}`,
      binding_sha256: roots.digest(challenge), evidence_reference: 'fixture:controlled-host-observation' };
  });
}
async function savedFixture(phase = 'failed') {
  const f = nativeFixture(), invoke = f.runtime.invokeNative;
  f.mailbox = path.join(f.dir, 'mailbox.json');
  f.runtime.invokeNative = async (...args) => {
    const result = await invoke(...args); write(f.mailbox, '\ufeff' + JSON.stringify(result));
    throw Object.assign(new Error('fixture crash after durable response'), { code: 'fixture-crash', provider_called: true });
  };
  await assert.rejects(() => unit.runUnitSidecar(f.r, f.runtime), /fixture-crash/);
  let record = receipt(f);
  if (phase === 'started') { record = { ...record, phase: 'started' }; write(f.r.resultFile + '.receipt.json', record); }
  f.history = JSON.stringify({ failure: record.failure, final_evidence: record.final_evidence, baseline: record.recovery_baseline,
    identity: record.recovery_identity_sha256, fingerprint: record.fingerprint, started: record.started_at });
  f.savedRuntime = { ...f.runtime, savedNativeResult: { resultFile: f.mailbox, sha256: roots.digest(fs.readFileSync(f.mailbox)),
    dispatchId: f.r.dispatchId, fingerprint: record.fingerprint, processStopped: true },
    processProbe: () => 'stopped', writerObservationAdapter: liveAdapter(),
    verifyOwnership: () => { f.metrics.reconciliation_calls++; throw new Error('saved replay must not reset'); },
    invokeNative: () => { throw new Error('saved response must never infer again'); } };
  return f;
}
  const mutations = {
    claim: f => { f.r.claim.generation = 'changed'; },
    caps: f => { f.caps.models = []; },
    prompt: f => fs.appendFileSync(f.r.nativePromptFile, '\nchanged'),
    gates: f => { f.r.gates.security = 'failed'; },
    model: f => { f.r.route.model = 'gpt-6-astra'; },
    effort: f => { f.r.route.effort = 'low'; },
    roots: f => { f.r.execution_contract.primary_root_id = 'foreign'; },
    inputs: f => fs.appendFileSync(path.join(f.task, `${f.r.taskId}-RESEARCH.md`), 'changed'),
    baseline: f => fs.appendFileSync(f.r.resultFile + '.reset-state.json', ' '),
    metadata: f => fs.appendFileSync(path.join(f.owner, '.gsd/forge/events.jsonl'), '{}\n'),
  };
async function main() {
  if (process.argv.includes('--review-r1')) return reviewReadinessCases();
  if (process.argv.includes('--review-r2')) return reviewVerificationCases();
  if (process.argv.includes('--review-r3')) return reviewOwnerSnapshotCases();
  console.log(JSON.stringify({ label: 'matrix-applicability', fresh_native: 'No earlier writer/process or recovery authorization exists; claims/gates/caps/binding still checked.', recovered_native: 'Proven service failure permits next routed candidate without a recovery exception; live standing authorization is covered separately by attempt-recovery tests.', provider: 'synthetic', child_process: 'local retained handle', human_uat: 'not exercised' }));
  if (!process.argv.some(arg => ['--saved', '--extra', '--recovery'].includes(arg))) {
  const positive = nativeFixture();
  const done = await unit.runUnitSidecar(positive.r, positive.runtime);
  assert.strictEqual(done.status, 'done'); assert.strictEqual(positive.calls(), 1);
  const first = receipt(positive);
  assert.strictEqual(first.phase, 'ready'); assert(first.recovery_baseline);
  assert.strictEqual(first.delivery_capture.verification_policy_sha256, first.verification_seal.sha256);
  assert.notStrictEqual(first.execution.packaged_context.sha256, first.execution.packaged_context.transport_sha256);
  label('native-positive');
  await unit.runUnitSidecar(positive.r, positive.runtime); assert.strictEqual(positive.calls(), 1); label('ready-replay');
  await assert.rejects(() => unit.runUnitSidecar(positive.r, { ...positive.runtime, verification: { preferenceCommands: ['node -e "process.exit(0)"', 'node -e "process.exit(1)"'] } }), /verification-policy-changed/);
  label('ready-replay-policy-change');
  const precedence = nativeFixture({ verify: 'node --version' });
  await unit.runUnitSidecar(precedence.r, { ...precedence.runtime, verification: { preferenceCommands: [...precedence.r.verification.preferenceCommands, 'node -e "process.exitCode=0"'], commandTimeoutMs: 12000 } });
  const policy = receipt(precedence).verification_seal;
  assert.strictEqual(policy.roots[0].commands[0], 'node --version'); assert.strictEqual(policy.roots[0].origins[0], 'task-plan');
  assert.strictEqual(policy.command_timeout_ms, 12000);
  assert(policy.roots[0].configuration_sources.includes('request.preferenceCommands'));
  assert(policy.roots[0].configuration_sources.includes('runtime.preferenceCommands')); label('plan-priority');
  for (const [name, request, override] of [
    ['replace-preferences', { preferenceCommands: ['node --version'] }, { preferenceCommands: ['node -e "process.exit(0)"'] }],
    ['replace-root-preferences', { commandsByRoot: { app: ['node --version'] } }, { commandsByRoot: { app: ['node -e "process.exit(0)"'] } }],
    ['unknown-option', {}, { cwd: process.cwd() }], ['unknown-root', {}, { commandsByRoot: { foreign: ['node --version'] } }],
    ['invalid-timeout', {}, { commandTimeoutMs: 0 }], ['replace-timeout', { commandTimeoutMs: 5000 }, { commandTimeoutMs: 10000 }], ['invalid-command', {}, { preferenceCommands: ['node --version; echo bypass'] }],
  ]) {
    const f = nativeFixture(); f.r.verification = request;
    await refuse(f, { ...f.runtime, verification: override }, /verification-/); label(name);
  }
  for (const stage of ['announce', 'onPackagedContext', 'invoke', 'readback']) {
    for (const [name, mutate] of Object.entries(mutations)) {
      const f = nativeFixture(), runtime = { ...f.runtime };
      if (stage === 'invoke') { const invoke = runtime.invokeNative; runtime.invokeNative = async (...args) => { const value = await invoke(...args); mutate(f); return value; }; }
      else if (stage === 'readback') runtime.readback = async () => { f.metrics.readback_calls++; await Promise.resolve(); mutate(f); return { model: 'gpt-6.1-sol', source: 'fixture' }; };
      else runtime[stage] = async () => { await Promise.resolve(); mutate(f); };
      await refuse(f, runtime, null, ['invoke', 'readback'].includes(stage) ? 1 : 0); label(`${stage}-mutation-${name}`);
    }
  }
  const linked = nativeFixture();
  linked.r.nativePromptFile = path.join(linked.dir, 'prompt-dir', 'native.txt');
  fs.mkdirSync(path.dirname(linked.r.nativePromptFile));
  let linkedOnce = false;
  linked.runtime.announce = () => {
    if (linkedOnce) return; linkedOnce = true;
    const original = path.dirname(linked.r.nativePromptFile), moved = original + '.moved';
    fs.renameSync(original, moved); fs.symlinkSync(moved, original, process.platform === 'win32' ? 'junction' : 'dir');
  };
  await refuse(linked, linked.runtime, /prompt|link|target/); label('physical-prompt-junction');
  }
  if (!process.argv.some(arg => ['--extra', '--recovery'].includes(arg))) {
  await reviewReadinessCases();
  for (const phase of ['failed', 'started']) {
    for (const state of ['running', 'unknown', true]) {
      const f = await savedFixture(phase);
      await refuse(f, { ...f.savedRuntime, processProbe: () => state }, /writer-observation-not-stopped/, 1);
      label(`saved-${phase}-live-probe-${state}`);
    }
    const f = await savedFixture(phase);
    const result = await unit.runUnitSidecar(f.r, f.savedRuntime); assert.strictEqual(result.status, 'done');
    const record = receipt(f);
    assert.strictEqual(JSON.stringify({ failure: record.failure, final_evidence: record.final_evidence, baseline: record.recovery_baseline,
      identity: record.recovery_identity_sha256, fingerprint: record.fingerprint, started: record.started_at }), f.history);
    assert.strictEqual(f.calls(), 1); label(`saved-${phase}-accepted`);
  }
  const imported = await savedFixture();
  await refuse(imported, { ...imported.savedRuntime, writerObservationAdapter: JSON.parse(JSON.stringify(imported.savedRuntime.writerObservationAdapter)) }, /writer-observation-adapter-required/, 1); label('serialized-adapter-refused');
  for (const [name, mutate] of Object.entries(mutations)) {
    const f = await savedFixture();
    const originalReceipt = fs.readFileSync(f.r.resultFile + '.receipt.json'), originalState = fs.readFileSync(f.r.resultFile + '.recovery.json');
    await refuse(f, { ...f.savedRuntime, writerObservationAdapter: liveAdapter(() => mutate(f)) }, null, 1);
    assert(fs.readFileSync(f.r.resultFile + '.receipt.json').equals(originalReceipt));
    assert(fs.readFileSync(f.r.resultFile + '.recovery.json').equals(originalState));
    assert.strictEqual(receipt(f).phase, 'failed'); label(`writer-observation-mutation-${name}`);
  }
  const schema = nativeFixture(), originalInvoke = schema.runtime.invokeNative;
  schema.runtime.invokeNative = async args => ({ ...await originalInvoke(args), artifacts: [] });
  await refuse(schema, schema.runtime, /native-execution-result-invalid/, 1); label('strict-result-schema');
  // Direct primitive exercise: telemetry callback mutates caps before the real invocation.
  const direct = nativeFixture(); let directCalls = 0;
  const nativeResult = await native.invokeNative({ hostRuntime: 'codex', resolvedDispatch: direct.r.route, activeCapabilities: direct.caps,
    agentType: 'forge-executor', taskName: 'direct_test', forkTurns: 'none', prompt: 'fixture',
    onPackagedContext: () => { direct.caps.models = []; } }, () => { directCalls++; });
  assert.strictEqual(nativeResult.ok, false); assert.strictEqual(nativeResult.provider_called, false); assert.strictEqual(directCalls, 0); label('invokeNative-boundary');
  const cli = nativeFixture(), requestFile = path.join(cli.dir, 'request.json'); write(requestFile, { ...cli.r, activeCapabilities: cli.caps, invokeNative: true });
  const child = cp.spawnSync(process.execPath, [path.join(__dirname, 'forge-unit-sidecar.js'), '--request', requestFile], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.notStrictEqual(child.status, 0); assert(!fs.existsSync(cli.r.resultFile + '.receipt.json')); label('cli-cannot-import-authority');
  const recover = await savedFixture();
  const stateFile = recover.r.resultFile + '.recovery.json', receiptFile = recover.r.resultFile + '.receipt.json';
  const beforeState = fs.readFileSync(stateFile);
  const beforeReceipt = fs.readFileSync(receiptFile), beforePrompt = fs.readFileSync(recover.r.nativePromptFile);
  await assert.rejects(() => unit.recoverUnitSidecar(recover.r, { stateFile, receiptFile }, {
    ...recover.savedRuntime, writerObservationAdapter: liveAdapter(() => mutations.prompt(recover)) }), /native-prompt-file-changed/);
  assert(fs.readFileSync(receiptFile).equals(beforeReceipt)); assert(fs.readFileSync(stateFile).equals(beforeState));
  assert.strictEqual(receipt(recover).phase, 'failed'); assert.strictEqual(recover.calls(), 1);
  assert(!fs.existsSync(path.join(recover.task, `${recover.r.taskId}-SUMMARY.md`)));
  label('recoverUnitSidecar-saved-prompt-unchanged-history'); fs.writeFileSync(recover.r.nativePromptFile, beforePrompt);
  const recovered = await unit.recoverUnitSidecar(recover.r, { stateFile, receiptFile }, recover.savedRuntime);
  assert.strictEqual(recovered.action, 'replay'); assert.strictEqual(recover.calls(), 1);
  assert(fs.readFileSync(stateFile).equals(beforeState)); label('recoverUnitSidecar-saved-no-reset');
  const raw = await savedFixture(); let reset = false;
  await assert.rejects(() => recovery.recoverAttempt({ request: raw.r, executionContract: raw.r.execution_contract,
    stateFile: raw.r.resultFile + '.recovery.json', receiptFile: raw.r.resultFile + '.receipt.json', processProbe: () => 'stopped',
    inspectSavedResult: async () => ({ valid_saved_response: true }), reconcile: () => { reset = true; } }), /writer-observation-handle-invalid/);
  assert.strictEqual(reset, false); label('recoverAttempt-opaque-handle');
  const local = await savedFixture();
  const writer = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  try {
    await refuse(local, { ...local.savedRuntime, processProbe: () => { try { process.kill(writer.pid, 0); return 'running'; } catch { return 'stopped'; } } }, /writer-observation-not-stopped/, 1);
  } finally { const ended = once(writer, 'exit'); writer.kill(); await ended; }
  const hostRecord = { handle: writer, dispatch: local.r.dispatchId, fingerprint: receipt(local).fingerprint };
  const retainedAdapter = handle => transition.createWriterObservationAdapter(async challenge => {
    if (handle !== hostRecord.handle || challenge.dispatch_id !== hostRecord.dispatch || challenge.fingerprint !== hostRecord.fingerprint) {
      throw Object.assign(new Error('writer-foreign-host-handle'), { code: 'writer-foreign-host-handle', provider_called: false });
    }
    return { ...challenge, status: handle.exitCode !== null || handle.signalCode !== null ? 'stopped' : 'running',
      writer_identity: `child:${handle.pid}:${hostRecord.dispatch}`, binding_sha256: roots.digest(challenge), evidence_reference: 'fixture:retained-child-handle' };
  });
  await refuse(local, { ...local.savedRuntime, writerObservationAdapter: retainedAdapter({ pid: writer.pid }) }, /writer-foreign-host-handle/, 1);
  label('local-process-foreign-handle');
  const resumed = { ...local.savedRuntime, writerObservationAdapter: retainedAdapter(writer), processProbe: () => { try { process.kill(writer.pid, 0); return 'running'; } catch { return 'stopped'; } } };
  assert.strictEqual((await unit.runUnitSidecar(local.r, resumed)).status, 'done'); label('local-process-running-exited-restart');
  }
  if (!process.argv.some(arg => ['--saved', '--recovery'].includes(arg))) await extraCases();
  if (!process.argv.some(arg => ['--saved', '--extra'].includes(arg))) await recoveryCases();
  label('PASS: synthetic provider; real local process/filesystem; provider real and human UAT not exercised');
}
async function extraCases() {
  await reviewVerificationCases();
  await reviewOwnerSnapshotCases();
  for (const [name, mutate] of Object.entries({
    'missing-plan-gate': f => { fs.unlinkSync(f.r.planFile.replace('-PLAN.md', '-PLAN-GATE.md')); },
    'missing-security-gate': f => { f.r.gates.security = undefined; },
    'empty-claim': f => { f.r.claim.paths = []; },
    'incompatible-host': f => { f.r.route.host_runtime = 'foreign'; },
    'incompatible-tool': f => { f.caps.tool = 'foreign'; },
    'prompt-owner-target': f => { f.r.nativePromptFile = path.join(f.owner, 'prompt.txt'); },
    'prompt-code-target': f => { f.r.nativePromptFile = path.join(f.cwd, 'prompt.txt'); },
  })) {
    const f = nativeFixture(); mutate(f); await refuse(f, f.runtime); label(name);
  }
  const failing = nativeFixture({ verify: 'node -e "process.exit(7)"' });
  await refuse(failing, failing.runtime, /execution-verification-failed/, 1);
  assert.strictEqual(receipt(failing).phase, 'executed'); label('plan-priority-failure');
  await refuse(failing, { ...failing.runtime, verification: { preferenceCommands: ['node --version'] } }, /verification-/, 1); label('executed-policy-change');
  await refuse(failing, failing.runtime, /execution-verification-failed/, 1); label('executed-replay-original-failure');
  const executedReceipt = fs.readFileSync(failing.r.resultFile + '.receipt.json'), executedState = fs.readFileSync(failing.r.resultFile + '.recovery.json');
  const executedPrompt = fs.readFileSync(failing.r.nativePromptFile);
  await refuse(failing, { ...failing.runtime, announce: () => mutations.prompt(failing) }, /native-prompt-file-changed/, 1);
  assert(fs.readFileSync(failing.r.resultFile + '.receipt.json').equals(executedReceipt));
  assert(fs.readFileSync(failing.r.resultFile + '.recovery.json').equals(executedState));
  assert.strictEqual(receipt(failing).phase, 'executed'); label('executed-replay-prompt-unchanged-history');
  fs.writeFileSync(failing.r.nativePromptFile, executedPrompt);
  const record = receipt(failing); delete record.verification_seal; write(failing.r.resultFile + '.receipt.json', record);
  await refuse(failing, failing.runtime, /verification-provenance-insufficient/, 1); label('legacy-without-capture-refused');
  const replay = nativeFixture(); await unit.runUnitSidecar(replay.r, replay.runtime);
  for (const [name, mutate, file] of [
    ['prompt', () => mutations.prompt(replay), replay.r.nativePromptFile],
    ['input', () => fs.appendFileSync(replay.r.planFile, 'changed'), replay.r.planFile],
    ['baseline-bytes', () => fs.appendFileSync(replay.r.resultFile + '.reset-state.json', ' '), replay.r.resultFile + '.reset-state.json'],
    ['baseline', () => { const f = replay.r.resultFile + '.reset-state.json', r = JSON.parse(fs.readFileSync(f)); r.attempt = 'foreign'; write(f, r); }, replay.r.resultFile + '.reset-state.json'],
    ['code', () => fs.appendFileSync(path.join(replay.cwd, 'src.js'), 'changed'), path.join(replay.cwd, 'src.js')],
    ['code-metadata', () => write(path.join(replay.cwd, '.gsd/foreign'), 'changed'), null],
  ]) {
    const before = file && fs.readFileSync(file);
    const beforeReceipt = fs.readFileSync(replay.r.resultFile + '.receipt.json');
    await assert.rejects(() => unit.runUnitSidecar(replay.r, { ...replay.runtime, announce: mutate }));
    if (name === 'prompt') assert(fs.readFileSync(replay.r.resultFile + '.receipt.json').equals(beforeReceipt));
    if (file) fs.writeFileSync(file, before); else fs.rmSync(path.join(replay.cwd, '.gsd'), { recursive: true });
    assert.strictEqual(replay.calls(), 1); label('ready-replay-mutation-' + name);
  }
  const generation = replay.r.claim.generation;
  await assert.rejects(() => unit.runUnitSidecar(replay.r, { ...replay.runtime, announce: () => { replay.r.claim.generation = 'changed'; } }));
  replay.r.claim.generation = generation; label('ready-replay-mutation-claim');
  const strictReplay = receipt(replay);
  write(replay.r.resultFile + '.receipt.json', { ...strictReplay, result: { ...strictReplay.result, extra: true } });
  await assert.rejects(() => unit.runUnitSidecar(replay.r, replay.runtime), /native-execution-result-invalid/);
  write(replay.r.resultFile + '.receipt.json', strictReplay); label('ready-replay-strict-schema');
  const legacy = receipt(replay); delete legacy.verification_seal; write(replay.r.resultFile + '.receipt.json', legacy);
  assert.strictEqual((await unit.runUnitSidecar(replay.r, replay.runtime)).status, 'done');
  assert.strictEqual(receipt(replay).verification_seal, undefined); label('legacy-complete-capture-preserved');
  await assert.rejects(() => unit.runUnitSidecar(replay.r, { ...replay.runtime, verification: replay.r.verification }), /verification-provenance-insufficient/); label('legacy-runtime-override-refused');
  for (const [name, change] of Object.entries({
    'invalid-status': value => ({ ...value, status: 'ready' }),
    'missing-delta': value => ({ ...value, files_changed: [] }),
    'undeclared-write': (value, f) => { write(path.join(f.cwd, 'outside.js'), 'unexpected'); return value; },
    'malformed-readback': () => null,
  })) {
    const f = nativeFixture(), invoke = f.runtime.invokeNative;
    if (name === 'malformed-readback') f.runtime.readback = async () => { f.metrics.readback_calls++; return 42; };
    else f.runtime.invokeNative = async (...args) => change(await invoke(...args), f);
    await refuse(f, f.runtime, null, 1); label(name);
  }
  const modifies = nativeFixture({ verify: `node -e "require('fs').appendFileSync('src.js','changed')"` });
  await refuse(modifies, modifies.runtime, /replay|delta|changed/, 1); label('verification-cannot-change-declared-bytes');
  const unknown = nativeFixture();
  const unobserved = await native.invokeNative({ hostRuntime: 'codex', resolvedDispatch: unknown.r.route, activeCapabilities: unknown.caps, agentType: 'forge-executor', taskName: 'unknown_model', forkTurns: 'none', prompt: 'fixture', readback: async () => ({ model: 'gpt-6.1-sol' }) }, async () => unknown.result());
  assert.strictEqual(unobserved.telemetry.model_observed, null); label('readback-without-source-unknown', { direct_tool_calls: 1, readback_calls: 1, model_observed: null });
  const discovery = nativeFixture(); write(path.join(discovery.cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node --version' } }));
  const discovered = verify.normalizeExecutionVerification(discovery.r.execution_contract, fs.readFileSync(discovery.r.planFile, 'utf8'), {});
  assert(discovered.roots[0].commands.length); assert(discovered.roots[0].origins.every(x => x === 'package-json')); label('discovery-canonical');
  const rootPriority = verify.normalizeExecutionVerification(discovery.r.execution_contract, fs.readFileSync(discovery.r.planFile, 'utf8'), { preferenceCommands: ['node -e "process.exit(9)"'], commandsByRoot: { app: ['  node --version  '] } });
  assert.deepStrictEqual(rootPriority.roots[0].commands, ['node --version']); assert.deepStrictEqual(rootPriority.roots[0].origins, ['root-preference']);
  assert.deepStrictEqual(rootPriority.roots[0].configuration_sources, ['request.commandsByRoot']); label('root-preference-priority');
  const asynchronous = nativeFixture(); let calls = 0;
  const refused = await native.invokeNative({ hostRuntime: 'codex', resolvedDispatch: asynchronous.r.route, activeCapabilities: asynchronous.caps,
    agentType: 'forge-executor', taskName: 'async_guard', forkTurns: 'none', prompt: 'fixture',
    assertInvocation: async stage => { if (stage === 'before-invoke') { await Promise.resolve(); asynchronous.caps.models = []; } } }, () => { calls++; });
  assert.strictEqual(refused.ok, false); assert.strictEqual(calls, 0); label('async-guard-binding-rechecked');
  for (const [name, change] of Object.entries({
    'foreign-dispatch': f => { f.savedRuntime.savedNativeResult.dispatchId = 'foreign'; },
    'foreign-fingerprint': f => { f.savedRuntime.savedNativeResult.fingerprint = 'foreign'; },
    'foreign-hash': f => { f.savedRuntime.savedNativeResult.sha256 = '0'.repeat(64); },
    'saved-schema': f => { write(f.mailbox, { ...f.result(), extra: true }); f.savedRuntime.savedNativeResult.sha256 = roots.digest(fs.readFileSync(f.mailbox)); },
    'receipt-during-observation': f => { f.savedRuntime.writerObservationAdapter = liveAdapter(() => fs.appendFileSync(f.r.resultFile + '.receipt.json', ' ')); },
    'mailbox-replaced-during-observation': f => { f.savedRuntime.writerObservationAdapter = liveAdapter(() => { const bytes = fs.readFileSync(f.mailbox); fs.renameSync(f.mailbox, f.mailbox + '.old'); write(f.mailbox, bytes.toString('utf8')); }); },
  })) {
    const f = await savedFixture(); change(f); await refuse(f, f.savedRuntime, null, 1); label(name);
  }
}
async function reviewReadinessCases() {
  for (const phase of ['failed', 'started']) for (const fault of ['running', 'unknown', 'mutation']) {
    const f = await savedFixture(phase);
    const receiptFile = f.r.resultFile + '.receipt.json', stateFile = f.r.resultFile + '.recovery.json';
    const beforeReceipt = fs.readFileSync(receiptFile), beforeState = fs.readFileSync(stateFile);
    let observations = 0;
    const adapter = transition.createWriterObservationAdapter(async challenge => {
      observations++;
      if (observations === 3 && fault === 'mutation') mutations.prompt(f);
      return { ...challenge, status: observations === 3 && fault !== 'mutation' ? fault : 'stopped',
        writer_identity: `local:${challenge.dispatch_id}`, binding_sha256: roots.digest(challenge),
        evidence_reference: 'fixture:final-live-observation' };
    });
    await refuse(f, { ...f.savedRuntime, writerObservationAdapter: adapter }, /writer-observation-unproved|native-prompt-file-changed/, 1);
    assert.strictEqual(observations, 3);
    assert(fs.readFileSync(receiptFile).equals(beforeReceipt), 'rejected final observation must preserve original receipt bytes');
    assert(fs.readFileSync(stateFile).equals(beforeState), 'rejected final observation must preserve recovery bytes');
    await assert.rejects(() => unit.runUnitSidecar(f.r, { ...f.runtime, invokeNative: () => { throw new Error('rejected saved response must not infer'); } }));
    assert(fs.readFileSync(receiptFile).equals(beforeReceipt));
    assert(fs.readFileSync(stateFile).equals(beforeState));
    assert(!fs.existsSync(path.join(f.task, `${f.r.taskId}-SUMMARY.md`)));
    assert.strictEqual(f.calls(), 1); label(`saved-${phase}-final-observation-${fault}-replay-refused`);
  }
}
async function reviewVerificationCases() {
  const required = 'node -e "process.exit(7)"', passing = 'node -e "process.exit(0)"';
  for (const rootSpecific of [false, true]) {
    const f = nativeFixture();
    f.r.verification = rootSpecific ? { commandsByRoot: { app: [required] } } : { preferenceCommands: [required] };
    await refuse(f, { ...f.runtime, verification: { commandsByRoot: { app: [passing] } } }, /verification-command-replacement/);
    label(`runtime-root-cannot-replace-request-${rootSpecific ? 'root' : 'general'}`);
    const policy = verify.normalizeExecutionVerification(f.r.execution_contract, fs.readFileSync(f.r.planFile, 'utf8'),
      f.r.verification, { commandsByRoot: { app: [required, passing] }, commandTimeoutMs: 12000 });
    assert.deepStrictEqual(policy.roots[0].commands, [required, passing]);
    assert.deepStrictEqual(policy.roots[0].origins, [rootSpecific ? 'root-preference' : 'preference', 'root-preference']);
    assert.deepStrictEqual(policy.roots[0].configuration_sources, [rootSpecific ? 'request.commandsByRoot' : 'request.preferenceCommands', 'runtime.commandsByRoot']);
    assert.strictEqual(policy.command_timeout_ms, 12000);
    assert.strictEqual(policy.timeout_origin, 'runtime');
    lastEvidence = { verification_policy_sha256: policy.sha256 }; label(`runtime-root-additive-request-${rootSpecific ? 'root' : 'general'}`);
    await refuse(f, { ...f.runtime, verification: { commandsByRoot: { app: [required, passing] }, commandTimeoutMs: 12000 } }, /execution-verification-failed/, 1);
    assert.deepStrictEqual(receipt(f).verification_seal.roots[0].commands, [required, passing]);
    verify.assertExecutionVerification(receipt(f).verification_seal, f.r.execution_contract,
      fs.readFileSync(f.r.planFile, 'utf8'), receipt(f).verification_seal.identity);
    assert.strictEqual(receipt(f).phase, 'executed'); label(`runtime-root-keeps-failing-request-${rootSpecific ? 'root' : 'general'}`);
  }
}
async function reviewOwnerSnapshotCases() {
  const execution = require('./forge-task-execution');
  for (const sameOwner of [false, true]) {
    for (const kind of ['owned', 'changed', 'added', 'removed', 'external-event', 'external-metadata', 'input', 'code-metadata']) {
      const f = nativeFixture();
      if (sameOwner) {
        write(path.join(f.owner, 'src.js'), 'before\n');
        harness.git(f.owner, ['init', '-q']);
        harness.git(f.owner, ['config', 'core.autocrlf', 'false']);
        harness.git(f.owner, ['add', 'src.js']);
        harness.git(f.owner, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']);
        const contract = roots.validateContract({ schema_version: 2, owner: f.owner, primary_root_id: 'app', code_roots: [{ id: 'app', path: f.owner }] });
        write(f.r.planFile, fs.readFileSync(f.r.planFile, 'utf8').replaceAll(f.cwd.replace(/\\/g, '/'), f.owner.replace(/\\/g, '/')));
        f.r.cwd = f.owner; f.r.execution_contract = contract; f.r.claim.execution_contract = contract;
        require('./forge-runs').update(f.owner, f.r.runId, { write_claim: f.r.claim });
      }
      await assert.rejects(() => unit.runUnitSidecar(f.r, { activeCapabilities: f.caps,
        invokeNative() { throw Object.assign(new Error('fixture failure before code writes'), { code: 'fixture-failure' }); } }), /fixture-failure/);
      const file = f.r.resultFile + '.receipt.json', bytes = fs.readFileSync(file), row = receipt(f);
      const stateBytes = fs.readFileSync(row.recovery_baseline.state_file);
      const recoveryFile = f.r.resultFile + '.recovery.json', recoveryBytes = fs.readFileSync(recoveryFile);
      const original = JSON.stringify(row);
      assert.notStrictEqual(row.execution.protected_owner['.gsd/forge/events.jsonl'], row.recovery_baseline.protected_owner['.gsd/forge/events.jsonl']);
      const metadata = path.join(f.owner, '.gsd/CODING-STANDARDS.md');
      if (kind === 'changed') fs.appendFileSync(metadata, 'changed');
      if (kind === 'added' || kind === 'external-metadata') write(path.join(f.owner, '.gsd/external.txt'), 'external');
      if (kind === 'removed') fs.unlinkSync(metadata);
      if (['changed', 'added', 'removed'].includes(kind)) row.execution.protected_owner = execution.protectedSnapshot(f.owner);
      if (kind === 'external-event') fs.appendFileSync(path.join(f.owner, '.gsd/forge/events.jsonl'), '{}\n');
      if (kind === 'input') fs.appendFileSync(f.r.planFile, '\nchanged');
      if (kind === 'code-metadata') write(path.join(f.r.cwd, '.gsd/external-code.txt'), 'external');
      let ownershipChecks = 0;
      const reconcile = () => unit.reconcileMilestoneAttempt(f.r, row, { verifyOwnership: () => { ownershipChecks++; return false; } });
      if (kind === 'owned') {
        assert.strictEqual(reconcile().ok, true);
        const { reconciliation, ...baseline } = JSON.parse(fs.readFileSync(row.recovery_baseline.state_file));
        assert.strictEqual(reconciliation.ok, true);
        assert.deepStrictEqual(baseline, JSON.parse(stateBytes));
      }
      else assert.throws(reconcile, ['changed', 'added', 'removed'].includes(kind) ? /recovery-owner-snapshot-mismatch/
        : kind === 'input' ? /recovery-baseline-input-changed/ : /execution-protected-metadata/);
      assert.strictEqual(ownershipChecks, 0);
      assert(fs.readFileSync(file).equals(bytes));
      if (kind !== 'owned') assert(fs.readFileSync(row.recovery_baseline.state_file).equals(stateBytes));
      assert(fs.readFileSync(recoveryFile).equals(recoveryBytes));
      if (!['changed', 'added', 'removed'].includes(kind)) assert.strictEqual(JSON.stringify(row), original);
      label(`reconcile-owner-snapshot-${sameOwner ? 'same-root' : 'separate-root'}-${kind}`, { receipt_unchanged: true, baseline_unchanged: true, recovery_clock_unchanged: true });
    }
  }
}
async function recoveryCases() {
  for (const stage of ['onPackagedContext', 'announce', 'invoke', 'readback']) {
  for (const mutation of ['valid', 'claim', 'caps', 'prompt', 'gates', 'model', 'effort', 'roots', 'inputs', 'baseline', 'metadata', 'process']) {
    if (mutation === 'valid' && stage !== 'onPackagedContext') continue;
    const f = nativeFixture({ models: ['gpt-6-sol', 'gpt-6.1-sol'] }), invoke = f.runtime.invokeNative;
    f.runtime.invokeNative = async (...args) => { await invoke(...args); throw Object.assign(new Error('fixture service unavailable'), { code: 'model-unavailable', provider_called: true }); };
    await assert.rejects(() => unit.runUnitSidecar(f.r, f.runtime), /model-unavailable/);
    const originalReceipt = fs.readFileSync(f.r.resultFile + '.receipt.json');
    const stateFile = f.r.resultFile + '.recovery.json'; const original = JSON.parse(fs.readFileSync(stateFile));
    let calls = 0, resetCalls = 0, stopped = true, nextRequest;
    let mutated = false;
    const mutate = () => {
        if (mutated) return; mutated = true;
        if (mutation === 'valid') return;
        if (mutation === 'process') { stopped = false; return; }
        // Packaging occurs after the new attempt's receipt is persisted.
        const files = fs.readdirSync(f.dir).filter(name => name.includes('.recovery-') && name.endsWith('.json.receipt.json'));
        const file = path.join(f.dir, files[0]); const row = JSON.parse(fs.readFileSync(file));
        if (mutation === 'baseline') fs.appendFileSync(row.recovery_baseline.state_file, 'changed');
        else if (mutation === 'prompt') { const prompt = file.replace(/\.receipt\.json$/, '.prompt.txt'); fs.appendFileSync(prompt, 'changed'); }
        else mutations[mutation](f);
    };
    const runtime = { activeCapabilities: f.caps, processProbe: () => stopped ? 'stopped' : 'running',
      verifyOwnership: () => { resetCalls++; f.metrics.reconciliation_calls++; return true; },
      ...(stage === 'onPackagedContext' || stage === 'announce' ? { [stage]: async () => { await Promise.resolve(); mutate(); } } : {}),
      readback: async () => { f.metrics.readback_calls++; await Promise.resolve(); if (stage === 'readback') mutate(); return {}; },
      invokeNative: async (next, binding) => {
        calls++; nextRequest = next;
        assert.strictEqual(binding.args.model, 'gpt-6.1-sol'); assert.strictEqual(binding.args.reasoning_effort, 'high');
        const row = JSON.parse(fs.readFileSync(next.resultFile + '.receipt.json'));
        assert.strictEqual(row.phase, 'started'); assert(row.recovery_baseline);
        assert(fs.readFileSync(next.nativePromptFile, 'utf8').includes('<!-- forge-procedure:recovery -->'));
        write(path.join(f.cwd, 'src.js'), 'recovered write\n'); await Promise.resolve(); if (stage === 'invoke') mutate(); return f.result();
      } };
    const run = () => unit.recoverUnitSidecar(f.r, { stateFile, receiptFile: f.r.resultFile + '.receipt.json', clock: () => original.started_at + 1 }, runtime);
    if (mutation === 'valid') { const result = await run(); assert.strictEqual(result.action, 'invoke', JSON.stringify({ action: result.action, reason: result.reason_code, rejected: result.rejected })); assert.strictEqual(result.result.status, 'done'); assert.strictEqual(calls, 1); assert.strictEqual(JSON.parse(fs.readFileSync(nextRequest.resultFile + '.receipt.json')).phase, 'ready'); }
    else { await assert.rejects(run, error => { lastEvidence = { reason_code: error.code }; return true; }); assert.strictEqual(calls, ['invoke', 'readback'].includes(stage) ? 1 : 0); assert(!fs.existsSync(path.join(f.task, `${f.r.taskId}-SUMMARY.md`))); }
    const now = JSON.parse(fs.readFileSync(stateFile));
    assert.strictEqual(now.started_at, original.started_at); assert.strictEqual(now.deadline_at, original.deadline_at);
    assert(fs.readFileSync(f.r.resultFile + '.receipt.json').equals(originalReceipt));
    label('recoverUnitSidecar-new-native-' + stage + '-' + mutation, { recovered_tool_calls: calls, ownership_checks: resetCalls, started_at: now.started_at, deadline_at: now.deadline_at });
  }
  }
}
let completed = false;
main().then(() => { completed = true; }).catch(e => { console.error(e); process.exitCode = 1; }).finally(() => harness.close(completed));
