'use strict';
const assert = require('assert');
const api = require('./forge-attempt-recovery');
async function main() {
  const linkedFixtures = require('./forge-loop-failure.test'), linkedFixture = linkedFixtures.fixture();
  try {
    const consumed = linkedFixtures.consume(linkedFixture);
    const entered = linkedFixtures.invoke(linkedFixture, 'reenter', consumed.snapshot, linkedFixtures.entryInput(linkedFixture, consumed));
    const linkedRequest = { ...linkedFixture.request, linked_begin_key: entered.controller_result.details.transaction.idempotency_key };
    assert.throws(() => api.requestIdentity({ ...linkedRequest, linkedEntryBinding: {}, approved: true }), /binding|required/);
    const bound = api.bindLinkedRequest(linkedRequest, { ...linkedFixtures.liveOptions(linkedFixture), ownerToken: linkedFixture.input.owner_token });
    assert.strictEqual(api.requestIdentity(bound).linked_entry.entry_id, 'fixture-entry-1');
    assert.throws(() => api.requestIdentity(JSON.parse(JSON.stringify(bound))), /binding|required/);
  } finally { linkedFixtures.cleanup(linkedFixture); }
  let now = 0, saved;
  const identity = { unit: 'execute-task/T-recovery', roots_sha256: 'roots', clock: () => now, persist: state => { saved = state; } };
  const route = { unit_type: 'execute-task', host_runtime: 'codex', resolved_worker_engine: 'claude', worker_mode: 'sidecar',
    model: 'claude-sonnet-5', model_resolved: 'claude-sonnet-5', effort: 'medium', tier: 'standard', dispatch_allowed: true };
  const attempt = { reason_code: 'quota', layer: 'provider', request_sha256: 'request', context_sha256: 'context',
    request_bytes: 100, context_bytes: 100, duration_ms: 10, budgets: { total: 1000 }, route,
    failure_class: 'service', service_failure_proven: true, diagnostic: 'token=secret-value' };
  const inspection = { process_stopped: true, receipt_checked: true, writer_possible: false };
  const chain = [{ id: 'claude-sonnet-5', engine: 'claude' }, { id: 'gpt-incompatible', engine: 'gpt' }, { id: 'gpt-6-astra', engine: 'gpt' }, { id: 'claude-opus-4-8', engine: 'claude' }];
  route.chain = chain;
  const request = { unitType: 'execute-task', scope: 'standalone-task', phase: 'execute', taskId: 'T-recovery',
    cwd: __dirname, contextRoot: __dirname, route };
  identity.request = request;
  const transitions = require('./forge-recovery-transition');
  assert.strictEqual(transitions.destinationKey(route), transitions.destinationKey({ ...route, tier: 'max', effort: 'max', worker_mode: 'native' }),
    'changing tier, effort or transport cannot re-enable the same host/worker/model destination');
  assert.notStrictEqual(transitions.destinationKey(route), transitions.destinationKey({ ...route, model: 'gpt-6-astra', model_resolved: 'gpt-6-astra' }));
  const resolverOptions = { unitType: request.unitType, scope: request.scope, phase: request.phase, unitId: request.taskId,
    cwd: request.cwd, hostRuntime: 'codex' };
  const recovery = api.createRecovery(identity); recovery.record(attempt);
  assert.throws(() => recovery.transition({ approved: true, schema_version: 1, sha256: 'recomputed', types: ['resolver-context-omission'] }), /live-handle/);
  assert.deepStrictEqual(recovery.snapshot().attempts, saved.attempts);
  assert.strictEqual(saved.attempts[0].provider_called, 'unknown');
  assert(!saved.attempts[0].diagnostic.includes('secret-value'));
  const candidateSet = api.resolveCandidates(resolverOptions, () => ({ ...route, chain, source: 'fixture-resolver' }), request);
  const checked = [];
  const next = await recovery.next({ inspection, candidateSet, validateInvocation: async candidate => {
    checked.push(candidate.model); return { ok: candidate.model !== 'gpt-incompatible', reason_code: 'unsupported-model' };
  } });
  assert.strictEqual(next.route.model, 'gpt-6-astra');
  assert.deepStrictEqual(checked, ['gpt-incompatible', 'gpt-6-astra']);
  const unapproved = api.resolveCandidates(resolverOptions, () => ({ ...route, chain: [{ id: 'gpt-new-unapproved', engine: 'gpt' }] }), request);
  await assert.rejects(recovery.next({ inspection, candidateSet: unapproved,
    validateInvocation() { throw new Error('unapproved route must never reach adapter'); } }), /candidate-list-changed/);
  assert(next.provenance.sha256); assert.strictEqual(next.rejected.length, 1);
  await assert.rejects(recovery.next({ inspection, candidateSet: {}, candidates: chain, validateInvocation: async () => ({ ok: true }) }), /provenance/);
  await assert.rejects(recovery.next({ inspection: { ...inspection, writer_possible: true }, candidateSet }), /reconciliation/);
  recovery.questions(['Choose root', 'Choose route']); const questions = saved.pending_questions;
  recovery.answer([{ id: questions[0].id, answer: 'alpha' }]);
  assert.strictEqual((await recovery.next({ inspection })).action, 'pending-questions');
  recovery.answer([{ id: questions[1].id, answer: 'native' }]);
  now = 60001;
  const resumed = api.createRecovery({ ...identity, state: saved });
  assert.strictEqual((await resumed.next({ inspection })).reason_code, 'recovery-deadline-exhausted');
  const timeout = api.createRecovery({ ...identity, state: undefined }); timeout.record({ ...attempt, failure_class: 'timeout' });
  assert.strictEqual((await timeout.next({ inspection })).reason_code, 'timeout-cause-indeterminate');
  await assert.rejects(timeout.next({ inspection, correction: { request_sha256: 'request', offline_validated: true, evidence_reference: 'check' } }), /correction-required/);
  await assert.rejects(timeout.next({ inspection, correction: { kind: 'environment', failure_id: 'forged', request_sha256: 'request', offline_validated: true, evidence_reference: 'check' } }), /correction-required/);
  const corrected = await timeout.next({ inspection, correction: { request_sha256: 'new', offline_validated: true, evidence_reference: 'check' }, validateInvocation: async () => ({ ok: true }) });
  assert.strictEqual(corrected.route.model, route.model);
  timeout.record({ ...attempt, failure_class: 'timeout', corrected: true });
  await assert.rejects(timeout.next({ inspection, correction: { request_sha256: 'newer', offline_validated: true, evidence_reference: 'check' } }), /retry-exhausted/);
  assert.throws(() => api.exceptionFor({ approved: true }, identity, now), /exception-invalid/);
  const authority = api.createAuthority(reference => ({ reference, status: 'resolved', answer: 'authorize', resolved_at: new Date().toISOString() }));
  const handle = authority.issue('live-answer', { unit: identity.unit, roots_sha256: identity.roots_sha256, purpose: 'sidecar-recovery',
    expires_at: now + 1000, routes: [api.routeKey(next.route)], gates_preserved: true }, () => now);
  assert.strictEqual(api.exceptionFor(handle, { ...identity, purpose: 'sidecar-recovery' }, now).reference, 'live-answer');
  for (const foreign of [{ ...identity, unit: 'other' }, { ...identity, roots_sha256: 'other' }, { ...identity, purpose: 'other' }]) {
    assert.throws(() => api.exceptionFor(handle, foreign, now), /exception-invalid/);
  }
  assert.throws(() => api.exceptionFor(handle, { ...identity, purpose: 'sidecar-recovery' }, now + 1001), /exception-invalid/);
  assert.throws(() => authority.issue('live-answer', { unit: identity.unit, roots_sha256: 'roots', routes: ['route'],
    purpose: 'sidecar-recovery', expires_at: now + 100, gates_preserved: false }, () => now), /not-authorized/);
  await silenceRecovery(identity, route, attempt, inspection, candidateSet);
  await persistentRecovery(route);
  await canonicalProvenance();
  console.log('PASS recovery clock, canonical candidate provenance/order, adapters, caller repair, pending IDs and live exception');
}
async function silenceRecovery(identity, route, attempt, inspection, candidateSet) {
  let now = 0, saved;
  const options = { ...identity, state: undefined, clock: () => now, persist: value => { saved = value; } };
  const silence = { dimension: 'initial', window_ms: 120001, threshold_ms: 120000,
    policy: 'claude-silence-v1', source: 'persisted-calibration', cause: 'indeterminate' };
  const session = api.createRecovery(options);
  session.record({ ...attempt, failure_class: 'silence', service_failure_proven: false, observation: { silence } });
  const authority = api.createAuthority(reference => ({ reference, status: 'resolved', answer: 'authorize', resolved_at: 'fixture' }));
  const alternate = { ...route, model: 'gpt-6-astra', model_resolved: 'gpt-6-astra',
    resolved_worker_engine: 'codex', worker_mode: 'native' };
  const exception = authority.issue('fixture:silence', { unit: identity.unit, roots_sha256: identity.roots_sha256,
    purpose: 'sidecar-recovery', expires_at: 120000, routes: [api.routeKey(route), api.routeKey(alternate)], gates_preserved: true }, () => now);
  const input = { inspection, exception, candidateSet, validateInvocation: async () => ({ ok: true }) };
  now = 1000;
  const retry = await session.next(input);
  assert.equal(retry.route.model, route.model); assert.equal(retry.silence_retry, true);
  assert.equal(retry.remaining_ms, 30000);
  session.reserve(retry, attempt.request_sha256);
  const restart = api.createRecovery({ ...options, state: saved });
  const pending = await restart.next({ ...input, validateInvocation() { throw Error('pending retry cannot validate another writer'); } });
  assert.equal(pending.reason_code, 'recovery-reservation-pending');
  assert.equal(restart.snapshot().reservations.length, 1);
  assert.equal(restart.snapshot().reservations[0].request_sha256, attempt.request_sha256);
  restart.record({ ...attempt, failure_class: 'silence', service_failure_proven: false, observation: { silence } });
  const following = await restart.next(input);
  assert.equal(following.route.model, 'gpt-6-astra', 'only one unchanged same-target retry is available');
  assert.equal(following.silence_retry, false);
  now = 59000; const expired = api.createRecovery({ ...options, state: saved });
  expired.snapshot(); now = 100;
  assert.equal(expired.remaining(), 1000, 'clock rollback cannot renew historical recovery time');
  const late = api.createRecovery({ ...options, state: undefined, clock: () => 0 });
  late.record({ ...attempt, failure_class: 'silence', observation: { silence } });
  const almostSpent = api.createRecovery({ ...options, state: late.snapshot(), clock: () => 55000 });
  assert.equal((await almostSpent.next(input)).reason_code, 'recovery-deadline-exhausted');
  console.log('PASS anomalous silence: trusted threshold, one durable same-target reservation, restart exclusion, fallback and nonrenewing clock');
}
async function persistentRecovery(route) {
  const fs = require('fs'), path = require('path'), stateApi = require('./forge-xllm-state');
  const lab = require('./forge-code-roots.test').laboratory('recovery-state');
  const cwd = path.join(lab.dir, 'code'); fs.mkdirSync(cwd);
  const request = { cwd, contextRoot: cwd, scope: 'milestone', phase: 'research', unitType: 'research-milestone',
    milestoneId: 'M001', route: { ...route, unit_type: 'research-milestone' }, prompt: 'before', resultFile: path.join(lab.dir, 'result.json') };
  const stateFile = path.join(lab.dir, 'state.json'), receiptFile = path.join(lab.dir, 'receipt.json');
  fs.writeFileSync(receiptFile, JSON.stringify({ phase: 'failed', recovery_identity_sha256: require('./forge-code-roots').digest(api.requestIdentity(request)), failure: { provider_called: false } }));
  const initial = api.captureFailure({ stateFile, receiptFile, request, unit: 'research-milestone/M001', route,
    finalEvidence: require('./forge-attempt-telemetry').captureFinal({ request: { argv: ['--model', route.model] }, context: request.prompt }),
    error: { code: 'context-budget-exceeded', provider_called: false, stderr: 'token=secret' }, budgets: { coding_standards: 3000 } });
  assert.strictEqual(initial.attempts[0].failure_class, 'caller');
  assert.strictEqual(initial.attempts[0].model_sent, 'unknown');
  assert(!fs.readFileSync(stateFile, 'utf8').includes('secret'));
  const base = { stateFile, receiptFile, request, clock: () => initial.started_at + 1,
    validateInvocation: async () => ({ ok: true }) };
  await assert.rejects(api.recoverAttempt({ ...base, request: { ...request, taskId: 'foreign' } }), /identity-mismatch/);
  assert.throws(() => api.captureFailure({ stateFile: path.join(cwd, 'state.json'), request, unit: 'x', route }), /result.*(?:root|inside|outside)|inside.*root/i);
  await assert.rejects(api.recoverAttempt({ ...base, correction: { offline_validated: true } }), /offline-validator-required/);
  for (const same of [request, Object.fromEntries(Object.entries(request).reverse())]) {
    await assert.rejects(api.recoverAttempt({ ...base, request: same, correction: true,
      validateCorrection: async () => { throw Error('unchanged input must fail before packaging'); } }), /correction-required/);
  }
  let invoked = 0;
  await assert.rejects(api.recoverAttempt({ ...base, request: { ...request, irrelevant: true }, correction: true,
    validateCorrection: async () => ({ ok: true, final_evidence: initial.attempts[0].final_evidence }) }), /correction-required/);
  const corrected = { ...request, prompt: 'after offline repair' };
  let advancing = initial.started_at + 1;
  const guardException = api.createAuthority(reference => ({ reference, status: 'resolved', answer: 'authorize', resolved_at: 'fixture' }))
    .issue('fixture:guard', { unit: initial.unit, roots_sha256: initial.roots_sha256, purpose: initial.purpose,
      routes: [api.routeKey(request.route)], expires_at: advancing + 120000, gates_preserved: true }, () => advancing);
  await assert.rejects(api.recoverAttempt({ ...base, request: corrected, correction: true,
    validateCorrection: async () => ({ ok: true, evidence_reference: 'fixture:unmeasured' }) }), /final-packaging-required/);
  // A killed short-mutex holder must not permanently strand recovery state.
  // Exercise the real lock in a separate process; no fabricated "dead" PID.
  const locks = require('./forge-lock'), { spawn } = require('child_process');
  const mutexState = path.join(lab.dir, 'mutex-state.json');
  const mutexRoot = path.join(require('os').tmpdir(), 'forge-recovery-' + require('./forge-code-roots').digest(path.resolve(mutexState)));
  fs.mkdirSync(path.join(mutexRoot, '.gsd'), { recursive: true });
  const recoverMutex = () => api.recoverAttempt({ ...base, stateFile: mutexState, request: corrected, correction: true,
    validateCorrection: async () => ({ ok: true, evidence_reference: 'fixture:mutex',
      final_evidence: require('./forge-attempt-telemetry').captureFinal({ request: { prompt: corrected.prompt }, context: corrected.prompt }) }) });
  try {
    for (const expired of [false, true]) {
      fs.writeFileSync(mutexState, JSON.stringify(initial));
      const child = spawn(process.execPath, ['-e', `
        const lock = require(process.argv[1]);
        const handle = lock.tryAcquireSync(process.argv[2], 'state', {
          now: () => Date.now() - (process.argv[3] === 'true' ? 60000 : 0)
        });
        process.send({ token: handle.ownerToken, generation: handle.generation });
        setInterval(() => {}, 1000);
      `, require.resolve('./forge-lock'), mutexRoot, String(expired)], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let old;
      try {
        old = await new Promise((resolve, reject) => {
          child.once('message', resolve); child.once('error', reject);
          child.once('exit', () => reject(Error('lock fixture exited before acquiring')));
        });
        await assert.rejects(recoverMutex(), /recovery-state-busy/, 'live owner stays protected even after TTL');
        assert.equal(locks.status(mutexRoot, 'state').metadata.generation, old.generation);
      } finally {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGKILL'); await exited;
      }
      if (!expired) {
        await assert.rejects(recoverMutex(), /recovery-state-busy/, 'non-expired dead owner remains protected');
        assert.equal(locks.releaseSync(mutexRoot, 'state', old.token, old.generation), true);
      } else {
        const recovered = await recoverMutex();
        assert.equal(recovered.action, 'invoke-native');
        assert.equal(stateApi.loadRecovery(mutexState).reservations.length, 1);
        const successor = locks.tryAcquireSync(mutexRoot, 'state');
        assert(successor);
        assert.notEqual(successor.generation, old.generation);
        assert.equal(locks.releaseSync(mutexRoot, 'state', old.token, old.generation), false);
        assert(locks.assertOwned(successor), 'old release cannot remove successor');
        successor.release();
      }
    }
    console.log('PASS recovery mutex: killed expired owner recovered, active/non-expired owners and successor generation protected');
  } finally { fs.rmSync(mutexRoot, { recursive: true, force: true }); }
  const retried = await api.recoverAttempt({ ...base, request: corrected, correction: true, exception: guardException, clock: () => ++advancing,
    validateCorrection: async () => ({ ok: true, evidence_reference: 'fixture:offline-check',
      final_evidence: require('./forge-attempt-telemetry').captureFinal({ request: { argv: ['--model', route.model, '--prompt', corrected.prompt] }, context: corrected.prompt }) }),
    invoke: async (selected, _invocation, remaining, assertReady) => {
      assertReady(); assertReady();
      invoked++; assert.strictEqual(selected.model, route.model); assert(remaining > 0 && remaining <= 60000); return { status: 'done' };
    } });
  assert.strictEqual(retried.corrected, true); assert.strictEqual(invoked, 1);
  assert.strictEqual(stateApi.loadRecovery(stateFile).reservations.length, 1);
  // Reloaded state retains the reservation even if the host stopped before it
  // could record the next result, and cannot send a second corrected request.
  await assert.rejects(api.recoverAttempt({ ...base, request: { ...request, prompt: 'second repair' }, correction: true,
    validateCorrection: async () => ({ ok: true, evidence_reference: 'fixture:offline-check',
      final_evidence: require('./forge-attempt-telemetry').captureFinal({ request: { repaired: 2 }, context: 'second repair' }) }),
    invoke() { throw Error('restart must not open a second writer'); } }), /retry-exhausted/);
  assert.strictEqual(stateApi.loadRecovery(stateFile).reservations.length, 1);
  assert.strictEqual(invoked, 1);
  const child = require('child_process').spawnSync(process.execPath,
    [path.join(__dirname, 'forge-attempt-recovery.js'), '--inspect', stateFile, receiptFile], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(child.status, 0, child.stderr);
  const inspected = JSON.parse(child.stdout);
  assert.strictEqual(inspected.state.deadline_at, initial.deadline_at);
  assert.strictEqual(inspected.state.reservations.length, 1);
  assert.strictEqual((await api.recoverAttempt({ ...base, clock: () => initial.deadline_at + 1 })).reason_code, 'recovery-deadline-exhausted');
  const raceState = path.join(lab.dir, 'racing-state.json');
  const readFile = fs.readFileSync;
  const concurrentState = { ...initial, phase: 'concurrent-reservation', reservations: [{ id: 'other-writer' }] };
  fs.writeFileSync(raceState, JSON.stringify(initial));
  let injected = false;
  fs.readFileSync = (file, ...args) => {
    const bytes = readFile(file, ...args);
    if (file === raceState && !injected) {
      injected = true; fs.writeFileSync(raceState, JSON.stringify(concurrentState));
    }
    return bytes;
  };
  try {
    await assert.rejects(api.recoverAttempt({ ...base, stateFile: raceState, request: corrected, correction: true,
      validateCorrection: async () => ({ ok: true, evidence_reference: 'fixture:race',
        final_evidence: require('./forge-attempt-telemetry').captureFinal({ request: { prompt: corrected.prompt }, context: corrected.prompt }) }) }), /state-raced/);
    assert.equal(JSON.parse(readFile(raceState)).phase, 'concurrent-reservation');
  } finally { fs.readFileSync = readFile; }
  fs.writeFileSync(raceState, JSON.stringify(initial));
  let raceWriters = 0;
  const racing = () => api.recoverAttempt({ ...base, stateFile: raceState, request: corrected, correction: true,
    validateCorrection: async () => {
      await new Promise(resolve => setImmediate(resolve));
      return { ok: true, evidence_reference: 'fixture:offline-check',
        final_evidence: require('./forge-attempt-telemetry').captureFinal({ request: { argv: ['--prompt', corrected.prompt] }, context: corrected.prompt }) };
    }, invoke: async () => { raceWriters++; return { status: 'done' }; } });
  const raced = await Promise.allSettled([racing(), racing()]);
  assert.equal(raceWriters, 1, 'concurrent callbacks cannot reserve two writers');
  assert.equal(stateApi.loadRecovery(raceState).reservations.length, 1);
  assert.equal(raced.filter(row => row.status === 'rejected' && /state-raced|state-busy/.test(row.reason.code)).length, 1);
  fs.writeFileSync(receiptFile, JSON.stringify({ phase: 'failed', pid: process.pid, execution: {} }));
  assert.strictEqual(api.inspectReceipt(receiptFile, { processProbe: () => 'stopped' }).process_stopped, false,
    'a callback cannot override an observed live adapter PID');
  let reconciled = 0;
  await assert.rejects(api.recoverAttempt({ ...base, reconcile() { reconciled++; } }), /process-receipt-inspection-required/);
  assert.strictEqual(reconciled, 0, 'a live writer must block before reset');
  fs.writeFileSync(receiptFile, JSON.stringify({ phase: 'failed' }));
  await assert.rejects(api.recoverAttempt(base), /process-receipt-inspection-required/);
  fs.writeFileSync(receiptFile, JSON.stringify({ phase: 'ready', provider_called: true }));
  const replay = await api.recoverAttempt({ ...base, clock: () => initial.deadline_at + 1, processProbe: () => 'stopped',
    resolveDispatch() { throw new Error('saved response must not resolve candidates'); }, replay: async () => ({ status: 'done' }) });
  assert.strictEqual(replay.action, 'replay'); assert.strictEqual(replay.provider_called, false); assert.strictEqual(invoked, 1);
  for (const receipt of [{ phase: 'ready', provider_called: true }, { phase: 'failed', saved_candidate: { sha256: 'fixture-candidate' } }]) {
    fs.writeFileSync(receiptFile, JSON.stringify(receipt));
    const saved = await api.recoverAttempt({ ...base, environmentalCorrection: true,
      processProbe: () => 'stopped', clock: () => initial.deadline_at + 1,
      inspectPreSpawn() { throw Error('saved response must replay before pre-spawn inspection'); },
      resolveDispatch() { throw Error('saved response must not resolve candidates'); },
      replay: async observed => { assert.deepStrictEqual(observed, receipt); return { status: 'done' }; } });
    assert.strictEqual(saved.action, 'replay'); assert.strictEqual(saved.provider_called, false);
  }
  assert.throws(() => api.validateState({ ...initial, deadline_at: initial.deadline_at + 1 }), /state-invalid/);
  lab.cleanup();
  console.log('PASS persisted recovery: caller repair once, process proof, restart/CLI deadline, identity, external state and zero-inference replay');
}
async function canonicalProvenance() {
  const fs = require('fs'), path = require('path'), os = require('os');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-recovery-resolver-')));
  const savedEnv = Object.fromEntries(['HOME', 'USERPROFILE', 'FORGE_HOME'].map(key => [key, process.env[key]]));
  try {
    for (const key of Object.keys(savedEnv)) process.env[key] = root;
    fs.mkdirSync(path.join(root, '.gsd'));
    const worktree = path.join(root, 'worktree');
    fs.mkdirSync(path.join(worktree, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(worktree, '.gsd', 'forge-prefs.jsonc'), JSON.stringify({ tier_models: { standard: ['gpt-6-sol'] } }));
    fs.writeFileSync(path.join(root, '.gsd', 'forge-prefs.jsonc'), JSON.stringify({ tier_models: {
      standard: ['claude-sonnet-5', 'gpt-6-astra', 'claude-opus-4-8'] } }));
    const resolverOptions = { cwd: root, unitType: 'research-slice', unitId: 'S01', milestoneId: 'M001',
      scope: 'milestone', phase: 'research', hostRuntime: 'codex' };
    const resolver = require('./forge-dispatch-resolve').resolveDispatch;
    const route = resolver(resolverOptions);
    assert.strictEqual(route.unit_type, undefined, 'real resolver omits unit_type: do not hide this with a stub');
    const request = { cwd: worktree, contextRoot: root, route, unitType: 'research-slice', scope: 'milestone',
      phase: 'research', milestoneId: 'M001', sliceId: 'S01' };
    assert.throws(() => api.requestIdentity({ ...request, route: { ...route, host_runtime: undefined } }),
      /recovery-request-identity-required/);
    const privateIdentity = api.requestIdentity(request);
    assert.strictEqual(privateIdentity.owner, process.platform === 'win32' ? fs.realpathSync(root).toLowerCase() : fs.realpathSync(root));
    assert.strictEqual(privateIdentity.cwd, process.platform === 'win32' ? fs.realpathSync(worktree).toLowerCase() : fs.realpathSync(worktree));
    const identity = { unit: 'research-slice/S01', roots_sha256: 'roots', request, clock: () => 0 };
    const candidates = api.resolveCandidates(resolverOptions, resolver, request);
    assert.strictEqual(route.chain[0].id, 'claude-sonnet-5', 'owner preferences remain authoritative over worktree preferences');
    assert.throws(() => api.resolveCandidates({ ...resolverOptions, cwd: worktree }, resolver, request), /identity-mismatch/);
    assert.throws(() => api.resolveCandidates({}, resolver), /request-identity-required/);
    for (const patch of [{ unitType: undefined }, { scope: undefined }, { phase: 'execute' }, { milestoneId: 'M002' }, { unitId: 'S02' }, { hostRuntime: 'claude' }]) {
      assert.throws(() => api.resolveCandidates({ ...resolverOptions, ...patch }, resolver, request), /identity-mismatch/);
    }
    const session = api.createRecovery(identity);
    session.record({ failure_class: 'timeout', reason_code: 'timeout', layer: 'provider', route, request_sha256: 'request',
      context_sha256: 'context', request_bytes: 1, context_bytes: 1, duration_ms: 300000, budgets: {} });
    const inspection = { receipt_checked: true, process_stopped: true, writer_possible: false };
    const noAuthority = await session.next({ inspection });
    assert.strictEqual(noAuthority.reason_code, 'timeout-cause-indeterminate');
    const scope = { unit: identity.unit, roots_sha256: 'roots', purpose: 'sidecar-recovery', expires_at: 120000,
      routes: route.chain.map(member => api.routeKey({ ...route, model_resolved: member.id, worker_mode: member.engine === 'gpt' ? 'native' : 'sidecar',
        resolved_worker_engine: member.engine === 'gpt' ? 'codex' : 'claude' })), gates_preserved: true };
    const authority = api.createAuthority(reference => ({ reference, status: 'resolved', answer: 'authorize', resolved_at: 'fixture' }));
    const exception = authority.issue('fixture', scope, () => 0);
    const restarted = api.createRecovery({ ...identity, state: JSON.parse(JSON.stringify(session.snapshot())), clock: () => 60001 });
    const accepted = await restarted.next({ inspection, candidateSet: candidates, exception, validateInvocation: () => ({ ok: true }) });
    assert.strictEqual(accepted.route.worker_mode, 'native');
    assert.strictEqual(accepted.sidecar_remaining_ms, 0);
    assert.strictEqual(accepted.remaining_ms, 0);
    assert.strictEqual(accepted.native_authorization_remaining_ms, 59999);
    assert.strictEqual(accepted.provenance.unit_type, request.unitType);
    restarted.reserve(accepted, 'request');
    const twice = api.createRecovery({ ...identity, state: JSON.parse(JSON.stringify(restarted.snapshot())), clock: () => 60002 });
    const stopped = await twice.next({ inspection, candidateSet: candidates, exception, validateInvocation() { throw new Error('sidecar beyond deadline'); } });
    assert.strictEqual(stopped.action, 'stop');
    assert(stopped.rejected.some(item => item.reason_code === 'recovery-deadline-exhausted'));
    assert.strictEqual(twice.snapshot().deadline_at, 60000);
    assert.strictEqual(twice.snapshot().reservations.length, 1);
    fs.mkdirSync(path.join(root, '.codex'));
    fs.writeFileSync(path.join(root, '.codex', 'AGENTS.md'), '<!-- user:forge-routing-continuity:start -->\nFixture authorization.\n<!-- user:forge-routing-continuity:end -->');
    const reference = 'conversation:restart-fixture';
    require('./forge-interaction').createRecoveryAuthorizationAdapter(observed => ({ ...observed, received: true,
      answer: 'authorize', resolved_at: 0 }), { resolveProfile: () => root, clock: () => 0 })
      .registerStandingAuthorization({ reference, host: 'codex', section: 'user:forge-routing-continuity', expires_at: 120000 });
    const fixture = path.join(root, 'restart.json');
    fs.writeFileSync(fixture, JSON.stringify({ state: session.snapshot(), request, resolverOptions, reference,
      scope: { ...scope, owner: root, roots: [worktree], request_identity_sha256: require('./forge-code-roots').digest(api.requestIdentity(request)),
        chain_sha256: require('./forge-code-roots').digest(route.chain) } }));
    const child = require('child_process').spawnSync(process.execPath, [__filename, '--resume-recovery', fixture], { encoding: 'utf8', windowsHide: true });
    assert.strictEqual(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.strictEqual(result.native.route.worker_mode, 'native');
    assert.strictEqual(result.native.sidecar_remaining_ms, 0);
    assert.strictEqual(result.afterReservation.action, 'stop');
    assert(result.afterReservation.rejected.some(row => row.reason_code === 'recovery-deadline-exhausted'));
    assert.strictEqual(result.state.deadline_at, session.snapshot().deadline_at);
    assert.strictEqual(result.state.reservations.length, 1);
    const foreign = api.createRecovery({ ...identity, state: undefined, request: undefined });
    foreign.record(session.snapshot().attempts[0]);
    await assert.rejects(foreign.next({ inspection, candidateSet: candidates, exception, validateInvocation: () => ({ ok: true }) }), /provenance/);
    console.log('PASS real resolver identity, missing/foreign scope and IDs, native after deadline, sidecar refusal and durable reservations');
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
async function resumeRecovery() {
  const fixture = JSON.parse(require('fs').readFileSync(process.argv[3], 'utf8'));
  const store = require('./forge-recovery-authority').createRecoveryAuthority({ resolveProfile: () => fixture.request.contextRoot, clock: () => 60001 });
  const exception = store.issueRecoveryException(fixture.reference, fixture.scope);
  const session = api.createRecovery({ unit: fixture.state.unit, roots_sha256: fixture.state.roots_sha256,
    request: fixture.request, state: fixture.state, clock: () => 60001 });
  const candidateSet = api.resolveCandidates(fixture.resolverOptions, undefined, fixture.request);
  const input = { inspection: { receipt_checked: true, process_stopped: true, writer_possible: false },
    candidateSet, exception, validateInvocation: () => ({ ok: true }) };
  const native = await session.next(input);
  session.reserve(native, 'request');
  const afterReservation = await session.next(input);
  process.stdout.write(JSON.stringify({ native, afterReservation, state: session.snapshot() }));
}
(process.argv[2] === '--resume-recovery' ? resumeRecovery() : main()).catch(error => { console.error(error); process.exitCode = 1; });
